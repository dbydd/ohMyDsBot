/**
 * Data shapes of `omd-table-chart`: the `plugin:omd/table-chart` session
 * record, plus the one host service face this package reaches.
 *
 * The record carries the whole `ChartSpec`, so a client that folds the log
 * needs nothing from the host and a resumed or forked session redraws the same
 * picture. `plan` is kept beside it as the compact summary a reader shows: the
 * column indices the heuristic chose, before they became series values.
 *
 * @module omd-table-chart/types
 */

import type { ChartPlan, ChartSpec, MergeTrace } from 'omd-chart-plan/types'

/** Heuristic decision marker. */
export interface ChartHeuristicDecision {
  readonly role: 'heuristic'
}

/** Judge decision marker with provider and model provenance. */
export interface ChartJudgeDecision {
  readonly role: 'judge'
  readonly provider: string
  readonly model: string
  readonly api?: string
}

/** Who decided the chart plan. */
export type ChartDecision = ChartHeuristicDecision | ChartJudgeDecision

/** Question specification passed to ctx.judgment. */
export interface ChoiceQuestion<Label extends string = string> {
  type: 'choice'
  instructions: string
  criteria: Record<Label, string | null>
}

/** Judgment result from ctx.judgment. */
export interface JudgmentResult {
  api: string
  provider: string
  model: string
  answers: Record<string, { type: string; choice?: string; confidence?: number; [key: string]: unknown }>
  usage?: { inputTokens: number; outputTokens: number }
}

/** Minimal face of ctx.judgment. */
export interface JudgmentService {
  available(): boolean
  label(): string
  judge(
    request: { state: unknown; questions: Record<string, ChoiceQuestion> },
    options?: { signal?: AbortSignal },
  ): Promise<JudgmentResult>
}

/** One chart written for one assistant message. */
export interface ChartRecordPayload {
  /** Session holding the decorated answer. */
  readonly sessionId: string
  /** Log sequence of the assistant message the chart hangs under. */
  readonly anchorSeq: number
  /** Turn that produced the answer; also gives the chart its chat location. */
  readonly turn: number
  /** Step within the turn. */
  readonly step: number
  /** Renderer family; one string so a later chart source can share the card. */
  readonly component: 'table-chart'
  /** Everything the renderer draws. */
  readonly spec: ChartSpec
  /** The plan the spec came from: column indices, order, focus, polarity. */
  readonly plan: ChartPlan
  /** Who chose the plan. */
  readonly decidedBy: ChartDecision
  /** Trace of decisions and threshold gates when planned by a judge. */
  readonly trace?: MergeTrace
  /** Epoch milliseconds when the record was written. */
  readonly createdAt: number
}

/** The part of `ctx.internalPaths` this plugin registers into. */
export interface InternalPathFace {
  register(source: string, provider: {
    readonly grammar: string
    readonly shorthand?: boolean
    readonly live?: boolean
    read(path: string, exec: unknown): Promise<string | Uint8Array>
  }): () => void
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /**
     * One chart derived from the table of one assistant message.
     *
     * `ignorable`, so no reader is required to understand it; the web client
     * folds it by `anchorSeq` and draws it, and a reader that does not know the
     * type retains and skips it. One record per assistant message.
     */
    'plugin:omd/table-chart': ChartRecordPayload
  }
}
