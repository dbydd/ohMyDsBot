/**
 * The copier: an APFS clonefile copy of a plain directory, plus a second
 * untouched copy that serves as the baseline.
 *
 * The copy is clonefile (`cp -cR`), and the change set is read by walking both
 * trees: a path whose size and mtime still match is re-read and compared byte
 * for byte, everything else is handed to `diff -u`. No repository is involved
 * anywhere, so the source may be a plain directory.
 *
 * The source directory is only read, and the caller's working directory is
 * never changed.
 *
 * Two limits are deliberate. A patch is built one file at a time and the byte
 * budget is passed down to every `diff` invocation, so a change set that cannot
 * fit in `patchMaxBytes` fails instead of being truncated. And a binary change
 * is reported as git's `Binary files … differ` notice, not carried: a text
 * patch cannot replay it, and inventing a truncated one would be worse.
 *
 * @module omd-worktree-alloc/cow
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, open, readFile, readdir, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { cloneTree } from './clone.ts'
import type { CowBaseline } from './types.ts'

/** stderr of a `diff` is short; stdout is bounded separately by the patch budget. */
const COMMAND_BUFFER = 65_536

/** Bytes of a file inspected for a NUL before it is treated as binary, as git does. */
const BINARY_PROBE_BYTES = 8000

/** One path in a tree index. */
interface TreeEntry {
  kind: 'file' | 'dir' | 'symlink'
  /** File size in bytes; 0 for directories and symlinks. */
  size: number
  /** Modification time in whole milliseconds, truncated so two copies compare equal. */
  mtimeMs: number
  /** Permission bits; 0 for directories. */
  mode: number
  /** Link target for a symlink. */
  link?: string
}

/** A tree index and the totals its walk measured. */
interface TreeIndex {
  /** Paths relative to the indexed root. */
  entries: Map<string, TreeEntry>
  /** SHA-256 over every index line. */
  digest: string
  /** Regular files and symlinks counted. */
  files: number
  /** Sum of regular-file sizes. */
  bytes: number
}

/** What one `cow` collection produced. */
export interface CowChangeSet {
  /** Unified diff text with `diff --git` headers; text changes replay with `git apply`. */
  patch: string
  /** Changed paths, sorted. */
  files: string[]
  /** One-line `--shortstat`-style summary. */
  summary: string
}

/** Budgets one `cow` collection reads. */
export interface CowCollectLimits {
  /** Ceiling on patch bytes; crossing it fails the collection. */
  maxBytes: number
  /** Deadline for each `diff` invocation, in milliseconds. */
  timeoutMs: number
}

/** Inputs for laying down the two copies a `cow` allocation owns. */
export interface CowCopyRequest {
  /** Absolute source directory; read only. */
  source: string
  /** Absolute pool directory inside `source` that must not be copied. */
  pool: string
  /** Absolute working copy directory. */
  copy: string
  /** Absolute untouched baseline directory. */
  baseline: string
  /** Deadline for each `cp` invocation, in milliseconds. */
  timeoutMs: number
  /** Ceiling on the baseline index bytes, checked while the baseline is indexed. */
  baselineMaxBytes: number
}

/** A baseline index that cannot fit its budget. */
export class CowBaselineTooLargeError extends Error {
  /** The budget the capture exceeded. */
  readonly limitBytes: number
  /** Bytes counted before the refusal. */
  readonly capturedBytes: number

  /**
   * @param root indexed directory
   * @param limitBytes configured budget
   * @param capturedBytes bytes counted when the budget was crossed
   */
  constructor(root: string, limitBytes: number, capturedBytes: number) {
    super(
      `worktree-alloc: the file index of ${root} is ${capturedBytes} bytes, over the ${limitBytes}-byte `
        + 'baseline budget; raise baselineMaxBytes',
    )
    this.name = 'CowBaselineTooLargeError'
    this.limitBytes = limitBytes
    this.capturedBytes = capturedBytes
  }
}

