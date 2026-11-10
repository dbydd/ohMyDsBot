/**
 * What a worker's coding-agent session becomes when a reader asks for it.
 *
 * A session log is the honest record of a run: the prompt it was given, every
 * reasoning step, every tool call and what came back. The feed here is that log
 * made readable — one row per message block, tool call, tool result and run
 * failure, with each payload cut to a bounded size, because a feed is rendered
 * in a panel, not paged by an agent.
 *
 * Two sources answer for one session, in this order: the live agent, when the
 * run is still in this process, and the durable log behind
 * `ctx.sessionPersistence`, which is what answers once the agent is gone. A
 * host without persistence answers `undefined` rather than an empty feed, so
 * "this session cannot be read" never looks like "the run did nothing".
 *
 * The session record is read structurally rather than through the typed event
 * union: the same summarizer consumes live events and records decoded from a
 * log written by another process and possibly another harness revision, and it
 * needs only a handful of fields from either.
 *
 * @module omd-issue-runner/events
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { RunnerEvent, SessionLogHandle, SessionPersistenceService } from './types.ts'

/** Longest single payload a feed row carries; longer text is cut. */
export const EVENT_FIELD_MAX_CHARS = 2_000

/** Most rows one feed carries; a longer log keeps its most recent rows. */
export const EVENT_LIST_MAX = 300

/** Where a session's events are read from, in order. */
export interface SessionSources {
  /** The agent registry: a session still live in this process answers from memory. */
  readonly agents: () => AgentRegistry | undefined
  /** The durable log, for a session this process no longer holds. */
  readonly persistence: () => SessionPersistenceService | undefined
}

/** One feed: the rows, and whether anything was cut. */
export interface SummarizedFeed {
  readonly events: RunnerEvent[]
  readonly truncated: boolean
}

/**
 * Read one session's event log.
 *
 * The live agent wins over the stored log because it is the same events
 * without a round trip through the backend, and because a running session's
 * log may lag its memory by a batch. Everything else — a settled run, a session
 * from before a restart — is answered from persistence.
 *
 * @param sources - the two places a session can be found.
 * @param sessionId - the session to read.
 * @returns its records, or undefined when this host has no log for it.
 * @throws when a log exists but cannot be read, naming the session and the reason.
 */
export async function readSessionLog(
  sources: SessionSources,
  sessionId: string,
): Promise<readonly unknown[] | undefined> {
  const live = sources.agents()?.get(SessionId(sessionId))
  if (live !== undefined) return live.session.snapshotEvents()
  const persistence = sources.persistence()
  if (persistence === undefined) return undefined
  let handle: SessionLogHandle
  try {
    handle = await persistence.open(SessionId(sessionId), 'read')
  } catch (error) {
    // Not found is the ordinary answer for a session this host never stored;
    // any other refusal is a real fault and must not be reported as missing.
    if (error instanceof Error && error.name === 'SessionPersistenceNotFoundError') return undefined
    throw new Error(`the session log of ${sessionId} could not be opened: ${firstLineOf(error)}`)
  }
  try {
    const slice = await handle.read(0)
    return slice.events
  } catch (error) {
    throw new Error(`the session log of ${sessionId} could not be read: ${firstLineOf(error)}`)
  } finally {
    await handle.close()
  }
}

/**
 * Summarize one session log into a feed.
 *
 * A tool call is taken from the `tool/call` record rather than from the
 * assistant block that announced it: the call record exists for every call,
 * while the block is optional, and taking both would list every call twice.
 * A tool result is paired with its call by id, so a result row says which tool
 * produced it. A run the provider stopped leaves no message of its own, so its
 * `turn/end` failure becomes one `result` row — the only place a reader can
 * learn why nothing ran.
 *
 * @param records - session records, oldest first.
 * @returns the rows and whether a payload or the list itself was cut.
 */
