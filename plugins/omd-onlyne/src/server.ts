/**
 * The HTTP listener that puts nodes on the wire.
 *
 * A node's `base_url` must be a real address: the library's trust handshake inspects the
 * peer's `/keys` route with a plain `fetch`. One process therefore needs one reachable
 * socket, not one per agent: this module keeps a process-wide listener per (host, data
 * root) pair and routes each request to the node it names.
 *
 * A signed request names its recipient in the signature payload (`target`), which the
 * receiving node checks against its own identity. The listener therefore sends root
 * `/onlyne/v3/...` requests to the nodes in registration order and keeps the first answer
 * that is not an authentication failure: a node that is not the intended recipient rejects
 * the signature before it writes anything, so a trial dispatch cannot mutate the wrong node.
 * The `/nodes/<encoded node id>/onlyne/v3/...` spelling routes directly, and an
 * introduction body names its recipient in its own `target` field.
 *
 * The port binds before the node exists (the node's `base_url` needs it), so the handler
 * arrives as a promise: early requests wait for construction instead of failing.
 *
 * @module omd-onlyne/server
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { NodeId } from '@onlyne/lib'
import { rememberPort, rememberedPort } from './storage.ts'

export type NodeHandler = (request: Request) => Promise<Response>

/** One node's place on a listener. */
export interface OnlyneListener {
  /** The address peers dial for this node. */
  readonly baseUrl: string
  /** The socket's port; every co-hosted node answers with the same one. */
  readonly port: number
  /** Withdraws this node; the socket closes with its last node. */
  close(): Promise<void>
}

export interface ListenOptions {
  host: string
  /** `0` asks the OS for a port; a fixed port is shared by every node that names it. */
  port?: number
  /**
   * Where an ephemeral port is remembered. A restart that binds a new port changes the
   * node's address and strands every peer's trust row, so the previous port is preferred.
   */
  portFile?: string
  nodeId: NodeId
  /** Resolves once the node exists; early requests wait for it. */
  handler: Promise<NodeHandler>
}

interface Route {
  readonly nodeId: NodeId
  readonly handler: Promise<NodeHandler>
}

const PREFIX = '/onlyne/v3'
const MOUNT = '/nodes/'
const MAX_SHARED = 200

/** One listener and the nodes it currently answers for, in join order. */
class SharedListener {
  readonly #host: string
  readonly #routes: Route[] = []
  #server?: Server
  #port?: number
  #binding?: Promise<void>
  #closing?: Promise<void>

  constructor(host: string) {
    this.#host = host
  }

  get size(): number { return this.#routes.length }

  /**
   * Put one node on this listener.
   * @param options - identity, handler, and the port policy the host configured.
   * @returns the node's address and the handle that withdraws it.
   */
  async join(options: ListenOptions): Promise<OnlyneListener> {
    if (this.#routes.length >= MAX_SHARED) throw new Error('The Onlyne listener already serves too many nodes.')
    const route: Route = { nodeId: options.nodeId, handler: options.handler }
    this.#routes.push(route)
    try {
      await this.#ensure(options)
    } catch (error) {
      this.#drop(route)
      throw error
    }
    const port = this.#port
    if (port === undefined) throw new Error('The Onlyne listener did not report a port.')
    // A peer configured with nothing but a host and a port must still reach the process,
    // so the first node answers root routes and later ones are named in the path. The
    // library's handler learns that prefix from its mount support; the public routes
    // (`/keys`, `/description`, `/introductions`) also work through it on older revisions.
    const baseUrl = route === this.#routes[0]
      ? `http://${this.#host}:${port}${PREFIX}`
      : `http://${this.#host}:${port}${MOUNT}${encodeURIComponent(route.nodeId)}${PREFIX}`
    return {
      baseUrl,
      port,
      close: async () => {
        this.#drop(route)
        if (this.#routes.length === 0) await this.#close()
      },
    }
  }

  #drop(route: Route): void {
    const index = this.#routes.indexOf(route)
    if (index >= 0) this.#routes.splice(index, 1)
  }

  async #ensure(options: ListenOptions): Promise<void> {
    if (this.#closing !== undefined) await this.#closing
    if (this.#server !== undefined) return
    this.#binding ??= (async () => {
      try {
        await this.#bind(options)
      } finally {
        this.#binding = undefined
      }
    })()
    await this.#binding
  }

  async #bind(options: ListenOptions): Promise<void> {
    const fixed = options.port !== undefined && options.port !== 0 ? options.port : undefined
    const remembered = fixed === undefined && options.portFile !== undefined
      ? rememberedPort(options.portFile)
      : undefined
    // A remembered or ephemeral port may be gone; a configured one is the operator's
    // decision, and a node that cannot bind it must say so instead of moving quietly.
    const server = await listen(this.#host, fixed ?? remembered ?? 0, fixed === undefined)
    const address = server.address()
    if (address === null || typeof address !== 'object') {
      server.close()
      throw new Error('The Onlyne listener did not report an address.')
    }
    this.#server = server
    this.#port = address.port
    server.on('request', (request: IncomingMessage, response: ServerResponse) => {
      void this.#serve(request, response)
    })
    if (fixed === undefined && options.portFile !== undefined) rememberPort(options.portFile, address.port)
  }

  async #close(): Promise<void> {
    const server = this.#server
    if (server === undefined) return
    this.#server = undefined
    this.#port = undefined
    const { promise, resolve } = Promise.withResolvers<void>()
    this.#closing = promise
    server.close(() => {
      this.#closing = undefined
      resolve()
    })
    await promise
  }

