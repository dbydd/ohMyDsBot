/**
 * `omd-compute` — a compute manager over the machines `omd-sandbox-vm` owns,
 * reachable as one Onlyne node.
 *
 * The design decision this package carries: a machine is a *resource with a
 * lease*, not a side effect of some other plugin's work. Callers ask the
 * manager; the manager decides whether a machine is started, stopped or
 * destroyed. Three consequences, each the reason the package exists:
 *
 * 1. **The control plane is Onlyne; the data plane is not.** A caller sends
 *    `compute` messages (`acquire`, `renew`, `release`, `destroy`, `status`) to
 *    this node and gets a descriptor back. Nothing about running commands or
 *    watching a desktop travels that way — those stay `omd-sandbox-vm`'s
 *    `exec` seam and the human's ticketed noVNC route.
 * 2. **Expiry stops; only retention destroys.** A lease that runs out stops its
 *    machine, which keeps the disk, the installed packages and the mount, so a
 *    later lease of the same name resumes rather than rebuilds. The disk is
 *    destroyed only after the retention window, which is the one place anything
 *    is deleted.
 * 3. **The ledger outlives the process.** Machines outlive a dsh restart and so
 *    do their leases; `compute://` and the ledger file are the two readings of
 *    the same table.
 *
 * A `compute` request is read from two envelope layers. OECP v1 puts the
 * operation and its container/resources/network/lease groups on `meta`; the
 * first implementation put a few flat fields on `meta.data`. Both are read,
 * top level winning, and a descriptor is answered in `meta.data` — the only
 * `meta` key the Onlyne envelope carries arbitrary data in.
 *
 * OrbStack offers no extension point — `orbctl` is a CLI with create/start/
 * stop/delete and no hooks — so a manager over it is a process that holds the
 * claim table and drives those verbs. That is what this is. A container spec a
 * caller sends is therefore parsed and reported, but this driver provisions
 * from its own configured image and injects no environment; the receipt says
 * what the machine actually has rather than echoing what was asked for.
 *
 * @module omd-compute
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { OnlyneError } from '@onlyne/lib'
import type { Entry, Json, Message, MsgInput, NodeId, Runtime } from '@onlyne/lib'
import z from '@deepseek-ai/schemastery'
import type { InternalExec, InternalSource } from 'omd-internal-paths'
import type { SandboxVm } from 'omd-sandbox-vm/machine'
import type { BotNode } from 'omd-onlyne/node'
import type { OnlyneService } from 'omd-onlyne/service'
import { createCompute } from './manager.ts'
import { COMPUTE_FAILED_KIND, COMPUTE_REQUEST_KIND, COMPUTE_RESULT_KIND, computeResultBody } from './wire.ts'
import {
  COMPUTE_OPERATIONS,
  type ComputeConfig,
  type ComputeLease,
  type ComputeMount,
  type ComputeOperation,
  type ComputePort,
  type ComputeRequest,
  type ComputeService,
  type ComputeSpec,
  type ExpiryReason,
} from './types.ts'

export type { ComputeConfig, ComputeLease, ComputeService, ComputeSpec, ComputeState } from './types.ts'
export { COMPUTE_OPERATIONS } from './types.ts'
export type { ComputeOperation, ComputeRequest, ComputeMount, ComputePort, ExpiryReason } from './types.ts'

/** Plugin id the Loader entry carries. */
export const name = 'omd-compute'

/** The plugin reads `onlyne` and `sandboxVm` from the process; neither is required to mount. */
export const inject: string[] = []

/** The delivery kind a requester sends. Replies use {@link COMPUTE_RESULT_KIND}. */
const COMPUTE_KIND = COMPUTE_REQUEST_KIND

/**
 * The host's data root. `DS Bot.app` runs with `DSH_HOME=~/.ds-bot`, so a
 * default that hardcodes `~/.dsh` would have two processes sharing one ledger.
 * @returns the configured dsh home, or `~/.dsh` when the host names none.
 */
function dshHome(): string {
  const configured = process.env.DSH_HOME
  return configured !== undefined && configured.length > 0 ? configured : join(homedir(), '.dsh')
}

