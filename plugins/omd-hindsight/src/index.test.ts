import { describe, expect, it } from 'bun:test'
import { resolveConfig } from './config.ts'
import { buildHindsightTool, createJudgePort, isSubagentCaller, type JudgmentServiceFace } from './tool.ts'
import { createPathReader } from './paths.ts'
import { HindsightRuntime } from './runtime.ts'
import type { HindsightHttpClient } from './core/client.ts'

describe('omd-hindsight config mapping', () => {
  it('resolves valid config mapping to core HindsightConfig', () => {
    const resolved = resolveConfig({
      baseUrl: 'http://localhost:8888',
      banks: {
        coding: {
          description: 'Engineering notes and decisions',
          access: 'read-write',
          retain: 'auto',
        },
      },
      defaultBank: 'coding',
    })

    expect(resolved.enabled).toBe(true)
    expect(resolved.baseUrl).toBe('http://localhost:8888')
    expect(resolved.banks.length).toBe(1)
    expect(resolved.banks[0]!.id).toBe('coding')
    expect(resolved.banks[0]!.bankId).toBe('coding')
    expect(resolved.banks[0]!.retain.mode).toBe('auto')
    expect(resolved.banks[0]!.retain.scopes).toBe('per_tag')
    expect(resolved.core.baseUrl).toBe('http://localhost:8888')
    expect(resolved.bankIds.has('coding')).toBe(true)
  })

  it('rejects empty banks if plugin is enabled', () => {
    expect(() => resolveConfig({ banks: {} })).toThrow(/banks/i)
  })

  it('rejects bank with empty description', () => {
    expect(() =>
      resolveConfig({
        banks: {
          coding: {
            description: '',
            access: 'read-write',
          },
        },
      }),
    ).toThrow(/description is required/i)
  })

  it('returns inert config when enabled=false with empty banks', () => {
    const resolved = resolveConfig({ enabled: false })
    expect(resolved.enabled).toBe(false)
  })
})

describe('omd-hindsight tool routing with fake client', () => {
  const resolved = resolveConfig({
    baseUrl: 'http://localhost:8888',
    banks: {
      coding: {
        description: 'Engineering notes and decisions',
        access: 'read-write',
        retain: 'auto',
      },
    },
    defaultBank: 'coding',
  })

  // Create a fake HindsightHttpClient
  const fakeClient = {
    async recall(bank: string, query: string) {
      return {
        results: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            text: `Fake recall result for ${query} in ${bank}`,
            type: 'world',
          },
        ],
      }
    },
    async retain(bank: string, content: string) {
      return {
        operation_id: 'op-fake-123',
        status: 'pending',
      }
    },
    async getMemory(bank: string, id: string) {
      return {
        id,
        text: 'Fake memory text',
        type: 'world',
        created_at: new Date().toISOString(),
      }
    },
    async getKnowledgeBaseTree(_bank: string) {
      return {
        roots: [
          {
            id: 'page-1',
            name: 'Architecture Overview',
            kind: 'page',
          },
        ],
      }
    },
    async getKnowledgePage(_bank: string, id: string) {
      return {
        id,
        name: 'Architecture Overview',
        body: 'Architecture content',
        source_query: 'architecture',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    },
    async listOperations(_bank: string) {
      return {
        bank_id: 'coding',
        total: 1,
        limit: 50,
        offset: 0,
        operations: [
          {
            id: 'op-1',
            operation_type: 'retain',
            status: 'completed',
            items_count: 1,
            document_id: null,
            mental_model_id: null,
            created_at: new Date().toISOString(),
            error_message: null,
          },
        ],
      }
    },
    async listMentalModels(_bank: string) {
      return {
        items: [],
      }
    },
    async listDocuments(_bank: string) {
      return {
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
      }
    },
    async getVersion() {
      return {
        api_version: '1.0.0-mock',
      }
    },
    async alignBank() {},
  } as unknown as HindsightHttpClient

  const runtime = new HindsightRuntime({
    config: resolved.core,
    cwd: process.cwd(),
  })
  // inject fake client into runtime
  ;(runtime as unknown as { client: HindsightHttpClient }).client = fakeClient

  it('detects subagent caller from session header', () => {
    expect(isSubagentCaller(undefined)).toBe(false)
    expect(isSubagentCaller({ session: { header: { origin: 'subagent' } } } as any)).toBe(true)
    expect(isSubagentCaller({ session: { header: { parentSession: 'sess-parent' } } } as any)).toBe(true)
    expect(isSubagentCaller({ session: { header: { delegationDepth: 1 } } } as any)).toBe(true)
    expect(isSubagentCaller({ session: { header: { origin: 'chat' } } } as any)).toBe(false)
  })

  it('subagent write is blocked immediately with readonly_subagent_guard', async () => {
    const tool = buildHindsightTool(resolved, undefined, new Map(), () => runtime)
    const exec = {
      agent: {
        session: {
          header: { origin: 'subagent' },
        },
      },
    } as any

    const result = await tool.execute(
      {
        intent: 'retain this important decision',
        content: 'We chose bun over node',
      },
      exec,
    )

    expect(result.status).toBe('hint')
    expect(result.scenario).toBe('readonly_subagent_guard')
    expect(result.text).toContain('readonly subagent environment')
  })

  it('routes recall request through judge pipeline to fake client', async () => {
    const mockJudgeService: JudgmentServiceFace = {
      available: () => true,
      label: () => 'mock-judge',
      async judge({ questions }) {
        const answers: Record<string, any> = {}
        for (const [id] of Object.entries(questions)) {
          if (id === 'intent_cardinality') {
            answers[id] = { type: 'choice', choice: 'atomic', confidence: 0.95, probabilities: {} }
          } else if (id === 'action_family') {
            answers[id] = { type: 'choice', choice: 'memory_query', confidence: 0.92, probabilities: {} }
          } else if (id === 'retrieval_depth') {
            answers[id] = { type: 'choice', choice: 'recall', confidence: 0.9, probabilities: {} }
          } else if (id === 'target_bank') {
            answers[id] = { type: 'choice', choice: 'coding', confidence: 0.88, probabilities: {} }
          }
        }
        return { answers }
      },
    }

    const tool = buildHindsightTool(resolved, mockJudgeService, new Map(), () => runtime)
    const exec = {
      agent: {
        session: {
          header: { origin: 'chat' },
        },
      },
    } as any

    const result = await tool.execute(
      {
        intent: 'recall deployment notes for this service',
      },
      exec,
    )

    expect(result.status).toBe('ok')
    expect(result.text).toContain('Completed 1 step(s)')
    expect(result.text).toContain('recall')
    expect(result.paths.length).toBeGreaterThan(0)
    expect(result.paths[0]).toContain('hindsight://coding/facts/')
  })

  it('routes retain request through judge pipeline to fake client', async () => {
    const mockJudgeService: JudgmentServiceFace = {
      available: () => true,
      label: () => 'mock-judge',
      async judge({ questions }) {
        const answers: Record<string, any> = {}
        for (const [id] of Object.entries(questions)) {
          if (id === 'intent_cardinality') {
            answers[id] = { type: 'choice', choice: 'atomic', confidence: 0.95, probabilities: {} }
          } else if (id === 'action_family') {
            answers[id] = { type: 'choice', choice: 'memory_retain', confidence: 0.92, probabilities: {} }
          } else if (id === 'retain_source') {
            answers[id] = { type: 'choice', choice: 'inline', confidence: 0.9, probabilities: {} }
          } else if (id === 'target_bank') {
            answers[id] = { type: 'choice', choice: 'coding', confidence: 0.88, probabilities: {} }
          }
        }
        return { answers }
      },
    }

    const tool = buildHindsightTool(resolved, mockJudgeService, new Map(), () => runtime)
    const exec = {
      agent: {
        session: {
          header: { origin: 'chat' },
        },
      },
    } as any

    const result = await tool.execute(
      {
        intent: 'remember our database configuration',
        content: 'Database port is 5432',
      },
      exec,
    )

    expect(result.status).toBe('ok')
    expect(result.text).toContain('retain')
    expect(result.text).toContain('op-fake-123')
    expect(result.paths).toContain('hindsight://coding/operations/op-fake-123')
  })
})

