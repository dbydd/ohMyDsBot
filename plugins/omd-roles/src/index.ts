/**
 * Named model roles: a role is resolved to one model route, and calling a role
 * is one single-turn model call rather than an agent loop.
 *
 * The harness owns exactly one default route (`agentDefaultModel`) and lets a
 * subagent override its route at creation time. Neither answers the question a
 * judge, a summarizer, or a reviewer asks: "run this one prompt on the model I
 * chose for this kind of work, and give me back a value." This service answers
 * it, with an optional JSON schema so a caller can ask for a typed answer
 * without pulling a whole agent loop into the call.
 *
 * Resolution order for one name: an exact entry in `roles`, then each name in
 * `fallback` in order, then the live `agentDefaultModel` selection. A chain
 * that resolves nothing is a configuration error and throws, because silently
 * picking another model would hide the mistake.
 *
 * `roles` is volatile: a caller always reads the current table, so a settings
 * write lands on the next call without remounting the plugin.
 *
 * @module omd-roles
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Named model roles with single-turn calls. */
    modelRoles: ModelRolesService
  }
}

/** One role's route: where a call goes and how much room it gets. */
export interface RoleRoute {
  /** Registered provider route, e.g. `magpie`. */
  provider: string
  /** Provider-owned model id, e.g. `group/decider`. */
  model: string
  /** Adapter-owned reasoning effort; omission follows the provider default. */
  reasoningEffort?: string
  /** Output budget in tokens; omission follows the provider default. */
  maxTokens?: number
}

/** One call to a role. Exactly one of `prompt` and `messages` must be present. */
export interface RoleCallRequest {
  /** Convenience for a one-message conversation; ignored when `messages` is present. */
  prompt?: string
  /** Complete conversation, sent as-is; wins over `prompt`. */
  messages?: unknown[]
  /** When present, the answer must be one JSON value matching this schema. */
  schema?: unknown
  /** Caller cancellation, merged with the configured per-call timeout. */
  signal?: AbortSignal
}

/** What one role call returned. */
export interface RoleCallResult {
  /** The assistant text exactly as generated. */
  text: string
  /** Parsed JSON value when a `schema` was requested. */
  value?: unknown
}

/** The service published as `ctx.modelRoles`. */
export interface ModelRolesService {
  /**
   * Resolve one role name to a route.
   * @param name - role name, e.g. `judge`.
   * @returns the route, falling back through `fallback` and then `agentDefaultModel`.
   * @throws when nothing in the chain resolves.
   */
  get(name: string): RoleRoute
  /** Configured role names, in configuration order. */
  list(): string[]
  /**
   * Run one single-turn model call for a role. With `schema`, an unparseable
   * answer is retried `schemaRetry` times and then thrown, carrying the raw text.
   * @param name - role name.
   * @param request - prompt or messages, optional schema, optional signal.
   * @returns the assistant text and, when a schema was given, its parsed value.
   */
  call(name: string, request: RoleCallRequest): Promise<RoleCallResult>
}

/** Plugin name. */
export const name = 'omd-roles'

/** The model runtime is the only hard requirement; `agentDefaultModel` is read when present. */
export const inject = ['llm']

/** One role's route, as configured. */
const RoleRouteSchema = z.object({
  provider: z.string().required().description('Registered provider route.'),
  model: z.string().required().description('Provider-owned model id.'),
  reasoningEffort: z.string().description('Adapter-owned reasoning effort; omission follows the provider default.'),
  maxTokens: z.natural().description('Output budget in tokens; omission follows the provider default.'),
})

/** Plugin configuration. */
export interface Config {
  /** Route per role name. A call on a role is one single-turn model call. */
  roles: Volatile<Record<string, RoleRoute>>
  /** Role names tried in order when the requested name is absent; an empty result falls back to `agentDefaultModel`. */
  fallback: string[]
  /** Budget in milliseconds for one role call, including every schema retry. */
  timeoutMs: number
  /** Extra attempts after an answer that did not parse as the requested schema; `0` fails on the first. */
  schemaRetry: number
}

export const Config: z<Config> = z.object({
  roles: z.dict(RoleRouteSchema).default({})
    .volatile()
    .description('Route per role name. `call` treats one role as one single-turn model call.'),
  fallback: z.array(z.string()).default(['default'])
    .description('Role names tried in order when the requested name is absent. An empty chain falls back to `agentDefaultModel`.'),
  timeoutMs: z.natural().default(30000)
    .description('Budget in milliseconds for one role call, including every schema retry.'),
  schemaRetry: z.natural().default(1)
    .description('Extra attempts after an answer that did not parse as the requested schema.'),
})

/** Characters of raw model text echoed in a parse failure. */
const EXCERPT_LIMIT = 500

/**
 * The last index of a balanced JSON value starting at `start`.
 * @param text - generated answer.
 * @param start - index of the opening `{` or `[`.
 * @returns the closing index, or -1 when the value never closes.
 */
function balancedEnd(text: string, start: number): number {
  let depth = 0
  let quote: string | undefined
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== undefined) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Read one JSON value out of a generated answer, tolerating a fence or prose
 * around it. Strict parsing comes first so a well-behaved answer is untouched.
 * @param text - generated answer.
 * @returns the parsed value.
 * @throws when no JSON value can be read, carrying an excerpt of the raw text.
 */
