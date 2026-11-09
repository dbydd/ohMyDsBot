/-
Activation semantics of the Cordis fiber layer as vendored in dsh.

Sources (repo `deepseek-harness`, commit
`687f282e8625c6b8d11ff58211a90524be2e4317`):

* `vendor/cordis/src/fiber.ts` — `FiberState` (`PENDING`, `LOADING`, `ACTIVE`, `FAILED`,
  `UNLOADING`, `DISPOSED`) and `_refresh`/`_setEpoch`: a fiber whose `inject` map contains a
  name with no stored implementation keeps epoch `INACTIVE` and stays `PENDING`; when the last
  missing name appears, `_refresh` produces a non-`INACTIVE` epoch and `_setEpoch` loads it.
* `vendor/cordis/src/reflect.ts` — `ReflectService.notify` re-runs `_checkImpl` and `_refresh`
  on every fiber whose `inject` mentions a service name that was just registered or removed,
  so registering a service wakes the fibers that were waiting for it.
* `vendor/cordis/src/registry.ts` — `inject` turns a requirement list into a plugin, and
  `plugin` creates the fiber that records it.
* `docs/cordis-primer.md` — "load order is expressed through service requirements rather than
  manual boot sequencing".

What is modelled: one `Omd.Entry` per composed row. A row is enabled when its `disabled`
condition does not hold, and it becomes active in a round once every service key in
`requires` is provided by an enabled row that is already active. `step` is one re-check round
over the full entry list; `closure` iterates rounds from the empty live set.

Deliberately outside the model:

* asynchronous activation. `_reload` awaits `Promise.resolve()` before running the callback,
  and effect bodies may be promises or async iterables. Here time is only the round index.
* activation failure. A throwing callback or an invalid config puts the fiber in
  `FiberState.FAILED`; no rule below produces `Status.failed`.
* disposal and re-activation. `_setEpoch(INACTIVE)` unloads a fiber when a provider
  disappears and `update`/`restart` reload it; `step` and `closure` are monotone and never
  remove a row.
* the loader's own concurrency and isolation. `dispose`, `inertia`, disposer lists and
  `Context[symbols.isolate]` are not modelled; `requires` is a flat list of service names.
* the `check` predicate of an implementation (`Impl.check` in `reflect.ts`).
* multiple fibers of one plugin (`runtime.fibers`) and per-fiber `inject` intercept config.
  A row is mounted at most once, so a profile that lists the same plugin twice is outside the
  model.
* re-evaluation of `disabled`. The primer has the loader evaluate it at every mount decision;
  here one assignment `asg` is fixed for the whole run, so a row's guard cannot change between
  rounds.
* ordering inside one round. `step` adds every ready row of the full entry list at once,
  while cordis re-checks fibers one notification at a time; `schedule_reaches_closure`
  shows that the order does not change the final set.
-/

import Omd.Basic

namespace Omd.Cordis

open Omd

/-- The fiber states that the mount rules distinguish. `failed` is part of the source's
`FiberState`, but no definition in this file produces it: activation failure is outside the
model. -/
inductive Status where
  | pending
  | active
  | failed
  deriving DecidableEq, Repr

/-- Status of a row given the rows already mounted. Only meaningful for rows the profile
enables; a disabled row never gets a fiber. -/
def status (live : List Entry) (e : Entry) : Status :=
  if live.contains e then .active else .pending

/-- A row may be mounted now: it is enabled, not already live, and every service key it
requires is provided by an enabled live row. This is the condition `_refresh` computes from
`inject` and the implementation store. -/
def ready (asg : List (String × Bool)) (live : List Entry) (e : Entry) : Bool :=
  e.enabled asg && !live.contains e && e.requires.all (fun k => provided asg live k)

/-- One re-check round: keep the live rows and append every ready row of the full entry
list. -/
def step (asg : List (String × Bool)) (entries live : List Entry) : List Entry :=
  live ++ entries.filter (fun e => ready asg live e)

/-- Rounds from the empty live set. Starting empty is what a fresh registry holds: every
plugin fiber is created `PENDING`, so only the root fiber is `ACTIVE` and it owns no row of
the profile.

The fuel is a round count. A row waits one round after the last of its providers becomes
live, so along an acyclic requirement graph every enabled row is live after at most one
round per row; `mem_closure_of_rank_lt` proves that with the rank as the induction measure
and `closure_stable` instantiates it at `entries.length + 1`. With a cycle the iteration
never places the cyclic rows, which is also what the source does. -/
def closure (asg : List (String × Bool)) (entries : List Entry) : Nat → List Entry
  | 0 => []
  | n + 1 => step asg entries (closure asg entries n)

