/**
 * The `loop` session projection: loop state derived entirely from the log.
 *
 * A tree-external plugin cannot append a session event type of its own, so
 * `/loop` never writes state directly. Every durable transition is derived
 * from events the harness already writes:
 *
 * - `command/run` (name `loop`) arms, re-arms, or closes the loop, re-parsing
 *   the logged raw input — the same pure grammar the command handler uses.
 * - `user/message` carrying this plugin's source kind is one delivered
 *   iteration, so the budget decrements from the log and survives resume.
 * - `turn/start` / `turn/end` supply the open turn, the last delivery turn,
 *   duration expiry, and the cancel that suspends an armed loop.
 *
 * `active` is the armed flag; `paused` and `finished` say why it is not
 * delivering. Wall-clock expiry is folded at turn boundaries and re-checked at
 * delivery time, so a deadline that passes mid-turn still closes the loop.
 *
 * @module omd-loop/projection
 */

import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-llm'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { LOOP_COMMAND, parseLoopArgs } from './args.ts'

declare module '@deepseek-ai/dsh-llm' {
  /** Loop-injected messages, distinguishable from ordinary user prompts in the log. */
  interface MessageSourceMap {
    'omd-loop':
      | { kind: 'omd-loop'; readonly form?: never }
      | { kind: 'omd-loop'; readonly form: 'notice'; readonly summary: string }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host-only `/loop` state, folded from `command/run`, `user/message`, and turn boundaries. */
    loop: LoopState
  }
}

/** Host-only loop state. Plain JSON, so it checkpoints and resumes with the log. */
export interface LoopState {
  /** Loop body; `null` while the loop is armed and waiting for the user's next prompt. */
  prompt: string | null
  /** Iterations left; `null` when the loop has no iteration limit. */
  remaining: number | null
  /** Epoch-millisecond deadline; `null` when the loop has no duration limit. */
  until: number | null
  /** Whether the loop is armed. */
  active: boolean
  /** Whether a cancelled turn suspended the armed loop until the next user prompt. */
  paused: boolean
  /** Whether the loop stopped because a limit ran out. */
  finished: boolean
  /** Turn currently open in the log, or `null` between turns. */
  turn: number | null
  /** Turn that admitted this plugin's most recent prompt delivery. */
  deliveryTurn: number | null
}

/** Validated shape of {@link LoopState}. */
const loopStateSchema = z.object({
  prompt: z.string().nullable(),
  remaining: z.number().int().nullable(),
  until: z.number().nullable(),
  active: z.boolean(),
  paused: z.boolean(),
  finished: z.boolean(),
  turn: z.number().nullable(),
  deliveryTurn: z.number().nullable(),
})

/**
 * Read the model-facing text of one user message.
 * @param message - the logged user message.
 * @returns its text blocks joined by newlines, trimmed.
 */
