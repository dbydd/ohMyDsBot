# omd-internal-tools

The single judge-routed model entry for internal paths, plus the
`dsh-resource://tools/` catalog that keeps every other model-facing tool
reachable without being on the prompt surface. Host-only: no client half.

## What the model sees

One small surface, Config-owned:

- `resource` (name via `toolName`) — the single judge-routed entry:
  `{ intent, path?, content?, meta? }`. Content bytes never enter judge state.
- The `passthrough` baseline (`read`, `write`, `edit`, `bash` by default),
  which keeps its original schemas. `read` and `bash` pass through the
  `tools/execute` judgment waterfall without registering replacement tools.
  `write` and `edit` add internal-address dispatch in the agent scope.
  Exact inventory, schema, and description reads use the direct metadata path.

Every other model-facing tool name is:

1. filtered out of the assembled prompt by a per-agent
   `system-prompt/assemble` listener, and
2. denied on direct calls by a per-agent `tools.guard` whose message names the
   exact `dsh-resource://tools/<sessionId>/<tool>/invoke` route.

`ctx.internalTools.allowPassthrough(name)` lets a plugin declare its own
model-facing entry at load time instead of editing the profile list. The name is
added to the one live passthrough set that the guard, the assembled tool list and
the `dsh-resource://tools` catalog all read; the returned disposer removes only
the name this caller added. `isPassthrough(name)` reads the same set.

Boot logs one line: `passthrough [...], N model-facing tool name(s) hidden
behind the resource entry`.

## The judge contract (omp-hindsight authority)

- Every action goes through `ctx.judgment`; no host-side pre-short-circuit.
  The judge's `explicit` target answer is how a supplied `path` executes as
  written — but that decision still comes from the judge.
- Judge state: intent + optional path + meta + a pruned candidate catalog
  (described sources with grammar/capabilities, hidden tool names). Situation
  prose explains why the decision matters; never a bare label table.
- One call, four questions (hindsight tiers): `intent_cardinality`,
  `action_family`, `target_surface`, `specialization`.
- Confidence gate 0.35 (hindsight's value): below it the entry returns an
  `unresolved` receipt with a HINT-style next-call suggestion, never a guess.
- Cache: key = FNV-1a of (intent, path, meta, catalog-version); TTL
  `cacheTtlMs` (default 5 min). A catalog change (sources or hidden set)
  invalidates cached decisions.
- Fail closed: judge unavailable or erroring returns a structured
  `error` receipt; no heuristic routing.

## dsh-resource://tools/

| address | content |
|---|---|
| `dsh-resource://tools/<sessionId>` | described catalog for that live session |
| `.../<tool>/description.md` | purpose + capability statement (hidden tools say so) |
| `.../<tool>/schema.json` | the scoped schema from `tools.schemas(agent)` |
| `.../<tool>/invoke` | write JSON arguments → `ctx.tools.execute` with the calling agent |

- Reads without an agent require an explicitly named session; a browser
  listing never resolves global private data.
- A tool unavailable to the calling agent never appears and cannot be invoked.
- Invocation runs the ORIGINAL definition through the full guard pipeline
  (pre-execute, approvals, sandbox, post-execute) — no bypass.
- Recursion rejection: invoking `write`/`edit`/`note` with an internal
  resource address as target fails with an explanatory error.
- Session-scoped: a session cannot invoke another session's tools.

## Registry write support (omd-internal-paths)

`InternalSource` gains optional `description`, `write(path, content, exec)`,
and `edit(...)`; `InternalExec` gains `origin` (`model` | `human`) and
`sessionId`. The service exposes `write`, `edit` (falls back to
read + `performTextEdit` + write when the provider has no native edit;
single-match enforced unless `replace_all`), and `writeRemote(address,
content, sessionId?, origin?)`. The `dsh-resource://` root read returns the
described source roster; the root itself is read-only.

## Self-disable

Without a judgment service the plugin registers the `tools` source and the
write/edit bridges but registers no `resource` entry, installs no mask, no
guard — the full tool surface stays visible, with a warning.

## Mount row

```yaml
- insert:
    - id: omd-internal-tools
      name: omd-internal-tools
      config:
        toolName: resource
        passthrough: [read, write, edit, bash]
        confidenceGate: 0.35
        cacheTtlMs: 300000
```

Requires `omd-internal-paths` (and, for the resource entry, `omd-judgment` or
the `judge` role). Deps: none beyond the workspace peer set in
`package.json`; `@deepseek-ai/dsh-util-values` must be linked into
`plugins/node_modules` (see `plugins/link-host-runtime.mjs`).

## Registration ownership

`omd-read` owns the unified `read` definition. This plugin adds judgment through
the execution waterfall, so either plugin load order creates one agent-scoped
`read` registration. Every judgment listener and write/edit bridge follows its
owning fiber's disposal.
