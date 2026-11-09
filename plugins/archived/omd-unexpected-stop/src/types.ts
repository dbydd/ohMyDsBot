/**
 * Vocabulary of the `judgment` service, declared structurally so this package
 * loads and type-checks without depending on `omd-judgment`.
 *
 * The owning package provides the service and declares `Context.judgment`; a
 * consumer copies the shapes it reads. The copies are structural, so the two
 * declarations stay compatible as long as the wire shapes agree.
 *
 * @module omd-unexpected-stop/types
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** Lossless JSON, the only value shape the judge may carry across its boundary. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/** The material under judgment: plain text, a JSON object, or a JSON array. */
export type JudgmentState = string | { readonly [key: string]: JsonValue } | readonly JsonValue[]

/** Pick exactly one label; `criteria[label]` describes what selecting it means. */
export interface ChoiceQuestion<Label extends string = string> {
  type: 'choice'
  instructions: string
  criteria: Record<Label, string | null>
}

/** Answer with a calibrated probability in `[0, 1]` that the statement holds. */
export interface NoulQuestion {
  type: 'noul'
  instructions: string
  criteria?: { true?: string; false?: string }
}

/** Answer with the ordered level whose description matches, lowest first. */
export interface ScoreQuestion {
  type: 'score'
  instructions: string
  criteria: readonly [string, string, ...string[]]
}

/** One judgment question; its `type` fixes the shape of its answer. */
export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion

/** A batch addressed by stable ids, one answer per id. */
export type Questions = Record<string, Question>

/** Answer to a {@link ChoiceQuestion}. */
export interface ChoiceAnswer<Label extends string = string> {
  type: 'choice'
  choice: Label
  probabilities: Record<Label, number>
  confidence: number
}

/** Answer to a {@link NoulQuestion}. */
export interface NoulAnswer {
  type: 'noul'
  noul: number
}

/** Answer to a {@link ScoreQuestion}; `score` indexes `criteria`. */
export interface ScoreAnswer {
  type: 'score'
  score: number
  probabilities: Record<string, number>
  confidence: number
}

/** Any answer; discriminate on `type`. */
export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer

/** The answer shape a question type obliges. */
export type AnswerFor<Q extends Question> = Q extends ChoiceQuestion<infer Label>
  ? ChoiceAnswer<Label>
  : Q extends NoulQuestion
    ? NoulAnswer
    : ScoreAnswer

/** One batch of judgments over one piece of state. */
export interface JudgmentRequest<Q extends Questions = Questions> {
  state: JudgmentState
  questions: Q
}

/** Answers plus the route and token accounting of the call that produced them. */
export interface JudgmentResult<Q extends Questions = Questions> {
  api: string
  provider: string
  model: string
  answers: { [K in keyof Q]: AnswerFor<Q[K]> }
  usage: TokenUsage
}

/** Per-call options accepted by a judge. */
export interface JudgeOptions {
  signal?: AbortSignal
}

/** The `judgment` service surface this package consumes. */
export interface JudgmentService {
  /**
   * At least one candidate has credentials and is not in rejection cooldown.
   * @returns whether a judge call could currently succeed.
   */
  available(): boolean
  /**
   * Label of the preferred candidate.
   * @returns the candidate label, or `none` when the chain is empty.
   */
  label(): string
  /**
   * Answer one batch through the candidate chain.
   * @param request - state under judgment and the questions to answer.
   * @param options - cancellation for the whole chain.
   * @returns answers, route identity, and usage.
   */
  judge<Q extends Questions>(
    request: JudgmentRequest<Q>,
    options?: JudgeOptions,
  ): Promise<JudgmentResult<Q>>
}
