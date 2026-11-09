/**
 * omd-unexpected-stop — pushes the model back to work when it announces a next
 * step and then ends the turn without taking it.
 *
 * The gate runs at the natural stop boundary (`agent/turn-stopping`): the newest
 * assistant message must end on an unfulfilled promise and the newest tool
 * result must be missing or empty. A hit is answered with one injected user
 * message, which the loop claims as the next step of the same turn. At most one
 * nudge is injected per turn, so a model that keeps narrating cannot be looped.
 *
 * `mechanical` decides from the text alone; `smart` asks the judge service
 * whether the message really describes an unperformed step and stays mechanical
 * when no judge can answer; `none` registers nothing.
 *
 * @module omd-unexpected-stop
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageId } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { assistantText, endsWithUnfulfilledStep, lastAssistant, lastToolResultIsEmpty } from './detect.ts'
import type { JudgmentService, NoulQuestion } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Context the unexpected-stop gate injected to resume an announced step. */
    'omd-unexpected-stop': { kind: 'omd-unexpected-stop' } & ContextFormed
  }
}

/** Stable Loader identity. */
export const name = 'omd-unexpected-stop'

/** The optional judge service; the plugin waits for it like any other consumer. */
export const inject = ['judgment']

/** How the gate decides that a stop was unexpected. */
export type UnexpectedStopMode = 'mechanical' | 'smart' | 'none'

/** Detection strength; `none` registers no listener at all. */
export interface Config {
  /** `mechanical` reads the closing sentence, `smart` also asks the judge, `none` disables the gate. */
  mode: UnexpectedStopMode
  /** Yes-probability above which `smart` mode calls the stop unexpected. */
  judgeThreshold: Volatile<number>
}

/** Detection strength, defaulting to the mechanical gate alone. */
export const Config: z<Config> = z.object({
  mode: z
    .union(['mechanical', 'smart', 'none'])
    .default('mechanical')
    .description(
      'Unexpected-stop detection: mechanical matches the closing sentence, smart also asks the judge, none disables it.',
    ),
  judgeThreshold: z.number().min(0).max(1).default(0.5)
    .volatile()
    .description('Yes-probability above which smart mode calls the stop unexpected.'),
})

/** Injected once per turn when the model announced a step it never took. */
const CONTINUE_PROMPT = 'You described a next step but did not take it. Continue, or say why you stopped.'

/** The one question `smart` mode asks; wording kept short for small judges. */
const STOPPED_QUESTION: NoulQuestion = {
  type: 'noul',
  instructions: '分类这条助手消息是否是意外停止：描述了下一步却没有执行。',
  criteria: {
    true: '描述了下一步但没有执行',
    false: '任务已完成或在等你决定',
  },
}

/** Per-agent bookkeeping; the WeakMap key makes disposal clean up for free. */
interface AgentState {
  /** Identity of the newest assistant message already judged. */
  judgedMessageId: MessageId | undefined
  /** Turn that already received its one nudge. */
  injectedTurn: number | undefined
}

/**
 * Read one agent's bookkeeping, creating it on first use.
 * @param states - per-agent state held by the plugin instance.
 * @param agent - the agent whose turn is stopping.
 * @returns the mutable state for that agent.
 */
function stateOf(states: WeakMap<Agent, AgentState>, agent: Agent): AgentState {
  const existing = states.get(agent)
  if (existing !== undefined) return existing
  const created: AgentState = { judgedMessageId: undefined, injectedTurn: undefined }
  states.set(agent, created)
  return created
}

/**
 * Ask the judge service whether the message is an unexpected stop.
 *
 * Every failure path returns `undefined` so the caller keeps the mechanical
 * verdict: an unreachable, uncredentialed, or misbehaving judge must never
 * change what the plugin would do on its own.
 * @param ctx - plugin context whose `judgment` service may be mounted.
 * @param text - the assistant message's visible text.
 * @param signal - the turn's abort signal, forwarded to the judge call.
 * @param threshold - yes-probability above which the stop is unexpected.
 * @returns the verdict, or `undefined` when no judge could answer.
 */
async function stopsUnexpectedly(
  ctx: Context,
  text: string,
  signal: AbortSignal,
  threshold: number,
): Promise<boolean | undefined> {
  // Read through `ctx.get` rather than declaring `Context.judgment` here: the
  // owning package declares that property, and a second declaration would
  // conflict wherever both packages are type-checked in one program.
  const judge = ctx.get('judgment') as JudgmentService | undefined
  if (judge === undefined || !judge.available()) return undefined
  try {
    const result = await judge.judge({ state: text, questions: { stopped: STOPPED_QUESTION } }, { signal })
    return result.answers.stopped.noul > threshold
  } catch {
    return undefined
  }
}

/**
 * Install the unexpected-stop gate.
 * @param ctx - plugin context.
 * @param config - detection strength; validated, then fixed for this load.
 */
export function apply(ctx: Context, config: Config): void {
  const mode = config.mode
  if (mode !== 'mechanical' && mode !== 'smart' && mode !== 'none') {
    throw new Error(`omd-unexpected-stop: unknown detection mode ${JSON.stringify(mode)}`)
  }
  if (mode === 'none') return

  const states = new WeakMap<Agent, AgentState>()

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const state = stateOf(states, agent)
    if (state.injectedTurn === turn) return

    const messages = agent.session.deriveMessages()
    const assistant = lastAssistant(messages)
    if (assistant === undefined || state.judgedMessageId === assistant.id) return
    state.judgedMessageId = assistant.id

    const text = assistantText(assistant)
    if (!endsWithUnfulfilledStep(text)) return
    if (!lastToolResultIsEmpty(messages)) return
    if (mode === 'smart' && (await stopsUnexpectedly(ctx, text, signal, config.judgeThreshold.get())) === false) return

    state.injectedTurn = turn
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: CONTINUE_PROMPT }],
      source: { kind: 'omd-unexpected-stop' },
    }))
  })
}
