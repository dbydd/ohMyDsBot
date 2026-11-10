/**
 * omd-chart-plan — a Markdown table read into a chart plan, with no I/O.
 *
 * `analyzeTable` parses a table and reads its cells, columns and summary rows;
 * `planChart` applies the capability gates and then the kind cascade, first
 * match wins; `buildSpec` turns the plan into the categories and values a
 * renderer draws. The judge half is pure too: `buildChartQuestions` offers the
 * decisions only meaning can make, and `mergeChartAnswers` puts the answers
 * back at their own gates, keeping the heuristic's value wherever an answer is
 * missing, hesitant or outranked by a fact the values prove.
 *
 * Pure functions only: no `ctx`, no service, no tool registration, no record
 * write, no client code, no model call. A caller hands in a table and gets back
 * a plan or `null`; it hands the plan and the judge's answers back and gets the
 * merged plan plus the audit of what the judge changed.
 *
 * What a table may say is deliberately narrow — the supported spellings and the
 * unsupported ones are listed in this package's `README.md`.
 *
 * @module omd-chart-plan
 */

export { analyzeTable } from './analyze.ts'
export { applyChartAnswers, buildChartQuestions, buildChartState, mergeChartAnswers } from './judge.ts'
export { buildSpec, DEFAULT_CONFIG, planChart, shouldJudge, worthCharting } from './plan.ts'
export type {
  Cell,
  CellFit,
  ChartAnswer,
  ChartAnswers,
  ChartHint,
  ChartKind,
  ChartOrder,
  ChartPlan,
  ChartQuestion,
  ChartQuestionKind,
  ChartState,
  ChartStateColumn,
  ChartSeries,
  ChartSpec,
  ColumnRole,
  Composition,
  Config,
  Dimension,
  MergeReason,
  MergeResult,
  MergeTrace,
  MergeTraceEntry,
  NumberCell,
  OtherCell,
  PolaritySide,
  TableAnalysis,
  TableColumn,
} from './types.ts'
