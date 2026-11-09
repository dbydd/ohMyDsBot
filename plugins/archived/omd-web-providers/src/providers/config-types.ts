/**
 * Deployment settings shared by the individual provider constructors.
 *
 * `config.ts` owns the schemastery schema; these narrow shapes are what a
 * provider actually reads, so a provider file never imports the whole config.
 *
 * @module omd-web-providers/providers/config-types
 */

/** Settings every search provider needs. */
export interface SearchProviderConfig {
  /** Credential reference resolved per call; empty means keyless. */
  secretRef: string
  /** Endpoint base; empty selects the vendor's public endpoint. */
  baseUrl: string
  /** Wall-clock budget for one search, in milliseconds. */
  timeoutMs: number
}

/** Settings the Tavily search provider adds. */
export interface TavilyProviderConfig extends SearchProviderConfig {
  /** Retrieval depth sent as Tavily's `search_depth`. */
  searchDepth: 'basic' | 'advanced'
}

/** Settings the OpenAlex search provider adds. */
export interface OpenAlexProviderConfig extends SearchProviderConfig {
  /** Contact address sent as `mailto`; the polite pool requires one. */
  mailto: string
}

/** Settings every fetch provider needs. */
export interface FetchProviderConfig {
  /** Credential reference resolved per call; empty means keyless. */
  secretRef: string
  /** Endpoint base; empty selects the vendor's public endpoint. */
  baseUrl: string
  /** Wall-clock budget for one fetch, in milliseconds. */
  timeoutMs: number
  /** Decoded-body cap; longer bodies are cut and flagged `truncated`. */
  maxChars: number
  /** When true, private and loopback URLs are fetched instead of refused. */
  allowPrivateUrls: boolean
  /** Exact IPs or `a.b.c.d/prefix` CIDRs that re-open private access. */
  allowRanges: string[]
}
