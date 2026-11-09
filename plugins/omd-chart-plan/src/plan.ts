/**
 * The deterministic half of the table-to-chart planner: which kind of chart a
 * table deserves, from the table alone.
 *
 * Two gates decide first, both from the design's capability bounds: a table is
 * worth a chart only when it keeps at least two data rows, at least one
 * varying measure column that does not restate another, is not prose carrying
 * a few small numbers, and passes {@link worthCharting}. Only then does the
 * kind cascade run, in the design's order, first match wins.
 *
 * No judge, no model call, no I/O. Every field a judge will later overwrite —
 * title, focus, polarity, rivals, order — is filled here with what the numbers
 * and headers state, so the plan is complete before any judge runs.
 *
 * The thresholds below are the values the design fixed. They belong in
 * `Config` once the profile carries them; this slice keeps them as named
 * constants and reads only `minRows` from {@link Config}.
 *
 * @module omd-chart-plan/plan
 */

import type {
  ChartKind,
  ChartOrder,
  ChartPlan,
  ChartSeries,
  ChartSpec,
  Config,
  PolaritySide,
  TableAnalysis,
  TableColumn,
} from './types.ts'

/** Fewest categories a chart must show before it beats the table. */
const WORTH_CATEGORIES = 4

/** Plotted values from which a chart reads even with few categories. */
const WORTH_POINTS = 9

/** Spread within one series from which a chart reads even with few categories. */
const WORTH_SPREAD = 3

/** Fewest values a series needs before one repeated value in all but one of them means something. */
const MIN_UNIFORM_VALUES = 4

/** Text a table's prose columns hold per row, by median, from which the prose carries the table. */
const PROSE_CELL_LENGTH = 40

/** Largest whole number a chart may plot beside prose and still restate it. */
const MAX_PROSE_COUNT = 5

/** Fewest rows a line joins: three points draw a bend, not a trend. */
const MIN_LINE_ROWS = 4

/** Most lines one line chart keeps apart. */
const MAX_LINE_SERIES = 6

/** Most panels a small-multiples grid stays legible with. */
const MAX_PANELS = 6

/** Fewest same-dimension columns a heatmap needs. */
const HEATMAP_MIN_SERIES = 4

/** Column headers naming a target a value is read against (`Target`, `Budget`, `SLO`). */
const TARGET_HEADER = /(?:^|\b)(?:target|budget|goal|limit|slo|threshold|ceiling)s?(?:\b|$)/i

/** Label headers saying each row is a quantity of its own (`Metric`, `Value`, `Stat`). */
const METRIC_HEADER = /^(?:metrics?|measures?|stats?|statistics?|quantit(?:y|ies)|values?)$/i

/** Outcome headers: counts of attempts split into results, parts of each row's whole. */
const OUTCOME_HEADER = /^(?:ok|success|successes|passed|pass|fail|failed|failures|error|errors|skipped|skip|miss|misses)$/i

/** Headers naming the earlier of two conditions. */
const BEFORE = /\b(?:before|old|baseline|prev|previous|original|main|master|stock|unpatched)\b/i

/** Headers naming the later of two conditions. */
const AFTER = /\b(?:after|new|patched|optimized|optimised|fixed|now|warm|proposed|v2)\b/i

/** Row names that point at the row the table is about. */
const FOCUS_NAME =
  /\((?:current|ours|recommended|chosen|selected|winner|best|shipped|proposed|pick)\b[^)]*\)|(?:^|[^\w])(?:ours|recommended)(?![\w])|[✅⭐★]/i

/** Headers whose lower value is the better result. */
const LOWER_HEADER = /(?:latency|duration|time|cost|price|memory|size|errors?|failures?|drops?|dropped|misses|overhead|regressions?)/i

/** Headers whose higher value is the better result. */
const HIGHER_HEADER = /(?:score|accuracy|passed|success|throughput|coverage|saved|savings|improvement|speedup)/i

/** Label headers naming what the rows compete with. */
const RIVAL_HEADER = /(?:models?|configs?|configurations?|variants?|approaches?|methods?|options?|strategies?|implementations?)/i

/**
 * The settings a profile will supply. These are the design's defaults; the
 * profile and the project panel own the real values.
 */
export const DEFAULT_CONFIG: Config = {
  mode: 'heuristic',
  minConfidence: 0.6,
  pickTimeoutMs: 15_000,
  maxTableChars: 4_000,
  maxQuestions: 25,
  minRows: 2,
}

/**
 * Plan a chart for an analysed table, or return `null` when the table is better
 * left as a table.
 *
 * The result is complete on its own: the judge path may replace `kind`,
 * `series`, `order`, `focus`, `polarity`, `rivals` and `title` with better
 * answers, but when no judge answers this plan is what gets drawn.
 */
