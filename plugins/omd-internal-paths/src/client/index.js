// Browser half of omd-internal-paths. Hand-authored because the web shell
// serves this file to the page as-is: there is no client build step, so the
// module-loader factory is written directly. No platform module is required —
// the only services used are `ctx.remote` and `ctx.resources`.
//
// One `ctx.resources` protocol per registered source. A source's protocol is
// its name, so an address is the same string the model side writes:
// `dsh-resource://<source>/<path>`. The value is what Host `read` returned.
//
// Following. A source that declares `live: true` is served as a stream that
// stays open: the first frame is the read, and every `livePollMs` afterwards
// re-reads the same address and yields a frame only when the content differs.
// A `live: false` source yields that one frame and ends, as before. Polling
// rather than a Host push because the missing piece is change detection, not
// transport: `InternalSource` exposes `read` only, so a `subscribe` would have
// to be implemented by every source (or faked by a Host timer), while the
// Remote already carries `mode: 'stream'` methods if a push is added later.
// The interval is published by the Host as a page global, because a client
// bundle is created with no entry config of its own.
//
// Reconciliation. The Remote surface has no change feed for the source roster,
// so the provider set is reconciled at startup and again on a slow timer; a
// source that leaves is unregistered (its addresses then read `none`, the
// model's own behaviour), and a source that arrives gets a protocol. A name
// already served by another package is reported once and left alone.
window.__ModuleLoader__.load({
  id: '@dbydd/omd-internal-paths',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const NAMESPACE = 'omd-internal-paths'
    const SERVICE = 'internalPaths'
    /** Browser global the Host publishes `livePollMs` on. */
    const CONFIG_GLOBAL = '__DSH_INTERNAL_PATHS_CONFIG__'
    /** Follow period when the page carries no Host row; matches the Host default. */
    const DEFAULT_LIVE_POLL_MS = 1500
    /** Roster poll period; the RPC is one small local message. */
    const ROSTER_REFRESH_MS = 15_000

    function strictCodec() {
      return {
        mode: 'strict',
        typeSymbol: 'omd.internalPaths.any',
        create: () => ({ parse: value => value }),
      }
    }

    function descriptor(method, parameters) {
      return {
        id: `${NAMESPACE}#${method}`,
        service: SERVICE,
        namespace: SERVICE,
        method,
        invocation: { kind: 'direct' },
        parameters: parameters.map(name => ({
          name,
          wire: name,
          source: 'json',
          codec: strictCodec(),
        })),
        result: { mode: 'src-json' },
      }
    }

    const CONTRIBUTION = {
      package: NAMESPACE,
      descriptors: [
        descriptor('sources', []),
        descriptor('read', ['address']),
        descriptor('write', ['address', 'content', 'sessionId', 'origin']),
      ],
    }

    function createRemote(ctx) {
      let mounting
      const namespace = async () => {
        const existing = ctx.get(`remote.${SERVICE}`)
        if (existing !== undefined) return existing
        const remote = ctx.get('remote')
        if (remote === undefined) throw new Error('the client Remote service is unavailable')
        mounting ??= remote.$mount(CONTRIBUTION).catch(error => {
          mounting = undefined
          throw error
        })
        await mounting
        const mounted = ctx.get(`remote.${SERVICE}`)
        if (mounted === undefined) throw new Error(`the ${SERVICE} Remote namespace is unavailable`)
        return mounted
      }
      return {
        namespace,
        async sources() {
          const ns = await namespace()
          const result = await ns.sources()
          if (!result.ok) throw new Error(result.error?.message ?? `${SERVICE}.sources failed`)
          return result.value
        },
        async write(address, content, sessionId, origin) {
          const ns = await namespace()
          const result = await ns.write(address, content, sessionId, origin)
          if (!result.ok) throw new Error(result.error?.message ?? `${SERVICE}.write failed`)
          return result.value
        },
      }
    }

    /** The Host-published follow period; a malformed or absent row keeps the default. */
    function livePollMs() {
      const config = globalThis[CONFIG_GLOBAL]
      const value = config !== null && typeof config === 'object' ? config.livePollMs : undefined
      return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.max(1, Math.round(value))
        : DEFAULT_LIVE_POLL_MS
    }

    /** A failed read as a resource failure frame; the model keeps the failed state. */
    function readFailure(error) {
      return {
        ok: false,
        error: {
          code: 'internal-paths/read-failed',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
      }
    }

    /** One Remote read as a frame; undefined means the stream was cancelled. */
    async function readFrame(remote, address, signal) {
      try {
        const ns = await remote.namespace()
        if (signal.aborted) return undefined
        return await ns.read(address)
      } catch (error) {
        if (signal.aborted) return undefined
        return readFailure(error)
      }
    }

    /** Whether two frame values are the same content; bytes compare by value, not identity. */
    function sameValue(left, right) {
      if (left === right) return true
      if (!ArrayBuffer.isView(left) || !ArrayBuffer.isView(right)) return false
      const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength)
      const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength)
      if (a.length !== b.length) return false
      for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return false
      }
      return true
    }

    /** Whether two frames carry the same state; a repeated failure is not a change either. */
    function sameFrame(left, right) {
      if (left.ok !== right.ok) return false
      if (!left.ok) {
        return left.error?.code === right.error?.code && left.error?.message === right.error?.message
      }
      return sameValue(left.value, right.value)
    }

    /**
     * Wait `ms`, or return early when `signal` aborts. The timer is cleared on
     * either path and the abort listener is removed on the normal path, so a
     * stream that follows for hours does not accumulate listeners.
     */
    function delay(ms, signal) {
      if (signal.aborted) return Promise.resolve()
      return new Promise(resolve => {
        const finish = () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = () => {
          clearTimeout(timer)
          finish()
        }
        const timer = setTimeout(finish, ms)
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }

    /** One live address: read now, then re-read on the interval, yielding only changes. */
    async function* follow(remote, address, pollMs, signal) {
      let last
      while (!signal.aborted) {
        const frame = await readFrame(remote, address, signal)
        if (frame === undefined) return
        if (last === undefined || !sameFrame(last, frame)) {
          last = frame
          yield frame
        }
        await delay(pollMs, signal)
      }
    }

    /**
     * One source as a resource protocol: read through the Host. A `live: false`
     * source yields one frame and ends; a `live: true` source is followed until
     * the stream is aborted. `following` holds one controller per address, so a
     * second open of the same address replaces the previous loop instead of
     * stacking a second timer.
     */
    function provider(remote, source, live, pollMs) {
      const following = new Map()
      return {
        protocol: source,
        async *open(address, { signal }) {
          if (!live) {
            const frame = await readFrame(remote, address, signal)
            if (frame !== undefined) yield frame
            return
          }
          if (signal.aborted) return
          following.get(address)?.abort()
          const controller = new AbortController()
          const stop = () => controller.abort()
          signal.addEventListener('abort', stop, { once: true })
          following.set(address, controller)
          try {
            yield* follow(remote, address, pollMs, controller.signal)
          } finally {
            signal.removeEventListener('abort', stop)
            if (following.get(address) === controller) following.delete(address)
          }
        },
      }
    }

    function createRegistry(ctx, remote, pollMs) {
      const providers = new Map()
      const conflicts = new Set()
      let timer
      let disposed = false
      let syncing = false
      let rosterFailureReported = false

      async function sync() {
        // Overlapping runs would both miss the not-yet-registered source and
        // the second registration would look like a protocol conflict.
        if (disposed || syncing) return
        syncing = true
        try {
          let sources
          try {
            sources = await remote.sources()
          } catch (error) {
            if (!disposed && !rosterFailureReported) {
              rosterFailureReported = true
              console.error('omd-internal-paths: cannot enumerate sources', error)
            }
            return
          }
          if (disposed) return
          rosterFailureReported = false
          const wanted = new Set(sources.map(entry => entry.source))
          for (const [source, dispose] of [...providers]) {
            if (wanted.has(source)) continue
            dispose()
            providers.delete(source)
            conflicts.delete(source)
          }
          for (const entry of sources) {
            if (providers.has(entry.source) || conflicts.has(entry.source)) continue
            try {
              providers.set(entry.source, ctx.resources.register(provider(remote, entry.source, entry.live === true, pollMs)))
            } catch (error) {
              conflicts.add(entry.source)
              console.error(`omd-internal-paths: cannot serve "${entry.source}" as a resource protocol`, error)
            }
          }
        } finally {
          syncing = false
        }
      }

      return {
        start() {
          void sync()
          timer = setInterval(() => { void sync() }, ROSTER_REFRESH_MS)
        },
        dispose() {
          disposed = true
          clearInterval(timer)
          for (const dispose of providers.values()) dispose()
          providers.clear()
          conflicts.clear()
        },
      }
    }

    function apply(ctx) {
      const remote = createRemote(ctx)
      const pollMs = livePollMs()
      ctx.effect(() => {
        const registry = createRegistry(ctx, remote, pollMs)
        registry.start()
        return () => registry.dispose()
      }, 'omd-internal-paths: resource protocols')
    }

    exports.apply = apply
    exports.inject = ['resources', 'remote']
    return module.exports
  },
})
