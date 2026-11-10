import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OnlyneError } from '@onlyne/lib'
import type { BotNode } from 'omd-onlyne/node'
import type { Entry, Json, Message, MsgInput } from '@onlyne/lib'
import type { InternalExec } from 'omd-internal-paths'
import type { SandboxVm } from 'omd-sandbox-vm/machine'
import type { Sandbox, SandboxExecResult, SandboxRequest } from 'omd-sandbox-vm/types'
import {
  Config,
  createComputeSource,
  describeLease,
  extractComputeRequest,
  handleBrokerInbox,
  sendExpiry,
} from './index.ts'
import { createCompute } from './manager.ts'
import type { ComputeConfig, ComputeLease, ExpiryReason } from './types.ts'

/** One directory per test run, removed when the file is done. */
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'omd-compute-tests-'))
afterAll(async () => { await rm(TEST_ROOT, { recursive: true, force: true }) })

/** Two nodes whose leases must not be confused. */
const PEER_A = 'urn:onlyne:agent:onlyne-a'
const PEER_B = 'urn:onlyne:agent:onlyne-b'
const MACHINE = 'omd-compute-oecp'

/** A machine provider that records verbs instead of moving bytes or disks. */
function fakeVm(): { vm: SandboxVm; calls: string[]; present: Set<string> } {
  const calls: string[] = []
  const present = new Set<string>()
  const sandbox = (name: string, state: Sandbox['state'] = 'ready'): Sandbox => ({
    name,
    workspacePath: '/workspace',
    state,
    desktopUrl: `http://${name}.orb.local:5901/vnc.html`,
  })
  const empty: SandboxExecResult = { stdout: '', stderr: '', outcome: 'exited', code: 0 }
  const vm: SandboxVm = {
    async provision(request: SandboxRequest) {
      calls.push(`provision ${request.name}`)
      present.add(request.name)
      return sandbox(request.name)
    },
    async exec() { return empty },
    async inspect(name: string) {
      return present.has(name) ? sandbox(name) : undefined
    },
    async dispose(name: string) {
      calls.push(`dispose ${name}`)
      present.delete(name)
    },
    async list() { return [...present].map(name => sandbox(name)) },
    async snapshot(name: string) {
      if (!present.has(name)) return undefined
      return {
        name,
        state: 'ready' as const,
        workspacePath: '/workspace',
        desktop: true,
        cpus: 4,
        memoryMiB: 8192,
        image: 'debian:12',
      }
    },
    async snapshots() { return [] },
    async openDesktop() { throw new Error('no desktop in this fake') },
    async captureFrame() { throw new Error('no desktop in this fake') },
    async stop(name: string) {
      calls.push(`stop ${name}`)
    },
    async start(name: string) {
      calls.push(`start ${name}`)
    },
    async sweepIdle() { return [] },
    async disposeOwned() {},
  }
  return { vm, calls, present }
}

/** Settings whose files live under the test root; idle reclamation is off unless a test names it. */
function config(overrides: Partial<ComputeConfig> = {}): ComputeConfig {
  const home = join(TEST_ROOT, Math.random().toString(36).slice(2))
  return {
    enabled: true,
    namePrefix: 'omd-compute-',
    defaultTtlMs: 60_000,
    maxTtlMs: 86_400_000,
    idleTimeoutMs: 0,
    retentionMs: 10_000,
    sweepMs: 300_000,
    poolPath: join(home, 'workspaces'),
    ledgerPath: join(home, 'leases.json'),
    nodeId: 'urn:onlyne:agent:compute',
    ...overrides,
  }
}

/** A compute node whose client records what it would send. */
function fakeNode(): { node: BotNode; sent: MsgInput[] } {
  const sent: MsgInput[] = []
  const node = {
    node: {
      client: {
        async msg(input: MsgInput) {
          sent.push(input)
          return {}
        },
      },
    },
  } as unknown as BotNode
  return { node, sent }
}

/** One inbox entry carrying a `compute` envelope. */
function entryOf(meta: Record<string, unknown>, author = PEER_A): Entry {
  const message: Message = {
    id: 'message-1',
    sender: author,
    delivery_kind: 'compute',
    msg: 'compute request',
    // The compute payload shares `meta` with the Onlyne envelope; the test builds it raw.
    meta: meta as unknown as Message['meta'],
  }
  return {
    thread_ref: { owner: 'urn:onlyne:agent:compute', id: 'thread-1' },
    seq: '1',
    message,
    authenticated_author: author,
    reply_authority: author,
    at: new Date().toISOString(),
  }
}

