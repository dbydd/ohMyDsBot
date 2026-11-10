/**
 * The two wake paths agree on one injection.
 *
 * An admitted inbound entry now reaches the maintenance loop twice: the library's
 * `wakeImmediate` arms a 0 ms timer, and the host's `wakeful` notify schedules its own
 * pass. Both go through `serialize`, so the second pass must observe the entry already
 * injected — not hand the agent the same message again.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyMaterial } from '@onlyne/lib'
import type { Entry, KeyHook, KeyMaterial, NotifyEvent, Runtime } from '@onlyne/lib'
import { createBotNode, type BotNode } from './node.ts'
import { EndpointRegistry } from './registry.ts'

let home: string | undefined
let previousHome: string | undefined
const made: Array<BotNode | string> = []

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'omd-onlyne-wake-'))
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

/** Records every injection and every notification the node emits. */
function recordingRuntime(): { runtime: Runtime; injected: string[]; notified: NotifyEvent[] } {
  const injected: string[] = []
  const notified: NotifyEvent[] = []
  const runtime: Runtime = {
    supports: async () => true,
    inject: async (entry: Entry) => {
      injected.push(entry.message.id)
      return { context: 'test', consumed: true }
    },
    notify: event => { notified.push(event) },
  }
  return { runtime, injected, notified }
}

describe('the wake paths agree on one injection', () => {
  test('a self-admitted message is injected exactly once without a manual pass', async () => {
    const { runtime, injected, notified } = recordingRuntime()
    const bot = await createBotNode({
      nodeId: 'urn:onlyne:agent:wake-a',
      keys: keyHook(),
      registry: new EndpointRegistry(),
      network: { port: 0 },
      runtime,
    })
    made.push(bot)

    const outcome = await bot.node.client.msg({
      delivery_kind: 'request',
      msg: 'wake once',
      meta: { to: bot.nodeId },
    }) as { admission: string }
    expect(outcome.admission).toBe('accepted')

    // No host call beyond the admission itself: the wakeImmediate timer and the
    // inbound-notify pass must deliver on their own. The pass runs on the node's
    // maintenance timer and exposes no completion promise, so the wait polls the
    // runtime's own record until the injection lands.
    const deadline = Date.now() + 1_000
    while (injected.length === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(injected.length).toBe(1)

    // The active cadence pass fires two seconds after the wake; the node exposes no
    // way to force it synchronously, so the wait rides the real timer to prove that
    // the scheduled pass observes the entry already injected.
    await Bun.sleep(2_300)
    expect(injected.length).toBe(1)
    expect(notified.some(event => event.event === 'inbound')).toBe(true)
  }, 10_000)
})
