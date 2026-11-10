/**
 * Reading a Markdown table for charting: parse the first table in a text, read
 * each cell as a quantity or a word, and derive each column's role.
 *
 * The reader is narrow on purpose. A spelling it does not recognize stays text,
 * so the planner declines the table instead of drawing a wrong axis. Supported
 * cell forms: a bare number (thousands separators, decimals), an optional
 * `~`/`≈` estimate or `<`/`>`/`≤`/`≥` bound, a sign, `%`, `$`, `ms`/`s`/`sec`/
 * `us`/`µs`/`h`/`hr`, `B`/`KB`/`MB`/`GB`/`KiB`/`MiB`/`GiB`, one trailing note
 * in parentheses, a score `a/b`, a range `a–b`, and a transition `a → b`.
 * A unit written into the header (`Latency ms`, `Memory (MiB)`) is applied to
 * the bare cells under it.
 *
 * Everything else — `1m 56s`, `3.4G`, `4:14`, `1.2 tok/s`, `12 ✅` — reads as
 * text. A column of text is not a measure, and a table without measures is not
 * charted.
 *
 * @module omd-chart-plan/analyze
 */

import type {
  Cell,
  ColumnRole,
  Composition,
  Dimension,
  NumberCell,
  TableAnalysis,
  TableColumn,
} from './types.ts'

/** A dimension's base factor: `ms` is the duration base, `B` the byte base, a percent point the percent base. */
interface Unit {
  readonly dim: Dimension
  readonly factor: number
  readonly token: string
}

/** Case-sensitive units: `MB` and `MiB` are different amounts, and `b` is neither. */
const CASED_UNITS: Record<string, Unit> = {
  B: { dim: 'bytes', factor: 1, token: 'B' },
  KB: { dim: 'bytes', factor: 1e3, token: 'KB' },
  MB: { dim: 'bytes', factor: 1e6, token: 'MB' },
  GB: { dim: 'bytes', factor: 1e9, token: 'GB' },
  KiB: { dim: 'bytes', factor: 1024, token: 'KiB' },
  MiB: { dim: 'bytes', factor: 1024 ** 2, token: 'MiB' },
  GiB: { dim: 'bytes', factor: 1024 ** 3, token: 'GiB' },
}

/** Case-insensitive units. Bare `m` (minutes or millions) is deliberately absent. */
const LOWER_UNITS: Record<string, Unit> = {
  '%': { dim: 'percent', factor: 1, token: '%' },
  ms: { dim: 'duration', factor: 1, token: 'ms' },
  s: { dim: 'duration', factor: 1e3, token: 's' },
  sec: { dim: 'duration', factor: 1e3, token: 's' },
  us: { dim: 'duration', factor: 1e-3, token: 'us' },
  'µs': { dim: 'duration', factor: 1e-3, token: 'µs' },
  h: { dim: 'duration', factor: 3.6e6, token: 'h' },
  hr: { dim: 'duration', factor: 3.6e6, token: 'h' },
}

/** An empty cell, a dash, or a written-out absence. */
const MISSING = /^(?:[-–—]|n\/?a|none|null|nil|·)$/i

/** Inline link: keep the text, drop the target. */
const LINK = /\[([^\]]*)\]\([^)]*\)/g

/** One trailing note in parentheses: `17 (21.5%)`, `$0.72 (±0.16)`. */
const PAREN = /\s*\(([^)]*)\)\s*$/

/** A bare figure with optional bound, sign, currency symbol, and unit. */
const CORE = /^([~≈]|<|>|≤|≥|<=|>=)?\s*([+-])?\s*(\$)?\s*(\d[\d,]*(?:\.\d+)?)\s*([%A-Za-zµμ]+)?$/

/** `154/160`, `85 / 147`. */
const FRACTION = /^([+-]?\d[\d,]*(?:\.\d+)?)\s*\/\s*(\d[\d,]*(?:\.\d+)?)$/

/** `24–72 h`, `24 — 72`, `24 to 72`. */
const RANGE = /^([+-]?\d[\d,]*(?:\.\d+)?)\s*(?:–|—|\s+to\s+)\s*([+-]?\d[\d,]*(?:\.\d+)?)\s*([%A-Za-zµμ]+)?$/

/** `12 → 15`, `12 -> 15`, `12 => 15`. */
const ARROW = /^(.+?)\s*(?:→|->|=>)\s*(.+)$/

/** An ISO calendar date, the only temporal spelling read as an axis. */
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** A `#123` row identifier. */
const ID = /^#\d+$/

/** Row names that summarize the rows above or below them: `Total`, `Average latency`. */
const TOTAL_ROW = /^(?:total|totals|sum|overall|grand total|sub-?total|average|avg|mean|median)\b/i

