/**
 * `tavily` — the Tavily Search API (`POST /search`), a metered search backend
 * with good recency handling; the second link in the default search chain.
 *
 * @module omd-web-providers/providers/tavily
 */

import type { WebSearchProvider, WebSearchSource } from '@deepseek-ai/dsh-web'
import { hasRef } from '../keys.ts'
import { authHeaders, callApiJson, endpoint } from '../provider-kit.ts'
import {
  asRecord,
  ProviderFailure,
  readArray,
  readString,
} from '../types.ts'
import type { TavilyProviderConfig } from './config-types.ts'

/** Stable id this provider registers under. */
export const TAVILY_PROVIDER_ID = 'tavily'

/** Default Tavily endpoint; `/search` is the operation. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'

/** Result count requested when the caller sets no bound. */
const DEFAULT_RESULT_COUNT = 8

/**
 * Map one Tavily result to a normalized source.
 * @param item one entry of the response's `results` array
 */
function toSource(item: unknown): WebSearchSource | undefined {
  const record = asRecord(item)
  if (record === undefined) return undefined
  const url = readString(record, 'url')
  if (url === undefined) return undefined
  const title = readString(record, 'title')
  const content = readString(record, 'content')
  const publishedDate = readString(record, 'published_date')
  return {
    url,
    ...title === undefined ? {} : { title },
    ...content === undefined ? {} : { snippet: content },
    ...publishedDate === undefined ? {} : { publishedAt: publishedDate },
  }
}

/**
 * Create the Tavily-backed search provider.
 * @param config the deployment settings this provider reads
 */
export function createTavilySearch(config: TavilyProviderConfig): WebSearchProvider {
  const baseUrl = config.baseUrl === '' ? TAVILY_DEFAULT_BASE_URL : config.baseUrl
  return {
    id: TAVILY_PROVIDER_ID,
    available: () => hasRef(config.secretRef),
    async search(request, signal) {
      const payload = await callApiJson({
        url: endpoint(baseUrl, '/search'),
        init: {
          method: 'POST',
          headers: authHeaders(config.secretRef, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            query: request.query,
            max_results: request.maxResults ?? DEFAULT_RESULT_COUNT,
            search_depth: config.searchDepth,
            // Tavily's generated answer is a second model call we do not bill
            // for and the seam's callers never asked for.
            include_answer: false,
          }),
        },
        timeoutMs: config.timeoutMs,
        signal,
        secretRef: config.secretRef,
      })
      const envelope = asRecord(payload)
      const items = envelope === undefined ? undefined : readArray(envelope, 'results')
      if (items === undefined) {
        throw new ProviderFailure('Tavily search response has no `results` array', 'invalid-response')
      }
      const sources = items.map(toSource).filter((source) => source !== undefined)
      return { sources, truncated: false }
    },
  }
}
