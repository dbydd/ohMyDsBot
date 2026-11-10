/**
 * One Onlyne node per host identity, on the process's HTTP listener.
 *
 * `createBotNode` is the whole assembly `OnlyneNode` needs from a host: storage, a clock,
 * an id source, the identity key, trust wiring, a resolver, a decision, and the transport.
 * Co-hosted nodes exchange messages in-process with signed requests; peers this process
 * does not host go through the library's own `FetchTransport` over their listener.
 *
 * Three deployment facts shape this module:
 *
 * 1. The listener is the process's, not the node's. Every node joins one socket and is
 *    routed by the identity in its request; a process that runs fifty agent sessions still
 *    opens one port.
 * 2. Storage is durable by default. The key file already outlives the process, and a store
 *    that empties on restart leaves every peer holding trust rows this side cannot honour.
 * 3. Pairing is on demand. The transport pairs a co-hosted peer on first use and settles
 *    concurrent attempts through one promise, so creating a node costs nothing per sibling.
 *
 * @module omd-onlyne/node
 */

import { OnlyneError, OnlyneNode } from '@onlyne/lib'
import type {
  Action, AdmissionContext, DiscoveryService, Json, KeyHook, MsgInput, NodeId, NotifyEvent, Runtime, Storage,
  Target, TrustEntry,
} from '@onlyne/lib'
import { decideMessage } from './decide.ts'
import { processKeyHook } from './keys.ts'
import { neighborRows, type SeedTarget } from './neighbors.ts'
import { forgetLiveNode, registerLiveNode } from './nodes.ts'
import { sharedRegistry, type EndpointRegistry } from './registry.ts'
import { joinNodeListener, type OnlyneListener } from './server.ts'
import { listenerPortFile, openNodeStorage, releaseNodeStorage } from './storage.ts'
import { HybridTransport, type TransportBinding } from './transport.ts'

/** What a host may choose when it builds a node. */
export interface BotNodeOptions {
  /**
   * The node's stable identity, e.g. `urn:onlyne:agent:dsh`. Sessions and subagents are
   * contexts of this identity; a session id is not an identity and must not name a node.
   */
  readonly nodeId: NodeId
  /** Durable backing. Defaults to this identity's SQLite file under the dsh data root. */
  readonly storage?: Storage
  /** Overrides the deterministic decision. */
  readonly decide?: (input: MsgInput) => Promise<Action>
  /** The host's inbound sink. Without one, admitted messages are read but never delivered. */
  readonly runtime?: Runtime
  /** Region this process advertises in its directory answer. */
  readonly region?: string
  /**
   * Listener binding. `0` joins the process listener on a remembered port; a fixed port
   * joins every node that names it; `dedicated` gives this node a socket of its own.
   */
  readonly network?: { readonly host?: string; readonly port?: number; readonly dedicated?: boolean }
  /** Same as `network.dedicated`; a node that must not share the process listener. */
  readonly dedicatedPort?: boolean
  /**
   * The endpoint registry this node joins. The shared one keeps the process's nodes
   * reachable in-process; a node with a registry of its own is a stranger to its siblings,
   * so traffic to it takes the network path.
   */
  readonly registry?: EndpointRegistry
  /** Identity key. Defaults to the process key at `<dsh home>/data/omd-onlyne/key.json`. */
  readonly keys?: KeyHook
  /** Peers this deployment can dial before any handshake, e.g. a node on another machine. */
  readonly seeds?: readonly SeedTarget[]
  /** Where a non-fatal failure (an unreachable seed, say) is reported. */
  readonly onDiagnostic?: (message: string, error: unknown) => void
}

/** A live node, its listener, and the registrations that keep it reachable. */
export interface BotNode {
  readonly nodeId: NodeId
  readonly node: OnlyneNode
  readonly transport: HybridTransport
  readonly listener: OnlyneListener
  /** The node's real HTTP base URL; the trust handshake and remote peers use it. */
  readonly baseUrl: string
  /** This node's key fingerprint, as a peer reads it from `/keys`. */
  readonly fingerprint: string
  /** The store this node reads, so a host can render the same rows the protocol uses. */
  readonly storage: Storage
  /**
   * Pair a co-hosted peer before the first send to it.
   *
   * A send is refused by the library when no trust row names the peer, and the transport's
   * own pairing runs below that check, so the host asks here first. Concurrent callers share
   * one exchange; a peer already trusted costs one storage read.
   */
  ensurePaired(peer: NodeId): Promise<void>
  /** Stops the maintenance loop, withdraws the node from the registry, closes the listener. */
  dispose(): Promise<void>
}

/** The actor scheme this binding advertises: a signed request names its actor. */
const AUTHENTICATION = ['signature']

/** One armed maintenance timer, opaque to the protocol; only this clock reads it back. */
type TimerHandle = ReturnType<typeof setTimeout>

