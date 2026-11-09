/**
 * `omd-memory` — the Hindsight memory backend for dsh.
 *
 * This package owns three things and nothing else: the configuration surface,
 * the HTTP client, and the durable retain queue. Recall injection, the model
 * tools, and the `memory://` resource are later phases; the interfaces they
 * need exist here already, so those phases add callers rather than reaching
 * back into these modules.
 *
 * What `apply` assembles:
 *
 * - the **turn projection**, which folds committed session events into the
 *   pending turn a retain would send;
 * - the **watermarks**, recovered from the queue's tail jobs and kept in the
 *   memory domain;
 * - the **client**, built once from the profile configuration;
 * - the **flusher**, one timer that delivers what the queue holds.
 *
 * Nothing here is on a turn's critical path. The flusher runs on its own
 * timer, so an unreachable server costs a queued job and a log line, never a
 * turn.
 *
 * @module omd-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-working-directory'
import z from '@deepseek-ai/schemastery'
import { checkHealth, createHindsightClient } from './client/index.ts'
import type { HindsightClientLike, HealthResult } from './client/index.ts'
import { Config, resolveConfig } from './config.ts'
import type { Config as MemoryConfig, ResolvedConfig } from './config.ts'
import { projectBank, projectIdentity } from './project.ts'
import type { ProjectIdentity } from './project.ts'
import { MemoryQueue } from './queue/index.ts'
import type { QueueSummary } from './queue/index.ts'
import { Watermarks } from './queue/watermark.ts'
import { memoryDomain } from './storage.ts'
import type { MemoryDomain } from './storage.ts'
import { turnFold } from './turn.ts'
import type { TurnState } from './turn.ts'

export { Config, PROJECT_OVERRIDABLE, resolveConfig } from './config.ts'
export type { Config as MemoryConfig, ProjectOverridableKey, ResolvedConfig } from './config.ts'
export { checkHealth, createHindsightClient } from './client/index.ts'
export type { HindsightClientLike, HealthResult } from './client/index.ts'
export { MemoryQueue } from './queue/index.ts'
export type { FlushResult, QueueSummary } from './queue/index.ts'
export { Watermarks } from './queue/watermark.ts'
export { normalizeRemote, projectBank, projectIdentity, projectTag, slug } from './project.ts'
export type { ProjectIdentity } from './project.ts'
export { isOwnInjection, turnFold } from './turn.ts'
export type { TurnEntry, TurnState } from './turn.ts'

/** Plugin id the Loader entry carries. */
export const name = 'omd-memory'

/** Services the backend is assembled from. Storage is required: without it there is nowhere to keep the watermark. */
export const inject = ['sessionProjections', 'workingDirectory', 'storageDomain']

/** The projection unit key this package registers. */
export const TURN_PROJECTION_KEY = 'omdMemoryTurn'

/** Version of the turn fold; bump whenever the state shape or the folding changes. */
export const TURN_PROJECTION_VERSION = 1

/** Attempts after which one job moves to the dead-letter file. */
export const RETAIN_MAX_RETRIES = 5

/** The queue the backend is serving through `ctx.memory`. */
export interface MemoryServices {
  /** Resolved configuration. */
  readonly config: ResolvedConfig
  /** The retain queue. */
  readonly queue: MemoryQueue
  /** Per-session retained positions. */
  readonly watermarks: Watermarks
  /** The client, or `undefined` when no address is configured or the backend is switched off. */
  readonly client: HindsightClientLike | undefined
  /** Resolve one session's project identity. */
  project(cwd: string): Promise<ProjectIdentity>
  /** The bank one project writes to. */
  bank(identity: ProjectIdentity): string
  /** The pending turn of one session, as the projection last saw it. */
  pending(sessionId: string): TurnState | undefined
  /**
   * Record one finished turn as a queued job. Appends a line and returns; the
   * network is never touched here.
   * @returns whether a job was written.
   */
  retainTurn(turn: { sessionId: string, turn: number, throughSeq: number, cwd: string }): Promise<{ queued: boolean }>
  /** Deliver what the queue holds, bounded by the configured pass size. */
  flush(): Promise<void>
  /** Queue counts and ages. */
  summary(): Promise<QueueSummary>
  /** Whether the server answers, phrased as a fact rather than a throw. */
  health(): Promise<HealthResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The mounted memory backend, present exactly while this plugin is loaded. */
    memory: MemoryServices
  }
}

/**
 * Mount the memory backend on this context.
 * @param ctx - the plugin's context.
 * @param config - the profile row's configuration.
 */
