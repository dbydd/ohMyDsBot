/**
 * `omd-web-providers` — one bundle of web search and web fetch providers for
 * `ctx.web`, plus the two auto providers that chain them.
 *
 * The upstream seam owns provider selection; this package supplies the roster
 * and the policy. `cordis.patch.yml` pins `searchProvider: omd-auto` and
 * `fetchProvider: omd-auto-fetch`, so every deployment using this bundle gets
 * the chain rather than one vendor's endpoint — a vendor outage becomes one
 * skipped link instead of a failed tool call.
 *
 * Each child provider also registers under its own id, so a deployment that
 * wants one vendor pinned (`searchProvider: tavily`) can override the row
 * without disabling the rest.
 *
 * Named exports only: a `default` export makes the Loader discard this whole
 * namespace and every injection with it.
 *
 * @module omd-web-providers
 */

import type { Context } from '@deepseek-ai/cordis'
import type { WebFetchProvider, WebSearchProvider } from '@deepseek-ai/dsh-web'
import { createAutoFetch, createAutoSearch } from './auto.ts'
import type { Config } from './config.ts'
import { createDdgSearch } from './providers/ddg.ts'
import { createFirecrawlFetch } from './providers/firecrawl-fetch.ts'
import { createJinaReaderFetch } from './providers/jina-reader.ts'
import { createJinaSearch } from './providers/jina.ts'
import { createOpenAlexSearch } from './providers/openalex.ts'
import { createSearchInfinitySearch } from './providers/searchinfinity.ts'
import { createTavilySearch } from './providers/tavily.ts'
import { createTinyFishSearch } from './providers/tinyfish.ts'

export { Config } from './config.ts'

/** Plugin id the Loader entry carries. */
export const name = 'omd-web-providers'

/** The web seam this package registers into. */
export const inject = ['web']

/**
 * Build the search and fetch children the enable flags select.
 * @param config deployment settings for this profile
 */
function buildProviders(config: Config): {
  search: Map<string, WebSearchProvider>
  fetch: Map<string, WebFetchProvider>
} {
  const search = new Map<string, WebSearchProvider>()
  const fetch = new Map<string, WebFetchProvider>()

  if (config.enableJina) {
    search.set('jina', createJinaSearch({
      secretRef: config.jinaRef,
      baseUrl: config.jinaSearchBaseUrl,
      timeoutMs: config.searchTimeoutMs,
    }))
  }
  if (config.enableTavily) {
    search.set('tavily', createTavilySearch({
      secretRef: config.tavilyRef,
      baseUrl: config.tavilyBaseUrl,
      timeoutMs: config.searchTimeoutMs,
      searchDepth: 'basic',
    }))
  }
  if (config.enableTinyfish) {
    search.set('tinyfish', createTinyFishSearch({
      secretRef: config.tinyfishRef,
      baseUrl: config.tinyfishBaseUrl,
      timeoutMs: config.searchTimeoutMs,
    }))
  }
  if (config.enableSearchInfinity) {
    search.set('searchinfinity', createSearchInfinitySearch({
      secretRef: config.searchInfinityRef,
      baseUrl: config.searchInfinityBaseUrl,
      timeoutMs: config.searchTimeoutMs,
    }))
  }
  if (config.enableOpenalex) {
    search.set('openalex', createOpenAlexSearch({
      secretRef: config.openalexRef,
      baseUrl: config.openalexBaseUrl,
      timeoutMs: config.searchTimeoutMs,
      mailto: config.openalexMailto,
    }))
  }
  if (config.enableDdg) {
    search.set('ddg', createDdgSearch({
      secretRef: '',
      baseUrl: '',
      timeoutMs: config.searchTimeoutMs,
    }))
  }

  const fetchSettings = {
    timeoutMs: config.fetchTimeoutMs,
    maxChars: config.fetchMaxChars,
    allowPrivateUrls: config.allowPrivateUrls,
    allowRanges: config.allowRanges,
  }
  if (config.enableJinaReader) {
    fetch.set('jina-reader', createJinaReaderFetch({
      ...fetchSettings,
      secretRef: config.jinaRef,
      baseUrl: config.jinaReaderBaseUrl,
    }))
  }
  if (config.enableFirecrawl) {
    fetch.set('firecrawl', createFirecrawlFetch({
      ...fetchSettings,
      secretRef: config.firecrawlRef,
      baseUrl: config.firecrawlBaseUrl,
    }))
  }

  return { search, fetch }
}

/**
 * Register the auto providers and every enabled child with `ctx.web`.
 * @param ctx the entry fiber's context, carrying the web registry
 * @param config deployment settings for this profile
 */
export function apply(ctx: Context, config: Config): void {
  const { search, fetch } = buildProviders(config)

  ctx.web.registerSearchProvider(createAutoSearch(config, search))
  for (const provider of search.values()) ctx.web.registerSearchProvider(provider)

  ctx.web.registerFetchProvider(createAutoFetch(config, fetch))
  for (const provider of fetch.values()) ctx.web.registerFetchProvider(provider)
}
