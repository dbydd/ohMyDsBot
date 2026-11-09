/**
 * The `omdAgents` fold: every child this session delegated to, materialized
 * from the parent's own durable log.
 *
 * Only three parent-log facts describe a child:
 *
 * - `subagent/catalog` — the manager appends one row per created child
 *   (`childId`, `childCreatedAt`, `mode`, `label`). Payload version 2 is the
 *   external-execution record; versions 0 and 1 record session-backed local
 *   children.
 * - `tool-workflow/agent-start` / `tool-workflow/agent-end` — a workflow
 *   member's publication and its exact terminal outcome (`completed`,
 *   `failed`, `cancelled`). The end event carries no child id, so the fold
 *   keeps the `runId:seq` pairing the start event established.
 * - `user/message` and `agent/inbox/spliced` with
 *   `source.kind === 'subagent-settled'` — the parent-side notice written when
 *   a child's residency ends. It names the child in `senderSessionId` and
 *   proves the end without recording why.
 *
 * Everything a child knows about itself — model route, token usage, request
 * and tool counts, cost — is appended to the child's OWN session log, which a
 * fold over the parent cannot read. Those fields are `null` here rather than
 * guessed, copied from the parent, or summed across children.
 *
 * The `tool/call` event of a delegation tool is deliberately NOT used: its
 * arguments carry a description but no child id, so matching one to a row
 * would mean guessing which concurrent spawn the term belongs to.
 *
 * @module omd-agents-hub/fold
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Lifecycle of one delegated child, as the parent's log proves it.
 *
 * - `active` — a creation fact exists and no terminal fact has been folded.
 * - `settled` — a settlement notice exists; the notice has no
 *   machine-readable reason, so the fold does not invent one.
 * - `completed` / `failed` / `cancelled` — a workflow member's recorded
 *   outcome.
 *
 * A live epoch and an idle-but-resumable child both read as `active`: the
 * durable log distinguishes started from ended, not running from parked.
 */
export type OmdAgentStatus = 'active' | 'settled' | 'completed' | 'failed' | 'cancelled'

/**
 * Where a cataloged child runs, as the parent's log proves it: catalog payload
 * version 2 marks an external execution, versions 0 and 1 a session-backed
 * local child. `null` when the row came from a source with no placement fact
 * (a workflow member, or a catalog version this build does not know).
 */
export type OmdAgentIsolation = 'in-process' | 'external'

/**
 * One delegated child's roster row. Every `null` is a fact the parent's log
 * does not carry — never a zero, an empty string, or a placeholder.
 */
export interface OmdAgentRecord {
  /** Lifecycle proven by the parent's log. */
  status: OmdAgentStatus
  /**
   * The delegation label the child was created with: the catalog row's
   * `label`, or a workflow member's label. `null` when the creating fact
   * carried none.
   */
  assignment: string | null
  /** Route the child ran on; only the child's own log records it. */
  model: string | null
  /** Total tokens the child spent; only the child's own log records them. */
  tokens: number | null
  /** Model requests the child issued; only the child's own log counts them. */
  requests: number | null
  /** Tool calls the child issued; only the child's own log counts them. */
  toolCalls: number | null
  /** Wall time the child spent working; only the child's own log bounds it. */
  activeMs: number | null
  /** Billed cost of the child's usage; only the child's own log prices it. */
  cost: number | null
  /**
   * Id of the session that delegated this child. Always `null`: a projection
   * folds one session's log and is read back for that same session, so the
   * caller already holds the id — and a fold has no session identity to write
   * into the row.
   */
  parentId: string | null
  /** Process placement proven by the catalog row. */
  isolation: OmdAgentIsolation | null
}

/** The roster, keyed by child session id. */
export type OmdAgentRoster = Record<string, OmdAgentRecord>

/** Host fold state: the roster plus the inherited-prefix watermark it must skip. */
export interface OmdAgentsState {
  /** Events below this offset belong to a fork seed's ancestor, not to this session. */
  inheritedEventCount: number
  /** Published roster. */
  agents: OmdAgentRoster
  /** `runId:memberSeq` → child id, so a workflow end lands on the member's row. */
  workflowMembers: Record<string, string>
}