/** One message carrying a `compute` envelope, for the parser's own tests. */
function messageOf(meta: Record<string, unknown>): Message {
  return entryOf(meta).message
}

/** The descriptor a reply put under `meta.data`. */
function dataOf(sent: MsgInput[]): Record<string, Json> {
  const reply = sent.at(-1)
  // OnlyneClient.#prepare wraps the whole `MsgInput.meta` as the delivered
  // `message.meta.data`, so the descriptor is the MsgInput's meta itself.
  return (reply?.meta ?? {}) as Record<string, Json>
}

/** The Onlyne error code a rejected promise carries, or `none` when it resolved. */
async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
    return 'none'
  } catch (error) {
    if (error instanceof OnlyneError) return error.error.code
    throw error
  }
}

describe('compute manager', () => {
  test('acquire provisions once and renews the same lease', async () => {
    const { vm, calls } = fakeVm()
    const compute = createCompute(config(), { vm: () => vm, log: () => {} })

    const first = await compute.acquire({ name: 'omd-compute-a' }, PEER_A)
    const second = await compute.acquire({ name: 'omd-compute-a' }, PEER_A)

    expect(calls.filter(call => call.startsWith('provision'))).toEqual(['provision omd-compute-a'])
    expect(second.expiresAt).toBeGreaterThanOrEqual(first.expiresAt)
    expect(compute.list()).toHaveLength(1)
  })

  test('release stops the machine and keeps the disk', async () => {
    const { vm, calls, present } = fakeVm()
    const compute = createCompute(config(), { vm: () => vm, log: () => {} })

    await compute.acquire({ name: 'omd-compute-b' }, PEER_A)
    expect(await compute.release('omd-compute-b', PEER_A)).toBe(true)

    expect(calls).toContain('stop omd-compute-b')
    expect(present.has('omd-compute-b')).toBe(true)
    expect(compute.get('omd-compute-b')?.state).toBe('stopped')
  })

  test('a stopped lease resumes the same machine instead of provisioning again', async () => {
    const { vm, calls } = fakeVm()
    const compute = createCompute(config(), { vm: () => vm, log: () => {} })

    await compute.acquire({ name: 'omd-compute-c' }, PEER_A)
    await compute.release('omd-compute-c', PEER_A)
    await compute.acquire({ name: 'omd-compute-c' }, PEER_A)

    expect(calls.filter(call => call.startsWith('provision'))).toHaveLength(1)
    expect(calls).toContain('start omd-compute-c')
  })

  test('an early release starts the retention window at the release', async () => {
    const { vm } = fakeVm()
    const compute = createCompute(config({ defaultTtlMs: 3_600_000 }), { vm: () => vm, log: () => {} })

    const lease = await compute.acquire({ name: 'omd-compute-g' }, PEER_A)
    await compute.release('omd-compute-g', PEER_A)

    const released = compute.get('omd-compute-g')
    expect(released?.state).toBe('stopped')
    expect(released?.expiresAt).toBeLessThan(lease.expiresAt)
  })

  test('sweep stops an expired lease, then destroys it after retention', async () => {
    const { vm, calls, present } = fakeVm()
    const compute = createCompute(config(), { vm: () => vm, log: () => {} })
    const lease = await compute.acquire({ name: 'omd-compute-d' }, PEER_A)

    expect(await compute.sweep(lease.expiresAt + 1)).toEqual(['omd-compute-d'])
    expect(calls).toContain('stop omd-compute-d')
    expect(present.has('omd-compute-d')).toBe(true)

    expect(await compute.sweep(lease.expiresAt + 10_001)).toEqual(['omd-compute-d'])
    expect(calls).toContain('dispose omd-compute-d')
    expect(compute.get('omd-compute-d')).toBeUndefined()
  })

  test('destroy removes the machine and the lease', async () => {
    const { vm, calls } = fakeVm()
    const compute = createCompute(config(), { vm: () => vm, log: () => {} })

    await compute.acquire({ name: 'omd-compute-e' }, PEER_A)
    expect(await compute.destroy('omd-compute-e', PEER_A)).toBe(true)

    expect(calls).toContain('dispose omd-compute-e')
    expect(compute.get('omd-compute-e')).toBeUndefined()
  })

  test('a caller-named workspace is never deleted by the manager', async () => {
    const { vm } = fakeVm()
    const compute = createCompute(config(), { vm: () => vm, log: () => {} })
    const lease = await compute.acquire({
      name: 'omd-compute-f',
      workspacePath: join(TEST_ROOT, 'caller-owns-this'),
    }, PEER_A)

    expect(lease.workspacePath).toBe(join(TEST_ROOT, 'caller-owns-this'))
    await compute.destroy('omd-compute-f', PEER_A)
    // Nothing threw, and the path was left for its owner to manage.
    expect(compute.list()).toHaveLength(0)
  })
})

