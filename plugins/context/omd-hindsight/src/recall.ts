/**
 * L2 adaptive recall: build a query from this turn's prompt, the last turn's
 * tool output and the recent task context; query every enabled bank in
 * parallel; rank the candidates; render the reference `hindsight.recall`
 * injection text.
 *
 * Automatic path (INV-7): every failure is "no injection this turn", never an
 * exception into the agent. The judge sees queries, task context and candidate
 * previews only — never document bodies (INV-12). Every tunable lives in
 * `runtime.config`; no defaults are buried here.
 *
 * @module omd-hindsight/recall
 */

import { RECALL_FENCE } from '../ssot/spec.ts'
import type { RecallOptions } from './core/client.ts'
import { decideInjection, type ChoiceQuestion, type ExecutionEnv, type JudgePort } from './core/judge.ts'
import { buildPath } from './core/paths.ts'
import type { PromptPack } from './core/prompt-pack.ts'
import { filterByAnchors, reciprocalRankFusion, type ScoredCandidate } from './core/rank.ts'
import type { BankConfig, HindsightConfig, InternalPath, TagsMatch } from './core/types.ts'
import type { HindsightRuntime } from './runtime.ts'

/** Source fields of the durable recall message; the renderer and queries share this identity. */
export const RECALL_SOURCE_KIND = 'hindsight'
export const RECALL_SOURCE_FORM = 'recall'

/** Reverse anti-pattern channel tag: written by the knowledge base, read only here. */
const ANTI_PATTERN_TAG = 'knowledge:anti_pattern'

/** `details.fence` carries the bare fence name, without angle brackets. */
const FENCE_NAME = RECALL_FENCE.open.replace(/[<>]/g, '')

const FACT_TYPES = ['world', 'experience', 'observation'] as const
type FactType = (typeof FACT_TYPES)[number]

const BUDGETS = ['low', 'mid', 'high'] as const
type RecallBudget = (typeof BUDGETS)[number]

// ─────────────────────────────────────────────────────────────
// Query construction
// ─────────────────────────────────────────────────────────────

/** One sampled turn: the role is filtered by the caller per `recallContextRoles`; text already clamped. */
export interface RecallTurnSample {
  readonly role: string
  readonly text: string
}

export interface LastTurn {
  /** Latest assistant body (clamped to its tail). */
  readonly assistant?: string
  /** Latest tool output body (clamped to its tail). */
  readonly toolResult?: string
}

export interface BuildQueryInput {
  readonly lastTurn?: LastTurn
  /** Sampled and clamped by the caller per recallContextTurns / recallContextRoles / recallTurnSampleChars. */
  readonly taskContext?: readonly RecallTurnSample[]
}

export interface AdaptiveRecallQuery {
  readonly query: string
  /** The latest output carries an error fingerprint: debounce must yield, and the query targets troubleshooting. */
  readonly isError: boolean
  /** Assembled task context for the rerank focus; null when there is none. */
  readonly taskContext: string | null
}

/**
 * Three error fingerprints, most specific first:
 * 1. exception class names (`TypeError: …`, `java.lang.NullPointerException`);
 * 2. lines starting with error/fatal/panic (`error: connect ECONNREFUSED`), line-anchored so
 *    prose that happens to mention an "error branch" is not a failure;
 * 3. language/tool error codes and status codes (`ENOENT`, `ORA-01461`, `HTTP 500`, `exit code 1`).
 */
const ERROR_PATTERNS = [
  /\b[A-Za-z_][A-Za-z0-9_]*(?:Error|Exception)\b[^\n]{0,160}/,
  /(?:^|\n)\s*(?:error|fatal|panic|traceback)\b[^\n]{0,160}/i,
  /\b(?:E[A-Z]{2,14}|TS\d{3,5}|[A-Z]{2,6}-\d{2,5}|HTTP\s?\d{3}|exit code:?\s?\d+|status\s?\d{3})\b[^\n]{0,120}/,
] as const