/** Schemastery configuration for the manager. */
export const Config: z<ComputeConfig> = z.object({
  enabled: z.boolean().default(true)
    .description('Mount the manager, its Onlyne node and the compute:// paths.'),
  namePrefix: z.string().default('omd-compute-')
    .description('Machine names this manager owns; anything else under vm:// is left alone.'),
  defaultTtlMs: z.natural().default(21_600_000)
    .description('Default lease window in milliseconds; 6 h by default.'),
  maxTtlMs: z.natural().default(86_400_000)
    .description('Hard ceiling on one lease lifetime; a longer ttl_ms is refused with capacity_exceeded, 24 h by default.'),
  idleTimeoutMs: z.natural().default(0)
    .description('How long a lease may go without an acquire or renew before the sweep stops it; 0, the default, disables the check.'),
  retentionMs: z.natural().default(86_400_000)
    .description('How long a stopped machine keeps its disk after its lease expired, in milliseconds; 24 h.'),
  sweepMs: z.natural().default(300_000)
    .description('How often the lease sweep runs, in milliseconds; 5 min.'),
  poolPath: z.string().default(join(dshHome(), 'data', 'omd-compute', 'workspaces'))
    .description('Where machines whose caller named no workspace get one.'),
  ledgerPath: z.string().default(join(dshHome(), 'data', 'omd-compute', 'leases.json'))
    .description('The lease table, kept across restarts.'),
  nodeId: z.string().default('urn:onlyne:agent:compute')
    .description('Node id this manager answers as.'),
})

/**
 * One lease as the descriptor hands it to a caller.
 *
 * OECP v1 names its timestamps in `snake_case`; the first implementation used
 * `camelCase`. Both spellings are present so neither generation of caller has
 * to translate. `resolved_env` is empty because this driver injects no
 * environment: returning the caller's own `container.env` would claim values
 * had been installed in a machine that never saw them.
 * @param lease - the claim to describe.
 * @param retentionMs - how long a stopped machine's disk is kept.
 * @param now - the moment the remaining ttl is measured against.
 * @returns the descriptor, as JSON-safe values.
 */
export function describeLease(lease: ComputeLease, retentionMs: number, now = Date.now()): Record<string, Json> {
  const ttlMs = Math.max(0, lease.expiresAt - now)
  const retentionUntil = lease.expiresAt + retentionMs
  const connection: Record<string, Json> = {
    exec_transport: 'vm_exec',
    endpoints: {},
    // `portal` is the address the machine's provider advertised. The fallback is
    // `omd-sandbox-vm`'s own source address for a machine's desktop.
    portal_urls: { desktop: lease.portal ?? `vm://${lease.name}/desktop` },
  }
  const allocated: Record<string, Json> = {
    cpu_cores: lease.allocated?.cpuCores ?? 0,
    memory_mb: lease.allocated?.memoryMb ?? 0,
    ...(lease.allocated?.diskGb === undefined ? {} : { disk_gb: lease.allocated.diskGb }),
  }
  return {
    lease_id: lease.leaseId,
    name: lease.name,
    owner: lease.owner,
    state: lease.state,
    workspacePath: lease.workspacePath,
    purpose: lease.purpose,
    createdAt: lease.createdAt,
    created_at: lease.createdAt,
    expiresAt: lease.expiresAt,
    expires_at: lease.expiresAt,
    retentionUntil,
    retention_until: retentionUntil,
    ttlMs,
    ttl_ms: ttlMs,
    maxTtlMs: lease.maxTtlMs,
    max_ttl_ms: lease.maxTtlMs,
    connection,
    resolved_env: {},
    allocated,
  }
}

/**
 * The answer body a caller reads before the card.
 * @param lease - the lease the operation produced.
 * @param operation - what was asked.
 * @returns one line naming the machine and what happened to it.
 */
