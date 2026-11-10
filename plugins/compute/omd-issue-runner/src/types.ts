/**
 * Cross-package vocabulary for `omd-issue-runner`: what a job looks like from
 * outside, what the `ctx.issueRunner` service offers, and the services this
 * plugin borrows from the host.
 *
 * The allocator, the directory service and the judgement face are mirrored here
 * rather than imported from the packages that provide them: those packages are
 * not dependencies of this one, and widening them is not this plugin's call.
 * Every mirror names the shape this plugin actually calls.
 *
 * @module omd-issue-runner/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Entry, Json, MessageRef, NodeId, ThreadRef } from '@onlyne/lib'
import type { OnlyneService } from 'omd-onlyne/service'

export type { OnlyneService }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by `omd-worktree-alloc`; without it a job is refused, not faked. */
    worktreeAlloc: WorktreeAllocator
    /** Provided by the session directory service; absent on hosts without one. */
    workingDirectory: DirectoryService
    /** Provided by this plugin. */
    issueRunner: IssueRunnerService
    /** Provided by `dsh-session-persistence`; absent on a host that keeps no durable log. */
    sessionPersistence: SessionPersistenceService
  }
}

// ── the work unit ────────────────────────────────────────────────────────────
// Mirrored from `@onlyne/lib`, where `WorkRef` is the first-class `meta.work`
// field. The unit, not the thread a message happens to be in, is what makes a
// second filing the same job: a Bot that answers in another thread still names
// the work it is continuing.

/** The unit of work one message belongs to, and where it sits in a chain of attempts. */
export interface WorkRef {
  /** The unit's identity; two filings with one unit and one attempt are one job. */
  unit: string
  /** The unit this one was cut from, when it was. */
  parent?: string | null
  /** 1-based attempt at the unit; a new attempt is a new job, not a resumed one. */
  attempt?: number
}

/**
 * One work reference as the JSON its wire field carries.
 * @param work - the reference, when the message named one.
 * @returns the nested object `meta.work` and a card's `work` key hold, or null.
 */
export function workJson(work: WorkRef | undefined): Json {
  if (work === undefined) return null
  return {
    unit: work.unit,
    ...work.parent === undefined ? {} : { parent: work.parent },
    ...work.attempt === undefined ? {} : { attempt: work.attempt },
  }
}

// ── the job as an operator and a peer see it ─────────────────────────────────

/** Where one job is in its life. */
export type IssueJobState =
  /** Waiting for a concurrency slot. */
  | 'queued'
  /** A coding agent is running, or review notes are being applied. */
  | 'running'
  /** The last run finished and the checkout is kept for review. */
  | 'idle'
  /** The last run failed; the reason is in the view. */
  | 'failed'
  /** Cancelled by `cancel`; the checkout was released. */
  | 'cancelled'
  /** Closed by `close`; the checkout and the machine it ran in are gone. */
  | 'closed'
  /** Approved by a `review` verdict; the checkout and the machine are gone. */
  | 'approved'

/** One job, as `list()` and `submit()` report it. */
export interface IssueJobView {
  readonly id: string
  /** `onlyne://runner/issue/<workerId>`: the worker's address, stable for the job's life. */
  readonly worker: string
  /** The worker's own id; independent of the machine it runs in. */
  readonly workerId: string
  readonly title: string
  /** Branch name, fixed once the checkout exists. */
  readonly branch: string
  readonly state: IssueJobState
  /** `owner/id` of the Onlyne thread this job answers; absent for a service-only job. */
  readonly thread?: string
  /** Machine the commands run in, once it is leased. */
  readonly machine?: string
  /** The work unit the job was filed under, when the issue named one. */
  readonly workUnit?: string
  /** The whole work reference, as the issue sent it. */
  readonly work?: WorkRef
  /** Absolute isolated checkout, once provisioned. */
  readonly worktreePath?: string
  /** Files the last collected patch touched. */
  readonly files?: number
  /** Bytes of that patch. */
  readonly patchBytes?: number
  /** The last run's closing text. */
  readonly summary?: string
  /** Why the last run or the provisioning failed. */
  readonly failure?: string
}

/** What a caller hands `submit`. */
export interface IssueSubmitInput {
  /** The issue body: what the coding agent must do. */
  text: string
  /** Short label; defaults to the issue's first line. */
  title?: string
  /** Absolute checkout the isolated tree is cut from; defaults to the process working directory. */
  source?: string
  /** The unit of work this issue is; a second submit of the same unit joins the first job. */
  work?: WorkRef
  /** Thread the answer goes to; without one the job only appears in `list()`. */
  thread?: ThreadRef
  /** Node that filed the issue and receives the answer. */
  requester?: NodeId
  /** Message the answer replies to, so the thread shows it under the issue. */
  inReplyTo?: MessageRef
}