export function planChart(analysis: TableAnalysis, config: Config = DEFAULT_CONFIG): ChartPlan | null {
  const measures = analysis.measures
  if (analysis.rows.length < config.minRows || measures.length === 0) return null
  // Two rows and one value compare in the table itself.
  if (analysis.rows.length === 2 && measures.length === 1) return null
  // A target column needs a bullet chart, which this slice does not draw. A bar
  // of the measured values alone would hide what each row is measured against.
  if (hasTargetColumn(analysis)) return null
  if (proseLed(analysis, measures)) return null
  const label = analysis.label
  if (measures.length === 1 && label?.role === 'label' && METRIC_HEADER.test(label.header.trim())) return null
  const plan = guessShape(analysis, measures, label)
  if (plan === null) return null
  const spec = buildSpec(analysis, plan)
  return spec !== undefined && worthCharting(spec) ? plan : null
}

/**
 * Whether a judge could improve on this plan: two or more measure columns and
 * three or more rows give it something to decide that the numbers cannot.
 */
export function shouldJudge(analysis: TableAnalysis, plan: ChartPlan | null): boolean {
  return plan !== null && analysis.rows.length >= 3 && analysis.measures.length >= 2
}

/**
 * Whether a chart of `spec` reads faster than its table: at least four
 * categories, nine plotted values, or a threefold spread inside a series — and
 * not one value repeated in nearly every row, which a sentence says better.
 */
export function worthCharting(spec: ChartSpec): boolean {
  const categories = spec.categories.length
  let points = 0
  let spread = 1
  for (const entry of spec.series) {
    const values = entry.values.flatMap(value => (value === null ? [] : [value]))
    points += values.length
    const positive = values.filter(value => value > 0)
    if (positive.length >= 2) spread = Math.max(spread, Math.max(...positive) / Math.min(...positive))
  }
  if (categories < WORTH_CATEGORIES && points < WORTH_POINTS && spread < WORTH_SPREAD) return false
  const uniform = spec.series.every(entry => {
    const values = entry.values.flatMap(value => (value === null ? [] : [value]))
    if (values.length < MIN_UNIFORM_VALUES) return false
    const tally = new Map<number, number>()
    for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1)
    return Math.max(...tally.values()) >= values.length - 1
  })
  return !uniform
}

/**
 * Turn a plan into the categories and values a renderer draws, or `undefined`
 * when the plan names no series.
 */
export function buildSpec(analysis: TableAnalysis, plan: ChartPlan): ChartSpec | undefined {
  const label = plan.label === undefined ? undefined : analysis.columns[plan.label]
  const series = plan.series.flatMap(index => {
    const column = analysis.columns[index]
    return column === undefined ? [] : [seriesOf(analysis, column)]
  })
  if (series.length === 0) return undefined
  const whole = plan.whole === undefined ? undefined : analysis.columns[plan.whole]
  return {
    kind: plan.kind,
    categories: analysis.rows.map((row, at) => label?.cells[row]!.text ?? `#${at + 1}`),
    series,
    ...(whole !== undefined && { whole: seriesOf(analysis, whole) }),
    order: plan.order,
    focus: plan.focus,
    polarity: Object.fromEntries(
      Object.entries(plan.polarity ?? {}).map(([index, side]) => [
        analysis.columns[Number(index)]?.header ?? index,
        side,
      ]),
    ),
    ...(plan.rivals !== undefined && { rivals: plan.rivals }),
    ...(plan.title !== undefined && { title: plan.title }),
  }
}

/** One column as the values a renderer draws, `null` where a row holds no plain value. */
function seriesOf(analysis: TableAnalysis, column: TableColumn): ChartSeries {
  return {
    column: column.index,
    header: column.header,
    dim: column.dim ?? 'count',
    values: analysis.rows.map(row => {
      const cell = column.cells[row]
      return cell?.kind === 'number' && cell.dim === column.dim && cell.upper === undefined && cell.to === undefined
        ? cell.value
        : null
    }),
  }
}

/** Whether any measure column is read against a per-row target. */
function hasTargetColumn(analysis: TableAnalysis): boolean {
  return analysis.columns.some(column => {
    if (column.role !== 'measure') return false
    if (TARGET_HEADER.test(column.header)) return true
    const bounded = analysis.rows.filter(row => {
      const cell = column.cells[row]
      return cell?.kind === 'number' && cell.bound
    }).length
    return bounded * 5 >= analysis.rows.length * 3
  })
}

/**
 * Whether the table's prose carries it: label columns other than the row names
 * hold forty characters a row by median, beside plotted values that are all
 * whole numbers up to five.
 */
function proseLed(analysis: TableAnalysis, measures: readonly TableColumn[]): boolean {
  let prose = 0
  for (const column of analysis.columns) {
    if (column.role !== 'label' || column.index === analysis.label?.index) continue
    const lengths = analysis.rows.map(row => column.cells[row]!.text.length).sort((a, b) => a - b)
    prose += lengths[lengths.length >> 1] ?? 0
  }
  if (prose < PROSE_CELL_LENGTH) return false
  return measures.every(column =>
    analysis.rows.every(row => {
      const cell = column.cells[row]
      return cell?.kind !== 'number' || (Number.isInteger(cell.value) && Math.abs(cell.value) <= MAX_PROSE_COUNT)
    }),
  )
}

