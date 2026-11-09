/**
 * The clonefile primitive: a copy-on-write copy of one directory tree.
 *
 * `cp -cR` asks the filesystem for a copy-on-write clone instead of copying
 * bytes, so the second tree costs metadata and only diverges where it is
 * written. The copy carries everything, `.git`, ignored directories, and
 * untracked files included, which is the point: a child starts from the
 * caller's live tree, including the dependencies a fresh copy would have to
 * reinstall.
 *
 * Two refusals are deliberate. The volume is probed against the mount table
 * before the first clone, because a non-APFS volume turns `cp -c` into a byte
 * copy or an error, and a silent full copy of a repository with dependencies is
 * not a behaviour anyone asked for. The probe reads `mount` rather than `df -T`:
 * BSD `df` has no `-T` and exits 0 with empty output, where GNU `df` reports the
 * type. A linked worktree is refused before the copy: its `.git` is a file
 * pointing into the main checkout's administration directory, so the copy would
 * share refs and the index with the original.
 *
 * @module omd-worktree-alloc/clone
 */

import { execFile } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'

/** stderr and stdout of `df` and `cp` are diagnostics; this is plenty for both. */
const COMMAND_BUFFER = 65_536

/**
 * Run one command and require exit status 0.
 *
 * `cp` and `df` are not git, so they do not go through the git runner; the
 * contract is the same: argv array, capped output, deadline, stderr in the
 * error message.
 *
 * @param command binary name
 * @param args arguments before the payload
 * @param timeoutMs deadline in milliseconds
 * @returns decoded standard output
 * @throws when the command cannot be started, is killed, or exits non-zero
 */
async function run(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  const { promise, resolve: done, reject } = Promise.withResolvers<string>()
  execFile(
    command,
    args,
    { encoding: 'utf8', maxBuffer: COMMAND_BUFFER, timeout: timeoutMs, windowsHide: true },
    (error, stdout, stderr) => {
      if (error === null) {
        done(stdout)
        return
      }
      const detail = stderr.trim() === '' ? error.message : stderr.trim()
      reject(new Error(`${command} ${args.join(' ')} failed (${error.code === undefined ? 'no exit status' : `exit ${error.code}`}): ${detail}`))
    },
  )
  return promise
}

/**
 * Refuse a volume that cannot clone files.
 *
 * The mount table is read and the longest mount point containing `target` names
 * its filesystem type: `<device> on <point> (<type>, <options>…)`. Anything
 * other than `apfs` — including a path no mount covers — fails, because the
 * backend's whole contract is the clone.
 *
 * @param target absolute path whose volume is probed
 * @param timeoutMs deadline for the probe
 * @throws when the platform is not macOS, `mount` fails, or the volume is not APFS
 */
export async function assertCloneVolume(target: string, timeoutMs: number): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('worktree-alloc: clonefile is APFS-only, and this is not macOS')
  }
  const type = filesystemTypeOf(await run('mount', [], timeoutMs), resolve(target))
  if (type !== 'apfs') {
    throw new Error(
      `worktree-alloc: an allocation needs an APFS volume, but ${target} is on `
      + `${type === '' ? 'an unknown filesystem' : type}; it will not fall back to a byte copy`,
    )
  }
}

/**
 * Filesystem type of the mount holding `path`.
 * @param table `mount` output, one line per mount
 * @param path absolute path inside the volume
 * @returns the type, or an empty string when no mount covers the path
 */
function filesystemTypeOf(table: string, path: string): string {
  const line = /^.+? on (.+?) \(([a-z0-9_]+)/gm
  let best = { point: '', type: '' }
  for (const match of table.matchAll(line)) {
    const point = match[1] ?? ''
    const covers = point === '/' ? path.startsWith('/') : path === point || path.startsWith(`${point}/`)
    if (covers && point.length > best.point.length) best = { point, type: match[2] ?? '' }
  }
  return best.type
}

/**
 * Copy one directory into `destination` with clonefile.
 *
 * The destination lives inside the source, so the allocator's own pool has to be
 * excluded: copying it would copy every other isolated tree into this one, and
 * the destination is itself inside that pool. An entry that contains the pool is
 * walked into and copied child by child, so only that subtree loses the clone
 * shortcut; everything else is cloned with its attributes, symlinks included.
 *
 * @param source absolute source directory
 * @param destination absolute clone directory, created by this call
 * @param skipped absolute paths inside `source` that must not be copied
 * @param timeoutMs deadline for each `cp` invocation
 * @throws when the destination exists, the source cannot be listed, or a copy fails
 */
export async function cloneTree(
  source: string,
  destination: string,
  skipped: readonly string[],
  timeoutMs: number,
): Promise<void> {
  await mkdir(destination)
  const skip = [...new Set(skipped.map(path => resolve(path)))]
  for (const name of await readdir(source)) {
    await copyEntry(join(source, name), destination, skip, timeoutMs)
  }
}

/**
 * Clone one entry, or rebuild the directories on the way to a skipped path.
 * @param from absolute source entry
 * @param destination absolute directory the entry belongs in
 * @param skip absolute paths that must not be copied
 * @param timeoutMs deadline for each `cp` invocation
 */
async function copyEntry(from: string, destination: string, skip: readonly string[], timeoutMs: number): Promise<void> {
  const path = resolve(from)
  if (skip.includes(path)) return
  const containsSkipped = skip.some(entry => entry.startsWith(`${path}${sep}`))
  if (!containsSkipped) {
    await run('cp', ['-cR', '--', from, destination], timeoutMs)
    return
  }
  const into = join(destination, basename(from))
  await mkdir(into)
  for (const name of await readdir(from)) {
    await copyEntry(join(from, name), into, skip, timeoutMs)
  }
}
