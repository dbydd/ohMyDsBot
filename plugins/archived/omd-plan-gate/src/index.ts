/**
 * `omd-plan-gate` — plan-mode guardrail for omd.
 *
 * While plan mode is active, the model-facing system prompt carries the
 * `omd:plan-freeze` section (order 90, literal text): the tool catalog is
 * frozen by design — no tool row is disabled, added, or removed, and that
 * stability is deliberate, not an omission — and change-making tools must
 * not be used until the plan is presented.
 *
 * The plan is exited with `exit_plan_with`, which offers a three-way handoff
 * (`execute` / `compact` / `keep`) that upstream `exit_plan_mode` does not
 * offer: upstream's `exit_plan_mode` is binary (approve vs keep planning) and
 * stays registered here untouched — re-registering it would change the
 * request tool catalog across plan transitions, exactly what this package
 * exists to prevent.
 *
 * `ctx.planMode` is not required: plan state is read from the `plan`
 * projection folded by `@deepseek-ai/dsh-plan-mode`, and leaving plan mode
 * appends the durable `plan/mode` event that plan-mode's own fold consumes,
 * so this package works whether or not plan-mode itself is composed.
 *
 * Named exports only: a `default` export makes the Loader discard this whole
 * namespace and every injection with it.
 *
 * Known limitations
 *   - Branch taken: `exit_plan_mode` (upstream) is not re-registered, and
 *     `exit_plan_with` is registered instead for the three-way handoff, since
 *     upstream does not support execute/compact/keep. `Config.exitMode`
 *     (default `compact`) records the default strategy; the prompt section
 *     states all three options' semantics.
 *   - `execute` spawns no new agent here: this package does not require the
 *     subagent service, so `execute` means "leave plan mode now and let the
 *     current agent continue from the plan already in the transcript". A
 *     brand-new agent without the planning transcript needs `ctx.get('subagents')`,
 *     which is not guaranteed in every profile.
 *   - `compact` throws an actionable error when the compaction service is not
 *     composed; `keep`/`execute` do not depend on it.
 *   - `plan/mode` is appended directly when `ctx.get('planMode')` is absent, so
 *     it commits immediately even mid-turn; plan-mode's fold takes the last
 *     `plan/mode`, so an in-flight plan-mode selection is overridden by this
 *     exit.
 *
 * @module omd-plan-gate
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { ExitMode, PlanUnitState } from './types.ts'

/** Minimal structural shape of the plan-mode service, read without import. */
interface PlanModeHandle {
  set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop'
}

/** Minimal structural shape of the compaction engine, read without import. */
interface CompactionEngine {
  compactNow(
    agent: { session: Session; options: { provider?: string; model?: string } },
    signal: AbortSignal,
    sourceCommandId?: string,
  ): Promise<unknown>
}

/**
 * Fixed guidance rendered while plan mode is active. It never lists tools by
 * name: the freeze is about the catalog's stability, not about any tool.
 */
const PLAN_FREEZE_TEXT = `\
Plan mode is on and the tool catalog is deliberately frozen: no row is disabled,
added, or replaced. That is the design, not an omission — keeping the catalog
identical across modes keeps the request cache warm.
Do not use mutating tools (write, edit, ...) before the plan is submitted. State
the whole plan first.
When the plan is ready, call exit_plan_with and pick the handoff:
- execute: enter execution from the plan, with the plan text as the next step and
  without the plan-mode guidance;
- compact: compact the context once, then continue in this agent;
- keep: continue in this agent with the planning transcript intact.
The default handoff is Config.exitMode (compact).
`

/** Plugin id the Loader entry carries. */
export const name = 'omd-plan-gate'

/** Services this plugin needs before its fiber activates. */
export const inject = ['sessionProjections', 'systemPrompt', 'tools']

/** Plan-gate deployment settings. */
export interface Config {
  /**
   * Default handoff strategy when leaving plan mode: `execute` continues from
   * the plan, `compact` compacts first, `keep` preserves the full transcript.
   * `exit_plan_with` may override it per call.
   */
  exitMode: ExitMode
}

/** Schemastery configuration for the plan-gate consumer. */
export const Config: z<Config> = z.object({
  exitMode: z
    .union([z.const('execute'), z.const('compact'), z.const('keep')])
    .default('compact')
    .description('Default handoff strategy when leaving plan mode.'),
})

/**
 * Append a `plan/mode` log event. `session.append('plan/mode', ...)` is not in
 * the `SessionEventMap` grammar unless `@deepseek-ai/dsh-plan-mode` is
 * imported, which this package deliberately avoids, so the append is typed
 * through this minimal structural interface.
 * @param session - session whose log grows
 * @param active - whether plan mode should be active after this event
 */
