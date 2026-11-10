/**
 * The sandbox backend: the same dsh coding agent as `dsh-agent`, with its
 * commands running inside an isolated ARM64 Linux machine and its files living
 * in a copy-on-write directory that machine mounts.
 *
 * The split is what makes this cheap. `read`, `write` and `edit` are host
 * filesystem calls, so they cost nothing and a change set is read by walking
 * the host directory afterwards — no export from the guest, no transfer. Only
 * `bash` crosses into the machine, and it does so as the tool the model already
 * knows: same name, same arguments, a different executor. The guest therefore
 * never holds the workspace; it holds a mount of it.
 *
 * A job's machine is named after the job id, so `vm://<machine>` reaches it and
 * an operator can open its desktop while the run is happening.
 *
 * The machine is *leased*, not started: `provision` asks the compute manager
 * (`urn:onlyne:agent:compute`) for one and `dispose` asks it to destroy that
 * machine, so the lease table — not this backend — decides when a machine
 * expires. A host with no manager fails that ask with `absent` and the machine
 * is started directly, which is the same code path standalone tests use.
 *
 * @module omd-issue-runner/backends/vm-agent
 */

import { randomUUID } from 'node:crypto'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage, joinAssistantStreamText } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createSandboxBash } from 'omd-sandbox-vm/bash-tool'
import type { SandboxService } from 'omd-sandbox-vm/types'
import type {
  CodingAgentBackend,
  CodingAgentJob,
  Provisioned,
  RunCollection,
  RunResult,
} from '../backend.ts'
import type { ComputeControl, WorktreeAllocation, WorktreeAllocator } from '../types.ts'
import { startLeaseHeartbeat, type LeaseHeartbeat } from '../compute.ts'
import {
  assertWorkspace,
  changedFilesOf,
  finalAssistantOutput,
  flattenOutput,
  routeOf,
  runTurn,
  stopOf,
} from './dsh-agent.ts'

/** How the sandbox agent is started and bounded. */
export interface VmAgentBackendOptions {
  /** The copy-on-write allocator, read per call so a late mount still applies. */
  readonly allocator: () => WorktreeAllocator | undefined
  /** The machine provider, read per call for the same reason. */
  readonly vm: () => SandboxService | undefined
  /** The lease control plane; absent leaves machine lifecycle to `vm` directly. */
  readonly compute: () => ComputeControl | undefined
  /** Image a leased machine runs; OECP v1's `container.image`. */
  readonly image: string
  /** Lease window asked for, in milliseconds; the heartbeat renews at half of it. */
  readonly leaseTtlMs: number
  /** The agent registry. */
  readonly agents: () => AgentRegistry | undefined
  /** The preset registry: a coding agent without its preset has no file tools. */
  readonly presets: () => { mount(ctx: unknown, id?: string): Promise<unknown> } | undefined
  /** The live agent that owns this run. */
  readonly parent: (job: CodingAgentJob) => Agent | undefined
  /** The prompt the agent receives. */
  readonly prompt: (job: CodingAgentJob) => string
  /** Machine name for a job; unique per machine on the host. */
  readonly machineName: (job: CodingAgentJob) => string
  /** Guest path the workspace is mounted at. */
  readonly guestWorkspacePath: string
  /** Deadline applied to one command the model runs. */
  readonly bashTimeoutMs: number
  /** Largest command output kept before the middle is dropped. */
  readonly maxOutputChars: number
  /** Where a lease that could not be renewed is reported. */
  readonly log: (message: string) => void
}

/** What one job holds while it is alive. */
interface VmJobState {
  readonly allocator: WorktreeAllocator
  readonly allocation: WorktreeAllocation
  readonly machine: string
  /** Who owns the machine's life: the compute manager's lease, or this backend. */
  readonly lease: 'compute' | 'direct'
  /** The lease's identity, when the manager's receipt named one. */
  readonly leaseId?: string
  /** The renewal loop while the lease is held. */
  readonly heartbeat?: LeaseHeartbeat
  /** The session the current or last run is in; replaced by every review run. */
  session?: string
}

/**
 * Build the sandbox backend.
 * @param options - the services it borrows and the bounds it applies.
 * @returns a backend the runner can hand jobs to.
 */
