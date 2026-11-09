/**
 * `omd-internal-http` — the internal-path registry as an HTTP endpoint, so a
 * script reaches the same addresses the model does.
 *
 * Two verbs, one address syntax: GET fetches a representation, POST submits to
 * the address. The registry already owns that vocabulary
 * (`InternalPathsService.fetch` / `submit`), so this plugin is a transport
 * adapter and nothing else — it maps the caller's identity into `InternalExec`
 * and maps a failed call onto an honest status instead of a 200.
 *
 * A third route carries what a source pushes: GET on `/api/paths/stream`
 * forwards `internalPaths.stream` as server-sent events, so a subscription is
 * a subscription and not a poller. A source that cannot push answers 409 with
 * the registry's own wording.
 *
 * Connection matches routes by exact pathname, so every source needs a route of
 * its own: `/api/paths` lists the roster and `/api/paths/<source>` names one
 * source. The registry is live (a plugin may register after this one loaded),
 * so the per-source routes are reconciled on a short timer and released when
 * the fiber unloads.
 *
 * @module omd-internal-http
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  InternalExec,
  InternalPathsService,
} from '../../omd-internal-paths/src/service.ts'

/** Plugin id the Loader entry carries. */
export const name = 'omd-internal-http'

/** Prefix every route this plugin owns lives under. */
export const ROUTE_PREFIX = '/api/paths'

/** The route that follows a source's pushed changes. */
export const STREAM_ROUTE = `${ROUTE_PREFIX}/stream`

/** How often the per-source routes are reconciled with the live registry. */
export const RESYNC_MS = 1000

/** The part of `ctx.connection.fetch` this plugin registers routes on. */
interface ConnectionFetchFace {
  register(route: {
    path: string
    methods: string[]
    requestBody: string
    fetch: (request: Request) => Promise<Response>
  }): () => void | Promise<void>
}

/** The part of `ctx.connection` this plugin reads. */
interface ConnectionFace {
  fetch?: ConnectionFetchFace
}

/**
 * Tag a body with the content type it actually has. The body is passed through
 * unchanged, so a JSON document keeps the exact bytes its source produced.
 * @param body - what the source returned.
 * @returns a 200 response.
 */
function representation(body: string | Uint8Array): Response {
  if (typeof body !== 'string') {
    // A Response body must sit on an ArrayBuffer; a shared one cannot. The
    // re-view costs nothing in the ordinary case.
    const bytes = body.buffer instanceof ArrayBuffer
      ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
      : new Uint8Array(body)
    return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
  }
  return new Response(body, {
    status: 200,
    headers: { 'content-type': parsesAsJson(body) ? 'application/json' : 'text/plain; charset=utf-8' },
  })
}

/**
 * Whether the body is a JSON document.
 * @param text - the source's text.
 * @returns true when it parses.
 */
function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * An error response. The message is the caller's only account of the failure,
 * so it carries the source's own wording rather than a category.
 * @param status - the HTTP status.
 * @param error - the message.
 * @returns the response.
 */
function failure(status: number, error: string): Response {
  return Response.json({ error }, { status })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Compose one server-sent-events frame.
 * @param event - the event name; undefined for a bare data frame.
 * @param data - the payload; each of its lines becomes one `data:` field.
 * @returns the wire frame.
 */
function frame(event: string | undefined, data: string): string {
  const fields = data.split('\n').map(line => `data: ${line}`).join('\n')
  return event === undefined ? `${fields}\n\n` : `event: ${event}\n${fields}\n\n`
}

/**
 * Follow one pushed address as server-sent events.
 *
 * The body is written while the source yields, so the answer cannot be a
 * buffered one: `event: open` proves the stream established, every pushed line
 * is one `data:` frame, and `event: close` ends it with the reason. The
 * caller's abort travels to the source as `exec.signal`, and the transport
 * stops waiting on a source that ignores it — a client disconnect ends the
 * iteration either way.
 * @param request - the incoming request; `?uri=` names the address.
 * @param paths - the live registry.
 * @returns the event stream, or the reason it could not start.
 */
function followStream(request: Request, paths: InternalPathsService): Response {
  const url = new URL(request.url)
  const uri = (url.searchParams.get('uri') ?? '').trim()
  const exec: InternalExec = {
    signal: request.signal,
    origin: 'script',
    sessionId: url.searchParams.get('session') ?? request.headers.get('x-dsh-session') ?? undefined,
    cwd: url.searchParams.get('cwd') ?? undefined,
  }

  if (uri === '') {
    return failure(400, `missing "uri": GET ${STREAM_ROUTE}?uri=<address> follows an address whose source pushes changes`)
  }

  const resolved = paths.resolve(uri)
  if (resolved === undefined) {
    return Response.json({ error: `no internal source owns ${JSON.stringify(uri)}`, sources: paths.sources(exec) }, { status: 404 })
  }

  let lines: AsyncIterable<string>
  try {
    lines = paths.stream(uri, exec)
  } catch (error) {
    // Once the address resolves, `stream` refuses for exactly two reasons: the
    // permission check, and a source that declares no `watch`. The second is a
    // capability the source does not have, so it is a 409 that names it rather
    // than a failure of the address.
    return resolved.provider.watch === undefined
      ? failure(409, messageOf(error))
      : failure(403, messageOf(error))
  }

  const encoder = new TextEncoder()
  const iterator = lines[Symbol.asyncIterator]()
  let finished = false
  const release = (): void => {
    try {
      void Promise.resolve(iterator.return?.()).catch(() => {
        // A source that rejects on release has already ended the stream.
      })
    } catch {
      // A source that throws on release has already ended the stream.
    }
  }
  const finish = (controller: ReadableStreamDefaultController<Uint8Array>, reason?: string): void => {
    if (finished) return
    finished = true
    try {
      if (reason !== undefined) controller.enqueue(encoder.encode(frame('close', reason)))
      controller.close()
    } catch {
      // The consumer cancelled first; releasing the source is all that is left.
    }
    release()
  }

  // One event per pull: the stream asks for the next line only when its
  // consumer has room, so a source that pushes faster than the socket drains
  // costs one pending read rather than an unbounded queue.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frame('open', uri)))
      if (request.signal.aborted) finish(controller)
      else request.signal.addEventListener('abort', () => finish(controller), { once: true })
    },
    async pull(controller) {
      let step: IteratorResult<string>
      try {
        step = await iterator.next()
      } catch (error) {
        finish(controller, messageOf(error))
        return
      }
      if (finished) return
      if (step.done === true) {
        finish(controller, 'end')
        return
      }
      try {
        controller.enqueue(encoder.encode(frame(undefined, step.value)))
      } catch {
        finish(controller)
      }
    },
    cancel() {
      finished = true
      release()
    },
  })

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    },
  })
}

