/**
 * Runtime module for omd-hindsight: one client/queue/status runtime per main
 * session, health probing, operation journal, and the offline retry queue.
 *
 * A dsh process hosts several Bot sessions, each with its own working
 * directory and therefore its own queue root and project overrides. The
 * runtime registry keys those by session id; subagent sessions bind to the
 * runtime of the session that created them.
 *
 * @module omd-hindsight/runtime
 */

import { HindsightHttpClient, httpClientFromConfig } from './core/client.ts'
import { allowsWrite } from './core/judge.ts'
import { RetryQueue, type QueueRunReport, type QueueSnapshot } from './core/queue.ts'
import type { BankConfig, HindsightConfig } from './core/types.ts'
import { getBuiltinPromptPack, type PromptPack } from './core/prompt-pack.ts'
import type { ResolvedConfig } from './config.ts'

export interface RuntimeStatus {
  readonly healthy: boolean
  readonly version?: string
  readonly error?: string
  /** When this status was last observed; absent means the backend was never probed. */
  readonly probedAt?: number
}

export interface PluginOperationRecord {
  readonly seq: number
  readonly at: string
  readonly status: 'ok' | 'hint'
  readonly actions: readonly string[]
  readonly hint: string | null
  readonly role: string | null
}

const OPERATION_LOG_LIMIT = 50

/** Re-probe an unhealthy backend at most this often while callers read status. */
const RECOVERY_PROBE_MS = 15000

export interface RuntimeOptions {
  readonly config: HindsightConfig
  readonly cwd: string
  readonly promptPack?: PromptPack
}

export class HindsightRuntime {
  config: HindsightConfig
  cwd: string
  promptPack: PromptPack
  client: HindsightHttpClient
  queue: RetryQueue
  status: RuntimeStatus = { healthy: false, error: 'unprobed' }

  #operations: PluginOperationRecord[] = []
  #nextSeq = 1
  #replay: Promise<QueueRunReport> | undefined

  constructor(options: RuntimeOptions) {
    this.config = options.config
    this.cwd = options.cwd
    this.promptPack = options.promptPack ?? getBuiltinPromptPack()
    this.client = httpClientFromConfig(options.config)
    this.queue = new RetryQueue({
      projectRoot: options.cwd,
      maxAttempts: options.config.retryQueueMaxAttempts,
    })
  }

  /**
   * Apply a project's effective configuration. The client and queue are rebuilt
   * only when the backend endpoint, key variable, timeout, retry budget or root
   * actually changed; a plain recall-parameter change keeps them.
   */
  configure(options: RuntimeOptions): void {
    const previous = this.config
    const promptPack = options.promptPack ?? this.promptPack
    const endpointChanged =
      previous.baseUrl !== options.config.baseUrl
      || previous.apiKeyEnvVar !== options.config.apiKeyEnvVar
      || previous.timeoutMs !== options.config.timeoutMs
    if (endpointChanged) this.client = httpClientFromConfig(options.config)
    if (this.cwd !== options.cwd || previous.retryQueueMaxAttempts !== options.config.retryQueueMaxAttempts) {
      this.cwd = options.cwd
      this.queue = new RetryQueue({
        projectRoot: options.cwd,
        maxAttempts: options.config.retryQueueMaxAttempts,
      })
    }
    this.config = options.config
    this.promptPack = promptPack
    // Project settings can disable the plugin or replace the roster; a status
    // observed against the old roster must not outlive it.
    if (endpointChanged || previous.enabled !== options.config.enabled) {
      this.status = { healthy: false, error: 'unprobed' }
    }
  }

  bank(id: string): BankConfig | undefined {
    return this.config.banks.find(bank => bank.id === id)
  }