describe('omd-hindsight path reader', () => {
  const resolved = resolveConfig({
    baseUrl: 'http://localhost:8888',
    banks: {
      coding: {
        description: 'Engineering notes and decisions',
        access: 'read-write',
        retain: 'auto',
      },
    },
    defaultBank: 'coding',
  })

  const fakeClient = {
    async recall(bank: string, query: string) {
      return {
        results: [
          {
            id: '22222222-2222-2222-2222-222222222222',
            text: `Fact text for ${query}`,
            type: 'world',
          },
        ],
      }
    },
    async getMemory(bank: string, id: string) {
      return {
        id,
        text: 'Specific fact text for test',
        type: 'world',
        created_at: new Date().toISOString(),
      }
    },
    async getKnowledgeBaseTree(_bank: string) {
      return {
        roots: [
          {
            id: 'kp-test',
            name: 'Test Page',
            kind: 'page',
          },
        ],
      }
    },
    async getKnowledgePage(_bank: string, id: string) {
      return {
        id,
        name: 'Test Page',
        body: 'Body text of test page',
        source_query: 'test query',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    },
    async listOperations(_bank: string) {
      return {
        bank_id: 'coding',
        total: 1,
        limit: 50,
        offset: 0,
        operations: [],
      }
    },
    async listMentalModels(_bank: string) {
      return { items: [] }
    },
    async listDocuments(_bank: string) {
      return { items: [], total: 0, limit: 50, offset: 0 }
    },
    async getVersion() {
      return { api_version: '1.0.0-mock' }
    },
  } as unknown as HindsightHttpClient

  const runtime = new HindsightRuntime({
    config: resolved.core,
    cwd: process.cwd(),
  })
  ;(runtime as unknown as { client: HindsightHttpClient }).client = fakeClient

  const reader = createPathReader(resolved, () => runtime)

  it('reads plugin config', async () => {
    const text = await reader('plugin/config')
    expect(text).toContain('# hindsight plugin config')
    expect(text).toContain('coding')
  })

  it('reads facts query', async () => {
    const text = await reader('coding/facts?q=docker')
    expect(text).toContain('Recall results')
    expect(text).toContain('22222222-2222-2222-2222-222222222222')
  })

  it('reads individual fact leaf', async () => {
    const text = await reader('coding/facts/22222222-2222-2222-2222-222222222222')
    expect(text).toContain('Fact 22222222-2222-2222-2222-222222222222')
    expect(text).toContain('Specific fact text for test')
  })

  it('reads knowledge page leaf', async () => {
    const text = await reader('coding/knowledge-base/pages/kp-test')
    expect(text).toContain('Body text of test page')
  })
})
