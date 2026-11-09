/**
 * `omd-shake` — `/shake`: drop recoverable content from older history without
 * spending a model on a summary.
 *
 * omp's shaker has three strategies; this package ports them onto dsh's surface
 * contract:
 *
 * - `elide` (default) replaces the model-facing content of every tool result
 *   older than the last `recentKeep` with one short marker. When the result
 *   already carried a spill notice, the marker keeps the notice's locator and
 *   retrieval hint, so the full text stays reachable through the file the spill
 *   store wrote.
 * - `images` removes image blocks from messages older than the same window,
 *   leaving a text placeholder when a message would otherwise be empty.
 * - `thinking` measures the reasoning blocks in that window and changes
 *   nothing, for the reason under Known limitations.
 *
 * # Why the surface, not the compaction seam
 *
 * `ctx.compaction` is a summarization seam: every shipped backend turns a
 * shadowed range into a model-written checkpoint. dsh exposes no "rewrite
 * history without a summary" entry point. The sanctioned seam for a lossless
 * positional rewrite is the surface `replace` operation, which the harness
 * documents as usable by "any surface-replacing producer"
 * (`packages/core/session/src/types.ts:454-461`) and which the shipped
 * tool-result pruner already uses exactly this way
 * (`packages/compaction/compaction-tool-result-pruner/src/index.ts:136-182`):
 * append one event citing the node it shadows, keep the original event in the
 * log, and let the fold derive history from the replacement.
 *
 * # Known limitations
 *
 * **`thinking` measures instead of removing.** A replacement must cite every
 * node it shadows, and `assistant/message` may not carry `sourceEventSeqs`
 * (`packages/core/session/src/surface.ts:335-337`), so the one node type that
 * holds reasoning is the one type no replacement can shadow. A plugin-owned
 * elision event is not an alternative: out-of-tree event types are absent from
 * `KNOWN_SESSION_EVENT_TYPES` (`packages/core/session/src/known-event-types.ts:8-21`),
 * and marking one `ignorable` would claim its loss cannot change
 * reconstruction — false for an event that rewrites content. `/compact` is the
 * only mechanism here that drops reasoning, and it pays a summary for it.
 *
 * **The token meter keeps its pre-shake estimate.** Each replacement carries
 * no `compaction/prune` shadow price, so the context-pressure fold treats the
 * replace as zero delta (`packages/llm/token-meter/src/surface-projection.ts:84-88`)
 * and keeps counting the elided bytes until the next compaction. Producing that
 * price needs `@deepseek-ai/dsh-token-meter`, which is not on the plugin runtime
 * link allowlist (`plugins/link-host-runtime.mjs:29-42`); adding it is outside
 * this package.
 *
 * **The recovery pointer is a spill path, not an artifact id.** dsh has no
 * artifact store, so an elided result cannot cite `artifact://<id>`. What it
 * can cite is the locator inside an existing spill notice, which
 * `dsh-spill-local` fills with a real file the model can read or grep; without
 * a notice the marker is plain `(elided)`.
 *
 * **History is read through a deprecated reader.** Building a replacement that
 * preserves every field outside `content` needs each node's exact event, and
 * `Session.eventAt` is the only synchronous reader that returns one
 * (`packages/core/session/src/index.ts:704-713`). One waivered call in
 * `shake.ts` carries the reason, exactly as the in-tree pruner does.
 *
 * @module omd-shake
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: these three packages' declaration merges supply `agent.session`,
// `agent.status`, `turnBoundary`, and `ctx.commands`.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection'
import z from '@deepseek-ai/schemastery'
import { formatShakeReport } from './report.ts'
import { shakeSession } from './shake.ts'
import { DEFAULT_RECENT_KEEP, SHAKE_MODES, WAIT_FOR_RESPONSE, parseShakeArgument } from './types.ts'

/** Plugin id the Loader entry carries. */
export const name = 'omd-shake'

/** Services this plugin needs before its fiber activates. */
export const inject = ['commands', 'sessionProjections']

/** Deployment settings for `/shake`. */
export interface Config {
  /** Count of most recent entries a run leaves untouched. */
  recentKeep: number
}

/** Schemastery configuration for `/shake`. */
export const Config: z<Config> = z.object({
  recentKeep: z.number().step(1).min(0).default(DEFAULT_RECENT_KEEP)
    .description('Most recent tool results (elide) or surface messages (images, thinking) a run leaves untouched.'),
})

/**
 * Register the `/shake` command.
 *
 * The handler refuses while a turn is open: an in-flight request already
 * snapshotted the history it sent, so rewriting the surface under it would
 * make the next step disagree with the one that just ran.
 * @param ctx - the entry fiber's context, carrying the command registry and the
 *   projection reader used for that check.
 * @param config - deployment settings for this profile.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.commands.register({
    name: 'shake',
    description: 'Drop recoverable content from older history without an LLM summary',
    input: { hint: `[${SHAKE_MODES.join('|')}]` },
    handler: (invocation) => {
      const argument = parseShakeArgument(invocation.rawInput)
      if (argument.kind === 'error') return { kind: 'error', text: argument.text }
      const session = invocation.agent.session
      const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
      if (invocation.agent.status === 'running'
        || (boundary !== undefined && boundary.openTurnStartSeq !== null)) {
        return { kind: 'error', text: WAIT_FOR_RESPONSE }
      }
      return {
        kind: 'success',
        text: formatShakeReport(shakeSession(session, argument.mode, config.recentKeep)),
      }
    },
  }))
}