export function createVmAgentBackend(options: VmAgentBackendOptions): CodingAgentBackend {
  const states = new Map<string, VmJobState>()

  return {
    name: 'vm-agent',

    async provision(job: CodingAgentJob): Promise<Provisioned> {
      const allocator = options.allocator()
      if (allocator === undefined) {
        throw new Error(
          'omd-issue-runner: the worktreeAlloc service is not mounted, so there is no isolated workspace to mount '
          + '(mount omd-worktree-alloc)',
        )
      }
      const allocation = await allocator.allocate(job.branch, job.source)
      const machine = options.machineName(job)
      try {
        const control = options.compute()
        if (control === undefined) {
          throw new Error(
            'omd-issue-runner: VM leases are Onlyne compute messages. No compute control plane is mounted, '
            + 'so this process will not call orbctl. Mount omd-compute on a node that has the driver, '
            + 'or set backend to "dsh-agent".',
          )
        }
        const lease = await control.acquire({
          name: machine,
          workspacePath: allocation.path,
          image: options.image,
          ttlMs: options.leaseTtlMs,
          purpose: `issue-${job.id}`,
          ...job.work === undefined ? {} : { work: job.work },
        })
        if (lease.kind !== 'granted') {
          throw new Error(
            `omd-issue-runner: ${options.machineName(job)} was not leased. The providing node did not answer; `
            + 'a missing driver is not a reason to provision on this host.',
          )
        }
        // The desktop in the receipt is the providing node's. A local inspect is
        // only a hint when this same host is the driver and the receipt named none.
        const vm = options.vm()
        const portal = lease.descriptor.connection?.portalUrls?.desktop
        const desktopUrl = portal
          ?? lease.descriptor.desktopUrl
          ?? (vm === undefined ? undefined : (await vm.inspect(machine).catch(() => undefined))?.desktopUrl)
        states.set(job.id, {
          allocator,
          allocation,
          machine,
          lease: 'compute',
          ...lease.descriptor.leaseId === undefined ? {} : { leaseId: lease.descriptor.leaseId },
          heartbeat: startLeaseHeartbeat({
            name: machine,
            ttlMs: options.leaseTtlMs,
            ...lease.descriptor.idleTimeoutMs === undefined
              ? {}
              : { idleTimeoutMs: lease.descriptor.idleTimeoutMs },
            ...lease.descriptor.leaseId === undefined ? {} : { leaseId: lease.descriptor.leaseId },
            log: options.log,
            renew: () => renewLease(machine, allocation.path, lease.descriptor.leaseId, job),
          }),
        })
        return {
          worktreePath: allocation.path,
          branch: allocation.name,
          machine,
          ...lease.descriptor.leaseId === undefined ? {} : { leaseId: lease.descriptor.leaseId },
          ...desktopUrl === undefined ? {} : { desktopUrl },
        }
      } catch (error) {
        // A machine that never came up leaves no workspace behind either: the
        // copy is useless without the guest that was supposed to run in it.
        // Nothing after a granted lease can fail — the desktop lookup is already
        // tolerant — so a leased machine is never released from here.
        await allocator.release(allocation, { force: true })
        throw error
      }
    },

    async launch(job: CodingAgentJob, provisioned: Provisioned): Promise<RunResult> {
      const state = states.get(job.id)
      if (state === undefined) {
        throw new Error(`omd-issue-runner: job "${job.id}" has no workspace; provision it before launching`)
      }
      const agents = options.agents()
      if (agents === undefined) {
        throw new Error('omd-issue-runner: the agents service is not mounted, so no coding agent was started')
      }
      const parent = options.parent(job)
      if (parent === undefined) {
        throw new Error(
          'omd-issue-runner: no live dsh session can own the coding agent, so no coding agent was started',
        )
      }
      const vm = options.vm()
      if (vm === undefined) {
        throw new Error('omd-issue-runner: the sandboxVm service went away before the run started')
      }
      const route = routeOf(parent)
      if (route === undefined) {
        throw new Error(
          `omd-issue-runner: the filing session ${String(parent.session.id)} has no provider/model route, `
          + 'so the coding agent could not render its persona; no run was started',
        )
      }
      const sessionId = SessionId(randomUUID())
      const bash = createSandboxBash({
        vm,
        machine: state.machine,
        workspacePath: options.guestWorkspacePath,
        defaultTimeoutMs: options.bashTimeoutMs,
        maxOutputChars: options.maxOutputChars,
      })
      const handle = await agents.create({
        sessionId,
        parentAgent: parent,
        agentOptions: route,
        setup: async (agentCtx) => {
          const presetId = parent.session.header.agentPreset
          const presets = options.presets()
          if (presets === undefined) throw new Error('omd-issue-runner: no agent preset registry is mounted')
          await presets.mount(agentCtx, presetId)
          // The preset registers its tools in a scope that is a parent of this
          // one, so the same name registered here is the one the model sees.
          const tools = agentCtx.get('tools')
          if (tools === undefined) {
            throw new Error('omd-issue-runner: the agent has no tool registry, so bash could not be redirected')
          }
          tools.register(bash)
        },
        meta: {
          // The session directory stays the host copy: file tools write here and
          // the guest reads through its mount, so both sides see one tree.
          cwd: provisioned.worktreePath,
          ...(parent.session.header.agentPreset === undefined
            ? {}
            : { agentPreset: parent.session.header.agentPreset }),
        },
      })
      // Recorded as soon as the session exists, so the worker's feed is
      // readable while the agent is still working.
      state.session = String(sessionId)
      try {
        assertWorkspace(handle.agent, provisioned.worktreePath, job)
        await runTurn(handle.agent, options.prompt(job), job.signal)
        const events = handle.agent.session.snapshotEvents()
        const output = finalAssistantOutput(events)
        return {
          summary: output === undefined ? '' : flattenOutput(output),
          ...stopOf(events),
          childId: String(sessionId),
        }
      } finally {
        await handle.dispose()
      }
    },

    async collect(job: CodingAgentJob): Promise<RunCollection> {
      const state = states.get(job.id)
      if (state === undefined) {
        throw new Error(`omd-issue-runner: job "${job.id}" has no workspace to collect`)
      }
      const patch = await state.allocator.collect(state.allocation)
      return {
        patch,
        patchBytes: new TextEncoder().encode(patch).byteLength,
        changedFiles: changedFilesOf(patch),
      }
    },

    sessionOf(job: CodingAgentJob): string | undefined {
      return states.get(job.id)?.session
    },

    async dispose(job: CodingAgentJob): Promise<void> {
      const state = states.get(job.id)
      if (state === undefined) return
      states.delete(job.id)
      // The lease goes back before the machine does: a renewal racing the
      // destroy would ask the manager to extend what it is destroying.
      state.heartbeat?.stop()
      // The machine goes first: a copy removed under a live mount is exactly
      // the debris this ordering avoids.
      const control = options.compute()
      const destroyed = state.lease === 'compute' && control !== undefined
        && await control.destroy(state.machine, state.leaseId) === 'destroyed'
      if (!destroyed) {
        // No manager to tell, or one that no longer holds this machine: the
        // provider is then the only thing that can still remove it.
        const vm = options.vm()
        if (vm !== undefined) await vm.dispose(state.machine)
      }
      await state.allocator.release(state.allocation, { force: true })
    },
  }

  /**
   * Extend this backend's lease once.
   *
   * A manager that answers `renew` is asked directly. One that predates the
   * verb is renewed through a same-name acquire, which is the extension it
   * already had.
   */
  async function renewLease(
    machine: string,
    workspacePath: string,
    leaseId: string | undefined,
    job: CodingAgentJob,
  ): Promise<boolean> {
    const control = options.compute()
    if (control === undefined) return false
    if (control.renew !== undefined) return await control.renew(machine, options.leaseTtlMs, leaseId) === 'renewed'
    const again = await control.acquire({
      name: machine,
      workspacePath,
      image: options.image,
      ttlMs: options.leaseTtlMs,
      purpose: `issue-${job.id}`,
      ...job.work === undefined ? {} : { work: job.work },
    })
    return again.kind === 'granted'
  }
}
