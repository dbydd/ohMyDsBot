/**
 * Todo domain types plus the three declarations this plugin owns: the upstream
 * `todo/write` event, its own `plugin:omd-todo/detail` record, and the `todos`
 * projection.
 *
 * Two events, one write. `todo/write` keeps the exact upstream payload
 * (`{ content, status }` per item, no extra keys) because the shipped client
 * registers its todo row, plan strip, and history entry against that event and
 * against the tool name `todo_write`. The domain's single `state` maps onto
 * that wire status one-to-one, so the list round-trips through the log without
 * a second field beside it. The narrative fields and the tree live in
 * `plugin:omd-todo/detail`, which an older reader retains and skips — so the
 * panel keeps working when this plugin is replaced, upgraded, or unloaded.
 *
 * @module omd-todo/types
 */

import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'

/** The one state axis a todo entry has. */
export type TodoState = 'active' | 'inactive' | 'completed'

/**
 * The status an upstream `todo/write` entry carries.
 *
 * `state` maps onto it and back without loss: `active` → `in_progress`,
 * `inactive` → `pending`, `completed` → `completed`.
 */
export type TodoWireStatus = 'pending' | 'in_progress' | 'completed'

/** Where an entry came from, when a tracker produced it. */
export interface TodoSource {
  /** A tracker issue, or a manually written entry. */
  kind: 'issue' | 'manual'
  /** Repository the issue belongs to, e.g. `owner/name`. */
  repo?: string
  /** Issue number. */
  number?: number
}

/**
 * One node of a todo tree as callers and the tool exchange it.
 *
 * `state` is the only lifecycle axis. The earlier model split that axis into
 * `status` (pending / in progress / done) and a boolean `active`, which made
 * most of the six combinations meaningless — a "pending but attention-worthy"
 * entry and a "completed and parked" one both had to be read as whichever
 * field each consumer happened to trust. Order plus `state` say everything:
 * `active` is the step being worked on now, `inactive` is planned but not now,
 * `completed` is done. An inactive entry stays in the tree, stays readable
 * through `dsh-resource://todo/…`, and still counts for the "a completed parent
 * needs every child completed" rule; only the board and the panel hide it by
 * default.
 *
 * `explanation` and `goal` are optional in the type because imported or
 * user-edited lists may omit them (`Config.requireDetail` decides whether the
 * model must supply them). `children` nests smaller steps under a larger one.
 */
export interface TodoItem {
  /** Short imperative line, trimmed, unique among its siblings. */
  content: string
  /** Where this node stands: being worked on, planned, or done. */
  state: TodoState
  /** Why this step exists and what it is connected to. */
  explanation?: string
  /** What is true once this step is done. */
  goal?: string
  /** Tracker provenance, when an issue produced this entry. */
  source?: TodoSource
  /** Smaller steps this one owns, at most two levels deeper than the root. */
  children?: TodoItem[]
}

/** One node of the narrative tree, without state: what the plugin record stores. */
export interface TodoDetail {
  content: string
  explanation: string
  goal: string
  /** Tracker provenance, when an issue produced this entry. */
  source?: TodoSource
  children?: TodoDetail[]
}

/**
 * Who replaced the list. The origin is recorded in the plugin payload and it
 * decides the merge, not just the audit trail:
 *
 * - `model` owns the whole tree — its call is a whole-list replacement.
 * - `issue` owns roots whose `source.kind` is `issue`.
 * - `user` and `file` own roots with `source.kind === 'manual'` or no source.
 *
 * Only the model's whole-list semantics replace everything; an external writer
 * must not wipe entries it does not own.
 */
export type TodoOrigin = 'model' | 'user' | 'file' | 'issue'

/** Payload of the `plugin:omd-todo/detail` record; aligned with the `todo/write` that precedes it. */
export interface TodoDetailPayload {
  /** The caller that replaced the list. */
  origin: TodoOrigin
  /** The tree whose preorder expansion is the preceding `todo/write` list. */
  items: TodoDetail[]
}

/** What one read returns: the state tree and the narrative tree, structurally aligned. */
export interface TodoSnapshot {
  items: TodoItem[]
  details: TodoDetail[]
}

/** One flat entry of the upstream-compatible `todo/write` payload. */
export interface FlatTodoItem {
  content: string
  status: TodoWireStatus
}

/** Called after a session's todo list changes; `null` when the session has no list. */
export type TodoChangeListener = (snapshot: TodoSnapshot | null) => void

/**
 * The todo data plane, published as `ctx.todoList`.
 *
 * It exists so that the tool, a kanban, and a file sync all write the same two
 * events through one choke point instead of each appending its own log
 * sequence. The session projection is a read-side view for the UI, never the
 * storage of record.
 */
export interface TodoListService {
  /**
   * Current tree of one session, or `null` before the first write.
   * @param session - session whose log is folded.
   * @returns the state tree and the aligned narrative tree.
   */
  read(session: Session): TodoSnapshot | null
  /**
   * Write a list, merging it by origin, with `todo/write` and the detail record
   * committed as one pair.
   *
   * A live `Session` is written directly. A `SessionId` is looked up in the
   * session store and never activated: no agent is created, no turn is queued,
   * and nothing reaches the model. An id that is not loaded (or does not exist)
   * is a clear error, never a silent drop. Writes to one session are serialized
   * through one FIFO, so concurrent callers cannot interleave the two events.
   *
   * @param session - live session, or the id of a loaded session.
   * @param items - the new tree (whole list for `model`; the origin's branch otherwise).
   * @param origin - who is writing, and therefore which entries the write owns.
   * @returns a promise that settles once both events are committed.
   */
  replace(session: Session | SessionId, items: readonly TodoItem[], origin: TodoOrigin): Promise<void>
  /**
   * Follow one session's list. The listener receives coalesced snapshots, not
   * one call per event, and is not invoked on registration.
   * @param session - session to follow.
   * @param listener - called after the list changes.
   * @returns idempotent unsubscribe.
   */
  subscribe(session: Session, listener: TodoChangeListener): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Todo data plane; present only while `omd-todo` is mounted. */
    todoList: TodoListService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole-list snapshot; latest write wins on replay. Log-only UI state. */
    'todo/write': { todos: FlatTodoItem[] }
  }
  interface PluginRecordMap {
    /** Narrative tree and origin of the `todo/write` immediately before it. */
    'plugin:omd-todo/detail': TodoDetailPayload
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    todos: FlatTodoItem[] | null
  }
  interface SessionProjectionMap {
    /**
     * The flat list the shipped todo panel renders. Same key, shape, and fold as
     * the upstream `tool-todo` package this plugin replaces, so the client needs
     * no change and an already-persisted projection row stays valid.
     *
     * Marked excluded from Session summaries for the same reason upstream marks
     * it: the projection registry refuses two registrations of one key that
     * disagree on `summary`, and the agent presets mount upstream `tool-todo`
     * alongside this plugin. Declaring `summary: false` at registration without
     * the mark here would leave the client view type advertising a key the
     * runtime omits from summaries.
     */
    todos: SessionProjectionSummaryExcluded<FlatTodoItem[]> | null
  }
}
