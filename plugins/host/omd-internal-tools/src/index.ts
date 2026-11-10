/**
 * `omd-internal-tools` — the single judge-routed resource entry, the
 * `dsh-resource://tools/` catalog, and the prompt mask that makes one entry
 * enough.
 *
 * The model sees one small surface: `resource` plus the passthrough
 * baseline (`read`, `write`, `edit`, `bash` by default; Config-owned). Every
 * other model-facing tool name is hidden from the assembled prompt and direct
 * calls to it are denied by a guard whose message names the described
 * `dsh-resource://tools/.../invoke` path to use instead. The hidden tools
 * still exist in the registry with their original definitions, guards,
 * approvals, and sandbox policies; the catalog reads them through
 * `tools.schemas(agent)`/`tools.get(name, agent)` so the scoped capability
 * contract is preserved, and an invocation writes JSON arguments to the
 * invocation path, which executes through `ctx.tools.execute` — the same
 * guarded pipeline the model would have used.
 *
 * Judge contract (omp-hindsight as the authority): every action goes through
 * `ctx.judgment`; the judge is a reasoning peer, so its state explains the
 * situation, the surfaces, their owners, and the consequences of each choice
 * rather than listing bare labels. Content bytes never enter judge state.
 * Decisions are cached by hash of (intent, path, meta, catalog-version).
 * Below the confidence gate the entry returns an unresolved receipt with a
 * HINT-style next-call suggestion instead of guessing. Exact inventory reads
 * (roster, descriptions, schemas, capabilities) are served directly from
 * `dsh-resource://` paths without a judge call, as hindsight does for
 * system-meta reads.
 *
 * Self-disable: when the `resource` entry cannot register (no judgment
 * service, no internalPaths), the plugin neither filters the prompt nor
 * installs the guard, and logs a warning instead — a half-installed surface
 * would leave the model with no way to act.
 *
 * @module omd-internal-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionResult, ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { InternalExec, InternalPathsService, InternalSource } from 'omd-internal-paths'
import { performTextEdit } from 'omd-internal-paths'
import type { PromptPresentation } from '@deepseek-ai/dsh-system-prompt'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import z from '@deepseek-ai/schemastery'

export const name = 'omd-internal-tools'

/** Services required before this plugin's fiber activates. */
export const inject = ['tools', 'internalPaths']

/** Tools whose internal-address dispatch replaces the filesystem implementation. */
const BRIDGED = ['write', 'edit'] as const

/** Unforgeable host set of authorized nested invocation tokens. */
const authorizedInvocations = new WeakSet<symbol>()

/** Tools whose write target must never be an internal resource address. */
const INTERNAL_WRITE_TOOLS = new Set(['write', 'edit', 'note'])

/** Canonical internal paths addressed by the `tools` source. */
const TOOLS_GRAMMAR = [
  'dsh-resource://tools — tool catalog for the calling agent',
  'dsh-resource://tools/<sessionId> — explicitly named session catalog (browser-safe)',
  'dsh-resource://tools/<sessionId>/<tool>/description.md — described tool purpose',
  'dsh-resource://tools/<sessionId>/<tool>/schema.json — current scoped tool schema',
  'dsh-resource://tools/<sessionId>/<tool>/invoke — write JSON arguments to invoke through normal guards',
].join('; ')

/** A tool as the catalog sees it. */
interface ToolCatalogEntry {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  /** Whether the model can call this name directly, or must reach it through `resource`. */
  readonly direct: boolean
}

/** Minimal structural face of the optional judgment service. */
interface JudgmentService {
  available(): boolean
  label(): string
  judge(request: unknown, options?: { signal?: AbortSignal }): Promise<unknown>
}

/** A settled judge decision, cached by request hash. */
interface JudgeDecision {
  readonly cardinality: string
  readonly family: string
  readonly target: string
  readonly specialization: string
  readonly confidence: number
  readonly api: string
  readonly provider: string
  readonly model: string
  readonly label: string
}

/** A cache entry with a time-to-live. */
interface CacheEntry {
  readonly expires: number
  readonly decision: JudgeDecision
}

/** The JSON receipt returned by the universal `resource` entry; matches its output schema. */
interface ResourceReceipt {
  status: 'ok' | 'unresolved' | 'error'
  path?: string
  operation?: string
  outcome?: string
  hint?: string
  reason?: string
  toolResult?: {
    tool?: string
    value?: unknown
    content?: unknown[]
    meta?: unknown
    concludesTurn?: boolean
  }
  cache?: 'hit' | 'miss'
  judge?: Record<string, JsonValue>
}

/** Narrow one loose receipt to the declared union so every return typechecks. */
function receipt(value: {
  status: 'ok' | 'unresolved' | 'error'
  path?: string
  operation?: string
  outcome?: string
  hint?: string
  reason?: string
  toolResult?: {
    tool?: string
    value?: unknown
    content?: unknown[]
    meta?: unknown
    concludesTurn?: boolean
  }
  cache?: 'hit' | 'miss'
  judge?: Record<string, JsonValue>
}): ResourceReceipt {
  return value
}

/** Deployment settings. */
export interface Config {
  /** Model-facing name of the single judge-routed resource entry. */
  toolName: string
  /** Tool names the model may still call directly while everything else is hidden. */
  passthrough: string[]
  /** Minimum judge confidence required before any action executes. */
  confidenceGate: number
  /** Judge decision cache lifetime in milliseconds. */
  cacheTtlMs: number
}

/** Schemastery configuration. */
export const Config: z<Config> = z.object({
  toolName: z.string().default('resource').description('Model-facing name of the single judge-routed resource entry.'),
  passthrough: z.array(z.string()).default(['read', 'write', 'edit', 'bash', 'hindsight'])
    .description('Tool names the model may still call directly; everything else model-facing is hidden and reachable through the resource entry.'),
  confidenceGate: z.number().min(0).max(1).default(0.35)
    .description('Judge answers below this confidence return an unresolved receipt instead of executing.'),
  cacheTtlMs: z.number().step(1).min(1000).default(300000)
    .description('How long one judge decision is reused, in milliseconds.'),
})

