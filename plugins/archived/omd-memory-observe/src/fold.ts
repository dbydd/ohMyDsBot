/**
 * The session-log fold behind the observation package: a pure, replayable
 * transcript of one session's turns.
 *
 * The fold reads only `turn/start`, `turn/end`, `tool/call`, `user/message`,
 * `assistant/message`, and `tool/result`, and it reads nothing else: no clock,
 * no random source, no session read API. Replaying the same event sequence
 * with the same bounds therefore produces a deeply equal state every time,
 * which is what lets the host checkpoint the projection and resume it mid-log.
 *
 * Turn semantics:
 *
 * - `turn/start` opens a turn and discards the previous pending segments, so
 *   an interrupted turn cannot leak into the next one.
 * - message events append a cleaned segment to the open turn; a message
 *   outside an open turn is dropped, because a turn is the unit a retain job
 *   and an injection cursor both speak in.
 * - `turn/end` commits the open turn into the bounded window and advances the
 *   watermark to its own seq, whatever the end reason: the log position is
 *   settled even when the turn produced nothing worth keeping.
 *
 * Cleaning is structural, decided by the block's own type, never by parsing
 * prose: text survives, a tool call becomes `[action name target]`, an image or
 * file becomes a one-word marker, reasoning and developer-plane blocks do not
 * survive at all. A segment whose cleaned text is empty is not stored, so the
 * state holds decisions rather than mechanics.
 *
 * @module omd-memory-observe/fold
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { ZodType } from 'zod'
import { isRetainedSource } from './sources.ts'
import type { RetainedSourceKind } from './sources.ts'

/** The per-turn bounds one fold run applies; the plugin maps its Config onto this. */
export interface ObservationBounds {
  /** Completed turns kept for recent-context reads; at least one. */
  readonly turnWindow: number
  /** Characters kept in one open turn before its oldest segments are dropped. */
  readonly maxChars: number
  /** Characters kept in one segment. */
  readonly maxSegmentChars: number
}

/** Fields every stored segment carries. */
export interface SegmentBase {
  /** Seq of the session event that produced this segment. */
  readonly seq: number
  /** The turn the segment belongs to. */
  readonly turn: number
}

/**
 * One human or agent-authored prompt. `sourceKind` is the narrowed retained
 * kind the message arrived with; an injected source never reaches this type.
 */
export interface UserSegment extends SegmentBase {
  readonly kind: 'user'
  readonly sourceKind: RetainedSourceKind
  readonly text: string
}

/**
 * One model answer, with each requested tool call flattened to
 * `[action name target]` in the order the model emitted it.
 */
export interface AssistantSegment extends SegmentBase {
  readonly kind: 'assistant'
  readonly text: string
}

/**
 * One tool result. `name` is the name recorded on the matching `tool/call`, so
 * a result stays attributable after the call's arguments are gone.
 */
export interface ToolSegment extends SegmentBase {
  readonly kind: 'tool'
  readonly callId: string
  readonly name: string
  readonly isError: boolean
  readonly text: string
}

/** One cleaned utterance inside a turn. */
export type ObservedSegment = UserSegment | AssistantSegment | ToolSegment

/** The open turn: the segments a retain job would read if the turn ended now. */
export interface PendingTurn {
  readonly turn: number
  /** Seq of the `turn/start` that opened this turn. */
  readonly startSeq: number
  readonly segments: readonly ObservedSegment[]
  /** Whether the character bound dropped the oldest segments. */
  readonly truncated: boolean
}

/** A turn the log has closed and the fold has committed. */
export interface CommittedTurn extends PendingTurn {
  /** Seq of the `turn/end` that closed this turn; the fold's watermark afterwards. */
  readonly throughSeq: number
}

/**
 * The whole projection state: plain JSON so the projection cache can persist
 * it, and bounded in both dimensions — at most `turnWindow` committed turns and
 * at most `maxChars` in the open one.
 */
export interface ObservationState {
  /** The turn number of the open turn, or of the last opened turn once closed. */
  readonly turn: number
  /** Whether a `turn/start` is still awaiting its `turn/end`. */
  readonly open: boolean
  /** Seq of the open turn's `turn/start`; `-1` when no turn is open. */
  readonly startSeq: number
  /** Segments of the open turn, oldest first. */
  readonly pending: readonly ObservedSegment[]
  /** Committed turns, oldest first, bounded by `turnWindow`. */
  readonly committed: readonly CommittedTurn[]
  /** Seq of the last folded `turn/end`; `-1` before the first commit. */
  readonly throughSeq: number
  /** `tool/call` id → tool name, for the open turn only. */
  readonly toolNames: Readonly<Record<string, string>>
  /** Whether the open turn has dropped segments because of `maxChars`. */
  readonly truncated: boolean
}

