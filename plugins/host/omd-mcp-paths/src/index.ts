/**
 * `omd-mcp-paths` — MCP servers as internal paths instead of model tools.
 *
 * Three verbs, three jobs, one address space:
 *
 * - `read` is documentation: the roster, one server's summary, the tool,
 *   resource, prompt and template listings with their argument and schema
 *   details, and the live subscription state.
 * - `get` fetches a representation: `mcp://<server>/resources/<uri>` returns
 *   that resource's content, with everything after `/resources/` taken as the
 *   uri verbatim.
 * - `post` performs: `mcp://<server>/tools/<tool>` calls the tool and
 *   `mcp://<server>/prompts/<name>` renders the prompt, both with the JSON body
 *   as arguments; `mcp://<server>/templates/<name>` expands a resource template
 *   with that body and reads the resource the expansion names, and
 *   `mcp://<server>/subscriptions` opens or closes a change subscription.
 *
 * Nothing here touches `ctx.tools`, so no `mcp__<server>__<tool>` ever reaches
 * the model surface. Changes arrive by subscription: a modern connection opens
 * a `subscriptions/listen` stream, a legacy one falls back to
 * `resources/subscribe` plus `ClientOptions.listChanged`. A connection
 * supervisor reconnects a down server with exponential backoff and re-opens the
 * streams; periodic list resync is opt-in through `resyncMs`, and every event
 * lands in `mcp://bus`. `watch` pushes those events, and the list changes, to a
 * script. A server-initiated `sampling/createMessage` is answered by the host
 * model when the entry configures a route, and the last exchanges stay readable
 * at `mcp://<server>/sampling`.
 *
 * One server per plugin instance (the same shape upstream `mcp-client` and the
 * ds-bot connector mount), and one `mcp` source shared by all of them.
 *
 * @module omd-mcp-paths
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Client, SdkErrorCode, UriTemplate } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type {
  CallToolResult,
  ClientOptions,
  CreateMessageRequest,
  CreateMessageRequestParams,
  CreateMessageResult,
  McpSubscription,
  ReadResourceResult,
  SamplingMessage,
  SubscriptionFilter,
  Transport,
} from '@modelcontextprotocol/client'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmRuntime, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { InternalExec, InternalSource } from '../../omd-internal-paths/src/index.ts'

/** Plugin id the Loader entry carries. */
export const name = 'omd-mcp-paths'

/** The internal-path registry is the whole surface this plugin publishes. */
export const inject = ['internalPaths']

/** Source name the paths live under. */
const SOURCE = 'mcp'

/** The one address under the source that is not a server: the heartbeat bus. */
const BUS = 'bus'

/** Server names are one path segment and nothing else. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** Events kept per server for `mcp://bus`, newest last. */
const EVENT_LOG = 100

/** Host-model route that answers a server's sampling request. */
export interface SamplingConfig {
  /** Registered provider route, e.g. `magpie`. */
  provider?: string
  /** Provider-owned model id. */
  model?: string
  /** Ceiling on the tokens the model may generate; the server's own budget still applies below it. */
  maxTokens?: number
}

/** Deployment settings for one MCP server. */
export interface Config {
  /** Mount this server at all. Off leaves its paths out of the source. */
  enabled: boolean
  /** Path segment naming this server: `mcp://<serverName>`. */
  serverName: string
  /** How to reach it: a spawned child over stdio, or a Streamable HTTP endpoint. */
  transport: 'stdio' | 'streamable-http'
  /** Executable to spawn under the stdio transport. */
  command?: string
  /** Arguments for that executable. */
  args: string[]
  /** Extra environment layered over the scrubbed parent environment. */
  env: Record<string, string>
  /** Working directory for the spawned server. */
  cwd?: string
  /** Endpoint URL under the Streamable HTTP transport. */
  url?: string
  /** Request headers for the Streamable HTTP transport, e.g. authorization. */
  headers: Record<string, string>
  /** Per-call budget in milliseconds, applied to a tool call, a prompt render and a resource read. */
  toolCallTimeoutMs: number
  /** Whether a failure to connect at load rejects this entry instead of leaving it down. */
  failOnStartupError: boolean
  /** Route that answers sampling; absent means the capability is not advertised. */
  sampling?: SamplingConfig
  /** Sampling exchanges kept per server at `mcp://<server>/sampling`; `0` keeps none. */
  requestLog: number
  /** Interval of the connection supervisor in milliseconds; `0` starts no timer. */
  heartbeatMs: number
  /** Interval between periodic listing resyncs in milliseconds; `0` never resyncs on a timer. */
  resyncMs: number
  /** First reconnect delay in milliseconds; every further failure doubles it. */
  retryBaseMs: number
  /** Cap on the reconnect delay in milliseconds. */
  retryMaxMs: number
}

/** Schemastery configuration for the plugin entry. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true)
    .description('Publish this server under mcp://; off mounts nothing.'),
  serverName: z.string().pattern(SERVER_NAME).required()
    .description('Path segment naming this server: mcp://<serverName>.'),
  transport: z.union(['stdio', 'streamable-http'] as const).default('stdio')
    .description('stdio spawns the server as a child process; streamable-http talks to a URL.'),
  command: z.string()
    .description('Executable to spawn under the stdio transport.'),
  args: z.array(z.string()).default([])
    .description('Arguments passed to the spawned server.'),
  env: z.dict(z.string()).default({})
    .description('Extra environment variables for the spawned server, layered over the scrubbed parent environment.'),
  cwd: z.string()
    .description('Working directory for the spawned server.'),
  url: z.string()
    .description('Endpoint URL under the streamable-http transport.'),
  headers: z.dict(z.string()).default({})
    .description('Request headers for the streamable-http transport; a bearer token belongs here, never in the path.'),
  toolCallTimeoutMs: z.natural().default(60_000)
    .description('Per-call budget in milliseconds for one tool call, prompt render or resource read.'),
  failOnStartupError: z.boolean().default(false)
    .description('Reject this entry when the first connection fails, instead of leaving the server down until a later call or heartbeat retries.'),
  sampling: z.object({
    provider: z.string().description('Registered provider route that answers sampling.'),
    model: z.string().description('Provider-owned model id that answers sampling.'),
    maxTokens: z.natural().description('Ceiling on generated tokens; the server asks for a budget below it in the usual case.'),
  }).default({})
    .description('Host-model route for server-initiated sampling; provider and model together advertise the capability, and an empty block does not.'),
  requestLog: z.natural().default(20)
    .description('Sampling exchanges kept per server at mcp://<server>/sampling; 0 keeps none.'),
  heartbeatMs: z.natural().default(15_000)
    .description('Interval in milliseconds of the connection supervisor, which reconnects a down server and re-opens its change streams; 0 starts no timer.'),
  resyncMs: z.natural().default(0)
    .description('Interval in milliseconds of the periodic listing resync; 0 (the default) leaves refreshes to subscriptions.'),
  retryBaseMs: z.natural().default(1_000)
    .description('First reconnect delay in milliseconds; each further failure doubles it.'),
  retryMaxMs: z.natural().default(60_000)
    .description('Cap on the reconnect delay in milliseconds.'),
})

/** One event in the heartbeat's per-server ring, published at `mcp://bus`. */
export interface BusEvent {
  /** When it happened, ISO 8601. */
  readonly at: string
  /** The server it happened to. */
  readonly server: string
  /** What happened. */
  readonly kind:
    | 'connect'
    | 'connect-failed'
    | 'refresh'
    | 'refresh-failed'
    | 'disconnected'
    | 'sampling'
    | 'notification'
    | 'listen'
    | 'listen-closed'
    | 'subscribe'
    | 'unsubscribe'
  /** Counts on success, the error text on failure. */
  readonly detail?: string
}

/** One sampling exchange, kept so a script can see what the server asked and what was answered. */
export interface SamplingExchange {
  /** When the request arrived, ISO 8601. */
  readonly at: string
  /** The request as the server sent it, with non-text blocks reduced to their type. */
  readonly request: {
    readonly systemPrompt?: string
    readonly maxTokens: number
    readonly temperature?: number
    readonly messages: readonly { readonly role: string, readonly text: string }[]
  }
  /** The host model's answer. */
  readonly answer?: { readonly model: string, readonly text: string, readonly stopReason: string }
  /** Why no answer was produced, when the call failed. */
  readonly error?: string
  /** Wall clock spent on the model call, in milliseconds. */
  readonly latencyMs: number
}