/** Whether a path is owned by the internal-path service. */
function isInternalAddress(service: InternalPathsService, address: string): boolean {
  if (/^file:\/\//iu.test(address)) return false
  if (/^dsh-resource:/iu.test(address)) return true
  if (service.resolve(address) !== undefined) return true
  return service.sources().some(source => address.startsWith(`${source.source}://`))
}

/** Whether an address represents an exact inventory or system-meta read that bypasses judgment. */
function isDirectInventoryRead(address: string): boolean {
  if (!address) return true
  const trimmed = address.trim()
  if (trimmed === 'dsh-resource://' || trimmed === 'dsh-resource:///' || trimmed === 'dsh-resource:') return true
  if (/^dsh-resource:\/\/tools(?:\/|$)/u.test(trimmed)) return true
  if (/^hindsight:\/\/(?:plugin\/config|queue)?$/u.test(trimmed)) return true
  if (trimmed.endsWith('/description.md') || trimmed.endsWith('/schema.json')) return true
  return false
}

/** Pick one field out of an object without trusting its prototype. */
function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  return Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, unknown>)[key] : undefined
}

/** Convert an unknown value into a one-line model-safe diagnostic. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The execution object passed into an internal path provider. */
async function internalExecFor(ctx: Context, exec: { signal: AbortSignal; agent?: Agent }): Promise<InternalExec> {
  const workingDirectory = ctx.get('workingDirectory') as { ensure(agent: Agent, signal: AbortSignal): Promise<string> } | undefined
  const cwd = exec.agent === undefined || workingDirectory === undefined
    ? undefined
    : await workingDirectory.ensure(exec.agent, exec.signal).catch(() => undefined)
  return {
    signal: exec.signal,
    origin: 'model',
    ...exec.agent === undefined ? {} : { agent: exec.agent, sessionId: String(exec.agent.session.id) },
    ...(exec as { judged?: boolean }).judged ? { judged: true } : {},
    ...cwd === undefined ? {} : { cwd },
  }
}

/** Resolve an explicit session id to its live agent, or fail closed. */
function agentForSession(ctx: Context, sessionId: string): Agent {
  const agents = ctx.get('agents') as { list(): Agent[] } | undefined
  if (agents === undefined) throw new Error('cannot resolve a session tool catalog: no agent registry is mounted')
  const candidate = agents.list().find(agent => String(agent.session.id) === sessionId)
  if (candidate === undefined) throw new Error(`no live session ${JSON.stringify(sessionId)}; name a session that is live in this host`)
  return candidate
}

/** Scope-sensitive tool catalog for one agent, marking direct visibility. */
function toolCatalog(ctx: Context, agent: Agent | undefined, passthrough: ReadonlySet<string>): ToolCatalogEntry[] {
  const tools = (agent === undefined ? ctx.get('tools') : agent.ctx.get('tools')) as ToolRuntime | undefined
  if (tools === undefined) throw new Error('cannot read the tool catalog: no tool registry is mounted')
  return tools.schemas(agent).map(schema => ({
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
    direct: passthrough.has(schema.name) || schema.name === 'run_code',
  }))
}

/** Split a tools source path into its session, tool, and requested file. */
function parseToolsPath(path: string): { sessionId?: string; tool?: string; file?: string } {
  const parts = path.replace(/^\/+/u, '').split('/').filter(part => part.length > 0)
  return { sessionId: parts[0], tool: parts[1], file: parts[2] }
}

/** A described directory of the agent's tools. */
function describeTools(sessionId: string, tools: readonly ToolCatalogEntry[]): string {
  const lines = [
    `# Tool catalog for session ${sessionId}`,
    '',
    'Each name links to a description, a schema, and a guarded invocation path. Tools marked `hidden` are not on the model surface: reach them through the `resource` entry or write JSON arguments to their invoke path.',
    '',
  ]
  for (const tool of tools) {
    const visibility = tool.direct ? 'direct' : 'hidden (model surface); use the resource entry or this invoke path'
    lines.push(`- **${tool.name}** [${visibility}] — ${tool.description || 'No description supplied.'}`)
    lines.push(`  - \`dsh-resource://tools/${sessionId}/${tool.name}/description.md\` (read-only)`)
    lines.push(`  - \`dsh-resource://tools/${sessionId}/${tool.name}/schema.json\` (read-only)`)
    lines.push(`  - \`dsh-resource://tools/${sessionId}/${tool.name}/invoke\` (writable: JSON arguments; executes through normal guards)`)
  }
  return lines.join('\n')
}

/** One per-tool metadata file. */
function describeTool(tool: ToolCatalogEntry, file: string | undefined): string {
  if (file === 'schema.json' || file === 'schema') {
    return JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters, direct: tool.direct }, null, 2)
  }
  if (file === 'description.md' || file === 'description' || file === undefined || file === '') {
    const capability = tool.direct
      ? 'Capabilities: the model calls this tool directly; metadata reads stay available here.'
      : 'Capabilities: NOT on the model surface. Reach it through the resource entry, or write JSON arguments to the invoke path — execution runs through the same guarded pipeline with approvals and sandbox policy intact.'
    return [
      `# ${tool.name}`,
      '',
      tool.description || 'No description supplied.',
      '',
      capability,
    ].join('\n')
  }
  throw new Error(`cannot read "dsh-resource://tools/.../${file}": expected description.md, schema.json, or invoke`)
}