function answerBody(lease: ComputeLease, operation: ComputeOperation): string {
  const state = lease.state === 'running' ? 'running' : lease.state === 'stopped' ? 'stopped (disk kept)' : 'released'
  return [
    `compute ${operation}: ${lease.name} is ${state}.`,
    `lease: ${lease.leaseId} (owner ${lease.owner})`,
    `workspace: ${lease.workspacePath}`,
    `lease ends: ${new Date(lease.expiresAt).toISOString()} (${String(Math.round((lease.expiresAt - Date.now()) / 60_000))} min)`,
    lease.purpose === null ? '' : `purpose: ${lease.purpose}`,
  ].filter(line => line !== '').join('\n')
}

/** A JSON object, or an empty one: a field of the wrong shape is ignored, not guessed at. */
function objectOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  // The check above proves an object; the index signature only types the read.
  return value as Record<string, unknown>
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function stringsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function envOf(value: unknown): Record<string, string> | undefined {
  const fields = objectOf(value)
  const env: Record<string, string> = {}
  for (const [key, entry] of Object.entries(fields)) {
    if (typeof entry === 'string') env[key] = entry
  }
  return env
}

/** One bind, volume or tmpfs out of an OECP `container.mounts` list. */
function mountsOf(value: unknown): ComputeMount[] | undefined {
  if (!Array.isArray(value)) return undefined
  const mounts: ComputeMount[] = []
  for (const entry of value) {
    const mount = objectOf(entry)
    const containerPath = textOf(mount.container_path) ?? textOf(mount.containerPath)
    if (containerPath === undefined) continue
    const type = textOf(mount.type)
    mounts.push({
      type: type === 'volume' || type === 'tmpfs' ? type : 'bind',
      ...(textOf(mount.host_path) === undefined ? {} : { hostPath: textOf(mount.host_path) }),
      containerPath,
      readOnly: booleanOf(mount.read_only) ?? booleanOf(mount.readOnly) ?? false,
    })
  }
  return mounts
}

/** One port out of `network.expose_ports` (or the spec's older `nat_ports`). */
function portsOf(value: unknown): ComputePort[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ports: ComputePort[] = []
  for (const entry of value) {
    const port = objectOf(entry)
    const containerPort = numberOf(port.container_port) ?? numberOf(port.containerPort)
    if (containerPort === undefined) continue
    ports.push({
      name: textOf(port.name) ?? `port-${String(containerPort)}`,
      containerPort,
      protocol: textOf(port.protocol) ?? 'tcp',
      public: booleanOf(port.public) ?? false,
    })
  }
  return ports
}

/** One writable view of {@link ComputeRequest}, so the parse can fill fields as it reads them. */
type RequestDraft = { -readonly [K in keyof ComputeRequest]: ComputeRequest[K] }

/**
 * Read one field across both envelope layers and, when named, one nested group.
 *
 * The top layer wins as a whole, not just key by key: a top-level `ttl_ms` beats
 * a legacy `data.ttlMs` even though the two spellings are different keys. Within
 * one layer the aliases are tried in order.
 * @param top - the message's `meta`.
 * @param data - the message's `meta.data`.
 * @param keys - the field's spellings, most OECP-like first.
 * @param group - the OECP spec group the field may also live under.
 * @returns the first value the layers name.
 */
function layered(
  top: Record<string, unknown>,
  data: Record<string, unknown>,
  keys: readonly string[],
  group?: string,
): unknown {
  const topGroup = group === undefined ? {} : objectOf(top[group])
  const dataGroup = group === undefined ? {} : objectOf(data[group])
  for (const layer of [top, topGroup, data, dataGroup]) {
    for (const key of keys) if (layer[key] !== undefined) return layer[key]
  }
  return undefined
}

/**
 * Read one `compute` request from a message.
 *
 * OECP v1 puts `operation`, `name`, `lease_id` and the four spec groups on the
 * message's `meta`; the legacy spelling puts a few flat fields on `meta.data`.
 * Both layers are merged, the top level winning, and the nested groups likewise
 * take their top-level spelling over the legacy one. An older flat `image`,
 * `ttlMs`, `purpose` and `workspacePath` still work.
 * @param message - the request as delivered.
 * @returns every field the message named, in one vocabulary.
 */
