/**
 * omd-prewalk — one-shot model handoff after the first successful file mutation.
 *
 * Ported from omp's prewalk: an agent plans on the strong model, then lands its
 * first real edit and continues on a cheaper route. The handoff fires once per
 * agent, when the agent has a non-empty `todos` projection and a successful
 * `edit` or `write` result. Disabled by default.
 *
 * The route is explicit. dsh has no model-role registry, so `into` is only the
 * label omp would use and never resolves a route by itself.
 *
 * Coupling with the model-selection layers (`installModelSelection`, the TUI
 * channel binding): the switch is a request-level reroute, not a session
 * selection change. It rewrites the next request after the trigger and moves
 * the logged `request/header`, so every route reader that falls back to the
 * header follows it. A layer that pins its own route keeps asking for the
 * pinned route; the override yields to it on the following request instead of
 * fighting the pin, and that layer's `[model changed: …]` notice stays true.
 *
 * `/prewalk off` releases the override. It cannot revert a request header the
 * switch already logged: unwinding a logged route is not available to a
 * tree-external plugin.
 *
 * @module omd-prewalk
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** Plugin name for registration in Cordis. */
export const name = 'omd-prewalk'

/** Required services: the todo projection read, route validation, and the command surface. */
export const inject = ['commands', 'llm', 'sessionProjections']

/** Deployment settings for the one-shot handoff. */
export interface Config {
  /** Arm the handoff at load. False registers nothing at all. */
  enabled: boolean
  /** Label for the target route, shown by `/prewalk`. Never resolves a route by itself. */
  into: string
  /** Registered provider route the handoff switches to; required when enabled. */
  intoProvider: string
  /** Provider-owned model id the handoff switches to; required when enabled. */
  intoModel: string
}

/** Schemastery configuration for the handoff. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false)
    .description('Arm the one-shot model handoff. False leaves the plugin inert: it registers no listener and no command.'),
  into: z.string().default('smol')
    .description('Label for the target route shown by /prewalk. dsh has no model-role registry, so this label resolves nothing.'),
  intoProvider: z.string().default('')
    .description('Registered provider route the handoff switches to. Required when enabled.'),
  intoModel: z.string().default('')
    .description('Provider-owned model id the handoff switches to. Required when enabled.'),
})

/** One provider/model pair a request can carry. */
interface Route {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
}

/** The one-shot outcome remembered for one agent. */
interface AgentPrewalkState {
  /** Target route while the override is in force; undefined once the handoff yielded or was released. */
  route: Route | undefined
  /** Whether the override already replaced one request's route. */
  applied: boolean
  /** Why no route is in force, when there is a cause worth reporting. */
  reason: string | undefined
}

/**
 * Structural face of the session-projection registry: the single read this
 * package performs. The `todos` unit belongs to `dsh-tool-todo`; reading it
 * through `ctx.get` keeps this package independent of that package's type
 * declarations, which the plugin link farm does not carry.
 */
interface ProjectionRead {
  /**
   * Current state of one registered projection unit.
   * @param session - session whose folded state is read.
   * @param key - projection key.
   * @returns the unit's current state, or undefined when no unit owns the key.
   */
  stateOf(session: Session, key: string): unknown
}

/**
 * Format one route for user-facing text.
 * @param route - the route to format.
 * @returns `<provider>/<model>`.
 */
function routeLabel(route: Route): string {
  return `${route.provider}/${route.model}`
}

/**
 * Compare two routes by provider and model.
 * @param left - first route.
 * @param right - second route.
 * @returns whether both name the same provider and model.
 */
function sameRoute(left: Route, right: Route): boolean {
  return left.provider === right.provider && left.model === right.model
}

/**
 * Read the route the machine would use for this agent right now.
 * @param agent - agent whose route is read.
 * @returns the last logged request route, else the agent's creation options.
 */
function currentRoute(agent: Agent): Route | undefined {
  const header = agent.session.requestHeader()
  if (header !== undefined) return { provider: header.config.provider, model: header.config.model }
  const { provider, model } = agent.options
  if (provider === undefined || model === undefined) return undefined
  return { provider, model }
}

/**
 * Whether the agent has a non-empty todo plan.
 * @param projections - projection registry, or undefined when the seam is absent.
 * @param session - session whose `todos` state is read.
 * @returns whether the latest whole todo list has at least one item.
 */
