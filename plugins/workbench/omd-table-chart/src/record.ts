/**
 * Writing and reading the one session record a chart leaves behind.
 *
 * This is the only module that calls `appendPluginRecord`: the writer is an
 * experimental Session API, so a host upgrade touches one file instead of every
 * call site, and the payload has exactly one constructor.
 *
 * A record never enters the model surface — it is `ignorable` plugin data — so
 * the next request is unchanged by a chart having been drawn. Because the
 * payload is complete, a client that folds the log after a restart, fork, or
 * resume draws the same picture without asking the host to recompute anything.
 *
 * @module omd-table-chart/record
 */

import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import type { ChartPlan, ChartSpec, MergeTrace } from 'omd-chart-plan/types'
import type { ChartDecision, ChartRecordPayload } from './types.ts'

/** The record type this package owns. */
export const RECORD_TYPE = 'plugin:omd/table-chart'

/** Everything one write supplies; the address, timestamp, and identity are derived. */
export interface ChartRecordInput {
  /** Assistant message this chart hangs under. */
  readonly anchorSeq: number
  readonly turn: number
  readonly step: number
  /** What the renderer draws. */
  readonly spec: ChartSpec
  /** The plan that produced the spec. */
  readonly plan: ChartPlan
  /** Who decided the plan. */
  readonly decidedBy?: ChartDecision
  /** Decision audit trace when planned by a judge. */
  readonly trace?: MergeTrace
}

/**
 * The address a reader uses to fetch one record.
 * @param sessionId - session holding the record.
 * @param anchorSeq - decorated assistant message.
 * @returns the canonical internal path.
 */
export function chartAddress(sessionId: string, anchorSeq: number): string {
  return `dsh-resource://chart/${sessionId}/${anchorSeq}`
}

/**
 * Append one record.
 *
 * One assistant message carries at most one chart, so callers check
 * {@link latestChartRecord} first and never write twice.
 * @param session - live session to append to.
 * @param input - what was planned and for which message.
 * @returns the new event's sequence number.
 * @throws when the session no longer accepts appends, or the payload is not
 *   JSON-serializable; the caller decides whether that matters.
 */
export function writeChartRecord(session: Session, input: ChartRecordInput): number {
  const payload: ChartRecordPayload = {
    sessionId: String(session.id),
    anchorSeq: input.anchorSeq,
    turn: input.turn,
    step: input.step,
    component: 'table-chart',
    spec: input.spec,
    plan: input.plan,
    decidedBy: input.decidedBy ?? { role: 'heuristic' },
    ...input.trace === undefined ? {} : { trace: input.trace },
    createdAt: Date.now(),
  }
  return appendPluginRecord(session, RECORD_TYPE, payload)
}

/**
 * The record written for one assistant message, if any.
 * @param events - the session's events, oldest first.
 * @param anchorSeq - decorated assistant message.
 * @returns the payload, or undefined when nothing was written for it.
 */
export function latestChartRecord(
  events: readonly SessionEvent[],
  anchorSeq: number,
): ChartRecordPayload | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    const record = pluginRecordOf(event)
    if (record === undefined || record.type !== RECORD_TYPE) continue
    const payload = record.data as ChartRecordPayload
    if (payload.anchorSeq === anchorSeq) return payload
  }
  return undefined
}

/**
 * All chart records written for a session, deduplicated by anchorSeq (newest wins).
 * @param events - the session's events, oldest first.
 * @returns list of chart records in chronological order.
 */
export function allChartRecords(events: readonly SessionEvent[]): ChartRecordPayload[] {
  const records: ChartRecordPayload[] = []
  const seenAnchors = new Set<number>()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    const record = pluginRecordOf(event)
    if (record === undefined || record.type !== RECORD_TYPE) continue
    const payload = record.data as ChartRecordPayload
    if (!seenAnchors.has(payload.anchorSeq)) {
      seenAnchors.add(payload.anchorSeq)
      records.unshift(payload)
    }
  }
  return records
}