export function extractComputeRequest(message: Message): ComputeRequest {
  // `meta` is typed as the Onlyne envelope; these keys are the compute payload
  // that shares it, so the two layers are read through an index signature.
  const top = objectOf(message.meta)
  const data = objectOf(top.data)
  const request: RequestDraft = {}
  const operation = textOf(layered(top, data, ['operation']))
  if (operation !== undefined && (COMPUTE_OPERATIONS as readonly string[]).includes(operation)) {
    request.operation = operation as ComputeOperation
  }
  const name = textOf(layered(top, data, ['name']))
  if (name !== undefined) request.name = name
  const leaseId = textOf(layered(top, data, ['lease_id', 'leaseId']))
  if (leaseId !== undefined) request.leaseId = leaseId
  const mounts = mountsOf(layered(top, data, ['mounts'], 'container'))
  const workspacePath = textOf(layered(top, data, ['workspacePath']))
  if (workspacePath !== undefined && workspacePath.startsWith('/')) request.workspacePath = workspacePath
  else if (request.workspacePath === undefined) {
    const bound = mounts?.find(mount => mount.type === 'bind' && mount.hostPath?.startsWith('/') === true)
    if (bound?.hostPath !== undefined) request.workspacePath = bound.hostPath
  }
  if (mounts !== undefined) request.mounts = mounts

  const ttlMs = numberOf(layered(top, data, ['ttl_ms', 'ttlMs'], 'lease'))
  if (ttlMs !== undefined) request.ttlMs = ttlMs
  const maxTtlMs = numberOf(layered(top, data, ['max_ttl_ms', 'maxTtlMs'], 'lease'))
  if (maxTtlMs !== undefined) request.maxTtlMs = maxTtlMs
  const idleTimeoutMs = numberOf(layered(top, data, ['idle_timeout_ms', 'idleTimeoutMs'], 'lease'))
  if (idleTimeoutMs !== undefined) request.idleTimeoutMs = idleTimeoutMs
  const autoDestroy = booleanOf(layered(top, data, ['auto_destroy', 'autoDestroy'], 'lease'))
  if (autoDestroy !== undefined) request.autoDestroy = autoDestroy

  const image = textOf(layered(top, data, ['image'], 'container'))
  if (image !== undefined) request.image = image
  const env = envOf(layered(top, data, ['env'], 'container'))
  if (env !== undefined) request.env = env
  const exposeEnv = stringsOf(layered(top, data, ['expose_env', 'exposeEnv'], 'container'))
  if (exposeEnv !== undefined) request.exposeEnv = exposeEnv

  const cpus = numberOf(layered(top, data, ['cpus', 'cpu_cores'], 'resources'))
  if (cpus !== undefined) request.cpus = cpus
  const memoryInGb = numberOf(layered(top, data, ['memory_gb', 'memoryGb'], 'resources'))
  const memoryMb = numberOf(layered(top, data, ['memory_mb', 'memoryMb'], 'resources'))
    ?? (memoryInGb === undefined ? undefined : memoryInGb * 1024)
  if (memoryMb !== undefined) request.memoryMb = memoryMb
  const diskGb = numberOf(layered(top, data, ['disk_gb', 'diskGb'], 'resources'))
  if (diskGb !== undefined) request.diskGb = diskGb
  const exposePorts = portsOf(layered(top, data, ['expose_ports', 'nat_ports'], 'network'))
  if (exposePorts !== undefined) request.exposePorts = exposePorts
  const provider = objectOf(layered(top, data, ['provider_meta', 'providerMeta']))
  if (Object.keys(provider).length > 0) {
    // Provider scheduling keys are opaque here: carried as JSON, never interpreted.
    request.providerMeta = provider as unknown as Json
  }
  const purpose = textOf(layered(top, data, ['purpose']))
  if (purpose !== undefined) request.purpose = purpose
  return request
}

/** The fields of a parsed request the machine provider can actually honour. */
function specOf(request: ComputeRequest): ComputeSpec {
  return {
    name: request.name ?? '',
    ...(request.workspacePath === undefined ? {} : { workspacePath: request.workspacePath }),
    ...(request.ttlMs === undefined ? {} : { ttlMs: request.ttlMs }),
    ...(request.maxTtlMs === undefined ? {} : { maxTtlMs: request.maxTtlMs }),
    ...(request.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: request.idleTimeoutMs }),
    ...(request.autoDestroy === undefined ? {} : { autoDestroy: request.autoDestroy }),
    ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
    ...(request.cpus === undefined ? {} : { cpus: request.cpus }),
    ...(request.memoryMb === undefined ? {} : { memoryMb: request.memoryMb }),
    ...(request.diskGb === undefined ? {} : { diskGb: request.diskGb }),
  }
}