function hasTodos(projections: ProjectionRead | undefined, session: Session): boolean {
  const state = projections?.stateOf(session, 'todos')
  return Array.isArray(state) && state.length > 0
}

/**
 * Apply `omd-prewalk`: arm one handoff per agent, reroute its next request, and
 * register `/prewalk`.
 * @param ctx - context carrying the agent, LLM, command, and projection seams.
 * @param config - deployment settings for the handoff.
 * @throws when the handoff is enabled without an explicit provider and model.
 */
export function apply(ctx: Context, config: Config): void {
  // Disabled means inert: no listener, no command, no state.
  if (!config.enabled) return

  const target: Route = {
    provider: config.intoProvider.trim(),
    model: config.intoModel.trim(),
  }
  if (target.provider === '' || target.model === '') {
    throw new Error(
      `omd-prewalk: enabled requires intoProvider and intoModel; dsh resolves no model route from "${config.into}"`,
    )
  }

  const projections: ProjectionRead | undefined = ctx.get('sessionProjections')
  const states = new Map<string, AgentPrewalkState>()

  ctx.effect(() => () => states.clear())

  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.effect(() => () => { states.delete(agent.id) })
  })

  ctx.on('agent/request', async (
    { agent }: { agent: Agent },
    next: () => Promise<LlmCallConfig>,
  ): Promise<LlmCallConfig> => {
    const resolved = await next()
    const state = states.get(agent.id)
    const route = state?.route
    if (state === undefined || route === undefined) return resolved
    const inner: Route = { provider: resolved.provider, model: resolved.model }
    if (sameRoute(inner, route)) return resolved
    if (state.applied) {
      // Something else owns this route (a pinned model selection): yield to it.
      state.route = undefined
      state.reason = `the session routes itself to ${routeLabel(inner)}`
      return resolved
    }
    state.applied = true
    // An inherited effort may not exist on the target route; its default applies instead.
    const { reasoningEffort: _inheritedEffort, ...rest } = resolved
    return { ...rest, provider: route.provider, model: route.model }
  }, { prepend: true })

  ctx.on('tools/post-execute', async (
    exec: ToolExecution,
    result: Readonly<ToolExecutionResult>,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> => {
    const decision = await next()
    if (decision.kind !== 'accept' || result.isError) return decision
    if (exec.name !== 'edit' && exec.name !== 'write') return decision
    const agent = exec.agent
    if (agent === undefined || states.has(agent.id)) return decision
    if (!hasTodos(projections, agent.session)) return decision
    const current = currentRoute(agent)
    if (current !== undefined && sameRoute(current, target)) {
      states.set(agent.id, { route: undefined, applied: false, reason: `the agent already runs on ${routeLabel(target)}` })
      return decision
    }
    if (!ctx.llm.listProviders().some(provider => provider.id === target.provider)) {
      states.set(agent.id, {
        route: undefined,
        applied: false,
        reason: `no adapter is registered for provider "${target.provider}"`,
      })
      return decision
    }
    states.set(agent.id, { route: target, applied: false, reason: undefined })
    return decision
  })

  const prewalkCommand = (invocation: CommandInvocation): CommandResult => {
    const state = states.get(invocation.agent.id)
    const input = invocation.rawInput.trim().toLowerCase()
    if (input === 'off') {
      if (state === undefined) {
        states.set(invocation.agent.id, { route: undefined, applied: false, reason: 'disarmed by /prewalk off' })
      } else {
        state.route = undefined
        state.applied = false
        if (state.reason === undefined) state.reason = 'released by /prewalk off'
      }
      return { kind: 'success', text: 'Nothing to switch' }
    }
    if (input !== '') return { kind: 'error', text: 'Usage: /prewalk [off]' }
    if (state === undefined) return { kind: 'success', text: 'Prewalk armed' }
    if (state.route !== undefined) return { kind: 'success', text: `Prewalk switched to ${routeLabel(state.route)}` }
    if (state.reason !== undefined) return { kind: 'success', text: `Nothing to switch (${state.reason})` }
    return { kind: 'success', text: 'Nothing to switch' }
  }

  ctx.effect(() => ctx.commands.register({
    name: 'prewalk',
    description: 'Inspect or disarm the one-shot model handoff that follows the first successful edit or write',
    input: { hint: '[off]' },
    handler: prewalkCommand,
  }))
}
