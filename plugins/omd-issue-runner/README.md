# omd-issue-runner

The bot is the organizer, not the coding agent. A session's tools are
conversation-sized; real work leaves the session as an **issue** and comes back
as a **PR**. This package is the host half of that exchange: an Onlyne
participant with no session of its own that receives an issue, runs a full dsh
coding agent in an isolated checkout, and answers in the same thread.

## Where the line runs

Two mechanisms, deliberately separate:

| layer | package | what it owns |
|---|---|---|
| messages | `omd-onlyne` | one node per session, the in-process transport, the `msg` tool, inbound delivery into a session log |
| starting a coding agent | this package | the runner node, the job queue, the isolated checkout, the delegated run, the `pr`/`failed` answer |

The runner does not reimplement messaging: it asks `ctx.onlyne.createNode` for a
node on the same in-process registry the sessions' nodes are in, so one address
space, one protocol, no port. It does not reimplement isolation either: the tree
comes from `ctx.worktreeAlloc`, and the agent is an ordinary dsh agent created
in that tree.

## What it mounts

| surface | what it does |
|---|---|
| runner node | `urn:onlyne:agent:issue-runner` by default; addresses `delivery_kind: "issue"`, `"review"` and `"close"` |
| `ctx.issueRunner` | `submit(issueInput)`, `list()`, `cancel(jobId)`, `close(jobId)` — the surface a UI or a test drives |
| `ctx.onlyne` | unrelated to this package's behaviour, but the reason it has no `msg` tool of its own |

A session files an issue with the ordinary Onlyne tool:

```jsonc
{ "delivery_kind": "issue",
  "msg": "Add a --json flag to the status command and cover it with a test.",
  "meta": { "to": "urn:onlyne:agent:issue-runner" } }
```

