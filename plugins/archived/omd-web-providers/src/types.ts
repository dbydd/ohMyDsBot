/**
 * Internal vocabulary shared by every provider in this package: the failure
 * taxonomy the auto chains route on, the private-network guard, the
 * data-URI scrubber, and the low-quality-output gate.
 *
 * None of this is exported from the package root; it exists so the providers
 * agree on what "failed in a way worth trying the next provider for" means.
 *
 * @module omd-web-providers/types
 */

/** Why one provider call did not produce a usable result. */
export type ProviderFailureKind =
  | 'transient'
  | 'quota'
  | 'network'
  | 'credential'
  | 'config'
  | 'aborted'
  | 'invalid-response'
  | 'unsupported'

/**
 * One provider call's failure, with the HTTP status carried as a field rather
 * than scraped back out of the message text.
 *
 * `dsh-web` reports non-2xx fetch responses as RESULTS, so a status here is
 * always about the provider's own API, never about the resource being fetched.
 */
export class ProviderFailure extends Error {
  /** The route this failure belongs to. */
  readonly kind: ProviderFailureKind
  /** HTTP status of the provider API call, when one was received. */
  readonly status?: number

  /**
   * @param message already-redacted human-readable cause
   * @param kind the route the auto chain should take
   * @param options HTTP status (when received) and the original cause
   */
  constructor(message: string, kind: ProviderFailureKind, options?: { status?: number, cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProviderFailure'
    this.kind = kind
    if (options?.status !== undefined) this.status = options.status
  }
}

/**
 * Kinds the auto chains walk past: trying the next provider is a reasonable
 * response. `credential`, `config`, and `aborted` are absent on purpose — a
 * wrong key must fail loudly instead of silently burning the whole chain.
 */
export const FALLBACK_KINDS: readonly ProviderFailureKind[] = [
  'transient',
  'quota',
  'network',
  'invalid-response',
  'unsupported',
]

/** True when `kind` is one the auto chain may continue past. */
export function isFallbackKind(kind: ProviderFailureKind): boolean {
  return FALLBACK_KINDS.includes(kind)
}

/**
 * Map a provider API status to a failure kind.
 *
 * 401/403 is a credential problem, 402/429 a quota problem, 408 and 5xx are
 * worth retrying elsewhere, and the 4xx codes a well-formed request would never
 * produce mean the vendor's response shape moved under us.
 * @param status HTTP status returned by the provider API
 */
export function kindForStatus(status: number): ProviderFailureKind {
  if (status === 401 || status === 403) return 'credential'
  if (status === 402 || status === 429) return 'quota'
  if (status === 408 || (status >= 500 && status <= 599)) return 'transient'
  return 'invalid-response'
}

/**
 * Remove credential material from text before it reaches a log line or an
 * error message. Vendor error bodies routinely echo the key back at the caller.
 * @param text text possibly containing secrets
 * @param secrets the resolved secret values to redact
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text
  for (const secret of secrets) {
    // A one- or two-character "key" would redact half the message.
    if (secret !== undefined && secret.length >= 4) out = out.split(secret).join('[redacted]')
  }
  return out
}

/** Longest provider error body kept in a message; the rest is dropped. */
const ERROR_BODY_LIMIT = 240

/**
 * Shape a provider error body into a safe one-line message.
 * @param body response body text, possibly echoing the request
 * @param secrets resolved secret values to redact
 */
export function safeErrorDetail(body: string, secrets: readonly (string | undefined)[]): string {
  const oneLine = redactSecrets(body, secrets).replace(/\s+/g, ' ').trim()
  return oneLine.length > ERROR_BODY_LIMIT ? `${oneLine.slice(0, ERROR_BODY_LIMIT)}…` : oneLine
}

/** True when `host` is a bare IPv4 literal with four decimal octets. */
function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

/** Parse a dotted-quad into octets, or `undefined` when any octet is out of range. */
function ipv4Octets(host: string): number[] | undefined {
  const parts = host.split('.')
  const octets = parts.map(Number)
  if (octets.length !== 4) return undefined
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return undefined
  return octets
}

/**
 * True when an IPv4 literal sits in loopback, RFC1918, link-local, or
 * carrier-grade NAT space. The `172` arm carries its own upper bound because
 * only 172.16.0.0/12 is private; 172.32.0.0 is public space.
 */
function isPrivateIpv4(host: string): boolean {
  const octets = ipv4Octets(host)
  if (octets === undefined) return false
  const [a, b] = [octets[0]!, octets[1]!]
  return a === 127 // 127.0.0.0/8 loopback
    || a === 10 // 10.0.0.0/8
    || (a === 172 && b >= 16 && b <= 31) // 172.16.0.0/12
    || (a === 192 && b === 168) // 192.168.0.0/16
    || (a === 169 && b === 254) // 169.254.0.0/16 link-local (cloud metadata lives here)
    || (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 carrier-grade NAT
}

/**
 * True when an IPv4 literal falls inside `a.b.c.d/prefix`. Shifts with `>>>`
 * so the mask never becomes a negative int32.
 */
function inIpv4Cidr(host: string, cidr: string): boolean {
  const [range, prefixText] = cidr.split('/')
  if (range === undefined || prefixText === undefined) return false
  const prefix = Number(prefixText)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
  const hostOctets = ipv4Octets(host)
  const rangeOctets = ipv4Octets(range)
  if (hostOctets === undefined || rangeOctets === undefined) return false
  let bits = prefix
  for (let i = 0; i < 4; i += 1) {
    const take = Math.max(0, Math.min(8, bits))
    const mask = take === 0 ? 0 : (0xFF << (8 - take)) & 0xFF
    if ((hostOctets[i]! & mask) !== (rangeOctets[i]! & mask)) return false
    bits -= take
  }
  return true
}

/**
 * True when `host` resolves only inside this machine or a private network.
 *
 * IPv6 covers `::1`, the unspecified address, unique-local `fc00::/7`, and
 * link-local `fe80::/10` — the last two are the IPv6 equivalents of RFC1918
 * and link-local IPv4, and shipping them to a remote reader would be the same
 * leak.
 */
function isPrivateHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '') return false
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '0.0.0.0' || host === '::' || host === '::1') return true
  if (isIpv4(host)) return isPrivateIpv4(host)
  if (host.includes(':')) {
    if (host.startsWith('fc') || host.startsWith('fd')) return true
    if (/^fe[89ab][0-9a-f]/.test(host)) return true
  }
  return false
}

