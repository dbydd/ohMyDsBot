/**
 * `omd-todo` — the todo list, with a reason and a goal on every entry.
 *
 * ## Why the tool stays named `todo_write`
 *
 * The shipped client keys four things on that literal name: the keyed todo
 * toolview (`client/ui-tool/.../todo-row.tsx`), the conversation-history entry
 * that renders `todo/write` (`todo-history.ts`), the plan-strip diff model
 * (`todo-diff-model.ts`), and the process-activity category
 * (`process-activity.ts`). Renaming the tool to something "friendlier" would
 * silently drop the todo row, the plan strip, and replay rendering. The
 * upstream description and payload are part of that contract too, which is why
 * `todo/write` still carries only `{ content, status }`.
 *
 * ## What this plugin adds
 *
 * - `explanation` and `goal` on every entry (`Config.requireDetail`), enforced
 *   at the tool and again at the storage boundary.
 * - A tree: `children`, three levels at most, 200 nodes at most.
 * - One lifecycle axis, `state`: `active` (working on it now), `inactive`
 *   (planned, not now), `completed`. A parked entry stays in the tree and
 *   stays readable; boards hide it by default.
 * - `source`, recording which issue produced an entry.
 * - `ctx.todoList`, a service that owns the two-event write, so a board or a
 *   file sync writes the same log sequence without impersonating the model.
 * - `dsh-resource://todo/<sessionId>[/<i>[.<j>[.<k>]]]`, a live path source.
 *
 * @module omd-todo
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ToolDefinition, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { field } from './fields.ts'
import { renderTodoSelection, renderTodoSnapshot, selectTodoNode } from './render.ts'
import { TodoListServiceImpl } from './service.ts'
import { MAX_DEPTH, TODO_STATES, countStates, parseTodoTree, todoTreeEcho } from './tree.ts'
import type { FlatTodoItem, TodoItem, TodoListService, TodoSnapshot } from './types.ts'

export type * from './types.ts'

/**
 * Public surface for other omd plugins: rebuild the tree the model writes from
 * a snapshot's two halves.
 *
 * `ctx.todoList.read` returns the state tree and the narrative tree as two
 * structurally aligned arrays. A kanban or a file mirror needs one tree
 * carrying both, and the two halves are only matched BY POSITION — a consumer
 * that re-pairs them by content will attach a goal to the wrong step as soon as
 * two siblings share a prefix.
 */
export { mergeTodoTree } from './tree.ts'

/** Plugin id the Loader entry carries. */
export const name = 'omd-todo'

/** The tool registry, the session store, and the projection registry this plugin registers into. */
export const inject = ['tools', 'sessions', 'sessionProjections']

/** Deployment settings. */
export interface Config {
  /** Allow more than one todo to be `active` at once. */
  allowParallelActive: boolean
  /**
   * Require a non-empty `explanation` and `goal` on every todo the model writes.
   * False keeps compatibility with callers used to the upstream two-field
   * shape; the fields stay in the schema, only their requiredness changes.
   */
  requireDetail: boolean
}

/** Schemastery configuration for the plugin entry. */
export const Config: z<Config> = z.object({
  allowParallelActive: z.boolean().required()
    .description('Allow several todos to be `active` at once (parallel work).'),
  requireDetail: z.boolean().default(true)
    .description('Reject a model write whose entries omit `explanation` or `goal`.'),
})

/** The model-facing tool name; see the module note before changing it. */
const TOOL_NAME = 'todo_write'

/** Projection key the shipped todo panel reads. */
const PROJECTION_KEY = 'todos'

/** Wire schema of the `todos` projection: the upstream flat list, or null before the first write. */
const flatItemSchema = zod.object({
  content: zod.string(),
  status: zod.union([zod.literal('pending'), zod.literal('in_progress'), zod.literal('completed')]),
})
const todosProjectionSchema: ZodType<FlatTodoItem[] | null> = zod.union([zod.array(flatItemSchema), zod.null()])

/**
 * Build the model-facing description.
 * @param config - deployment settings.
 * @returns the description for this activation.
 */