describe('OECP v1 envelope', () => {
  test('extractComputeRequest merges both layers, top level winning', () => {
    const request = extractComputeRequest(messageOf({
      operation: 'renew',
      name: 'winner',
      ttl_ms: 1_800_000,
      container: { image: 'debian:12-slim', env: { CI: 'true' }, expose_env: ['AGENT_TOKEN'] },
      resources: { cpus: 4, memory_mb: 8192, disk_gb: 40 },
      network: { expose_ports: [{ name: 'vnc-desktop', container_port: 6080, protocol: 'tcp', public: true }] },
      provider_meta: { selector: 'local-orbstack' },
      lease: { max_ttl_ms: 14_400_000, idle_timeout_ms: 600_000, auto_destroy: true },
      data: {
        operation: 'destroy',
        name: 'loser',
        ttlMs: 9_000_000,
        purpose: 'legacy purpose',
      },
    }))

    expect(request.operation).toBe('renew')
    expect(request.name).toBe('winner')
    expect(request.ttlMs).toBe(1_800_000)
    expect(request.maxTtlMs).toBe(14_400_000)
    expect(request.idleTimeoutMs).toBe(600_000)
    expect(request.autoDestroy).toBe(true)
    expect(request.image).toBe('debian:12-slim')
    expect(request.env).toEqual({ CI: 'true' })
    expect(request.exposeEnv).toEqual(['AGENT_TOKEN'])
    expect(request.cpus).toBe(4)
    expect(request.memoryMb).toBe(8192)
    expect(request.diskGb).toBe(40)
    expect(request.exposePorts?.[0]?.name).toBe('vnc-desktop')
    expect(request.providerMeta).toEqual({ selector: 'local-orbstack' })
    // A field absent from the top level still comes from the legacy layer.
    expect(request.purpose).toBe('legacy purpose')
  })

  test('a top-level meta acquire answers with the complete OECP receipt', async () => {
    const settings = config()
    const { vm, calls } = fakeVm()
    const compute = createCompute(settings, { vm: () => vm, log: () => {} })
    const { node, sent } = fakeNode()

    await handleBrokerInbox(node, entryOf({
      to: settings.nodeId,
      operation: 'acquire',
      name: MACHINE,
      container: {
        image: 'debian:12-slim',
        env: { CI: 'true' },
        mounts: [{ type: 'volume', container_path: '/workspace', read_only: false }],
      },
      resources: { cpus: 4, memory_mb: 8192, disk_gb: 40 },
      network: { expose_ports: [{ name: 'vnc-desktop', container_port: 6080, protocol: 'tcp', public: true }] },
      provider_meta: { selector: 'local-orbstack' },
      lease: { ttl_ms: 1_800_000, max_ttl_ms: 14_400_000, idle_timeout_ms: 600_000 },
      purpose: 'PR validation',
    }), compute, settings)

    expect(sent).toHaveLength(1)
    expect(sent[0]?.delivery_kind).toBe('compute-result')
    // No double nesting: the receipt must arrive as message.meta.data.<field>,
    // not message.meta.data.data.<field>.
    expect(sent[0]?.meta?.data).toBeUndefined()
    const data = dataOf(sent)
    expect(data.operation).toBe('acquire')
    expect(data.lease_id).toBe(`lease-${MACHINE}`)
    expect(data.name).toBe(MACHINE)
    expect(data.owner).toBe(PEER_A)
    expect(data.state).toBe('running')
    expect(typeof data.workspacePath).toBe('string')
    expect(data.created_at).toBe(data.createdAt)
    expect(data.expires_at).toBe(data.expiresAt)
    expect(data.retention_until).toBe(data.retentionUntil)
    expect(data.ttl_ms).toBe(data.ttlMs)
    expect(data.max_ttl_ms).toBe(14_400_000)
    expect(data.maxTtlMs).toBe(14_400_000)
    expect(data.retention_until).toBe((data.expires_at as number) + settings.retentionMs)
    const connection = data.connection as Record<string, Json>
    expect(connection.exec_transport).toBe('vm_exec')
    expect(connection.endpoints).toEqual({})
    expect((connection.portal_urls as Record<string, Json>).desktop).toBe(`http://${MACHINE}.orb.local:5901/vnc.html`)
    expect(data.resolved_env).toEqual({})
    const allocated = data.allocated as Record<string, Json>
    expect(allocated.cpu_cores).toBe(4)
    expect(allocated.memory_mb).toBe(8192)
    expect(allocated.disk_gb).toBe(40)
    expect(calls).toContain(`provision ${MACHINE}`)
  })

  test('a legacy meta.data acquire still works and grants the requested window', async () => {
    const settings = config()
    const { vm } = fakeVm()
    const compute = createCompute(settings, { vm: () => vm, log: () => {} })
    const { node, sent } = fakeNode()

    await handleBrokerInbox(node, entryOf({
      to: settings.nodeId,
      data: { operation: 'acquire', name: MACHINE, ttlMs: 900_000, purpose: 'legacy' },
    }), compute, settings)

    const data = dataOf(sent)
    expect(sent[0]?.delivery_kind).toBe('compute-result')
    expect(data.lease_id).toBe(`lease-${MACHINE}`)
    expect(data.purpose).toBe('legacy')
    expect((data.expires_at as number) - (data.created_at as number)).toBe(900_000)
    expect((data.connection as Record<string, Json>).portal_urls).toBeDefined()
  })

  test('top-level fields win over meta.data when both name the same operation', async () => {
    const settings = config()
    const { vm, calls } = fakeVm()
    const compute = createCompute(settings, { vm: () => vm, log: () => {} })
    const { node, sent } = fakeNode()

    await handleBrokerInbox(node, entryOf({
      operation: 'acquire',
      name: MACHINE,
      data: { operation: 'destroy', name: 'omd-compute-other' },
    }), compute, settings)

    expect(calls).toEqual([`provision ${MACHINE}`])
    expect(dataOf(sent).name).toBe(MACHINE)
  })
})

