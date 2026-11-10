/**
 * The compute control plane: a machine is asked for, not started.
 *
 * `omd-compute` owns a lease table and the machine verbs a lease implies —
 * acquire starts (or resumes) a machine and records who asked for it until
 * when, an expired lease stops it, retention destroys it. It answers one
 * Onlyne node, `urn:onlyne:agent:compute`, so asking is a message and the
 * answer is the manager's reply in the thread the ask opened.
 *
 * The split this module keeps is the plugin's own: control crosses Onlyne,
 * data does not. The reply describes a lease; commands and the desktop stay
 * `omd-sandbox-vm`'s seam (`exec`, `SandboxBash`, `inspect`).
 *
 * A host with no providing node gets `absent`. That is not a cue to call
 * `orbctl` here: the lease is the message, and only a node with a driver
 * starts the machine.
 *
 * @module omd-issue-runner/compute
 */

import type { Entry, Json } from '@onlyne/lib'
import { computeRequest, readComputeResult, type ComputeWireRequest } from 'omd-compute/wire'
import type { BotNode } from 'omd-onlyne/node'
import {
  workJson,
  type ComputeAcquire,
  type ComputeConnection,
  type ComputeControl,
  type ComputeDescriptor,
  type ComputeLease,
} from './types.ts'

/** What an acquire says in its body; the manager reads the operation from `meta`. */
const ACQUIRE_TEXT = 'acquire workspace machine'

/** What a renew says in its body. */
const RENEW_TEXT = 'renew workspace machine'

/** What a destroy says in its body. */
const DESTROY_TEXT = 'destroy workspace machine'

/**
 * How long a destroy waits for its answer. A destroy answer is one word, and a
 * manager that never sends one has already lost the machine from its own view:
 * the lease's own sweep is the backstop, so a close does not wait minutes.
 */
const DESTROY_TIMEOUT_MS = 30_000

/**
 * How long one renew waits for its answer. A renewal that is not acknowledged
 * inside half a lease window has already cost the caller what it asked for, so
 * the ask does not hold a close open for minutes.
 */
const RENEW_TIMEOUT_MS = 30_000

/**
 * The ask's meta, as the standard request spells it.
 * @param meta - fields `acquire`, `renew` and `destroy` already gathered.
 * @returns the wire request.
 */
function wireOf(meta: { readonly [key: string]: Json }): ComputeWireRequest {
  const operation = meta.operation
  if (operation !== 'acquire' && operation !== 'renew' && operation !== 'release' && operation !== 'destroy' && operation !== 'status') {
    throw new Error(`omd-issue-runner: "${String(operation)}" is not a compute bus operation`)
  }
  const container = objectOf(meta.container)
  const lease = objectOf(meta.lease)
  return {
    operation,
    ...typeof meta.name === 'string' ? { name: meta.name } : {},
    ...typeof meta.lease_id === 'string' ? { lease_id: meta.lease_id } : {},
    ...typeof meta.ttl_ms === 'number' ? { ttl_ms: meta.ttl_ms } : {},
    ...typeof meta.workspacePath === 'string' ? { workspacePath: meta.workspacePath } : {},
    ...container === undefined ? {} : { container: container as ComputeWireRequest['container'] },
    ...lease === undefined ? {} : { lease: lease as ComputeWireRequest['lease'] },
    ...typeof meta.purpose === 'string' ? { purpose: meta.purpose } : {},
    ...meta.work === undefined ? {} : { work: meta.work },
  }
}

/** The manager's answer, reduced to what the caller acts on. */
type Answer =
  | { readonly ok: true; readonly data: { readonly [key: string]: Json } }
  | { readonly ok: false; readonly reason: string }

/** One ask in flight. `messageId` arrives with the admission, after the ask is registered. */
interface Pending {
  readonly answer: (value: Answer) => void
  messageId?: string
}

/** What the client needs from the runner. */
export interface ComputeClientOptions {
  /** Node id the manager answers as. */
  readonly managerId: string
  /** The runner's node: undefined before it starts and after it is disposed. */
  readonly node: () => BotNode | undefined
  /** How long one acquire waits for the manager's answer, in milliseconds. */
  readonly timeoutMs: number
  /** Where an ask nobody answered is reported. */
  readonly log: (message: string) => void
}

/** One string out of a loosely typed descriptor field. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A JSON object, read as the fields OECP v1 nests inside a descriptor. */
function objectOf(value: Json | undefined): Record<string, Json> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/** A map of strings, when every value the manager sent is one. */
function stringsOf(value: Json | undefined): Record<string, string> | undefined {
  const record = objectOf(value)
  if (record === undefined) return undefined
  const entries = Object.entries(record).filter(([, item]) => typeof item === 'string')
  if (entries.length !== Object.keys(record).length) return undefined
  return Object.fromEntries(entries) as Record<string, string>
}

