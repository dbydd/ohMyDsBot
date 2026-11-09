/**
 * Lifecycle assembly: per-session runtime, automatic adaptive recall through the
 * `agent/pre-step` waterfall, compaction reset and offline queue replay.
 *
 * Recall enters as a durable sourced user message replacing the step's message
 * batch. It never calls `followup`, `steer` or `inject`, so it cannot wake an
 * idle driver or open a turn of its own.
 *
 * Every automatic path obeys INV-7: a failure is one warn and "no injection
 * this turn", never an exception into the host.
 *
 * @module omd-hindsight/lifecycle
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig } from './config.ts'
import type { JudgePort } from './core/judge.ts'
import type { HindsightConfig } from './core/types.ts'
import {
  DebounceTracker,
  buildAdaptiveRecallQuery,
  performAdaptiveRecall,
  setRecallLogger,
  type LastTurn,
  type RecallDetails,
  type RecallInjection,
  type RecallTurnSample,
} from './recall.ts'
import {
  HindsightRuntime,
  bindRuntime,
  disposeRuntime,
  getRuntime,
  registerRuntime,
} from './runtime.ts'
import { isSubagentCaller } from './tool.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    hindsight: {
      readonly kind: 'hindsight'
      readonly form: 'recall'
      readonly details: RecallDetails
    }
  }
}

/** Source kind of every recall message this plugin appends. */
const SOURCE_KIND = 'hindsight'
const SOURCE_FORM = 'recall'

/** Cache lifetime for one rendered recall, matching the reference turn cache. */
const RECALL_CACHE_TTL_MS = 60000

type Logger = { warn(message: string, context?: Record<string, unknown>): void }

let lifecycleLogger: Logger | undefined

export interface RecallHost {
  /** The profile row's resolved config, used when a project has no overrides. */
  readonly base: ResolvedConfig
  /** Project-effective configuration for one agent's working directory. */
  resolve(agent: Agent): Promise<ResolvedConfig>
  /** Lazy judge access: the automatic path must not need the service to mount. */
  judgePort(): JudgePort | undefined
}

interface AgentRecallState {
  readonly debounce: DebounceTracker
  turns: number
  lastRecallAt: number
  injectedThisSession: number
  readonly injectedIds: Set<string>
  /** Trigger message ids already answered; this is what prevents a duplicate append. */
  readonly answeredTriggers: Set<string>
  cache?: { readonly key: string; readonly injection: RecallInjection; readonly at: number }
}

const states = new Map<string, AgentRecallState>()

function stateOf(agent: Agent, config: HindsightConfig): AgentRecallState {
  const existing = states.get(agent.id)
  if (existing !== undefined) return existing
  const created: AgentRecallState = {
    debounce: new DebounceTracker(config.recallDebounceTurns),
    turns: 0,
    lastRecallAt: 0,
    injectedThisSession: 0,
    injectedIds: new Set(),
    answeredTriggers: new Set(),
  }
  states.set(agent.id, created)
  return created
}

function resetRecallState(sessionId: string): void {
  const state = states.get(sessionId)
  if (state === undefined) return
  state.turns = 0
  state.lastRecallAt = 0
  state.injectedThisSession = 0
  state.injectedIds.clear()
  state.answeredTriggers.clear()
  // Only the fingerprint is cleared: the window size is configuration.
  state.debounce.reset()
  state.cache = undefined
}