describe('lease ownership', () => {
  test('peer B is refused acquire, renew, release and destroy on peer A\'s lease', async () => {
    const settings = config()
    const { vm, calls } = fakeVm()
    const compute = createCompute(settings, { vm: () => vm, log: () => {} })
    const acquired = fakeNode()
    await handleBrokerInbox(acquired.node, entryOf({
      operation: 'acquire', name: MACHINE, lease: { ttl_ms: 60_000 },
    }), compute, settings)
    const leaseId = dataOf(acquired.sent).lease_id as string

    for (const operation of ['acquire', 'renew', 'release', 'destroy']) {
      const fromB = fakeNode()
      await handleBrokerInbox(fromB.node, entryOf({
        operation,
        name: MACHINE,
        lease_id: leaseId,
        ttl_ms: 60_000,
      }, PEER_B), compute, settings)
      expect(fromB.sent[0]?.delivery_kind).toBe('failed')
      const error = dataOf(fromB.sent).error as Record<string, Json>
      expect(error.code).toBe('forbidden')
      expect(String(error.message)).toContain(PEER_A)
    }

    expect(calls).toEqual([`provision ${MACHINE}`])
    expect(compute.get(leaseId)?.state).toBe('running')
    expect(compute.get(leaseId)?.owner).toBe(PEER_A)
  })

  test('the owner can renew by lease id without re-running acquire, then release and destroy', async () => {
    const settings = config()
    const { vm, calls } = fakeVm()
    const compute = createCompute(settings, { vm: () => vm, log: () => {} })
    const first = fakeNode()
    await handleBrokerInbox(first.node, entryOf({
      operation: 'acquire', name: MACHINE, lease: { ttl_ms: 60_000, max_ttl_ms: 3_600_000 },
    }), compute, settings)
    const leaseId = dataOf(first.sent).lease_id as string
    const firstExpiry = dataOf(first.sent).expires_at as number

    const renewed = fakeNode()
    await handleBrokerInbox(renewed.node, entryOf({
      operation: 'renew', lease_id: leaseId, ttl_ms: 120_000,
    }), compute, settings)
    expect(renewed.sent[0]?.delivery_kind).toBe('compute-result')
    expect(dataOf(renewed.sent).expires_at as number).toBeGreaterThanOrEqual(firstExpiry)
    expect(calls.filter(call => call.startsWith('provision') || call.startsWith('start'))).toEqual([`provision ${MACHINE}`])

    const released = fakeNode()
    await handleBrokerInbox(released.node, entryOf({
      operation: 'release', lease_id: leaseId,
    }), compute, settings)
    expect(released.sent[0]?.delivery_kind).toBe('compute-result')
    expect(dataOf(released.sent).state).toBe('stopped')

    const destroyed = fakeNode()
    await handleBrokerInbox(destroyed.node, entryOf({
      operation: 'destroy', lease_id: leaseId,
    }), compute, settings)
    expect(destroyed.sent[0]?.delivery_kind).toBe('compute-result')
    expect(dataOf(destroyed.sent).destroyed).toBe(true)
    expect(compute.get(MACHINE)).toBeUndefined()
  })

  test('a stopped lease still belongs to its owner', async () => {
    const settings = config()
    const { vm } = fakeVm()
    const compute = createCompute(settings, { vm: () => vm, log: () => {} })
    const lease = await compute.acquire({ name: MACHINE }, PEER_A)
    await compute.release(MACHINE, PEER_A)
    expect(lease.state).toBe('running')

    expect(await codeOf(compute.acquire({ name: MACHINE }, PEER_B))).toBe('forbidden')
    expect(await codeOf(compute.destroy(MACHINE, PEER_B))).toBe('forbidden')
    expect(await compute.acquire({ name: MACHINE }, PEER_A)).toMatchObject({ state: 'running' })
  })
})

