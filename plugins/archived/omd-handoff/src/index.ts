/**
 * `omd-handoff` — a `/handoff` command that turns the live session into a
 * structured document another window can continue from.
 *
 * omp's handoff writes a compaction entry: it replaces history and keeps the
 * document. dsh's compaction is not open to a tree-external plugin, so this
 * package keeps the part that still works — the document — and lands it in a
 * host-only `handoff` projection. The durable channel an out-of-tree plugin
 * owns is the invocation's own text, so the document is returned as the
 * `command/done` text and the projection recognizes it by its four headings.
 *
 * Model route: `ctx.llm` has no default of its own — `prepareCall` demands an
 * explicit provider and model, and the only host-owned default is
 * `agentDefaultModel.currentSelection()`
 * (`packages/core/agent-default-model/src/index.ts:67`). The `omd-core` row
 * mounts this package bare, so that selection is the normal route; `Config`
 * `provider`/`model` exist to pin a cheaper auxiliary model instead. Both
 * empty with no host default is a clear per-invocation error, not a load
 * failure — a failed handoff must not take the session down.
 *
 * @module omd-handoff
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  createUserMessage,
  LlmError,
  type ContentBlock,
  type FinishReason,
  type Message,
} from '@deepseek-ai/dsh-llm'
// Type-only: resolves the `ctx.sessionProjections` declaration this file registers into.
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import {
  NOTHING_TO_HAND_OFF,
  WAIT_FOR_RESPONSE,
  handoffStateSchema,
  type GoalEntry,
  type HandoffState,
  type TodoEntry,
} from './types.ts'
import { buildHandoffPrompt, DEFAULT_TRANSCRIPT_BYTES, HANDOFF_SYSTEM, hasAllSections } from './prompt.ts'

// The `handoff` projection-key declaration lives in src/types.ts; this keeps the
// module edge in the emitted declarations so a consumer aggregate sees the merge.
export type * from './types.ts'

/** Plugin id the Loader entry carries. */
export const name = 'omd-handoff'

/** Services this plugin needs before its fiber activates. */
export const inject = ['commands', 'sessionProjections', 'llm']

/** The projection key this package owns. */
const KEY = 'handoff'

/** Default output cap for one document; a handoff is a page, not a chapter. */
const DEFAULT_MAX_TOKENS = 4096

/** Default end-to-end deadline for one document call. */
const DEFAULT_TIMEOUT_MS = 120_000

/** `omd-handoff` deployment settings. */
export interface Config {
  /** Provider route for the handoff call; empty defers to `agentDefaultModel`. */
  provider: string
  /** Model id for the handoff call; empty defers to `agentDefaultModel`. */
  model: string
  /** Output-token cap for one document. */
  maxTokens: number
  /** End-to-end deadline in milliseconds. */
  timeoutMs: number
  /** Conversation bytes sent to the model; older bytes are cut first. */
  maxTranscriptBytes: number
}

/** Schemastery configuration for the handoff command. */
export const Config: z<Config> = z.object({
  provider: z.string().default('').description('Provider route for the handoff call; empty defers to agentDefaultModel.'),
  model: z.string().default('').description('Model id for the handoff call; empty defers to agentDefaultModel.'),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS).description('Output-token cap for one document.'),
  timeoutMs: z.number().step(1).min(1).default(DEFAULT_TIMEOUT_MS).description('End-to-end deadline for one document.'),
  maxTranscriptBytes: z.number().step(1).min(1).default(DEFAULT_TRANSCRIPT_BYTES)
    .description('Conversation bytes sent to the model; older bytes are cut first.'),
})

