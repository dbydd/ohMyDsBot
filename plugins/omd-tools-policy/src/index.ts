/**
 * omd-tools-policy — one mask over every agent's model-facing surface.
 *
 * Everything here is applied per agent, at `agent/created`, through that
 * agent's own context. Four independent mechanisms narrow the surface:
 *
 * - `deny` removes inherited tool names (`tools.restrict`).
 * - `blankSections` shadows inherited system-prompt sections with an empty
 *   section of the same name.
 * - `redirectCommands` shadows inherited slash commands with a notice.
 * - `pauseGoals` pauses an already-active goal so it cannot keep running.
 *
 * All four are registrations on `agent.ctx`, so a mask lives exactly as long
 * as the agent it applies to. Nothing is registered on the host context: a
 * global restriction or a global section would hit every agent, and both
 * services refuse that on purpose.
 *
 * Sections and commands use the same merge as tools: global layer, then each
 * ancestor (a preset is one), then the agent's own scope; the nearest layer
 * wins a name. Registering an empty section or a replacement command therefore
 * replaces the inherited one rather than adding to it. An empty section is
 * dropped when the prompt is rendered.
 *
 * `deny` is intersected with the names the agent actually inherits. One
 * profile-wide list spans presets that mount different plugins — a preset may
 * not compose `dsh-tool-lsp` at all — and `restrict` rejects an unknown name.
 * Intersection keeps the list declarative; a misspelled name is a no-op rather
 * than a rejected agent. A name the agent's own scope registers stays visible:
 * `schemas` includes it, `restrict` still rejects it as inherited-unknown, so
 * keep own-scope names out of the list.
 *
 * The services are reached with `get('…')` because this plugin is not a plugin
 * of the agent's context: property access there throws without an `inject`
 * declaration, while `get` returns the same service bound to the scope it was
 * read from.
 *
 * @module omd-tools-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'

export const name = 'omd-tools-policy'

/** Services this plugin needs before its fiber activates. */
export const inject = ['tools']

/** One inherited slash command replaced by a fixed notice. */
export interface RedirectCommand {
  /** Command name without the leading slash; the inherited one is shadowed. */
  name: string
  /** Notice shown in the command panel and returned by the command. */
  message: string
}

/** Deployment settings for the per-agent surface. */
export interface Config {
  /** Tool names hidden from every agent that inherits them. */
  deny: string[]
  /** System-prompt section names replaced by an empty section of the same name. */
  blankSections: string[]
  /** Slash commands replaced by a notice, without reaching the model. */
  redirectCommands: RedirectCommand[]
  /** Pause a goal that is already active when the agent is created. */
  pauseGoals: boolean
  /** Preset ids that skip every mechanism above, for agents that need the full surface. */
  exemptPresets: string[]
}

/** Schemastery configuration for the per-agent surface. */
export const Config: z<Config> = z.object({
  deny: z.array(z.string()).default([])
    .description('Tool names hidden from every agent that inherits them.'),
  blankSections: z.array(z.string()).default([])
    .description('System-prompt section names replaced by an empty section of the same name.'),
  redirectCommands: z.array(z.object({
    name: z.string().description('Command name without the leading slash.'),
    message: z.string().description('Notice shown in the command panel and returned by the command.'),
  })).default([])
    .description('Slash commands replaced by a notice, without reaching the model.'),
  pauseGoals: z.boolean().default(false)
    .description('Pause a goal that is already active when the agent is created.'),
  exemptPresets: z.array(z.string()).default([])
    .description('Preset ids that skip every mechanism in this config.'),
})

/**
 * Apply the configured surface to each agent as it is created.
 * @param ctx - the entry fiber's context, carrying the tool registry.
 * @param config - deployment settings for this profile.
 */
export function apply(ctx: Context, config: Config): void {
  const deny = [...new Set(config.deny)]
  const blankSections = [...new Set(config.blankSections)]
  // Duplicate names would collide inside one scope; the last entry wins.
  const redirects = [...new Map(config.redirectCommands.map(item => [item.name, item] as const)).values()]
  const exempt = new Set(config.exemptPresets)
  if (deny.length === 0 && blankSections.length === 0 && redirects.length === 0 && !config.pauseGoals) return

  ctx.on('agent/created', ({ agent }) => {
    const preset = agent.session.header.agentPreset
    if (preset !== undefined && exempt.has(preset)) return

    if (deny.length > 0) {
      const tools = agent.ctx.get('tools')
      if (tools !== undefined) {
        const present = new Set<string>(tools.schemas(agent).map((tool: { name: string }) => tool.name))
        const names = deny.filter(name => present.has(name))
        if (names.length > 0) tools.restrict({ deny: names })
      }
    }

    if (blankSections.length > 0) {
      const prompt = agent.ctx.get('systemPrompt')
      if (prompt !== undefined) {
        // Order is irrelevant: the name shadows an inherited section, and an
        // empty text contributes nothing to the rendered prompt.
        for (const section of blankSections) prompt.section({ name: section, order: 0, text: '' })
      }
    }

    if (redirects.length > 0) {
      const commands = agent.ctx.get('commands')
      if (commands !== undefined) {
        for (const { name, message } of redirects) {
          commands.register({
            name,
            description: message,
            // Direct handling: the command never opens a turn, so nothing
            // reaches the model and no goal is created.
            handler: () => ({ kind: 'success', text: message }),
          })
        }
      }
    }

    if (config.pauseGoals) {
      const goals = ctx.get('goals')
      const goal = goals?.get(agent)
      if (goal !== undefined && goal.phase === 'active') {
        goals.pause(agent, { id: goal.id, revision: goal.revision })
      }
    }
  })
}
