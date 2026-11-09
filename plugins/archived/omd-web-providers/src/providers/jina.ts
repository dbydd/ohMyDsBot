/**
 * `jina` — the Jina AI Search API (`GET /{query}` on `s.jina.ai`), our
 * highest-quality search source and the default first link in the chain.
 *
 * @module omd-web-providers/providers/jina
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
import type { SearchProviderConfig } from './config-types.ts'

/** Stable id this provider registers under. */
export const JINA_PROVIDER_ID = 'jina'

/** Default Jina search endpoint; the query is the path. */
export const JINA_DEFAULT_BASE_URL = 'https://s.jina.ai'

/** Result count requested when the caller sets no bound. */
const DEFAULT_RESULT_COUNT = 8

/**
 * Map one Jina search hit to a normalized source.
 * @param item one entry of the response's `data` array
 */
function toSource(item: unknown): WebSearchSource | undefined {
  const record = asRecord(item)
  if (record === undefined) return undefined
  const url = readString(record, 'url')
  if (url === undefined) return undefined
  const title = readString(record, 'title')
  const description = readString(record, 'description')
  const updatedAt = readString(record, 'updated_at')
  return {
    url,
    ...title === undefined ? {} : { title },
    ...description === undefined ? {} : { snippet: description },
    ...updatedAt === undefined ? {} : { publishedAt: updatedAt },
  }
}

/**
 * Create the Jina-backed search provider.
 * @param config the deployment settings this provider reads
 */
export function createJinaSearch(config: SearchProviderConfig): WebSearchProvider {
  const baseUrl = config.baseUrl === '' ? JINA_DEFAULT_BASE_URL : config.baseUrl
  return {
    id: JINA_PROVIDER_ID,
    available: () => hasRef(config.secretRef),
    async search(request, signal) {
      const count = request.maxResults ?? DEFAULT_RESULT_COUNT
      const payload = await callApiJson({
        url: `${endpoint(baseUrl, encodeURIComponent(request.query))}?count=${count}`,
        init: {
          method: 'GET',
          headers: authHeaders(config.secretRef, {
            // `no-content` keeps the answer synthesis out of the billed response
            // and out of `content`; we only want citeable sources.
            'X-Respond-With': 'no-content',
            'X-Retain-Images': 'none',
            Accept: 'application/json',
          }),
        },
        timeoutMs: config.timeoutMs,
        signal,
        secretRef: config.secretRef,
      })
      const envelope = asRecord(payload)
      const items = envelope === undefined ? undefined : readArray(envelope, 'data')
      if (items === undefined) {
        throw new ProviderFailure('Jina search response has no `data` array', 'invalid-response')
      }
      const sources = items.map(toSource).filter((source) => source !== undefined)
      return { sources, truncated: false }
    },
  }
}