function describe(config: Config): string {
  const detail = config.requireDetail
    ? 'Every todo carries `explanation` (why this step exists and what it is connected to) and `goal` (what is true once it is done); a call missing either is rejected. '
    : 'Fill `explanation` and `goal` whenever you have them. '
  const parallel = config.allowParallelActive
    ? 'Keep the todos being worked on `active`, several only when the work actually runs in parallel. '
    : 'Keep exactly one todo `active`. '
  return 'Record and update a complete todo tree to plan multi-step work and show progress; skip it for trivial single-step tasks. '
    + 'Each call replaces the whole list. Add one todo per concrete step before you start. '
    + detail
    + '`state` is the only lifecycle field: `active` is the step you are working on now, '
    + '`inactive` is planned but not being worked on, `completed` is done. '
    + `Nest smaller steps under a larger one with \`children\` (at most ${MAX_DEPTH + 1} levels: root, child, grandchild). `
    + 'A todo marked `completed` must have every child `completed`. '
    + 'Mark a step `inactive` to park it without deleting it; parked entries stay in the tree and keep their place. '
    + parallel
    + 'Mark each todo `completed` as soon as it is done.'
}

/**
 * Parameter schema of one input node.
 * @param depth - 0 for a root.
 * @param requireDetail - whether the narrative fields are required.
 * @returns the node schema.
 */
function inputItemSchema(depth: number, requireDetail: boolean): ValueSchemaSpec {
  const properties: ParameterSchemaSpec = {
    content: { type: 'string', required: true, description: 'What the task is — a short imperative line.' },
    state: {
      type: 'string',
      required: true,
      enum: [...TODO_STATES],
      description: 'active (working on it now) | inactive (planned, not now) | completed (done).',
    },
    explanation: {
      type: 'string',
      ...(requireDetail ? { required: true as const } : {}),
      description: 'Why this step exists and what it is connected to — not a restatement of the title.',
    },
    goal: {
      type: 'string',
      ...(requireDetail ? { required: true as const } : {}),
      description: 'What is true once this step is done.',
    },
    source: {
      type: 'object',
      additionalProperties: false,
      description: 'Where this entry came from, when a tracker produced it.',
      properties: {
        kind: { type: 'string', required: true, enum: ['issue', 'manual'] },
        repo: { type: 'string', description: 'Repository, e.g. `owner/name`.' },
        number: { type: 'integer', description: 'Issue number.' },
      },
    },
  }
  properties.children = depth < MAX_DEPTH
    ? { type: 'array', description: 'Smaller steps owned by this one.', items: inputItemSchema(depth + 1, requireDetail) }
    : {
        type: 'json',
        description: `Do not nest further: ${MAX_DEPTH + 1} levels (root, child, grandchild) is the limit.`,
      }
  return { type: 'object', additionalProperties: false, properties }
}

/**
 * Output schema of one echoed node.
 * @param depth - 0 for a root.
 * @returns the node schema.
 */
function outputItemSchema(depth: number): ValueSchemaSpec {
  const properties: ParameterSchemaSpec = {
    content: { type: 'string', required: true },
    state: { type: 'string', required: true, enum: [...TODO_STATES] },
    source: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, enum: ['issue', 'manual'] },
        repo: { type: 'string' },
        number: { type: 'integer' },
      },
    },
  }
  if (depth < MAX_DEPTH) properties.children = { type: 'array', items: outputItemSchema(depth + 1) }
  return { type: 'object', additionalProperties: false, properties }
}

/** Canonical value every successful call returns. */
const OUTPUT_SCHEMA: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    todos: { type: 'array', required: true, items: outputItemSchema(0) },
    counts: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        active: { type: 'integer', required: true },
        inactive: { type: 'integer', required: true },
        completed: { type: 'integer', required: true },
      },
    },
  },
}

/**
 * Register the `todo_write` tool over the service.
 * @param ctx - plugin context.
 * @param config - deployment settings.
 * @param service - the write path.
 */