/** The client surface the path source and the connection supervisor call. */
export type McpClient = Pick<
  Client,
  | 'connect'
  | 'close'
  | 'listTools'
  | 'callTool'
  | 'listResources'
  | 'readResource'
  | 'listResourceTemplates'
  | 'listPrompts'
  | 'getPrompt'
  | 'listen'
  | 'subscribeResource'
  | 'unsubscribeResource'
  | 'setNotificationHandler'
  | 'getProtocolEra'
>

/** Answers one `sampling/createMessage` from the server. */
export type SamplingHandler = (request: CreateMessageRequest) => Promise<CreateMessageResult>

/** One tool a server listed, kept so a description read costs no round trip after the first. */
interface McpToolInfo {
  readonly name: string
  readonly description: string
  readonly inputSchema?: unknown
  readonly outputSchema?: unknown
}

/** One resource a server listed. */
interface McpResourceInfo {
  readonly uri: string
  readonly name: string
  readonly description: string
  readonly mimeType?: string
}

/** One prompt a server listed, with the arguments it takes. */
interface McpPromptInfo {
  readonly name: string
  readonly description: string
  readonly arguments: readonly { readonly name: string, readonly description: string, readonly required: boolean }[]
}

/** One resource template a server listed. */
interface McpTemplateInfo {
  readonly uriTemplate: string
  readonly name: string
  readonly description: string
  readonly mimeType?: string
}

/** One open `subscriptions/listen` stream, kept so it can be closed and re-opened. */
interface ListenState {
  readonly subscription: McpSubscription
  readonly honored: SubscriptionFilter
}

/** One configured server as the source sees it. */
export interface ServerEntry {
  readonly config: Config
  /** How this entry builds its client; unset means the SDK client over the configured transport. */
  open?: () => McpClient
  client?: McpClient
  tools?: McpToolInfo[]
  resources?: McpResourceInfo[]
  prompts?: McpPromptInfo[]
  /** Template listing, fetched on demand and dropped by every listing refresh. */
  templates?: McpTemplateInfo[]
  /** Which protocol era the connection negotiated: settled by the client, or by `listen` refusing to run. */
  era: 'unknown' | 'modern' | 'legacy'
  state: 'idle' | 'ready' | 'down'
  lastError?: string
  /** Consecutive failed connections; drives the backoff. */
  retries: number
  /** Earliest epoch millisecond at which a reconnect may run. */
  nextAttempt?: number
  /** Epoch millisecond of the last listing refresh. */
  lastRefresh?: number
  /** The sampling answer this entry installs on its client, when a route is configured. */
  sample?: SamplingHandler
  readonly events: BusEvent[]
  readonly exchanges: SamplingExchange[]
  /** Subscriptions the caller asked for, keyed by `resource:<uri>` or `lists`; survives a reconnection. */
  readonly wanted: Map<string, SubscriptionFilter>
  /** Listen streams live on the current connection, keyed like `wanted`. */
  readonly listens: Map<string, ListenState>
  /** Resource uris the current connection subscribed to, on either era. */
  readonly subscribed: Set<string>
  /** Scripts watching `mcp://<server>/events`. */
  readonly watchers: Set<(event: BusEvent) => void>
  /** Scripts watching one list, by list name. */
  readonly listWatchers: Map<'tools' | 'resources' | 'prompts', Set<() => void>>
  /** One connection attempt at a time, shared by path operations and the ticker. */
  connecting?: Promise<void>
  /** One tick at a time. */
  ticking: boolean
  /** Set by the plugin's disposer so a late close is not reported as a drop. */
  disposed: boolean
}

/** Every configured server in this process, keyed by its path segment. */
const servers = new Map<string, ServerEntry>()

/** The one source registration, shared by every instance. */
let registered: { dispose: () => void, users: number } | undefined

/** A settled listing call: the value, or the error that replaced it. */
interface Settled<T> {
  value?: T
  error?: string
}

/**
 * Build one server entry in its empty state.
 * @param config - validated deployment settings.
 * @returns the entry the source reads.
 */
export function createEntry(config: Config): ServerEntry {
  return {
    config,
    era: 'unknown',
    state: 'idle',
    retries: 0,
    events: [],
    exchanges: [],
    wanted: new Map(),
    listens: new Map(),
    subscribed: new Set(),
    watchers: new Set(),
    listWatchers: new Map(),
    ticking: false,
    disposed: false,
  }
}

/**
 * Build the `mcp` source over one map of server entries.
 * @param entries - the mounted servers, keyed by path segment.
 * @returns the source the registry publishes.
 */