/** True when `host` matches one `allowRanges` entry (exact IP or IPv4 CIDR). */
function matchesAllowRange(host: string, allowRanges: readonly string[]): boolean {
  const bare = host.toLowerCase().replace(/^\[|\]$/g, '')
  return allowRanges.some((range) => {
    const trimmed = range.trim()
    if (trimmed === '') return false
    if (trimmed.includes('/')) return inIpv4Cidr(bare, trimmed)
    return trimmed === bare
  })
}

/**
 * True when `url` points at loopback, link-local, or RFC1918 space and must
 * never be handed to a remote reader service.
 *
 * A URL this function cannot parse is treated as private: the fetch providers
 * send the target to a third-party extraction API, and failing closed costs
 * one readable error where failing open costs an internal network probe.
 * @param url absolute URL about to be fetched
 * @param allowRanges exact IPs or `a.b.c.d/prefix` CIDRs that re-open access
 */
export function isPrivateUrl(url: string, allowRanges: readonly string[] = []): boolean {
  let parsed: URL
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`)
  } catch {
    return true
  }
  const host = parsed.hostname
  if (matchesAllowRange(host, allowRanges)) return false
  return isPrivateHost(host)
}

/** Markdown image whose payload is an inline base64 data URI. */
const DATA_URI_IMAGE = /!\[([^\]]*)\]\(\s*data:image\/[a-z0-9.+-]+;base64,[^)]*\)/gi

/**
 * Bare base64 data-URI run left in text with no markdown wrapper. The class is
 * whitespace-free on purpose: including `\s` would let a run swallow the
 * ordinary prose that follows it, since letters are also base64 characters.
 */
const BARE_DATA_URI_IMAGE = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]{16,}/gi

/**
 * Drop inline base64 image payloads while keeping the alt text and the
 * surrounding markdown. A single screenshot is megabytes of context the model
 * cannot read anyway; the alt text is what carries the meaning.
 * @param markdown fetched markdown or text
 */
export function stripDataUriImages(markdown: string): string {
  return markdown
    .replace(DATA_URI_IMAGE, (_match, alt: string) => alt)
    .replace(BARE_DATA_URI_IMAGE, '')
}

/** Markers that mean the extractor returned an interstitial, not the page. */
const GATE_MARKERS: readonly string[] = [
  'enable javascript',
  'please enable cookies',
  'verify you are human',
  'captcha',
  'just a moment',
  'access denied',
]

/** Characters of output inspected for a gate marker. */
const GATE_WINDOW = 1024

/** A non-empty line shorter than this counts as navigation soup, not prose. */
const SHORT_LINE = 40

/** Non-empty lines required before the soup ratio means anything. */
const MIN_LINES_FOR_SOUP = 8

/** Fraction of short lines above which the output is navigation chrome. */
const SHORT_LINE_RATIO = 0.7

/**
 * True when fetched content looks like a bot wall or a navigation menu rather
 * than the article that was asked for. Used by the fetch chain to keep trying.
 * @param content decoded fetch body
 */
export function isLowQualityOutput(content: string): boolean {
  const head = content.slice(0, GATE_WINDOW).toLowerCase()
  if (GATE_MARKERS.some((marker) => head.includes(marker))) return true

  const lines = content.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length < MIN_LINES_FOR_SOUP) return false
  const short = lines.filter((line) => line.length < SHORT_LINE).length
  return short / lines.length > SHORT_LINE_RATIO
}

/**
 * Narrow an unknown value to a plain object, so provider payloads can be read
 * field by field without a cast.
 * @param value value parsed out of a provider response
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Narrow an unknown value to an array.
 * @param value value parsed out of a provider response
 */
export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

/**
 * Read one string field, treating an empty or non-string value as absent.
 * @param record the object to read from
 * @param key the field name
 */
export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Read one nested object field.
 * @param record the object to read from
 * @param key the field name
 */
export function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return asRecord(record[key])
}

/**
 * Read one array field.
 * @param record the object to read from
 * @param key the field name
 */
export function readArray(record: Record<string, unknown>, key: string): unknown[] | undefined {
  return asArray(record[key])
}
