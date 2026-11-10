/**
 * Cross-package vocabulary for `omd-compute`: one lease on one machine, the
 * manager that hands leases out, and the wire shape a `compute` message carries.
 *
 * The split this seam carries is the point of the plugin. A machine's commands
 * and its desktop belong to `omd-sandbox-vm`; what belongs here is the *claim*
 * on that machine — who asked, for what, until when — plus the lifecycle a claim
 * implies: start it when the lease is taken, stop it when the lease expires,
 * destroy it when the lease is released. Nothing in this module runs a command.
 *
 * @module omd-compute/types
 */

import type { Json } from '@onlyne/lib'

/** The five verbs one `compute` message may name. */
export type ComputeOperation = 'acquire' | 'renew' | 'release' | 'destroy' | 'status'

/** The verbs, in the order a refusal lists them. */
export const COMPUTE_OPERATIONS: readonly ComputeOperation[] = ['acquire', 'renew', 'release', 'destroy', 'status']

/** Why the sweep took a running lease's machine down. */
export type ExpiryReason = 'ttl_expired' | 'idle_timeout' | 'max_ttl_reached'

/** One mount the caller asked for. */
export interface ComputeMount {
  /** How the guest path is backed. */
  readonly type: 'bind' | 'volume' | 'tmpfs'
  /** Host directory a bind mount comes from; absent when the platform picks one. */
  readonly hostPath?: string
  /** Path inside the machine. */
  readonly containerPath: string
  readonly readOnly: boolean
}

/** One port the caller wants reachable. */
export interface ComputePort {
  /** Logical name, which is the key the receipt's `connection.endpoints` uses. */
  readonly name: string
  readonly containerPort: number
  readonly protocol: string
  /** Whether the caller wants an ingress endpoint minted for it. */
  readonly public: boolean
}

/**
 * One `compute` message as it arrived, both envelope layers merged.
 *
 * OECP v1 spells the request on the message's `meta`; the first implementation
 * read it off `meta.data`. Both are read, the top level winning, so a caller
 * written against either spelling reaches the same manager. The fields this
 * driver cannot honour are still parsed: a provider's placement constraints and
 * port exposure are recorded on the request and reported by nothing, rather
 * than silently mistaking "asked for" for "got".
 */
export interface ComputeRequest {
  readonly operation?: ComputeOperation
  readonly name?: string
  readonly leaseId?: string
  readonly workspacePath?: string
  readonly ttlMs?: number
  readonly maxTtlMs?: number
  readonly idleTimeoutMs?: number
  readonly autoDestroy?: boolean
  readonly image?: string
  readonly env?: Record<string, string>
  readonly exposeEnv?: readonly string[]
  readonly mounts?: readonly ComputeMount[]
  readonly cpus?: number
  readonly memoryMb?: number
  readonly diskGb?: number
  readonly exposePorts?: readonly ComputePort[]
  readonly providerMeta?: Json
  readonly purpose?: string
}

/** What a caller asks for when it needs compute, restricted to what this driver can honour. */
export interface ComputeSpec {
  /**
   * Caller-chosen name for the machine. Doubles as the identity of the lease, so
   * asking twice for the same name by the same owner joins the existing lease
   * instead of making a second machine.
   */
  readonly name: string
  /**
   * Absolute host directory mounted into the machine. Omitted means a directory
   * the manager creates under its own pool, in which case the machine's files
   * die with the lease.
   */
  readonly workspacePath?: string
  /** How long the claim lasts, in milliseconds. Defaults to the manager's own window. */
  readonly ttlMs?: number
  /** Ceiling this caller accepts on the lease's whole lifetime; the deployment's cap still wins. */
  readonly maxTtlMs?: number
  /** How long the lease may go untouched before the sweep stops it; 0 disables the check. */
  readonly idleTimeoutMs?: number
  /** Discard the disk when the caller releases the lease, instead of stopping the machine. */
  readonly autoDestroy?: boolean
  /** Free-form label for a human reading `compute://`: what this machine is for. */
  readonly purpose?: string
  /**
   * What the caller asked the machine to have. The receipt prefers the
   * provider's own numbers and falls back to these when it reports none.
   */
  readonly cpus?: number
  readonly memoryMb?: number
  readonly diskGb?: number
}

/** What the machine actually got, as the provider reported it. */
export interface ComputeAllocation {
  readonly cpuCores: number
  readonly memoryMb: number
  readonly diskGb?: number
}

/**
 * One outstanding claim.
 *
 * `state` is the lease's own state, not the machine's: a lease can outlive a
 * stopped machine, and a machine can exist with no lease at all (one a worker
 * closed, one an operator made by hand). Keeping them apart is what lets the
 * sweep stop machines without deleting the evidence of who asked for them.
 */
