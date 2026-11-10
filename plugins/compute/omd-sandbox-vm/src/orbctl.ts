/**
 * The one place this package runs `orbctl`: an argv array through `execFile`,
 * never a shell string, so a command and a path stay distinguishable.
 *
 * The deadline and the caller's cancellation are owned here rather than handed
 * to `execFile`'s own `timeout` and `signal` options, because the caller is
 * told which of the two stopped a run and those options do not say which fired.
 *
 * A stopped run is killed with `SIGKILL`: `orbctl` has nothing to flush, and a
 * wedged OrbStack daemon must not hold a promise open behind a polite `SIGTERM`.
 * The guest side of a killed run is OrbStack's business, not this module's.
 *
 * @module omd-sandbox-vm/orbctl
 */

import { execFile } from 'node:child_process'

/** One call: which executable, what it runs, and the limits on it. */
export interface OrbctlInvocation {
  /** The `orbctl` binary, from configuration. */
  readonly orbctlPath: string
  /** Arguments after the binary, already split. */
  readonly argv: readonly string[]
  /** Deadline for this one call, in milliseconds. */
  readonly timeoutMs: number
  /** Ceiling on captured stdout; crossing it rejects instead of buffering more. */
  readonly maxBuffer: number
  /** The caller's cancellation; aborting kills the call and reports `aborted`. */
  readonly signal?: AbortSignal
  /**
   * Additions to the environment of the `orbctl` process itself. `orbctl`
   * forwards only the names listed in `ORBENV`, so a caller adding a variable
   * for the guest has to add that name there as well.
   */
  readonly env?: Readonly<Record<string, string>>
}

/** What one call produced. */
export interface OrbctlOutcome {
  /** Exit status; null when the call was killed. */
  readonly code: number | null
  /** Decoded standard output, verbatim. */
  readonly stdout: string
  /** Decoded standard error, verbatim. */
  readonly stderr: string
  /** How the call ended. */
  readonly outcome: 'exited' | 'timeout' | 'aborted'
}

/** An `orbctl` call that produced no exit status, or one the caller required to succeed. */
export class OrbctlError extends Error {
  /** The arguments after the binary, as they were passed. */
  readonly argv: readonly string[]
  /** Exit status; null when no exit status was produced. */
  readonly code: number | null
  /** Captured standard error, undecorated. */
  readonly stderr: string

  /**
   * @param argv - the arguments after the binary
   * @param code - exit status, or null when the call produced none
   * @param stderr - captured standard error
   * @param reason - replaces the stderr text when stderr says nothing
   */
  constructor(argv: readonly string[], code: number | null, stderr: string, reason?: string) {
    const detail = reason ?? (stderr.trim() === '' ? 'no stderr' : stderr.trim())
    super(`orbctl ${argv.join(' ')} failed (${code === null ? 'no exit status' : `exit ${code}`}): ${detail}`)
    this.name = 'OrbctlError'
    this.argv = argv
    this.code = code
    this.stderr = stderr
  }
}

/**
 * Run one call, resolving every ordinary exit status.
 *
 * A non-zero exit resolves with its status, because `orbctl` uses it for
 * answers a caller may want to read (`list` of an empty host, a machine that
 * turned out to be gone). Only the cases that carry no exit status at all — a
 * binary that cannot be started, a killed run, stdout over the cap — reject.
 *
 * @param invocation - command, limits, cancellation and environment
 * @returns the exit status, both decoded streams, and how the call ended
 * @throws {OrbctlError} when the binary cannot be started, the run is killed
 * with no observed cause, or stdout crosses `maxBuffer`
 */
export function tryOrbctl(invocation: OrbctlInvocation): Promise<OrbctlOutcome> {
  if (invocation.signal?.aborted === true) {
    return Promise.resolve({ code: null, stdout: '', stderr: '', outcome: 'aborted' })
  }
  const { promise, resolve, reject } = Promise.withResolvers<OrbctlOutcome>()
  let stoppedBy: 'timeout' | 'aborted' | undefined
  const child = execFile(
    invocation.orbctlPath,
    [...invocation.argv],
    {
      encoding: 'utf8',
      maxBuffer: invocation.maxBuffer,
      windowsHide: true,
      ...invocation.env === undefined ? {} : { env: { ...process.env, ...invocation.env } },
    },
    (error, stdout, stderr) => {
      clearTimeout(timer)
      invocation.signal?.removeEventListener('abort', stop)
      if (stoppedBy !== undefined) {
        resolve({ code: null, stdout, stderr, outcome: stoppedBy })
        return
      }
      if (error === null) {
        resolve({ code: 0, stdout, stderr, outcome: 'exited' })
        return
      }
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        reject(new OrbctlError(invocation.argv, null, stderr, `wrote more than ${invocation.maxBuffer} bytes to stdout`))
        return
      }
      if (typeof error.code === 'number') {
        resolve({ code: error.code, stdout, stderr, outcome: 'exited' })
        return
      }
      reject(new OrbctlError(invocation.argv, null, stderr, error.killed ? 'killed before it exited' : error.message))
    },
  )
  const timer = setTimeout(() => {
    if (stoppedBy === undefined) stoppedBy = 'timeout'
    child.kill('SIGKILL')
  }, invocation.timeoutMs)
  const stop = (): void => {
    if (stoppedBy === undefined) stoppedBy = 'aborted'
    child.kill('SIGKILL')
  }
  invocation.signal?.addEventListener('abort', stop, { once: true })
  return promise
}

/**
 * Run one call and require it to succeed.
 * @param invocation - command, limits, cancellation and environment
 * @returns decoded standard output
 * @throws {OrbctlError} on a non-zero exit, a killed run, or an unstartable binary
 */
export async function runOrbctl(invocation: OrbctlInvocation): Promise<string> {
  const outcome = await tryOrbctl(invocation)
  if (outcome.outcome !== 'exited') {
    throw new OrbctlError(invocation.argv, null, outcome.stderr, `the call was ${outcome.outcome}`)
  }
  if (outcome.code !== 0) throw new OrbctlError(invocation.argv, outcome.code, outcome.stderr)
  return outcome.stdout
}