export function createSource(entries: ReadonlyMap<string, ServerEntry>): InternalSource {
  return {
    grammar: 'mcp:// | mcp://bus | mcp://<server> | mcp://<server>/tools[/<tool>] | mcp://<server>/resources[/<uri>] | mcp://<server>/prompts[/<name>] | mcp://<server>/templates[/<name>] | mcp://<server>/subscriptions | mcp://<server>/sampling',
    description: 'MCP servers as paths: read documents servers, tools, resources, prompts, templates and subscriptions; get fetches a resource; post calls a tool, renders a prompt, instantiates a template or changes a subscription; watch streams events and list changes.',
    shorthand: true,
    live: true,
    async read(path, _exec) {
      const parts = segments(path)
      const head = parts[0]
      if (head === undefined) return json({ servers: [...entries.values()].map(rosterRow) })
      if (head === BUS) {
        if (parts.length > 1) throw new Error('mcp://bus has no children: read it for the heartbeat state')
        return json(busState(entries))
      }
      const entry = entryOf(entries, head)
      if (parts.length === 1) return json(serverSummary(entry))
      const section = parts[1] ?? ''
      if (section === 'tools') {
        const tools = await toolsOf(entry)
        if (parts.length === 2) {
          return json({
            server: entry.config.serverName,
            tools: tools.map(tool => ({ name: tool.name, description: firstLine(tool.description) })),
          })
        }
        const toolName = parts.slice(2).join('/')
        const tool = tools.find(candidate => candidate.name === toolName)
        if (tool === undefined) {
          throw new Error(`mcp://${entry.config.serverName} has no tool "${toolName}"; read mcp://${entry.config.serverName}/tools to list them`)
        }
        return json({
          server: entry.config.serverName,
          name: tool.name,
          description: tool.description,
          ...tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema },
          ...tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema },
        })
      }
      if (section === 'resources') {
        if (parts.length > 2) {
          throw new Error(`mcp://${entry.config.serverName}/resources/${parts.slice(2).join('/')} is a representation, not a listing: GET it`)
        }
        return json({
          server: entry.config.serverName,
          resources: (await resourcesOf(entry)).map(resource => ({
            uri: resource.uri,
            name: resource.name,
            description: firstLine(resource.description),
            ...resource.mimeType === undefined ? {} : { mimeType: resource.mimeType },
          })),
        })
      }
      if (section === 'prompts') {
        const prompts = await promptsOf(entry)
        if (parts.length === 2) {
          return json({
            server: entry.config.serverName,
            prompts: prompts.map(prompt => ({
              name: prompt.name,
              description: firstLine(prompt.description),
              arguments: prompt.arguments,
            })),
          })
        }
        const promptName = parts.slice(2).join('/')
        const prompt = prompts.find(candidate => candidate.name === promptName)
        if (prompt === undefined) {
          throw new Error(`mcp://${entry.config.serverName} has no prompt "${promptName}"; read mcp://${entry.config.serverName}/prompts to list them`)
        }
        return json({
          server: entry.config.serverName,
          name: prompt.name,
          description: prompt.description,
          arguments: prompt.arguments,
        })
      }
      if (section === 'templates') {
        const templates = await templatesOf(entry)
        if (parts.length === 2) {
          return json({
            server: entry.config.serverName,
            templates: templates.map(template => ({
              name: template.name,
              uriTemplate: template.uriTemplate,
              description: firstLine(template.description),
              ...template.mimeType === undefined ? {} : { mimeType: template.mimeType },
            })),
          })
        }
        const templateName = parts.slice(2).join('/')
        const template = templates.find(candidate => candidate.name === templateName)
        if (template === undefined) {
          throw new Error(`mcp://${entry.config.serverName} has no template "${templateName}"; read mcp://${entry.config.serverName}/templates to list them`)
        }
        return json({
          server: entry.config.serverName,
          name: template.name,
          uriTemplate: template.uriTemplate,
          description: template.description,
          ...template.mimeType === undefined ? {} : { mimeType: template.mimeType },
          variables: variablesOf(template.uriTemplate),
          instantiate: `POST mcp://${entry.config.serverName}/templates/${template.name}`,
        })
      }
      if (section === 'subscriptions') {
        if (parts.length > 2) throw new Error('mcp://<server>/subscriptions has no children: post a body to it')
        return json(subscriptionsState(entry))
      }
      if (section === 'sampling') {
        if (parts.length > 2) throw new Error('mcp://<server>/sampling has no children')
        const route = samplingRoute(entry.config)
        return json({
          server: entry.config.serverName,
          route: route ?? 'unavailable',
          capacity: entry.config.requestLog,
          requests: entry.exchanges,
        })
      }
      throw new Error(`mcp://${entry.config.serverName} has no "${section}": read tools, resources, prompts, templates, subscriptions or sampling`)
    },
    async get(path, exec) {
      const rest = path.trim().replace(/^\/+/u, '')
      const slash = rest.indexOf('/')
      if (slash <= 0) throw new Error('GET needs a resource address: mcp://<server>/resources/<uri>')
      const entry = entryOf(entries, rest.slice(0, slash))
      const remainder = rest.slice(slash + 1)
      if (remainder === 'resources') {
        throw new Error(`mcp://${entry.config.serverName}/resources is a listing, not a representation: read it, or GET one of its uris`)
      }
      if (!remainder.startsWith('resources/')) {
        throw new Error(`GET fetches resources only: mcp://${entry.config.serverName}/resources/<uri>; read mcp://${entry.config.serverName}/${remainder.split('/')[0] ?? ''} for its documentation`)
      }
      const uri = remainder.slice('resources/'.length)
      if (uri === '') throw new Error(`mcp://${entry.config.serverName}/resources/ needs a uri after it`)
      const client = await clientOf(entry)
      const result = await client.readResource({ uri }, {
        signal: exec.signal,
        timeout: entry.config.toolCallTimeoutMs,
        cacheMode: 'refresh',
      })
      return renderResource(entry, uri, result)
    },
    async post(path, content, exec) {
      const parts = segments(path)
      const head = parts[0]
      if (head === undefined) throw new Error('POST needs a tool, a prompt, a template or a subscription: mcp://<server>/tools/<tool> | mcp://<server>/prompts/<name> | mcp://<server>/templates/<name> | mcp://<server>/subscriptions')
      if (head === BUS) throw new Error('mcp://bus is read-only')
      const entry = entryOf(entries, head)
      const section = parts[1]
      if (section === 'tools') {
        const tool = parts.slice(2).join('/')
        if (tool === '') throw new Error(`mcp://${entry.config.serverName}/tools needs a tool name after it`)
        return await callTool(entry, tool, content, exec)
      }
      if (section === 'prompts') {
        const promptName = parts.slice(2).join('/')
        if (promptName === '') throw new Error(`mcp://${entry.config.serverName}/prompts needs a prompt name after it`)
        return await renderPrompt(entry, promptName, content, exec)
      }
      if (section === 'templates') {
        const templateName = parts.slice(2).join('/')
        if (templateName === '') throw new Error(`mcp://${entry.config.serverName}/templates needs a template name after it`)
        return await instantiateTemplate(entry, templateName, content, exec)
      }
      if (section === 'subscriptions') {
        if (parts.length > 2) throw new Error('mcp://<server>/subscriptions has no children: post a body to it')
        return await updateSubscriptions(entry, content)
      }
      if (section === 'resources') {
        throw new Error(`mcp://${entry.config.serverName}/resources/${parts.slice(2).join('/')} is a representation, not an action: GET it`)
      }
      throw new Error(`mcp://${entry.config.serverName} has no POST endpoint "${section ?? ''}": post to tools/<tool>, prompts/<name>, templates/<name> or subscriptions`)
    },
    watch(path, exec) {
      const parts = segments(path)
      const head = parts[0]
      if (head === undefined) throw new Error('mcp:// has no change stream: watch mcp://<server>/events or one of its lists')
      if (head === BUS) throw new Error('mcp://bus has no change stream: watch mcp://<server>/events instead')
      const entry = entryOf(entries, head)
      const section = parts[1]
      if (parts.length !== 2) {
        throw new Error(`mcp://${entry.config.serverName}/${parts.slice(1).join('/')} has no change stream`)
      }
      if (section === 'events') {
        return pushed<string>(emit => {
          const watcher = (event: BusEvent): void => { emit(line(event)) }
          entry.watchers.add(watcher)
          return () => { entry.watchers.delete(watcher) }
        }, exec.signal)
      }
      if (section === 'tools' || section === 'resources' || section === 'prompts') {
        const list = section
        return pushed<string>(emit => {
          const watcher = (): void => {
            emit(line({ at: new Date().toISOString(), server: entry.config.serverName, list, count: counts(entry)[list] }))
          }
          const watchers = listWatchersOf(entry, list)
          watchers.add(watcher)
          return () => { watchers.delete(watcher) }
        }, exec.signal)
      }
      throw new Error(`mcp://${entry.config.serverName} has no change stream at "${section ?? ''}": watch events, tools, resources or prompts`)
    },
  }
}

/**
 * Connect one server, then refresh its listings.
 * @param entry - the server's configuration and the client slot to fill.
 */
async function connect(entry: ServerEntry): Promise<void> {
  const { config } = entry
  const client: McpClient = entry.open?.() ?? createClient(entry)
  try {
    await client.connect(createTransport(config))
  } catch (error) {
    await client.close().catch(() => {})
    markDown(entry, error, 'connect-failed')
    throw error instanceof Error ? error : new Error(String(error))
  }
  entry.client = client
  entry.retries = 0
  entry.nextAttempt = undefined
  entry.era = client.getProtocolEra() ?? 'unknown'
  entry.listens.clear()
  entry.subscribed.clear()
  // Registered after the handshake so it cannot collide with the list-change
  // handlers the SDK installs for `ClientOptions.listChanged` at connect time.
  client.setNotificationHandler('notifications/resources/updated', notification => {
    record(entry, 'notification', `resources/updated ${notification.params.uri}`)
  })
  record(entry, 'connect', config.transport)
  await refresh(entry, client)
  // A connection that died during the refresh already recorded itself as down;
  // the listing error, when there is one, stays on `lastError` for the caller.
  if (entry.client === client) entry.state = 'ready'
  if (entry.client === client) await restoreSubscriptions(entry, client)
}

/**
 * Build the SDK client for one entry, installing the sampling handler when a
 * route is configured: the capability is advertised in the handshake, so a
 * server without it never sends a sampling request it would have to wait on.
 * @param entry - the server.
 * @returns the client, before `connect`.
 */
function createClient(entry: ServerEntry): Client {
  const handler = entry.sample
  const options: ClientOptions = {
    capabilities: handler === undefined ? {} : { sampling: {} },
    versionNegotiation: { mode: 'auto' },
    // The SDK refreshes the list itself under `autoRefresh`; here the refresh
    // has to go through this module so the caches and the watchers stay in step.
    listChanged: {
      tools: { autoRefresh: false, debounceMs: 0, onChanged: () => changed(entry, 'tools') },
      prompts: { autoRefresh: false, debounceMs: 0, onChanged: () => changed(entry, 'prompts') },
      resources: { autoRefresh: false, debounceMs: 0, onChanged: () => changed(entry, 'resources') },
    },
  }
  const client = new MonitoredClient(options, () => dropped(entry))
  if (handler !== undefined) {
    client.setRequestHandler('sampling/createMessage', async request => await handler(request))
  }
  return client
}

/**
 * A client that reports its own close, because the SDK owns the transport's
 * `onclose` after `connect` and a server that exits is exactly the state the
 * heartbeat must see.
 */
class MonitoredClient extends Client {
  readonly #closed: () => void

