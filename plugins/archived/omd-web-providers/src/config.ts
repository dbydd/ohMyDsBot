/**
 * Deployment settings for `omd-web-providers`, as a schemastery schema.
 *
 * Every tunable lives here: provider order, credential reference names,
 * endpoint overrides, timeouts, and the private-network policy. Nothing in
 * `src/` reads `process.env` for behaviour or hardcodes a deployment knob.
 *
 * @module omd-web-providers/config
 */

import z from '@deepseek-ai/schemastery'

/** `omd-web-providers` deployment settings. */
export interface Config {
  /** Search provider ids the auto chain tries, in order. */
  searchOrder: string[]
  /** Fetch provider ids the auto chain tries, in order. */
  fetchOrder: string[]
  /** Credential reference backing the Jina search provider. */
  jinaRef: string
  /** Credential reference backing the Tavily search provider. */
  tavilyRef: string
  /** Credential reference backing the TinyFish search provider. */
  tinyfishRef: string
  /** Credential reference backing the Searchinfinity search provider. */
  searchInfinityRef: string
  /** Credential reference backing OpenAlex; empty means keyless. */
  openalexRef: string
  /** Contact address sent to OpenAlex as `mailto`; empty stays out of the polite pool by choice. */
  openalexMailto: string
  /** Credential reference backing the Firecrawl fetch provider. */
  firecrawlRef: string
  /** Jina search endpoint override; empty selects `https://s.jina.ai`. */
  jinaSearchBaseUrl: string
  /** Jina Reader endpoint override; empty selects `https://r.jina.ai`. */
  jinaReaderBaseUrl: string
  /** Tavily endpoint override; empty selects `https://api.tavily.com`. */
  tavilyBaseUrl: string
  /** TinyFish endpoint override; empty selects `https://api.search.tinyfish.ai`. */
  tinyfishBaseUrl: string
  /** Searchinfinity endpoint override; empty selects the BytePlus host. */
  searchInfinityBaseUrl: string
  /** Firecrawl endpoint override; empty selects `https://api.firecrawl.dev`. */
  firecrawlBaseUrl: string
  /** OpenAlex endpoint override; empty selects `https://api.openalex.org`. */
  openalexBaseUrl: string
  /** When true, fetch providers may retrieve loopback and private-network URLs. */
  allowPrivateUrls: boolean
  /** Exact IPs or `a.b.c.d/prefix` CIDRs that stay reachable even without `allowPrivateUrls`. */
  allowRanges: string[]
  /** Wall-clock budget for one search call, in milliseconds. */
  searchTimeoutMs: number
  /** Wall-clock budget for one fetch call, in milliseconds. */
  fetchTimeoutMs: number
  /** Decoded-body cap for a fetch result; longer bodies are cut and flagged. */
  fetchMaxChars: number
  /** Mount the DuckDuckGo HTML search provider. */
  enableDdg: boolean
  /** Mount the TinyFish search provider. Off until its endpoint is verified against a live key. */
  enableTinyfish: boolean
  /** Mount the Searchinfinity search provider. Off until a key with Searchinfinity access is supplied. */
  enableSearchInfinity: boolean
  /** Mount the OpenAlex scholarly search provider. */
  enableOpenalex: boolean
  /** Mount the Jina search provider. */
  enableJina: boolean
  /** Mount the Tavily search provider. */
  enableTavily: boolean
  /** Mount the Firecrawl fetch provider. */
  enableFirecrawl: boolean
  /** Mount the Jina Reader fetch provider. */
  enableJinaReader: boolean
}

/** Default search chain: paid and metered sources first, keyless floors last. */
const DEFAULT_SEARCH_ORDER = ['jina', 'tavily', 'tinyfish', 'searchinfinity', 'openalex', 'ddg']

/** Default fetch chain: the reader is cheaper; Firecrawl is the heavier retry. */
const DEFAULT_FETCH_ORDER = ['jina-reader', 'firecrawl']

/** Schemastery configuration for the web-provider bundle. */
export const Config: z<Config> = z.object({
  searchOrder: z.array(z.string()).default(DEFAULT_SEARCH_ORDER),
  fetchOrder: z.array(z.string()).default(DEFAULT_FETCH_ORDER),
  jinaRef: z.string().default('JINA_API_KEY'),
  tavilyRef: z.string().default('TAVILY_API_KEY'),
  tinyfishRef: z.string().default('TINYFISH_API_KEY'),
  searchInfinityRef: z.string().default('SEARCH_INFINITY_API_KEY'),
  openalexRef: z.string().default('OPENALEX_API_KEY'),
  openalexMailto: z.string().default(''),
  firecrawlRef: z.string().default('FIRECRAWL_API_KEY'),
  jinaSearchBaseUrl: z.string().default(''),
  jinaReaderBaseUrl: z.string().default(''),
  tavilyBaseUrl: z.string().default(''),
  tinyfishBaseUrl: z.string().default(''),
  searchInfinityBaseUrl: z.string().default(''),
  firecrawlBaseUrl: z.string().default(''),
  openalexBaseUrl: z.string().default(''),
  allowPrivateUrls: z.boolean().default(false),
  // The Docker bridge network this deployment runs agents in; see README.
  allowRanges: z.array(z.string()).default(['172.19.0.0/16']),
  // `step(1)` is this schemastery dialect's "integer"; `z.int()` does not exist.
  searchTimeoutMs: z.number().step(1).min(1000).default(20000),
  fetchTimeoutMs: z.number().step(1).min(1000).default(30000),
  fetchMaxChars: z.number().step(1).min(1000).default(200000),
  enableDdg: z.boolean().default(true),
  enableTinyfish: z.boolean().default(false),
  enableSearchInfinity: z.boolean().default(false),
  enableOpenalex: z.boolean().default(true),
  enableJina: z.boolean().default(true),
  enableTavily: z.boolean().default(true),
  enableFirecrawl: z.boolean().default(true),
  enableJinaReader: z.boolean().default(true),
})
