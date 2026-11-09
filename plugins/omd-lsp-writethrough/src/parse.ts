/**
 * Parsing the `lsp_diagnostics` tool result back into structured diagnostics.
 *
 * The only LSP surface dsh exposes to a plugin is the community `dsh-tool-lsp`
 * tool set: it keeps its server sessions in its own closure and publishes no
 * `ctx.lsp` provider that would hand out raw diagnostics. So this plugin calls
 * the `lsp_diagnostics` tool and reads the text it renders, which follows a
 * single stable line format (`lib/render.js` in `dsh-tool-lsp`):
 *
 * ```text
 * src/a.ts: 2 error, 1 warning (pull+pushed)
 *   error 10:5-10:15 [typescript] (TS2307): Cannot find module 'x'
 * ```
 *
 * Parsing text instead of a typed payload is a deliberate trade, not a
 * limitation of the package: `dsh-tool-lsp` declares no `exports` map, so its
 * `lib/runner.js` (and with it `LspSession`) is importable, and a version-exact
 * pass could read `OpenDocument.version` directly. Doing that means owning a
 * second document table and a second `tsserver` per workspace, which costs more
 * than the freshness it buys: this plugin only needs "is the answer newer than
 * the write", and the write token answers that without a second server.
 *
 * The parser is strict about the prefix and lenient about the message, so an
 * unrecognized line is skipped rather than misreported. A clean file renders as
 * `<path>: no diagnostics`, which parses to an empty list; a truncation line
 * (`… N more not shown`) likewise matches nothing and is ignored.
 *
 * @module omd-lsp-writethrough/parse
 */

import type { NormalizedDiagnostic } from './filter.ts'

/**
 * One rendered diagnostic line: `severity line:col[-end] [source] (code): message`.
 *
 * The range tail is optional because a single-position diagnostic renders as
 * `line:col` alone; source and code are optional independently, because a server
 * may omit either.
 */
const DIAGNOSTIC_LINE = /^ {2}(error|warning|information|hint) (\d+):(\d+)(?:-[^\s]*)?(?: \[([^\]]*)\])?(?: \(([^)]*)\))?: (.*)$/

/**
 * Narrow a matched severity capture to the vocabulary the renderer emits.
 * @param value - the captured word.
 * @returns the severity, or `undefined` when the capture is not one of the four.
 */
function severityOf(value: string): NormalizedDiagnostic['severity'] | undefined {
  return value === 'error' || value === 'warning' || value === 'information' || value === 'hint'
    ? value
    : undefined
}

/**
 * Parse the rendered text of one `lsp_diagnostics` result.
 *
 * @param text - the tool result's text, as `dsh-tool-lsp` rendered it.
 * @returns the structured diagnostics; an unparseable line is skipped, and a
 *   "no diagnostics" result yields an empty array.
 */
export function parseDiagnosticsText(text: string): NormalizedDiagnostic[] {
  const diagnostics: NormalizedDiagnostic[] = []
  for (const line of text.split('\n')) {
    const match = DIAGNOSTIC_LINE.exec(line)
    if (match === null) continue
    const [, severityWord, lineNumber, column, source, code, message] = match
    if (severityWord === undefined || lineNumber === undefined || column === undefined || message === undefined) {
      continue
    }
    const severity = severityOf(severityWord)
    if (severity === undefined) continue
    diagnostics.push({
      severity,
      line: Number(lineNumber),
      column: Number(column),
      message,
      ...source === undefined || source === '' ? {} : { source },
      ...code === undefined || code === '' ? {} : { code },
    })
  }
  return diagnostics
}

/**
 * Extract the tool result's text.
 *
 * A tool result carries an ordered block list; the diagnostic renderer emits one
 * text block, so every text block is joined in order and non-text blocks are
 * ignored.
 *
 * @param content - the result's content blocks.
 * @returns the concatenated text, or `''` when the result carried no text.
 */
export function textOfContent(content: readonly { type: string; text?: string }[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}