When the filing session works in a directory that is not a Git checkout (a Bot
team's workspace, for instance), the issue names the project itself:
`meta.checkout` is an absolute path and takes precedence over the session's
working directory. `worktreeAlloc` validates it; a bad path answers `failed`
instead of falling back to a guessed checkout. A prompt section registered by
this plugin teaches the filing form, the runner's node id and the no-polling
rule to every session in the profile.

## Job lifecycle

```
issue entry
   │  (queue: at most maxConcurrent jobs run; the rest wait, nothing is refused)
   ▼
provision ──► worktreeAlloc.allocate(branchPrefix + jobId, HEAD, meta.checkout ?? session directory)
   │            branch kept; the checkout is the agent's alone. Under the "vm"
   │            backend the machine is a lease asked for over Onlyne (see below)
   ▼
launch ─────► ctx.agents.create({ meta: { cwd: worktree } })
   │            a fresh dsh agent whose session IS the checkout, prompted with
   │            issuePrompt rendered from the issue, the thread and the branch
   ▼
collect ────► allocator.collect → git diff --binary text, changed files, git log
   │            then the judge reads the run: refused answers `failed`, otherwise
   │            `pr` with the verdict it reached (or the reason it has none)
   ▼
pr / failed answer in the same thread
```

A **`review`** entry on a thread that already has a job appends a note to that
job. If the agent is running, the note is picked up by the current run's loop as
soon as it finishes; if the job is idle, it is queued again. Either way the next
run happens in the **same checkout**, with a fresh agent whose prompt carries the
issue plus every note so far — a new agent cannot read the thread, so the notes
travel in the prompt.

A **finished job keeps its worktree**: the change set is still there to be read,
and the answer names the path. `cancel` (or plugin unload) releases it with
`force`, because a cancelled answer is not going to be reviewed. Trees left by
earlier runs are still swept by the allocator's own `idleTtl`.

## One unit of work is one worker

`meta.work` is the protocol's work identity, and the runner uses it as the job's
idempotency key:

```jsonc
{ "delivery_kind": "issue",
  "msg": "Add a --json flag to the status command and cover it with a test.",
  "meta": { "to": "urn:onlyne:agent:issue-runner",
            "work": { "unit": "ISSUE-42" } } }
```

A second `issue` with the same `unit` and `attempt` — from any thread — allocates
nothing: it answers `note` naming the worker that already holds the unit, and
that thread joins the worker's readers, so the later `pr` / `failed` / `closed`
answers arrive there too. A new `attempt` is a new job. `ctx.issueRunner.submit`
applies the same rule and returns the existing view instead of queueing a twin.
An older caller may name the unit in `meta.data.workUnit` or `meta.data.issueId`;
both are read as the unit.

The worker's address is `onlyne://runner/issue/<workerId>`, where `workerId` is
generated for the job — never sliced out of the machine name. Under the `vm`
backend the machine is named after the worker for an operator's convenience,
but routing reads the address: a provider that renames machines changes nothing
a caller uses. `ctx.issueRunner.workers()` lists every live worker with its
`worker`, `workerId`, `jobId`, `machine`, `thread`, `state`, `startedAt`,
`updatedAt` and the `workUnit` / `work` / `leaseId` / `desktopUrl` it holds,
plus two fields the later sections explain: `session` (the coding agent's own
session, absent until a backend has minted one) and `reclaimAt` (when the
worker reclaims itself, absent while it runs or when that is switched off).
`omd-onlyne` serves the same catalog as `onlyne://runner/workers`, one worker as
`onlyne://runner/issue/<workerId>`, and that worker's run as
`onlyne://runner/issue/<workerId>/events`, through
`globalThis.__onlyneRunnerCatalog` — published as
`{ workers: () => WorkerRecord[], readEvents: (worker) => Promise<…> }`, so a UI
does not scrape chat text for the address.

## Watching a run

A worker's coding agent is an ordinary dsh session, and that session's log is
what the run actually did. `onlyne://runner/issue/<workerId>/events` serves it,
summarized:

```jsonc
{
  "worker": "onlyne://runner/issue/3f2a1b9c",
  "state": "running",            // the worker's state: queued, running, idle, failed, closed, approved
  "events": [
    { "at": 1793951714937, "kind": "user", "role": "user", "text": "…", "tool": null, "args": null, "result": null },
    { "at": 1793951719497, "kind": "reasoning", "role": "assistant", "text": "…", "tool": null, "args": null, "result": null },
    { "at": 1793951719498, "kind": "tool", "role": "assistant", "text": null, "tool": "bash", "args": "{\"command\":\"ls\"}", "result": null },
    { "at": 1793951720323, "kind": "result", "role": null, "text": null, "tool": "bash", "args": null, "result": "parser.ts" }
  ],
  "truncated": false
}
```

`at` is epoch milliseconds, and a row is one message block, one tool call or
one tool result — `kind` says which, and `role` is `assistant`, `user` or
`null` for a tool result. A tool call is taken from the `tool/call` record and
paired with its `tool/result` by call id, so a result row names the tool that
produced it without listing the call twice.

A run the provider stopped leaves no message of its own, so its `turn/end`
failure becomes one `result` row with `tool: null` and the provider's text —
`"MISSING_CREDENTIAL: llm-pi-ai: no credential for provider route \"magpie\"…"`
— which is how the cause reaches a reader instead of a bare `stop: error`:

```jsonc
{ "at": 1794143055015, "kind": "result", "role": null, "text": null,
  "tool": null, "args": null,
  "result": "MISSING_CREDENTIAL: llm-pi-ai: no credential for provider route \"magpie\"…" }
```

That row is the same failure the `failed` answer carries as `diagnostic:`.

Two bounds keep one HTTP body from carrying a whole run's raw output: a single
payload longer than `EVENT_FIELD_MAX_CHARS` (2000) is cut with a marker, and a
log longer than `EVENT_LIST_MAX` (300) rows keeps its most recent rows. Either
cut sets `truncated: true`, so a reader never mistakes a shortened feed for a
short run.

The log is read from two places in order: the live agent, while the run is in
this process, and `ctx.sessionPersistence` once the agent is gone. A worker that
is unknown to this process, or whose session has a log this host cannot read,
is a refusal with the reason in it, never an empty feed: an unreadable run must
not look like a run that did nothing.

One case is deliberately not a refusal. An accepted worker spends its first
seconds provisioning its machine, and a watcher opens the feed exactly then, so
the answer is a **feed with no rows and a `note`**:

```jsonc
{ "worker": "onlyne://runner/issue/3f2a1b9c", "state": "running", "events": [],
  "truncated": false, "note": "the coding-agent session has not started yet" }
```

`note` is a status line about the feed, not an error: a UI renders it as a
neutral line above the timeline, and the same address starts answering rows as
soon as the coding agent has a session.

## The machine is a lease

The data plane and the control plane are separate, and the `vm` backend keeps
them that way. Commands and the desktop go straight to `omd-sandbox-vm`
(`exec`, `SandboxBash`, `vm://`); a machine's *life* does not. `provision` sends
one OECP v1 `compute` message to `urn:onlyne:agent:compute`:

```jsonc
{
  "delivery_kind": "compute",
  "msg": "acquire workspace machine",
  "meta": {
    "to": "urn:onlyne:agent:compute",
    "operation": "acquire",
    "name": "omd-sandbox-issue-<workerId>",
    "workspacePath": "/…/worktrees/issue/<jobId>",
    "container": { "image": "debian:12" },
    "lease": { "ttl_ms": 21600000 },
    "work": { "unit": "ISSUE-42" },
    "purpose": "issue-<jobId>"
  }
}
```

`workspacePath` travels beside the OECP v1 groups as the transitional alias the
manager still reads. The answer is a v1 descriptor — `lease_id`, `name`,
`state`, `workspacePath`, `expires_at`, `connection` (whose
`portal_urls.desktop` is the ticketed desktop the run is watched through),
`resolved_env` and `allocated` — and the ask resolves on it: `running` means the
machine is up and the run may start, anything else fails the job with the state
the manager named. The desktop in the receipt wins over the provider's own
`vm.inspect` address. `dispose` sends `destroy` with the same `lease_id`, so a
close removes the machine through the table that owns it, not by name alone.
The node runtime routes the answer: a `compute-result` entry (JSON body, the
shape `@onlyne/compute-gateway` posts) is settled against the ask waiting for
it and never becomes a job. An older `compute` reply whose descriptor sits in
`meta.data` still settles.

The lease is kept alive: while a job holds one, a heartbeat sends `renew` with
the `lease_id` and `ttl_ms` every half of the shorter window — `ttl / 2`, or half
the receipt's `idle_timeout_ms` when that is smaller (the window is
`computeTtlMs`, 6 h by default). It stops in `dispose` and on every path that
reclaims the job, so a close never renews what it destroyed. One renewal is in
flight at a time, two refused renewals stop the heartbeat and are logged, and
the manager's sweep then decides the machine's fate.

