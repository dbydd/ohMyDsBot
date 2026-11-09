/**
 * The one place a provider touches the network.
 *
 * Every provider here funnels through {@link callApi}, so status-to-kind
 * mapping, timeout classification, abort propagation, and error redaction are
 * decided once instead of per vendor.
 *
 * @module omd-web-providers/provider-kit
 */

import { resolveRef } from './keys.ts'
import {
  kindForStatus,
  ProviderFailure,
  safeErrorDetail,
} from './types.ts'

/** One in-flight provider API call. */
export interface ApiCall {
  /** Absolute request URL, already carrying its query string. */
  url: string
  /** Request method and headers; the body is set by the call sites. */
  init: RequestInit
  /** Wall-clock budget for this call, in milliseconds. */
  timeoutMs: number
  /** The caller's cancellation signal, when one was supplied. */
  signal?: AbortSignal | undefined
  /** Credential ref in use, so its value can be redacted out of any message. */
  secretRef?: string
}

/** A provider API response whose status is in the 2xx range. */
export interface ApiResponse {
  /** HTTP status of the successful call. */
  status: number
  /** The response body as text; parsed by the caller. */
  text: string
}

/** True for a caller-driven or fetch-internal abort, which must never be wrapped. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Perform one provider API call and return its body as text.
 *
 * A non-2xx response is a {@link ProviderFailure} here — unlike the resource
 * fetch seam, this is our own API's status, not a fetched page's — and the
 * status is carried on the failure so the chain can route on it without reading
 * the message.
 * @param call the request to perform
 */
export async function callApi(call: ApiCall): Promise<ApiResponse> {
  const secret = call.secretRef === undefined ? undefined : resolveRef(call.secretRef)
  const timeout = AbortSignal.timeout(call.timeoutMs)
  const signal = call.signal === undefined ? timeout : AbortSignal.any([call.signal, timeout])

  let response: Response
  try {
    response = await fetch(call.url, { ...call.init, signal, redirect: 'follow' })
  } catch (error) {
    if (call.signal?.aborted === true) throw error
    if (isAbortError(error)) {
      throw new ProviderFailure(`no response within ${call.timeoutMs}ms`, 'transient', { cause: error })
    }
    throw new ProviderFailure(
      `request to ${safeErrorDetail(call.url, [secret])} failed: ${safeErrorDetail(String((error as Error).message), [secret])}`,
      'network',
      { cause: error },
    )
  }

  const text = await response.text()
  if (!response.ok) {
    throw new ProviderFailure(
      `provider responded ${response.status}: ${safeErrorDetail(text, [secret])}`,
      kindForStatus(response.status),
      { status: response.status },
    )
  }
  return { status: response.status, text }
}

/**
 * Perform one provider API call and parse its JSON body.
 *
 * @param call the request to perform
 * @returns the parsed body, narrowed to `unknown` for the caller to read
 */
export async function callApiJson(call: ApiCall): Promise<unknown> {
  const { status, text } = await callApi(call)
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch (error) {
    throw new ProviderFailure(
      `provider responded ${status} with a body that is not JSON: ${safeErrorDetail(text, [])}`,
      'invalid-response',
      { status, cause: error },
    )
  }
}

/**
 * Join a configured base URL with an operation path, tolerating a trailing
 * slash on the base and an absolute URL passed as the path.
 * @param base the configured endpoint base
 * @param path the operation path or absolute URL
 */
export function endpoint(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/** Attribution header identifying this plugin to provider APIs. */
export const USER_AGENT = 'oh-my-dsh/omd-web-providers (https://github.com/oh-my-dsh)'

/**
 * Build request headers with a bearer token when the credential resolves.
 *
 * Providers that are keyless-legal (Jina Reader, OpenAlex) send no
 * `Authorization` header at all rather than an empty one, because some vendors
 * reject a malformed auth header outright.
 * @param secretRef credential ref to attach as a bearer token
 * @param extra additional headers for the call
 */
export function authHeaders(secretRef: string | undefined, extra: Record<string, string>): Record<string, string> {
  const secret = secretRef === undefined ? undefined : resolveRef(secretRef)
  return {
    'User-Agent': USER_AGENT,
    ...extra,
    ...secret === undefined ? {} : { Authorization: `Bearer ${secret}` },
  }
}
