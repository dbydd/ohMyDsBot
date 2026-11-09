/**
 * The retain queue: enqueue at the end of a turn, deliver in the background,
 * dead-letter what the server refuses to accept.
 *
 * Three behaviors matter more than the rest:
 *
 * 1. **Enqueue never waits on the network.** A turn's stop boundary appends to
 *    a local file (one write) and returns. An unreachable server therefore
 *    delays nothing; delivery is a separate pass.
 * 2. **The tail is coalescable, the middle is not.** Two adjacent jobs that
 *    target the same bank and document under append semantics become one job,
 *    which halves both the server's extraction work and the queue's length.
 *    Only the tail is considered, so append order never jumps a failed job.
 * 3. **A restart resumes from the queue, not from a cursor file.** The newest
 *    job of a session carries that session's `throughSeq`, so the watermark is
 *    a fact of the queue itself: no second file to fall out of sync.
 *
 * @module omd-memory/queue
 */

import { redactError } from '../sanitize.ts'
import type { HindsightClientLike } from '../client/index.ts'
import { newRetainJob } from './job.ts'
import type { RetainJob } from './job.ts'
import { withQueueLock } from './lock.ts'
import { QueueStore } from './store.ts'

export { deadLetterPath, malformedPath } from './store.ts'
export { isRetainJob, newRetainJob } from './job.ts'
export type { JobUpdateMode, RetainItem, RetainJob } from './job.ts'

/** What one flush did. */
export interface FlushResult {
  /** Jobs the server accepted. */
  sent: number
  /** Jobs still on disk, already-failed writes included. */
  remaining: number
  /** Jobs moved to the dead-letter file in this pass. */
  deadLettered: number
  /** Raw lines moved to the quarantine file in this pass. */
  malformed: number
  /** Redacted text of the last failure, when the pass failed at least once. */
  lastError?: string
}

/** Limits of one flush pass. */
export interface FlushOptions {
  /** Jobs this pass may send. */
  maxJobs: number
  /** Attempts after which a job is dead-lettered. */
  maxRetries?: number
  /** Whether the pass stops at the first failure instead of trying the rest. */
  stopOnFirstFailure?: boolean
}

/** Counts and ages of the queue, for a status surface. */
export interface QueueSummary {
  /** Job id and age of the oldest queued job. */
  oldest?: { id: string; createdAt: string; ageMs: number }
  /** Jobs awaiting delivery. */
  pending: number
  /** Jobs the last pass recorded a failure for. */
  failing: number
  /** Jobs in the dead-letter file. */
  dead: number
  /** Raw lines in the quarantine file. */
  malformed: number
}

/** Automatic-retain merging: same target, append semantics, never failed. */
function canCoalesce(existing: RetainJob, incoming: RetainJob): boolean {
  return existing.bankId === incoming.bankId
    && existing.documentId === incoming.documentId
    && existing.updateMode === 'append'
    && incoming.updateMode === 'append'
    && existing.retries === 0
    && existing.deadLetteredAt === undefined
}

/**
 * Merge two jobs' content. Turn content is a JSON array of projected entries,
 * so concatenating the arrays keeps the merged job indistinguishable from
 * having enqueued both in sequence; anything else concatenates with a newline.
 * @param existing - the earlier content.
 * @param incoming - the later content.
 * @returns the merged content.
 */
function mergeContent(existing: string, incoming: string): string {
  try {
    const a: unknown = JSON.parse(existing)
    const b: unknown = JSON.parse(incoming)
    if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify([...a, ...b], null, 2)
  } catch {
    // Not projected turn content; fall through.
  }
  return `${existing}\n${incoming}`
}

/** Merge two compatible jobs, keeping the later one's turn and watermark. */
function coalesce(existing: RetainJob, incoming: RetainJob): RetainJob {
  const tags = [...new Set([...(existing.item.tags ?? []), ...(incoming.item.tags ?? [])])]
  return {
    ...incoming,
    id: existing.id,
    createdAt: existing.createdAt,
    item: {
      ...incoming.item,
      content: mergeContent(existing.item.content, incoming.item.content),
      ...(tags.length > 0 ? { tags } : {}),
    },
  }
}

/** Options one delivery sends, assembled from the job alone. */
function deliveryOptions(job: RetainJob) {
  const item = job.item
  return {
    documentId: job.documentId,
    updateMode: job.updateMode,
    context: item.context,
    ...(item.timestamp !== undefined ? { timestamp: item.timestamp } : {}),
    ...(item.metadata !== undefined ? { metadata: item.metadata } : {}),
    ...(item.async !== undefined ? { async: item.async } : {}),
    // The job id makes a retried async retain idempotent on the server.
    ...(item.async === true ? { operationId: job.id } : {}),
    ...(item.tags !== undefined ? { tags: item.tags } : {}),
    ...(item.documentTags !== undefined ? { documentTags: item.documentTags } : {}),
    ...(item.observationScopes !== undefined ? { observationScopes: item.observationScopes } : {}),
    ...(item.strategy !== undefined ? { strategy: item.strategy } : {}),
  }
}

