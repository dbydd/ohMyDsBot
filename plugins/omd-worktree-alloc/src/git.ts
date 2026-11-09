/**
 * The one place this package runs `git`: an argv array through `execFile`, never
 * a shell string, with stdout capped before it is buffered. Its only caller is
 * `git apply`, which needs the binary but no repository.
 *
 * @module omd-worktree-alloc/git
 */

import { execFile, type ExecFileException } from 'node:child_process'

/** One command: where it runs, what it runs, and the limits on it. */
export interface GitInvocation {
  /** Directory the command runs in. */
  cwd: string
  /** Arguments after `git`, already split. */
  args: readonly string[]
  /**
   * Text written to standard input, for the commands that take a payload:
   * `git apply -` and `git add/reset --pathspec-from-file=-`. Omitted leaves
   * stdin empty and closed.
   */
  input?: string
  /** Ceiling on captured stdout; crossing it rejects instead of buffering more. */
  maxBuffer: number
  /** Deadline for this one command, in milliseconds. */
  timeoutMs: number
}

/** What a command that is allowed to exit non-zero produced. */
export interface GitOutcome {
  /** Exit status; null when the process was killed before it exited. */
  code: number | null
  /** Decoded standard output. */
  stdout: string
  /** Decoded standard error. */
  stderr: string
}

/** A `git` invocation that exited non-zero, or was killed before exiting. */
export class GitCommandError extends Error {
  /** Exit status; null when no exit status was produced. */
  readonly code: number | null
  /** Captured standard error, undecorated. */
  readonly stderr: string

  /**
   * @param args the arguments after `git`
   * @param code exit status, or null when the process was killed
   * @param stderr captured standard error
   * @param reason replaces the stderr text when the process never wrote one
   */
  constructor(args: readonly string[], code: number | null, stderr: string, reason?: string) {
    const detail = reason ?? (stderr.trim() === '' ? 'no stderr' : stderr.trim())
    super(`git ${args.join(' ')} failed (${code === null ? 'no exit status' : `exit ${code}`}): ${detail}`)
    this.name = 'GitCommandError'
    this.code = code
    this.stderr = stderr
  }
}

/** A `git` invocation whose stdout crossed its `maxBuffer`. */
export class GitOutputTooLargeError extends Error {
  /** The cap that was crossed, in bytes. */
  readonly limitBytes: number

  /**
   * @param args the arguments after `git`
   * @param limitBytes the configured cap
   */
  constructor(args: readonly string[], limitBytes: number) {
    super(`git ${args.join(' ')} wrote more than ${limitBytes} bytes to stdout`)
    this.name = 'GitOutputTooLargeError'
    this.limitBytes = limitBytes
  }
}

/**
 * Run one command, resolving every ordinary exit status.
 *
 * A non-zero exit resolves with its status because some calls use it as an
 * answer (`rev-parse --verify --quiet` says "no such ref" that way). The two
 * cases that carry no exit status at all — stdout over the cap, and a process
 * git never started or that was killed — reject instead.
 *
 * @param invocation command, directory, cap, and deadline
 * @returns the exit status and both decoded streams
 * @throws {GitOutputTooLargeError} when stdout crosses `maxBuffer`
 * @throws {GitCommandError} when git cannot be started or is killed
 */
export function tryGit(invocation: GitInvocation): Promise<GitOutcome> {
  const { promise, resolve, reject } = Promise.withResolvers<GitOutcome>()
  const child = execFile(
    'git',
    invocation.args,
    {
      cwd: invocation.cwd,
      encoding: 'utf8',
      maxBuffer: invocation.maxBuffer,
      timeout: invocation.timeoutMs,
      windowsHide: true,
    },
    (error: ExecFileException | null, stdout: string, stderr: string) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr })
        return
      }
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        reject(new GitOutputTooLargeError(invocation.args, invocation.maxBuffer))
        return
      }
      if (typeof error.code === 'number') {
        resolve({ code: error.code, stdout, stderr })
        return
      }
      const reason = error.killed ? `killed after ${invocation.timeoutMs} ms` : error.message
      reject(new GitCommandError(invocation.args, null, stderr, reason))
    },
  )
  // A command that rejects its payload (`apply --check` bails out on the first
  // conflict) closes the pipe early. Its stderr carries the reason, so the EPIPE
  // on this side is not reported as a second failure.
  child.stdin?.on('error', () => undefined)
  child.stdin?.end(invocation.input ?? '')
  return promise
}

/**
 * Run one command and require exit status 0.
 * @param invocation command, directory, cap, and deadline
 * @returns decoded standard output
 * @throws {GitCommandError} when git exits non-zero, cannot be started, or is killed
 * @throws {GitOutputTooLargeError} when stdout crosses `maxBuffer`
 */
export async function runGit(invocation: GitInvocation): Promise<string> {
  const outcome = await tryGit(invocation)
  if (outcome.code !== 0) throw new GitCommandError(invocation.args, outcome.code, outcome.stderr)
  return outcome.stdout
}
