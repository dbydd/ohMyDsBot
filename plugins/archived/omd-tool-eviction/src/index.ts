/**
 * omd-tool-eviction — empty-result eviction and evidence retention, ported from omp.
 *
 * Two independent concerns:
 *
 * 1. **Eviction** — a tool result that carries no new information (empty text,
 *    a "No matches" prefix, or a tool-declared `useless` flag) is replaced in
 *    the model-facing content with a single placeholder block. The durable log
 *    still holds the original content, so the session pruner never strips the
 *    evidence before this package's projection records it.
 * 2. **Evidence** — a passing `bash` result is recorded as evidence in the
 *    host-only `omdToolEvidence` projection. The content is never rewritten;
 *    the projection is the only artefact.
 *
 * The projection is host-only (no wire view) so it never reaches the browser.
 *
 * @module omd-tool-eviction
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import z from '@deepseek-ai/schemastery'

import { DEFAULT_EMPTY_PREFIXES, classifyResult } from './classify.ts'
import { applyToolEvidence, emptyEvidenceState, stateSchema } from './projection.ts'

export const name = 'omd-tool-eviction'

/** Services this plugin needs before its fiber activates. */
export const inject = ['tools', 'sessionProjections']

/** Deployment settings for the eviction policy. */
export interface Config {
  /** Text substituted for an evicted result's model-facing content. */
  readonly emptyText?: string
  /** Prefixes that mark a result as carrying no new information. */
  emptyPrefixes: string[]
  /** Longest trimmed result, in characters, that still counts as empty. */
  emptyMaxChars: number
}

/** Schemastery configuration for the eviction policy. */
export const Config: z<Config> = z.object({
  emptyText: z
    .string()
    .default('(evicted: empty result)')
    .description('Text substituted for an evicted result\'s model-facing content.'),
  emptyPrefixes: z.array(z.string()).default([...DEFAULT_EMPTY_PREFIXES])
    .description('Result prefixes that mark a tool result as carrying no new information.'),
  emptyMaxChars: z.number().step(1).min(0).default(1)
    .description('Longest trimmed result, in characters, that still counts as empty.'),
})

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Per-call eviction / evidence flags, host-only. */
    omdToolEvidence: {
      names: Record<string, string>
      entries: Record<string, { evidence: boolean; evicted: boolean }>
    }
  }
}

const KEY = 'omdToolEvidence' as const

/**
 * Register the `omdToolEvidence` projection and the `tools/post-execute` eviction policy.
 *
 * The projection folds every committed session event; `tool/call` and
 * `tool/ptc-dispatch-start` events record the tool name for a call id, and
 * `tool/result` events classify the outcome. Evidence is therefore recorded
 * automatically — no post-execute work is needed for it.
 *
 * @param ctx - the entry fiber's context, carrying the two registries.
 * @param config - deployment settings for this profile.
 */
export function apply(ctx: Context, config: Config): void {
  const emptyText = config.emptyText ?? '(evicted: empty result)'
  const criteria = { emptyPrefixes: config.emptyPrefixes, emptyMaxChars: config.emptyMaxChars }

  ctx.sessionProjections.register({
    key: KEY,
    stateSchema,
    init: () => emptyEvidenceState(),
    apply: (state, event) => applyToolEvidence(state, event, criteria),
    stateVersion: 1,
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept') return decision
    // A decision that replaces `value` rebuilds the whole result through the
    // tool's output contract; it is not a content rewrite and must not be
    // touched here.
    if (Object.hasOwn(decision, 'value')) return decision
    if (result.isError) return decision

    const text = result.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('')
    const { evict } = classifyResult(exec.name, text, false, result.meta, criteria)
    if (!evict) return decision

    return { ...decision, content: [{ type: 'text', text: emptyText }] }
  })
}