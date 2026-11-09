/**
 * Orphan sweeping for the allocation pool.
 *
 * A pooled entry is the pair `<entry>` and `<entry>.baseline`: the working copy
 * and the untouched copy it is diffed against. The `<entry>.baseline` sibling is
 * what marks a directory as one of ours — a copy name can never end in
 * `.baseline` — so anything without it that is not itself a baseline is left
 * alone. A pool is a normal directory, and nothing guarantees it only ever holds
 * trees this plugin wrote.
 *
 * An entry counts as orphaned when the baseline's directory mtime is older than
 * the idle TTL and the current process is not holding it. The allocation path is
 * therefore the only thing that tells a live entry from an abandoned one; a
 * second process on the same directory would have to keep its trees fresh.
 *
 * @module omd-worktree-alloc/sweep
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Deepest pool-relative path an allocation can occupy: `omd/task/<childId>` needs three. */
const MAX_DEPTH = 5

/** Marker the allocator appends to a working copy's path to name its baseline. */
const BASELINE_SUFFIX = '.baseline'

/** What one sweep pass reads. */
export interface SweepInput {
  /** Absolute pool directory; a missing one is skipped. */
  pool: string
  /** Absolute allocation paths this allocator holds right now. */
  live: ReadonlySet<string>
  /** Age after which an entry this process does not hold is removable. */
  ttlMs: number
}

/** One removable pair, or a baseline whose working copy is already gone. */
interface SweepCandidate {
  /** Absolute working copy directory; absent when only the baseline is left. */
  copy?: string
  /** Absolute baseline directory. */
  baseline: string
}

/**
 * Remove pool entries that outlived the idle TTL.
 *
 * @param input pool, live allocations, and the TTL
 * @param now clock reading, for tests and callers that already have one
 * @returns one message per entry that could not be removed; empty on success
 */
export async function sweepPools(input: SweepInput, now: number = Date.now()): Promise<string[]> {
  const failures: string[] = []
  for (const candidate of await candidatesOf(input.pool)) {
    const baseline = resolve(candidate.baseline)
    if (input.live.has(baseline)) continue
    if (candidate.copy !== undefined && input.live.has(resolve(candidate.copy))) continue
    const mtimeMs = await mtimeOf(baseline)
    if (mtimeMs === undefined || now - mtimeMs < input.ttlMs) continue
    try {
      if (candidate.copy !== undefined) await rm(candidate.copy, { recursive: true, force: true })
      await rm(baseline, { recursive: true, force: true })
    } catch (error) {
      const path = candidate.copy ?? baseline
      failures.push(`worktree-alloc: could not sweep ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return failures
}

/**
 * Every allocation below `dir`, without descending into one.
 *
 * A baseline whose working copy is gone is its own candidate: a removal that
 * managed the copy but not the baseline would otherwise leave a full copy in the
 * pool that nothing else ever reclaims.
 *
 * @param dir absolute directory
 * @param depth current recursion depth
 * @returns the removable pairs and leftover baselines
 */
async function candidatesOf(dir: string, depth: number = 0): Promise<SweepCandidate[]> {
  if (depth > MAX_DEPTH) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: SweepCandidate[] = []
  for (const entry of entries) {
    // Symlinked directories are not followed: a pool symlink could point
    // anywhere, and the copy that created it is not ours to delete.
    if (!entry.isDirectory()) continue
    const path = join(dir, entry.name)
    const baseline = `${path}${BASELINE_SUFFIX}`
    if (await isDirectory(baseline)) {
      found.push({ copy: path, baseline })
      continue
    }
    if (entry.name.endsWith(BASELINE_SUFFIX)) {
      if (!await isDirectory(path.slice(0, -BASELINE_SUFFIX.length))) found.push({ baseline: path })
      continue
    }
    found.push(...await candidatesOf(path, depth + 1))
  }
  return found
}

/**
 * True when a path is a directory.
 * @param path absolute path
 * @returns whether the path exists and is a directory
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Modification time of a path, or undefined when it is not there.
 * @param path absolute path
 * @returns milliseconds since the epoch
 */
async function mtimeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return undefined
  }
}
