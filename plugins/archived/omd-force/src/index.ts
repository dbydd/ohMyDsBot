/**
 * omd-force — force the model to call a specific tool first on the upcoming turn.
 *
 * Registers the `/force <tool> [prompt]` slash command and attaches a `tools/pre-execute`
 * waterfall listener to verify that the first tool call of the turn matches the forced tool.
 * If the first tool call does not match, execution is blocked with feedback.
 * Once the first tool call occurs (whether allowed or blocked), the one-time mark is cleared.
 * Calling `/force off` explicitly disarms the forced tool.
 *
 * @module omd-force
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

/** Plugin name for registration in Cordis. */
export const name = 'omd-force'

/** Required services declared for Cordis dependency injection. */
export const inject = ['commands', 'tools']

/** State representing an armed force directive for one agent. */
export interface ForcedToolState {
  /** Target tool name required on the first invocation. */
  readonly tool: string
  /** Optional prompt or context explaining the forced execution requirement. */
  readonly prompt?: string
}

/**
 * Extracts a stable lookup key for an agent.
 *
 * @param agent - Target agent handle.
 * @returns String identity or string representation of the agent.
 */
export function getAgentKey(agent: Agent): string {
  if ('id' in agent && typeof agent.id === 'string') {
    return agent.id
  }
  return String(agent)
}

/**
 * Evaluates the `/force` command invocation and updates or inspects the per-agent state.
 *
 * @param forcedByAgent - Registry mapping agent keys to their armed force state.
 * @param invocation - Current command invocation context.
 * @returns Resulting status message to display to the user.
 */
export function handleForceCommand(
  forcedByAgent: Map<string, ForcedToolState>,
  invocation: CommandInvocation,
): CommandResult {
  const agentKey = getAgentKey(invocation.agent)
  const trimmed = invocation.rawInput.trim()

  if (trimmed === '') {
    const current = forcedByAgent.get(agentKey)
    if (current !== undefined) {
      return { kind: 'success', text: `Force armed: ${current.tool}` }
    }
    return { kind: 'success', text: 'No forced tool' }
  }

  if (trimmed.toLowerCase() === 'off') {
    forcedByAgent.delete(agentKey)
    return { kind: 'success', text: 'Force cleared' }
  }

  const match = /^\s*(\S+)(?:\s+([\s\S]+))?$/.exec(trimmed)
  if (match === null) {
    return { kind: 'success', text: 'No forced tool' }
  }

  const rawTool = match[1]!
  const tool = rawTool.startsWith(':') ? rawTool.slice(1) : rawTool
  const prompt = match[2]?.trim()

  const entry: ForcedToolState = prompt === undefined || prompt === ''
    ? { tool }
    : { tool, prompt }

  forcedByAgent.set(agentKey, entry)

  return { kind: 'success', text: `Force armed: ${tool}` }
}

/**
 * Inspects a pending tool execution before dispatch against the agent's forced tool requirement.
 *
 * @param forcedByAgent - Registry mapping agent keys to their armed force state.
 * @param exec - Candidate tool execution entering the pre-execute waterfall.
 * @param next - Downstream pre-execute decision resolver.
 * @returns Promise resolving to the pre-execution decision (allow, deny, or downstream).
 */
export async function handlePreExecute(
  forcedByAgent: Map<string, ForcedToolState>,
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>,
): Promise<PreToolDecision> {
  // Zero overhead when no agents have armed force states or when exec has no associated agent.
  if (forcedByAgent.size === 0 || exec.agent === undefined) {
    return next()
  }

  const agentKey = getAgentKey(exec.agent)
  const forced = forcedByAgent.get(agentKey)
  if (forced === undefined) {
    return next()
  }

  // One-time enforcement on the first tool call of the turn: consume the mark immediately.
  forcedByAgent.delete(agentKey)

  if (exec.name === forced.tool) {
    return next()
  }

  const feedback = forced.prompt !== undefined && forced.prompt !== ''
    ? `本回合必须先用 ${forced.tool}：${forced.prompt}`
    : `本回合必须先用 ${forced.tool}`

  return {
    kind: 'deny',
    reason: feedback,
  }
}

/**
 * Applies the `omd-force` plugin to the Cordis context.
 *
 * @param ctx - Root or scoped Cordis context.
 */
export function apply(ctx: Context): void {
  const forcedByAgent = new Map<string, ForcedToolState>()

  ctx.effect(() => {
    return () => {
      forcedByAgent.clear()
    }
  })

  ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
    forcedByAgent.delete(getAgentKey(agent))
  })

  ctx.effect(() => {
    return ctx.commands.register({
      name: 'force',
      description: 'Force the model to call a specific tool first on the upcoming turn',
      input: {
        hint: '<tool> [prompt]',
      },
      handler: (invocation: CommandInvocation): CommandResult => {
        return handleForceCommand(forcedByAgent, invocation)
      },
    })
  })

  ctx.on('tools/pre-execute', (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    return handlePreExecute(forcedByAgent, exec, next)
  })
}
