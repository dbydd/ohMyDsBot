/**
 * `omd-worktree-alloc` — isolated working trees for child agents, plus the
 * collector that lands their work back in the parent directory, without the
 * upstream service's final `workingDirectory.set(agent, path)`.
 *
 * The upstream `@deepseek-ai/dsh-experimental-worktree` ends `create()` by
 * pointing the *calling* agent at the new checkout
 * (`packages/experimental/worktree/src/index.ts:170`). That is correct for a
 * command whose purpose is to move a session and wrong for a parent handing an
 * isolated tree to a child: the parent would end up working inside the child's
 * checkout. This package provides `ctx.worktreeAlloc` instead.
 *
 * One materialisation, and it needs no repository: the directory the caller
 * names is copied with APFS clonefile, and a second untouched copy is kept as
 * the baseline. `collect` turns what the child did into patch text, `apply`
 * replays it onto the source directory one patch at a time, and `release`
 * removes the copy. None of them calls `process.chdir` or touches the
 * `workingDirectory` projection, so the caller's own directory is the same
 * before and after.
 *
 * Named exports only: a `default` export makes the Loader discard this whole
 * namespace and every injection with it.
 *
 * @module omd-worktree-alloc
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createAllocator } from './allocate.ts'

export { CowBaselineTooLargeError, CowPatchTooLargeError } from './cow.ts'
export type { CowChangeSet, CowCollectLimits } from './cow.ts'
export type {
  ApplyResult,
  CowBaseline,
  CowWorktreeAllocation,
  ReleaseOptions,
  WorktreeAllocation,
  WorktreeAllocator,
  WorktreeBackend,
} from './types.ts'

/** Plugin id the Loader entry carries. */
export const name = 'omd-worktree-alloc'

/** This package publishes a service and depends on no host service of its own. */
export const inject: string[] = []

/**
 * How often the timer sweeps the pool. A sweep reads one directory and compares
 * mtimes, so this is a cheap tick, not an allocation-sized one.
 */
const SWEEP_INTERVAL_MS = 60_000

/** Deployment settings for the allocator. */
export interface Config {
  /**
   * Pool directory the copies are written to, relative to the directory being
   * copied. The pool writes its own `.gitignore`, so a copied checkout does not
   * see it in `git status`. It holds a working copy per allocation and a
   * `<entry>.baseline` sibling beside it.
   */
  cloneDirectory: string
  /**
   * Ceiling on the bytes one baseline may capture: the file index of the
   * untouched copy. Exceeding it fails the allocation and removes the copies
   * instead of truncating the baseline.
   */
  baselineMaxBytes: number
  /**
   * Ceiling on the patch one isolated run may collect. Exceeding it fails the
   * collect with the byte count instead of truncating the change set.
   */
  patchMaxBytes: number
  /** Deadline for each `cp`, `diff`, and `git apply` invocation, in milliseconds. */
  timeoutMs: number
  /** stdout ceiling for git invocations that answer with an explanation. */
  metadataMaxBytes: number
  /**
   * Seconds a pooled tree may sit untouched without being held by this process
   * before a sweep removes it. Sweeps run when `apply` is called and on a
   * minute timer; the entry's directory mtime is the clock, so a long run whose
   * writes all landed deeper in the tree can look idle.
   */
  idleTtl: Volatile<number>
}

/** Schemastery configuration for the allocator. */
export const Config: z<Config> = z.object({
  cloneDirectory: z
    .string()
    .default('.omd/clones')
    .description('Pool directory for clonefile copies, relative to the directory being copied.'),
  baselineMaxBytes: z
    .number()
    .step(1)
    .min(1)
    .default(8_388_608)
    .description('Ceiling on the bytes one baseline file index may capture; exceeding it fails the allocation.'),
  patchMaxBytes: z
    .number()
    .step(1)
    .min(1)
    .default(8_388_608)
    .description('Ceiling on the patch one isolated run may collect; exceeding it fails the collect.'),
  timeoutMs: z.number().step(1).min(1000).default(60_000).description('Deadline for each cp, diff, and git apply invocation, in milliseconds.'),
  metadataMaxBytes: z
    .number()
    .step(1)
    .min(4096)
    .default(65_536)
    .description('stdout ceiling for git invocations that answer with an explanation.'),
  idleTtl: z
    .number()
    .step(1)
    .min(1)
    .default(3600)
    .volatile()
    .description('Seconds a pooled tree may sit unheld and untouched before a sweep removes it.'),
})

/**
 * True when `value` is a relative directory path that cannot leave the copied
 * directory.
 * @param value the configured pool path
 * @returns whether the path is relative and free of dot segments
 */
function isRelativeDirectory(value: string): boolean {
  return value.length > 0
    && !value.includes('\\')
    && !value.includes(':')
    && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}

/**
 * Validate the deployment settings, then publish `ctx.worktreeAlloc` and start
 * the orphan timer.
 * @param ctx the entry fiber's context
 * @param config deployment settings for this profile
 * @throws when a setting could produce an allocator that writes outside the
 * copied directory, or refuses every allocation
 */
export function apply(ctx: Context, config: Config): void {
  if (!isRelativeDirectory(config.cloneDirectory)) {
    throw new Error('worktree-alloc: cloneDirectory must be a relative path without dot segments')
  }
  for (const key of ['baselineMaxBytes', 'patchMaxBytes', 'timeoutMs', 'metadataMaxBytes'] as const) {
    const value = config[key]
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`worktree-alloc: ${key} must be a positive integer`)
    }
  }
  const idleTtl = config.idleTtl.get()
  if (!Number.isSafeInteger(idleTtl) || idleTtl <= 0) {
    throw new Error('worktree-alloc: idleTtl must be a positive integer number of seconds')
  }

  const allocator = createAllocator({
    cloneDirectory: config.cloneDirectory,
    baselineMaxBytes: config.baselineMaxBytes,
    patchMaxBytes: config.patchMaxBytes,
    timeoutMs: config.timeoutMs,
    metadataMaxBytes: config.metadataMaxBytes,
    idleTtlMs: () => config.idleTtl.get() * 1000,
  })
  ctx.provide('worktreeAlloc', allocator)

  ctx.effect(() => {
    const timer = setInterval(() => {
      allocator.sweep().then(
        failures => {
          for (const failure of failures) ctx.logger.warn(failure)
        },
        (error: unknown) => ctx.logger.warn('omd-worktree-alloc: sweep failed: %o', error),
      )
    }, SWEEP_INTERVAL_MS)
    // The timer must not keep the process alive on its own.
    timer.unref()
    return () => clearInterval(timer)
  })
}
