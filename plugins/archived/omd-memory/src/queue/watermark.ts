/**
 * The watermark: which turn of a session has already been retained.
 *
 * The queue is the durable record, so the watermark is recovered from it and
 * never from a separate cursor file that could drift. Two sources feed one
 * value per session:
 *
 * - **The queue tail.** Delivery removes jobs, so the queue alone forgets a
 *   session as soon as its last job is sent — and a restart would then re-queue
 *   the turn that was just delivered. The highest `throughSeq` is therefore
 *   also recorded in the durable memory domain, written after the append and
 *   before the flush, so a restart resumes from whichever of the two is newer.
 * - **In-process memory**, for the common case of a running host.
 *
 * @module omd-memory/queue/watermark
 */

import type { MemoryDomain } from '../storage.ts'
import type { RetainJob } from './job.ts'

/** Per-session retained-turn positions. */
export class Watermarks {
  private domain: MemoryDomain | undefined
  private readonly live = new Map<string, number>()

  constructor() {}

  /**
   * Attach the opened domain and load what it already holds. Called once the
   * open resolves, so a watermark read never waits on storage.
   * @param domain - the opened memory domain.
   */
  use(domain: MemoryDomain): void {
    this.domain = domain
    for (const [sessionId, record] of domain.table('watermarks').entries()) {
      const current = this.live.get(sessionId)
      if (current === undefined || record.throughSeq > current) this.live.set(sessionId, record.throughSeq)
    }
  }

  /**
   * The highest seq already retained for one session.
   * @param sessionId - the session.
   * @returns the seq, or `0` when nothing is recorded.
   */
  get(sessionId: string): number {
    return this.live.get(sessionId) ?? 0
  }

  /**
   * Raise one session's watermark. Never lowers it: a late-arriving job with an
   * older seq must not reopen turns that were already retained.
   * @param sessionId - the session.
   * @param throughSeq - the seq folded into the job just enqueued.
   * @param turn - the turn that produced the job.
   * @returns resolution after the durable write, when storage is present.
   */
  async raise(sessionId: string, throughSeq: number, turn: number): Promise<void> {
    if (throughSeq <= this.get(sessionId)) return
    this.live.set(sessionId, throughSeq)
    if (this.domain === undefined) return
    await this.domain.table('watermarks').put(sessionId, { throughSeq, turn, updatedAt: new Date().toISOString() })
  }

  /**
   * Fold what a freshly read queue knows into memory. Called at startup, and
   * deliberately not persisted: the queue is the durable side of this source,
   * so writing it back would only add a second copy.
   * @param jobs - every job currently queued or dead-lettered.
   */
  absorb(jobs: readonly RetainJob[]): void {
    for (const job of jobs) {
      const current = this.live.get(job.sessionId)
      if (current === undefined || job.throughSeq > current) this.live.set(job.sessionId, job.throughSeq)
    }
  }
}
