/**
 * The queue's durable medium: one append-only JSONL file per queue, plus the
 * two side files a damaged or undeliverable job goes to.
 *
 * Why a file and not a domain table: a job is appended at the end of a turn
 * and must cost one write, not a read-modify-write of a growing record set,
 * and the queue is the one piece of memory state an operator inspects with
 * `cat`. Every mutation still runs under the queue's file lock (see
 * `lock.ts`), so interleaved processes never read a partial line.
 *
 * @module omd-memory/queue/store
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isRetainJob } from './job.ts'
import type { RetainJob } from './job.ts'

/** Path of the dead-letter file for a queue. */
export function deadLetterPath(path: string): string {
  return `${path}.dead.jsonl`
}

/** Path of the quarantine file for a queue. */
export function malformedPath(path: string): string {
  return `${path}.malformed.jsonl`
}

/** Result of reading a queue that may contain damaged lines. */
export interface ParsedQueue {
  /** Complete jobs, in file order. */
  jobs: RetainJob[]
  /** Raw lines that failed to parse; the caller quarantines them. */
  malformedLines: string[]
}

/** One queue file, read and written under the caller's lock. */
export class QueueStore {
  readonly path: string

  /**
   * @param path - the queue file.
   */
  constructor(path: string) {
    this.path = path
  }

  /**
   * Read the queue, keeping damaged lines aside.
   * @returns the usable jobs and the raw damaged lines.
   */
  async readTolerant(): Promise<ParsedQueue> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { jobs: [], malformedLines: [] }
      throw error
    }
    const jobs: RetainJob[] = []
    const malformedLines: string[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isRetainJob(parsed)) jobs.push(parsed)
        else malformedLines.push(line)
      } catch {
        malformedLines.push(line)
      }
    }
    return { jobs, malformedLines }
  }

  /**
   * Number of records in the file, used only for reporting.
   * @returns the record count; a missing file counts as zero.
   */
  async count(): Promise<number> {
    return (await this.readTolerant()).jobs.length
  }

  /**
   * Append jobs. One write call, so a crash lands a whole line or none.
   * @param jobs - the jobs to append.
   */
  async append(jobs: RetainJob[]): Promise<void> {
    if (jobs.length === 0) return
    await mkdir(dirname(this.path), { recursive: true })
    await appendFile(this.path, jobs.map((job) => JSON.stringify(job)).join('\n') + '\n', 'utf8')
  }

  /**
   * Replace the whole file atomically: write a sibling, then rename over the
   * queue, so a reader never observes a truncated queue.
   * @param jobs - the complete new contents.
   */
  async replace(jobs: RetainJob[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    if (jobs.length === 0) {
      await writeFile(this.path, '', 'utf8')
      return
    }
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, jobs.map((job) => JSON.stringify(job)).join('\n') + '\n', 'utf8')
    await rename(temporary, this.path)
  }

  /**
   * Move damaged raw lines into the quarantine file, each with its provenance.
   * @param lines - raw lines that failed validation.
   */
  async quarantine(lines: string[]): Promise<void> {
    if (lines.length === 0) return
    const target = malformedPath(this.path)
    await mkdir(dirname(target), { recursive: true })
    const quarantinedAt = new Date().toISOString()
    await appendFile(
      target,
      lines.map((line) => JSON.stringify({ quarantinedAt, sourceQueue: this.path, line })).join('\n') + '\n',
      'utf8',
    )
  }

  /**
   * Append jobs to the dead-letter file.
   * @param jobs - jobs that exhausted their retries.
   */
  async deadLetter(jobs: RetainJob[]): Promise<void> {
    if (jobs.length === 0) return
    const target = deadLetterPath(this.path)
    await mkdir(dirname(target), { recursive: true })
    await appendFile(target, jobs.map((job) => JSON.stringify(job)).join('\n') + '\n', 'utf8')
  }
}
