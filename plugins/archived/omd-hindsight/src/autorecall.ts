/**
 * The automatic recall: on the first step of each turn the anchor message is
 * queried against both banks — plus the banks' active directives — and the
 * result becomes a plugin-sourced snapshot message riding the pre-step
 * decision, so it lands in the transcript right after the message that
 * triggered it.
 *
 * The lookup is started AHEAD of the turn that pays for it: when a turn stops
 * a detached job runs the same recall for that turn's message — while the
 * user reads or types the next one — and the next turn's first step consumes
 * the cached result without a bank call. The trade (omp ships it as the
 * default): from the second turn on the snapshot targets the PREVIOUS turn's
 * message; the current message is already in context, and memory is durable
 * knowledge. The first turn has no cache and takes the bounded synchronous
 * path. `prefetch: false` turns the job off and anchors every turn on the
 * current message, at the cost of the bank's latency on the first model call.
 *
 * A steering intervention claimed at a later step is recalled on the bounded
 * synchronous path anchored on the intervention itself. A later step without
 * a human message recalls nothing.
 *
 * Subagent sessions are skipped: their task context is owned by the
 * delegating prompt.
 *
 * @module omd-hindsight/autorecall
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'

import { PREFETCH_TTL_MS, type Banks, type DirectiveRule, type RecallHit } from './banks.ts'
import type { ResolvedConfig } from './config.ts'
import {
  composeRecallQuery,
  queryFromHumanMessages,
  queryFromMessages,
  queryFromSession,
  renderSnapshot,
  renderUnchanged,
} from './snapshot.ts'

/** The `agent/pre-step` payload (the live-runtime event shape). */
export interface PreStepPayload {
  agent: Agent
  messages: UserMessage[]
  turn: number
  step: number
  signal: AbortSignal
}

/** The `agent/turn-stopping` payload: the turn is about to close. */
export interface TurnStoppingPayload {
  agent: Agent
  turn: number
  signal: AbortSignal
}

/** The `agent/disposed` payload: the agent left the registry. */
export interface DisposedPayload {
  agent: Agent
}

/** One finished prefetch: the merged lookup's result. */
interface PrefetchedTurn {
  hits: RecallHit[]
  rules: DirectiveRule[]
  durationMs: number
}

/** One in-flight prefetch and the controller that bounds it. */
interface Slot {
  controller: AbortController
  promise: Promise<PrefetchedTurn>
}

/**
 * Build the automatic-recall handlers for one plugin instance.
 * @param banks - the bank operations.
 * @param config - resolved plugin configuration.
 * @param pluginName - the plugin's own name, used as the snapshot's attribution.
 * @returns the three handlers wired in `index.ts`.
 */