/** No recorded tool names; shared so a turn boundary allocates nothing. */
const NO_TOOL_NAMES: Readonly<Record<string, string>> = Object.freeze({})

/** One stored segment as persisted. */
const segmentSchema: ZodType<ObservedSegment> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    seq: z.number().int().nonnegative(),
    turn: z.number().int().nonnegative(),
    sourceKind: z.enum(['user', 'model', 'tool']),
    text: z.string(),
  }).strict(),
  z.object({
    kind: z.literal('assistant'),
    seq: z.number().int().nonnegative(),
    turn: z.number().int().nonnegative(),
    text: z.string(),
  }).strict(),
  z.object({
    kind: z.literal('tool'),
    seq: z.number().int().nonnegative(),
    turn: z.number().int().nonnegative(),
    callId: z.string(),
    name: z.string(),
    isError: z.boolean(),
    text: z.string(),
  }).strict(),
])

/** One committed turn as persisted. */
const committedSchema: ZodType<CommittedTurn> = z.object({
  turn: z.number().int().nonnegative(),
  startSeq: z.number().int().nonnegative(),
  throughSeq: z.number().int().nonnegative(),
  segments: z.array(segmentSchema),
  truncated: z.boolean(),
}).strict()

/**
 * The persisted shape of {@link ObservationState}. The projection registry
 * validates every checkpoint row against it before it seeds a fold, so this
 * schema is the contract with state written by an older build.
 */
export const observationStateSchema: ZodType<ObservationState> = z.object({
  turn: z.number().int().nonnegative(),
  open: z.boolean(),
  startSeq: z.number().int().min(-1),
  pending: z.array(segmentSchema),
  committed: z.array(committedSchema),
  throughSeq: z.number().int().min(-1),
  toolNames: z.record(z.string(), z.string()),
  truncated: z.boolean(),
}).strict()

/**
 * Keys tried, in order, for a compact tool-action target. The list is the
 * write-back discipline the upstream transcript cleaner already settled on:
 * retain what was touched, not the argument object.
 */
const TOOL_TARGET_KEYS = [
  'file_path',
  'path',
  'notebook_path',
  'command',
  'pattern',
  'query',
  'url',
  'name',
  'id',
] as const

/** Cap for one tool target, in characters. */
const TARGET_CAP = 100

/**
 * Bound one text run, marking an ellipsis so a reader can tell it was cut.
 * @param text - the text to bound.
 * @param cap - maximum characters to keep.
 * @returns the text unchanged when it fits, otherwise its prefix and `…`.
 */
export function capText(text: string, cap: number): string {
  if (text.length <= cap) return text
  return `${text.slice(0, Math.max(0, cap - 1))}…`
}

/** The first non-empty line of a raw argument string, bounded. */
function firstLine(text: string): string {
  const line = text.split('\n').find(candidate => candidate.trim() !== '') ?? ''
  return capText(line.trim(), TARGET_CAP)
}

/**
 * Compact a tool call's raw argument JSON to its primary target.
 * @param rawArguments - the argument string exactly as the model produced it.
 * @returns the first of {@link TOOL_TARGET_KEYS} present as a non-empty string,
 * bounded; the raw first line when the arguments are not JSON; `''` otherwise.
 */
export function toolActionTarget(rawArguments: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return firstLine(rawArguments)
  }
  if (typeof parsed === 'string') return firstLine(parsed)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
  for (const key of TOOL_TARGET_KEYS) {
    if (!Object.hasOwn(parsed, key)) continue
    const value = Reflect.get(parsed, key)
    if (typeof value !== 'string' || value.trim() === '') continue
    return firstLine(value)
  }
  return ''
}

/**
 * Clean one message's content blocks into retain-ready text.
 * @param content - the message's blocks, in model order.
 * @param cap - maximum characters to keep.
 * @returns text blocks and compact action lines joined by newlines; image and
 * file blocks become markers; reasoning and tool-plane blocks are dropped.
 */
export function cleanContent(content: readonly ContentBlock[], cap: number): string {
  const lines: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        if (block.text.trim() !== '') lines.push(block.text)
        break
      case 'tool-call': {
        const target = toolActionTarget(block.arguments)
        lines.push(target === '' ? `[action ${block.name}]` : `[action ${block.name} ${target}]`)
        break
      }
      case 'image':
        lines.push('[image]')
        break
      case 'file':
        lines.push('[file]')
        break
      default:
        // Reasoning is not conversation, and tool additions/removals are the
        // developer plane rather than something anyone said.
        break
    }
  }
  return capText(lines.join('\n').trim(), cap)
}

/** The state of a session whose log holds no turn yet. */
export function initialObservation(): ObservationState {
  return {
    turn: 0,
    open: false,
    startSeq: -1,
    pending: [],
    committed: [],
    throughSeq: -1,
    toolNames: NO_TOOL_NAMES,
    truncated: false,
  }
}

