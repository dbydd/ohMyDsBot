/**
 * `omd-onlyne` — Onlyne v3 inside one dsh process.
 *
 * One process owns one node identity, not one per session: `urn:onlyne:agent:dsh` by
 * default. Every chat session and subagent binds to that node as a context, so an address
 * a peer learned once keeps working after a restart, a new chat, or fifty subagents. The
 * node's store is durable and lives beside the identity key.
 *
 * The model sees one tool, `msg`: `meta.to` sends, `meta.scope` reads. The same data is
 * readable as `onlyne://directory`, `onlyne://neighbors`, `onlyne://threads`,
 * `onlyne://threads/<alias>/messages` and `onlyne://inbox`. An admitted message reaches its
 * target session as an ordinary user message, so the session log is the durable record of
 * what the model saw.
 *
 * @module omd-onlyne
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { Entry, Json, MsgInput, NodeId, Page, Runtime, SendOutcome } from '@onlyne/lib'
import { onlyneSource } from './reads.ts'
import { createBotNode, type BotNode } from './node.ts'
import { NodeTable, liveNodes, type SessionNode } from './nodes.ts'
import type { SeedTarget } from './neighbors.ts'
import { sharedRegistry } from './registry.ts'
import { createOnlyneService } from './service.ts'

export type { CreateNodeRequest, OnlyneEndpointView, OnlyneRegistry, OnlyneService } from './service.ts'

/** Plugin id the Loader entry carries. */
export const name = 'omd-onlyne'

/** The tool registry this plugin registers `msg` into. */
export const inject = ['tools']

/** One peer this deployment can dial before any handshake proves it. */
export interface SeedConfig {
  /** The peer's node id. Without it, discovery learns the identity from the address. */
  nodeId?: string
  /** The peer's service address, e.g. `https://peer.example/onlyne/v3`. */
  baseUrl: string
  /** Free-form label the directory shows beside the row. */
  label?: string
  /** The peer's key fingerprint; a pinned peer cannot be impersonated by another key. */
  fingerprint?: string
}

/** Deployment settings for the in-process binding. */
export interface Config {
  /** Mount the nodes, the `msg` tool, `onlyne://` and `/onlyne`. Off leaves the profile untouched. */
  enabled: boolean
  /** Region this process's nodes advertise in their directory answer. Machine-independent by default. */
  region: string
  /** Page size for `onlyne://` lists and for the `/onlyne` counts; not a protocol limit. */
  threadPageSize: number
  /** Listener host. Loopback only: a wide bind exposes unauthenticated protocol routes. */
  host: string
  /**
   * Listener port. `0` asks the OS once and remembers the port under the dsh data root, so
   * the node keeps its address across restarts; a fixed port is shared by every node in
   * this process that names it.
   */
  port: number
  /**
   * The node identity this process speaks as. It must not derive from a session id: a
   * session is disposable, and an address peers trusted would die with it.
   */
  nodeId: string
  /** Peers this deployment can dial first, so it does not depend on them introducing themselves. */
  seeds: SeedConfig[]
}

/** Schemastery configuration for the plugin entry. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true)
    .description('Mount one Onlyne node per process plus the msg tool, onlyne:// paths and /onlyne command.'),
  region: z.string().default('urn:onlyne:region:local')
    .description('Region label this process advertises; it names a place, not a network endpoint.'),
  threadPageSize: z.natural().min(1).default(50)
    .description('Page size for onlyne:// listings and the /onlyne counts.'),
  host: z.string().default('127.0.0.1')
    .description('Listener host; loopback only.'),
  port: z.natural().default(0)
    .description('Listener port; 0 asks the OS once and reuses that port after a restart.'),
  nodeId: z.string().default('urn:onlyne:agent:dsh')
    .description('Stable node identity shared by every session of this process.'),
  seeds: z.array(z.object({
    nodeId: z.string().default('').description('The peer node id; empty learns it from the address.'),
    baseUrl: z.string().required().description('The peer service address.'),
    label: z.string().default('').description('Label the directory shows beside this peer.'),
    fingerprint: z.string().default('').description('Pinned peer key fingerprint.'),
  })).default([])
    .description('Peers this deployment can dial before any handshake, e.g. nodes on other machines.'),
})

/**
 * An inbound message is declared here rather than reusing a user source: the
 * log then distinguishes a peer's relay from a human prompt.
 */
