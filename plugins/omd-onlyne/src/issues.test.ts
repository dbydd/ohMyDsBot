/**
 * Regression cover for the three 2026-11-07 DSH issues.
 *
 * Each `describe` mirrors one issue's acceptance criteria: honest delivery capabilities with
 * an immediate wake-up, one stable identity on one listener with a durable store, and
 * process-level `onlyne://` reads with a neighbor directory.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TrustService, generateKeyMaterial, MemoryStorage } from '@onlyne/lib'
import type { Auth, DeliveryPlan, Entry, KeyHook, KeyMaterial, NodeId, Runtime, ThreadRef, TrustEntry } from '@onlyne/lib'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { InternalExec, InternalSource } from 'omd-internal-paths'
import { createBotNode, type BotNode } from './node.ts'
import { createRuntime } from './index.ts'
import { NodeTable } from './nodes.ts'
import { EndpointRegistry } from './registry.ts'
import { onlyneSource } from './reads.ts'

const live: BotNode[] = []
const homes: string[] = []
let home: string
let previousHome: string | undefined

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'omd-onlyne-issues-'))
  homes.push(home)
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})

afterAll(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const path of homes) rmSync(path, { recursive: true, force: true })
})

afterEach(async () => {
  for (const node of live.splice(0).reverse()) await node.dispose().catch(() => undefined)
})

/** One fresh identity key: a peer of the process key is a real exchange, not a shared secret. */
function keyHook(): KeyHook {
  const material: KeyMaterial = generateKeyMaterial()
  const hook = (): Promise<KeyMaterial> => Promise.resolve(material)
  hook.replace = async () => {}
  return hook
}

/** A host conversation, as much of an `Agent` as delivery touches. */
function agentFor(sessionId: string): Agent {
  return {
    session: { id: sessionId },
    status: 'idle',
    steer: () => {},
    followup: () => {},
  } as unknown as Agent
}

/** A host runtime that claims every capability, for the peer that is not the DSH side. */
function permissive(): Runtime {
  return {
    supports: async () => true,
    async inject(): Promise<{ context: string; consumed: boolean; outcome: 'queued' }> {
      return { context: 'peer', consumed: true, outcome: 'queued' }
    },
    notify: () => {},
  }
}

async function bot(options: Parameters<typeof createBotNode>[0]): Promise<BotNode> {
  const node = await createBotNode(options)
  live.push(node)
  return node
}

/** Both sides observe each other's description, then approve both halves of the exchange. */
async function pair(left: BotNode, right: BotNode): Promise<void> {
  await left.node.discovery.observe(right.baseUrl, 'test', right.nodeId)
  await right.node.discovery.observe(left.baseUrl, 'test', left.nodeId)
  const fromLeft = await left.node.trust.begin(left.node.auth, right.nodeId)
  await fromLeft.confirm(fromLeft.fingerprint)
  const fromRight = await right.node.trust.begin(right.node.auth, left.nodeId)
  await fromRight.confirm(fromRight.fingerprint)
}

/** Poll a condition until it holds or the budget runs out. */
async function until(condition: () => boolean | Promise<boolean>, budgetMs = 3_000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await Bun.sleep(20)
  }
  throw new Error(`condition did not hold within ${String(budgetMs)} ms`)
}

/** A port no listener holds right now; a test needs it to pin two deployments in one process. */
function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = server.port
  server.stop(true)
  return port
}

function message(sender: NodeId, text: string, thread?: ThreadRef): { id: string; sender: NodeId; delivery_kind: string; msg: string; meta?: { thread: ThreadRef } } {
  return {
    id: crypto.randomUUID(),
    sender,
    delivery_kind: 'note',
    msg: text,
    ...(thread === undefined ? {} : { meta: { thread } }),
  }
}

/** The source's POST, asserted present: every deployment of this plugin registers one. */
function postOf(source: InternalSource): NonNullable<InternalSource['post']> {
  const post = source.post
  if (post === undefined) throw new Error('the onlyne source must accept POST')
  return post
}

/** A read of one record, parsed: the source answers text for every `onlyne://` path. */
async function readJson<T>(source: InternalSource, path: string, exec: InternalExec): Promise<T> {
  const value = await source.read(path, exec)
  if (typeof value !== 'string') throw new Error(`onlyne://${path} did not answer with text`)
  return JSON.parse(value) as T
}

