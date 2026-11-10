import { describe, expect, test } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import * as InternalPaths from '../../omd-internal-paths/src/index.ts'
import * as JudgmentPlugin from '../../../judgment/omd-judgment/src/index.ts'
import * as InternalTools from './index.ts'

describe('omd-internal-tools & internal-paths acceptance suite', () => {
  async function createFixture(options?: {
    judgeAvailable?: boolean
    spyJudge?: (req: unknown) => void
  }) {
    const root = new Context()
    await root.plugin(SessionProjectionRegistry)
    await root.plugin(SystemPrompt)
    await root.plugin(ToolRuntime)
    root.provide('llm', {} as any)
    root.provide('commands', { register: () => () => {} } as any)
    await root.plugin(InternalPaths, {
      livePollMs: 1500,
      permissions: [
        {
          agent: 'restricted-subagent',
          path: 'dsh-resource://notebook/*',
          action: 'write',
          access: 'deny',
        },
      ],
    })

    // Mount judgment service
    if (options?.judgeAvailable === false) {
      root.provide('judgment', {
        available: () => false,
        label: () => 'mock-offline-judge',
        judge: async () => { throw new Error('offline') },
      } as any)
    } else {
      await root.plugin(JudgmentPlugin, {
        candidates: ['magpie/group/decider'],
        endpoints: {
          magpie: {
            baseUrl: 'http://127.0.0.1:3425',
            apiKeyEnv: '',
          },
        },
        timeoutMs: 30000,
      })
      if (options?.spyJudge) {
        const originalJudge = root.get('judgment').judge.bind(root.get('judgment'))
        root.get('judgment').judge = async (req: unknown, opts: unknown) => {
          options.spyJudge?.(req)
          return await originalJudge(req, opts)
        }
      }
    }

    // Sessions registry mock
    const sessionsMap = new Map<string, Session>()
    const mockSessions = {
      get: (id: { toString(): string }) => sessionsMap.get(id.toString()),
      create: (id?: any) => {
        const sid = id || SessionId(`sess-${Date.now().toString(36)}`)
        const s = Session.create(sid)
        sessionsMap.set(sid.toString(), s)
        return s
      },
    }
    root.provide('sessions', mockSessions as any)
    root.provide('agents', {
      list: () => [...sessionsMap.values()].map(s => ({
        id: `agent-${s.id}`,
        name: `agent-${s.id}`,
        session: s,
        ctx: root.extend(),
      })),
    } as any)

  return { root, mockSessions, sessionsMap }
}

test('(1) read tool catalog concrete scope paths and inventory', async () => {
    const { root, mockSessions } = await createFixture()
    const session = mockSessions.create(SessionId('smoke-session-1'))
    const agentCtx = root.extend()
    const agent: any = {
      id: 'agent-1',
      name: 'smoke-agent-1',
      session,
      ctx: agentCtx,
    }

    // Register a hidden tool
    root.tools.register(defineTool({
      name: 'render_text',
      description: 'Render native text components',
      parameters: { title: { type: 'string', required: true } },
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: `Rendered: ${v.title}` }],
      },
      async execute({ title }) {
        return { title }
      },
    }))

    await root.plugin(InternalTools, {
      toolName: 'resource',
      passthrough: ['read', 'write', 'edit', 'bash', 'hindsight'],
      confidenceGate: 0.1,
      cacheTtlMs: 300000,
    })

    root.emit('agent/created' as any, { agent })

    const catalogContent = await root.internalPaths.read(`dsh-resource://tools/${session.id}`, { agent })
    expect(typeof catalogContent).toBe('string')
    expect(catalogContent).toContain(`dsh-resource://tools/${session.id}/render_text/invoke`)
    expect(catalogContent).not.toContain('<sessionId>')
    expect(catalogContent).not.toContain('<tool>')

    const schemaContent = await root.internalPaths.read(`dsh-resource://tools/${session.id}/render_text/schema.json`, { agent })
    const parsedSchema = JSON.parse(schemaContent as string)
    expect(parsedSchema.name).toBe('render_text')
    expect(parsedSchema.direct).toBe(false)
  }, 30000)

  test('(2) successful render_text through resource result/presentation + guard spy proving other guards run', async () => {
    const { root, mockSessions } = await createFixture()
    const session = mockSessions.create(SessionId('smoke-session-2'))
    const agentCtx = root.extend()
    const agent: any = {
      id: 'agent-2',
      name: 'smoke-agent-2',
      session,
      ctx: agentCtx,
    }

    root.tools.register(defineTool({
      name: 'render_text',
      description: 'Format native text UI document with typography and blocks',
      parameters: {
        title: { type: 'string', required: true },
        blocks: { type: 'array', items: { type: 'string' } },
      },
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: `Doc: ${v.title} (${v.blocks.length} blocks)` }],
        presentationMeta: (_a, v) => ({ dshGenerativeUi: { documentId: 'doc-123', doc: v } }),
      },
      async execute(args) {
        return { title: args.title, blocks: args.blocks ?? [] }
      },
    }))

    await root.plugin(InternalTools, {
      toolName: 'resource',
      passthrough: ['read', 'write', 'edit', 'bash', 'hindsight'],
      confidenceGate: 0.1,
      cacheTtlMs: 300000,
    })

    root.emit('agent/created' as any, { agent })

    // Install a guard spy on the agent's tool runtime to prove other guards run
    let guardSpyCalled = false
    let interceptedToolName = ''
    agent.ctx.tools.guard((exec: any) => {
      guardSpyCalled = true
      interceptedToolName = exec.name
      return undefined // allow
    })

    const resourceExec = await agent.ctx.tools.execute({
      name: 'resource',
      arguments: {
        intent: 'Render an announcement for the user with title and blocks',
        meta: {
          op: 'render_text',
          arguments: {
            title: 'Launch Notice',
            blocks: ['Feature deployed to production.'],
          },
        },
      },
      agent,
      callId: 'call-res-1' as any,
      signal: new AbortController().signal,
    })

    expect(resourceExec.isError).toBe(false)
    expect(guardSpyCalled).toBe(true)
    expect(interceptedToolName).toBe('render_text')

    // presentationMeta and content preserved
    expect(resourceExec.meta).toBeDefined()
    expect((resourceExec.meta as any).dshGenerativeUi.documentId).toBe('doc-123')
    expect(resourceExec.content[0].text).toContain('Doc: Launch Notice')
  }, 30000)

  test('(3) hidden direct invocation denied', async () => {
    const { root, mockSessions } = await createFixture()
    const session = mockSessions.create(SessionId('smoke-session-3'))
    const agentCtx = root.extend()
    const agent: any = {
      id: 'agent-3',
      name: 'smoke-agent-3',
      session,
      ctx: agentCtx,
    }

    root.tools.register(defineTool({
      name: 'hidden_worker',
      description: 'Performs backend work',
      parameters: { task: { type: 'string' } },
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: String(v) }],
      },
      async execute({ task }) {
        return { done: task }
      },
    }))

    await root.plugin(InternalTools, {
      toolName: 'resource',
      passthrough: ['read', 'write', 'edit', 'bash', 'hindsight'],
      confidenceGate: 0.1,
      cacheTtlMs: 300000,
    })

    root.emit('agent/created' as any, { agent })

    const directResult = await agent.ctx.tools.execute({
      name: 'hidden_worker',
      arguments: { task: 'clean' },
      agent,
      callId: 'call-direct-1' as any,
      signal: new AbortController().signal,
    })

    expect(directResult.isError).toBe(true)
    expect(directResult.error?.message).toContain('is not on the model surface')
    expect(directResult.error?.message).toContain(`dsh-resource://tools/${session.id}/hidden_worker/invoke`)
  }, 30000)

  test('(4) task-like existing tool invoked normal pipeline', async () => {
    const { root, mockSessions } = await createFixture()
    const session = mockSessions.create(SessionId('smoke-session-4'))
    const agentCtx = root.extend()
    const agent: any = {
      id: 'agent-4',
      name: 'smoke-agent-4',
      session,
      ctx: agentCtx,
    }

    let pipelinePassed = false
    root.tools.register(defineTool({
      name: 'task_worker',
      description: 'Run background sub-task batch',
      parameters: {
        taskName: { type: 'string', required: true },
        count: { type: 'number', required: true },
      },
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: `Task ${v.taskName} completed with ${v.count} items` }],
      },
      async execute(args) {
        pipelinePassed = true
        return { taskName: args.taskName, count: args.count, status: 'completed' }
      },
    }))

    await root.plugin(InternalTools, {
      toolName: 'resource',
      passthrough: ['read', 'write', 'edit', 'bash', 'hindsight'],
      confidenceGate: 0.1,
      cacheTtlMs: 300000,
    })

    root.emit('agent/created' as any, { agent })

    const res = await agent.ctx.tools.execute({
      name: 'resource',
      arguments: {
        intent: 'Run background task batch for user',
        meta: JSON.stringify({
          op: 'task_worker',
          arguments: { taskName: 'indexing', count: 42 },
        }),
      },
      agent,
      callId: 'call-task-1' as any,
      signal: new AbortController().signal,
    })

    expect(res.isError).toBe(false)
    expect(pipelinePassed).toBe(true)
    expect(res.content[0].text).toContain('Task indexing completed with 42 items')
  }, 30000)

  test('(5) duplicate request hits decision cache but actions execute exactly as requested', async () => {
    const { root, mockSessions } = await createFixture()
    const session = mockSessions.create(SessionId('smoke-session-5'))
    const agentCtx = root.extend()
    const agent: any = {
      id: 'agent-5',
      name: 'smoke-agent-5',
      session,
      ctx: agentCtx,
    }

    let executionCount = 0
    root.tools.register(defineTool({
      name: 'action_side_effect',
      description: 'Performs external side-effect mutation',
      parameters: { actionId: { type: 'string', required: true } },
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: `Side effect #${v.count}` }],
      },
      async execute({ actionId }) {
        executionCount += 1
        return { actionId, count: executionCount }
      },
    }))

    await root.plugin(InternalTools, {
      toolName: 'resource',
      passthrough: ['read', 'write', 'edit', 'bash', 'hindsight'],
      confidenceGate: 0.1,
      cacheTtlMs: 300000,
    })

    root.emit('agent/created' as any, { agent })

    const reqArgs = {
      intent: 'Trigger side effect action for sync',
      meta: { op: 'action_side_effect', arguments: { actionId: 'sync-01' } },
    }

    // Call 1: cache miss
    const res1 = await agent.ctx.tools.execute({
      name: 'resource',
      arguments: reqArgs,
      agent,
      callId: 'call-dup-1' as any,
      signal: new AbortController().signal,
    })
    expect(res1.isError).toBe(false)
    expect(executionCount).toBe(1)
    const val1 = res1.value as any
    expect(val1.cache).toBe('miss')

    // Call 2: cache hit on judge decision, but side effect executes again!
    const res2 = await agent.ctx.tools.execute({
      name: 'resource',
      arguments: reqArgs,
      agent,
      callId: 'call-dup-2' as any,
      signal: new AbortController().signal,
    })
    expect(res2.isError).toBe(false)
    expect(executionCount).toBe(2)
    const val2 = res2.value as any
    expect(val2.cache).toBe('hit')
    expect(val2.toolResult.value.count).toBe(2)
  }, 30000)

  test('(6) payload trap not in judge state', async () => {
    let capturedJudgeState: any = null
    const { root, mockSessions } = await createFixture({
      spyJudge: (req: any) => {
        capturedJudgeState = req.state
      },
    })
    const session = mockSessions.create(SessionId('smoke-session-6'))
    const agentCtx = root.extend()
    const agent: any = {
      id: 'agent-6',
      name: 'smoke-agent-6',
      session,
      ctx: agentCtx,
    }

    root.tools.register(defineTool({
      name: 'storage_tool',
      description: 'Store arbitrary payload',
      parameters: { data: { type: 'string' } },
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: 'Stored' }],
      },
      async execute({ data }) {
        return { stored: true }
      },
    }))

    await root.plugin(InternalTools, {
      toolName: 'resource',
      passthrough: ['read', 'write', 'edit', 'bash', 'hindsight'],
      confidenceGate: 0.1,
      cacheTtlMs: 300000,
    })

    root.emit('agent/created' as any, { agent })

    const SECRET_TRAP_1 = 'SUPER_SECRET_PAYLOAD_TRAP_12345'
    const SECRET_TRAP_2 = 'CONFIDENTIAL_DATA_TRAP_67890'

    await agent.ctx.tools.execute({
      name: 'resource',
      arguments: {
        intent: 'Store payload data into storage tool',
        content: SECRET_TRAP_1,
        meta: {
          op: 'storage_tool',
          arguments: { data: SECRET_TRAP_2 },
          data: SECRET_TRAP_2,
          code: 'console.log("secret code trap")',
        },
      },
      agent,
      callId: 'call-trap-1' as any,
      signal: new AbortController().signal,
    })

    expect(capturedJudgeState).toBeDefined()
    const serializedState = JSON.stringify(capturedJudgeState)
    expect(serializedState).not.toContain(SECRET_TRAP_1)
    expect(serializedState).not.toContain(SECRET_TRAP_2)
    expect(serializedState).not.toContain('secret code trap')
  }, 30000)

  test('(7) explicit path bound, unavailable judge fail-closed', async () => {
    const { root, mockSessions } = await createFixture({
      judgeAvailable: false,
    })
    const session = mockSessions.create(SessionId('smoke-session-7'))
    const agentCtx = root.extend()
    const agent: any = {
      id: 'agent-7',
      name: 'smoke-agent-7',
      session,
      ctx: agentCtx,
    }

    await root.plugin(InternalTools, {
      toolName: 'resource',
      passthrough: ['read', 'write', 'edit', 'bash', 'hindsight'],
      confidenceGate: 0.1,
      cacheTtlMs: 300000,
    })

    root.emit('agent/created' as any, { agent })

    const res = await agent.ctx.tools.execute({
      name: 'resource',
      arguments: {
        intent: 'Read specific path',
        path: 'dsh-resource://tools',
      },
      agent,
      callId: 'call-fail-1' as any,
      signal: new AbortController().signal,
    })

    expect(res.isError).toBe(false)
    const val = res.value as any
    expect(val.status).toBe('error')
    expect(val.reason).toContain('the judge is unavailable')
  }, 30000)

  test('(8) independent scripted tests: cross-session write and backend permission enforcement', async () => {
    const { root, mockSessions } = await createFixture()
    const session1 = mockSessions.create(SessionId('session-alice'))
    const session2 = mockSessions.create(SessionId('session-bob'))

    const agent1: any = {
      id: 'agent-alice',
      name: 'alice',
      session: session1,
      ctx: root.extend(),
    }

    const restrictedAgent: any = {
      id: 'agent-sub',
      name: 'restricted-subagent',
      session: session1,
      ctx: root.extend(),
    }

    root.tools.register(defineTool({
      name: 'vault_tool',
      description: 'Vault access tool',
      parameters: { key: { type: 'string' } },
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: 'ok' }],
      },
      async execute() {
        return { ok: true }
      },
    }))

    await root.plugin(InternalTools, {
      toolName: 'resource',
      passthrough: ['read', 'write', 'edit', 'bash', 'hindsight'],
      confidenceGate: 0.1,
      cacheTtlMs: 300000,
    })

    // Test A: Alice attempts cross-session invoke on Bob's tool path
    expect(
      root.internalPaths.write(`dsh-resource://tools/${session2.id}/vault_tool/invoke`, JSON.stringify({ key: '123' }), {
        agent: agent1,
      })
    ).rejects.toThrow('cannot invoke a tool for')

    // Test B: Backend permission denial enforced on restricted-subagent
    root.internalPaths.register('notebook', {
      grammar: 'dsh-resource://notebook/<sessionId>/notes.md',
      description: 'Notebook memory',
      async read() {
        return '# Notes'
      },
      async write() {
        return 'written'
      },
    })

    expect(
      root.internalPaths.write('dsh-resource://notebook/123/notes.md', 'new text', {
        agent: restrictedAgent,
      })
    ).rejects.toThrow('permission denied: agent "restricted-subagent" cannot write')

    // But allowed for alice
    const writeOutcome = await root.internalPaths.write('dsh-resource://notebook/123/notes.md', 'new text', {
      agent: agent1,
    })
    expect(writeOutcome).toBe('written')

    // Test C: Direct write to invoke without judge authorization must not bypass judge
    // (with an unavailable judge, direct write fails closed)
    const noJudgeFixture = await createFixture({ judgeAvailable: false })
    const noJudgeCtx = noJudgeFixture.root
    await noJudgeCtx.plugin(InternalTools, {
      toolName: 'resource',
      passthrough: ['read', 'write', 'edit', 'bash'],
      confidenceGate: 0.1,
      cacheTtlMs: 300000,
    })
    expect(
      noJudgeCtx.internalPaths.write(`dsh-resource://tools/${session1.id}/vault_tool/invoke`, JSON.stringify({ key: '123' }), {
        agent: agent1,
      })
    ).rejects.toThrow('judge is unavailable and direct invocation cannot bypass the judge')
  }, 30000)

  test('(9) baseline primitives read/write/edit/bash wrapped with judgment at entry and direct inventory bypass', async () => {
    const { root, mockSessions } = await createFixture()
    const session = mockSessions.create(SessionId('smoke-session-9'))
    const agent: any = {
      id: 'agent-9',
      name: 'smoke-agent-9',
      session,
      ctx: root.extend(),
    }

    let readExecuted = false
    let bashExecuted = false
    let writeExecuted = false
    let editExecuted = false

    root.tools.register(defineTool({
      name: 'read',
      description: 'Read file',
      parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute({ path }) {
        readExecuted = true
        return { content: `content of ${path}` }
      },
    }))

    root.tools.register(defineTool({
      name: 'bash',
      description: 'Execute command',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute({ command }) {
        bashExecuted = true
        return { stdout: `ran: ${command}` }
      },
    }))

    root.tools.register(defineTool({
      name: 'write',
      description: 'Write file',
      parameters: { path: { type: 'string', required: true }, content: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute({ path, content }) {
        writeExecuted = true
        return { written: true, path, content }
      },
    }))

    await root.plugin(InternalTools, {
      toolName: 'resource',
      passthrough: ['read', 'write', 'edit', 'bash', 'hindsight'],
      confidenceGate: 0.1,
      cacheTtlMs: 300000,
    })

    // Direct inventory read bypasses judge
    const directInventory = await agent.ctx.tools.execute({
      name: 'read',
      arguments: { path: 'dsh-resource://tools' },
      agent,
      callId: 'call-read-inv' as any,
      signal: new AbortController().signal,
    })
    expect(directInventory.isError).toBe(false)
    expect(readExecuted).toBe(true)

    // Baseline action read goes through judge
    readExecuted = false
    const fileRead = await agent.ctx.tools.execute({
      name: 'read',
      arguments: { path: '/workspace/src/app.ts' },
      agent,
      callId: 'call-read-file' as any,
      signal: new AbortController().signal,
    })
    expect(fileRead.isError).toBe(false)
    expect(readExecuted).toBe(true)

    // Baseline action bash goes through judge
    const bashRun = await agent.ctx.tools.execute({
      name: 'bash',
      arguments: { command: 'echo hello' },
      agent,
      callId: 'call-bash-1' as any,
      signal: new AbortController().signal,
    })
    expect(bashRun.isError).toBe(false)
    expect(bashExecuted).toBe(true)
  }, 30000)
})
