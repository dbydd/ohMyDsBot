/**
 * omp-style read selectors: parse the `:50-200` suffix grammar and turn file
 * text into a bounded, optionally multi-range window.
 *
 * A selector names line ranges only; numbering, caps, and context lines belong
 * to the caller. Parsing is pure, so a malformed suffix is reported before any
 * filesystem work.
 *
 * @module omd-read/selector
 */

/** One requested line range, 1-based and inclusive. */
export interface Range {
  start: number
  /** Last line, inclusive. Undefined reads through end of file. */
  end?: number
  /** Set instead of `end` for a tail selector (`:-60`): the last N lines. */
  tail?: number
}

/** A parsed selector. */
export interface Selector {
  /** `raw` suppresses line numbers. */
  raw: boolean
  /** A bare `:raw` names no range: the caller keeps its default window. */
  ranges: Range[]
}

const RANGE_PIECE = /^(?:(\d+)|(\d+)-(\d*)|(\d+)\+(\d+)|-(\d+))$/u

/**
 * Parse the text after the last path colon as a selector.
 * @param suffix - the candidate selector text, without its leading colon.
 * @returns the parsed selector, or undefined when the text is not selector grammar.
 * An empty range list is valid when `raw` was asked for: `path:raw` means the
 * default window, unnumbered.
 */
export function parseSelectorSuffix(suffix: string): Selector | undefined {
  if (suffix.trim() === '') return undefined
  let raw = false
  const ranges: Range[] = []
  for (const chunk of suffix.split(':')) {
    if (chunk.toLowerCase() === 'raw') {
      raw = true
      continue
    }
    for (const piece of chunk.split(',')) {
      const match = RANGE_PIECE.exec(piece)
      if (match === null) return undefined
      if (match[6] !== undefined) {
        const count = Number(match[6])
        if (count < 1) return undefined
        ranges.push({ start: 1, tail: count })
        continue
      }
      if (match[4] !== undefined) {
        const start = Number(match[4])
        const count = Number(match[5])
        if (start < 1 || count < 1) return undefined
        ranges.push({ start, end: start + count - 1 })
        continue
      }
      if (match[2] !== undefined) {
        const start = Number(match[2])
        if (start < 1) return undefined
        if (match[3] === '') {
          ranges.push({ start })
          continue
        }
        const end = Number(match[3])
        if (end < start) return undefined
        ranges.push({ start, end })
        continue
      }
      const single = Number(match[1])
      if (single < 1) return undefined
      ranges.push({ start: single, end: single })
    }
  }
  return ranges.length === 0 && !raw ? undefined : { raw, ranges }
}

/** Split a raw `path:selector` argument into its path and selector text. */
export function splitPathSelector(rawPath: string): { path: string; suffix?: string } {
  const colon = rawPath.lastIndexOf(':')
  // Avoid splitting a Windows drive letter or a bare `host:port`.
  if (colon <= 1) return { path: rawPath }
  return { path: rawPath.slice(0, colon), suffix: rawPath.slice(colon + 1) }
}

/** One line of the window. */
export interface WindowLine {
  number: number
  text: string
}

/** A built window. */
export interface WindowResult {
  lines: WindowLine[]
  totalLines: number
  truncatedByBytes: boolean
  /** Ranges that started past the end of the file, rendered as notices. */
  beyondEnd: Range[]
}

/** Everything one window build needs. */
export interface WindowRequest {
  /** Parsed selector; undefined reads one forward window from `offset`. */
  selector?: Selector
  offset: number
  limit: number
  /** Hard cap on returned lines, whatever the selector asked for. */
  maxLines: number
  /** Lines kept before an explicitly bounded single range. */
  contextBefore: number
  /** Lines kept after an explicitly bounded single range. */
  contextAfter: number
  maxLineLength: number
  maxBytes: number
}

/** Largest tail a `:-N` selector may request, as a guard against buffering a file. */
const MAX_TAIL_LINES = 20_000

/**
 * Build the window for one read over streamed text.
 *
 * One pass counts every line and keeps only the planned ones, so a large file
 * never lands in memory while the total stays exact. A `:-N` tail is resolved
 * from a bounded ring filled during the same pass.
 * @param chunks - decoded text chunks in file order.
 * @param request - the resolved window request.
 * @param displayPath - the caller-facing path used in range errors.
 * @returns the kept lines, the exact total, and any cap or bounds facts.
 */
