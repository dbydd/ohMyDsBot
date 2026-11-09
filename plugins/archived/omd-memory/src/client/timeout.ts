/**
 * Abort and timeout semantics for one HTTP call. The memory server is an
 * optional dependency of a turn: its failure has to surface as a missing
 * result, never as an unbounded wait, so every call here is bounded.
 *
 * @module omd-memory/client/timeout
 */

/**
 * Build the error an aborted operation throws.
 * @param operation - label carried by the message.
 * @returns an Error whose name is `AbortError`.
 */
export function abortError(operation: string): Error {
  const error = new Error(`${operation} aborted`)
  error.name = 'AbortError'
  return error
}

/**
 * Whether a thrown value means "the operation was cancelled".
 * @param error - anything thrown.
 * @returns true for an abort, whether from a signal or a timeout.
 */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if ('name' in error && String(error.name) === 'AbortError') return true
  const message = 'message' in error && typeof error.message === 'string' ? error.message : ''
  return /\baborted\b/i.test(message)
}

/**
 * Throw if a signal is already aborted.
 * @param signal - the caller's signal, when it has one.
 * @param operation - label carried by the thrown error.
 */
export function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) throw abortError(operation)
}

/**
 * Run one operation under a deadline and an optional parent signal. Every
 * losing branch is contained: the timer is cleared and the parent listener
 * removed whatever the outcome.
 * @param operation - label carried by timeout and abort errors.
 * @param timeoutMs - deadline in milliseconds.
 * @param fn - the operation, receiving the signal it must forward.
 * @param parentSignal - cancellation inherited from the caller.
 * @returns the operation's result.
 */
export async function withTimeout<T>(
  operation: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  throwIfAborted(parentSignal, operation)

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeAbortListener: (() => void) | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(`${operation} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    })
    const abort = parentSignal
      ? new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          controller.abort(parentSignal.reason)
          reject(abortError(operation))
        }
        parentSignal.addEventListener('abort', onAbort, { once: true })
        removeAbortListener = () => parentSignal.removeEventListener('abort', onAbort)
      })
      : undefined
    return await Promise.race([fn(controller.signal), timeout, ...(abort ? [abort] : [])])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    removeAbortListener?.()
  }
}
