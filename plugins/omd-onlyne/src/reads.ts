/**
 * `onlyne://` as a record the browser and the model read.
 *
 * Reads are process-level: the caller picks a node with its own session, `?session=`, or
 * `?node=`, and a caller that names nothing gets the process's first live node. A session
 * that hosts no node is not an error — a subagent, a browser tab opened before the plugin
 * mounted, and a script with no session all read the same process records.
 *
 * Writes are not: a POST must name the session or node it acts for, because a message's
 * sender is a protocol fact. Falling back to the first live node would put a human's
 * interruption under a Bot's identity.
 *
 * @module omd-onlyne/reads
 */

import type { Json, NodeId } from '@onlyne/lib'
import type { InternalExec, InternalSource } from 'omd-internal-paths'
import type { BotNode } from './node.ts'
import type { SeedTarget } from './neighbors.ts'
import { directoryRows, neighborRows } from './neighbors.ts'
import { liveNode, liveNodes, type NodeTable } from './nodes.ts'
import { sharedRegistry } from './registry.ts'

/** The settings one `onlyne://` source reads. */
export interface ReadConfig {
  readonly threadPageSize: number
  readonly seeds?: readonly SeedTarget[]
}

/** One read, with the node that answers it and the path it named. */
export interface ReadTarget {
  readonly bot: BotNode
  readonly path: string
  readonly params: URLSearchParams
}

/** A POST's sender: a node, and the session context its message belongs to. */
export interface SendTarget {
  readonly bot: BotNode
  readonly sessionId: string | undefined
  readonly path: string
  readonly params: URLSearchParams
  readonly meta: Record<string, Json> | undefined
}

/** Split a source path into its record name and its query string. */
export function splitAddress(raw: string): { path: string; params: URLSearchParams } {
  const cut = raw.indexOf('?')
  const hash = raw.indexOf('#')
  const end = hash < 0 ? raw.length : hash
  const path = (cut < 0 ? raw.slice(0, end) : raw.slice(0, cut)).trim().replace(/^\/+/u, '').replace(/\/+$/u, '')
  const query = cut < 0 ? '' : raw.slice(cut + 1, end)
  return { path, params: new URLSearchParams(query) }
}

function available(nodes: NodeTable): string {
  const sessions = nodes.sessions()
  const hosted = liveNodes().map(entry => entry.nodeId)
  return [
    sessions.length === 0 ? 'no session hosts a node' : `sessions: ${sessions.join(', ')}`,
    hosted.length === 0 ? 'no node is live' : `nodes: ${hosted.join(', ')}`,
  ].join('; ')
}

/**
 * The node one read speaks for: the calling session, the one `?session=` names, the one
 * `?node=` names, or the process's first live node.
 *
 * @throws when the process hosts no node at all, with the sessions it does have.
 */
export async function readTarget(nodes: NodeTable, exec: InternalExec, raw: string): Promise<ReadTarget> {
  const { path, params } = splitAddress(raw)
  const caller = exec.agent === undefined ? exec.sessionId : String(exec.agent.session.id)
  for (const sessionId of [caller, params.get('session') ?? undefined]) {
    if (sessionId === undefined || sessionId === '') continue
    const session = await nodes.get(sessionId)
    if (session !== undefined) return { bot: session.bot, path, params }
    const byNode = liveNode(sessionId)
    if (byNode !== undefined) return { bot: await byNode, path, params }
  }
  const named = params.get('node')
  if (named !== null && named !== '') {
    const found = liveNode(named)
    if (found !== undefined) return { bot: await found, path, params }
  }
  const first = await nodes.first()
  if (first !== undefined) return { bot: first.bot, path, params }
  const live = liveNodes()[0]
  if (live !== undefined) return { bot: await live.bot, path, params }
  throw new Error(`onlyne:// has no Onlyne node mounted in this process (${available(nodes)}).`)
}

/**
 * The sender one POST acts for. There is no fallback: an explicit session, the calling
 * agent, or `meta.from` naming a node.
 *
 * @throws when none is named or the named one hosts no node, listing what the process has.
 */
export async function sendTarget(
  nodes: NodeTable,
  exec: InternalExec,
  raw: string,
  meta: Record<string, Json> | undefined,
): Promise<SendTarget> {
  const { path, params } = splitAddress(raw)
  const caller = exec.agent === undefined ? exec.sessionId : String(exec.agent.session.id)
  const from = meta?.from
  const candidates = [
    caller,
    params.get('session') ?? undefined,
    typeof from === 'string' && from !== '' ? from : undefined,
  ].filter((value): value is string => value !== undefined && value !== '')
  if (candidates.length === 0) {
    throw new Error(`onlyne:// POST needs a sender: run it from an agent session, pass ?session=<session id>, or set meta.from to a node id (${available(nodes)}).`)
  }
  for (const candidate of candidates) {
    const session = await nodes.get(candidate)
    if (session !== undefined) {
      return { bot: session.bot, sessionId: String(session.agent.session.id), path, params, meta }
    }
    const byNode = liveNode(candidate)
    if (byNode !== undefined) {
      const primary = await nodes.primary(candidate)
      return {
        bot: await byNode,
        sessionId: primary === undefined ? undefined : String(primary.agent.session.id),
        path, params, meta,
      }
    }
  }
  throw new Error(`onlyne:// POST names a sender that hosts no node (${available(nodes)}).`)
}

