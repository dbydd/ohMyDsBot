# omd-onlyne

Onlyne v3 messaging between the agents of one dsh process, and with peers
outside it. The protocol is `@onlyne/lib`'s: threads, grant notices, attention,
admission, reconciliation, the RFC 0017 key exchange.

One process speaks as one node identity (`urn:onlyne:agent:dsh` by default) and
holds one Ed25519 key. Every session and subagent binds to that node as a
context, so an address a peer learned once survives a restart, a new chat and a
burst of subagents. All nodes of the process share one loopback listener: a
request is routed by the identity its signature names, or by its
`/nodes/<encoded id>/onlyne/v3/...` path, so fifty sessions still open one port.
Co-hosted nodes skip the socket — the hybrid transport hands a signed request to
the sibling's handler directly — but the signature and the response check are
the same as on the wire. A peer this process does not host is reached through
the library's `FetchTransport` over a configured seed, discovery, or its trusted
row.

The store is durable: trust rows, grants, known threads, inbox rows and outbound
cursors live in SQLite under `<dsh home>/data/omd-onlyne/`, beside the identity
key, so a restart resumes the threads a peer already holds instead of answering
as a stranger.

## What it mounts

| surface | what it does |
|---|---|
| one node per process identity | `config.nodeId` (default `urn:onlyne:agent:dsh`), created by the first `agent/created` and shared by every session and subagent that follows |
| `msg` tool | `{ delivery_kind, msg, meta }`; `meta.to` sends, `meta.scope` reads. Registered globally and again in each agent's own scope, where the description carries that session's node id |
| inbound delivery | an admitted entry becomes one `user/message` in the target session, sourced `{ kind: 'onlyne', form: 'relay' }`, via `agent.steer` while it runs and `agent.followup` while it is idle |
| `onlyne://` paths | `onlyne://directory` (local, trusted and discovered peers, each with its source tier), `onlyne://neighbors`, `onlyne://threads`, `onlyne://threads/<alias>/messages`, `onlyne://inbox`, `onlyne://runner/workers`, `onlyne://runner/issue/<id>`, `onlyne://runner/issue/<id>/events`; reads are process-level, `shorthand: true`. An alias is `<threadId>` or `<owner>/<threadId>` |
| `/onlyne` command | node id, base URL, key fingerprint, hosted and joined thread counts, inbox size |
| `ctx.onlyne` | `createNode({ nodeId, runtime })` and `registry.list()`/`.find(id)`; how another plugin joins the same in-process registry without a session |
| `ctx.botRelay` | `relay({ fromSessionId, toSessionId, deliveryKind, header, source, text, steer })`: the seam a team host uses to carry a Bot-to-Bot message over a thread instead of delivering it locally |
| relay card (web) | `src/client/index.js`: a `conversation.chat.node` renderer for the `omdOnlyneMessage` kind, so a relayed message reads as a card instead of the empty `context` row a Bot's flow leaves |
| network tab (web) | `src/client/index.js`: a `网络` / `Network` tab (`order: 25`) in DS-Bot's Bot and group drawer — this session's node id, its declared address, its key fingerprint, and the live neighbor list, repainted every 5 s while open |

## Bot-team traffic on threads

A team host that already composes its own header and `source` object does not
have to give them up. `ctx.botRelay.relay` sends them as `meta.data.botTeam`;
the receiving node rebuilds exactly that header and that source on the message
it delivers, so the team's roles, exchange ids, reply links and audience read
the same as before — only the transport moved. Group turns and attachments stay
on the host's own path, because neither is a session-to-session message.

## The relay card

The client half is one Conversation Definition over `user/message` events whose
`source.kind` is `onlyne`. It builds the `omdOnlyneMessage` node from the logged
event alone and the card shows the sender's node tail, the thread alias, the
delivery kind, and the peer's own text. Nothing is fetched and nothing is
stored: the session log is the whole input, so the card is identical after a
reload and in a replayed history window. `source` carries `kind`, `form`,
`sender`, `thread` and `seq`; the delivery kind exists only in the header line
the host writes in front of the body, so the client reads it back from there.

Every session binds the process's node, subagent sessions included; the node
retires only when its last bound session ends. Two sessions of one process
address each other by naming the receiving session in the plan's `context`.

## The network tab

`window.dshBot.registerDetailsTab` from the same client half mounts one drawer
tab at `order: 25`, beside the built-in Details and Browser tabs and the other
omd tabs. The registration follows the host's own queue handshake — applied at
once when `window.dshBot` is already there, pushed onto `window.dshBotQueue`
otherwise — and the disposer that `ctx.effect` returns unregisters exactly that
tab, so a reload or a disabled plugin leaves no button behind.