/**
 * One answer into the thread the request came from.
 *
 * Descriptor fields are spread into `MsgInput.meta`, because
 * `OnlyneClient.#prepare` wraps that whole object as the delivered
 * `message.meta.data` — the Onlyne envelope's arbitrary-data key. Nesting them
 * under `data` here would deliver `meta.data.data` instead, and a reply that
 * tried to put them on the wire's top-level `meta` would be refused at
 * admission by the receiving node's strict `meta` shape.
 * @param node - this manager's node.
 * @param entry - the request.
 * @param kind - `compute-result` for a descriptor, `failed` for a refusal.
 * @param body - the text a human reads. A result also carries that text as `summary` inside the JSON body.
 * @param data - the descriptor a caller reads.
 */
export async function sendReply(
  node: BotNode,
  entry: Entry,
  kind: typeof COMPUTE_RESULT_KIND | typeof COMPUTE_FAILED_KIND,
  body: string,
  data: Record<string, Json>,
): Promise<void> {
  if (typeof node.ensurePaired === 'function') {
    await node.ensurePaired(entry.authenticated_author)
  }
  const payload: Record<string, Json> = kind === COMPUTE_FAILED_KIND ? data : { summary: body, ...data }
  const message: MsgInput = {
    delivery_kind: kind,
    msg: kind === COMPUTE_FAILED_KIND ? body : computeResultBody(payload),
    meta: {
      ...payload,
      to: entry.authenticated_author,
      thread: { owner: entry.thread_ref.owner, id: entry.thread_ref.id },
      in_reply_to: { sender: entry.message.sender, id: entry.message.id },
    },
  }
  await node.node.client.msg(message)
}

/**
 * Handle one `compute` entry from the broker node's inbox.
 *
 * The owner of every verb is the entry's authenticated author, not a field the
 * message can name: a caller cannot claim somebody else's lease by writing
 * their name into the request.
 * @param node - the compute node, for its client.
 * @param entry - the request.
 * @param compute - the lease table.
 * @param config - validated settings, for the receipt's retention deadline.
 */