function appendPlanMode(session: Session, active: boolean): void {
  ;(session as { append(type: string, data: unknown): unknown }).append('plan/mode', { active })
}

/**
 * Leave plan mode, preferring plan-mode's own `set` (which handles open-turn
 * and pending-selection bookkeeping) when the service is composed, and
 * appending `plan/mode` directly otherwise.
 * @param ctx - cordis context
 * @param agent - agent whose session leaves plan mode
 */
async function leavePlanMode(ctx: Context, agent: Agent): Promise<void> {
  const planMode = ctx.get('planMode') as PlanModeHandle | undefined
  if (planMode !== undefined) {
    planMode.set(agent, false)
    return
  }
  appendPlanMode(agent.session, false)
}

/**
 * Apply the plan-gate: register the freeze prompt section gated on plan state,
 * and the `exit_plan_with` tool. Nothing in the tool registry is touched by
 * plan transitions.
 * @param ctx - the entry fiber's context, carrying the registries
 * @param config - deployment settings for this profile
 */
export function apply(ctx: Context, config: Config): void {
  const exitMode = config.exitMode ?? 'compact'

  ctx.systemPrompt.section({
    name: 'omd:plan-freeze',
    order: 90,
    interpolate: false,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined) return ''
      const state = ctx.sessionProjections.stateOf(agent.session, 'plan')
      if (state === undefined) return ''
      const wanted = state.running?.wanted ?? state.wanted
      const active = wanted !== null ? wanted : state.active
      return active ? PLAN_FREEZE_TEXT : ''
    },
  })

  /** The three-way plan-mode exit tool; upstream `exit_plan_mode` is not touched. */
  const EXIT_PLAN_WITH = 'exit_plan_with'

  ctx.tools.register(
    defineTool({
      name: EXIT_PLAN_WITH,
      description: [
        'Leave plan mode with a handoff strategy. Only meaningful while plan mode is active.',
        `exit: ${exitMode} is the profile default; `,
        'execute continues from the plan, compact compacts first, keep preserves the full transcript.',
      ].join(' '),
      parameters: {
        mode: {
          type: 'string',
          enum: ['execute', 'compact', 'keep'],
          required: true,
          description: `Handoff strategy. Profile default: ${exitMode}.`,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string', required: true },
            exited: { type: 'boolean', required: true },
            compaction: {
              type: 'string',
              enum: ['none', 'performed', 'skipped'],
              required: true,
            },
          },
        },
        render: (_args, value) => {
          // `value` is `JsonValue` from the tool-output contract; the schema
          // guarantees the shape, but the compiler only sees `JsonValue`, so
          // narrow via a cast to a named const and validate before use.
          const result = value as {
            mode: string
            exited: boolean
            compaction: string
          } | undefined
          if (
            !result ||
            typeof result.mode !== 'string' ||
            typeof result.exited !== 'boolean' ||
            typeof result.compaction !== 'string'
          ) {
            return [{ type: 'text', text: 'exit_plan_with: <invalid result>' }]
          }
          return [
            {
              type: 'text',
              text: `exit_plan_with: mode=${result.mode}, exited=${result.exited}, compaction=${result.compaction}`,
            },
          ]
        },
      },
      execute: async (args, exec) => {
        const agent = exec.agent
        if (agent === undefined) {
          throw new Error(`${EXIT_PLAN_WITH} requires a calling agent (no session to switch)`)
        }
        const session = agent.session
        const state = ctx.sessionProjections.stateOf(session, 'plan')
        const wanted = state?.running?.wanted ?? state?.wanted
        const active = wanted !== null ? wanted : state?.active
        if (!active) {
          throw new Error(`${EXIT_PLAN_WITH} is only available while plan mode is active`)
        }

        let compaction: 'none' | 'performed' | 'skipped' = 'none'
        if (args.mode === 'compact') {
          const engine = ctx.get('compaction') as CompactionEngine | undefined
          if (engine === undefined) {
            throw new Error(
              `${EXIT_PLAN_WITH} mode=compact requires the compaction service; configure ` +
                '@deepseek-ai/dsh-compaction-basic or use keep/execute instead',
            )
          }
          await engine.compactNow({ session, options: {} }, exec.signal)
          compaction = 'performed'
        }

        await leavePlanMode(ctx, agent)

        return { mode: args.mode, exited: true, compaction }
      },
    }),
  )
}