/**
 * The service another plugin, a command or a test drives.
 *
 * The Onlyne node is one front end to this; the service is the other, so a UI
 * does not have to speak the protocol to start or inspect a job.
 */
export interface IssueRunnerService {
  /**
   * Queue one job.
   * @param input - the issue, its origin, and where the answer goes.
   * @returns the job's view at submission time; later states come from {@link list}.
   */
  submit(input: IssueSubmitInput): IssueJobView
  /** Every job this process created, oldest first. */
  list(): IssueJobView[]
  /**
   * Every worker this process still holds, oldest first.
   *
   * This is the catalog `onlyne://runner/workers` serves: a UI reads it
   * instead of scraping chat text, and it names the worker's address beside
   * the machine that address is *not* derived from.
   */
  workers(): WorkerRecord[]
  /**
   * Stop a job and give its checkout back, discarding uncommitted work.
   * @param jobId - the job's id.
   * @returns whether a job of that id existed.
   */
  cancel(jobId: string): boolean
  /**
   * Reclaim a job: stop it, destroy its checkout and the machine it ran in, and
   * answer `closed` in its thread.
   *
   * Closing twice is not an error: the second call answers `closed` again and
   * releases nothing a second time.
   * @param jobId - the job's id.
   * @returns whether a job of that id existed.
   */
  close(jobId: string): Promise<boolean>
}

// ── the worker catalog ───────────────────────────────────────────────────────

/** One worker as the catalog reports it. */
export interface WorkerRecord {
  /** `onlyne://runner/issue/<workerId>`. */
  readonly worker: string
  /** The id inside that address; a machine rename does not touch it. */
  readonly workerId: string
  readonly jobId: string
  /** Machine the commands run in; empty when the backend runs them on the host. */
  readonly machine: string
  /** `owner/id` of the thread the job answers; empty for a service-only job. */
  readonly thread: string
  readonly state: IssueJobState
  /** Epoch milliseconds the job was created at. */
  readonly startedAt: number
  /** Epoch milliseconds of the last state change. */
  readonly updatedAt: number
  readonly workUnit?: string
  readonly work?: WorkRef
  readonly leaseId?: string
  readonly desktopUrl?: string
  /**
   * The coding-agent session driving this worker: the current run's while one
   * is going, otherwise the latest run's. Absent until a backend has minted
   * one; read `onlyne://runner/issue/<workerId>/events` for its feed.
   */
  readonly session?: string
  /**
   * Epoch milliseconds the automatic reclaim fires at, when one is scheduled:
   * the worker has settled, and it is closed unless a review or a close comes
   * first. Absent while the worker is running or when `settleReclaimMs` is 0.
   */
  readonly reclaimAt?: number
}

// ── the worker's session feed ────────────────────────────────────────────────
// A worker's session log, summarized for whoever watches the run. One row per
// message block, tool call and tool result; the payloads are cut to a bounded
// size because this feed is rendered in a panel, not paged by an agent.

/** One line of a worker's session feed. */
export interface RunnerEvent {
  /** Epoch milliseconds the record was written at. */
  readonly at: number
  /** What the row is: a message block, a tool call, or its result. */
  readonly kind: 'text' | 'reasoning' | 'tool' | 'result' | 'user'
  readonly role: 'assistant' | 'user' | null
  /** The message text, for a `text`, `reasoning` or `user` row. */
  readonly text: string | null
  /** Tool name, for a `tool` or `result` row. */
  readonly tool: string | null
  /** The call's arguments as the model wrote them, for a `tool` row. */
  readonly args: string | null
  /** The call's output, for a `result` row. */
  readonly result: string | null
}

/** One worker's session log, summarized for a reader. */
export interface WorkerEvents {
  /** `onlyne://runner/issue/<workerId>`. */
  readonly worker: string
  readonly state: IssueJobState
  /** Oldest first. */
  readonly events: readonly RunnerEvent[]
  /** Whether a payload or the list itself was cut. */
  readonly truncated: boolean
  /**
   * One neutral line about the feed itself, when there is nothing wrong and
   * nothing to show yet — an accepted worker whose coding agent has not
   * started. A reader shows it as status, not as a failure.
   */
  readonly note?: string
}

/** What a feed read produced: the feed, or the reason there is none. */
export type WorkerEventsResult =
  | { readonly kind: 'feed'; readonly value: WorkerEvents }
  | { readonly kind: 'missing'; readonly reason: string }

