/**
 * `ctx.todoList`: the one data plane for todo lists, published as a service.
 *
 * The tool is a skin over this service. Keeping the service separate means a
 * kanban or a file watcher can replace the list later without impersonating the
 * model tool, while all writers still produce the same two log events in the
 * same order and the same validation.
 *
 * Storage is the session log, never the `todos` projection: the projection is a
 * read-side view for the shipped UI and drops the list on `turn/start`, which
 * would make it the wrong source for a board or a path read.
 *
 * @module omd-todo/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { field } from './fields.ts'
import {
  MAX_DEPTH,
  detailMatchesFlat,
  detailTreeOf,
  flattenTodoTree,
  mergeTodoTree,
  parseTodoTree,
  todoTreeFromDetails,
  todoTreeFromFlat,
} from './tree.ts'
import type {
  FlatTodoItem,
  TodoChangeListener,
  TodoDetail,
  TodoDetailPayload,
  TodoItem,
  TodoListService,
  TodoOrigin,
  TodoSnapshot,
  TodoSource,
  TodoWireStatus,
} from './types.ts'

/** Record type this plugin owns; declared in `types.ts`. */
const DETAIL_RECORD = 'plugin:omd-todo/detail'

/** Deployment policy the service enforces at the storage boundary. */
export interface TodoServicePolicy {
  /** Reject a model-origin replacement that omits `explanation` or `goal`. */
  readonly requireDetail: boolean
  /** Allow more than one node to be `active` at once. */
  readonly allowParallelActive: boolean
}

/**
 * Structural face of the persistence service, used only to tell "no such
 * session" from "exists but not loaded". Optional: a host without persistence
 * simply cannot make that distinction.
 */
interface SessionPersistenceProbe {
  stat(id: SessionId): Promise<unknown>
}

/** Folded log state of one session. */
interface SessionState {
  /** Latest upstream-compatible list, or null before the first write. */
  flat: FlatTodoItem[] | null
  /** Latest narrative tree written beside that list. */
  details: TodoDetail[] | null
  /** Whether a coalesced notification is already queued. */
  pending: boolean
  /** Followers of this session's list. */
  listeners: Set<TodoChangeListener>
}

/** The live implementation published as `ctx.todoList`. */
export class TodoListServiceImpl implements TodoListService {
  readonly #ctx: Context
  readonly #policy: TodoServicePolicy
  readonly #states = new WeakMap<Session, SessionState>()
  /** One FIFO per session, so no two writes can interleave their event pair. */
  readonly #queues = new WeakMap<Session, Promise<void>>()

