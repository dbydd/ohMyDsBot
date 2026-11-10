/**
 * Vocabulary of a judgment call: the state a decision is made over, the
 * questions asked about it, and the answers a backend must produce.
 *
 * Every consumer of `ctx.judgment` shares these types; a backend owns only the
 * wire, never the vocabulary. Values are plain JSON so a request can be hashed
 * for caching and echoed into a log without loss.
 *
 * @module omd-judgment/types
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** Any JSON value a judgment state may carry. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/** The material a judgment is made over: text, an object, or an ordered list. */
export type JudgmentState = string | { readonly [key: string]: JsonValue } | readonly JsonValue[]

/** One label of a `choice` question. A `null` criterion marks the label as discouraged. */
export interface ChoiceQuestion<Label extends string = string> {
  /** Discriminator; selects the answer shape. */
  type: 'choice'
  /** What the judge is deciding, in one sentence. */
  instructions: string
  /** Every admissible label, mapped to the criterion that admits it (or `null`). */
  criteria: Record<Label, string | null>
}

/** A truth value in `[0, 1]` rather than a hard yes/no. */
export interface NoulQuestion {
  /** Discriminator; selects the answer shape. */
  type: 'noul'
  /** What the judge is deciding, in one sentence. */
  instructions: string
  /** Optional wording for the two poles; backends may render them as anchors. */
  criteria?: { true?: string; false?: string }
}

/** A judgement on an ordered scale given by `criteria`. */
export interface ScoreQuestion {
  /** Discriminator; selects the answer shape. */
  type: 'score'
  /** What the judge is deciding, in one sentence. */
  instructions: string
  /** At least two ordered levels, lowest first; the answer is an index into this tuple. */
  criteria: readonly [string, string, ...string[]]
}

/** Any question a caller may ask. */
export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion

/** A named set of questions answered in one round trip. */
export type Questions = Record<string, Question>

/** Answer to a {@link ChoiceQuestion}. */
export interface ChoiceAnswer<Label extends string = string> {
  /** Discriminator copied from the question. */
  type: 'choice'
  /** The chosen label; always a key of the question's `criteria`. */
  choice: Label
  /** Full distribution over every label, normalized to sum to 1. */
  probabilities: Record<Label, number>
  /** Probability the backend attached to `choice`, clamped to `[0, 1]`. */
  confidence: number
}

/** Answer to a {@link NoulQuestion}. */
export interface NoulAnswer {
  /** Discriminator copied from the question. */
  type: 'noul'
  /** Truth value in `[0, 1]`. */
  noul: number
}

/** Answer to a {@link ScoreQuestion}. */
export interface ScoreAnswer {
  /** Discriminator copied from the question. */
  type: 'score'
  /** Index into the question's `criteria`. */
  score: number
  /** Full distribution over the levels, keyed by `'0'`..`'n-1'`. */
  probabilities: Record<string, number>
  /** Probability the backend attached to `score`, clamped to `[0, 1]`. */
  confidence: number
}

/** Any answer a backend may return. */
export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer

/** The answer type a given question requires. */
export type AnswerFor<Q extends Question> = Q extends ChoiceQuestion<infer Label>
  ? ChoiceAnswer<Label>
  : Q extends NoulQuestion
    ? NoulAnswer
    : ScoreAnswer

/** One judgment call. */
export interface JudgmentRequest<Q extends Questions = Questions> {
  /** The material the questions are asked about. */
  state: JudgmentState
  /** Named questions; every key receives exactly one answer. */
  questions: Q
}

/** One settled judgment call. */
export interface JudgmentResult<Q extends Questions = Questions> {
  /** Wire dialect that answered, e.g. `typesafe` or `chat`. */
  api: string
  /** Provider route the answer came from. */
  provider: string
  /** Model id the provider reported, or the configured one when it reported none. */
  model: string
  /**
   * One answer per requested question key.
   *
   * The map is keyed by question id rather than typed per key, because which
   * answer shape a key carries is only decided at runtime by the question the
   * caller built. Narrow on `answer.type` (or use `answerValue`) after the
   * lookup; `Q` is retained so a caller with a literal question map can assert
   * the precise shape itself.
   */
  answers: Record<keyof Q & string, Answer>
  /** Provider-reported usage for this call. */
  usage: TokenUsage
}

/** Options every backend honours. */
export interface JudgeOptions {
  /** Cancels the call; a settled abort is rethrown as the signal's reason. */
  signal?: AbortSignal
}

/** One judgment backend. */
export interface Judge {
  /** Stable human-readable identity used in diagnostics. */
  readonly label: string
  /** Answer a request. */
  judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>>
}

/** The service `ctx.judgment` publishes. */
export interface JudgmentService {
  /** Whether at least one candidate is credentialed and not cooling down. */
  available(): boolean
  /** Label of the candidate a call would try first, or `none`. */
  label(): string
  /** Answer a request through the candidate chain. */
  judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Decision-model judge; present only when `omd-judgment` is mounted. */
    judgment: JudgmentService
  }
}

/** A backend produced syntactically invalid or inconsistent answers. */
export class JudgmentParseError extends Error {
  /**
   * @param message - what was wrong with the payload, in one sentence.
   */
  constructor(message: string) {
    super(message)
    this.name = 'JudgmentParseError'
  }
}

/** A judgment endpoint answered with a non-2xx status. */
export class JudgmentHttpError extends Error {
  /** HTTP status the endpoint answered with. */
  readonly status: number

  /**
   * @param message - diagnosis naming the route and what the endpoint said.
   * @param status - the HTTP status, preserved for cooldown decisions.
   */
  constructor(message: string, status: number) {
    super(message)
    this.name = 'JudgmentHttpError'
    this.status = status
  }
}
