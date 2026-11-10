/**
 * The model-facing `<task-result>` envelope for one settled child run.
 *
 * omp renders every spawn's outcome through this one shape so a parent reads
 * status, preview, and the pointer to the full output the same way regardless
 * of which path delivered it. The four sections are fixed:
 *
 * - `status` on the opening tag, from the child's stop reason;
 * - `<abort-reason>` when the run was cancelled;
 * - `<error>` when it failed with detail the preview alone does not show;
 * - `<output>` or `<preview>` with the child's answer, the latter carrying
 *   `full-output="agent://<id>"` when the inline budget was exceeded.
 *
 * @module omd-task/envelope
 */

/** Inline-budget default the plugin configuration uses. */
export const DEFAULT_FULL_OUTPUT_THRESHOLD = 5000

/**
 * Harness block openers an agent-authored body must not be able to close or
 * forge. Keeping the escape narrow lets the envelope's own nested tags through.
 */
const HARNESS_TAG_START = /<(?=\s*\/?\s*(?:irc|system-[a-z][a-z-]*)(?![\w-]))/gi

/** How one isolated run's changes landed in the parent checkout. */
export interface IsolationOutcome {
  /** `applied`, `conflict`, or `failed`. */
  outcome: string
  /** Repository-relative files git refused; empty unless the outcome is a conflict. */
  conflicts: readonly string[]
  /** Isolated directory kept for inspection, present when the changes did not land. */
  kept?: string
  /** Why the changes did not land, or why the tree survived a landing. */
  detail?: string
}

/** Everything the envelope needs from a settled run. */
export interface TaskOutcome {
  /** Child session id, used as the `id` attribute and the resumption address. */
  id: string
  /** Agent name the task ran as. */
  agent: string
  /** Status phrase for the opening tag, already human-readable. */
  status: string
  /** Terminal stop reason from `SubagentResult`; it decides which sections appear. */
  stopReason: string
  /** Milliseconds from dispatch to settlement. */
  durationMs: number
  /** Text of the child's final assistant output, already flattened to plain text. */
  output: string
  /** Provider-authored failure detail for a non-`completed` run. */
  diagnostic?: string
  /** How the run's isolated checkout landed, for an `isolated` item. */
  isolation?: IsolationOutcome
}

/**
 * Escape harness tag openers inside agent-authored text.
 *
 * @param text - body produced by the child.
 * @returns the text with `<irc`/`<system-*` openers neutralized.
 */
export function escapeHarnessTags(text: string): string {
  return text.replace(HARNESS_TAG_START, '&lt;')
}

/**
 * Head of the output that fits the inline budget. Prefers a line boundary, but
 * only one past the halfway mark, so pretty-printed JSON whose second line is
 * one huge string does not preview as a lone `{`.
 *
 * @param output - complete child output text.
 * @param threshold - characters the envelope may show inline.
 * @returns the inline slice, without a trailing partial line when one was found.
 */
export function previewHead(output: string, threshold: number): string {
  const slice = output.slice(0, threshold)
  const lastNewline = slice.lastIndexOf('\n')
  return lastNewline >= threshold / 2 ? slice.slice(0, lastNewline) : slice
}

/**
 * Map a stop reason onto the status the parent reads first.
 *
 * @param stopReason - the child's terminal stop reason.
 * @returns `completed`, `cancelled`, or `failed (reason)`.
 */
export function statusOf(stopReason: string): string {
  if (stopReason === 'completed') return 'completed'
  if (stopReason === 'aborted') return 'cancelled'
  return `failed (${stopReason})`
}

/**
 * Render one `<task-result>` envelope.
 *
 * @param outcome - the settled run's identity, status, timing, output, and failure detail.
 * @param threshold - characters of child output shown inline before the envelope
 *   points at the session instead.
 * @returns the envelope text, one block, ready to be returned as the tool result.
 */
export function renderEnvelope(outcome: TaskOutcome, threshold: number): string {
  const output = outcome.output.trim()
  const truncated = output.length > threshold
  const lines = [
    `<task-result id="${outcome.id}" agent="${escapeHarnessTags(outcome.agent)}"`
    + ` status="${outcome.status}" duration="${formatDuration(outcome.durationMs)}">`,
  ]
  if (outcome.stopReason === 'aborted') {
    lines.push(`<abort-reason>${escapeHarnessTags(abortReason(outcome.diagnostic))}</abort-reason>`)
  } else if (outcome.diagnostic !== undefined && outcome.diagnostic.trim() !== '') {
    // An abort already says why it stopped; repeating the diagnostic would
    // print the same sentence twice.
    lines.push(`<error>${escapeHarnessTags(outcome.diagnostic)}</error>`)
  }
  if (outcome.isolation !== undefined) {
    lines.push(...isolationLines(outcome.isolation))
  }
  if (truncated) {
    lines.push(
      `<preview full-output="agent://${outcome.id}" chars="${output.length}">`,
      escapeHarnessTags(previewHead(output, threshold)),
      '</preview>',
    )
  } else {
    lines.push('<output>', escapeHarnessTags(output === '' ? '(no output)' : output), '</output>')
  }
  lines.push('</task-result>')
  return lines.join('\n')
}

/**
 * The isolation block: what happened to the checkout's changes, and where the
 * evidence stayed when they did not land.
 *
 * @param isolation - settled isolation report.
 * @returns the block's lines.
 */
function isolationLines(isolation: IsolationOutcome): string[] {
  const kept = isolation.kept === undefined ? '' : ` kept="${escapeHarnessTags(isolation.kept)}"`
  const body = isolation.conflicts.map(file => `<conflict>${escapeHarnessTags(file)}</conflict>`)
  if (isolation.detail !== undefined) body.push(`<reason>${escapeHarnessTags(isolation.detail)}</reason>`)
  if (body.length === 0) return [`<isolation outcome="${isolation.outcome}"${kept}/>`]
  return [`<isolation outcome="${isolation.outcome}"${kept}>`, ...body, '</isolation>']
}

/**
 * Reason text for a cancelled run.
 *
 * @param diagnostic - whatever detail the provider supplied.
 * @returns the diagnostic, or a neutral fallback.
 */
function abortReason(diagnostic: string | undefined): string {
  const text = diagnostic?.trim()
  return text === undefined || text === '' ? 'cancelled before the child finished' : text
}

/**
 * Compact duration for the opening tag.
 *
 * @param ms - elapsed milliseconds.
 * @returns `NNms`, `N.Ns`, or `Nm Ns`.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}