/** The source registered as `dsh-resource://tools`. */
function toolsSource(ctx: Context, config: Config, cache: Map<string, CacheEntry>, passthrough: ReadonlySet<string>): InternalSource {
  return {
    grammar: TOOLS_GRAMMAR,
    description: 'Agent-scoped model tool catalog: described tools, scoped schemas, and guarded invocation paths. Browser reads require an explicit session id. A tool unavailable to the calling agent never appears here and cannot be invoked.',
    live: true,
    async read(path, exec) {
      const parts = parseToolsPath(path)
      const targetSessionId = exec.sessionId ?? parts.sessionId
      const agent = exec.agent ?? (targetSessionId === undefined ? undefined : agentForSession(ctx, targetSessionId))
      if (agent === undefined) {
        throw new Error('cannot read "dsh-resource://tools": no calling agent; a browser listing must resolve an explicitly named session (dsh-resource://tools/<sessionId>)')
      }
      const sessionId = String(agent.session.id)
      const catalog = toolCatalog(ctx, agent, passthrough)
      if (path === '' || path === '/' || path === sessionId || path === `${sessionId}/`) {
        return describeTools(sessionId, catalog)
      }
      if (parts.sessionId !== sessionId) {
        throw new Error(`the tool catalog for ${JSON.stringify(parts.sessionId ?? '')} is not readable from session ${JSON.stringify(sessionId)}`)
      }
      const tool = catalog.find(entry => entry.name === parts.tool)
      if (tool === undefined) {
        throw new Error(`tool ${JSON.stringify(parts.tool ?? '')} is not available in session ${JSON.stringify(sessionId)}; read dsh-resource://tools/${sessionId} for the catalog`)
      }
      return describeTool(tool, parts.file)
    },
    async write(path, content, exec) {
      const parts = parseToolsPath(path)
      if (parts.file !== 'invoke') throw new Error(`only an /invoke path accepts JSON arguments; "dsh-resource://tools/${path}" is read-only`)
      if (parts.sessionId === undefined || parts.sessionId === '') throw new Error('an invocation must name an explicit session')
      const agent = exec.agent ?? agentForSession(ctx, parts.sessionId)
      if (String(agent.session.id) !== parts.sessionId) {
        throw new Error(`session ${JSON.stringify(String(agent.session.id))} cannot invoke a tool for ${JSON.stringify(parts.sessionId)}`)
      }
      const tools = agent.ctx.get('tools') as ToolRuntime | undefined
      if (tools === undefined) throw new Error('cannot invoke a tool: no tool registry is mounted')
      const toolName = parts.tool ?? ''
      if (toolName === config.toolName || toolName === 'resource') {
        throw new Error('cannot invoke resource through resource')
      }
      if (INTERNAL_WRITE_TOOLS.has(toolName)) {
        const target = typeof field(safeJson(content), 'file_path') === 'string'
          ? String(field(safeJson(content), 'file_path'))
          : typeof field(safeJson(content), 'path') === 'string' ? String(field(safeJson(content), 'path')) : ''
        if (isInternalAddress((ctx.get('internalPaths') as InternalPathsService), target)) {
          throw new Error(`invoking ${toolName} with an internal resource address would recurse through the resource bridge; use the resource entry directly or write to dsh-resource:// paths`)
        }
      }
      const tool = tools.get(toolName, agent)
      if (tool === undefined) throw new Error(`tool ${JSON.stringify(toolName)} is not available in session ${JSON.stringify(parts.sessionId)}`)
      const args = safeJson(content)
      if (args === undefined) throw new Error(`cannot invoke ${toolName}: arguments must be valid JSON`)
      if ((exec as { judged?: boolean }).judged !== true) {
        const judgment = ctx.get('judgment') as JudgmentService | undefined
        if (judgment === undefined || !judgment.available()) {
          throw new Error(`cannot invoke tool "${toolName}": judge is unavailable and direct invocation cannot bypass the judge`)
        }
        await judgeAction(ctx, config, cache, {
          action: 'invoke',
          path: `dsh-resource://tools/${parts.sessionId}/${toolName}/invoke`,
          intent: `Invoke tool ${toolName} for session ${parts.sessionId}`,
          exec,
      })
      }
      const token = Symbol(`resource-invoke-${toolName}`)
      authorizedInvocations.add(token)
      try {
      const result = await tools.execute({
        callId: ToolCallId(`resource-invoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
        name: toolName,
        arguments: args,
        agent,
          parent: token as any,
        signal: exec.signal ?? new AbortController().signal,
      })
        const envelope = {
          isError: result.isError,
          ...result.isError
            ? {
                error: {
                  message: result.error?.message ?? (result.content?.[0] as { text?: string } | undefined)?.text ?? 'unknown error',
                  ...result.error?.info ? { info: result.error.info } : {},
                },
                content: result.content,
                meta: result.meta,
              }
            : {
                value: result.value,
                content: result.content,
                meta: result.meta,
                concludesTurn: result.concludesTurn,
                additionalContexts: result.additionalContexts,
              },
        }
        if (result.isError) {
          throw new Error(`tool ${toolName} failed: ${envelope.error.message}`)
        }
        return JSON.stringify(envelope, null, 2)
      } finally {
        authorizedInvocations.delete(token)
      }
    },
  }
}

/** Parse JSON content, returning undefined instead of throwing. */
function safeJson(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

/** Stable FNV-1a hash of the judge input; content bytes never enter this hash. */
function hashText(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** The pruned catalog the judge sees, with descriptions and capabilities. */
function judgeCatalog(service: InternalPathsService, exec: InternalExec): Array<Record<string, unknown>> {
  return service.sources(exec).map(source => ({
    path: `dsh-resource://${source.source}`,
    description: source.description ?? source.grammar,
    grammar: source.grammar,
    capabilities: source.writable ? ['read', 'write'] : ['read'],
  }))
}

/** The hindsight-shaped tiered question set, answered in one judge call. */
function resourceQuestions(targets: readonly Record<string, unknown>[]) {
  const targetCriteria: Record<string, string> = {
    explicit: 'The intent already names one concrete dsh-resource:// path and the situation gives no reason to reinterpret it; execute that reference as written, with ordinary validation still applying.',
    none: 'No candidate surface can honestly serve the intent; refusing is safer than guessing, and the caller receives an unresolved receipt.',
  }
  for (const target of targets) {
    targetCriteria[String(target.path)] = `Choose this surface when the caller means: ${String(target.description)}. Its executable capabilities are ${JSON.stringify(target.capabilities)}.`
  }
  return {
    intent_cardinality: {
      type: 'choice',
      instructions: 'The session is asking to act on one described internal resource surface. Decide whether this is one concrete action or a compound or unclear request. A compound or unclear request must not trigger a guessed side effect; the caller will be asked to split or clarify it.',
      criteria: {
        one: 'One coherent action can be carried out on one selected surface; the target and operation tiers below then apply.',
        multiple: 'The intent bundles several independent actions, or names several unrelated surfaces that must be handled separately.',
        unclear: 'The intent is too underspecified to know what the caller is trying to accomplish even after considering the candidate descriptions.',
      },
    },
    action_family: {
      type: 'choice',
      instructions: 'Weigh what actually happens under each operation family. Read is a state lookup with no side effect. Write replaces or creates the full content of one writable resource. Edit is a targeted literal-text replacement inside one writable resource. Invoke executes an existing model tool through its normal guards, approvals, and sandbox policy. Inspect asks for exact inventory, capabilities, a description, or a schema — the host already serves those verbatim from dsh-resource:// paths, so picking inspect returns the described path rather than duplicating it. Manage would register or reconfigure sources; that capability is deliberately not exposed.',
      criteria: {
        inspect: 'The caller wants exact inventory, capabilities, a description, or a schema that the host can answer verbatim from a described path.',
        read: 'The caller wants the current content or state of one described resource, with no mutation.',
        write: 'The caller wants to replace or create the full content of one writable resource.',
        edit: 'The caller wants a deterministic literal replacement inside one writable resource.',
        invoke: 'The caller wants to run one existing model tool through its normal scoped guards using JSON arguments.',
        manage: 'The caller wants to register, unregister, or reconfigure sources; this entry does not expose that.',
      },
    },
    target_surface: {
      type: 'choice',
      instructions: 'Choose the surface that owns the requested effect. Prefer an explicit path when the caller supplied one and the situation shows it means that surface; otherwise reason from each surface purpose, its owner, and the operation family. Only an executable candidate may win. Choosing none produces an unresolved receipt, never a guessed mutation.',
      criteria: targetCriteria,
    },
    specialization: {
      type: 'choice',
      instructions: 'Specialize only when meta already fixes a mode or scope; do not invent one. as_written means no extra interpretation is needed. current_session means an omitted session resolves from the calling agent. explicit_session means the path or meta already supplies the exact session. conflict means meta contradicts the path, so execution must refuse rather than silently choose.',
      criteria: {
        as_written: 'No mode or scope hint is present, so the mechanical executor should use the reference exactly as written.',
        current_session: 'Meta asks for the calling agent\'s current session, and no conflicting explicit session is present.',
        explicit_session: 'Meta or the path names a concrete session; preserve it exactly.',
        conflict: 'Meta and the path disagree about session or scope; do not resolve by guessing.',
      },
    },
  }
}

/** Extract one choice answer with its confidence. */
function choiceOf(result: unknown, id: string): { choice: string; confidence: number } {
  const answers = field(result, 'answers')
  const answer = field(answers, id)
  const value = field(answer, 'choice')
  const confidence = field(answer, 'confidence')
  if (typeof value !== 'string') throw new Error(`judge returned no choice for ${id}`)
  return { choice: value, confidence: typeof confidence === 'number' ? confidence : 0 }
}

/** The typed receipt for a judgment miss; never a guess. */
function unresolvedReceipt(reason: string, hint: string, cache: 'hit' | 'miss', judge: Record<string, JsonValue>): ResourceReceipt {
  return { status: 'unresolved', reason, hint, cache, judge }
}

/** Keys in `meta` that route a request instead of becoming tool arguments. */
const ROUTE_KEYS: Record<string, true> = {
  op: true,
  tool: true,
  name: true,
  path: true,
  arguments: true,
  old_string: true,
  new_string: true,
  replace_all: true,
}

/** Normalize meta whether supplied as an object or a JSON string. */
function normalizeMeta(meta: unknown): Record<string, unknown> | undefined {
  if (typeof meta === 'string') {
    const parsed = safeJson(meta)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return undefined
  }
  if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
    return meta as Record<string, unknown>
  }
  return undefined
}

const PAYLOAD_KEYS = new Set(['arguments', 'data', 'content', 'code', 'source', 'payload', 'secret', 'old_string', 'new_string', 'body', 'text'])

/** Strip payload content keys so payload bytes never enter judge state. */
function sanitizeMetaForJudge(meta: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (meta === undefined) return null
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (PAYLOAD_KEYS.has(key)) continue
    sanitized[key] = value
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null
}

/** Judge a single baseline primitive action, throwing on refusal or unavailable judge. */
async function judgeAction(
  ctx: Context,
  config: Config,
  cache: Map<string, CacheEntry>,
  action: { action: string; path?: string; intent: string; exec: { signal?: AbortSignal; agent?: Agent } },
): Promise<void> {
  const judgment = ctx.get('judgment') as JudgmentService | undefined
  if (judgment === undefined || !judgment.available()) {
    throw new Error(`the judge is unavailable; cannot authorize action "${action.action}"`)
  }
  const key = hashText(JSON.stringify({ action: action.action, path: action.path ?? null, intent: action.intent }))
  const hit = cache.get(key)
  const now = Date.now()
  if (hit !== undefined && hit.expires > now) {
    if (hit.decision.confidence < config.confidenceGate || hit.decision.cardinality === 'unclear') {
      throw new Error(`judge confidence below gate (${hit.decision.confidence.toFixed(2)} < ${config.confidenceGate}) for action "${action.action}"`)
    }
    return
  }
  const state = {
    situation: `This session authorizes a baseline ${action.action} action. You are a reasoning peer: verify whether this action is safe and coherent.`,
    intent: action.intent,
    explicit_path: action.path ?? null,
    fixed: { content_isolated: true, actions_always_judged: true },
  }
  const questions = {
    action_authorization: {
      type: 'choice',
      instructions: `Decide whether the requested ${action.action} action is coherent and authorized.`,
      criteria: {
        allow: `The ${action.action} action is coherent and should proceed.`,
        deny: `The action is unsafe, contradictory, or unauthorized.`,
      },
    },
  }
  const result = await judgment.judge({ state, questions }, { signal: action.exec.signal })
  const choice = choiceOf(result, 'action_authorization')
  const decision: JudgeDecision = {
    cardinality: choice.choice === 'allow' ? 'one' : 'unclear',
    family: action.action,
    target: action.path ?? 'system',
    specialization: 'as_written',
    confidence: choice.confidence,
    api: String(field(result, 'api') ?? 'unknown'),
    provider: String(field(result, 'provider') ?? 'unknown'),
    model: String(field(result, 'model') ?? 'unknown'),
    label: judgment.label(),
  }
  cache.set(key, { expires: now + config.cacheTtlMs, decision })
  if (choice.choice === 'deny' || choice.confidence < config.confidenceGate) {
    throw new Error(`judge denied action "${action.action}" (confidence=${choice.confidence.toFixed(2)}, gate=${config.confidenceGate})`)
  }
}

/** The tool name the caller fixed in `meta`, when it named one. */
function toolFromMeta(meta: unknown): string | undefined {
  for (const key of ['op', 'tool', 'name']) {
    const value = field(meta, key)
    if (typeof value === 'string' && /^[a-z][a-z0-9_]*$/iu.test(value)) return value
  }
  return undefined
}

/**
 * Turn whatever the judge chose into one concrete invocation path.
 *
 * The judge may return an explicit address, a candidate carrying the session
 * id, or a template when the caller itself supplied one; the session id and
 * the tool name are host facts, so they are substituted here rather than asked
 * of the model.
 *
 * @param raw - the chosen path, possibly containing placeholders.
 * @param sessionId - the calling session.
 * @param meta - the caller's routing hints.
 * @returns a concrete `/invoke` address, or undefined when no tool is named.
 */
function materializeInvokePath(raw: string | undefined, sessionId: string, meta: unknown): string | undefined {
  const tool = toolFromMeta(meta)
  let path = raw === undefined ? undefined : raw.replaceAll('<sessionId>', sessionId)
  if (path !== undefined && path.includes('<tool>')) {
    if (tool === undefined) return undefined
    path = path.replaceAll('<tool>', tool)
  }
  if (path !== undefined && !path.includes('<') && path.endsWith('/invoke')) return path
  if (tool === undefined) return undefined
  return `dsh-resource://tools/${sessionId}/${tool}/invoke`
}

/**
 * The JSON arguments one invocation carries.
 * @param meta - routing hints, plus any argument fields the caller added.
 * @param content - the payload, used only when `meta` names no argument.
 * @returns the JSON text written to the invoke path.
 */
function invokeArguments(meta: unknown, content: string | undefined): string {
  const explicit = field(meta, 'arguments')
  if (typeof explicit === 'string') return explicit
  if (explicit !== undefined && explicit !== null && typeof explicit === 'object') return JSON.stringify(explicit)
  const bag: Record<string, unknown> = {}
  if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
    for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
      if (ROUTE_KEYS[key] !== true) bag[key] = value
    }
  }
  if (Object.keys(bag).length === 0 && content !== undefined) bag.content = content
  return JSON.stringify(bag)
}