export function summarizeSession(records: readonly unknown[]): SummarizedFeed {
  const rows: RunnerEvent[] = []
  /** Call id → tool name, so a result row names the tool that produced it. */
  const calls = new Map<string, string>()
  let truncated = false

  /** One payload, cut to the size a row carries; the cut is reported once. */
  const text = (value: unknown): string | null => {
    const raw = asString(value)
    if (raw === undefined) return null
    if (raw.length <= EVENT_FIELD_MAX_CHARS) return raw
    truncated = true
    return `${raw.slice(0, EVENT_FIELD_MAX_CHARS)}\n… [cut at ${String(EVENT_FIELD_MAX_CHARS)} characters]`
  }

  for (const raw of records) {
    const record = asRecord(raw)
    const type = record?.type
    const at = asNumber(record?.time) ?? 0
    const data = asRecord(record?.data)
    if (type === 'user/message') {
      for (const block of blocksOf(data?.content)) {
        if (block.type !== 'text' || block.text === null) continue
        rows.push(row(at, 'user', 'user', { text: text(block.text) }))
      }
    } else if (type === 'assistant/message') {
      const message = asRecord(data?.message)
      for (const block of blocksOf(message?.content)) {
        if (block.text === null) continue
        if (block.type === 'text') rows.push(row(at, 'text', 'assistant', { text: text(block.text) }))
        else if (block.type === 'reasoning') rows.push(row(at, 'reasoning', 'assistant', { text: text(block.text) }))
      }
    } else if (type === 'tool/call') {
      const name = asString(data?.name) ?? '(tool)'
      const callId = asString(data?.callId)
      if (callId !== undefined) calls.set(callId, name)
      rows.push(row(at, 'tool', 'assistant', { tool: name, args: text(data?.arguments) }))
    } else if (type === 'tool/result') {
      const message = asRecord(data?.message)
      // The call id lives on the tool message the result carries; a record
      // that also names it beside the message is read the same way.
      const callId = asString(message?.toolCallId) ?? asString(data?.toolCallId)
      const name = callId === undefined ? undefined : calls.get(callId)
      rows.push(row(at, 'result', null, { tool: name ?? null, result: text(flattenBlocks(message?.content)) }))
    } else if (type === 'turn/end' && asRecord(data?.reason)?.kind === 'error') {
      // A run the provider stopped leaves no assistant message at all, so the
      // turn's own failure is the only account of what happened. It belongs in
      // the feed, or a reader has to decompress the log to learn why nothing ran.
      const failure = asRecord(asRecord(data?.reason)?.error)
      const message = asString(failure?.message) ?? 'the run stopped on a provider error'
      const code = asString(failure?.code)
      rows.push(row(at, 'result', null, { result: text(code === undefined ? message : `${code}: ${message}`) }))
    }
  }

  if (rows.length <= EVENT_LIST_MAX) return { events: rows, truncated }
  // The tail is what a watcher is looking at: a long run is read by its last
  // turns, and the cut is reported rather than hidden.
  return { events: rows.slice(rows.length - EVENT_LIST_MAX), truncated: true }
}

/** One feed row with every field the wire shape carries. */
function row(
  at: number,
  kind: RunnerEvent['kind'],
  role: RunnerEvent['role'],
  filled: { readonly text?: string | null; readonly tool?: string | null; readonly args?: string | null; readonly result?: string | null },
): RunnerEvent {
  return {
    at,
    kind,
    role,
    text: filled.text ?? null,
    tool: filled.tool ?? null,
    args: filled.args ?? null,
    result: filled.result ?? null,
  }
}

/** One message block, as the three fields a feed uses. */
interface BlockView {
  readonly type: string | undefined
  readonly text: string | null
}

/** The blocks of one message's content, skipping anything that is not a block. */
function blocksOf(value: unknown): BlockView[] {
  const blocks: BlockView[] = []
  for (const raw of Array.isArray(value) ? value : []) {
    const block = asRecord(raw)
    if (block === undefined) continue
    const type = asString(block.type)
    // A tool-call block and its `tool/call` record are the same fact; the
    // record is the one the feed reads, so the block contributes no row.
    blocks.push({ type, text: type === 'text' || type === 'reasoning' ? asString(block.text) ?? null : null })
  }
  return blocks
}

/** A tool result's content as one line of text, non-text blocks named by type. */
function flattenBlocks(value: unknown): string | null {
  const parts: string[] = []
  for (const raw of Array.isArray(value) ? value : []) {
    const block = asRecord(raw)
    if (block === undefined) continue
    if (block.type === 'text') {
      const text = asString(block.text)
      if (text !== undefined && text !== '') parts.push(text)
    } else {
      const type = asString(block.type)
      if (type !== undefined) parts.push(`[${type}]`)
    }
  }
  return parts.length === 0 ? null : parts.join('\n')
}

/** One record's fields, read as the loose object a log line carries. */
function asRecord(value: unknown): { readonly [key: string]: unknown } | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as { readonly [key: string]: unknown }
    : undefined
}

/** A string field, or undefined when it is absent or of another type. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** A numeric field, or undefined when it is absent or not a finite number. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** One line of an arbitrary thrown value. */
function firstLineOf(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message
  return String(error)
}
