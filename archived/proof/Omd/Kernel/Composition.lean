/-
The bridge from the generated composition to the activation theory.

Sources (repo `deepseek-harness`, commit
`687f282e8625c6b8d11ff58211a90524be2e4317`):

* `vendor/cordis/src/fiber.ts` — a fiber whose `inject` names a service that no
  mounted implementation provides keeps epoch `INACTIVE` and stays `PENDING`;
  `_refresh` produces a live epoch only once every injected name is provided.
* `vendor/cordis/src/reflect.ts` — `ReflectService.notify` re-runs `_checkImpl`
  and `_refresh` whenever a service is registered, so the order in which
  providers mount is what wakes their consumers.
* `docs/capability-seams.md` — the `ctx key` table names an Owner for every
  service a profile row consumes. The keys with no row owner are launcher facts:
  `cordis-plugin-loader` registers `loader` before it mounts the rows it loads,
  `dsh-cmdline`'s `provideCmdline` registers `cmdlineArgs` before the tree
  mounts, and the launcher's profile boot registers `profileContext`. Those
  three are exactly `Omd.Kernel.external`.

What is modelled: `Omd.Kernel.Generated.kernel` is a list of rows; each row's
`requires` is an `inject` list and each row's `provides` is what its module
registers. A key in `external` is provided by a synthetic launcher row, one per
key, enabled under every assignment. `composition` is the launcher rows followed
by the kernel rows; that is the entry list `Omd.Cordis.closure` runs over.

`coversOk` says `order` is a permutation of the kernel row ids, and `topoOk`
says `order` is a topological order of the requirement graph, where a key in
`external` counts as already satisfied. Together they yield the `Stratified`
witness — the rank being the row's position in `order` — which is what
`Omd.Cordis.closure_stable` needs. The two checks are *checked* against the
generated data elsewhere; this file proves only that they imply activation, so
nothing here is specific to this run.

Deliberately outside the model:

* the checks themselves. `coversOk`/`topoOk` are not established for
  `Omd.Kernel.kernel`, `Omd.Kernel.order` and `Omd.Kernel.external` here.
* the launcher's actual provisioning. `launcherRows` asserts one enabled row per
  external key; whether `cordis-plugin-loader`, `dsh-cmdline` and the profile
  boot really register those keys is a fact about the launcher, not about the
  composition. The launcher row ids are synthesized, so `ordered_stratified`
  carries `hdisj`: no synthesized id may coincide with a string in `order`.
  Without it the rank of a launcher row is not known to be `0`.
* everything `Omd.Cordis.Fiber` already leaves outside: asynchronous activation,
  activation failure and `Status.failed`, disposal and re-activation, the
  implementation `check` predicate, and re-evaluation of `disabled` between
  rounds. `asg` is fixed for the whole run.
* guard semantics beyond `Cond.eval`. A guard that tests a platform atom is only
  as accurate as the assignment it is evaluated under.

No theorem names `kernel`, `order` or `external`: all three are parameters, so
the file is run-independent and a port re-checks only the hypotheses.
-/

import Omd.Basic
import Omd.Cordis.Fiber
import Omd.Kernel.Spec
import Omd.Kernel.Generated

namespace Omd.Kernel

/-- The launcher's row for one externally provided key.

The launcher mounts before the profile, provides `k` for the whole run, and has
no requirements and no `disabled` condition: `Cond.never` is never true, so the
row is enabled under every assignment. -/
def launcherRow (k : String) : Entry :=
  { id := "launcher:" ++ k
  , package := "launcher"
  , provides := [k]
  , requires := []
  , guard := Cond.never }

/-- One synthetic row per key the launcher provides. -/
def launcherRows (ext : List String) : List Entry := ext.map launcherRow

/-- The entry list activation runs over: the launcher rows, then the kernel.

Rank is read off `order`, not off a position in this list, so the prefix changes
nothing about activation; `composition` exists so that the launcher and the
kernel are one entry list for `Omd.Cordis.closure`. -/
def composition (ext : List String) (kernel : List Entry) : List Entry :=
  launcherRows ext ++ kernel

/-- A row's rank: one more than its position in `order`, or `0` when it has no
position.

Launcher rows have no position in `order` (given `hdisj` below), so they rank
`0`, and a kernel row, whose position is at most `order.length - 1`, always
outranks them. Any other row also ranks `0`. -/
def rankOf (order : List String) (e : Entry) : Nat :=
  if order.idxOf e.id < order.length then order.idxOf e.id + 1 else 0

/-- `order` is a permutation of the kernel row ids: same length, every id exactly
once.

`filter`+`length` is the count; the core library has no `List.count` for
`String` under a usable statement. -/
def coversOk (order : List String) (kernel : List Entry) : Bool :=
  (order.length == kernel.length) &&
    kernel.all (fun e => (order.filter (fun id => id == e.id)).length == 1)

/-- `f` is an enabled provider of `k` placed strictly before `e` in `order`. -/
def earlierProvider (asg : List (String × Bool)) (order : List String)
    (k : String) (e f : Entry) : Bool :=
  f.enabled asg && f.provides.contains k && decide (order.idxOf f.id < order.idxOf e.id)

