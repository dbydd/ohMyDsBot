/**
 * `tinyfish` — the TinyFish Search API (`GET /?query=` on `api.search.tinyfish.ai`).
 *
 * TinyFish returns a fixed page of ten organic results and has no result-count
 * parameter, so a larger bound is served by walking `page` until the bound is
 * met or the vendor's page ceiling is reached. Auth is the `X-API-Key` header,
 * not a bearer token — a bearer header here fails as an invalid key.
 *
 * @module omd-web-providers/providers/tinyfish
 */

import type { WebSearchProvider, WebSearchSource } from '@deepseek-ai/dsh-web'
import { hasRef, resolveRef } from '../keys.ts'
import { USER_AGENT, callApiJson } from '../provider-kit.ts'
import {
  asRecord,
  ProviderFailure,
  readArray,
  readString,
} from '../types.ts'
import type { SearchProviderConfig } from './config-types.ts'

/** Stable id this provider registers under. */
export const TINYFISH_PROVIDER_ID = 'tinyfish'

/** Default TinyFish search endpoint; the query is a URL parameter. */
export const TINYFISH_DEFAULT_BASE_URL = 'https://api.search.tinyfish.ai'

/** Result count requested when the caller sets no bound. */
const DEFAULT_RESULT_COUNT = 8

/** Results per page, fixed by the vendor. */
const PAGE_SIZE = 10

/**
 * Map one TinyFish result to a normalized source.
 * @param item one entry of the response's `results` array
 */
function toSource(item: unknown): WebSearchSource | undefined {
  const record = asRecord(item)
  if (record === undefined) return undefined
  const url = readString(record, 'url')
  if (url === undefined) return undefined
  const title = readString(record, 'title')
  const snippet = readString(record, 'snippet')
  const date = readString(record, 'date')
  return {
    url,
    ...title === undefined ? {} : { title },
    ...snippet === undefined ? {} : { snippet },
    ...date === undefined ? {} : { publishedAt: date },
  }
}

/**
 * Create the TinyFish-backed search provider.
 * @param config the deployment settings this provider reads
 */
export function createTinyFishSearch(config: SearchProviderConfig): WebSearchProvider {
  const baseUrl = config.baseUrl === '' ? TINYFISH_DEFAULT_BASE_URL : config.baseUrl.replace(/\/+$/, '')
  return {
    id: TINYFISH_PROVIDER_ID,
    available: () => hasRef(config.secretRef),
    async search(request, signal) {
      const wanted = request.maxResults ?? DEFAULT_RESULT_COUNT
      const pages = Math.max(1, Math.ceil(wanted / PAGE_SIZE))
      const sources: WebSearchSource[] = []
      const seen = new Set<string>()

      for (let page = 0; page < pages; page += 1) {
        const secret = resolveRef(config.secretRef)
        if (secret === undefined) {
          throw new ProviderFailure('no TinyFish API key resolved', 'config')
        }
        const url = new URL(baseUrl)
        url.searchParams.set('query', request.query)
        url.searchParams.set('page', String(page))
        const payload = await callApiJson({
          url: url.toString(),
          init: {
            method: 'GET',
            headers: { 'User-Agent': USER_AGENT, 'X-API-Key': secret, Accept: 'application/json' },
          },
          timeoutMs: config.timeoutMs,
          signal,
          secretRef: config.secretRef,
        })
        const envelope = asRecord(payload)
        const items = envelope === undefined ? undefined : readArray(envelope, 'results')
        if (items === undefined) {
          throw new ProviderFailure('TinyFish search response has no `results` array', 'invalid-response')
        }
        for (const item of items) {
          const source = toSource(item)
          if (source === undefined || seen.has(source.url)) continue
          seen.add(source.url)
          sources.push(source)
        }
        // A short page means the vendor ran out of results; asking again
        // would only bill for the same empty answer.
        if (items.length < PAGE_SIZE) break
      }

      return { sources: sources.slice(0, wanted), truncated: sources.length > wanted }
    },
  }
}
