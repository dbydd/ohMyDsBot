/**
 * Pure prompt construction for `/handoff`.
 *
 * The prompt does three things and nothing else: pins the four output headings,
 * tells the model what kind of evidence to keep, and hands over the session's
 * own projections as typed facts rather than asking the model to infer them from
 * prose. Splitting it out of the command keeps it testable without a Context.
 *
 * @module omd-handoff/prompt
 */

import {
  NOTHING_TO_HAND_OFF,
  SECTION_HEADINGS,
  type GoalEntry,
  type HandoffInputs,
  type TodoEntry,
} from './types.ts'

/** Cap on transcript bytes sent to the model; older bytes are cut first. */
export const DEFAULT_TRANSCRIPT_BYTES = 96 * 1024

/** Fixed system prompt. Stable across calls so the provider's prefix cache is reused. */
export const HANDOFF_SYSTEM = [
  'You write a handoff document for another instance of yourself, which will continue the work with no access to this conversation.',
  'Output ONLY the document. No preamble, no commentary, no code fence around it.',
  'Address the successor directly in the imperative ("Fix X", "Run Y"). Never use first person.',
  'Capture exact technical state, not abstractions: file paths, symbol names, commands run, observed failures, and decisions with their rationale.',
  'Never list writing or generating this document as progress or as a next step; Progress and Next steps cover the user\'s task only.',
  'Use exactly this structure, keeping all four headings in order:',
  '## Objective',
  '[what the user is trying to accomplish, including the goal and emphasis below]',
  '## Progress',
  '[done / in progress / pending, with specifics; use the todo list as evidence of what remains]',
  '## Decisions',
  '[decisions made and why; constraints and corrections the user gave]',
  '## Next steps',
  '[the concrete next actions, most urgent first]',
  'Write "(none)" for a section with no content. Never drop a heading.',
].join('\n')

/** Render the todo list as one line per entry, or "(none)". */
function renderTodos(todos: readonly TodoEntry[] | null): string {
  if (todos === null || todos.length === 0) return '(none)'
  return todos.map(todo => `- [${todo.status}] ${todo.content}`).join('\n')
}

/** Render the goal as objective plus phase, or "(none)". */
function renderGoal(goal: GoalEntry | null): string {
  return goal === null ? '(none)' : `${goal.objective} (phase: ${goal.phase})`
}

/**
 * Cut a transcript at a byte budget without splitting a UTF-8 sequence.
 * @param transcript - the rendered conversation.
 * @param maxBytes - budget in UTF-8 bytes.
 * @returns the transcript, or its newest tail within the budget, marked as cut.
 */
export function capTranscript(transcript: string, maxBytes: number = DEFAULT_TRANSCRIPT_BYTES): string {
  const bytes = Buffer.byteLength(transcript, 'utf8')
  if (bytes <= maxBytes) return transcript
  // Slice by characters until the encoded length fits; a buffer cut mid-sequence
  // would produce U+FFFD at the seam and corrupt a path or an identifier there.
  // Bytes-to-characters is one-to-one or worse, so the start is already a bound.
  let low = 0
  let high = Math.min(transcript.length, maxBytes)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(transcript.slice(transcript.length - mid), 'utf8') <= maxBytes) low = mid
    else high = mid - 1
  }
  const tail = transcript.slice(transcript.length - low)
  // Start at a line boundary when one exists, so the first visible line is whole.
  const firstBreak = tail.indexOf('\n')
  const aligned = firstBreak === -1 ? tail : tail.slice(firstBreak + 1)
  return `[earlier transcript omitted: ${bytes - Buffer.byteLength(aligned, 'utf8')} bytes over budget]\n${aligned}`
}

/**
 * Build the one user message a handoff call sends.
 *
 * @param inputs - the session's projections and rendered transcript.
 * @param maxTranscriptBytes - transcript budget; defaults to 96 KiB.
 * @returns the prompt text, headed by the emphasis when the user supplied one.
 */
export function buildHandoffPrompt(
  inputs: HandoffInputs,
  maxTranscriptBytes: number = DEFAULT_TRANSCRIPT_BYTES,
): string {
  if (inputs.transcript.trim().length === 0) {
    throw new Error(NOTHING_TO_HAND_OFF)
  }
  const lines = [
    ...inputs.focus.length === 0 ? [] : [`Focus: ${inputs.focus}`, ''],
    '<recorded-goal>',
    renderGoal(inputs.goal),
    '</recorded-goal>',
    '',
    '<recorded-todos>',
    renderTodos(inputs.todos),
    '</recorded-todos>',
    '',
    '<transcript>',
    capTranscript(inputs.transcript, maxTranscriptBytes),
    '</transcript>',
  ]
  return lines.join('\n')
}

/**
 * Whether a produced document carries every heading the contract names.
 *
 * Used before the document is returned to the UI: a model that drops a heading
 * would otherwise publish a handoff the successor cannot rely on.
 * @param body - the model's document text.
 * @returns true when all four headings appear, in order.
 */
export function hasAllSections(body: string): boolean {
  let from = 0
  for (const heading of SECTION_HEADINGS) {
    const found = body.indexOf(heading, from)
    if (found === -1) return false
    from = found + heading.length
  }
  return true
}