/-- `order` is a topological order of the requirement graph.

For every row: it is disabled, or each key it requires is either provided by the
launcher (`ext`) or provided by an enabled row placed strictly earlier in
`order`. This is the hypothesis "every enabled row's requirements are provided
by some enabled row" *plus* the acyclicity the activation theorem needs; the
bare provision condition alone admits two rows that provide each other's
requirement and both stay pending. -/
def topoOk (asg : List (String × Bool)) (ext order : List String)
    (kernel : List Entry) : Bool :=
  kernel.all fun e =>
    !e.enabled asg ||
      e.requires.all fun k =>
        ext.contains k || kernel.any (earlierProvider asg order k e)

/-! ## The launcher rows -/

theorem launcher_row_enabled (asg : List (String × Bool)) (k : String) :
    (launcherRow k).enabled asg = true := rfl

theorem launcher_row_provides (k : String) : (launcherRow k).provides = [k] := rfl

theorem launcher_row_requires (k : String) : (launcherRow k).requires = [] := rfl

theorem mem_launcherRows {ext : List String} {k : String} (hk : k ∈ ext) :
    launcherRow k ∈ launcherRows ext :=
  List.mem_map_of_mem hk

/-- An external key is provided by the composition, under every assignment. -/
theorem launcher_rows_provide_external {asg : List (String × Bool)}
    {ext : List String} {kernel : List Entry} {k : String} (hk : k ∈ ext) :
    provided asg (composition ext kernel) k = true :=
  provided_of_mem
    (List.mem_append.mpr (Or.inl (mem_launcherRows hk)))
    (launcher_row_enabled asg k)
    (by rw [launcher_row_provides]; exact List.mem_singleton.mpr rfl)

/-- A launcher row ranks `0`, provided its synthesized id is not in `order`. -/
theorem rankOf_launcherRow {order ext : List String} {k : String} (hk : k ∈ ext)
    (hdisj : ∀ k, k ∈ ext → ("launcher:" ++ k) ∉ order) :
    rankOf order (launcherRow k) = 0 := by
  have hlen : order.idxOf ("launcher:" ++ k) = order.length :=
    List.idxOf_eq_length (hdisj k hk)
  simp [rankOf, launcherRow, hlen]

/-- A kernel row ranks one more than its position in `order`. -/
theorem rankOf_of_idxOf_lt {order : List String} {e : Entry}
    (h : order.idxOf e.id < order.length) :
    rankOf order e = order.idxOf e.id + 1 := by
  simp [rankOf, h]

/-! ## The checks, unpacked -/

theorem earlierProvider_iff {asg : List (String × Bool)} {order : List String}
    {k : String} {e f : Entry} :
    earlierProvider asg order k e f = true ↔
      f.enabled asg = true ∧ k ∈ f.provides ∧
        order.idxOf f.id < order.idxOf e.id := by
  simp [earlierProvider, and_assoc]

theorem coversOk_length {order : List String} {kernel : List Entry}
    (h : coversOk order kernel = true) : order.length = kernel.length := by
  simp only [coversOk, Bool.and_eq_true] at h
  exact beq_iff_eq.mp h.1

theorem coversOk_idxOf {order : List String} {kernel : List Entry}
    (h : coversOk order kernel = true) {e : Entry} (he : e ∈ kernel) :
    order.idxOf e.id < order.length := by
  simp only [coversOk, Bool.and_eq_true] at h
  have hcount : (order.filter (fun id => id == e.id)).length = 1 :=
    beq_iff_eq.mp (List.all_eq_true.mp h.2 e he)
  have hne : order.filter (fun id => id == e.id) ≠ [] := by
    intro hnil
    rw [hnil] at hcount
    simp at hcount
  obtain ⟨x, hxmem⟩ := List.exists_mem_of_ne_nil _ hne
  obtain ⟨hxorder, hxbeq⟩ := List.mem_filter.mp hxmem
  have hx : x = e.id := beq_iff_eq.mp hxbeq
  subst hx
  exact List.idxOf_lt_length_iff.mpr hxorder

/-- The launcher prefix contributes exactly one entry per external key. -/
theorem composition_length (ext : List String) (kernel : List Entry) :
    (composition ext kernel).length = ext.length + kernel.length := by
  simp [composition, launcherRows, List.length_append]

/-! ## The checks imply a stratification -/

/-- The topological order is a rank witness for the composition.

