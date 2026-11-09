/**
 * `omd-advisor/guard` — the admission filter between an advisor model's
 * suggestions and the primary agent's transcript.
 *
 * Ported from omp's `advisor/emission-guard.ts`. The advisor prompt states a
 * per-update budget and forbids repeats; a real advisor model violates both.
 * One recorded omp session held 309 `advise` calls covering 92 unique notes,
 * 114 of them the bare word `Stop.` (issue #3520). The rules therefore live in
 * code, not prose, and every dropped suggestion carries the reason it was
 * dropped so the caller never reports one as delivered.
 *
 * This module is deliberately import-free: no host package, no node builtin.
 * It is the one piece of this plugin that is pure enough to reason about on
 * its own, and it must stay that way — the four rules are the whole policy.
 *
 * @module omd-advisor/guard
 */

/** Why a suggestion was suppressed. */
export type GuardDropReason = 'empty' | 'noise' | 'duplicate' | 'rate-limit'

/** One suggestion offered to the guard. */
export interface GuardInput {
  /** The advice text as the advisor wrote it. */
  readonly text: string
  /** Severity rank assigned by the judge: `1` nit, `2` concern, `3` blocker. */
  readonly severity: number
  /** The primary turn the suggestion arrived in; the per-turn budget is keyed on it. */
  readonly turn: number
}

/** One previously accepted suggestion. */
export interface GuardHistoryEntry {
  /** Normalized text, as returned by {@link normalizeSuggestion}. */
  readonly key: string
  /** Severity rank the entry was accepted at. */
  readonly severity: number
  /** The turn the entry was accepted in. */
  readonly turn: number
}

/** The guard's verdict for one suggestion. */
export interface GuardDecision {
  /** Whether the suggestion may reach the primary agent. */
  readonly accept: boolean
  /** Why it was dropped. Set only when `accept` is false. */
  readonly reason?: GuardDropReason
}

/** What one guard pass did: the admitted subset plus a count per drop reason. */
export interface GuardResult {
  /** The suggestions that survived, in input order. */
  readonly accept: readonly GuardInput[]
  /** How many suggestions each rule dropped. */
  readonly dropped: Readonly<Record<GuardDropReason, number>>
}

/**
 * The rate limits one guard pass applies. Also the third positional argument
 * of {@link guardSuggestions}.
 */
export interface GuardLimits {
  /** Non-`blocker` suggestions allowed per `turn`. */
  readonly maxPerTurn: number
  /** Non-`blocker` suggestions allowed across the whole window. */
  readonly hardCap: number
}

/** Severity rank that is exempt from both budgets. */
const BLOCKER_RANK = 3

/**
 * Case-insensitive, punctuation-folded normalization: lowercases, applies
 * NFKC, collapses every run of non-letter/non-digit characters to one space,
 * and trims. `"Stop."`, `"*Stop*"` and `"  stop  "` all key to `stop`;
 * `"No issue; continue."` keys to `no issue continue`.
 * @param text - the raw suggestion text.
 * @returns the normalized key; `''` when the text carries no letters or digits.
 */
