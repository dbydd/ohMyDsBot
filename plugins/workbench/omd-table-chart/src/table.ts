/**
 * Reading the settled answer of one turn and planning the chart its table
 * deserves.
 *
 * The host half decides nothing about kind selection: it hands the answer text
 * to `omd-chart-plan`, and writes a record only when the deterministic path
 * returns a plan. A table whose cells cannot be read stays a table.
 *
 * @module omd-table-chart/table
 */

import type { Session } from '@deepseek-ai/dsh-session'

import {
  analyzeTable,
  buildSpec,
  buildChartQuestions,
  buildChartState,
  DEFAULT_CONFIG,
  mergeChartAnswers,
  planChart,
  shouldJudge,
} from 'omd-chart-plan'
import type { ChartHint, ChartPlan, ChartSpec, MergeTrace } from 'omd-chart-plan/types'
import type { ChartDecision, ChoiceQuestion, JudgmentResult, JudgmentService } from './types.ts'

/** The last assistant message of one turn, as the chart anchor. */
export interface SettledAnswer {
  /** Log sequence of that message; the chart hangs under it. */
  readonly anchorSeq: number
  /** Step within the turn. */
  readonly step: number
  /** Concatenated text blocks. */
  readonly text: string
}

/** Concatenated text blocks of one message, or `''`. */
function textOf(message: { readonly content?: readonly unknown } | undefined): string {
  if (message === undefined || !Array.isArray(message.content)) return ''
  const parts: string[] = []
  for (const block of message.content) {
    if (typeof block !== 'object' || block === null) continue
    const { type, text } = block as { type?: unknown; text?: unknown }
    if (type === 'text' && typeof text === 'string') parts.push(text)
  }
  return parts.join('\n').trim()
}

/**
 * The turn's final assistant message that carries text.
 * @param session - the agent's session.
 * @param turn - the turn about to close.
 * @returns the anchor and text, or undefined when the turn said nothing.
 */
export function readSettledAnswer(session: Session, turn: number): SettledAnswer | undefined {
  const events = session.snapshotEvents()
  let settled: SettledAnswer | undefined
  for (const event of events) {
    if (event.type !== 'assistant/message' || event.data.turn !== turn) continue
    const text = textOf(event.data.message)
    if (text !== '') settled = { anchorSeq: event.seq, step: event.data.step, text }
  }
  return settled
}

/** Options driving turn chart planning. */
export interface PlanOptions {
  readonly mode: 'judge' | 'heuristic' | 'off'
  readonly minRows: number
  readonly pickTimeoutMs: number
  readonly maxQuestions: number
  readonly maxTableChars: number
}

/** Outcome of planning a turn's chart. */
export interface JudgedChartOutcome {
  readonly outcome: 'resolved' | 'unavailable' | 'failed' | 'unresolved' | 'ineligible'
  readonly plan?: ChartPlan
  readonly spec?: ChartSpec
  readonly decidedBy?: ChartDecision
  readonly trace?: MergeTrace
  readonly hint?: ChartHint
  readonly error?: unknown
}

/**
 * Plan the chart for a turn, asking a judge when configured or falling back to heuristics.
 */
export async function planTableTurnChart(
  text: string,
  options: PlanOptions,
  judgment: JudgmentService | undefined,
  signal?: AbortSignal,
): Promise<JudgedChartOutcome | undefined> {
  const analysis = analyzeTable(text)
  if (analysis === undefined) return undefined
  const plan = planChart(analysis, { ...DEFAULT_CONFIG, minRows: options.minRows })
  if (plan === null) return undefined

  if (options.mode === 'heuristic') {
    const spec = buildSpec(analysis, plan)
    if (spec === undefined || spec.categories.length === 0 || spec.series.length === 0) return undefined
    return {
      outcome: 'resolved',
      plan,
      spec,
      decidedBy: { role: 'heuristic' },
    }
  }

  if (options.mode === 'judge') {
    // Small/ineligible table skips judge:
    if (!shouldJudge(analysis, plan)) {
      const spec = buildSpec(analysis, plan)
      if (spec === undefined || spec.categories.length === 0 || spec.series.length === 0) return undefined
      return {
        outcome: 'resolved',
        plan,
        spec,
        decidedBy: { role: 'heuristic' },
      }
    }

    // Qualifying table: must go through judge
    if (judgment === undefined || !judgment.available()) {
      return {
        outcome: 'unavailable',
        hint: {
          scenario: 'unavailable_judge',
          diagnosis: 'Judgment service ctx.judgment is unavailable or uncredentialed in judge mode',
          suggestedAction: 'Mount and configure omd-judgment with candidates, or switch omd-table-chart mode to heuristic',
        },
      }
    }

    const chartConfig = {
      ...DEFAULT_CONFIG,
      minRows: options.minRows,
      pickTimeoutMs: options.pickTimeoutMs,
      maxQuestions: options.maxQuestions,
      maxTableChars: options.maxTableChars,
    }

    const state = buildChartState(text, analysis, chartConfig)
    const questions = buildChartQuestions(analysis, plan, chartConfig)
    const judgeQuestions: Record<string, ChoiceQuestion> = {}
    for (const q of questions) {
      judgeQuestions[q.id] = {
        type: 'choice',
        instructions: q.prompt,
        criteria: q.options,
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.pickTimeoutMs)
    const forwardAbort = () => controller.abort()
    signal?.addEventListener('abort', forwardAbort, { once: true })

    let result: JudgmentResult
    try {
      result = await judgment.judge({ state, questions: judgeQuestions }, { signal: controller.signal })
    } catch (error) {
      return {
        outcome: 'failed',
        error,
        hint: {
          scenario: 'judge_call_failed',
          diagnosis: `Judge call failed or timed out: ${error instanceof Error ? error.message : String(error)}`,
          suggestedAction: 'Check judgment candidate endpoint responsiveness or increase pickTimeoutMs',
        },
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }

    if (signal?.aborted) return undefined

    const answers: Record<string, { choice: string; confidence: number }> = {}
    for (const [id, ans] of Object.entries(result.answers)) {
      if (ans && ans.type === 'choice' && typeof ans.choice === 'string') {
        answers[id] = { choice: ans.choice, confidence: ans.confidence ?? 0 }
      }
    }

    const merged = mergeChartAnswers(plan, analysis, answers, chartConfig)
    if (merged.unresolved) {
      return {
        outcome: 'unresolved',
        hint: merged.hint,
        trace: merged.trace,
      }
    }

    const spec = buildSpec(analysis, merged.plan)
    if (spec === undefined || spec.categories.length === 0 || spec.series.length === 0) return undefined

    return {
      outcome: 'resolved',
      plan: merged.plan,
      spec,
      decidedBy: {
        role: 'judge',
        provider: result.provider,
        model: result.model,
        api: result.api,
      },
      trace: merged.trace,
    }
  }

  return undefined
}

/**
 * Plan the chart for the first table in `text`.
 * @param text - the settled answer.
 * @param minRows - fewest data rows the table must keep, from the plugin config.
 * @returns the plan and its spec, or undefined when the table is better left as a table.
 */
export function planTableChart(
  text: string,
  minRows: number,
): { readonly plan: ChartPlan; readonly spec: ChartSpec } | undefined {
  const analysis = analyzeTable(text)
  if (analysis === undefined) return undefined
  const plan = planChart(analysis, { ...DEFAULT_CONFIG, minRows })
  if (plan === null) return undefined
  const spec = buildSpec(analysis, plan)
  if (spec === undefined || spec.categories.length === 0 || spec.series.length === 0) return undefined
  return { plan, spec }
}
