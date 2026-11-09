/**
 * Orphan-project diagnostic filtering, ported from omp's
 * `src/lsp/diagnostics.ts:109-142`.
 *
 * A TypeScript file opened outside any project the server was configured for
 * produces codes that describe the *absence of a project*, not the file: no
 * `tsconfig.json` means "cannot find module", "cannot use JSX", "not under
 * rootDir". Surfacing those after a write teaches the model to fix a
 * configuration it cannot see and must not touch, so they are dropped.
 *
 * The filter is deliberately narrow: only the listed codes, only for a
 * TypeScript server, and only when no `tsconfig.json` governs the file.
 *
 * @module omd-lsp-writethrough/filter
 */

/** A normalized diagnostic, in the shape the plugin reasons and renders in. */
export interface NormalizedDiagnostic {
  /** `error` / `warning` / `information` / `hint`, as reported. */
  readonly severity: 'error' | 'warning' | 'information' | 'hint'
  /** One-based line. */
  readonly line: number
  /** One-based UTF-16 column. */
  readonly column: number
  /** The server's message, newlines already collapsed. */
  readonly message: string
  /** The server-supplied diagnostic code, when it sent one. */
  readonly code?: string | number
  /** The reporting server's identity: its LSP `source` or the configured server id. */
  readonly source?: string
}

/**
 * Codes a TypeScript server emits only because it never found a project.
 * Mirrors omp's `ORPHAN_TYPESCRIPT_PROJECT_DIAGNOSTIC_CODES`.
 */
const ORPHAN_TYPESCRIPT_CODES: ReadonlySet<number> = new Set([
  1375, // 'await' expressions are only allowed at the top level of a file when that file is a module
  1378, // Top-level 'await' expressions are only allowed when the 'module' option is set to ...
  2307, // Cannot find module 'x' or its corresponding type declarations.
  2580, // Cannot find name 'require' / 'process' / 'Buffer' ...
  2591, // Cannot find name 'require'. Do you need to install type definitions for node?
  2792, // Cannot find module 'x'. Did you mean to set the 'moduleResolution' option ...
  2867, // This import is never used as a value and must use 'import type'
])

/** The project file whose absence marks a file as belonging to no TypeScript project. */
export const TYPESCRIPT_PROJECT_MARKER = 'tsconfig.json'

/**
 * Read a diagnostic code as a number.
 * @param code - the server's code, which the protocol allows as a string.
 * @returns the numeric code, or `null` when it is not numeric.
 */
function numericCode(code: string | number | undefined): number | null {
  if (typeof code === 'number') return Number.isFinite(code) ? code : null
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code)
  return null
}

/**
 * Whether one diagnostic describes a missing TypeScript project rather than the file.
 * @param diagnostic - the normalized diagnostic.
 * @returns true when the source is TypeScript and the code is in the orphan set.
 */
function isOrphanProjectDiagnostic(diagnostic: NormalizedDiagnostic): boolean {
  const source = diagnostic.source?.toLowerCase() ?? ''
  if (source !== 'typescript' && !source.includes('typescript') && source !== 'ts') return false
  const code = numericCode(diagnostic.code)
  return code !== null && ORPHAN_TYPESCRIPT_CODES.has(code)
}

/**
 * Drop orphan-project false positives when the file has no nearby `tsconfig.json`.
 *
 * @param diagnostics - every diagnostic the server reported for the file.
 * @param hasProjectMarker - whether a `tsconfig.json` exists at or above the file's directory.
 * @returns the diagnostics to surface; the input array itself when a project exists.
 */
export function filterOrphanProjectDiagnostics(
  diagnostics: readonly NormalizedDiagnostic[],
  hasProjectMarker: boolean,
): readonly NormalizedDiagnostic[] {
  if (hasProjectMarker) return diagnostics
  return diagnostics.filter((diagnostic) => !isOrphanProjectDiagnostic(diagnostic))
}
