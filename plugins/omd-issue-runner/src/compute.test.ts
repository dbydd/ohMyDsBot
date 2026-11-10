import { afterAll, describe, expect, test, vi } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Entry, Json, Runtime } from '@onlyne/lib'
import { createVmAgentBackend } from './backends/vm-agent.ts'
import type { CodingAgentJob } from './backend.ts'
import { createComputeControl, leaseRenewInterval, startLeaseHeartbeat } from './compute.ts'
import { createBotNode, type BotNode } from 'omd-onlyne/node'
import { EndpointRegistry } from 'omd-onlyne/registry'
import type { SandboxService } from 'omd-sandbox-vm/types'
import type { ComputeControl, WorktreeAllocation, WorktreeAllocator } from './types.ts'

/** Nodes and temp homes the file created, disposed in one place. */
const made: Array<BotNode | string> = []

afterAll(async () => {
  for (const item of made.reverse()) {
    if (typeof item === 'string') rmSync(item, { recursive: true, force: true })
    else await item.dispose()
  }
})

/** The workspace one allocation reports; the guest path is the backend's own. */
const WORKSPACE = '/tmp/omd-compute-test/worktree'

/** A job snapshot, in the shape the coordinator hands a backend. */
function jobOf(id = 'job1'): CodingAgentJob {
  return {
    id,
    workerId: `w-${id}`,
    title: 'rename the parser helper',
    issue: 'rename the parser helper',
    notes: [],
    branch: `issue/${id}`,
    source: '/tmp/omd-compute-test/source',
    work: { unit: 'ISSUE-7' },
    signal: new AbortController().signal,
  }
}

/** An allocator that records what it handed out and what was released. */
function allocator(): { allocator: WorktreeAllocator; released: WorktreeAllocation[] } {
  const released: WorktreeAllocation[] = []
  const allocation: WorktreeAllocation = {
    path: WORKSPACE,
    name: 'issue/job1',
    sourceRoot: '/tmp/omd-compute-test/source',
    backend: 'cow',
  }
  return {
    allocator: {
      allocate: async () => allocation,
      collect: async () => '',
      release: async handle => { released.push(handle) },
    },
    released,
  }
}

/** A machine provider that records every verb it was asked for. */
function machine(): { vm: SandboxService; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    vm: {
      provision: async request => {
        calls.push(`provision:${request.name}:${request.workspacePath}`)
        return { name: request.name, workspacePath: '/workspace', state: 'ready', desktopUrl: 'http://direct/vnc.html' }
      },
      exec: async () => ({ code: 0, stdout: '', stderr: '', outcome: 'exited' }),
      inspect: async name => ({ name, workspacePath: '/workspace', state: 'ready' }),
      dispose: async name => { calls.push(`dispose:${name}`) },
      list: async () => [],
    },
  }
}

/** A control plane whose acquire answer the test chooses. */
function control(answer: 'granted' | 'absent'): { compute: ComputeControl; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    compute: {
      acquire: async spec => {
        calls.push(`acquire:${spec.name}:${spec.workspacePath}:${spec.purpose ?? ''}`)
        return answer === 'absent'
          ? { kind: 'absent' }
          : { kind: 'granted', descriptor: { name: spec.name, state: 'running', leaseId: `lease-${spec.name}` } }
      },
      renew: async (name, ttlMs) => {
        calls.push(`renew:${name}:${String(ttlMs)}`)
        return answer === 'absent' ? 'not-owed' : 'renewed'
      },
      destroy: async (name, leaseId) => {
        calls.push(`destroy:${name}${leaseId === undefined ? '' : `:${leaseId}`}`)
        return answer === 'absent' ? 'not-owed' : 'destroyed'
      },
      settle: () => true,
    },
  }
}

/** The options every backend under test gets. */
function options(
  parts: { readonly compute?: ComputeControl; readonly vm?: SandboxService; readonly allocator?: WorktreeAllocator },
) {
  return {
    allocator: () => parts.allocator,
    vm: () => parts.vm,
    compute: () => parts.compute,
    image: 'debian:12',
    leaseTtlMs: 60_000,
    agents: () => undefined,
    presets: () => undefined,
    parent: () => undefined,
    prompt: () => 'do the work',
    machineName: (job: CodingAgentJob) => `omd-sandbox-issue-${job.id}`,
    guestWorkspacePath: '/workspace',
    bashTimeoutMs: 30_000,
    maxOutputChars: 1_000,
    log: () => {},
  }
}

