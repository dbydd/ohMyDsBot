/**
 * The single model-facing `hindsight` tool for dsh.
 *
 * Exactly four parameters matching TOOL_PARAMETERS: intent, content, file, target.
 * Routes through the reference core judge pipeline: decomposer -> cardinality -> action -> slots -> executeAction.
 *
 * Subagents are strictly read-only: writes are blocked in ExecutionEnv (core INV-6).
 *
 * @module omd-hindsight/tool
 */

import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './config.ts'
import type { HindsightHttpClient } from './core/client.ts'
import type { ChoiceQuestion, ExecutionEnv, JudgeAnswer, JudgePort, JudgeState } from './core/judge.ts'
import { executeToolInput, type ToolOutcome } from './core/ops.ts'
import { TOOL_PARAMETERS } from '../ssot/spec.ts'
import type { HindsightRuntime } from './runtime.ts'

const descriptionOf = (name: 'intent' | 'content' | 'file' | 'target'): string =>
  TOOL_PARAMETERS[name]?.description ?? name

const TOOL_DESCRIPTION = [
  'Hindsight: durable memory and knowledge tool. Store facts, recall them across sessions, and',
  'maintain knowledge pages and mental models — all addressed by stable `hindsight://` paths.',
  '',
  'Four parameters only:',
  `- \`intent\` (required): ${descriptionOf('intent')}`,
  `- \`content\` (optional): ${descriptionOf('content')}`,
  `- \`file\` (optional): ${descriptionOf('file')}`,
  `- \`target\` (optional): ${descriptionOf('target')}`,
  '',
  'Everything the tool returns carries a `hindsight://` path you can also `read` directly.',
  'Read-only sessions (subagents) can recall and read; writes are refused with guidance.',
].join('\n')

export interface CachedRun {
  readonly outcome: ToolOutcome
  readonly route: string
}

export interface JudgmentServiceFace {
  available(): boolean
  label(): string
  judge(request: {
    state: JudgeState
    questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string | null> }>
  }, options?: { signal?: AbortSignal }): Promise<{
    answers: Record<string, { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }>
  }>
}

export function judgmentOf(scope: { get(name: 'judgment'): unknown }): JudgmentServiceFace | undefined {
  const judgment = scope.get('judgment') as JudgmentServiceFace | undefined
  return judgment !== undefined && typeof judgment.judge === 'function' ? judgment : undefined
}

export function createJudgePort(service: JudgmentServiceFace): JudgePort {
  return async (state: JudgeState, questions: Record<string, ChoiceQuestion>): Promise<Record<string, JudgeAnswer>> => {
    if (!service.available()) throw new Error(`judgment service unavailable: ${service.label()}`)
    const wire: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string | null> }> = {}
    for (const [id, q] of Object.entries(questions)) {
      wire[id] = { type: 'choice', instructions: q.instructions, criteria: q.criteria }
    }
    const result = await service.judge({ state, questions: wire })
    const answers: Record<string, JudgeAnswer> = {}
    for (const [id, answer] of Object.entries(result.answers)) {
      answers[id] = {
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
      }
    }
    return answers
  }
}

export function isSubagentCaller(agent: Agent | undefined): boolean {
  if (agent === undefined) return false
  const header = agent.session?.header
  if (!header) return false
  return (
    header.origin === 'subagent'
    || header.parentSession !== undefined
    || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
  )
}

function callerEnv(agent: Agent | undefined): ExecutionEnv {
  if (agent === undefined) return { role: null, isReadonly: false }
  const isReadonly = isSubagentCaller(agent)
  const role = agent.session?.header?.agentPreset ?? null
  return { role, isReadonly }
}

function requestHash(
  input: { intent: string; content?: string; file?: string; target?: string },
  isReadonly: boolean,
  banks: readonly string[],
  effectiveScope: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      intent: input.intent.trim(),
      hasContent: input.content !== undefined && input.content.length > 0,
      hasFile: input.file !== undefined && input.file.length > 0,
      target: input.target ?? null,
      isReadonly,
      banks,
      effectiveScope,
    }))
    .digest('hex')
}

/** Values that change a routing decision; projects sharing them may share a cached decision. */
function scopeOf(config: ResolvedConfig): string {
  return [
    config.defaultBank,
    config.recallMaxItems,
    config.recallPreviewChars,
    ...config.banks.map(bank => `${bank.id}:${bank.access}:${bank.retain.mode}:${bank.retain.autoTarget}`),
  ].join('|')
}

