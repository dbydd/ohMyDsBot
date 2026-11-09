---
kind: reference
---

# omd-memory-observe

The transcript the memory backend reads: a `memoryObservation` session
projection that folds a session log into turns, plus the cleaned segments a
retain job consumes.

dsh forbids synchronous session-history reads — `Session.eventAt`,
`snapshotEvents`, and `ownEvents` are deprecated with new calls prohibited —
and gives plugins no cursor event to write. This package is the sanctioned
substitute: the framework drives the fold over committed events, and consumers
read the result instead of the log.

Nothing here is model-visible: no tool, no prompt section, no injection, no
token or KV-cache effect.

## Install

```yaml
- insert:
    - id: omd-memory-observe
      name: omd-memory-observe
```

The package carries no bundle patch; the profile row above is the mount. Its
consumer (`omd-memory`) reads the service, so a profile that mounts the
consumer without this row fails at the first read with
`the memoryObservation projection is not registered`.

## Configuration

One `omd-memory-observe` row in the profile patch. The `config` block replaces
the defaults wholesale — list every key you want to keep.

| key | default | what it does |
| --- | --- | --- |
| `turnWindow` | `4` | Committed turns kept for recent-context reads. `0` is treated as `1`. |
| `maxChars` | `20000` | Characters kept in the open turn; beyond it the **oldest** segments are dropped and the turn is marked `truncated`. |
| `maxSegmentChars` | `4000` | Characters kept in one segment. Clamped to `maxChars`. |

These bound the projection state, which the projection cache persists — they
are not retain-content limits. A retain job's own ceiling is the consumer's
business.

## The read model

`ctx.memoryObservation` is the only surface:

| member | returns |
| --- | --- |
| `pending(session)` | the open turn `{ turn, startSeq, segments, truncated }`, or `null` |
| `turns(session)` | committed turns inside the window, oldest first |
| `latest(session)` | the most recently committed turn, or `null` |
| `throughSeq(session)` | seq of the last committed `turn/end`; `-1` before the first |
| `subscribe(listener)` | calls `listener(turn, session)` once per commit, in log order; returns the disposer |

Every reader except the subscription's own delivery throws when the projection
is absent from the calling context, so a misconfigured profile fails where it
reads rather than enqueueing blank memories.

## What the fold promises

- **Deterministic.** The fold reads only six event types and no clock, no
  random source, no session API. The same events with the same bounds produce a
  deeply equal state; that is what makes checkpointing and mid-log resume safe.
- **Turn-scoped.** `turn/start` opens a turn and discards the previous pending
  segments; `turn/end` commits it and advances `throughSeq` whatever the end
  reason. A message outside an open turn is dropped — a turn is the unit both a
  retain job and an injection cursor speak in.
- **Filtered by type, not by inspection.** `src/sources.ts` defines the
  retained source vocabulary (`user`, `model`, `tool`) and the type-level
  exclusion of any source carrying a context `form`. A producer that adds a new
  message kind — a recall injection's `memory` kind, for instance — is excluded
  by construction, and the one runtime guard only narrows.
- **Structurally cleaned.** Text survives; a tool call becomes
  `[action name target]` with the target drawn from the call's argument JSON; an
  image or file becomes a one-word marker; reasoning and developer-plane blocks
  do not survive. A segment with no text is not stored.
- **Turn-bounded.** At most `turnWindow` committed turns and `maxChars` in the
  open one, so a long session cannot grow the projection state without bound.

## Known limitations and deferred work

- No recall injection, no model tool, no `memory://` resource, and no
  per-project overrides live here. They belong to the consumer; this package
  only states what was said.
- Segments ignore surface operations. A compaction that replaces surface nodes
  does not rewrite or remove earlier segments: memory is what was said, not what
  the current request happens to show.
- The fold does not classify turns as worth retaining. A turn with no user
  message, or one that only read files, still commits; the consumer's policy
  decides what becomes a memory.
- A crash between "turn committed" and "job enqueued" loses that turn unless the
  consumer recovers from its own watermark (`throughSeq` is the floor it should
  compare against).