Two consequences are worth knowing:

- **Expiry is the manager's.** A job whose lease lapsed is stopped under it; the
  machine keeps its disk and `acquire` resumes it. The heartbeat is what keeps a
  long job from reaching that point.
- **No manager is an error for the vm backend.** The lease is the Onlyne
  message. If `urn:onlyne:agent:compute` does not answer, the job fails and
  this process does not call `orbctl`. A host without a driver should run the
  `dsh-agent` backend, or point `computeNodeId` at a node that has one.
  `computeTimeoutMs` bounds the wait.

## Closing a worker

A finished job keeps its checkout and, under the `vm` backend, its machine: the
change set is there to be read and the desktop is there to be opened. Deciding
what happens to it is a review decision, so the runner does not guess — the
caller says when it is done with that worker:

```jsonc
{ "delivery_kind": "close",
  "msg": "",
  "meta": { "worker": "onlyne://runner/issue/479f55fb" } }
```

`meta.worker` is the address the `pr` answer carried. It is what decides the
target, because a Bot usually closes from a different thread than the one the
job answered in; a close with no worker falls back to the thread, and one that
matches nothing answers `failed` listing the workers still holding a checkout.

A `review` resolves the same way, from the strongest identity it carries: the
worker address (`meta.worker`), `meta.data.workerId` or `meta.data.jobId`, the
work unit in `meta.work`, an `in_reply_to` of one of the job's answers, then the
thread. A reviewer posting in a new thread therefore still lands on the job
instead of being told no job is waiting. A review carrying `meta.verdict`:

- `"approve"` reclaims the worker and answers `closed` with `state: "approved"`
  — the change set was applied or dropped, so neither remains;
- `"reject"` (or no verdict) adds the note and runs the agent again in the
  **same** checkout.

A rejection therefore never starts a second worker and never provisions a
second machine: `acceptReview` pushes the note onto the job that already holds
the thread and enqueues that job (`jobs.ts`, `acceptReview`), and `runJob`
provisions only while `job.provisioned` is undefined (`jobs.ts`, `runJob`).
`bun test src/close.test.ts -t "a rejecting review"` holds it down — one
`provision`, two `launch` — and the same file's next fact covers a review that
names the worker after the provider renamed its machine.

