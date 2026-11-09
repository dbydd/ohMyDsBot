/**
 * `omd-agents-hub` — the durable roster an agent panel reads: which children
 * this session delegated to, what each was asked to do, and whether it has
 * ended.
 *
 * The panel needs no subscription of its own: the `omdAgents` projection
 * replays the parent session log, so a resumed session shows the same rows it
 * showed live. `apply` returns the same state reference for every event that
 * is not one of the three child facts, so unrelated session traffic publishes
 * nothing.
 *
 * Child-internal metrics (model, tokens, requests, tool calls, active
 * milliseconds, cost) are recorded in the child's own session log and arrive
 * as `null` here; a live adapter fills them from the child session, and this
 * projection never fabricates them.
 *
 * Named exports only: a `default` export makes the Loader discard this whole
 * namespace and every injection with it.
 *
 * @module omd-agents-hub
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { foldOmdAgents, initialOmdAgents } from './fold.ts'
import type { OmdAgentRecord, OmdAgentRoster, OmdAgentsState } from './fold.ts'
// Re-exports the projection-key merges so a consumer resolving this entry sees them.
export type * from './types.ts'

/** Plugin id the Loader entry carries. */
export const name = 'omd-agents-hub'

/** The projection registry is the package's whole purpose. */
export const inject = ['sessionProjections']

/** One roster row on the wire; identical to {@link OmdAgentRecord}. */
const rowSchema: z.ZodType<OmdAgentRecord> = z.object({
  status: z.enum(['active', 'settled', 'completed', 'failed', 'cancelled']),
  assignment: z.string().nullable(),
  model: z.string().nullable(),
  tokens: z.number().nullable(),
  requests: z.number().nullable(),
  toolCalls: z.number().nullable(),
  activeMs: z.number().nullable(),
  cost: z.number().nullable(),
  parentId: z.string().nullable(),
  isolation: z.enum(['in-process', 'external']).nullable(),
}).strict()

/** The wire view: the roster itself, with no reshaping to keep `Object.is` meaningful. */
const rosterSchema: z.ZodType<OmdAgentRoster> = z.record(z.string(), rowSchema)

/** Host fold state schema; what the projection cache persists. */
const stateSchema: z.ZodType<OmdAgentsState> = z.object({
  inheritedEventCount: z.number().int().nonnegative(),
  agents: rosterSchema,
  workflowMembers: z.record(z.string(), z.string()),
}).strict()

/** The `omdAgents` unit: a pure fold over the parent's own subagent facts. */
export const omdAgentsProjectionDefinition = {
  key: 'omdAgents',
  stateVersion: 1,
  stateSchema,
  init: (_header, inheritedEventCount) => initialOmdAgents(inheritedEventCount),
  apply: (state, event) => foldOmdAgents(state, event),
  wire: { viewSchema: rosterSchema, view: state => state.agents },
} satisfies ProjectionDefinition<'omdAgents', OmdAgentsState>

/**
 * Register the `omdAgents` unit; without the registry the fiber stays pending.
 * @param ctx - registrant context carrying the projection registry.
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register<'omdAgents', OmdAgentsState>(omdAgentsProjectionDefinition)
}
