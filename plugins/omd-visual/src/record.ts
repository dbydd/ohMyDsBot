/**
 * Writing and reading the one session record a visualization leaves behind.
 *
 * This is the only module that calls `appendPluginRecord`: the writer is an
 * experimental Session API, so a host upgrade touches one file instead of
 * every call site, and the record payload has exactly one constructor.
 *
 * A record never enters the model surface — it is `ignorable` plugin data — so
 * the parent transcript carries no fence text and the next request is unchanged
 * by a visualization having happened.
 *
 * @module omd-visual/record
 */

import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import type {
  VisualDecision, VisualRecordPayload, VisualRecordProps, VisualStatus,
} from './types.ts'

/** The record type this package owns. */
export const RECORD_TYPE = 'plugin:omd/visual'

/** Everything one write supplies; the address and timestamp are derived. */
export interface VisualRecordInput {
  /** Assistant message this card hangs under. */
  readonly targetSeq: number
  readonly turn: number
  readonly step: number
  readonly status: VisualStatus
  readonly decidedBy: VisualDecision
  readonly reason?: string
  /** Raw fence text, markers included; only for `ready`. */
  readonly fence?: string
  readonly title?: string
  readonly fallback?: string
  readonly childSessionId?: string
  readonly childMode?: 'continuable' | 'one-shot' | 'unknown'
}

/**
 * The address a reader uses to fetch one record.
 * @param sessionId - session holding the record.
 * @param targetSeq - decorated assistant message.
 * @returns the canonical internal path.
 */
export function visualAddress(sessionId: string, targetSeq: number): string {
  return `dsh-resource://visual/${sessionId}/${targetSeq}`
}

/**
 * Append one record.
 *
 * The newest record for a `targetSeq` supersedes the earlier ones when the
 * client folds the log, so callers write `pending` once and then exactly one
 * settlement.
 * @param session - live session to append to.
 * @param input - what happened and what to render.
 * @returns the new event's sequence number.
 * @throws when the session no longer accepts appends, or the payload is not
 *   JSON-serializable; the caller decides whether that matters.
 */
export function writeVisualRecord(session: Session, input: VisualRecordInput): number {
  const props: VisualRecordProps = {
    address: visualAddress(String(session.id), input.targetSeq),
    ...input.fence === undefined ? {} : { fence: input.fence },
    ...input.title === undefined ? {} : { title: input.title },
    ...input.fallback === undefined ? {} : { fallback: input.fallback },
    ...input.childSessionId === undefined ? {} : { childSessionId: input.childSessionId },
    ...input.childMode === undefined ? {} : { childMode: input.childMode },
  }
  const payload: VisualRecordPayload = {
    sessionId: String(session.id),
    targetSeq: input.targetSeq,
    turn: input.turn,
    step: input.step,
    component: 'visual',
    status: input.status,
    decidedBy: input.decidedBy,
    ...input.reason === undefined ? {} : { reason: input.reason },
    props,
    at: Date.now(),
  }
  return appendPluginRecord(session, RECORD_TYPE, payload)
}

/**
 * The newest record for one assistant message.
 * @param events - the session's events, oldest first.
 * @param targetSeq - decorated assistant message.
 * @returns the payload, or undefined when nothing was written for it.
 */
export function latestVisualRecord(
  events: readonly SessionEvent[],
  targetSeq: number,
): VisualRecordPayload | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    const record = pluginRecordOf(event)
    if (record === undefined || record.type !== RECORD_TYPE) continue
    const payload = record.data as VisualRecordPayload
    if (payload.targetSeq === targetSeq) return payload
  }
  return undefined
}
