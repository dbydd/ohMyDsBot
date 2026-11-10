# omd-todo

The todo tool, with a reason and a goal on every entry, nested steps, and an
addressable read path. It replaces the upstream `tool-todo` package in the
`omd` profile and keeps the shipped todo UI working unchanged.

## One lifecycle axis: `state`

Every entry carries exactly one state:

| state | meaning | mark in `dsh-resource://todo/…` |
|---|---|---|
| `active` | Being worked on now. At most one, unless `allowParallelActive`. | `[active]` |
| `inactive` | Planned, not being worked on now. Stays in the tree, stays readable. | `[ ]` |
| `completed` | Done. A `completed` parent needs every child `completed`. | `[x]` |

### Why one state instead of `status` + `active`

An earlier version had both: `status` (`pending` / `in_progress` / `completed`)
and a boolean `active` ("should this occupy attention"). That pair is two axes
for one question, and the six combinations it allows are mostly meaningless:

- `pending` + `active` and `in_progress` + `active` differ only in wording,
  while `pending` + `inactive` and `in_progress` + `inactive` contradict each
  other — "running but parked".
- `completed` + either flag has no distinct meaning; a finished entry is
  finished.
- Every consumer had to pick a field to trust. The panel hid on `active`, the
  counts read `status`, and validation read both, so the same list rendered
  differently depending on which surface you looked at.

Order already says what comes next, so `pending` versus `in_progress` was not
carrying information the list position did not carry. The three states say the
one thing the list cannot: what is being worked on, what is waiting, what is
done. Parking a step (`inactive`) is not deleting it and not completing it: an
inactive child still blocks its parent from becoming `completed`.

The state maps onto the upstream `todo/write` status one-to-one, so the flat
event and the domain tree never disagree:

| `state` | `todo/write` status |
|---|---|
| `active` | `in_progress` |
| `inactive` | `pending` |
| `completed` | `completed` |

## The tool is named `todo_write`

The name is a client contract, not a style choice. The shipped web client keys
four registrations on the literal string `todo_write`: the keyed todo toolview
(`client/ui-tool/.../todo-row.tsx`), the conversation-history entry that renders
`todo/write` (`todo-history.ts`), the plan-strip diff model
(`todo-diff-model.ts`), and the process-activity category
(`process-activity.ts`). Renaming the tool to a "friendlier" name silently
removes the todo row, the plan strip, and replay rendering. Do not unify it.

For the same reason the `todo/write` event payload stays exactly upstream:
`{ todos: [{ content, status }] }`, one entry per node, children indented two
spaces per level in preorder. The status there is the mapped state, so the tree
reconstructs from the event alone. Everything this plugin adds lives in its own
record.

## Data model

```ts
interface TodoItem {
  content: string                  // trimmed, unique among siblings
  state: 'active' | 'inactive' | 'completed'
  explanation?: string             // why this step exists, what it is connected to
  goal?: string                    // what is true when it is done
  source?: { kind: 'issue' | 'manual', repo?: string, number?: number }
  children?: TodoItem[]
}
```

Limits and rules, all enforced by `src/tree.ts` at the storage boundary:

- Three levels at most: root (0), child (1), grandchild (2). Deeper input is
  rejected with the reason (the tree is part of every request).
- 200 nodes at most across the whole tree, inactive entries included.
- `content` is trimmed and unique among its siblings. The same text under
  different parents is allowed.
- A `completed` node must have every child `completed`; the rejection names the
  failing child and its state.
- At most one `active` node across the whole tree, unless
  `Config.allowParallelActive` is true.
- `explanation` and `goal` are required for a model write when
  `Config.requireDetail` is true (the default). External writers may omit them.

## Two events, one write

Every write commits a pair, in this order:

1. `todo/write` — the upstream flat list (`content`, `status` only), indented by
   depth. The shipped panel and plan strip read this.
2. `plugin:omd-todo/detail` — `{ origin, items }`, where `items` is the narrative
   tree (content, explanation, goal, source, children). The state is not
   repeated there: the preceding `todo/write` already carries it. Readers that
   do not know this record retain and skip it.

The `todos` projection is registered with the upstream fold (last write wins,
cleared by `turn/start`) so the existing UI needs no change. It is a read-side
view only: the service reads the log, never the projection, because the
projection drops the list on a new turn.

## Service: `ctx.todoList`

```ts
interface TodoListService {
  read(session: Session): { items: TodoItem[]; details: TodoDetail[] } | null
  replace(session: Session | SessionId, items: readonly TodoItem[], origin: TodoOrigin): Promise<void>
  subscribe(session: Session, listener: (snapshot: TodoSnapshot | null) => void): () => void
}

type TodoOrigin = 'model' | 'user' | 'file' | 'issue'
```

- `read` folds the session log (details aligned with items by structure) and
  returns `null` before the first write.