/**
 * Build the segment one message event contributes, already cleaned.
 * @param state - state covering every earlier event; its open turn owns the segment.
 * @param event - a `user/message`, `assistant/message`, or `tool/result` event.
 * @param maxSegmentChars - per-segment character bound.
 * @returns the segment, or `undefined` when the message carries nothing to keep.
 */
function segmentOf(
  state: ObservationState,
  event: SessionEvent<'user/message' | 'assistant/message' | 'tool/result'>,
  maxSegmentChars: number,
): ObservedSegment | undefined {
  const base = { seq: event.seq, turn: state.turn }
  switch (event.type) {
    case 'user/message': {
      // Assistant and tool messages carry a fixed source kind in their own
      // type; only a user-role message can arrive from any producer.
      if (!isRetainedSource(event.data.source)) return undefined
      const text = cleanContent(event.data.content, maxSegmentChars)
      if (text === '') return undefined
      return { ...base, kind: 'user', sourceKind: event.data.source.kind, text }
    }
    case 'assistant/message': {
      const text = cleanContent(event.data.message.content, maxSegmentChars)
      if (text === '') return undefined
      return { ...base, kind: 'assistant', text }
    }
    case 'tool/result': {
      const { message } = event.data
      const text = cleanContent(message.content, maxSegmentChars)
      const isError = message.isError === true
      // A successful empty result is mechanics; a failed one is a fact.
      if (text === '' && !isError) return undefined
      return {
        ...base,
        kind: 'tool',
        callId: message.toolCallId,
        name: state.toolNames[message.toolCallId] ?? '',
        isError,
        text,
      }
    }
  }
}

/**
 * Append one segment to the open turn, dropping the oldest segments while the
 * turn exceeds its character bound.
 * @param state - the open-turn state.
 * @param segment - the cleaned segment to append.
 * @param maxChars - character bound for the whole open turn.
 * @returns the next state, or `state` itself when nothing had to change.
 */
function appendSegment(
  state: ObservationState,
  segment: ObservedSegment,
  maxChars: number,
): ObservationState {
  const segments = [...state.pending, segment]
  let total = 0
  for (const kept of segments) total += kept.text.length
  let from = 0
  let truncated = state.truncated
  while (from < segments.length - 1 && total > maxChars) {
    total -= segments[from].text.length
    from += 1
    truncated = true
  }
  return { ...state, pending: from === 0 ? segments : segments.slice(from), truncated }
}

/**
 * Fold one committed session event into the observation state.
 * @param state - state covering every earlier event.
 * @param event - the next committed event.
 * @param bounds - turn-window and character bounds.
 * @returns the next state, or `state` itself for every event the fold ignores.
 */
export function foldObservation(
  state: ObservationState,
  event: SessionEvent,
  bounds: ObservationBounds,
): ObservationState {
  switch (event.type) {
    case 'turn/start':
      return {
        ...state,
        turn: event.data.turn,
        open: true,
        startSeq: event.seq,
        pending: [],
        toolNames: NO_TOOL_NAMES,
        truncated: false,
      }
    case 'turn/end': {
      if (state.throughSeq >= event.seq) return state
      const keep = Math.max(1, bounds.turnWindow)
      const committed = state.open
        ? [...state.committed, {
          turn: state.turn,
          startSeq: state.startSeq,
          throughSeq: event.seq,
          segments: state.pending,
          truncated: state.truncated,
        }].slice(-keep)
        : state.committed
      return {
        ...state,
        open: false,
        startSeq: -1,
        pending: [],
        toolNames: NO_TOOL_NAMES,
        truncated: false,
        throughSeq: event.seq,
        committed,
      }
    }
    case 'tool/call': {
      if (!state.open) return state
      return { ...state, toolNames: { ...state.toolNames, [event.data.callId]: event.data.name } }
    }
    case 'user/message':
    case 'assistant/message':
    case 'tool/result': {
      if (!state.open) return state
      const segment = segmentOf(state, event, Math.min(bounds.maxSegmentChars, bounds.maxChars))
      if (segment === undefined) return state
      return appendSegment(state, segment, bounds.maxChars)
    }
    default:
      return state
  }
}

/**
 * Read the open turn out of one state.
 * @param state - the folded state.
 * @returns the pending turn, or `null` when no turn is open.
 */
export function pendingTurn(state: ObservationState): PendingTurn | null {
  if (!state.open) return null
  return {
    turn: state.turn,
    startSeq: state.startSeq,
    segments: state.pending,
    truncated: state.truncated,
  }
}

/**
 * Read the most recently committed turn out of one state.
 * @param state - the folded state.
 * @returns the last committed turn, or `null` before the first commit.
 */
export function latestTurn(state: ObservationState): CommittedTurn | null {
  return state.committed.at(-1) ?? null
}