export async function buildWindow(
  chunks: AsyncIterable<string> | Iterable<string>,
  request: WindowRequest,
  displayPath: string,
): Promise<WindowResult> {
  const selector = request.selector
  const lineBudget = Math.min(request.limit, request.maxLines)
  let byteBudget = request.maxBytes
  let truncatedByBytes = false
  const kept: WindowLine[] = []
  const beyondEnd: Range[] = []

  // Context only expands a single explicitly bounded range: an open range has
  // no line after its end, and eliding several ranges keeps `…` gaps honest.
  const planned: { start: number; end: number }[] = []
  if (selector === undefined) {
    planned.push({ start: request.offset, end: request.offset + lineBudget - 1 })
  } else {
    const single = selector.ranges.length === 1 ? selector.ranges[0] : undefined
    const expand = single !== undefined && single.tail === undefined && single.end !== undefined
    for (const range of selector.ranges) {
      if (range.tail !== undefined) continue
      const end = range.end ?? Number.MAX_SAFE_INTEGER
      planned.push(expand
        ? { start: Math.max(1, range.start - request.contextBefore), end: end + request.contextAfter }
        : { start: range.start, end })
    }
  }
  const wanted = (number: number): boolean => planned.some(range => number >= range.start && number <= range.end)

  const push = (number: number, raw: string): void => {
    if (kept.length >= lineBudget) {
      truncatedByBytes = true
      return
    }
    const text = raw.length > request.maxLineLength
      ? `${raw.slice(0, request.maxLineLength)}... (line truncated to ${request.maxLineLength} chars)`
      : raw
    const size = Buffer.byteLength(text, 'utf8') + (kept.length > 0 ? 1 : 0)
    if (size > byteBudget) {
      truncatedByBytes = true
      return
    }
    byteBudget -= size
    kept.push({ number, text })
  }

  const tailSize = Math.min(
    MAX_TAIL_LINES,
    Math.max(0, ...(selector?.ranges ?? []).map(range => range.tail ?? 0)),
  )
  const ring: string[] = []
  let totalLines = 0
  let lineBuffer = ''

  for await (const chunk of chunks) {
    let start = 0
    let newline = -1
    while ((newline = chunk.indexOf('\n', start)) !== -1) {
      lineBuffer += chunk.slice(start, newline)
      totalLines += 1
      const text = lineBuffer.endsWith('\r') ? lineBuffer.slice(0, -1) : lineBuffer
      if (wanted(totalLines)) push(totalLines, text)
      if (tailSize > 0) {
        ring.push(text)
        if (ring.length > tailSize) ring.shift()
      }
      lineBuffer = ''
      start = newline + 1
    }
    lineBuffer += chunk.slice(start)
  }
  if (lineBuffer.length > 0) {
    totalLines += 1
    const text = lineBuffer.endsWith('\r') ? lineBuffer.slice(0, -1) : lineBuffer
    if (wanted(totalLines)) push(totalLines, text)
    if (tailSize > 0) {
      ring.push(text)
      if (ring.length > tailSize) ring.shift()
    }
  }

  if (selector !== undefined) {
    for (const range of selector.ranges) {
      if (range.tail !== undefined) {
        if (range.tail > totalLines) {
          beyondEnd.push(range)
          continue
        }
        const from = totalLines - range.tail + 1
        for (let number = from; number <= totalLines; number += 1) push(number, ring[number - from] ?? '')
        continue
      }
      if (range.start > totalLines && !(totalLines === 0 && range.start === 1)) beyondEnd.push(range)
    }
    kept.sort((a, b) => a.number - b.number)
    const unique: WindowLine[] = []
    for (const line of kept) if (unique.at(-1)?.number !== line.number) unique.push(line)
    kept.length = 0
    kept.push(...unique)
  } else if (kept.length === 0 && totalLines > 0) {
    throw new Error(`offset ${request.offset} is out of range for "${displayPath}" (${totalLines} lines)`)
  }

  return { lines: kept, totalLines, truncatedByBytes, beyondEnd }
}

/**
 * Render one text window as the model-facing envelope.
 * @param displayPath - the resolved path for the envelope's `<path>` element.
 * @param result - the built window.
 * @param options - numbering and footer policy.
 * @returns the envelope text.
 */
export function formatRead(
  displayPath: string,
  result: WindowResult,
  options: { lineNumbers: boolean; footer: string },
): string {
  const body: string[] = []
  let previous: number | undefined
  for (const line of result.lines) {
    if (previous !== undefined && line.number > previous + 1) body.push('…')
    body.push(options.lineNumbers ? `${line.number}|${line.text}` : line.text)
    previous = line.number
  }
  const notices = result.beyondEnd.map(range => {
    const bound = range.tail !== undefined
      ? `-${range.tail}`
      : range.end === undefined ? `${range.start}-` : `${range.start}-${range.end}`
    return `[Range ${bound} is beyond end of file (${result.totalLines} lines total); skipped]`
  })
  const footer = [
    ...result.truncatedByBytes ? ['(Output capped. Narrow the selector to read further.)'] : [],
    options.footer,
    ...notices,
  ].filter(part => part !== '').join('\n')
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${body.length === 0 ? footer : `${body.join('\n')}\n\n${footer}`}
</content>`
}