/**
 * The error fingerprint prefers tool output (that is what just ran), then a stack pasted into
 * the prompt, then the assistant's own words. The intent sentence is the prompt's first
 * sentence: later sentences are detail and only dilute the search terms. Task context never
 * enters the query — it tells the judge what we are doing, and mixing it into retrieval terms
 * lowers recall.
 */
export function buildAdaptiveRecallQuery(
  prompt: string,
  config: HindsightConfig,
  input?: BuildQueryInput,
): AdaptiveRecallQuery {
  const lastTurn = input?.lastTurn
  const signature =
    errorSignature(lastTurn?.toolResult, config) ??
    errorSignature(prompt, config) ??
    errorSignature(lastTurn?.assistant, config)
  const intent = intentSentence(prompt, config) ?? intentSentence(lastTurn?.assistant, config) ?? ''
  const query = [intent, signature].filter((part): part is string => part !== null && part.length > 0).join(' ')
  return { query, isError: signature !== null, taskContext: taskContextText(input?.taskContext) }
}

function intentSentence(text: string | undefined, config: HindsightConfig): string | null {
  if (text === undefined) return null
  const flattened = text.replace(/\s+/g, ' ').trim()
  if (flattened.length === 0) return null
  const limit = Math.max(1, config.recallIntentMaxChars)
  // A short prompt goes in whole: the first sentence is often just setup ("run date once first")
  // and the thing to find is in the next one. Only a prompt over budget falls back to the first
  // sentence, where the subject usually lives.
  if (flattened.length <= limit) return flattened
  // Cut on CJK and ASCII terminal punctuation; ASCII periods stay for paths, versions and decimals.
  const stop = flattened.search(/[。！？!?；;]/)
  const sentence = stop > 0 ? flattened.slice(0, stop) : flattened
  return sentence.length > limit ? `${sentence.slice(0, limit)}…` : sentence
}

function errorSignature(text: string | undefined, config: HindsightConfig): string | null {
  if (text === undefined || text.length === 0) return null
  const limit = Math.max(1, config.recallSignatureMaxChars)
  for (const pattern of ERROR_PATTERNS) {
    const matched = pattern.exec(text)
    if (matched === null) continue
    const line = matched[0].replace(/\s+/g, ' ').trim()
    if (line.length === 0) continue
    return line.length > limit ? line.slice(0, limit) : line
  }
  return null
}

function taskContextText(samples: readonly RecallTurnSample[] | undefined): string | null {
  if (samples === undefined) return null
  const lines: string[] = []
  for (const sample of samples) {
    const text = sample.text.replace(/\s+/g, ' ').trim()
    if (text.length === 0) continue
    lines.push(`${sample.role}: ${text}`)
  }
  return lines.length === 0 ? null : lines.join('\n')
}

// ─────────────────────────────────────────────────────────────
// Debounce
// ─────────────────────────────────────────────────────────────

/**
 * Fingerprint of the most recent operation focus. Once the same focus repeats past the window,
 * recall is skipped: `recallDebounceTurns = 3` allows three consecutive refreshes, the fourth
 * stops. A zero (or invalid) window disables debounce.
 */
export class DebounceTracker {
  readonly #window: number
  #last: string | null = null
  #repeats = 0

  constructor(turns: number) {
    this.#window = Number.isFinite(turns) && turns > 0 ? Math.floor(turns) : 0
  }