/** Register the recall lifecycle on a plugin context. */
export function registerLifecycle(ctx: Context, host: RecallHost): void {
  setRecallLogger(ctx.logger)
  lifecycleLogger = ctx.logger

  ctx.on('agent/created', async ({ agent, source }) => {
    const subagent = isSubagentCaller(agent)
    if (subagent) {
      const parent = agent.session?.header?.parentSession
      if (parent !== undefined) bindRuntime(agent.id, parent)
    }
    // A resumed, cleared or compacted session starts with a fresh recall budget;
    // the states map is keyed by session id, so this is the same session's state.
    if (source !== 'startup') resetRecallState(agent.id)

    const effective = await host.resolve(agent)
    const cwd = agent.session?.header?.cwd
    if (!subagent && cwd !== undefined) {
      // One runtime per main session, even when this project has memory off: its
      // queue root and status stay addressable, only probing and recall stop.
      const runtime = getRuntime(agent.id) ?? new HindsightRuntime({ config: effective.core, cwd })
      registerRuntime(agent.id, runtime)
      runtime.configure({ config: effective.core, cwd })
      if (effective.enabled) void runtime.probe()
    } else {
      if (effective.enabled) void getRuntime(agent.id)?.probe()
    }

    // A compaction replaces the conversation the recall was computed from. The
    // write path stays closed for subagents (same posture as the tool guard).
    if (source === 'compact' && !subagent && effective.enabled) {
      try {
        await getRuntime(agent.id)?.replay(effective, false)
      } catch (error) {
        warn('hindsight.lifecycle.drain_failed', { error: describe(error) })
      }
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    disposeRuntime(agent.id)
    states.delete(agent.id)
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const { agent, signal } = payload
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    try {
      const trigger = triggerMessage(decision.messages)
      if (trigger === undefined) return decision
      const existing = states.get(agent.id)
      if (existing?.answeredTriggers.has(trigger.id) === true) return decision

      const effective = await host.resolve(agent)
      if (!effective.enabled || !triggerSwitch(effective.core)) return decision
      if (!recallAllowed(agent, effective.core)) return decision

      const runtime = getRuntime(agent.id)
      if (runtime === undefined) return decision
      runtime.configure({ config: effective.core, cwd: runtime.cwd })

      const lastUser = textOf(trigger)
      const state = existing ?? stateOf(agent, effective.core)
      if (lastUser === undefined || isTrivialPrompt(lastUser)) {
        state.answeredTriggers.add(trigger.id)
        return decision
      }

      // 1. A rendered recall for this exact instruction inside the cache window is
      // reused: a tool loop's later steps and a repeated instruction need no second
      // retrieval. The trigger identity check above keeps one message from being
      // answered twice.
      const cacheKey = `${effective.banks.map(bank => bank.id).join(',')}|${lastUser}`
      const cached = getCachedRecall(state, cacheKey)
      if (cached !== undefined) {
        state.answeredTriggers.add(trigger.id)
        return withRecall(decision, cached, effective.core.recallInjectPosition)
      }

      if (!passRecallGate(state, effective.core)) return decision

      const samples = sampleSession(agent, effective.core)
      const built = buildAdaptiveRecallQuery(lastUser, effective.core, {
        lastTurn: effective.core.recallContextStrategy === 'adaptive' ? samples.lastTurn : undefined,
        taskContext: samples.taskContext,
      })
      if (built.query.trim().length === 0) return decision
      if (!built.isError && state.debounce.unchanged(built.query)) return decision
      state.lastRecallAt = Date.now()

      const injection = await withinBudget(
        performAdaptiveRecall(runtime, built.query, host.judgePort(), {
          taskContext: built.taskContext,
          trigger: 'context',
          injectedThisSession: state.injectedThisSession,
          excludeIds: state.injectedIds,
          env: { role: agent.session?.header?.agentPreset ?? null, isReadonly: isSubagentCaller(agent) },
        }),
        effective.core.injectTimeoutMs,
      )
      if (injection === undefined) return decision
      if (signal.aborted) return decision

      state.injectedThisSession += 1
      for (const fact of injection.details.facts) state.injectedIds.add(fact.id)
      state.answeredTriggers.add(trigger.id)
      state.cache = { key: cacheKey, injection, at: Date.now() }
      return withRecall(decision, injection, effective.core.recallInjectPosition)
    } catch (error) {
      warn('hindsight.lifecycle.context_recall_failed', { error: describe(error) })
      return decision
    }
  })
}

interface TriggerMessage {
  readonly id: string
  readonly content: unknown
}

/**
 * The newest message that is a human/Onlyne instruction: not a recall, and not
 * a plugin snapshot, notice or catalog. Snapshots are context the harness
 * assembles; treating one as the ask would query memory for a clock line.
 */
function triggerMessage(messages: readonly UserMessage[]): TriggerMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    const source = sourceFields(message)
    if (source.kind === SOURCE_KIND) continue
    if (source.form !== undefined && source.form !== 'instructions' && source.form !== 'relay') continue
    return message
  }
  return undefined
}