export function apply(ctx: Context, config: MemoryConfig | undefined): void {
  // An absent profile block arrives as `undefined`, not as a validated object:
  // the schema is what turns one into the documented defaults.
  const resolved = resolveConfig(config ?? {})

  // Registered unconditionally: a later phase reads the pending turn even with
  // delivery switched off, and an unregistered key would read as "no history".
  ctx.effect(() => ctx.sessionProjections.register({
    key: TURN_PROJECTION_KEY,
    stateVersion: TURN_PROJECTION_VERSION,
    ...turnFold({ maxChars: resolved.retainMaxContentChars, toolResults: resolved.retainToolResults }),
  }))

  const domainReady: Promise<MemoryDomain> = ctx.storageDomain.open(memoryDomain)
  ctx.effect(() => async () => {
    await (await domainReady).close()
  })

  const queuePath = resolved.queuePath === '' ? dshHomePath('memory', 'retain-queue.jsonl') : resolved.queuePath
  const queue = new MemoryQueue(queuePath, RETAIN_MAX_RETRIES)

  const client = resolved.enabled && resolved.baseUrl !== ''
    ? createHindsightClient({
      baseUrl: resolved.baseUrl,
      apiKey: resolveApiKey(ctx, resolved),
      timeoutMs: resolved.timeoutMs,
    })
    : undefined

  /** The projection's latest state per session, refreshed at each step boundary. */
  const pendingBySession = new Map<string, TurnState>()
  /** Project identity per working directory; a remote identity costs a file walk. */
  const identities = new Map<string, Promise<ProjectIdentity>>()

  /** Watermarks, filled once the domain and the queue are readable. */
  const watermarks = new Watermarks()

  const services: MemoryServices = {
    config: resolved,
    queue,
    watermarks,
    client,
    project: async (cwd) => {
      const cached = identities.get(cwd) ?? projectIdentity(cwd, resolved)
      identities.set(cwd, cached)
      return await cached
    },
    bank: (identity) => projectBank(identity, resolved),
    pending: (sessionId) => pendingBySession.get(sessionId),
    retainTurn: async ({ sessionId, turn, throughSeq, cwd }) => {
      const state = pendingBySession.get(sessionId)
      const entries = state?.entries ?? []
      if (entries.length === 0) return { queued: false }
      const identity = await services.project(cwd)
      await queue.enqueue({
        sessionId,
        turn,
        throughSeq,
        bankId: services.bank(identity),
        documentId: `dsh-session:${sessionId}`,
        updateMode: resolved.retainUpdateMode,
        item: {
          content: JSON.stringify(entries, null, 2),
          context: `turn ${turn} of session ${sessionId} in project ${identity.id}`,
          timestamp: new Date().toISOString(),
          async: resolved.retainAsync,
          tags: [`project:${identity.id}`],
          strategy: 'conversation',
        },
      })
      await watermarks.raise(sessionId, throughSeq, turn)
      pendingBySession.delete(sessionId)
      return { queued: true }
    },
    flush: async () => {
      if (client === undefined) return
      await queue.flush(client, { maxJobs: resolved.flushMaxJobsPerPass, maxRetries: RETAIN_MAX_RETRIES })
    },
    summary: async () => await queue.summarize(),
    health: async () => client === undefined
      ? { ok: false, error: 'no memory server address is configured' }
      : await checkHealth(client),
  }

  ctx.provide('memory', services)

  // Watermarks resume from two durable sources: the queue's tail jobs (which
  // survive a crash between append and flush) and the memory domain (which
  // survives delivery emptying the queue). Either alone loses a turn.
  const recovered = domainReady.then(async (domain) => {
    watermarks.use(domain)
    const { jobs } = await queue.read()
    watermarks.absorb(jobs)
    return domain
  })
  ctx.effect(() => async () => {
    await recovered.catch(() => {})
  })

  ctx.inject(['timer'], (timed) => {
    // Read on every turn from the session's own registry: the unit may be
    // registered after this plugin, and clearing the cache at the start of a
    // turn keeps the fold current whether or not it is.
    timed.on('agent/pre-step', async ({ agent }, next) => {
      const state = timed.sessionProjections.stateOf(agent.session, TURN_PROJECTION_KEY)
      if (state !== undefined) pendingBySession.set(agent.session.id, state)
      return await next()
    })
    timed.effect(() => timed.interval(() => {
      void services.flush().catch((error: unknown) => {
        timed.logger('omd-memory').warn(`flush pass failed: ${String(error)}`)
      })
    }, resolved.flushIntervalMs))
    timed.effect(() => async () => {
      await Promise.race([services.flush().catch(() => {}), timed.timeout(resolved.shutdownFlushMs)])
    })
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    if (!resolved.enabled || !resolved.autoRetain) return
    const state = ctx.sessionProjections.stateOf(agent.session, TURN_PROJECTION_KEY)
    if (state === undefined || state.entries.length === 0) return
    // The first turn of a fresh process waits for the recovery read; later
    // turns see it already settled.
    await recovered.catch(() => undefined)
    if (state.throughSeq <= watermarks.get(agent.session.id)) return
    await services.retainTurn({
      sessionId: agent.session.id,
      turn,
      throughSeq: state.throughSeq,
      cwd: ctx.workingDirectory.get(agent.session),
    })
  })

  ctx.on('agent/disposed', ({ agent }) => {
    pendingBySession.delete(agent.session.id)
  })

}

/**
 * Resolve the API key through the credential service. Only the reference lives
 * in configuration; the value is read here.
 * @param ctx - plugin context.
 * @param config - resolved configuration.
 * @returns the key, or `undefined` when none is stored.
 */
function resolveApiKey(ctx: Context, config: ResolvedConfig): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined || config.apiKeyRef === '') return Promise.resolve(undefined)
  return credentials.resolve(credentialRef(config.apiKeyRef)).then(
    (resolved) => resolved?.value,
    () => undefined,
  )
}

/** Schemastery schema, re-exported under one name for the Loader's config validation. */
export const configSchema: z<MemoryConfig> = Config