  constructor(options: ClientOptions, closed: () => void) {
    super({ name: 'omd-mcp-paths', version: '0.1.0' }, options)
    this.#closed = closed
  }

  protected override _onclose(): void {
    super._onclose()
    this.#closed()
  }
}

/**
 * Drop the cached client after the connection closed on its own.
 * @param entry - the server whose client closed.
 */
function dropped(entry: ServerEntry): void {
  if (entry.disposed || entry.client === undefined) return
  markDown(entry, new Error('connection closed'), 'disconnected')
}

/**
 * Build the transport for one server.
 * @param config - the validated plugin configuration.
 * @returns the transport the SDK client connects over.
 */
function createTransport(config: Config): Transport {
  if (config.transport === 'stdio') {
    if (config.command === undefined || config.command === '') {
      throw new Error('omd-mcp-paths: the stdio transport needs command')
    }
    return new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      env: { ...scrubbedEnv(), ...config.env },
      ...config.cwd === undefined ? {} : { cwd: config.cwd },
    })
  }
  if (config.url === undefined || config.url === '') {
    throw new Error('omd-mcp-paths: the streamable-http transport needs url')
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: { ...config.headers } },
  })
}

/**
 * The parent environment minus credential-shaped names, so a spawned server
 * cannot inherit a key the profile never granted it.
 * @returns the environment a child server receives before its own overrides.
 */
function scrubbedEnv(): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|^DSH_/iu.test(key)) continue
    kept[key] = value
  }
  return kept
}

/**
 * Refresh the three cached listings on one live client. A failing listing is
 * recorded rather than thrown: the connection is up, and only the supervisor
 * owns reconnection. A list that comes back different wakes its watchers, and
 * the template cache is dropped for the next read to refill.
 * @param entry - the server.
 * @param client - its live client.
 */
async function refresh(entry: ServerEntry, client: McpClient): Promise<void> {
  if (entry.client !== client) return
  const before = fingerprint(entry)
  entry.templates = undefined
  const [tools, resources, prompts] = await Promise.all([
    settle(() => client.listTools(undefined, { cacheMode: 'refresh' })),
    settle(() => client.listResources(undefined, { cacheMode: 'refresh' })),
    settle(() => client.listPrompts(undefined, { cacheMode: 'refresh' })),
  ])
  if (tools.value !== undefined) {
    entry.tools = tools.value.tools.map(tool => ({
      name: tool.name,
      description: tool.description ?? '',
      ...tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema },
      ...tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema },
    }))
  }
  if (resources.value !== undefined) {
    entry.resources = resources.value.resources.map(resource => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description ?? '',
      ...resource.mimeType === undefined ? {} : { mimeType: resource.mimeType },
    }))
  }
  if (prompts.value !== undefined) {
    entry.prompts = prompts.value.prompts.map(prompt => ({
      name: prompt.name,
      description: prompt.description ?? '',
      arguments: (prompt.arguments ?? []).map(argument => ({
        name: argument.name,
        description: argument.description ?? '',
        required: argument.required === true,
      })),
    }))
  }
  const after = fingerprint(entry)
  for (const list of LISTS) {
    if (before[list] === after[list]) continue
    for (const watcher of entry.listWatchers.get(list) ?? []) watcher()
  }
  entry.lastRefresh = Date.now()
  const failures = [tools.error, resources.error, prompts.error].filter((failure): failure is string => failure !== undefined)
  if (failures.length > 0) {
    entry.lastError = failures.join('; ')
    record(entry, 'refresh-failed', entry.lastError)
    return
  }
  entry.lastError = undefined
  record(entry, 'refresh', `tools=${entry.tools?.length ?? 0} resources=${entry.resources?.length ?? 0} prompts=${entry.prompts?.length ?? 0}`)
}

/**
 * Run one listing, capturing its failure instead of throwing it.
 * @param call - the SDK call.
 * @returns the value, or the error text.
 */
async function settle<T>(call: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { value: await call() }
  } catch (error) {
    return { error: message(error) }
  }
}

/**
 * The live client for one server, connecting on demand.
 * @param entry - the server.
 * @returns the connected client.
 */
async function clientOf(entry: ServerEntry): Promise<McpClient> {
  const live = entry.client
  if (live !== undefined) return live
  const pending = entry.connecting ?? (entry.connecting = connect(entry))
  try {
    await pending
  } catch (error) {
    throw new Error(`omd-mcp-paths: server "${entry.config.serverName}" could not connect: ${message(error)}`)
  } finally {
    if (entry.connecting === pending) entry.connecting = undefined
  }
  const connected = entry.client
  if (connected === undefined) {
    throw new Error(`omd-mcp-paths: server "${entry.config.serverName}" is not connected${entry.lastError === undefined ? '' : `: ${entry.lastError}`}`)
  }
  return connected
}

/**
 * A server's tool list, fetching everything once when the cache is still empty.
 * @param entry - the server.
 * @returns its tools, in the server's own order.
 */
async function toolsOf(entry: ServerEntry): Promise<McpToolInfo[]> {
  if (entry.tools === undefined) await refresh(entry, await clientOf(entry))
  if (entry.tools === undefined) throw unlisted(entry, 'tools')
  return entry.tools
}

/**
 * A server's resource list, fetching everything once when the cache is still empty.
 * @param entry - the server.
 * @returns its resources, in the server's own order.
 */
async function resourcesOf(entry: ServerEntry): Promise<McpResourceInfo[]> {
  if (entry.resources === undefined) await refresh(entry, await clientOf(entry))
  if (entry.resources === undefined) throw unlisted(entry, 'resources')
  return entry.resources
}

/**
 * A server's prompt list, fetching everything once when the cache is still empty.
 * @param entry - the server.
 * @returns its prompts, in the server's own order.
 */
async function promptsOf(entry: ServerEntry): Promise<McpPromptInfo[]> {
  if (entry.prompts === undefined) await refresh(entry, await clientOf(entry))
  if (entry.prompts === undefined) throw unlisted(entry, 'prompts')
  return entry.prompts
}

/**
 * A server's template list. Not part of the periodic refresh: a server that
 * offers no templates answers `resources/templates/list` with an error, which
 * would otherwise turn every refresh into a recorded failure. Every listing
 * refresh drops this cache, so a resource list change still refetches on the
 * next read.
 * @param entry - the server.
 * @returns its templates, in the server's own order.
 */
async function templatesOf(entry: ServerEntry): Promise<McpTemplateInfo[]> {
  const cached = entry.templates
  if (cached !== undefined) return cached
  const client = await clientOf(entry)
  const result = await client.listResourceTemplates(undefined, { cacheMode: 'refresh' })
  entry.templates = result.resourceTemplates.map(template => ({
    uriTemplate: template.uriTemplate,
    name: template.name,
    description: template.description ?? '',
    ...template.mimeType === undefined ? {} : { mimeType: template.mimeType },
  }))
  return entry.templates
}

/**
 * Instantiate one resource template: expand it with the request body, then read
 * the resource the expansion names. The answer is that resource's own
 * representation, never the template text.
 * @param entry - the server holding the template.
 * @param templateName - the template name as the server spelled it.
 * @param content - JSON object of variables.
 * @param exec - the calling execution, carrying cancellation.
 * @returns the resource representation.
 */
async function instantiateTemplate(entry: ServerEntry, templateName: string, content: string, exec: InternalExec): Promise<string> {
  const address = `mcp://${entry.config.serverName}/templates/${templateName}`
  const template = (await templatesOf(entry)).find(candidate => candidate.name === templateName)
  if (template === undefined) {
    throw new Error(`mcp://${entry.config.serverName} has no template "${templateName}"; read mcp://${entry.config.serverName}/templates to list them`)
  }
  const uri = expandTemplate(template.uriTemplate, parseArguments(content, address), address)
  const client = await clientOf(entry)
  const result = await client.readResource({ uri }, {
    signal: exec.signal,
    timeout: entry.config.toolCallTimeoutMs,
    cacheMode: 'refresh',
  })
  return renderResource(entry, uri, result)
}

/**
 * The variable names one uriTemplate declares.
 * @param uriTemplate - the template as the server wrote it.
 * @returns the names, in the order the template mentions them.
 */