function parseJsonAnswer(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {}
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed)
  if (fenced?.[1] !== undefined) {
    try {
      return JSON.parse(fenced[1].trim())
    } catch {}
  }
  const start = trimmed.search(/[[{]/u)
  if (start >= 0) {
    const end = balancedEnd(trimmed, start)
    if (end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1))
      } catch {}
    }
  }
  const excerpt = trimmed.length > EXCERPT_LIMIT ? `${trimmed.slice(0, EXCERPT_LIMIT)}…` : trimmed
  throw new Error(`omd-roles: the answer was not JSON: ${excerpt === '' ? '(empty answer)' : JSON.stringify(excerpt)}`)
}

/**
 * Merge the caller's signal with a fresh per-call timeout.
 * @param signal - caller cancellation, if any.
 * @param timeoutMs - this call's budget.
 * @param name - role name, for the timeout message.
 * @returns the merged signal and a disposer for the timer and listener.
 */
function deadline(signal: AbortSignal | undefined, timeoutMs: number, name: string): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`omd-roles: role "${name}" timed out after ${timeoutMs}ms`)), timeoutMs)
  if (signal === undefined) return { signal: controller.signal, cancel: () => clearTimeout(timer) }
  const forward = (): void => controller.abort(signal.reason instanceof Error ? signal.reason : new Error('omd-roles: call aborted'))
  if (signal.aborted) {
    forward()
    clearTimeout(timer)
    return { signal: controller.signal, cancel: () => {} }
  }
  signal.addEventListener('abort', forward, { once: true })
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', forward)
    },
  }
}

/**
 * Collect one stream's assistant text and terminal outcome.
 * @param stream - the adapter's chunk stream.
 * @returns the text, plus the failure or abort that ended it.
 */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<{ text: string; failure: string | undefined; aborted: boolean }> {
  let text = ''
  let failure: string | undefined
  let aborted = false
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error') failure = chunk.reason.failure.message
      else if (chunk.reason.kind === 'aborted') aborted = true
    }
  }
  return { text, failure, aborted }
}

/**
 * The system prompt that turns an ordinary chat route into a JSON function.
 * @param schema - the caller's JSON Schema.
 * @param strict - whether this is a retry after an unparseable answer.
 * @returns the system prompt.
 */
function schemaSystem(schema: unknown, strict: boolean): string {
  const lines = [
    'Answer with exactly one JSON value and nothing else: no prose and no code fence.',
    'The value must validate against this JSON Schema:',
    JSON.stringify(schema),
  ]
  if (strict) lines.push('The previous answer was not valid JSON. Reply with the JSON value alone.')
  return lines.join('\n')
}

/**
 * Mount the role service.
 * @param ctx - plugin context with `llm`; `agentDefaultModel` is read when mounted.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const llm: LlmRuntime = ctx.llm

  /**
   * Resolve a role name through the fallback chain and the harness default.
   * @param roleName - requested role.
   * @returns the resolved route.
   */
  const resolve = (roleName: string): RoleRoute => {
    if (roleName.trim() === '') throw new Error('omd-roles: a role name must not be empty')
    const table = config.roles.get()
    const exact = table[roleName]
    if (exact !== undefined) return exact
    for (const candidate of config.fallback) {
      const hit = table[candidate]
      if (hit !== undefined) return hit
    }
    const selection = ctx.get('agentDefaultModel')?.currentSelection()
    if (selection !== undefined) {
      return {
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: String(selection.reasoningEffort) },
      }
    }
    throw new Error(
      `omd-roles: no route for role "${roleName}": it is absent from \`roles\`,`
        + ` the fallback chain [${config.fallback.join(', ')}] resolved nothing,`
        + ' and no `agentDefaultModel` is mounted',
    )
  }

  ctx.provide('modelRoles', {
    get: (roleName: string): RoleRoute => resolve(roleName),
    list: (): string[] => Object.keys(config.roles.get()),
    call: async (roleName: string, request: RoleCallRequest): Promise<RoleCallResult> => {
      const route = resolve(roleName)
      if (request.messages === undefined && request.prompt === undefined) {
        throw new Error(`omd-roles: role "${roleName}" needs a \`prompt\` or \`messages\``)
      }
      const messages: RequestMessage[] = request.messages !== undefined
        ? request.messages as RequestMessage[]
        : [createUserMessage({ content: [{ type: 'text', text: request.prompt }], source: { kind: 'user' } })]

      const attempts = request.schema === undefined ? 1 : config.schemaRetry + 1
      const { signal, cancel } = deadline(request.signal, config.timeoutMs, roleName)
      let lastError: Error | undefined
      try {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const stream = llm.stream({
            provider: route.provider,
            model: route.model,
            ...route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) },
            ...route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens },
            ...request.schema === undefined ? {} : { system: schemaSystem(request.schema, attempt > 0) },
            messages,
            signal,
          })
          const collected = await collect(stream)
          if (collected.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error(`omd-roles: role "${roleName}" aborted`)
          }
          if (collected.failure !== undefined) {
            throw new Error(`omd-roles: role "${roleName}" (${route.provider}/${route.model}) failed: ${collected.failure}`)
          }
          if (request.schema === undefined) return { text: collected.text }
          try {
            return { text: collected.text, value: parseJsonAnswer(collected.text) }
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error))
          }
        }
        throw lastError ?? new Error(`omd-roles: role "${roleName}" produced no answer`)
      } finally {
        cancel()
      }
    },
  })
}