describe('vm-agent compute leases', () => {
  test('provision asks the manager and never starts a machine itself', async () => {
    const worktrees = allocator()
    const boxes = machine()
    const leases = control('granted')
    const backend = createVmAgentBackend(options({
      compute: leases.compute, vm: boxes.vm, allocator: worktrees.allocator,
    }))

    const provisioned = await backend.provision(jobOf())

    expect(leases.calls).toEqual([`acquire:omd-sandbox-issue-job1:${WORKSPACE}:issue-job1`])
    // The data plane is the provider's; provisioning is not.
    expect(boxes.calls).toEqual([])
    expect(provisioned.machine).toBe('omd-sandbox-issue-job1')
    expect(provisioned.worktreePath).toBe(WORKSPACE)
  })

  test('dispose destroys through the manager and releases the checkout', async () => {
    const worktrees = allocator()
    const boxes = machine()
    const leases = control('granted')
    const backend = createVmAgentBackend(options({
      compute: leases.compute, vm: boxes.vm, allocator: worktrees.allocator,
    }))
    await backend.provision(jobOf())

    await backend.dispose(jobOf())

    expect(leases.calls).toEqual([
      `acquire:omd-sandbox-issue-job1:${WORKSPACE}:issue-job1`,
      'destroy:omd-sandbox-issue-job1:lease-omd-sandbox-issue-job1',
    ])
    expect(boxes.calls).toEqual([])
    expect(worktrees.released.map(handle => handle.path)).toEqual([WORKSPACE])
  })

  test('a manager that is absent leaves the machine to the provider', async () => {
    const worktrees = allocator()
    const boxes = machine()
    const leases = control('absent')
    const backend = createVmAgentBackend(options({
      compute: leases.compute, vm: boxes.vm, allocator: worktrees.allocator,
    }))

    const provisioned = await backend.provision(jobOf())
    await backend.dispose(jobOf())

    // A machine this backend started is not the manager's to destroy, so no
    // destroy ask goes out for it.
    expect(leases.calls).toEqual([`acquire:omd-sandbox-issue-job1:${WORKSPACE}:issue-job1`])
    expect(boxes.calls).toEqual([
      `provision:omd-sandbox-issue-job1:${WORKSPACE}`,
      'dispose:omd-sandbox-issue-job1',
    ])
    expect(provisioned.desktopUrl).toBe('http://direct/vnc.html')
  })

  test('an acquire that fails releases the checkout and starts no machine', async () => {
    const worktrees = allocator()
    const boxes = machine()
    const failing: ComputeControl = {
      ...control('granted').compute,
      acquire: async () => { throw new Error('lease refused') },
    }
    const backend = createVmAgentBackend(options({
      compute: failing, vm: boxes.vm, allocator: worktrees.allocator,
    }))

    await expect(backend.provision(jobOf())).rejects.toThrow('lease refused')
    expect(boxes.calls).toEqual([])
    expect(worktrees.released.map(handle => handle.path)).toEqual([WORKSPACE])
  })

  test('a manager answer without a desktop address leaves the machine without one', async () => {
    const worktrees = allocator()
    // The provider cannot report the machine it just leased, which is where a
    // desktop lookup fails; the machine must not survive that.
    const boxes = machine()
    const broken: SandboxService = { ...boxes.vm, inspect: async () => { throw new Error('orbctl is gone') } }
    const leases = control('granted')
    const backend = createVmAgentBackend(options({
      compute: leases.compute, vm: broken, allocator: worktrees.allocator,
    }))

    // `inspect` failing is tolerated — the desktop is optional, not the run.
    const provisioned = await backend.provision(jobOf())
    expect(provisioned.machine).toBe('omd-sandbox-issue-job1')
    expect(provisioned.desktopUrl).toBeUndefined()
  })
})

