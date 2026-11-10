/**
 * The lease table: one JSON document, written atomically, holding every
 * outstanding claim this process knows about.
 *
 * The table is the manager's memory across restarts. A machine outlives the
 * process that created it, so the lease has to outlive it too: without the
 * ledger, a restart would leave machines running that nobody holds a claim on,
 * and the sweep would have no window to measure them by.
 *
 * A row is the lease with nothing derived: the lease id comes from the name, and
 * the remaining ttl from the clock, so neither is stored. Rows written by an
 * older build carry no caps and no activity clock; they are read as leases whose
 * caps the manager fills from its own configuration, not dropped.
 *
 * @module omd-compute/ledger
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ComputeAllocation, ComputeLease, ComputeState } from './types.ts'

/** One row as it is stored: the lease, with nothing derived. */
export interface StoredLease {
  name: string
  workspacePath: string
  owner: string
  purpose: string | null
  createdAt: number
  expiresAt: number
  state: ComputeState
  /** Absent on rows an older build wrote. */
  lastActivityAt?: number
  maxTtlMs?: number
  idleTimeoutMs?: number
  autoDestroy?: boolean
  portal?: string
  allocated?: ComputeAllocation
}

/** True for a number that survived a round trip through JSON. */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** True for an allocation this version can read. */
function isAllocation(value: unknown): value is ComputeAllocation {
  if (typeof value !== 'object' || value === null) return false
  const allocation = value as Record<string, unknown>
  return isNumber(allocation.cpuCores) && isNumber(allocation.memoryMb)
    && (allocation.diskGb === undefined || isNumber(allocation.diskGb))
}

/** True for a row this version can read; a malformed row is dropped, not guessed at. */
function isRow(value: unknown): value is StoredLease {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.name === 'string' && row.name !== ''
    && typeof row.workspacePath === 'string' && row.workspacePath.startsWith('/')
    && typeof row.owner === 'string'
    && (row.purpose === null || typeof row.purpose === 'string')
    && isNumber(row.createdAt)
    && isNumber(row.expiresAt)
    && (row.state === 'running' || row.state === 'stopped' || row.state === 'released')
    && (row.lastActivityAt === undefined || isNumber(row.lastActivityAt))
    && (row.maxTtlMs === undefined || isNumber(row.maxTtlMs))
    && (row.idleTimeoutMs === undefined || isNumber(row.idleTimeoutMs))
    && (row.autoDestroy === undefined || typeof row.autoDestroy === 'boolean')
    && (row.portal === undefined || typeof row.portal === 'string')
    && (row.allocated === undefined || isAllocation(row.allocated))
}

/**
 * Read the ledger at `path`.
 *
 * A missing file is an empty table. A corrupt one is also an empty table, with
 * the reason handed back so the caller can say so: refusing to start over a
 * ledger nobody can read would trade one broken file for a manager that never
 * runs, and the machines are still discoverable through `vm://`.
 * @param path - the ledger file.
 * @returns the leases it held, and why it could not be read when it could not.
 */
export async function readLedger(path: string): Promise<{ leases: StoredLease[]; problem?: string }> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const missing = (error as { code?: string }).code === 'ENOENT'
    return missing ? { leases: [] } : { leases: [], problem: `the lease ledger could not be read: ${String(error)}` }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return { leases: [], problem: 'the lease ledger is not a JSON array' }
    const leases = parsed.filter(isRow).map(row => ({ ...row }))
    const dropped = parsed.length - leases.length
    return dropped === 0 ? { leases } : { leases, problem: `the lease ledger carried ${String(dropped)} unreadable rows` }
  } catch (error) {
    return { leases: [], problem: `the lease ledger is not valid JSON: ${String(error)}` }
  }
}

/**
 * Write the ledger, atomically.
 *
 * A temp file plus a rename, so a crash between the two leaves the previous
 * table intact rather than half of the next one.
 * @param path - the ledger file.
 * @param leases - every lease to keep.
 */
export async function writeLedger(path: string, leases: readonly ComputeLease[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const rows: StoredLease[] = leases.map(lease => ({
    name: lease.name,
    workspacePath: lease.workspacePath,
    owner: lease.owner,
    purpose: lease.purpose,
    createdAt: lease.createdAt,
    expiresAt: lease.expiresAt,
    state: lease.state,
    lastActivityAt: lease.lastActivityAt,
    maxTtlMs: lease.maxTtlMs,
    idleTimeoutMs: lease.idleTimeoutMs,
    autoDestroy: lease.autoDestroy,
    ...(lease.portal === undefined ? {} : { portal: lease.portal }),
    ...(lease.allocated === undefined ? {} : { allocated: lease.allocated }),
  }))
  const temp = `${path}.tmp`
  await writeFile(temp, `${JSON.stringify(rows, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}
