/**
 * Vocabulary of the table-to-chart planner: what a cell reads as, what role a
 * column plays, the plan the heuristic produces, and the spec a renderer draws.
 *
 * Values are plain JSON. The plan carries column indices, the spec carries the
 * values a renderer needs, and every field the judge will later override is
 * already declared here with a heuristic default so the two paths share one
 * object shape.
 *
 * @module omd-chart-plan/types
 */

/** What a number measures; cells of one dimension share an axis after unit normalization. */
export type Dimension = 'count' | 'percent' | 'duration' | 'bytes' | 'currency'

/**
 * How a cell was written: bare (`12 ms`), with one note (`17 (21.5%)`), a range
 * (`24–72 h`), a transition (`12 → 15`), or a score (`154/160`).
 */
export type CellFit = 'pure' | 'note' | 'range' | 'arrow' | 'fraction'

/** A cell that reads as a quantity, in base units (milliseconds, bytes, percent points). */
export interface NumberCell {
  /** Discriminator. */
  readonly kind: 'number'
  /** Value in base units of {@link dim}. */
  readonly value: number
  /** What the value measures. */
  readonly dim: Dimension
  /** Unit or symbol as written (`ms`, `MiB`, `%`, `$`); empty when the cell was written bare. */
  readonly unit: string
  /** How the cell was written. */
  readonly fit: CellFit
  /** Written as an estimate (`~`, `≈`) or a bound (`<`, `≥`). */
  readonly approx: boolean
  /** Written with an explicit bound (`<`, `≤`, `>`, `≥`), the mark of a target column. */
  readonly bound: boolean
  /** Written with an explicit sign (`+12`, `-3`). */
  readonly signed: boolean
  /** Wrapped in bold or emphasis: the writer pointed at this value. */
  readonly emphasis: boolean
  /** The cell text without Markdown decoration. */
  readonly text: string
  /** `a → b`: `b`, in base units. A column of these is read but not charted. */
  readonly to?: number
  /** `a–b`: `b`, in base units. */
  readonly upper?: number
  /** `a/b`: `b`, the total the score is out of. */
  readonly denominator?: number
}

/** A cell that is not a quantity. */
export interface OtherCell {
  /** Discriminator: blank or dash, an ISO date, a `#123` identifier, or a word. */
  readonly kind: 'missing' | 'date' | 'id' | 'text'
  /** The cell text without Markdown decoration. */
  readonly text: string
  /** Wrapped in bold or emphasis. */
  readonly emphasis: boolean
}

/** One parsed cell. */
export type Cell = NumberCell | OtherCell

/**
 * What a column contributes: `measure` values to plot, `label` names for the
 * rows, `temporal` dates, `sequence` an ordered step (`Run`, `Pass`), `index` a
 * row number or identifier never plotted.
 */
export type ColumnRole = 'measure' | 'label' | 'temporal' | 'sequence' | 'index'

/** One column of an analysed table. */
export interface TableColumn {
  /** Position in the table, left to right from zero. */
  readonly index: number
  /** Header text without Markdown decoration. */
  readonly header: string
  /** What the column is for. */
  readonly role: ColumnRole
  /** One cell per table row, summary rows included. */
  readonly cells: readonly Cell[]
  /** Dominant dimension of the numeric cells; absent when there is none. */
  readonly dim: Dimension | undefined
  /** Representative unit or symbol of the dominant dimension; empty when bare. */
  readonly unit: string
  /** Numeric cells disagree on dimension: a metric-per-row table, not one axis. */
  readonly mixed: boolean
  /** Numeric cells are scores (`154/160`), read as the percent of the total they reached. */
  readonly scores: boolean
  /** Every data-row value is the same: an echoed setting, never a measure. */
  readonly constant: boolean
  /** Share of numeric cells written with an explicit sign. */
  readonly signedShare: number
  /** Share of numeric cells written as `a → b`. */
  readonly arrowShare: number
  /** Index of the measure column this one copies proportionally, read from the values. */
  readonly restates?: number
}

/** Measure columns that add up, read from the values: `parts` sum to `whole` in every data row. */
export interface Composition {
  /** Column the parts make up. */
  readonly whole: number
  /** Part columns, in table order. */
  readonly parts: readonly number[]
}

