/**
 * The compute manager: leases over the machines `omd-sandbox-vm` owns.
 *
 * A lease is the whole idea. A caller does not create a machine and hope it
 * gets cleaned up later; it takes a claim with a deadline, and the manager is
 * the thing that enforces the deadline. Three moments follow from that:
 *
 * - **acquire** starts the machine (or resumes a stopped one) and records who
 *   asked, for what, until when;
 * - **expiry** stops the machine, keeping its disk: a stopped machine costs no
 *   CPU and comes back with the same packages installed;
 * - **retention** destroys the disk once nobody has renewed the claim for a
 *   while, which is the only moment anything is actually deleted.
 *
 * Three rules keep the claim meaningful, and each one is enforced here rather
 * than in the entry, so no caller can reach a machine around them:
 *
 * 1. **A lease has one owner.** The first node to take a machine owns it; every
 *    later verb from another node is refused, because a lease nobody can enforce
 *    is not a lease.
 * 2. **A window past the ceiling is refused, not truncated.** Silently shortening
 *    a caller's `ttl_ms` makes it fail later, somewhere else; `capacity_exceeded`
 *    fails here, before a machine is touched.
 * 3. **Expiry is reported.** A machine that goes down under a running task looks
 *    like a command that broke; the callback carries the reason to whoever owns
 *    the lease.
 *
 * Nothing here executes a command. The machine's commands stay `omd-sandbox-vm`'s
 * seam, and its desktop stays a human's; this module only decides whether the
 * machine is up.
 *
 * @module omd-compute/manager
 */

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { OnlyneError } from '@onlyne/lib'
import { MACHINE_NAME, type MachineSnapshot, type SandboxVm } from 'omd-sandbox-vm/machine'
import { readLedger, writeLedger, type StoredLease } from './ledger.ts'
import type {
  ComputeAllocation,
  ComputeConfig,
  ComputeLease,
  ComputeService,
  ComputeSpec,
  ExpiryReason,
} from './types.ts'

/** What the manager needs from the process. */
export interface ManagerPorts {
  /** The machine provider, read per call so a late mount applies. */
  readonly vm: () => SandboxVm | undefined
  /** Where a recovered problem is reported without failing the call that hit it. */
  readonly log: (message: string) => void
  /**
   * Told after the sweep has taken a running lease's machine down. Awaited, so a
   * notifier that answers in the same process has finished before the sweep
   * returns; a notifier that throws is reported, not propagated.
   */
  readonly onExpire?: (lease: ComputeLease, reason: ExpiryReason) => void | Promise<void>
}

/** What the sweep says when it takes a machine down, in words a log reader needs. */
const EXPIRY_TEXT: Record<ExpiryReason, string> = {
  ttl_expired: 'its lease expired',
  idle_timeout: 'its lease went idle',
  max_ttl_reached: 'its lease reached the lifetime ceiling',
}

/**
 * Build the manager.
 * @param config - validated deployment settings.
 * @param ports - the machine provider, the log sink and the expiry notifier.
 * @returns the service published as `ctx.compute`.
 */
