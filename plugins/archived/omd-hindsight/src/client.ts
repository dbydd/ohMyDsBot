/**
 * The Hindsight server transport: one `request()` helper over global `fetch`
 * plus the credential-reference resolution it authenticates with.
 *
 * There is no sanctioned HTTP service in dsh (the reference plugin uses global
 * `fetch` too), so this module is the whole network story: absolute paths off
 * {@link ResolvedConfig.baseUrl}, JSON in and out, bounded error detail.
 *
 * @module omd-hindsight/client
 */

import type { ResolvedConfig } from './config.ts'
import fs from 'node:fs'
import os from 'node:os'

/** How long a credential value may be echoed in an error before truncation. */
const MAX_ERROR_DETAIL_CHARS = 300

/** One Hindsight server failure, with the HTTP status when the server answered. */
export class HindsightError extends Error {
  /** Machine-routable code: `HINDSIGHT_NETWORK` or `HINDSIGHT_HTTP`. */
  readonly code: 'HINDSIGHT_NETWORK' | 'HINDSIGHT_HTTP'
  /** The HTTP status code, when the server answered. */
  readonly status?: number

  constructor(code: 'HINDSIGHT_NETWORK' | 'HINDSIGHT_HTTP', message: string, status?: number) {
    super(message)
    this.name = 'HindsightError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

/**
 * Resolve one credential reference to its CURRENT value: the process
 * environment first, then `~/.dsh/.credentials.yaml`, then a `.env` file in
 * the working directory. Resolution is per call, never cached, so a rotated
 * key reaches the next request without a restart.
 * @param ref - a POSIX identifier naming the secret, never the secret itself.
 * @returns the value, or `undefined` when no layer carries it.
 */
export function resolveRef(ref: string): string | undefined {
  if (!ref) return undefined
  const fromEnv = process.env[ref]
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim()
  return fromCredentialsYaml(ref) ?? fromDotEnv(ref)
}

/** Read one flat `name: value` entry out of `~/.dsh/.credentials.yaml`. */
function fromCredentialsYaml(ref: string): string | undefined {
  return fromFlatFile(`${os.homedir()}/.dsh/.credentials.yaml`, ref, ':')
}

/** Read one `NAME=value` entry out of `.env` in the working directory. */
function fromDotEnv(ref: string): string | undefined {
  return fromFlatFile(`${process.cwd()}/.env`, ref, '=')
}

/** The one-file flat parser both credential layers share. */
function fromFlatFile(path: string, ref: string, separator: string): string | undefined {
  let text: string
  try {
    text = fs.readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf(separator)
    if (at <= 0) continue
    if (trimmed.slice(0, at).trim() !== ref) continue
    const value = trimmed.slice(at + 1).trim().replace(/^['"]|['"]$/g, '')
    return value.length > 0 ? value : undefined
  }
  return undefined
}

/**
 * Run one Hindsight API call. A non-2xx status becomes {@link HindsightError}
 * with the server's detail truncated; a transport failure becomes
 * `HINDSIGHT_NETWORK`. The caller's `signal` passes through untouched — an
 * abort must surface as an abort, not as a plugin error.
 * @param config - resolved plugin configuration carrying the base URL.
 * @param path - the API path after the bank root, beginning with `/`.
 * @param body - the JSON body; `undefined` for a bare GET.
 * @param signal - cancellation for the caller's budget.
 * @param method - the HTTP method; POST when omitted.
 * @returns the parsed JSON response.
 */
export async function request(
  config: ResolvedConfig,
  path: string,
  body: unknown,
  signal: AbortSignal,
  method: 'POST' | 'PATCH' | 'PUT' | 'GET' | 'DELETE' = 'POST',
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const key = resolveRef(config.apiKeyRef)
  if (key !== undefined) headers.authorization = `Bearer ${key}`
  let response: Response
  try {
    const bodyText = body === undefined || method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body)
    response = await fetch(`${config.baseUrl}/v1/default${path}`, {
      method,
      headers,
      ...(bodyText === undefined ? {} : { body: bodyText }),
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new HindsightError('HINDSIGHT_NETWORK', `hindsight: ${method} ${path} failed: ${describe(error)}`)
  }
  if (!response.ok) {
    throw new HindsightError('HINDSIGHT_HTTP', `hindsight: ${method} ${path} → HTTP ${response.status}: ${await detail(response)}`, response.status)
  }
  if (response.status === 204) return {}
  try {
    return await response.json() as Record<string, unknown>
  } catch {
    return {}
  }
}

/** A failure's text, with response bodies and anything secret-shaped redacted. */
function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return redact(text).slice(0, MAX_ERROR_DETAIL_CHARS)
}

/** A response body's first bytes as error detail, redacted and bounded. */
async function detail(response: Response): Promise<string> {
  try {
    return redact((await response.text()).replace(/\s+/g, ' ')).slice(0, MAX_ERROR_DETAIL_CHARS)
  } catch {
    return '(no detail)'
  }
}

/** Replace bearer-shaped tokens and long hex/base64 runs before detail lands in a message. */
function redact(text: string): string {
  return text
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'bearer [redacted]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[redacted]')
}