export async function handleBrokerInbox(
  node: BotNode,
  entry: Entry,
  compute: ComputeService,
  config: ComputeConfig,
): Promise<void> {
  const request = extractComputeRequest(entry.message)
  try {
    const operation = request.operation
    if (operation === undefined) {
      await sendReply(node, entry, COMPUTE_FAILED_KIND, [
        'compute: the message names no operation.',
        `It answers: ${COMPUTE_OPERATIONS.join(', ')} — name one in meta.operation `
          + '(or, for the legacy envelope, meta.data.operation).',
      ].join('\n'), { error: { code: 'invalid_request', message: 'meta.operation names no operation' } })
      return
    }
    const ref = request.leaseId ?? request.name
    if (operation === 'status') {
      const shown = ref === undefined
        ? compute.list()
        : compute.list().filter(lease => lease.leaseId === ref || lease.name === ref)
      if (ref !== undefined && shown.length === 0) {
        throw new OnlyneError('not_found', `compute: no lease named "${ref}".`)
      }
      await sendReply(node, entry, COMPUTE_RESULT_KIND, [
        `compute status: ${String(shown.length)} lease(s).`,
        ...shown.map(lease => `- ${lease.name}: ${lease.state}, ends ${new Date(lease.expiresAt).toISOString()}`),
      ].join('\n'), {
        operation,
        leases: shown.map(lease => describeLease(lease, config.retentionMs)),
      })
      return
    }
    if (ref === undefined) {
      throw new OnlyneError('invalid_request', 'compute: the message names no machine — pass meta.name or meta.lease_id.')
    }
    const owner = entry.authenticated_author
    if (operation === 'acquire') {
      if (request.name === undefined) {
        throw new OnlyneError('invalid_request', 'compute acquire: the machine name goes in meta.name.')
      }
      const lease = await compute.acquire(specOf(request), owner)
      await sendReply(node, entry, COMPUTE_RESULT_KIND, answerBody(lease, 'acquire'), {
        operation, ...describeLease(lease, config.retentionMs),
      })
      return
    }
    if (operation === 'renew') {
      const lease = await compute.renew(ref, request.ttlMs, owner)
      await sendReply(node, entry, COMPUTE_RESULT_KIND, answerBody(lease, 'renew'), {
        operation, ...describeLease(lease, config.retentionMs),
      })
      return
    }
    if (operation === 'release') {
      const before = compute.get(ref)
      if (before === undefined) {
        await sendReply(node, entry, COMPUTE_FAILED_KIND, `compute release: no lease named "${ref}".`, { operation, name: ref })
        return
      }
      await compute.release(ref, owner)
      const after = compute.get(ref)
      await sendReply(node, entry, COMPUTE_RESULT_KIND, after === undefined
        ? `compute release: ${before.name} and its disk are gone.`
        : answerBody(after, 'release'), after === undefined
        ? { operation, name: before.name, state: 'released' }
        : { operation, ...describeLease(after, config.retentionMs) })
      return
    }
    const destroyed = await compute.destroy(ref, owner)
    await sendReply(node, entry, destroyed ? COMPUTE_RESULT_KIND : COMPUTE_FAILED_KIND, destroyed
      ? `compute destroy: ${ref} and its disk are gone.`
      : `compute destroy: no machine named "${ref}" belongs to this manager.`, { operation, name: ref, destroyed })
  } catch (error) {
    const code = error instanceof OnlyneError ? error.error.code : 'internal'
    const message = error instanceof Error ? error.message : String(error)
    await sendReply(node, entry, COMPUTE_FAILED_KIND, `compute: ${message}`, {
      ...(request.operation === undefined ? {} : { operation: request.operation }),
      error: { code, message },
    }).catch(() => undefined)
  }
}

/**
 * The runtime this node delivers into.
 *
 * `inject` returns at once, like the issue runner's: a `provision` can take a
 * minute, and holding the maintenance loop for it would delay every other
 * entry. The work runs beside the loop and answers when it is done.
 * @param nodeId - the identity answers are stamped with.
 * @param node - the node itself, resolved per answer so the runtime can be built first.
 * @param compute - the lease table.
 * @param config - validated settings.
 * @returns the runtime the node was created with.
 */
function createRuntime(
  nodeId: NodeId,
  node: () => BotNode | undefined,
  compute: ComputeService,
  config: ComputeConfig,
): Runtime {
  return {
    supports: async (_plan, message) => {
      // Some admission checks call supports(plan) with no message. Refusing those
      // drops the request before it exists. A present message is filtered: this
      // node executes `compute` and must still admit its own `compute-result`.
      if (message === undefined) return true
      const kind = message.delivery_kind
      return kind === COMPUTE_KIND || kind === COMPUTE_RESULT_KIND || kind === COMPUTE_FAILED_KIND
    },
    async inject(entry: Entry, context: string | undefined) {
      if (entry.message.delivery_kind !== COMPUTE_KIND) {
        return { context: context ?? nodeId, consumed: true, outcome: 'consumed' }
      }
      void handle(entry)
      return { context: context ?? nodeId, consumed: true, outcome: 'queued' }
    },
    notify: () => {},
  }

  async function handle(entry: Entry): Promise<void> {
    const bot = node()
    if (bot === undefined) return
    await handleBrokerInbox(bot, entry, compute, config)
  }
}

/**
 * The node id a `compute://` POST answers as.
 *
 * A path call belongs to the session or agent that made it, not to the path:
 * every dsh session has an Onlyne node at `urn:onlyne:agent:<sessionId>`, and
 * writing a fixed owner here would let one session release another's machine.
 * @param exec - the path call's execution context.
 * @param fields - the POST body, which may name an explicit `owner`.
 * @returns the node id that owns everything this POST does.
 */
