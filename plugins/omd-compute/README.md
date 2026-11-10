# omd-compute

Compute leases over the machines `omd-sandbox-vm` owns. A caller asks for a
machine with a deadline; this plugin decides whether that machine is started,
stopped or destroyed, and one Onlyne node is the control surface.

OrbStack has no extension API — `orbctl` is a CLI whose verbs are
`create/start/stop/delete/...` with no hook points — so a manager above it is a
process that holds a claim table and drives those verbs. That is what this is.

## Why a lease and not a machine

Three moments follow from "a machine is a claim with a deadline":

| Moment | Verb | What happens |
|---|---|---|
| a caller needs compute | `acquire` | the machine starts (or a stopped one resumes) and the claim records who asked, for what, until when |
| the deadline, idle window or lifetime ceiling passes | sweep | the machine is **stopped**, its owner gets an `expired` notice, and its disk, installed packages and workspace mount all survive |
| retention passes with no renewal | sweep | the machine is **destroyed** with its disk; a caller-named workspace is left alone |

The middle row is the point. Stopping costs no CPU and comes back with the same
guest, so an idling worker does not force a rebuild; only retention deletes
anything, and that is the single place a disk goes away.

## The lease belongs to one node

`acquire` records the message's authenticated author as `owner`. A second node
naming the same machine is refused (`forbidden`), and `renew`, `release` and
`destroy` require the same owner, by machine name or by `lease_id`. A `ttl_ms`
past the effective `max_ttl_ms` is refused with `capacity_exceeded` before a
machine is touched; no value is silently shortened. `renew` is its own verb:
it moves a running lease's deadline without starting the machine again, and the
ceiling bounds the whole claim from `createdAt`, not one window.

## What crosses Onlyne, and what does not

The control plane is Onlyne; the data plane is not.

- **Over Onlyne** (`delivery_kind: "compute"` to `urn:onlyne:agent:compute`):
  `acquire`, `renew`, `release`, `destroy`, `status`, plus the `expired` notice
  the sweep pushes. Each answers with a descriptor: `lease_id`, `name`, `owner`,
  `state`, `workspacePath`, timestamps and ttl in both `camelCase` and
  `snake_case`, `connection` (`exec_transport`, `endpoints`,
  `portal_urls.desktop`), `resolved_env` and `allocated`. No credential appears
  in it: the desktop portal is the machine's address, not a ticket.
- **Not over Onlyne**: running commands (`omd-sandbox-vm`'s `exec`) and watching
  or taking over a desktop (the human's ticketed noVNC route). Container traffic
  never enters the message bus.

A descriptor is therefore a *description of a resource*, not a way into it.

A request is read from two envelope layers: OECP v1 puts `operation`, `name`,
`lease_id`, `container`, `resources`, `network`, `provider_meta`, `lease` and
`purpose` on the message's `meta`; the older shape puts flat fields on
`meta.data`. Both are read, the top level winning. Answers carry the descriptor
under the delivered message's `meta.data`, which is where
`OnlyneClient.#prepare` puts `MsgInput.meta`.

## Surfaces

| Surface | What it is |
|---|---|
| `ctx.compute` | `acquire(spec, owner)`, `renew(ref, ttlMs, owner)`, `release(ref, owner)`, `destroy(ref, owner)`, `get(ref)`, `list()`, `sweep(now?)`, `load()` — `ref` is a machine name or a lease id |
| `compute://` | GET the table (or one lease) as JSON; POST `{ operation, name?, lease_id?, ttl_ms?, max_ttl_ms?, workspacePath?, purpose? }`. The owner is the calling session's node id, or an explicit `owner` |
| `urn:onlyne:agent:compute` | the same five operations as `compute` messages, answered in the requesting thread; the sweep also sends `expired` |
| `~/.dsh/data/omd-compute/leases.json` | the lease table, so a dsh restart does not orphan a running machine |

## Settings

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | mount the manager, its node and the `compute://` paths |
| `namePrefix` | `omd-compute-` | machine names this manager owns; anything else under `vm://` is left alone |
| `defaultTtlMs` | `21600000` (6 h) | default lease window |
| `maxTtlMs` | `86400000` (24 h) | hard ceiling on one lease's whole lifetime; a longer `ttl_ms` gets `capacity_exceeded` and starts nothing. A request's `lease.max_ttl_ms` can only lower it |
| `idleTimeoutMs` | `0` (off) | opt-in: how long a lease may go without an `acquire` or `renew` before the sweep stops it. A request's `lease.idle_timeout_ms` overrides it per lease |
| `retentionMs` | `86400000` (24 h) | how long a stopped machine keeps its disk after its claim ended |
| `sweepMs` | `300000` (5 min) | how often the sweep runs |
| `poolPath` | `~/.dsh/data/omd-compute/workspaces` | where a lease with no named workspace gets one |
| `ledgerPath` | `~/.dsh/data/omd-compute/leases.json` | the lease table |
| `nodeId` | `urn:onlyne:agent:compute` | the control node's identity |

## Model Experience

The manager adds no model-visible tool and no system-prompt section. A Bot meets
it the way it meets any peer: `msg` with `delivery_kind: "compute"` and
`meta.to: urn:onlyne:agent:compute`, then a `compute` answer arrives by itself.
The descriptor it carries is a few hundred bytes, so a session that never asks
for compute pays nothing.

## Relationship to `omd-sandbox-vm`

`omd-sandbox-vm` owns one machine's life (`provision`, `exec`, `stop`, `start`,
`dispose`, `openDesktop`, `captureFrame`, and its own idle sweep). `omd-compute`
owns the *claim* on machines and the deadline that drives those verbs. A machine
created by a worker through `omd-issue-runner` is leased here over Onlyne;
the manager records the worker's lease and enforces the claim deadline.

The idle sweep in `omd-sandbox-vm` (`idleTimeoutMs`, 12 h) is the backstop for
machines nobody leased — a worker's machine whose job state was lost to a
restart, for instance.

Idle reclamation is off by default because the manager sees a control-plane
touch, not guest CPU or IO: a renew is its only activity signal, so an idle
window configured shorter than a caller's heartbeat would stop leases nobody
abandoned. A deployment that turns it on must keep it above the heartbeat
interval.

## Known Limitations and Deferred Work

- No cross-process coordination: two dsh hosts sharing a `ledgerPath` would each
  believe they own the table. The lock the allocator uses would be the model.
- No quota: a caller can take as many leases as it asks for, bounded only by the
  host's memory and CPU. A per-owner ceiling is the obvious next field.
- The OECP v1 container spec is parsed but not applied: this driver provisions
  from `omd-sandbox-vm`'s configured image, maps no ports and injects no
  environment. `allocated` reports the machine's real CPUs and memory,
  `resolved_env` is empty, and `connection.endpoints` carries no mapped ports.
- The descriptor carries no cost figure. OrbStack reports disk usage but not CPU
  seconds, so a billing-shaped answer would be a guess.

## Checks

```sh
bun test src/manager.test.ts   # 24 cases: the manager's lifecycle plus OECP v1 envelope, receipts, ownership, capacity, expiry notices and compute:// identity
tsc --noEmit -p tsconfig.json  # src only; tests carry bun:test with no types here
```

Verified against OrbStack on this host: a lease provisioned `omd-compute-demo`,
`release` left it `stopped` with `/usr/bin/scrot` still installed, `acquire`
resumed that same machine (no second provision) and the package was still there,
`destroy` removed the machine, its workspace and its ledger row. The Onlyne path
was exercised separately: a `compute` message to `urn:onlyne:agent:compute`
provisioned `omd-compute-ctl` and the ledger recorded the asking session as owner.