The statement needs one fact beyond `coversOk`/`topoOk`: `hdisj`, that the
synthesized launcher ids are not in `order`, which is what makes launcher rows
rank `0`. A kernel row's rank is its position plus one, which is at most
`order.length`, which `coversOk` makes `kernel.length`. -/
theorem ordered_stratified {asg : List (String × Bool)} {ext : List String}
    {kernel : List Entry} {order : List String}
    (hcov : coversOk order kernel = true)
    (htopo : topoOk asg ext order kernel = true)
    (hdisj : ∀ k, k ∈ ext → ("launcher:" ++ k) ∉ order) :
    Omd.Cordis.Stratified asg (composition ext kernel) (rankOf order) := by
  constructor
  · intro e he
    rcases List.mem_append.mp he with hle | hke
    · obtain ⟨k, hk, hrow⟩ := List.mem_map.mp hle
      have hr : rankOf order e = 0 := by
        rw [← hrow]
        exact rankOf_launcherRow hk hdisj
      omega
    · have hlt := coversOk_idxOf hcov hke
      have hr : rankOf order e = order.idxOf e.id + 1 := rankOf_of_idxOf_lt hlt
      rw [hr, composition_length]
      have hlen := coversOk_length hcov
      omega
  · intro e he hen k hk
    rcases List.mem_append.mp he with hle | hke
    · obtain ⟨k', _, hrow⟩ := List.mem_map.mp hle
      rw [← hrow] at hk
      rw [launcher_row_requires] at hk
      exact absurd hk List.not_mem_nil
    · have hlt := coversOk_idxOf hcov hke
      have hrank : rankOf order e = order.idxOf e.id + 1 := rankOf_of_idxOf_lt hlt
      have hall : e.requires.all
          (fun k => ext.contains k || kernel.any (earlierProvider asg order k e)) = true := by
        have h := List.all_eq_true.mp htopo e hke
        simpa [hen] using h
      have hk' : (ext.contains k ||
          kernel.any (earlierProvider asg order k e)) = true :=
        List.all_eq_true.mp hall k hk
      rw [Bool.or_eq_true] at hk'
      rcases hk' with hkExt | hkAny
      · have hkmem : k ∈ ext := List.contains_iff_mem.mp hkExt
        refine ⟨launcherRow k, List.mem_append.mpr (Or.inl (mem_launcherRows hkmem)),
          launcher_row_enabled asg k, ?_, ?_⟩
        · rw [launcher_row_provides]; exact List.mem_singleton.mpr rfl
        · rw [hrank, rankOf_launcherRow hkmem hdisj]
          omega
      · obtain ⟨f, hfmem, hf⟩ := List.any_eq_true.mp hkAny
        obtain ⟨hfen, hfprov, hfidx⟩ := earlierProvider_iff.mp hf
        refine ⟨f, List.mem_append.mpr (Or.inr hfmem), hfen,
          hfprov, ?_⟩
        have hflt : order.idxOf f.id < order.length :=
          Nat.lt_trans hfidx hlt
        rw [hrank, rankOf_of_idxOf_lt hflt]
        omega

/-! ## No enabled row stays pending -/

/-- Under a stratification, every enabled kernel row is live in the closure.

`(composition ext kernel).length + 1` rounds are enough: the rank of every row
is at most the composition length, and `Omd.Cordis.mem_closure_of_rank_lt` places
a row of rank `r` by round `r + 1`. -/
theorem no_pending {asg : List (String × Bool)} {ext : List String}
    {kernel : List Entry} {order : List String}
    (hstrat : Omd.Cordis.Stratified asg (composition ext kernel) (rankOf order)) :
    ∀ e, e ∈ kernel → e.enabled asg = true →
      e ∈ Omd.Cordis.closure asg (composition ext kernel)
        ((composition ext kernel).length + 1) := by
  intro e he hen
  exact (Omd.Cordis.closure_stable hstrat e
    (List.mem_append.mpr (Or.inr he))).mpr hen

/-- The same fact as a status: no enabled kernel row is left `pending`. -/
theorem no_pending_status {asg : List (String × Bool)} {ext : List String}
    {kernel : List Entry} {order : List String}
    (hstrat : Omd.Cordis.Stratified asg (composition ext kernel) (rankOf order))
    {e : Entry} (he : e ∈ kernel) (hen : e.enabled asg = true) :
    Omd.Cordis.status
      (Omd.Cordis.closure asg (composition ext kernel)
        ((composition ext kernel).length + 1)) e = .active :=
  Omd.Cordis.status_of_mem (no_pending hstrat e he hen)

/-- One statement per assignment: if the two checks hold for an assignment, every
enabled row of `kernel` is `active` under it, so the mounting order does not
matter for this kernel.

The checks are the ones a later file discharges; `hdisj` is the one extra fact
the bridge needs (see `ordered_stratified`). -/
theorem no_pending_all_assignments {ext : List String} {kernel : List Entry}
    {order : List String}
    (hcov : coversOk order kernel = true)
    (hdisj : ∀ k, k ∈ ext → ("launcher:" ++ k) ∉ order) :
    ∀ asg : List (String × Bool), topoOk asg ext order kernel = true →
      ∀ e, e ∈ kernel → e.enabled asg = true →
        Omd.Cordis.status
          (Omd.Cordis.closure asg (composition ext kernel)
            ((composition ext kernel).length + 1)) e = .active := by
  intro asg htopo e he hen
  exact no_pending_status (ordered_stratified hcov htopo hdisj) he hen

end Omd.Kernel