function callerOf(exec: InternalExec, fields: Record<string, unknown>): string {
  const agent: unknown = exec.agent
  const session = agent !== null && typeof agent === 'object' && 'session' in agent ? objectOf(agent.session) : {}
  const identity = textOf(session.id) ?? textOf(exec.sessionId) ?? textOf(fields.owner)
  if (identity === undefined) {
    throw new OnlyneError(
      'invalid_request',
      'compute:// needs a caller identity: call it from an agent session, pass ?session=<id>, or name one in owner.',
    )
  }
  return identity.startsWith('urn:') ? identity : `urn:onlyne:agent:${identity}`
}

/**
 * `compute://` — the lease table as a document and an action.
 * @param compute - the lease table.
 * @param config - validated settings.
 * @returns the source the internal-path registry publishes.
 */
export function createComputeSource(compute: ComputeService, config: ComputeConfig): InternalSource {
  return {
    grammar: 'compute:// | compute://<name>',
    description:
      'Compute leases: GET the table or one lease as JSON; POST to compute:// with '
      + '{ operation, name?, lease_id?, ttl_ms|ttlMs?, max_ttl_ms?, workspacePath?, purpose? } '
      + 'to acquire, renew, release, destroy or read status. The owner is the calling session.',
    shorthand: true,
    async read(path, _exec: InternalExec) {
      const clean = path.trim().replace(/^\/+/u, '').replace(/\/+$/u, '')
      if (clean === '') {
        return `${JSON.stringify({
          nodeId: config.nodeId,
          defaultTtlMs: config.defaultTtlMs,
          maxTtlMs: config.maxTtlMs,
          idleTimeoutMs: config.idleTimeoutMs,
          retentionMs: config.retentionMs,
          // The lease name is the machine name: prefixing again here would name
          // a machine that does not exist.
          leases: compute.list().map(lease => ({
            ...describeLease(lease, config.retentionMs),
            machine: lease.name,
          })),
        }, null, 2)}\n`
      }
      const lease = compute.get(clean)
      if (lease === undefined) {
        throw new OnlyneError('not_found', `omd-compute: no lease named "${clean}"; read compute:// for the table`)
      }
      return `${JSON.stringify(describeLease(lease, config.retentionMs), null, 2)}\n`
    },
    async post(path, content, exec: InternalExec) {
      const clean = path.trim().replace(/^\/+/u, '').replace(/\/+$/u, '')
      if (clean !== '') throw new Error(`compute:// POST acts on the table, not on "${clean}"`)
      const parsed: unknown = JSON.parse(content)
      const fields = objectOf(parsed)
      // The POST body is the same envelope a `compute` message carries, so the
      // one parser reads both without a second, drifting set of field names.
      const message: Message = {
        id: '',
        sender: '',
        delivery_kind: COMPUTE_KIND,
        msg: '',
        meta: fields as unknown as Message['meta'],
      }
      const request = extractComputeRequest(message)
      const operation = request.operation
      if (operation === undefined) {
        throw new OnlyneError('invalid_request', `compute:// POST needs operation to be one of ${COMPUTE_OPERATIONS.join(', ')}`)
      }
      const owner = callerOf(exec, fields)
      const ref = request.leaseId ?? request.name
      if (operation === 'status') {
        const listed = ref === undefined
          ? compute.list()
          : compute.list().filter(lease => lease.leaseId === ref || lease.name === ref)
        return `${JSON.stringify(listed.map(lease => describeLease(lease, config.retentionMs)), null, 2)}\n`
      }
      if (ref === undefined) {
        throw new OnlyneError('invalid_request', 'compute:// POST needs a machine name in name (or a lease_id)')
      }
      if (operation === 'acquire') {
        const lease = await compute.acquire(specOf({ ...request, name: request.name ?? ref }), owner)
        return `${JSON.stringify(describeLease(lease, config.retentionMs), null, 2)}\n`
      }
      if (operation === 'renew') {
        const lease = await compute.renew(ref, request.ttlMs, owner)
        return `${JSON.stringify(describeLease(lease, config.retentionMs), null, 2)}\n`
      }
      if (operation === 'release') {
        return `${JSON.stringify({ name: ref, released: await compute.release(ref, owner) })}\n`
      }
      return `${JSON.stringify({ name: ref, destroyed: await compute.destroy(ref, owner) })}\n`
    },
  }
}

