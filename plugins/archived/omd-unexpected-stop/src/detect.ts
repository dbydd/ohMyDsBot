/**
 * Pure predicates behind the mechanical unexpected-stop gate: what the newest
 * assistant message says, and whether the step left any visible tool output.
 *
 * Nothing here touches the runtime, so the gate can be reasoned about from the
 * transcript alone.
 *
 * @module omd-unexpected-stop/detect
 */

import type { AssistantMessage, Message } from '@deepseek-ai/dsh-llm'

/** Sentence boundaries inside one line: end punctuation followed by whitespace. */
const SENTENCE_BREAK = /(?<=[.!?])\s+/u

/**
 * Discourse markers in front of a clause that do not change what it promises.
 * Stripping them lets `So, I'll …` and `Now I'll …` reach the cue check.
 */
const LEADING_FILLER = /^(?:(?:ok(?:ay)?|alright|so|and|also|well|now|then)[,.!:]?\s+)+/iu

/** Clause openings that announce the next step instead of reporting a finished one. */
const PENDING_STEP_CUE =
  /^(?:i (?:should|will|am going to)|i'll|i'm going to|let me|let's|let us|next[,.!:]? i|first[,.!:]? i|doing (?:that|it) now|continuing)\b/iu

/** Openings that promise nothing: `Let me know if …` closes a turn. */
const NON_PROMISE = /^let me know\b/iu

/**
 * The last non-empty line's last sentence, trimmed.
 * @param text - visible assistant text, possibly multi-line.
 * @returns the sentence a stop was declared in, or `''` when there is none.
 */
function lastSentence(text: string): string {
  const lines = text.trim().split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? ''
    if (line.length === 0) continue
    return line.split(SENTENCE_BREAK).at(-1)?.trim() ?? ''
  }
  return ''
}

/**
 * Join the visible text blocks of one assistant message.
 * @param message - the message whose text blocks are read.
 * @returns the joined text; `''` for a message with no text block.
 */
export function assistantText(message: AssistantMessage): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Whether the message's final sentence promises a next step it never took.
 *
 * The check is deliberately literal: only the closing clause counts, because a
 * promise earlier in a long message followed by real content is a summary, not
 * a stop. Trailing punctuation and casing are tolerated.
 * @param text - the assistant message's visible text.
 * @returns `true` when the message ends on an unfulfilled promise.
 */
export function endsWithUnfulfilledStep(text: string): boolean {
  const sentence = lastSentence(text)
  if (sentence.length === 0) return false
  const clause = sentence.replace(LEADING_FILLER, '')
  if (NON_PROMISE.test(clause)) return false
  return PENDING_STEP_CUE.test(clause)
}

/**
 * The newest assistant message in a derived transcript.
 * @param messages - messages in conversation order.
 * @returns the last assistant message, or `undefined` when none exists.
 */
export function lastAssistant(messages: readonly Message[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant') return message
  }
  return undefined
}

/**
 * Whether the newest tool result is missing or carries no visible text.
 *
 * A substantive last result means the stop came after the model already had
 * something to work with, so the mechanical gate stays silent there.
 * @param messages - messages in conversation order.
 * @returns `true` when there is no tool message, or its content holds no text.
 */
export function lastToolResultIsEmpty(messages: readonly Message[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'tool') continue
    return message.content.every(block => block.type === 'text' && block.text.trim().length === 0)
  }
  return true
}