  /**
   * Publish the data plane and start following session events.
   * @param ctx - plugin context.
   * @param policy - deployment validation policy.
   */
  constructor(ctx: Context, policy: TodoServicePolicy) {
    this.#ctx = ctx
    this.#policy = policy
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const state = this.#states.get(session)
      if (state === undefined) return
      if (!foldEvent(state, event)) return
      this.#schedule(state)
    })
  }

  read(session: Session): TodoSnapshot | null {
    return snapshotOf(this.#state(session))
  }

  replace(target: Session | SessionId, items: readonly TodoItem[], origin: TodoOrigin): Promise<void> {
    return this.#enqueue(target, items, origin)
  }

  subscribe(session: Session, listener: TodoChangeListener): () => void {
    const state = this.#state(session)
    state.listeners.add(listener)
    return () => {
      state.listeners.delete(listener)
    }
  }

  /**
   * Resolve the session, then append the write to its FIFO.
   * @param target - live session or the id of a loaded one.
   * @param items - tree to write.
   * @param origin - who is writing.
   * @returns settles after this write committed, or rejects with its cause.
   */
  async #enqueue(target: Session | SessionId, items: readonly TodoItem[], origin: TodoOrigin): Promise<void> {
    const session = await this.#liveSession(target)
    const previous = this.#queues.get(session) ?? Promise.resolve()
    const next = previous.then(() => this.#apply(session, items, origin))
    // The stored chain never rejects: a failed write must not poison the queue
    // for the callers behind it. This caller still sees its own rejection.
    this.#queues.set(session, next.then(() => undefined, () => undefined))
    return next
  }

  /**
   * Perform one queued write.
   * @param session - live session.
   * @param items - tree to write.
   * @param origin - who is writing; decides the merge and the detail requirement.
   */
  async #apply(session: Session, items: readonly TodoItem[], origin: TodoOrigin): Promise<void> {
    const policy = {
      requireDetail: origin === 'model' && this.#policy.requireDetail,
      allowParallelActive: this.#policy.allowParallelActive,
    }
    const incoming = parseTodoTree(items, policy)
    const owns = ownershipOf(origin)
    if (origin !== 'model') assertOwned(incoming, owns, origin)
    // Rebuild the current tree WITH its narrative before merging; the read
    // side keeps statuses and text apart, and merging without the narrative
    // would blank the explanation and goal of every preserved branch.
    const currentSnapshot = this.read(session)
    const current = currentSnapshot === null
      ? null
      : mergeTodoTree(currentSnapshot.items, currentSnapshot.details)
    const merged = mergeByOrigin(current, incoming, owns, origin)
    const final = origin === 'model' ? incoming : parseTodoTree(merged, policy)
    const payload: TodoDetailPayload = { origin, items: detailTreeOf(final) }
    const flat = flattenTodoTree(final)
    // Both payloads are built from validated strings only, so the record append
    // below cannot fail on serialization or schema after the write committed:
    // the two events either both land or the first append throws before either.
    session.append('todo/write', { todos: flat })
    appendPluginRecord(session, DETAIL_RECORD, payload)
  }

  /**
   * Resolve a live session without activating anything.
   * @param target - live session or its id.
   * @returns the live session.
   * @throws when no live session owns the id, naming whether it exists at all.
   */
  async #liveSession(target: Session | SessionId): Promise<Session> {
    if (typeof target !== 'string') return target
    const live = this.#ctx.sessions.get(target)
    if (live !== undefined) return live
    // Optional seam: without persistence there is no way to tell a deleted
    // session from one this process never loaded.
    const persistence = this.#ctx.get('sessionPersistence') as SessionPersistenceProbe | undefined
    if (persistence === undefined) {
      throw new Error(
        `cannot write todos to session "${target}": it is not loaded here, and no session-persistence `
        + 'service is mounted to check storage — a todo write never starts an agent',
      )
    }
    const stored = await persistence.stat(target)
    if (stored === undefined) throw new Error(`cannot write todos to session "${target}": no such session`)
    throw new Error(
      `cannot write todos to session "${target}": it exists in storage but is not loaded in this process — `
      + 'open or resume it first; a todo write never starts an agent',
    )
  }

  /**
   * Materialize one session's fold, reading its existing log once.
   * @param session - session to materialize.
   * @returns its mutable fold state.
   */
  #state(session: Session): SessionState {
    const existing = this.#states.get(session)
    if (existing !== undefined) return existing
    const state: SessionState = { flat: null, details: null, pending: false, listeners: new Set() }
    // A resumed session already holds a log when this plugin mounts, and the
    // fold has to start from it. The projection registry is the UI's view of
    // the same log, not this plugin's storage (see the module note).
    // oxlint-disable-next-line typescript/no-deprecated -- plugin-owned state needs the log itself.
    for (const event of session.snapshotEvents()) foldEvent(state, event)
    this.#states.set(session, state)
    return state
  }

  /**
   * Queue one coalesced change notification.
   * @param state - the changed fold state.
   */
  #schedule(state: SessionState): void {
    if (state.pending || state.listeners.size === 0) return
    state.pending = true
    queueMicrotask(() => {
      state.pending = false
      if (state.listeners.size === 0) return
      const snapshot = snapshotOf(state)
      for (const listener of [...state.listeners]) {
        try {
          listener(snapshot)
        } catch (error: unknown) {
          this.#ctx.logger.warn(`omd-todo: todoList subscriber failed: ${String(error)}`)
        }
      }
    })
  }
}

/**
 * The roots one origin owns.
 *
 * The model owns everything (its call is the whole-list replacement). An issue
 * sync owns issue roots; a user edit or a file sync owns manual and unsourced
 * roots. Ownership decides which existing roots a write replaces, so an
 * external writer cannot erase a branch it does not maintain.
 * @param origin - who is writing.
 * @returns the ownership predicate for one root.
 */
function ownershipOf(origin: TodoOrigin): (item: TodoItem) => boolean {
  if (origin === 'model') return () => true
  if (origin === 'issue') return item => item.source?.kind === 'issue'
  return item => item.source === undefined || item.source.kind === 'manual'
}

/**
 * Reject external roots this origin does not own instead of silently dropping
 * them from the merge.
 * @param items - the incoming roots.
 * @param owns - the origin's ownership predicate.
 * @param origin - who is writing, quoted in the error.
 */
function assertOwned(items: readonly TodoItem[], owns: (item: TodoItem) => boolean, origin: TodoOrigin): void {
  for (const [index, item] of items.entries()) {
    if (owns(item)) continue
    const source = item.source === undefined ? 'no source' : `source.kind "${item.source.kind}"`
    throw new Error(
      `invalid ${origin}-origin write: todos[${index}] ${JSON.stringify(item.content)} carries ${source}, `
      + 'which this origin does not own — an external write carries only its own roots; '
      + 'a model `todo_write` call is the one that replaces the whole list',
    )
  }
}