/** A resolved route, or the reason none could be resolved. */
type RouteResolution =
  | { readonly ok: true; readonly provider: string; readonly model: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Resolve the call route without guessing: this package's `Config` wins whole,
 * then the host's default selection, then nothing.
 * @param ctx - context that may carry `agentDefaultModel`.
 * @param config - this package's deployment settings.
 * @returns the route, or a one-line reason it is unavailable.
 */
function resolveRoute(ctx: Context, config: Config): RouteResolution {
  if (config.provider.length > 0 && config.model.length > 0) {
    return { ok: true, provider: config.provider, model: config.model }
  }
  const defaults = ctx.get('agentDefaultModel')
  if (defaults === undefined) {
    return {
      ok: false,
      reason: 'omd-handoff: no model route; set both `provider` and `model` on this plugin\'s row, or compose @deepseek-ai/dsh-agent-default-model',
    }
  }
  const selection = defaults.currentSelection()
  if (selection.provider.length === 0 || selection.model.length === 0) {
    return {
      ok: false,
      reason: 'omd-handoff: agentDefaultModel reports an empty provider/model; set both `provider` and `model` on this plugin\'s row',
    }
  }
  return { ok: true, provider: selection.provider, model: selection.model }
}

/**
 * Flatten content blocks to their text, one line per block.
 *
 * A handoff prompt needs the work, not the protocol: tool calls become their
 * name and arguments, and image/file blocks become a marker, so a transcript
 * with attachments still reads as a transcript. Reasoning blocks are dropped:
 * they are the model's private working, they cost the whole transcript budget,
 * and the visible decisions they led to are in the messages around them.
 * @param blocks - the message's content blocks.
 * @returns the joined text, trimmed.
 */
function blocksText(blocks: readonly ContentBlock[]): string {
  const lines: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        lines.push(block.text)
        break
      case 'tool-call':
        lines.push(`[tool ${block.name} ${block.arguments}]`)
        break
      case 'image':
        lines.push('[image]')
        break
      case 'file':
        lines.push('[file]')
        break
      default:
        break
    }
  }
  return lines.join('\n').trim()
}

/** Render one message as a `role: text` line, or `''` when it carries nothing. */
function messageLine(message: Message): string {
  const text = blocksText(message.content)
  if (text.length === 0) return ''
  if (message.role === 'tool') return `tool result${message.isError === true ? ' (error)' : ''}: ${text}`
  return `${message.role}: ${text}`
}

/**
 * Render the derived conversation as the transcript the model condenses.
 *
 * The count of user/assistant messages is also the emptiness gate: a system
 * prompt alone means the session has done nothing to hand off.
 * @param session - the session being handed off.
 * @returns the transcript text and the number of user/assistant messages in it.
 */
export function renderTranscript(session: Session): { readonly text: string; readonly turns: number } {
  const lines: string[] = []
  let turns = 0
  for (const message of session.deriveMessages()) {
    if (message.role === 'system') continue
    if (message.role === 'user' || message.role === 'assistant') turns += 1
    const line = messageLine(message)
    if (line.length > 0) lines.push(line)
  }
  return { text: lines.join('\n\n'), turns }
}

/** Map a terminal finish to the failure it represents, or `undefined` when it is usable. */
function finishFailure(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
    case 'tool-calls':
      return undefined
    case 'max-tokens':
      return new Error(
        'omd-handoff: the document hit the output token cap; raise `maxTokens` on this plugin\'s row and retry',
      )
    case 'error':
    case 'aborted':
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    default:
      return new Error('omd-handoff: the request finished with an unknown reason')
  }
}

/**
 * Read one `command/done` payload structurally.
 *
 * `@deepseek-ai/dsh-commands` declares this event, but the package is not on
 * this package's runtime link path, so the type is not a member of this
 * program's `SessionEventMap`. The guard checks exactly the fields the fold
 * reads — the same two the harness writes at
 * `packages/interaction/commands/src/index.ts:379-388`.
 * @param event - one committed session event.
 * @returns the document text and its commit time, or `undefined` for any other event.
 */
function commandDone(event: SessionEvent): { readonly text: string; readonly at: number } | undefined {
  if ((event.type as string) !== 'command/done') return undefined
  const data: unknown = event.data
  if (typeof data !== 'object' || data === null) return undefined
  const kind = 'kind' in data ? data.kind : undefined
  const text = 'text' in data ? data.text : undefined
  if (kind !== 'success' || typeof text !== 'string') return undefined
  return { text, at: event.time }
}

/**
 * Register the `handoff` projection and the `/handoff` command.
 * @param ctx - the entry fiber's context, carrying commands, projections, and LLM.
 * @param config - deployment settings for this profile.
 */
