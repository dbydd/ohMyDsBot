/**
 * What this node knows about the peers around it, in the one shape every reader shows.
 *
 * The trust table proves who a peer is; the known-thread and grant rows prove this node
 * actually talks to someone; discovery holds the addresses a seed or a scan observed.
 * `onlyne://neighbors`, `onlyne://directory` and the library's `plugins.neighbors` hook all
 * read these rows, so a peer cannot appear in one view and be missing from another.
 *
 * @module omd-onlyne/neighbors
 */

import { trustPhase } from '@onlyne/lib'
import type { DiscoveryService, Grant, NodeId, Storage, ThreadRef, TrustEntry } from '@onlyne/lib'
import { sharedRegistry } from './registry.ts'

/** Where one peer row came from. A peer may be known through several channels. */
export type NeighborSource = 'trust' | 'known' | 'grant' | 'discovery'

/** One peer, merged across every table that names it. */
export interface NeighborRow {
  readonly nodeId: NodeId
  /** Trust stage when the trust table names the peer; `unrecorded` otherwise. */
  readonly state: TrustEntry['state'] | 'unrecorded'
  /** The derived stage (`invited`/`requested`/`exchanged`/`revoked`) when a trust row exists. */
  readonly phase: string | null
  readonly baseUrl: string | null
  readonly fingerprint: string | null
  /** Threads of this peer this node holds a known or grant row for. */
  readonly threads: number
  /** Distinct addresses discovery observed, with the last verification time. */
  readonly observed: Array<{ baseUrl: string; verifiedAt: string | null }>
  /** Whether the trust row proves this peer's key. */
  readonly verified: boolean
  readonly sources: NeighborSource[]
}

interface Mutable {
  readonly nodeId: NodeId
  state: TrustEntry['state'] | 'unrecorded'
  phase: string | null
  baseUrl: string | null
  fingerprint: string | null
  threads: number
  observed: Array<{ baseUrl: string; verifiedAt: string | null }>
  verified: boolean
  sources: NeighborSource[]
}

/**
 * Merge every peer this node can name into one row each.
 * @param storage - the node's own store; trust, known and grant rows all live there.
 * @param discovery - the node's discovery catalog, when it has one.
 * @returns rows sorted by node id.
 */
export async function neighborRows(storage: Storage, discovery?: DiscoveryService): Promise<NeighborRow[]> {
  const merged = new Map<NodeId, Mutable>()
  const row = (nodeId: NodeId): Mutable => {
    const known = merged.get(nodeId)
    if (known !== undefined) return known
    const fresh: Mutable = {
      nodeId, state: 'unrecorded', phase: null, baseUrl: null, fingerprint: null, threads: 0, observed: [], verified: false, sources: [],
    }
    merged.set(nodeId, fresh)
    return fresh
  }

  await storage.transaction(async tx => {
    for (const { value } of await tx.scan<TrustEntry>('trust/')) {
      const peer = row(value.node_id)
      peer.state = value.state
      peer.phase = trustPhase(value)
      peer.verified = value.state === 'trusted'
      peer.baseUrl = value.base_url === '' ? null : value.base_url
      peer.fingerprint = value.fingerprint
      if (!peer.sources.includes('trust')) peer.sources.push('trust')
    }
    for (const { value } of await tx.scan<{ thread_ref: ThreadRef }>('known/')) {
      const peer = row(value.thread_ref.owner)
      peer.threads += 1
      if (!peer.sources.includes('known')) peer.sources.push('known')
    }
    for (const { value } of await tx.scan<Grant>('grant/')) {
      const peer = row(value.thread_ref.owner)
      peer.threads += 1
      if (!peer.sources.includes('grant')) peer.sources.push('grant')
    }
  })

  if (discovery !== undefined) {
    for (const record of await discovery.listRecords()) {
      const peer = row(record.node_id)
      if (peer.baseUrl === null && record.base_url !== '') peer.baseUrl = record.base_url
      peer.observed.push({ baseUrl: record.base_url, verifiedAt: record.verified_at ?? null })
      if (!peer.sources.includes('discovery')) peer.sources.push('discovery')
    }
  }

  return [...merged.values()]
    .map(peer => ({ ...peer, observed: peer.observed.sort((a, b) => a.baseUrl.localeCompare(b.baseUrl)) }))
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
}

/** One address a deployment was configured with, before any handshake proves it. */
export interface SeedTarget {
  readonly nodeId?: string
  readonly baseUrl: string
  readonly label?: string
  readonly fingerprint?: string
}

/** One row of `onlyne://directory`: a node this process hosts or a peer it can reach. */
export interface DirectoryRow {
  readonly nodeId: NodeId
  readonly baseUrl: string | null
  /** `local` outranks `trusted`, which outranks `discovered`, when one node is all three. */
  readonly source: 'local' | 'trusted' | 'discovered'
  readonly isSelf: boolean
  readonly state?: NeighborRow['state']
  readonly fingerprint?: string | null
  readonly label?: string
  readonly verified?: boolean
}

/**
 * The three tiers one directory answer merges: nodes this process hosts, peers the trust
 * table proves (with the threads that prove traffic), and addresses a seed or a scan
 * discovered. Deduplication keeps the strongest evidence and names the tier it came from.
 *
 * @param peers - rows from {@link neighborRows}.
 * @param seeds - configured addresses, which may name no identity yet.
 * @param self - the node the answer speaks for, when one is selected.
 * @returns directory rows sorted by node id.
 */
export function directoryRows(peers: NeighborRow[], seeds: readonly SeedTarget[], self?: NodeId): DirectoryRow[] {
  const rows = new Map<NodeId, DirectoryRow>()
  const put = (next: DirectoryRow): void => {
    const previous = rows.get(next.nodeId)
    if (previous === undefined || rank(next.source) > rank(previous.source)) rows.set(next.nodeId, next)
  }
  for (const endpoint of sharedRegistry.list()) {
    put({ nodeId: endpoint.nodeId, baseUrl: endpoint.baseUrl, source: 'local', isSelf: endpoint.nodeId === self })
  }
  for (const peer of peers) {
    // A peer with no trust row and no thread row is only a discovered address; it belongs
    // to the third tier, not this one.
    if (!peer.sources.includes('trust') && !peer.sources.includes('known') && !peer.sources.includes('grant')) continue
    put({
      nodeId: peer.nodeId,
      baseUrl: peer.baseUrl,
      source: 'trusted',
      isSelf: peer.nodeId === self,
      state: peer.state,
      fingerprint: peer.fingerprint,
      verified: peer.verified,
    })
  }
  for (const seed of seeds) {
    if (seed.nodeId === undefined) continue
    put({
      nodeId: seed.nodeId,
      baseUrl: seed.baseUrl,
      source: 'discovered',
      isSelf: seed.nodeId === self,
      ...(seed.label === undefined ? {} : { label: seed.label }),
      verified: seed.fingerprint !== undefined,
    })
  }
  for (const peer of peers) {
    if (peer.observed.length === 0) continue
    put({
      nodeId: peer.nodeId,
      baseUrl: peer.baseUrl,
      source: 'discovered',
      isSelf: peer.nodeId === self,
      ...(peer.fingerprint === null ? {} : { fingerprint: peer.fingerprint }),
      verified: peer.observed.some(record => record.verifiedAt !== null),
    })
  }
  return [...rows.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId))
}

/** Higher wins when two tiers name one node. */
function rank(source: DirectoryRow['source']): number {
  return source === 'local' ? 2 : source === 'trusted' ? 1 : 0
}