/** The order the label column states, which a line chart needs; `null` for plain names. */
function labelOrder(label: TableColumn | undefined): ChartOrder {
  if (label === undefined) return null
  if (label.role === 'sequence') return 'numeric'
  if (label.role !== 'temporal') return null
  const dates = label.cells.flatMap(cell => (cell.kind === 'date' ? [cell.text] : []))
  const ascending = dates.every((date, at) => at === 0 || dates[at - 1]! <= date)
  const descending = dates.every((date, at) => at === 0 || dates[at - 1]! >= date)
  return ascending ? 'ascending' : descending ? 'descending' : null
}

/** Row indices the writer pointed at: bold or `(current)`, while they stay a minority. */
function guessFocus(analysis: TableAnalysis, label: TableColumn | undefined): number[] {
  const { rows } = analysis
  if (label === undefined || rows.length < 2) return []
  const bolded = rows.filter(
    row =>
      label.cells[row]!.emphasis ||
      (analysis.measures.length >= 2 &&
        analysis.measures.filter(column => column.cells[row]?.emphasis).length * 2 > analysis.measures.length),
  )
  const picked =
    bolded.length > 0 && bolded.length * 3 <= rows.length + 1
      ? bolded
      : rows.filter(row => FOCUS_NAME.test(label.cells[row]!.text))
  return picked.length > 0 && picked.length * 3 <= rows.length + 1 ? picked : []
}

/**
 * Which direction is the better result, where the header or the dimension says
 * so: durations and cost-like names lower, scores and accuracy-like names higher.
 */
function guessPolarity(measures: readonly TableColumn[]): Record<number, PolaritySide> | undefined {
  const sides: Record<number, PolaritySide> = {}
  for (const column of measures) {
    const header = column.header.trim()
    if (column.dim === 'duration' || LOWER_HEADER.test(header)) sides[column.index] = 'lower'
    else if (column.scores || HIGHER_HEADER.test(header)) sides[column.index] = 'higher'
  }
  return Object.keys(sides).length > 0 ? sides : undefined
}

/** The plan shared by every branch: row names, order, focus, polarity, rivals. */
function shapeOf(
  analysis: TableAnalysis,
  measures: readonly TableColumn[],
  label: TableColumn | undefined,
): Omit<ChartPlan, 'kind' | 'series'> {
  const polarity = guessPolarity(measures)
  return {
    ...(label !== undefined && { label: label.index }),
    order: labelOrder(label),
    focus: guessFocus(analysis, label),
    ...(polarity !== undefined && { polarity }),
    rivals: label !== undefined && RIVAL_HEADER.test(label.header) ? 'rows' : 'columns',
  }
}

/**
 * The kind cascade: the design's order, first match wins. Returns `null` where
 * the shape a table calls for is a kind this slice does not draw.
 */
function guessShape(
  analysis: TableAnalysis,
  measures: readonly TableColumn[],
  label: TableColumn | undefined,
): ChartPlan | null {
  const shape = shapeOf(analysis, measures, label)
  const draw = (kind: ChartKind, series: readonly TableColumn[], whole?: number): ChartPlan => ({
    ...shape,
    kind,
    series: series.map(column => column.index),
    ...(whole !== undefined && { whole }),
  })
  // A transition column (`12 → 15`) draws as a dumbbell pair; one series of its
  // starting values would drop half of what the cell says.
  if (measures.some(column => column.arrowShare >= 0.6)) return null
  const composition = analysis.composition
  if (composition !== undefined) {
    const parts = composition.parts.flatMap(index => {
      const column = analysis.columns[index]
      return column === undefined ? [] : [column]
    })
    return draw('stacked', parts, composition.whole)
  }
  const outcomes = measures.filter(column => column.dim === 'count' && OUTCOME_HEADER.test(column.header.trim()))
  if (outcomes.length >= 2) return draw('stacked', outcomes)
  if (measures.length >= 2) {
    const before = measures.find(column => BEFORE.test(column.header))
    const after = measures.find(column => column.index !== before?.index && AFTER.test(column.header))
    if (before !== undefined && after !== undefined) {
      // Two conditions in different units are a change chart, which this slice
      // does not draw: one axis would mix the units, panels would hide the move.
      return before.dim === after.dim ? draw('paired', [before, after]) : null
    }
  }
  if (
    label !== undefined &&
    (label.role === 'temporal' || label.role === 'sequence') &&
    labelOrder(label) !== null &&
    analysis.rows.length >= MIN_LINE_ROWS
  ) {
    const lead = measures[0]!.dim
    return draw(
      'line',
      measures.filter(column => column.dim === lead).slice(0, MAX_LINE_SERIES),
    )
  }
  if (measures.length === 1 && measures[0]!.scores) return draw('progress', measures)
  const dims = new Set(measures.map(column => column.dim))
  if (dims.size === 1 && measures.length >= HEATMAP_MIN_SERIES && analysis.rows.length >= 3) {
    return draw('heatmap', measures)
  }
  if (dims.size >= 2) return draw('multiples', measures.slice(0, MAX_PANELS))
  if (measures.length >= 2) return draw('grouped', measures)
  return draw('bar', measures)
}
