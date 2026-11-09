/**
 * The retained-turn projection: what a finished turn looked like, folded from
 * committed session events.
 *
 * This is the one place the memory backend learns about a conversation, and it
 * learns it from events rather than by reading the session log: synchronous
 * history reads (`eventAt`, `snapshotEvents`, `ownEvents`) are deprecated and
 * closed to new callers, and a plugin may not append records of its own. A
 * session projection is the sanctioned equivalent — the registry drives the
 * fold over every committed event, in order, and hands back the state.
 *
 * The fold is cheap by construction: an event that does not concern it returns
 * the same state reference, so the registry does no downstream work.
 *
 * Two properties matter beyond that:
 *
 * - **No feedback loop.** Anything this plugin itself injects carries the
 *   `memory` source kind; such an entry is never folded back into a turn, so a
 *   recalled block cannot become a memory.
 * - **Bounded.** The state keeps at most `retainMaxContentChars` characters of
 *   projected text, dropping the oldest first and marking the state truncated,
 *   so a long turn costs bounded memory.
 *
 * @module omd-memory/turn
 */

import { z } from 'zod'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Source kind this plugin publishes under. */
export const MEMORY_SOURCE_KIND = 'memory'

/** Context form of an injected recall block: the form the harness reserves for exactly this. */
export const RECALL_FORM = 'recall'

/** One projected entry of a turn. */
export interface TurnEntry {
  /** Which part of the turn this came from. */
  role: 'user' | 'assistant' | 'tool'
  /** Text, already trimmed to what memory needs. */
  text: string
}

/** The projection's state. */
export interface TurnState {
  /** Turn currently being folded; `0` before the first `turn/start`. */
  turn: number
  /** Seq of the highest event folded into this turn. */
  throughSeq: number
  /** Entries of the turn in progress. */
  entries: TurnEntry[]
  /** Whether the character bound already dropped something. */
  truncated: boolean
}

/** The empty state, served before any event arrives. */
export const EMPTY_TURN_STATE: TurnState = { turn: 0, throughSeq: 0, entries: [], truncated: false }

/** Which tool-result policy the projection follows. */
export type ToolResultPolicy = 'errors-only' | 'none' | 'all'

/** What the fold needs to know from configuration. */
export interface TurnFoldOptions {
  /** Character bound on the projected text. */
  maxChars: number
  /** Which tool results survive. */
  toolResults: ToolResultPolicy
}

/** Zod schema of the state, so a checkpoint cannot restore a malformed value. */
const turnStateSchema = z.object({
  turn: z.number().int().min(0),
  throughSeq: z.number().int().min(0),
  entries: z.array(z.object({
    role: z.enum(['user', 'assistant', 'tool']),
    text: z.string(),
  }).strict()),
  truncated: z.boolean(),
}).strict()

/** What one persisted turn looks like, as `ctx.codeFacts` serves it. */
export interface TurnRecord {
  sessionId: string
  turn: number
  throughSeq: number
  entries: TurnEntry[]
  truncated: boolean
}

/**
 * The text of one message's content blocks, skipping non-text blocks.
 * @param message - a session message-shaped value.
 * @returns the concatenated text.
 */
function messageText(message: { readonly content?: readonly unknown[] } | undefined): string {
  const parts: string[] = []
  for (const block of message?.content ?? []) {
    const record = block as { type?: unknown, text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

/**
 * Whether a message was published by this plugin rather than by the user.
 * @param message - a session message-shaped value.
 * @returns true when the message carries the `memory` source kind.
 */
export function isOwnInjection(message: { readonly source?: { readonly kind?: string, readonly form?: string } }): boolean {
  return message.source?.kind === MEMORY_SOURCE_KIND || message.source?.form === RECALL_FORM
}

/**
 * Append one entry, applying the character bound.
 * @param state - current state.
 * @param entry - the entry to append.
 * @param maxChars - character bound.
 * @returns a new state, or the same state when nothing can be appended.
 */
function withEntry(state: TurnState, entry: TurnEntry, maxChars: number): TurnState {
  if (entry.text.trim() === '') return state
  const entries = [...state.entries, entry]
  let total = entries.reduce((sum, current) => sum + current.text.length, 0)
  let truncated = state.truncated
  while (total > maxChars && entries.length > 1) {
    const dropped = entries.shift()
    total -= dropped?.text.length ?? 0
    truncated = true
  }
  return { ...state, entries, truncated }
}

/**
 * Build the fold for one session's projection unit.
 * @param options - the bounds the fold honours.
 * @returns the projection definition minus its key and version.
 */
export function turnFold(options: TurnFoldOptions): {
  stateSchema: z.ZodType<TurnState>
  init: () => TurnState
  apply: (state: TurnState, event: SessionEvent) => TurnState
} {
  return {
    stateSchema: turnStateSchema,
    init: () => EMPTY_TURN_STATE,
    apply: (state, event) => {
      // A turn boundary is where the previous turn stops being pending, and the
      // only place the window resets, so a resumed session starts its next turn
      // from nothing rather than replaying the last one.
      if (event.type === 'turn/start') {
        const turn = event.data.turn
        if (turn === state.turn && state.entries.length === 0) return state
        return { turn, throughSeq: event.seq, entries: [], truncated: false }
      }
      if (event.type === 'user/message') {
        if (isOwnInjection(event.data)) return { ...state, throughSeq: event.seq }
        const text = messageText(event.data)
        return { ...withEntry(state, { role: 'user', text }, options.maxChars), throughSeq: event.seq }
      }
      if (event.type === 'assistant/message') {
        const text = messageText(event.data.message)
        return { ...withEntry(state, { role: 'assistant', text }, options.maxChars), throughSeq: event.seq }
      }
      if (event.type === 'tool/result') {
        if (options.toolResults === 'none') return { ...state, throughSeq: event.seq }
        if (options.toolResults === 'errors-only' && !event.data.message.isError) {
          return { ...state, throughSeq: event.seq }
        }
        const text = messageText(event.data.message)
        return {
          ...withEntry(state, { role: 'tool', text: text === '' ? '(no output)' : text }, options.maxChars),
          throughSeq: event.seq,
        }
      }
      // Every other event advances nothing; returning the same reference is what
      // keeps unrelated traffic free.
      return state
    },
  }
}

/** The projection's key, published as a type table entry so consumers stay typed. */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    omdMemoryTurn: TurnState
  }
}
