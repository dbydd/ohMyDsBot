/**
 * `omd-hindsight` — Hindsight-equivalent durable memory for dsh.
 *
 * One model-facing `hindsight` tool with four parameters (intent, content, file, target),
 * judged routing via omd-judgment, real HTTP backend communication via HindsightHttpClient,
 * stable hindsight:// virtual internal paths, automatic adaptive recall, and the JSON
 * status/config/queue resources plus their POST actions that the Bot panel reads and writes.
 *
 * @module omd-hindsight
 */

import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  ConfigSchema,
  effectiveView,
  resolveConfig,
  resolveProjectConfig,
  type BankSpec,
  type Config as ConfigRow,
  type EffectiveConfigView,
  type ProjectHindsightValues,
  type ResolvedConfig,
} from './config.ts'
import { getRuntime } from './runtime.ts'
import {
  ProjectConfigError,
  ProjectConfigStore,
  projectConfigSchema,
  validateProjectValues,
} from './project-config.ts'
import { isRecord } from './core/guards.ts'
import {
  buildHindsightTool,
  createJudgePort,
  isSubagentCaller,
  judgmentOf,
  projectCwdOfExec,
  renderOutcome,
  runTool,
  type CachedRun,
  type JudgmentServiceFace,
} from './tool.ts'
import { createPathReader, GRAMMAR, type PathExec } from './paths.ts'
import { registerLifecycle } from './lifecycle.ts'
import {
  ActionError,
  postPluginAction,
  type ActionHost,
  type JudgmentAccess,
} from './actions.ts'

export { resolveConfig } from './config.ts'
export type { BankSpec, Config as ConfigRow, ResolvedConfig } from './config.ts'
export { renderOutcome, runTool } from './tool.ts'

export const name = 'omd-hindsight'
export const inject = ['tools', 'systemPrompt']
export const Config: z<ConfigRow> = ConfigSchema

const SECTION_NAME = 'omd-hindsight:banks'
const SECTION_ORDER = 150
const SOURCE_NAME = 'hindsight'

interface InternalPathRegistry {
  register(source: string, provider: {
    readonly grammar: string
    readonly shorthand?: boolean
    readonly live?: boolean
    readonly description?: string
    read(path: string, exec: PathExec): Promise<string | Uint8Array>
    post?(path: string, content: string, exec: PathExec): Promise<string>
  }): () => void
}

/** The POST body must be an object; project a string and expectedRevision an integer >= 0. */
function readPostBody(body: unknown): { project: string; expectedRevision: number; values: unknown } {
  if (!isRecord(body)) {
    throw new ProjectConfigError('request body must be a JSON object', 'invalid')
  }
  if (typeof body.project !== 'string') {
    throw new ProjectConfigError('project must be a string (the Bot session cwd)', 'invalid')
  }
  if (typeof body.expectedRevision !== 'number' || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
    throw new ProjectConfigError('expectedRevision must be a non-negative integer (the revision you read)', 'invalid')
  }
  return { project: body.project, expectedRevision: body.expectedRevision, values: body.values }
}

function respondError(error: unknown): Response {
  if (error instanceof ProjectConfigError) {
    return Response.json({ error: error.message }, { status: error.code === 'conflict' ? 409 : 400 })
  }
  if (error instanceof ActionError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  return Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  )
}

function renderSection(config: ResolvedConfig, readonlyEnv: boolean): string {
  const lines: string[] = [
    '# Hindsight memory banks',
    '',
    'You have a durable memory. The `hindsight` tool stores facts and answers questions from them; '
      + 'every result carries a `hindsight://` path you can also read directly.',
    '',
  ]
  for (const bank of config.banks) {
    lines.push(`## ${bank.id}`)
    lines.push(bank.description ?? '')
    const writable = bank.access === 'read-write' && bank.retain.mode !== 'off'
    lines.push(`Access for you: ${readonlyEnv || !writable ? 'read-only' : 'read and write'}${bank.retain.autoTarget ? '' : ' · explicit target required for writes'}.`)
    lines.push('')
  }
  lines.push(
    'Retain a durable conclusion when you reach one (the `hindsight` tool, `content` carries the text); '
      + 'recall before answering from memory; read `hindsight://plugin/config` to see the roster as data.',
  )
  return lines.join('\n')
}

