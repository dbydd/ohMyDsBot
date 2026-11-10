/**
 * Candidate chain: try each judge backend in order until one answers.
 *
 * The chain is the whole resilience story. A candidate that is uncredentialed
 * is skipped without a request; a candidate that rejected the account is
 * remembered for a cooldown so every later call does not pay that round trip
 * again; any other failure falls through to the next candidate and is only
 * reported when the chain is exhausted.
 *
 * Aborts and timeouts are NOT failures to fall through on: the caller asked to
 * stop, so they are rethrown unchanged.
 *
 * @module omd-judgment/chain
 */

import type { JudgmentCache } from './cache.ts'
import { judgmentKey } from './cache.ts'
import type { Judge, JudgeOptions, JudgmentRequest, JudgmentResult, JudgmentService, Questions } from './types.ts'
import { JudgmentHttpError } from './types.ts'

/** Which wire a candidate speaks; reported in diagnostics and gating. */
export type JudgeKind = 'native' | 'chat'

/** One resolvable backend. */
export interface JudgeCandidate {
  /** Route label, e.g. `magpie/group/decider` or `chat:magpie/group/supercheap`. */
  readonly label: string
  /** Wire dialect. */
  readonly kind: JudgeKind
  /** Provider route, used as the cooldown key with the model. */
  readonly provider: string
  /** Model id, used as the cooldown key with the provider. */
  readonly model: string
  /**
   * Instantiate the backend.
   * @returns the judge, or undefined when this candidate has no credential.
   */
  create(): Judge | undefined
}

/** Construction inputs for {@link ChainJudge}. */
export interface ChainJudgeOptions {
  /** Live candidate list; re-read at most once per second so a settings change lands. */
  candidates: () => readonly JudgeCandidate[]
  /** Memo of settled results. */
  cache: JudgmentCache
  /** How long a rejected account is skipped, in milliseconds. */
  rejectionCooldownMs: number
}

/** Account-level statuses that mean "this credential will not work right now". */
const ACCOUNT_REJECTION_STATUSES = new Set([401, 402, 403])

/** How long a resolved candidate list is reused, in milliseconds. */
const CANDIDATE_TTL_MS = 1000

/**
 * Whether an error means the caller asked to stop.
 * @param signal - the caller's signal.
 * @returns true when the signal fired, so the error must not fall through.
 */
function stopped(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** The chain itself. */
export class ChainJudge implements JudgmentService {
  readonly #options: ChainJudgeOptions
  readonly #rejections = new Map<string, number>()
  #resolved: { at: number; list: JudgeCandidate[] } | undefined

  /**
   * @param options - candidate source, cache, and cooldown policy.
   */
  constructor(options: ChainJudgeOptions) {
    this.#options = options
  }

  /** Candidates, re-resolved at most once per second. */
  #list(): JudgeCandidate[] {
    const now = Date.now()
    if (this.#resolved !== undefined && now - this.#resolved.at < CANDIDATE_TTL_MS) return this.#resolved.list
    const list = [...this.#options.candidates()]
    this.#resolved = { at: now, list }
    return list
  }

  /**
   * Whether a candidate is currently usable.
   * @param candidate - the candidate to test.
   * @returns true when it is not cooling down and can be instantiated.
   */
  #usable(candidate: JudgeCandidate): boolean {
    const identity = `${candidate.provider}/${candidate.model}`
    const until = this.#rejections.get(identity)
    if (until !== undefined && until > Date.now()) return false
    if (until !== undefined) this.#rejections.delete(identity)
    return true
  }

  /** {@inheritDoc JudgmentService.available} */
  available(): boolean {
    return this.#list().some(candidate => this.#usable(candidate))
  }

  /** {@inheritDoc JudgmentService.label} */
  label(): string {
    const [first] = this.#list()
    return first === undefined ? 'none' : first.label
  }

  /** Candidates currently inside a rejection cooldown, for diagnostics. */
  cooling(): string[] {
    const now = Date.now()
    const cooling: string[] = []
    for (const [identity, until] of this.#rejections) {
      if (until > now) cooling.push(identity)
    }
    return cooling
  }

  /** {@inheritDoc JudgmentService.judge} */
  async judge<Q extends Questions>(
    request: JudgmentRequest<Q>,
    options: JudgeOptions = {},
  ): Promise<JudgmentResult<Q>> {
    const key = judgmentKey(request)
    const cached = this.#options.cache.get<Q>(key)
    if (cached !== undefined) return cached

    const candidates = this.#list()
    if (candidates.length === 0) throw new Error('judgment: no judge model available')

    let lastFailure: string | undefined
    let lastUnavailable: string | undefined

    for (const candidate of candidates) {
      if (stopped(options.signal)) throw abortReason(options.signal)

      const identity = `${candidate.provider}/${candidate.model}`
      if (!this.#usable(candidate)) {
        lastUnavailable = `${identity} rejected the account recently`
        continue
      }

      let judge: Judge | undefined
      try {
        judge = candidate.create()
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error)
        continue
      }
      if (judge === undefined) {
        lastUnavailable = `no credential for ${identity}`
        continue
      }

      try {
        const result = await judge.judge(request, options)
        this.#options.cache.set<Q>(key, result)
        return result
      } catch (error) {
        if (stopped(options.signal)) throw abortReason(options.signal)
        if (isTimeout(error)) throw error
        if (error instanceof JudgmentHttpError && ACCOUNT_REJECTION_STATUSES.has(error.status)) {
          this.#rejections.set(identity, Date.now() + this.#options.rejectionCooldownMs)
        }
        lastFailure = error instanceof Error ? error.message : String(error)
      }
    }

    throw new Error(`judgment: every judge candidate failed: ${lastFailure ?? lastUnavailable ?? 'unknown error'}`)
  }
}

/** The reason an aborted signal carries, as an Error. */
function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason
  return reason instanceof Error ? reason : new Error('judgment aborted')
}

/** Whether an error is this module's own per-call timeout rather than a provider failure. */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && /judgment: (chat )?timed out after/u.test(error.message)
}
