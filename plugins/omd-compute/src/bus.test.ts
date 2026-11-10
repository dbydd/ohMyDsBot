import assert from 'node:assert/strict'
import test from 'node:test'
import { sandboxVmDriver } from './driver.ts'
import { computeRequest, computeResultBody, readComputeResult, COMPUTE_REQUEST_KIND, COMPUTE_RESULT_KIND } from './wire.ts'

test('an acquire is a standard compute message, not a local orbctl call', () => {
  const message = computeRequest('urn:onlyne:agent:compute', {
    operation: 'acquire',
    name: 'omd-compute-worker',
    workspacePath: '/work/job',
    container: { image: 'debian:12', mounts: [{ host_path: '/work/job', container_path: '/workspace' }] },
    lease: { ttl_ms: 1_800_000 },
    purpose: 'issue-7',
  }, 'acquire workspace machine')
  assert.equal(message.delivery_kind, COMPUTE_REQUEST_KIND)
  assert.equal(message.meta?.to, 'urn:onlyne:agent:compute')
  assert.equal(message.meta?.operation, 'acquire')
  assert.equal(message.meta?.name, 'omd-compute-worker')
  const container = message.meta?.container as { image?: string }
  assert.equal(container.image, 'debian:12')
  const lease = message.meta?.lease as { ttl_ms?: number }
  assert.equal(lease.ttl_ms, 1_800_000)
})

test('a providing node reply is compute-result JSON, and the older meta.data envelope still parses', () => {
  const body = computeResultBody({
    lease_id: 'lease-omd-compute-worker',
    name: 'omd-compute-worker',
    state: 'running',
    connection: { portal_urls: { desktop: 'vm://omd-compute-worker/desktop' } },
  })
  const standard = readComputeResult({
    message: { delivery_kind: COMPUTE_RESULT_KIND, msg: body, meta: {} },
  } as never)
  assert.equal(standard?.ok, true)
  if (standard?.ok) assert.equal(standard.data.lease_id, 'lease-omd-compute-worker')

  const legacy = readComputeResult({
    message: {
      delivery_kind: 'compute',
      msg: 'compute acquire: running',
      meta: { data: { name: 'omd-compute-worker', state: 'running' } },
    },
  } as never)
  assert.equal(legacy?.ok, true)
  if (legacy?.ok) assert.equal(legacy.data.state, 'running')
})

test('the orbstack driver is the seam behind the message and does not choose a command channel', async () => {
  const calls: string[] = []
  const driver = sandboxVmDriver({
    provision: async request => {
      calls.push(`provision:${request.name}:${request.workspacePath}`)
      return { name: request.name, desktopUrl: 'http://guest/vnc.html' }
    },
    start: async name => { calls.push(`start:${name}`) },
    stop: async name => { calls.push(`stop:${name}`) },
    dispose: async name => { calls.push(`dispose:${name}`) },
    inspect: async () => ({ state: 'ready', desktopUrl: 'http://guest/vnc.html' }),
  })
  assert.equal(driver.id, 'orbstack')
  assert.deepEqual(driver.supportedArchs, ['arm64'])
  const allocated = await driver.provision('lease-1', {
    name: 'omd-compute-worker',
    container: {
      image: 'debian:12',
      mounts: [{ type: 'bind', host_path: '/work/job', container_path: '/workspace' }],
    },
  })
  assert.equal(allocated.provider, 'orbstack')
  assert.equal(allocated.container_id, 'omd-compute-worker')
  assert.equal(allocated.connection?.portal_urls?.desktop, 'http://guest/vnc.html')
  assert.equal(allocated.connection?.exec_transport, undefined)
  await driver.stop('omd-compute-worker')
  await driver.destroy('omd-compute-worker')
  assert.deepEqual(calls, [
    'provision:omd-compute-worker:/work/job',
    'stop:omd-compute-worker',
    'dispose:omd-compute-worker',
  ])
})