describe('capability honesty and inbound wake-up', () => {
  test('the host runtime refuses await and new-context plans', async () => {
    const runtime = createRuntime(new NodeTable(), 'urn:onlyne:agent:caps')
    const plan = (response: DeliveryPlan['response'], execution: DeliveryPlan['execution']): DeliveryPlan => ({ response, execution })
    expect(await runtime.supports(plan('await', 'existing'))).toBe(false)
    expect(await runtime.supports(plan('async', 'new'))).toBe(false)
    expect(await runtime.supports(plan('async', 'existing'))).toBe(true)
  }, 20_000)

  test('an external await is refused before anything is stored', async () => {
    const table = new NodeTable()
    const dshId = 'urn:onlyne:agent:dsh-await'
    const delivered: Entry[] = []
    const base = createRuntime(table, dshId)
    const runtime: Runtime = {
      ...base,
      async inject(entry, context, plan) {
        delivered.push(entry)
        return base.inject(entry, context, plan)
      },
    }
    const dsh = await bot({ nodeId: dshId, storage: new MemoryStorage(), dedicatedPort: true, runtime })
    table.bind('session-await', agentFor('session-await'), dshId, () => Promise.resolve(dsh))

    const external = await bot({
      nodeId: 'urn:onlyne:agent:ext-await',
      storage: new MemoryStorage(),
      dedicatedPort: true,
      registry: new EndpointRegistry(),
      keys: keyHook(),
      runtime: permissive(),
    })
    await pair(dsh, external)

    // A thread the DSH node owns, so the reply is admitted there rather than stored locally.
    const kickoff = await dsh.node.client.send(external.nodeId, message(dshId, 'kickoff'), {
      response: 'async',
      execution: 'existing',
    })
    const thread = kickoff.receipt?.thread_ref
    expect(thread?.owner).toBe(dshId)
    await external.node.client.reconcile()

    const outcome = await external.node.client.send(dshId, message(external.nodeId, 'needs an answer', thread), {
      response: 'await',
      execution: 'existing',
    })
    expect(outcome.admission).toBe('refused')
    expect(outcome.error?.code).toBe('unsupported_delivery')
    expect(delivered).toHaveLength(0)
    const inbox = await dsh.node.messages.inbox(dsh.node.auth, { page_size: 50 })
    expect(inbox.items).toHaveLength(0)
  }, 30_000)

  test('an HTTP inbound entry reaches the agent in under 200 ms', async () => {
    const table = new NodeTable()
    const dshId = 'urn:onlyne:agent:dsh-wake'
    const arrivals: Array<{ msg: string; at: number }> = []
    const events: string[] = []
    const base = createRuntime(table, dshId)
    const runtime: Runtime = {
      ...base,
      async inject(entry, context) {
        arrivals.push({ msg: entry.message.msg, at: performance.now() })
        return { context: context ?? 'session-wake', consumed: true, outcome: 'queued' }
      },
      notify: event => { events.push(event.event) },
    }
    const dsh = await bot({ nodeId: dshId, storage: new MemoryStorage(), dedicatedPort: true, runtime })
    table.bind('session-wake', agentFor('session-wake'), dshId, () => Promise.resolve(dsh))

    const external = await bot({
      nodeId: 'urn:onlyne:agent:ext-wake',
      storage: new MemoryStorage(),
      dedicatedPort: true,
      registry: new EndpointRegistry(),
      keys: keyHook(),
      runtime: permissive(),
    })
    await pair(dsh, external)
    const kickoff = await dsh.node.client.send(external.nodeId, message(dshId, 'kickoff'), {
      response: 'async',
      execution: 'existing',
    })
    const thread = kickoff.receipt?.thread_ref
    expect(thread).toBeDefined()
    await external.node.client.reconcile()
    // Let the loop settle to its idle cadence: what is measured below is the wake-up, not a
    // pass that happened to be armed anyway.
    await until(async () => !(await dsh.node.client.hasPendingWork()), 5_000)

    const samples: number[] = []
    for (let index = 0; index < 3; index++) {
      const text = `http inbound ${String(index)}`
      const started = performance.now()
      const admitted = await external.node.client.send(dshId, message(external.nodeId, text, thread), {
        response: 'async',
        execution: 'existing',
      })
      expect(admitted.admission).toBe('accepted')
      await until(() => arrivals.some(row => row.msg === text), 5_000)
      samples.push(performance.now() - started)
    }
    const max = Math.max(...samples)
    expect(max).toBeLessThan(200)
    expect(events).toContain('inbound')
  }, 40_000)
})

