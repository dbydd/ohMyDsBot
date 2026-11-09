/-
The kernel predicates, discharged against the generated facts.

Everything here is checked by `decide` over data that `scripts/extract.mjs`
regenerates: `env` and the row classification from `Omd.Kernel.Spec`, `kernel`,
`order`, and `external` from `Omd.Kernel.Generated`. The activation bridge in
`Omd.Kernel.Composition` turns the two structural checks (`coversOk`, `topoOk`)
into `Stratified`, and `Omd.Cordis.Fiber.closure_stable` turns that into "every
enabled row becomes active".

What is checked here, theorem by theorem:

- `kernel_closed` — every enabled row's requirements are provided by an enabled
  row, except the launcher keys. The launcher keys are covered by
  `Omd.Kernel.Composition.launcher_rows_provide_external`, so the composition as
  a whole is closed.
- `kernel_topo` — the topological check holds: for every enabled row and every
  required key, some enabled provider appears strictly earlier in `order`.
- `kernel_covers` — `order` is a permutation of the kernel row ids.
- `kernel_disjoint` — no launcher row id collides with a real entry id (the
  hypothesis `hdisj` of `ordered_stratified`).
- `kernel_stratified` — the composition is stratified under `env`.
- `kernel_no_pending` — every enabled row of the composition becomes active.
- `kernel_unique` — no service key has two enabled providers.
- `kernel_no_human` — no row that needs a human is enabled.
- `kernel_no_machine` — no machine-bound row is enabled.
- `kernel_interface` — every row of the manipulation surface is enabled.

If `scripts/extract.mjs` regenerates facts that break one of these, the build
fails here, and that failure is the finding.
-/
import Omd.Kernel.Spec
import Omd.Kernel.Generated
import Omd.Kernel.Composition

set_option maxRecDepth 8000

namespace Omd.Kernel

open Omd (Entry provided)
open Omd.Cordis (Stratified closure status)

/-- Enabled rows whose requirement no enabled row provides. -/
private def unprovided (asg : List (String × Bool)) (l : List Entry) : List (String × String) :=
  l.flatMap fun e =>
    if e.enabled asg then
      (e.requires.filter fun k => !provided asg l k).map fun k => (e.id, k)
    else []

/-- Keys with more than one enabled provider. -/
private def duplicated (asg : List (String × Bool)) (l : List Entry) : List String :=
  let keys := (l.filter fun e => e.enabled asg).flatMap fun e => e.provides
  keys.filter fun k => 1 < (keys.filter fun k' => k' == k).length

/-- Every enabled row's requirements are provided, or the key is launcher-supplied. -/
theorem kernel_closed :
    kernel.all fun e => !e.enabled env || e.requires.all fun k =>
      provided env kernel k || external.contains k := by
  decide

/-- `order` is a permutation of the kernel ids. -/
theorem kernel_covers : coversOk order kernel = true := by decide

/-- The topological check holds under `env`. -/
theorem kernel_topo : topoOk env external order kernel = true := by decide

/-- Launcher row ids never collide with real entry ids. -/
theorem kernel_disjoint :
    ∀ k, k ∈ external → ("launcher:" ++ k) ∉ order := by
  intro k hk hmem
  have hall : external.all fun j => !(order.contains ("launcher:" ++ j)) = true := by decide
  have hthis := List.all_eq_true.mp hall k hk
  simp only [Bool.not_eq_true'] at hthis
  have hfalse : order.contains ("launcher:" ++ k) = true := List.contains_iff_mem.mpr hmem
  rw [hfalse] at hthis
  simp at hthis

/-- The composition is stratified: the rank witness exists. -/
theorem kernel_stratified :
    Stratified env (composition external kernel) (rankOf order) :=
  ordered_stratified kernel_covers kernel_topo kernel_disjoint

/-- Every enabled row of the kernel becomes active. -/
theorem kernel_no_pending :
    ∀ e, e ∈ kernel → e.enabled env = true →
      e ∈ closure env (composition external kernel)
        ((composition external kernel).length + 1) :=
  fun e he hen =>
    no_pending kernel_stratified e he hen

/-- …and its status is `active`, not merely "in the list". -/
theorem kernel_no_pending_status :
    ∀ (e : Entry), e ∈ kernel → e.enabled env = true →
      status (closure env (composition external kernel)
        ((composition external kernel).length + 1)) e = .active :=
  fun _e he hen =>
    no_pending_status kernel_stratified he hen

/-- No service key has two enabled providers. -/
theorem kernel_unique : duplicated env kernel = [] := by decide

/-- No row that needs a human is enabled. -/
theorem kernel_no_human :
    rowsThatNeedAHuman.all fun i => !((enabledRows env kernel).any fun e => e.id == i) := by
  decide

/-- No machine-bound row is enabled. -/
theorem kernel_no_machine :
    rowsBoundToThisMachine.all fun i => !((enabledRows env kernel).any fun e => e.id == i) := by
  decide

/-- Every row of the manipulation surface is enabled. -/
theorem kernel_interface :
    interfaceRows.all fun i => (enabledRows env kernel).any fun e => e.id == i := by decide

end Omd.Kernel
