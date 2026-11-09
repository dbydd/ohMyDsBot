/**
 * Repository-layer access and project-root resolution.
 *
 * Only the repository layer lives on disk: `<project root>/.omd/config.json`
 * is a committed, team-shared file. The personal override layer is a
 * `ctx.storageDomain` record keyed by root, so this module never writes.
 *
 * Project root = `git -C <cwd> rev-parse --show-toplevel`, falling back to
 * the canonical `cwd` when git is unavailable or the directory is not inside a
 * repository. Roots and `cwd → root` answers are cached; a repository layer is
 * re-read when its mtime changes.
 *
 * @module omd-project-config/store
 */

import { execFile } from 'node:child_process'
import { realpath, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { ProjectConfigFileError, validateLayer, type ConfigLayer } from './schema.ts'

const run = promisify(execFile)

/** Display title of a root: its basename, or the root itself when it has none. */
export function titleOf(root: string): string {
  return basename(root) || root
}

/** Cached `cwd → root` answers, including in-flight lookups. */
const roots = new Map<string, Promise<string>>()

/** Every root this process has resolved, for `list()`. */
const resolvedRoots = new Set<string>()

/**
 * Resolve the canonical project root for one working directory.
 * @param cwd - a Session working directory or a Workspace path.
 * @returns the git top level, or the canonical directory when git cannot answer.
 */
export function projectRoot(cwd: string): Promise<string> {
  const cached = roots.get(cwd)
  if (cached !== undefined) return cached
  const pending = resolveRoot(cwd)
  roots.set(cwd, pending)
  return pending
}

async function resolveRoot(cwd: string): Promise<string> {
  const directory = await canonical(cwd)
  try {
    const { stdout } = await run('git', ['-C', directory, 'rev-parse', '--show-toplevel'], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    })
    const top = stdout.trim()
    if (top !== '') {
      const root = await canonical(top)
      resolvedRoots.add(root)
      return root
    }
  } catch {
    // Not a repository, git missing, or the directory vanished: the directory
    // itself is the project in every one of those cases.
  }
  resolvedRoots.add(directory)
  return directory
}

/**
 * Every project root resolved in this process, sorted.
 * @returns the roots `list()` merges with the stored override keys.
 */
export function knownProjectRoots(): readonly string[] {
  return [...resolvedRoots].sort()
}

/** Canonicalize a path, falling back to the absolute spelling when it does not exist yet. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/** Cached repository layer keyed by root. */
const repoLayers = new Map<string, { mtimeMs: number | undefined; layer: ConfigLayer | undefined }>()

/**
 * Read one project's committed layer, reusing the cached value while its mtime
 * is unchanged.
 * @param root - normalized absolute project root.
 * @returns the validated layer, or undefined when the file does not exist.
 * @throws {ProjectConfigFileError} when the file holds invalid JSON or invalid fields.
 */
export async function readRepoLayer(root: string): Promise<ConfigLayer | undefined> {
  const file = join(root, '.omd', 'config.json')
  const mtimeMs = await mtimeOf(file)
  const cached = repoLayers.get(root)
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.layer
  const layer = mtimeMs === undefined ? undefined : await parseFile(file)
  repoLayers.set(root, { mtimeMs, layer })
  return layer
}

/**
 * Forget every cached layer and root answer. Only consumers that write into a
 * checkout outside this service need it.
 */
export function invalidateCaches(): void {
  roots.clear()
  repoLayers.clear()
  resolvedRoots.clear()
}

async function mtimeOf(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).mtimeMs
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function parseFile(file: string): Promise<ConfigLayer> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ProjectConfigFileError(file, `invalid JSON: ${message}`)
  }
  return validateLayer(value, file)
}
