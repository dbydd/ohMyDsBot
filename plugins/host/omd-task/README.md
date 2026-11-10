# omd-task

Batch delegation tool for dsh, providing omp-style parallel subagent dispatch.

## Features

- **Batch dispatch**: Dispatches concurrent subagents via `ctx.subagents` (`spawn` or other registered providers).
- **Agent catalog routing**: Resolves agent names against `ctx.agentCatalog` (`omd-agents`), applying instructions, model/tier routing, and thinking levels.
- **Dedicated notebook sections**: When `notebook: true` (or a string title) is specified, allocates a dedicated subsection of the parent session's working-memory notebook under `# Agent notes` (`dsh-resource://notebook/<parentSessionId>/sections/<childId>.md`). Write permissions are code-enforced to that assigned subsection only.
- **Independent isolation**: `isolated: true` provisions a git worktree via `omd-worktree-alloc`. Specifying `notebook` does NOT allocate a worktree unless `isolated: true` is explicitly requested.
- **Structured results and envelopes**: Collects child outputs into standard `<task-result>` envelopes with duration, status, and isolation outcome.

## Tool Interface

- `context` (string, required): Shared background and interfaces for the entire batch.
- `tasks` (array of objects, required):
  - `name` (string, optional): CamelCase label for the subagent.
  - `agent` (string, required): Catalog agent name (`engineer`, `labor`, `philosopher`, `theorist`, etc.).
  - `task` (string, required): Self-contained task instructions.
  - `isolated` (boolean, optional): Run in dedicated git worktree checkout.
  - `notebook` (boolean | string, optional): Allocate a private section of parent's notebook. `true` uses task label; string specifies custom section title.
  - `tools` (array of strings, optional): Advisory tool allowlist.
  - `outputSchema` (json, optional): JSON Schema for structured output validation.
