/**
 * Remote protocol bindings for `omd-context-notes`.
 *
 * Implements the Typert Remote descriptors so the Host service methods
 * can be called directly by the client Remote runtime over the Gateway.
 *
 * @module omd-context-notes/remote
 */

/** Stable prototype key of the version-1 Remote method descriptor. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** The direct-receiver marker every method here uses. */
const DIRECT = Object.freeze({ kind: 'direct' })

/**
 * One exported method. `exportName` renames the wire endpoint if needed.
 */
export type RemoteMethodMark =
  | string
  | { readonly method: string; readonly exportName: string }

/**
 * Record that every listed public instance method is a Remote endpoint.
 * @param prototype - the service class's prototype.
 * @param methods - method names, in declaration order.
 */
export function markRemoteMethods(prototype: object, methods: readonly RemoteMethodMark[]): void {
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(methods.map((entry) => {
        const method = typeof entry === 'string' ? entry : entry.method
        return Object.freeze({
          method,
          ...typeof entry === 'string' ? {} : { exportName: entry.exportName },
          invocation: DIRECT,
        })
      })),
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
