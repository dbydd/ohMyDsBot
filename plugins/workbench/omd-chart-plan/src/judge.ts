/**
 * The judge half of the table-to-chart planner: the questions only meaning can
 * answer, and the merge that lets a confident answer replace the heuristic's
 * field.
 *
 * {@link buildChartQuestions} offers seven decisions — the chart kind, the row
 * order, which columns to plot, what the rows compete with, which side of each
 * plotted measure is better, which row the table is about, and what titles the
 * chart — each with its options, the heuristic's own value as the fallback, and
 * the probability gate that value must beat. The wording, the gate values and
 * the semantic priority come from oh-my-pi's judge prompt set
 * (`packages/coding-agent/src/prompts/judge/auto-graph.json`, MIT), trimmed to
 * the eight kinds this package draws; see the repository `NOTICE.md`.
 *
 * {@link mergeChartAnswers} puts the answers back. Each answer at its gate
 * replaces its field; a missing answer, an option the question did not offer,
 * or a probability under the gate leaves the heuristic's value. The structural
 * facts this package read from the cells still win: an exact sum relation keeps
 * the chart stacked whatever kind was picked, and a kind the chosen columns
 * cannot draw falls back to the heuristic's.
 *
 * {@link buildChartState} is the judge's whole input: the table's Markdown cut
 * to `maxTableChars`, plus each column's inferred type — never the conversation.
 *
 * Pure functions only: no `ctx`, no model call, no timeout, no I/O. The caller
 * runs the judge at its own deadline and writes the record.
 *
 * @module omd-chart-plan/judge
 */

import { DEFAULT_CONFIG } from './plan.ts'
import type {
  ChartAnswers,
  ChartHint,
  ChartKind,
  ChartOrder,
  ChartPlan,
  ChartQuestion,
  ChartState,
  Config,
  Dimension,
  MergeReason,
  MergeResult,
  MergeTrace,
  MergeTraceEntry,
  NumberCell,
  PolaritySide,
  TableAnalysis,
  TableColumn,
} from './types.ts'

/**
 * Gate for row ordering (0.6).
 * Reasoning: Reordering table rows alters the reading flow. If the judge's confidence
 * is below 0.6, retaining the author's original row order prevents arbitrary or disorienting reshuffles.
 */
const ORDER_CONFIDENCE = 0.6

/**
 * Gate for measure polarity (0.7).
 * Reasoning: Polarity controls color semantics (green vs red/muted). Mislabeled polarity
 * inverts good/bad indicators. A high threshold of 0.7 ensures only clear optimization directions are adopted.
 */
const POLARITY_CONFIDENCE = 0.7

/**
 * Gate for competitor axis (0.7).
 * Reasoning: Determines whether best-in-class badges highlight row champions or column champions.
 * Requires 0.7 confidence to prevent spurious badges on non-competitive categories.
 */
const RIVALS_CONFIDENCE = 0.7

/**
 * Gate for focus row when unformatted in the source table (0.75).
 * Reasoning: Singling out an unformatted row as 'recommended' risks fabricating an author endorsement.
 * Requires strong confidence (0.75) to stand out.
 */
const FOCUS_CONFIDENCE = 0.75

/**
 * Gate for focus row when already formatted (bold, `(current)`, checkmarks) (0.4).
 * Reasoning: The table author already marked this row in markdown. The judge only needs to confirm
 * author intent, so a low threshold (0.4) is sufficient.
 */
const AGREED_FOCUS_CONFIDENCE = 0.4

/**
 * Gate for whole-table summary title (0.4).
 * Reasoning: A headline asserting a trend across all rows (e.g. rising latency) summarizes the entire
 * table at a glance and adds value even at moderate confidence (0.4).
 */
const TITLE_CONFIDENCE = 0.4

/**
 * Gate for single-value fact title (0.75).
 * Reasoning: A headline that merely repeats a single cell's value (top/low) adds visual noise unless
 * it is unambiguously the headline finding (0.75).
 */
const PLAIN_TITLE_CONFIDENCE = 0.75

/**
 * Gate for plotting candidate columns (0.5).
 * Reasoning: Standard binary threshold (0.5) for including or omitting an optional metric column.
 */
const COLUMN_CONFIDENCE = 0.5

/** Fewest rows a ranking can reorder usefully. */
const MIN_RANKED_ROWS = 4

/** Fewest rows for which a focus or a contest changes the chart. */
const MIN_CONTEST_ROWS = 3

/** Most rows offered as the table's focus. */
const MAX_FOCUS_ROWS = 12

/** Most measures asked for their polarity. */
const MAX_POLARITY_QUESTIONS = 6

/** Fewest rows a line joins: three points draw a bend, not a trend. */
const MIN_LINE_ROWS = 4

