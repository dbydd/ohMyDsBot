/**
 * Error classification and bounded retry for the memory-server client.
 *
 * Retry is a policy, not a reflex: a 5xx, a timeout, or a transport failure
 * is worth another attempt because the server may be starting; a 4xx means
 * the request itself is wrong and repeating it only wastes the caller's time.
 *
 * @module omd-memory/client/retry
 */

/** The status-carrying shape both the SDK error and our own error use. */
interface StatusCarrier {
  status?: number
  statusCode?: number
}

/**
 * Read an HTTP status off a thrown value, whichever field carries it.
 * @param error - anything thrown.
 * @returns the status, or `undefined` when the value carries none.
 */
export function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const carrier = error as StatusCarrier
  const status = carrier.status ?? carrier.statusCode
  return typeof status === 'number' ? status : undefined
}

/**
 * Whether the same request may succeed on a second attempt.
 * @param error - anything thrown by one attempt.
 * @returns true for server-side statuses and transport-level failures.
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const status = statusOf(error)
  if (status !== undefined) return status >= 500
  const message = error.message
  return message.includes('timed out')
    || message.includes('fetch failed')
    || message.includes('ECONNREFUSED')
    || message.includes('ENOTFOUND')
    || message.includes('ETIMEDOUT')
    || message.includes('ECONNRESET')
}

/**
 * Run one operation, retrying only retryable failures with exponential
 * backoff and jitter.
 * @param operation - label carried by the final error when nothing was thrown but attempts ran out.
 * @param fn - the attempt.
 * @param maxRetries - retries after the first attempt.
 * @param baseDelayMs - first backoff step; each later step doubles it.
 * @returns the attempt's result.
 */
export async function withRetry<T>(
  operation: string,
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1_000,
): Promise<T> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const jitter = Math.random() * baseDelayMs * 0.5
      await new Promise<void>((resolve) => { setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1) + jitter) })
    }
    try {
      return await fn()
    } catch (error) {
      if (!isRetryableError(error)) throw error
      lastError = error as Error
    }
  }
  throw lastError ?? new Error(`${operation} failed after retries`)
}