/** The retain queue over one file. */
export class MemoryQueue {
  private readonly store: QueueStore
  private readonly maxRetries: number
  /** Serializes flushes so two passes never deliver the same job twice. */
  private flushing: Promise<FlushResult> | undefined

  /**
   * @param path - the queue file.
   * @param maxRetries - attempts after which a job is dead-lettered.
   */
  constructor(path: string, maxRetries = 5) {
    this.store = new QueueStore(path)
    this.maxRetries = maxRetries
  }

  /** The queue file this instance owns. */
  get path(): string {
    return this.store.path
  }

  /**
   * Read the queue without touching damaged lines beyond reporting them.
   * @returns complete jobs in file order and the raw damaged lines.
   */
  async read(): Promise<{ jobs: RetainJob[]; malformedLines: string[] }> {
    return await this.store.readTolerant()
  }

  /**
   * Append a job, merging it into the tail when the tail is compatible.
   * @param job - the job fields, without identity and attempt counter.
   * @returns whether the job was merged into the tail.
   */
  async enqueue(job: Omit<RetainJob, 'id' | 'createdAt' | 'retries'>): Promise<{ coalesced: boolean }> {
    const candidate = newRetainJob(job)
    return await withQueueLock(this.store.path, async () => {
      const parsed = await this.store.readTolerant()
      const jobs = parsed.jobs
      const tail = jobs[jobs.length - 1]
      if (tail !== undefined && canCoalesce(tail, candidate)) {
        jobs[jobs.length - 1] = coalesce(tail, candidate)
        await this.store.quarantine(parsed.malformedLines)
        await this.store.replace(jobs)
        return { coalesced: true }
      }
      await this.store.quarantine(parsed.malformedLines)
      await this.store.append([candidate])
      return { coalesced: false }
    })
  }

  /**
   * Deliver what the queue holds. Never throws for a server failure: a failed
   * delivery increments the job's attempt count, records the redacted error,
   * and either stays queued or moves to the dead-letter file.
   * @param client - the server client.
   * @param options - pass limits.
   * @returns what this pass did.
   */
  flush(client: HindsightClientLike, options: FlushOptions): Promise<FlushResult> {
    this.flushing ??= this.runFlush(client, options).finally(() => { this.flushing = undefined })
    return this.flushing
  }

  private async runFlush(client: HindsightClientLike, options: FlushOptions): Promise<FlushResult> {
    return await withQueueLock(this.store.path, async () => {
      const parsed = await this.store.readTolerant()
      const jobs = parsed.jobs
      const remaining: RetainJob[] = []
      const dead: RetainJob[] = []
      let sent = 0
      let lastError: string | undefined
      for (const [index, job] of jobs.entries()) {
        if (sent >= options.maxJobs) {
          remaining.push(...jobs.slice(index))
          break
        }
        try {
          await client.retain(job.bankId, job.item.content, deliveryOptions(job))
          sent += 1
        } catch (error) {
          const message = redactError(error)
          lastError = message
          const retries = job.retries + 1
          if (retries >= (options.maxRetries ?? this.maxRetries)) {
            dead.push({ ...job, retries, lastError: `${message}; retry limit reached, moved to the dead-letter queue`, deadLetteredAt: new Date().toISOString() })
          } else {
            remaining.push({ ...job, retries, lastError: message })
          }
          if (options.stopOnFirstFailure === true) {
            remaining.push(...jobs.slice(index + 1))
            break
          }
        }
      }
      await this.store.quarantine(parsed.malformedLines)
      await this.store.deadLetter(dead)
      await this.store.replace(remaining)
      return {
        sent,
        remaining: remaining.length,
        deadLettered: dead.length,
        malformed: parsed.malformedLines.length,
        ...(lastError !== undefined ? { lastError } : {}),
      }
    })
  }

  /**
   * Delete jobs the predicate selects, e.g. after an operator inspects them.
   * @param predicate - which jobs to drop.
   * @returns how many jobs were removed.
   */
  async remove(predicate: (job: RetainJob) => boolean): Promise<number> {
    return await withQueueLock(this.store.path, async () => {
      const parsed = await this.store.readTolerant()
      const kept = parsed.jobs.filter((job) => !predicate(job))
      const removed = parsed.jobs.length - kept.length
      if (removed > 0) await this.store.replace(kept)
      await this.store.quarantine(parsed.malformedLines)
      return removed
    })
  }

  /**
   * Counts and ages for a status surface.
   * @param now - clock, injected for a stable read.
   * @returns the summary.
   */
  async summarize(now = Date.now()): Promise<QueueSummary> {
    const parsed = await this.store.readTolerant()
    const dead = await new QueueStore(`${this.store.path}.dead.jsonl`).readTolerant()
    const malformed = await new QueueStore(`${this.store.path}.malformed.jsonl`).readTolerant()
    const oldest = parsed.jobs[0]
    return {
      ...(oldest !== undefined ? { oldest: { id: oldest.id, createdAt: oldest.createdAt, ageMs: now - Date.parse(oldest.createdAt) } } : {}),
      pending: parsed.jobs.length,
      failing: parsed.jobs.filter((job) => job.retries > 0).length,
      dead: dead.jobs.length,
      malformed: malformed.jobs.length + malformed.malformedLines.length,
    }
  }
}