  /** True when the focus has not moved and the window is spent (the caller skips recall). */
  unchanged(fingerprint: string): boolean {
    if (this.#window === 0) return false
    if (fingerprint !== this.#last) {
      this.#last = fingerprint
      this.#repeats = 0
      return false
    }
    this.#repeats += 1
    return this.#repeats >= this.#window
  }

  reset(): void {
    this.#last = null
    this.#repeats = 0
  }
}

// ─────────────────────────────────────────────────────────────
// Injection payload (durable source details)
// ─────────────────────────────────────────────────────────────

/** One memory fact as the durable source records it. */
export interface RecallFactDetail {
  readonly bank: string
  readonly id: string
  readonly text: string
  readonly type: string | null
  /** The fact's address. */
  readonly path: InternalPath
  /** The chunk that supports this fact; null when there is none. */
  readonly chunkPath: InternalPath | null
  /** Came from the reverse anti-pattern channel (`knowledge:anti_pattern`). */
  readonly antiPattern: boolean
}

/** `source.details` of a durable recall message. Exactly these four fields. */
export interface RecallDetails {
  readonly query: string
  readonly banks: readonly string[]
  readonly facts: readonly RecallFactDetail[]
  readonly fence: typeof FENCE_NAME
}

/** What the lifecycle appends: the model-facing text plus its durable source details. */
export interface RecallInjection {
  readonly text: string
  readonly details: RecallDetails
}

interface BankHit {
  readonly bank: BankConfig
  readonly id: string
  readonly text: string
  readonly type: string | null
  readonly chunkId: string | null
  readonly score: number
  readonly antiPattern: boolean
}

function toScoredCandidate(hit: BankHit): ScoredCandidate & { readonly hit: BankHit } {
  return { id: hit.id, bankId: hit.bank.id, text: hit.text, score: hit.score, hit }
}

// ─────────────────────────────────────────────────────────────
// Logging: the host logger is attached at assembly so the automatic path is not silent
// ─────────────────────────────────────────────────────────────

export interface RecallLogger {
  warn(message: string, context?: Record<string, unknown>): void
}

let logger: RecallLogger | undefined

export function setRecallLogger(next: RecallLogger | undefined): void {
  logger = next
}

export interface AdaptiveRecallOptions {
  /** Task context for the inject-decision focus; null when there is none. */
  readonly taskContext?: string | null
  /** Trigger point for the inject decision. */
  readonly trigger?: string
  /** Injected count this session; the judge reads it as "these memories are already in use". */
  readonly injectedThisSession?: number
  /** Memory ids already injected this session: dedupe is deterministic, not a judge guess. */
  readonly excludeIds?: ReadonlySet<string>
  /** Decision environment; the automatic path is a read-only recall, so the default suffices. */
  readonly env?: ExecutionEnv
}

function warn(message: string, context: Record<string, unknown>): void {
  logger?.warn(message, context)
}

// ─────────────────────────────────────────────────────────────
// Main flow
// ─────────────────────────────────────────────────────────────

export async function performAdaptiveRecall(
  runtime: HindsightRuntime,
  query: string,
  judgePort: JudgePort | undefined,
  options: AdaptiveRecallOptions = {},
): Promise<RecallInjection | undefined> {
  try {
    const config = runtime.config
    const banks = config.banks.filter((bank) => bank.recall.enabled)
    if (banks.length === 0) return undefined

    const trimmed = query.trim().slice(0, Math.max(1, config.recallMaxQueryChars))
    if (trimmed.length === 0) return undefined

    const sampled = (options.taskContext ?? '').trim()
    const context = sampled.length === 0 ? null : sampled

    const settled = await Promise.allSettled(
      banks.map(async (bank) => ({ bank, hits: await recallBank(runtime, bank, trimmed) })),
    )

    const reached: string[] = []
    const hits: BankHit[] = []
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        reached.push(outcome.value.bank.id)
        hits.push(...outcome.value.hits)
      } else {
        warn('hindsight.recall.bank_failed', {
          bank: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        })
      }
    }
    if (reached.length === 0) {
      warn('hindsight.recall.no_bank_reached', { banks: banks.map((bank) => bank.id) })
      return undefined
    }