/** Fewest same-unit columns a heatmap needs. */
const HEATMAP_SERIES = 4

/** Fewest rows for which a run through every row is a statement about the table. */
const MIN_TREND_ROWS = 3

/** The two answers a plot-or-not question has. */
const YES = 'yes'
const NO = 'no'

/** The answer naming no row and no title. */
const NONE = 'none'

/** The answer keeping the table's own row order. */
const TABLE = 'table'

/** Dimensions that are amounts, not rates or ratios: columns that can stack. */
const ADDITIVE: ReadonlySet<Dimension> = new Set(['count', 'percent', 'duration', 'bytes', 'currency'])

/** The kind question's options, in the order they are offered. */
const KIND_ORDER: readonly ChartKind[] = [
  'bar',
  'paired',
  'grouped',
  'stacked',
  'line',
  'heatmap',
  'multiples',
  'progress',
]

/** What each kind is for, as the judge reads it. */
const KIND_OPTIONS: Readonly<Record<ChartKind, string>> = {
  bar: 'One numeric measure compared across categories: use when the table compares a single key metric across independent items without sub-components or conditions.',
  paired:
    'One quantity under two conditions per category, drawn as a dumbbell: use for before/after, baseline vs. variant, or old vs. new comparisons where the shift between two states is the primary story.',
  grouped:
    'Two to four same-unit measures per category, side by side: use when comparing distinct non-additive metrics sharing the same scale across categories, giving each metric equal visual weight.',
  stacked:
    'Columns that are parts of one whole per category: use when values are non-negative additive components (such as token counts: prompt + completion = total, or error severity breakdown) summing into an aggregate whole.',
  line: 'Values over an ordered progression: use strictly when the x-axis represents an ordered progression (time, releases, benchmark iterations, or pipeline steps) where the trajectory matters.',
  heatmap: 'A two-dimensional matrix of same-unit values: use when the distribution or pattern across a grid of rows and columns reveals density, correlations, or anomalies.',
  multiples:
    'Measures in different units or distinct dimensions: use when the table presents heterogeneous metrics (e.g. latency in ms, pass rate in %, cost in $) that each require an independent scale.',
  progress: 'Completion rates or bounded scores out of a total (e.g. 154/160 or 95%): use when the key visual message is progress toward 100% completion or maximum score.',
}

const ORDER_OPTIONS: Readonly<Record<string, string>> = {
  [TABLE]: "Keep the table's original row order: rows follow an intentional logical sequence (such as time, execution steps, a pipeline, or a baseline row deliberately placed first), or the table is already meaningfully sorted.",
  descending: 'Rank independent items largest first: rows are independent competing alternatives with no intrinsic order, and sorting by the primary measure from highest to lowest highlights top-ranking performers.',
  ascending: 'Rank independent items smallest first: rows are independent competing alternatives where lower values represent superior performance (e.g. lower latency, lower execution time, lower error rate, lower cost).',
}

const POLARITY_OPTIONS: Readonly<Record<string, string>> = {
  higher: 'Higher values are better: measures of success, quality, throughput, accuracy, pass rates, speedups, or financial savings.',
  lower: 'Lower values are better: measures of cost, latency, response time, resource consumption (memory, tokens), errors, or defect counts.',
  neutral: 'Neutral: descriptive quantities, dimensions, allocations, or identifiers where neither direction represents a superior result.',
}

const RIVALS_OPTIONS: Readonly<Record<string, string>> = {
  rows: 'Rows are competing alternatives: each row represents a distinct system, model, or configuration evaluated on common benchmark columns, so the best row in each column should be highlighted.',
  columns: 'Columns are competing alternatives: numeric columns represent competing implementations or settings evaluated across test workloads/rows, so the best column in each row should be highlighted.',
  neither: 'No direct competition: data represents sequential process steps, parts of a whole, before/after states, or descriptive categories rather than competing alternatives.',
}

const COLUMN_OPTIONS: Readonly<Record<string, string>> = {
  [YES]: 'Plot this column: contains a substantive metric or comparison variable that directly contributes to the chart visualization.',
  [NO]: 'Leave this column out: aggregate total or average that restates other columns, invariant configuration setting, row identifier, or metadata not suited for a chart axis.',
}

const TABLE_PREFACE =
  "The state is a Markdown table from a coding assistant's answer, with each column's inferred type."