Closing does three things, in this order: it aborts the run if one is going and
waits for that turn to unwind, it hands the checkout back with `force`, and it
destroys the machine through the backend. The order is not cosmetic — the
machine is what the agent is executing in, and a checkout deleted under a live
mount is the debris the ordering avoids. The thread gets one short line and a
card:

```jsonc
{ "job": "479f55fb", "worker": "onlyne://runner/issue/479f55fb",
  "machine": "omd-sandbox-issue-479f55fb", "worktree": "/…/clones/issue/479f55fb",
  "reclaimed": true }
```

Both the release and the answer are idempotent: a second close answers `closed`
again and releases nothing a second time, so a client that retries after a lost
reply does not fail. `ctx.issueRunner.close` is the same path without a thread.

### Nobody remembers to close one

A worker that settled is on a clock, because the step people skip is the one
that costs a machine. Settlement is a `pr` answer, a `failed` answer, or a run
the judge read as a refusal; from there `settleReclaimMs` (12 h by default)
runs, and when it expires the worker takes exactly the path a `close` takes —
the run is stopped, the checkout handed back and the machine destroyed, in that
order — and the thread gets the same `closed` answer. `reclaimAt` on the worker
record is when that fires, so a UI can count down instead of guessing.

Anything that means "still in use" cancels the countdown: a `review` (including
`reject`, which starts another run in the same checkout) and an explicit
`close` or `approve` both drop it, and a run that settles again starts a new
window. `settleReclaimMs: 0` turns the whole thing off and leaves every worker
to its caller — the behavior before the window existed.

**The automatic path never discards work that has no other copy.** The checkout
is a copy-on-write directory that `dispose` deletes, the `branch:` in the `pr`
answer is a name inside it and not a Git branch anyone can fetch, and the patch
travels inline only up to `maxPatchBytes`. So a worker whose last change set was
larger than that gets **no countdown at all** (`reclaimAt` stays absent): its
review would otherwise arrive after the only copy of the work was deleted. It
still goes when a caller says so — `close`, or an `approve` that means the
change set was landed elsewhere.

What dies with the machine is the guest's whole filesystem — packages the agent
installed, browser profiles, anything written outside the mounted workspace.
What survives on the host is only what was written into the checkout, and that
goes too unless something copied it out first. A workflow that wants a change
set, an artifact or a log keeps it in the workspace or reads it back before
closing.

## Backends

`src/backend.ts` is the extension point:

```ts
interface CodingAgentBackend {
  provision(job): Promise<{ worktreePath, branch }>
  launch(job, provisioned): Promise<{ summary, stopReason, diagnostic? }>
  collect(job): Promise<{ patch, patchBytes, changedFiles, log }>
  dispose(job): Promise<void>
}
```

`src/backends/dsh-agent.ts` is the MVP and the cheap end: a git worktree plus one
dsh agent whose own session is rooted in it. A containerized development
environment — `layerfs` plus a self-built OrbStack plugin, say — is **one more
file implementing this interface**: `provision` starts the container and returns
its mount point, `launch` runs the agent inside it, `collect` reads the diff out,
`dispose` destroys it. Nothing in `jobs.ts` or `index.ts` changes.

The agent is created through `ctx.agents.create({ meta: { cwd: checkout } })`, and
its owning agent is the live session that filed the issue
(`urn:onlyne:agent:<sessionId>` → `ctx.agents.get`), falling back to the first
live root agent.

### Why not `ctx.subagents`

A subagent child cannot write in a checkout outside its parent's directory.
`SubagentStartRequest.cwd` reaches only the child's *working directory*
(`manager.resolveDirectory` → `workingDirectory.set`, which appends a
`working-directory/change` event); the child session's immutable header keeps the
parent's cwd (`childSessionMeta`: `cwd: parentHeader.cwd`); and the sandbox takes
exactly that header as its `workspace-write` boundary
(`SandboxPolicyService.resolve`: `session?.header.cwd ?? this.workspaceRoot`). A
job's checkout is never inside the Bot session's workspace, so a subagent child
of that session would have every write denied with
`[sandbox: file access denied under workspace-write mode]`.

Creating the session itself with `meta.cwd` set to the checkout makes the policy
resolve to the checkout by construction. `launch` then checks what the session
reports and refuses the run with both paths named if it is ever anything else.

## Reading the result

