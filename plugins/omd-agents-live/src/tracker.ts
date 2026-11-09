/**
 * Live state behind `dsh-resource://agents/<sessionId>`.
 *
 * Discovery is the parent's own durable log: every `subagent/catalog` row
 * names a direct child (`childId`, `childCreatedAt`, `label`, `mode`). What a
 * child is doing now comes from its own session log, folded once and advanced
 * by a per-child subscription that is released when the session leaves the
 * store. What a child ended as comes from the `omdAgents` roster projection
 * the panel already uses; this package reads it and never writes it.
 *
 * Background jobs come from `ctx.jobs`, filtered to this session. Their output
 * tail is read incrementally through `readAt`, never by re-reading the ring.
 *
 * Neither list keeps history. A finished job or child stays only long enough to
 * be read once, then leaves: this source answers "what is running now", and a
 * growing tail of finished rows would cost the band a row per child forever.
 *
 * @module omd-agents-live/tracker
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { extractMetrics, lastLines } from './metrics.ts'
import type {
  AgentLiveActivity,
  AgentLiveEntry,
  AgentLiveStatus,
  AgentsLiveSnapshot,
  HeadlineEntry,
  JobLiveEntry,
  JobViewFace,
  JobsFace,
  LiveAgentsFace,
  MetricEntry,
  ProjectionReader,
  SessionStoreFace,
} from './types.ts'

/** Longest argument excerpt inside a tool label. */
const ARGUMENT_LIMIT = 60

/** Retained job output tail; enough for the metric window without keeping a whole log. */
const JOB_TAIL_CHARS = 16384

/** Argument fields that say what a call is about, most specific first. */
const ARGUMENT_KEYS = ['command', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'description', 'task', 'prompt', 'name']

/** Every tracker-wide number the plugin passes in from its `Config`. */
export interface TrackerOptions {
  /** How long a settled background job stays visible while no turn is open. */
  readonly settledJobGraceMs: number
  /** How long a child that reached a terminal status stays visible. */
  readonly settledAgentGraceMs: number
  /** Longest activity label, in UTF-16 code units; at least 1. */
  readonly activityMaxChars: number
}

/** One catalog row from the parent's log. */
interface CatalogRow {
  readonly id: string
  /** Durable creation time; the first row's value wins across re-announcements. */
  readonly createdAt: number | null
  /** Latest non-empty label; a later row without one keeps the earlier label. */
  readonly label: string | null
}