const KIND_PROMPT =
  `${TABLE_PREFACE} A chart will be rendered immediately below the table to visualize its data for the user. Select the chart family that best conveys the primary relationship in this data.\n\n` +
  "Decision purpose: choose the visualization structure that fits the data's semantic relationship (independent items, paired conditions, component parts, temporal/step trends, or multi-metric evaluation).\n" +
  "What the reader will see: an inline chart matching the chosen family (e.g., grouped bars, segmented stacked bars, connected line trend, or multi-metric panels).\n" +
  "What goes wrong under the wrong choice: choosing a line chart for unordered items displays misleading slopes; choosing stacked bars for non-additive metrics produces meaningless totals; choosing grouped bars for parts-of-a-whole obscures the cumulative total."

const RIVALS_PROMPT =
  `${TABLE_PREFACE} The chart will optionally mark the top-performing competitor in each comparison with visual badges.\n\n` +
  "Decision purpose: identify what is competing in this table so best-in-class highlights can be placed accurately.\n" +
  "What the reader will see: if rows compete, the best row in each metric column is highlighted; if columns compete, the best column in each row is highlighted; if neither, no competitive badges are shown.\n" +
  "What goes wrong under the wrong choice: marking rivals on sequential pipeline stages or parts of a whole misleadingly implies a contest between non-competing parts; failing to mark rivals on benchmarks leaves the winning alternatives hard to spot."

const FOCUS_PROMPT =
  `${TABLE_PREFACE} A chart will be drawn under the table with one entry per row. Decide which row, if any, is the primary subject or recommendation of the table.\n\n` +
  "Decision purpose: highlight the recommended candidate, proposed modification, or baseline reference that other rows are evaluated against.\n" +
  "What the reader will see: visual callout or distinctive emphasis on the focus row.\n" +
  "What goes wrong under the wrong choice: highlighting an arbitrary row invents an unwarranted recommendation; failing to highlight the author's recommended solution makes the decision harder to follow."

const TITLE_PROMPT =
  `${TABLE_PREFACE} A chart will be drawn under the table, headed by a single-line summary statement.\n\n` +
  "Decision purpose: select a concise headline that captures the table's central conclusion or takeaway for the user.\n" +
  "What the reader will see: a one-line prominent title above the chart, or no title if no candidate accurately summarizes the table.\n" +
  "What goes wrong under the wrong choice: choosing an irrelevant or minor cell value distracts from the core takeaway; asserting a conclusion not supported by the data misinforms the reader."

/** What one table states in one line: the chart's title candidates. */
interface Fact {
  /** Option key: `top:Latency ms`, `trend:Queued jobs`. */
  readonly key: string
  /** The sentence a title would carry. */
  readonly text: string
  /** About the whole table, so a hesitant judge may still pick it. */
  readonly striking: boolean
}

/**
 * What the judge is shown for one table: the Markdown itself, cut to
 * `config.maxTableChars`, and each column's inferred type. The table is the
 * whole state — no conversation, no session projection, no earlier turns.
 */
export function buildChartState(
  markdown: string,
  analysis: TableAnalysis,
  config: Config = DEFAULT_CONFIG,
): ChartState {
  return {
    table: markdown.slice(0, Math.max(0, config.maxTableChars)),
    columns: analysis.columns.map(column => ({ name: column.header, type: columnType(column) })),
  }
}

/** A column's type as a judge reads it: `number (duration)`, `text`, `ordered step`, `row index`, `date/time`. */
function columnType(column: TableColumn): string {
  switch (column.role) {
    case 'measure':
      if (column.mixed) return 'number (mixed units)'
      return column.scores ? 'number (score out of a total)' : `number (${column.dim ?? 'count'})`
    case 'sequence':
      return 'ordered step'
    case 'index':
      return 'row index'
    case 'temporal':
      return 'date/time'
    default:
      return 'text'
  }
}

/**
 * The questions a judge is asked about one table, in the order they are
 * offered: the kind first, then the structural questions (row order, each
 * candidate column), then the semantic ones in the design's priority — title,
 * rivals, polarity, focus. A table with more questions than
 * `config.maxQuestions` keeps the earliest ones, so a wide table loses a focus
 * or title question before it loses a column question.
 */
export function buildChartQuestions(
  analysis: TableAnalysis,
  plan: ChartPlan,
  config: Config = DEFAULT_CONFIG,
): ChartQuestion[] {
  const candidates = columnCandidates(analysis, plan)
  const questions: ChartQuestion[] = [kindQuestion(analysis, plan, candidates)]
  const order = orderQuestion(analysis, plan)
  if (order !== undefined) questions.push(order)
  for (const column of candidates) questions.push(columnQuestion(plan, column))
  const semantic = [
    titleQuestion(analysis, plan),
    rivalsQuestion(analysis, plan),
    ...polarityQuestions(analysis, plan, candidates),
    focusQuestion(analysis, plan),
  ].filter((question): question is ChartQuestion => question !== undefined)
  semantic.sort((a, b) => a.priority - b.priority)
  questions.push(...semantic)
  return questions.slice(0, Math.max(0, config.maxQuestions))
}