/** A change set that would cross `patchMaxBytes`. */
export class CowPatchTooLargeError extends Error {
  /** The budget that was crossed. */
  readonly limitBytes: number

  /**
   * @param cwd the working copy being collected
   * @param limitBytes configured budget
   */
  constructor(cwd: string, limitBytes: number) {
    super(`worktree-alloc: the change set in ${cwd} exceeds ${limitBytes} bytes; raise patchMaxBytes or split the work`)
    this.name = 'CowPatchTooLargeError'
    this.limitBytes = limitBytes
  }
}

/**
 * Reject a name that would not be safe as one path below the pool.
 *
 * The name is a directory path, so the check is local: no empty, dot, or parent
 * segment, no separator a path could reinterpret, and no trailing `.baseline`
 * that would collide with a sibling allocation's baseline copy.
 *
 * @param name caller's identifier, also the pool-relative path
 * @throws when the name could escape the pool or collide with a baseline
 */
export function assertCowName(name: string): void {
  const invalid = name.length === 0
    || name.startsWith('-')
    || name.startsWith('/')
    || name.includes('\\')
    || name.includes(':')
    || name.includes('\0')
    || name.endsWith('.baseline')
    || name.split('/').some(part => part === '' || part === '.' || part === '..')
  if (invalid) throw new Error(`worktree-alloc: not a usable allocation name: ${name}`)
}

/**
 * Refuse a source whose `.git` is a file.
 *
 * That shape is a linked worktree, whose `.git` points into another checkout's
 * administration directory; a copy would carry the pointer and any git command
 * a child runs would edit the original's refs and index.
 *
 * @param root absolute source directory
 * @throws when `root/.git` is a file
 */