/** Read `kind`/`form` off a merge-extensible source without asserting its shape. */
function sourceFields(message: Message): { readonly kind?: string; readonly form?: string } {
  const source: unknown = message.source
  if (typeof source !== 'object' || source === null) return {}
  const kind = 'kind' in source && typeof source.kind === 'string' ? source.kind : undefined
  const form = 'form' in source && typeof source.form === 'string' ? source.form : undefined
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(form === undefined ? {} : { form }),
  }
}

function textOf(message: { readonly content: unknown }): string | undefined {
  const content = message.content
  if (typeof content === 'string') return content.trim().length === 0 ? undefined : content
  if (!Array.isArray(content)) return undefined
  const text = content
    .map(block => (typeof block === 'object' && block !== null && 'text' in block ? String(block.text) : ''))
    .join(' ')
  return text.trim().length === 0 ? undefined : text
}

function isTrivialPrompt(prompt: string): boolean {
  const cleaned = prompt.trim()
  if (cleaned.length <= 2) return true
  return /^(?:ok|okay|continue|go|yes|no|好的|收到|继续|确认|撤回|重试|了解|明白)[.!?。！？]*$/iu.test(cleaned)
}

/** `recallTriggers` resolves to one switch; an unknown value of a typo only turns one trigger off. */
function triggerSwitch(config: HindsightConfig): boolean {
  const listed = new Set(config.recallTriggers)
  return listed.has('context') || listed.has('prompt') || listed.has('turn-end') || listed.size === 0
}

/** Automatic recall is always on for main sessions; subagents follow `recallInSubagents`. */
function recallAllowed(agent: Agent, config: HindsightConfig): boolean {
  return !isSubagentCaller(agent) || config.recallInSubagents
}

/**
 * The shared automatic-recall gate, fixed order: explicit mode → every-N gate →
 * minimum interval. `turns` counts recall opportunities, not host turns.
 */
function passRecallGate(state: AgentRecallState, config: HindsightConfig): boolean {
  if (config.recallMode === 'explicit-only') return false
  state.turns += 1
  if (
    config.recallMode === 'every-n-turns' &&
    config.recallEveryNTurns > 1 &&
    state.turns % config.recallEveryNTurns !== 0
  ) {
    return false
  }
  if (config.recallMinIntervalMs > 0 && Date.now() - state.lastRecallAt < config.recallMinIntervalMs) return false
  return true
}

function getCachedRecall(state: AgentRecallState, key: string): RecallInjection | undefined {
  const cache = state.cache
  if (cache === undefined || cache.key !== key) return undefined
  if (Date.now() - cache.at > RECALL_CACHE_TTL_MS) {
    state.cache = undefined
    return undefined
  }
  return cache.injection
}

/**
 * Append the recall to the step's message batch. The human prompt keeps its
 * place and content; only a new sourced message joins the batch, which the
 * session logs as one durable `user/message`.
 */
function withRecall(decision: Extract<PreStepDecision, { kind: 'enter' }>, injection: RecallInjection, position: string): PreStepDecision {
  const source: UserMessage['source'] = {
    kind: SOURCE_KIND,
    form: SOURCE_FORM,
    details: injection.details,
  }
  const message = createUserMessage({
    content: [{ type: 'text', text: injection.text }],
    source,
  })
  return {
    ...decision,
    messages: position === 'prepend' ? [message, ...decision.messages] : [...decision.messages, message],
  }
}

/** The injection budget: recall may not hold up the host's next step. */
async function withinBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | undefined> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return work
  void work.catch(() => undefined)
  const { promise: guard, resolve } = Promise.withResolvers<undefined>()
  const timer = setTimeout(() => resolve(undefined), budgetMs)
  try {
    return await Promise.race([work, guard])
  } finally {
    clearTimeout(timer)
  }
}