function messageText(message: UserMessage): string {
  return message.content
    .flatMap(block => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim()
}

/** The empty state: no loop has ever been armed in this session. */
const EMPTY: LoopState = {
  prompt: null,
  remaining: null,
  until: null,
  active: false,
  paused: false,
  finished: false,
  turn: null,
  deliveryTurn: null,
}

/**
 * Narrow a `command/run` payload recorded by this plugin's own surface.
 *
 * `@deepseek-ai/dsh-commands` is not on this package's runtime link path, so
 * its event declaration is not visible here. The harness writes the payload
 * before this fold reads it; the predicate checks the two recorded fields the
 * fold uses.
 * @param data - the event's recorded payload.
 * @returns whether the payload names the `/loop` command with recorded input.
 */
function loopCommandInput(data: unknown): data is { name: string; args: string } {
  if (typeof data !== 'object' || data === null) return false
  if (!('name' in data) || data.name !== LOOP_COMMAND) return false
  return 'args' in data && typeof data.args === 'string'
}

/**
 * Fold one committed session event into the loop state.
 * @param state - state covering every earlier event.
 * @param event - the next committed event.
 * @returns the next state, or `state` itself when the event is not ours.
 */
function applyLoopEvent(state: LoopState, event: SessionEvent): LoopState {
  switch (event.type) {
    case 'command/run': {
      if (!loopCommandInput(event.data)) return state
      const spec = parseLoopArgs(event.data.args)
      // A bare status query changes nothing; an invalid budget the handler
      // rejected is not recorded as a decision either.
      if (typeof spec === 'string' || spec.kind === 'status') return state
      if (spec.kind === 'off') {
        // Only bare `/loop off` reaches here, so it always closes, including a
        // loop that already finished.
        if (!state.active && !state.finished) return { ...state, prompt: null }
        return { ...EMPTY, turn: state.turn, deliveryTurn: state.deliveryTurn }
      }
      return {
        ...state,
        prompt: spec.prompt,
        remaining: spec.remaining,
        until: spec.durationMs === null ? null : event.time + spec.durationMs,
        active: true,
        paused: false,
        finished: false,
      }
    }
    case 'user/message': {
      const source = event.data.source
      if (source.kind === 'omd-loop') {
        // A notice records the stop; only a prompt delivery spends budget.
        if (source.form === 'notice' || !state.active) return state
        const remaining = state.remaining === null ? null : Math.max(0, state.remaining - 1)
        const exhausted = remaining === 0
        return {
          ...state,
          remaining,
          active: !exhausted,
          finished: state.finished || exhausted,
          deliveryTurn: state.turn,
        }
      }
      if (source.kind !== 'user' || !state.active) return state
      // A human prompt becomes the loop body and resumes a suspended loop.
      const text = messageText(event.data)
      if (text === '') return state
      return { ...state, prompt: text, paused: false }
    }
    case 'turn/start': {
      const expired = state.until !== null && event.time >= state.until
      if (expired && state.active) return { ...state, turn: event.data.turn, active: false, finished: true }
      return { ...state, turn: event.data.turn }
    }
    case 'turn/end': {
      const expired = state.until !== null && event.time >= state.until
      if (expired && state.active) return { ...state, turn: null, active: false, finished: true }
      if (event.data.reason.kind === 'aborted' && state.active) return { ...state, turn: null, paused: true }
      return state.turn === null ? state : { ...state, turn: null }
    }
    default:
      return state
  }
}

/** Registration payload for the host-only `loop` unit. */
export const loopProjectionDefinition = {
  key: 'loop',
  stateVersion: 1,
  stateSchema: loopStateSchema,
  init: () => EMPTY,
  apply: applyLoopEvent,
} satisfies ProjectionDefinition<'loop', LoopState>

/**
 * Whether the loop should deliver one more prompt right now.
 *
 * Narrows `prompt` to a string, so callers can build the delivered message
 * without a second check.
 * @param state - current loop state, or `undefined` before registration.
 * @param now - current epoch milliseconds.
 * @returns whether an armed, unpaused, unexhausted loop has a body to deliver.
 */
export function deliveringNow(state: LoopState | undefined, now: number): state is LoopState & { prompt: string } {
  return state !== undefined
    && state.active
    && !state.paused
    && state.prompt !== null
    && (state.remaining === null || state.remaining > 0)
    && (state.until === null || now < state.until)
}

/**
 * Whether this turn end is the one that closes the loop, so the closing notice
 * is logged exactly once: the deadline passed while the loop was armed, or the
 * iteration budget ran out on a delivery in this turn.
 * @param state - current loop state, or `undefined` before registration.
 * @param now - current epoch milliseconds.
 * @returns whether the turn-stopping boundary should record the stop.
 */
export function stopsAtThisTurnEnd(state: LoopState | undefined, now: number): boolean {
  if (state === undefined) return false
  if (state.active && state.until !== null && now >= state.until) return true
  return state.finished && state.deliveryTurn !== null && state.deliveryTurn === state.turn
}
