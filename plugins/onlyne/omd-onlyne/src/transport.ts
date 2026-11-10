/**
 * The hybrid transport: co-hosted nodes are reached in-process with signed
 * requests, everything else through the library's own network transport.
 *
 * In-process dispatch keeps the protocol's guarantees: the request is signed
 * with the node's trust service and the response is verified against the
 * peer's stored key, exactly as a network hop would be. A co-hosted peer is
 * paired on first use — the handshake runs the real exchange (inspect the
 * peer's `/keys`, post a statement) over its loopback listener, so both sides
 * hold trusted rows.
 */

import { FetchTransport, OnlyneError } from '@onlyne/lib'
import type { ErrorCode, Failure, NodeId, Target, Transport, TrustService } from '@onlyne/lib'
import type { EndpointRegistry } from './registry.ts'

/** The node's own services, assigned right after `OnlyneNode` construction. */
export interface TransportBinding {
  trust?: TrustService
  /** This node's own key fingerprint; the pairing exchange names it. */
  fingerprint?: string
  /** Resolution beyond the co-hosted registry, e.g. the discovery catalog. */
  resolve?(node: NodeId): Promise<Target>
}

export class HybridTransport implements Transport {
  readonly #self: NodeId
  readonly #registry: EndpointRegistry
  readonly #binding: TransportBinding
  #network?: FetchTransport
  readonly #pairing = new Map<NodeId, Promise<void>>()

  constructor(self: NodeId, registry: EndpointRegistry, binding: TransportBinding) {
    this.#self = self
    this.#registry = registry
    this.#binding = binding
  }

  async request<T>(target: NodeId, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.#registry.resolve(target) !== undefined) {
      await this.#pair(target)
      return this.#local<T>(target, method, path, body, signal)
    }
    return this.#networkFor().request<T>(target, method, path, body, signal)
  }

  /** The library's transport for peers this process does not host. */
  #networkFor(): FetchTransport {
    this.#network ??= new FetchTransport(async node => {
      const local = this.#registry.resolve(node)
      if (local !== undefined) return { node_id: local.nodeId, base_url: local.advertisedBaseUrl ?? local.baseUrl }
      const trust = this.#trust()
      try {
        const remote = await this.#binding.resolve?.(node)
        if (remote !== undefined) return remote
        throw new OnlyneError('not_found', `No record answers for ${node}.`)
      } catch (error) {
        // composeResolver semantics: a trusted row's address answers when the
        // discovery catalog has nothing usable for the peer.
        const code = (error as { error?: Failure } | null)?.error?.code
        if (code !== 'not_found' && code !== 'unavailable') throw error
        const entry = await trust.entry(node)
        if (entry?.state !== 'trusted' || entry.base_url === '') throw error
        return { node_id: node, base_url: entry.base_url }
      }
    }, fetch, { trust: this.#trust() })
    return this.#network
  }

  #trust(): TrustService {
    const trust = this.#binding.trust
    if (trust === undefined) throw new OnlyneError('internal', 'The transport was used before its node finished construction.')
    return trust
  }

  /** One trust handshake per co-hosted peer; concurrent senders await the same attempt. */
  #pair(target: NodeId): Promise<void> {
    const known = this.#pairing.get(target)
    if (known !== undefined) return known
    const attempt = (async () => {
      const trust = this.#trust()
      const entry = await trust.entry(target)
      if (entry?.state === 'trusted') return
      const fingerprint = this.#binding.fingerprint
      if (fingerprint === undefined) throw new OnlyneError('internal', 'The transport paired before its node had a key.')
      await trust.request({ actor: this.#self }, target, fingerprint)
    })()
    this.#pairing.set(target, attempt)
    attempt.catch(() => this.#pairing.delete(target))
    return attempt
  }

  async #local<T>(target: NodeId, method: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const trust = this.#trust()
    const endpoint = this.#registry.resolve(target)
    if (endpoint === undefined) throw new OnlyneError('not_found', `No node answers as ${target} in this process.`)
    const entry = await trust.entry(target)
    if (entry?.state !== 'trusted') {
      throw new OnlyneError('unavailable', `The co-hosted peer ${target} is not trusted; its pairing exchange did not settle.`)
    }
    const url = new URL(path.replace(/^\/+/u, ''), endpoint.baseUrl.endsWith('/') ? endpoint.baseUrl : `${endpoint.baseUrl}/`)
    const serialized = body === undefined ? '' : JSON.stringify(body)
    const headers = new Headers()
    if (body !== undefined) headers.set('content-type', 'application/json')
    const signer = new Request(url.href, { method, headers })
    await trust.signRequest(signer, target, serialized)
    for (const [name, value] of signer.headers) headers.set(name, value)
    // The signature covers the body digest, so the dispatch sends the same
    // bytes the signature was computed over.
    const request = new Request(url.href, {
      method,
      headers,
      ...(body === undefined ? {} : { body: serialized }),
    })

    let response: Response
    try {
      response = await endpoint.fetch(request)
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      throw new OnlyneError('unavailable', 'The in-process target failed to answer.', { cause: String(error) })
    }
    const text = await response.text()
    await trust.verifyResponse(target, request, response, text)
    let parsed: unknown
    try { parsed = text === '' ? undefined : JSON.parse(text) } catch { parsed = undefined }

    if (!response.ok) {
      const record = (parsed as { error?: Failure } | undefined)?.error
      if (record !== undefined && typeof record.code === 'string') {
        const rejection = new OnlyneError(record.code as ErrorCode, record.message)
        if (typeof record.retryable === 'boolean') rejection.error.retryable = record.retryable
        throw rejection
      }
      throw new OnlyneError(response.status >= 500 ? 'unavailable' : 'internal', `The in-process target answered HTTP ${String(response.status)} without a failure record.`)
    }
    if (parsed === undefined) throw new OnlyneError('unavailable', 'The in-process target returned a malformed response.')
    endpoint.wake?.()
    return parsed as T
  }
}