/**
 * `plan` with the judge's `answers` applied, each at its own gate, plus the
 * record of what was adopted and what was ignored. `answers` is keyed by
 * {@link ChartQuestion.id}; an answer for a question this table did not ask is
 * ignored as `unknown-question`.
 */
export function mergeChartAnswers(
  plan: ChartPlan,
  analysis: TableAnalysis,
  answers: ChartAnswers = {},
  config: Config = DEFAULT_CONFIG,
): MergeResult {
  const questions = buildChartQuestions(analysis, plan, config)
  const byId = new Map(questions.map(question => [question.id, question]))
  const verdicts = new Map<string, Verdict>()
  for (const question of questions) {
    const judged = verdict(question, answers[question.id])
    if (judged !== undefined) verdicts.set(question.id, judged)
  }
  /** What the merge did with one question, keyed by id. */
  const outcomes = new Map<string, { before: string; after: string; reason?: MergeReason }>()

  const kindVerdict = verdicts.get('kind')
  const kindPick = kindVerdict?.choice as ChartKind | undefined
  const candidates = columnCandidates(analysis, plan)
  const columnVerdicts = candidates.map(column => verdicts.get(`c${column.index}`))
  let kind: ChartKind = kindPick ?? plan.kind
  let series: readonly number[] = plan.series
  let whole = plan.whole
  // Each answered column decides itself; an unanswered one keeps the heuristic's place.
  if (columnVerdicts.some(entry => entry?.choice !== undefined)) {
    const chosen = candidates.flatMap(column => {
      const pick = verdicts.get(`c${column.index}`)?.choice
      const plot = pick ?? (plan.series.includes(column.index) ? YES : NO)
      return plot === YES ? [column.index] : []
    })
    if (chosen.length > 0) series = chosen
  }
  // The values prove the parts make the whole: the chart stacks them whatever kind was picked.
  const composition = analysis.composition
  if (composition !== undefined) {
    kind = 'stacked'
    series = composition.parts
    whole = composition.whole
  } else if (
    kindPick !== undefined &&
    !kindFits(kind, analysis, plan, series.flatMap(index => analysis.columns[index] ?? []))
  ) {
    kind = plan.kind
    series = plan.series
    whole = plan.whole
  }
  const constrained = composition !== undefined
  const kindOutcome =
    kindVerdict?.choice === undefined
      ? undefined
      : kindVerdict.choice === kind
        ? 'adopted'
        : constrained
          ? 'structural-override'
          : 'not-drawable'
  if (kindVerdict !== undefined) {
    outcomes.set('kind', { before: plan.kind, after: kind, ...(kindOutcome !== undefined && { reason: kindOutcome }) })
  }
  for (const column of candidates) {
    const answer = verdicts.get(`c${column.index}`)
    if (answer === undefined) continue
    const id = `c${column.index}`
    const plotted = series.includes(column.index) ? YES : NO
    const reason =
      answer.choice === undefined
        ? undefined
        : answer.choice === plotted
          ? 'adopted'
          : constrained
            ? 'structural-override'
            : 'not-drawable'
    outcomes.set(id, {
      before: byId.get(id)?.fallback ?? NO,
      after: plotted,
      ...(reason !== undefined && { reason }),
    })
  }

  const rivalsVerdict = verdicts.get('rivals')
  let rivals = plan.rivals
  if (rivalsVerdict?.choice !== undefined)
    rivals = rivalsVerdict.choice === 'neither' ? undefined : (rivalsVerdict.choice as 'columns' | 'rows')
  if (rivalsVerdict !== undefined)
    outcomes.set('rivals', { before: plan.rivals ?? 'neither', after: rivals ?? 'neither' })

  // A plotted column's polarity is drawn; the heuristic's value stands for the rest.
  const polarity: Record<number, PolaritySide> = { ...plan.polarity }
  for (const question of questions) {
    if (question.kind !== 'polarity') continue
    const answer = verdicts.get(question.id)
    if (answer === undefined) continue
    const index = Number(question.id.slice(1))
    const before = question.fallback
    if (answer.choice === undefined) {
      outcomes.set(question.id, { before, after: before })
      continue
    }
    if (!series.includes(index)) {
      outcomes.set(question.id, { before, after: before, reason: 'not-plotted' })
      continue
    }
    if (answer.choice === 'neutral') delete polarity[index]
    else polarity[index] = answer.choice as PolaritySide
    outcomes.set(question.id, { before, after: answer.choice })
  }
  const sides = Object.keys(polarity).length > 0 ? polarity : undefined

  const names = rowNames(analysis, plan)
  const focusVerdict = verdicts.get('focus')
  let focus = plan.focus
  if (focusVerdict?.choice !== undefined) {
    if (focusVerdict.choice === NONE) focus = []
    else {
      const row = names.get(focusVerdict.choice)
      if (row !== undefined) focus = [row]
    }
  }
  if (focusVerdict !== undefined) {
    const focused = focus.length > 0 ? nameOf(names, focus[0]!) : NONE
    outcomes.set('focus', { before: byId.get('focus')?.fallback ?? NONE, after: focused })
  }

  const orderVerdict = verdicts.get('order')
  let order: ChartOrder = plan.order
  if (orderVerdict?.choice !== undefined)
    order = orderVerdict.choice === TABLE ? null : (orderVerdict.choice as ChartOrder)
  if (orderVerdict !== undefined)
    outcomes.set('order', { before: byId.get('order')?.fallback ?? TABLE, after: order ?? TABLE })

  const titleVerdict = verdicts.get('title')
  const titleQuestion = byId.get('title')
  let title = plan.title
  let titleKey = titleQuestion?.fallback ?? NONE
  if (titleVerdict?.choice !== undefined) {
    if (titleVerdict.choice === NONE) {
      title = undefined
      titleKey = NONE
    } else {
      const facts = chartFacts(analysis, plan)
      const fact = facts.find(f => f.key === titleVerdict.choice)
      if (fact !== undefined) {
        title = fact.text
        titleKey = titleVerdict.choice
      }
    }
  }
  if (titleVerdict !== undefined)
    outcomes.set('title', { before: titleQuestion?.fallback ?? NONE, after: titleKey })

  const merged: ChartPlan = {
    kind,
    ...(plan.label !== undefined && { label: plan.label }),
    series,
    ...(whole !== undefined && { whole }),
    order,
    focus,
    ...(sides !== undefined && { polarity: sides }),
    ...(rivals !== undefined && { rivals }),
    ...(title !== undefined && { title }),
  }

  const entries: MergeTraceEntry[] = []
  for (const question of questions) {
    const answer = verdicts.get(question.id)
    if (answer === undefined) continue
    const outcome = outcomes.get(question.id)
    const reason: MergeReason =
      outcome?.reason ?? (answer.choice === undefined ? answer.reason : 'adopted')
    const asked = answers[question.id]
    entries.push({
      id: question.id,
      kind: question.kind,
      ...(asked !== undefined && { answer: asked.choice, confidence: answer.confidence }),
      threshold: answer.threshold,
      adopted: reason === 'adopted',
      reason,
      before: outcome?.before ?? question.fallback,
      after: outcome?.after ?? question.fallback,
    })
  }
  for (const id of Object.keys(answers)) {
    const asked = answers[id]
    if (asked === undefined || verdicts.has(id)) continue
    entries.push({
      id,
      answer: asked.choice,
      confidence: asked.confidence,
      threshold: 0,
      adopted: false,
      reason: 'unknown-question',
    })
  }
  const trace: MergeTrace = {
    entries,
    adopted: entries.filter(entry => entry.adopted).map(entry => entry.id),
    ignored: entries.filter(entry => !entry.adopted).map(entry => entry.id),
  }

  let unresolved = false
  let hint: ChartHint | undefined

  if (kindVerdict !== undefined && kindVerdict.choice === undefined) {
    unresolved = true
    hint = {
      scenario: 'unresolved_kind',
      diagnosis: `Chart kind decision was ambiguous (confidence ${kindVerdict.confidence.toFixed(2)} < gate ${kindVerdict.threshold.toFixed(2)}).`,
      suggestedAction: 'Specify an explicit chart kind or provide clearer comparison headers in the table.',
    }
  } else if (series.length === 0) {
    unresolved = true
    hint = {
      scenario: 'unresolved_columns',
      diagnosis: 'All proposed column series were rejected or below threshold, leaving zero plottable metrics.',
      suggestedAction: 'Ensure the table includes at least one distinct numeric measure column.',
    }
  } else if (questions.length > 0 && Object.keys(answers).length === 0) {
    unresolved = true
    hint = {
      scenario: 'missing_answers',
      diagnosis: 'Judge returned no answers for the chart questions.',
      suggestedAction: 'Verify judgment service connectivity and candidate availability.',
    }
  }

  return { plan: merged, trace, ...(unresolved && { unresolved, hint }) }
}