/-- A rank assignment witnessing that the requirement graph has no cycle: every enabled row's
requirements are provided by enabled rows of strictly smaller rank, and every rank is bounded
by the number of rows, which any acyclic graph admits. -/
def Stratified (asg : List (String × Bool)) (entries : List Entry) (rank : Entry → Nat) : Prop :=
  (∀ e, e ∈ entries → rank e ≤ entries.length) ∧
    ∀ e, e ∈ entries → e.enabled asg = true → ∀ k, k ∈ e.requires →
      ∃ f, f ∈ entries ∧ f.enabled asg = true ∧ k ∈ f.provides ∧ rank f < rank e

theorem ready_iff {asg : List (String × Bool)} {live : List Entry} {e : Entry} :
    ready asg live e = true ↔
      e.enabled asg = true ∧ e ∉ live ∧
        ∀ k, k ∈ e.requires → provided asg live k = true := by
  simp [ready, List.all_eq_true, Bool.and_eq_true, and_assoc]

theorem status_of_mem {live : List Entry} {e : Entry} (h : e ∈ live) :
    status live e = .active := by
  simp [status, h]

theorem status_of_ready {asg : List (String × Bool)} {live : List Entry} {e : Entry}
    (h : ready asg live e = true) : status live e = .pending := by
  have hnot : ¬ e ∈ live := (ready_iff.mp h).2.1
  simp [status, hnot]