export async function assertCowSource(root: string): Promise<void> {
  let info
  try {
    info = await lstat(join(root, '.git'))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  if (info.isFile()) {
    throw new Error(
      `worktree-alloc: refusing a linked worktree; ${root}/.git points into another checkout`,
    )
  }
}

/**
 * Lay down the working copy and its baseline, then index the baseline.
 *
 * The baseline is copied from the source first, and the working copy is copied
 * from the baseline, so both trees start byte-identical and the pool the copies
 * live in is never copied into itself. clonefile keeps this cheap: the second
 * copy shares blocks until either side is written.
 *
 * @param request source, pool, destinations, and budgets
 * @returns the baseline, its index digest, and the index totals
 * @throws {CowBaselineTooLargeError} when the index crosses `baselineMaxBytes`
 */
export async function createCowCopies(request: CowCopyRequest): Promise<CowBaseline> {
  await cloneTree(request.source, request.baseline, [request.pool], request.timeoutMs)
  await cloneTree(request.baseline, request.copy, [], request.timeoutMs)
  const index = await indexTree(request.baseline, request.baselineMaxBytes)
  return {
    path: request.baseline,
    digest: index.digest,
    entries: index.files,
    bytes: index.bytes,
  }
}

/**
 * Read the change a run left in its working copy.
 *
 * The walk compares size and modification time first. Only a path whose
 * metadata still matches is read and compared byte for byte, because a copy
 * tool can preserve mtimes across a rewrite; a path whose metadata moved is
 * handed straight to `diff`, which drops it again when the content is the same
 * (a `touch` does not become a patch hunk).
 *
 * @param baseline baseline captured at allocation
 * @param copy absolute working copy directory
 * @param limits patch budget and per-invocation deadline
 * @param excluded absolute paths to leave out of the walk, for the allocation
 * pool a nested allocation keeps inside this copy
 * @returns patch text, the sorted changed paths, and a one-line summary
 * @throws {CowPatchTooLargeError} when the patch would cross `limits.maxBytes`
 * @throws when either tree cannot be read
 */
export async function collectCowChanges(
  baseline: CowBaseline,
  copy: string,
  limits: CowCollectLimits,
  excluded: readonly string[] = [],
): Promise<CowChangeSet> {
  const skip = new Set(excluded)
  const before = await indexTree(baseline.path, Number.MAX_SAFE_INTEGER)
  const after = await indexTree(copy, Number.MAX_SAFE_INTEGER, skip)

  const parts: string[] = []
  const changed = new Set<string>()
  let insertions = 0
  let deletions = 0
  let binary = 0
  let remaining = limits.maxBytes

  const overflow = (): CowPatchTooLargeError => new CowPatchTooLargeError(copy, limits.maxBytes)
  const emit = (text: string): void => {
    remaining -= Buffer.byteLength(text)
    if (remaining < 0) throw overflow()
    parts.push(text)
  }

  const paths = [...new Set([...before.entries.keys(), ...after.entries.keys()])].sort()
  for (const path of paths) {
    const left = before.entries.get(path)
    const right = after.entries.get(path)
    if (left?.kind === 'dir' && right?.kind === 'dir') continue

    const removed = left !== undefined && left.kind !== 'dir' ? left : undefined
    const added = right !== undefined && right.kind !== 'dir' ? right : undefined
    if (removed === undefined && added === undefined) continue

    if (removed !== undefined && added !== undefined && removed.kind === added.kind) {
      const leftPath = join(baseline.path, path)
      const rightPath = join(copy, path)
      if (removed.kind === 'symlink') {
        if (removed.link === added.link) continue
        changed.add(path)
        emit(`${header(path, removed, added)}--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${removed.link}\n+${added.link}\n\\ No newline at end of file\n`)
        insertions += 1
        deletions += 1
        continue
      }
      const modeChanged = modeOf(removed) !== modeOf(added)
      if (!modeChanged && !await contentChanged(removed, added, leftPath, rightPath)) continue
      if (await isBinaryFile(leftPath) || await isBinaryFile(rightPath)) {
        const [a, b] = await Promise.all([readFile(leftPath), readFile(rightPath)])
        if (!modeChanged && a.equals(b)) continue
        changed.add(path)
        binary += 1
        emit(`${header(path, removed, added)}Binary files a/${path} and b/${path} differ\n`)
        continue
      }
      const body = await runDiff(
        ['-u', '--label', `a/${path}`, '--label', `b/${path}`, leftPath, rightPath],
        remaining,
        limits.timeoutMs,
        overflow(),
      )
      const counted = countLines(body)
      if (counted.insertions + counted.deletions === 0 && !modeChanged) continue
      changed.add(path)
      insertions += counted.insertions
      deletions += counted.deletions
      emit(`${header(path, removed, added)}${body}`)
      continue
    }

    if (removed !== undefined) {
      const leftPath = join(baseline.path, path)
      changed.add(path)
      if (removed.kind === 'symlink') {
        emit(`${header(path, removed, undefined)}--- a/${path}\n+++ /dev/null\n@@ -1 +0,0 @@\n-${removed.link}\n\\ No newline at end of file\n`)
        deletions += 1
        continue
      }
      if (await isBinaryFile(leftPath)) {
        binary += 1
        emit(`${header(path, removed, undefined)}Binary files a/${path} and /dev/null differ\n`)
        continue
      }
      const body = await runDiff(
        ['-u', '--label', `a/${path}`, '--label', '/dev/null', leftPath, '/dev/null'],
        remaining,
        limits.timeoutMs,
        overflow(),
      )
      const counted = countLines(body)
      deletions += counted.deletions
      emit(`${header(path, removed, undefined)}${body}`)
    }

    if (added !== undefined) {
      const rightPath = join(copy, path)
      changed.add(path)
      if (added.kind === 'symlink') {
        emit(`${header(path, undefined, added)}--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${added.link}\n\\ No newline at end of file\n`)
        insertions += 1
        continue
      }
      if (await isBinaryFile(rightPath)) {
        binary += 1
        emit(`${header(path, undefined, added)}Binary files /dev/null and b/${path} differ\n`)
        continue
      }
      const body = await runDiff(
        ['-u', '--label', '/dev/null', '--label', `b/${path}`, '/dev/null', rightPath],
        remaining,
        limits.timeoutMs,
        overflow(),
      )
      const counted = countLines(body)
      insertions += counted.insertions
      emit(`${header(path, undefined, added)}${body}`)
    }
  }

  const files = [...changed].sort()
  return { patch: parts.join(''), files, summary: summarize(files.length, insertions, deletions, binary) }
}

/**
 * `diff --git` header plus the mode lines git writes for a created, removed, or
 * chmod-ed file.
 * @param path repository-relative path
 * @param left entry on the baseline side
 * @param right entry on the working-copy side
 * @returns header lines, newline-terminated
 */
function header(path: string, left: TreeEntry | undefined, right: TreeEntry | undefined): string {
  const lines = [`diff --git a/${path} b/${path}`]
  if (left === undefined && right !== undefined) lines.push(`new file mode ${modeOf(right)}`)
  else if (right === undefined && left !== undefined) lines.push(`deleted file mode ${modeOf(left)}`)
  else if (left !== undefined && right !== undefined && modeOf(left) !== modeOf(right)) {
    lines.push(`old mode ${modeOf(left)}`, `new mode ${modeOf(right)}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Git's textual mode for one entry.
 * @param entry indexed path
 * @returns `120000` for a symlink, else `100755` or `100644`
 */
function modeOf(entry: TreeEntry): string {
  if (entry.kind === 'symlink') return '120000'
  return (entry.mode & 0o111) !== 0 ? '100755' : '100644'
}

/**
 * True when two files with the same kind differ in content.
 *
 * Size and mtime decide most cases. When both still match, the content is read
 * and compared, because a copy that preserved metadata would otherwise hide a
 * rewrite.
 *
 * @param left baseline entry
 * @param right working-copy entry
 * @param leftPath absolute baseline path
 * @param rightPath absolute working-copy path
 * @returns whether the content differs
 */
async function contentChanged(
  left: TreeEntry,
  right: TreeEntry,
  leftPath: string,
  rightPath: string,
): Promise<boolean> {
  if (left.size !== right.size || left.mtimeMs !== right.mtimeMs) return true
  const [a, b] = await Promise.all([readFile(leftPath), readFile(rightPath)])
  return !a.equals(b)
}

/**
 * True when a file starts with bytes a text patch cannot carry.
 * @param path absolute file path
 * @returns whether a NUL appears in the probed prefix
 */
async function isBinaryFile(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const probe = Buffer.alloc(BINARY_PROBE_BYTES)
    const { bytesRead } = await handle.read(probe, 0, BINARY_PROBE_BYTES, 0)
    return probe.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

/**
 * Insertions and deletions a diff body adds.
 * @param body `diff -u` output for one file
 * @returns the two counts, with header lines excluded
 */
function countLines(body: string): { insertions: number; deletions: number } {
  let insertions = 0
  let deletions = 0
  for (const line of body.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) insertions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { insertions, deletions }
}

/**
 * One `--shortstat`-style line.
 * @param files changed paths
 * @param insertions added lines
 * @param deletions removed lines
 * @param binary files whose content the patch reports but cannot carry
 * @returns the summary text
 */
function summarize(files: number, insertions: number, deletions: number, binary: number): string {
  const parts = [`${files} file${files === 1 ? '' : 's'} changed`]
  if (insertions > 0) parts.push(`${insertions} insertion${insertions === 1 ? '' : 's'}(+)`)
  if (deletions > 0) parts.push(`${deletions} deletion${deletions === 1 ? '' : 's'}(-)`)
  if (binary > 0) parts.push(`${binary} binary`)
  return parts.join(', ')
}

/**
 * Run one `diff` and resolve with its stdout.
 *
 * Exit status 1 means the files differ, which is this call's normal answer.
 * Status 2 is a real failure. `maxBuffer` is the remaining patch budget, so an
 * oversized diff is refused before it is buffered.
 *
 * @param args arguments after `diff`
 * @param maxBuffer stdout ceiling in bytes
 * @param timeoutMs deadline in milliseconds
 * @param overflow error to reject with when stdout crosses `maxBuffer`
 * @returns decoded standard output
 * @throws {CowPatchTooLargeError} when stdout crosses `maxBuffer`
 * @throws when `diff` cannot be started or reports a failure
 */
async function runDiff(
  args: readonly string[],
  maxBuffer: number,
  timeoutMs: number,
  overflow: Error,
): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  execFile(
    'diff',
    args,
    { encoding: 'utf8', maxBuffer, timeout: timeoutMs, windowsHide: true },
    (error, stdout, stderr) => {
      if (error === null || error.code === 1) {
        resolve(stdout)
        return
      }
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        reject(overflow)
        return
      }
      const detail = stderr.trim() === '' ? error.message : stderr.trim()
      reject(new Error(`diff ${args.join(' ')} failed (${error.code === undefined ? 'no exit status' : `exit ${error.code}`}): ${detail}`))
    },
  )
  return promise
}

/**
 * Index every directory, regular file, and symlink below `root`.
 *
 * The index is metadata only, built in one pass, and its byte size is checked
 * while it grows, so a tree too large for the budget is refused without
 * materialising the whole index. Sockets, FIFOs, and devices are skipped: they
 * have no content a patch could carry. A symlink is recorded and never
 * descended into, matching what `cp -cR` copied.
 *
 * @param root absolute directory
 * @param limitBytes ceiling on the index's own bytes
 * @param skip absolute paths that are not part of the tree
 * @returns paths relative to `root`, a digest over the index, and its totals
 * @throws {CowBaselineTooLargeError} when the index crosses `limitBytes`
 */
async function indexTree(root: string, limitBytes: number, skip: ReadonlySet<string> = new Set()): Promise<TreeIndex> {
  const entries = new Map<string, TreeEntry>()
  const hash = createHash('sha256')
  let indexBytes = 0
  let files = 0
  let bytes = 0

  const record = (path: string, entry: TreeEntry): void => {
    entries.set(path, entry)
    const line = `${entry.kind}\t${entry.size}\t${entry.mtimeMs}\t${entry.mode}\t${entry.link ?? ''}\t${path}\n`
    indexBytes += Buffer.byteLength(line)
    if (indexBytes > limitBytes) throw new CowBaselineTooLargeError(root, limitBytes, indexBytes)
    hash.update(line)
    if (entry.kind !== 'dir') files += 1
    if (entry.kind === 'file') bytes += entry.size
  }

  await walk(root, '', record, skip)
  return { entries, digest: hash.digest('hex'), files, bytes }
}

/**
 * Walk one directory into a record callback.
 * @param root absolute directory the walk started at
 * @param relative path relative to `root`, empty at the root
 * @param record receives each indexed entry
 * @param skip absolute paths that are not part of the tree
 */
async function walk(
  root: string,
  relative: string,
  record: (path: string, entry: TreeEntry) => void,
  skip: ReadonlySet<string>,
): Promise<void> {
  const directory = relative === '' ? root : join(root, relative)
  for (const child of await readdir(directory, { withFileTypes: true })) {
    const path = relative === '' ? child.name : `${relative}/${child.name}`
    const absolute = join(root, path)
    if (skip.has(absolute)) continue
    if (child.isSymbolicLink()) {
      const info = await lstat(absolute)
      record(path, {
        kind: 'symlink',
        size: 0,
        mtimeMs: Math.trunc(info.mtimeMs),
        mode: info.mode,
        link: await readlink(absolute),
      })
      continue
    }
    if (child.isDirectory()) {
      record(path, { kind: 'dir', size: 0, mtimeMs: 0, mode: 0 })
      await walk(root, path, record, skip)
      continue
    }
    if (child.isFile()) {
      const info = await lstat(absolute)
      record(path, { kind: 'file', size: info.size, mtimeMs: Math.trunc(info.mtimeMs), mode: info.mode })
    }
  }
}