/** The runner's worker table, when the issue runner published one. */
interface RunnerWorker {
  readonly worker?: unknown
  readonly workerId?: unknown
  readonly id?: unknown
  readonly machine?: unknown
  readonly thread?: unknown
  readonly state?: unknown
  readonly startedAt?: unknown
  readonly workUnit?: unknown
}

/** What one process-level catalog offers, as this side reads it. */
interface RunnerCatalogFace {
  readonly workers?: RunnerWorker[]
  readonly readEvents?: (worker: string) => Promise<unknown>
}

/**
 * The worker catalog `omd-issue-runner` publishes for the process.
 *
 * The issue runner owns the shape; this side needs two things from it — the
 * worker rows, and the reader that turns one worker's session into a feed. A
 * runner that predates the feed publishes the bare worker list, either
 * directly or as a function returning it, and both are still read so a
 * mismatched pair of plugin versions lists workers instead of answering
 * nothing.
 */
function runnerCatalog(): RunnerCatalogFace | undefined {
  const published = (globalThis as { __onlyneRunnerCatalog?: unknown }).__onlyneRunnerCatalog
  if (published === undefined) return undefined
  let value: unknown
  try {
    value = typeof published === 'function' ? (published as () => unknown)() : published
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return { workers: workersOf(value) }
  // The global crosses a package boundary the compiler cannot follow, so the
  // two members are narrowed here and cast once each; both are checked.
  const readEvents = 'readEvents' in value && typeof value.readEvents === 'function'
    ? value.readEvents as (worker: string) => Promise<unknown>
    : undefined
  const rowsOf = 'workers' in value && typeof value.workers === 'function'
    ? value.workers as () => unknown
    : undefined
  if (rowsOf !== undefined) {
    let rows: unknown
    try { rows = rowsOf() } catch { return undefined }
    return { workers: workersOf(rows), ...readEvents === undefined ? {} : { readEvents } }
  }
  return { workers: workersOf(value), ...readEvents === undefined ? {} : { readEvents } }
}

function workersOf(value: unknown): RunnerWorker[] | undefined {
  if (Array.isArray(value)) return value.filter(row => typeof row === 'object' && row !== null) as RunnerWorker[]
  if (typeof value !== 'object' || value === null) return undefined
  for (const list of [(value as { workers?: unknown }).workers, (value as { items?: unknown }).items]) {
    if (Array.isArray(list)) return list.filter(row => typeof row === 'object' && row !== null) as RunnerWorker[]
  }
  return undefined
}

/** The id an address names, compared against every spelling the row may use. */
function workerNamed(rows: RunnerWorker[], id: string): RunnerWorker | undefined {
  return rows.find(row => {
    // `workerId` is the identity the address carries; `worker` is the full onlyne:// address
    // and `id` an older spelling, so all three are compared.
    for (const value of [row.workerId, row.id, row.worker]) {
      if (typeof value === 'string' && (value === id || value.endsWith(`/${id}`))) return true
    }
    return false
  })
}

/** One thread alias: `<threadId>` or `<owner>/<threadId>`. */
function splitAlias(alias: string): { owner?: string; id: string } {
  const cut = alias.indexOf('/')
  if (cut <= 0) return { id: alias }
  return { owner: alias.slice(0, cut), id: alias.slice(cut + 1) }
}

/** Resolve an alias against the hosted threads, then the joined ones. */
async function threadByAlias(bot: BotNode, alias: string, pageSize: number): Promise<{ owner: NodeId; id: string }> {
  const wanted = splitAlias(alias)
  const match = (ref: { owner: NodeId; id: string }): boolean =>
    ref.id === wanted.id && (wanted.owner === undefined || ref.owner === wanted.owner)
  const owned = await bot.node.threads.list(bot.node.auth, { page_size: pageSize })
  for (const thread of owned.items) if (match(thread.thread_ref)) return thread.thread_ref
  const joined = await bot.node.client.joinedThreads({ page_size: pageSize })
  for (const row of joined.items) if (match(row.thread_ref)) return row.thread_ref
  throw new Error(`no onlyne thread is named "${alias}"`)
}

/** The JSON body a POST carries, or a readable refusal. */
function bodyOf(content: string): Record<string, Json> {
  let parsed: unknown
  try { parsed = JSON.parse(content) } catch {
    throw new Error('onlyne:// POST needs a JSON object with delivery_kind, msg and meta')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('onlyne:// POST needs a JSON object')
  }
  return parsed as Record<string, Json>
}

function metaOf(body: Record<string, Json>): Record<string, Json> | undefined {
  const meta = body.meta
  if (meta === undefined) return undefined
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new Error('onlyne:// POST needs meta to be a JSON object')
  }
  return meta as Record<string, Json>
}

