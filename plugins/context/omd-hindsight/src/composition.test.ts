/**
 * Composition smoke: mount the plugin on a real Cordis context with the real
 * tools, system-prompt and internal-path services, then drive one
 * `agent/created` + `agent/pre-step` cycle and use the POST contract through the
 * registered source.
 *
 * This is the closest composition to the Loader that runs inside the package:
 * a profile launch additionally supplies the llm service, whose prepared
 * request is the caller's acceptance check.
 */

import { describe, expect, it } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolsService from '@deepseek-ai/dsh-tools'
import * as HindsightPlugin from './index.ts'
import { InternalPathsServiceImpl } from '../../../host/omd-internal-paths/src/service.ts'
import { getRuntime } from './runtime.ts'

describe('omd-hindsight composition smoke', () => {
  it('mounts, recalls into the first step and writes through hindsight://plugin/*', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omd-hindsight-compose-'))
    // The project-config store lives under DSH_HOME; keep the smoke off the user's home.
    const home = await mkdtemp(join(tmpdir(), 'omd-hindsight-home-'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const root = new Context()
      await root.plugin(SystemPrompt)
      await root.plugin(ToolsService)
      const internalPaths = new InternalPathsServiceImpl()
      root.provide('internalPaths', internalPaths)
      root.provide('judgment', {
        available: () => true,
        label: () => 'mock-judge',
        judge: async () => ({
          answers: {
            action_decision: {
              type: 'choice',
              choice: 'proceed',
              confidence: 0.9,
              probabilities: { proceed: 0.9, decline: 0.1 },
            },
          },
        }),
      } as never)

      await root.plugin(HindsightPlugin, {
        baseUrl: 'http://127.0.0.1:1',
        banks: {
          coding: { description: 'Engineering notes and decisions', access: 'read-write', retain: 'auto' },
        },
        defaultBank: 'coding',
      })

      expect(internalPaths.sources().map(source => source.source)).toContain('hindsight')

      const agent = {
        id: 'compose-agent',
        session: { id: 'compose-session', header: { cwd, origin: 'chat' }, deriveMessages: () => [] },
        // A real agent has its own scoped tools registry; this fixture only needs
        // the system-prompt section to land, so tools resolve to nothing.
        ctx: {
          get: (name: string) => (name === 'systemPrompt' ? root.get('systemPrompt') : undefined),
        },
      } as Agent
      await root.serial('agent/created', { agent, source: 'startup' })

      const runtime = getRuntime('compose-agent')
      expect(runtime).toBeDefined()
      runtime!.client = Object.assign(runtime!.client, {
        async recall(bank: string, query: string) {
          return {
            results: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', text: `fact for ${query} (${bank})`, type: 'world' }],
          }
        },
        async getVersion() {
          return { api_version: 'compose' }
        },
      })

      const human = createUserMessage({
        content: [{ type: 'text', text: 'Where do we keep engineering decisions?' }],
        source: { kind: 'user' },
      })
      const decision = await root.waterfall('agent/pre-step', {
        agent,
        messages: [human],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
        modelSelection: {},
      } as never, async () => ({ kind: 'enter' as const, messages: [human] }))

      expect(decision.kind).toBe('enter')
      if (decision.kind !== 'enter') return
      expect(decision.messages).toHaveLength(2)
      expect(decision.messages[0]!.id).toBe(human.id)
      expect(decision.messages[1]!.source).toMatchObject({ kind: 'hindsight', form: 'recall' })

      const status = JSON.parse(await internalPaths.read('hindsight://plugin/status', {
        sessionId: 'compose-agent',
      }))
      expect(status.enabled).toBe(true)
      expect(status.health.healthy).toBe(false)
      expect(status.banks).toHaveLength(1)
      expect(status.queue).toEqual({ pending: 0, failed: 0, corrupt: 0 })

      const source = internalPaths.sources().find(candidate => candidate.source === 'hindsight')
      expect(source?.grammar).toContain('status,project-config,queue')
      expect(source?.live).toBe(true)

      const written = JSON.parse(await internalPaths.submit(
        'hindsight://plugin/project-config',
        JSON.stringify({
          intent: 'Update Hindsight project settings',
          expectedRevision: 0,
          values: { recallMaxItems: 5 },
        }),
        { sessionId: 'compose-agent', origin: 'human', cwd },
      ))
      expect(written).toMatchObject({ ok: true, revision: 1 })

      const document = JSON.parse(await internalPaths.read('hindsight://plugin/project-config', {
        sessionId: 'compose-agent',
        origin: 'human',
        cwd,
      }))
      expect(document.revision).toBe(1)
      expect(document.values.recallMaxItems).toBe(5)
      expect(document.schema.properties.recallMaxItems['x-scope']).toBe('project')
      expect(document.row.apiKeyEnvVar).toBe('HINDSIGHT_API_KEY')

      const retry = JSON.parse(await internalPaths.submit(
        'hindsight://plugin/queue',
        JSON.stringify({ intent: 'Retry queued Hindsight memory writes', action: 'retry' }),
        { sessionId: 'compose-agent', origin: 'human', cwd },
      ))
      expect(retry).toEqual({ sent: [], queued: [], failed: [], corrupt: [] })

      await expect(internalPaths.submit(
        'hindsight://plugin/project-config',
        JSON.stringify({ intent: 'Update Hindsight project settings', expectedRevision: 1, values: {} }),
        {
          sessionId: 'compose-sub',
          agent: { session: { header: { origin: 'subagent', parentSession: 'compose-agent' } } } as never,
        },
      )).rejects.toThrow(/read-only/)
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })
})
