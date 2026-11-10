/**
 * Regressions for the automatic recall lifecycle, the no-judge recall path, the
 * JSON resources and the queue/config write boundaries.
 *
 * The lifecycle block drives a real Cordis context and its `agent/pre-step`
 * waterfall, so the assertions are about what actually enters the step and what
 * the session would log, not about a builder's intermediate value.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { resolveConfig, type ResolvedConfig } from './config.ts'
import { HindsightHttpClient } from './core/client.ts'
import type { HindsightConfig } from './core/types.ts'
import { registerLifecycle } from './lifecycle.ts'
import { createPathReader } from './paths.ts'
import { ProjectConfigError, ProjectConfigStore, projectConfigSchema } from './project-config.ts'
import { HindsightRuntime, registerRuntime } from './runtime.ts'
import { RetryQueue } from './core/queue.ts'
import { performAdaptiveRecall } from './recall.ts'

const baseResolved = resolveConfig({
  baseUrl: 'http://localhost:8888',
  banks: {
    coding: { description: 'Engineering notes and decisions', access: 'read-write', retain: 'auto' },
    reference: { description: 'Stable reference material', access: 'read-write', retain: 'off' },
  },
  defaultBank: 'coding',
})

function withCore(base: ResolvedConfig, patch: Partial<HindsightConfig>): ResolvedConfig {
  return { ...base, core: { ...base.core, ...patch } }
}

function recallClient(text = 'Docker socket lives at /var/run/docker.sock on the host.'): HindsightHttpClient {
  return Object.assign(new HindsightHttpClient({ baseUrl: 'http://localhost:8888' }), {
    async recall(bank: string, _query: string, options?: { readonly tags?: readonly string[] }) {
      // The anti-pattern channel is a tagged query; an untagged backend answers it with nothing.
      if (options?.tags?.includes('knowledge:anti_pattern') === true) return { results: [] }
      return {
        results: [{ id: '11111111-1111-1111-1111-111111111111', text: `${text} (${bank})`, type: 'world' }],
      }
    },
    async getVersion() {
      return { api_version: 'test' }
    },
    async retain() {
      return { operation_id: 'op-test' }
    },
  })
}

/** A backend whose fact id follows the query, so a new instruction retrieves a new fact. */
function queryKeyedClient(): HindsightHttpClient {
  return Object.assign(new HindsightHttpClient({ baseUrl: 'http://localhost:8888' }), {
    async recall(bank: string, query: string, options?: { readonly tags?: readonly string[] }) {
      if (options?.tags?.includes('knowledge:anti_pattern') === true) return { results: [] }
      const id = createHash('sha1').update(`${bank}\u0000${query}`).digest('hex')
      return { results: [{ id, text: `Fact for: ${query} (${bank})`, type: 'world' }] }
    },
    async getVersion() {
      return { api_version: 'test' }
    },
  })
}

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'omd-hindsight-test-'))
}

function fakeAgent(id: string, cwd: string, header: Record<string, unknown> = { origin: 'chat' }) {
  const calls: string[] = []
  const agent = {
    id,
    session: { id, header: { cwd, ...header }, deriveMessages: () => [] },
    ctx: { get: () => undefined },
    followup: () => calls.push('followup'),
    steer: () => calls.push('steer'),
    inject: () => calls.push('inject'),
    send: () => calls.push('send'),
  } as Agent
  return { agent, calls }
}