/** {@link mergeChartAnswers} without the trace, for a caller that only draws the plan. */
export function applyChartAnswers(
  plan: ChartPlan,
  analysis: TableAnalysis,
  answers: ChartAnswers = {},
  config: Config = DEFAULT_CONFIG,
): ChartPlan {
  return mergeChartAnswers(plan, analysis, answers, config).plan
}

/** One question's verdict: the option when it is listed and at its gate, else why it was not. */
interface Verdict {
  readonly choice?: string
  readonly confidence: number
  readonly threshold: number
  readonly reason: MergeReason
}

/** What an answer to `question` decides, or `undefined` when there is no such question. */
function verdict(question: ChartQuestion, answer: ChartAnswers[string] | undefined): Verdict | undefined {
  if (answer === undefined) {
    const threshold = question.optionThresholds?.[question.fallback] ?? question.threshold
    return { confidence: 0, threshold, reason: 'missing' }
  }
  const threshold = question.optionThresholds?.[answer.choice] ?? question.threshold
  if (!Object.hasOwn(question.options, answer.choice)) {
    return { confidence: answer.confidence, threshold, reason: 'unknown-option' }
  }
  return answer.confidence >= threshold
    ? { choice: answer.choice, confidence: answer.confidence, threshold, reason: 'adopted' }
    : { confidence: answer.confidence, threshold, reason: 'below-threshold' }
}

