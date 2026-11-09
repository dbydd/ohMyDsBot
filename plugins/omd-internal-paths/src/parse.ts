/**
 * Address parsing for internal paths. Pure: no registry, no I/O, no state.
 *
 * Canonical form is `dsh-resource://<source>/<path>`. The path is returned
 * exactly as written — no percent-decoding, no segment folding, query and hash
 * included — because the source owns its grammar. The shorthand
 * `<source>://<path>` is accepted only when the caller says that source
 * declared `shorthand`; without this check a file named `skill:12` would be
 * mistaken for a resource. `file://` and plain paths are not internal paths.
 *
 * @module omd-internal-paths/parse
 */

/** A source name: lowercase letters, digits, and `-`. */
export const SOURCE_NAME = /^[a-z0-9-]+$/

const CANONICAL = /^dsh-resource:(?:\/\/([a-z0-9-]*)(?:\/(.*))?)?$/su
const SHORTHAND = /^([a-z][a-z0-9-]*):\/\/(.*)$/su
const RESERVED_SCHEME = /^dsh-resource:/iu

/** One address split into its source and that source's own path. */
export interface AddressParts {
  /** Registered source name. */
  readonly source: string
  /** The remainder, untouched; empty when the address named no path. */
  readonly path: string
}

/**
 * Parse the canonical form.
 * @param address - the model- or client-supplied address.
 * @returns the source and path, or undefined when this is not a canonical internal address.
 */
export function parseCanonical(address: string): AddressParts | undefined {
  const match = CANONICAL.exec(address)
  if (match === null) return undefined
  if (!match[1]) {
    return { source: '', path: match[2] ?? '' }
  }
  return { source: match[1] ?? '', path: match[2] ?? '' }
}

/**
 * Parse the syntactic shorthand form, without checking whether the source
 * actually accepts shorthand.
 * @param address - the model-supplied address.
 * @returns the scheme-shaped source and path, or undefined when the string does not have that shape.
 */
export function parseShorthand(address: string): AddressParts | undefined {
  // The canonical scheme is reserved even when its own parse failed, so a
  // source can never claim it as a shorthand scheme.
  if (RESERVED_SCHEME.test(address)) return undefined
  const match = SHORTHAND.exec(address)
  if (match === null) return undefined
  return { source: match[1] ?? '', path: match[2] ?? '' }
}

/**
 * Resolve an address the way the service does: canonical form first, then
 * shorthand for sources the caller declares shorthand-capable.
 * @param address - the address to split.
 * @param acceptsShorthand - whether one source name may be written in shorthand.
 * @returns the source and path, or undefined when the address names no internal path here.
 */
export function parseAddress(
  address: string,
  acceptsShorthand: (source: string) => boolean,
): AddressParts | undefined {
  const canonical = parseCanonical(address)
  if (canonical !== undefined) return canonical
  const shorthand = parseShorthand(address)
  if (shorthand === undefined || !acceptsShorthand(shorthand.source)) return undefined
  return shorthand
}
