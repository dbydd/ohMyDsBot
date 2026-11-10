/**
 * A counting semaphore whose waiters are cancellable and whose capacity can be
 * resized in place.
 *
 * Two properties matter to the caller that queues child agents:
 *
 * - `acquire(signal)` removes its waiter from the queue when the signal fires,
 *   so an abandoned delegation never holds a slot nobody is waiting on.
 * - `resize(max)` changes the limit on the existing instance, so queued and
 *   running holders see the new capacity without losing their place.
 *
 * Waiter order is FIFO: a delegation that queued first starts first once a
 * slot frees.
 *
 * @module omd-task/semaphore
 */

/** One queued acquisition, resolved either with a release function or a rejection. */
interface Waiter {
  /** Hand the caller its release function. */
  resolve(release: () => void): void
  /** Fail the caller's `acquire`. */
  reject(error: Error): void
  /** Stop listening for the caller's abort signal; safe to call twice. */
  cancel(): void
}

/** Reason reported when an acquisition is cancelled before it starts. */
export class SemaphoreAbortError extends Error {
  /**
   * Build the cancellation error for one caller-owned signal.
   *
   * @param signal - the signal whose abort ended the wait.
   */
  constructor(signal: AbortSignal) {
    super('semaphore acquire aborted before a slot was granted', { cause: signal.reason })
    this.name = 'SemaphoreAbortError'
  }
}

/** FIFO counting semaphore with in-place resize and abortable acquisition. */
export class Semaphore {
  #limit: number
  /** Slots handed out and not yet released. */
  #active = 0
  readonly #waiters: Waiter[] = []

  /**
   * @param max - initial capacity, a positive integer.
   * @throws when `max` is not a positive integer.
   */
  constructor(max: number) {
    assertCapacity(max)
    this.#limit = max
  }

  /** Slots currently held. */
  get active(): number {
    return this.#active
  }

  /** Acquisitions waiting for a slot. */
  get pending(): number {
    return this.#waiters.length
  }

  /** Current capacity. */
  get limit(): number {
    return this.#limit
  }

  /**
   * Change capacity without replacing the instance. Lowering it below the
   * number of held slots lets running holders finish; the surplus drains as
   * they release, and no waiter starts until the live count is under the new
   * limit.
   *
   * @param max - new capacity, a positive integer.
   * @throws when `max` is not a positive integer.
   */
  resize(max: number): void {
    assertCapacity(max)
    this.#limit = max
    this.#drain()
  }

  /**
   * Wait for a slot. Resolves with an idempotent release, or rejects with
   * {@link SemaphoreAbortError} when the signal aborts while this waiter is
   * still queued.
   *
   * @param signal - optional cancellation; an already-aborted signal rejects
   * immediately without entering the queue.
   * @returns the release function for the granted slot.
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal !== undefined && signal.aborted) return Promise.reject(new SemaphoreAbortError(signal))
    if (this.#active < this.#limit && this.#waiters.length === 0) {
      this.#active += 1
      return Promise.resolve(this.#mintRelease())
    }
    return this.#enqueue(signal)
  }

  /**
   * Queue one acquisition and wire its cancellation.
   *
   * @param signal - the caller's cancellation, when it supplied one.
   * @returns a promise for the granted slot.
   */
  #enqueue(signal: AbortSignal | undefined): Promise<() => void> {
    const granted = Promise.withResolvers<() => void>()
    const waiter: Waiter = { resolve: granted.resolve, reject: granted.reject, cancel: () => {} }
    if (signal !== undefined) {
      const owner = signal
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(waiter)
        if (index === -1) return
        this.#waiters.splice(index, 1)
        waiter.cancel()
        granted.reject(new SemaphoreAbortError(owner))
      }
      owner.addEventListener('abort', onAbort, { once: true })
      waiter.cancel = () => { owner.removeEventListener('abort', onAbort) }
    }
    this.#waiters.push(waiter)
    return granted.promise
  }

  /** Grant as many queued waiters as the current `active`/`limit` allow. */
  #drain(): void {
    while (this.#waiters.length > 0 && this.#active < this.#limit) {
      const waiter = this.#waiters.shift()
      if (waiter === undefined) return
      this.#active += 1
      waiter.cancel()
      waiter.resolve(this.#mintRelease())
    }
  }

  /**
   * Build the release handed to one holder's caller.
   *
   * @returns an idempotent release that frees exactly one slot.
   */
  #mintRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.#active -= 1
      this.#drain()
    }
  }
}

/**
 * Reject a capacity that cannot represent a slot count.
 *
 * @param max - candidate capacity.
 * @throws when `max` is not a positive safe integer.
 */
function assertCapacity(max: number): void {
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new RangeError(`semaphore capacity must be a positive safe integer, got ${String(max)}`)
  }
}
