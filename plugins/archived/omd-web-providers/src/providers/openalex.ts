/**
 * `openalex` — the OpenAlex Works API (`GET /works`), a keyless-legal scholarly
 * index. It is the chain's floor for research questions: no credential, no
 * quota of ours, and a polite-pool `mailto` instead of a key.
 *
 * OpenAlex ships abstracts only as an inverted index (`word -> positions`), so
 * {@link reconstructAbstract} reassembles the text; works with no abstract at
 * all come back with a title and no snippet rather than an invented one.
 *
 * @module omd-web-providers/providers/openalex
 */

import type { WebSearchProvider, WebSearchSource } from '@deepseek-ai/dsh-web'
import { resolveRef } from '../keys.ts'
import { callApiJson, endpoint, USER_AGENT } from '../provider-kit.ts'
import {
  asRecord,
  ProviderFailure,
  readArray,
  readString,
} from '../types.ts'
import type { OpenAlexProviderConfig } from './config-types.ts'

/** Stable id this provider registers under. */
export const OPENALEX_PROVIDER_ID = 'openalex'

/** Default OpenAlex endpoint; `/works` is the operation. */
export const OPENALEX_DEFAULT_BASE_URL = 'https://api.openalex.org'

/** Result count requested when the caller sets no bound. */
const DEFAULT_RESULT_COUNT = 8

/** OpenAlex caps `per_page` at 200; a caller asking for more gets an error. */
const MAX_PER_PAGE = 200

/**
 * Rebuild an abstract from OpenAlex's inverted index.
 *
 * The index maps each word to the positions it occupies, so the text is the
 * words sorted by position — the gaps are what punctuation and stopwords lost.
 * @param index the `abstract_inverted_index` object, or `undefined`
 */
function reconstructAbstract(index: unknown): string | undefined {
  const record = asRecord(index)
  if (record === undefined) return undefined
  const slots: (string | undefined)[] = []
  for (const [word, positions] of Object.entries(record)) {
    const list = asPositions(positions)
    for (const position of list ?? []) {
      if (Number.isInteger(position) && position >= 0) slots[position] = word
    }
  }
  const text = slots.filter((word) => word !== undefined).join(' ').trim()
  return text === '' ? undefined : text
}

/**
 * Read a numeric array field; OpenAlex positions arrive as plain number arrays.
 * @param value the field value to read
 */
function asPositions(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is number => typeof entry === 'number')
}

/**
 * Map one OpenAlex work to a normalized source.
 *
 * The citation target is the DOI when the work has one and the OpenAlex id
 * otherwise; a bare `openalex.org/W…` id resolves to the work's landing page.
 * @param item one entry of the response's `results` array
 */
function toSource(item: unknown): WebSearchSource | undefined {
  const record = asRecord(item)
  if (record === undefined) return undefined
  const doi = readString(record, 'doi')
  const id = readString(record, 'id')
  const url = doi ?? id
  if (url === undefined) return undefined
  const title = readString(record, 'display_name')
  const abstract = reconstructAbstract(record['abstract_inverted_index'])
  const publishedAt = readString(record, 'publication_date')
  return {
    url,
    ...title === undefined ? {} : { title },
    ...abstract === undefined ? {} : { snippet: abstract },
    ...publishedAt === undefined ? {} : { publishedAt },
  }
}

/**
 * Create the OpenAlex-backed search provider.
 *
 * `available()` is always true: OpenAlex serves unauthenticated callers, and an
 * API key only raises the rate ceiling.
 * @param config the deployment settings this provider reads
 */
export function createOpenAlexSearch(config: OpenAlexProviderConfig): WebSearchProvider {
  const baseUrl = config.baseUrl === '' ? OPENALEX_DEFAULT_BASE_URL : config.baseUrl
  return {
    id: OPENALEX_PROVIDER_ID,
    available: () => true,
    async search(request, signal) {
      const url = new URL(endpoint(baseUrl, '/works'))
      url.searchParams.set('search', request.query)
      url.searchParams.set('per_page', String(Math.min(request.maxResults ?? DEFAULT_RESULT_COUNT, MAX_PER_PAGE)))
      if (config.mailto !== '') url.searchParams.set('mailto', config.mailto)
      const secret = resolveRef(config.secretRef)
      if (secret !== undefined) url.searchParams.set('api_key', secret)

      const payload = await callApiJson({
        url: url.toString(),
        init: { method: 'GET', headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } },
        timeoutMs: config.timeoutMs,
        signal,
        ...secret === undefined ? {} : { secretRef: config.secretRef },
      })
      const envelope = asRecord(payload)
      const items = envelope === undefined ? undefined : readArray(envelope, 'results')
      if (items === undefined) {
        throw new ProviderFailure('OpenAlex response has no `results` array', 'invalid-response')
      }
      const sources = items.map(toSource).filter((source) => source !== undefined)
      return { sources, truncated: false }
    },
  }
}
