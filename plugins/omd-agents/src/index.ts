/**
 * `omd-agents` — the delegation roster: agent definitions from configuration and
 * local markdown files, rendered into the system prompt, and exposed as `ctx.agentCatalog`.
 *
 * Implements:
 * - Built-in standard capability tiers (`engineer`, `labor`, `philosopher`, `theorist`)
 *   mapping directly to gateway routes (`magpie/group/...`).
 * - Profile-configurable routes via `Config.agents`.
 * - Optional local definition scan in `~/.dsh/agent/agents/*.md` and `<cwd>/.dsh/agents/*.md`.
 * - System prompt section `# Available Agents` rendered into model view.
 * - `ctx.agentCatalog` service consumed by `omd-task`.
 *
 * @module omd-agents
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import { detectDuplicates, scanAgents } from './frontmatter.ts'
import type { AgentCatalog, AgentDefinition } from './types.ts'
export type * from './types.ts'

/** Plugin id the Loader entry carries. */
export const name = 'omd-agents'

/** Services this plugin needs before its fiber activates. */
export const inject = ['systemPrompt']

/** Section name this package owns in the system prompt. */
const SECTION_NAME = 'omd:agents'

/** Configuration for one agent in profile settings. */
export interface AgentSpec {
  description: string
  instructions?: string
  model?: string
  thinkingLevel?: string
  tools?: string[]
}

/** Deployment settings for the roster. */
export interface Config {
  /** Prompt position for the agent catalog; the omd-core contract reserves 80. */
  sectionOrder: number
  /** Configured agent roles mapping capability tiers to gateway routes. */
  agents?: Record<string, AgentSpec>
}

const AgentSpecSchema = z.object({
  description: z.string().description('One-line description of the agent role and purpose.'),
  instructions: z.string().description('System instructions for the subagent.'),
  model: z.string().description('provider/model gateway route for this capability tier.'),
  thinkingLevel: z.string().description('Reasoning effort or thinking level.'),
  tools: z.array(z.string()).description('Allowed tool names for this agent.'),
})

/** Schemastery configuration for the roster. */
export const Config: z<Config> = z.object({
  sectionOrder: z.natural().default(80)
    .description('Position of the agent catalog in the assembled system prompt; the omd-core contract reserves 80.'),
  agents: z.dict(AgentSpecSchema)
    .description('Configured agent roles mapping capability tiers to gateway routes.'),
})

/** Built-in standard capability tiers mapping to gateway routes. */
const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  {
    name: 'engineer',
    description: 'Technical implementation: multi-file edits, caller migration, bug fixes, settled interface execution.',
    instructions: 'You are an engineer subagent. Implement features and fixes to working, verified code.',
    model: 'magpie/group/engineer',
    tools: ['read', 'write', 'edit', 'bash', 'resource'],
    source: 'config',
  },
  {
    name: 'labor',
    description: 'Routine bulk tasks, deterministic programming, mechanical rewrites, test runs.',
    instructions: 'You are a labor subagent. Focus on high-volume, deterministic edits.',
    model: 'magpie/group/labor',
    tools: ['read', 'write', 'edit', 'bash', 'resource'],
    source: 'config',
  },
  {
    name: 'philosopher',
    description: 'Deep reasoning, open problem solving, foundational architecture, scientific derivation.',
    instructions: 'You are a philosopher subagent. Reason from first principles on difficult technical problems.',
    model: 'magpie/group/philosopher',
    tools: ['read', 'write', 'edit', 'bash', 'resource'],
    source: 'config',
  },
  {
    name: 'theorist',
    description: 'Architecture trade-offs, interface design, specification refinement.',
    instructions: 'You are a theorist subagent. Plan, specify, and evaluate designs without premature implementation.',
    model: 'magpie/group/theorist',
    tools: ['read', 'resource'],
    source: 'config',
  },
]

/**
 * Render the tool grant of one agent.
 * @param tools the agent's declared tools, or undefined when it inherits
 * @returns the parenthesized clause that follows the description
 */
function describeTools(tools: readonly string[] | undefined): string {
  if (tools === undefined) return '(tools: inherited)'
  if (tools.length === 0) return '(tools: none)'
  return `(tools: ${tools.join(', ')})`
}

/**
 * Render the catalog as a prompt section body.
 * @param agents the loaded definitions, already ordered by name
 * @returns the section text, or `''` when there are no agents
 */
function renderCatalog(agents: readonly AgentDefinition[]): string {
  if (agents.length === 0) return ''
  const lines = agents.map(agent => `- \`${agent.name}\`: ${agent.description} ${describeTools(agent.tools)}`)
  return ['# Available Agents', ...lines].join('\n')
}

/**
 * Load the roster from built-ins, configuration, and directories, then register it on the context.
 * @param ctx the entry fiber's context, carrying the prompt registry
 * @param config deployment settings for this profile
 */
export function apply(ctx: Context, config: Config): void {
  const byName = new Map<string, AgentDefinition>()

  // 1. Load built-ins
  for (const agent of BUILTIN_AGENTS) {
    byName.set(agent.name, agent)
  }

  // 2. Load configured agents from profile settings
  if (config.agents) {
    for (const [agentName, spec] of Object.entries(config.agents)) {
      byName.set(agentName, {
        name: agentName,
        description: spec.description,
        instructions: spec.instructions ?? `You are agent ${agentName}. Follow assignment instructions.`,
        model: spec.model,
        thinkingLevel: spec.thinkingLevel,
        tools: spec.tools,
        source: 'config',
      })
    }
  }

  // 3. Scan filesystem definitions if present
  try {
    const scanned = scanAgents(process.cwd(), homedir())
    const duplicates = detectDuplicates(scanned.agents)
    if (duplicates.length === 0) {
      for (const entry of scanned.agents) {
        byName.set(entry.definition.name, entry.definition)
      }
    }
  } catch {
    // Ignore filesystem scan failure if directories don't exist
  }

  const agents: readonly AgentDefinition[] = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  const catalog: AgentCatalog = {
    list: () => agents,
    resolve: name => byName.get(name),
  }
  ctx.provide('agentCatalog', catalog)

  const text = renderCatalog(agents)
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: config.sectionOrder,
    interpolate: false,
    text: () => text,
  }))
}