/** A table read for charting. */
export interface TableAnalysis {
  /** Every column, in table order. */
  readonly columns: readonly TableColumn[]
  /** The column naming the rows, when one was found. */
  readonly label: TableColumn | undefined
  /** Plottable measure columns: varying, not restating another column, not an index. */
  readonly measures: readonly TableColumn[]
  /** Data-row indices, in table order, with summary rows removed. */
  readonly rows: readonly number[]
  /** Summary-row indices (`Total`, `Average`), removed from {@link rows}. */
  readonly totals: readonly number[]
  /** The exact sum relation between measures, when the values show one. */
  readonly composition: Composition | undefined
}

/** The eight chart kinds this package plans. */
export type ChartKind = 'bar' | 'grouped' | 'stacked' | 'paired' | 'line' | 'heatmap' | 'multiples' | 'progress'

/** Row order along the x axis: the table's own order (`null`), or an axis the label column states. */
export type ChartOrder = 'ascending' | 'descending' | 'numeric' | null

/** Which direction of a series is the better result. */
export type PolaritySide = 'higher' | 'lower'

/**
 * What to draw, decided from the table alone.
 *
 * The judge will overwrite `title`, `focus`, `polarity`, `rivals`, `order` and
 * the series selection when it is configured; `kind` stays subject to the
 * structural facts this plan rests on.
 */
export interface ChartPlan {
  /** Which chart to draw. */
  readonly kind: ChartKind
  /** Index of the column naming the categories. */
  readonly label?: number
  /** Indices of the columns drawn, in table order. */
  readonly series: readonly number[]
  /** For a stacked chart: the column the series add up to. */
  readonly whole?: number
  /** Row order; `null` keeps the table's order. */
  readonly order: ChartOrder
  /** Row indices to emphasize. */
  readonly focus: readonly number[]
  /** Polarity per column index, where the header or the dimension states one. */
  readonly polarity?: Readonly<Record<number, PolaritySide>>
  /** What the rows compete with: each other (`columns`) or the columns (`rows`). */
  readonly rivals?: 'columns' | 'rows'
  /** Chart title; only the judge writes one. */
  readonly title?: string
}

/** One drawn series: the column it came from and its value per category. */
export interface ChartSeries {
  /** Column index in {@link TableAnalysis.columns}. */
  readonly column: number
  /** Header text, used as the series name. */
  readonly header: string
  /** Dimension all values share. */
  readonly dim: Dimension
  /** One entry per category, `null` where the cell held no plain value. */
  readonly values: readonly (number | null)[]
}

/** Everything a renderer needs, with no reference to the table. */
export interface ChartSpec {
  /** Which chart to draw. */
  readonly kind: ChartKind
  /** Category names, in drawing order. */
  readonly categories: readonly string[]
  /** Series to draw, in table order. */
  readonly series: readonly ChartSeries[]
  /** For a stacked chart: the column the series add up to. */
  readonly whole?: ChartSeries
  /** Row order along the x axis. */
  readonly order: ChartOrder
  /** Category indices to emphasize. */
  readonly focus: readonly number[]
  /** Polarity keyed by series header, the side that is the better result. */
  readonly polarity: Readonly<Record<string, PolaritySide>>
  /** What the categories compete with. */
  readonly rivals?: 'columns' | 'rows'
  /** Chart title; absent unless a judge supplied one. */
  readonly title?: string
}

/**
 * Settings the profile and the project panel own.
 *
 * The heuristic reads `minRows`; the judge path reads `maxQuestions` and
 * `maxTableChars`; `minConfidence` is the gate a question falls back to when it
 * states none of its own (each of the seven states one today). `mode` and
 * `pickTimeoutMs` belong to the caller that asks the judge.
 */
export interface Config {
  /** Whether charts are planned at all: `off` writes nothing, `heuristic` never asks a judge, `judge` does. */
  readonly mode: 'off' | 'heuristic' | 'judge'
  /** Gate a judge question falls back to when it states none of its own. */
  readonly minConfidence: number
  /** Deadline for one judge round trip, in milliseconds. */
  readonly pickTimeoutMs: number
  /** Longest table markdown sent to a judge, in characters. */
  readonly maxTableChars: number
  /** Most questions one judge round trip may carry. */
  readonly maxQuestions: number
  /** Fewest data rows, summary rows excluded, a table needs to be charted. */
  readonly minRows: number
}

/** Which decision a judge question asks. */
export type ChartQuestionKind = 'kind' | 'order' | 'polarity' | 'rivals' | 'focus' | 'title' | 'column'

/**
 * One question about a table: the options, the value the heuristic already
 * put in the plan, and the probability an answer needs to replace it.
 */