/**
 * The process-level catalog `omd-onlyne` serves its `onlyne://runner` paths
 * from, published as `globalThis.__onlyneRunnerCatalog` while the plugin is
 * mounted.
 */
export interface RunnerCatalog {
  /** Every worker this process still holds, oldest first. */
  workers(): WorkerRecord[]
  /**
   * Read one worker's session feed.
   * @param worker - the worker address, or the bare id its address carries.
   * @returns the feed, or why the worker or its log could not be read.
   */
  readEvents(worker: string): Promise<WorkerEventsResult>
}

// ── the session log ─────────────────────────────────────────────────────────
// Mirrored from `dsh-session-persistence`: only the read half a feed needs.

/** One open read channel onto a stored session log. */
export interface SessionLogHandle {
  /**
   * Read a slice of the log.
   * @param offset - first logical event seq to include; defaults to 0.
   * @param length - maximum number of events; defaults to the rest of the log.
   */
  read(offset?: number, length?: number, options?: { readonly signal?: AbortSignal }): Promise<{
    readonly events: readonly unknown[]
  }>
  /** Release the handle. */
  close(): Promise<void>
}

/** The part of `ctx.sessionPersistence` this plugin reads. */
export interface SessionPersistenceService {
  /**
   * Open an existing stored session for reading.
   * @param id - the stored session.
   * @param access - `read` observes without taking write ownership.
   * @throws a `SessionPersistenceNotFoundError` when no log is visible here.
   */
  open(id: SessionId, access: 'read', options?: { readonly signal?: AbortSignal }): Promise<SessionLogHandle>
}

// ── the allocator ────────────────────────────────────────────────────────────

/** One isolated working copy. Only `path` and `name` are read here. */
export interface WorktreeAllocation {
  /** Absolute working-copy directory; passed as the child's working directory. */
  path: string
  /** Identifier the allocator named the copy with. */
  name: string
  /** Absolute root of the directory patches are applied back to. */
  sourceRoot: string
  /** Backend that created the tree. */
  backend: 'cow'
}

/** The allocator `omd-worktree-alloc` provides on the context. */
export interface WorktreeAllocator {
  /**
   * Create an isolated tree without touching the caller's own directory.
   * @param name - identifier, also the copy's path below the allocator's pool
   * @param cwd - the directory to copy; no repository is required
   */
  allocate(name: string, cwd?: string): Promise<WorktreeAllocation>
  /** The run's change set as unified diff text, files the run created included. */
  collect(handle: WorktreeAllocation): Promise<string>
  /**
   * Remove one allocated tree.
   * @param handle - the allocation to remove
   * @param options - `force` discards uncommitted files instead of refusing
   */
  release(handle: WorktreeAllocation, options?: { force?: boolean }): Promise<void>
}

// ── the judgement step ───────────────────────────────────────────────────────
// Mirrored from `omd-judgment`; this plugin asks one choice question about one
// finished run, so the face stays as small as that call.

/** What one choice answer looks like to this plugin. */
export interface ChoiceVerdict {
  /** The chosen label, a key of the question's criteria. */
  readonly choice: string
  /** Probability the judge attached to that label. */
  readonly confidence: number
}