describe('stable identity, one listener, durable store', () => {
  test('fifty nodes of one process share a port and pair on demand only', async () => {
    const original = TrustService.prototype.request
    let handshakes = 0
    TrustService.prototype.request = async function (auth: Auth, node: NodeId, fingerprint: string): Promise<TrustEntry> {
      handshakes += 1
      return original.call(this, auth, node, fingerprint)
    }
    try {
      const nodes: BotNode[] = []
      for (let index = 0; index < 50; index++) {
        nodes.push(await bot({ nodeId: `urn:onlyne:agent:many-${String(index)}`, storage: new MemoryStorage() }))
      }
      expect(new Set(nodes.map(node => node.listener.port)).size).toBe(1)
      // Creating a node may not pair it with every sibling: that was the O(n^2) startup.
      expect(handshakes).toBe(0)
      const first = nodes[0]
      const second = nodes[1]
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      // The host pairs a co-hosted peer before the first send; that exchange is the only one.
      await first!.ensurePaired(second!.nodeId)
      expect(handshakes).toBe(1)
      const outcome = await first!.node.client.msg({
        delivery_kind: 'note',
        msg: 'hello',
        meta: { to: second!.nodeId },
      }) as { admission: string }
      expect(outcome.admission).toBe('accepted')
      // Exactly the one pair this send needed, no full mesh, and no repeat for the send.
      expect(handshakes).toBe(1)
    } finally {
      TrustService.prototype.request = original
    }
  }, 60_000)

  test('a fixed port serves a second node instead of EADDRINUSE', async () => {
    const port = freePort()
    const first = await bot({ nodeId: 'urn:onlyne:agent:fixed-a', storage: new MemoryStorage(), network: { port } })
    const second = await bot({ nodeId: 'urn:onlyne:agent:fixed-b', storage: new MemoryStorage(), network: { port } })
    expect(first.listener.port).toBe(port)
    expect(second.listener.port).toBe(port)
    expect(first.baseUrl).not.toBe(second.baseUrl)
  }, 30_000)

  test('two sessions of one identity are addressed by plan context, not by a second node', async () => {
    const nodeId = 'urn:onlyne:agent:contexts'
    const table = new NodeTable()
    const contexts: string[] = []
    const base = createRuntime(table, nodeId)
    const runtime: Runtime = {
      ...base,
      async inject(_entry, context) {
        contexts.push(String(context))
        return { context: String(context), consumed: true, outcome: 'queued' }
      },
    }
    const node = await bot({ nodeId, storage: new MemoryStorage(), dedicatedPort: true, runtime })
    table.bind('session-a', agentFor('session-a'), nodeId, () => Promise.resolve(node))
    table.bind('session-b', agentFor('session-b'), nodeId, () => Promise.resolve(node))
    const outcome = await node.node.client.msg({
      delivery_kind: 'note',
      msg: 'for the second session',
      meta: { to: nodeId, context: 'session-b' },
    }) as { admission: string }
    expect(outcome.admission).toBe('accepted')
    await until(() => contexts.includes('session-b'), 5_000)
    expect(contexts).toEqual(['session-b'])
  }, 30_000)

  test('a restart keeps the address, the trust row and the thread', async () => {
    const own = mkdtempSync(join(tmpdir(), 'omd-onlyne-restart-'))
    homes.push(own)
    process.env.DSH_HOME = own
    const dshId = 'urn:onlyne:agent:dsh-restart'
    const arrivals: string[] = []
    const runtime = (): Runtime => ({
      supports: async plan => plan.response !== 'await' && plan.execution !== 'new',
      async inject(entry, context) {
        arrivals.push(entry.message.msg)
        return { context: context ?? 'restart', consumed: true, outcome: 'queued' }
      },
      notify: () => {},
    })
    let first: BotNode | undefined
    let second: BotNode | undefined
    let external: BotNode | undefined
    try {
      first = await createBotNode({ nodeId: dshId, runtime: runtime() })
      external = await createBotNode({
        nodeId: 'urn:onlyne:agent:ext-restart',
        storage: new MemoryStorage(),
        dedicatedPort: true,
        registry: new EndpointRegistry(),
        keys: keyHook(),
        runtime: permissive(),
      })
      await pair(first, external)
      const kickoff = await first.node.client.send(external.nodeId, message(dshId, 'kickoff'), {
        response: 'async',
        execution: 'existing',
      })
      const thread = kickoff.receipt?.thread_ref
      expect(thread).toBeDefined()
      await external.node.client.reconcile()
      const address = first.baseUrl
      await first.dispose()

      second = await createBotNode({ nodeId: dshId, runtime: runtime() })
      expect(second.nodeId).toBe(dshId)
      expect(second.baseUrl).toBe(address)
      expect((await second.node.trust.entry(external.nodeId))?.state).toBe('trusted')

      // No second exchange: the peer's stored row and the same address carry the thread on.
      const reply = await external.node.client.send(dshId, message(external.nodeId, 'after restart', thread), {
        response: 'async',
        execution: 'existing',
      })
      expect(reply.admission).toBe('accepted')
      await until(() => arrivals.includes('after restart'), 5_000)
    } finally {
      await second?.dispose().catch(() => undefined)
      await first?.dispose().catch(() => undefined)
      await external?.dispose().catch(() => undefined)
      process.env.DSH_HOME = home
    }
  }, 40_000)

  test('a configured seed lets the node send first, with no peer handshake', async () => {
    const own = mkdtempSync(join(tmpdir(), 'omd-onlyne-seed-'))
    homes.push(own)
    process.env.DSH_HOME = own
    const dshId = 'urn:onlyne:agent:dsh-seed'
    const extId = 'urn:onlyne:agent:ext-seed'
    const dshPort = freePort()
    const extPort = freePort()
    let probe: BotNode | undefined
    let dsh: BotNode | undefined
    let external: BotNode | undefined
    try {
      // The identity key is the process key, so one fingerprint names both deployments; the
      // probe learns it before either side is configured with the other's address.
      probe = await createBotNode({ nodeId: dshId, network: { port: dshPort }, storage: new MemoryStorage() })
      const fingerprint = probe.fingerprint
      const dshAddress = probe.baseUrl
      await probe.dispose()

      external = await createBotNode({
        nodeId: extId,
        network: { port: extPort },
        storage: new MemoryStorage(),
        seeds: [{ nodeId: dshId, baseUrl: dshAddress, fingerprint }],
      })
      dsh = await bot({
        nodeId: dshId,
        network: { port: dshPort },
        storage: new MemoryStorage(),
        seeds: [{ nodeId: extId, baseUrl: external.baseUrl, fingerprint }],
      })

      await dsh.node.trust.request(dsh.node.auth, extId, fingerprint)
      expect((await dsh.node.trust.entry(extId))?.state).toBe('trusted')
      expect((await external.node.trust.entry(dshId))?.state).toBe('trusted')

      const outcome = await dsh.node.client.msg({
        delivery_kind: 'note',
        msg: 'first contact from the dsh side',
        meta: { to: extId },
      }) as { admission: string }
      expect(outcome.admission).toBe('accepted')
      await external.node.client.reconcile()
      const joined = await external.node.client.joinedThreads({ page_size: 10 })
      expect(joined.items.length).toBeGreaterThan(0)
    } finally {
      await dsh?.dispose().catch(() => undefined)
      await probe?.dispose().catch(() => undefined)
      await external?.dispose().catch(() => undefined)
      process.env.DSH_HOME = home
    }
  }, 40_000)
})

