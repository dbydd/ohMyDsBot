# proof/ — the correctness argument

Lean 4.34.1, no Mathlib, Lake. Every claim about the omd kernel ends here: the
semantics of the code dsh is built from, the real composition, and the contract
the omd plugins have to satisfy.

## Layout

| path | what it is |
|---|---|
| `Omd/Basic.lean` | Shared vocabulary: `Cond` (guard over platform atoms), `Entry` (one composed row: `id package provides requires guard`), `enabled`, `provided` |
| `Omd/Cordis/Effect.lean` | Registrations as reversible effects; a well-formed program unwinds to the state it started from |
| `Omd/Cordis/Fiber.lean` | Activation: `ready` / `step` / `closure`, the rank witness `Stratified`, load-order independence |
| `Omd/Cordis/Registry.lean` | Service registry: one implementation per key; `ctx.get` vs the property proxy |
| `Omd/Cordis/Dispatch.lean` | The five event dispatch modes |
| `Omd/Dsh/Session.lean` | Session log: append-only, strict sequence, replay guarantee, surface replacement |
| `Omd/Dsh/Tools.lean` | Tool registry and the call pipeline: nearest scope wins, guard denial irreversible |
| `Omd/Dsh/Prompt.lean` | Scoped prompt layers: nearest layer wins |
| `Omd/Dsh/Request.lean` | Request assembly: every part sourced, tools come from the registry |
| `Omd/Kernel/Spec.lean` | Kernel predicates: `closed`, `uniqueProvider`, `noHumanSurface`, `noMachineBinding`, `interfacePresent`, the row classification |
| `Omd/Kernel/Generated.lean` | **Generated.** The 100 composed rows of `profiles/omd-kernel`, extracted from the real dump |
| `Omd/Kernel/Composition.lean` | The bridge: launcher-provided keys become synthetic rows; `order` becomes the rank witness; `Stratified` ⇒ every enabled row activates |
| `Omd/Kernel/Facts.lean` | The predicates discharged by `decide` over the generated facts. If extraction breaks a property, the build breaks here |
| `Omd/Plugins/Contract.lean` | `conforms`: the five-clause contract for out-of-tree omd plugins, plus `mount_preserves_closed` |
| `scripts/extract.mjs` | The generator: dump → provides/requires/guards/order → `Generated.lean` |
| `generated/check.lean` | Readable run log of the fact checks (`#eval` forms of what `Facts.lean` proves) |
| `generated/axioms.lean` | Proof hygiene: no theorem depends on `sorryAx` |

## Run it

```sh
cd proof
node scripts/extract.mjs    # regenerate the composition facts
lake build                  # check every theorem
lake env lean generated/check.lean   # human-readable fact log
lake env lean generated/axioms.lean  # axiom audit
```

## The source correspondence

The full record — source paths at commit
`687f282e8625c6b8d11ff58211a90524be2e4317`, what each module models, what it
leaves out, and the model–source disagreements found while building it — is
`docs/omd-proof-manifest.md`. Every module's docstring carries the same
information inline. Summary:

| module | source | modelled | outside |
|---|---|---|---|
| Effect | `vendor/cordis/src/context.ts`, `fiber.ts` | the effect stack, reverse-order unwind | async bodies, fiber statuses, `isolate`, logger effects |
| Fiber | `vendor/cordis/src/fiber.ts`, `reflect.ts` | `inject` gating, round-based activation | async activation, failure, disposal/re-activation, loader concurrency |
| Registry | `vendor/cordis/src/registry.ts`, `service.ts`, `reflect.ts` | registration, `get`, the ancestor-chain proxy | isolate labels, accessors, the proxy's throws |
| Dispatch | `vendor/cordis/src/events.ts` | the five modes' order laws | awaiting, `parallel` interleaving, listener errors |
| Session | `packages/core/session/src/index.ts` | append-only log, sequence discipline, surface ops, replay | projections, durability, JSONL, the event-type catalogue |
| Tools | `packages/core/tools/src/index.ts` | scope resolution, pipeline stages, guard monotonicity | schemas, PTC, async dispatch, timeouts |
| Prompt | `packages/core/system-prompt/src/index.ts` | scoped layer merge | rendering order, `{{model}}` interpolation, token accounting |
| Request | same + `packages/core/tools` | the three request parts and their sources | runtime contexts, adapter defaults |

Known model–source gaps worth remembering:

- Cordis tolerates a repeated or absent disposal silently; `Effect.lean` treats
  it as an error — the model is deliberately stricter.
- `closure_stable` needs the acyclicity witness (`Stratified`). "Requirements are
  provided" alone admits two rows deadlocking on each other — the same holds in
  cordis itself.
- The tool `restrict` filter in the source is applied to inherited names only;
  `Request.lean` filters the resolved list. Documented in that module.

## What the facts file proves about this kernel

`Omd/Kernel/Facts.lean`, all `decide`-checked against `Generated.lean` under
`env = [("win32", false)]` (plus the two authoring-runtime atoms, both false):

| theorem | content |
|---|---|
| `kernel_closed` | every enabled row's requirements come from an enabled row or the launcher |
| `kernel_covers`, `kernel_topo` | `order` is a permutation of the row ids and satisfies the topological check |
| `kernel_disjoint` | launcher row ids never collide with real entry ids |
| `kernel_stratified` | the composition is stratified — the activation theorem applies |
| `kernel_no_pending`, `kernel_no_pending_status` | every enabled row activates; status is `active` |
| `kernel_unique` | no key has two enabled providers |
| `kernel_no_human` | none of the 14 human-facing rows is enabled |
| `kernel_no_machine` | `llm-pi-ai`, `deepseek-account`, `llm-deepseek-account` are off |
| `kernel_interface` | `sdk-jsonrpc-server` and the services it needs are enabled |

The runtime evidence that the same composition boots and serves a real turn is in
`artifacts/kernel-verify/session.md`.

## Regenerating

`node scripts/extract.mjs` re-reads `dsh --profile omd-kernel --dump-config` and
every package's entry module, and rewrites `Omd/Kernel/Generated.lean`. It exits
non-zero on: a guard expression its table does not cover, a requirement with no
provider, or a cycle in the requirement graph. Two runs are byte-identical; the
script prints what changed in `provides` so a diff in the report is the diff to
read.

## Extending

New modules join at `Omd.lean`. The plugin contract in
`Omd/Plugins/Contract.lean` is written to be instantiated per plugin: one
`Plugin` record per package (declarations read off the source), `conforms` for
the instance, and `mount_preserves_closed` for the mount step. A plugin that
fails its record breaks its own file, not the kernel's.
