/**
 * Result memoization keyed by the exact request.
 *
 * A judgment is a pure function of `(state, questions)` for a fixed chain, so
 * repeating one within the TTL is free. Only successful results are stored: a
 * failure must be allowed to reach the next candidate rather than being
 * replayed from memory.
 *
 * @module omd-judgment/cache
 */

import { createHash } from 'node:crypto'
import type { JudgmentRequest, JudgmentResult, Questions } from './types.ts'

/**
 * Digest of a request's semantic content.
 * @param request - the judgment request.
 * @returns a hex digest that changes whenever state or questions change.
 */
export function judgmentKey(request: JudgmentRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({ state: request.state, questions: request.questions }))
    .digest('hex')
}

/**
 * Bounded time-to-live memo of settled judgments.
 *
 * Entries are stored erased: the digest covers `state` and `questions`
 * together, so a hit was necessarily produced by a request whose question keys
 * and types match the caller's. `get` re-attaches that caller's type at the one
 * place the erasure is undone.
 */
export class JudgmentCache {
  readonly #ttlMs: number
  readonly #entries = new Map<string, { at: number; result: unknown }>()

  /**
   * @param ttlMs - how long an entry stays usable, in milliseconds.
   */
  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs
  }

  /**
   * Read a live entry.
   * @param key - the digest produced by {@link judgmentKey}.
   * @returns the cached result, or undefined when absent or expired.
   */
  get<Q extends Questions>(key: string): JudgmentResult<Q> | undefined {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    if (Date.now() - entry.at > this.#ttlMs) {
      this.#entries.delete(key)
      return undefined
    }
    return entry.result as JudgmentResult<Q>
  }

  /**
   * Store a settled result and drop entries that have expired.
   * @param key - the digest produced by {@link judgmentKey}.
   * @param result - the successful result to replay.
   */
  set<Q extends Questions>(key: string, result: JudgmentResult<Q>): void {
    const now = Date.now()
    for (const [stored, entry] of this.#entries) {
      if (now - entry.at > this.#ttlMs) this.#entries.delete(stored)
    }
    this.#entries.set(key, { at: now, result })
  }

  /** Number of live entries, for diagnostics. */
  size(): number {
    return this.#entries.size
  }
}

