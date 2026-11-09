/**
 * POST actions behind the plugin's own internal paths.
 *
 * Every action intent goes through the same judgment service as model and manual
 * action requests. The decision sees only intent, path, action, origin and
 * session — never a queue entry body or a config payload. A missing backend, a
 * missing answer or a declined answer fails the action explicitly; nothing is
 * routed heuristically around the decision.
 *
 * @module omd-hindsight/actions
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { effectiveView, type EffectiveConfigView, type ProjectHindsightValues, type ResolvedConfig } from './config.ts'
import type { JudgePort } from './core/judge.ts'
import {
  ProjectConfigError,
  ProjectConfigStore,
  validateProjectValues,
} from './project-config.ts'
import type { HindsightRuntime } from './runtime.ts'

export interface ActionExec {
  readonly cwd?: string
  readonly sessionId?: string
  readonly origin?: string
  readonly agent?: Agent
}

export interface JudgmentAccess {
  readonly port: JudgePort
  readonly label: string
}

export interface ActionHost {
  readonly base: ResolvedConfig
  readonly bankIds: ReadonlySet<string>
  readonly store: ProjectConfigStore
  /** Effective row + one project's overrides, used to re-check policy at replay time. */
  effectiveFor(project: string): Promise<ResolvedConfig>
  /** The runtime owning this session, or undefined when no session was started for it. */
  runtimeFor(exec: ActionExec): HindsightRuntime | undefined
  /** The calling session's working directory: the exec's own, else read from the session store. */
  projectCwd(exec: ActionExec): string | undefined
  /** Lazy judgment access: inventory/status reads must never need this service. */
  judgment(): JudgmentAccess | undefined
  /** Name of the judgment service for an explicit unavailable error. */
  judgmentLabel(): string
  /** A subagent caller is read-only and cannot write config or replay retain entries. */
  isReadonly(exec: ActionExec): boolean
}

export class ActionError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ActionError'
    this.status = status
  }
}

/** POST one of the plugin's action paths; the answer is the JSON body of the response. */
export async function postPluginAction(path: string, content: string, exec: ActionExec, host: ActionHost): Promise<string> {
  const address = path.trim().replace(/^\/+/u, '')
  if (address !== 'plugin/project-config' && address !== 'plugin/queue') {
    throw new ActionError(`cannot POST "${path}": no action is registered at this hindsight path`, 404)
  }
  const body = parseBody(content)
  const intent = body.intent
  if (typeof intent !== 'string' || intent.trim().length === 0) {
    throw new ActionError('intent must be a non-empty string naming the requested action')
  }
  const action = address === 'plugin/queue' ? 'retry' : 'update-project-config'
  await decide(intent, address, action, exec, host)

  if (address === 'plugin/project-config') return await updateProjectConfig(body, exec, host)
  return await retryQueue(body, exec, host)
}

function parseBody(content: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new ActionError('invalid JSON body')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ActionError('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

const ACTION_INSTRUCTIONS =
  'A user or agent asked the Hindsight plugin to perform one settings or retry action. '
  + 'Decide whether the stated intent authorizes that exact action on the named path. '
  + 'The decision metadata carries only the intent, path, action, origin and session; '
  + 'the values and queue entries are not part of this decision. Choose proceed only when '
  + 'the intent names this action, otherwise decline.'

async function decide(intent: string, path: string, action: string, exec: ActionExec, host: ActionHost): Promise<void> {
  const access = host.judgment()
  if (access === undefined) {
    throw new ActionError(`judgment service unavailable: ${host.judgmentLabel()}`, 503)
  }
  const answers = await access.port(
    {
      intent,
      path: `hindsight://${path}`,
      action,
      origin: exec.origin ?? 'human',
      session: exec.sessionId ?? null,
    },
    {
      action_decision: {
        type: 'choice',
        instructions: ACTION_INSTRUCTIONS,
        criteria: {
          proceed: 'The intent authorizes this exact action on this path.',
          decline: 'The intent asks for something else, is unclear, or does not authorize a write.',
        },
      },
    },
  )
  const answer = answers.action_decision
  if (answer === undefined || answer.choice !== 'proceed') {
    throw new ActionError(`judgment declined ${action} on hindsight://${path}`, 403)
  }
  if (answer.confidence < host.base.judgeAmbiguousConfidence) {
    throw new ActionError(
      `judgment confidence ${answer.confidence} is below ${host.base.judgeAmbiguousConfidence} for ${action}`,
      503,
    )
  }
}

async function updateProjectConfig(
  body: Record<string, unknown>,
  exec: ActionExec,
  host: ActionHost,
): Promise<string> {
  if (host.isReadonly(exec)) {
    throw new ActionError('read-only session: a subagent cannot change project settings', 403)
  }
  const project = host.projectCwd(exec)
  if (project === undefined || project.trim().length === 0) {
    throw new ActionError('session cwd is required to resolve the project config', 400)
  }
  const expectedRevision = body.expectedRevision
  if (
    typeof expectedRevision !== 'number'
    || !Number.isInteger(expectedRevision)
    || expectedRevision < 0
  ) {
    throw new ActionError('expectedRevision must be a non-negative integer (the revision you read)')
  }
  try {
    const values = validateProjectValues(body.values, host.bankIds)
    const current = await host.store.read(project)
    const doc = await host.store.write(project, expectedRevision, { ...current.hindsight, ...values })
    const resolved = await host.effectiveFor(project)
    const view: EffectiveConfigView = effectiveView(resolved, doc.hindsight as ProjectHindsightValues)
    return JSON.stringify({ ok: true, revision: doc.revision, effective: view, values: doc.hindsight })
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      throw new ActionError(error.message, error.code === 'conflict' ? 409 : 400)
    }
    throw new ActionError(error instanceof Error ? error.message : String(error), 502)
  }
}

async function retryQueue(
  body: Record<string, unknown>,
  exec: ActionExec,
  host: ActionHost,
): Promise<string> {
  if (body.action !== 'retry') {
    throw new ActionError('action must be "retry"')
  }
  if (host.isReadonly(exec)) {
    throw new ActionError('read-only session: a subagent cannot replay queued retain writes', 403)
  }
  const runtime = host.runtimeFor(exec)
  if (runtime === undefined) {
    throw new ActionError('no Hindsight runtime is attached to this session; open a Bot session first', 503)
  }
  const project = host.projectCwd(exec)
  const effective = project === undefined ? host.base : await host.effectiveFor(project)
  if (!effective.enabled) {
    throw new ActionError('Hindsight is disabled for this project; queue replay is not available', 409)
  }
  runtime.configure({ config: effective.core, cwd: runtime.cwd })
  try {
    const report = await runtime.replay(effective, host.isReadonly(exec))
    return JSON.stringify(report)
  } catch (error) {
    throw new ActionError(error instanceof Error ? error.message : String(error), 502)
  }
}