  async #serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      const body = await readBody(request)
      const answer = await this.#dispatch(url, request, body)
      response.writeHead(answer.status, forwardHeaders(answer.headers))
      if (answer.body === null) {
        response.end()
        return
      }
      const stream = Readable.fromWeb(answer.body as never)
      stream.pipe(response)
      stream.on('error', () => response.destroy())
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'internal', message: 'The listener failed to relay the request.' } }))
      console.error('omd-onlyne listener error:', error)
    }
  }

  async #dispatch(url: URL, request: IncomingMessage, body: Buffer): Promise<Response> {
    const mounted = mountOf(url.pathname)
    if (mounted !== undefined) {
      const route = mounted.nodeId === undefined ? undefined : this.#find(mounted.nodeId)
      if (route === undefined) return failure(404, 'not_found', `No Onlyne node is named ${String(mounted.nodeId)}.`)
      return this.#forward(route, url, request, body, mounted)
    }
    if (!url.pathname.startsWith(`${PREFIX}/`)) return failure(404, 'not_found', 'Unknown route.')

    const named = url.searchParams.get('node') ?? request.headers['onlyne-target']
    if (typeof named === 'string' && named !== '') {
      const route = this.#find(named)
      if (route !== undefined) return this.#forward(route, url, request, body, { nodeId: named, path: url.pathname })
    }

    // The exchange names its recipient in the body: an introduction is addressed to the
    // node whose key the sender expects to find. `/keys` and `/description` carry no such
    // field, so the listener's first node answers them.
    if (url.pathname === `${PREFIX}/introductions`) {
      const target = targetOf(body)
      const route = target === undefined ? undefined : this.#find(target)
      if (route !== undefined) return this.#forward(route, url, request, body, { nodeId: target, path: url.pathname })
    }

    const signed = request.headers['onlyne-sig'] !== undefined
    if (!signed) {
      const first = this.#routes[0]
      if (first === undefined) return failure(404, 'not_found', 'No Onlyne node answers on this listener.')
      return this.#forward(first, url, request, body, { nodeId: first.nodeId, path: url.pathname })
    }

    let rejection: Response | undefined
    for (const route of this.#routes) {
      const answer = await this.#forward(route, url, request, body, { nodeId: route.nodeId, path: url.pathname })
      // Anything but an authentication failure is the intended node's answer; a wrong node
      // rejects the signature before its first write, so trying the next one changes nothing.
      if (answer.status !== 401 && answer.status !== 403) return answer
      rejection = answer
    }
    return rejection ?? failure(404, 'not_found', 'No Onlyne node answers on this listener.')
  }

  #find(nodeId: NodeId): Route | undefined {
    return this.#routes.find(route => route.nodeId === nodeId)
  }

  /**
   * Hand one request to one node. The signed path is never rewritten — the sender's
   * signature covers it — but an unsigned mounted request is answered at the root path, so
   * a library revision that only knows the root prefix can still serve `/keys`,
   * `/description` and the introduction exchange.
   */
  async #forward(route: Route, url: URL, request: IncomingMessage, body: Buffer, mount: Mount): Promise<Response> {
    const handler = await route.handler
    const signed = request.headers['onlyne-sig'] !== undefined
    const path = signed ? mount.path : rootPath(mount)
    try {
      return await handler(new Request(new URL(path + url.search, 'http://localhost'), {
        method: request.method,
        headers: new Headers(request.headers as Record<string, string>),
        ...(body.length === 0 ? {} : { body: new Uint8Array(body) }),
      }))
    } catch (error) {
      console.error('omd-onlyne node failed:', error)
      return failure(500, 'internal', 'The node failed to complete the request.')
    }
  }
}