/**
 * `onlyne://` — the records a process can read as files, and the one POST that sends.
 *
 * @param config - page size and the configured seeds the directory lists.
 * @param nodes - the session table the caller's identity resolves through.
 * @returns the source registered under the `onlyne` scheme.
 */
export function onlyneSource(config: ReadConfig, nodes: NodeTable): InternalSource {
  const pageSize = config.threadPageSize
  const seeds = config.seeds ?? []
  return {
    grammar: [
      'onlyne://directory',
      'onlyne://neighbors',
      'onlyne://threads',
      'onlyne://threads/<alias>/messages',
      'onlyne://inbox',
      'onlyne://runner/workers',
      'onlyne://runner/issue/<id>',
      'onlyne://runner/issue/<id>/events',
    ].join(' | '),
    description: 'Onlyne nodes, threads, their messages and this process\'s inbox. GET reads; POST to onlyne://threads sends one message carrying { delivery_kind, msg, meta }.',
    shorthand: true,
    async post(path, content, exec) {
      const { path: clean } = splitAddress(path)
      if (clean !== '' && clean !== 'threads') {
        throw new Error(`onlyne:// POST accepts "threads"; "${path}" is a record, not an action`)
      }
      const body = bodyOf(content)
      const kind = body.delivery_kind
      if (typeof kind !== 'string' || kind === '') throw new Error('onlyne:// POST needs a non-empty delivery_kind')
      if (typeof body.msg !== 'string') throw new Error('onlyne:// POST needs a string msg')
      const meta = metaOf(body)
      const target = await sendTarget(nodes, exec, path, meta)
      // `from` selected the sender; it is not part of the message it sends.
      const forwarded = target.meta === undefined
        ? undefined
        : Object.fromEntries(Object.entries(target.meta).filter(([key]) => key !== 'from'))
      const to = forwarded?.to
      if (typeof to === 'string' && sharedRegistry.resolve(to) !== undefined) {
        await target.bot.ensurePaired(to)
      }
      const result = await target.bot.node.client.msg({
        delivery_kind: kind,
        msg: body.msg,
        ...(forwarded === undefined ? {} : { meta: forwarded }),
      }, {
        signal: exec.signal,
        ...(target.sessionId === undefined ? {} : { context: target.sessionId }),
      })
      return JSON.stringify(result, null, 2)
    },
    async read(path, exec) {
      const { path: clean, params } = splitAddress(path)

      if (clean === 'directory') {
        return readDirectory(nodes, exec, path, seeds)
      }
      if (clean === 'neighbors') {
        const target = await readTarget(nodes, exec, path).catch(() => undefined)
        if (target === undefined) return JSON.stringify({ node: null, neighbors: [] }, null, 2)
        const rows = await neighborRows(target.bot.storage, target.bot.node.discovery)
        return JSON.stringify({ node: target.bot.nodeId, neighbors: rows }, null, 2)
      }
      if (clean === 'runner/workers' || clean.startsWith('runner/issue/')) {
        const target = await readTarget(nodes, exec, path).catch(() => undefined)
        return readRunner(target?.bot.nodeId ?? null, clean)
      }

      const target = await readTarget(nodes, exec, path)
      const bot = target.bot
      if (clean === '' || clean === 'threads') {
        const owned = await bot.node.threads.list(bot.node.auth, { page_size: pageSize })
        const joined = await bot.node.client.joinedThreads({ page_size: pageSize })
        return JSON.stringify({
          node: bot.nodeId,
          threads: [
            ...owned.items.map(thread => ({
              alias: `${thread.thread_ref.owner}/${thread.thread_ref.id}`,
              hosted: true,
              title: thread.title,
              state: thread.state,
              next_seq: thread.next_seq,
            })),
            ...joined.items.map(row => ({
              alias: `${row.thread_ref.owner}/${row.thread_ref.id}`,
              hosted: false,
              title: row.title ?? null,
              state: row.state ?? null,
              last_seq: row.last_seq,
              messages: row.message_count,
            })),
          ],
          next_cursor: owned.next_cursor ?? joined.next_cursor,
        }, null, 2)
      }
      if (clean === 'inbox') {
        const inbox = await bot.node.messages.inbox(bot.node.auth, { page_size: pageSize })
        return JSON.stringify({
          node: bot.nodeId,
          count: inbox.items.length,
          next_cursor: inbox.next_cursor,
          messages: inbox.items.map(row => ({
            thread: `${row.attention.thread_ref.owner}/${row.attention.thread_ref.id}`,
            seq: row.attention.seq,
            sender: row.attention.authenticated_author,
            delivery_kind: row.attention.entry?.message.delivery_kind ?? null,
            injected: row.injected,
            settlement: row.settlement?.via ?? null,
            msg: row.attention.entry?.message.msg ?? null,
          })),
        }, null, 2)
      }
      const parts = clean.split('/')
      if (parts[0] === 'threads' && parts.length >= 3 && parts[parts.length - 1] === 'messages') {
        const alias = parts.slice(1, -1).join('/')
        const ref = await threadByAlias(bot, alias, pageSize)
        const entries = await bot.node.client.threadEntries(ref, { page_size: pageSize, attention: 'thread' })
        return JSON.stringify({
          node: bot.nodeId,
          thread: `${ref.owner}/${ref.id}`,
          next_cursor: entries.next_cursor,
          messages: entries.items.map(entry => ({
            seq: entry.seq,
            sender: entry.message.sender,
            at: entry.at,
            delivery_kind: entry.message.delivery_kind,
            msg: entry.message.msg,
          })),
        }, null, 2)
      }
      throw new Error(`onlyne:// has no path "${path}"; use directory, neighbors, threads, threads/<alias>/messages, inbox, runner/workers, runner/issue/<id>, or runner/issue/<id>/events`)
    },
  }
}

