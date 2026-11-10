/**
 * omd-todo-driver — nudges the model back to its active todo when a turn stops
 * with work still runnable, after the judge says the stop is not a wait.
 *
 * One trigger: `agent/turn-stopping`, the boundary the loop dispatches after a
 * step ends and before `turn/end`, when the model was already going to stop.
 * Structural gates (any active item, no manual-stop latch, consecutive cap,
 * cooldown, an empty inbox, not a subagent session) run first; the judge is
 * the only semantic gate, and an unavailable judge means "do not nudge".
 *
 * The nudge is `steer` — a user message with `source.kind: 'omd-todo-nudge'` —
 * so the same turn takes one more step. The cap notice is injected instead,
 * because it asks the model to stop, not to work.
 *
 * @module omd-todo-driver
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import z from '@deepseek-ai/schemastery'
import { mergeTodoTree } from 'omd-todo'
import type { TodoItem } from 'omd-todo'
import { buildJudgeContext } from 'omd-judge-context'
import type { JudgeContext, JudgeFacts, JudgeTodoNode } from 'omd-judge-context'
import { foldEvent, stateOf } from './fold.ts'
import type { FoldState } from './fold.ts'
import type {
  JudgmentService,
  TodoOrderService,
  Verdict,
  VerdictAnswer,
  VerdictQuestion,
} from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A todo nudge or its cap notice, steered by `omd-todo-driver`. */
    'omd-todo-nudge': { kind: 'omd-todo-nudge' } & ContextFormed
  }
}

/** Stable Loader identity. */
export const name = 'omd-todo-driver'

/** No hard dependency: the judge is read through `ctx.get` and its absence means no nudge. */
export const inject: string[] = []

/** How one stop is handled once the structural gates pass. */
export interface Config {
  /** Master switch; off registers no listener work and sends nothing. */
  enabled: Volatile<boolean>
  /** Nudges allowed after one `todo/write` before the cap notice is written. */
  maxConsecutive: Volatile<number>
  /** Minimum gap between two nudges, in milliseconds. */
  cooldownMs: Volatile<number>
  /** Opt in to waking an idle agent when an external writer changed its todo list. */
  wakeOnExternalTodoChange: boolean
  /** Continue confidence at or above which the verdict is a nudge. */
  minConfidence: Volatile<number>
  /** Token budget of the assembled judge state. */
  judgeBudgetTokens: Volatile<number>
}

/** Configuration schema; the numbers are volatile so the UI can retune them live. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true)
    .volatile()
    .description('Master switch for todo-continuation nudges.'),
  maxConsecutive: z.natural().min(1).default(3)
    .volatile()
    .description('Nudges allowed after one todo write before the cap notice stops the loop.'),
  cooldownMs: z.natural().default(5000)
    .volatile()
    .description('Minimum milliseconds between two nudges.'),
  wakeOnExternalTodoChange: z.boolean().default(false)
    .description(
      'Wake an idle agent when an external writer changes its todo list. Off by default: '
      + 'starting a turn without a human word is a different kind of authority.',
    ),
  minConfidence: z.number().min(0).max(1).default(0.45)
    .volatile()
    .description(
      'Continue confidence at or above which the nudge is sent. The verdict is one of three '
      + 'choices, so a flat distribution puts every label at 0.333; 0.45 asks for a leading '
      + '"continue", not near-certainty.',
    ),
  judgeBudgetTokens: z.natural().min(100).default(4000)
    .volatile()
    .description('Token budget of the assembled judge state (todo, messages, tool history).'),
})

/** Delay that lets one batch of external file/issue writes settle before waking. */
const EXTERNAL_WAKE_DEBOUNCE_MS = 250

/** What the judge decides and what each label admits. */
const VERDICT_CRITERIA: Record<Verdict, string> = {
  continue: '还有 active 待办可以推进，且最近的输出没有在等任何会自己回来的事件',
  wait: '在等后台作业、运行中的子代理、未回答的用户提问或审批、定时或外部事件',
  done: '没有 active 待办，或者下一步必须由用户先决定',
}

/**
 * The one "is there work to push" predicate.
 * @param item - one todo entry.
 * @returns true only for the active tri-state.
 */
function isActive(item: TodoItem): boolean {
  return item.state === 'active'
}

/** One active entry plus its 1-based path in the full tree. */
interface ActiveTarget {
  item: TodoItem
  path: string
}

/**
 * Find the first active entry in preorder, with the path a `todo` read accepts.
 * @param items - todo tree.
 * @param prefix - parent indices.
 * @returns the first active entry, or undefined when none exists.
 */