    // Strip what this session already injected first: "the model is already using it" is a
    // fact here, not an inference for the judge.
    const unique = dedupe(hits).filter((hit) => options.excludeIds?.has(hit.id) !== true)
    const antiPatterns = unique
      .filter((hit) => hit.antiPattern)
      .slice(0, Math.max(0, config.recallAntiPatternLimit))
    // Without the inject judge, a deterministic lexical anchor gate stands in: keep candidates
    // sharing at least `recallProgrammaticMinSharedTerms` content anchors with the query. Anchors
    // come from the query, not the task context — the context is tens of thousands of characters
    // and any candidate would collide with one or two words.
    const minShared = config.recallInjectJudge ? 0 : Math.max(0, config.recallProgrammaticMinSharedTerms)
    const regular = filterByAnchors(
      unique.filter((hit) => !hit.antiPattern),
      trimmed,
      minShared,
    )
    const banksWithHits = new Set(regular.map((hit) => hit.bank.id))
    const topK = Math.max(1, config.recallTopK)

    // Rerank only earns a judgment when truncation is an actual choice: candidates from several
    // banks (raw scores are not comparable; RRF unifies them) or a single bank with more
    // candidates than K while task context exists. Fewer candidates than K need no judgment.
    const needsRerank =
      config.recallRerankJudge &&
      judgePort !== undefined &&
      regular.length > topK &&
      (banksWithHits.size > 1 || context !== null)
    const chosen =
      regular.length === 0
        ? []
        : needsRerank
          ? (await rerank(config, runtime.promptPack, trimmed, regular, judgePort, context)).slice(0, topK)
          : banksWithHits.size > 1
            ? reciprocalRankFusion(regular.map(toScoredCandidate)).map((candidate) => candidate.hit).slice(0, topK)
            : byScore(regular).slice(0, topK)

    const pooled = [...chosen, ...antiPatterns]
    if (pooled.length === 0) return undefined

    // The second gate: reranking answers "which fits best"; this answers "give it at all".
    // Keyword collisions, memories already in use and irrelevance to the current action are
    // invisible to a rerank score and only visible to a judge holding both sides.
    const injection = judgePort === undefined
      ? { inject: true, confidence: 1, basis: 'fallback' as const }
      : await decideInjection(
        {
          trigger: options.trigger ?? 'prompt',
          query: trimmed,
          taskContext: context,
          injectedThisSession: options.injectedThisSession ?? 0,
          candidates: pooled.map((hit, index) => ({
            index: index + 1,
            bank: hit.bank.id,
            type: hit.type,
            summary: preview(hit.text, Math.max(1, config.recallPreviewChars)),
          })),
          topScore: chosen.length === 0 ? null : Math.max(...chosen.map((hit) => hit.score)),
        },
        config,
        options.env ?? { role: null, isReadonly: false },
        judgePort,
        runtime.promptPack.judge,
      )
    if (!injection.inject) {
      warn('hindsight.recall.inject_skipped', {
        trigger: options.trigger ?? 'prompt',
        candidates: pooled.length,
        confidence: injection.confidence,
      })
      return undefined
    }

    const details: RecallDetails = {
      query: trimmed,
      banks: reached,
      facts: pooled.map(toDetail),
      fence: FENCE_NAME,
    }
    return { text: renderRecallContent(config.recallQueryPreamble, details), details }
  } catch (error) {
    warn('hindsight.recall.failed', { error: error instanceof Error ? error.message : String(error) })
    return undefined
  }
}

