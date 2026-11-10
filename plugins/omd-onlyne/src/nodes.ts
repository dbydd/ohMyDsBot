/**
 * The session-to-node table.
 *
 * A node identity is stable — `urn:onlyne:agent:dsh` for a dsh deployment — while sessions
 * and subagents come and go. One identity therefore owns one `BotNode`, and every session
 * that speaks for it binds to that node: a chat session, a subagent, and a caller that
 * names the node explicitly all share one address, one store and one listener slot.
 *
 * A node is retired when its last session unbinds, and only then. A node created without a
 * session (a job runner, say) is live until its owner disposes it; `live` is the process
 * view reads fall back to when no session is involved.
 *
 * @module omd-onlyne/nodes
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { NodeId } from '@onlyne/lib'
import type { BotNode } from './node.ts'

/** One live session and the node that speaks for it. */
export interface SessionNode {
  readonly agent: Agent
  readonly bot: BotNode
}

interface Entry {
  readonly agent: Agent
  readonly nodeId: NodeId
  readonly bot: Promise<BotNode>
}

interface Held {
  readonly bot: Promise<BotNode>
  readonly sessions: Set<string>
}

/** Every node this process currently hosts, by identity, whether or not a session binds it. */
const live = new Map<NodeId, Promise<BotNode>>()

/** Publish one node so reads and `?node=` lookups can find a node no session names. */
export function registerLiveNode(nodeId: NodeId, bot: Promise<BotNode>): void {
  live.set(nodeId, bot)
}

/** Withdraw one node from the process view. */
export function forgetLiveNode(nodeId: NodeId): void {
  live.delete(nodeId)
}

/** One live node by identity. */
export function liveNode(nodeId: NodeId): Promise<BotNode> | undefined {
  return live.get(nodeId)
}

/** Every node this process hosts, in registration order. */
export function liveNodes(): Array<{ nodeId: NodeId; bot: Promise<BotNode> }> {
  return [...live.entries()].map(([nodeId, bot]) => ({ nodeId, bot }))
}

export class NodeTable {
  readonly #sessions = new Map<string, Entry>()
  readonly #held = new Map<NodeId, Held>()
  #chain: Promise<unknown> = Promise.resolve()

  /**
   * Reuse the node one identity already has, or create it once.
   *
   * Concurrent callers share the first creation: an `agent/created` burst must not build
   * (and bind) fifty listeners for one identity.
   *
   * @param nodeId - the stable identity.
   * @param create - builds the node; called at most once per live identity.
   */
  claim(nodeId: NodeId, create: () => Promise<BotNode>): Promise<BotNode> {
    const known = this.#held.get(nodeId)
    if (known !== undefined) return known.bot
    const bot = create()
    this.#held.set(nodeId, { bot, sessions: new Set() })
    bot.catch(() => {
      // A failed creation leaves no node behind; the next session is allowed to try again.
      if (this.#held.get(nodeId)?.bot === bot) this.#held.delete(nodeId)
    })
    return bot
  }

  /**
   * Bind one session to an identity, creating the node on first use.
   * @returns the node the session speaks through.
   */
  bind(sessionId: string, agent: Agent, nodeId: NodeId, create: () => Promise<BotNode>): Promise<BotNode> {
    const bot = this.claim(nodeId, create)
    const held = this.#held.get(nodeId)
    if (held !== undefined) held.sessions.add(sessionId)
    this.#sessions.set(sessionId, { agent, nodeId, bot })
    return bot
  }

  /** The node one session speaks through. */
  async get(sessionId: string | undefined): Promise<SessionNode | undefined> {
    if (sessionId === undefined) return undefined
    const entry = this.#sessions.get(sessionId)
    return entry === undefined ? undefined : { agent: entry.agent, bot: await entry.bot }
  }

  /** One entry per bound session, in binding order. */
  async all(): Promise<SessionNode[]> {
    const rows: SessionNode[] = []
    for (const entry of this.#sessions.values()) rows.push({ agent: entry.agent, bot: await entry.bot })
    return rows
  }

  /** The first session that hosts a node, for a read that names no session. */
  async first(): Promise<SessionNode | undefined> {
    const entry = this.#sessions.values().next()
    return entry.done === true ? undefined : { agent: entry.value.agent, bot: await entry.value.bot }
  }

  /** The first session bound to one identity; how a node without its own session is read. */
  async primary(nodeId: NodeId): Promise<SessionNode | undefined> {
    for (const entry of this.#sessions.values()) {
      if (entry.nodeId === nodeId) return { agent: entry.agent, bot: await entry.bot }
    }
    return undefined
  }

  /** Every session id currently bound, in binding order. */
  sessions(): string[] {
    return [...this.#sessions.keys()]
  }

  /** Every identity with at least one bound session. */
  identities(): NodeId[] {
    return [...new Set(this.#sessions.values())].map(entry => entry.nodeId)
  }

  /**
   * Unbind one session. The node goes with the last session that spoke for it.
   *
   * Disposal is serialized through one chain so two sessions releasing at once cannot both
   * see a count of zero.
   */
  release(sessionId: string): Promise<void> {
    const run = async (): Promise<void> => {
      const entry = this.#sessions.get(sessionId)
      if (entry === undefined) return
      this.#sessions.delete(sessionId)
      const held = this.#held.get(entry.nodeId)
      if (held === undefined) return
      held.sessions.delete(sessionId)
      if (held.sessions.size > 0) return
      this.#held.delete(entry.nodeId)
      // A node whose creation failed has nothing to dispose; that session's node is gone.
      const bot = await entry.bot.catch(() => undefined)
      await bot?.dispose().catch(() => undefined)
    }
    const result = this.#chain.then(run, run)
    this.#chain = result.then(() => undefined, () => undefined)
    return result
  }

  /** Unbind everything and dispose each node once. */
  async disposeAll(): Promise<void> {
    const nodes = [...this.#held.values()].map(held => held.bot)
    this.#held.clear()
    this.#sessions.clear()
    for (const bot of nodes) {
      await (await bot).dispose().catch(() => undefined)
    }
  }
}
