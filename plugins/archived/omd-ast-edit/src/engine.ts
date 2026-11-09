/**
 * ast-grep engine access for `omd-ast-edit`.
 *
 * The community package `dsh-tool-ast-grep` already owns binary resolution,
 * spawn-error classification and the read-only argv contract, and `omd-core`
 * mounts it in every omd profile. This module borrows that engine rather than
 * shipping a second copy: it locates the installed package and drives its
 * exported `runAstGrep`. Only the argv differs, because a rewrite query needs
 * `--rewrite`, which the community search builder deliberately never emits.
 *
 * Borrowing also inherits its discovery rules: `AST_GREP_PATH` / `AST_GREP_BIN`
 * override the executable, and a POSIX host without `ast-grep` on `PATH` fails
 * every call. That one failure is translated into an install hint, because the
 * model can act on it.
 *
 * @module omd-ast-edit/engine
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Package whose engine this plugin borrows. */
const ENGINE_PACKAGE = 'dsh-tool-ast-grep'

/** Error text the borrowed runner uses when no `ast-grep` executable exists. */
const MISSING_BINARY_MARKER = 'ast-grep binary was not found'

/** Engine invocation budget the plugin configuration defaults to. */
export const DEFAULT_ENGINE_TIMEOUT_MS = 60_000

/**
 * One structural match, reduced to the splice a rewrite performs: the file's
 * raw UTF-8 byte range and the engine's own rendered replacement for it.
 */
export interface AstSite {
  /** Path as ast-grep reports it, relative to the search root and `/`-separated. */
  readonly file: string
  /** Match start, 0-based UTF-8 byte offset into the file on disk. */
  readonly byteStart: number
  /** Match end, 0-based exclusive UTF-8 byte offset into the file on disk. */
  readonly byteEnd: number
  /** Matched source text, used to prove a site is still what was staged. */
  readonly text: string
  /** The rewrite for this match, already expanded by the engine. */
  readonly replacement: string
}

/** One match as ast-grep's `--json` mode serializes it. */
interface AstGrepMatch {
  readonly text?: string
  readonly file?: string
  readonly replacement?: string
  readonly range?: {
    readonly byteOffset?: { readonly start?: number; readonly end?: number }
  }
}

/** The one export this plugin borrows from the installed engine. */
interface AstGrepRunner {
  runAstGrep(args: string[], cwd: string, signal: AbortSignal, timeoutMs?: number): Promise<string>
}

/** Cached engine runner; a failed load is dropped, so a later install heals. */
let engineLoad: Promise<AstGrepRunner> | undefined

/**
 * Candidate install locations for the engine, most specific first.
 * @returns absolute paths to the package directory.
 */
function engineCandidates(): string[] {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profiles = join(home, 'profiles')
  const active = process.env.DSH_PROFILE
  return [
    ...active === undefined || active.length === 0 ? [] : [join(profiles, active, 'node_modules', ENGINE_PACKAGE)],
    join(profiles, 'omd', 'node_modules', ENGINE_PACKAGE),
    join(profiles, 'node_modules', ENGINE_PACKAGE),
  ]
}

/**
 * Import the borrowed engine from the first installed copy.
 *
 * The specifier is runtime-selected, so a static import cannot name it: the
 * package is a profile-level `dsh` bundle row, not a dependency of this plugin,
 * and an out-of-tree plugin resolves from its own directory. See the module
 * header for the consequence of that layout.
 * @returns the engine's runner.
 * @throws when no installed copy exists, or it does not export what is expected.
 */
export async function loadEngine(): Promise<AstGrepRunner> {
  if (engineLoad !== undefined) return engineLoad
  const load = (async () => {
    const directory = engineCandidates().find(candidate => existsSync(join(candidate, 'lib', 'runner.js')))
    if (directory === undefined) {
      throw new Error(
        `ast_edit: the ${ENGINE_PACKAGE} package is not installed in any dsh profile; `
        + `mount omd-core (it provides the tool-ast-grep row) or run \`dsh plugin --profile <profile> add ${ENGINE_PACKAGE}\`.`,
      )
    }
    const runner = await import(pathToFileURL(join(directory, 'lib', 'runner.js')).href) as Partial<AstGrepRunner>
    if (typeof runner.runAstGrep !== 'function') {
      throw new Error(`ast_edit: ${directory} does not export runAstGrep; ${ENGINE_PACKAGE} changed its layout`)
    }
    return { runAstGrep: runner.runAstGrep }
  })()
  try {
    engineLoad = await load
  } catch (error) {
    // A missing package may be installed later in this process; a failed load
    // must not poison every following call.
    engineLoad = undefined
    throw error
  }
  return engineLoad
}