describe('capacity ceiling', () => {
  test('ttl_ms above max_ttl_ms answers capacity_exceeded without starting a VM', async () => {
    const settings = config({ maxTtlMs: 60_000 })
    const { vm, calls } = fakeVm()
    const compute = createCompute(settings, { vm: () => vm, log: () => {} })
    const { node, sent } = fakeNode()

    await handleBrokerInbox(node, entryOf({
      operation: 'acquire', name: MACHINE, lease: { ttl_ms: 120_000, max_ttl_ms: 600_000 },
    }), compute, settings)

    expect(sent[0]?.delivery_kind).toBe('failed')
    const error = dataOf(sent).error as Record<string, Json>
    expect(error.code).toBe('capacity_exceeded')
    expect(String(error.message)).toContain('exceeds max_ttl_ms (60000)')
    expect(calls).toEqual([])
    expect(compute.list()).toHaveLength(0)
  })

  test('a ttl_ms within the ceiling is granted exactly, not truncated', async () => {
    const settings = config({ defaultTtlMs: 10_000, maxTtlMs: 3_600_000 })
    const { vm } = fakeVm()
    const compute = createCompute(settings, { vm: () => vm, log: () => {} })

    const lease = await compute.acquire({ name: MACHINE, ttlMs: 1_800_000 }, PEER_A)
    expect(lease.expiresAt - lease.createdAt).toBe(1_800_000)
    expect(lease.maxTtlMs).toBe(3_600_000)
    expect(describeLease(lease, settings.retentionMs).ttl_ms).toBeGreaterThan(1_799_000)
  })

  test('renew refuses a window past the ceiling and a claim that has reached it', async () => {
    const settings = config({ maxTtlMs: 120_000 })
    const { vm, calls } = fakeVm()
    const compute = createCompute(settings, { vm: () => vm, log: () => {} })
    const clock = spyOn(Date, 'now')
    const base = 1_800_000_000_000
    clock.mockReturnValue(base)
    try {
      const lease = await compute.acquire({ name: MACHINE, ttlMs: 60_000 }, PEER_A)

      expect(await codeOf(compute.renew(MACHINE, 180_000, PEER_A))).toBe('capacity_exceeded')
      // A second, legal renewal still works: the first refusal changed nothing.
      const renewed = await compute.renew(`lease-${MACHINE}`, 60_000, PEER_A)
      expect(renewed.expiresAt).toBeGreaterThanOrEqual(lease.expiresAt)
      expect(renewed.lastActivityAt).toBeGreaterThanOrEqual(lease.lastActivityAt)
      expect(calls.filter(call => call.startsWith('provision') || call.startsWith('start'))).toEqual([`provision ${MACHINE}`])

      // The lifetime ceiling counts from the original claim, not from one window.
      clock.mockReturnValue(base + 90_000)
      expect(await codeOf(compute.renew(MACHINE, 60_000, PEER_A))).toBe('capacity_exceeded')
    } finally {
      clock.mockRestore()
    }
  })
})

