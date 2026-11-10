/**
 * `omd-agents-live` — the live half of the agent panel.
 *
 * `dsh-resource://agents/<sessionId>` answers one JSON document with the
 * session's direct children and its background jobs, each with what it is
 * doing now and for how long. It is a read-only view: it appends no session
 * event, contributes no prompt section, and registers no tool.
 *
 * The durable roster stays `omd-agents-hub`'s `omdAgents` projection. This
 * package discovers children from the parent's own `subagent/catalog` rows,
 * reads a child's live facts from its own session log, and takes only the
 * terminal status word from that roster. A child whose session is gone keeps
 * its row with the durable status and `null` live facts for `settledAgentGraceMs`
 * — never a ghost `running` row — and then leaves the document entirely.
 * Finished children are never listed as history: see the README.
 *
 * Following: the source declares `live: true`. The web half of
 * `omd-internal-paths` owns the follow interval (`livePollMs`, default 1500);
 * this package cannot set it per source.
 *
 * @module omd-agents-live
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { AgentsLiveTracker } from './tracker.ts'
import type { InternalPathRegistry, SessionStoreFace } from './types.ts'

export type * from './types.ts'
export { extractMetrics } from './metrics.ts'
export { AgentsLiveTracker } from './tracker.ts'
export type { TrackerOptions } from './tracker.ts'

/** Plugin id the Loader entry carries. */
export const name = 'omd-agents-live'

/** The source is optional: without the registry the package simply never appears. */
export const inject: string[] = []

/** Plugin configuration. */
export interface Config {
  /**
   * How long a settled background job stays in the ticker once its turn is
   * over, in milliseconds. While a turn is open, a job that settled inside it
   * stays until that turn ends; between turns, this window keeps "just
   * finished" visible without accumulating old rows. `0` hides settled jobs
   * as soon as no turn is open.
   */
  settledJobGraceMs: number
  /**
   * How long a child that reached a terminal status stays in the ticker, in
   * milliseconds. Counted from the child's own last event, so a read that
   * arrives late — or a session reopened after a restart — expires an
   * already-finished child at once. `0` drops it as soon as it settles.
   */
  settledAgentGraceMs: number
  /**
   * Longest `activity.label` the tracker emits, in UTF-16 code units — the same
   * unit as `String.prototype.length`, so a character outside the BMP (an
   * emoji, for example) counts as two. A clipped label ends in `…`, which
   * occupies one of the characters. Values below 1 are rejected. Default 80.
   */
  activityMaxChars: number
}

/** Every field is machine-independent: no endpoint, path, or credential. */
export const Config: z<Config> = z.object({
  settledJobGraceMs: z.number().step(1).min(0).default(8000)
    .description('How long a settled background job stays visible after its turn ends, in milliseconds.'),
  settledAgentGraceMs: z.number().step(1).min(0).default(30000)
    .description('How long a subagent that reached a terminal status stays visible, in milliseconds.'),
  activityMaxChars: z.number().step(1).min(1).default(80)
    .description('Longest activity label, in UTF-16 code units, including the trailing ellipsis when clipped.'),
})

/** The address this source accepts. */
const GRAMMAR = 'dsh-resource://agents/<sessionId> — one JSON document with the session\'s subagents and background jobs'

/**
 * Register the live source for the plugin's lifetime.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['internalPaths'], (scope) => {
    const registry = scope.get('internalPaths') as InternalPathRegistry | undefined
    if (registry === undefined) return
    const tracker = new AgentsLiveTracker(scope, {
      settledJobGraceMs: config.settledJobGraceMs,
      settledAgentGraceMs: config.settledAgentGraceMs,
      activityMaxChars: config.activityMaxChars,
    })
    scope.effect(() => () => tracker.dispose(), 'omd-agents-live: live feeds')
    scope.effect(() => registry.register('agents', {
      grammar: GRAMMAR,
      description: 'Live view of one running session: active subagents, background jobs, and their latest activity.',
      shorthand: false,
      live: true,
      read: async (path: string) => {
        const address = `dsh-resource://agents/${path}`
        const sessionId = path.trim().replace(/^\/+/u, '')
        if (sessionId === '' || sessionId.includes('/')) {
          throw new Error(`cannot read "${address}": expected ${GRAMMAR}`)
        }
        const sessions = scope.get('sessions') as SessionStoreFace | undefined
        const session = sessions?.get(SessionId(sessionId))
        if (session === undefined) {
          throw new Error(`cannot read "${address}": no live session ${JSON.stringify(sessionId)} — open that session first`)
        }
        return JSON.stringify(tracker.snapshot(session), null, 2)
      },
    }), 'omd-agents-live: dsh-resource://agents')
  })
}