/** The direct data-plane channels an OECP v1 descriptor names, snake_case or camelCase. */
function connectionOf(value: Json | undefined): ComputeConnection | undefined {
  const record = objectOf(value)
  if (record === undefined) return undefined
  const execTransport = stringOf(record.exec_transport) ?? stringOf(record.execTransport)
  const endpoints = stringsOf(record.endpoints)
  const portals = objectOf(record.portal_urls) ?? objectOf(record.portalUrls)
  const desktop = portals === undefined ? undefined : stringOf(portals.desktop)
  const connection: ComputeConnection = {
    ...execTransport === undefined ? {} : { execTransport },
    ...endpoints === undefined ? {} : { endpoints },
    ...desktop === undefined ? {} : { portalUrls: { desktop } },
  }
  return Object.keys(connection).length === 0 ? undefined : connection
}

/**
 * The message id an answer replies to.
 *
 * `in_reply_to` is a top-level field of the message; an in-process send stores
 * the whole input meta as `meta.data`, so the answer's own meta is read both
 * ways — the same double layer the operation fields have.
 */
function repliedToOf(entry: Entry): string | undefined {
  const meta = (entry.message.meta ?? {}) as unknown as { in_reply_to?: Json }
  const ref = objectOf(meta.in_reply_to) ?? objectOf(entry.message.meta?.data?.in_reply_to)
  return stringOf(ref?.id)
}

/**
 * The manager's descriptor, read leniently.
 *
 * OECP v1 names `lease_id`, `connection.portal_urls.desktop`, `resolved_env`
 * and `allocated`; a provider that predates the layer names fewer fields, so
 * every one of them is optional here. The fields also arrive under their
 * snake_case spelling, which is what the agent-facing spec uses.
 */
function descriptorOf(data: { readonly [key: string]: Json }, fallbackName: string): ComputeDescriptor {
  const connection = connectionOf(data.connection)
  const portal = connection?.portalUrls?.desktop
  const workspacePath = stringOf(data.workspacePath) ?? stringOf(data.workspace_path)
  const desktopUrl = portal ?? stringOf(data.desktopUrl) ?? stringOf(data.desktop_url)
  const leaseId = stringOf(data.lease_id) ?? stringOf(data.leaseId)
  const expiresAt = typeof data.expiresAt === 'number'
    ? data.expiresAt
    : typeof data.expires_at === 'number' ? data.expires_at : undefined
  const idleTimeoutMs = typeof data.idle_timeout_ms === 'number'
    ? data.idle_timeout_ms
    : typeof data.idleTimeoutMs === 'number' ? data.idleTimeoutMs : undefined
  const resolvedEnv = stringsOf(data.resolved_env)
  const allocated = objectOf(data.allocated)
  return {
    name: stringOf(data.name) ?? fallbackName,
    state: typeof data.state === 'string' ? data.state : 'unknown',
    ...workspacePath === undefined ? {} : { workspacePath },
    ...desktopUrl === undefined ? {} : { desktopUrl },
    ...expiresAt === undefined ? {} : { expiresAt },
    ...idleTimeoutMs === undefined ? {} : { idleTimeoutMs },
    ...leaseId === undefined ? {} : { leaseId },
    ...connection === undefined ? {} : { connection },
    ...resolvedEnv === undefined ? {} : { resolvedEnv },
    ...allocated === undefined ? {} : { allocated },
  }
}

/** The admission and the message id inside `client.msg`'s outcome. */
function sentOf(outcome: unknown): { admission?: string; messageId?: string; code?: string } {
  if (typeof outcome !== 'object' || outcome === null) return {}
  const admission = 'admission' in outcome && typeof outcome.admission === 'string' ? outcome.admission : undefined
  const receipt = 'receipt' in outcome ? outcome.receipt : undefined
  const ref = typeof receipt === 'object' && receipt !== null && 'message_ref' in receipt ? receipt.message_ref : undefined
  const messageId = typeof ref === 'object' && ref !== null && 'id' in ref && typeof ref.id === 'string' ? ref.id : undefined
  const error = 'error' in outcome ? outcome.error : undefined
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
  return { ...admission === undefined ? {} : { admission }, ...messageId === undefined ? {} : { messageId },
    ...code === undefined ? {} : { code } }
}

/**
 * Build the control-plane client.
 * @param options - the manager's node id, the runner's node, the wait bound and the log.
 * @returns the face `vm-agent` provisions through and the runtime settles with.
 */