function firstActive(items: readonly TodoItem[], prefix: readonly number[] = []): ActiveTarget | undefined {
  for (const [index, item] of items.entries()) {
    const path = [...prefix, index + 1]
    if (isActive(item)) return { item, path: path.join('.') }
    if (item.children === undefined) continue
    const found = firstActive(item.children, path)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Count active entries across the whole tree.
 * @param items - todo tree.
 * @returns the number of active entries.
 */
function countActive(items: readonly TodoItem[]): number {
  let total = 0
  for (const item of items) {
    if (isActive(item)) total += 1
    if (item.children !== undefined) total += countActive(item.children)
  }
  return total
}

/**
 * Project the active branches into the judge's todo shape, keeping hierarchy.
 *
 * An inactive ancestor stays only as the path to an active descendant; the
 * judge needs to know that the child is parked under it, and no status is
 * inferred from position.
 * @param items - todo tree.
 * @param prefix - parent indices.
 * @returns active nodes plus their needed ancestors.
 */
function judgeTodos(items: readonly TodoItem[], prefix: readonly number[] = []): JudgeTodoNode[] {
  const out: JudgeTodoNode[] = []
  for (const [index, item] of items.entries()) {
    const path = [...prefix, index + 1]
    const children = item.children === undefined ? [] : judgeTodos(item.children, path)
    if (!isActive(item) && children.length === 0) continue
    const node: JudgeTodoNode = {
      path: path.join('.'),
      content: item.content,
      state: item.state,
    }
    if (item.goal !== undefined && item.goal !== '') node.goal = item.goal
    if (item.explanation !== undefined && item.explanation !== '') node.explanation = item.explanation
    if (children.length > 0) node.children = children
    out.push(node)
  }
  return out
}

/**
 * The three states of waiting that can return on their own, as the judge sees them.
 * @param ctx - plugin context; each service is optional.
 * @param agent - the agent whose turn is stopping.
 * @returns the waiting facts, empty arrays when the services are absent or idle.
 */
function collectWaiting(ctx: Context, agent: Agent): NonNullable<JudgeFacts['waiting']> {
  const jobs = ctx.get('jobs') as JobRegistry | undefined
  const running = (jobs?.list(agent.session.id) ?? [])
    .filter(job => job.owner === agent.session.id && (job.status === 'running' || job.status === 'stopping'))
    .map(job => ({
      kind: job.kind,
      label: job.label,
      status: job.status,
      ...(job.progress === undefined ? {} : { progress: job.progress }),
    }))
  const registry = ctx.get('agents')
  const children = (registry?.list() ?? [])
    .filter(child => child.id !== agent.id
      && child.session.header.parentSession === agent.session.id
      && child.status === 'running')
    .map(child => ({ session: String(child.id), status: child.status }))
  const projections = ctx.get('sessionProjections')
  const questions = (projections?.stateOf(agent.session, 'userQuestions')?.questions.active ?? [])
    .map(call => ({ state: call.state, questions: call.questions.map(item => item.question) }))
  return { jobs: running, children, user_questions: questions }
}

/**
 * Build the one question the driver asks.
 * @param task - constant task text from the shared assembler.
 * @returns the choice question.
 */
function verdictQuestion(task: string): VerdictQuestion {
  return { type: 'choice', instructions: task, criteria: VERDICT_CRITERIA }
}

/**
 * The nudge text: the current active entry and its goal, an address for the
 * full context, and the exit for a genuine wait. It never invents the next step.
 * @param target - first active entry and its tree path.
 * @param activeCount - how many active entries remain.
 * @returns the message body.
 */
function nudgeText(target: ActiveTarget, activeCount: number): string {
  const goal = target.item.goal?.trim() ?? ''
  const lines = [
    `[待办续跑] 第 ${target.path} 项（${target.item.state}）没做完：${target.item.content}`,
    `目标：${goal === '' ? '（未写）' : goal}`,
    `上下文：read dsh-resource://todo/current/${target.path}`,
  ]
  if (activeCount > 1) lines.push(`另有 ${activeCount - 1} 条 active 待办。`)
  lines.push(
    '继续做它。若在等外部事件（后台作业、子代理、用户答复），在回复里说明等的是什么；'
    + '如果确实卡住了，说清卡在哪一步、哪条报错。',
  )
  return lines.join('\n')
}

/**
 * One steer message that asks for the same turn to take another step.
 * @param text - nudge body.
 * @returns the identified user message.
 */
function nudgeMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'omd-todo-nudge' },
  })
}

/**
 * One notice the model sees on its next turn, after the cap stopped the loop.
 * @param max - the configured consecutive limit.
 * @returns the identified notice message.
 */
function noticeMessage(max: number): UserMessage {
  const text = `[待办续跑] 已连续催 ${max} 次待办没动，先停手。说句话或改一下待办再开。`
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'omd-todo-nudge', form: 'notice', summary: boundContextSummary(text) },
  })
}

/**
 * Warn once per session; repeated judge failures must not flood the log.
 * @param ctx - plugin context.
 * @param session - session the warning is about.
 * @param warned - sessions already warned.
 * @param message - warning body.
 */
function warnOnce(ctx: Context, session: Session, warned: WeakSet<Session>, message: string): void {
  if (warned.has(session)) return
  warned.add(session)
  ctx.logger.warn(`omd-todo-driver: ${message}`)
}

/** Where one nudge would land. */
type NudgeEntry = 'turn' | 'external'

