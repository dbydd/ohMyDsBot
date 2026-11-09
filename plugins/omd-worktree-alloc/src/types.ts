/**
 * Cross-package vocabulary for `omd-worktree-alloc`: one isolated working tree,
 * the baseline captured inside it, the patch an isolated run produced, and the
 * service that makes, harvests, and breaks them.
 *
 * Consumers publish `allocate`'s `path` as a child agent's working directory and
 * keep their own. Nothing here expresses a directory change, because this
 * allocator never makes one.
 *
 * @module omd-worktree-alloc/types
 */

/** How an isolated working tree is materialised: an APFS clonefile copy of a directory. */
export type WorktreeBackend = 'cow'

/**
 * Baseline of an allocation: the untouched copy the run is diffed against.
 *
 * A pooled tree has no repository to commit to, so the baseline is a second
 * clonefile copy of the source; the index captured beside it is an identity and
 * a budget measurement, not a replayable patch.
 */
export interface CowBaseline {
  /** Absolute directory holding the untouched copy. */
  path: string
  /** SHA-256 over the file index. */
  digest: string
  /** Regular files and symlinks in the index. */
  entries: number
  /** Sum of regular-file sizes in the index, in bytes. */
  bytes: number
}

/** One isolated working tree created for a child agent. */
export interface CowWorktreeAllocation {
  /** Absolute directory; pass it as the child's working directory. */
  path: string
  /**
   * Identifier the caller named, also the copy's path below the pool. It
   * addresses the allocation; it is not a branch, because nothing here has
   * commits.
   */
  name: string
  /**
   * Absolute root of the directory patches are applied back to: the directory
   * the caller named when the allocation was made.
   */
  sourceRoot: string
  /** Backend that created this tree. */
  backend: WorktreeBackend
  /** The untouched copy the run is diffed against. */
  baseline: CowBaseline
}

/** One isolated working tree created for a child agent. */
export type WorktreeAllocation = CowWorktreeAllocation

/** Optional behaviour for {@link WorktreeAllocator.release}. */
export interface ReleaseOptions {
  /**
   * The caller is discarding the run's work. A clonefile copy keeps nothing
   * tracked, so there is no clean/dirty test to bypass: `release` removes the
   * copy and its baseline together either way.
   */
  force?: boolean
}

/** What applying one isolated run's patch to the source directory produced. */
export interface ApplyResult {
  /**
   * `applied` — every file in the patch landed; `conflict` — the source holds
   * edits the patch cannot merge onto, nothing was written; `failed` — git
   * refused for another reason, nothing was written.
   */
  outcome: 'applied' | 'conflict' | 'failed'
  /** Source-relative paths git refused to apply, sorted; empty unless `conflict`. */
  conflicts: string[]
  /** Git's own explanation, bounded; present for `conflict` and `failed`. */
  detail?: string
}

/**
 * Creates, harvests, and removes isolated working trees without touching the
 * caller.
 *
 * The caller's process working directory and its Session's
 * `workingDirectory` projection are both untouched by every method here: the
 * allocation is described by its return value alone.
 */
export interface WorktreeAllocator {
  /**
   * Copy a directory into the pool with clonefile and keep a second untouched
   * copy as the baseline.
   *
   * The tree starts as the source's live state. No repository is required, so
   * there is no commit to name: {@link CowBaseline.digest} identifies the state
   * the copy started from, and {@link collect} reads the change by walking both
   * trees.
   *
   * @param name identifier, also the copy's path below the pool, for example
   *   `omd/task/<childId>`
   * @param cwd the directory to copy; defaults to the process working
   *   directory, which is only read, never changed
   * @returns the copy, its name, the root patches apply back to, the backend,
   *   and the baseline captured beside it
   * @throws when `cwd` is not a directory, the name is unusable or its
   *   destination exists, the volume cannot clone, or the baseline would exceed
   *   its byte budget (the copies made by this call are removed before the
   *   error surfaces)
   */
  allocate(name: string, cwd?: string): Promise<WorktreeAllocation>

  /**
   * Generate the isolated run's change set as patch text, files the run created
   * included, relative to the baseline captured at allocation.
   *
   * @param handle allocation to read; the source tree is never opened
   * @returns a unified diff carrying `diff --git` headers, which {@link apply}
   *   replays. Text changes replay; a binary change is reported as a
   *   `Binary files …` notice the patch cannot carry
   * @throws when either tree cannot be read or the change set exceeds
   *   `patchMaxBytes`
   */
  collect(handle: WorktreeAllocation): Promise<string>

  /**
   * Collect the run's change set and apply it to the source directory.
   *
   * Applies run one at a time per allocator instance, and nothing is written
   * unless a dry run of the whole patch succeeds: a source that edited the same
   * lines gets `conflict` and its files stay exactly as they were.
   *
   * Orphaned trees from earlier runs are swept first, so a caller that keeps
   * applying does not also need a timer.
   *
   * @param handle allocation whose changes should land
   * @returns the outcome and, for a conflict, the files git refused, sorted
   * @throws when the patch cannot be generated; git refusals are reported, not thrown
   */
  apply(handle: WorktreeAllocation): Promise<ApplyResult>

  /**
   * Remove one allocated tree: the working copy and the baseline copy it was
   * diffed against, which are one unit and neither recoverable from the other.
   *
   * @param handle allocation returned by {@link allocate}
   * @param options present for callers that are discarding work; see
   *   {@link ReleaseOptions.force}
   * @throws when the path is outside its pool, or the removal itself fails
   */
  release(handle: WorktreeAllocation, options?: ReleaseOptions): Promise<void>

  /**
   * Remove pool entries older than `idleTtl` that this allocator does not hold.
   *
   * @returns one message per entry that could not be removed; empty on success
   */
  sweep(): Promise<string[]>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    worktreeAlloc: WorktreeAllocator
  }
}
