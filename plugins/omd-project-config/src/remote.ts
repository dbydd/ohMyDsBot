/**
 * The two runtime structures that make a Host service a Typert Remote
 * namespace, constructed without importing `@deepseek-ai/dsh-typert-protocol`.
 *
 * Why not import the protocol: dsh resolves a plugin's bare imports from the
 * plugin's real path, and the protocol package is not part of the host runtime
 * the profile links into `plugins/node_modules`. The shapes used here are the
 * protocol's own documented runtime contract — a frozen `typertRemote`
 * binding `{ service, serviceKey, namespace }` and a frozen, version-1 method
 * descriptor under the stable string key below — so the installed Gateway
 * reads them exactly as it reads generated artifacts. Source-mode dispatch
 * derives wire parameters from the method signatures and uses `src-json`
 * codecs; that is the same path this repository's plugins run under.
 *
 * @module omd-project-config/remote
 */

/** Stable prototype key of the version-1 Remote method descriptor. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** The direct-receiver marker every method here uses. */
const DIRECT = Object.freeze({ kind: 'direct' })

/**
 * Record that every listed public instance method is a Remote endpoint.
 * @param prototype - the service class's prototype.
 * @param methods - method names, in declaration order.
 */
export function markRemoteMethods(prototype: object, methods: readonly string[]): void {
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(methods.map(method => Object.freeze({ method, invocation: DIRECT }))),
    }),
  })
}

/**
 * Attach the Gateway's visible binding to one live service instance.
 * @param service - the provided service object.
 * @param serviceKey - its Cordis service key.
 * @param namespace - wire namespace; the service key when omitted.
 */
export function bindRemote(service: object, serviceKey: string, namespace: string = serviceKey): void {
  Object.defineProperty(service, 'typertRemote', {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ service, serviceKey, namespace }),
    writable: false,
  })
}