describe('expiry notification', () => {
  test('sweep stops an expired lease and the notice carries operation expired', async () => {
    const settings = config({ defaultTtlMs: 1_000 })
    const { vm, calls } = fakeVm()
    const notices: Array<{ lease: ComputeLease; reason: ExpiryReason }> = []
    const compute = createCompute(settings, {
      vm: () => vm,
      log: () => {},
      onExpire: (lease, reason) => { notices.push({ lease, reason }) },
    })
    const lease = await compute.acquire({ name: MACHINE }, PEER_A)

    expect(await compute.sweep(lease.expiresAt + 1)).toEqual([MACHINE])
    expect(calls).toContain(`stop ${MACHINE}`)
    expect(notices).toHaveLength(1)
    expect(notices[0]?.reason).toBe('ttl_expired')
    expect(notices[0]?.lease.state).toBe('stopped')

    const { node, sent } = fakeNode()
    await sendExpiry(node, notices[0]!.lease, 'ttl_expired', settings.retentionMs, () => {})
    expect(sent[0]?.meta?.to).toBe(PEER_A)
    const data = dataOf(sent)
    expect(data.operation).toBe('expired')
    expect(data.reason).toBe('ttl_expired')
    expect(data.lease_id).toBe(`lease-${MACHINE}`)
    expect(data.state).toBe('stopped')
  })

  test('sweep distinguishes idle_timeout and max_ttl_reached', async () => {
    const idleSettings = config({ defaultTtlMs: 60_000, idleTimeoutMs: 1_000 })
    const { vm: idleVm } = fakeVm()
    const idleReasons: Array<[string, ExpiryReason]> = []
    const idleCompute = createCompute(idleSettings, {
      vm: () => idleVm,
      log: () => {},
      onExpire: (lease, reason) => { idleReasons.push([lease.name, reason]) },
    })
    // The configured window applies when the request names none.
    const fromConfig = await idleCompute.acquire({ name: 'omd-compute-idle-cfg' }, PEER_A)
    await idleCompute.sweep(fromConfig.createdAt + 1_001)
    expect(idleReasons).toEqual([['omd-compute-idle-cfg', 'idle_timeout']])
    // A request's lease.idle_timeout_ms overrides that window for its own lease.
    const overridden = await idleCompute.acquire({ name: 'omd-compute-idle-req', idleTimeoutMs: 5_000 }, PEER_A)
    await idleCompute.sweep(overridden.createdAt + 1_001)
    expect(idleReasons).toHaveLength(1)
    await idleCompute.sweep(overridden.createdAt + 5_001)
    expect(idleReasons.at(-1)).toEqual(['omd-compute-idle-req', 'idle_timeout'])

    const capSettings = config({ maxTtlMs: 1_000 })
    const { vm: capVm } = fakeVm()
    const capReasons: ExpiryReason[] = []
    const capCompute = createCompute(capSettings, {
      vm: () => capVm,
      log: () => {},
      onExpire: (_lease, reason) => { capReasons.push(reason) },
    })
    const capped = await capCompute.acquire({ name: 'omd-compute-cap', ttlMs: 600 }, PEER_A)
    await capCompute.sweep(capped.createdAt + 1_001)
    expect(capReasons).toEqual(['max_ttl_reached'])
  })

  test('the shipped defaults leave idle reclamation off and cap a lease at 24 h', () => {
    const defaults = Config({})
    expect(defaults.idleTimeoutMs).toBe(0)
    expect(defaults.maxTtlMs).toBe(86_400_000)
    expect(defaults.defaultTtlMs).toBe(21_600_000)
  })

  test('a failed notice does not stop the sweep', async () => {
    const settings = config({ defaultTtlMs: 1_000 })
    const { vm } = fakeVm()
    const logged: string[] = []
    const compute = createCompute(settings, {
      vm: () => vm,
      log: message => logged.push(message),
      onExpire: () => { throw new Error('no transport') },
    })
    const lease = await compute.acquire({ name: MACHINE }, PEER_A)

    expect(await compute.sweep(lease.expiresAt + 1)).toEqual([MACHINE])
    expect(logged.some(line => line.includes('expiry notice'))).toBe(true)
  })

  test('an 8 h task held by ttl/2 heartbeats is not stopped; a dead heartbeat is reclaimed at the ceiling', async () => {
    const settings = config({ defaultTtlMs: 21_600_000, maxTtlMs: 86_400_000, idleTimeoutMs: 0 })
    const { vm, calls } = fakeVm()
    const reasons: ExpiryReason[] = []
    const compute = createCompute(settings, {
      vm: () => vm,
      log: () => {},
      onExpire: (_lease, reason) => { reasons.push(reason) },
    })
    const clock = spyOn(Date, 'now')
    const base = 1_800_000_000_000
    let now = base
    clock.mockImplementation(() => now)
    try {
      await compute.acquire({ name: MACHINE, ttlMs: 3_600_000 }, PEER_A)
      const halfWindow = 1_800_000
      for (let elapsed = halfWindow; elapsed <= 8 * 3_600_000; elapsed += halfWindow) {
        now = base + elapsed
        const renewed = await compute.renew(MACHINE, 3_600_000, PEER_A)
        expect(renewed.state).toBe('running')
        expect(await compute.sweep(now)).toEqual([])
      }
      // Every heartbeat crossed the deployment's old 6 h window without a stop.
      expect(calls.filter(call => call.startsWith('stop'))).toEqual([])

      now = base + 86_400_000
      expect(await compute.sweep(now)).toEqual([MACHINE])
      expect(reasons).toEqual(['max_ttl_reached'])
      expect(calls).toContain(`stop ${MACHINE}`)
    } finally {
      clock.mockRestore()
    }
  })
})

