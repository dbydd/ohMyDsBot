/-
Prompt-section layers: which body a section name resolves to.

Source: `refs/deepseek-harness`, commit
`687f282e8625c6b8d11ff58211a90524be2e4317`:
- `packages/core/system-prompt/src/index.ts`: `SystemPrompt.assemble` calls
  `this.layers.merge(scope, layer => layer.sections)` (line 631); `PromptLayer`
  builds its section table with a throwing duplicate diagnostic (lines
  402-416); `section()` registers into the calling scope (lines 478-487).
- `packages/core/scope/src/store.ts`: `ScopedLayers.merge` (lines 201-217) and
  `NamedEntries.insert` (lines 37-54).
- `packages/core/scope/src/index.ts`: `scopeChainOf` (lines 93-102) returns the
  chain nearest-first, from a scope key up to its root ancestor.
- `packages/core/system-prompt/README.md`: scoped contributions shadow globals
  for one agent, and a per-agent override registers through `agent.ctx`.

What is modelled. A section name resolves against a layer chain: the global
layer, every ancestor scope from the farthest to the nearest, then the viewing
scope. `ScopedLayers.merge` inserts those layers into one map in that order, so
a nearer layer replaces a same-named entry of a farther layer and the nearest
layer wins. A `Layer` here is one registration flattened out of its layer map,
`depth` is the registration's position in that chain (`0` is the global layer,
a greater depth is nearer), and `merge` returns the body contributed at the
greatest depth. In the real chain no two layers share a depth because
`ScopedLayers` keys one layer per scope; `UniquePerDepth` records the same fact
for an arbitrary list, and `register` is where a same-name registration inside
one layer is rejected.

What is deliberately outside the model.
- Section placement and rendering: `order`, the code-unit name tie-break,
  joining with blank lines, dropping empty sections. The model answers which
  body a name resolves to, not the final prompt text.
- `{{model}}` and every other `{{variable}}` interpolation, `interpolate:
  false`, and the failure on an unresolved reference.
- `complete: true` sections, the `system-prompt/assemble` waterfall, runtime
  contexts with their `required` flag and suppressors, tool schemas, and the
  `system-prompt/change` notification.
- Token accounting and KV-cache effects.
- Locale and command sections: other plugins contribute that text and it
  varies per deployment; the model covers only how a contributed name resolves.
- Scope identity and lifetime: `ScopeKey` is an opaque object in a parent map,
  a scoped layer is created on first registration and reclaimed when empty.
  The model keeps a `Nat` depth, has no removal, and takes the layer list as
  given.
- Duplicate rejection is an `Except` result rather than a thrown `Error`. The
  message is the scoped-layer one; the global-layer message adds the
  `agent.ctx` hint.
-/
import Omd.Basic

namespace Omd.Dsh.Prompt

/-- One section registration at one layer depth.

`depth` is the layer's position in the scope chain: `0` is the global layer,
and a greater depth is a nearer scope, so the maximum depth is the viewing
scope. -/
structure Layer where
  name : String
  depth : Nat
  body : String
  deriving DecidableEq, Repr

/-- At most one layer holds a given name at a given depth.

This is the invariant `register` maintains: `NamedEntries.insert` throws a
second insertion of one name into one layer, and `ScopedLayers` creates one
layer per scope. Without it, `pick`'s positional tie-break would decide the
result, and the merge would depend on list order. -/
def UniquePerDepth (l : List Layer) : Prop :=
  ∀ a ∈ l, ∀ b ∈ l, a.depth = b.depth → a.name = b.name → a = b

/-- The registrations contributing one section name, in layer-list order. -/
def hits (l : List Layer) (n : String) : List Layer :=
  l.filter (fun x => decide (x.name = n))

/-- The registration of greatest depth; among equal depths the one later in
the list. `UniquePerDepth` makes that second clause unreachable. -/
def pick : List Layer → Option Layer
  | [] => none
  | x :: xs =>
      match pick xs with
      | none => some x
      | some y => if x.depth ≤ y.depth then some y else some x

theorem pick_cons (x : Layer) (xs : List Layer) :
    pick (x :: xs) =
      (match pick xs with
       | none => some x
       | some y => if x.depth ≤ y.depth then some y else some x) := rfl

/-- The layer that decides one section name. -/
def nearest (l : List Layer) (n : String) : Option Layer :=
  pick (hits l n)

/-- The body a section name resolves to. `none` means no layer contributes the
name; the assembly then omits the section rather than failing. -/
def merge (l : List Layer) (n : String) : Option String :=
  (nearest l n).map (fun x => x.body)

/-- Register one section in one layer. A second registration of the same name
at the same depth is rejected, as `NamedEntries.insert` throws. -/
def register (l : List Layer) (x : Layer) : Except String (List Layer) :=
  if l.any (fun y => decide (y.depth = x.depth ∧ y.name = x.name)) = true then
    .error s!"prompt section \"{x.name}\" is already registered in this scope"
  else
    .ok (l ++ [x])

