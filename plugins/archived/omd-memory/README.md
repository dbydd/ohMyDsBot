# omd-memory — the memory backend's contract

`omd-memory` is the Hindsight-backed memory backend for dsh. It owns
configuration, the HTTP client, and the durable retain queue. It registers no
model tool and injects no context; recall injection and the `memory://` resource
are later phases, and the interfaces they need already exist here.

## What is mounted

| Service / surface | Provided by | Purpose |
|---|---|---|
| `ctx.memory` | this package | `config`, `queue`, `watermarks`, `client`, `project()`, `bank()`, `pending()`, `retainTurn()`, `flush()`, `summary()`, `health()` |
| `omdMemoryTurn` projection | this package | The pending turn: `{ turn, throughSeq, entries[], truncated }` |
| `ctx.sessionProjections` | host | Drives the fold over committed events |
| `ctx.storageDomain` | host | Required: watermarks live in the `omd_memory` domain |

The fold lives here (`src/turn.ts`) because retain is this package's job and retain
is the only consumer that needs the pending turn today. The observation package
(`omd-memory-observe`) folds the same committed events for its own purposes under
its own keys; the two do not share a unit, and neither imports the other's
internals.

Delivery is wired through `ctx.inject(['timer'])`: the periodic flush and the
shutdown deadline both need that service, and a context that has no timer cannot
schedule them.

## Configuration

Thirty-three fields, each with per-field JSDoc in `src/config.ts`; 32 are
`volatile()` and therefore editable in the settings form, `queuePath` is not.
The package's defaults describe an *unconfigured* state: empty address, empty
bank ids, a generic credential name. Every machine-specific value belongs in
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: omd-memory
      name: <absolute path to this package's src/index.ts>
      config:
        baseUrl: http://127.0.0.1:PORT
        codingBank: my-coding-bank
```

**The Loader does not run the plugin's schema.** A row with no `config` block
delivers `undefined`, and a row that does carry one delivers the raw mapping —
unset volatile fields arrive as descriptor objects, not as defaults. `apply`
therefore resolves through `resolveConfig`, which treats `undefined` and any
non-array object as "not configured" and applies the default. Never read a
config field without that normalization.

`name:` must resolve to a file. A bare package name works when the profile's
own `node_modules` holds the package; a directory path does not, because the
Loader imports the name as an ES module and Node refuses directory imports.

### Per-project overrides

Eleven keys may be overridden per project (`PROJECT_OVERRIDABLE`): `codingBank`,
`userBank`, `scopeMode`, `autoRecall`, `recallEveryNTurns`, `recallBudget`,
`recallMaxTokens`, `mentalModels`, `includeSharedObservations`, `autoRetain`,
`retainToolResults`. The rest — address, credential reference, timeouts, queue
path — belong to the deployment.

"Which project" is anchored on `ctx.workingDirectory.get(session)` — the
session's effective directory, not the project in its header, which a `cd` may
have left behind.

## The queue

- One JSONL file, `dshHomePath('memory', 'retain-queue.jsonl')` unless
  `queuePath` says otherwise. Enqueue is one append under a directory lock.
- `.dead.jsonl` holds jobs that exhausted their retries; `.malformed.jsonl` holds
  raw lines that failed validation, with their source.
- The tail is coalesced: adjacent jobs for the same bank and document under both
  jobs' `append` semantics become one job. The middle of the queue is never
  reordered.
- A failed delivery records a redacted error and counts an attempt; after
  `RETAIN_MAX_RETRIES` the job moves to the dead-letter file. The pass itself
  never throws and never waits on a retry loop.
- The lock is a directory plus an owner record and a heartbeat. A lock whose
  owner is gone or whose heartbeat is older than 30 s is reclaimed.

## The watermark

The highest session seq already retained, per session, recovered from two
sources at startup:

1. the **queue**, whose jobs carry `{ sessionId, turn, throughSeq }` — this is
   what survives a crash between the append and the flush;
2. the **memory domain** (`omd_memory` / `watermarks`) — this is what survives a
   flush emptying the queue.

Whichever is higher wins, and `raise()` never lowers a value, so at-least-once
delivery is the worst case, never a reopened turn.

## Known trade-offs

- **At-least-once, not exactly-once.** A crash between "job appended" and
  "watermark written" re-sends that turn. Hindsight's append semantics make the
  duplicate an extension rather than an overwrite, and the dead-letter file makes
  the failure visible.
- **Recall is configuration without a reader yet.** `autoRecall`, `prefetch`,
  `recallBudget`, `recallTypes`, `recallTopK`, `recallContextTurns`,
  `recallMaxQueryChars`, `recallTimeoutMs`, `mentalModels` and
  `mentalModelsMaxChars` are resolved, documented and overridable, but the
  recall phase has not landed.
- **`@vectorize-io/hindsight-client` is a direct dependency**, not a peer: the
  host links only `@deepseek-ai/*` into `plugins/node_modules`, so the SDK must
  arrive with the package's own dependency tree.