export function buildAutoRecall(
  banks: Banks,
  config: ResolvedConfig,
  pluginName: string,
): {
  preStep: (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>
  turnStopping: (payload: TurnStoppingPayload) => void
  disposed: (payload: DisposedPayload) => void
} {
  /** One slot per session: `pre-step` consumes it, `turn-stopping` fills it, disposal clears it. */
  const slots = new Map<string, Slot>()
  /** The text of the last snapshot committed per session, for the unchanged marker. */
  const lastSnapshot = new Map<string, string>()

  function discardSlot(sessionId: string): void {
    const slot = slots.get(sessionId)
    slots.delete(sessionId)
    slot?.controller.abort()
  }

  /** One bounded recall + directive pair; timeout, abort or failure yields `null`. */
  function syncRecall(session: Session, query: string, signal: AbortSignal): Promise<PrefetchedTurn | null> {
    return (async (): Promise<PrefetchedTurn | null> => {
      const startedAt = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), config.autoContextTimeoutMs)
      const onAbort = (): void => controller.abort()
      if (!signal.aborted) signal.addEventListener('abort', onAbort, { once: true })
      try {
        const cwd = session.header?.cwd ?? process.cwd()
        const hits = query.length > 0 ? await banks.recall(cwd, query, controller.signal) : []
        const rules = await banks.directives(cwd, controller.signal)
        return { hits, rules, durationMs: Date.now() - startedAt }
      } catch {
        return null
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    })()
  }

  /** Start the detached prefetch for the turn that just ended. */
  function startPrefetch(session: Session): void {
    discardSlot(session.id)
    const query = queryFromSession(session)
    const anchor = composeRecallQuery(session, query, config.recallContextTurns, true)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PREFETCH_TTL_MS)
    const cwd = session.header?.cwd ?? process.cwd()
    const startedAt = Date.now()
    const promise = (async (): Promise<PrefetchedTurn> => {
      try {
        const hits = anchor.length > 0 ? await banks.recall(cwd, anchor, controller.signal) : []
        const rules = await banks.directives(cwd, controller.signal)
        return { hits, rules, durationMs: Date.now() - startedAt }
      } finally {
        clearTimeout(timer)
      }
    })()
    // A rejected prefetch (server down, TTL abort) must never become an
    // unhandled rejection; its consumer treats rejection as "no cache".
    promise.catch(() => undefined)
    slots.set(session.id, { controller, promise })
  }

  /**
   * Commit one snapshot onto the step: a plugin-sourced user-role message
   * riding the decision, so the loop appends it right after the triggering
   * message. An unchanged recall commits the marker row instead of repeating
   * the block; an empty recall commits nothing.
   */
  function commit(decision: PreStepDecision, session: Session, result: PrefetchedTurn, label: string): PreStepDecision {
    if (decision.kind !== 'enter') return decision
    const rendered = renderSnapshot(result.hits, result.rules)
    if (rendered.length === 0) return decision
    const unchanged = lastSnapshot.get(session.id) === rendered
    const text = unchanged ? renderUnchanged(result.hits, result.rules) : rendered
    if (!unchanged) lastSnapshot.set(session.id, rendered)
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: pluginName,
        form: unchanged ? 'notice' : 'snapshot',
        label,
        summary: boundContextSummary(text),
        sections: [{ name: pluginName, text }],
      },
    })
    return { kind: 'enter', messages: [...decision.messages, message] }
  }

  const preStep = async ({ agent, messages, step, signal }: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    const decision = await next()
    const session = agent.session
    if (decision.kind !== 'enter' || signal.aborted) {
      discardSlot(session.id)
      return decision
    }
    if (!config.autoContext) return decision
    if (session.header?.origin === 'subagent') return decision
    if (step > 1) {
      // A later step claims the steering delivered at its boundary: the loop
      // skips the turn-stopping prefetch while a steer is queued, so this step
      // owns no cache and takes the bounded synchronous path on the steer.
      const intervention = queryFromHumanMessages(messages)
      if (intervention.length === 0) return decision
      const query = composeRecallQuery(session, intervention, config.recallContextTurns, false)
      const result = await syncRecall(session, query, signal)
      if (result === null) return decision
      return commit(decision, session, result, `recall - ${result.durationMs}ms`)
    }
    const slot = slots.get(session.id)
    if (slot !== undefined) {
      slots.delete(session.id)
      const prefetched = await race(slot.promise, config.autoContextTimeoutMs, () => slot.controller.abort())
      if (prefetched === null) return decision
      return commit(decision, session, prefetched, `recall - ${prefetched.durationMs}ms`)
    }
    const anchor = queryFromMessages(messages)
    const query = composeRecallQuery(session, anchor, config.recallContextTurns, false)
    const result = await syncRecall(session, query, signal)
    if (result === null) return decision
    return commit(decision, session, result, `recall - ${result.durationMs}ms`)
  }

  const turnStopping = ({ agent, signal }: TurnStoppingPayload): void => {
    const session = agent.session
    if (signal.aborted || !config.autoContext || !config.prefetch) return
    if (session.header?.origin === 'subagent') return
    startPrefetch(session)
  }

  const disposed = ({ agent }: DisposedPayload): void => {
    discardSlot(agent.session.id)
    lastSnapshot.delete(agent.session.id)
  }

  return { preStep, turnStopping, disposed }
}

/**
 * `promise` or `null` once `timeoutMs` elapses; `onTimeout` fires on the
 * losing branch so the caller can abort the work it stopped waiting for.
 */
function race<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T | null> {
  return new Promise<T | null>(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      onTimeout()
      resolve(null)
    }, timeoutMs)
    promise.then(
      value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

/**
 * Wire the pre-compaction recall: at `compaction/start`, recall on the
 * session's own tail and inject the result as a queued message, which lands
 * OUTSIDE the compacted span — so the memory survives the replacement.
 * @param ctx - the plugin's context, for the session/agent events.
 * @param banks - the bank operations.
 * @param config - resolved plugin configuration.
 * @param pluginName - the plugin's attribution name.
 */
export function wirePreCompaction(ctx: Context, banks: Banks, config: ResolvedConfig, pluginName: string): void {
  /** The live agent per session id; `compaction/start` carries no agent. */
  const agents = new Map<string, Agent>()
  ctx.on('agent/created', ({ agent }) => { agents.set(agent.session.id, agent) })
  ctx.on('agent/disposed', ({ agent }) => { agents.delete(agent.session.id) })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/start') return
    const agent = agents.get(session.id)
    if (agent === undefined) return
    if (session.header?.origin === 'subagent') return
    const anchor = queryFromSession(session)
    if (anchor.length === 0) return
    const query = composeRecallQuery(session, anchor, config.recallContextTurns, true)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.autoContextTimeoutMs)
    const cwd = session.header?.cwd ?? process.cwd()
    const startedAt = Date.now()
    // Detached: the compaction transaction owns the turn, and a slow bank must
    // never hold it. Failure means the compaction simply proceeds without memory.
    void (async () => {
      try {
        const hits = await banks.recall(cwd, query, controller.signal)
        const rules = await banks.directives(cwd, controller.signal)
        const text = renderSnapshot(hits, rules)
        if (text.length === 0) return
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: 'plugin',
            plugin: pluginName,
            form: 'snapshot',
            label: `recall:pre-compaction - ${Date.now() - startedAt}ms`,
            summary: boundContextSummary(text),
            sections: [{ name: pluginName, text }],
          },
        })
        agent.inject(message)
      } catch {
        // no memory through this compaction
      } finally {
        clearTimeout(timer)
      }
    })()
  })
}
