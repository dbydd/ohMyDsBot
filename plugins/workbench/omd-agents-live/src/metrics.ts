/**
 * Heuristic metric extraction for the ticker's `metrics`/`headline` fields.
 *
 * This is deliberately NOT a general log parser. It scans the last lines of
 * one text (a tool result, an assistant message, or a job's output tail) for
 * the shape training and benchmark logs use:
 *
 *   mpsnr 40.20 dB ▼5.7% · ssim 0.9445 ▼1.0% · sam 2.37 ▲14%
 *   best mpsnr 40.20 dB · best @ iter 10.0k
 *
 * A candidate is `name value [unit]`; a change, when present, is the `▲/▼/±`
 * or `+x%`/`-x%` immediately after it. A decimal value is a candidate on its
 * own, which is the shape training logs use (`loss 0.1234`, `val acc 0.87 · val
 * loss 0.31`); a whole number qualifies only with a unit or a change. A line is
 * then accepted when it carries two candidates, names what it measures
 * (`loss`, `best`, `val`, …), or holds one candidate that has a unit or a
 * change. So `bash grep -c . package.json` followed by `2`, `step 3 done`, and
 * `wrote 12 files` yield nothing while `p95 1200 ms` yields one metric. Nothing
 * is inferred: no metric yields no headline, and the caller turns the empty
 * result into `null`.
 *
 * @module omd-agents-live/metrics
 */

import type { HeadlineEntry, MetricEntry } from './types.ts'

/** How many lines of the supplied text are considered. */
export const METRIC_WINDOW_LINES = 40

/** Upper bound on returned metrics; later matches are dropped. */
export const MAX_METRICS = 6

/**
 * A name is a short identifier (`mpsnr`, `ssim`, `train/loss`), never a plain
 * number and never a sentence word: stop words are rejected after matching so
 * `3 of 5` and `at 12:00` cannot become metrics.
 */
const NAME = String.raw`[A-Za-z_][\w./-]{1,19}`

/** Value with optional sign and decimal part. */
const VALUE = String.raw`[+-]?\d+(?:\.\d+)?`

/**
 * A short unit token: `dB`, `ms`, `%`, `k`, `GB/s`. The trailing letter guard
 * keeps a longer word (`lines`, `files`) from being truncated into a unit that
 * the log never wrote.
 */
const UNIT = String.raw`[A-Za-zµ%]{1,4}(?:\/[A-Za-z]{1,3})?(?![A-Za-z])`

/** `name value [unit]`, requiring whitespace or `:`/`=` between name and value. */
const METRIC = new RegExp(String.raw`(?<![\w./-])(${NAME})[ \t]*[:=]?[ \t]+(${VALUE})(?:[ \t]*(${UNIT}))?`, 'gu')

/** Slope markers: `▲5.7%`, `▼1.0%`, `±0.3`, `+3%`, `-2%` (percent required for ASCII signs). */
const DELTA_SYMBOL = /^[ \t]*([▲▼±])\s*(\d+(?:\.\d+)?)[ \t]*%?/u
const DELTA_ASCII = /^[ \t]*([+\-−])\s*(\d+(?:\.\d+)?)[ \t]*%/u

/**
 * Words that make a line's numbers worth reading even when it carries only one
 * candidate. Without one of these a lone `name value` is noise.
 */
const METRIC_CONTEXT = /\b(?:metric|metrics|loss|acc|score|best|val|test|eval)\b/iu

/** `best <name> <value> [unit]`, or `best @ iter <value>` / `@ iter <value>`. */
const NOTE_BEST_METRIC = new RegExp(String.raw`\bbest\s+${NAME}\s+${VALUE}(?:\s*${UNIT})?`, 'u')
const NOTE_ITER = /\bbest\s+@\s*iter\s+[+-]?\d+(?:\.\d+)?[kKmM]?|@\s*iter\s+[+-]?\d+(?:\.\d+)?[kKmM]?/u

/** Ordinary English words that appear right before a number and are not metric names. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'had', 'has', 'have',
  'in', 'into', 'is', 'it', 'iter', 'of', 'on', 'or', 'over', 'per', 'ran', 'step',
  'than', 'that', 'the', 'then', 'this', 'to', 'under', 'was', 'were', 'with',
])

/**
 * Extract `metrics` and a `headline` from up to the last 40 lines of `text`.
 * @param text - one tool result, one assistant message, or a job's output tail.
 * @returns the metrics found (at most six, first occurrence per name) and the
 *   first metric carrying a change as the headline; empty/`null` when the text
 *   has no `name value` shape.
 */
