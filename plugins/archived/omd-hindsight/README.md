---
kind: reference
---

> **Shelved 2026-10-21 — not mounted in any profile.** Its bank model came from
> the omp deployment, and the auto-recall path costs context every turn. Memory
> will be redesigned from scratch; this file stays as a record of what was tried
> and of the Hindsight server contract (banks, recall budgets, prefetch), not as
> something to install. `dsh plugin --profile omd add …` on it again only if you
> are deliberately reviving this version.

# omd-hindsight

Hindsight memory for DeepSeek Harness, with the bank model the omp/pi
deployments converged on: **one shared bank every session reads, plus one bank
per project** written by that project's sessions.

The dsh plugin ecosystem's `dsh-plugin-hindsight-advanced` is single-bank (one
`bank` per mount). This package exists because that partition is the wrong
shape for a daily driver: preferences and cross-project facts belong in a
shared bank that every session sees, while project decisions belong to the
project and must not surface in unrelated work.

## Install

```bash
dsh plugin --profile <profile> add /abs/path/to/plugins/context/omd-hindsight
```

The package carries its own bundle patch, so the entry inserts itself — no
manual profile row. It replaces a `dsh-plugin-hindsight-advanced` row; run one
or the other, never both (two plugins reciting memory into the same turns
double the context cost).

## Configuration

One `omd-hindsight` row in your profile patch. The `config` block **replaces**
the plugin's defaults wholesale — list every key you want to keep.

| key | default | what it does |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8888` | The Hindsight server. |
| `apiKeyRef` | `HINDSIGHT_API_KEY` | A **name** for the secret, never the secret. Resolved per call: environment → `~/.dsh/.credentials.yaml` → `.env`. Empty disables the auth header. |
| `globalBank` | `pi-global` | The shared bank. Defaults to the bank the omp deployment already writes, so dsh sessions join the same global memory on day one. |
| `scoping` | `project` | `project` = per-project write bank + merged recall. `global` = one bank for everything (the omp setting; use it to mirror omp exactly). |
| `projectBankPrefix` | `dsh-project` | Prefix for derived project bank ids. |
| `projectBankMap` | `{}` | Adopt an existing bank for a project: key is the project's absolute path or its lowercased directory name, value the bank id. |
| `recallGlobalBudget` | `1024` | Token budget for the global leg of a merged recall; the project leg gets `maxRecallTokens`. |
| `autoContext` | `true` | The per-turn automatic recall. |
| `prefetch` | `true` | Start the next turn's lookup at `agent/turn-stopping`, so the turn rarely waits. |
| `recallContextTurns` | `5` | Recent human turns composed under `Prior context:` in the recall query. |
| `maxRecallTokens` | `4096` | Token budget for the project leg. |
| `autoContextTimeoutMs` | `2500` | Bound on one automatic recall; a stopped server never blocks a turn. |
| `retainAsync` | `false` | `false` waits for the bank's extraction, so the next turn already sees the memory. |
| `preCompaction` | `true` | Recall again at `compaction/start` and inject the result, which lands outside the compacted span. |
| `mentalModels` | `true` | Render the project bank's mental models as a system-prompt section. |
| `mentalModelRefreshSec` | `300` | Seconds between mental-model refreshes. |
| `globalMission` / `projectMission` | (omp's texts) | Mission installed on each bank at first use. |
| `projectBankPrefix`, `apiKeyRef` | see above | — |

Bank ids derive from the session's working directory:
`<prefix>-<dirname>-<sha256(absPath)[0:16] as base36>`. The directory is
**not** resolved to a git root — an older scheme did that and fragmented
memories when a `.git` appeared or vanished above the cwd (omp #2412).

## Model Experience

- **Per turn (automatic)**: one plugin-sourced user-role message appended
  immediately after the triggering message, carrying the recalled memories
  (with their bank and id) and the banks' standing directives. An unchanged
  recall commits a one-line marker instead of repeating the block; an empty
  recall commits nothing. Budget-bounded by `maxRecallTokens` +
  `recallGlobalBudget`.
- **System prompt (per agent)**: one section, `omd-hindsight:mental-models`,
  holding the project bank's mental models inside `<mental_models>` wrappers,
  capped at 6000 characters.
- **Tools**: `memory_recall` (search), `memory_retain` (store), `memory_reflect`
  (synthesized answer). Their schemas and descriptions ship in every request's
  tool list, as any registered tool's do.
- **Prefetch**: none of the above costs a bank round-trip on a steady-state
  turn beyond the detached job that runs while the user is not waiting.

## Known Limitations and Deferred Work

- **No tier tags.** The reference plugin partitions one bank with tags
  (global/preset/session); this package partitions with banks and applies no
  tag filter, so everything in a bank is visible to it. The tag machinery is
  the thing to add if per-session memory ever matters.
- **No action lessons, no mid-step (text/reasoning) recall, no
  `recallPreserve: false` tombstone mode.** Those are opt-in features of the
  reference plugin; this one ships the append-only snapshot and the
  intervention path.
- **No automatic retain.** Nothing writes memory except the `memory_retain`
  tool, matching the omp deployment's `autoRetain: false`.
- **Bank hash compatibility.** An existing bank whose id was derived by another
  client's hashing (pi's `pi-project-<slug>-<hash>` banks) is adopted through
  `projectBankMap`, not by reproducing that hash.
- **Mental models must already exist.** The package renders models the bank
  has; it does not seed them.
- **Requires a working embedding model server-side.** Recall and retain are
  embedding-backed; the plugin degrades to "no memory" (never a failed turn)
  when the server cannot embed.