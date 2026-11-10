/**
 * Answer normalization: turn what a backend emitted into the exact answer shape
 * a question requires.
 *
 * Native endpoints return structured payloads; the chat backend returns text
 * lines that are first reduced to a bare value. Both funnels end here, so the
 * two backends cannot drift on what a valid answer means. Anything outside the
 * contract is a parse error, never a silent default.
 *
 * @module omd-judgment/answers
 */

import type {
  Answer,
  AnswerFor,
  ChoiceAnswer,
  ChoiceQuestion,
  NoulAnswer,
  NoulQuestion,
  Question,
  Questions,
  ScoreAnswer,
  ScoreQuestion,
} from './types.ts'
import { JudgmentParseError } from './types.ts'

/** Read a finite number out of a loose payload, or fail. */
function finite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new JudgmentParseError(`judgment: expected a finite number for ${what}, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Clamp a probability into `[0, 1]`, treating out-of-range input as 0. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** Sum of non-negative entries of a distribution. */
function sum(probs: Record<string, number>): number {
  let total = 0
  for (const value of Object.values(probs)) total += clamp01(value)
  return total
}

/** Read a finite number out of a loose payload, returning undefined when absent. */
function optFinite(value: unknown, what: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new JudgmentParseError(`judgment: expected a finite number for ${what}, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Reduce any non-empty string to its lower-cased trimmed form. */
function labelOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  return trimmed === '' ? undefined : trimmed
}

/** Parse one `choice` answer from a structured payload or a bare label. */
function normalizeChoice<L extends string>(question: ChoiceQuestion<L>, raw: unknown): ChoiceAnswer<L> {
  const criteria = question.criteria
  const labels = Object.keys(criteria)
  if (labels.length === 0) throw new JudgmentParseError('judgment: a choice question needs at least one label')

  let choice: string | undefined
  let probabilities: unknown
  let confidence: unknown

  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>
    choice = labelOf(record.choice)
    probabilities = record.probabilities
    confidence = record.confidence
  } else {
    choice = labelOf(raw)
  }
  if (choice === undefined) {
    throw new JudgmentParseError(`judgment: choice answer for "${question.instructions}" named no label`)
  }

  const index = labels.findIndex(label => label.toLowerCase() === choice)
  if (index < 0) {
    throw new JudgmentParseError(
      `judgment: choice answer "${choice}" is not one of ${labels.join(', ')}`,
    )
  }
  const winner = labels[index] as L

  if (probabilities === undefined) {
    // Chat path: only the chosen label is known, so the distribution is one-hot.
    const oneHot = {} as Record<L, number>
    for (const label of labels) oneHot[label as L] = label === winner ? 1 : 0
    return { type: 'choice', choice: winner, probabilities: oneHot, confidence: 1 }
  }

  if (probabilities === null || typeof probabilities !== 'object' || Array.isArray(probabilities)) {
    throw new JudgmentParseError(`judgment: probabilities for "${question.instructions}" must be an object`)
  }
  const source = probabilities as Record<string, unknown>
  const distribution = {} as Record<L, number>
  for (const label of labels) distribution[label as L] = clamp01(finite(source[label], `${label} probability`))
  if (sum(distribution as Record<string, number>) <= 0) {
    throw new JudgmentParseError(`judgment: probabilities for "${question.instructions}" do not sum to a positive value`)
  }
  return {
    type: 'choice',
    choice: winner,
    probabilities: distribution,
    confidence: clamp01(optFinite(confidence, 'confidence') ?? distribution[winner]),
  }
}

/** Parse one `noul` answer from a structured payload, a number, or yes/no text. */
function normalizeNoul(question: NoulQuestion, raw: unknown): NoulAnswer {
  let value: unknown
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    value = (raw as Record<string, unknown>).noul
  } else if (typeof raw === 'number') {
    value = raw
  } else {
    const text = labelOf(raw)
    if (text === undefined) {
      throw new JudgmentParseError(`judgment: noul answer for "${question.instructions}" was unreadable`)
    }
    if (text === 'yes' || text === 'true' || text === '1') value = 1
    else if (text === 'no' || text === 'false' || text === '0') value = 0
    else throw new JudgmentParseError(`judgment: noul answer "${text}" is neither yes/no nor a number`)
  }
  const numeric = finite(value, 'noul')
  if (numeric < 0 || numeric > 1) throw new JudgmentParseError(`judgment: noul ${numeric} is outside [0, 1]`)
  return { type: 'noul', noul: numeric }
}