function registerTool(ctx: Context, config: Config, service: TodoListService): void {
  const policy = { requireDetail: config.requireDetail, allowParallelActive: config.allowParallelActive }
  const definition: ToolDefinition = defineTool({
    name: TOOL_NAME,
    description: describe(config),
    parameters: {
      todos: {
        type: 'array',
        required: true,
        description: 'The COMPLETE todo tree, replacing any previous list.',
        items: inputItemSchema(0, config.requireDetail),
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: summaryText(value) }],
    },
    async execute(args, exec) {
      const raw = args !== null && typeof args === 'object' ? field(args, 'todos') : undefined
      const items = parseTodoTree(raw, policy)
      const agent = exec.agent
      if (agent === undefined) {
        // The list is per-session state; a caller with no owning session has
        // nowhere to write it.
        throw new Error(`${TOOL_NAME} requires an owning agent session`)
      }
      await service.replace(agent.session, items, 'model')
      return { todos: todoTreeEcho(items), counts: countStates(items) }
    },
    presentCall: () => ({ card: 'generic', title: 'Update todo list', kind: 'other' }),
  })
  // The tool an agent actually resolves comes from its preset: `preset-standard`
  // mounts the upstream `tool-todo`, and a nearer scope's same-name entry
  // shadows the global layer. Registering the replacement into every agent's
  // own scope wins over that inherited row without restating the preset's
  // whole child list in the profile patch. The global registration stays for
  // non-agent callers and for a profile that does not mount the preset row.
  ctx.tools.register(definition)
  ctx.on('agent/created', ({ agent }) => {
    // `get` bypasses the inject check: this listener is not a plugin of the
    // agent's context, so property access there would throw.
    agent.ctx.get('tools')?.register(definition)
  })
}

/**
 * Summarize a returned value for the model-facing result text.
 * @param value - schema-validated canonical value, possibly from an older call.
 * @returns one line with the counts.
 */
function summaryText(value: unknown): string {
  const counts = value !== null && typeof value === 'object' ? field(value, 'counts') : undefined
  if (counts === null || typeof counts !== 'object') return 'Updated the todo list.'
  const count = (key: string): number => {
    const raw = field(counts, key)
    return typeof raw === 'number' ? raw : 0
  }
  return `Updated todo list: ${count('active')} active, ${count('inactive')} inactive, ${count('completed')} completed.`
}

/**
 * Register the `todos` projection with the upstream fold semantics.
 *
 * Every field has to agree with the upstream `tool-todo` registration, because
 * both register this one key and the registry refuses a second registration
 * whose `stateVersion` or `summary` differs. The agent presets mount upstream
 * `tool-todo` even when this plugin shadows its tool, so a disagreement here
 * fails session creation outright (`agent-preset/invalid`) rather than
 * degrading.
 * @param ctx - plugin context.
 */
function registerProjection(ctx: Context): void {
  ctx.sessionProjections.register<'todos', FlatTodoItem[] | null>({
    key: PROJECTION_KEY,
    stateSchema: todosProjectionSchema,
    init: () => null,
    apply: (state, event) => {
      if (event.type === 'todo/write') return event.data.todos.map(item => ({ content: item.content, status: item.status }))
      // Same retirement rule as upstream: a new turn starts a new checklist.
      if (event.type === 'turn/start') return null
      return state
    },
    wire: { viewSchema: todosProjectionSchema, view: state => state, summary: false },
    stateVersion: 2,
  })
}

/** Structural face of `omd-internal-paths`; that package is optional at run time. */
interface InternalPathRegistry {
  register(source: string, provider: {
    readonly grammar: string
    readonly shorthand?: boolean
    readonly live?: boolean
    read(path: string, exec: unknown): Promise<string | Uint8Array>
  }): () => void
}

/**
 * Register `dsh-resource://todo/…` when the internal-path registry is mounted.
 * @param ctx - plugin context.
 * @param service - read side used by the path.
 */
function registerPathSource(ctx: Context, service: TodoListService): void {
  ctx.inject(['internalPaths'], (scope) => {
    // `omd-internal-paths` is deliberately not a dependency: without it the
    // tool and the service still work, and this source simply never appears.
    const registry = scope.get('internalPaths') as InternalPathRegistry | undefined
    if (registry === undefined) return
    scope.effect(() => registry.register('todo', {
      grammar: 'dsh-resource://todo/<sessionId>[/<i>[.<j>[.<k>]]] — `current` names the calling session',
      description: 'Todo trees of sessions, addressed by session id and node path; `current` resolves to the calling session.',
      shorthand: false,
      live: true,
      read: (path, exec) => readTodoPath(ctx, service, path, exec),
    }), 'omd-todo: dsh-resource://todo')
  })
}

/**
 * Read one `todo` address.
 * @param ctx - plugin context, for the session store.
 * @param service - todo read side.
 * @param path - address remainder after `dsh-resource://todo/`.
 * @param exec - calling execution, which may carry the calling agent.
 * @returns markdown of the whole tree or the selected node.
 */
