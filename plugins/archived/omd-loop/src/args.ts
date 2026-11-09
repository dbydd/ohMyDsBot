/**
 * `/loop` argument grammar: an optional leading iteration count or duration,
 * then the loop body prompt.
 *
 * The grammar is deliberate about ambiguity. A leading token that *looks* like
 * a limit (starts with a digit or sign) but does not parse is a hard error, so
 * a typo cannot silently become prompt text. Anything else is prompt text, so
 * `/loop keep fixing the tests` starts an unbounded loop over that sentence.
 * `off`, `stop`, and `cancel` are recognised only as the whole input, leaving
 * `/loop off the lights` a prompt.
 *
 * @module omd-loop/args
 */

/** Registered command name, without the leading slash. */
export const LOOP_COMMAND = 'loop'

/** Error text for limit-shaped input that does not parse and for zero budgets. */
export const LOOP_USAGE
  = 'Usage: /loop [count|duration] [prompt], or /loop off to stop. '
  + 'Examples: /loop 10, /loop 90s, /loop 10 minutes, /loop 3 fix the failing tests.'

/** One parsed invocation. */
export type LoopSpec =
  | { readonly kind: 'status' }
  | { readonly kind: 'off' }
  | {
    readonly kind: 'arm'
    /** Loop body; `null` arms the limit and waits for the user's next prompt. */
    readonly prompt: string | null
    /** Iteration budget; `null` when the loop has no iteration limit. */
    readonly remaining: number | null
    /** Wall-clock budget from now; `null` when the loop has no duration limit. */
    readonly durationMs: number | null
  }

/** Spelled-out duration units accepted after a bare integer (`/loop 10 minutes`). */
const UNIT_WORDS_MS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
}

/** Compact duration units accepted inside one token (`/loop 90s`, `/loop 1h30m`). */
const COMPACT_UNITS_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
}

/** Inputs that close an armed loop. */
const OFF_WORDS: Record<string, true> = { off: true, stop: true, cancel: true }

/**
 * Parse a leading compact duration token such as `90s`, `10m`, or `1h30m`.
 * @param token - one whitespace-delimited lowercased token.
 * @returns milliseconds, or `null` when the token is not a compact duration.
 */
function parseCompactDuration(token: string): number | null {
  const pattern = /(\d+)([smh])/gu
  let total = 0
  let consumed = 0
  for (let match = pattern.exec(token); match !== null; match = pattern.exec(token)) {
    if (match.index !== consumed) return null
    const digits = match[1]
    const unit = match[2]
    if (digits === undefined || unit === undefined) return null
    const unitMs = COMPACT_UNITS_MS[unit]
    if (unitMs === undefined) return null
    total += Number(digits) * unitMs
    consumed += match[0].length
  }
  if (consumed !== token.length || total <= 0 || !Number.isSafeInteger(total)) return null
  return total
}

/**
 * Split raw command input into a loop specification.
 * @param raw - exact text after the command name, separator whitespace included.
 * @returns the specification, or the usage text when the input is limit-shaped but invalid.
 */
export function parseLoopArgs(raw: string): LoopSpec | string {
  const trimmed = raw.trim()
  if (trimmed === '') return { kind: 'status' }
  if (OFF_WORDS[trimmed.toLowerCase()] === true) return { kind: 'off' }

  const separator = trimmed.search(/\s/u)
  const head = separator === -1 ? trimmed : trimmed.slice(0, separator)
  const rest = separator === -1 ? '' : trimmed.slice(separator + 1).trim()
  const prompt = rest === '' ? null : rest

  if (!/^[+-]?\d/u.test(head)) {
    return { kind: 'arm', prompt: trimmed, remaining: null, durationMs: null }
  }

  const token = head.toLowerCase()
  if (/^\d+$/u.test(token)) {
    const count = Number(token)
    const unitToken = (/^\S+/u.exec(rest)?.[0] ?? '').toLowerCase()
    const unitMs = UNIT_WORDS_MS[unitToken]
    if (unitMs !== undefined) {
      if (count <= 0) return LOOP_USAGE
      const body = rest.slice(unitToken.length).trim()
      return { kind: 'arm', prompt: body === '' ? null : body, remaining: null, durationMs: count * unitMs }
    }
    if (count <= 0) return LOOP_USAGE
    return { kind: 'arm', prompt, remaining: count, durationMs: null }
  }

  const durationMs = parseCompactDuration(token)
  if (durationMs === null) return LOOP_USAGE
  return { kind: 'arm', prompt, remaining: null, durationMs }
}

/**
 * Render a millisecond span the way `/loop` reports remaining time.
 * @param ms - span in milliseconds; values at or below zero render as `0s`.
 * @returns a compact span such as `90s`, `9m 30s`, or `1h 2m`.
 */
export function describeSpan(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`)
  return parts.join(' ')
}