export function apply(ctx: Context, config: Config): void {
  // The document lives in the invocation's own `command/done` text: this fold
  // adopts any successful command text carrying all four headings, so a resumed
  // session recovers the last handoff without a plugin-owned session event —
  // `command/done` records neither the command name nor `args`. Every other
  // event returns the same state reference.
  ctx.sessionProjections.register({
    key: KEY,
    stateVersion: 1,
    stateSchema: handoffStateSchema,
    init: (): HandoffState => null,
    apply: (state, event) => {
      const done = commandDone(event)
      if (done === undefined || !hasAllSections(done.text)) return state
      return { body: done.text, at: done.at }
    },
  })

  ctx.commands.register({
    name: 'handoff',
    description: 'Write a structured handoff document that another window can continue from',
    input: { hint: '[focus]' },
    handler: async (invocation) => {
      const { agent, signal } = invocation
      const session = agent.session
      const transcript = renderTranscript(session)
      // A session whose only messages carry no text (an empty prompt, an image
      // alone) has nothing a successor could read, so it counts as empty too.
      if (transcript.turns === 0 || transcript.text.trim().length === 0) {
        return { kind: 'error', text: NOTHING_TO_HAND_OFF }
      }
      if (signal.aborted) return { kind: 'error', text: 'Handoff cancelled.' }

      // `turnBoundary` is registered by `dsh-agent-loop` only; an open turn means
      // a response is running, and a non-idle agent may still be settling one.
      const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
      if (agent.status === 'running' || (boundary !== undefined && boundary.openTurnStartSeq !== null)) {
        return { kind: 'error', text: WAIT_FOR_RESPONSE }
      }

      const route = resolveRoute(ctx, config)
      if (!route.ok) return { kind: 'error', text: route.reason }

      // Both projections are optional by composition: an absent key reads as
      // "nothing recorded", which the prompt renders as "(none)".
      const todos = ctx.sessionProjections.stateOf(session, 'todos')
      const goal = ctx.sessionProjections.stateOf(session, 'goal')
      const goalEntry: GoalEntry | null = goal === undefined || goal.current === null
        ? null
        : { objective: goal.current.goal.objective, phase: goal.current.goal.phase }
      const todoEntries: readonly TodoEntry[] | null = todos === undefined || todos === null
        ? null
        : todos.map(todo => ({ content: todo.content, status: todo.status }))

      const deadline = AbortSignal.timeout(config.timeoutMs)
      const composed = AbortSignal.any([signal, deadline])
      const messages: Message[] = [createUserMessage({
        content: [{
          type: 'text',
          text: buildHandoffPrompt({
            focus: invocation.rawInput.trim(),
            goal: goalEntry,
            todos: todoEntries,
            transcript: transcript.text,
          }, config.maxTranscriptBytes),
        }],
        // A one-shot auxiliary message: it is sent, never appended to the log.
        source: { kind: 'user' },
      })]
      try {
        const prepared = await ctx.llm.prepareCall({
          provider: route.provider,
          model: route.model,
          maxTokens: config.maxTokens,
        }, composed)
        const assembler = new BlockAssembler()
        for await (const chunk of prepared.stream({
          ...prepared.config,
          messages,
          system: HANDOFF_SYSTEM,
          sessionId: session.id,
          signal: composed,
        })) assembler.push(chunk)
        const failure = finishFailure(assembler.finish)
        if (failure !== undefined) return { kind: 'error', text: failure.message }
        const body = blocksText(assembler.blocks())
          .replace(/^```(?:markdown)?\n([\s\S]*)\n```$/u, '$1')
          .trim()
        if (body.length === 0) {
          return { kind: 'error', text: 'omd-handoff: the model returned an empty document; nothing was recorded' }
        }
        if (!hasAllSections(body)) {
          return {
            kind: 'error',
            text: 'omd-handoff: the document is missing one of the four required sections (## Objective, ## Progress, ## Decisions, ## Next steps); nothing was recorded',
          }
        }
        return { kind: 'success', text: body }
      } catch (error: unknown) {
        if (signal.aborted) return { kind: 'error', text: 'Handoff cancelled.' }
        if (deadline.aborted) {
          return {
            kind: 'error',
            text: `omd-handoff: the model did not answer within ${config.timeoutMs} ms; nothing was recorded`,
          }
        }
        return { kind: 'error', text: `omd-handoff: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })
}
