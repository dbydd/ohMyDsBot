# omd-visual

One package, two halves. The host half decides, spawns, and records; the client
half projects the record into a chat row. It lets an answer carry a rendered
component **without the answering agent ever holding a UI tool**.

```
turn ends ──► explicit request in the human message
            ──► spawn a child (provider: spawn, no agentPreset, delivery: caller)
                    one user message: question + answer + contract + rules
            ──► child replies with ONE fenced block (no tool calls)
            ──► plugin:omd/visual record on the parent session
            ──► client: dshUiFences node (renderer present) + source card
```

## Why the fence, and why the contract is ours

The delivery is text, not a tool call, and this is what keeps the parent's
request prefix intact:

- `spawn` without `agentPreset` joins the parent's current generation, so the
  child receives the parent's system prompt and tool array byte for byte
  (`docs/subsystems/subagent.md`).
- No `outputSchema`: it would add a child-only tool and change the tool array.
- `delivery: 'caller'`: the settlement is not injected into the parent's history.
- The contract travels as the child's single user message — after the prefix, so
  it cannot affect cache reuse for the parent's own turns.

Because the UI plugin is mounted on the host (browser bundles are discovered
from host Loader entries only), its fifteen tools would otherwise be visible to
every agent. With `maskHostTools` on, the host half masks them per agent through
`agent.ctx.get('tools').restrict({ deny })` — naming only tools that actually
exist, because `restrict` rejects unknown names — and shadows its three prompt
sections (`generative-ui:design-skill`, `:protocol`, `:worked-examples`) with
empty text in the same scope. Masking schemas without silencing the guidance
leaves the model looking for tools that are not there.

`maskHostTools: false` skips both halves: the answering agent keeps the UI tools
and their guidance, and draws directly instead of delegating. Use it on a
profile whose agent should own the picture; the delegation path still runs when
the user asks for one.

`contract.md` is written by this package rather than imported from the host
plugin. Upstream's exported contracts all speak in tool calls — `NATIVE_CONTRACT`
opens with `render_ui({document:…})`, `CANVAS_CONTRACT` is written against the
`DSHUI.` API, and `DELIVERY_CONTRACT` is documentId-oriented — so any of them
would push the child toward tools it has been denied. Component names, field
names, and fence syntax still come from upstream; only the modality is rewritten
as a fence. The hard condition on the file is:

```sh
rg -n 'render_|inspect_|ui_catalog|DSHUI\.' plugins/workbench/omd-visual/contract.md   # no matches
```

`mode: 'explicit'` (the default) has one trigger: `agent/turn-stopping` checks
whether the newest human message asks for a picture (`precheck.ts`,
negation-aware), and only then writes a `pending` record that the settlement
replaces. There is no manual command — asking for a picture is already the
human's decision, so a command would only make them say it twice.

The spawn is fire-and-forget: the answer is already settled, and a turn must not
wait for a worker.

## Record: `plugin:omd/visual`

`ignorable`, written through the one writer in `record.ts` (the only file that
calls `appendPluginRecord`, so an upstream change is a one-file review):

```ts
{
  sessionId, targetSeq, turn, step, component: 'visual',
  status: 'pending' | 'ready' | 'failed' | 'timeout' | 'skipped',
  decidedBy: { role: 'user' },
  reason?: string,
  props: { address, fence?, title?, fallback?, childSessionId?, childMode? },
  at
}
```

`targetSeq` is the log sequence of the assistant message being decorated. The
newest record for one `targetSeq` supersedes the earlier ones when the client
folds the log, so `pending` becomes `ready` (or `failed`/`timeout`/`skipped`) in
place. `pending` is written only for a human-triggered attempt: an automatic
attempt that ends in `NO_VISUAL` must leave no trace, and a pending card that
then never resolved would be exactly that trace.

The record never enters the model surface: the parent's next request carries no
fence text, and the child's output is not replayed anywhere.

## Address: `dsh-resource://visual/<sessionId>/<targetSeq>`

Registered into `ctx.internalPaths` when that service is mounted; the plugin
works without it. `live: false`, `shorthand: false`. The reader returns the
record's status, turn/step, who asked, child session, title/fallback, and the
raw fence, so the component can be copied out long after the row scrolled away.
Only live sessions are addressable: a record is a fact about a session this
process holds, and a cold reader would be a second source of truth.

## Client half

`src/client/index.js` is plain JavaScript because the web shell stitches the
`./client` bytes into `__ModuleLoader__.load({ factory })` with no TypeScript
build step.

Two `ConversationNodeDefinition`s fold the same records:

