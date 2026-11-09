/**
 * `searchinfinity` — BytePlus Searchinfinity (ByteDance's international
 * BytePlus arm), `POST /search_api/web_search` on `torchlight.byteintlapi.com`.
 *
 * Two vendor quirks drive the shape of this file: the API answers HTTP 200 even
 * for failures, with the error carried in `ResponseMetadata.Error`, so a 200 is
 * not success; and `PublishTime` is an ISO string only on some results, with a
 * unix-seconds `PublishTimeUnix` (0 meaning "unknown") alongside it.
 *
 * @module omd-web-providers/providers/searchinfinity
 */

import type { WebSearchProvider, WebSearchSource } from '@deepseek-ai/dsh-web'
import { hasRef } from '../keys.ts'
import { authHeaders, callApiJson, endpoint } from '../provider-kit.ts'
import {
  asRecord,
  ProviderFailure,
  readArray,
  readRecord,
  readString,
} from '../types.ts'
import type { ProviderFailureKind } from '../types.ts'
import type { SearchProviderConfig } from './config-types.ts'

/** Stable id this provider registers under. */
export const SEARCH_INFINITY_PROVIDER_ID = 'searchinfinity'

/** Default Searchinfinity endpoint; the Flux operation is appended. */
export const SEARCH_INFINITY_DEFAULT_BASE_URL = 'https://torchlight.byteintlapi.com'

/** Flux operation path. The Omnira variant is a documented alternative. */
const SEARCH_PATH = '/search_api/web_search'

/** Result count requested when the caller sets no bound (vendor max 20). */
const DEFAULT_RESULT_COUNT = 10

/** Route each documented in-body error code to the matching failure kind. */
const KIND_BY_ERROR_CODE: Record<string, ProviderFailureKind> = {
  '700901': 'credential', // invalid ApiKey
  'invalid_api_key': 'credential', // the same error under its string code
  '10403': 'quota', // no permission, or the account's quota is spent
  '700429': 'quota', // QPS ceiling (5/s by default)
  '10400': 'invalid-response', // parameter error
  '10500': 'transient', // internal error; the vendor says retry
}

/**
 * Turn an in-body vendor error into a {@link ProviderFailure}.
 *
 * The API's HTTP status is always 200, so the transport layer sees a success;
 * without this the chain would treat a rejected key as zero results and move
 * on silently.
 * @param payload the parsed response envelope
 */
function throwInBodyError(payload: Record<string, unknown>): void {
  const error = readRecord(readRecord(payload, 'ResponseMetadata') ?? {}, 'Error')
  if (error === undefined) return
  // The envelope carries both a numeric `CodeN` and a symbolic `Code`, and
  // which one is populated varies by error, so prefer the number and fall back.
  const numeric = error['CodeN']
  const code = typeof numeric === 'number' ? String(numeric) : readString(error, 'Code')
  const message = readString(error, 'Message') ?? 'Searchinfinity reported an in-body error'
  const kind = code === undefined ? 'transient' : KIND_BY_ERROR_CODE[code] ?? 'transient'
  throw new ProviderFailure(`Searchinfinity error ${code ?? 'unknown'}: ${message}`, kind)
}

/** Convert a unix-seconds field to an ISO string; 0 or absent means unknown. */
function unixToIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  const date = new Date(value * 1000)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/**
 * Map one WebResult to a normalized source.
 * @param item one entry of `Result.WebResults`
 */
function toSource(item: unknown): WebSearchSource | undefined {
  const record = asRecord(item)
  if (record === undefined) return undefined
  const url = readString(record, 'Url')
  if (url === undefined) return undefined
  const title = readString(record, 'Title')
  const snippet = readString(record, 'Summary') ?? readString(record, 'Snippet')
  const publishedAt = readString(record, 'PublishTime') ?? unixToIso(record['PublishTimeUnix'])
  return {
    url,
    ...title === undefined ? {} : { title },
    ...snippet === undefined ? {} : { snippet },
    ...publishedAt === undefined ? {} : { publishedAt },
  }
}

/**
 * Create the Searchinfinity-backed search provider.
 * @param config the deployment settings this provider reads
 */
export function createSearchInfinitySearch(config: SearchProviderConfig): WebSearchProvider {
  const baseUrl = config.baseUrl === '' ? SEARCH_INFINITY_DEFAULT_BASE_URL : config.baseUrl
  return {
    id: SEARCH_INFINITY_PROVIDER_ID,
    available: () => hasRef(config.secretRef),
    async search(request, signal) {
      const payload = await callApiJson({
        url: endpoint(baseUrl, SEARCH_PATH),
        init: {
          method: 'POST',
          headers: authHeaders(config.secretRef, {
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            Query: request.query.slice(0, 400),
            Count: Math.min(request.maxResults ?? DEFAULT_RESULT_COUNT, 20),
          }),
        },
        timeoutMs: config.timeoutMs,
        signal,
        secretRef: config.secretRef,
      })
      const envelope = asRecord(payload)
      if (envelope === undefined) {
        throw new ProviderFailure('Searchinfinity response is not a JSON object', 'invalid-response')
      }
      throwInBodyError(envelope)
      const result = readRecord(envelope, 'Result')
      const items = result === undefined ? undefined : readArray(result, 'WebResults')
      if (items === undefined) {
        throw new ProviderFailure('Searchinfinity response has no `Result.WebResults` array', 'invalid-response')
      }
      const sources = items.map(toSource).filter((source) => source !== undefined)
      return { sources, truncated: false }
    },
  }
}