export function variablesOf(uriTemplate: string): string[] {
  return new UriTemplate(uriTemplate).variableNames
}

/**
 * Expand one uriTemplate with a body of variables. The template's own names are
 * the contract: a body key it does not declare is refused, and so is a declared
 * name the body leaves out, because an omitted variable silently produces a
 * different resource than the caller asked for.
 * @param uriTemplate - the template as the server wrote it.
 * @param values - the request body.
 * @param address - the address, for the error text.
 * @returns the uri to read.
 */
function expandTemplate(uriTemplate: string, values: Record<string, unknown>, address: string): string {
  const template = new UriTemplate(uriTemplate)
  const declared = template.variableNames
  for (const key of Object.keys(values)) {
    if (declared.includes(key)) continue
    throw new Error(`${address} has no variable "${key}"; ${declared.length === 0 ? 'this template takes none' : `it takes ${declared.join(', ')}`}`)
  }
  const missing = declared.filter(name => !(name in values))
  if (missing.length > 0) throw new Error(`${address} needs ${missing.join(', ')} for ${uriTemplate}`)
  const filled: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string') throw new Error(`${address} expects string variable "${key}"`)
    filled[key] = value
  }
  return template.expand(filled)
}

/**
 * Answer a `subscriptions` POST: subscribe a resource, unsubscribe it, or open
 * and close the list-change subscription.
 * @param entry - the server.
 * @param content - the JSON body naming what to change.
 * @returns the resulting subscription state.
 */
async function updateSubscriptions(entry: ServerEntry, content: string): Promise<string> {
  const address = `mcp://${entry.config.serverName}/subscriptions`
  const forms = '{"resource":"<uri>"}, {"resource":"<uri>","remove":true} and {"lists":true}'
  const body = parseArguments(content, address)
  for (const key of Object.keys(body)) {
    if (key !== 'resource' && key !== 'remove' && key !== 'lists') {
      throw new Error(`${address} accepts ${forms}; got key "${key}"`)
    }
  }
  const { resource, remove, lists } = body
  if (resource !== undefined) {
    if (lists !== undefined) throw new Error(`${address} takes "resource" or "lists", not both; accepted: ${forms}`)
    if (typeof resource !== 'string' || resource === '') throw new Error(`${address} needs "resource" as a non-empty uri string; accepted: ${forms}`)
    if (remove !== undefined && typeof remove !== 'boolean') throw new Error(`${address} takes "remove" as true or false`)
    return remove === true ? await unsubscribe(entry, resource) : await subscribe(entry, resource)
  }
  if (lists !== undefined) {
    if (remove !== undefined) throw new Error(`${address} pairs "remove" with "resource" only; accepted: ${forms}`)
    if (typeof lists !== 'boolean') throw new Error(`${address} takes "lists" as true or false; accepted: ${forms}`)
    return lists ? await subscribeLists(entry) : await unsubscribeLists(entry)
  }
  throw new Error(`${address} needs a body: ${forms}`)
}

/**
 * Subscribe one resource, on whichever era the connection uses.
 * @param entry - the server.
 * @param uri - the resource uri.
 * @returns the resulting subscription state.
 */
async function subscribe(entry: ServerEntry, uri: string): Promise<string> {
  const key = `resource:${uri}`
  if (entry.wanted.has(key)) return json({ ...subscriptionsState(entry), status: 'already-subscribed', key })
  const client = await clientOf(entry)
  const filter: SubscriptionFilter = { resourceSubscriptions: [uri] }
  entry.wanted.set(key, filter)
  const opened = await settle(() => openListen(entry, client, key, filter))
  if (opened.error !== undefined) {
    entry.wanted.delete(key)
    throw new Error(`mcp://${entry.config.serverName}/subscriptions could not subscribe ${uri}: ${opened.error}`)
  }
  record(entry, 'subscribe', uri)
  return json({ ...subscriptionsState(entry), status: 'subscribed', key })
}

/**
 * Drop one resource subscription.
 * @param entry - the server.
 * @param uri - the resource uri.
 * @returns the resulting subscription state.
 */
async function unsubscribe(entry: ServerEntry, uri: string): Promise<string> {
  const key = `resource:${uri}`
  if (!entry.wanted.delete(key)) return json({ ...subscriptionsState(entry), status: 'not-subscribed', key })
  const live = entry.listens.get(key)
  entry.listens.delete(key)
  const subscribed = entry.subscribed.delete(uri)
  if (live !== undefined) await live.subscription.close()
  else if (subscribed) await (await clientOf(entry)).unsubscribeResource({ uri })
  record(entry, 'unsubscribe', uri)
  return json({ ...subscriptionsState(entry), status: 'unsubscribed', key })
}

/**
 * Open the list-change subscription the request names.
 * @param entry - the server.
 * @returns the resulting subscription state.
 */
async function subscribeLists(entry: ServerEntry): Promise<string> {
  if (entry.wanted.has('lists')) return json({ ...subscriptionsState(entry), status: 'already-subscribed', key: 'lists' })
  const client = await clientOf(entry)
  const filter: SubscriptionFilter = { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true }
  entry.wanted.set('lists', filter)
  const opened = await settle(() => openListen(entry, client, 'lists', filter))
  if (opened.error !== undefined) {
    entry.wanted.delete('lists')
    throw new Error(`mcp://${entry.config.serverName}/subscriptions could not open the list subscription: ${opened.error}`)
  }
  return json({ ...subscriptionsState(entry), status: 'subscribed', key: 'lists' })
}

/**
 * Close the list-change subscription.
 * @param entry - the server.
 * @returns the resulting subscription state.
 */
async function unsubscribeLists(entry: ServerEntry): Promise<string> {
  if (!entry.wanted.delete('lists')) return json({ ...subscriptionsState(entry), status: 'not-subscribed', key: 'lists' })
  const live = entry.listens.get('lists')
  entry.listens.delete('lists')
  if (live !== undefined) await live.subscription.close()
  record(entry, 'unsubscribe', 'lists')
  return json({ ...subscriptionsState(entry), status: 'unsubscribed', key: 'lists' })
}

/**
 * Open the stream for one wanted subscription, on the era the connection uses.
 * A modern connection keeps a `subscriptions/listen` stream; a legacy one
 * subscribes the resource outright and leaves list delivery to the client's
 * `listChanged` handlers, which is where that era puts unsolicited changes.
 * @param entry - the server.
 * @param client - its live client.
 * @param key - the wanted key.
 * @param filter - what the caller asked to be told about.
 */
async function openListen(entry: ServerEntry, client: McpClient, key: string, filter: SubscriptionFilter): Promise<void> {
  if (entry.era === 'legacy') {
    await legacyListen(entry, client, key, filter)
    return
  }
  try {
    const subscription = await client.listen(filter)
    entry.era = 'modern'
    entry.listens.set(key, { subscription, honored: subscription.honoredFilter })
    for (const uri of filter.resourceSubscriptions ?? []) entry.subscribed.add(uri)
    record(entry, 'listen', `${key} honored ${filterDetail(subscription.honoredFilter)}`)
    void subscription.closed.then(reason => { listenEnded(entry, key, subscription, reason) })
  } catch (error) {
    if (!unsupportedMethod(error)) throw error
    entry.era = 'legacy'
    await legacyListen(entry, client, key, filter)
  }
}

/**
 * The legacy half of {@link openListen}: `resources/subscribe` for the uris, and
 * nothing to open for the lists, because `ClientOptions.listChanged` already
 * carries those on this era.
 * @param entry - the server.
 * @param client - its live client.
 * @param key - the wanted key.
 * @param filter - what the caller asked to be told about.
 */
async function legacyListen(entry: ServerEntry, client: McpClient, key: string, filter: SubscriptionFilter): Promise<void> {
  const uris = filter.resourceSubscriptions ?? []
  for (const uri of uris) {
    await client.subscribeResource({ uri })
    entry.subscribed.add(uri)
  }
  const lists = listFlags(filter)
  record(entry, 'listen', lists.length > 0
    ? `${key} delivered through ClientOptions.listChanged (${lists.join(', ')})`
    : `${key} subscribed through resources/subscribe`)
}