type OnlyneMessageSource = {
  readonly kind: 'onlyne'
  /** The node whose message this is. */
  readonly sender: string
  /** `<owner>/<id>` of the thread it landed in. */
  readonly thread: string
  /** The thread sequence this message occupies. */
  readonly seq: string
} & ContextFormed

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    onlyne: OnlyneMessageSource
  }
}

/** A JSON object, or undefined for every other JSON value. */
function jsonRecord(value: unknown): Record<string, Json> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, Json>
}

/**
 * Render one admitted message for the target session. The header carries who
 * sent it and where it landed; the body stays the peer's exact text.
 */
function renderEntry(entry: Entry): string {
  const relation = entry.message.meta?.relation
  const kind = relation === undefined ? entry.message.delivery_kind : `${entry.message.delivery_kind}/${relation}`
  return [
    `[onlyne] from ${entry.authenticated_author}`,
    `thread ${entry.thread_ref.owner}/${entry.thread_ref.id} · seq ${entry.seq} · ${kind}`,
    '',
    entry.message.msg,
  ].join('\n')
}

/** The session one inbound entry belongs to: the plan's context, else the node's first session. */
async function sessionForEntry(
  nodes: NodeTable,
  nodeId: NodeId,
  context: string | undefined,
): Promise<SessionNode | undefined> {
  if (context !== undefined && context !== '' && context !== nodeId) {
    const named = await nodes.get(context)
    if (named !== undefined && named.bot.nodeId === nodeId) return named
  }
  return nodes.primary(nodeId)
}

/**
 * The host half of inbound delivery: an admitted entry becomes one identified
 * user message in the session its plan addressed, queued through the agent's own inbox
 * so the session log records it.
 *
 * `consumed: true` is the settlement the library asks of a host that has taken
 * the body: it writes the consumption record and stops replaying the row on the
 * next maintenance pass. A `false` here would re-queue the same message every
 * two seconds until the model claimed it.
 *
 * `supports` is honest about what this host can do (RFC 0005 §3): the queue has no
 * synchronous reply path, so an `await` plan is refused at admission with
 * `unsupported_delivery` instead of being accepted and left to time out. `notify` is a
 * no-op here because {@link createBotNode} wraps it with the node's wake-up.
 */
export function createRuntime(nodes: NodeTable, nodeId: NodeId): Runtime {
  return {
    supports: async plan => plan.response !== 'await' && plan.execution !== 'new',
    async inject(entry, context) {
      const session = await sessionForEntry(nodes, nodeId, context)
      if (session === undefined) {
        return { context: context ?? nodeId, consumed: false, outcome: 'skipped' }
      }
      const team = teamMessage(entry)
      if (team !== undefined) {
        // A Bot-team relay keeps the sending side's header text and source
        // object byte for byte: the team's routing (roles, exchange ids,
        // audience, reply links) is what ds-bot's own records read back, and
        // only the transport changed.
        const message = createUserMessage({
          content: [{ type: 'text', text: `${team.header}\n${entry.message.msg}` }],
          source: team.source as never,
        })
        // The host decided between cutting into a running turn and queueing
        // behind it; the node must not second-guess that with the agent's own
        // status.
        if (team.steer) session.agent.steer(message)
        else session.agent.followup(message)
        return { context: String(session.agent.session.id), consumed: true, outcome: 'queued' }
      }
      const message = createUserMessage({
        content: [{ type: 'text', text: renderEntry(entry) }],
        source: {
          kind: 'onlyne',
          form: 'relay',
          sender: entry.message.sender,
          thread: `${entry.thread_ref.owner}/${entry.thread_ref.id}`,
          seq: entry.seq,
        },
      })
      if (session.agent.status === 'running') session.agent.steer(message)
      else session.agent.followup(message)
      return { context: String(session.agent.session.id), consumed: true, outcome: 'queued' }
    },
    notify: () => {},
  }
}

/** The Bot-team payload one entry carries, when the sender put one there. */
function teamMessage(entry: Entry): { header: string; source: Record<string, Json>; steer: boolean } | undefined {
  const data = entry.message.meta?.data
  if (data === undefined) return undefined
  const payload = data.botTeam
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const record = payload as { [key: string]: Json }
  const header = record.header
  const source = record.source
  if (typeof header !== 'string' || typeof source !== 'object' || source === null || Array.isArray(source)) {
    return undefined
  }
  return { header, source: source as Record<string, Json>, steer: record.steer === true }
}

