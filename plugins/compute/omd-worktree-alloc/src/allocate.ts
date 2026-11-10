/**
 * The allocator: isolated working trees created as APFS clonefile copies,
 * leaving the caller's own working directory exactly where it was.
 *
 * The upstream `@deepseek-ai/dsh-experimental-worktree` service ends `create()`
 * with `workingDirectory.set(agent, path)`
 * (`packages/experimental/worktree/src/index.ts:170`), which is right for a
 * command that is meant to move a session and wrong for a parent handing an
 * isolated tree to a child: the parent would end up working inside the child's
 * checkout, and every later relative tool call would follow it there. This
 * module performs the same work with the last step removed. It never calls
 * `process.chdir` and never touches `workingDirectory`; the tree is described
 * by the returned path alone.
 *
 * The pool lives inside the directory being copied, because the copy is of that
 * tree. One allocation owns two entries there: the working copy and the
 * untouched baseline it is diffed against. That pool is swept for entries this
 * process no longer holds.
 *
 * @module omd-worktree-alloc/allocate
 */

import { lstat, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { applyPatch } from './apply.ts'
import { assertCloneVolume } from './clone.ts'
import { assertCowName, assertCowSource, collectCowChanges, createCowCopies } from './cow.ts'
import { sweepPools } from './sweep.ts'
import type {
  ApplyResult,
  CowWorktreeAllocation,
  WorktreeAllocation,
  WorktreeAllocator,
} from './types.ts'

/** Deployment settings the allocator reads; validated by `apply`. */
export interface AllocatorSettings {
  /** Relative pool directory for clonefile copies inside the copied directory. */
  cloneDirectory: string
  /** Ceiling on the baseline file index bytes. */
  baselineMaxBytes: number
  /** Ceiling on patch bytes collected from one isolated run. */
  patchMaxBytes: number
  /** Deadline for each `cp`, `diff`, and `git apply` invocation, in milliseconds. */
  timeoutMs: number
  /** stdout ceiling for git invocations that answer with explanations. */
  metadataMaxBytes: number
  /** Age after which an entry this allocator does not hold is swept. */
  idleTtlMs(): number
}

/**
 * Build the service `apply` publishes as `ctx.worktreeAlloc`.
 * @param settings validated deployment settings
 * @returns the allocator
 */
export function createAllocator(settings: AllocatorSettings): WorktreeAllocator {
  const live = new Set<string>()
  let lastRoot: string | undefined
  let queue: Promise<unknown> = Promise.resolve()

  const collect = (handle: WorktreeAllocation): Promise<string> =>
    // A grandchild allocation pools inside this copy; its files belong to that
    // child, not to this one.
    collectCowChanges(
      handle.baseline,
      handle.path,
      {
        maxBytes: settings.patchMaxBytes,
        timeoutMs: settings.timeoutMs,
      },
      [join(handle.path, settings.cloneDirectory)],
    ).then(changes => changes.patch)

  const sweep = async (): Promise<string[]> => {
    if (lastRoot === undefined) return []
    return sweepPools({
      pool: join(lastRoot, settings.cloneDirectory),
      live,
      ttlMs: settings.idleTtlMs(),
    })
  }

  // One apply at a time: two children landing patches in the same source tree
  // must not interleave their dry run and their write.
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
  }

  return {
    async allocate(name, cwd) {
      const root = await cowRootOf(cwd ?? process.cwd())
      lastRoot = root
      const allocation = await allocateCow(settings, root, name)
      live.add(resolve(allocation.path))
      // The baseline is a pool entry of its own and can look orphaned; it is
      // part of the allocation, so the sweep has to see it as held.
      live.add(resolve(allocation.baseline.path))
      return allocation
    },
    collect,
    apply(handle) {
      return serialize(async (): Promise<ApplyResult> => {
        // Best effort: a sweep failure must not hold a child's finished work in
        // its isolated tree, and `sweep()` reports the same failures to its caller.
        await sweep().catch(() => [])
        const patch = await collect(handle)
        return applyPatch(patch, handle.sourceRoot, {
          metadataMaxBytes: settings.metadataMaxBytes,
          timeoutMs: settings.timeoutMs,
        })
      })
    },
    async release(handle) {
      await releaseAllocation(settings, handle)
      live.delete(resolve(handle.path))
      live.delete(resolve(handle.baseline.path))
    },
    sweep,
  }
}

