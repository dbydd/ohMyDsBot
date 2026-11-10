/**
 * Rendering diagnostic sets into the two shapes the plugin emits.
 *
 * Two decisions live here and nowhere else:
 *
 *  - **Only new problems are worth the model's attention.** A file that was
 *    already carrying twelve errors must not have those twelve re-reported after
 *    every edit; the model would re-read the same list and spend the turn
 *    deciding nothing new. The summary is therefore diffed against the set
 *    already shown for that file, which the caller keeps in a ledger.
 *  - **Zero diagnostics is silence.** Appending "no diagnostics" to a clean
 *    write is pure noise. An empty `<diagnostics>` block trains the model to
 *    skip the tag on the one write where it matters, so nothing is appended.
 *
 * @module omd-lsp-writethrough/format
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import type { NormalizedDiagnostic } from './filter.ts'

/**
 * A stable identity for one diagnostic, used to tell new ones from carried-over ones.
 * @param diagnostic - the normalized diagnostic.
 * @returns a key unique to that diagnostic within a file.
 */
export function diagnosticKey(diagnostic: NormalizedDiagnostic): string {
  return [
    diagnostic.severity,
    diagnostic.line,
    diagnostic.column,
    diagnostic.code ?? '',
    diagnostic.message,
  ].join('\u0000')
}

/**
 * Render one diagnostic as `severity file:line:col message (code)`.
 * @param file - the path the model wrote, as it wrote it.
 * @param diagnostic - the diagnostic to render.
 * @returns one line, with the message collapsed onto it.
 */
export function formatDiagnosticLine(file: string, diagnostic: NormalizedDiagnostic): string {
  const code = diagnostic.code === undefined ? '' : ` (${diagnostic.code})`
  return `${diagnostic.severity} ${file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}${code}`
}

/**
 * Render a diagnostic list, capped already by the caller, plus the omission note.
 * @param file - the written path.
 * @param diagnostics - the diagnostics to render.
 * @param total - how many diagnostics existed before the cap.
 * @returns one line per diagnostic, plus an omission note when the cap bit.
 */
function diagnosticLines(
  file: string,
  diagnostics: readonly NormalizedDiagnostic[],
  total: number,
): string[] {
  const lines = diagnostics.map((diagnostic) => formatDiagnosticLine(file, diagnostic))
  const omitted = total - diagnostics.length
  if (omitted > 0) lines.push(`… ${omitted} more not shown`)
  return lines
}

/**
 * Render the summary block appended to a tool result.
 * @param file - the written path.
 * @param diagnostics - the new diagnostics, already filtered and capped.
 * @param total - how many new diagnostics existed before the cap.
 * @returns the block body including its leading blank line, or `''` when there is nothing to say.
 */
export function formatDiagnosticsBlock(
  file: string,
  diagnostics: readonly NormalizedDiagnostic[],
  total: number,
): string {
  if (diagnostics.length === 0) return ''
  return `\n\n<diagnostics>\n${diagnosticLines(file, diagnostics, total).join('\n')}\n</diagnostics>`
}

/**
 * Render the body of a deferred `<system-notice>`.
 * @param file - the written path.
 * @param diagnostics - the new diagnostics, already filtered and capped.
 * @param total - how many new diagnostics existed before the cap.
 * @returns the notice text, or `''` when there is nothing to say.
 */
export function formatDeferredNotice(
  file: string,
  diagnostics: readonly NormalizedDiagnostic[],
  total: number,
): string {
  if (diagnostics.length === 0) return ''
  const lines = diagnosticLines(file, diagnostics, total)
  return `<system-notice>Deferred diagnostics for ${file}:\n${lines.join('\n')}</system-notice>`
}

/**
 * Append the summary to the tool result's existing content.
 *
 * The original blocks are copied first and only ever appended to: the write's
 * own rendered text stays byte-identical, so a clean result is untouched.
 *
 * @param content - the blocks `next()` produced.
 * @param block - the summary to append; an empty string appends nothing.
 * @returns the original array when there is nothing to append, else a new one.
 */
export function appendDiagnostics(
  content: readonly ContentBlock[],
  block: string,
): readonly ContentBlock[] {
  if (block === '') return content
  const appended: ContentBlock = { type: 'text', text: block }
  return [...content, appended]
}