/** Register the single judge-routed resource entry; returns false when it cannot be offered. */
function registerResourceTool(ctx: Context, config: Config, internalPaths: InternalPathsService, cache: Map<string, CacheEntry>, passthrough: ReadonlySet<string>): boolean {
  const judgment = ctx.get('judgment') as JudgmentService | undefined
  // Presence decides registration; a momentarily unavailable judge is a
  // per-call error receipt, not a reason to leave the model with no surface.
  if (judgment === undefined) return false
  const definition = defineTool({
    name: config.toolName,
    description: 'Use one short intent to act on described internal resource paths. '
      + 'Exact inventory, capabilities, descriptions, and schemas are direct reads of dsh-resource:// paths; actions through this entry always go through the judge. '
      + 'Keep payload text in `content` or `meta.data`; content bytes are never shown to the judge. '
      + 'Use `path` for an explicit reference when the caller supplied one, and `meta` only for hints such as op, session, old_string, new_string, or replace_all.',
    parameters: {
      intent: { type: 'string', required: true, description: 'One short natural-language action; content/file bytes never belong here.' },
      path: { type: 'string', description: 'Optional explicit internal resource path; the judge still decides whether to execute it as written.' },
      content: { type: 'string', description: 'Optional payload text; isolated from judge state.' },
      meta: { type: 'json', description: 'Optional JSON hints for ambiguous or specialized requests.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['ok', 'unresolved', 'error'] },
          path: { type: 'string' },
          operation: { type: 'string' },
          outcome: { type: 'string' },
          hint: { type: 'string' },
          reason: { type: 'string' },
          cache: { type: 'string', enum: ['hit', 'miss'] },
          judge: { type: 'object', additionalProperties: true },
          toolResult: { type: 'json' },
        },
      } as const,
      render: (_args, value: ResourceReceipt) => {
        if (value.toolResult?.content && Array.isArray(value.toolResult.content) && value.toolResult.content.length > 0) {
          return value.toolResult.content as any
        }
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
      presentationMeta: (_args, value: ResourceReceipt) => {
        if (value.toolResult?.meta !== undefined && value.toolResult?.meta !== null) {
          return value.toolResult.meta as JsonValue
        }
        return null
      },
    },
    async execute(args, exec) {
      if (!judgment.available()) {
        return receipt({
          status: 'error',
          reason: 'the judge is unavailable, so no action was decided; nothing was executed and no heuristic routing was attempted',
          cache: 'miss',
        })
      }
      const intent = typeof field(args, 'intent') === 'string' ? String(field(args, 'intent')) : ''
      const path = typeof field(args, 'path') === 'string' ? String(field(args, 'path')) : undefined
      const content = typeof field(args, 'content') === 'string' ? String(field(args, 'content')) : undefined
      const meta = normalizeMeta(field(args, 'meta'))
      const sources = judgeCatalog(internalPaths, exec)
      const scopedTools = toolCatalog(ctx, exec.agent, passthrough).filter(tool => !tool.direct)
      const callerSessionId = exec.agent === undefined ? '' : String(exec.agent.session.id)
      const catalog = [
        ...sources,
        // One executable candidate per hidden tool: a template the judge could
        // only echo back is not an option, because nothing downstream can
        // resolve it.
        ...scopedTools.map(tool => ({
          path: `dsh-resource://tools/${callerSessionId}/${tool.name}/invoke`,
          description: `Guarded invocation of the hidden tool "${tool.name}": ${tool.description || 'no description supplied'}`,
          grammar: `dsh-resource://tools/${callerSessionId}/${tool.name}/invoke`,
          capabilities: ['invoke'],
        })),
      ]
      const version = hashText(JSON.stringify({ catalog, hidden: scopedTools.map(tool => tool.name) }))
      const key = hashText(JSON.stringify({ intent, path: path ?? null, routingMeta: sanitizeMetaForJudge(meta), version }))
      const now = Date.now()
      const hit = cache.get(key)
      let decision: JudgeDecision
      let cacheState: 'hit' | 'miss'
      if (hit !== undefined && hit.expires > now) {
        decision = hit.decision
        cacheState = 'hit'
      } else {
        const state = {
          situation: 'This session routes one resource request through the described path convention. You are a reasoning peer: weigh the caller situation, each surface purpose and owner, and the consequence of every choice before answering.',
          intent,
          explicit_path: path ?? null,
          meta: sanitizeMetaForJudge(meta),
          fixed: { content_isolated: true, actions_always_judged: true },
          catalog,
        }
        try {
          const result = await judgment.judge({ state, questions: resourceQuestions(catalog) }, { signal: exec.signal })
          const cardinality = choiceOf(result, 'intent_cardinality')
          const family = choiceOf(result, 'action_family')
          const target = choiceOf(result, 'target_surface')
          const specialization = choiceOf(result, 'specialization')
          decision = {
            cardinality: cardinality.choice,
            family: family.choice,
            target: target.choice,
            specialization: specialization.choice,
            confidence: Math.min(cardinality.confidence, family.confidence, target.confidence, specialization.confidence),
            api: String(field(result, 'api') ?? 'unknown'),
            provider: String(field(result, 'provider') ?? 'unknown'),
            model: String(field(result, 'model') ?? 'unknown'),
            label: judgment.label(),
          }
        } catch (error) {
          return receipt({ status: 'error', reason: `judge failed: ${message(error)}; no heuristic routing was attempted`, cache: 'miss' })
        }
        cache.set(key, { expires: now + config.cacheTtlMs, decision })
        cacheState = 'miss'
      }
      const judgeInfo = {
        label: decision.label,
        api: decision.api,
        provider: decision.provider,
        model: decision.model,
        confidence: decision.confidence,
        gate: config.confidenceGate,
        questionIds: ['intent_cardinality', 'action_family', 'target_surface', 'specialization'],
      }
      if (decision.confidence < config.confidenceGate) {
        return unresolvedReceipt(
          `judge confidence ${decision.confidence.toFixed(2)} is below the gate ${config.confidenceGate}`,
          `HINT: restate one concrete action, naming an explicit dsh-resource:// path or one described surface; current intent ${JSON.stringify(intent)}`,
          cacheState,
          judgeInfo,
        )
      }
      if (decision.cardinality !== 'one' || decision.target === 'none' || decision.specialization === 'conflict'
        || decision.family === 'inspect' || decision.family === 'manage') {
        return unresolvedReceipt(
          `the judge did not authorize an executable action (cardinality=${decision.cardinality}, family=${decision.family}, target=${decision.target}, specialization=${decision.specialization})`,
          'HINT: use a single action with an explicit dsh-resource:// path, or read dsh-resource:// first to inspect the described catalog',
          cacheState,
          judgeInfo,
        )
      }
      let targetPath: string | undefined
      if (decision.target === 'explicit') {
        targetPath = path
      } else if (path !== undefined) {
        const targetSource = decision.target.replace(/^dsh-resource:\/\//u, '').split('/')[0]
        const pathSource = path.startsWith('dsh-resource://')
          ? path.replace(/^dsh-resource:\/\//u, '').split('/')[0]
          : path.split('://')[0]
        if (targetSource === pathSource) {
          targetPath = path
        } else {
          return unresolvedReceipt(
            `explicit path ${JSON.stringify(path)} conflicts with judge-selected surface ${JSON.stringify(decision.target)}`,
            'HINT: align the explicit path with the intended surface or omit path to let the judge select',
            cacheState,
            judgeInfo,
          )
        }
      } else {
        const selected = catalog.find(entry => entry.path === decision.target)
        targetPath = selected === undefined ? undefined : String(selected.path)
      }
      if (targetPath === undefined || targetPath === '') {
        return unresolvedReceipt(
          'the judge selected no executable path',
          'HINT: add `path` with the exact dsh-resource:// address, or name one surface in the intent',
          cacheState,
          judgeInfo,
        )
      }
      const internal = await internalExecFor(ctx, exec)
      ;(internal as any).judged = true
      try {
        let outcome: string
        let parsedToolResult: ResourceReceipt['toolResult']
        if (decision.family === 'read') {
          outcome = String(await internalPaths.read(targetPath, internal))
        } else if (decision.family === 'write') {
          if (content === undefined) {
            return unresolvedReceipt('a write action needs content', 'HINT: put the full payload in `content`; keep the intent short', cacheState, judgeInfo)
          }
          outcome = await internalPaths.write(targetPath, content, internal)
        } else if (decision.family === 'edit') {
          const oldString = typeof field(meta, 'old_string') === 'string' ? String(field(meta, 'old_string')) : ''
          const newString = typeof field(meta, 'new_string') === 'string' ? String(field(meta, 'new_string')) : ''
          outcome = await internalPaths.edit(targetPath, oldString, newString, field(meta, 'replace_all') === true, internal)
        } else if (decision.family === 'invoke') {
          const invokePath = materializeInvokePath(targetPath, callerSessionId, meta)
          if (invokePath === undefined) {
            return unresolvedReceipt(
              'an invoke action needs one concrete tool invocation path',
              'HINT: read dsh-resource://tools/<sessionId>, then name the tool in meta.op or path',
              cacheState,
              judgeInfo,
            )
          }
          const resolved = internalPaths.resolve(invokePath)
          if (resolved === undefined) throw new Error(`no internal source owns ${invokePath}`)
          const payload = invokeArguments(meta, content)
          outcome = await (resolved.provider.write?.(resolved.path, payload, internal)
            ?? Promise.reject(new Error('the invocation source is not writable')))
          const parsedEnvelope = safeJson(outcome) as {
            value?: unknown
            content?: unknown[]
            meta?: unknown
            concludesTurn?: boolean
            additionalContexts?: unknown[]
          } | undefined
          if (parsedEnvelope) {
            if (parsedEnvelope.concludesTurn) exec.concludeTurn?.()
            if (Array.isArray(parsedEnvelope.additionalContexts)) {
              for (const c of parsedEnvelope.additionalContexts) exec.deferContext?.(c as any)
            }
            parsedToolResult = parsedEnvelope
          }
          targetPath = invokePath
        } else {
          return unresolvedReceipt(
            `operation family ${decision.family} has no safe mechanical executor`,
            'HINT: read the described path for metadata, or restate one action on a writable surface',
            cacheState,
            judgeInfo,
          )
        }
        return receipt({ status: 'ok', path: targetPath, operation: decision.family, outcome, cache: cacheState, judge: judgeInfo, toolResult: parsedToolResult })
      } catch (error) {
        return receipt({ status: 'error', path: targetPath, operation: decision.family, reason: message(error), cache: cacheState, judge: judgeInfo })
      }
    },
  })
  ctx.effect(() => ctx.tools.register(definition))
  return true
}

/** The inherited file-write summary, for a bridged write that has no answer of its own. */
function renderOriginalWrite(original: ToolDefinition, args: unknown, value: unknown): string {
  // The inherited renderer reads only the declared write fields, and this value
  // is the write tool's own result object, so the cast names its contract.
  const render = original.output?.render
  const inherited = render?.(args as never, value as never)
  if (Array.isArray(inherited)) {
    const text = inherited
      .map(block => (typeof block === 'object' && block !== null && 'text' in block ? String(block.text) : ''))
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  const path = typeof value === 'object' && value !== null && 'path' in value && typeof value.path === 'string'
    ? value.path
    : ''
  return `${path} written`
}

/** Replace one inherited tool with an internal-path-aware bridge in agent scope. */
function bridgedTool(ctx: Context, original: ToolDefinition, toolName: 'write' | 'edit', config: Config, cache: Map<string, CacheEntry>, internalPaths: InternalPathsService): ToolDefinition {
  return {
    ...original,
    description: `${original.description} An internal resource address (dsh-resource://...) writes that source instead of a file; read the dsh-resource:// root for the source roster and capabilities.`,
    // A source may answer a write (an invocation surface returns what the
    // remote service said). The inherited write schema is a closed set, so the
    // bridge declares the one extra property and renders it in place of the
    // file-shaped summary; an ordinary file write still renders as before.
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'operation', 'before', 'after'],
        properties: {
          path: { type: 'string' },
          operation: { type: 'string', enum: ['create', 'update'] },
          before: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          after: { type: 'string' },
          response: { type: 'string', description: 'What the addressed source answered, when it answers writes.' },
        },
      },
      render: (args: unknown, value: { response?: string, path: string }) => [{
        type: 'text',
        text: typeof value.response === 'string' ? value.response : renderOriginalWrite(original, args, value),
      }],
    },
    async execute(args, exec) {
      const rawPath = typeof field(args, 'file_path') === 'string'
        ? String(field(args, 'file_path'))
        : (typeof field(args, 'path') === 'string' ? String(field(args, 'path')) : '')
      await judgeAction(ctx, config, cache, {
        action: toolName,
        path: rawPath,
        intent: `${toolName === 'write' ? 'Write to' : 'Edit'} ${rawPath}`,
        exec,
      })
      if (!isInternalAddress(internalPaths, rawPath)) {
        return await original.execute(args, exec)
      }
      const internal = await internalExecFor(ctx, exec)
      ;(internal as any).judged = true
      if (toolName === 'write') {
        const content = field(args, 'content')
        if (typeof content !== 'string') throw new Error('content must be a string')
        const before = await internalPaths.read(rawPath, internal).catch(() => null)
        const answer = await internalPaths.write(rawPath, content, internal)
        return {
          path: rawPath,
          operation: before === null ? 'create' : 'update',
          before: typeof before === 'string' ? before : null,
          after: content,
          ...(answer === '' ? {} : { response: answer }),
        }
      }
      const oldString = field(args, 'old_string')
      const newString = field(args, 'new_string')
      if (typeof oldString !== 'string' || typeof newString !== 'string') throw new Error('old_string and new_string must be strings')
      const before = await internalPaths.read(rawPath, internal)
      if (typeof before !== 'string') throw new Error('cannot edit an internal path that returns bytes')
      const after = performTextEdit(before, oldString, newString, field(args, 'replace_all') === true)
      await internalPaths.write(rawPath, after, internal)
      return { path: rawPath, before, after }
    },
  }
}

