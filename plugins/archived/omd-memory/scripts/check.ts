/**
 * Acceptance check for `omd-memory`.
 *
 * Exercises the pieces the module cannot prove by importing: the queue's
 * coalescing, its dead-letter path against an unreachable server, and the
 * watermark recovery a restart performs. Prints one line per check and exits
 * non-zero on the first failure, so the output is the evidence.
 *
 * Run: `npx tsx scripts/check.ts`
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryQueue } from '../src/queue/index.ts'
import { Watermarks } from '../src/queue/watermark.ts'
import { createHindsightClient } from '../src/client/index.ts'

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL ${message}`)
    process.exit(1)
  }
  console.log(`ok   ${message}`)
}

const dir = await mkdtemp(join(tmpdir(), 'omd-memory-check-'))
const queuePath = join(dir, 'retain-queue.jsonl')
const queue = new MemoryQueue(queuePath, 2)

const job = (turn: number, throughSeq: number, content: string) => ({
  sessionId: 'session-1',
  turn,
  throughSeq,
  bankId: 'dsh-coding-check',
  documentId: 'dsh-session:session-1',
  updateMode: 'append' as const,
  item: {
    content: JSON.stringify([{ role: 'user', text: content }], null, 2),
    context: `turn ${turn}`,
    async: true,
    tags: ['project:check'],
  },
})

// Coalescing: two adjacent append jobs for one document become one.
await queue.enqueue(job(1, 10, 'first'))
await queue.enqueue(job(2, 20, 'second'))
const coalesced = await queue.read()
assert(coalesced.jobs.length === 1, 'adjacent append jobs coalesce into one')
assert(coalesced.jobs[0]!.throughSeq === 20, 'the coalesced job carries the newer watermark')
assert(coalesced.jobs[0]!.item.content.includes('first') && coalesced.jobs[0]!.item.content.includes('second'), 'the coalesced job carries both turns')

// Watermark recovery: a fresh table absorbing the queue resumes at seq 20.
const recovered = new Watermarks()
recovered.absorb(coalesced.jobs)
assert(recovered.get('session-1') === 20, 'a fresh watermark table recovers throughSeq from the queue tail')

// An unreachable server: two failed deliveries dead-letter the job, and the
// pass returns instead of blocking.
const deadClient = createHindsightClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2_000 })
const started = Date.now()
const firstPass = await queue.flush(deadClient, { maxJobs: 4, maxRetries: 2 })
const secondPass = await queue.flush(deadClient, { maxJobs: 4, maxRetries: 2 })
const elapsed = Date.now() - started
assert(firstPass.sent === 0 && firstPass.deadLettered === 0 && firstPass.remaining === 1, 'the first failed pass keeps the job queued')
assert(firstPass.lastError !== undefined && /fetch failed|ECONNREFUSED|timed out/.test(firstPass.lastError), `the failure is recorded as a fact (${firstPass.lastError})`)
assert(secondPass.deadLettered === 1 && secondPass.remaining === 0, 'the second failed pass moves the job to the dead-letter file')
assert(elapsed < 15_000, `both passes returned without blocking a turn (${elapsed}ms)`)
const dead = await readFile(`${queuePath}.dead.jsonl`, 'utf8')
assert(dead.trim().split('\n').length === 1, 'the dead-letter file holds exactly the failed job')

// A healthy flood is bounded by maxJobs, not by the queue length.
await queue.enqueue({ ...job(5, 50, 'third'), updateMode: 'replace' })
await queue.enqueue({ ...job(6, 60, 'fourth'), updateMode: 'replace' })
const summary = await queue.summarize()
assert(summary.pending === 2 && summary.dead === 1, `summary reports the queue (${JSON.stringify(summary)})`)

await rm(dir, { recursive: true, force: true })
console.log('all checks passed')