/** The measure columns a question may name, the label column aside. */
function columnCandidates(analysis: TableAnalysis, plan: ChartPlan): TableColumn[] {
  return analysis.measures.filter(column => column.index !== plan.label)
}

/** Whether the chosen columns can draw `kind` at all. */
function kindFits(
  kind: ChartKind,
  analysis: TableAnalysis,
  plan: ChartPlan,
  columns: readonly TableColumn[],
): boolean {
  switch (kind) {
    case 'bar':
      return columns.length >= 1
    case 'paired':
      return columns.length === 2 && columns[0]!.dim === columns[1]!.dim
    case 'grouped':
      return columns.length >= 2
    case 'stacked':
      return stackable(columns, analysis).length >= 2
    case 'line':
      return columns.length >= 1 && plan.label !== undefined && analysis.rows.length >= MIN_LINE_ROWS
    case 'heatmap':
      return (
        columns.length >= HEATMAP_SERIES &&
        new Set(columns.map(column => column.dim)).size === 1 &&
        analysis.rows.length >= 3
      )
    case 'multiples':
      return columns.length >= 2 && new Set(columns.map(column => column.dim)).size >= 2
    case 'progress':
      return columns.length === 1
  }
}

/** Columns that can stack: non-negative amounts in the first such column's dimension and unit. */
function stackable(columns: readonly TableColumn[], analysis: TableAnalysis): TableColumn[] {
  const amounts = columns.filter(
    column =>
      column.dim !== undefined &&
      ADDITIVE.has(column.dim) &&
      !column.scores &&
      analysis.rows.every(row => {
        const cell = column.cells[row]
        return cell?.kind !== 'number' || cell.value >= 0
      }),
  )
  const first = amounts[0]
  return first === undefined
    ? []
    : amounts.filter(column => column.dim === first.dim && column.unit === first.unit)
}

/** The chart kind question: every kind these columns can draw. */
function kindQuestion(
  analysis: TableAnalysis,
  plan: ChartPlan,
  candidates: readonly TableColumn[],
): ChartQuestion {
  const options: Record<string, string> = {}
  for (const kind of KIND_ORDER) {
    if (kindFits(kind, analysis, plan, candidates)) options[kind] = KIND_OPTIONS[kind]
  }
  return {
    id: 'kind',
    kind: 'kind',
    prompt: KIND_PROMPT,
    options,
    fallback: plan.kind,
    threshold: 0,
    priority: 0,
  }
}

/** The row order question, asked where the rows are independent items a ranking could reorder. */
function orderQuestion(analysis: TableAnalysis, plan: ChartPlan): ChartQuestion | undefined {
  const label = plan.label === undefined ? undefined : analysis.columns[plan.label]
  const lead = analysis.columns[plan.series[0] ?? -1]
  if (label?.role !== 'label' || lead === undefined || analysis.rows.length < MIN_RANKED_ROWS) return undefined
  const values = analysis.rows.flatMap(row => {
    const cell = valueAt(lead, row)
    return cell === undefined ? [] : [cell.value]
  })
  const rising = values.every((value, at) => at === 0 || value >= values[at - 1]!)
  const falling = values.every((value, at) => at === 0 || value <= values[at - 1]!)
  if (values.length < MIN_RANKED_ROWS || rising || falling) return undefined
  return {
    id: 'order',
    kind: 'order',
    prompt:
      `${TABLE_PREFACE} The chart will render categories along the primary axis, measuring "${lead.header}". Decide the appropriate display order for the rows.\n\n` +
      "Decision purpose: determine whether categories have intrinsic order or benefit from ranking by the primary measure.\n" +
      "What the reader will see: categories displayed in table order, descending order (largest first), or ascending order (smallest first).\n" +
      "What goes wrong under the wrong choice: reordering a chronological sequence or baseline-first structure breaks the logical narrative; failing to sort unordered benchmarks forces the reader to scan to find top performers.",
    options: ORDER_OPTIONS,
    fallback: plan.order ?? TABLE,
    threshold: ORDER_CONFIDENCE,
    priority: 0,
  }
}

