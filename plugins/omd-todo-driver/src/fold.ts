/**
 * Fold of one session log into the four facts the nudge gate needs: how many
 * nudges the model actually saw since its last todo write, when the newest one
 * landed, whether the cap notice was already written, and whether the human's
 * last action was a manual stop.
 *
 * The fold is the storage. There is no event type and no `storageDomain` to
 * keep in sync: a restart replays the same log into the same answer, and a
 * fork inherits the parent prefix exactly as it inherits everything else.
 *
 * @module omd-todo-driver/fold
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Per-session gate facts, all derivable from the log alone. */
export interface FoldState {
  /** Nudges admitted since the latest `todo/write`; a max notice never counts. */
  nudges: number
  /** Epoch milliseconds of the newest admitted nudge, or undefined before the first. */
  lastNudgeAt: number | undefined
  /** Whether the cap notice has been written since the latest `todo/write`. */
  noticeWritten: boolean
  /** True when the newest manual stop has no newer human message behind it. */
  latched: boolean
}

/** Read one property off an untrusted event payload. */
function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>)[key]
}

/**
 * Apply one committed event to a gate fold.
 *
 * `todo/write` reopens both counters because a changed list is new work. A
 * human message unlatches; only `agent` stops latch, because a job-completion
 * reminder or a subagent report is not the human taking control back.
 * @param state - the session's mutable fold state.
 * @param event - the committed event.
 */
export function foldEvent(state: FoldState, event: SessionEvent): void {
  const type: string = event.type
  if (type === 'todo/write') {
    state.nudges = 0
    state.noticeWritten = false
    return
  }
  if (type === 'user/message') {
    const source = field(event.data, 'source')
    if (field(source, 'kind') === 'user') {
      state.latched = false
      return
    }
    if (field(source, 'kind') !== 'omd-todo-nudge') return
    if (field(source, 'form') === 'notice') {
      state.noticeWritten = true
      return
    }
    state.nudges += 1
    state.lastNudgeAt = event.time
    return
  }
  if (type !== 'turn/end') return
  const reason = field(event.data, 'reason')
  if (field(reason, 'kind') !== 'aborted') return
  if (field(field(reason, 'reason'), 'kind') === 'user') state.latched = true
}

/**
 * Read one session's fold, materializing it from the log on first use.
 * @param states - per-session folds held by the plugin instance.
 * @param session - session whose gate facts are needed.
 * @returns the mutable fold state, already replayed over the existing log.
 */
export function stateOf(states: WeakMap<Session, FoldState>, session: Session): FoldState {
  const existing = states.get(session)
  if (existing !== undefined) return existing
  const state: FoldState = { nudges: 0, lastNudgeAt: undefined, noticeWritten: false, latched: false }
  // A resumed or forked session already holds a log when this plugin mounts,
  // and the counters have to start from it. The log is the storage; the
  // projection registry is the UI's view, not this plugin's record.
  // oxlint-disable-next-line typescript/no-deprecated -- gate state is folded from the log itself.
  for (const event of session.snapshotEvents()) foldEvent(state, event)
  states.set(session, state)
  return state
}