export function createComputeControl(options: ComputeClientOptions): ComputeControl {
  /** Asks in flight, keyed by machine: one live ask per machine name. */
  const pending = new Map<string, Pending>()
  /** Whether the missing manager has already been reported: one line per process, not per job. */
  let reportedAbsent = false

  function logAbsent(): void {
    if (reportedAbsent) return
    reportedAbsent = true
    options.log(
      `omd-issue-runner: no compute manager answers at ${options.managerId}; `
      + 'the lease stays on the Onlyne bus and this process does not start a machine itself',
    )
  }

  /**
   * Send one control message and wait for its answer.
   * @returns the manager's answer, or `absent` when no manager is reachable —
   *   an unknown node id is how a host without the manager answers.
   */
  async function ask(
    machine: string,
    text: string,
    meta: { readonly [key: string]: Json },
    timeoutMs: number,
  ): Promise<Answer | 'absent'> {
    const node = options.node()
    if (node === undefined) return 'absent'
    const { promise, resolve } = Promise.withResolvers<Answer>()
    let settled = false
    const answer = (value: Answer): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (pending.get(machine) === row) pending.delete(machine)
      resolve(value)
    }
    const timer = setTimeout(() => {
      answer({ ok: false, reason: `no answer in ${String(timeoutMs)} ms` })
    }, timeoutMs)
    timer.unref()
    // Registered before the send: two co-hosted nodes can finish the whole
    // round trip faster than `msg` returns, and the answer must still find us.
    const row: Pending = { answer }
    pending.set(machine, row)

    let outcome: unknown
    try {
      if (typeof node.ensurePaired === 'function') {
        await node.ensurePaired(options.managerId)
      }
      outcome = await node.node.client.msg(computeRequest(options.managerId, wireOf(meta), text))
    } catch (error) {
      answer({ ok: false, reason: 'the ask was not sent' })
      if (typeof error === 'object' && error !== null && 'error' in error) {
        const failure = error.error
        if (typeof failure === 'object' && failure !== null && 'code' in failure && failure.code === 'not_found') {
          logAbsent()
          return 'absent'
        }
      }
      throw error
    }
    const sent = sentOf(outcome)
    if (sent.messageId !== undefined) row.messageId = sent.messageId
    if (sent.code === 'not_found') {
      answer({ ok: false, reason: 'no manager answers at that node id' })
      logAbsent()
      return 'absent'
    }
    if (sent.admission !== 'accepted') {
      answer({
        ok: false,
        reason: `the ask was ${sent.admission ?? 'not admitted'}${sent.code === undefined ? '' : ` (${sent.code})`}`,
      })
    }
    return promise
  }

  return {
    async acquire(spec: ComputeAcquire): Promise<ComputeLease> {
      // The OECP v1 acquire: the operation, the machine's container, the lease
      // window and the work unit it is held for. `workspacePath` stays beside
      // them as the transitional alias the manager still reads.
      const meta: { [key: string]: Json } = {
        operation: 'acquire',
        name: spec.name,
        workspacePath: spec.workspacePath,
        container: { image: spec.image },
        ...spec.ttlMs === undefined ? {} : { lease: { ttl_ms: spec.ttlMs } },
        ...spec.work === undefined ? {} : { work: workJson(spec.work) },
        ...spec.purpose === undefined ? {} : { purpose: spec.purpose },
      }
      const answer = await ask(spec.name, ACQUIRE_TEXT, meta, options.timeoutMs)
      if (answer === 'absent') return { kind: 'absent' }
      if (!answer.ok) {
        throw new Error(`omd-issue-runner: ${options.managerId} did not lease "${spec.name}": ${answer.reason}`)
      }
      const descriptor = descriptorOf(answer.data, spec.name)
      if (descriptor.state !== 'running') {
        throw new Error(
          `omd-issue-runner: ${options.managerId} holds "${spec.name}" as "${descriptor.state}", `
          + 'so no command can run in it',
        )
      }
      return { kind: 'granted', descriptor }
    },

    async renew(name: string, ttlMs: number, leaseId?: string): Promise<'renewed' | 'not-owed'> {
      const answer = await ask(name, RENEW_TEXT, {
        operation: 'renew',
        name,
        ttl_ms: ttlMs,
        ...leaseId === undefined ? {} : { lease_id: leaseId },
      }, Math.min(options.timeoutMs, RENEW_TIMEOUT_MS))
      if (answer === 'absent') return 'not-owed'
      if (!answer.ok) {
        options.log(`omd-issue-runner: ${options.managerId} did not renew "${name}": ${answer.reason}`)
        return 'not-owed'
      }
      return 'renewed'
    },

    async destroy(name: string, leaseId?: string): Promise<'destroyed' | 'not-owed'> {
      const answer = await ask(name, DESTROY_TEXT, {
        operation: 'destroy',
        name,
        ...leaseId === undefined ? {} : { lease_id: leaseId },
      },
        Math.min(options.timeoutMs, DESTROY_TIMEOUT_MS))
      if (answer === 'absent') return 'not-owed'
      if (!answer.ok) {
        // The manager refused or never answered: the caller sweeps the machine
        // itself rather than leaving it behind on a failed close.
        options.log(`omd-issue-runner: ${options.managerId} did not destroy "${name}": ${answer.reason}`)
        return 'not-owed'
      }
      return 'destroyed'
    },

    settle(entry: Entry): boolean {
      if (entry.authenticated_author !== options.managerId) return false
      const result = readComputeResult(entry)
      if (result === undefined) return false
      const named = result.ok && typeof result.data.name === 'string' && result.data.name !== '' ? result.data.name : undefined
      const replyTo = repliedToOf(entry)
      const waiting = named === undefined
        ? [...pending.values()].find(row => replyTo !== undefined && row.messageId === replyTo)
        : pending.get(named) ?? [...pending.values()].find(row => replyTo !== undefined && row.messageId === replyTo)
      if (waiting !== undefined) {
        // A standard reply is `compute-result` with a JSON body. `failed`, and a
        // body that carries `error`, settle the same ask as a refusal.
        waiting.answer(result.ok ? { ok: true, data: result.data } : { ok: false, reason: result.reason })
        return true
      }
      // Nothing in this process is waiting: the ask timed out, or the process
      // restarted under it. The entry still belongs to the manager, so it is
      // consumed here — answering it would open a thread about a thread.
      options.log(
        `omd-issue-runner: an unsolicited ${entry.message.delivery_kind} answer from ${entry.authenticated_author}: ${entry.message.msg}`,
      )
      return true
    },
  }
}