/** Register one bridge in the nearest agent scope so it shadows the inherited definition. */
function registerBridges(ctx: Context, config: Config, cache: Map<string, CacheEntry>, internalPaths: InternalPathsService): void {
  ctx.on('agent/created', ({ agent }) => {
    const tools = agent.ctx.get('tools') as ToolRuntime | undefined
    if (tools === undefined) return
    for (const toolName of BRIDGED) {
      const original = tools.get(toolName, agent)
      if (original === undefined) continue
      tools.register(bridgedTool(ctx, original, toolName, config, cache, internalPaths))
    }
  })
}

/**
 * Hide every non-passthrough tool from the assembled prompt and deny direct
 * calls with a message naming the resource route. Registered per agent so the
 * mask lives exactly as long as the agent.
 */
function installMask(ctx: Context, config: Config, resourceRegistered: boolean, passthrough: ReadonlySet<string>): void {
  if (!resourceRegistered) return
  const denyDirect = (agent: Agent): void => {
    const tools = agent.ctx.get('tools') as ToolRuntime | undefined
    if (tools === undefined) return
    tools.guard((execution) => {
      if (execution.agent !== agent) return undefined
      if (execution.parent && authorizedInvocations.has(execution.parent as symbol) && execution.agent === agent) {
        return undefined
      }
      if (passthrough.has(execution.name) || execution.name === config.toolName) return undefined
      const route = `dsh-resource://tools/${String(agent.session.id)}/${execution.name}/invoke`
      return `tool "${execution.name}" is not on the model surface; read ${route.replace(/\/invoke$/u, '')} for its description and schema, then reach it through the ${config.toolName} entry or write JSON arguments to ${route}`
    })
    // The assembly hook lives on the context, not on the prompt service: the
    // waterfall is emitted by `ctx`, and an agent-scoped listener sees only
    // that agent's assembly.
    agent.ctx.on('system-prompt/assemble', async (_assembly: PromptPresentation, _context: unknown, next) => {
      const result = await next()
      // The 0.2.2-rc.1 waterfall returns `PromptPresentation` without tools;
      // filter only if a listener upstream attached a tool list anyway.
      const candidate = result as PromptPresentation & { tools?: Array<{ name: string }> }
      if (!Array.isArray(candidate.tools)) return result
      return { ...result, tools: candidate.tools.filter(tool => passthrough.has(tool.name) || tool.name === config.toolName) }
    })
  }
  ctx.on('agent/created', ({ agent }) => (denyDirect(agent), undefined))
  const bootHidden = (ctx.get('tools') as ToolRuntime | undefined)?.schemas().filter(toolName => !passthrough.has(toolName.name) && toolName.name !== config.toolName).length ?? 0
  ctx.logger.warn(`omd-internal-tools: passthrough [${[...passthrough].join(', ')}], ${bootHidden} model-facing tool name(s) hidden behind the ${config.toolName} entry`)
}