The tab reads two addresses through `/api/paths?uri=…&session=<sessionId>`, the
same route the other omd clients use: `onlyne://directory` for the node's own
row and the three peer tiers, and `onlyne://neighbors` for the trust-table
peers. A session that hosts no node still reads the process records. A failed
neighbor read is shown above the rows instead of being swallowed: the directory
rows remain visible, but the panel says which read failed and why. Identity and
address are read from whichever spelling the answer uses (`nodeId`/`node_id`,
`baseUrl`/`base_url`), a missing key fingerprint reads as "not published"
instead of being guessed, each peer carries its source badge (`local` /
`trusted` / `discovered`), and the connection dot reports what the read actually
did: green when the directory answered, red with the source's wording when it
refused, grey while the first read is still in flight.

## The service: a participant that is not a session

`ctx.onlyne` is what a plugin takes when it has to be addressable but owns no
session — `omd-issue-runner` is the first such participant:

```ts
const node = ctx.onlyne.createNode({ nodeId: 'urn:onlyne:agent:issue-runner', runtime })
ctx.onlyne.registry.list()   // every node this process hosts
ctx.onlyne.registry.find(id) // one of them, by identity
```

`createNode` is `createBotNode` with this plugin's configured region and listener
settings: the same storage, the same hybrid transport, the same endpoint
registry, so a session's address reaches the new node exactly as it reaches
another session and the directory answer lists it. It returns a promise because
the listener binds before the node exists. The caller owns the node and must
`dispose()` it. `registry` exposes identity and base URL only — the request
handler stays inside this package.

The service is provided by `apply`, so a profile with `enabled: false` has no
`onlyne` service and a participant relying on it simply never activates.

## The issue runner's catalog

`omd-issue-runner` owns its jobs; this package only serves them, because a
reader of an address should not have to hold another plugin's service:

```ts
globalThis.__onlyneRunnerCatalog = {
  workers: () => WorkerRecord[],                    // onlyne://runner/workers, /issue/<id>
  readEvents: (worker) => Promise<{ kind: 'feed', value: WorkerEvents }
                               | { kind: 'missing', reason: string }>,  // /issue/<id>/events
}
```

That global is process-wide and untyped here — the two packages do not depend
on each other — so it is read structurally: a runner too old to publish the
feed, one that publishes the bare worker list, or one that publishes it behind
a function all still list workers, and the feed path refuses with the runner's
own wording rather than inventing one.

`onlyne://runner/issue/<id>/events` answers that worker's run, summarized:

```jsonc
{
  "worker": "onlyne://runner/issue/3f2a1b9c",
  "state": "running",            // queued | running | idle | failed | closed | approved
  "events": [
    { "at": 1793951714937, "kind": "user", "role": "user", "text": "…",
      "tool": null, "args": null, "result": null },
    { "at": 1793951719498, "kind": "tool", "role": "assistant", "text": null,
      "tool": "bash", "args": "{\"command\":\"ls\"}", "result": null },
    { "at": 1793951720323, "kind": "result", "role": null, "text": null,
      "tool": "bash", "args": null, "result": "parser.ts" }
  ],
  "truncated": false
}
```

`kind` is `text`, `reasoning`, `tool`, `result` or `user`; a payload over 2000
characters, or a log over 300 rows, is cut and sets `truncated` — the worker
package documents the bounds beside the reader that applies them. `role` is
`assistant`, `user`, or `null` for a tool result.

A run the provider stopped has no message of its own in the log, so its failure
arrives as one `result` row with `tool: null` and the provider's text — the same
cause the worker's `failed` answer carries as `diagnostic:`, readable here
without opening the stored log.

`note` is present only when the feed is empty for a healthy reason, and it is
status, not failure: an accepted worker still provisioning its machine answers
`{ "events": [], "truncated": false, "note": "the coding-agent session has not
started yet" }`, and rows appear at the same address once the coding agent has
a session. A UI renders it as a neutral line above the timeline; the request
itself succeeded.

The worker rows this package passes through carry two fields a watcher reads
beside the feed. `session` is the coding-agent session the current or latest
run is in — the id `/events` resolves — and is absent until a backend has
minted one. `reclaimAt` is the epoch millisecond at which the worker reclaims
itself, present only while a countdown runs: the runner's `settleReclaimMs`
(12 h by default) starts it when a run settles, a `review` or a `close`
cancels it, `0` turns it off so the field never appears, and a worker whose
change set was too large to inline in its answer never gets one at all.

An unknown worker and a session whose log this host cannot read are refusals,
never an empty feed: an unreadable run must not look like a run that did
nothing. A run that has not started yet is the documented `note` feed above.
Refusals travel as an error from the source — over HTTP that is `{ "error": "<the
runner's reason>" }` with the transport's status, and through the Remote
namespace it is a failed read. A reader should key on the body, not on a
specific status code, because the status belongs to the transport
(`omd-internal-http` maps a source's refusal to 502 and reserves 404 for an
address no source owns).

## Configuration

