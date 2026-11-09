/**
 * `omd-loop` — repeat one prompt until an iteration or time limit runs out.
 *
 * This is the host-side half of omp's `/loop` mode: state lives in the
 * host-only `loop` session projection and is derived purely from the log (see
 * `./projection.ts`), so a resumed or forked session remembers its budget.
 *
 * Three harness boundaries carry one iteration each:
 *
 * - `agent/pre-step`, on a turn's first proposed step that admits no message.
 *   Such a turn would otherwise close without a model call; appending the loop
 *   body is what lets it produce its first output.
 * - `agent/turn-stopping`, where the loop steers the body again so the turn
 *   keeps going instead of closing. This is the documented way for a listener
 *   to object to a turn end: the machine re-reads its inbox and runs another
 *   step.
 * - the same `agent/turn-stopping` boundary, once the budget is spent, where
 *   the closing notice is logged directly. It is a surface message with a
 *   notice source, not a queued prompt, so the stop costs no extra model call;
 *   omp reports its stop the same way, by disabling loop mode without submitting
 *   another turn.
 *
 * A cancelled turn suspends the loop rather than killing it — Esc pauses, the
 * next human prompt resumes — matching omp's `/loop` interruption semantics.
 *
 * @module omd-loop
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import z from '@deepseek-ai/schemastery'
import { LOOP_COMMAND, describeSpan, parseLoopArgs } from './args.ts'
import { deliveringNow, loopProjectionDefinition, stopsAtThisTurnEnd } from './projection.ts'
import type { LoopState } from './projection.ts'

export const name = 'omd-loop'

/** Services this plugin needs before its fiber activates. */
export const inject = ['commands', 'sessionProjections']

/** Deployment settings for `/loop`. */
export interface Config {
  /** Longest prompt echo `/loop` repeats in its status line before eliding. */
  promptExcerptChars: Volatile<number>
}

export const Config: z<Config> = z.object({
  promptExcerptChars: z.number().step(1).min(1).default(48)
    .volatile()
    .description('Longest prompt echo the /loop status line repeats before eliding.'),
})

/**
 * Render a prompt as one short line for status output.
 * @param prompt - the loop body.
 * @param limit - longest echo before eliding.
 * @returns the body with newlines collapsed, truncated when long.
 */
function excerpt(prompt: string, limit: number): string {
  const oneLine = prompt.replace(/\s+/gu, ' ').trim()
  return oneLine.length <= limit
    ? oneLine
    : `${oneLine.slice(0, limit - 1)}…`
}

/**
 * Name the limit that closed the loop, for status and notice text.
 * @param state - a state whose `active` flag is already false.
 * @param now - current epoch milliseconds.
 * @returns which budget ran out.
 */
function limitName(state: LoopState, now: number): string {
  if (state.remaining === 0) return 'iteration limit'
  if (state.until !== null && now >= state.until) return 'time limit'
  return 'loop limit'
}

/**
 * Render the budget half of a status line.
 * @param state - current loop state.
 * @param now - current epoch milliseconds.
 * @returns the budget description, or `undefined` for an unbounded loop.
 */
function budgetText(state: LoopState, now: number): string | undefined {
  const parts: string[] = []
  if (state.remaining !== null) {
    parts.push(`${state.remaining} ${state.remaining === 1 ? 'iteration' : 'iterations'} left`)
  }
  if (state.until !== null) {
    parts.push(now < state.until ? `${describeSpan(state.until - now)} left` : 'time limit reached')
  }
  return parts.length === 0 ? undefined : parts.join(', ')
}

/**
 * Describe the current loop in one line.
 * @param state - current loop state, or `undefined` before the unit is registered.
 * @param now - current epoch milliseconds.
 * @param excerptChars - longest prompt echo before eliding.
 * @returns status copy: `Loop waiting`, `Loop running`, `Loop paused`, `Loop finished`, or `Loop: off`.
 */
function describeLoop(state: LoopState | undefined, now: number, excerptChars: number): string {
  if (state === undefined || (!state.active && !state.finished)) return 'Loop: off'
  if (state.finished) return `Loop finished · ${limitName(state, now)} reached`
  const label = state.prompt === null ? 'Loop waiting' : state.paused ? 'Loop paused' : 'Loop running'
  const details: string[] = []
  const budget = budgetText(state, now)
  if (budget !== undefined) details.push(budget)
  if (state.paused) details.push('send any message to resume, /loop off to stop')
  else if (state.prompt === null) details.push('the next prompt repeats after every turn, /loop off to stop')
  else details.push(`repeating "${excerpt(state.prompt, excerptChars)}", /loop off to stop`)
  return `${label} · ${details.join(' · ')}`
}

/**
 * Build the message that carries one loop iteration.
 * @param text - the loop body.
 * @returns an identified user message sourced to this plugin.
 */
function loopPromptMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'omd-loop' },
  })
}

/**
 * Build the logged closing notice.
 * @param state - the loop state that just stopped.
 * @param now - current epoch milliseconds.
 * @returns a notice-form user message, so carriers render one collapsed row.
 */
function finishNotice(state: LoopState, now: number): UserMessage {
  const text = `Loop finished · ${limitName(state, now)} reached`
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'omd-loop', form: 'notice', summary: boundContextSummary(text) },
  })
}

/**
 * Register `/loop`, the `loop` projection, and the two step boundaries that
 * drive one iteration each.
 * @param ctx - the entry fiber's context, carrying the command and projection registries.
 * @param config - deployment settings for this profile.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.sessionProjections.register(loopProjectionDefinition)

  ctx.commands.register({
    name: LOOP_COMMAND,
    description: 'Repeat one prompt until an iteration or time limit runs out',
    input: { hint: '[count|duration|off] [prompt]' },
    // The handler only narrates: `command/run` is already logged, and the fold
    // above has applied it, so the reply reads the same durable state a resume
    // would.
    handler: ({ agent, rawInput }) => {
      const spec = parseLoopArgs(rawInput)
      if (typeof spec === 'string') return { kind: 'error', text: spec }
      return {
        kind: 'success',
        text: describeLoop(
          ctx.sessionProjections.stateOf(agent.session, 'loop'),
          Date.now(),
          config.promptExcerptChars.get(),
        ),
      }
    },
  })

  ctx.on('agent/pre-step', async ({ agent, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    // A turn's first proposed step is the only one the harness abandons when it
    // admits no message, so it is the one place a loop body can start a turn.
    if (step !== 1 || decision.messages.length > 0) return decision
    const state = ctx.sessionProjections.stateOf(agent.session, 'loop')
    if (!deliveringNow(state, Date.now())) return decision
    return { ...decision, messages: [...decision.messages, loopPromptMessage(state.prompt)] }
  })

  ctx.on('agent/turn-stopping', ({ agent }) => {
    const state = ctx.sessionProjections.stateOf(agent.session, 'loop')
    const now = Date.now()
    if (deliveringNow(state, now)) {
      try {
        agent.steer(loopPromptMessage(state.prompt))
      } catch (error: unknown) {
        ctx.logger.warn('omd-loop: could not queue the next iteration: %o', error)
      }
      return
    }
    if (state === undefined || !stopsAtThisTurnEnd(state, now)) return
    try {
      agent.session.append('user/message', finishNotice(state, now), { surfaceOp: 'append' })
    } catch (error: unknown) {
      ctx.logger.warn('omd-loop: could not log the closing notice: %o', error)
    }
  })
}