/** The tail of the maintenance passes this process runs, per node. */
const passQueues = new WeakMap<object, Promise<unknown>>()

/**
 * Run one maintenance pass after the previous one on the same node settled.
 *
 * The library serializes its own loop, but a host-requested pass would overlap one, and two
 * passes read the same uninjected inbox row before either writes it. One queue per node
 * keeps the agent from receiving an entry twice.
 */
function serialize<T>(queue: object, work: () => Promise<T>): Promise<T> {
  const tail = passQueues.get(queue) ?? Promise.resolve()
  const run = () => work()
  const result = tail.then(run, run)
  passQueues.set(queue, result.then(() => undefined, () => undefined))
  return result
}

/**
 * Build and start one node on the process listener.
 *
 * The maintenance loop starts here because inbound delivery depends on it: a peer's push
 * wakes the loop through `notify`, and the loop's reconcile pass is what turns an owner's
 * attention row into a local inbox entry. `dispose` stops it.
 *
 * @param options - identity, storage, network binding, and the host's inbound runtime.
 * @returns the node, its transport, listener address, and the disposer.
 */
export async function createBotNode(options: BotNodeOptions): Promise<BotNode> {
  const { nodeId } = options
  const registry = options.registry ?? sharedRegistry
  const keyHook = options.keys ?? processKeyHook()
  const region = options.region ?? 'urn:onlyne:region:local'
  const host = options.network?.host ?? '127.0.0.1'
  const port = options.network?.port ?? 0
  const dedicated = options.dedicatedPort === true || options.network?.dedicated === true
  const seeds = options.seeds ?? []
  const diagnose = options.onDiagnostic ?? (() => {})
  const seedTargets = new Map<NodeId, string>()
  for (const seed of seeds) {
    if (seed.nodeId !== undefined && seed.nodeId !== '') seedTargets.set(seed.nodeId, seed.baseUrl)
    if (seed.nodeId !== undefined && seed.fingerprint !== undefined) {
      registry.seed({ node_id: seed.nodeId, fingerprint: seed.fingerprint })
    }
  }

  const storage = options.storage ?? await openNodeStorage(nodeId)
  const ownsStorage = options.storage === undefined
  // The wake path is a mutable hook because the client exists only after the node it belongs
  // to: `notify` is called by that client, so the closure reads the hook at call time.
  let wakeLoop: (() => void) | undefined
  let pass: (() => void) | undefined

  const { promise: handler, resolve: deliverHandler } = Promise.withResolvers<(request: Request) => Promise<Response>>()
  const listener = await joinNodeListener({
    host,
    port,
    dedicated,
    portFile: dedicated || port !== 0 ? undefined : listenerPortFile(),
    nodeId,
    handler,
  })

  const binding: TransportBinding = {}
  const transport = new HybridTransport(nodeId, registry, binding)
  let discovery: DiscoveryService | undefined
  let trustEntry: ((peer: NodeId) => Promise<TrustEntry | undefined>) | undefined
  const resolve = async (peer: NodeId): Promise<Target> => {
    const endpoint = registry.resolve(peer)
    if (endpoint !== undefined) return { node_id: endpoint.nodeId, base_url: endpoint.advertisedBaseUrl ?? endpoint.baseUrl }
    const seeded = seedTargets.get(peer)
    if (seeded !== undefined) return { node_id: peer, base_url: seeded }
    if (discovery !== undefined) {
      try {
        return await discovery.resolve(peer)
      } catch (error) {
        const code = (error as { error?: { code?: string } } | null)?.error?.code
        if (code !== 'not_found' && code !== 'unavailable' && code !== 'conflict') throw error
      }
    }
    const known = trustEntry === undefined ? undefined : await trustEntry(peer)
    if (known?.base_url !== undefined && known.base_url !== '') return { node_id: peer, base_url: known.base_url }
    throw new OnlyneError('not_found', `No record answers for ${peer}.`)
  }

  const node = new OnlyneNode({
    node_id: nodeId,
    base_url: listener.baseUrl,
    authentication: AUTHENTICATION,
    now: () => Date.now(),
    id: () => crypto.randomUUID(),
    plugins: {
      storage,
      transport,
      keys: keyHook,
      trust_seeds: registry.seeds,
      resolve,
      // Unreachable while the node holds a key: `createHttpHandler` authenticates
      // a keyed node through the trust service and never calls this hook. It is
      // present because the protocol makes the host own the actor decision.
      authenticate: async () => null,
      decide: options.decide ?? decideMessage,
      ...(options.runtime === undefined
        ? {}
        : {
            runtime: wakeful(options.runtime, event => {
              wakeLoop?.()
              // A wake only shortens the cadence to two seconds. An inbound entry is owed
              // a pass now, so the agent sees it in milliseconds instead of after a tick.
              if (event?.event === 'inbound') pass?.()
            }),
          }),
      // A handshake with a co-hosted peer settles through the registry's shared
      // keys, and a remote peer reaches this only after its own exchange. The
      // first contact of a stranger is admitted by the thread owner's decision,
      // which this binding leaves to the protocol.
      inboundThread: async (_actor: NodeId, _context: AdmissionContext) => true,
      directory: async (): Promise<Json> => ({
        region,
        nodes: registry.list().map(endpoint => ({
          node_id: endpoint.nodeId,
          base_url: endpoint.advertisedBaseUrl ?? endpoint.baseUrl,
        })),
      }),
      neighbors: async () => neighborRows(storage, discovery),
      maintenanceClock: {
        // Passes are serialized with the host's own inbound pass: `#replayInbox` reads
        // `injected` before the runtime writes it, so two concurrent passes could hand the
        // agent the same entry twice.
        setTimer: (ms, run) => setTimeout(() => {
          void serialize(node, async () => { await (run as () => unknown)() }).catch(() => undefined)
        }, ms),
        clearTimer: handle => { clearTimeout(handle as TimerHandle) },
      },
    },
  })
  const identity = await node.keys.describe()
  if (identity === undefined) throw new OnlyneError('internal', 'The node started without an identity key.')
  binding.trust = node.trust
  binding.fingerprint = identity.fingerprint
  binding.resolve = resolve
  discovery = node.discovery
  trustEntry = peer => node.trust.entry(peer)
  deliverHandler(request => node.fetch(request))

  if (options.keys === undefined && !registry.seeds.some(row => row.node_id === nodeId)) {
    registry.seed({ node_id: nodeId, fingerprint: identity.fingerprint })
  }
  // In-process dispatch builds its signed URL from `baseUrl`, so a node advertised under a
  // mounted path is still handed the root spelling here: the library's own handler knows the
  // root, and the address a peer dials is the one `advertisedBaseUrl` carries.
  const rootBaseUrl = `http://${host}:${listener.port}/onlyne/v3`
  registry.register({
    nodeId,
    baseUrl: rootBaseUrl,
    advertisedBaseUrl: listener.baseUrl,
    fetch: request => node.fetch(request),
    wake: () => { node.client.wakeLoop() },
  })
  wakeLoop = () => { node.client.wakeLoop() }
  pass = () => {
    void serialize(node, () => node.client.maintain()).catch(() => undefined)
  }
  node.client.runMaintenance()

  // Seeds are addresses, not trust: observing them in the background proves identity and
  // fills the discovery catalog without making a down peer delay this node's startup.
  for (const seed of seeds) {
    void node.discovery.observe(seed.baseUrl, 'configured-seed', seed.nodeId).catch(error => {
      diagnose(`seed ${seed.baseUrl} could not be observed`, error)
    })
  }

  const pairing = new Map<NodeId, Promise<void>>()
  const ensurePaired = (peer: NodeId): Promise<void> => {
    if (peer === nodeId) return Promise.resolve()
    const running = pairing.get(peer)
    if (running !== undefined) return running
    const attempt = (async () => {
      const known = await node.trust.entry(peer)
      if (known?.state === 'trusted') return
      await node.trust.request(node.auth, peer, identity.fingerprint)
    })()
    pairing.set(peer, attempt)
    attempt.catch(() => { pairing.delete(peer) })
    return attempt
  }

  let disposed = false
  const bot: BotNode = {
    nodeId,
    node,
    transport,
    listener,
    baseUrl: listener.baseUrl,
    fingerprint: identity.fingerprint,
    storage,
    ensurePaired,
    async dispose() {
      if (disposed) return
      disposed = true
      node.client.stopMaintenance()
      registry.unregister(nodeId)
      forgetLiveNode(nodeId)
      registry.unseed(nodeId)
      await listener.close()
      if (ownsStorage) releaseNodeStorage(storage)
    },
  }
  registerLiveNode(nodeId, Promise.resolve(bot))
  return bot
}

/**
 * Wrap a host runtime so every notification also wakes the node's maintenance loop.
 *
 * HTTP inbound never touches the transport's in-process `wake`, so without this the entry
 * waits for the idle cadence — up to thirty seconds — before the agent sees it.
 */
function wakeful(runtime: Runtime, onEvent: (event: NotifyEvent | undefined) => void): Runtime {
  return {
    supports: (plan, message) => runtime.supports(plan, message),
    inject: (entry, context, plan) => runtime.inject(entry, context, plan),
    notify: event => {
      onEvent(event)
      runtime.notify(event)
    },
    ...(runtime.todo === undefined ? {} : { todo: (entry, context) => runtime.todo!(entry, context) }),
    ...(runtime.trace === undefined ? {} : { trace: event => runtime.trace!(event) }),
    ...(runtime.confirmToolResult === undefined
      ? {}
      : { confirmToolResult: (entry, context) => runtime.confirmToolResult!(entry, context) }),
  }
}