/** The plot-or-not question for one candidate column. */
function columnQuestion(plan: ChartPlan, column: TableColumn): ChartQuestion {
  return {
    id: `c${column.index}`,
    kind: 'column',
    prompt:
      `${TABLE_PREFACE} Decide whether the column "${column.header}" should be plotted as a visual data series in the chart.\n\n` +
      "Decision purpose: select only substantive comparison measures and filter out redundant, invariant, or metadata columns.\n" +
      "What the reader will see: if plotted (yes), a dedicated visual series is created; if omitted (no), the column is excluded from chart axes.\n" +
      "What goes wrong under the wrong choice: plotting redundant totals alongside component parts doubles the apparent volume and distorts the axis; plotting invariant settings adds clutter; omitting an essential metric leaves the comparison incomplete.",
    options: COLUMN_OPTIONS,
    fallback: plan.series.includes(column.index) ? YES : NO,
    threshold: COLUMN_CONFIDENCE,
    priority: 0,
  }
}

/** One polarity question per measure the chart may plot, the heuristic's series first. */
function polarityQuestions(
  analysis: TableAnalysis,
  plan: ChartPlan,
  candidates: readonly TableColumn[],
): ChartQuestion[] {
  const ordered = [
    ...plan.series.flatMap(index => analysis.columns[index] ?? []),
    ...candidates.filter(column => !plan.series.includes(column.index)),
  ]
  const seen = new Set<number>()
  const questions: ChartQuestion[] = []
  for (const column of ordered) {
    if (column.role !== 'measure' || column.index === plan.label || seen.has(column.index)) continue
    if (questions.length >= MAX_POLARITY_QUESTIONS) break
    seen.add(column.index)
    questions.push({
      id: `p${column.index}`,
      kind: 'polarity',
      prompt:
        `${TABLE_PREFACE} Decide whether higher or lower numerical values represent better performance for the column "${column.header}".\n\n` +
        "Decision purpose: determine the optimization direction for visual polarity coloring (green for favorable values, red/muted for unfavorable values).\n" +
        "What the reader will see: color emphasis indicating whether a value is good or bad.\n" +
        "What goes wrong under the wrong choice: marking lower is better for accuracy or higher is better for latency inverts success indicators and completely misleads the user on performance.",
      options: POLARITY_OPTIONS,
      fallback: plan.polarity?.[column.index] ?? 'neutral',
      threshold: POLARITY_CONFIDENCE,
      priority: 3,
    })
  }
  return questions
}

/** The rivals question, asked where more than two rows give the answer something to mark. */
function rivalsQuestion(analysis: TableAnalysis, plan: ChartPlan): ChartQuestion | undefined {
  if (analysis.rows.length < MIN_CONTEST_ROWS) return undefined
  return {
    id: 'rivals',
    kind: 'rivals',
    prompt: RIVALS_PROMPT,
    options: RIVALS_OPTIONS,
    fallback: plan.rivals ?? 'neither',
    threshold: RIVALS_CONFIDENCE,
    priority: 2,
  }
}

/** The focus question, offered the rows by the names the chart writes. */
function focusQuestion(analysis: TableAnalysis, plan: ChartPlan): ChartQuestion | undefined {
  const names = rowNames(analysis, plan)
  if (names.size < MIN_CONTEST_ROWS || names.size > MAX_FOCUS_ROWS) return undefined
  const options: Record<string, string | null> = {}
  for (const name of names.keys()) {
    options[name] = `Focus on row "${name}": this row is the primary recommendation, proposed modification, or baseline reference under evaluation.`
  }
  options[NONE] = 'No single row stands out: all rows are peer alternatives presented neutrally without a favored candidate.'
  const thresholds: Record<string, number> = {}
  for (const row of plan.focus) {
    const name = nameOf(names, row)
    if (name !== NONE && names.has(name)) thresholds[name] = AGREED_FOCUS_CONFIDENCE
  }
  return {
    id: 'focus',
    kind: 'focus',
    prompt: FOCUS_PROMPT,
    options,
    fallback: plan.focus.length > 0 ? nameOf(names, plan.focus[0]!) : NONE,
    threshold: FOCUS_CONFIDENCE,
    ...(Object.keys(thresholds).length > 0 && { optionThresholds: thresholds }),
    priority: 4,
  }
}

