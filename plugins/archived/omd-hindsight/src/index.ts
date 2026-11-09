/**
 * `omd-hindsight` — Hindsight memory for dsh, with the omp/pi bank model:
 * one shared bank every session reads, plus one bank per project written by
 * that project's sessions.
 *
 * The plugin declares no service of its own: it listens on three agent events
 * (recall rides `agent/pre-step`; the next turn's lookup is prefetched at
 * `agent/turn-stopping`; per-session state is dropped at `agent/disposed`),
 * injects the project bank's mental models as a per-agent system-prompt
 * section, and registers the three memory tools. Each operation talks to a
 * Hindsight server over HTTP with a credential reference resolved at call
 * time.
 *
 * Named exports only: a `default` export makes the Loader discard this whole
 * namespace and every injection with it.
 *
 * @module omd-hindsight
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

import { createBanks } from './banks.ts'
import { Config, resolveConfig, type Config as HindsightConfig } from './config.ts'
import { buildAutoRecall, wirePreCompaction } from './autorecall.ts'
import { renderMentalModels } from './snapshot.ts'
import { registerMemoryTools } from './tools.ts'

/**
 * The `compaction/start` event type used by the pre-compaction recall. It is
 * declared by `@deepseek-ai/dsh-compaction`, a DSH-internal workspace package
 * that a userland plugin cannot resolve — so the shape is re-declared here
 * (type-only; the runtime already carries the event).
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'compaction/start': {
      compactionId: string
      sourceCommandId?: string
      turn: number | null
    }
  }
}

export { Config }
export type { HindsightConfig }

/** Plugin id the Loader entry carries. */
export const name = 'omd-hindsight'

/** Services this plugin needs before its fiber activates. */
export const inject = ['tools', 'systemPrompt']

/** The system-prompt section carrying the project bank's mental models. */
const MENTAL_MODELS_SECTION = 'omd-hindsight:mental-models'

/** Section order: after the persona (0), well before the tool guidance (1000+). */
const MENTAL_MODELS_ORDER = 100

/** Character budget for the rendered `<mental_models>` block. */
const MENTAL_MODELS_BUDGET_CHARS = 6000

/**
 * Register memory for every agent session in this profile.
 * @param ctx - the entry fiber's context, carrying the tool and prompt registries.
 * @param config - the profile row's configuration.
 */
export function apply(ctx: Context, config: HindsightConfig): void {
  const resolved = resolveConfig(config)
  const banks = createBanks(resolved)

  const autoRecall = buildAutoRecall(banks, resolved, name)
  ctx.on('agent/pre-step', autoRecall.preStep, { prepend: true })
  ctx.on('agent/turn-stopping', autoRecall.turnStopping)
  ctx.on('agent/disposed', autoRecall.disposed)

  if (resolved.preCompaction) wirePreCompaction(ctx, banks, resolved, name)

  registerMemoryTools(ctx.tools, banks, resolved)

  if (resolved.mentalModels) installMentalModels(ctx, banks, resolved)
}

/**
 * Give each agent a section carrying its project bank's mental models.
 *
 * Registered through `agent.ctx`, so the section lives exactly as long as that
 * agent and needs no bookkeeping of its own. The rendered text comes from a
 * per-project cache refreshed off a timer: a stable prompt prefix is worth
 * more to the prompt cache than a fresher block on every assembly.
 */
function installMentalModels(ctx: Context, banks: ReturnType<typeof createBanks>, resolved: ReturnType<typeof resolveConfig>): void {
  /** Rendered block per project cwd, with its fetch time. */
  const cache = new Map<string, { text: string; at: number }>()
  /** Projects with a refresh already in flight. */
  const refreshing = new Set<string>()

  const refresh = (cwd: string, signal: AbortSignal): void => {
    if (refreshing.has(cwd)) return
    refreshing.add(cwd)
    void banks.mentalModels(cwd, signal)
      .then(models => { cache.set(cwd, { text: renderMentalModels(models, MENTAL_MODELS_BUDGET_CHARS), at: Date.now() }) })
      .catch(() => { /* keep the previous block */ })
      .finally(() => { refreshing.delete(cwd) })
  }

  ctx.on('agent/created', ({ agent }) => {
    const cwd = agent.session.header?.cwd ?? process.cwd()
    if (!cache.has(cwd)) cache.set(cwd, { text: '', at: 0 })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), resolved.autoContextTimeoutMs)
    refresh(cwd, controller.signal)
    clearTimeout(timer)
    agent.ctx.systemPrompt.section({
      name: MENTAL_MODELS_SECTION,
      order: MENTAL_MODELS_ORDER,
      text: () => {
        const entry = cache.get(cwd)
        if (entry !== undefined && Date.now() - entry.at >= resolved.mentalModelRefreshMs) {
          const later = new AbortController()
          const stop = setTimeout(() => later.abort(), resolved.autoContextTimeoutMs)
          refresh(cwd, later.signal)
          clearTimeout(stop)
        }
        return entry?.text ?? ''
      },
    })
  })
}
