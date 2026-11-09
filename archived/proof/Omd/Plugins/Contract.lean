/-
The contract an out-of-tree `omd` plugin satisfies before it may be mounted into
the kernel.

The five clauses are harness rules restated as facts about a package, so that a
generated record per plugin can be checked mechanically instead of argued in
prose. The sources are `refs/deepseek-harness/packages/AGENTS.md` (inject,
effects, one implementation per key), `refs/deepseek-harness/AGENTS.md:131,136`
(registration as effect; model-visible ⟺ logged), and this repository's
`AGENTS.md` (界面归属, 发布与配置).

What is outside this model: the actual bodies of plugin code, the loader's
concurrency, and whether a `Config` default is *used* rather than merely absent.
The record states what a package declares; the declaration is what the checker
reads.
-/
import Omd.Basic
import Omd.Kernel.Spec

namespace Omd.Plugins

open Omd (Entry provided)
open Omd.Kernel (closed)

/-- One contribution a plugin makes at mount time. -/
structure Registration where
  /-- What the contribution lands in: a service key, a tool registry, a prompt
  layer, a session projection, an event listener. -/
  target : String
  /-- Whether the contribution was made through `ctx.effect` or `ctx.on`, so a
  disposer exists and unmounting removes it. -/
  reversible : Bool
  deriving Repr, DecidableEq

/-- A plugin reduced to the facts the contract tests.

Every field is a declaration read off the package, not a behaviour: `inject`,
`exports`, whether the source calls `ctx.effect`/`ctx.on` for each registration,
whether it writes a session event for the content it makes visible, and whether a
`Config` default names something that only exists on one machine. -/
structure Plugin where
  name : String
  /-- Declared `inject` services. -/
  requires : List String
  /-- Service keys the plugin registers. -/
  provides : List String
  registrations : List Registration
  /-- The plugin contributes content the model can read: a prompt section, a tool
  schema, or an injected user-visible context. -/
  modelVisible : Bool
  /-- Every such contribution is derived from a session event, or is a schema the
  registry already owns. -/
  modelVisibleIsLogged : Bool
  /-- The package declares `dsh.client`. -/
  declaresClient : Bool
  /-- The host entry imports anything under `src/client`. -/
  hostImportsClient : Bool
  /-- A `Config` default names a host path, a gateway address, a model id, or a
  credential. -/
  machineBoundDefault : Bool
  deriving Repr

/-- Clause 1: every required service is provided by the composition the plugin is
mounted into. An unmet requirement is not an error at mount time — the fiber sits
`PENDING` — so the contract has to state the closure explicitly. -/
def depsClosed (asg : List (String × Bool)) (l : List Entry) (p : Plugin) : Bool :=
  p.requires.all fun k => provided asg l k

/-- Clause 2: every registration carries a disposer. -/
def allReversible (p : Plugin) : Bool :=
  p.registrations.all fun r => r.reversible

/-- Clause 2, second half: one target per plugin, so a single unmount cannot
leave a second registration of the same kind behind. -/
def distinctTargets (p : Plugin) : Bool :=
  (p.registrations.map (·.target)).eraseDups.length == p.registrations.length

/-- Clause 3: model-visible content is either a registry-owned schema or is backed
by a session event. -/
def modelVisibleIsLogged (p : Plugin) : Bool :=
  !p.modelVisible || p.modelVisibleIsLogged

/-- Clause 4: the host half never reaches into the client half, and the client
half is never part of a host composition. -/
def clientStaysOut (p : Plugin) : Bool :=
  !p.hostImportsClient

/-- Clause 5: no `Config` default is bound to one machine. -/
def machineFree (p : Plugin) : Bool :=
  !p.machineBoundDefault

/-- The contract. -/
def conforms (asg : List (String × Bool)) (l : List Entry) (p : Plugin) : Bool :=
  depsClosed asg l p && allReversible p && distinctTargets p &&
    modelVisibleIsLogged p && clientStaysOut p && machineFree p

theorem conforms_deps {asg l p} (h : conforms asg l p = true) : depsClosed asg l p = true := by
  unfold conforms at h
  simp only [Bool.and_eq_true] at h
  exact h.1.1.1.1.1

theorem conforms_reversible {asg l p} (h : conforms asg l p = true) : allReversible p = true := by
  unfold conforms at h
  simp only [Bool.and_eq_true] at h
  exact h.1.1.1.1.2

theorem conforms_logged {asg l p} (h : conforms asg l p = true) : modelVisibleIsLogged p = true := by
  unfold conforms at h
  simp only [Bool.and_eq_true] at h
  exact h.1.1.2

theorem conforms_client_out {asg l p} (h : conforms asg l p = true) : clientStaysOut p = true := by
  unfold conforms at h
  simp only [Bool.and_eq_true] at h
  exact h.1.2

theorem conforms_machine_free {asg l p} (h : conforms asg l p = true) : machineFree p = true := by
  unfold conforms at h
  simp only [Bool.and_eq_true] at h
  exact h.2

/-- Adding a row never removes a service a composition already provides. -/
theorem provided_mono_cons {asg : List (String × Bool)} {l : List Entry} {k : String} {x : Entry}
    (h : provided asg l k = true) : provided asg (x :: l) k = true := by
  simp only [provided] at h ⊢
  rw [List.any_cons, h]
  simp

/-- Mounting cannot strand an existing consumer.

If the composition was closed and the new row's requirements are already
satisfied, the composition stays closed: the new row adds services, it does not
take any away, so every requirement that held before still holds. This is the
induction step that lets plugins be mounted one at a time — each mount is checked
on its own, and the kernel's closure survives the sequence. -/
theorem mount_preserves_closed {asg : List (String × Bool)} {l : List Entry} {p : Entry}
    (hclosed : closed asg l = true)
    (hreq : p.requires.all (provided asg l) = true) :
    closed asg (p :: l) = true := by
  unfold closed at *
  rw [List.all_cons] at *
  rw [Bool.and_eq_true]
  constructor
  · by_cases hp : p.enabled asg = true
    · simp only [hp, Bool.not_true, Bool.false_or]
      refine List.all_eq_true.mpr ?_
      intro k hk
      exact provided_mono_cons ((List.all_eq_true.mp hreq) k hk)
    · simp only [hp, Bool.not_false, Bool.true_or]
  · refine List.all_eq_true.mpr ?_
    intro e he
    have he' : (!e.enabled asg || e.requires.all (provided asg l)) = true :=
      (List.all_eq_true.mp hclosed) e he
    by_cases hpe : e.enabled asg = true
    · simp only [hpe, Bool.not_true, Bool.false_or] at he' ⊢
      refine List.all_eq_true.mpr ?_
      intro k hk
      exact provided_mono_cons ((List.all_eq_true.mp he') k hk)
    · simp only [hpe, Bool.not_false, Bool.true_or]

end Omd.Plugins