/**
 * Run every gate once and nudge when the judge says continue.
 *
 * Structural checks come first and never call the judge; the judge is called
 * only for a stop with active work, no latch, no cap, no cooldown, and an empty
 * inbox. Every failure below the structural gates resolves to "do not nudge".
 * @param ctx - plugin context.
 * @param agent - the agent at the stop boundary, or the idle target of an external wake.
 * @param entry - turn steering or the external follow-up.
 * @param signal - the stopping turn's abort signal, absent for an external wake.
 * @param config - plugin configuration.
 * @param states - per-session gate folds.
 * @param warned - sessions already warned about an unavailable judge.
 */
async function consider(
  ctx: Context,
  agent: Agent,
  entry: NudgeEntry,
  signal: AbortSignal | undefined,
  config: Config,
  states: WeakMap<Session, FoldState>,
  warned: WeakSet<Session>,
): Promise<void> {
  if (!config.enabled.get()) return
  if (agent.session.header.origin === 'subagent') return
  if (entry === 'external' && agent.status !== 'idle') return

  const todo = ctx.get('todoList')
  if (todo === undefined) return
  const order = ctx.get('todoOrder') as TodoOrderService | undefined
  if (order !== undefined) {
    try {
      await order.ensureFresh(agent.session, signal)
    } catch (error: unknown) {
      if (signal?.aborted !== true) {
        ctx.logger.warn('omd-todo-driver: todo order refresh failed; reading the current tree: %o', error)
      }
    }
  }
  const snapshot = todo.read(agent.session)
  if (snapshot === null) return
  const merged = mergeTodoTree(snapshot.items, snapshot.details)
  if (countActive(merged) === 0) return

  const fold = stateOf(states, agent.session)
  if (fold.latched) return
  if (agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0) return

  const max = config.maxConsecutive.get()
  if (fold.nudges >= max) {
    if (fold.noticeWritten) return
    fold.noticeWritten = true
    agent.inject(noticeMessage(max))
    return
  }

  if (fold.lastNudgeAt !== undefined && Date.now() - fold.lastNudgeAt < config.cooldownMs.get()) return

  const judge = ctx.get('judgment') as JudgmentService | undefined
  if (judge === undefined || !judge.available()) {
    warnOnce(ctx, agent.session, warned, 'judge unavailable; no nudge')
    return
  }

  let context: JudgeContext
  try {
    context = await buildJudgeContext(ctx, {
      session: agent.session,
      budget: config.judgeBudgetTokens.get(),
      purpose: 'todo-continuation',
      facts: { todos: judgeTodos(merged), waiting: collectWaiting(ctx, agent) },
    })
  } catch (error: unknown) {
    warnOnce(ctx, agent.session, warned, `judge context failed: ${String(error)}`)
    return
  }

  let verdict: VerdictAnswer
  try {
    const result = await judge.judge(
      { state: context.state, questions: { verdict: verdictQuestion(context.task) } },
      signal === undefined ? {} : { signal },
    )
    verdict = result.answers.verdict
  } catch (error: unknown) {
    if (signal?.aborted !== true) {
      warnOnce(ctx, agent.session, warned, `judge call failed: ${String(error)}`)
    }
    return
  }
  ctx.logger.info(
    'omd-todo-driver: verdict %s confidence=%s distribution=%s',
    verdict.choice,
    verdict.confidence.toFixed(2),
    JSON.stringify(verdict.probabilities),
  )
  if (signal?.aborted === true) return
  if (verdict.choice !== 'continue' || verdict.confidence < config.minConfidence.get()) return
  if (agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0) return

  const fresh = todo.read(agent.session)
  if (fresh === null) return
  const freshTree = mergeTodoTree(fresh.items, fresh.details)
  const target = firstActive(freshTree)
  if (target === undefined) return
  const message = nudgeMessage(nudgeText(target, countActive(freshTree)))
  if (entry === 'turn') agent.steer(message)
  else agent.followup(message)
}

/**
 * Install the gate and its one trigger.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const states = new WeakMap<Session, FoldState>()
  const warned = new WeakSet<Session>()

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    const state = states.get(session)
    if (state !== undefined) foldEvent(state, event)
  })

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    try {
      await consider(ctx, agent, 'turn', signal, config, states, warned)
    } catch (error: unknown) {
      ctx.logger.warn('omd-todo-driver: turn-stopping gate failed: %o', error)
    }
  })

  if (!config.wakeOnExternalTodoChange) return
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin === 'subagent') return
    const todo = ctx.get('todoList')
    if (todo === undefined) return
    agent.ctx.effect(() => {
      let timer: NodeJS.Timeout | undefined
      const unsubscribe = todo.subscribe(agent.session, () => {
        if (agent.status !== 'idle') return
        clearTimeout(timer)
        timer = setTimeout(() => {
          timer = undefined
          void consider(ctx, agent, 'external', undefined, config, states, warned)
            .catch((error: unknown) => {
              ctx.logger.warn('omd-todo-driver: external wake failed: %o', error)
            })
        }, EXTERNAL_WAKE_DEBOUNCE_MS)
        timer.unref()
      })
      return () => {
        unsubscribe()
        clearTimeout(timer)
      }
    }, 'omd-todo-driver: external todo wake')
  })
}