/** Publish the source catalog, the tool bridges, the resource entry, and the mask. */
export function apply(ctx: Context, config: Config): void {
  const internalPaths = ctx.internalPaths
  const passthrough = new Set(config.passthrough)

  ctx.provide('internalTools', {
    allowPassthrough(names: string | string[]) {
      const list = Array.isArray(names) ? names : [names]
      const added = list.filter(name => !passthrough.has(name))
      for (const n of added) passthrough.add(n)
      return () => {
        for (const n of added) passthrough.delete(n)
      }
    },
    isPassthrough(toolName: string) {
      return passthrough.has(toolName)
    },
  })

  const cache = new Map<string, CacheEntry>()
  ctx.effect(() => internalPaths.register('tools', toolsSource(ctx, config, cache, passthrough)), 'omd-internal-tools: dsh-resource://tools')
  registerBridges(ctx, config, cache, internalPaths)
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'read') {
      const rawPath = typeof field(exec.arguments, 'file_path') === 'string'
        ? String(field(exec.arguments, 'file_path'))
        : String(field(exec.arguments, 'path') ?? '')
      if (!isDirectInventoryRead(rawPath)) {
        await judgeAction(ctx, config, cache, { action: 'read', path: rawPath, intent: `Read content of ${rawPath}`, exec })
      }
    } else if (exec.name === 'bash') {
      const command = String(field(exec.arguments, 'command') ?? '')
      await judgeAction(ctx, config, cache, { action: 'bash', intent: `Execute shell command: ${command.slice(0, 200)}`, exec })
    }
    return next()
  })

  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => scope.systemPrompt.section({
      name: 'omd:internal-resources',
      order: 82,
      text: (context) => {
        const sources = internalPaths.sources({ agent: context.agent })
        const lines = [
          '# Described Internal Resources & Tools',
          '',
          'All internal tools and data sources are published under `dsh-resource://<source>/<path>`:',
          '- `dsh-resource://` — exact inventory root of all registered sources (direct read)',
        ]
        for (const s of sources) {
          const caps = [s.writable ? 'writable' : 'read-only', s.live ? 'live' : undefined].filter(Boolean).join(', ')
          lines.push(`- \`dsh-resource://${s.source}\` (${caps}): ${s.description ?? s.grammar}`)
        }
        lines.push('')
        lines.push(`Use the \`${config.toolName}\` tool with one short intent to act on any described surface or invoke hidden tools through their \`dsh-resource://tools/<sessionId>/<tool>/invoke\` paths.`)
        lines.push('Exact metadata, schemas, and descriptions are read directly via `read` without a judge call.')
        return lines.join('\n')
      },
    }))
  })

  ctx.effect(() => () => cache.clear(), 'omd-internal-tools: judge decision cache')
  // The judge service may mount after this plugin: sampling `ctx.get` once at
  // load would disable the whole surface for the rest of the process. Wait for
  // the service the way any other dependency is waited for.
  ctx.inject(['judgment'], (scope) => {
    const resourceRegistered = registerResourceTool(scope, config, internalPaths, cache, passthrough)
    if (!resourceRegistered) {
      scope.logger.warn('omd-internal-tools: no judgment service is available; the resource entry, prompt mask, and guard are all disabled and the full tool surface stays visible')
      return
    }
    installMask(scope, config, resourceRegistered, passthrough, dynamicPassthrough)
  })
}