- `replace` accepts a live `Session` or a `SessionId`. An id is resolved through
  the session store: no agent is activated, no turn is queued, and nothing
  becomes model-visible. A missing session throws with the distinction between
  "no such session" and "exists in storage but not loaded here".
- All writes to one session go through a single FIFO, so `todo/write` and its
  detail record can never interleave with another write's pair.
- `subscribe` coalesces a burst of events into one snapshot per microtask. It is
  for boards and file sync; it does not fire on registration.

### Whole-list replacement is the model's semantics, not the service's

`origin` decides the merge:

| origin | owns | effect |
|---|---|---|
| `model` | every root | Whole-list replacement. |
| `issue` | roots with `source.kind === 'issue'` | Replaces only issue roots, in the position of the first one; other branches are preserved. |
| `user` | roots with `source.kind === 'manual'` or no source | Same splice for hand-written roots. |
| `file` | same as `user` | Same splice for a file-synced tree. |

An external write that carries a root it does not own is rejected with the
offending index instead of having that root silently dropped. The merged result
is validated again, so a cross-branch duplicate or a broken parent/child
completion rule fails the whole write.

## Path: `dsh-resource://todo/…`

Registered into `ctx.internalPaths` when that service is mounted; the plugin
works without it. `live: true`, `shorthand: false`.

| address | content |
|---|---|
| `dsh-resource://todo/<sessionId>` | Whole tree as a nested markdown list. |
| `dsh-resource://todo/<sessionId>/1` | First root and its subtree. |
| `dsh-resource://todo/<sessionId>/1.2` | Its second child. |
| `dsh-resource://todo/<sessionId>/1.2.3` | Its third grandchild. |
| `dsh-resource://todo/current` | The calling agent's session (falls back to the only live session). |

A missing level, an out-of-range index, or a malformed index path is an error
naming what exists — never a silent whole-tree response. Only live sessions are
addressable.

Rendered outline of one tree:

```markdown
# Todo — session-7

4 item(s): 1 active, 2 inactive, 1 completed.

`[active]` being worked on · `[ ]` planned, not now · `[x]` completed

- [active] Ship the tri-state model — 目标：… — 前因后果：…
  - [x] Rewrite types
  - [ ] Update README
- [ ] Bench the board — 目标：…
```

## Configuration

```yaml
- insert:
    - id: omd-todo
      name: omd-todo
      config:
        allowParallelActive: true
        requireDetail: true
```

The plugin publishes `ctx.todoList`, the `todos` projection, and the path
source from the global layer, so this one row is the whole mount.

### Replacing a tool that an agent preset mounts

This is a reusable mechanism for any `omd-*` package that replaces an upstream
`tool-*` row; it applies to `omd-read` and the other tool replacements too.

**Symptom.** Upstream mounts its model-facing tools as children of an agent
preset (`preset-standard` in `packages/bundle/web-app/presets/standard.patch.yml`
has a `- id: tool-todo` child). Those rows mount in the preset's generation
scope, which becomes the *parent* of each agent's own scope. `ToolRuntime`
builds a scope's view from the farthest ancestor to the nearest, so a nearer
same-name registration shadows a farther one — a global registration is the
farthest of all.

**Consequence.** A profile patch `- id: tool-todo / disabled: true` targets the
top-level row only. That row is already disabled by the web bundle; the preset
child is untouched, and the model keeps getting the preset's tool. Dumping the
config looks as if the replacement landed, which is what makes this expensive
to notice.

**Mechanism.** Register the definition globally *and* into each agent's own
scope when the agent is created:

```ts
ctx.tools.register(definition)
ctx.on('agent/created', ({ agent }) => {
  // `get` bypasses the inject check: this listener is not a plugin of the
  // agent's context, so `agent.ctx.tools` would throw.
  agent.ctx.get('tools')?.register(definition)
})
```

The agent's own layer is nearer than the preset generation scope, so it wins.
The registration is owned by `agent.ctx`, so it unwinds when the agent is
disposed; nothing has to be tracked by hand. The same definition object is
safe to register into several scopes.

**Caveats.**

- A duplicate name in the *same* layer throws
  (`tool "todo_write" is already registered in this scope`). Different scopes
  are fine; two registrations for one agent are not.
- `agent.ctx.tools` property access throws without an `inject` declaration on
  that context; `agent.ctx.get('tools')` is the accessor that works.
- `agent/created` fires after the preset mounted, which is the order that makes
  the agent's own layer shadow it. The registration is live before the first
  prompt assembly.

Verified on dsh 0.2.1-rc.2 against the real `ToolRuntime`: with an
upstream-style `todo_write` in the preset-like parent scope and this plugin
applied, both `tools.get('todo_write')` and
`tools.get('todo_write', scopeOf(agent.ctx))` return this plugin's definition,
and the model-facing schema carries `content`, `state`, `explanation`, `goal`,
`source`, and `children`.