/** Parse one `score` answer from a structured payload or a bare level index. */
function normalizeScore(question: ScoreQuestion, raw: unknown): ScoreAnswer {
  const n = question.criteria.length
  if (n < 2) throw new JudgmentParseError('judgment: a score question needs at least two levels')

  let score: unknown
  let probabilities: unknown
  let confidence: unknown

  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>
    score = record.score
    probabilities = record.probabilities
    confidence = record.confidence
  } else if (typeof raw === 'number') {
    score = raw
  } else {
    const text = labelOf(raw)
    if (text === undefined) {
      throw new JudgmentParseError(`judgment: score answer for "${question.instructions}" was unreadable`)
    }
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) {
      throw new JudgmentParseError(`judgment: score answer "${text}" is not an integer level index`)
    }
    score = parsed
  }
  const level = Math.trunc(finite(score, 'score'))
  if (level < 0 || level >= n) {
    throw new JudgmentParseError(`judgment: score level ${level} is outside 0..${n - 1}`)
  }

  if (probabilities === undefined) {
    const oneHot = {} as Record<string, number>
    for (let i = 0; i < n; i += 1) oneHot[String(i)] = i === level ? 1 : 0
    return { type: 'score', score: level, probabilities: oneHot, confidence: 1 }
  }
  if (probabilities === null || typeof probabilities !== 'object' || Array.isArray(probabilities)) {
    throw new JudgmentParseError(`judgment: probabilities for "${question.instructions}" must be an object`)
  }
  const source = probabilities as Record<string, unknown>
  const distribution: Record<string, number> = {}
  for (let i = 0; i < n; i += 1) distribution[String(i)] = clamp01(finite(source[String(i)], `level ${i} probability`))
  if (sum(distribution) <= 0) {
    throw new JudgmentParseError(`judgment: probabilities for "${question.instructions}" do not sum to a positive value`)
  }
  return {
    type: 'score',
    score: level,
    probabilities: distribution,
    confidence: clamp01(optFinite(confidence, 'confidence') ?? distribution[String(level)] ?? 0),
  }
}

/**
 * Reduce one raw answer to the shape its question requires.
 * @param question - the question the raw payload answers.
 * @param raw - the payload exactly as the backend emitted it.
 * @returns the normalized answer.
 */
export function normalizeAnswer<Q extends Question>(question: Q, raw: unknown): AnswerFor<Q> {
  if (question.type === 'choice') return normalizeChoice(question, raw) as AnswerFor<Q>
  if (question.type === 'noul') return normalizeNoul(question, raw) as AnswerFor<Q>
  return normalizeScore(question, raw) as AnswerFor<Q>
}

/**
 * Normalize every answer of a request, preserving the question's key set.
 * @param questions - the request's questions.
 * @param answers - one raw payload per question key.
 * @returns one normalized answer per question key.
 */
export function normalizeAnswers<Q extends Questions>(
  questions: Q,
  answers: Record<string, unknown> | undefined,
): Record<string, Answer> {
  const out: Record<string, Answer> = {}
  for (const [key, question] of Object.entries(questions)) {
    out[key] = normalizeAnswer(question, answers?.[key])
  }
  return out
}

/** Flatten any answer to the single value a consumer is usually after. */
export function answerValue(answer: Answer): number | string {
  if (answer.type === 'choice') return answer.choice
  if (answer.type === 'noul') return answer.noul
  return answer.score
}

/**
 * Confidence of any answer.
 * @param answer - a normalized answer.
 * @returns the backend's stated confidence, or `undefined` for a `noul` answer.
 */
export function answerConfidence(answer: Answer): number | undefined {
  if (answer.type === 'noul') return undefined
  return answer.confidence
}
