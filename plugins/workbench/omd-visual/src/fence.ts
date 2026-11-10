/**
 * Reading the one fenced block a visual child is told to produce.
 *
 * The fence is the whole contract: the child has no tool that could hand a
 * document over, so the parent parses its text. The three languages are the
 * ones the host renderer recognises, and the raw text — markers included — is
 * what gets stored in the record, because the client hands that exact string
 * back to the renderer's own fence scanner.
 *
 * @module omd-visual/fence
 */

/** The languages the renderer turns into UI. */
export type FenceLanguage = 'dsh-ui' | 'motion-ui' | 'svg'

/** One complete fenced block. */
export interface ExtractedFence {
  /** Raw text from the opening marker through the closing marker. */
  readonly raw: string
  /** Language the child marked the block with. */
  readonly language: FenceLanguage
  /** Text between the markers, untrimmed. */
  readonly body: string
}

/** The reply that means "this answer does not need a picture". */
export const NO_VISUAL = 'NO_VISUAL'

/** Upper bound on one document, matching the renderer's own limit. */
export const MAX_FENCE_BYTES = 128 * 1024

/** Opening marker: three backticks or tildes followed by a recognised language. */
const OPENING = /^\s*(`{3,}|~{3,})\s*(dsh-ui|motion-ui|svg)\s*$/iu
/** Closing marker: the same run character, nothing else on the line. */
const CLOSING = /^\s*(`{3,}|~{3,})\s*$/u

/**
 * Whether the child declined to visualize.
 * @param text - the child's final text.
 * @returns `true` for `NO_VISUAL`, ignoring case and trailing punctuation.
 */
export function saysNoVisual(text: string): boolean {
  const normalized = text.trim().replace(/[.。]+$/u, '').toUpperCase()
  return normalized === NO_VISUAL
}

/**
 * Whether a body is the document shape its language promises.
 * @param language - fence language.
 * @param body - text between the markers.
 * @returns `true` when the body can reach the renderer as-is.
 */
function bodyIsWellFormed(language: FenceLanguage, body: string): boolean {
  if (language === 'svg') return /<svg[\s>]/iu.test(body)
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
  } catch {
    return false
  }
}

/**
 * Find the first complete, well-formed fence in a child reply.
 *
 * A block that opens and never closes is not a deliverable — the child was cut
 * off mid-document — so it is skipped rather than half-used.
 * @param text - the child's final text.
 * @returns the fence, or `undefined` when the reply carries none.
 */
export function extractFence(text: string): ExtractedFence | undefined {
  const lines = text.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const opening = OPENING.exec(lines[index] ?? '')
    if (opening === null) continue
    const run = opening[1]?.[0] ?? '`'
    const language = (opening[2] ?? '').toLowerCase() as FenceLanguage
    let close = -1
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const marker = CLOSING.exec(lines[cursor] ?? '')
      if (marker !== null && (marker[1]?.[0] ?? '`') === run) {
        close = cursor
        break
      }
    }
    if (close === -1) continue
    const body = lines.slice(index + 1, close).join('\n')
    if (Buffer.byteLength(body, 'utf8') > MAX_FENCE_BYTES) continue
    if (!bodyIsWellFormed(language, body)) continue
    return {
      raw: lines.slice(index, close + 1).join('\n'),
      language,
      body: body.trim(),
    }
  }
  return undefined
}

/**
 * The document's own title or fallback, read from a JSON body.
 *
 * Both are optional decorations for the card; a body that parses but carries
 * neither simply leaves them out.
 * @param fence - the extracted fence.
 * @returns the fields the card can show.
 */
export function fenceLabels(fence: ExtractedFence): { title?: string; fallback?: string } {
  if (fence.language === 'svg') return {}
  try {
    const parsed: unknown = JSON.parse(fence.body)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const record = parsed as { title?: unknown; fallback?: unknown }
    return {
      ...typeof record.title === 'string' && record.title.trim() !== '' ? { title: record.title.trim() } : {},
      ...typeof record.fallback === 'string' && record.fallback.trim() !== ''
        ? { fallback: record.fallback.trim() }
        : {},
    }
  } catch {
    return {}
  }
}
