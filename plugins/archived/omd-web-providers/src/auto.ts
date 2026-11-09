/**
 * The two meta-providers `cordis.patch.yml` pins as the deployment's web
 * search and fetch selection.
 *
 * Both walk an ordered list of children and decide what a failure means:
 *
 * - **search** falls through on {@link FALLBACK_KINDS} and rethrows anything
 *   else, so a rejected credential surfaces instead of being spent across the
 *   whole chain.
 * - **fetch** falls through on *quality*, not on failure — an empty or
 *   bot-walled body is a reason to ask the next extractor, and if none does
 *   better the worst one seen is returned rather than a bare error, because a
 *   short page is usually still readable and an exception is not.
 *
 * The two chains therefore differ on hard failures: search rethrows them,
 * fetch records them. Each child carries its own credential, so one provider's
 * rejected key is exactly the situation the other provider exists to survive,
 * and a fetch chain that stopped at the first unusable credential would return
 * nothing on a deployment where the second provider works fine.
 *
 * @module omd-web-providers/auto
 */

import { WebError, type WebFetchProvider, type WebFetchResult, type WebSearchProvider } from '@deepseek-ai/dsh-web'
import {
  isFallbackKind,
  isLowQualityOutput,
  ProviderFailure,
} from './types.ts'

/** Stable id of the search meta-provider. */
export const AUTO_SEARCH_PROVIDER_ID = 'omd-auto'

/** Stable id of the fetch meta-provider. */
export const AUTO_FETCH_PROVIDER_ID = 'omd-auto-fetch'

/** Trimmed body length at or below which a fetch is treated as no answer. */
const MIN_USEFUL_CHARS = 100

/** Settings the auto providers read from the deployment config. */
export interface AutoProviderConfig {
  /** Provider ids to try, in order. */
  searchOrder: string[]
  /** Fetch provider ids to try, in order. */
  fetchOrder: string[]
}

/** One child's failure, as recorded for the exhausted-chain message. */
interface FailureNote {
  /** The child's provider id. */
  id: string
  /** Why it failed. */
  kind: string
  /** Its already-redacted message. */
  message: string
}

/**
 * Classify an unknown thrown value into a note, never leaking a stack or a body.
 * @param id the child provider's id
 * @param error the thrown value
 */
function note(id: string, error: unknown): FailureNote {
  if (error instanceof ProviderFailure) return { id, kind: error.kind, message: error.message }
  // A `WebError` from a child (a refused private URL) already carries a
  // machine-routable kind; using it keeps the exhausted-chain message specific.
  if (error instanceof WebError) return { id, kind: error.code, message: error.message }
  if (error instanceof Error) return { id, kind: 'unknown', message: error.message }
  return { id, kind: 'unknown', message: String(error) }
}

/**
 * Create the auto search provider over an ordered set of children.
 * @param config the chain order from the deployment config
 * @param children the registered search providers, keyed by id
 */
export function createAutoSearch(
  config: AutoProviderConfig,
  children: Map<string, WebSearchProvider>,
): WebSearchProvider {
  return {
    id: AUTO_SEARCH_PROVIDER_ID,
    available: () => [...children.values()].some((child) => child.available()),
    async search(request, signal) {
      const notes: FailureNote[] = []
      for (const id of config.searchOrder) {
        const child = children.get(id)
        if (child === undefined || !child.available()) continue
        try {
          return await child.search(request, signal)
        } catch (error) {
          // A caller abort is not this chain's decision to make; let it out.
          if (signal?.aborted === true) throw error
          const failure = note(id, error)
          notes.push(failure)
          if (!(error instanceof ProviderFailure) || !isFallbackKind(error.kind)) {
            throw new WebError(`web search provider "${id}" failed: ${failure.message}`, 'OMD_SEARCH_PROVIDER_FAILED', {
              cause: error,
            })
          }
        }
      }
      const detail = notes.length === 0
        ? 'no configured search provider is available'
        : notes.map((entry) => `${entry.id}: ${entry.kind} — ${entry.message}`).join('; ')
      throw new WebError(`every web search provider failed: ${detail}`, 'OMD_SEARCH_EXHAUSTED')
    },
  }
}

/**
 * Create the auto fetch provider over an ordered set of children.
 * @param config the chain order from the deployment config
 * @param children the registered fetch providers, keyed by id
 */
export function createAutoFetch(
  config: AutoProviderConfig,
  children: Map<string, WebFetchProvider>,
): WebFetchProvider {
  return {
    id: AUTO_FETCH_PROVIDER_ID,
    available: () => [...children.values()].some((child) => child.available()),
    async fetch(request, signal) {
      const notes: FailureNote[] = []
      let fallback: WebFetchResult | undefined
      let lastError: unknown

      for (const id of config.fetchOrder) {
        const child = children.get(id)
        if (child === undefined || !child.available()) continue
        try {
          const result = await child.fetch(request, signal)
          const content = result.body.content.trim()
          if (content.length <= MIN_USEFUL_CHARS) continue
          if (isLowQualityOutput(content)) {
            // Remember the first bot-walled answer: it is the only thing this
            // chain can return if no extractor does better, and it beats an
            // exception. An empty answer is not worth remembering.
            fallback ??= result
            continue
          }
          return result
        } catch (error) {
          if (signal?.aborted === true) throw error
          const failure = note(id, error)
          notes.push(failure)
          lastError = error
        }
      }

      if (fallback !== undefined) return fallback
      const detail = notes.length === 0
        ? 'no configured fetch provider is available'
        : notes.map((entry) => `${entry.id}: ${entry.kind} — ${entry.message}`).join('; ')
      throw new WebError(`every web fetch provider failed: ${detail}`, 'OMD_FETCH_EXHAUSTED', {
        cause: lastError,
      })
    },
  }
}
