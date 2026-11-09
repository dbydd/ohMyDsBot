/**
 * Host-only `omdToolEvidence` projection: per-call eviction / evidence flags.
 *
 * The fold records one entry per tool call id. It is host-only (no wire view)
 * so it never reaches the browser; it exists so a future UI can inspect which
 * results were suppressed and which bash runs produced passing evidence.
 *
 * `tool/result` events carry no tool name, so the fold also remembers the name
 * from the matching `tool/call` (and nested `tool/ptc-dispatch-start`)
 * events. State stays plain JSON: names are a record, not a Map.
 *
 * @module omd-tool-eviction/projection
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'

import type { EvictionCriteria, EvictionDecision } from './classify.ts'
import { classifyResult } from './classify.ts'

/** One recorded entry. */
export interface ToolEvidenceEntry {
  readonly evidence: boolean
  readonly evicted: boolean
}

/** Whole projection state: names remembered from call events, flags per call id. */
export interface ToolEvidenceState {
  readonly names: Record<string, string>
  readonly entries: Record<string, ToolEvidenceEntry>
}

const entrySchema = z.object({
  evidence: z.boolean(),
  evicted: z.boolean(),
})

export const stateSchema: z.ZodType<ToolEvidenceState> = z.object({
  names: z.record(z.string(), z.string()),
  entries: z.record(z.string(), entrySchema),
})

/** Initial state: no recorded calls. */
export function emptyEvidenceState(): ToolEvidenceState {
  return { names: {}, entries: {} }
}

/** Extract concatenated model-facing text from one tool result's content blocks. */
function resultText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/**
 * Pure fold: one committed session event → next evidence state.
 *
 * `tool/call` and `tool/ptc-dispatch-start` events record the tool name for a
 * call id; `tool/result` events classify the outcome. Every other event
 * returns the same state reference so the eager drive produces no work.
 *
 * @param state - the current evidence state.
 * @param event - the committed session event.
 * @param criteria - prefixes and the empty-result length threshold.
 * @returns the next state (same reference when the event is not relevant).
 */
export function applyToolEvidence(
  state: ToolEvidenceState,
  event: SessionEvent,
  criteria: EvictionCriteria,
): ToolEvidenceState {
  if (event.type === 'tool/call') {
    const callId = String(event.data.callId)
    if (state.names[callId] === event.data.name) return state
    return { ...state, names: { ...state.names, [callId]: event.data.name } }
  }

  if (event.type === 'tool/ptc-dispatch-start') {
    const callId = String(event.data.subCallId)
    if (state.names[callId] === event.data.name) return state
    return { ...state, names: { ...state.names, [callId]: event.data.name } }
  }

  if (event.type !== 'tool/result') return state

  const callId = String(event.data.message.source.callId)
  const toolName = state.names[callId] ?? ''
  const decision: EvictionDecision = classifyResult(
    toolName,
    resultText(event.data.message.content),
    event.data.message.isError === true,
    typeof event.data.meta === 'object' && event.data.meta !== null
      ? (event.data.meta as { useless?: boolean })
      : undefined,
    criteria,
  )

  const existing = state.entries[callId]
  if (existing !== undefined && existing.evidence === decision.evidence && existing.evicted === decision.evict) {
    return state
  }

  return {
    ...state,
    entries: { ...state.entries, [callId]: { evidence: decision.evidence, evicted: decision.evict } },
  }
}