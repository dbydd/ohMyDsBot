/**
 * `ddg` — DuckDuckGo's HTML endpoint, the chain's keyless last resort for
 * general web queries.
 *
 * This is the brittle link by design: it parses `html.duckduckgo.com`'s markup
 * with regular expressions, and that markup is neither versioned nor covered by
 * a compatibility promise. The result href is a `//duckduckgo.com/l/?uddg=`
 * redirect whose `uddg` parameter carries the real target, so the parser
 * decodes it rather than shipping the reader a tracking URL.
 *
 * @module omd-web-providers/providers/ddg
 */

import type { WebSearchProvider, WebSearchSource } from '@deepseek-ai/dsh-web'
import { callApi } from '../provider-kit.ts'
import { ProviderFailure } from '../types.ts'
import type { SearchProviderConfig } from './config-types.ts'

/** Stable id this provider registers under. */
export const DDG_PROVIDER_ID = 'ddg'

/** DuckDuckGo's keyless HTML search endpoint. */
export const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/'

/** Result count requested when the caller sets no bound. */
const DEFAULT_RESULT_COUNT = 8

/**
 * A browser user agent. The endpoint degrades to an empty result page for
 * clients it does not recognise, which reads as "no results" rather than as an
 * error and would silently empty the chain.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/131.0.0.0 Safari/537.36'

/** Anchor carrying a hit's title and redirect href. */
const RESULT_ANCHOR = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g

/** Snippet block following an anchor. */
const RESULT_SNIPPET = /<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g

/** Tag boundaries left in the parsed title/snippet text. */
const TAG = /<[^>]*>/g

/** Decode the HTML entities DuckDuckGo emits in titles and snippets. */
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
}

/** Reduce a parsed markup fragment to readable plain text. */
function toText(fragment: string): string {
  return fragment
    .replace(TAG, '')
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Recover the real target URL from DuckDuckGo's redirect href.
 *
 * Hrefs arrive in three forms depending on the markup variant: a protocol-
 * relative `//duckduckgo.com/l/?uddg=…` redirect, the same path absolute, and
 * occasionally the destination already unwrapped.
 * @param href the anchor's `href` attribute
 */
function unwrapHref(href: string): string | undefined {
  const decoded = toText(href)
  if (decoded === '') return undefined
  const marker = decoded.indexOf('uddg=')
  if (marker < 0) return decoded.startsWith('http') ? decoded : undefined
  const target = new URLSearchParams(decoded.slice(marker)).get('uddg')
  return target === null || target === '' ? undefined : target
}

/**
 * Parse the HTML endpoint's markup into normalized sources.
 * @param html the endpoint's response body
 */
function parseResults(html: string): WebSearchSource[] {
  const snippets = [...html.matchAll(RESULT_SNIPPET)].map((match) => toText(match[1] ?? ''))
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  let index = 0
  for (const match of html.matchAll(RESULT_ANCHOR)) {
    const url = unwrapHref(match[1] ?? '')
    if (url === undefined || seen.has(url)) continue
    seen.add(url)
    const title = toText(match[2] ?? '')
    const snippet = snippets[index] ?? ''
    index += 1
    sources.push({
      url,
      ...title === '' ? {} : { title },
      ...snippet === '' ? {} : { snippet },
    })
  }
  return sources
}

/**
 * Create the DuckDuckGo HTML search provider.
 *
 * `available()` is always true: the endpoint takes no credential.
 * @param config the deployment settings this provider reads
 */
export function createDdgSearch(config: SearchProviderConfig): WebSearchProvider {
  return {
    id: DDG_PROVIDER_ID,
    available: () => true,
    async search(request, signal) {
      const url = new URL(DDG_ENDPOINT)
      url.searchParams.set('q', request.query)
      const { status, text } = await callApi({
        url: url.toString(),
        init: { method: 'GET', headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' } },
        timeoutMs: config.timeoutMs,
        signal,
      })
      const wanted = request.maxResults ?? DEFAULT_RESULT_COUNT
      const sources = parseResults(text)
      if (sources.length === 0) {
        // Zero hits and a zero-hit page look identical, and both mean the parse
        // no longer matches the markup. Failing lets the chain try a source
        // that still returns something.
        throw new ProviderFailure(`DuckDuckGo returned ${status} with no parsable results`, 'invalid-response')
      }
      return { sources: sources.slice(0, wanted), truncated: sources.length > wanted }
    },
  }
}