/**
 * Tell a lease's owner that the sweep stopped its machine.
 * @param node - the compute node; absent until Onlyne has mounted.
 * @param lease - the lease as it stands after the stop.
 * @param reason - why it was stopped.
 * @param retentionMs - how long the disk is kept.
 * @param log - where a failed notice is reported.
 */
export async function sendExpiry(
  node: BotNode | undefined,
  lease: ComputeLease,
  reason: ExpiryReason,
  retentionMs: number,
  log: (message: string) => void,
): Promise<void> {
  if (node === undefined || !lease.owner.startsWith('urn:onlyne:')) return
  try {
    if (typeof node.ensurePaired === 'function') {
      await node.ensurePaired(lease.owner)
    }
    const summary = [
      `compute expired: ${lease.name} was stopped (${reason}).`,
      `lease: ${lease.leaseId}`,
      `retention ends: ${new Date(lease.expiresAt + retentionMs).toISOString()}`,
    ].join('\n')
    const payload: Record<string, Json> = {
      summary,
      operation: 'expired',
      reason,
      ...describeLease(lease, retentionMs),
    }
    const message: MsgInput = {
      delivery_kind: COMPUTE_RESULT_KIND,
      msg: computeResultBody(payload),
      meta: { to: lease.owner, ...payload },
    }
    await node.node.client.msg(message)
  } catch (error) {
    log(`omd-compute: the expiry notice for "${lease.name}" was not sent: ${
      error instanceof Error ? error.message : String(error)
    }`)
  }
}

/**
 * Mount the manager, its node, its internal path and its sweep.
 * @param ctx - plugin context.
 * @param config - validated deployment settings.
 */
export function apply(ctx: Context, config: ComputeConfig): void {
  if (!config.enabled) return

  /** The compute node, once Onlyne has created it; the sweep reads it lazily. */
  const brokerNode: { current: BotNode | undefined } = { current: undefined }

  const compute = createCompute(config, {
    vm: () => ctx.get('sandboxVm') as SandboxVm | undefined,
    log: message => ctx.logger.warn(message),
    onExpire: async (lease, reason) => {
      await sendExpiry(brokerNode.current, lease, reason, config.retentionMs, message => ctx.logger.warn(message))
    },
  })

  void compute.load().catch((error: unknown) => {
    ctx.logger.warn('omd-compute: the lease ledger could not be loaded: %o', error)
  })

  // The node mounts when Onlyne mounts, not when this fiber happens to apply:
  // `ctx.get` at apply time can be empty for a sibling that has not started yet.
  ctx.inject(['onlyne'], scope => {
    const service: OnlyneService | undefined = scope.get('onlyne')
    if (service === undefined) return
    let node: BotNode | undefined
    const pending = service.createNode({
      nodeId: config.nodeId,
      runtime: createRuntime(config.nodeId, () => node, compute, config),
    }).then(created => {
      node = created
      brokerNode.current = created
      return created
    })
    pending.catch((error: unknown) => {
      ctx.logger.warn('omd-compute: the compute node could not start: %o', error)
    })
    scope.effect(() => () => {
      brokerNode.current = undefined
      void pending.then(created => created.dispose(), () => undefined)
    }, 'omd-compute: node')
    ctx.logger.info(`omd-compute: leases are overseen by ${config.nodeId}`)
  })

  ctx.inject(['internalPaths'], scope => {
    const internalPaths = scope.get('internalPaths')
    if (internalPaths === undefined) return
    scope.effect(
      () => internalPaths.register('compute', createComputeSource(compute, config)),
      'omd-compute: compute:// source',
    )
  })

  ctx.effect(() => {
    const timer = setInterval(() => {
      void compute.sweep().catch((error: unknown) => {
        ctx.logger.warn('omd-compute: the lease sweep failed: %o', error)
      })
    }, config.sweepMs)
    timer.unref()
    return () => clearInterval(timer)
  }, 'omd-compute: lease sweep')
}