/** The text the model reads to decide what to put in `msg`. */
function describeTool(nodeId: NodeId | undefined): string {
  const lines = [
    'Onlyne messaging inside this dsh process: threads, inbox and replies between agent sessions.',
    ...(nodeId === undefined ? [] : [`This process speaks as node ${nodeId}; every session and subagent shares it.`]),
    'Peers: read onlyne://directory for the nodes this process hosts and the peers it can reach (local, trusted, discovered).',
    'Send: { delivery_kind, msg, meta: { to, context?, thread?, in_reply_to?, relation? } }. `to` is a node id such as urn:onlyne:agent:dsh; `context` names the session that should receive it (its session id), which is how one session of this node addresses another.',
    'Read: { delivery_kind: "read", msg: "", meta: { scope } } where scope is directory | neighbors | threads | inbox | messages | message | evidence; messages takes a thread, message/evidence take a message ref, and cursor/page_size page.',
    'The same records are readable as files: onlyne://directory, onlyne://neighbors, onlyne://threads, onlyne://threads/<alias>/messages, onlyne://inbox, onlyne://runner/workers.',
  ]
  return lines.join('\n')
}

/**
 * The one model-facing entry. It is defined per agent when possible, so the
 * description can carry that session's own node id; the global registration is
 * what a caller outside an agent still resolves.
 */
