/**
 * The Onlyne compute control-plane message.
 *
 * A lease is a message on the bus `@onlyne/lib` already carries, in the shape
 * `@onlyne/compute-gateway` accepts: `delivery_kind: "compute"` with the OECP
 * v1 fields on `meta`, and a reply of `delivery_kind: "compute-result"` whose
 * `msg` is the JSON descriptor. Commands and the desktop do not travel here.
 *
 * omd's client stores `MsgInput.meta` as the delivered `message.meta.data`, so
 * a reply also spreads the descriptor into `meta`. A caller reads `msg` first
 * and `meta.data` when the body is not JSON. That second read is the older
 * omd envelope, not a second bus.
 *
 * @module omd-compute/wire
 */

import type { Entry, Json, MsgInput } from '@onlyne/lib'

/** Request kind. The providing node executes this and does not execute its own replies. */
export const COMPUTE_REQUEST_KIND = 'compute'

/** Reply kind from `@onlyne/compute-gateway`. */
export const COMPUTE_RESULT_KIND = 'compute-result'

/** Refusal kind this manager still emits, and that a caller treats as a failed result. */
export const COMPUTE_FAILED_KIND = 'failed'

/** Operations the providing node implements. */
export const COMPUTE_WIRE_OPERATIONS = ['acquire', 'renew', 'release', 'destroy', 'status'] as const

/** One control-plane operation, as OECP v1 spells it. */
export type ComputeWireOperation = (typeof COMPUTE_WIRE_OPERATIONS)[number]

/** Fields a requester puts on `meta`. Unknown keys are left for the provider to ignore. */
export interface ComputeWireRequest {
  readonly operation: ComputeWireOperation
  readonly name?: string
  readonly lease_id?: string
  /**
   * How long this renew extends the lease, in milliseconds.
   * `@onlyne/compute-gateway` reads this on `meta` itself for `renew`;
   * an acquire still nests the same number under `lease.ttl_ms`.
   */
  readonly ttl_ms?: number
  readonly workspacePath?: string
  readonly container?: { readonly image?: string; readonly mounts?: ReadonlyArray<{ readonly host_path?: string; readonly container_path?: string }> }
  readonly lease?: { readonly ttl_ms?: number; readonly max_ttl_ms?: number; readonly idle_timeout_ms?: number }
  readonly purpose?: string
  readonly work?: Json
}

/**
 * One `compute` request.
 * @param to - node id of the provider, such as `urn:onlyne:agent:compute`.
 * @param request - the operation and the OECP fields.
 * @param text - a short human reading of the ask. The provider reads `meta`, not this string.
 * @returns the `msg` input.
 */
export function computeRequest(to: string, request: ComputeWireRequest, text: string): MsgInput {
  const meta: Record<string, Json> = {
    to,
    operation: request.operation,
  }
  if (request.name !== undefined) meta.name = request.name
  if (request.lease_id !== undefined) meta.lease_id = request.lease_id
  if (request.ttl_ms !== undefined) meta.ttl_ms = request.ttl_ms
  if (request.workspacePath !== undefined) meta.workspacePath = request.workspacePath
  if (request.container !== undefined) meta.container = request.container as Json
  if (request.lease !== undefined) meta.lease = request.lease as Json
  if (request.purpose !== undefined) meta.purpose = request.purpose
  if (request.work !== undefined) meta.work = request.work
  return { delivery_kind: COMPUTE_REQUEST_KIND, msg: text, meta }
}

/**
 * JSON body of a `compute-result`.
 * @param payload - descriptor or error object.
 * @returns the string a providing node puts in `msg`.
 */
export function computeResultBody(payload: Record<string, Json>): string {
  return JSON.stringify(payload)
}

/** A JSON object, or undefined when the value is not one. */
function objectOf(value: unknown): Record<string, Json> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, Json>
}

/**
 * The descriptor or refusal in one reply.
 *
 * Standard replies carry the object in `msg`. Replies from the previous omd
 * manager carry it in `meta.data` and use `delivery_kind: "compute"`.
 * @param entry - the admitted reply.
 * @returns the object, or undefined when this entry is not a compute reply.
 */
export function readComputeResult(entry: Entry): { readonly ok: true; readonly data: Record<string, Json> } | { readonly ok: false; readonly reason: string } | undefined {
  const kind = entry.message.delivery_kind
  if (kind !== COMPUTE_RESULT_KIND && kind !== COMPUTE_REQUEST_KIND && kind !== COMPUTE_FAILED_KIND) return undefined
  const parsed = kind === COMPUTE_FAILED_KIND ? undefined : objectOf(parseJson(entry.message.msg))
  const data = parsed ?? objectOf(entry.message.meta?.data) ?? {}
  if (kind === COMPUTE_FAILED_KIND || data.ok === false || objectOf(data.error) !== undefined) {
    const error = objectOf(data.error)
    const reason = typeof error?.message === 'string' ? error.message : entry.message.msg
    return { ok: false, reason }
  }
  return { ok: true, data }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