/** The part of `ctx.judgment` this plugin calls. */
export interface IssueJudge {
  /** Whether at least one candidate is credentialed and not cooling down. */
  available(): boolean
  /** Answer one round of choice questions. */
  judge(
    request: {
      readonly state: string | { readonly [key: string]: Json }
      readonly questions: Record<string, {
        readonly type: 'choice'
        readonly instructions: string
        readonly criteria: Record<string, string | null>
      }>
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly answers: Record<string, ChoiceVerdict> }>
}

// ── the directory service ────────────────────────────────────────────────────

/** The one method this plugin needs from the host's directory service. */
export interface DirectoryService {
  /**
   * The agent's committed directory, created when it is missing.
   * @param agent - the agent whose directory is wanted
   * @param signal - cancellation of the lookup
   */
  ensure(agent: Agent, signal?: AbortSignal): Promise<string>
}

// ── compute ──────────────────────────────────────────────────────────────────
// Mirrored from `omd-compute`, which answers one Onlyne node. A machine is a
// lease there: this plugin asks for one and the manager decides whether it
// starts, stops or is destroyed. Only the control message crosses; commands and
// the desktop stay `omd-sandbox-vm`'s seam.

/** What an acquire names, beside the operation itself. */
export interface ComputeAcquire {
  /** Machine name; also the identity of the lease, so asking twice joins one machine. */
  readonly name: string
  /** Absolute host directory the machine mounts. */
  readonly workspacePath: string
  /** Image the machine runs; OECP v1's `container.image`. */
  readonly image: string
  /** Lease window asked for, in milliseconds; OECP v1's `lease.ttl_ms`. */
  readonly ttlMs?: number
  /** Free-form label the lease table shows a human. */
  readonly purpose?: string
  /** Work unit the lease is held for, sent as OECP v1's `work`. */
  readonly work?: WorkRef
}

/** The direct data-plane channels an OECP v1 descriptor names. */
export interface ComputeConnection {
  /** `ssh`, `docker_exec` or `k8s_exec`: how commands reach the machine. */
  readonly execTransport?: string
  /** Named endpoints, `vnc-desktop` and any port the acquire asked to publish. */
  readonly endpoints?: { readonly [name: string]: string }
  /** Ticketed interactive entries; `desktop` is the one a human opens. */
  readonly portalUrls?: { readonly desktop?: string }
}

/** One lease as the manager's answer describes it. */
export interface ComputeDescriptor {
  readonly name: string
  /** `running` is the only state a command can run in; `stopped` and `released` cannot. */
  readonly state: string
  readonly workspacePath?: string
  readonly desktopUrl?: string
  /** Epoch milliseconds the lease ends at. */
  readonly expiresAt?: number
  /** Silence, in milliseconds, after which the manager stops the machine. */
  readonly idleTimeoutMs?: number
  /** Stable lease identity; `renew` and `destroy` name it. */
  readonly leaseId?: string
  /** How commands and a human reach the machine. */
  readonly connection?: ComputeConnection
  /** Environment the manager resolved for the machine's declared `expose_env`. */
  readonly resolvedEnv?: { readonly [name: string]: string }
  /** What the provider actually allocated: arch, container id, host. */
  readonly allocated?: { readonly [key: string]: Json }
}

/** What an acquire produced. */
export type ComputeLease =
  /** A manager answered and the machine is up. */
  | { readonly kind: 'granted'; readonly descriptor: ComputeDescriptor }
  /**
   * No manager is reachable — the node id resolved to nothing, or the run has
   * no node. The caller starts the machine itself, as it did before leases.
   */
  | { readonly kind: 'absent' }

/** The control plane, as `vm-agent` and the node runtime consume it. */
export interface ComputeControl {
  /**
   * Ask the manager for one machine.
   * @param spec - the machine name, the directory it mounts and its purpose.
   * @returns the granted lease, or `absent` when no manager answered at all.
   */
  acquire(spec: ComputeAcquire): Promise<ComputeLease>
  /**
   * Extend one running lease.
   *
   * Optional so a manager that predates the verb is still usable: the caller
   * then renews through a same-name acquire, which is what that manager
   * already supported.
   * @param name - machine name.
   * @param ttlMs - window requested from now, in milliseconds.
   * @param leaseId - the lease's identity, when the receipt named one.
   * @returns `renewed` when the manager extended it, `not-owed` when it did
   *   not — refused, expired, or no manager answered.
   */
  renew?(name: string, ttlMs: number, leaseId?: string): Promise<'renewed' | 'not-owed'>
  /**
   * Ask the manager to destroy one machine.
   * @param name - machine name.
   * @returns `destroyed` when the manager took it, `not-owed` when it did not —
   *   the caller then sweeps the machine itself.
   */
  destroy(name: string, leaseId?: string): Promise<'destroyed' | 'not-owed'>
  /**
   * Settle one inbound `compute` answer against the ask waiting for it.
   * @param entry - the admitted message.
   * @returns whether this module consumed the entry.
   */
  settle(entry: Entry): boolean
}

/** What the runner sends back into a thread. */
export interface RunnerReply {
  /**
   * `pr` reports a change set, `failed` a broken run, `closed` a reclaimed
   * worker, `note` anything else.
   */
  readonly kind: 'pr' | 'failed' | 'closed' | 'note'
  readonly body: string
  /** Node that filed the issue. */
  readonly to: NodeId
  /** Thread the answer belongs to. */
  readonly thread: ThreadRef
  /** Message the answer replies to. */
  readonly inReplyTo?: MessageRef
  /** Machine-readable card data: worktree, branch, file count, patch size. */
  readonly data: Record<string, Json>
}

declare global {
  /**
   * The runner's worker catalog, while the plugin is mounted.
   *
   * `omd-onlyne` reads it for `onlyne://runner/workers`,
   * `onlyne://runner/issue/<workerId>` and that worker's `/events`, so a
   * reader of those paths does not have to hold this plugin's service.
   */
  var __onlyneRunnerCatalog: RunnerCatalog | undefined
}
