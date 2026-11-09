/**
 * Cross-package vocabulary for `omd-sandbox-vm`: one isolated Linux machine,
 * the workspace directory mounted into it, and the service that owns the
 * machine's whole life.
 *
 * The layer split is deliberate and is why this seam exists at all: the agent
 * runs on the host, its files live in a host directory, and only command
 * execution and the desktop happen inside the machine. Nothing here carries an
 * agent, a model or a session.
 *
 * @module omd-sandbox-vm/types
 */

/** What the caller asks for when it needs a machine. */
export interface SandboxRequest {
  /** Machine name; unique per machine on the host, lowercase, `[a-z0-9-]`. */
  readonly name: string
  /**
   * Absolute host directory to mount at the machine's workspace path. Created
   * on the host when absent. Guest writes land in it directly, which is what
   * lets the caller read a change set on the host afterwards.
   */
  readonly workspacePath: string
}

/** A machine that exists and can be executed in. */
export interface Sandbox {
  /** Machine name, as passed to {@link SandboxService.exec}. */
  readonly name: string
  /** Guest path the workspace is mounted at. */
  readonly workspacePath: string
  /**
   * Interactive view of the guest desktop, when the desktop is enabled and the
   * bridge came up; `undefined` on a machine without one. A human opens it to
   * watch the agent work and to take the mouse and keyboard over.
   */
  readonly desktopUrl?: string
  /** Whether the machine is still reachable. */
  readonly state: SandboxState
}

/** Whether a machine is up, up but without a desktop, or gone. */
export type SandboxState = 'ready' | 'ready-no-desktop' | 'absent'

/** One command run inside a machine. */
export interface SandboxExecOptions {
  /** Guest working directory; defaults to the machine's workspace path. */
  readonly cwd?: string
  /** Wall-clock budget; the run is killed when it expires. */
  readonly timeoutMs?: number
  /** Aborting stops the run and reports it as aborted, not as a failure code. */
  readonly signal?: AbortSignal
  /** Environment additions; the guest's own environment is kept. */
  readonly env?: Readonly<Record<string, string>>
}

/** What one command produced. */
export interface SandboxExecResult {
  /** Exit status; `undefined` when the run was killed by a signal or the deadline. */
  readonly code: number | undefined
  /** Standard output, verbatim. */
  readonly stdout: string
  /** Standard error, verbatim. */
  readonly stderr: string
  /** How the run ended, so a caller can tell a failure from a stop. */
  readonly outcome: 'exited' | 'timeout' | 'aborted'
}

/**
 * The machine provider. It owns creation, execution and disposal; it never
 * decides what is executed, so an agent undecided about its work can still
 * call it.
 */
export interface SandboxService {
  /**
   * Create a machine, or return the one already carrying this name.
   * @param request - the machine name and the host directory to mount.
   * @returns the machine, once it can accept commands.
   */
  provision(request: SandboxRequest): Promise<Sandbox>
  /**
   * Run one command inside a machine.
   * @param name - machine name.
   * @param command - shell command, executed by the guest's `/bin/sh`.
   * @param options - working directory, deadline, cancellation, environment.
   * @returns the exit status and both streams, never a thrown non-zero exit.
   */
  exec(name: string, command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>
  /**
   * Read a machine's state without creating anything.
   * @param name - machine name.
   * @returns the machine when it exists, `undefined` when it does not.
   */
  inspect(name: string): Promise<Sandbox | undefined>
  /**
   * Destroy a machine and everything it held. Idempotent: a missing machine is
   * not an error, so a retried disposal cannot fail on its own success.
   * @param name - machine name.
   */
  dispose(name: string): Promise<void>
  /**
   * List the machines this deployment owns.
   * @returns every machine under the configured name prefix, newest name first.
   */
  list(): Promise<readonly Sandbox[]>
}