/** A runner node whose only real part is the message send. */
function runnerNode(sent: { delivery_kind: string; msg: string; meta?: Record<string, unknown> }[]): BotNode {
  return {
    nodeId: 'urn:onlyne:agent:issue-runner',
    node: {
      client: {
        msg: async (input: { delivery_kind: string; msg: string; meta?: Record<string, unknown> }) => {
          sent.push(input)
          return { admission: 'accepted', receipt: { message_ref: { sender: 'urn:onlyne:agent:issue-runner', id: 'msg-1' } } }
        },
      },
    },
  } as unknown as BotNode
}

/** Let a chain of resolved promises settle; a heartbeat renewal is two hops deep. */
async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve()
}

describe('compute control client', () => {
  test('acquire sends one compute ask to the manager and settles on its answer', async () => {
    const sent: { delivery_kind: string; msg: string; meta?: Record<string, unknown> }[] = []
    const compute = createComputeControl({
      managerId: 'urn:onlyne:agent:compute',
      node: () => runnerNode(sent),
      timeoutMs: 5_000,
      log: () => {},
    })

    const pending = compute.acquire({
      name: 'omd-sandbox-issue-job1',
      workspacePath: WORKSPACE,
      image: 'debian:12',
      ttlMs: 1_800_000,
      purpose: 'issue-job1',
      work: { unit: 'ISSUE-7' },
    })
    // The answer arrives while `msg` is still returning, as a co-hosted manager's does.
    await Promise.resolve()
    compute.settle({
      thread_ref: { owner: 'urn:onlyne:agent:issue-runner', id: 'msg-1' },
      seq: '2',
      authenticated_author: 'urn:onlyne:agent:compute',
      message: {
        id: 'answer-1',
        sender: 'urn:onlyne:agent:compute',
        delivery_kind: 'compute',
        msg: 'compute acquire: omd-sandbox-issue-job1 is running.',
        meta: {
          thread: { owner: 'urn:onlyne:agent:issue-runner', id: 'msg-1' },
          data: { name: 'omd-sandbox-issue-job1', state: 'running', workspacePath: WORKSPACE, expiresAt: 1 },
        },
      },
    } as unknown as Entry)

    const lease = await pending
    expect(lease).toEqual({
      kind: 'granted',
      descriptor: { name: 'omd-sandbox-issue-job1', state: 'running', workspacePath: WORKSPACE, expiresAt: 1 },
    })
    expect(sent).toEqual([{
      delivery_kind: 'compute',
      msg: 'acquire workspace machine',
      meta: {
        to: 'urn:onlyne:agent:compute',
        operation: 'acquire',
        name: 'omd-sandbox-issue-job1',
        workspacePath: WORKSPACE,
        container: { image: 'debian:12' },
        lease: { ttl_ms: 1_800_000 },
        work: { unit: 'ISSUE-7' },
        purpose: 'issue-job1',
      },
    }])
  })

  test('destroy sends the destroy ask for the same machine', async () => {
    const sent: { delivery_kind: string; msg: string; meta?: Record<string, unknown> }[] = []
    const compute = createComputeControl({
      managerId: 'urn:onlyne:agent:compute',
      node: () => runnerNode(sent),
      timeoutMs: 5_000,
      log: () => {},
    })

    const pending = compute.destroy('omd-sandbox-issue-job1', 'cls_01M6R38AW6HH2S')
    await Promise.resolve()
    compute.settle({
      thread_ref: { owner: 'urn:onlyne:agent:issue-runner', id: 'msg-1' },
      seq: '2',
      authenticated_author: 'urn:onlyne:agent:compute',
      message: {
        id: 'answer-1',
        sender: 'urn:onlyne:agent:compute',
        delivery_kind: 'compute',
        msg: 'compute destroy: omd-sandbox-issue-job1 and its disk are gone.',
        meta: { data: { name: 'omd-sandbox-issue-job1', destroyed: true } },
      },
    } as unknown as Entry)

    expect(await pending).toBe('destroyed')
    expect(sent[0]?.meta).toEqual({
      to: 'urn:onlyne:agent:compute',
      operation: 'destroy',
      name: 'omd-sandbox-issue-job1',
      lease_id: 'cls_01M6R38AW6HH2S',
    })
  })

  test('no node means no manager answered, and nothing is sent', async () => {
    const compute = createComputeControl({
      managerId: 'urn:onlyne:agent:compute',
      node: () => undefined,
      timeoutMs: 5_000,
      log: () => {},
    })

    expect(await compute.acquire({ name: 'm', workspacePath: WORKSPACE, image: 'debian:12' })).toEqual({ kind: 'absent' })
    expect(await compute.destroy('m')).toBe('not-owed')
  })

  test('a real manager node answers an ask over Onlyne', async () => {
    // Two co-hosted nodes on one registry, the production shape: the ask is
    // signed and delivered in-process, and the answer comes back as a message
    // in the runner's own thread — no fake anywhere in this path.
    const home = mkdtempSync(join(tmpdir(), 'omd-issue-runner-compute-'))
    made.push(home)
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const registry = new EndpointRegistry()
      const asked: Array<{ operation: string; name: string; workspacePath: string; purpose: string }> = []
      const managerRuntime: Runtime = {
        supports: async () => true,
        inject: async entry => {
          const data = entry.message.meta?.data ?? {}
          const operation = typeof data.operation === 'string' ? data.operation : ''
          const name = typeof data.name === 'string' ? data.name : ''
          asked.push({
            operation,
            name,
            workspacePath: typeof data.workspacePath === 'string' ? data.workspacePath : '',
            purpose: typeof data.purpose === 'string' ? data.purpose : '',
          })
          const manager = made.find(item => typeof item !== 'string' && item.nodeId === 'urn:onlyne:agent:compute')
          if (manager === undefined || typeof manager === 'string') throw new Error('no manager node')
          const descriptor: Record<string, Json> = operation === 'destroy'
            ? { name, destroyed: true }
            : { name, state: 'running', workspacePath: String(data.workspacePath ?? ''), expiresAt: 1 }
          await manager.node.client.msg({
            delivery_kind: 'compute',
            msg: `compute ${operation}: ${name}`,
            meta: {
              to: entry.authenticated_author,
              thread: { owner: entry.thread_ref.owner, id: entry.thread_ref.id },
              in_reply_to: { sender: entry.message.sender, id: entry.message.id },
              ...descriptor,
            },
          })
          return { context: entry.thread_ref.id, consumed: true, outcome: 'consumed' }
        },
        notify: () => {},
      }
      const manager = await createBotNode({
        nodeId: 'urn:onlyne:agent:compute',
        registry,
        runtime: managerRuntime,
      })
      made.push(manager)
      // The runner's runtime is the production one: a `compute` entry is an
      // answer to settle, and that is what resolves the ask below.
      let compute: ComputeControl
      const runner = await createBotNode({
        nodeId: 'urn:onlyne:agent:issue-runner',
        registry,
        runtime: {
          supports: async () => true,
          inject: async entry => {
            compute.settle(entry)
            return { context: entry.thread_ref.id, consumed: true, outcome: 'consumed' }
          },
          notify: () => {},
        },
      })
      made.push(runner)

      compute = createComputeControl({
        managerId: 'urn:onlyne:agent:compute',
        node: () => runner,
        timeoutMs: 20_000,
        log: () => {},
      })

      const lease = await compute.acquire({
        name: 'omd-sandbox-issue-job1',
        workspacePath: WORKSPACE,
        image: 'debian:12',
        purpose: 'issue-job1',
      })
      expect(lease).toEqual({
        kind: 'granted',
        descriptor: { name: 'omd-sandbox-issue-job1', state: 'running', workspacePath: WORKSPACE, expiresAt: 1 },
      })
      expect(await compute.destroy('omd-sandbox-issue-job1')).toBe('destroyed')
      expect(asked).toEqual([
        { operation: 'acquire', name: 'omd-sandbox-issue-job1', workspacePath: WORKSPACE, purpose: 'issue-job1' },
        { operation: 'destroy', name: 'omd-sandbox-issue-job1', workspacePath: '', purpose: '' },
      ])
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await Promise.all(made.splice(0).map(item => typeof item === 'string' ? undefined : item.dispose()))
    }
  }, 30_000)
})

