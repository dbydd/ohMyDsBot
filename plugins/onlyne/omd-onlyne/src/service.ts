/**
 * The Onlyne binding as a second participant gets it.
 *
 * A dsh session is not the only thing that can own a node: a job runner that
 * consumes issues has no session, and still has to be addressable by the
 * sessions it serves. This service is what such a participant takes from
 * `ctx.onlyne`: `createNode` builds a node on the same listener factory and the
 * same endpoint registry the sessions' nodes are in, so an address that reaches
 * one reaches all of them, and `registry` says which nodes this process hosts.
 *
 * @module omd-onlyne/service
 */

import type { NodeId, Runtime } from '@onlyne/lib'
import { createBotNode, type BotNode } from './node.ts'
import type { SeedTarget } from './neighbors.ts'
import { sharedRegistry } from './registry.ts'

/** What a participant supplies for one node. */
export interface CreateNodeRequest {
  /** The node's identity; `urn:onlyne:agent:<something>` by this deployment's convention. */
  readonly nodeId: NodeId
  /** The host's inbound sink. Without one the node is addressable but reads nothing. */
  readonly runtime?: Runtime
  /** Overrides the plugin's configured region in this node's directory answer. */
  readonly region?: string
}

/** One hosted node as a peer or an operator sees it. */
export interface OnlyneEndpointView {
  readonly nodeId: NodeId
  readonly baseUrl: string
}

/** Every node this process answers for. */
export interface OnlyneRegistry {
  /** Hosted nodes, in registration order. */
  list(): OnlyneEndpointView[]
  /** The node registered under this identity, if any. */
  find(nodeId: NodeId): OnlyneEndpointView | undefined
}

/** What `ctx.onlyne` offers another plugin. */
export interface OnlyneService {
  /**
   * Build and start one node in this process.
   * @param request - identity, optional runtime and region.
   * @returns the node; the caller owns its lifetime and must `dispose()` it.
   */
  createNode(request: CreateNodeRequest): Promise<BotNode>
  readonly registry: OnlyneRegistry
}

/**
 * Build the service over the module-level endpoint registry.
 *
 * The registry is module state, not per-service state, so every plugin that
 * imports `registry.ts` joins the same one; this factory only fixes the
 * default region and narrows the view to what a consumer should hold.
 *
 * @param options - the region and network settings this plugin was configured with.
 * @returns the service the plugin publishes as `ctx.onlyne`.
 */
export function createOnlyneService(options: {
  readonly region: string
  readonly network?: { readonly host?: string; readonly port?: number; readonly dedicated?: boolean }
  readonly seeds?: readonly SeedTarget[]
}): OnlyneService {
  return {
    createNode(request) {
      return createBotNode({
        nodeId: request.nodeId,
        region: request.region ?? options.region,
        ...(options.network === undefined ? {} : { network: options.network }),
        ...(options.seeds === undefined || options.seeds.length === 0 ? {} : { seeds: options.seeds }),
        ...request.runtime === undefined ? {} : { runtime: request.runtime },
      })
    },
    registry: {
      // The endpoint also carries the node's request handler and wake-up; a
      // consumer needs the address, so the handler never leaves this module.
      list: () => sharedRegistry.list().map(endpoint => ({
        nodeId: endpoint.nodeId,
        baseUrl: endpoint.advertisedBaseUrl ?? endpoint.baseUrl,
      })),
      find: nodeId => {
        const endpoint = sharedRegistry.resolve(nodeId)
        return endpoint === undefined
          ? undefined
          : { nodeId: endpoint.nodeId, baseUrl: endpoint.advertisedBaseUrl ?? endpoint.baseUrl }
      },
    },
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The in-process Onlyne binding; absent while `omd-onlyne` is disabled. */
    onlyne: OnlyneService
  }
}