| field | default | meaning |
|---|---|---|
| `enabled` | `true` | mount the nodes, the tool, the paths and the command |
| `region` | `urn:onlyne:region:local` | region label a node advertises in its directory answer; a place, not an endpoint |
| `threadPageSize` | `50` | page size for `onlyne://` listings and the `/onlyne` counts |
| `host` | `127.0.0.1` | listener host; loopback only, since the bind is not a security boundary |
| `port` | `0` | listener port for every node of the process; `0` asks the OS once and remembers the port under the dsh data root, so an address survives a restart |
| `nodeId` | `urn:onlyne:agent:dsh` | the stable identity every session of this process speaks as. Never derive it from a session id |
| `seeds` | `[]` | peers this deployment can dial before any handshake: `{ nodeId, baseUrl, label?, fingerprint? }`. A seed's `baseUrl` answers a first message, and its `fingerprint` pins the key |

```yaml
- insert:
    - id: omd-onlyne
      name: omd-onlyne
      config:
        threadPageSize: 50
        nodeId: urn:onlyne:agent:dsh
        seeds:
          - nodeId: urn:onlyne:agent:peer
            baseUrl: https://peer.example/onlyne/v3
```

## Loading `@onlyne/lib`

`@onlyne/lib` `^3.2.0` is the published package. `3.2.0`'s `main` and
`exports["."]` both point at `./dist/index.js`. **The host loads that file
as-is**; no loader hook, no transpilation and no rewritten copy is involved.

A plugin installed by `link:` resolves its own bare imports from its real path,
which never reaches `$DSH_HOME/profiles/node_modules`. `plugins/node_modules`
holds those links, and this repository fills it:

```sh
node plugins/link-host-runtime.mjs
```

The script links the DSH host runtime and the in-tree siblings these packages
import by name (`omd-internal-paths`, `omd-sandbox-vm`, `omd-onlyne`,
`omd-compute`, `omd-issue-runner`), and installs `@onlyne/lib@^3.2.0` from npm
(`plugins/npm-packages`) into that directory. Set `ONLYNE_ROOT` to a local
Onlyne checkout to use `<ONLYNE_ROOT>/packages/lib` instead of the npm package.
Then install and mount the plugin:

```sh
dsh plugin --profile <profile> add ./plugins/omd-onlyne
```

and append the patch row above to the profile's `cordis.patch.yml`.

## Who consumes the threads

Nothing in `memory-transport.ts` or `node.ts` assumes the consumer. A node is
built from storage, a transport, a decision and a `Runtime`; the runtime is the
only thing that knows what a message becomes. This plugin's runtime turns an
entry into a session `user/message`. A coding-agent backend is another module
that builds nodes with the same factory and its own runtime — it needs no edit
here, because the address registry, the transport and the host the nodes live in
carry no opinion about who reads them.

## Mounting next to `omd-internal-tools`

That plugin hides every tool outside its `passthrough` list behind the single
`resource` entry. This plugin declares `msg` itself through
`ctx.internalTools.allowPassthrough('msg')` when that service is present, so the
tool stays on the assembled surface and the `dsh-resource://tools` catalog marks
it `direct`. No profile edit is needed; the declaration is disposed with the
plugin.

## Not in this slice

- **No judge.** `decide` is deterministic: `meta.scope` reads, `meta.to` sends,
  and anything else fails with `invalid_request`. Ambiguous intent is refused,
  not guessed. Routing through a judge is the next slice.


## Checks

- `tsc --noEmit -p tsconfig.json` — clean for this package's `src/`; the
  diagnostics that remain belong to `omd-internal-paths`. `src/**/*.test.ts` is
  excluded because `@types/bun` is not part of this program.
- `bun test src/` — nineteen facts across `network.test.ts` and
  `issues.test.ts`: two nodes on separate registries pair through `/keys` and
  `/introductions` over loopback and deliver a signed message; an unsigned
  request to `/trust` answers `401 unauthenticated`; the persisted key file
  derives its own public key; two nodes sharing a registry deliver without a
  socket after the host pairs them; an `await` plan is refused as
  `unsupported_delivery` with nothing stored; an HTTP inbound entry reaches the
  agent in single-digit milliseconds; fifty nodes share one port with zero
  startup handshakes; a restart keeps the address, the trust row and the thread;
  a configured seed lets this node send first; and the `onlyne://` reads fall
  back to the process node, merge the three directory tiers, list a trusted
  cross-process neighbor, refuse an anonymous POST and serve the runner catalog:
  the workers list, one worker by its address, one worker's summarized session
  feed through the catalog's `readEvents`, and a worker the catalog does not
  know refused with the catalog's own reason instead of an empty feed.
- A real dsh session on a temporary profile: `msg` appeared in the session's
  `request/header` tool table (26 tools, `msg` among them, description carrying
  that session's node id), the model's `msg` call was admitted with a receipt,
  and the message came back as a `user/message` sourced
  `{ kind: 'onlyne', form: 'relay' }`.
- The same profile plus `omd-internal-paths` and `omd-read`: `read
  onlyne://inbox`, `read onlyne://threads` and `read
  onlyne://threads/<alias>/messages` all returned this node's records, the last
  one through the `<owner>/<id>` alias form.