/** Headers naming a row identifier. */
const INDEX_HEADER =
  /^(?:#|no\.?|id|ids|rank|row|idx|index|ln|pr|issue|commit|sha|hash|port|pid|exit\s*code)$|(?:^|\s)(?:id|version|sha|hash|pid|port)$/i

/** Headers naming an ordered step, which makes a numeric column an x axis rather than a measure. */
const SEQUENCE_HEADER =
  /^(?:step|phase|stage|round|tier|level|wave|pass|attempt|iter|iteration|epoch|run|batch|day|week|month|year|quarter|n|workers?|threads?|concurrency|jobs|depth|k)$/i

/** Most columns searched for a sum relation; subsets grow combinatorially. */
const MAX_COMPOSED = 8

/** Most parts one whole splits into directly. */
const MAX_PARTS = 4

/** Half a row more than one measure column: fewer rows cannot prove a proportion or a sum. */
const MIN_PROVEN_ROWS = 3

/**
 * Read the first Markdown table in `markdown`.
 *
 * Returns `undefined` when the text holds no table (a header row followed by a
 * delimiter row and at least one body row).
 */
export function analyzeTable(markdown: string): TableAnalysis | undefined {
  const table = parseMarkdownTable(markdown)
  if (!table) return undefined
  const headers = table.header.map(cell => plainCell(cell).text)
  const parsed = table.rows.map(row => headers.map((_, index) => parseCell(row[index] ?? '')))
  const columns = headers.map((header, index) => {
    const unit = headerUnit(header)
    const cells = unit === undefined ? parsed.map(row => row[index]!) : parsed.map(row => withHeaderUnit(row[index]!, unit))
    return readColumn(index, header, cells)
  })
  const named = (cell: Cell) =>
    cell.kind !== 'missing' && ((cell.kind !== 'id' && cell.kind !== 'number') || /\s/.test(cell.text))
  const labels = columns.filter(column => column.role === 'label' || column.role === 'temporal')
  const label =
    labels.find(column => column.cells.some(named)) ??
    labels[0] ??
    columns.find(column => column.role === 'sequence') ??
    columns.find(column => column.role === 'index')
  const totals: number[] = []
  const data: number[] = []
  table.rows.forEach((_, row) => {
    const name = label?.cells[row]!.text ?? ''
    ;(label !== undefined && TOTAL_ROW.test(name) ? totals : data).push(row)
  })
  const finished = columns.map(column => finishColumn(column, data))
  const restated = restatedColumns(
    finished.filter(column => column.role === 'measure'),
    data,
  )
  const analysed = finished.map(column =>
    restated.has(column.index) ? { ...column, restates: restated.get(column.index) } : column,
  )
  const measures = analysed.filter(
    column => column.role === 'measure' && !column.constant && column.restates === undefined,
  )
  return {
    columns: analysed,
    label: label === undefined ? undefined : analysed[label.index],
    measures,
    rows: data,
    totals,
    composition: compositionOf(measures, data),
  }
}

/** The header and body cells of the first Markdown table in `markdown`. */
function parseMarkdownTable(markdown: string): { header: string[]; rows: string[][] } | undefined {
  const lines = markdown.split(/\r?\n/)
  for (let at = 0; at + 1 < lines.length; at++) {
    const header = lines[at]!
    if (!header.includes('|')) continue
    const delimiter = splitRow(lines[at + 1]!)
    if (delimiter.length === 0 || !delimiter.every(cell => /^:?-+:?$/.test(cell))) continue
    const headers = splitRow(header)
    if (headers.length !== delimiter.length) continue
    const rows: string[][] = []
    for (let next = at + 2; next < lines.length; next++) {
      const line = lines[next]!
      if (!line.includes('|') || line.trim() === '') break
      const cells = splitRow(line)
      rows.push(headers.map((_, index) => cells[index] ?? ''))
    }
    if (rows.length > 0) return { header: headers, rows }
  }
  return undefined
}

/** Split one table line on unescaped pipes, dropping the optional outer pipes. */
function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|') && !text.startsWith('\\|')) text = text.slice(1)
  if (/(?<!\\)\|$/.test(text)) text = text.slice(0, -1)
  const cells: string[] = []
  let current = ''
  for (let at = 0; at < text.length; at++) {
    const character = text[at]!
    if (character === '\\' && text[at + 1] === '|') {
      current += '|'
      at++
    } else if (character === '|') {
      cells.push(current.trim())
      current = ''
    } else current += character
  }
  cells.push(current.trim())
  return cells
}