/** The only fields this fold reads from a committed event. */
interface CommittedRecord {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

/**
 * View one committed event through the fields the fold reads.
 * @param event - the committed event.
 * @returns the same event, widened to a type-name string and unknown payload.
 */
function committedRecord(event: SessionEvent): CommittedRecord {
  return event as CommittedRecord
}

/**
 * Narrow an unknown payload to a plain JSON object.
 * @param value - candidate payload.
 * @returns the object view, or `undefined` when the value is not a plain object.
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
 * Empty fold state.
 * @param inheritedEventCount - length of a fork seed's inherited prefix.
 * @returns the initial state; the same shape every later fold returns.
 */
export function initialOmdAgents(inheritedEventCount: number): OmdAgentsState {
  return { inheritedEventCount, agents: {}, workflowMembers: {} }
}

/**
 * Fold one committed event.
 *
 * Unrelated events, events of an unrecognized payload, and facts about a child
 * this session never created all return the SAME state reference, so the
 * projection registry publishes nothing for them.
 * @param state - state covering every earlier event.
 * @param event - the next committed event.
 * @returns the next state, or `state` itself when this event changes nothing.
 */
export function foldOmdAgents(state: OmdAgentsState, event: SessionEvent): OmdAgentsState {
  if (event.seq < state.inheritedEventCount) return state
  const record = committedRecord(event)
  switch (record.type) {
    case 'subagent/catalog':
      return foldCatalogRow(state, record.data)
    case 'tool-workflow/agent-start':
      return foldWorkflowStart(state, record.data)
    case 'tool-workflow/agent-end':
      return foldWorkflowEnd(state, record.data)
    case 'agent/inbox/spliced':
      return foldInboxSplice(state, record.data)
    case 'user/message':
      return foldSettlementNotice(state, record.data)
    default:
      return state
  }
}

/**
 * Fold one `subagent/catalog` row into the roster.
 * @param state - current state.
 * @param data - the event payload.
 * @returns the next state, or `state` when the row is unusable or unchanged.
 */
function foldCatalogRow(state: OmdAgentsState, data: unknown): OmdAgentsState {
  const payload = plainObject(data)
  if (payload === undefined) return state
  const childId = nonEmptyString(payload.childId)
  if (childId === undefined) return state
  const previous = state.agents[childId]
  // A creating fact that declares no label leaves the child's last durable
  // label in place: the child identity survived, and no later fact can
  // restore a label this fold dropped.
  const assignment = nonEmptyString(payload.label) ?? previous?.assignment ?? null
  const version = payload.version
  const isolation: OmdAgentIsolation | null = version === 2
    ? 'external'
    : version === 0 || version === 1 ? 'in-process' : null
  // A repeated row (the same epoch re-announced) must not reallocate: the
  // registry compares views with Object.is to suppress publication.
  if (previous !== undefined
    && previous.status === 'active'
    && previous.assignment === assignment
    && previous.isolation === isolation) {
    return state
  }
  return {
    ...state,
    agents: {
      ...state.agents,
      [childId]: {
        status: 'active',
        assignment,
        model: null,
        tokens: null,
        requests: null,
        toolCalls: null,
        activeMs: null,
        cost: null,
        parentId: null,
        isolation,
      },
    },
  }
}

/**
 * Fold one `tool-workflow/agent-start`: publish a member row and remember the
 * pairing its settlement event needs.
 * @param state - current state.
 * @param data - the event payload.
 * @returns the next state, or `state` when the payload names no member.
 */
function foldWorkflowStart(state: OmdAgentsState, data: unknown): OmdAgentsState {
  const payload = plainObject(data)
  if (payload === undefined) return state
  const childId = nonEmptyString(payload.childId)
  const runId = nonEmptyString(payload.runId)
  const memberSeq = payload.seq
  if (childId === undefined || runId === undefined || typeof memberSeq !== 'number') return state
  const memberKey = `${runId}:${memberSeq}`
  const previous = state.agents[childId]
  const assignment = nonEmptyString(payload.label) ?? previous?.assignment ?? null
  const sameRow = previous !== undefined
    && previous.status === 'active'
    && previous.assignment === assignment
  const samePairing = state.workflowMembers[memberKey] === childId
  if (sameRow && samePairing) return state
  return {
    ...state,
    agents: sameRow
      ? state.agents
      : {
        ...state.agents,
        [childId]: {
          status: 'active',
          assignment,
          model: null,
          tokens: null,
          requests: null,
          toolCalls: null,
          activeMs: null,
          cost: null,
          parentId: null,
          isolation: previous?.isolation ?? null,
        },
      },
    workflowMembers: samePairing
      ? state.workflowMembers
      : { ...state.workflowMembers, [memberKey]: childId },
  }
}

/**
 * Fold one `tool-workflow/agent-end` into its member's row.
 * @param state - current state.
 * @param data - the event payload.
 * @returns the next state, or `state` when the member or outcome is unknown.
 */
function foldWorkflowEnd(state: OmdAgentsState, data: unknown): OmdAgentsState {
  const payload = plainObject(data)
  if (payload === undefined) return state
  const runId = nonEmptyString(payload.runId)
  const memberSeq = payload.seq
  if (runId === undefined || typeof memberSeq !== 'number') return state
  const childId = state.workflowMembers[`${runId}:${memberSeq}`]
  if (childId === undefined) return state
  const row = state.agents[childId]
  if (row === undefined) return state
  const outcome = payload.outcome
  const status: OmdAgentStatus | undefined = outcome === 'completed'
    ? 'completed'
    : outcome === 'failed' ? 'failed' : outcome === 'cancelled' ? 'cancelled' : undefined
  if (status === undefined || row.status === status) return state
  return { ...state, agents: { ...state.agents, [childId]: { ...row, status } } }
}

/**
 * Fold an inbox splice's inserted messages, so a settlement notice staged for
 * a busy parent counts before a later step claims it.
 * @param state - current state.
 * @param data - the `agent/inbox/spliced` payload.
 * @returns the next state, or `state` when no inserted message settles a child.
 */
function foldInboxSplice(state: OmdAgentsState, data: unknown): OmdAgentsState {
  const payload = plainObject(data)
  const inserted = payload?.inserted
  if (!Array.isArray(inserted)) return state
  let next = state
  for (const message of inserted) next = foldSettlementNotice(next, message)
  return next
}

/**
 * Fold one settlement notice: the named child ended.
 * @param state - current state.
 * @param data - a user message, or one inbox entry.
 * @returns the next state, or `state` when the message is not a notice for a tracked child.
 */
function foldSettlementNotice(state: OmdAgentsState, data: unknown): OmdAgentsState {
  const message = plainObject(data)
  if (message === undefined) return state
  const source = plainObject(message.source)
  if (source === undefined || source.kind !== 'subagent-settled') return state
  const childId = nonEmptyString(source.senderSessionId)
  if (childId === undefined) return state
  const row = state.agents[childId]
  // A recorded outcome outranks the notice: the notice has no reason, so it
  // must not overwrite what the event stream already proved.
  if (row === undefined || row.status !== 'active') return state
  return { ...state, agents: { ...state.agents, [childId]: { ...row, status: 'settled' } } }
}