export function normalizeSuggestion(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * Normalized phrases that carry no concrete, actionable content. Every entry
 * is the output of {@link normalizeSuggestion}, so one membership check covers
 * every casing and punctuation variant. The list is conservative on purpose: a
 * genuine blocker such as `"Stop: 'await' missing on writeStream.end()"`
 * normalizes to something longer and does not match.
 */
const NOISE_PHRASES: Readonly<Record<string, true>> = {
  stop: true,
  'stop here': true,
  'stop now': true,
  halt: true,
  abort: true,
  done: true,
  'task done': true,
  'task complete': true,
  complete: true,
  finished: true,
  ok: true,
  okay: true,
  'ok done': true,
  'no issue': true,
  'no issues': true,
  'no issue continue': true,
  'no concerns': true,
  'no concern': true,
  'nothing to add': true,
  'nothing to flag': true,
  'nothing to report': true,
  'no notes': true,
  'no further input': true,
  'no further input needed': true,
  'no further input required': true,
  'no further watcher input': true,
  'no further watcher input needed': true,
  'no further advice': true,
  'no further advice needed': true,
  lgtm: true,
  'looks good': true,
  'all good': true,
  'agent is on track': true,
  'agent on track': true,
  'on track': true,
  continue: true,
  'carry on': true,
}

/**
 * Classify one suggestion against the four rules, in a fixed order:
 * `empty` → `noise` → `duplicate` → `rate-limit`. A suggestion stopped by an
 * early rule never reaches a later one.
 *
 * Rank-aware dedupe: re-raising the same text at a strictly higher severity is
 * a real escalation, not a repeat. Equal or lower re-raises stay dropped, so
 * an advisor cannot sidestep dedupe by retagging the same text sideways.
 *
 * A `blocker` is exempt from both budgets: it must always interrupt, so an
 * earlier lower-severity note can never rate-limit it out of the turn.
 *
 * @param input - the suggestion under consideration.
 * @param history - suggestions accepted before this pass, oldest first.
 * @param perTurn - non-`blocker` suggestions already accepted for `input.turn`.
 * @param limits - the two budgets.
 * @returns the verdict; `accept: true` means the caller must record the suggestion.
 */
function judgeOne(
  input: GuardInput,
  history: readonly GuardHistoryEntry[],
  perTurn: number,
  limits: GuardLimits,
): GuardDecision {
  const key = normalizeSuggestion(input.text)
  if (key === '') return { accept: false, reason: 'empty' }
  if (NOISE_PHRASES[key] === true) return { accept: false, reason: 'noise' }

  let seenRank = 0
  for (const entry of history) {
    if (entry.key === key && entry.severity > seenRank) seenRank = entry.severity
  }
  if (input.severity <= seenRank) return { accept: false, reason: 'duplicate' }

  if (input.severity >= BLOCKER_RANK) return { accept: true }

  if (perTurn >= limits.maxPerTurn) return { accept: false, reason: 'rate-limit' }
  let nonBlockers = 0
  for (const entry of history) {
    if (entry.severity < BLOCKER_RANK) nonBlockers += 1
  }
  if (nonBlockers >= limits.hardCap) return { accept: false, reason: 'rate-limit' }
  return { accept: true }
}

/**
 * Run a batch of suggestions through the four rules, in input order.
 *
 * The batch is judged against a growing copy of `history`: a suggestion that
 * passes the duplicate rule is recorded before the next one is judged, so two
 * copies of the same advice in one batch collapse to one acceptance. A dropped
 * suggestion never consumes budget, so a suppressed phrase cannot burn the
 * turn's slot ahead of a substantive concern that follows it.
 *
 * Per-turn counts are derived from the batch itself plus `history`: an entry
 * carries the turn it was accepted in, so the third argument stays the pure
 * rate-limit policy and the same call shape serves one suggestion or many.
 *
 * @param input - every suggestion produced in this pass, in emission order.
 * @param history - suggestions accepted before this pass, oldest first.
 * @param perTurn - the per-turn and session-wide non-`blocker` budgets.
 * @returns the accepted subset plus a per-reason drop count.
 */
export function guardSuggestions(
  input: readonly GuardInput[],
  history: readonly GuardHistoryEntry[],
  perTurn: GuardLimits,
): GuardResult {
  const accept: GuardInput[] = []
  const dropped: Record<GuardDropReason, number> = { empty: 0, noise: 0, duplicate: 0, 'rate-limit': 0 }
  const seen: GuardHistoryEntry[] = [...history]

  for (const suggestion of input) {
    let acceptedThisTurn = 0
    for (const entry of seen) {
      if (entry.turn === suggestion.turn && entry.severity < BLOCKER_RANK) acceptedThisTurn += 1
    }
    const decision = judgeOne(suggestion, seen, acceptedThisTurn, perTurn)
    if (!decision.accept) {
      dropped[decision.reason ?? 'empty'] += 1
      continue
    }
    accept.push(suggestion)
    seen.push({ key: normalizeSuggestion(suggestion.text), severity: suggestion.severity, turn: suggestion.turn })
  }

  return { accept, dropped }
}