/**
 * Build the rewrite argv: the community search argv plus `--rewrite`, which is
 * the one flag its read-only builder withholds.
 * @param pattern - structural pattern, `$VAR` for one node and `$$$` for many.
 * @param replacement - replacement template.
 * @param glob - `--globs` filter.
 * @param root - absolute search root.
 * @returns the argv to hand to the engine.
 */
export function buildRewriteArgs(pattern: string, replacement: string, glob: string, root: string): string[] {
  return ['run', '--json=compact', '--pattern', pattern, '--rewrite', replacement, '--globs', glob, root]
}

/**
 * Reduce one engine match to a splice, or drop it when the payload is
 * unusable. A match without a `replacement` means the engine did not expand
 * the rewrite, which makes the whole run untrustworthy rather than partially
 * usable.
 * @param match - one element of the engine's JSON array.
 * @returns the reduced site.
 * @throws when the match lacks a byte range or an expanded replacement.
 */
export function reduceMatch(match: AstGrepMatch): AstSite {
  const { file, replacement, text } = match
  const byteStart = match.range?.byteOffset?.start
  const byteEnd = match.range?.byteOffset?.end
  if (typeof file !== 'string' || typeof byteStart !== 'number' || typeof byteEnd !== 'number') {
    throw new Error(`ast_edit: ast-grep returned a match without a file/byte range: ${JSON.stringify(match).slice(0, 200)}`)
  }
  if (text === undefined) {
    throw new Error('ast_edit: ast-grep returned a match without its text; the site cannot be verified, so the run is refused')
  }
  if (typeof replacement !== 'string') {
    throw new Error('ast_edit: ast-grep returned no replacement for a match; the installed ast-grep is too old to expand --rewrite in --json output')
  }
  return {
    file: file.replace(/^\.\//, '').replaceAll('\\', '/'),
    byteStart,
    byteEnd,
    text,
    replacement,
  }
}

/**
 * Run one rewrite query and reduce its matches to splices. Nothing is written.
 * @param options.pattern - structural pattern.
 * @param options.replacement - replacement template.
 * @param options.glob - `--globs` filter.
 * @param options.root - absolute search root.
 * @param options.signal - caller's cancellation.
 * @param options.timeoutMs - engine timeout; `DEFAULT_ENGINE_TIMEOUT_MS` by default.
 * @returns the matched sites in engine order.
 * @throws when the engine cannot start, returns non-JSON, or returns a
 *   malformed match.
 */
export async function findSites(options: {
  pattern: string
  replacement: string
  glob: string
  root: string
  signal: AbortSignal
  timeoutMs?: number
}): Promise<AstSite[]> {
  const engine = await loadEngine()
  const argv = buildRewriteArgs(options.pattern, options.replacement, options.glob, options.root)
  let raw: string
  try {
    raw = await engine.runAstGrep(argv, options.root, options.signal, options.timeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes(MISSING_BINARY_MARKER)) throw error
    throw new Error(
      'ast_edit: the ast-grep executable is not installed. Install it with `npm install -g @ast-grep/cli`, '
      + '`brew install ast-grep`, or `cargo install ast-grep --locked`, then retry.',
    )
  }

  let matches: unknown
  try {
    matches = JSON.parse(raw)
  } catch {
    throw new Error(`ast_edit: ast-grep did not return JSON (got ${JSON.stringify(raw.slice(0, 200))})`)
  }
  if (!Array.isArray(matches)) throw new Error('ast_edit: ast-grep returned a non-array JSON payload')
  return matches.map(match => reduceMatch(match as AstGrepMatch))
}
