/**
 * `jina-reader` — Jina AI Reader (`GET /{url}` on `r.jina.ai`), which returns
 * one page as clean markdown.
 *
 * The reader runs the fetch on Jina's infrastructure, so a loopback or RFC1918
 * URL would be an SSRF probe against the caller's own network; the guard below
 * refuses those before the URL leaves the machine. Keyless use is rate-limited
 * rather than refused, so the provider stays available without a credential.
 *
 * @module omd-web-providers/providers/jina-reader
 */

import { WebError, type WebFetchProvider } from '@deepseek-ai/dsh-web'
import { authHeaders, callApi } from '../provider-kit.ts'
import {
  isPrivateUrl,
  stripDataUriImages,
} from '../types.ts'
import type { FetchProviderConfig } from './config-types.ts'

/** Stable id this provider registers under. */
export const JINA_READER_PROVIDER_ID = 'jina-reader'

/** Default Jina Reader endpoint; the target URL is the path. */
export const JINA_READER_DEFAULT_BASE_URL = 'https://r.jina.ai'

/**
 * Create the Jina Reader-backed fetch provider.
 * @param config the deployment settings this provider reads
 */
export function createJinaReaderFetch(config: FetchProviderConfig): WebFetchProvider {
  const baseUrl = config.baseUrl === '' ? JINA_READER_DEFAULT_BASE_URL : config.baseUrl.replace(/\/+$/, '')
  return {
    id: JINA_READER_PROVIDER_ID,
    // Keyless readers work at a lower rate limit, so a deployment without a key
    // still gets a usable fetch provider.
    available: () => true,
    async fetch(request, signal) {
      if (config.allowPrivateUrls !== true && isPrivateUrl(request.url, config.allowRanges)) {
        throw new WebError(
          `refusing to send ${request.url} to a remote reader; set allowPrivateUrls or allowRanges to permit it`,
          'OMD_PRIVATE_URL',
        )
      }
      const { status, text } = await callApi({
        url: `${baseUrl}/${request.url}`,
        init: {
          method: 'GET',
          headers: authHeaders(config.secretRef, {
            Accept: 'text/markdown',
            'X-Return-Format': 'markdown',
          }),
        },
        timeoutMs: config.timeoutMs,
        signal,
        secretRef: config.secretRef,
      })
      if (status < 200 || status >= 300) {
        // The reader mirrors the target's own status through its own envelope;
        // a 4xx/5xx here is the fetched resource's state, which is a result
        // rather than a provider failure. The body is usually the reader's own
        // error text, so it is kept but capped like any other body.
        const detail = stripDataUriImages(text)
        const capped = detail.length > config.maxChars
        return {
          url: request.url,
          statusCode: status,
          body: { kind: 'text', content: capped ? detail.slice(0, config.maxChars) : detail },
          truncated: capped,
        }
      }
      const full = stripDataUriImages(text)
      const truncated = full.length > config.maxChars
      return {
        url: request.url,
        statusCode: status,
        body: { kind: 'text', content: truncated ? full.slice(0, config.maxChars) : full },
        truncated,
      }
    },
  }
}