1. `omdVisualInline` → node kind `dshUiFences`, the shape the host UI plugin's
   own renderer consumes (`{ turn, blocks: [{ step, index, text }], settled,
   everUi }`). It builds a node **only** while
   `ctx.slots.entriesOfSlot('conversation.chat.node')` contains an entry whose
   `options.key === 'dshUiFences'`.
2. `omdVisualSource` → node kind `omdVisualCard`. Always builds: a collapsed
   `<details>` with the fence verbatim for `ready`, a status card (reason,
   fallback, address, "open worker session") otherwise.

Both use `anchorSeq = targetSeq` and `groupTree: 'turn'`, and the inline
Definition is registered first, so within a turn the component stands above its
source card and neither is folded into the process disclosure.

Degradation is the point of the second node:

| Situation | Result |
|---|---|
| renderer registered, render succeeds | component + collapsed source card |
| renderer missing (plugin unmounted, profile without it) | `omdVisualInline` builds no node; the source card remains |
| renderer present but throws while rendering | the slot retires that entry (`entriesOfSlot` drops it), so no further inline nodes; the source card remains |
| renderer's node-data shape drifted upstream | at worst the component does not draw; the fence is still readable and copyable in the source card |

## Configuration

```yaml
- id: omd-visual
  name: omd-visual
  config:
    mode: explicit        # explicit | off
    maskHostTools: true   # false leaves the UI tools with the answering agent
    maxQuestionChars: 4000
    maxMaterialChars: 12000
    timeoutMs: 120000
```

`mode: off` registers no trigger and no mask; the address reader stays
registered so records written earlier remain readable. `maskHostTools: false`
leaves the host UI tools and their guidance in place, so the answering agent
draws directly; the delegated worker then inherits those same tools and draws
from the fence contract instead.

The host UI plugin has an `autoRepair` switch that feeds rejected fences back to
the model. It is **not** this plugin's default to set: the correct value belongs
to the profile's own row for that plugin, written by whoever deploys the pair,
because a plugin default would silently change behaviour for every profile that
mounts us. Nothing here depends on it either way — a fence we deliver is a
record, not an assistant message, so that repair loop has no message to repair.

## Deferred: judge-gated automatic triggering

`mode: 'auto'` is not implemented yet, and the reason is a dependency rather
than a decision. It needs the shared judge-context package
(`plugins/judgment/omd-judge-context/`), which will export
`buildJudgeContext({ session, budget, purpose })` and return the ordered material
(task description, todo tree, last user message, the latest three assistant
messages, then as much tool-call history as the remaining budget allows). The
visual call site will be:

```ts
const material = buildJudgeContext({ session: agent.session, budget: 4000, purpose: 'visual' })
const result = await ctx.judgment.judge({
  state: material,
  questions: {
    decision: { type: 'choice', instructions: '…', criteria: { visual: '…', none: '…' } },
  },
})
```

with `decision.choice === 'visual'` and `decision.confidence >= 0.75` as the
gate. `ctx.judgment` returns a label, its distribution, and a confidence — no
free-text rationale — so the record's `reason` will carry the distribution, not
an invented sentence.

Until then, an explicit request in a human message is the only trigger. There is
no manual command: the visualization has exactly one entry point.

## Model Experience

- **The parent's model surface does not change** with `maskHostTools` on: no tool
  is added, the fifteen host UI tools are removed for every agent, and their
  guidance sections render empty. Parent requests are cache-stable across
  mounted/unmounted worker runs. With the switch off the fifteen tools and their
  guidance stay in the parent's request, which is the point of the setting.
- **The child's prefix equals the parent's.** Same generation, same system
  prompt, same tool array; only its single user message differs. The verification
  is byte equality of `request/header.header.tools` and `system/message` between
  the parent turn and the child's first request.
- **The child pays for the contract.** `contract.md` (~2.4 KB) is one user
  message in the child's own session; it never enters the parent's history and
  never touches the cache prefix.

## Known Limitations and Deferred Work

- The inline node depends on the host plugin's private `dshUiFences` node-data
  shape. If an upgrade changes `{ turn, blocks, settled }`, the component stops
  drawing; the source card is the fallback, and the check is a real session whose
  message asked for a picture.
- `HOST_UI_TOOLS` and the shadowed section names are duplicated from that plugin
  on purpose (no import of a third-party package). A rename upstream means a
  tool stays visible and its guidance stays in the prompt; the prefix comparison
  and a `request/header` tool listing are how that shows up.
- A worker that outlives the session loses its record: the append throws and is
  logged, because a closed session has nowhere to put a card.