function createMsgTool(nodes: NodeTable, nodeId?: NodeId): ToolDefinition {
  return defineTool({
    name: 'msg',
    description: describeTool(nodeId),
    parameters: {
      delivery_kind: {
        type: 'string',
        required: true,
        description: 'What kind of message this is, e.g. "request", "note" or "reply"; for reads use "read".',
      },
      msg: {
        type: 'string',
        required: true,
        description: 'The message body. Empty for a read.',
      },
      meta: {
        // An object, not unconstrained JSON: a model that sees `json` tends to send
        // the object as a string, and the routing keys are all object members.
        type: 'object',
        additionalProperties: true,
        description: 'Object: to/context/thread/in_reply_to/relation for a send, or scope/thread/message/cursor/page_size for a read.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('msg needs an owning agent session')
      const session = await nodes.get(String(agent.session.id))
      if (session === undefined) throw new Error(`msg: session ${String(agent.session.id)} has no Onlyne node`)
      const meta = args.meta === undefined ? undefined : jsonRecord(args.meta)
      if (args.meta !== undefined && meta === undefined) throw new Error('msg.meta must be a JSON object')
      const input: MsgInput = {
        delivery_kind: args.delivery_kind,
        msg: args.msg,
        ...(meta === undefined ? {} : { meta }),
      }
      // A co-hosted peer has no trust row until someone asks, and the library refuses a send
      // before it reaches the transport's own pairing. Only a local identity is paired here;
      // a remote peer was paired when its row was written.
      const to = meta?.to
      if (typeof to === 'string' && sharedRegistry.resolve(to) !== undefined) {
        await session.bot.ensurePaired(to)
      }
      const result = await session.bot.node.client.msg(input, {
        signal: exec.signal,
        context: String(agent.session.id),
      })
      return JSON.stringify(result, null, 2)
    },
    presentCall: () => ({ card: 'generic', title: 'Onlyne message', kind: 'other' }),
  })
}

/** Follow pages until the listing ends, keeping the count. */
async function countPages(load: (cursor: string | undefined) => Promise<Page<unknown>>): Promise<number> {
  let total = 0
  let cursor: string | undefined
  for (let pages = 0; pages < 50; pages++) {
    const page = await load(cursor)
    total += page.items.length
    if (page.next_cursor === null) return total
    cursor = page.next_cursor
  }
  return total
}

/**
 * One Bot-to-Bot delivery handed to the thread network.
 *
 * The caller keeps its own notion of a team: header text, a source object with
 * roles and exchange ids, and where the answer goes. None of that is
 * reinterpreted here — it travels as the message's `meta.data.botTeam`, and the
 * receiving node rebuilds the very message it would have built locally.
 */
export interface BotRelayInput {
  /** Session id of the sending Bot. */
  readonly fromSessionId: string
  /** Session id of the receiving Bot. */
  readonly toSessionId: string
  /** Delivery kind the caller uses, e.g. `request`, `reply`, `report`. */
  readonly deliveryKind: string
  /** The header line the receiving model reads above the body. */
  readonly header: string
  /** The caller's own source object, carried unchanged. */
  readonly source: Record<string, Json>
  /** The body. */
  readonly text: string
  /** Cut into a running turn instead of queuing for the next one. */
  readonly steer: boolean
}

/** What one relay did: the admission the network recorded. */
export interface BotRelayOutcome {
  readonly admission: string
  readonly thread: string
  readonly seq: string
}

/** The seam a team host takes from `ctx.botRelay`. */
export interface BotRelayService {
  /**
   * Deliver one Bot-to-Bot message over the thread network.
   * @param input - sender, receiver, header, source, body and steering.
   * @returns the admission and the thread the message landed in.
   * @throws when either side has no live node; the caller decides what to do.
   */
  relay(input: BotRelayInput): Promise<BotRelayOutcome>
}

/**
 * Build the relay over the live session table.
 *
 * The receiving session is named by the plan's `context`, not by a second node: one
 * process speaks as one node, and a conversation between two of its sessions is a local
 * admission whose context selects the agent that reads it.
 *
 * @param nodes - session id to node, kept by {@link apply}.
 * @param log - one audit line per relayed message.
 * @returns the service published as `ctx.botRelay`.
 */
function createBotRelay(nodes: NodeTable, log: (line: string) => void): BotRelayService {
  return {
    async relay(input) {
      const sender = await nodes.get(input.fromSessionId)
      if (sender === undefined) {
        throw new Error(`botRelay: session ${input.fromSessionId} has no Onlyne node`)
      }
      const target = await nodes.get(input.toSessionId)
      if (target === undefined) {
        throw new Error(`botRelay: session ${input.toSessionId} has no Onlyne node`)
      }
      if (target.bot.nodeId !== sender.bot.nodeId) await sender.bot.ensurePaired(target.bot.nodeId)
      const result = await sender.bot.node.client.msg({
        delivery_kind: input.deliveryKind,
        msg: input.text,
        meta: {
          to: target.bot.nodeId,
          context: String(target.agent.session.id),
          // The library stores the whole input meta as the message's
          // `meta.data`, so this key lands one level up from here.
          botTeam: { header: input.header, source: input.source, steer: input.steer },
        },
      }) as SendOutcome
      if (result.admission !== 'accepted') {
        throw new Error(`botRelay: admission ${String(result.admission)}`)
      }
      const receipt = result.receipt
      if (receipt === undefined) throw new Error('botRelay: the admitted message carries no receipt')
      // One audit line per relayed message: "did this Bot-to-Bot traffic ride a
      // thread" is the question the log exists to answer.
      log(`omd-onlyne: relayed ${input.deliveryKind} ${input.fromSessionId} -> ${input.toSessionId} at seq ${receipt.seq}`)
      return {
        admission: result.admission,
        thread: `${receipt.thread_ref.owner}/${receipt.thread_ref.id}`,
        seq: receipt.seq,
      }
    },
  }
}

/** The stable identity a profile configured, or the deployment default. */
function stableNodeId(config: Config): NodeId {
  const configured = config.nodeId.trim()
  return configured === '' ? 'urn:onlyne:agent:dsh' : configured
}

/** Configured seeds, with empty optional fields left out. */
function seedTargets(config: Config): SeedTarget[] {
  return config.seeds.map(seed => ({
    ...((seed.nodeId ?? '').trim() === '' ? {} : { nodeId: (seed.nodeId ?? '').trim() }),
    baseUrl: seed.baseUrl.trim(),
    ...((seed.label ?? '').trim() === '' ? {} : { label: (seed.label ?? '').trim() }),
    ...((seed.fingerprint ?? '').trim() === '' ? {} : { fingerprint: (seed.fingerprint ?? '').trim() }),
  })).filter(seed => seed.baseUrl !== '')
}

/**
 * Register the nodes, the tool, the paths and the command.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const nodes = new NodeTable()
  const nodeId = stableNodeId(config)
  const seeds = seedTargets(config)

  // Another participant — a runner with no session — joins the same registry
  // through this, so the address set is the process's, not one plugin's.
  ctx.provide('onlyne', createOnlyneService({
    region: config.region,
    network: { host: config.host, port: config.port },
    seeds,
  }))

  // The seam a team host uses to put Bot-to-Bot traffic on the thread network:
  // it hands over what it would have delivered locally, and this service does
  // the same delivery from the sending node to the receiving one.
  ctx.provide('botRelay', createBotRelay(nodes, line => ctx.logger.info(line)))

  ctx.effect(() => ctx.tools.register(createMsgTool(nodes, nodeId)), 'omd-onlyne: msg tool')

  // `msg` is this plugin's model-facing entry: naming it here keeps it on the
  // assembled tool surface even when `omd-internal-tools` hides everything that
  // is not on its passthrough list, without asking a profile to remember the name.
  ctx.inject(['internalTools'], scope => {
    const internalTools = scope.get('internalTools') as
      | { allowPassthrough(names: string | string[]): () => void }
      | undefined
    if (internalTools === undefined) return
    scope.effect(() => internalTools.allowPassthrough('msg'), 'omd-onlyne: msg on the model surface')
  })

  const runtime = createRuntime(nodes, nodeId)
  ctx.on('agent/created', ({ agent }) => {
    const sessionId = String(agent.session.id)
    // One node per identity: a new session binds to the node its predecessor built, and
    // the first session is the one that creates it.
    const bot = nodes.bind(sessionId, agent, nodeId, () => createBotNode({
      nodeId,
      region: config.region,
      network: { host: config.host, port: config.port },
      runtime,
      seeds,
      onDiagnostic: (message, error) => { ctx.logger.warn('omd-onlyne: %s: %o', message, error) },
    }))
    bot.catch((error: unknown) => {
      ctx.logger.warn('omd-onlyne: the node %s could not start: %o', nodeId, error)
    })
    // Registering into the agent's own scope keeps the description's node id
    // truthful and follows the agent's lifetime, with no separate cleanup.
    agent.ctx.get('tools')?.register(createMsgTool(nodes, nodeId))
    agent.ctx.effect(() => () => {
      void nodes.release(sessionId)
    })
  })

  // Plugin teardown retires every node: a reload must not leave a listener or store open.
  ctx.effect(() => () => { void nodes.disposeAll() }, 'omd-onlyne: nodes')

  ctx.inject(['internalPaths'], scope => {
    const internalPaths = scope.get('internalPaths')
    if (internalPaths === undefined) return
    scope.effect(() => internalPaths.register('onlyne', onlyneSource(config, nodes)), 'omd-onlyne: onlyne:// source')
  })

  ctx.inject(['commands'], scope => {
    const commands = scope.get('commands')
    if (commands === undefined) return
    scope.effect(() => commands.register({
      name: 'onlyne',
      description: 'Report this process\'s Onlyne node id, thread counts and inbox size',
      recordInput: false,
      async handler({ agent }: CommandInvocation) {
        const session = await nodes.get(String(agent.session.id)) ?? await nodes.first()
        const bot = session?.bot ?? await liveNodes()[0]?.bot
        if (bot === undefined) {
          return { kind: 'error', text: `No Onlyne node is mounted (omd-onlyne is ${config.enabled ? 'mounted' : 'disabled'}).` }
        }
        const node = bot.node
        const [threads, joined, inbox] = await Promise.all([
          countPages(cursor => node.threads.list(node.auth, { page_size: 100, ...(cursor === undefined ? {} : { cursor }) })),
          countPages(cursor => node.client.joinedThreads({ page_size: 100, ...(cursor === undefined ? {} : { cursor }) })),
          countPages(cursor => node.messages.inbox(node.auth, { page_size: 100, ...(cursor === undefined ? {} : { cursor }) })),
        ])
        return {
          kind: 'success',
          text: [
            `node: ${bot.nodeId}`,
            `base URL: ${bot.baseUrl}`,
            `fingerprint: ${bot.fingerprint}`,
            `threads: ${threads} hosted, ${joined} joined`,
            `inbox: ${inbox} ${inbox === 1 ? 'message' : 'messages'}`,
          ].join('\n'),
        }
      },
    }), 'omd-onlyne: /onlyne command')
  })
}

/** Exported for the tests: the settings a node needs from the plugin config. */
export type { BotNode }