  recordOperation(entry: Omit<PluginOperationRecord, 'seq' | 'at'>): PluginOperationRecord {
    const record: PluginOperationRecord = { seq: this.#nextSeq, at: new Date().toISOString(), ...entry }
    this.#nextSeq += 1
    this.#operations = [...this.#operations.slice(-(OPERATION_LOG_LIMIT - 1)), record]
    return record
  }

  operations(): readonly PluginOperationRecord[] {
    return this.#operations
  }

  operation(seq: number): PluginOperationRecord | undefined {
    return this.#operations.find(entry => entry.seq === seq)
  }

  /** Probe `/version` once; a failure updates status and is never thrown. */
  async probe(): Promise<RuntimeStatus> {
    try {
      const version = await this.client.getVersion({
        signal: AbortSignal.timeout(Math.min(this.config.timeoutMs, 5000)),
      })
      this.status = { healthy: true, version: version.api_version, probedAt: Date.now() }
    } catch (error) {
      this.status = {
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
        probedAt: Date.now(),
      }
    }
    return this.status
  }

  /**
   * Status for a read: a backend that was down when the session started may be
   * up now, so an unhealthy or never-probed runtime is retried, at most once per
   * recovery window. A healthy observation is reused as-is.
   */
  async ensureProbed(): Promise<RuntimeStatus> {
    const aged = this.status.probedAt === undefined || Date.now() - this.status.probedAt >= RECOVERY_PROBE_MS
    if (this.status.healthy) return this.status
    if (!aged) return this.status
    return await this.probe()
  }

  async queueSnapshot(): Promise<QueueSnapshot> {
    return await this.queue.inspect()
  }

  /**
   * Replay the pending queue once. Concurrent callers share one run: a double
   * click cannot submit the same entries twice.
   *
   * The caller supplies the project's effective config and its caller class,
   * and the policy is the same guard the action path uses: a read-only caller
   * (subagent) cannot write at all, an entry naming a bank this project does not
   * declare stays pending, and a bank whose access or retain policy no longer
   * admits retains stays pending too. Skipped entries are reported with the
   * entries still queued, because that is where they remain.
   */
  async replay(effective: ResolvedConfig, isReadonly: boolean): Promise<QueueRunReport> {
    if (isReadonly) {
      throw new Error('read-only session: a subagent cannot replay queued retain writes')
    }
    if (this.#replay !== undefined) return await this.#replay
    const run = this.queue.process(this.client, {
      allow: (entry) => {
        const bank = effective.banks.find(candidate => candidate.bankId === entry.bank || candidate.id === entry.bank)
        if (bank === undefined) {
          return `bank ${JSON.stringify(entry.bank)} is not declared by this project's configuration`
        }
        if (!allowsWrite('retain', bank)) {
          return `bank ${bank.id} no longer accepts retains under this project's configuration`
        }
        return null
      },
    })
    this.#replay = run
    try {
      return await run
    } finally {
      if (this.#replay === run) this.#replay = undefined
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Registry: one runtime per main session, subagents bind to their parent
// ─────────────────────────────────────────────────────────────

const runtimes = new Map<string, HindsightRuntime>()
const bound = new Map<string, string>()
let primary: HindsightRuntime | undefined

/** Register a session's runtime; the newest main session becomes the unaddressed default. */
export function registerRuntime(sessionId: string, runtime: HindsightRuntime): HindsightRuntime {
  runtimes.set(sessionId, runtime)
  primary = runtime
  return runtime
}

/** Bind a subagent session to the session id that owns its runtime. */
export function bindRuntime(sessionId: string, ownerSessionId: string): void {
  bound.set(sessionId, ownerSessionId)
}

/** The runtime for one session, its bound owner, or the default when no id is known. */
export function getRuntime(sessionId?: string): HindsightRuntime | undefined {
  if (sessionId !== undefined) {
    const direct = runtimes.get(sessionId)
    if (direct !== undefined) return direct
    const owner = bound.get(sessionId)
    if (owner !== undefined) {
      const inherited = runtimes.get(owner)
      if (inherited !== undefined) return inherited
    }
  }
  return primary
}

/** Forget a session's runtime; returns the runtime that was owned by a main session. */
export function disposeRuntime(sessionId: string): HindsightRuntime | undefined {
  bound.delete(sessionId)
  const runtime = runtimes.get(sessionId)
  if (runtime === undefined) return undefined
  runtimes.delete(sessionId)
  if (primary === runtime) primary = [...runtimes.values()].at(-1)
  return runtime
}