/** The directory answer: three merged tiers, with the node the answer speaks for. */
async function readDirectory(
  nodes: NodeTable,
  exec: InternalExec,
  raw: string,
  seeds: readonly SeedTarget[],
): Promise<string> {
  const target = await readTarget(nodes, exec, raw).catch(() => undefined)
  const bot = target?.bot
  const peers = bot === undefined ? [] : await neighborRows(bot.storage, bot.node.discovery)
  const rows = directoryRows(peers, seeds, bot?.nodeId)
  return JSON.stringify({
    self: bot?.nodeId ?? null,
    baseUrl: bot?.baseUrl ?? null,
    fingerprint: bot?.fingerprint ?? null,
    nodes: rows,
  }, null, 2)
}

/** The runner catalog answer: workers, one worker, or that worker's session feed. */
async function readRunner(node: NodeId | null, clean: string): Promise<string> {
  const catalog = runnerCatalog()
  if (catalog?.workers === undefined) {
    throw new Error('onlyne://runner has no worker catalog: the issue runner is not mounted in this process.')
  }
  const workers = catalog.workers
  if (clean === 'runner/workers') return JSON.stringify({ node, workers }, null, 2)
  const [id, ...tail] = clean.slice('runner/issue/'.length).split('/')
  if (id === undefined || id === '') {
    throw new Error('onlyne://runner/issue/ names no worker; read onlyne://runner/workers for the list.')
  }
  if (tail.length > 1 || (tail.length === 1 && tail[0] !== 'events')) {
    throw new Error(
      `onlyne://runner/issue/${id} has no "${tail.join('/')}" record; read onlyne://runner/issue/${id} for `
      + 'the worker, or its /events for the run.',
    )
  }
  if (tail.length === 1) {
    const uri = `onlyne://runner/issue/${id}`
    if (catalog.readEvents === undefined) {
      throw new Error(`the issue runner in this process cannot read session events; read ${uri} for the worker.`)
    }
    return readWorkerEvents(uri, await catalog.readEvents(uri))
  }
  const worker = workerNamed(workers, id)
  if (worker === undefined) {
    throw new Error(`onlyne://runner/issue/${id} names no live worker; read onlyne://runner/workers for the list.`)
  }
  return JSON.stringify({ node, worker }, null, 2)
}

/**
 * One session feed as the catalog's reader answered it.
 *
 * The runner reports either a feed or the reason there is none; a worker that
 * is unknown, has not started a session, or whose log this host cannot reach
 * is a refusal with the runner's own wording, not an empty feed that would
 * read as a run that did nothing.
 *
 * @param uri - the worker address that was read, for the refusal text.
 * @param answer - the reader's answer, read structurally across the package boundary.
 * @returns the feed, as JSON.
 */
function readWorkerEvents(uri: string, answer: unknown): string {
  const record = typeof answer === 'object' && answer !== null ? answer : undefined
  const kind = record !== undefined && 'kind' in record ? record.kind : undefined
  if (kind === 'feed' && record !== undefined && 'value' in record
    && typeof record.value === 'object' && record.value !== null) {
    return JSON.stringify(record.value, null, 2)
  }
  const reason = record !== undefined && 'reason' in record && typeof record.reason === 'string'
    ? record.reason
    : `${uri}/events answered nothing this reader understands; the issue runner and this plugin disagree on the feed`
  throw new Error(reason)
}