describe('compute:// path', () => {
  test('POST takes the owner from the calling session, not a fixed path identity', async () => {
    const settings = config()
    const { vm } = fakeVm()
    const compute = createCompute(settings, { vm: () => vm, log: () => {} })
    const source = createComputeSource(compute, settings)
    const post = source.post
    expect(post).toBeDefined()

    const fromA = { agent: { session: { id: 'session-a' } } } as unknown as InternalExec
    await post!('', JSON.stringify({ operation: 'acquire', name: MACHINE, ttl_ms: 60_000 }), fromA)
    expect(compute.get(MACHINE)?.owner).toBe('urn:onlyne:agent:session-a')

    // The path reads the same descriptor the Onlyne answer carries.
    const table: unknown = JSON.parse(await source.read('', fromA))
    const document = table as { maxTtlMs: number; idleTimeoutMs: number; leases: Array<Record<string, Json>> }
    expect(document.maxTtlMs).toBe(settings.maxTtlMs)
    expect(document.idleTimeoutMs).toBe(settings.idleTimeoutMs)
    expect(document.leases[0]).toMatchObject({ lease_id: `lease-${MACHINE}`, owner: 'urn:onlyne:agent:session-a' })
    const one: unknown = JSON.parse(await source.read(MACHINE, fromA))
    expect((one as Record<string, Json>).state).toBe('running')

    const fromB = { sessionId: 'session-b' } as unknown as InternalExec
    expect(await codeOf(post!('', JSON.stringify({ operation: 'release', name: MACHINE }), fromB))).toBe('forbidden')
    expect(compute.get(MACHINE)?.state).toBe('running')

    await post!('', JSON.stringify({ operation: 'destroy', name: MACHINE }), fromA)
    expect(compute.get(MACHINE)).toBeUndefined()
  })

  test('status reads a lease by lease_id from either envelope layer', async () => {
    const settings = config()
    const { vm } = fakeVm()
    const compute = createCompute(settings, { vm: () => vm, log: () => {} })
    const acquired = fakeNode()
    await handleBrokerInbox(acquired.node, entryOf({ operation: 'acquire', name: MACHINE }), compute, settings)
    const leaseId = dataOf(acquired.sent).lease_id as string

    const top = fakeNode()
    await handleBrokerInbox(top.node, entryOf({ operation: 'status', lease_id: leaseId }), compute, settings)
    expect(top.sent[0]?.delivery_kind).toBe('compute-result')
    expect((dataOf(top.sent).leases as Json[])[0]).toMatchObject({ lease_id: leaseId, owner: PEER_A })

    const legacy = fakeNode()
    await handleBrokerInbox(legacy.node, entryOf({ data: { operation: 'status' } }), compute, settings)
    expect(legacy.sent[0]?.delivery_kind).toBe('compute-result')
    expect(dataOf(legacy.sent).leases).toHaveLength(1)
  })
})