export function extractMetrics(text: string): { metrics: MetricEntry[]; headline: HeadlineEntry | null } {
  const window = lastLines(text, METRIC_WINDOW_LINES)
  if (window === '') return { metrics: [], headline: null }
  const found: { metric: MetricEntry; rawValue: string }[] = []
  const seen = new Set<string>()
  for (const line of window.split('\n')) {
    const candidates = lineCandidates(line)
    if (!lineAccepted(line, candidates)) continue
    for (const candidate of candidates) {
      const { label } = candidate.metric
      if (seen.has(label)) continue
      seen.add(label)
      found.push(candidate)
      if (found.length >= MAX_METRICS) break
    }
    if (found.length >= MAX_METRICS) break
  }
  const metrics = found.map(entry => entry.metric)
  const first = found.find(entry => entry.metric.delta !== null)
  if (first === undefined) return { metrics, headline: null }
  const unit = first.metric.unit === null ? '' : ` ${first.metric.unit}`
  return {
    metrics,
    headline: { label: `${first.rawValue}${unit}`, delta: first.metric.delta ?? 0, note: noteNear(window) },
  }
}

/**
 * Whether a line's candidates are worth reporting.
 *
 * Two candidates speak for themselves, so does a line that names what it
 * measures; a single candidate is enough only when its unit or change already
 * marks it as a measurement rather than a count.
 * @param line - one line of the window.
 * @param candidates - the candidates found on it.
 * @returns `true` when the line's candidates are accepted.
 */
function lineAccepted(
  line: string,
  candidates: { metric: MetricEntry; rawValue: string }[],
): boolean {
  if (candidates.length >= 2) return true
  if (METRIC_CONTEXT.test(line)) return true
  if (candidates.length !== 1) return false
  const { unit, delta } = candidates[0]!.metric
  return unit !== null || delta !== null
}

/**
 * Take the last `count` lines of a text.
 * @param text - source text.
 * @param count - line budget.
 * @returns the joined tail; empty input yields an empty string.
 */
export function lastLines(text: string, count: number): string {
  if (text === '') return ''
  return text.split(/\r?\n/u).slice(-count).join('\n')
}

/**
 * Metric candidates on one line.
 *
 * A decimal value is a measurement on its own; a whole number needs a unit or a
 * change, which is what drops `12` from `wrote 12 files`. Stop words drop
 * `step 3` before that check.
 * @param line - one line of the window.
 * @returns the candidates in the order they appear.
 */
function lineCandidates(line: string): { metric: MetricEntry; rawValue: string }[] {
  const candidates: { metric: MetricEntry; rawValue: string }[] = []
  METRIC.lastIndex = 0
  for (let match = METRIC.exec(line); match !== null; match = METRIC.exec(line)) {
    const name = match[1]
    const rawValue = match[2]
    if (name === undefined || rawValue === undefined) continue
    if (STOP_WORDS.has(name.toLowerCase())) continue
    const value = Number(rawValue)
    if (!Number.isFinite(value)) continue
    const unit = match[3] ?? null
    const delta = readDelta(line.slice(match.index + match[0].length))
    if (!rawValue.includes('.') && unit === null && delta === null) continue
    candidates.push({ metric: { label: name, value, unit, delta }, rawValue })
  }
  return candidates
}

/**
 * Read a change marker that starts at the beginning of `rest`.
 * @param rest - text right after a metric match.
 * @returns the signed change, or `null` when the next token is not a marker.
 */
function readDelta(rest: string): number | null {
  const symbol = DELTA_SYMBOL.exec(rest)
  if (symbol !== null) {
    const magnitude = Number(symbol[2])
    if (!Number.isFinite(magnitude)) return null
    return symbol[1] === '▲' ? magnitude : -magnitude
  }
  const ascii = DELTA_ASCII.exec(rest)
  if (ascii === null) return null
  const magnitude = Number(ascii[2])
  if (!Number.isFinite(magnitude)) return null
  return ascii[1] === '-' || ascii[1] === '−' ? -magnitude : magnitude
}

/**
 * Find the contextual `best …`/`@ iter …` phrase for the headline.
 * @param window - the same text the metrics were read from.
 * @returns the matched phrase verbatim, or `null`.
 */
function noteNear(window: string): string | null {
  const iter = NOTE_ITER.exec(window)
  if (iter !== null) return iter[0].trim()
  const best = NOTE_BEST_METRIC.exec(window)
  return best === null ? null : best[0].trim()
}