/**
 * Record the end of one listen stream and forget it, so the supervisor can
 * re-open it on the wanted filter.
 * @param entry - the server.
 * @param key - the wanted key.
 * @param subscription - the stream that ended.
 * @param reason - how it ended.
 */
function listenEnded(entry: ServerEntry, key: string, subscription: McpSubscription, reason: 'local' | 'graceful' | 'remote'): void {
  if (entry.listens.get(key)?.subscription !== subscription) return
  entry.listens.delete(key)
  record(entry, 'listen-closed', `${key} ${reason}`)
}

/**
 * Re-open every wanted subscription the current connection does not hold. Run
 * after a reconnection and by the supervisor, so a stream the server ended on
 * its own also comes back.
 * @param entry - the server.
 * @param client - its live client.
 */
async function restoreSubscriptions(entry: ServerEntry, client: McpClient): Promise<void> {
  for (const [key, filter] of entry.wanted) {
    if (entry.listens.has(key)) continue
    const uri = key.startsWith('resource:') ? key.slice('resource:'.length) : undefined
    if (entry.era === 'legacy' && uri !== undefined && entry.subscribed.has(uri)) continue
    const opened = await settle(() => openListen(entry, client, key, filter))
    if (opened.error !== undefined) record(entry, 'listen', `${key} could not be re-opened: ${opened.error}`)
  }
}

/**
 * The subscription state `read mcp://<server>/subscriptions` reports.
 * @param entry - the server.
 * @returns era, what was asked for, what the server honored, and the counts.
 */
function subscriptionsState(entry: ServerEntry): Record<string, unknown> {
  return {
    server: entry.config.serverName,
    era: entry.era,
    listens: [...entry.listens].map(([key, live]) => ({
      key,
      requested: entry.wanted.get(key) ?? null,
      honored: live.honored,
    })),
    subscribedResources: [...entry.subscribed],
    counts: {
      listens: entry.listens.size,
      resources: entry.subscribed.size,
      eventWatchers: entry.watchers.size,
      listWatchers: [...entry.listWatchers.values()].reduce((total, watchers) => total + watchers.size, 0),
    },
    ...entry.era === 'legacy' && entry.wanted.has('lists')
      ? { listChanges: 'delivered through ClientOptions.listChanged; the server must advertise <list>.listChanged' }
      : {},
    ...entry.era === 'unknown'
      ? { note: 'the era is settled when the first listen stream opens; post {"lists":true} or {"resource":"<uri>"}' }
      : {},
  }
}

/**
 * Whether an error is the SDK saying this protocol era has no
 * `subscriptions/listen`, which is the signal to use the legacy path.
 * @param error - the thrown value.
 * @returns true when the method is missing for the negotiated version.
 */
function unsupportedMethod(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return error.code === SdkErrorCode.MethodNotSupportedByProtocolVersion
}

/**
 * The filter's list flags, named for the event detail.
 * @param filter - a subscription filter.
 * @returns the flags that are on.
 */
function listFlags(filter: SubscriptionFilter): string[] {
  const flags: string[] = []
  if (filter.toolsListChanged === true) flags.push('tools')
  if (filter.promptsListChanged === true) flags.push('prompts')
  if (filter.resourcesListChanged === true) flags.push('resources')
  return flags
}

/**
 * A subscription filter in one line, for the event ring.
 * @param filter - the honored filter.
 * @returns the flag names plus the subscribed uris.
 */
function filterDetail(filter: SubscriptionFilter): string {
  const parts = listFlags(filter).map(name => `${name}.listChanged`)
  const uris = filter.resourceSubscriptions ?? []
  if (uris.length > 0) parts.push(`resources=${uris.join(',')}`)
  return parts.length === 0 ? 'nothing' : parts.join(' ')
}

/**
 * Why a listing is still unavailable after a fetch.
 * @param entry - the server.
 * @param what - the listing name.
 * @returns the error to throw.
 */
function unlisted(entry: ServerEntry, what: string): Error {
  return new Error(`omd-mcp-paths: server "${entry.config.serverName}" did not list its ${what}${entry.lastError === undefined ? '' : `: ${entry.lastError}`}`)
}

/**
 * Look a server up by its path segment.
 * @param entries - the mounted servers.
 * @param name - the segment as written.
 * @returns the entry.
 */
function entryOf(entries: ReadonlyMap<string, ServerEntry>, name: string): ServerEntry {
  const entry = entries.get(name)
  if (entry === undefined) {
    const known = [...entries.keys()].join(', ') || 'none'
    throw new Error(`mcp:// has no server "${name}"; configured: ${known}`)
  }
  return entry
}

/**
 * One tool call through the path surface.
 * @param entry - the server holding the tool.
 * @param tool - the tool name as the server spelled it.
 * @param content - JSON arguments; an empty body means no arguments.
 * @param exec - the calling execution, carrying cancellation.
 * @returns the server's result as JSON text.
 */
async function callTool(entry: ServerEntry, tool: string, content: string, exec: InternalExec): Promise<string> {
  const client = await clientOf(entry)
  const args = parseArguments(content, `mcp://${entry.config.serverName}/tools/${tool}`)
  const result: CallToolResult = await client.callTool(
    { name: tool, arguments: args },
    { signal: exec.signal, timeout: entry.config.toolCallTimeoutMs },
  )
  return json({
    server: entry.config.serverName,
    tool,
    ...result.isError === true ? { isError: true } : {},
    content: result.content,
    ...result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent },
  })
}

/**
 * Render one prompt through the path surface.
 * @param entry - the server holding the prompt.
 * @param promptName - the prompt name as the server spelled it.
 * @param content - JSON arguments keyed by the prompt's argument names.
 * @param exec - the calling execution, carrying cancellation.
 * @returns the rendered messages as JSON text.
 */
async function renderPrompt(entry: ServerEntry, promptName: string, content: string, exec: InternalExec): Promise<string> {
  const address = `mcp://${entry.config.serverName}/prompts/${promptName}`
  const args = promptArguments(content, address)
  const client = await clientOf(entry)
  const result = await client.getPrompt(
    { name: promptName, ...args === undefined ? {} : { arguments: args } },
    { signal: exec.signal, timeout: entry.config.toolCallTimeoutMs },
  )
  return json({
    server: entry.config.serverName,
    name: promptName,
    ...result.description === undefined ? {} : { description: result.description },
    messages: result.messages,
  })
}

/**
 * Render one resource read for the path surface: a text body is returned as
 * text, anything else as the envelope that carries its bytes and type.
 * @param entry - the server the resource belongs to.
 * @param uri - the uri as written after `/resources/`.
 * @param result - the SDK's read result.
 * @returns the representation.
 */
function renderResource(entry: ServerEntry, uri: string, result: ReadResourceResult): string {
  const [only] = result.contents
  if (result.contents.length === 1 && only !== undefined) {
    if ('text' in only) return only.text
    return json({
      server: entry.config.serverName,
      uri: only.uri,
      ...only.mimeType === undefined ? {} : { mimeType: only.mimeType },
      blob: only.blob,
    })
  }
  return json({
    server: entry.config.serverName,
    uri,
    contents: result.contents.map(part => ({
      uri: part.uri,
      ...part.mimeType === undefined ? {} : { mimeType: part.mimeType },
      ...'text' in part ? { text: part.text } : { blob: part.blob },
    })),
  })
}

/**
 * Parse a request body as a JSON object of tool or prompt arguments.
 * @param content - the body.
 * @param address - the address, for the error text.
 * @returns the arguments object; an empty body means no arguments.
 */
function parseArguments(content: string, address: string): Record<string, unknown> {
  if (content.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new Error(`${address} expects a JSON object body: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${address} expects a JSON object body`)
  }
  return parsed as Record<string, unknown>
}

/**
 * Parse a prompt render body; MCP prompt arguments are strings.
 * @param content - the body.
 * @param address - the address, for the error text.
 * @returns the arguments, or undefined for an empty body.
 */
function promptArguments(content: string, address: string): Record<string, string> | undefined {
  const raw = parseArguments(content, address)
  const args: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') throw new Error(`${address} expects string argument "${key}"`)
    args[key] = value
  }
  return Object.keys(args).length === 0 ? undefined : args
}

/**
 * The sampling route this entry answers on, when it advertises one.
 * @param config - the entry's configuration.
 * @returns the route, or undefined when the capability stays off.
 */