async function readTodoPath(ctx: Context, service: TodoListService, path: string, exec: unknown): Promise<string> {
  const address = `dsh-resource://todo/${path}`
  const trimmed = path.trim().replace(/^\/+/u, '')
  const slash = trimmed.indexOf('/')
  const head = slash === -1 ? trimmed : trimmed.slice(0, slash)
  const tail = slash === -1 ? '' : trimmed.slice(slash + 1)
  if (head === '') {
    throw new Error(`cannot read "${address}": name a session id or \`current\` — dsh-resource://todo/<sessionId>[/<i>[.<j>[.<k>]]]`)
  }
  const indices = indexPath(tail, address)
  const session = resolveSession(ctx, head, exec, address)
  const snapshot: TodoSnapshot | null = service.read(session)
  if (snapshot === null) return renderTodoSnapshot(`${session.id}`, null)
  if (indices.length === 0) return renderTodoSnapshot(`${session.id}`, snapshot)
  const selected = selectTodoNode(snapshot, indices, address)
  return renderTodoSelection(`${session.id}`, indices.join('.'), selected.item, selected.detail)
}

/**
 * Parse the 1-based index part of a todo address.
 * @param tail - text after the session segment.
 * @param address - the full address, quoted in errors.
 * @returns one index per level, outermost first; empty for the whole tree.
 */
function indexPath(tail: string, address: string): number[] {
  if (tail === '') return []
  const segments = tail.split('.')
  if (segments.length > MAX_DEPTH + 1) {
    throw new Error(`cannot read "${address}": an address names at most ${MAX_DEPTH + 1} levels (for example 1.2.3)`)
  }
  return segments.map(segment => {
    if (!/^[1-9]\d*$/u.test(segment)) {
      throw new Error(
        `cannot read "${address}": ${JSON.stringify(segment)} is not a 1-based item number — `
        + 'write <sessionId>, <sessionId>/1, <sessionId>/1.2, or <sessionId>/1.2.3',
      )
    }
    return Number(segment)
  })
}

/**
 * Resolve the session segment of a todo address.
 * @param ctx - plugin context.
 * @param head - session id, or `current`.
 * @param exec - calling execution, which may carry the calling agent.
 * @param address - the full address, quoted in errors.
 * @returns the live session.
 */
function resolveSession(ctx: Context, head: string, exec: unknown, address: string): Session {
  if (head !== 'current') {
    const session = ctx.sessions.get(SessionId(head))
    if (session !== undefined) return session
    throw new Error(`cannot read "${address}": no live session ${JSON.stringify(head)} — todo addresses read live sessions only`)
  }
  const hinted = hintedSession(exec)
  if (hinted !== undefined) return hinted
  const live = ctx.sessions.list()
  if (live.length === 1) return live[0]!
  const known = live.slice(0, 5).map(session => `${session.id}`).join(', ')
  throw new Error(
    live.length === 0
      ? `cannot read "${address}": no session is live, and \`current\` needs one`
      : `cannot read "${address}": ${live.length} sessions are live (${known}${live.length > 5 ? ', …' : ''}) — address one explicitly`,
  )
}

/**
 * Find the session behind the calling tool execution, when there is one.
 * @param exec - the execution handed to the path source.
 * @returns the session, or undefined for a non-agent caller.
 */
function hintedSession(exec: unknown): Session | undefined {
  if (exec === null || typeof exec !== 'object') return undefined
  const agent = field(exec, 'agent')
  if (agent === null || typeof agent !== 'object') return undefined
  const session = field(agent, 'session')
  return isSession(session) ? session : undefined
}

/**
 * Structural check for a live session object.
 * @param value - candidate value.
 * @returns whether it looks like a Session.
 */
function isSession(value: unknown): value is Session {
  return value !== null && typeof value === 'object' && 'id' in value && 'append' in value && 'header' in value
}

/**
 * Publish the service, the projection, the tool, and the path source.
 * @param ctx - plugin context.
 * @param config - deployment settings.
 */
export function apply(ctx: Context, config: Config): void {
  const service = new TodoListServiceImpl(ctx, {
    requireDetail: config.requireDetail,
    allowParallelActive: config.allowParallelActive,
  })
  ctx.provide('todoList', service)
  registerProjection(ctx)
  registerTool(ctx, config, service)
  registerPathSource(ctx, service)
}