/**
 * Copy a directory with clonefile and keep a second copy as the baseline.
 *
 * There are no commits to resolve and none to name: the allocation reports the
 * baseline index digest, so a caller still has an identity for the state the
 * copy started from.
 *
 * @param settings validated deployment settings
 * @param sourceRoot absolute directory the caller named
 * @param name identifier used as the copy's path below the pool
 * @returns the copy, its name, the baseline digest, the source root, and the
 * baseline
 * @throws when the name is unusable, the source is a linked worktree, the
 * volume cannot clone, a destination exists, or the index is over budget; the
 * copies made by this call are removed first
 */
async function allocateCow(
  settings: AllocatorSettings,
  sourceRoot: string,
  name: string,
): Promise<CowWorktreeAllocation> {
  assertCowName(name)
  await assertCowSource(sourceRoot)
  const pool = join(sourceRoot, settings.cloneDirectory)
  const destination = join(pool, name)
  const baseline = `${destination}.baseline`
  if (await exists(destination)) throw new Error(`worktree-alloc: the copy already exists: ${destination}`)
  if (await exists(baseline)) throw new Error(`worktree-alloc: the baseline already exists: ${baseline}`)
  await assertCloneVolume(sourceRoot, settings.timeoutMs)
  await preparePool(pool)
  await mkdir(dirname(destination), { recursive: true })

  try {
    const captured = await createCowCopies({
      source: sourceRoot,
      pool,
      copy: destination,
      baseline,
      timeoutMs: settings.timeoutMs,
      baselineMaxBytes: settings.baselineMaxBytes,
    })
    return {
      path: destination,
      name,
      sourceRoot,
      backend: 'cow',
      baseline: captured,
    }
  } catch (error) {
    await discardCow(destination, baseline)
    throw error
  }
}

/**
 * Remove the copies a failed allocation made.
 * @param copy absolute working copy directory
 * @param baseline absolute baseline directory
 */
async function discardCow(copy: string, baseline: string): Promise<void> {
  await rm(copy, { recursive: true, force: true }).catch(() => undefined)
  await rm(baseline, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Remove one allocated working copy and its baseline.
 * @param settings validated deployment settings
 * @param handle allocation returned by {@link createAllocator}'s `allocate`
 * @throws when either path is outside the pool, or the removal itself fails
 */
async function releaseAllocation(
  settings: AllocatorSettings,
  handle: WorktreeAllocation,
): Promise<void> {
  const pool = join(resolve(handle.sourceRoot), settings.cloneDirectory)
  const target = resolve(handle.path)
  const baseline = resolve(handle.baseline.path)
  if (!withinPool(target, pool)) {
    throw new Error(`worktree-alloc: ${target} is not inside the pool ${pool}`)
  }
  if (!withinPool(baseline, pool)) {
    throw new Error(`worktree-alloc: ${baseline} is not inside the pool ${pool}`)
  }
  await rm(target, { recursive: true, force: false })
  await rm(baseline, { recursive: true, force: true })
}

/**
 * Resolve the directory an allocation copies.
 *
 * The filesystem root is refused, because cloning it is never what an
 * allocation meant.
 *
 * @param cwd directory to copy
 * @returns its absolute path
 * @throws when `cwd` is not a directory or is the filesystem root
 */
async function cowRootOf(cwd: string): Promise<string> {
  const root = resolve(cwd)
  if (root === sep) throw new Error('worktree-alloc: refusing to clone the filesystem root')
  let info
  try {
    info = await stat(root)
  } catch (error) {
    throw new Error(`worktree-alloc: ${cwd} is not a directory`, { cause: error })
  }
  if (!info.isDirectory()) throw new Error(`worktree-alloc: ${cwd} is not a directory`)
  return root
}

/**
 * Create the pool and make it invisible to a checkout's own status when the
 * copied directory happens to be one. The pool holds isolated copies, which Git
 * never tracks; its `.gitignore` keeps them out of `git status` and
 * `git clean` as well.
 * @param pool absolute pool directory
 */
async function preparePool(pool: string): Promise<void> {
  await mkdir(pool, { recursive: true })
  try {
    await writeFile(join(pool, '.gitignore'), '*\n', { flag: 'wx' })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
}

/**
 * True when `target` is a proper descendant of `pool`.
 * @param target absolute candidate path
 * @param pool absolute pool directory
 * @returns whether the target may be deleted as one of this pool's entries
 */
function withinPool(target: string, pool: string): boolean {
  return target !== pool && target.startsWith(pool.endsWith(sep) ? pool : `${pool}${sep}`)
}

/**
 * True when `path` exists, without following a final symlink.
 * @param path absolute path to probe
 * @returns whether anything is there
 */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}