/**
 * How often one lease is renewed: half its window, and never a tight loop.
 *
 * A lease that also names an idle timeout is renewed at half of the shorter
 * window, because going idle is a way to lose it just as surely as expiring. A
 * window shorter than 100 ms renews at 50 ms, which is the floor.
 * @param ttlMs - the lease window, in milliseconds.
 * @param idleTimeoutMs - the manager's silence limit, when it names one.
 * @returns the interval between renewals, in milliseconds.
 */
export function leaseRenewInterval(ttlMs: number, idleTimeoutMs?: number): number {
  const window = idleTimeoutMs !== undefined && idleTimeoutMs > 0 ? Math.min(ttlMs, idleTimeoutMs) : ttlMs
  return Math.max(50, Math.floor(window / 2))
}

/** What one heartbeat renews and where its failures are reported. */
export interface LeaseHeartbeatOptions {
  /** Machine name, as the manager knows it. */
  readonly name: string
  /** Lease window the manager granted; the heartbeat runs at half of it. */
  readonly ttlMs: number
  /** Silence the manager allows before it stops the machine, when it named one. */
  readonly idleTimeoutMs?: number
  /** The lease's identity, when the receipt named one. */
  readonly leaseId?: string
  /** One renewal attempt; `false` means the manager did not take it. */
  readonly renew: () => Promise<boolean>
  /** Where a missed renewal is reported. */
  readonly log: (message: string) => void
}

/** The handle that stops one heartbeat. */
export interface LeaseHeartbeat {
  /** Stop renewing. Called on every path that gives the lease back. */
  stop(): void
}

/**
 * Keep one lease alive by renewing it at half its window.
 *
 * The interval is what the protocol asks for: a lease that is renewed only
 * near its end can be swept while a renewal is in flight. Two missed renewals
 * in a row stop the heartbeat — the manager has either lost the lease or
 * refused to extend it past `max_ttl_ms`, and a tighter loop would only repeat
 * the same refusal.
 * @param options - the lease, the renewal call and the log.
 * @returns the handle that stops it.
 */
export function startLeaseHeartbeat(options: LeaseHeartbeatOptions): LeaseHeartbeat {
  let stopped = false
  let missed = 0
  /** One renewal at a time: a slow answer must not pile asks under one name. */
  let inflight = false
  const intervalMs = leaseRenewInterval(options.ttlMs, options.idleTimeoutMs)
  const timer = setInterval(() => { void beat() }, intervalMs)
  timer.unref()

  async function beat(): Promise<void> {
    if (stopped || inflight) return
    inflight = true
    let renewed = false
    try {
      renewed = await options.renew()
    } catch {
      renewed = false
    } finally {
      inflight = false
    }
    if (stopped) return
    if (renewed) {
      missed = 0
      return
    }
    missed++
    if (missed < 2) {
      options.log(
        `omd-issue-runner: the lease on "${options.name}" was not renewed; retrying in ${String(intervalMs)} ms`,
      )
      return
    }
    options.log(
      `omd-issue-runner: the lease on "${options.name}"${options.leaseId === undefined ? '' : ` (${options.leaseId})`} `
      + 'was refused twice; the heartbeat stops and the manager\'s sweep decides what happens to the machine',
    )
    stop()
  }

  function stop(): void {
    stopped = true
    clearInterval(timer)
  }

  return { stop }
}