/-- `provided` only grows when the live list grows. -/
theorem provided_mono {asg : List (String × Bool)} {l l' : List Entry} {k : String}
    (h : l ⊆ l') (hp : provided asg l k = true) : provided asg l' k = true := by
  obtain ⟨e, he, hc⟩ := List.any_eq_true.mp hp
  exact List.any_eq_true.mpr ⟨e, h he, hc⟩

/-- Readiness survives a larger live set as long as the row itself is still not live. -/
theorem ready_mono {asg : List (String × Bool)} {live live' : List Entry} {e : Entry}
    (h : live ⊆ live') (he : e ∉ live') (hr : ready asg live e = true) :
    ready asg live' e = true := by
  rw [ready_iff] at hr ⊢
  exact ⟨hr.1, he, fun k hk => provided_mono h (hr.2.2 k hk)⟩

/-- A larger live set produces a larger next round. -/
theorem step_mono {asg : List (String × Bool)} {entries : List Entry} {live live' : List Entry}
    (h : live ⊆ live') : step asg entries live ⊆ step asg entries live' := by
  intro x hx
  rcases List.mem_append.mp hx with hx | hx
  · exact List.mem_append.mpr (Or.inl (h hx))
  · obtain ⟨hxe, hxr⟩ := List.mem_filter.mp hx
    by_cases hmem : x ∈ live'
    · exact List.mem_append.mpr (Or.inl hmem)
    · exact List.mem_append.mpr (Or.inr (List.mem_filter.mpr ⟨hxe, ready_mono h hmem hxr⟩))

/-- One round keeps everything that was live. -/
theorem subset_step (asg : List (String × Bool)) (entries live : List Entry) :
    live ⊆ step asg entries live := by
  intro x hx
  exact List.mem_append.mpr (Or.inl hx)

theorem closure_succ (asg : List (String × Bool)) (entries : List Entry) :
    ∀ n, closure asg entries n ⊆ closure asg entries (n + 1)
  | 0 => by simp [closure]
  | n + 1 => subset_step asg entries (closure asg entries (n + 1))

theorem closure_subset_entries (asg : List (String × Bool)) (entries : List Entry) :
    ∀ n, closure asg entries n ⊆ entries
  | 0 => by simp [closure]
  | n + 1 => by
      intro x hx
      rcases List.mem_append.mp hx with hx | hx
      · exact closure_subset_entries asg entries n hx
      · exact (List.mem_filter.mp hx).1

theorem closure_enabled (asg : List (String × Bool)) (entries : List Entry) :
    ∀ (n : Nat) (x : Entry), x ∈ closure asg entries n → x.enabled asg = true
  | 0 => by simp [closure]
  | n + 1 => by
      intro x hx
      rcases List.mem_append.mp hx with hx | hx
      · exact closure_enabled asg entries n x hx
      · exact (ready_iff.mp (List.mem_filter.mp hx).2).1

/-- A row that is live after some round had all its requirements provided at that round, and
the live list only grows, so a row is never live while one of its requirements is unprovided. -/
theorem pending_never_activates_unsatisfied (asg : List (String × Bool))
    (entries : List Entry) :
    ∀ (n : Nat) (e : Entry), e ∈ closure asg entries n →
      ∀ k, k ∈ e.requires → provided asg (closure asg entries n) k = true
  | 0 => by simp [closure]
  | n + 1 => by
      intro e he k hk
      rcases List.mem_append.mp he with he | he
      · exact provided_mono (closure_succ asg entries n)
          (pending_never_activates_unsatisfied asg entries n e he k hk)
      · exact provided_mono (closure_succ asg entries n)
          ((ready_iff.mp (List.mem_filter.mp he).2).2.2 k hk)

/-- The contrapositive reading: a row whose requirement no enabled row of the profile provides
never becomes live, at any round. -/
theorem never_live_of_unprovided {asg : List (String × Bool)} {entries : List Entry}
    {n : Nat} {e : Entry} {k : String} (hk : k ∈ e.requires)
    (hno : ∀ f, f ∈ entries → f.enabled asg = true → k ∉ f.provides) :
    e ∉ closure asg entries n := by
  intro hmem
  have hp := pending_never_activates_unsatisfied asg entries n e hmem k hk
  obtain ⟨f, hf, hcond⟩ := List.any_eq_true.mp hp
  rw [Bool.and_eq_true] at hcond
  exact hno f (closure_subset_entries asg entries n hf) hcond.1
    (List.contains_iff_mem.mp hcond.2)

/-- Rows of a fixed point of `step` are never below a later round. -/
theorem closure_subset_of_fixpoint {asg : List (String × Bool)} {entries : List Entry}
    {live : List Entry} (hfix : step asg entries live ⊆ live) :
    ∀ n, closure asg entries n ⊆ live
  | 0 => by simp [closure]
  | n + 1 => fun x hx =>
      hfix (step_mono (closure_subset_of_fixpoint hfix n) hx)

/-- Rounds follow the rank: a row of rank `r` is live once more than `r` rounds have run,
because its providers have smaller rank and are live a round earlier. `closure_stable`
combines this with the bound `rank e ≤ entries.length`. Without a rank the conclusion fails:
two rows that provide each other's requirement keep each other `PENDING` forever, in cordis
as here. -/
theorem mem_closure_of_rank_lt (asg : List (String × Bool)) (entries : List Entry)
    (rank : Entry → Nat) (hstrat : Stratified asg entries rank) :
    ∀ (n : Nat) (e : Entry), e ∈ entries → e.enabled asg = true → rank e < n →
      e ∈ closure asg entries n
  | 0 => by intro e _ _ h; omega
  | n + 1 => by
      intro e he hen hlt
      by_cases hmem : e ∈ closure asg entries n
      · exact closure_succ asg entries n hmem
      · have hprov : ∀ k, k ∈ e.requires → provided asg (closure asg entries n) k = true := by
          intro k hk
          obtain ⟨f, hf, hfen, hfk, hfr⟩ := hstrat.2 e he hen k hk
          have hflt : rank f < n := by omega
          exact provided_of_mem
            (mem_closure_of_rank_lt asg entries rank hstrat n f hf hfen hflt) hfen hfk
        exact List.mem_append.mpr (Or.inr (List.mem_filter.mpr
          ⟨he, ready_iff.mpr ⟨hen, hmem, hprov⟩⟩))

/-- With a rank witness, the closure over `entries.length + 1` rounds is exactly the enabled
rows: every enabled row is live, so no enabled row is left pending, and only enabled rows are
live. -/
theorem closure_stable {asg : List (String × Bool)} {entries : List Entry} {rank : Entry → Nat}
    (hstrat : Stratified asg entries rank) :
    ∀ e, e ∈ entries → (e ∈ closure asg entries (entries.length + 1) ↔ e.enabled asg = true) := by
  intro e he
  constructor
  · exact closure_enabled asg entries (entries.length + 1) e
  · intro hen
    exact mem_closure_of_rank_lt asg entries rank hstrat (entries.length + 1) e he hen
      (by have := hstrat.1 e he; omega)

/-- A mount sequence, stated as legality of every append: each row is in the profile and was
ready when it was added. -/
def Schedule (asg : List (String × Bool)) (entries : List Entry) : List Entry → List Entry → Prop
  | _, [] => True
  | live, e :: rest =>
      e ∈ entries ∧ ready asg live e = true ∧ Schedule asg entries (live ++ [e]) rest

/-- The live set a mount sequence produces. -/
def runSchedule (asg : List (String × Bool)) (entries : List Entry) :
    List Entry → List Entry → List Entry
  | live, [] => live
  | live, e :: rest => runSchedule asg entries (live ++ [e]) rest

/-- Fairness: no row of the profile is ready at the end. A schedule that leaves a ready row
out fails this condition. -/
def Maximal (asg : List (String × Bool)) (entries : List Entry) (live : List Entry) : Prop :=
  ∀ e, e ∈ entries → ready asg live e = false

theorem not_maximal_of_ready {asg : List (String × Bool)} {entries : List Entry}
    {live : List Entry} {e : Entry} (he : e ∈ entries) (hr : ready asg live e = true) :
    ¬ Maximal asg entries live := by
  intro h
  have hfalse := h e he
  rw [hr] at hfalse
  exact Bool.noConfusion hfalse

theorem runSchedule_entries (asg : List (String × Bool)) (entries : List Entry) :
    ∀ (s : List Entry) (live : List Entry), Schedule asg entries live s →
      (∀ x, x ∈ live → x ∈ entries ∧ x.enabled asg = true) →
      ∀ x, x ∈ runSchedule asg entries live s → x ∈ entries ∧ x.enabled asg = true
  | [], live, _, hinv => hinv
  | e :: rest, live, hs, hinv => by
      obtain ⟨he, hr, hrest⟩ := hs
      have hnew : ∀ x, x ∈ live ++ [e] → x ∈ entries ∧ x.enabled asg = true := by
        intro x hx
        rcases List.mem_append.mp hx with hx | hx
        · exact hinv x hx
        · rw [List.mem_singleton] at hx
          subst hx
          exact ⟨he, (ready_iff.mp hr).1⟩
      exact runSchedule_entries asg entries rest (live ++ [e]) hrest hnew

/-- A maximal schedule ends in a fixed point of `step`. -/
theorem step_of_maximal {asg : List (String × Bool)} {entries : List Entry} {live : List Entry}
    (h : Maximal asg entries live) : step asg entries live = live := by
  unfold step
  have hempty : entries.filter (fun e => ready asg live e) = [] := by
    rw [List.filter_eq_nil_iff]
    intro e he
    rw [h e he]
    exact Bool.false_ne_true
  rw [hempty, List.append_nil]

/-- Every maximal schedule mounts exactly the enabled rows, so the mounting order cannot change
the outcome. The fairness condition is `Maximal`: a schedule that stops while some row of the
profile is ready is not maximal and can be extended. -/
theorem schedule_reaches_closure {asg : List (String × Bool)} {entries : List Entry}
    {rank : Entry → Nat} (hstrat : Stratified asg entries rank) :
    ∀ s, Schedule asg entries [] s →
      Maximal asg entries (runSchedule asg entries [] s) →
      ∀ e, e ∈ entries →
        (e ∈ runSchedule asg entries [] s ↔ e.enabled asg = true) := by
  intro s hsch hmax e he
  constructor
  · intro hmem
    exact (runSchedule_entries asg entries s [] hsch (fun x hx => absurd hx List.not_mem_nil)
      e hmem).2
  · intro hen
    have hstable := closure_stable hstrat e he
    have hfix : step asg entries (runSchedule asg entries [] s) ⊆ runSchedule asg entries [] s := by
      rw [step_of_maximal hmax]
      exact fun _ hx => hx
    exact closure_subset_of_fixpoint hfix (entries.length + 1) (hstable.mpr hen)

/-- Two maximal schedules of the same profile produce the same live set. -/
theorem maximal_schedules_agree {asg : List (String × Bool)} {entries : List Entry}
    {rank : Entry → Nat} (hstrat : Stratified asg entries rank)
    {s t : List Entry} (hs : Schedule asg entries [] s) (ht : Schedule asg entries [] t)
    (hmaxS : Maximal asg entries (runSchedule asg entries [] s))
    (hmaxT : Maximal asg entries (runSchedule asg entries [] t)) :
    ∀ e, e ∈ entries →
      (e ∈ runSchedule asg entries [] s ↔ e ∈ runSchedule asg entries [] t) := by
  intro e he
  exact (schedule_reaches_closure hstrat s hs hmaxS e he).trans
    (schedule_reaches_closure hstrat t ht hmaxT e he).symm

end Omd.Cordis