describe('process-level onlyne:// reads', () => {
  async function world(): Promise<{ dsh: BotNode; external: BotNode; source: ReturnType<typeof onlyneSource>; table: NodeTable }> {
    const dshId = 'urn:onlyne:agent:dsh-reads'
    const table = new NodeTable()
    const dsh = await bot({
      nodeId: dshId,
      storage: new MemoryStorage(),
      dedicatedPort: true,
      runtime: permissive(),
    })
    table.bind('session-reads', agentFor('session-reads'), dshId, () => Promise.resolve(dsh))
    const external = await bot({
      nodeId: 'urn:onlyne:agent:ext-reads',
      storage: new MemoryStorage(),
      dedicatedPort: true,
      registry: new EndpointRegistry(),
      keys: keyHook(),
      runtime: permissive(),
    })
    await pair(dsh, external)
    // A third node is the "configured seed" tier: its address is listed without being paired.
    const seeded = await bot({
      nodeId: 'urn:onlyne:agent:seed-reads',
      storage: new MemoryStorage(),
      dedicatedPort: true,
      registry: new EndpointRegistry(),
      keys: keyHook(),
      runtime: permissive(),
    })
    const source = onlyneSource({
      threadPageSize: 50,
      seeds: [{ nodeId: seeded.nodeId, baseUrl: seeded.baseUrl, label: 'seed' }],
    }, table)
    return { dsh, external, source, table }
  }

  test('a read in a session that hosts no node falls back to the process node', async () => {
    const { dsh, source } = await world()
    const body = await readJson<{ node: string }>(source, 'threads', { sessionId: 'ghost-session' })
    expect(body.node).toBe(dsh.nodeId)
    const inbox = await readJson<{ node: string }>(source, 'inbox', {})
    expect(inbox.node).toBe(dsh.nodeId)
  }, 30_000)

  test('neighbors list a trusted cross-process peer, and msg scope agrees', async () => {
    const { dsh, external, source } = await world()
    const body = await readJson<{
      node: string
      neighbors: Array<{ nodeId: string; state: string; sources: string[] }>
    }>(source, 'neighbors', { sessionId: 'session-reads' })
    expect(body.node).toBe(dsh.nodeId)
    const peer = body.neighbors.find(row => row.nodeId === external.nodeId)
    expect(peer?.state).toBe('trusted')
    expect(peer?.sources).toContain('trust')

    const viaMsg = await dsh.node.client.msg({
      delivery_kind: 'read',
      msg: '',
      meta: { scope: 'neighbors' },
    }) as Array<{ nodeId: string }>
    expect(viaMsg.map(row => row.nodeId)).toContain(external.nodeId)
  }, 30_000)

  test('directory merges local, trusted and discovered rows with their source', async () => {
    const { dsh, external, source } = await world()
    const body = await readJson<{
      self: string
      nodes: Array<{ nodeId: string; source: string }>
    }>(source, 'directory', { sessionId: 'session-reads' })
    expect(body.self).toBe(dsh.nodeId)
    const sourceOf = (nodeId: string): string | undefined => body.nodes.find(row => row.nodeId === nodeId)?.source
    expect(sourceOf(dsh.nodeId)).toBe('local')
    expect(sourceOf(external.nodeId)).toBe('trusted')
    expect(sourceOf('urn:onlyne:agent:seed-reads')).toBe('discovered')
  }, 30_000)

  test('a POST without an explicit sender is refused and names the sessions', async () => {
    const { dsh, source } = await world()
    const body = JSON.stringify({ delivery_kind: 'note', msg: 'human interruption', meta: { to: dsh.nodeId } })
    const post = postOf(source)
    await expect(post('threads', body, {})).rejects.toThrow(/needs a sender/u)
    await expect(post('threads', body, {})).rejects.toThrow(/session-reads/u)
  }, 30_000)

  test('a POST acts for the session it names, and for meta.from', async () => {
    const { dsh, source } = await world()
    const post = postOf(source)
    const bySession = JSON.parse(await post('threads', JSON.stringify({
      delivery_kind: 'note',
      msg: 'from the session',
      meta: { to: dsh.nodeId },
    }), { sessionId: 'session-reads' })) as { admission: string }
    expect(bySession.admission).toBe('accepted')

    const byNode = JSON.parse(await post('threads', JSON.stringify({
      delivery_kind: 'note',
      msg: 'from the node',
      meta: { to: dsh.nodeId, from: dsh.nodeId },
    }), {})) as { admission: string }
    expect(byNode.admission).toBe('accepted')
  }, 30_000)

  test('the runner catalog answers workers and one worker by its address', async () => {
    const { source } = await world()
    const catalog = (globalThis as { __onlyneRunnerCatalog?: unknown }).__onlyneRunnerCatalog
    const rows = [{
      worker: 'onlyne://runner/issue/worker-1',
      workerId: 'worker-1',
      jobId: 'job-1',
      machine: 'sandbox-1',
      state: 'running',
      startedAt: '2026-11-07T00:00:00.000Z',
      workUnit: 'issue:1',
      session: 'session-1',
    }]
    ;(globalThis as { __onlyneRunnerCatalog?: unknown }).__onlyneRunnerCatalog = {
      workers: () => rows,
      readEvents: async (worker: string) => worker === 'onlyne://runner/issue/worker-1'
        ? {
            kind: 'feed',
            value: {
              worker,
              state: 'running',
              events: [{
                at: 1_000,
                kind: 'tool',
                role: 'assistant',
                text: null,
                tool: 'bash',
                args: '{"command":"ls"}',
                result: null,
              }],
              truncated: false,
            },
          }
        : { kind: 'missing', reason: `${worker} names no worker this process created` },
    }
    try {
      const workers = await readJson<{ workers: unknown[] }>(source, 'runner/workers', {})
      expect(workers.workers).toHaveLength(1)
      const one = await readJson<{ worker: { workerId: string } }>(source, 'runner/issue/worker-1', {})
      expect(one.worker.workerId).toBe('worker-1')
      const feed = await readJson<{ events: Array<{ kind: string; tool: string }>; truncated: boolean }>(
        source, 'runner/issue/worker-1/events', {},
      )
      expect(feed.events.map(event => event.tool)).toEqual(['bash'])
      expect(feed.truncated).toBe(false)
      // A worker whose session cannot be read is a refusal, not an empty feed.
      await expect(source.read('runner/issue/worker-2/events', {})).rejects.toThrow(/names no worker/u)
    } finally {
      ;(globalThis as { __onlyneRunnerCatalog?: unknown }).__onlyneRunnerCatalog = catalog
    }
  }, 30_000)
})