/** The fields the two folds read from a committed event. */
interface EventRecord {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/**
 * View one committed event through the fields the folds read; the harness's
 * own event map does not carry the subagent extension events in this program.
 * @param event - one committed event.
 * @returns the same event with an open type name and unknown payload.
 */
function recordOf(event: SessionEvent): EventRecord {
  return event as EventRecord
}

/**
 * Narrow an unknown value to a plain JSON object.
 * @param value - candidate value.
 * @returns the object view, or `undefined` for anything else.
 */
function plainObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * Read a non-empty string field.
 * @param value - candidate value.
 * @returns the string, or `undefined` when it is not a non-empty string.
 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read a finite number field.
 * @param value - candidate value.
 * @returns the number, or `null` when it is not a finite number.
 */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Clip a label to the activity budget.
 * @param value - candidate label.
 * @param limit - maximum length, in UTF-16 code units; below 1 yields an empty string.
 * @returns the original value or a clipped copy ending in an ellipsis.
 */
function truncate(value: string, limit: number): string {
  if (limit < 1) return ''
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

/**
 * Take the visible or reasoning text of one content array.
 * @param content - `message.content` as stored in the log.
 * @param type - the block type to join.
 * @returns the joined text, or an empty string when no such block carries text.
 */
function contentText(content: unknown, type: 'text' | 'reasoning'): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = plainObject(block)
    if (record?.type !== type) continue
    const text = nonEmptyString(record.text)
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n')
}

/**
 * The first sentence of a text, collapsed onto one line.
 * @param text - assistant text or reasoning.
 * @param limit - activity budget, in UTF-16 code units.
 * @returns at most one line, clipped to that budget.
 */
function firstSentence(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  const end = /[。！？]|[.!?](?=\s|$)/u.exec(collapsed)
  return truncate(end === null ? collapsed : collapsed.slice(0, end.index + 1), limit)
}

/**
 * Find the first useful string in a tool-call argument value.
 * @param value - candidate argument value.
 * @param depth - current nesting depth, bounded so a hostile payload cannot recurse forever.
 * @returns the collapsed string, or `undefined`.
 */
function firstArgumentString(value: unknown, depth: number): string | undefined {
  if (typeof value === 'string') {
    const collapsed = value.replace(/\s+/gu, ' ').trim()
    return collapsed === '' ? undefined : collapsed
  }
  if (depth >= 3) return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstArgumentString(item, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  const record = plainObject(value)
  if (record === undefined) return undefined
  for (const item of Object.values(record)) {
    const found = firstArgumentString(item, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * One-line summary of a tool call: the tool name plus its most telling argument.
 * @param name - tool name as the model wrote it.
 * @param rawArguments - the call's raw JSON arguments.
 * @param limit - activity budget, in UTF-16 code units.
 * @returns an activity label such as `read plugins/omd-read/src/index.ts`.
 */
function toolLabel(name: string, rawArguments: string, limit: number): string {
  let summary = ''
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    parsed = undefined
  }
  const record = plainObject(parsed)
  if (record !== undefined) {
    for (const key of ARGUMENT_KEYS) {
      const value = record[key]
      if (typeof value !== 'string') continue
      const collapsed = value.replace(/\s+/gu, ' ').trim()
      if (collapsed !== '') {
        summary = truncate(collapsed, ARGUMENT_LIMIT)
        break
      }
    }
    if (summary === '') summary = truncate(firstArgumentString(record, 0) ?? '', ARGUMENT_LIMIT)
  }
  return truncate(summary === '' ? name : `${name} ${summary}`, limit)
}

/**
 * The child's reported token total for one assistant message.
 * @param usage - `assistant/message` usage, as stored.
 * @returns the total, or `null` when the adapter reported no count.
 */
function usageTotal(usage: unknown): number | null {
  const record = plainObject(usage)
  if (record === undefined) return null
  const total = numberOrNull(record.totalTokens)
  if (total !== null) return total
  const parts = [
    numberOrNull(record.inputTokens),
    numberOrNull(record.outputTokens),
    numberOrNull(record.cacheReadTokens),
    numberOrNull(record.cacheWriteTokens),
  ].filter((part): part is number => part !== null)
  return parts.length === 0 ? null : parts.reduce((sum, part) => sum + part, 0)
}

/**
 * Extract metrics from a text, mapping "nothing found" to `null` fields.
 * @param text - the metric window.
 * @returns metrics and headline, each `null` when absent.
 */
function metricsOrNull(text: string): { metrics: MetricEntry[] | null; headline: HeadlineEntry | null } {
  const extracted = extractMetrics(text)
  return { metrics: extracted.metrics.length === 0 ? null : extracted.metrics, headline: extracted.headline }
}

/**
 * Map the live agent's lifecycle and the durable roster's word to one status.
 * @param live - `running`, `idle` (the agent exists but drives no turn), or `null` (no live agent).
 * @param durable - the `omdAgents` row status, or `null` when the projection is absent.
 * @returns the panel status; `active` without a live agent reads as `settled`.
 */
function agentStatus(live: 'running' | 'idle' | null, durable: string | null): AgentLiveStatus {
  if (live === 'running') return 'running'
  if (durable === 'completed' || durable === 'failed' || durable === 'cancelled' || durable === 'settled') return durable
  return 'settled'
}

/**
 * Sort key putting live rows first.
 * @param status - an agent or job status word.
 * @returns 0 for a live row, 1 for a settled one.
 */
function liveRank(status: string): number {
  return status === 'running' || status === 'stopping' ? 0 : 1
}

/**
 * One child's fold over its own session log.
 *
 * The first fold reads the session's whole snapshot but skips the fork seed:
 * an inherited parent assistant message must never become the child's
 * activity, metrics, or token count. Later events arrive through one
 * `session/event` subscription, released when this session is disposed.
 */
class ChildTrack {
  /** The exact live session this fold belongs to. */
  readonly session: Session
  /** First own event time, a fallback when the catalog row carries no creation time. */
  firstOwnEventAt: number | null = null
  /** Last own event time; freezes `elapsedMs` once the child stops running. */
  lastEventAt: number | null = null
  /** Own `tool/call` count. */
  toolCalls = 0
  /** Sum of reported token usage; `null` until a message carries accounting. */
  tokens: number | null = null
  /** `provider/model` of the latest assistant message. */
  model: string | null = null
  /** The child's `subagent/descriptor` label, when its own log has one. */
  descriptorLabel: string | null = null
  /** Latest tool call, assistant text, or reasoning. */
  activity: AgentLiveActivity | null = null
  /** Last 40 lines of the newest tool result or assistant text. */
  metricText: string | null = null
  readonly #activityMaxChars: number
  #subscription: (() => boolean) | undefined
  #disposal: (() => boolean) | undefined

  /**
   * Fold the session's existing own events, then follow new ones.
   * @param ctx - context owning the subscriptions.
   * @param session - the live child session.
   * @param activityMaxChars - longest activity label, in UTF-16 code units.
   */
  constructor(ctx: Context, session: Session, activityMaxChars: number) {
    this.session = session
    this.#activityMaxChars = activityMaxChars
    for (const event of session.snapshotEvents()) {
      if (!session.isOwnSeq(event.seq)) continue
      this.#fold(recordOf(event))
    }
    this.#subscription = ctx.on('session/event', (eventSession: Session, event: SessionEvent) => {
      if (eventSession.id !== session.id) return
      this.#fold(recordOf(event))
    })
    this.#disposal = ctx.on('session/disposed', (gone: Session) => {
      if (gone.id !== session.id) return
      this.close()
    })
  }