/**
 * Serve one address request.
 * @param request - the incoming request; `?uri=` names the address.
 * @param paths - the live registry.
 * @param source - the source named by the route, when the route carries one.
 * @returns the representation, the roster, or a failure.
 */
async function serve(request: Request, paths: InternalPathsService, source?: string): Promise<Response> {
  const url = new URL(request.url)
  const uri = (url.searchParams.get('uri') ?? '').trim()
  const exec: InternalExec = {
    signal: request.signal,
    // A shell is neither the model nor a browser: a source that reports who
    // asked must be able to say so.
    origin: 'script',
    sessionId: url.searchParams.get('session') ?? request.headers.get('x-dsh-session') ?? undefined,
    cwd: url.searchParams.get('cwd') ?? undefined,
  }

  if (uri === '') {
    if (request.method === 'GET' && source === undefined) {
      return representation(JSON.stringify({ sources: paths.sources(exec) }))
    }
    return failure(400, source === undefined
      ? `missing "uri": GET ${ROUTE_PREFIX}?uri=<scheme>://<path> reads an address; GET ${ROUTE_PREFIX} alone lists the roster`
      : `missing "uri": GET ${ROUTE_PREFIX}/${source}?uri=<address> reads an address in that source`)
  }

  if (paths.resolve(uri) === undefined) {
    // An address naming no registered source is a miss in the request, not a
    // failure behind the server, so the roster comes back with it.
    return Response.json({ error: `no internal source owns ${JSON.stringify(uri)}`, sources: paths.sources(exec) }, { status: 404 })
  }

  // `?doc=1` asks for the documentation channel: the same text the model reads
  // with the read tool. GET without it is the representation, POST the action.
  const doc = url.searchParams.get('doc') === '1'
  if (doc && request.method !== 'GET') {
    return failure(400, 'documentation is a GET: ?doc=1 reads the description behind an address')
  }
  const action = request.method === 'POST' ? 'write' : 'read'
  try {
    paths.checkPermission(uri, action, exec)
  } catch (error) {
    return failure(403, messageOf(error))
  }

  try {
    if (request.method === 'POST') {
      return representation(await paths.submit(uri, await request.text(), exec))
    }
    if (doc) {
      return representation(await paths.read(uri, exec))
    }
    return representation(await paths.fetch(uri, exec))
  } catch (error) {
    return failure(502, messageOf(error))
  }
}

/**
 * Register the roster route, the stream route, and one route per registered
 * source, then keep the per-source set in step with the registry.
 * @param fetch - the connection's exact-route registry.
 * @param paths - the live internal-path registry.
 * @returns a disposer that releases every route and the reconcile timer.
 */
export function publishRoutes(fetch: ConnectionFetchFace, paths: InternalPathsService): () => void {
  const route = (path: string, source?: string) => ({
    path,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: (request: Request): Promise<Response> => serve(request, paths, source),
  })

  const roster = fetch.register(route(ROUTE_PREFIX))
  // The stream owns GET on its exact path, so it is registered before the
  // per-source reconcile runs; a source named `stream` would collide with it,
  // and that collision is reported rather than silently shadowing either one.
  const stream = fetch.register({
    path: STREAM_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request: Request) => followStream(request, paths),
  })
  const perSource = new Map<string, () => void | Promise<void>>()

  const reconcile = (): void => {
    const names = new Set(paths.sources().map(info => info.source))
    for (const [source, dispose] of perSource) {
      if (names.has(source)) continue
      perSource.delete(source)
      void dispose()
    }
    for (const source of names) {
      if (perSource.has(source)) continue
      try {
        perSource.set(source, fetch.register(route(`${ROUTE_PREFIX}/${source}`, source)))
      } catch (error) {
        // Reconciliation runs on a timer: a throw here would take the host
        // down, and one source's route is a discovery aid, not the service.
        console.error(`omd-internal-http: cannot publish ${ROUTE_PREFIX}/${source}: ${messageOf(error)}`)
      }
    }
  }

  reconcile()
  const timer = setInterval(reconcile, RESYNC_MS)
  return () => {
    clearInterval(timer)
    void roster()
    void stream()
    for (const dispose of perSource.values()) void dispose()
    perSource.clear()
  }
}

/**
 * Publish the registry for as long as this fiber lives.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['connection', 'internalPaths'], (scope) => {
    const connection = scope.get('connection') as ConnectionFace | undefined
    const paths = scope.get('internalPaths') as InternalPathsService | undefined
    if (connection?.fetch === undefined || paths === undefined) return
    const fetch = connection.fetch
    scope.effect(() => publishRoutes(fetch, paths), 'omd-internal-http: routes')
  })
}