async function recallBank(runtime: HindsightRuntime, bank: BankConfig, query: string): Promise<BankHit[]> {
  const signal = runtime.config.recallTimeoutMs > 0
    ? AbortSignal.timeout(runtime.config.recallTimeoutMs)
    : undefined
  const [main, antiPatterns] = await Promise.all([
    sendRecall(runtime, bank, query, signal, false),
    runtime.config.recallAntiPatternGuard
      ? sendRecall(runtime, bank, query, signal, true).catch((error: unknown) => {
        // The reverse channel is a bonus: its failure does not affect the main recall.
        warn('hindsight.recall.anti_pattern_failed', {
          bank: bank.id,
          error: error instanceof Error ? error.message : String(error),
        })
        return [] as BankHit[]
      })
      : Promise.resolve([] as BankHit[]),
  ])
  // The pool is bounded by the rerank limit, not topK: clamping each bank at topK would make
  // "more candidates than topK" impossible inside one bank and turn the rerank branch into
  // dead code. Final count is settled after ranking.
  const limit = Math.max(1, runtime.config.recallTopK, runtime.config.recallRerankCandidateLimit)
  return [
    ...main.slice(0, limit),
    ...antiPatterns.slice(0, Math.max(0, runtime.config.recallAntiPatternLimit)),
  ]
}

async function sendRecall(
  runtime: HindsightRuntime,
  bank: BankConfig,
  query: string,
  signal: AbortSignal | undefined,
  antiPattern: boolean,
): Promise<BankHit[]> {
  const scope =
    antiPattern
      // any_strict is required: `any` would return memories without the tag, which defeats the channel.
      ? { tags: [ANTI_PATTERN_TAG], tagsMatch: 'any_strict' as TagsMatch }
      : bank.recall.tags.length > 0
        ? { tags: [...bank.recall.tags], tagsMatch: bank.recall.tagsMatch }
        : {}
  const options: RecallOptions = {
    signal,
    maxTokens: bank.recall.maxTokens,
    types: antiPattern ? ['observation'] : factTypes(runtime.config.autoRecallTypes),
    preferObservations: runtime.config.recallPreferObservations,
    budget: budgetOf(runtime.config.recallBudget),
    ...scope,
  }
  const response = await runtime.client.recall(bank.bankId, query, options)
  return response.results.map((result) => ({
    bank,
    id: result.id,
    text: result.text,
    type: result.type ?? null,
    chunkId: typeof result.chunk_id === 'string' && result.chunk_id.length > 0 ? result.chunk_id : null,
    score: result.scores?.final ?? 0,
    antiPattern,
  }))
}

function factTypes(values: readonly string[]): FactType[] | undefined {
  const types = values.filter((value): value is FactType => (FACT_TYPES as readonly string[]).includes(value))
  return types.length === 0 ? undefined : types
}

function budgetOf(value: string): RecallBudget | undefined {
  return (BUDGETS as readonly string[]).includes(value) ? (value as RecallBudget) : undefined
}

// ─────────────────────────────────────────────────────────────
// Candidate rerank (judge `candidate_rerank`)
// ─────────────────────────────────────────────────────────────

/**
 * One judgment reranks every candidate: the question asks which one fits the current task,
 * and the rest get their relevance from `probabilities`, so the answer space is the candidate
 * list itself. `focus.task_context` is the other half of the input: with only a query, the
 * current focus inside a long task stopped being the prompt's first sentence long ago.
 * Candidates below `judgeAmbiguousConfidence` are dropped.
 */