  /** Release both subscriptions; the folded facts stay readable. */
  close(): void {
    this.#subscription?.()
    this.#disposal?.()
    this.#subscription = undefined
    this.#disposal = undefined
  }

  /**
   * Fold one own committed event.
   * @param record - the event viewed through the fields this fold reads.
   */
  #fold(record: EventRecord): void {
    this.firstOwnEventAt ??= record.time
    this.lastEventAt = this.lastEventAt === null ? record.time : Math.max(this.lastEventAt, record.time)
    switch (record.type) {
      case 'subagent/descriptor': {
        const label = nonEmptyString(plainObject(record.data)?.label)
        if (label !== undefined) this.descriptorLabel = label
        return
      }
      case 'tool/call': {
        const payload = plainObject(record.data)
        const name = nonEmptyString(payload?.name) ?? 'tool'
        const argumentsJson = typeof payload?.arguments === 'string' ? payload.arguments : ''
        this.toolCalls += 1
        this.activity = { kind: 'tool', label: toolLabel(name, argumentsJson, this.#activityMaxChars) }
        return
      }
      case 'assistant/message': {
        const payload = plainObject(record.data)
        const message = plainObject(payload?.message)
        const total = usageTotal(payload?.usage)
        if (total !== null) this.tokens = (this.tokens ?? 0) + total
        const source = plainObject(message?.source)
        const provider = nonEmptyString(source?.provider)
        const model = nonEmptyString(source?.model)
        if (model !== undefined) this.model = provider === undefined ? model : `${provider}/${model}`
        const text = contentText(message?.content, 'text')
        const reasoning = text === '' ? contentText(message?.content, 'reasoning') : ''
        if (text !== '') {
          this.activity = { kind: 'text', label: firstSentence(text, this.#activityMaxChars) }
          this.metricText = lastLines(text, 40)
        } else if (reasoning !== '') {
          this.activity = { kind: 'thinking', label: firstSentence(reasoning, this.#activityMaxChars) }
        }
        return
      }
      case 'tool/result': {
        const text = contentText(plainObject(plainObject(record.data)?.message)?.content, 'text')
        if (text !== '') this.metricText = lastLines(text, 40)
        return
      }
      default:
        return
    }
  }
}

/**
 * Everything one parent session's read needs: its catalog, its children's
 * folds, job tails, and the two retention clocks — the open turn's start for
 * settled jobs, the settle instant per child for settled agents.
 */
class ParentFeed {
  readonly #ctx: Context
  readonly #session: Session
  readonly #graceMs: number
  readonly #agentGraceMs: number
  readonly #activityMaxChars: number
  readonly #rows = new Map<string, CatalogRow>()
  readonly #tracks = new Map<string, { readonly session: Session; readonly track: ChildTrack }>()
  readonly #jobTails = new Map<string, { offset: number; text: string }>()
  /** Child id → the instant its row stopped being live, for agent retention. */
  readonly #settledAt = new Map<string, number>()
  /** Index in `snapshotEvents()` already folded. */
  #folded = 0
  /** Start time of the open turn, or `null` between turns. */
  #openTurnStartedAt: number | null = null

  /**
   * @param ctx - context for live lookups and child subscriptions.
   * @param session - the addressed (parent) session.
   * @param options - retention windows and the activity budget.
   */
  constructor(ctx: Context, session: Session, options: TrackerOptions) {
    this.#ctx = ctx
    this.#session = session
    this.#graceMs = options.settledJobGraceMs
    this.#agentGraceMs = options.settledAgentGraceMs
    this.#activityMaxChars = options.activityMaxChars
  }

  /**
   * Compose one response from the current facts.
   * @param now - read time, in epoch milliseconds.
   * @returns the wire document.
   */
  snapshot(now: number): AgentsLiveSnapshot {
    this.#advance()
    const roster = this.#durableStatuses()
    const agents: AgentLiveEntry[] = []
    for (const row of this.#rows.values()) {
      const track = this.#trackFor(row.id)
      const entry = this.#agentEntry(row, track, roster, now)
      if (this.#keepAgent(row.id, entry.status, track, now)) agents.push(entry)
    }
    agents.sort((left, right) => liveRank(left.status) - liveRank(right.status)
      || (left.startedAt ?? 0) - (right.startedAt ?? 0)
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    return {
      sessionId: String(this.#session.id),
      generatedAt: now,
      agents,
      jobs: this.#jobEntries(now),
    }
  }

  /** Release every child subscription; called when the parent session leaves the store. */
  dispose(): void {
    for (const entry of this.#tracks.values()) entry.track.close()
    this.#tracks.clear()
    this.#jobTails.clear()
  }

  /** Fold the parent's new events: catalog rows and turn boundaries. */
  #advance(): void {
    const events = this.#session.snapshotEvents()
    for (let index = this.#folded; index < events.length; index += 1) {
      const event = events[index]
      if (event === undefined || !this.#session.isOwnSeq(event.seq)) continue
      const record = recordOf(event)
      switch (record.type) {
        case 'subagent/catalog':
          this.#foldCatalog(record.data)
          break
        case 'turn/start':
          this.#openTurnStartedAt = record.time
          break
        case 'turn/end':
          this.#openTurnStartedAt = null
          break
        default:
          break
      }
    }
    this.#folded = events.length
  }

  /**
   * Fold one catalog row, keeping the first creation time and the latest label.
   * @param data - the `subagent/catalog` payload.
   */
  #foldCatalog(data: unknown): void {
    const payload = plainObject(data)
    const id = nonEmptyString(payload?.childId)
    if (id === undefined) return
    const previous = this.#rows.get(id)
    const label = nonEmptyString(payload?.label) ?? previous?.label ?? null
    const createdAt = numberOrNull(payload?.childCreatedAt) ?? previous?.createdAt ?? null
    this.#rows.set(id, { id, createdAt, label })
  }

  /** The `omdAgents` roster statuses, keyed by child id; empty without the projection. */
  #durableStatuses(): Map<string, string> {
    const statuses = new Map<string, string>()
    const projections = this.#ctx.get('sessionProjections') as ProjectionReader | undefined
    if (projections === undefined) return statuses
    const state = plainObject(projections.stateOf(this.#session, 'omdAgents'))
    const agents = state?.agents
    if (typeof agents !== 'object' || agents === null || Array.isArray(agents)) return statuses
    for (const [id, row] of Object.entries(agents)) {
      const status = nonEmptyString(plainObject(row)?.status)
      if (status !== undefined) statuses.set(id, status)
    }
    return statuses
  }

  /**
   * Resolve one child's fold, seeding a new one when the child is live.
   * A closed fold is replaced when the same id is resumed with a new Session.
   * @param id - child session id.
   * @returns the fold, or `undefined` when the child has no live session and was never seen live.
   */
  #trackFor(id: string): ChildTrack | undefined {
    const sessions = this.#ctx.get('sessions') as SessionStoreFace | undefined
    const live = sessions?.get(SessionId(id))
    const existing = this.#tracks.get(id)
    if (live === undefined) return existing?.track
    if (existing !== undefined && existing.session === live) return existing.track
    existing?.track.close()
    const track = new ChildTrack(this.#ctx, live, this.#activityMaxChars)
    this.#tracks.set(id, { session: live, track })
    return track
  }

  /**
   * Build one child row.
   * @param row - the catalog identity.
   * @param track - the child's fold, or `undefined` when it was never seen live.
   * @param roster - durable statuses keyed by child id.
   * @param now - read time.
   * @returns the wire row.
   */
  #agentEntry(row: CatalogRow, track: ChildTrack | undefined, roster: Map<string, string>, now: number): AgentLiveEntry {
    const agents = this.#ctx.get('agents') as LiveAgentsFace | undefined
    const agent = agents?.get(SessionId(row.id))
    const live = agent === undefined ? null : agent.status === 'running' ? 'running' : 'idle'
    const status = agentStatus(live, roster.get(row.id) ?? null)
    const startedAt = row.createdAt ?? track?.firstOwnEventAt ?? null
    const endAt = status === 'running' ? now : track?.lastEventAt ?? null
    const elapsedMs = startedAt === null || endAt === null ? null : Math.max(0, endAt - startedAt)
    const extracted = track?.metricText == null ? { metrics: null, headline: null } : metricsOrNull(track.metricText)
    return {
      id: row.id,
      name: row.label ?? track?.descriptorLabel ?? row.id.slice(0, 8),
      status,
      startedAt,
      elapsedMs,
      activity: track?.activity ?? null,
      model: track?.model ?? null,
      tokens: track?.tokens ?? null,
      toolCalls: track === undefined ? null : track.toolCalls,
      metrics: extracted.metrics,
      headline: extracted.headline,
    }
  }

  /**
   * Whether a child row still earns a ticker slot, advancing its settle clock.
   *
   * Retention keeps no history: the band reports what is happening now, so a
   * row that reached a terminal status leaves after `settledAgentGraceMs` and
   * nothing of it is listed afterwards. The catalog row stays in {@link #rows},
   * so a child that is woken again returns as a live row instead of being lost.
   *
   * The clock starts at the child's own last event, not at the read that first
   * noticed the end, so a poll arriving late expires the row when the child
   * actually stopped. A child with no live log (an external provider, one whose
   * session was disposed before it was ever read, or a session read after a
   * process restart) has no such instant, and its clock starts at the first
   * read that proves it settled — one window, then gone.
   *
   * @param id - child session id.
   * @param status - the status this read proved.
   * @param track - the child's fold, when one exists.
   * @param now - read time.
   * @returns true while the row belongs on the ticker.
   */
  #keepAgent(id: string, status: AgentLiveStatus, track: ChildTrack | undefined, now: number): boolean {
    if (liveRank(status) === 0) {
      this.#settledAt.delete(id)
      return true
    }
    const settledAt = this.#settledAt.get(id) ?? Math.min(now, track?.lastEventAt ?? now)
    this.#settledAt.set(id, settledAt)
    return now - settledAt <= this.#agentGraceMs
  }

  /**
   * Build the job rows owned by this session.
   * @param now - read time.
   * @returns live jobs first by start time, then settled jobs still worth showing.
   */
  #jobEntries(now: number): JobLiveEntry[] {
    const jobs = this.#ctx.get('jobs') as JobsFace | undefined
    if (jobs === undefined) return []
    const sessionId = String(this.#session.id)
    const entries: JobLiveEntry[] = []
    const seen = new Set<string>()
    for (const job of jobs.list(SessionId(sessionId))) {
      if (job.owner === undefined || String(job.owner) !== sessionId) continue
      seen.add(job.id)
      if (liveRank(job.status) === 1 && !this.#keepSettled(job, now)) {
        this.#jobTails.delete(job.id)
        continue
      }
      const extracted = metricsOrNull(this.#tailOf(jobs, job))
      const elapsedMs = liveRank(job.status) === 0
        ? Math.max(0, now - job.startedAt)
        : job.finishedAt === undefined ? null : Math.max(0, job.finishedAt - job.startedAt)
      entries.push({
        id: job.id,
        kind: job.kind,
        label: job.label,
        status: job.status,
        startedAt: Number.isFinite(job.startedAt) ? job.startedAt : null,
        elapsedMs,
        metrics: extracted.metrics,
        headline: extracted.headline,
      })
    }
    for (const id of this.#jobTails.keys()) if (!seen.has(id)) this.#jobTails.delete(id)
    entries.sort((left, right) => liveRank(left.status) - liveRank(right.status)
      || (left.startedAt ?? 0) - (right.startedAt ?? 0)
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    return entries
  }

  /**
   * Whether a settled job is still within its visible window.
   * @param job - the settled job.
   * @param now - read time.
   * @returns true while it should stay on the ticker.
   */
  #keepSettled(job: JobViewFace, now: number): boolean {
    if (job.finishedAt === undefined) return false
    if (this.#openTurnStartedAt !== null) return job.finishedAt >= this.#openTurnStartedAt
    return now - job.finishedAt <= this.#graceMs
  }

  /**
   * Advance and read one job's retained output tail.
   * @param jobs - the job registry.
   * @param job - the job projection.
   * @returns at most {@link JOB_TAIL_CHARS} characters of output.
   */
  #tailOf(jobs: JobsFace, job: JobViewFace): string {
    let tail = this.#jobTails.get(job.id)
    if (tail === undefined) {
      tail = { offset: 0, text: '' }
      this.#jobTails.set(job.id, tail)
    }
    if (job.output.total <= tail.offset) return tail.text
    try {
      const read = jobs.readAt(job.id, tail.offset, SessionId(String(this.#session.id)))
      if (read.chunks.length > 0) {
        const joined = tail.text + read.chunks.map(chunk => chunk.text).join('')
        tail.text = joined.length <= JOB_TAIL_CHARS ? joined : joined.slice(-JOB_TAIL_CHARS)
      }
      tail.offset = read.next
    } catch {
      // `list()` and `readAt()` are separate calls; a job removed in between
      // has no tail to show, and the next read decides what still exists.
    }
    return tail.text
  }
}

/**
 * The plugin-wide tracker: one feed per read parent session, dropped when that
 * session leaves the process. Nothing is subscribed until a session is read.
 */
export class AgentsLiveTracker {
  readonly #ctx: Context
  readonly #options: TrackerOptions
  readonly #feeds = new Map<string, ParentFeed>()
  readonly #disposal: () => boolean

  /**
   * @param ctx - plugin context owning every subscription.
   * @param options - retention windows and the activity budget.
   */
  constructor(ctx: Context, options: TrackerOptions) {
    this.#ctx = ctx
    this.#options = options
    this.#disposal = ctx.on('session/disposed', (session: Session) => {
      const id = String(session.id)
      const feed = this.#feeds.get(id)
      if (feed === undefined) return
      feed.dispose()
      this.#feeds.delete(id)
    })
  }

  /**
   * Half of the source response for one parent session.
   * @param session - the live parent session.
   * @param now - read time; defaults to the current clock.
   * @returns the wire document.
   */
  snapshot(session: Session, now: number = Date.now()): AgentsLiveSnapshot {
    const id = String(session.id)
    let feed = this.#feeds.get(id)
    if (feed === undefined) {
      feed = new ParentFeed(this.#ctx, session, this.#options)
      this.#feeds.set(id, feed)
    }
    return feed.snapshot(now)
  }

  /** Drop every feed, its subscriptions, and the disposal listener. */
  dispose(): void {
    this.#disposal()
    for (const feed of this.#feeds.values()) feed.dispose()
    this.#feeds.clear()
  }
}