describe('OECP v1 receipt', () => {
  test('a v1 descriptor arrives as lease id, desktop portal, resolved env and allocation', async () => {
    const sent: { delivery_kind: string; msg: string; meta?: Record<string, unknown> }[] = []
    const compute = createComputeControl({
      managerId: 'urn:onlyne:agent:compute',
      node: () => runnerNode(sent),
      timeoutMs: 5_000,
      log: () => {},
    })
    const portal = 'http://10.0.12.88:32155/vnc.html?password=xyz&autoconnect=true'

    const pending = compute.acquire({
      name: 'omd-sandbox-issue-job1',
      workspacePath: WORKSPACE,
      image: 'debian:12',
      ttlMs: 1_800_000,
    })
    await Promise.resolve()
    compute.settle({
      thread_ref: { owner: 'urn:onlyne:agent:issue-runner', id: 'msg-1' },
      seq: '2',
      authenticated_author: 'urn:onlyne:agent:compute',
      message: {
        id: 'answer-1',
        sender: 'urn:onlyne:agent:compute',
        delivery_kind: 'compute',
        msg: 'compute acquire: omd-sandbox-issue-job1 is running.',
        meta: {
          data: {
            lease_id: 'cls_01M6R38AW6HH2S',
            name: 'omd-sandbox-issue-job1',
            state: 'running',
            workspacePath: WORKSPACE,
            expires_at: 1_793_974_057_000,
            idle_timeout_ms: 600_000,
            connection: {
              exec_transport: 'ssh',
              endpoints: { 'vnc-desktop': 'http://10.0.12.88:32155' },
              portal_urls: { desktop: portal },
            },
            resolved_env: { GATEWAY_PORT: '32155' },
            allocated: { arch: 'arm64', container_id: 'd0f19c83b8a12', host_ip: '10.0.12.88' },
          },
        },
      },
    } as unknown as Entry)

    expect(await pending).toEqual({
      kind: 'granted',
      descriptor: {
        name: 'omd-sandbox-issue-job1',
        state: 'running',
        workspacePath: WORKSPACE,
        desktopUrl: portal,
        expiresAt: 1_793_974_057_000,
        idleTimeoutMs: 600_000,
        leaseId: 'cls_01M6R38AW6HH2S',
        connection: {
          execTransport: 'ssh',
          endpoints: { 'vnc-desktop': 'http://10.0.12.88:32155' },
          portalUrls: { desktop: portal },
        },
        resolvedEnv: { GATEWAY_PORT: '32155' },
        allocated: { arch: 'arm64', container_id: 'd0f19c83b8a12', host_ip: '10.0.12.88' },
      },
    })
  })

  test('renew names the lease it extends and reports the manager\'s answer', async () => {
    const sent: { delivery_kind: string; msg: string; meta?: Record<string, unknown> }[] = []
    const compute = createComputeControl({
      managerId: 'urn:onlyne:agent:compute',
      node: () => runnerNode(sent),
      timeoutMs: 5_000,
      log: () => {},
    })

    const pending = compute.renew('omd-sandbox-issue-job1', 1_800_000, 'cls_01M6R38AW6HH2S')
    await Promise.resolve()
    compute.settle({
      thread_ref: { owner: 'urn:onlyne:agent:issue-runner', id: 'msg-1' },
      seq: '2',
      authenticated_author: 'urn:onlyne:agent:compute',
      message: {
        id: 'answer-1',
        sender: 'urn:onlyne:agent:compute',
        delivery_kind: 'compute',
        msg: 'compute renew: omd-sandbox-issue-job1 is running.',
        meta: { data: { lease_id: 'cls_01M6R38AW6HH2S', name: 'omd-sandbox-issue-job1', state: 'running' } },
      },
    } as unknown as Entry)

    expect(await pending).toBe('renewed')
    expect(sent[0]).toEqual({
      delivery_kind: 'compute',
      msg: 'renew workspace machine',
      meta: {
        to: 'urn:onlyne:agent:compute',
        operation: 'renew',
        name: 'omd-sandbox-issue-job1',
        ttl_ms: 1_800_000,
        lease_id: 'cls_01M6R38AW6HH2S',
      },
    })
  })
})

