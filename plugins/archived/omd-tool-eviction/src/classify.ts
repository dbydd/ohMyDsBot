/**
 * Pure classification of one tool result into eviction / evidence flags.
 *
 * Eviction replaces the model-facing content of a no-information result with a
 * single placeholder block; evidence marks a passing bash result so the
 * session pruner never strips it before the evidence projection records it.
 *
 * @module omd-tool-eviction/classify
 */

/**
 * Decision flags for one tool result.
 *
 * `evict` and `evidence` are independent: a result can be evicted *and* carry
 * evidence (e.g. an empty `bash` output that still says "passed"), in which
 * case the content is replaced and the evidence projection records the fact.
 */
export interface EvictionDecision {
  /** Replace the model-facing content with a placeholder block. */
  readonly evict: boolean
  /** Record this result as passing evidence in the `omdToolEvidence` projection. */
  readonly evidence: boolean
}

/** Prefixes that mark a result as carrying no new information. */
export const DEFAULT_EMPTY_PREFIXES: readonly string[] = ['No matches', 'No files', 'Nothing to', '(empty)']

/** Thresholds the classifier applies to one result. */
export interface EvictionCriteria {
  /** Prefixes that mark a result as carrying no new information. */
  readonly emptyPrefixes: readonly string[]
  /** Longest trimmed result that still counts as empty. */
  readonly emptyMaxChars: number
}

/**
 * Classify one tool result.
 *
 * @param toolName - the tool that produced the result.
 * @param text - concatenated model-facing text of the result.
 * @param isError - whether the tool invocation failed.
 * @param meta - the tool's optional presentation metadata (`result.meta`).
 * @param criteria - prefixes and the empty-result length threshold.
 * @returns the eviction / evidence decision.
 */
export function classifyResult(
  toolName: string,
  text: string,
  isError: boolean,
  meta: unknown,
  criteria: EvictionCriteria,
): EvictionDecision {
  if (isError) return { evict: false, evidence: false }

  const trimmed = text.trim()
  const useless =
    typeof meta === 'object' && meta !== null && 'useless' in meta && meta.useless === true
  const evict =
    trimmed.length <= criteria.emptyMaxChars ||
    criteria.emptyPrefixes.some((prefix) => text.startsWith(prefix)) ||
    useless

  const evidence =
    toolName === 'bash' &&
    !isError &&
    /\b(passed|PASS|ok)\b/.test(text)

  return { evict, evidence }
}