export function createCompute(config: ComputeConfig, ports: ManagerPorts): ComputeService {
  /** Every lease this process holds, by machine name. */
  const leases = new Map<string, ComputeLease>()
  /** Serialises ledger writes so two acquisitions cannot interleave. */
  let writes: Promise<void> = Promise.resolve()
  let loaded = false

  function persist(): void {
    const snapshot = [...leases.values()]
    writes = writes
      .then(() => writeLedger(config.ledgerPath, snapshot))
      .catch((error: unknown) => {
        ports.log(`omd-compute: the lease ledger was not written: ${
          error instanceof Error ? error.message : String(error)
        }`)
      })
  }

  function requireVm(): SandboxVm {
    const vm = ports.vm()
    if (vm === undefined) {
      throw new Error('omd-compute: the sandboxVm service is not mounted, so no machine can be started')
    }
    return vm
  }

  /** The workspace a lease gets when the caller named none: a directory of its own. */
  function workspaceFor(name: string): string {
    return join(config.poolPath, name)
  }

  /** One lease, by machine name first and by lease id second. */
  function find(ref: string): ComputeLease | undefined {
    const named = leases.get(ref)
    if (named !== undefined) return named
    for (const lease of leases.values()) if (lease.leaseId === ref) return lease
    return undefined
  }

  /** Refuse a verb aimed at a lease somebody else holds. */
  function assertOwner(lease: ComputeLease, caller: string): void {
    if (lease.owner === caller) return
    throw new OnlyneError('forbidden', `Lease "${lease.name}" is owned by ${lease.owner}`)
  }

  /** The window a caller asked for, validated; the deployment's default when it named none. */
  function ttlOf(asked: number | undefined): number {
    if (asked === undefined) return config.defaultTtlMs
    if (!Number.isFinite(asked) || asked <= 0) {
      throw new OnlyneError(
        'invalid_request',
        `omd-compute: ttlMs must be a positive number of milliseconds, got ${String(asked)}`,
      )
    }
    return asked
  }

  /** The lifetime ceiling this lease lives under: the caller's, never above the deployment's. */
  function capOf(asked: number | undefined): number {
    if (asked === undefined || !Number.isFinite(asked) || asked <= 0) return config.maxTtlMs
    return Math.min(asked, config.maxTtlMs)
  }

  /** Refuse a window the ceiling cannot hold, before a machine is started or created. */
  function requireWithinCap(window: number, cap: number): void {
    if (window <= cap) return
    throw new OnlyneError('capacity_exceeded', `Requested ttl_ms (${window}) exceeds max_ttl_ms (${cap})`)
  }

  /**
   * What the provider says the machine actually has.
   *
   * The numbers and the portal are read once, when the lease is taken, rather
   * than on every descriptor: a receipt is a record of what was granted, and a
   * probe per read would cost an `orbctl` call per lease in the table.
   * @param vm - the machine provider.
   * @param name - machine name.
   * @param spec - what the caller asked for, used where the provider says nothing.
   * @returns the portal and the allocation a descriptor reports.
   */
  async function factsOf(
    vm: SandboxVm,
    name: string,
    spec: ComputeSpec,
  ): Promise<{ portal?: string; allocated: ComputeAllocation }> {
    const [machine, snapshot] = await Promise.all([
      vm.inspect(name).catch(() => undefined),
      vm.snapshot(name).catch((): MachineSnapshot | undefined => undefined),
    ])
    return {
      ...(machine?.desktopUrl === undefined ? {} : { portal: machine.desktopUrl }),
      allocated: {
        cpuCores: snapshot?.cpus ?? spec.cpus ?? 0,
        memoryMb: snapshot?.memoryMiB ?? spec.memoryMb ?? 0,
        ...(spec.diskGb === undefined ? {} : { diskGb: spec.diskGb }),
      },
    }
  }

  /** Replace one lease and persist the table. */
  function record(lease: ComputeLease): ComputeLease {
    leases.set(lease.name, lease)
    persist()
    return lease
  }

  /** Drop a disk the manager created; a caller-named workspace is the caller's files. */
  async function dropWorkspace(lease: ComputeLease): Promise<void> {
    if (lease.workspacePath !== workspaceFor(lease.name)) return
    await rm(lease.workspacePath, { recursive: true, force: true }).catch(() => undefined)
  }

  /** Why a running lease must come down now, or `undefined` while it may stay up. */
  function expiryOf(lease: ComputeLease, now: number): ExpiryReason | undefined {
    if (now - lease.createdAt >= lease.maxTtlMs) return 'max_ttl_reached'
    if (now >= lease.expiresAt) return 'ttl_expired'
    if (lease.idleTimeoutMs > 0 && now - lease.lastActivityAt >= lease.idleTimeoutMs) return 'idle_timeout'
    return undefined
  }

  /** Tell the owner the machine went down, without letting a failed notice break the sweep. */
  async function announce(lease: ComputeLease, reason: ExpiryReason): Promise<void> {
    const onExpire = ports.onExpire
    if (onExpire === undefined) return
    try {
      await onExpire(lease, reason)
    } catch (error) {
      ports.log(`omd-compute: the expiry notice for "${lease.name}" failed: ${
        error instanceof Error ? error.message : String(error)
      }`)
    }
  }

  /**
   * One stored row as a lease. The id is derived from the name and the caps may
   * be missing on a row an older build wrote, so both come from the configuration.
   */
  function adopted(row: StoredLease, state: ComputeLease['state']): ComputeLease {
    return {
      leaseId: `lease-${row.name}`,
      name: row.name,
      workspacePath: row.workspacePath,
      owner: row.owner,
      purpose: row.purpose,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      lastActivityAt: row.lastActivityAt ?? row.createdAt,
      maxTtlMs: row.maxTtlMs ?? config.maxTtlMs,
      idleTimeoutMs: row.idleTimeoutMs ?? config.idleTimeoutMs,
      autoDestroy: row.autoDestroy ?? false,
      state,
      ...(row.portal === undefined ? {} : { portal: row.portal }),
      ...(row.allocated === undefined ? {} : { allocated: row.allocated }),
    }
  }

  return {
    async load() {
      if (loaded) return
      loaded = true
      const { leases: stored, problem } = await readLedger(config.ledgerPath)
      if (problem !== undefined) ports.log(`omd-compute: ${problem}`)
      const vm = ports.vm()
      for (const row of stored) {
        if (row.state === 'released') continue
        // A machine that no longer exists cannot carry a lease: keeping it would
        // make the next acquire resume something that is not there.
        const machine = vm === undefined ? undefined : await vm.inspect(row.name).catch(() => undefined)
        if (machine === undefined) continue
        leases.set(row.name, adopted(row, machine.state === 'absent' ? 'stopped' : 'running'))
      }
      persist()
    },

    async acquire(spec, owner) {
      if (!MACHINE_NAME.test(spec.name)) {
        throw new OnlyneError(
          'invalid_request',
          `omd-compute: machine name "${spec.name}" must match ${String(MACHINE_NAME)}`,
        )
      }
      // Both checks come before the provider is touched: a refused ask must not
      // leave a machine behind.
      const ttl = ttlOf(spec.ttlMs)
      const cap = capOf(spec.maxTtlMs)
      requireWithinCap(ttl, cap)
      const vm = requireVm()
      const existing = leases.get(spec.name)
      const now = Date.now()
      if (existing !== undefined && existing.state !== 'released') {
        assertOwner(existing, owner)
        if (existing.state === 'stopped') {
          await vm.start(existing.name)
          // A stopped lease resumes as a fresh claim: the lifetime ceiling counts
          // from the resume, not from an acquisition the caller already ended.
          return record({
            ...existing,
            ...await factsOf(vm, existing.name, spec),
            createdAt: now,
            expiresAt: now + ttl,
            lastActivityAt: now,
            state: 'running',
          })
        }
        // A live lease is renewed, not duplicated: asking twice for one machine
        // is a caller retrying, not a caller wanting two.
        return record({ ...existing, expiresAt: now + ttl, lastActivityAt: now })
      }
      const workspacePath = spec.workspacePath ?? workspaceFor(spec.name)
      await mkdir(workspacePath, { recursive: true })
      await vm.provision({ name: spec.name, workspacePath })
      return record({
        leaseId: `lease-${spec.name}`,
        name: spec.name,
        workspacePath,
        owner,
        purpose: spec.purpose ?? null,
        createdAt: now,
        expiresAt: now + ttl,
        lastActivityAt: now,
        maxTtlMs: cap,
        idleTimeoutMs: spec.idleTimeoutMs ?? config.idleTimeoutMs,
        autoDestroy: spec.autoDestroy === true,
        state: 'running',
        ...await factsOf(vm, spec.name, spec),
      })
    },

    async renew(ref, ttlMs, callerOwner) {
      const lease = find(ref)
      if (lease === undefined) {
        throw new OnlyneError('not_found', `omd-compute: no lease named "${ref}"; read compute:// for the table`)
      }
      assertOwner(lease, callerOwner)
      if (lease.state !== 'running') {
        throw new OnlyneError(
          'invalid_request',
          `omd-compute: lease "${lease.name}" is ${lease.state}; acquire it again to resume the machine`,
        )
      }
      const ttl = ttlOf(ttlMs)
      const now = Date.now()
      // The ceiling bounds the whole claim, not one window: a lease renewed every
      // ten minutes cannot outlive its `max_ttl_ms` by renewing forever.
      requireWithinCap(now - lease.createdAt + ttl, lease.maxTtlMs)
      return record({ ...lease, expiresAt: now + ttl, lastActivityAt: now })
    },

    async release(ref, callerOwner) {
      const lease = find(ref)
      if (lease === undefined) return false
      assertOwner(lease, callerOwner)
      const vm = requireVm()
      if (lease.autoDestroy) {
        await vm.dispose(lease.name)
        await dropWorkspace(lease)
        leases.delete(lease.name)
        persist()
        return true
      }
      if (lease.state === 'running') {
        await vm.stop(lease.name).catch((error: unknown) => {
          ports.log(`omd-compute: could not stop "${lease.name}" on release: ${
            error instanceof Error ? error.message : String(error)
          }`)
        })
      }
      // A release ends the claim now: the retention window has to start here,
      // or an early release would keep the disk until the original deadline plus
      // retention, which is longer than the caller asked for.
      record({ ...lease, state: 'stopped', expiresAt: Math.min(lease.expiresAt, Date.now()) })
      return true
    },

    async destroy(ref, callerOwner) {
      const lease = find(ref)
      const vm = ports.vm()
      if (lease === undefined) {
        // A machine with no lease is still this manager's to destroy when it
        // carries the configured prefix; that is what makes an orphan cleanable.
        if (vm === undefined || !ref.startsWith(config.namePrefix)) return false
        const machine = await vm.inspect(ref).catch(() => undefined)
        if (machine === undefined) return false
        await vm.dispose(ref)
        return true
      }
      assertOwner(lease, callerOwner)
      if (vm !== undefined) await vm.dispose(lease.name)
      await dropWorkspace(lease)
      leases.delete(lease.name)
      persist()
      return true
    },

    get(ref) {
      return find(ref)
    },

    list() {
      return [...leases.values()].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    },

    async sweep(now = Date.now()) {
      const vm = ports.vm()
      if (vm === undefined) return []
      const changed: string[] = []
      for (const lease of [...leases.values()]) {
        if (lease.state === 'running') {
          const reason = expiryOf(lease, now)
          if (reason === undefined) continue
          try {
            await vm.stop(lease.name)
            // The retention clock starts at the stop, not at the deadline the
            // lease was granted: a machine stopped early is kept for the full
            // window from here.
            const stopped = record({ ...lease, state: 'stopped', expiresAt: Math.min(lease.expiresAt, now) })
            changed.push(lease.name)
            ports.log(`omd-compute: stopped "${lease.name}" — ${EXPIRY_TEXT[reason]}`)
            await announce(stopped, reason)
          } catch (error) {
            ports.log(`omd-compute: could not stop the expired lease "${lease.name}": ${
              error instanceof Error ? error.message : String(error)
            }`)
          }
          continue
        }
        if (now - lease.expiresAt >= config.retentionMs) {
          try {
            await vm.dispose(lease.name)
            await dropWorkspace(lease)
            leases.delete(lease.name)
            persist()
            changed.push(lease.name)
            ports.log(`omd-compute: destroyed "${lease.name}" — its lease was not renewed`)
          } catch (error) {
            ports.log(`omd-compute: could not destroy the retained lease "${lease.name}": ${
              error instanceof Error ? error.message : String(error)
            }`)
          }
        }
      }
      return changed
    },
  }
}