export interface ChartQuestion {
  /** Stable id the caller keys its answers by: `kind`, `order`, `c2`, `p3`, `rivals`, `focus`, `title`. */
  readonly id: string
  /** Which decision the question asks. */
  readonly kind: ChartQuestionKind
  /** The prompt, with the concrete column or row already named. */
  readonly prompt: string
  /**
   * Options by value: the option's meaning, or `null` where the value names
   * itself (a row's name, a fact's key).
   */
  readonly options: Readonly<Record<string, string | null>>
  /** The option the heuristic chose; an answer that misses its gate leaves this in place. */
  readonly fallback: string
  /** Lowest probability an answer needs to replace {@link fallback}. */
  readonly threshold: number
  /**
   * Gate for options where it differs from {@link threshold}: a fact the table
   * already states, or a row it already singles out.
   */
  readonly optionThresholds?: Readonly<Record<string, number>>
  /** 0 for a structural question that is always asked, then the semantic priority: title, rivals, polarity, focus. */
  readonly priority: number
}

/** One judge answer: the chosen option and the probability the judge gave it. */
export interface ChartAnswer {
  /** One of the question's option values. */
  readonly choice: string
  /** Probability of {@link choice}, from zero to one. */
  readonly confidence: number
}

/** Answers keyed by {@link ChartQuestion.id}. */
export type ChartAnswers = Readonly<Record<string, ChartAnswer>>

/** One column as a judge reads it: its header and its inferred type. */
export interface ChartStateColumn {
  /** Header text without Markdown decoration. */
  readonly name: string
  /** `number (duration)`, `number (score out of a total)`, `text`, `ordered step`, `row index`, `date/time`. */
  readonly type: string
}

/**
 * What a judge is shown: the Markdown table itself, cut to the configured
 * length, and each column's inferred type. Not the conversation.
 */
export interface ChartState {
  /** The table's Markdown, at most `maxTableChars` characters. */
  readonly table: string
  /** Every column, in table order. */
  readonly columns: readonly ChartStateColumn[]
}

/** What became of one answer. */
export type MergeReason =
  /** The answer was a listed option at its gate, and the plan carries it. */
  | 'adopted'
  /** The judge did not answer this question. */
  | 'missing'
  /** The answer names a question this table was not asked. */
  | 'unknown-question'
  /** The answer names an option the question did not offer. */
  | 'unknown-option'
  /** The answer's probability is under the question's gate. */
  | 'below-threshold'
  /** The answer was valid, but the column it is about is not drawn, so nothing shows it. */
  | 'not-plotted'
  /** A structural fact the values prove — an exact sum relation — outranks the answer. */
  | 'structural-override'
  /** The chosen columns cannot draw the picked kind, so the heuristic's kind stands. */
  | 'not-drawable'

/** One answer as the merge saw it: what was asked, what came back, what the plan kept. */
export interface MergeTraceEntry {
  /** The question's id, or the unknown id an answer named. */
  readonly id: string
  /** Which decision the question asked; absent for an id no question carried. */
  readonly kind?: ChartQuestionKind
  /** The option the answer named; absent when the judge did not answer. */
  readonly answer?: string
  /** The probability the answer gave its option; absent when the judge did not answer. */
  readonly confidence?: number
  /** The gate the answer had to beat. */
  readonly threshold: number
  /** Whether the merged plan carries the answer. */
  readonly adopted: boolean
  /** Why it does or does not. */
  readonly reason: MergeReason
  /** The heuristic's option, for comparison in a log. */
  readonly before?: string
  /** The option or value the merged plan carries. */
  readonly after?: string
}

/** The audit of one merge: every question's verdict, and the two id lists a log line needs. */
export interface MergeTrace {
  /** One entry per question, in the order asked, then one per unknown answer. */
  readonly entries: readonly MergeTraceEntry[]
  /** Ids whose answer the merged plan keeps. */
  readonly adopted: readonly string[]
  /** Ids whose answer was ignored; each entry carries the reason. */
  readonly ignored: readonly string[]
}

/** Diagnostic hint aligned with Hindsight's hint pattern for unresolved decisions. */
export interface ChartHint {
  /** Machine-readable scenario identifier. */
  readonly scenario: string
  /** Human-readable explanation of why the decision could not resolve cleanly. */
  readonly diagnosis: string
  /** Concrete next action or input that would resolve ambiguity. */
  readonly suggestedAction: string
}

/** A merged plan with its audit and unresolved status. */
export interface MergeResult {
  readonly plan: ChartPlan
  readonly trace: MergeTrace
  readonly unresolved?: boolean
  readonly hint?: ChartHint
}