/**
 * Splice the origin's branch into the existing tree.
 * @param existing - current roots, or null before the first write.
 * @param incoming - the origin's new roots.
 * @param owns - the origin's ownership predicate.
 * @param origin - who is writing.
 * @returns the roots to store.
 */
function mergeByOrigin(
  existing: readonly TodoItem[] | null,
  incoming: readonly TodoItem[],
  owns: (item: TodoItem) => boolean,
  origin: TodoOrigin,
): TodoItem[] {
  if (origin === 'model' || existing === null) return [...incoming]
  const kept = existing.filter(item => !owns(item))
  const firstOwned = existing.findIndex(item => owns(item))
  const at = firstOwned === -1 ? kept.length : Math.min(firstOwned, kept.length)
  return [...kept.slice(0, at), ...incoming, ...kept.slice(at)]
}

/**
 * Fold one committed event into a session's state.
 * @param state - the session's fold state.
 * @param event - the committed event.
 * @returns whether the todo list may have changed.
 */
function foldEvent(state: SessionState, event: SessionEvent): boolean {
  const type: string = event.type
  if (type === 'todo/write') {
    const raw = event.data !== null && typeof event.data === 'object' ? field(event.data, 'todos') : undefined
    state.flat = Array.isArray(raw) ? raw.flatMap(readFlatItem) : null
    // A new list without its record invalidates the old narrative.
    state.details = null
    return true
  }
  if (type !== DETAIL_RECORD) return false
  const items = event.data !== null && typeof event.data === 'object' ? field(event.data, 'items') : undefined
  state.details = readStoredDetails(items, 0)
  return true
}

/**
 * Read one stored flat entry, dropping anything that is not a todo.
 * @param value - untrusted entry.
 * @returns one entry or nothing.
 */
function readFlatItem(value: unknown): FlatTodoItem[] {
  if (value === null || typeof value !== 'object') return []
  const content = field(value, 'content')
  if (typeof content !== 'string') return []
  const status = field(value, 'status')
  if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return []
  return [{ content, status: status as TodoWireStatus }]
}

/**
 * Read a stored narrative tree, refusing a malformed record rather than
 * half-attaching it.
 * @param value - untrusted payload.
 * @param depth - current level.
 * @returns the tree, or null when the payload is unusable.
 */
function readStoredDetails(value: unknown, depth: number): TodoDetail[] | null {
  if (!Array.isArray(value) || depth > MAX_DEPTH) return null
  const nodes: TodoDetail[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
    const content = field(entry, 'content')
    if (typeof content !== 'string' || content.trim() === '') return null
    const explanation = field(entry, 'explanation') ?? ''
    const goal = field(entry, 'goal') ?? ''
    if (typeof explanation !== 'string' || typeof goal !== 'string') return null
    // A record written before the tri-state model carries a legacy `active`
    // flag beside the status; it is ignored, because the state now comes from
    // the `todo/write` status this record was written with.
    const node: TodoDetail = { content, explanation, goal }
    const rawSource = field(entry, 'source')
    if (rawSource !== undefined) {
      const source = readStoredSource(rawSource)
      if (source === null) return null
      node.source = source
    }
    const rawChildren = field(entry, 'children')
    if (rawChildren !== undefined) {
      const children = readStoredDetails(rawChildren, depth + 1)
      if (children === null) return null
      if (children.length > 0) node.children = children
    }
    nodes.push(node)
  }
  return nodes
}

/**
 * Read stored tracker provenance.
 * @param value - untrusted `source` field.
 * @returns the source, or null when it is not a valid source.
 */
function readStoredSource(value: unknown): TodoSource | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const kind = field(value, 'kind')
  if (kind !== 'issue' && kind !== 'manual') return null
  const source: TodoSource = { kind }
  const repo = field(value, 'repo')
  if (repo !== undefined) {
    if (typeof repo !== 'string' || repo.trim() === '') return null
    source.repo = repo
  }
  const number = field(value, 'number')
  if (number !== undefined) {
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return null
    source.number = number
  }
  return source
}

/**
 * Build the read result from folded state.
 * @param state - one session's fold.
 * @returns the aligned trees, or null with no list.
 */
function snapshotOf(state: SessionState): TodoSnapshot | null {
  if (state.flat === null) return null
  const details = state.details
  if (details !== null && detailMatchesFlat(details, state.flat)) {
    return { items: todoTreeFromDetails(details, state.flat), details }
  }
  const items = todoTreeFromFlat(state.flat)
  return { items, details: detailTreeOf(items) }
}
