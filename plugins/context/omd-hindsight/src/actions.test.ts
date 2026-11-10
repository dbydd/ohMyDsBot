/**
 * POST action boundary: the judgment gate is explicit, a stale revision fails
 * visibly, and a queue replay goes through the same policy guard as the tool.
 */

import { describe, expect, it } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, resolveProjectConfig } from './config.ts'
import { ActionError, postPluginAction, type ActionHost } from './actions.ts'
import { HindsightHttpClient } from './core/client.ts'
import { ProjectConfigStore } from './project-config.ts'
import { HindsightRuntime } from './runtime.ts'

const resolved = resolveConfig({
  baseUrl: 'http://localhost:8888',
  banks: {
    coding: { description: 'Engineering notes and decisions', access: 'read-write', retain: 'auto' },
  },
  defaultBank: 'coding',
})

async function projectDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'omd-hindsight-action-'))
}

function host(options: Partial<ActionHost> & { readonly store: ProjectConfigStore; readonly cwd: string; readonly runtime: HindsightRuntime }): ActionHost {
  const { store, cwd, runtime, ...rest } = options
  return {
    base: resolved,
    bankIds: resolved.bankIds,
    effectiveFor: async () => resolved,
    runtimeFor: () => runtime,
    projectCwd: () => cwd,
    judgment: () => undefined,
    judgmentLabel: () => 'omd-judgment is not mounted in this profile',
    isReadonly: () => false,
    store,
    ...rest,
  }
}

describe('plugin POST actions', () => {
  it('fails a write explicitly when no judgment service is available', async () => {
    const cwd = await projectDir()
    const store = new ProjectConfigStore(join(cwd, 'store'))
    const runtime = new HindsightRuntime({ config: resolved.core, cwd })
    await expect(postPluginAction(
      'plugin/project-config',
      JSON.stringify({ intent: 'Update Hindsight project settings', expectedRevision: 0, values: { recallMaxItems: 4 } }),
      { cwd },
      host({ store, cwd, runtime }),
    )).rejects.toMatchObject({ status: 503 })
  })

  it('refuses a declined intent and leaves the stored document untouched', async () => {
    const cwd = await projectDir()
    const store = new ProjectConfigStore(join(cwd, 'store'))
    const runtime = new HindsightRuntime({ config: resolved.core, cwd })
    const declining: ActionHost = host({
      store,
      cwd,
      runtime,
      judgment: () => ({
        label: 'mock',
        port: async () => ({
          action_decision: { type: 'choice', choice: 'decline', confidence: 0.9, probabilities: {} },
        }),
      }),
    })
    await expect(postPluginAction(
      'plugin/project-config',
      JSON.stringify({ intent: 'Update Hindsight project settings', expectedRevision: 0, values: { recallMaxItems: 4 } }),
      { cwd },
      declining,
    )).rejects.toBeInstanceOf(ActionError)
    expect((await store.read(cwd)).revision).toBe(0)
  })

  it('reports a stale revision as a conflict through the action', async () => {
    const cwd = await projectDir()
    const store = new ProjectConfigStore(join(cwd, 'store'))
    const runtime = new HindsightRuntime({ config: resolved.core, cwd })
    const accepting: ActionHost = host({
      store,
      cwd,
      runtime,
      judgment: () => ({
        label: 'mock',
        port: async () => ({
          action_decision: { type: 'choice', choice: 'proceed', confidence: 0.9, probabilities: {} },
        }),
      }),
    })
    const body = (revision: number) => JSON.stringify({
      intent: 'Update Hindsight project settings',
      expectedRevision: revision,
      values: { recallMaxItems: 6 },
    })
    const first = JSON.parse(await postPluginAction('plugin/project-config', body(0), { cwd }, accepting))
    expect(first).toMatchObject({ ok: true, revision: 1 })
    await expect(postPluginAction('plugin/project-config', body(0), { cwd }, accepting))
      .rejects.toMatchObject({ status: 409 })
    expect((await store.read(cwd)).hindsight.recallMaxItems).toBe(6)
  })

  it('saves reference console settings without removing earlier project overrides', async () => {
    const cwd = await projectDir()
    const store = new ProjectConfigStore(join(cwd, 'store'))
    const runtime = new HindsightRuntime({ config: resolved.core, cwd })
    await store.write(cwd, 0, { recallMaxItems: 4 })
    const accepting = host({
      store, cwd, runtime,
      effectiveFor: async () => resolveProjectConfig({
        banks: { coding: { description: 'Engineering notes and decisions' } },
      }, (await store.read(cwd)).hindsight),
      judgment: () => ({
        label: 'test boundary',
        port: async () => ({ action_decision: { type: 'choice', choice: 'proceed', confidence: 1, probabilities: {} } }),
      }),
    })
    const result = JSON.parse(await postPluginAction('plugin/project-config', JSON.stringify({
      intent: 'Update Hindsight project settings', expectedRevision: 1,
      values: { baseUrl: 'http://127.0.0.1:8899', recallBudget: 'high', recallDebounceTurns: 2, recallInjectJudge: false },
    }), { cwd }, accepting))
    expect(result.effective).toMatchObject({
      baseUrl: 'http://127.0.0.1:8899', recallBudget: 'high', recallDebounceTurns: 2,
      recallInjectJudge: false, recallMaxItems: 4,
    })
    expect((await store.read(cwd)).hindsight).toEqual(result.values)
    await expect(postPluginAction('plugin/project-config', JSON.stringify({
      intent: 'Update Hindsight project settings', expectedRevision: 2, values: { recallBudget: 'unbounded' },
    }), { cwd }, accepting)).rejects.toMatchObject({ status: 400 })
    expect((await store.read(cwd)).revision).toBe(2)
  })

  it('replays through the action boundary with the queue policy and refuses a read-only caller', async () => {
    const cwd = await projectDir()
    const store = new ProjectConfigStore(join(cwd, 'store'))
    const runtime = new HindsightRuntime({ config: resolved.core, cwd })
    const retained: string[] = []
    runtime.client = Object.assign(runtime.client, {
      async retain(bank: string) {
        retained.push(bank)
        return { operation_id: 'op-1' }
      },
    })
    const entry = await runtime.queue.enqueue('coding', { content: 'a fact' })
    const accepting: ActionHost = host({
      store,
      cwd,
      runtime,
      judgment: () => ({
        label: 'mock',
        port: async () => ({
          action_decision: { type: 'choice', choice: 'proceed', confidence: 0.9, probabilities: {} },
        }),
      }),
    })

    const report = JSON.parse(await postPluginAction(
      'plugin/queue',
      JSON.stringify({ intent: 'Retry queued Hindsight memory writes', action: 'retry' }),
      { cwd, origin: 'human' },
      accepting,
    ))
    expect(report.sent).toEqual([entry.id])
    expect(retained).toEqual(['coding'])

    await expect(postPluginAction(
      'plugin/queue',
      JSON.stringify({ intent: 'Retry queued Hindsight memory writes', action: 'retry' }),
      { cwd, origin: 'model', agent: { session: { header: { origin: 'subagent' } } } as never },
      { ...accepting, isReadonly: () => true },
    )).rejects.toMatchObject({ status: 403 })
  })
})