function warn(message: string, context: Record<string, unknown>): void {
  lifecycleLogger?.warn(message, context)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ─────────────────────────────────────────────────────────────
// Task-context sampling
// ─────────────────────────────────────────────────────────────

export interface BranchSamples {
  /** Context samples in time order: roles filtered, bodies clamped. */
  readonly taskContext: readonly RecallTurnSample[]
  /** Latest assistant body and latest tool output; the `adaptive` strategy needs them alone. */
  readonly lastTurn: LastTurn
}

interface BranchMessage {
  readonly role: string
  readonly content?: unknown
}

/**
 * Sample the session's conversation so the rerank sees what we are doing now.
 * One turn starts at a user message; the last `recallContextTurns` turns are
 * sampled, keeping the newest message per role per turn. A branch without a
 * user message (after a compaction boundary) counts as one turn.
 */
export function sampleSession(agent: Agent, config: HindsightConfig): BranchSamples {
  const roles = contextRoles(config.recallContextRoles)
  const limit = Math.max(0, Math.trunc(config.recallTurnSampleChars))
  const messages: BranchMessage[] = []
  for (const message of derivedMessages(agent)) {
    // Recall text is memory, not something the user said.
    if (sourceFields(message).kind === SOURCE_KIND) continue
    messages.push({ role: message.role, content: message.content })
  }

  const taskContext: RecallTurnSample[] = []
  if (config.recallContextTurns > 0 && limit > 0) {
    for (const turn of lastTurns(messages, Math.trunc(config.recallContextTurns))) {
      const newest = new Map<string, number>()
      for (const index of turn) {
        const message = messages[index]
        if (message !== undefined && roles.has(message.role)) newest.set(message.role, index)
      }
      for (const index of [...newest.values()].sort((left, right) => left - right)) {
        const message = messages[index]
        if (message === undefined) continue
        const text = textOfMessage(message, limit)
        if (text.length === 0) continue
        taskContext.push({ role: message.role, text })
      }
    }
  }
  return { taskContext, lastTurn: lastTurnOf(messages, limit) }
}

function derivedMessages(agent: Agent): readonly Message[] {
  try {
    return agent.session?.deriveMessages?.() ?? []
  } catch {
    return []
  }
}

/** Config roles map to host message roles; dsh calls a tool result `tool`. */
function contextRoles(configured: readonly string[]): ReadonlySet<string> {
  const roles = new Set<string>()
  for (const role of configured) {
    if (role === 'user' || role === 'assistant') roles.add(role)
    else if (role === 'tool' || role === 'toolResult') roles.add('tool')
  }
  return roles
}

/** Indices of the last `count` turns, in time order. */
function lastTurns(messages: readonly BranchMessage[], count: number): number[][] {
  const starts: number[] = []
  for (let index = messages.length - 1; index >= 0 && starts.length < count; index -= 1) {
    if (messages[index]?.role === 'user') starts.push(index)
  }
  if (starts.length === 0) return messages.length === 0 ? [] : [[...messages.keys()]]
  starts.reverse()
  return starts.map((from, position) => {
    const to = starts[position + 1] ?? messages.length
    return Array.from({ length: to - from }, (_unused, offset) => from + offset)
  })
}

function lastTurnOf(messages: readonly BranchMessage[], limit: number): LastTurn {
  let assistant: string | undefined
  let toolResult: string | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (assistant !== undefined && toolResult !== undefined) break
    const message = messages[index]
    if (message === undefined) continue
    const text = textOfMessage(message, limit)
    if (text.length === 0) continue
    if (message.role === 'assistant') assistant ??= text
    else if (message.role === 'tool') toolResult ??= text
  }
  return { ...(assistant === undefined ? {} : { assistant }), ...(toolResult === undefined ? {} : { toolResult }) }
}

/** Text blocks only: images and thinking placeholders retrieve nothing; the tail holds error fingerprints. */
function textOfMessage(message: unknown, limit: number): string {
  if (limit <= 0 || typeof message !== 'object' || message === null) return ''
  if (!('content' in message)) return ''
  const content = message.content
  const text = typeof content === 'string' ? content : textParts(content)
  return text.length > limit ? text.slice(-limit) : text
}

function textParts(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

export type { RecallDetails, RecallInjection }