/** Calling session's project directory: the live working directory, else the creation cwd. */
export function projectCwdOfExec(exec: { agent?: Agent; cwd?: string }): string | undefined {
  if (exec.cwd !== undefined) return exec.cwd
  const agent = exec.agent
  if (agent === undefined) return undefined
  const directory = agent.ctx.get('workingDirectory')
  const live = directory?.get(agent.session)
  if (typeof live === 'string' && live.length > 0) return live
  return agent.session?.header?.cwd
}

export function renderOutcome(outcome: ToolOutcome): string {
  if (outcome.status === 'hint') {
    const lines: string[] = []
    lines.push(
      outcome.completed.length === 0
        ? 'No steps executed.'
        : `Completed ${outcome.completed.length} step(s) before stopping: ${outcome.completed
            .map(action => action.action)
            .join(' → ')}`,
    )
    lines.push(`Diagnostic: ${outcome.hint.diagnosis}`)
    lines.push(`Suggested action: ${outcome.hint.suggestedAction}`)
    return lines.join('\n')
  }

  const lines = [`Completed ${outcome.actions.length} step(s).`]
  for (const [index, action] of outcome.actions.entries()) {
    const bank = action.bank.length === 0 ? '' : ` · bank \`${action.bank}\``
    let detail = ''
    if (action.receipt !== null) {
      if (action.receipt.kind === 'retain') {
        detail = action.receipt.operationId.length === 0
          ? `: submitted (${action.receipt.payloadKind})`
          : `: submitted (${action.receipt.payloadKind}), operation \`${action.receipt.operationId}\``
      } else if (action.receipt.kind === 'recall') {
        detail = `: ${action.receipt.matchCount} match(es)`
      } else if (action.receipt.kind === 'knowledge_page') {
        detail = `: page \`${action.receipt.pagePath}\``
      }
    }
    lines.push(`${index + 1}. ${action.action}${bank}${detail}`)
    if (action.receipt !== null && action.receipt.kind === 'recall') {
      for (const fact of action.receipt.facts) {
        const preview = fact.text.replace(/\s+/gu, ' ').slice(0, 120)
        lines.push(`   - \`${fact.path}\` (${fact.type ?? 'unknown'}) ${preview}`)
      }
    }
    if (action.paths.length > 0) {
      lines.push(`   Paths: ${action.paths.map(p => `\`${p}\``).join(', ')}`)
    }
    if (action.content !== null) {
      lines.push('', action.content.trim(), '')
    }
  }

  if (outcome.failures.length > 0) {
    lines.push('', `Failed ${outcome.failures.length} step(s):`)
    for (const failure of outcome.failures) {
      lines.push(`- ${failure.diagnosis}`)
      lines.push(`  Suggested action: ${failure.suggestedAction}`)
    }
  }
  return lines.join('\n')
}

export function buildHindsightTool(
  resolved: ResolvedConfig,
  judgment: JudgmentServiceFace | undefined,
  cache: Map<string, CachedRun>,
  runtimeFor: (exec: { agent?: Agent; cwd?: string }) => HindsightRuntime | undefined,
  projectConfigFor?: (exec: { agent?: Agent; cwd?: string }) => ResolvedConfig | undefined | Promise<ResolvedConfig | undefined>,
): ToolDefinition {
  return defineTool({
    name: 'hindsight',
    description: TOOL_DESCRIPTION,
    parameters: {
      intent: { type: 'string', required: true, description: descriptionOf('intent') },
      content: { type: 'string', description: descriptionOf('content') },
      file: { type: 'string', description: descriptionOf('file') },
      target: { type: 'string', description: descriptionOf('target') },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, description: 'ok | hint' },
          text: { type: 'string', required: true, description: 'Rendered receipt or guidance text' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Stable hindsight:// paths' },
          scenario: { type: 'string', description: 'Hint scenario when status is hint' },
          cached: { type: 'boolean', description: 'Whether the decision was cached' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: args => args.content === undefined && args.file === undefined,
    async execute(args, exec) {
      const env = callerEnv(exec.agent)
      const runtime = runtimeFor(exec)
      if (runtime === undefined) {
        return {
          status: 'hint',
          text: 'Hindsight is not running for this session yet; no runtime is attached to the working directory.',
          paths: [],
          scenario: 'runtime_unavailable',
          cached: false,
        }
      }
      const effective = (await projectConfigFor?.(exec)) ?? resolved
      const input = {
        intent: args.intent,
        content: args.content ?? undefined,
        file: args.file ?? undefined,
        target: args.target ?? undefined,
      }

      if (!input.intent || input.intent.trim().length === 0) {
        return {
          status: 'hint',
          text: 'Invalid arguments: intent must not be empty; state what to do in one sentence.',
          paths: [],
          scenario: 'unresolved_intent',
          cached: false,
        }
      }

      if (env.isReadonly && (input.content !== undefined || input.file !== undefined)) {
        const hintOutcome: ToolOutcome = {
          status: 'hint',
          hint: {
            scenario: 'readonly_subagent_guard',
            diagnosis: 'Write action blocked in readonly subagent environment: subagents cannot mutate remote state.',
            suggestedAction: 'Pass conclusions back to main session to execute the write.',
          },
          completed: [],
        }
        runtime.recordOperation({
          status: 'hint',
          actions: [],
          hint: 'readonly_subagent_guard',
          role: env.role,
        })
        return {
          status: 'hint',
          text: renderOutcome(hintOutcome),
          paths: [],
          scenario: 'readonly_subagent_guard',
          cached: false,
        }
      }

      if (!effective.enabled) {
        const disabledOutcome: ToolOutcome = {
          status: 'hint',
          hint: {
            scenario: 'project_memory_disabled',
            diagnosis: 'Hindsight memory is disabled for this project directory (project-level config).',
            suggestedAction: 'Re-enable it in the Bot config panel (Hindsight project config) or ask the user.',
          },
          completed: [],
        }
        runtime.recordOperation({
          status: 'hint',
          actions: [],
          hint: 'project_memory_disabled',
          role: env.role,
        })
        return {
          status: 'hint',
          text: renderOutcome(disabledOutcome),
          paths: [],
          scenario: 'project_memory_disabled',
          cached: false,
        }
      }

      if (judgment === undefined || !judgment.available()) {
        const hintOutcome: ToolOutcome = {
          status: 'hint',
          hint: {
            scenario: 'judge_unavailable',
            diagnosis: `The decision judge is not available right now (${judgment?.label() ?? 'none'}). Hindsight routes every request through the judge.`,
            suggestedAction: 'Retry when judgment service is available; check omd-judgment service status.',
          },
          completed: [],
        }
        return {
          status: 'hint',
          text: renderOutcome(hintOutcome),
          paths: [],
          scenario: 'judge_unavailable',
          cached: false,
        }
      }

      const key = requestHash(input, env.isReadonly, [...effective.bankIds], scopeOf(effective))
      const cached = cache.get(key)
      if (cached !== undefined) {
        const paths = cached.outcome.status === 'ok'
          ? cached.outcome.actions.flatMap(a => [...a.paths])
          : []
        return {
          status: cached.outcome.status,
          text: renderOutcome(cached.outcome),
          paths,
          ...(cached.outcome.status === 'hint' ? { scenario: cached.outcome.hint.scenario } : {}),
          cached: true,
        }
      }

      const judgePort = createJudgePort(judgment)
      const outcome = await executeToolInput(
        input,
        effective.core,
        runtime.client,
        judgePort,
        env,
        {
          queue: runtime.queue,
          judgeOverrides: runtime.promptPack.judge,
        },
      )

      const executed = outcome.status === 'ok' ? outcome.actions : outcome.completed
      runtime.recordOperation({
        status: outcome.status,
        actions: executed.map(a => a.action),
        hint: outcome.status === 'hint' ? outcome.hint.scenario : null,
        role: env.role,
      })

      if (!(outcome.status === 'hint' && (outcome.hint.scenario === 'judge_unavailable' || outcome.hint.scenario === 'judge_failed'))) {
        cache.set(key, { outcome, route: judgment.label() })
      }

      const paths = outcome.status === 'ok' ? outcome.actions.flatMap(a => [...a.paths]) : []
      return {
        status: outcome.status,
        text: renderOutcome(outcome),
        paths,
        ...(outcome.status === 'hint' ? { scenario: outcome.hint.scenario } : {}),
        cached: false,
      }
    },
    presentCall: args => ({ card: 'generic', title: `Hindsight: ${args.intent.slice(0, 60)}`, kind: 'read' }),
  })
}

export async function runTool(
  resolved: ResolvedConfig,
  client: HindsightHttpClient,
  judgePort: JudgePort | undefined,
  input: { intent: string; content?: string; file?: string; target?: string },
  env: ExecutionEnv = { role: null, isReadonly: false },
): Promise<ToolOutcome> {
  if (judgePort === undefined) {
    return {
      status: 'hint',
      hint: {
        scenario: 'judge_unavailable',
        diagnosis: 'No judge port provided',
        suggestedAction: 'Provide a valid JudgePort',
      },
      completed: [],
    }
  }
  return executeToolInput(input, resolved.core, client, judgePort, env)
}
