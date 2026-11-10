/**
 * Copied judgment vocabulary for `omd-auto-thinking`.
 *
 * Reproduced verbatim from `plugins/judgment/omd-judgment/src/types.ts` so this package
 * does not import another `omd-*` package. The host's `Context` augmentation
 * merges automatically when `omd-judgment` is present.
 *
 * @module omd-auto-thinking/types
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [k: string]: JsonValue }

export type JudgmentState = string | { readonly [k: string]: JsonValue } | readonly JsonValue[]

export interface ChoiceQuestion<L extends string = string> {
  type: 'choice'
  instructions: string
  criteria: Record<L, string | null>
}

export interface NoulQuestion {
  type: 'noul'
  instructions: string
  criteria?: { true?: string; false?: string }
}

export interface ScoreQuestion {
  type: 'score'
  instructions: string
  criteria: readonly [string, string, ...string[]]
}

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion

export type Questions = Record<string, Question>

export interface ChoiceAnswer<L extends string = string> {
  type: 'choice'
  choice: L
  probabilities: Record<L, number>
  confidence: number
}

export interface NoulAnswer {
  type: 'noul'
  noul: number
}

export interface ScoreAnswer {
  type: 'score'
  score: number
  probabilities: Record<string, number>
  confidence: number
}

export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer

export type AnswerFor<Q extends Question> =
  Q extends ChoiceQuestion<infer L> ? ChoiceAnswer<L>
  : Q extends NoulQuestion ? NoulAnswer
  : ScoreAnswer

export interface JudgmentRequest<Q extends Questions = Questions> {
  state: JudgmentState
  questions: Q
}

export interface JudgmentResult<Q extends Questions = Questions> {
  api: string
  provider: string
  model: string
  answers: { [K in keyof Q]: AnswerFor<Q[K]> }
  usage: TokenUsage
}

export interface JudgeOptions {
  signal?: AbortSignal
}

export interface Judge {
  readonly label: string
  judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>>
}

export class JudgmentParseError extends Error {}

export interface JudgmentService {
  available(): boolean
  label(): string
  judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    judgment: JudgmentService
  }
}