theorem pick_none_iff {l : List Layer} : pick l = none ↔ l = [] := by
  constructor
  · intro h
    cases l with
    | nil => rfl
    | cons x xs =>
        rw [pick_cons x xs] at h
        cases hx : pick xs with
        | none => simp [hx] at h
        | some y =>
            by_cases hle : x.depth ≤ y.depth <;> simp [hx, hle] at h
  · intro h
    subst h
    rfl

theorem pick_mem {l : List Layer} {x : Layer} (h : pick l = some x) : x ∈ l := by
  induction l with
  | nil => simp [pick] at h
  | cons hd tl ih =>
      rw [pick_cons hd tl] at h
      cases htl : pick tl with
      | none =>
          simp [htl] at h
          subst h
          exact List.mem_cons_self
      | some y =>
          by_cases hle : hd.depth ≤ y.depth
          · simp [htl, hle] at h
            subst h
            exact List.mem_cons_of_mem hd (ih htl)
          · simp [htl, hle] at h
            subst h
            exact List.mem_cons_self

theorem pick_max {l : List Layer} {x : Layer} (h : pick l = some x) :
    ∀ y ∈ l, y.depth ≤ x.depth := by
  induction l generalizing x with
  | nil => simp [pick] at h
  | cons hd tl ih =>
      rw [pick_cons hd tl] at h
      cases htl : pick tl with
      | none =>
          have hx : hd = x := by simpa [htl] using h
          rw [← hx]
          intro y hy
          rcases List.mem_cons.mp hy with rfl | hy
          · exact Nat.le_refl _
          · rw [pick_none_iff.mp htl] at hy
            simp at hy
      | some z =>
          by_cases hle : hd.depth ≤ z.depth
          · have hx : z = x := by simpa [htl, hle] using h
            rw [← hx]
            intro y hy
            rcases List.mem_cons.mp hy with rfl | hy
            · exact hle
            · exact ih htl y hy
          · have hx : hd = x := by simpa [htl, hle] using h
            rw [← hx]
            intro y hy
            rcases List.mem_cons.mp hy with rfl | hy
            · exact Nat.le_refl _
            · exact Nat.le_trans (ih htl y hy) (Nat.le_of_lt (Nat.lt_of_not_le hle))

/-- `pick` returns the unique element of greatest depth when depths are
distinct, so the result is fixed by the depths and not by list order. -/
theorem pick_spec {l : List Layer} {x : Layer}
    (huniq : ∀ a ∈ l, ∀ b ∈ l, a.depth = b.depth → a = b) :
    pick l = some x ↔ x ∈ l ∧ ∀ y ∈ l, y.depth ≤ x.depth := by
  constructor
  · intro h
    exact ⟨pick_mem h, pick_max h⟩
  · rintro ⟨hmem, hmax⟩
    cases hp : pick l with
    | none =>
        rw [pick_none_iff.mp hp] at hmem
        simp at hmem
    | some z =>
        have hzmem : z ∈ l := pick_mem hp
        have hzmax : ∀ y ∈ l, y.depth ≤ z.depth := pick_max hp
        have hdz : x.depth = z.depth := Nat.le_antisymm (hzmax x hmem) (hmax z hzmem)
        have hxz : x = z := huniq x hmem z hzmem hdz
        simp [hxz]

/-- The registration of greatest depth decides the section, so a scoped
contribution shadows a global one of the same name and an ancestor's
contribution is shadowed by a nearer scope's. -/
theorem nearest_layer_wins {l : List Layer} {x : Layer} {n : String}
    (huniq : UniquePerDepth l) (hx : x ∈ l) (hname : x.name = n)
    (hmax : ∀ y ∈ l, y.name = n → y.depth ≤ x.depth) :
    merge l n = some x.body := by
  have hxHits : x ∈ hits l n := by
    simp [hits, hx, hname]
  have hmaxHits : ∀ y ∈ hits l n, y.depth ≤ x.depth := by
    intro y hy
    have hy' : y ∈ l ∧ y.name = n := by simpa [hits] using hy
    exact hmax y hy'.1 hy'.2
  have huniqHits : ∀ a ∈ hits l n, ∀ b ∈ hits l n, a.depth = b.depth → a = b := by
    intro a ha b hb hd
    have ha' : a ∈ l ∧ a.name = n := by simpa [hits] using ha
    have hb' : b ∈ l ∧ b.name = n := by simpa [hits] using hb
    exact huniq a ha'.1 b hb'.1 hd (ha'.2.trans hb'.2.symm)
  have hp : pick (hits l n) = some x := (pick_spec huniqHits).mpr ⟨hxHits, hmaxHits⟩
  simp [merge, nearest, hp]

/-- A name no layer contributes resolves to nothing; no default body is
invented for it. -/
theorem absent_section_is_absent {l : List Layer} {n : String}
    (h : ∀ x ∈ l, x.name ≠ n) : merge l n = none := by
  have hnil : hits l n = [] := by
    rw [hits, List.filter_eq_nil_iff]
    intro a ha hdec
    exact h a ha (of_decide_eq_true hdec)
  show (pick (hits l n)).map (fun x => x.body) = none
  rw [hnil]
  rfl