async function rerank(
  config: HindsightConfig,
  pack: PromptPack,
  query: string,
  hits: readonly BankHit[],
  judgePort: JudgePort,
  taskContext: string | null,
): Promise<BankHit[]> {
  const candidates = byScore(hits).slice(0, Math.max(1, config.recallRerankCandidateLimit))
  const previewChars = Math.max(1, config.recallPreviewChars)
  const options: Record<string, string | null> = {}
  const indexed = new Map<string, BankHit>()
  candidates.forEach((hit, position) => {
    const option = `${hit.bank.id}#${position + 1}`
    options[option] = `${hit.bank.id} · ${hit.type ?? 'unknown'} · ${preview(hit.text, previewChars)}`
    indexed.set(option, hit)
  })

  const question: ChoiceQuestion = {
    type: 'choice',
    instructions: pack.recall.rerankInstructions,
    criteria: options,
  }
  const answers = await judgePort(
    {
      focus: taskContext === null ? { query } : { query, task_context: taskContext },
      ground_truth: {
        candidates: candidates.map((hit, position) => ({
          index: position + 1,
          bank: hit.bank.id,
          summary: preview(hit.text, previewChars),
        })),
      },
    },
    { candidate_rerank: question },
  )

  const answer = answers.candidate_rerank
  if (answer === undefined) throw new Error('judge did not answer candidate_rerank')
  if (!Object.hasOwn(options, answer.choice)) {
    throw new Error(`judge answered ${answer.choice}, outside the candidate_rerank option set (INV-4)`)
  }

  // Below the ambiguity threshold the reranker is undecided: fall back to raw retrieval scores
  // rather than emptying the candidate set.
  if (answer.confidence < config.judgeAmbiguousConfidence) {
    return byScore(hits)
  }

  const selectedHit = indexed.get(answer.choice)
  const remaining = candidates.filter((candidate) => candidate !== selectedHit)

  const probEntries = Object.entries(answer.probabilities)
  if (probEntries.length > 0) {
    remaining.sort((left, right) => probabilityOf(answer.probabilities, indexed, right) - probabilityOf(answer.probabilities, indexed, left))
  } else {
    remaining.sort((left, right) => right.score - left.score)
  }

  return selectedHit !== undefined
    ? [selectedHit, ...remaining]
    : byScore(hits)
}

function probabilityOf(
  probabilities: Record<string, number>,
  indexed: ReadonlyMap<string, BankHit>,
  hit: BankHit,
): number {
  for (const [option, candidate] of indexed) {
    if (candidate === hit) return probabilities[option] ?? 0
  }
  return 0
}

function byScore(hits: readonly BankHit[]): BankHit[] {
  return [...hits].sort((left, right) => right.score - left.score)
}

/**
 * The same memory can arrive through both channels; the anti-pattern conclusion is the one
 * that matters, so its copy is kept and the main-channel copy dropped — otherwise the same
 * warning is injected twice and counted as an ordinary fact.
 */
function dedupe(hits: readonly BankHit[]): BankHit[] {
  const byMemory = new Map<string, BankHit>()
  for (const hit of hits) {
    const key = `${hit.bank.id}\u0000${hit.id}`
    const previous = byMemory.get(key)
    if (previous === undefined || (!previous.antiPattern && hit.antiPattern)) byMemory.set(key, hit)
  }
  return [...byMemory.values()]
}

function toDetail(hit: BankHit): RecallFactDetail {
  return {
    bank: hit.bank.id,
    id: hit.id,
    text: hit.text,
    type: hit.type,
    path: buildPath(':bank/facts/:id', { bank: hit.bank.id, id: hit.id }),
    chunkPath:
      hit.chunkId === null ? null : buildPath(':bank/chunks/:id', { bank: hit.bank.id, id: hit.chunkId }),
    antiPattern: hit.antiPattern,
  }
}

function preview(text: string, chars: number): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  return flattened.length > chars ? `${flattened.slice(0, chars)}…` : flattened
}

// ─────────────────────────────────────────────────────────────
// Fence rendering: what the model sees
// ─────────────────────────────────────────────────────────────

function renderRecallContent(preamble: string, details: RecallDetails): string {
  const lines: string[] = []
  const trimmed = preamble.trim()
  if (trimmed.length > 0) lines.push(trimmed)
  lines.push(RECALL_FENCE.open)
  for (const fact of details.facts) {
    const label = fact.antiPattern ? 'anti-pattern · past failed attempt, do not retry' : (fact.type ?? 'unknown')
    lines.push(`- [${fact.bank}] (${label}) ${fact.text.replace(/\s+/g, ' ').trim()}`)
    lines.push(`  evidence: ${fact.chunkPath ?? fact.path}`)
  }
  lines.push(RECALL_FENCE.close)
  return lines.join('\n')
}
