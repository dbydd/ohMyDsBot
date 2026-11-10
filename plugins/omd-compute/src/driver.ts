/**
 * The hypervisor seam under a compute lease.
 *
 * The bus does not create machines. The node that admitted the `compute`
 * message calls a {@link SandboxDriver}. `orbstack` is the driver
 * `omd-sandbox-vm` already is: isolated ARM64 Linux via `orbctl`, which is
 * Mac-only. A later docker or QEMU driver implements the same four verbs and
 * is selected by the providing node. Nothing here shells out.
 *
 * @module omd-compute/driver
 */

import type { AcquireSpec, DirectConnection, DriverAllocation, LeaseState, SandboxDriver } from '@onlyne/compute-core'
import type { SandboxVm } from 'omd-sandbox-vm/machine'
import type { Sandbox } from 'omd-sandbox-vm/types'

/** What one driver call needs from `omd-sandbox-vm`. Tests pass a fake. */
export interface OrbstackMachine {
  provision(request: { readonly name: string; readonly workspacePath: string }): Promise<Pick<Sandbox, 'name' | 'desktopUrl'>>
  start(name: string): Promise<void>
  stop(name: string): Promise<void>
  dispose(name: string): Promise<void>
  inspect(name: string): Promise<Pick<Sandbox, 'state' | 'desktopUrl'> | undefined>
}

/**
 * OrbStack as the published driver. `container_id` is the machine name,
 * because `orbctl` addresses machines by name and has no separate container id.
 * @param vm - the mounted sandbox service, or a fake with the same verbs.
 * @returns the driver a providing node calls after it has accepted the message.
 */
export function sandboxVmDriver(vm: OrbstackMachine): SandboxDriver {
  return {
    id: 'orbstack',
    supportedArchs: ['arm64'],
    async provision(_leaseId: string, spec: AcquireSpec): Promise<DriverAllocation> {
      const hostPath = spec.container.mounts?.find(mount => mount.host_path !== undefined)?.host_path
      if (hostPath === undefined) {
        throw new Error('orbstack driver: acquire needs container.mounts[].host_path for the workspace')
      }
      const sandbox = await vm.provision({ name: spec.name, workspacePath: hostPath })
      const connection: DirectConnection = {
        endpoints: {},
        portal_urls: sandbox.desktopUrl === undefined ? {} : { desktop: sandbox.desktopUrl },
      }
      return {
        container_id: sandbox.name,
        provider: 'orbstack',
        arch: 'arm64',
        host_ip: '127.0.0.1',
        connection,
      }
    },
    async start(containerId: string): Promise<DirectConnection | undefined> {
      await vm.start(containerId)
      const machine = await vm.inspect(containerId)
      if (machine?.desktopUrl === undefined) return undefined
      return { portal_urls: { desktop: machine.desktopUrl } }
    },
    async stop(containerId: string): Promise<void> {
      await vm.stop(containerId)
    },
    async destroy(containerId: string): Promise<void> {
      await vm.dispose(containerId)
    },
    async status(containerId: string): Promise<{ state: LeaseState; error?: string }> {
      const machine = await vm.inspect(containerId)
      if (machine === undefined || machine.state === 'absent') return { state: 'destroyed' }
      return { state: 'running' }
    },
  }
}

/**
 * The driver id a mounted `SandboxVm` would answer as.
 * Present so the providing node can say which backend it has without calling it.
 * @param vm - the service, when it is mounted.
 * @returns `orbstack`, or undefined when this process has no machine backend.
 */
export function driverId(vm: SandboxVm | undefined): 'orbstack' | undefined {
  return vm === undefined ? undefined : 'orbstack'
}