export function apply(ctx: Context, config: ConfigRow): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  const store = new ProjectConfigStore()
  const cache: Map<string, CachedRun> = new Map()
  const schema = projectConfigSchema(resolved.bankIds)

  /** Row-scope console values; the API key is only ever named, never read. */
  const rowView = () => ({
    baseUrl: resolved.core.baseUrl,
    apiKeyEnvVar: resolved.core.apiKeyEnvVar,
    decomposerRole: resolved.core.decomposerRole,
    recallDebounceTurns: resolved.core.recallDebounceTurns,
    recallBudget: resolved.core.recallBudget,
    recallInjectJudge: resolved.core.recallInjectJudge,
    recallRerankJudge: resolved.core.recallRerankJudge,
    recallInSubagents: resolved.core.recallInSubagents,
  })

  /** Row config folded with one project's overrides; falls back to the row on a stale override. */
  const effectiveOf = (values: ProjectHindsightValues): { effective: EffectiveConfigView; error?: string } => {
    try {
      return { effective: effectiveView(resolveProjectConfig(config, values), values) }
    } catch (error) {
      return {
        effective: effectiveView(resolved, values),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** A project's effective config; a stored document that no longer parses fails loudly. */
  const effectiveForProject = async (project: string): Promise<{ resolved: ResolvedConfig; values: ProjectHindsightValues }> => {
    const doc = await store.read(project)
    if (Object.keys(doc.hindsight).length === 0) return { resolved, values: doc.hindsight }
    return { resolved: resolveProjectConfig(config, doc.hindsight), values: doc.hindsight }
  }

  /** Per-request merge point: the calling session's project overrides, else the row config. */
  const effectiveForExec = async (exec: { agent?: Agent; cwd?: string }): Promise<ResolvedConfig | undefined> => {
    const cwd = projectCwdOfExec(exec)
    if (cwd === undefined) return undefined
    try {
      const doc = await store.read(cwd)
      if (Object.keys(doc.hindsight).length === 0) return undefined
      return resolveProjectConfig(config, doc.hindsight)
    } catch (error) {
      getRuntime(exec.agent?.id)?.recordOperation({
        status: 'hint',
        actions: [],
        hint: `project config for ${cwd} ignored: ${error instanceof Error ? error.message : String(error)}`,
        role: null,
      })
      return undefined
    }
  }

  /** Automatic path: a project config that cannot be read falls back to the row, never throws. */
  const resolveForAgent = async (agent: Agent): Promise<ResolvedConfig> => {
    const cwd = projectCwdOfExec({ agent })
    if (cwd === undefined) return resolved
    try {
      return (await effectiveForProject(cwd)).resolved
    } catch (error) {
      getRuntime(agent.id)?.recordOperation({
        status: 'hint',
        actions: [],
        hint: `project config for ${cwd} ignored: ${error instanceof Error ? error.message : String(error)}`,
        role: null,
      })
      return resolved
    }
  }

  const judgmentAccess = (): JudgmentAccess | undefined => {
    const service = judgmentOf(ctx)
    return service === undefined || !service.available()
      ? undefined
      : { port: createJudgePort(service), label: service.label() }
  }

  const actionHost: ActionHost = {
    base: resolved,
    bankIds: resolved.bankIds,
    store,
    effectiveFor: async (project) => (await effectiveForProject(project)).resolved,
    runtimeFor: (exec) => getRuntime(exec.sessionId ?? exec.agent?.id),
    projectCwd: (exec) => {
      if (exec.cwd !== undefined) return exec.cwd
      if (exec.sessionId === undefined) return undefined
      const sessions = ctx.get('sessions') as
        | { get?: (id: string) => { header?: { cwd?: string } } | undefined }
        | undefined
      return sessions?.get?.(exec.sessionId)?.header?.cwd
    },
    judgment: judgmentAccess,
    judgmentLabel: () => judgmentOf(ctx)?.label() ?? 'omd-judgment is not mounted in this profile',
    isReadonly: (exec) => exec.agent !== undefined && isSubagentCaller(exec.agent),
  }

  ctx.inject(['judgment'], (scope) => {
    const judgment = judgmentOf(scope)
    const registerTool = (): void => {
      const tool = buildHindsightTool(resolved, judgment, cache, (exec) => getRuntime(exec.agent?.id), effectiveForExec)
      scope.get('tools')?.register(tool)
      scope.on('agent/created', ({ agent }) => {
        agent.ctx.get('tools')?.register(tool)
        const readonlyEnv = isSubagentCaller(agent)
        agent.ctx.get('systemPrompt')?.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          text: renderSection(resolved, readonlyEnv),
        })
      })
    }
    if (scope.get('tools') !== undefined) registerTool()
  })

  ctx.inject(['internalPaths'], (scope) => {
    const registry = scope.get('internalPaths') as InternalPathRegistry | undefined
    if (registry === undefined) return
    const read = createPathReader(resolved, () => getRuntime(), {
      runtimeFor: (exec) => getRuntime(exec.sessionId ?? exec.agent?.id),
      configFor: async (exec) => (
        await effectiveForExec({ agent: exec.agent, cwd: actionHost.projectCwd(exec) })
      ) ?? resolved,
      projectConfigDocument: async (exec) => {
        const project = actionHost.projectCwd(exec)
        const doc = project === undefined
          ? { version: 1 as const, revision: 0, project: null, hindsight: {} as ProjectHindsightValues }
          : await store.read(project)
        const { effective, error } = effectiveOf(doc.hindsight)
        return `${JSON.stringify({
          project: doc.project,
          revision: doc.revision,
          values: doc.hindsight,
          effective,
          schema,
          row: rowView(),
          ...(error === undefined ? {} : { error }),
        }, null, 2)}\n`
      },
    })
    scope.effect(() => registry.register(SOURCE_NAME, {
      grammar: GRAMMAR,
      shorthand: true,
      live: true,
      description: 'Durable memory banks (facts, knowledge-base pages, mental models, operations) addressed via hindsight://<bank>/…, plus hindsight://plugin/{status,config,project-config,queue} JSON resources; read-only for subagents.',
      read: async (path: string, exec: PathExec) => await read(path, exec),
      post: async (path: string, content: string, exec: PathExec) => await postPluginAction(path, content, exec, actionHost),
    }), 'omd-hindsight: hindsight source')
  })

  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection') as
      | { fetch?: { register?: (route: unknown) => () => void } }
      | undefined
    if (connection?.fetch?.register === undefined) return
    scope.effect(() => connection.fetch!.register!({
      path: '/api/plugins/omd-hindsight/project-config',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        if (request.method === 'GET') {
          const project = new URL(request.url).searchParams.get('project')
          if (project === null || project.trim() === '') {
            return Response.json({ error: 'project query parameter is required (the Bot session cwd)' }, { status: 400 })
          }
          try {
            const doc = await store.read(project)
            const { effective, error } = effectiveOf(doc.hindsight)
            return Response.json({
              project: doc.project,
              revision: doc.revision,
              values: doc.hindsight,
              effective,
              schema,
              row: rowView(),
              ...(error === undefined ? {} : { error }),
            })
          } catch (error) {
            return respondError(error)
          }
        }
        if (request.method === 'POST') {
          let body: unknown
          try {
            body = await request.json()
          } catch {
            return Response.json({ error: 'invalid JSON body' }, { status: 400 })
          }
          try {
            const parsed = readPostBody(body)
            const values = validateProjectValues(parsed.values, resolved.bankIds)
            const doc = await store.write(parsed.project, parsed.expectedRevision, values)
            const { effective, error } = effectiveOf(doc.hindsight)
            return Response.json({ ok: true, revision: doc.revision, effective, ...(error === undefined ? {} : { error }) })
          } catch (error) {
            return respondError(error)
          }
        }
        return Response.json({ error: 'GET or POST required' }, { status: 405 })
      },
    }), 'omd-hindsight: project-config route')
  })

  // Automatic recall is not judgment-gated at mount: a profile without the
  // judgment service still recalls through the programmatic no-judge path.
  registerLifecycle(ctx, {
    base: resolved,
    resolve: resolveForAgent,
    judgePort: () => judgmentAccess()?.port,
  })
}