export interface ComputeLease {
  /** Stable lease id, derived from the machine name so both sides can compute it. */
  readonly leaseId: string
  /** Machine name, which is also the machine's own identity. */
  readonly name: string
  /** Absolute host directory mounted into the machine. */
  readonly workspacePath: string
  /** Caller that took the lease, as its Onlyne node id. */
  readonly owner: string
  /** What the caller said the machine is for. */
  readonly purpose: string | null
  /** When the lease was taken, in epoch milliseconds. */
  readonly createdAt: number
  /** When the lease stops being valid, in epoch milliseconds. */
  readonly expiresAt: number
  /** The last control-plane touch (acquire or renew), which the idle window measures. */
  readonly lastActivityAt: number
  /** Hard ceiling on this lease's whole lifetime, in milliseconds. */
  readonly maxTtlMs: number
  /** How long the lease may go untouched before the sweep stops it; 0 disables the check. */
  readonly idleTimeoutMs: number
  /** Whether the disk goes with the claim when the caller releases it. */
  readonly autoDestroy: boolean
  /** Whether the machine is believed to be running, stopped, or gone. */
  readonly state: ComputeState
  /** What the machine has, as the provider reported it when the lease was taken. */
  readonly allocated?: ComputeAllocation
  /** Desktop portal the provider advertised, when the machine runs one. */
  readonly portal?: string
}

/** Whether the machine behind a lease is up, stopped but recoverable, or destroyed. */
export type ComputeState = 'running' | 'stopped' | 'released'

/** The manager, as the rest of the process consumes it. */
export interface ComputeService {
  /**
   * Take a lease, starting the machine when it is not already up.
   * @param spec - the name, an optional workspace, window and caps.
   * @param owner - the node asking, recorded on the lease and enforced from then on.
   * @returns the lease, with the machine running.
   * @throws {OnlyneError} `capacity_exceeded` when the requested window is past
   *   the ceiling, `forbidden` when another node already holds this machine.
   */
  acquire(spec: ComputeSpec, owner: string): Promise<ComputeLease>
  /**
   * Extend a running lease without touching the machine.
   * @param ref - machine name or lease id.
   * @param ttlMs - the next window, in milliseconds; defaults to the configured one.
   * @param callerOwner - the node asking; must be the lease's owner.
   * @returns the lease, with its deadline moved.
   * @throws {OnlyneError} `forbidden` for another node's lease,
   *   `capacity_exceeded` past the ceiling, `invalid_request` on a stopped lease.
   */
  renew(ref: string, ttlMs: number | undefined, callerOwner: string): Promise<ComputeLease>
  /**
   * Release a lease: stop the machine and forget the claim.
   *
   * Not the same as destroying it — `release` is the caller saying it is done,
   * and the machine is stopped so a later lease of the same name resumes the
   * same disk rather than paying for a new one. A lease taken with
   * `autoDestroy` skips the stop and destroys the disk here.
   * @param ref - machine name or lease id.
   * @param callerOwner - the node asking; must be the lease's owner.
   * @returns whether a lease of that name existed.
   * @throws {OnlyneError} `forbidden` for another node's lease.
   */
  release(ref: string, callerOwner: string): Promise<boolean>
  /**
   * Destroy a machine and its lease outright, for the case where the disk is
   * exactly what the caller does not want to keep.
   * @param ref - machine name or lease id.
   * @param callerOwner - the node asking; must be the lease's owner.
   * @returns whether anything was there to destroy.
   * @throws {OnlyneError} `forbidden` for another node's lease.
   */
  destroy(ref: string, callerOwner: string): Promise<boolean>
  /**
   * Describe one lease.
   * @param ref - machine name or lease id.
   * @returns the lease, or `undefined` when nothing carries that name or id.
   */
  get(ref: string): ComputeLease | undefined
  /** Every lease this process knows, oldest name first. */
  list(): ComputeLease[]
  /**
   * Run one lease sweep: stop the machines whose leases expired, went idle past
   * their window, or reached the lifetime ceiling, and forget the leases whose
   * stopped machines have been idle past the retention window.
   * @param now - the moment to measure against.
   * @returns the names whose state changed.
   */
  sweep(now?: number): Promise<readonly string[]>
  /** Restore leases from disk, adopting machines that already exist under this prefix. */
  load(): Promise<void>
}

/** Deployment settings, validated by the plugin entry. */
export interface ComputeConfig {
  /** Whether the manager runs at all. */
  enabled: boolean
  /** Prefix a machine name gets, so `vm://` and this manager agree on ownership. */
  namePrefix: string
  /** Default lease window, in milliseconds. */
  defaultTtlMs: number
  /**
   * Hard ceiling on one lease's whole lifetime, in milliseconds. A window past
   * it is refused with `capacity_exceeded`; nothing is silently truncated.
   */
  maxTtlMs: number
  /** How long a lease may go without a control-plane touch before the sweep stops it; 0 disables. */
  idleTimeoutMs: number
  /** How long a stopped machine is kept before its disk is destroyed. */
  retentionMs: number
  /** How often the sweep runs, in milliseconds. */
  sweepMs: number
  /** Directory the manager's own workspace pool lives under. */
  poolPath: string
  /** File the lease table is kept in. */
  ledgerPath: string
  /** Node id the manager answers as on Onlyne. */
  nodeId: string
}