function samplingRoute(config: Config): { provider: string, model: string, maxTokens?: number } | undefined {
  const route = config.sampling
  if (route?.provider === undefined || route.model === undefined) return undefined
  return {
    provider: route.provider,
    model: route.model,
    ...route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens },
  }
}

/**
 * Build the handler that runs one sampling request on the host model.
 * @param ctx - the plugin context, read for `llm` at call time.
 * @param entry - the server, for the exchange log.
 * @param route - the configured sampling route.
 * @returns the handler installed on the SDK client.
 */
export function buildSampler(ctx: Context, entry: ServerEntry, route: { provider: string, model: string, maxTokens?: number }): SamplingHandler {
  return async request => {
    const params = request.params
    const at = new Date().toISOString()
    const started = Date.now()
    const logged = {
      ...params.systemPrompt === undefined ? {} : { systemPrompt: params.systemPrompt },
      maxTokens: params.maxTokens,
      ...params.temperature === undefined ? {} : { temperature: params.temperature },
      messages: params.messages.map(message => ({ role: message.role, text: exchangeText(message.content) })),
    }
    try {
      const messages = toRequestMessages(params.messages, route)
      const llm: LlmRuntime | undefined = ctx.get('llm')
      if (llm === undefined) throw new Error('omd-mcp-paths: sampling needs the llm service, which is not mounted')
      const text = await generate(llm, route, params, messages)
      pushExchange(entry, {
        at,
        request: logged,
        answer: { model: route.model, text, stopReason: 'endTurn' },
        latencyMs: Date.now() - started,
      })
      return { model: route.model, role: 'assistant', content: { type: 'text', text }, stopReason: 'endTurn' }
    } catch (error) {
      pushExchange(entry, { at, request: logged, error: message(error), latencyMs: Date.now() - started })
      throw error
    }
  }
}

/**
 * Run one sampling request on the host model as a single-turn call.
 * @param llm - the model runtime.
 * @param route - the configured route.
 * @param params - the server's request parameters.
 * @param messages - the conversation, already converted.
 * @returns the assistant text.
 */
async function generate(
  llm: LlmRuntime,
  route: { provider: string, model: string, maxTokens?: number },
  params: CreateMessageRequestParams,
  messages: RequestMessage[],
): Promise<string> {
  const stream: AsyncIterable<StreamChunk> = llm.stream({
    provider: route.provider,
    model: route.model,
    messages,
    ...params.systemPrompt === undefined ? {} : { system: params.systemPrompt },
    ...params.temperature === undefined ? {} : { temperature: params.temperature },
    maxTokens: Math.min(params.maxTokens, route.maxTokens ?? params.maxTokens),
  })
  let text = ''
  let failure: string | undefined
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      failure = chunk.reason.failure.message
    }
  }
  if (failure !== undefined) throw new Error(`omd-mcp-paths: sampling failed: ${failure}`)
  return text
}

/**
 * Convert MCP sampling messages into the messages one model call takes.
 * @param messages - the server's conversation.
 * @param route - the route that will answer, whose identity tags assistant turns.
 * @returns the host-model request messages.
 */
function toRequestMessages(
  messages: readonly SamplingMessage[],
  route: { provider: string, model: string },
): RequestMessage[] {
  return messages.map(message => {
    const content: ContentBlock[] = [{ type: 'text', text: samplingText(message.content) }]
    return message.role === 'assistant'
      ? createAssistantMessage({ content, source: { provider: route.provider, model: route.model } })
      : createUserMessage({ content, source: { kind: 'user' } })
  })
}

/**
 * The text of one sampling message; anything but text is refused, because the
 * other block types have no attachment behind them here.
 * @param content - one block or a list of them.
 * @returns the joined text.
 */
function samplingText(content: SamplingMessage['content']): string {
  const blocks = Array.isArray(content) ? content : [content]
  return blocks.map(block => {
    if (block.type !== 'text') {
      throw new Error(`omd-mcp-paths: sampling supports text content only, got "${block.type}"`)
    }
    return block.text
  }).join('\n')
}

/**
 * The same message, reduced for the exchange log without ever throwing.
 * @param content - one block or a list of them.
 * @returns the joined text, with non-text blocks named by type.
 */
function exchangeText(content: SamplingMessage['content']): string {
  const blocks = Array.isArray(content) ? content : [content]
  return blocks.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n')
}

/**
 * Append one exchange to the server's log, trimmed to `requestLog`.
 * @param entry - the server.
 * @param exchange - what was asked and answered.
 */
function pushExchange(entry: ServerEntry, exchange: SamplingExchange): void {
  entry.exchanges.push(exchange)
  const capacity = Math.max(0, entry.config.requestLog)
  if (entry.exchanges.length > capacity) entry.exchanges.splice(0, entry.exchanges.length - capacity)
  record(entry, 'sampling', exchange.error ?? `${exchange.answer?.model ?? 'model'} ${exchange.latencyMs}ms`)
}

/**
 * One row of the `mcp://` roster.
 * @param entry - the server.
 * @returns name, transport, state and listing counts.
 */
function rosterRow(entry: ServerEntry): unknown {
  return {
    name: entry.config.serverName,
    transport: entry.config.transport,
    state: entry.state,
    tools: entry.tools?.length ?? null,
    resources: entry.resources?.length ?? null,
    prompts: entry.prompts?.length ?? null,
    ...entry.lastError === undefined ? {} : { error: entry.lastError },
  }
}

/**
 * One server's own documentation at `mcp://<server>`.
 * @param entry - the server.
 * @returns its settings, state and child addresses.
 */
function serverSummary(entry: ServerEntry): unknown {
  const server = entry.config.serverName
  return {
    server,
    transport: entry.config.transport,
    state: entry.state,
    era: entry.era,
    heartbeatMs: entry.config.heartbeatMs,
    resyncMs: entry.config.resyncMs,
    sampling: samplingRoute(entry.config) ?? 'unavailable',
    counts: counts(entry),
    subscriptions: { listens: entry.listens.size, resources: entry.subscribed.size },
    lastRefresh: iso(entry.lastRefresh),
    nextAttempt: iso(entry.nextAttempt),
    ...entry.lastError === undefined ? {} : { error: entry.lastError },
    paths: {
      tools: `mcp://${server}/tools`,
      resources: `mcp://${server}/resources`,
      prompts: `mcp://${server}/prompts`,
      templates: `mcp://${server}/templates`,
      subscriptions: `mcp://${server}/subscriptions`,
      events: `mcp://${server}/events`,
      sampling: `mcp://${server}/sampling`,
    },
  }
}

/**
 * The heartbeat's published state.
 * @param entries - the mounted servers.
 * @returns per-server state plus the recent events, newest first.
 */
function busState(entries: ReadonlyMap<string, ServerEntry>): unknown {
  const all = [...entries.values()]
  const events = all.flatMap(entry => entry.events).sort((left, right) => right.at.localeCompare(left.at))
  return {
    at: new Date().toISOString(),
    servers: all.map(entry => ({
      name: entry.config.serverName,
      state: entry.state,
      era: entry.era,
      heartbeatMs: entry.config.heartbeatMs,
      resyncMs: entry.config.resyncMs,
      retries: entry.retries,
      lastError: entry.lastError ?? null,
      nextAttempt: iso(entry.nextAttempt),
      lastRefresh: iso(entry.lastRefresh),
      counts: counts(entry),
    })),
    events: events.slice(0, EVENT_LOG),
  }
}

/**
 * One supervisor tick: reconnect a down server whose backoff has elapsed,
 * re-open subscriptions the connection lost, and — only when `resyncMs` asks
 * for it — refresh listings that subscriptions cannot keep current. A
 * connection attempt already in flight is left alone. Exported so a host that
 * sets `heartbeatMs` to `0` can drive the supervisor on its own schedule.
 * @param entry - the server.
 */
export async function tick(entry: ServerEntry): Promise<void> {
  if (entry.ticking || entry.disposed) return
  entry.ticking = true
  try {
    const live = entry.client
    if (live !== undefined) {
      await restoreSubscriptions(entry, live)
      const resyncMs = entry.config.resyncMs
      if (resyncMs > 0 && Date.now() >= (entry.lastRefresh ?? 0) + resyncMs) await refresh(entry, live)
      return
    }
    if (entry.nextAttempt !== undefined && Date.now() < entry.nextAttempt) return
    try {
      await clientOf(entry)
    } catch {
      // connect() already recorded the failure and its next attempt.
    }
  } finally {
    entry.ticking = false
  }
}

