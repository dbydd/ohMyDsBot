/**
 * The application step: replay one isolated run's patch onto the directory it
 * was copied from.
 *
 * Applying is check-first and all-or-nothing. Git is asked to validate the
 * whole patch before anything is written, so a conflict leaves every file in
 * the source byte-identical and the caller gets the list of files git refused.
 *
 * `git apply` needs the git binary but not a repository, which is what lets a
 * plain directory be patched. It is fed a patch carrying `diff --git` headers
 * and no blob names, so the three-way merge cannot be used here: when the
 * context does not apply, the patch is refused, not merged.
 *
 * @module omd-worktree-alloc/apply
 */

import { runGit, tryGit } from './git.ts'
import type { ApplyResult } from './types.ts'

/** How much of git's stderr an apply result carries; the head names the failing files. */
const DETAIL_LIMIT = 2000

/** File names git reports when it refuses a patch, as line-anchored patterns. */
const CONFLICT_PATTERNS: readonly string[] = [
  '^error: patch failed: (.+?):\\d+$',
  '^error: (.+?): (?:patch does not apply|does not match index|does not exist in index)$',
  '^error: (.+?): (?:already exists(?: in (?:working directory|index))?|No such file or directory)$',
]

/** Settings one apply reads; both validated by `apply`. */
export interface ApplyLimits {
  /** Ceiling on stdout for git's explanation. */
  metadataMaxBytes: number
  /** Deadline for each git invocation, in milliseconds. */
  timeoutMs: number
}

/**
 * Validate and replay one patch onto the source directory.
 *
 * @param patch patch text produced by the collector
 * @param root absolute directory the patch paths are relative to
 * @param limits invocation budgets
 * @returns `applied` when the patch landed, `conflict` with the files git
 * refused, or `failed` with git's explanation; nothing is written unless the
 * whole patch validated
 * @throws when git cannot be run at all
 */
export async function applyPatch(
  patch: string,
  root: string,
  limits: ApplyLimits,
): Promise<ApplyResult> {
  if (patch.trim() === '') return { outcome: 'applied', conflicts: [] }
  const text = patch.endsWith('\n') ? patch : `${patch}\n`
  const invocation = {
    cwd: root,
    input: text,
    maxBuffer: limits.metadataMaxBytes,
    timeoutMs: limits.timeoutMs,
  }

  const check = await tryGit({ ...invocation, args: ['apply', '--check', '-'] })
  if (check.code === 0) {
    await runGit({ ...invocation, args: ['apply', '-'] })
    return { outcome: 'applied', conflicts: [] }
  }

  const conflicts = conflictFiles(check.stderr)
  const detail = bounded(check.stderr)
  if (conflicts.length === 0) return { outcome: 'failed', conflicts: [], detail }
  return { outcome: 'conflict', conflicts, detail }
}

/**
 * Source-relative paths named by git's refusal messages.
 * @param stderr stderr of the dry run
 * @returns sorted, de-duplicated paths
 */
function conflictFiles(stderr: string): string[] {
  const found = new Set<string>()
  for (const source of CONFLICT_PATTERNS) {
    for (const match of stderr.matchAll(new RegExp(source, 'gm'))) {
      const path = match[1]
      if (path !== undefined && path !== '') found.add(path)
    }
  }
  return [...found].sort()
}

/**
 * Bound git's explanation so one result cannot carry an unbounded log.
 * @param text git's stderr
 * @returns the head of the text, or undefined when there is none
 */
function bounded(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  return trimmed.length > DETAIL_LIMIT ? `${trimmed.slice(0, DETAIL_LIMIT)}…` : trimmed
}