/** The title question, offered the one-line facts the table states. */
function titleQuestion(analysis: TableAnalysis, plan: ChartPlan): ChartQuestion | undefined {
  const facts = chartFacts(analysis, plan)
  if (facts.length === 0) return undefined
  const options: Record<string, string | null> = {}
  const thresholds: Record<string, number> = {}
  for (const fact of facts) {
    options[fact.key] = `${fact.text}: prominent finding demonstrated across the table.`
    if (!fact.striking) thresholds[fact.key] = PLAIN_TITLE_CONFIDENCE
  }
  options[NONE] = "No title: none of these is the table's point."
  return {
    id: 'title',
    kind: 'title',
    prompt: TITLE_PROMPT,
    options,
    fallback: facts.find(fact => fact.text === plan.title)?.key ?? NONE,
    threshold: TITLE_CONFIDENCE,
    ...(Object.keys(thresholds).length > 0 && { optionThresholds: thresholds }),
    priority: 1,
  }
}

/**
 * What the table states in one line: for every measure column, the row holding
 * its highest and its lowest value, and where a series runs one way through
 * every row, that run. A top or low fact restates one value, so it needs a
 * confident judge; a run through the whole table stands on less.
 */
function chartFacts(analysis: TableAnalysis, plan: ChartPlan): Fact[] {
  const facts: Fact[] = []
  const keys = new Set<string>()
  const add = (key: string, text: string, striking: boolean) => {
    let unique = key
    for (let at = 2; keys.has(unique); at++) unique = `${key} (${at})`
    keys.add(unique)
    facts.push({ key: unique, text, striking })
  }
  const names = rowNames(analysis, plan)
  // A top or low fact names its row, so it needs the table to name its rows.
  if (names.size > 0) {
    for (const column of analysis.measures) {
      const entries = analysis.rows.flatMap(row => {
        const cell = valueAt(column, row)
        return cell === undefined ? [] : [[row, cell] as const]
      })
      if (entries.length < 2) continue
      let top = entries[0]!
      let low = entries[0]!
      for (const entry of entries) {
        if (entry[1].value > top[1].value) top = entry
        if (entry[1].value < low[1].value) low = entry
      }
      add(
        `top:${column.header}`,
        `${nameOf(names, top[0])} has the highest ${column.header} (${display(top[1])})`,
        false,
      )
      if (low[0] !== top[0]) {
        add(
          `low:${column.header}`,
          `${nameOf(names, low[0])} has the lowest ${column.header} (${display(low[1])})`,
          false,
        )
      }
    }
  }
  for (const column of analysis.measures) {
    const values = analysis.rows.flatMap(row => {
      const cell = valueAt(column, row)
      return cell === undefined ? [] : [cell.value]
    })
    if (values.length < MIN_TREND_ROWS) continue
    const rising = values.every((value, at) => at === 0 || value > values[at - 1]!)
    const falling = values.every((value, at) => at === 0 || value < values[at - 1]!)
    if (rising) add(`trend:${column.header}`, `${column.header} rises through every row`, true)
    else if (falling) add(`trend:${column.header}`, `${column.header} falls through every row`, true)
  }
  return facts
}

/** Each data row's name as the chart writes it, made unique; empty without a label column. */
function rowNames(analysis: TableAnalysis, plan: ChartPlan): Map<string, number> {
  const names = new Map<string, number>()
  const label = plan.label === undefined ? undefined : analysis.columns[plan.label]
  if (label === undefined) return names
  for (const row of analysis.rows) {
    const text = label.cells[row]?.text ?? ''
    const stem = text === '' ? `row ${row + 1}` : text
    let name = stem
    for (let at = 2; names.has(name) || name === NONE; at++) name = `${stem} (${at})`
    names.set(name, row)
  }
  return names
}

/** The name `row` was given, or `none` when the table names no rows. */
function nameOf(names: ReadonlyMap<string, number>, row: number): string {
  for (const [name, index] of names) if (index === row) return name
  return NONE
}

/** `column`'s plain value at `row`: a number of the column's dimension, not a range or a move. */
function valueAt(column: TableColumn, row: number): NumberCell | undefined {
  const cell = column.cells[row]
  return cell?.kind === 'number' && cell.dim === column.dim && cell.upper === undefined && cell.to === undefined
    ? cell
    : undefined
}

/** A value as the table wrote it, with the header's unit when the cell carried none. */
function display(cell: NumberCell): string {
  if (cell.fit === 'fraction') return cell.text
  return cell.unit === '' || cell.text.includes(cell.unit) ? cell.text : `${cell.text} ${cell.unit}`
}