/**
 * Record a connection loss or a failed attempt: drop the client, count the
 * failure, and schedule the next attempt behind an exponential backoff.
 * @param entry - the server.
 * @param error - what went wrong.
 * @param kind - the event kind.
 */
function markDown(entry: ServerEntry, error: unknown, kind: 'connect-failed' | 'disconnected'): void {
  const text = message(error)
  entry.client = undefined
  entry.listens.clear()
  entry.subscribed.clear()
  entry.state = 'down'
  entry.lastError = text
  entry.retries += 1
  entry.nextAttempt = Date.now() + backoff(entry.config, entry.retries)
  record(entry, kind, text)
}

/**
 * The delay before attempt `retries`, doubling from the base and capped.
 * @param config - the entry's configuration.
 * @param retries - consecutive failures so far.
 * @returns milliseconds.
 */
function backoff(config: Config, retries: number): number {
  const base = Math.max(1, config.retryBaseMs)
  const ceiling = Math.max(base, config.retryMaxMs)
  return Math.min(base * 2 ** Math.max(0, retries - 1), ceiling)
}

/**
 * Append one event to the server's ring.
 * @param entry - the server.
 * @param kind - what happened.
 * @param detail - counts on success, the error on failure.
 */
function record(entry: ServerEntry, kind: BusEvent['kind'], detail?: string): void {
  const event: BusEvent = {
    at: new Date().toISOString(),
    server: entry.config.serverName,
    kind,
    ...detail === undefined ? {} : { detail },
  }
  entry.events.push(event)
  if (entry.events.length > EVENT_LOG) entry.events.splice(0, entry.events.length - EVENT_LOG)
  for (const watcher of entry.watchers) watcher(event)
}

/**
 * Report a list change the client's `listChanged` handler saw: record it, then
 * refresh, which is where the cached list and the list watchers actually move.
 * @param entry - the server.
 * @param list - which list changed.
 */
function changed(entry: ServerEntry, list: 'tools' | 'resources' | 'prompts'): void {
  record(entry, 'notification', `${list}/list_changed`)
  const live = entry.client
  if (live === undefined) return
  void refresh(entry, live)
}

/**
 * The three list names that have watchers and a change fingerprint.
 * @returns the names.
 */
const LISTS = ['tools', 'resources', 'prompts'] as const

/**
 * What each cached listing holds, as one comparable string per list.
 * @param entry - the server.
 * @returns the fingerprints.
 */
function fingerprint(entry: ServerEntry): Record<'tools' | 'resources' | 'prompts', string> {
  return {
    tools: JSON.stringify(entry.tools ?? null),
    resources: JSON.stringify(entry.resources ?? null),
    prompts: JSON.stringify(entry.prompts ?? null),
  }
}

/**
 * The listing counts one server reports.
 * @param entry - the server.
 * @returns counts, or null where the list has not been fetched.
 */
function counts(entry: ServerEntry): Record<'tools' | 'resources' | 'prompts' | 'templates', number | null> {
  return {
    tools: entry.tools?.length ?? null,
    resources: entry.resources?.length ?? null,
    prompts: entry.prompts?.length ?? null,
    templates: entry.templates?.length ?? null,
  }
}

/**
 * The watcher set for one list, created on first use.
 * @param entry - the server.
 * @param list - the list name.
 * @returns the set to add to and remove from.
 */
function listWatchersOf(entry: ServerEntry, list: 'tools' | 'resources' | 'prompts'): Set<() => void> {
  const existing = entry.listWatchers.get(list)
  if (existing !== undefined) return existing
  const created = new Set<() => void>()
  entry.listWatchers.set(list, created)
  return created
}

/**
 * One push line: a value as compact JSON, newline-terminated so a reader can
 * split the stream on lines.
 * @param value - the pushed value.
 * @returns the line.
 */
function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

/**
 * Turn a registration into the iterator `watch` returns. The registration runs
 * once when iteration starts; aborting the signal, or the consumer breaking
 * out, releases it. Lines emitted before the abort are still delivered.
 * @param register - subscribes a sink and returns its release.
 * @param signal - the caller's cancellation.
 * @returns the pushed values.
 */
function pushed<T>(register: (emit: (value: T) => void) => () => void, signal: AbortSignal | undefined): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<T> {
      const queue: T[] = []
      let wake: (() => void) | undefined
      let done = signal?.aborted === true
      const emit = (value: T): void => {
        if (done) return
        queue.push(value)
        wake?.()
        wake = undefined
      }
      const release = register(emit)
      const abort = (): void => {
        done = true
        wake?.()
        wake = undefined
      }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        while (!done) {
          const next = queue.shift()
          if (next !== undefined) {
            yield next
            continue
          }
          const wait = Promise.withResolvers<void>()
          wake = wait.resolve
          await wait.promise
        }
        for (const value of queue) yield value
      } finally {
        signal?.removeEventListener('abort', abort)
        release()
      }
    },
  }
}

/**
 * Split an address remainder into its non-empty segments.
 * @param path - the remainder as written.
 * @returns the segments, with the leading and trailing slashes dropped.
 */
function segments(path: string): string[] {
  return path.trim().replace(/^\/+/u, '').replace(/\/+$/u, '').split('/').filter(part => part !== '')
}

/** Cut a description to the first non-empty line, for the listing form. */
function firstLine(text: string): string {
  return text.split('\n').map(part => part.trim()).find(part => part !== '') ?? ''
}

/** An epoch millisecond as ISO 8601, or null when it is unset. */
function iso(at: number | undefined): string | null {
  return at === undefined ? null : new Date(at).toISOString()
}

/** One error's text. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Any value as the JSON text every path verb returns. */
function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Register one server and, with the first server, the shared source.
 * @param ctx - plugin context carrying the internal-path registry.
 * @param config - validated deployment settings.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (!SERVER_NAME.test(config.serverName)) {
    throw new Error(`omd-mcp-paths: serverName "${config.serverName}" must match ${String(SERVER_NAME)}`)
  }
  if (config.serverName === BUS) {
    throw new Error(`omd-mcp-paths: serverName "${BUS}" is reserved for the heartbeat address mcp://bus`)
  }
  if (servers.has(config.serverName)) {
    throw new Error(`omd-mcp-paths: server "${config.serverName}" is already mounted; use one entry per server`)
  }
  const entry = createEntry(config)
  const route = samplingRoute(config)
  if (route !== undefined) entry.sample = buildSampler(ctx, entry, route)
  servers.set(config.serverName, entry)

  if (registered === undefined) {
    const dispose = ctx.internalPaths.register(SOURCE, createSource(servers))
    const lease = { dispose, users: 0 }
    registered = lease
    ctx.effect(() => () => {
      lease.users -= 1
      if (lease.users === 0 && registered === lease) {
        registered = undefined
        dispose()
      }
    }, 'omd-mcp-paths: mcp source')
  }
  const lease = registered
  lease.users += 1

  ctx.effect(() => () => {
    entry.disposed = true
    if (servers.get(config.serverName) === entry) servers.delete(config.serverName)
    for (const live of entry.listens.values()) void live.subscription.close().catch(() => {})
    entry.listens.clear()
    void entry.client?.close().catch(() => {})
  }, 'omd-mcp-paths: server')

  if (config.heartbeatMs > 0) {
    const timer = setInterval(() => { void tick(entry) }, config.heartbeatMs)
    timer.unref()
    ctx.effect(() => () => clearInterval(timer), 'omd-mcp-paths: heartbeat')
  }

  // Through `clientOf` so a tick that fires during the first attempt joins it
  // instead of opening a second connection.
  void clientOf(entry).catch((error: unknown) => {
    if (config.failOnStartupError) {
      throw new Error(`omd-mcp-paths(${config.serverName}): initial connection failed`, { cause: error })
    }
    ctx.logger.warn(`omd-mcp-paths(${config.serverName}): not connected yet: ${message(error)}`)
  })
}