One stop reason is settled before any of this: `stopReason: "error"` — the
provider refused the request, the transport died, no report exists — answers
`failed` with the provider's own `diagnostic:` line, and the judge is never
asked. Judicial reading cannot turn an execution failure into a change set ready
for review, and an empty report is not a refusal anyone decided. That is the
case a missing credential produces, and it used to be reported as `pr`.

A clean turn end is not the same as finished work: an agent whose writes were
denied, or one that found the wrong directory, still stops `completed`. With
`ctx.judgment` mounted, the answer is judged first — one choice question over the
issue text and the agent's own report:

| label | answer |
|---|---|
| `accomplished` | `pr`, with `verdict: judged accomplished` |
| `partial` | `pr`, with `verdict: judged partial` — the report says what is left |
| `refused` | `failed`, carrying the agent's own words as the reason |

The instructions say plainly that a report of inability — no access, could not
write, hands the work back — is a refusal, however politely it is worded. Without
a judge, with `judgeResults: false`, below `confidenceFloor`, or when the call
fails, the answer keeps the run's own stop reason and says
`verdict: not judged — <why>`; an unchecked result must not look checked.

## Configuration

| field | default | meaning |
|---|---|---|
| `enabled` | `true` | Mount the runner node and answer issues. |
| `runnerNodeId` | `urn:onlyne:agent:issue-runner` | Node id a session addresses to file an issue. |
| `maxConcurrent` | `2` | Coding agents allowed to run at once; the rest queue. |
| `branchPrefix` | `issue/` | Branch prefix; the job id follows it. |
| `issuePrompt` | see `DEFAULT_ISSUE_PROMPT` | Prompt template; `{{issue}}`, `{{thread}}`, `{{branch}}` are substituted. |
| `maxPatchBytes` | `1048576` | Largest patch still inlined in the `pr` answer. A bigger change set is not inlined: the answer says the patch is omitted and names the branch it is on. |
| `backend` | `dsh-agent` | `dsh-agent` runs commands on the host in a copy-on-write directory; `vm` runs them in an isolated machine whose life is a compute lease. |
| `computeNodeId` | `urn:onlyne:agent:compute` | Node id the `vm` backend leases machines from. An unknown node means no manager is reachable and the machine is started directly. |
| `computeImage` | `debian:12` | Image a leased machine runs, as OECP v1's `container.image`. |
| `computeTtlMs` | `21600000` | Lease window asked for, in milliseconds; the heartbeat renews at half of it. |
| `computeTimeoutMs` | `180000` | How long one lease ask waits for the manager's answer. Creating a machine from scratch takes about a minute. |
| `settleReclaimMs` | `43200000` (12 h) | How long a settled worker is kept before it reclaims itself: the run is stopped, the checkout released and the machine destroyed. A `review` or a `close` within the window cancels it. A worker whose change set was larger than `maxPatchBytes` is never reclaimed automatically — the checkout is the only copy of it. `0` never reclaims automatically at all. |
| `judgeResults` | `true` | Judge a finished run before reporting it. Off reports the agent's own stop reason, marked unjudged. |
| `confidenceFloor` | `0.5` | Lowest judgement confidence that changes the answer. |

```yaml
- insert:
    - id: omd-issue-runner
      name: omd-issue-runner
      config:
        maxConcurrent: 2
        branchPrefix: issue/
        backend: vm
```

`inject: ['onlyne']` — without `omd-onlyne` there is no address to answer, so the
plugin waits instead of half-activating. `worktreeAlloc`, `agents` and `judgment`
are read per call: a missing allocator or registry fails the job with a reason
(not the boot), and a missing judge only means the result is reported unjudged.

## Known limits

- **A judge, not a test.** `judgeResults` reads the agent's report; it does not
  run the project's tests, so an agent that claims success wrongly still passes.
- **No container.** The checkout is a git worktree on this machine, sharing the
  host's toolchain and credentials.
- **No apply step.** The patch is reported, never replayed onto the main
  checkout: landing it is a review decision, and `worktreeAlloc.apply` exists for
  whoever makes it.
- **Needs model credentials.** The agent is an ordinary dsh agent, so the profile's
  LLM provider has to work; without it `launch` fails and the answer is `failed`
  with that reason.
- **A fresh agent per run.** Follow-ups keep the checkout, not the conversation.
- **No observable child in the agent tree.** The agent is a runtime child of the
  filing session rather than a cataloged subagent, so it shows as its own session
  and carries no `subagent/descriptor`.
