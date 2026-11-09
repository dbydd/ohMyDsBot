/**
 * The lock one queue file is written under.
 *
 * Two processes may run against the same `$DSH_HOME` — a web host and a
 * headless session, or two profiles pointing at one file — so the lock is a
 * directory created with `mkdir`, which is atomic on every platform, plus an
 * owner record and a heartbeat. A lock whose owner stopped heartbeating, or
 * whose owner process is gone, is reclaimable; a lock created by `mkdir` with
 * no owner record yet is given a grace period before it may be judged stale,
 * because that window is normal during acquisition.
 *
 * @module omd-memory/queue/lock
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Timings of one acquisition attempt and the staleness rules. */
export const QUEUE_LOCK = {
  /** Wait between two acquisition attempts. */
  retryMs: 25,
  /** Give up after this long; the caller treats it as "somebody else holds it". */
  timeoutMs: 5_000,
  /** A heartbeat older than this marks the lock stale. */
  staleMs: 30_000,
  /** How often the holder rewrites its heartbeat. */
  heartbeatMs: 10_000,
  /** Grace period before a lock directory that has no owner record yet may be judged stale. */
  ownerGraceMs: 5_000,
} as const

/** Who holds a lock, as recorded next to it. */
export interface QueueLockOwner {
  token: string
  pid: number
  acquiredAt: string
  heartbeatAt: string
}

/**
 * Wait one turn of the event loop.
 * @param ms - milliseconds to wait.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Whether a process with this id is still alive.
 * @param pid - process id.
 * @returns true when the process exists (or the probe is not permitted).
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Decide whether a recorded owner has abandoned its lock.
 * @param owner - the recorded owner, when the record could be read.
 * @param now - clock, injected so the rule is testable.
 * @returns true when the lock may be taken over.
 */
export function isQueueLockOwnerStale(owner: QueueLockOwner | undefined, now = Date.now()): boolean {
  if (owner === undefined) return false
  const heartbeat = Date.parse(owner.heartbeatAt)
  if (Number.isFinite(heartbeat) && now - heartbeat > QUEUE_LOCK.staleMs) return true
  return !isProcessAlive(owner.pid)
}

/**
 * Take one queue lock, run the body, and release the lock.
 *
 * In-process callers of the same path serialize on one promise chain, so a
 * single process never contends with itself on the filesystem; the directory
 * lock only arbitrates between processes.
 * @param path - the queue file the lock protects.
 * @param fn - the body to run while the lock is held.
 * @returns the body's result.
 */
export async function withQueueLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const inProcess = IN_PROCESS.get(path) ?? Promise.resolve()
  const next = inProcess.then(() => locked(path, fn))
  IN_PROCESS.set(path, next.then(noop, noop))
  return await next
}

/** Per-path chains of in-process work. */
const IN_PROCESS = new Map<string, Promise<void>>()

function noop(): void {}

/**
 * Run the body under the directory lock.
 * @param path - the queue file the lock protects.
 * @param fn - the body.
 * @returns the body's result.
 */
async function locked<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquire(path)
  try {
    return await fn()
  } finally {
    await release()
  }
}

/** Path of the lock directory guarding one queue file. */
function lockPath(path: string): string {
  return `${path}.lock`
}

/**
 * Acquire the directory lock, reclaiming it when its owner is stale.
 * @param path - the queue file the lock protects.
 * @returns the release function.
 */
async function acquire(path: string): Promise<() => Promise<void>> {
  const lock = lockPath(path)
  const token = randomUUID()
  const deadline = Date.now() + QUEUE_LOCK.timeoutMs
  await mkdir(dirname(lock), { recursive: true })

  for (;;) {
    try {
      await mkdir(lock)
      await writeOwner(lock, token)
      const heartbeat = setInterval(() => { void writeOwner(lock, token) }, QUEUE_LOCK.heartbeatMs)
      heartbeat.unref?.()
      return async () => {
        clearInterval(heartbeat)
        await releaseIfOwned(lock, token)
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      if (await reclaim(lock)) continue
      if (Date.now() >= deadline) {
        throw new Error(`omd-memory: the retain queue at ${path} is locked by another process and has not released it within ${QUEUE_LOCK.timeoutMs}ms`)
      }
      await sleep(QUEUE_LOCK.retryMs)
    }
  }
}

/**
 * Judge and, when stale, remove a lock somebody else holds.
 * @param lock - lock directory path.
 * @returns true when the lock was removed and may be retried immediately.
 */
async function reclaim(lock: string): Promise<boolean> {
  const ownerPath = `${lock}/owner.json`
  let owner: QueueLockOwner | undefined
  try {
    owner = JSON.parse(await readFile(ownerPath, 'utf8')) as QueueLockOwner
  } catch {
    // No readable owner record yet: either the holder is mid-acquisition or
    // the holder died between `mkdir` and the write. Only the grace period
    // can tell those apart, so check the directory's own age.
    try {
      const info = await stat(lock)
      if (Date.now() - info.mtimeMs < QUEUE_LOCK.ownerGraceMs) return false
    } catch {
      return true
    }
    await rm(lock, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
    return true
  }
  if (!isQueueLockOwnerStale(owner)) return false
  await rm(lock, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
  return true
}

/**
 * Record the holder. Written to a temporary name first so a reader never sees
 * a half-written owner record.
 * @param lock - lock directory path.
 * @param token - this acquisition's token.
 */
async function writeOwner(lock: string, token: string): Promise<void> {
  const ownerPath = `${lock}/owner.json`
  const now = new Date().toISOString()
  let acquiredAt = now
  try {
    const previous = JSON.parse(await readFile(ownerPath, 'utf8')) as QueueLockOwner
    if (previous.token === token && previous.acquiredAt !== undefined) acquiredAt = previous.acquiredAt
  } catch {
    // First write of this acquisition.
  }
  const temporary = `${ownerPath}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify({ token, pid: process.pid, acquiredAt, heartbeatAt: now } satisfies QueueLockOwner), 'utf8')
  await rename(temporary, ownerPath)
}

/**
 * Remove the lock, but only when this acquisition still owns it. A lock that
 * was reclaimed by another process after this one stalled must survive.
 * @param lock - lock directory path.
 * @param token - this acquisition's token.
 */
async function releaseIfOwned(lock: string, token: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(`${lock}/owner.json`, 'utf8')) as QueueLockOwner
    if (owner.token !== token) return
  } catch {
    return
  }
  await rm(lock, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
}
