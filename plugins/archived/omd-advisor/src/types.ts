/**
 * `omd-advisor/types` — the judgment-service vocabulary this package consumes.
 *
 * The provider is `plugins/judgment/omd-judgment`; this module re-declares only the
 * slice a consumer needs, because the link farm carries no sibling `omd-*`
 * package. The `Context` module augmentation in `index.ts` merges with the
 * provider's identical declaration, so both spellings of `judgment` resolve to
 * this interface.
 *
 * @module omd-advisor/types
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** JSON-compatible value; readonly containers are accepted so `as const` state passes through. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/** The content a request evaluates: plain text, or a named-field object / array for multi-part context. */
export type JudgmentState = string | { readonly [key: string]: JsonValue } | readonly JsonValue[]

/** Pick one option from a fixed set. `criteria` maps option → rubric (`null` when the name suffices). */
export interface ChoiceQuestion<L extends string = string> {
  readonly type: 'choice'
  readonly instructions: string
  readonly criteria: Record<L, string | null>
}

/** Probability that a yes/no condition holds. `criteria` optionally spells out what yes and no mean. */
export interface NoulQuestion {
  readonly type: 'noul'
  readonly instructions: string
  readonly criteria?: { readonly true?: string; readonly false?: string }
}

/** Position on ordered levels; `criteria` lists at least two level descriptions from lowest to highest. */
export interface ScoreQuestion {
  readonly type: 'score'
  readonly instructions: string
  readonly criteria: readonly [string, string, ...string[]]
}

/** Any question a caller can ask the judge. */
export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion

/** Questions keyed by caller-chosen ids; answers come back under the same ids. */
export type Questions = Record<string, Question>

/** One label chosen from a question's fixed set, with its calibrated confidence. */
export interface ChoiceAnswer<L extends string = string> {
  readonly type: 'choice'
  readonly choice: L
  readonly probabilities: Record<L, number>
  readonly confidence: number
}

/** Probability that the asked condition holds, in `[0, 1]`. */
export interface NoulAnswer {
  readonly type: 'noul'
  readonly noul: number
}

/** Index into the question's ordered levels, with its calibrated confidence. */
export interface ScoreAnswer {
  readonly type: 'score'
  readonly score: number
  readonly probabilities: Record<string, number>
  readonly confidence: number
}

/** Any answer the judge returns. */
export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer

/** The answer type for a question, preserving choice labels. */
export type AnswerFor<Q extends Question> = Q extends ChoiceQuestion<infer L>
  ? ChoiceAnswer<L>
  : Q extends NoulQuestion
    ? NoulAnswer
    : ScoreAnswer

/** One judgment call: the state to evaluate and the questions to answer about it. */
export interface JudgmentRequest<Q extends Questions = Questions> {
  readonly state: JudgmentState
  readonly questions: Q
}

/** One judgment result: which backend answered, the typed answers, and its billed usage. */
export interface JudgmentResult<Q extends Questions = Questions> {
  readonly api: string
  readonly provider: string
  readonly model: string
  readonly answers: { [K in keyof Q]: AnswerFor<Q[K]> }
  readonly usage: TokenUsage
}

/** Per-call judgment controls. */
export interface JudgeOptions {
  readonly signal?: AbortSignal
}

/**
 * The judgment service handle mounted by `plugins/judgment/omd-judgment` and consumed
 * here. It is optional: `ctx.get('judgment')` returns `undefined` when the
 * provider is absent, and every call site in this package treats that as
 * "do nothing" rather than throwing.
 */
export interface JudgmentService {
  /** At least one candidate has credentials and is not in a rejection cooldown. */
  available(): boolean
  /** Current preferred candidate's label, e.g. `magpie/group/decider` or `chat:...`. `none` when no candidate exists. */
  label(): string
  /**
   * Answer every question about `request.state`.
   * @param request - the state and the typed questions to answer.
   * @param options - optional cancellation for this call.
   * @returns the typed answers plus the answering backend and its usage.
   */
  judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>>
}