- **In-memory jobs.** A restart forgets the job list; the worktrees remain until
  the allocator sweeps them.
- **The feed is reachable through the job.** A worker's events are served from
  the job record, which a restart drops, so `/events` answers for the life of
  the process that created the worker. The session log itself is durable (it is
  what `ctx.sessionPersistence` reads), so an index of worker → session that
  outlives the process would be the way to read an older run.
- **A closed worker is gone.** Its log stays readable, its address stops
  resolving once the process forgets the job, and the checkout and machine are
  already destroyed — read the change set before the window closes.
- **A lease is not a machine.** `dispose` asks the manager to destroy the
  machine; a manager that refuses or does not answer leaves the machine to
  `omd-sandbox-vm`'s own idle sweep, which is also what cleans a machine whose
  job state was lost. The two never fight because each only touches its own
  names.

## Checks

- `tsc --noEmit -p tsconfig.json` — clean for `src/`. The package needs
  `@types/node` (`types: ["node"]`) because it runs `git log` and reads
  `process.cwd()`; this tree has no install step for plugin packages, so the
  types sit in the package's ignored `node_modules`. Without them, `tsc` reports
  the `node:*` modules as missing.
- `bun test src/close.test.ts` — closing, with a backend that records releases
  instead of moving files: one release per worker, the `closed` reply and its
  card, a second close that answers again and releases nothing, an unknown id
  that answers `false`, a close entry that names a worker from another thread,
  one that names nothing live, and a running job stopped before the release.
  Then identity: a second `issue` of one work unit joins the running worker and
  only one machine is provisioned, a different `attempt` is a new job, an
  approving review from another thread — by work unit or by worker address —
  approves the job and releases it, a rejecting one runs the same checkout
  again, a review that names nothing lists the live workers, and the catalog
  names a worker whose machine was renamed under it.
  Then the retain window and the feed: a settled worker reclaims itself and
  answers `closed`, `reclaimAt` is on the record before it does, and a review
  inside the window drops the countdown, while a change set larger than
  `maxPatchBytes` arms no countdown at all and still goes on an explicit close;
  and a worker reports its `session`, the log
  summarizes into `user` / `reasoning` / `tool` / `result` rows with the tool
  name paired to its result, an unknown worker and a session with no log each
  answer a reason instead of an empty feed, and a worker whose agent has not
  started yet answers an empty feed with a `note` — then the real feed once the
  session exists, including the session a review run minted rather than the one
  that finished. Last, the provider failure: a `stop: error` answers `failed`
  with its diagnostic and is never judged (a mounted judge that would have said
  `accomplished` is proved unused), a change set behind a non-error stop still
  carries its diagnostic, and a recorded failure becomes one `result` row.
  The file is excluded from the `tsc` project because `bun:test` has no types
  installed here; `bun test` transpiles it, it is not type checked.
- `bun test src/compute.test.ts` — the lease path. With a control plane that
  records calls: `provision` asks the manager and starts nothing itself,
  `dispose` destroys through the manager and releases the checkout, a manager
  that answers `absent` fails the job and does not call `vm.provision`, and a
  failed acquire releases the checkout without starting a machine. Then the
  protocol itself: two real Onlyne nodes on one registry, where the manager's
  `compute-result` settles the runner's ask and the acquire/destroy asks arrive
  with the operation, name, workspace and purpose the manager reads. A v1
  receipt is read for `lease_id`, `connection.portal_urls.desktop`,
  `resolved_env` and `allocated`; `renew` names the lease; the heartbeat renews
  at half the window, stops on request and after two refusals, and a job's
  heartbeat stops with its `dispose`.
- `src/backends/dsh-agent.ts` needs a live profile to exercise end to end: the
  probes in the slice report cover the allocator, the `meta.cwd` the agent is
  created with, the workspace mismatch refusal, and the judged/unjudged answer
  without a model.
- `src/backends/vm-agent.ts` disposal was exercised against a real
  `omd-sandbox-scratch-*` machine: `provision` created it, `apt-get install
  scrot` and a marker file landed in the guest, `dispose` destroyed the machine
  and the host checkout in one call, `orbctl list` no longer showed it, and
  re-provisioning the same name came back without `scrot` or the marker. The
  demo machine `omd-sandbox-issue-479f55fb` was untouched.
