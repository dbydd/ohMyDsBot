/**
 * Two nodes, two listeners, one loopback round trip.
 *
 * Each node joins a registry of its own, so neither is reachable in-process:
 * every message and every trust handshake has to cross the loopback listener.
 * That is the path a peer on another machine takes, minus the network.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { generateKeyMaterial } from '@onlyne/lib'
import type { KeyHook, KeyMaterial, NodeId } from '@onlyne/lib'
import { createBotNode, type BotNode } from './node.ts'
import { EndpointRegistry } from './registry.ts'

const made: Array<BotNode | string> = []

// Every node now defaults to a durable store under the dsh data root. A test process must
// not write into the operator's real `~/.dsh`, so the file gets a root of its own.
let home: string | undefined
let previousHome: string | undefined

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'omd-onlyne-network-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})

afterAll(async () => {
  for (const item of made.reverse()) {
    if (typeof item === 'string') rmSync(item, { recursive: true, force: true })
    else await item.dispose()
  }
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

function keyHook(): KeyHook {
  const material: KeyMaterial = generateKeyMaterial()
  const hook = (): Promise<KeyMaterial> => Promise.resolve(material)
  hook.replace = async next => { void next }
  return hook
}

async function node(nodeId: NodeId): Promise<BotNode> {
  const created = await createBotNode({
    nodeId,
    keys: keyHook(),
    registry: new EndpointRegistry(),
    network: { port: 0 },
    // A registry of its own marks this node as a stranger; a socket of its own keeps the
    // loopback path a real round trip instead of a shared-listener dispatch.
    dedicatedPort: true,
  })
  made.push(created)
  return created
}

/** Both sides observe each other's published description before pairing. */
async function observeEachOther(a: BotNode, b: BotNode): Promise<void> {
  await a.node.discovery.observe(b.baseUrl, 'smoke', b.nodeId)
  await b.node.discovery.observe(a.baseUrl, 'smoke', a.nodeId)
}

/** The first exchange: A approves B, then B approves A, which now knows both approvals. */
async function pair(a: BotNode, b: BotNode): Promise<void> {
  await observeEachOther(a, b)
  const fromA = await a.node.trust.begin(a.node.auth, b.nodeId)
  await fromA.confirm(fromA.fingerprint)
  const fromB = await b.node.trust.begin(b.node.auth, a.nodeId)
  await fromB.confirm(fromB.fingerprint)
}

describe('two nodes over loopback HTTP', () => {
  test('pair, then deliver a signed message', async () => {
    const a = await node('urn:onlyne:agent:smoke-a')
    const b = await node('urn:onlyne:agent:smoke-b')
    expect(a.baseUrl).not.toBe(b.baseUrl)
    expect(a.fingerprint).not.toBe(b.fingerprint)

    await pair(a, b)
    expect((await a.node.trust.entry(b.nodeId))?.state).toBe('trusted')
    expect((await b.node.trust.entry(a.nodeId))?.state).toBe('trusted')

    const outcome = await a.node.client.msg({
      delivery_kind: 'request',
      msg: 'hello over the wire',
      meta: { to: b.nodeId },
    }) as { admission: string }
    expect(outcome.admission).toBe('accepted')

    // The sender owns the thread it started, so the receiver's inbox is filled
    // by its own reconcile pass rather than by the push alone.
    const inbox = await b.node.client.reconcile()
    expect(inbox.items.map(row => row.attention.entry?.message.msg)).toContain('hello over the wire')
  }, 20_000)

  test('a request without a node signature is refused', async () => {
    const b = await node('urn:onlyne:agent:smoke-c')
    const response = await fetch(`${b.baseUrl}/trust`, { headers: { 'onlyne-actor': 'urn:onlyne:agent:smoke-a' } })
    expect(response.status).toBe(401)
    expect((await response.json() as { error?: { code?: string } }).error?.code).toBe('unauthenticated')
  }, 20_000)

  test('the key file derives its own public key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'omd-onlyne-keys-'))
    made.push(home)
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const material = await import('./keys.ts').then(module => module.processKeyHook()())
      const jwk = createPublicKey(createPrivateKey({ key: Buffer.from(material.private_key), format: 'der', type: 'pkcs8' })).export({ format: 'jwk' })
      expect(Buffer.from(material.public_key).toString('base64url')).toBe(String(jwk.x))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  }, 20_000)
})

describe('two nodes in one process', () => {
  test('the shared registry pairs them before the first send and delivers in-process', async () => {
    // Same key, same registry: the production shape, where one process owns
    // several bot sessions. The transport still signs, and the seeds the
    // registry publishes settle the handshake in one round.
    const home = mkdtempSync(join(tmpdir(), 'omd-onlyne-shared-'))
    made.push(home)
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const registry = new EndpointRegistry()
      const a = await createBotNode({ nodeId: 'urn:onlyne:agent:pair-a', registry })
      const b = await createBotNode({ nodeId: 'urn:onlyne:agent:pair-b', registry })
      made.push(a, b)

      // The host pairs a co-hosted peer itself: the library refuses a send that names an
      // unpaired peer before the transport's own pairing runs.
      await a.ensurePaired(b.nodeId)
      const outcome = await a.node.client.msg({
        delivery_kind: 'request',
        msg: 'hello in process',
        meta: { to: b.nodeId },
      }) as { admission: string }
      expect(outcome.admission).toBe('accepted')
      expect((await b.node.trust.entry(a.nodeId))?.state).toBe('trusted')
      const inbox = await b.node.client.reconcile()
      expect(inbox.items.map(row => row.attention.entry?.message.msg)).toContain('hello in process')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await Promise.all(made.splice(0).map(item => typeof item === 'string' ? undefined : item.dispose()))
    }
  }, 20_000)
})
