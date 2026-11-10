/**
 * `omd-table-chart` — a table in a settled answer becomes an inline chart,
 * without a model call.
 *
 * At the turn boundary the host reads the turn's final assistant message, hands
 * its first Markdown table to `omd-chart-plan`, and — when the deterministic
 * path produces a plan — appends one `plugin:omd/table-chart` record anchored to
 * that message's sequence number. The record carries the whole `ChartSpec`, so
 * the client needs nothing from this process after the write: a refresh, a fork,
 * or a resume folds the same record out of the log and draws the same chart.
 *
 * Nothing here renders and nothing here is model-facing. The record is
 * `ignorable`, no tool is registered, and the answer text itself is untouched.
 * The `chart` internal path is the one read surface, for an agent or a human who
 * wants the numbers behind a picture.
 *
 * The judge path belongs to a separate slice; every record this package writes
 * says `decidedBy: { role: 'heuristic' }`.
 *
 * @module omd-table-chart
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'

import { latestChartRecord, writeChartRecord } from './record.ts'
import { registerChartSource } from './resource.ts'
import { planTableTurnChart, readSettledAnswer } from './table.ts'
import type { JudgmentService } from './types.ts'

/** Plugin id the Loader entry carries. */
export const name = 'omd-table-chart'

/** Deployment settings. */
export interface Config {
  /**
   * `judge`: ask the decision-model judge to decide chart kind, order, series, and focus.
   * `heuristic` plans a chart from the table alone at every turn boundary.
   * `off` writes nothing; records already in the log stay readable through
   * their addresses and still render.
   */
  mode: 'judge' | 'heuristic' | 'off'
  /** Fewest data rows, summary rows excluded, a table needs to be charted. */
  minRows: number
  /** Whole-call budget in milliseconds for judge decisions. */
  pickTimeoutMs: number
  /** Maximum questions one judge call may carry. */
  maxQuestions: number
  /** Longest table markdown sent to a judge, in characters. */
  maxTableChars: number
}

/** Every field carries a default so an empty patch row still works. */
export const Config: z<Config> = z.object({
  mode: z.union(['judge', 'heuristic', 'off']).default('heuristic').description(
    'judge: use decision-model judge for chart planning. heuristic: plan without model call. off: write no records.',
  ),
  minRows: z.number().step(1).min(2).default(2).description(
    'Fewest data rows, summary rows excluded, a table needs before it is charted.',
  ),
  pickTimeoutMs: z.natural().default(15000).description('Whole-call budget in milliseconds for judge decisions.'),
  maxQuestions: z.natural().default(25).description('Maximum questions per judge call.'),
  maxTableChars: z.natural().default(4000).description('Maximum table markdown length sent to judge.'),
})

/**
 * Plan and write the chart for one settled turn.
 * @param ctx - plugin context, for the logger.
 * @param session - the agent's session.
 * @param turn - the turn about to close.
 * @param minRows - row floor from the plugin config.
 */
async function chartTurn(
  ctx: Context,
  session: Session,
  turn: number,
  config: Config,
  signal?: AbortSignal,
): Promise<void> {
  const answer = readSettledAnswer(session, turn)
  if (answer === undefined) return
  // One chart per assistant message: a turn that stopped and continued leaves
  // earlier answers alone, and the newest answer is the one still on screen.
  if (latestChartRecord(session.snapshotEvents(), answer.anchorSeq) !== undefined) return

  const outcome = await planTableTurnChart(
    answer.text,
    config,
    ctx.get('judgment') as JudgmentService | undefined,
    signal,
  )
  if (outcome === undefined || outcome.outcome !== 'resolved' || outcome.spec === undefined || outcome.plan === undefined) {
    if (outcome && outcome.outcome !== 'ineligible' && outcome.outcome !== 'resolved') {
      ctx.logger.warn(
        'omd-table-chart: judge mode preserved table without chart (%s: %s; %s)',
        outcome.hint?.scenario,
        outcome.hint?.diagnosis,
        outcome.hint?.suggestedAction,
      )
    }
    return
  }

  // Re-check late record after judge settlement
  if (latestChartRecord(session.snapshotEvents(), answer.anchorSeq) !== undefined) return

  writeChartRecord(session, {
    anchorSeq: answer.anchorSeq,
    turn,
    step: answer.step,
    spec: outcome.spec,
    plan: outcome.plan,
    decidedBy: outcome.decidedBy,
    ...outcome.trace === undefined ? {} : { trace: outcome.trace },
  })
}

/**
 * Mount the turn trigger and the address reader.
 * @param ctx - plugin context carrying the internal-path registry.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // The reader is independent of the trigger: records written before `mode` was
  // turned off stay addressable, and reading one costs no model call.
  registerChartSource(ctx)

  if (config.mode === 'off') return

  const inFlight = new WeakMap<Agent, AbortController>()

  ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
    inFlight.get(agent)?.abort()
    inFlight.delete(agent)
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }: { agent: Agent; turn: number; signal?: AbortSignal }) => {
    try {
      // A worker session never charts its own output; it has no chat of its own.
      if (agent.session.header.parentSession !== undefined) return
      const controller = new AbortController()
      inFlight.set(agent, controller)
      const onSignalAbort = () => controller.abort()
      signal?.addEventListener('abort', onSignalAbort, { once: true })
      try {
        await chartTurn(ctx, agent.session, turn, config, controller.signal)
      } finally {
        signal?.removeEventListener('abort', onSignalAbort)
        inFlight.delete(agent)
      }
    } catch (error) {
      // This listener sits on the turn boundary; a decoration must never be
      // able to fail a turn that already produced its answer.
      ctx.logger.warn('omd-table-chart: could not plan the turn: %o', error)
    }
  })
}
