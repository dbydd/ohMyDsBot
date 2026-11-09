/**
 * `firecrawl` — Firecrawl's scrape endpoint (`POST /v2/scrape`), a
 * markdown-returning extraction backend used when the reader chain's first
 * answer is a bot wall.
 *
 * Firecrawl runs the fetch on its own infrastructure, so it carries the same
 * private-URL guard as the reader: an internal URL must never leave the
 * machine inside a request to a third party.
 *
 * @module omd-web-providers/providers/firecrawl-fetch
 */

import { WebError, type WebFetchProvider } from '@deepseek-ai/dsh-web'
import { hasRef } from '../keys.ts'
import { authHeaders, callApiJson, endpoint } from '../provider-kit.ts'
import {
  asRecord,
  isPrivateUrl,
  ProviderFailure,
  readRecord,
  readString,
  stripDataUriImages,
} from '../types.ts'
import type { FetchProviderConfig } from './config-types.ts'

/** Stable id this provider registers under. */
export const FIRECRAWL_PROVIDER_ID = 'firecrawl'

/** Default Firecrawl endpoint; `/v2/scrape` is the operation. */
export const FIRECRAWL_DEFAULT_BASE_URL = 'https://api.firecrawl.dev'

/** Status reported when Firecrawl's metadata omits one. */
const FALLBACK_STATUS_CODE = 200

/**
 * Create the Firecrawl-backed fetch provider.
 * @param config the deployment settings this provider reads
 */
export function createFirecrawlFetch(config: FetchProviderConfig): WebFetchProvider {
  const baseUrl = config.baseUrl === '' ? FIRECRAWL_DEFAULT_BASE_URL : config.baseUrl
  return {
    id: FIRECRAWL_PROVIDER_ID,
    available: () => hasRef(config.secretRef),
    async fetch(request, signal) {
      if (config.allowPrivateUrls !== true && isPrivateUrl(request.url, config.allowRanges)) {
        throw new WebError(
          `refusing to send ${request.url} to Firecrawl; set allowPrivateUrls or allowRanges to permit it`,
          'OMD_PRIVATE_URL',
        )
      }
      const payload = await callApiJson({
        url: endpoint(baseUrl, '/v2/scrape'),
        init: {
          method: 'POST',
          headers: authHeaders(config.secretRef, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            url: request.url,
            formats: ['markdown'],
            onlyMainContent: true,
          }),
        },
        timeoutMs: config.timeoutMs,
        signal,
        secretRef: config.secretRef,
      })
      const envelope = asRecord(payload)
      const data = envelope === undefined ? undefined : readRecord(envelope, 'data')
      if (data === undefined) {
        throw new ProviderFailure('Firecrawl response has no `data` object', 'invalid-response')
      }
      const metadata = readRecord(data, 'metadata') ?? {}
      const markdown = readString(data, 'markdown') ?? ''
      const statusCode = typeof metadata['statusCode'] === 'number' ? metadata['statusCode'] : FALLBACK_STATUS_CODE
      const finalUrl = readString(metadata, 'url') ?? request.url
      const full = stripDataUriImages(markdown)
      const truncated = full.length > config.maxChars
      return {
        url: finalUrl,
        statusCode,
        body: { kind: 'text', content: truncated ? full.slice(0, config.maxChars) : full },
        truncated,
      }
    },
  }
}