function human(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function step(ctx: Context, agent: Agent, messages: UserMessage[], turn = 1, stepNumber = 1) {
  return await ctx.waterfall(
    'agent/pre-step',
    {
      agent,
      messages,
      turn,
      step: stepNumber,
      signal: new AbortController().signal,
      modelSelection: {},
    } as never,
    async () => ({ kind: 'enter' as const, messages }),
  )
}

describe('adaptive recall without a judgment service', () => {
  it('renders the exact fenced recall and needs no judge when both judge stages are off', async () => {
    const cwd = await tempDir()
    const single = resolveConfig({
      baseUrl: 'http://localhost:8888',
      banks: { coding: { description: 'Engineering notes and decisions', access: 'read-write', retain: 'auto' } },
      defaultBank: 'coding',
    })
    const resolved = withCore(single, { recallInjectJudge: false, recallRerankJudge: false })
    const runtime = new HindsightRuntime({ config: resolved.core, cwd })
    runtime.client = recallClient()

    const injection = await performAdaptiveRecall(runtime, 'where is the docker socket', undefined, {
      trigger: 'context',
    })
    expect(injection).toBeDefined()
    const text = injection!.text
    expect(text.startsWith('omp coding task memory lookup.\n<hindsight_memories>\n')).toBe(true)
    expect(text).toContain('- [coding] (world) Docker socket lives at /var/run/docker.sock on the host. (coding)')
    expect(text).toContain('evidence: hindsight://coding/facts/11111111-1111-1111-1111-111111111111')
    expect(text.endsWith('</hindsight_memories>')).toBe(true)

    const details = injection!.details
    expect(details.fence).toBe('hindsight_memories')
    expect(details.query).toBe('where is the docker socket')
    expect(details.banks).toEqual(['coding'])
    expect(Object.keys(details).sort()).toEqual(['banks', 'facts', 'fence', 'query'])
    expect(details.facts[0]!.bank).toBe('coding')
    expect(details.facts[0]!.path).toBe('hindsight://coding/facts/11111111-1111-1111-1111-111111111111')
    expect(details.facts[0]!.chunkPath).toBeNull()
    expect(details.facts[0]!.antiPattern).toBe(false)
  })
})

describe('agent/pre-step recall lifecycle on a real Cordis context', () => {
  it('appends a durable sourced recall, leaves the human prompt untouched and opens no turn', async () => {
    const cwd = await tempDir()
    const resolved = withCore(baseResolved, { recallMinIntervalMs: 0 })
    const runtime = new HindsightRuntime({ config: resolved.core, cwd })
    runtime.client = queryKeyedClient()
    registerRuntime('agent-main', runtime)

    const root = new Context()
    registerLifecycle(root, { base: resolved, resolve: async () => resolved, judgePort: () => undefined })
    const { agent, calls } = fakeAgent('agent-main', cwd)

    const first = human('Where is the docker socket mounted?')
    const decision = await step(root, agent, [first])
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[0]!.id).toBe(first.id)
    expect(decision.messages[0]!.content).toEqual(first.content)
    const recall = decision.messages[1]!
    expect(recall.source).toMatchObject({ kind: 'hindsight', form: 'recall' })
    if (recall.source.kind !== 'hindsight') throw new Error('Expected a Hindsight source')
    expect(recall.source.details.fence).toBe('hindsight_memories')
    expect(calls).toEqual([])

    // The same human message cannot be answered twice, even when a later step sees it again.
    const second = await step(root, agent, [first], 1, 2)
    expect(second.kind === 'enter' && second.messages).toHaveLength(1)

    // A steering instruction inside the same turn is a new human intent and is eligible.
    const steer = human('Also note: docker runs rootless here.')
    const third = await step(root, agent, [steer], 1, 3)
    expect(third.kind === 'enter' && third.messages).toHaveLength(2)
  })

  it('keeps subagents off recall when recallInSubagents is false', async () => {
    const cwd = await tempDir()
    const resolved = withCore(baseResolved, { recallInSubagents: false, recallMinIntervalMs: 0 })
    const runtime = new HindsightRuntime({ config: resolved.core, cwd })
    runtime.client = recallClient()
    registerRuntime('agent-parent', runtime)

    const root = new Context()
    registerLifecycle(root, { base: resolved, resolve: async () => resolved, judgePort: () => undefined })
    const { agent } = fakeAgent('agent-sub', cwd, { origin: 'subagent', parentSession: 'agent-parent' })
    const decision = await step(root, agent, [human('Where is the docker socket mounted?')])
    expect(decision.kind === 'enter' && decision.messages).toHaveLength(1)
  })
})