describe('lease heartbeat', () => {
  test('renews at half the window and stops on request', async () => {
    vi.useFakeTimers()
    try {
      let renewals = 0
      expect(leaseRenewInterval(1_800_000)).toBe(900_000)
      // A lease that also names an idle timeout renews at half the shorter window.
      expect(leaseRenewInterval(1_800_000, 600_000)).toBe(300_000)
      expect(leaseRenewInterval(1_800_000, 0)).toBe(900_000)
      // A window shorter than 100 ms still renews at the floor, not in a loop.
      expect(leaseRenewInterval(10)).toBe(50)

      const heartbeat = startLeaseHeartbeat({
        name: 'omd-sandbox-issue-job1',
        ttlMs: 400,
        idleTimeoutMs: 200,
        leaseId: 'cls_1',
        renew: async () => {
          renewals++
          return true
        },
        log: () => {},
      })

      // One tick at a time: the heartbeat renews once, then waits for the
      // answer before it renews again.
      for (let tick = 0; tick < 2; tick++) {
        vi.advanceTimersByTime(100)
        await flushMicrotasks()
      }
      expect(renewals).toBe(2)

      heartbeat.stop()
      vi.advanceTimersByTime(500)
      expect(renewals).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('stops after two refusals instead of asking forever', async () => {
    vi.useFakeTimers()
    try {
      const log: string[] = []
      let renewals = 0
      startLeaseHeartbeat({
        name: 'omd-sandbox-issue-job1',
        ttlMs: 200,
        leaseId: 'cls_1',
        renew: async () => {
          renewals++
          return false
        },
        log: message => log.push(message),
      })

      // One tick at a time, letting each refusal settle before the next.
      for (let tick = 0; tick < 10; tick++) {
        vi.advanceTimersByTime(100)
        await Promise.resolve()
      }

      expect(renewals).toBe(2)
      expect(log.some(line => line.includes('was refused twice'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('vm-agent lease lifecycle', () => {
  test('renews while the lease is held and stops when the job is disposed', async () => {
    vi.useFakeTimers()
    try {
      const worktrees = allocator()
      const boxes = machine()
      const leases = control('granted')
      const backend = createVmAgentBackend({
        ...options({ compute: leases.compute, vm: boxes.vm, allocator: worktrees.allocator }),
        leaseTtlMs: 200,
      })

      const provisioned = await backend.provision(jobOf())
      expect(provisioned.leaseId).toBe('lease-omd-sandbox-issue-job1')

      for (let tick = 0; tick < 2; tick++) {
        vi.advanceTimersByTime(100)
        await flushMicrotasks()
      }
      const whileHeld = leases.calls.filter(call => call.startsWith('renew:')).length
      expect(whileHeld).toBe(2)

      await backend.dispose(jobOf())
      const atDispose = leases.calls.filter(call => call.startsWith('renew:')).length
      vi.advanceTimersByTime(500)
      expect(leases.calls.filter(call => call.startsWith('renew:')).length).toBe(atDispose)
    } finally {
      vi.useRealTimers()
    }
  })

  test('the receipt\'s desktop portal wins over the provider\'s own display address', async () => {
    const worktrees = allocator()
    const boxes = machine()
    const portal = 'http://portal.test/vnc.html?password=t&autoconnect=true'
    const leased: ComputeControl = {
      ...control('granted').compute,
      acquire: async spec => ({
        kind: 'granted',
        descriptor: {
          name: spec.name,
          state: 'running',
          leaseId: 'cls_1',
          connection: { portalUrls: { desktop: portal } },
        },
      }),
    }
    const backend = createVmAgentBackend(options({
      compute: leased, vm: boxes.vm, allocator: worktrees.allocator,
    }))

    const provisioned = await backend.provision(jobOf())
    // The provider answers with its own address; the lease receipt is newer.
    expect(boxes.calls).toEqual([])
    expect(provisioned.desktopUrl).toBe(portal)
    await backend.dispose(jobOf())
  })
})
