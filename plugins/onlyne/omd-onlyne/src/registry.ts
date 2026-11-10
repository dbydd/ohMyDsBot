/**
 * The co-hosted endpoint registry: every node of this process registers here, and the
 * hybrid transport resolves peers against it before reaching the network. One registry per
 * process by default; a test that wants a real network hop gives each node its own, which
 * makes them strangers to each other's transport.
 */

import type { NodeId, TrustSeed } from '@onlyne/lib'

/** One node of this process, as the transport reaches it in-process. */
export interface LocalEndpoint {
  readonly nodeId: NodeId
  /**
   * The spelling in-process dispatch builds its signed URL from. It is the root path even
   * for a node advertised under `/nodes/<id>/onlyne/v3`, because the library's handler
   * matches the root and the in-process hop never touches the listener.
   */
  readonly baseUrl: string
  /** The address a peer outside this process dials; the listener routes it to this node. */
  readonly advertisedBaseUrl?: string
  /** The node's HTTP handler; the transport dispatches to it directly. */
  readonly fetch: (request: Request) => Promise<Response>
  /**
   * Wakes the node's maintenance loop. A peer push is the same evidence an
   * HTTP send is: the target now owes a pass, and the library's own cadence
   * must start now instead of after the idle tick.
   */
  readonly wake?: () => void
}

export class EndpointRegistry {
  readonly #endpoints = new Map<NodeId, LocalEndpoint>()
  /**
   * The pinned fingerprints this registry trusts on sight. Nodes that share a
   * registry also share the process key, so one entry per node — pushed at
   * creation — lets their handshake settle as trusted on both sides in one
   * round. The library reads this array live.
   */
  readonly seeds: TrustSeed[] = []

  register(endpoint: LocalEndpoint): void {
    this.#endpoints.set(endpoint.nodeId, endpoint)
  }

  unregister(nodeId: NodeId): void {
    this.#endpoints.delete(nodeId)
  }

  /** Pin one identity's key. Re-pinning the same row is a no-op, not a duplicate. */
  seed(seed: TrustSeed): void {
    if (!this.seeds.some(row => row.node_id === seed.node_id && row.fingerprint === seed.fingerprint)) {
      this.seeds.push(seed)
    }
  }

  /** Drop every pin naming this identity; `dispose` is the node's last act. */
  unseed(nodeId: NodeId): void {
    for (let index = this.seeds.length - 1; index >= 0; index--) {
      if (this.seeds[index]?.node_id === nodeId) this.seeds.splice(index, 1)
    }
  }

  resolve(nodeId: NodeId): LocalEndpoint | undefined {
    return this.#endpoints.get(nodeId)
  }

  list(): LocalEndpoint[] {
    return [...this.#endpoints.values()]
  }
}

/** The registry every plugin-level node joins unless a caller passes its own. */
export const sharedRegistry = new EndpointRegistry()