describe('queue replay boundary', () => {
  it('reports a policy-refused entry as still queued and submits the allowed one once', async () => {
    const cwd = await tempDir()
    const queue = new RetryQueue({ projectRoot: cwd })
    const allowed = await queue.enqueue('coding', { content: 'a fact' })
    const refused = await queue.enqueue('reference', { content: 'a fact for a retain-off bank' })
    const unknown = await queue.enqueue('missing-bank', { content: 'a fact for an undeclared bank' })

    const submitted: string[] = []
    const report = await queue.process(
      {
        async retain(bank: string) {
          submitted.push(bank)
          return { operation_id: 'op-1' }
        },
      },
      {
        allow: (entry) => {
          const bank = baseResolved.banks.find(candidate => candidate.bankId === entry.bank)
          if (bank === undefined) return 'unknown bank'
          return bank.retain.mode === 'off' ? 'retain off' : null
        },
      },
    )
    expect(submitted).toEqual(['coding'])
    expect(report.sent).toEqual([allowed.id])
    expect(report.queued.sort()).toEqual([refused.id, unknown.id].sort())
    const remaining = await queue.inspect()
    expect(remaining.pending.map(entry => entry.id).sort()).toEqual([refused.id, unknown.id].sort())
  })

  it('shares one replay between concurrent callers and rejects a read-only caller', async () => {
    const cwd = await tempDir()
    const runtime = new HindsightRuntime({ config: baseResolved.core, cwd })
    let retained = 0
    const { promise: gate, resolve: release } = Promise.withResolvers<void>()
    runtime.client = Object.assign(runtime.client, {
      async retain() {
        retained += 1
        await gate
        return { operation_id: 'op-1' }
      },
    })
    await runtime.queue.enqueue('coding', { content: 'a fact' })

    const first = runtime.replay(baseResolved, false)
    const second = runtime.replay(baseResolved, false)
    release()
    const [left, right] = await Promise.all([first, second])
    expect(retained).toBe(1)
    expect(left.sent).toHaveLength(1)
    expect(right.sent).toEqual(left.sent)

    await expect(runtime.replay(baseResolved, true)).rejects.toThrow(/read-only/)
  })
})

describe('project config conflict boundary', () => {
  it('refuses a stale revision without overwriting the stored document', async () => {
    const dir = await tempDir()
    const store = new ProjectConfigStore(dir)
    const project = join(dir, 'bot-project')
    const written = await store.write(project, 0, { recallMaxItems: 12 })
    expect(written.revision).toBe(1)

    await expect(store.write(project, 0, { recallMaxItems: 4 })).rejects.toBeInstanceOf(ProjectConfigError)
    const reread = await store.read(project)
    expect(reread.revision).toBe(1)
    expect(reread.hindsight.recallMaxItems).toBe(12)
  })
})

describe('JSON plugin resources', () => {
  it('reports real queue counts, the project schema and a disabled project without bank presentation', async () => {
    const cwd = await tempDir()
    const runtime = new HindsightRuntime({ config: baseResolved.core, cwd })
    runtime.client = recallClient()
    await runtime.queue.enqueue('coding', { content: 'a fact' })
    const schema = projectConfigSchema(baseResolved.bankIds)

    const reader = createPathReader(baseResolved, () => runtime, {
      projectConfigDocument: async () => `${JSON.stringify({
        project: cwd,
        revision: 0,
        values: {},
        effective: null,
        schema,
      })}\n`,
    })

    const status = JSON.parse(await reader('plugin/status'))
    expect(status.enabled).toBe(true)
    expect(status.health.healthy).toBe(true)
    expect(status.banks.map((bank: { id: string }) => bank.id)).toEqual(['coding', 'reference'])
    expect(status.banks[1].retain).toBe('off')
    expect(status.queue).toEqual({ pending: 1, failed: 0, corrupt: 0 })

    const queue = JSON.parse(await reader('plugin/queue'))
    expect(queue.pending).toHaveLength(1)

    const legacy = await reader('queue')
    expect(legacy).toContain('# Retry Queue')
    expect(legacy).toContain('Pending: 1')

    const config = JSON.parse(await reader('plugin/project-config'))
    expect(config.schema.properties.enabled['x-scope']).toBe('project')
    expect(config.schema.properties.baseUrl['x-scope']).toBe('project')
    expect(config.schema.properties.retain.enum).toContain('auto')

    const disabled = { ...withCore(baseResolved, { enabled: false }), enabled: false }
    const disabledReader = createPathReader(disabled, () => runtime)
    const disabledStatus = JSON.parse(await disabledReader('plugin/status'))
    expect(disabledStatus.enabled).toBe(false)
    expect(disabledStatus.banks).toEqual([])
  })
})