/** A parsed `/nodes/<id>/onlyne/v3/...` path. */
interface Mount {
  readonly nodeId: NodeId | undefined
  readonly path: string
}

/** The node a mounted path names, with the path exactly as the sender wrote it. */
function mountOf(pathname: string): Mount | undefined {
  if (!pathname.startsWith(MOUNT)) return undefined
  const rest = pathname.slice(MOUNT.length)
  const cut = rest.indexOf(PREFIX)
  if (cut <= 0) return undefined
  const tail = rest.slice(cut)
  if (tail !== PREFIX && !tail.startsWith(`${PREFIX}/`)) return undefined
  const encoded = rest.slice(0, cut)
  let nodeId: string | undefined
  try { nodeId = decodeURIComponent(encoded) } catch { nodeId = undefined }
  return { nodeId, path: pathname }
}

/** The root spelling of a mounted path; unchanged for a request that already has one. */
function rootPath(mount: Mount): string {
  const index = mount.path.indexOf(PREFIX)
  return index < 0 ? mount.path : mount.path.slice(index)
}

/** The `target` an introduction body names. */
function targetOf(body: Buffer): string | undefined {
  if (body.length === 0) return undefined
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { target?: unknown }
    return typeof parsed.target === 'string' && parsed.target !== '' ? parsed.target : undefined
  } catch {
    return undefined
  }
}

function failure(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function listen(host: string, port: number, retry: boolean): Promise<Server> {
  const { promise, resolve, reject } = Promise.withResolvers<Server>()
  const server = createServer()
  server.once('error', (error: Error) => {
    server.close(() => {})
    if (retry && port !== 0) {
      // A remembered port may be taken by another process; the address moves and the
      // listener still comes up rather than failing the whole plugin.
      resolve(listen(host, 0, false))
      return
    }
    reject(error)
  })
  server.listen(port, host, () => resolve(server))
  return promise
}

function forwardHeaders(headers: Headers): Record<string, string> {
  const forwarded: Record<string, string> = {}
  for (const [name, value] of headers) {
    if (name === 'transfer-encoding' || name === 'connection' || name === 'content-length') continue
    forwarded[name] = value
  }
  return forwarded
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** One listener per host and data root: a distinct `DSH_HOME` is a distinct deployment. */
const listeners = new Map<string, SharedListener>()

/**
 * Join the process listener for one host, or a fixed port, and register one node on it.
 * @param options - identity, handler, port policy and the remembering file.
 * @param options.dedicated - a node that must own its socket instead of sharing one.
 * @returns the node's address on the wire.
 */
export async function joinNodeListener(options: ListenOptions & { dedicated?: boolean }): Promise<OnlyneListener> {
  const key = options.dedicated === true
    ? `dedicated:${options.host}:${String(nextDedicated++)}`
    : options.port !== undefined && options.port !== 0
      ? `port:${options.host}:${String(options.port)}`
      : `auto:${options.host}:${options.portFile ?? ''}`
  let listener = listeners.get(key)
  if (listener === undefined) {
    listener = new SharedListener(options.host)
    listeners.set(key, listener)
  }
  const joined = await listener.join(options)
  return {
    ...joined,
    close: async () => {
      await joined.close()
      if (listener.size === 0 && listeners.get(key) === listener) listeners.delete(key)
    },
  }
}

let nextDedicated = 0