/-- Registering a name that the same layer already holds is rejected, so one
depth never contributes two bodies for one name. -/
theorem duplicate_in_layer_rejected {l : List Layer} {x y : Layer}
    (hy : y ∈ l) (hname : y.name = x.name) (hdepth : y.depth = x.depth) :
    ∃ msg, register l x = .error msg := by
  have hany : l.any (fun z => decide (z.depth = x.depth ∧ z.name = x.name)) = true := by
    apply List.any_eq_true.mpr
    exact ⟨y, hy, by simp [hname, hdepth]⟩
  refine ⟨s!"prompt section \"{x.name}\" is already registered in this scope", ?_⟩
  unfold register
  rw [ite_eq_left hany]

/-- A successful registration keeps the layer list unique per depth, which is
the hypothesis the merge theorems rely on. -/
theorem register_ok_unique {l : List Layer} {x : Layer} {l' : List Layer}
    (huniq : UniquePerDepth l) (h : register l x = .ok l') : UniquePerDepth l' := by
  unfold register at h
  split at h
  · simp at h
  · rename_i hnot
    simp only [Except.ok.injEq] at h
    subst h
    intro a ha b hb hd hn
    have ha' : a ∈ l ∨ a = x := by simpa using ha
    have hb' : b ∈ l ∨ b = x := by simpa using hb
    rcases ha' with ha' | hax
    · rcases hb' with hb' | hbx
      · exact huniq a ha' b hb' hd hn
      · exfalso
        apply hnot
        have hany : l.any (fun z => decide (z.depth = x.depth ∧ z.name = x.name)) = true := by
          rw [List.any_eq_true]
          refine ⟨a, ha', ?_⟩
          simp [hd, hbx, hn]
        exact hany
    · rcases hb' with hb' | hbx
      · exfalso
        apply hnot
        have hany : l.any (fun z => decide (z.depth = x.depth ∧ z.name = x.name)) = true := by
          rw [List.any_eq_true]
          refine ⟨b, hb', ?_⟩
          simp [← hd, ← hn, hax]
        exact hany
      · rw [hax, hbx]

/-- Reordering layers does not change the resolved body.

Every reordering qualifies when the layers are `UniquePerDepth`: the winner is
the registration at the greatest depth, and at most one registration holds a
name at that depth, so position decides nothing and depth order need not be
preserved. The hypothesis is what `register` maintains. Without it a repeated
`(name, depth)` pair makes `pick` keep the later one; then a reordering
qualifies exactly when it leaves the same registration last among the
name-matching registrations of greatest depth. -/
theorem merge_order_independent {l l' : List Layer} {n : String}
    (huniq : UniquePerDepth l) (hperm : l.Perm l') :
    merge l n = merge l' n := by
  have huniq' : UniquePerDepth l' := by
    intro a ha b hb hd hn
    exact huniq a (hperm.mem_iff.mpr ha) b (hperm.mem_iff.mpr hb) hd hn
  have hpermHits : List.Perm (hits l n) (hits l' n) :=
    hperm.filter (fun (x : Layer) => decide (x.name = n))
  unfold merge nearest
  cases hp : pick (hits l n) with
  | none =>
      have hnil : hits l n = [] := pick_none_iff.mp hp
      have hnil' : hits l' n = [] := by
        rw [hnil] at hpermHits
        exact hpermHits.symm.eq_nil
      simp [hnil', pick]
  | some x =>
      have hxHits : x ∈ hits l n := pick_mem hp
      have hmaxHits : ∀ y ∈ hits l n, y.depth ≤ x.depth := pick_max hp
      have hx' : x ∈ l ∧ x.name = n := by simpa [hits] using hxHits
      have hxHits' : x ∈ hits l' n := by
        simp [hits, hperm.mem_iff.mp hx'.1, hx'.2]
      have hmaxHits' : ∀ y ∈ hits l' n, y.depth ≤ x.depth := by
        intro y hy
        have hy' : y ∈ l' ∧ y.name = n := by simpa [hits] using hy
        exact hmaxHits y (by simp [hits, hperm.mem_iff.mpr hy'.1, hy'.2])
      have huniqHits' : ∀ a ∈ hits l' n, ∀ b ∈ hits l' n, a.depth = b.depth → a = b := by
        intro a ha b hb hd
        have ha' : a ∈ l' ∧ a.name = n := by simpa [hits] using ha
        have hb' : b ∈ l' ∧ b.name = n := by simpa [hits] using hb
        exact huniq' a ha'.1 b hb'.1 hd (ha'.2.trans hb'.2.symm)
      have hp' : pick (hits l' n) = some x :=
        (pick_spec huniqHits').mpr ⟨hxHits', hmaxHits'⟩
      simp [hp']

/-- Without `UniquePerDepth` the tie-break is positional: of two registrations
at one depth the later one wins, which is the state `register` rejects. -/
theorem pick_later_of_equal_depth {a b : Layer} (hdepth : a.depth = b.depth) :
    pick [a, b] = some b := by
  simp [pick, hdepth]

end Omd.Dsh.Prompt
