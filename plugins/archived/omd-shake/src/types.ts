/**
 * Vocabulary for `/shake`: the accepted strategies, the text every marker and
 * no-op uses, and the report one run returns.
 *
 * @module omd-shake/types
 */

/** The strategies `/shake` accepts, in the order its hint lists them. */
export const SHAKE_MODES = ['elide', 'images', 'thinking'] as const

/** One `/shake` strategy. */
export type ShakeMode = (typeof SHAKE_MODES)[number]

/** Default number of most recent entries a run leaves untouched. */
export const DEFAULT_RECENT_KEEP = 6

/** Model-facing text for an elided tool result with no recoverable reference. */
export const ELIDED_TEXT = '(elided)'

/**
 * Prefix shared by every elision marker. A result whose content is exactly one
 * text block starting with this prefix is already shaken, so a second run
 * leaves it alone instead of appending another replacement.
 */
export const ELIDED_PREFIX = '(elided'

/** Text kept in place of removed image blocks when a message would otherwise be empty. */
export const IMAGE_ELIDED_TEXT = '(image elided)'

/** No-op text for `elide` when no older tool result is left to replace. */
export const NOTHING_TO_SHAKE = 'Nothing to shake'

/** No-op text for `images` when no older message carries an image. */
export const NO_IMAGES_FOUND = 'No images found'

/** No-op text for `thinking` when no older message carries reasoning. */
export const NO_THINKING_FOUND = 'No thinking blocks found'

/** Refusal while a turn is open: a rewrite would race the request in flight. */
export const WAIT_FOR_RESPONSE = 'Wait for the current response to finish or abort it before shaking.'

/** Marker spelling of a spill notice's recovery address, inside its full notice. */
export const SPILL_LOCATION = ' Full formatted result stored at: '

/** One parsed command argument: the strategy to run, or why the argument is unusable. */
export type ShakeArgument =
  | { readonly kind: 'mode'; readonly mode: ShakeMode }
  | { readonly kind: 'error'; readonly text: string }

/**
 * Parse the command's optional strategy argument.
 * @param rawInput - exact text following the command name, separator whitespace included.
 * @returns the strategy to run, defaulting to `elide`, or the error to render.
 */
export function parseShakeArgument(rawInput: string): ShakeArgument {
  const word = rawInput.trim().toLowerCase()
  if (word.length === 0) return { kind: 'mode', mode: 'elide' }
  const found = SHAKE_MODES.find(candidate => candidate === word)
  if (found !== undefined) return { kind: 'mode', mode: found }
  return {
    kind: 'error',
    text: `Unknown shake mode "${word}". Use ${SHAKE_MODES.join(', ')}; the default is elide.`,
  }
}

/**
 * What one `/shake` run changed, measured over the durable events it read.
 *
 * Byte totals cover real content: `bytesBefore` is the UTF-8 length of the
 * model-facing text or the image bytes the run replaced, and `bytesAfter` is
 * what replaced them — the elision marker, or the placeholder left behind by
 * removed images. `thinking` removes nothing, so both totals describe the same
 * reasoning bytes. A no-op reports zero everywhere and an empty
 * {@link shadowedSeqs}.
 */
export interface ShakeReport {
  /** Strategy the run applied. */
  readonly mode: ShakeMode
  /** Tool results whose content was replaced by an elision marker (`elide`). */
  readonly toolResultsElided: number
  /** Image blocks removed from older messages (`images`). */
  readonly imagesRemoved: number
  /** Reasoning blocks found in older messages (`thinking`; this strategy removes nothing). */
  readonly thinkingBlocksFound: number
  /** Older messages carrying at least one reasoning block (`thinking`). */
  readonly thinkingMessages: number
  /** UTF-8 bytes of the content the run replaced or measured, before the rewrite. */
  readonly bytesBefore: number
  /** UTF-8 bytes of what replaced the removed content. */
  readonly bytesAfter: number
  /** Surface seqs the replacements shadow, in model-visible order. */
  readonly shadowedSeqs: readonly number[]
}