/** A cell's text with Markdown decoration removed, and whether it was emphasized. */
function plainCell(raw: string): { text: string; emphasis: boolean } {
  const trimmed = raw.trim()
  const emphasis = /\*\*[^*]+\*\*|__[^_]+__/.test(trimmed)
  const text = trimmed.replace(LINK, '$1').replace(/\*\*|__|`/g, '').trim()
  return { text, emphasis }
}

/** Read one raw cell. */
function parseCell(raw: string): Cell {
  const { text, emphasis } = plainCell(raw)
  if (text === '' || MISSING.test(text)) return { kind: 'missing', text, emphasis }
  const number = readNumber(text, emphasis)
  if (number) return number
  if (DATE.test(text)) return { kind: 'date', text, emphasis }
  if (ID.test(text)) return { kind: 'id', text, emphasis }
  return { kind: 'text', text, emphasis }
}

/** Read `text` as a quantity, in any of the supported cell forms. */
function readNumber(text: string, emphasis: boolean): NumberCell | undefined {
  const note = PAREN.exec(text)
  const core = (note ? text.slice(0, note.index) : text).trim()
  const common = { kind: 'number' as const, emphasis, text }
  const arrow = ARROW.exec(core)
  if (arrow) {
    const from = figureOf(arrow[1]!)
    const to = figureOf(arrow[2]!)
    if (!from || !to || from.dim !== to.dim) return undefined
    return {
      ...common,
      value: from.value,
      dim: from.dim,
      unit: from.unit,
      fit: 'arrow',
      approx: from.approx,
      bound: from.bound,
      signed: from.signed,
      to: to.value,
    }
  }
  const range = RANGE.exec(core)
  if (range) {
    const unit = range[3]
    const from = figureOf(unit === undefined ? range[1]! : `${range[1]} ${unit}`)
    const to = figureOf(unit === undefined ? range[2]! : `${range[2]} ${unit}`)
    if (!from || !to || from.dim !== to.dim) return undefined
    return {
      ...common,
      value: from.value,
      dim: from.dim,
      unit: from.unit,
      fit: 'range',
      approx: true,
      bound: false,
      signed: from.signed,
      upper: to.value,
    }
  }
  const fraction = FRACTION.exec(core)
  if (fraction) {
    const value = Number(fraction[1]!.replaceAll(',', ''))
    const denominator = Number(fraction[2]!.replaceAll(',', ''))
    if (!Number.isFinite(value) || !Number.isFinite(denominator)) return undefined
    if (denominator <= 0 || value < 0 || value > denominator) return undefined
    return {
      ...common,
      value,
      dim: 'count',
      unit: '',
      fit: 'fraction',
      approx: false,
      bound: false,
      signed: false,
      denominator,
    }
  }
  const figure = figureOf(core)
  if (!figure) return undefined
  return {
    ...common,
    value: figure.value,
    dim: figure.dim,
    unit: figure.unit,
    fit: note ? 'note' : 'pure',
    approx: figure.approx,
    bound: figure.bound,
    signed: figure.signed,
  }
}

/** A figure read from its written form. */
interface Figure {
  readonly value: number
  readonly dim: Dimension
  readonly unit: string
  readonly approx: boolean
  readonly bound: boolean
  readonly signed: boolean
}

/** Read `text` as a bare figure (`~405`, `-3`, `$250`, `18,400 ms`, `87%`). */
function figureOf(text: string): Figure | undefined {
  const match = CORE.exec(text.trim())
  if (!match) return undefined
  const [, prefix, sign, symbol, digits, suffix] = match
  const written = Number(digits!.replaceAll(',', ''))
  if (!Number.isFinite(written)) return undefined
  if (symbol !== undefined && suffix !== undefined) return undefined
  const unit = suffix === undefined ? undefined : unitOf(suffix)
  if (suffix !== undefined && unit === undefined) return undefined
  const factor = unit?.factor ?? 1
  return {
    value: (sign === '-' ? -1 : 1) * written * factor,
    dim: symbol !== undefined ? 'currency' : (unit?.dim ?? 'count'),
    unit: symbol ?? unit?.token ?? '',
    approx: prefix !== undefined,
    bound: prefix !== undefined && prefix !== '~' && prefix !== '≈',
    signed: sign !== undefined,
  }
}

/** The unit a written token names; cased spellings first, then lowercase. */
function unitOf(token: string): Unit | undefined {
  if (Object.hasOwn(CASED_UNITS, token)) return CASED_UNITS[token]
  if (Object.hasOwn(LOWER_UNITS, token)) return LOWER_UNITS[token]
  const lower = token.toLowerCase()
  return Object.hasOwn(LOWER_UNITS, lower) ? LOWER_UNITS[lower] : undefined
}

/** The first unit token in a header: `Latency ms`, `Memory (MiB)`, `Pass %`. */
function headerUnit(header: string): Unit | undefined {
  for (const token of header.split(/[^A-Za-z0-9%$µμ]+/)) {
    if (token === '') continue
    const unit = unitOf(token)
    if (unit !== undefined) return unit
  }
  return undefined
}

/** A bare cell under a header that names a unit takes that unit, converted to base. */
function withHeaderUnit(cell: Cell, unit: Unit): Cell {
  if (cell.kind !== 'number' || cell.unit !== '' || cell.dim !== 'count') return cell
  if (cell.denominator !== undefined) return cell
  return {
    ...cell,
    value: cell.value * unit.factor,
    dim: unit.dim,
    unit: unit.token,
    ...(cell.to !== undefined && { to: cell.to * unit.factor }),
    ...(cell.upper !== undefined && { upper: cell.upper * unit.factor }),
  }
}

/** Numeric summary of a column's parsed cells. */
interface Summary {
  readonly numbers: readonly NumberCell[]
  readonly dominant: readonly NumberCell[]
  readonly dim: Dimension | undefined
  readonly mixed: boolean
}

/** Tally the numeric cells of a column by dimension. */
function summarize(cells: readonly Cell[]): Summary {
  const numbers = cells.filter(isNumber)
  const dims = new Map<Dimension, NumberCell[]>()
  for (const cell of numbers) {
    const group = dims.get(cell.dim)
    if (group) group.push(cell)
    else dims.set(cell.dim, [cell])
  }
  let dominant: NumberCell[] = []
  for (const group of dims.values()) if (group.length > dominant.length) dominant = group
  return {
    numbers,
    dominant,
    dim: dominant[0]?.dim,
    mixed: numbers.length > 0 && dominant.length / numbers.length < 0.8,
  }
}

/** Derive a column's role and values from its cells. */
function readColumn(index: number, header: string, cells: readonly Cell[]): TableColumn {
  const present = cells.filter(cell => cell.kind !== 'missing')
  const total = Math.max(1, present.length)
  const draft = summarize(cells)
  const scored = draft.numbers.filter(cell => cell.denominator !== undefined).length
  const scores = draft.numbers.length > 0 && scored / draft.numbers.length >= 0.8
  const values = scores
    ? cells.map((cell): Cell =>
        isNumber(cell) && cell.denominator !== undefined
          ? { ...cell, value: (100 * cell.value) / cell.denominator, dim: 'percent', unit: '%' }
          : cell,
      )
    : cells
  const summary = scores ? summarize(values) : draft
  const numberShare = summary.numbers.length / total
  const temporalShare = present.filter(cell => cell.kind === 'date').length / total
  const trimmed = header.trim()
  const bare = summary.numbers.length > 0 && summary.numbers.every(cell => cell.dim === 'count' && cell.unit === '')
  const sequential =
    index === 0 &&
    summary.numbers.length >= MIN_PROVEN_ROWS &&
    summary.numbers.length === present.length &&
    bare &&
    summary.numbers.every((cell, at) => cell.value === summary.numbers[0]!.value + at)
  const rising = summary.numbers.every((cell, at) => at === 0 || cell.value >= summary.numbers[at - 1]!.value)
  const falling = summary.numbers.every((cell, at) => at === 0 || cell.value <= summary.numbers[at - 1]!.value)
  let role: ColumnRole
  if (temporalShare >= 0.8) role = 'temporal'
  else if (numberShare >= 0.8 && (sequential || (bare && INDEX_HEADER.test(trimmed)))) role = 'index'
  else if (numberShare >= 0.8 && bare && SEQUENCE_HEADER.test(trimmed) && (rising || falling)) role = 'sequence'
  else if (numberShare >= 0.8) role = 'measure'
  // A mostly numeric column whose other cells are short status words (`TIMEOUT`, `MISS`).
  else if (numberShare >= 0.6 && present.every(cell => isNumber(cell) || cell.text.length <= 24))
    role = 'measure'
  else role = 'label'
  const numbers = summary.numbers
  return {
    index,
    header,
    role,
    cells: values,
    dim: summary.dim,
    unit: summary.dim === 'currency' || summary.dim === 'percent' ? (summary.dominant[0]?.unit ?? '') : '',
    mixed: summary.mixed,
    scores,
    constant: false,
    signedShare: numbers.length > 0 ? numbers.filter(cell => cell.signed).length / numbers.length : 0,
    arrowShare: numbers.length > 0 ? numbers.filter(cell => cell.to !== undefined).length / numbers.length : 0,
  }
}

/** Recompute the data-row facts that summary rows and missing cells would distort. */
function finishColumn(column: TableColumn, rows: readonly number[]): TableColumn {
  const values = rows.flatMap(row => {
    const cell = column.cells[row]
    return cell !== undefined && cell.kind === 'number' ? [cell.value] : []
  })
  return { ...column, constant: values.length > 0 && values.every(value => value === values[0]) }
}

/** Measure columns that only repeat another column: `pass%` beside `pass`, a share of a total. */
function restatedColumns(measures: readonly TableColumn[], rows: readonly number[]): Map<number, number> {
  const restated = new Map<number, number>()
  for (let at = 0; at < measures.length; at++) {
    for (const later of measures.slice(at + 1)) {
      const earlier = measures[at]!
      if (restated.has(earlier.index) || restated.has(later.index)) continue
      if (proportional(earlier, later, rows)) restated.set(later.index, earlier.index)
    }
  }
  return restated
}

/** `b = k·a` for one `k` in three or more rows where `a` varies, within one percent. */
function proportional(a: TableColumn, b: TableColumn, rows: readonly number[]): boolean {
  const pairs = rows.flatMap(row => {
    const x = plainValue(a, row)?.value
    const y = plainValue(b, row)?.value
    return x !== undefined && y !== undefined ? [[x, y] as const] : []
  })
  if (pairs.length < MIN_PROVEN_ROWS || pairs.some(([x, y]) => x <= 0 || y <= 0)) return false
  if (Math.max(...pairs.map(([x]) => x)) < 1.5 * Math.min(...pairs.map(([x]) => x))) return false
  const ratio = pairs[0]![1] / pairs[0]![0]
  return pairs.every(([x, y]) => Math.abs(y / x - ratio) <= ratio * 0.01)
}

/** The value of `column` at `row` as a plain number of the column's dimension. */
function plainValue(column: TableColumn, row: number): NumberCell | undefined {
  const cell = column.cells[row]
  return isNumber(cell) && cell.dim === column.dim && cell.upper === undefined && cell.to === undefined
    ? cell
    : undefined
}

/**
 * The exact sum relation among `measures`: one column equals two to four others
 * in every data row, within written precision, each part non-zero at least once.
 */
function compositionOf(measures: readonly TableColumn[], rows: readonly number[]): Composition | undefined {
  const pool = measures
    .filter(
      column =>
        !column.mixed &&
        column.arrowShare === 0 &&
        rows.every(row => {
          const cell = column.cells[row]
          return cell?.kind !== 'number' || (cell.value >= 0 && cell.upper === undefined && cell.to === undefined)
        }),
    )
    .slice(0, MAX_COMPOSED)
  let best: Composition | undefined
  for (const whole of pool) {
    const others = pool.filter(column => column.index !== whole.index && column.dim === whole.dim)
    for (const parts of subsets(others, 2, MAX_PARTS)) {
      if (!adds(whole, parts, rows)) continue
      if (best === undefined || parts.length > best.parts.length) {
        best = { whole: whole.index, parts: parts.map(column => column.index) }
      }
    }
  }
  return best
}

/** `parts` sum to `whole` in every row holding all of them, over three rows at least. */
function adds(whole: TableColumn, parts: readonly TableColumn[], rows: readonly number[]): boolean {
  let held = 0
  const used = new Set<number>()
  for (const row of rows) {
    const total = plainValue(whole, row)
    const values = parts.map(part => plainValue(part, row))
    if (total === undefined || values.some(value => value === undefined)) continue
    held++
    const sum = values.reduce((acc, value) => acc + value!.value, 0)
    if (Math.abs(sum - total.value) > 1e-9 * Math.max(1, Math.abs(total.value))) return false
    values.forEach((value, at) => {
      if (value!.value > 0) used.add(parts[at]!.index)
    })
  }
  return held >= MIN_PROVEN_ROWS && used.size === parts.length
}

/** Subsets of `items` between `min` and `max` long, shortest first, in items order. */
function subsets<T>(items: readonly T[], min: number, max: number): T[][] {
  const out: T[][] = []
  const grow = (start: number, picked: T[]) => {
    if (picked.length >= min) out.push(picked)
    if (picked.length === max) return
    for (let at = start; at < items.length; at++) grow(at + 1, [...picked, items[at]!])
  }
  grow(0, [])
  return out.sort((a, b) => a.length - b.length)
}

/** Whether a cell holds a quantity. */
function isNumber(cell: Cell | undefined): cell is NumberCell {
  return cell?.kind === 'number'
}
