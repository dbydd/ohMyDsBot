/-
The shape of one model request: three parts, and where each part may come from.

Sources (commit 687f282e8625c6b8d11ff58211a90524be2e4317):

* `packages/core/system-prompt/src/index.ts` — `PromptAssembly` is the assembled
  model input: `sections`, `contexts`, `tools`, `variables`. `assemble` merges
  the global layer with the calling scope's layer, where "a scoped section
  shadows a global section with the same name" (`section`), then sorts the
  surviving definitions by `order` and name.
* `packages/core/tools/README.md` — the registry "projects" its definitions onto
  the model-facing `ToolSchema` set "at request time"; `ctx.tools.schemas(scope)`
  returns "the visible schemas without the `execute` functions"; and
  `ctx.tools.restrict(filter)` may narrow what an agent inherits — "masks
  intersect, scoped registrations stay visible, and the restriction lifts when
  disposed." `packages/core/tools/src/index.ts` (`ToolRuntime.view`) derives that
  view: inherited definitions keep the nearest same-name entry along the scope
  chain, restrictions filter only inherited names, and the scope's own
  registrations are added outside the filter without deleting a registration.
* `AGENTS.md:136-137` — "Model-visible ⟺ logged": anything that reaches a model
  request must be reconstructable from the session log; a new model-visible
  input requires a session event.

Modelled here: a request has three parts, `sections`, `tools`, and `history`.
`sectionsFrom` resolves one body per section name from the nearest layer on the
chain, `toolsFrom` resolves one registration per tool name at or above the
scope, `restrict` removes resolved tools and nothing else, and `Request.assemble`
is the only constructor, so every part of a request traces to data the caller
supplied. A registration is modelled as a name plus its defining depth, a
section body as an opaque `String`, and a tool body not at all.

Deliberately outside the model:

* Section ordering (`order`, then code-unit name order), `complete` sections,
  prompt-variable interpolation, runtime contexts, and the
  `system-prompt/assemble` waterfall.
* Section and tool bodies: text providers, descriptions, parameter schemas,
  `execute`, and the presentation-mode collapse (`native`/`ptc`).
* The registry's own validations: `restrict` refusing an unscoped context,
  `restrict({})`, the reserved `run_code`, and unknown global names all throw in
  the source. Registrations are never deleted, which the model states by never
  removing an entry from its inputs.
* `restrict`'s own-layer exemption: here it filters the resolved list, so the
  model cannot tell an inherited registration from the scope's own.
* Chain membership: the caller passes the chain (`chainLayers`); the model only
  checks `depth ≤ scope`, so a caller supplying an unrelated shallower layer
  would have it counted.
* The session log: `history` is the caller-supplied projection, unchanged.
* Everything the loop or the adapter adds after assembly: model route, token
  budget (`maxTokens`), temperature, and adapter-owned `reasoningEffort` /
  `maxTokens` defaults.
-/
import Omd.Basic

namespace Omd.Dsh

/-- One registry layer. `depth` is the layer's place on the scope chain: `0` is
the global layer, and a larger depth is nearer to the requesting scope. A
layer's registrations are defined at the layer's own depth. -/
structure Layer where
  depth : Nat
  sections : List (String × String)
  tools : List String
  deriving Repr, DecidableEq

/-! ## Name bookkeeping -/

/-- Whether `n` occurs in `l`, decided on `String` equality. -/
def hasName : List String → String → Bool
  | [], _ => false
  | m :: ms, n => decide (m = n) || hasName ms n

theorem hasName_eq_true_iff {l : List String} {n : String} :
    hasName l n = true ↔ n ∈ l := by
  induction l with
  | nil => simp [hasName]
  | cons m ms ih =>
      show (decide (m = n) || hasName ms n) = true ↔ n ∈ m :: ms
      rw [Bool.or_eq_true, decide_eq_true_eq, ih, List.mem_cons]
      constructor
      · rintro (h | h)
        · exact Or.inl h.symm
        · exact Or.inr h
      · rintro (h | h)
        · exact Or.inl h.symm
        · exact Or.inr h

/-- Keep the first occurrence of each name. The projections only need every name
to appear once; the preserved order carries no meaning. -/
def dedupNames : List String → List String
  | [] => []
  | n :: ns => if hasName ns n then dedupNames ns else n :: dedupNames ns

theorem mem_dedupNames {n : String} : ∀ {ns : List String}, n ∈ dedupNames ns ↔ n ∈ ns := by
  intro ns
  induction ns with
  | nil => simp [dedupNames]
  | cons m ms ih =>
      rw [dedupNames]
      by_cases h : hasName ms m = true
      · rw [ite_eq_left h, ih, List.mem_cons]
        constructor
        · exact Or.inr
        · rintro (rfl | hmem)
          · exact hasName_eq_true_iff.mp h
          · exact hmem
      · rw [ite_eq_right h, List.mem_cons, List.mem_cons, ih]

/-! ## Nearest registration -/

variable {β : Type}

/-- Whether to keep the head registration, given the resolved tail. The tail is
kept unless the head carries the requested name, sits at a depth not above the
scope, and is strictly nearer than the tail. Equal depths keep the later entry;
the source throws on two same-name registrations in one layer, so that case
cannot arise there. -/
def nearer (scope : Nat) (name : String) (depth : Nat) (body : β) (n : String)
    (tail : Option (Nat × β)) : Option (Nat × β) :=
  match tail with
  | none => if name = n ∧ depth ≤ scope then some (depth, body) else none
  | some (near, nearBody) =>
      if name = n ∧ depth ≤ scope ∧ near < depth then some (depth, body)
      else some (near, nearBody)

/-- The registration a scope resolves for one name: the greatest defining depth
not above the scope, with the body registered there. -/
def nearest (scope : Nat) : List (String × Nat × β) → String → Option (Nat × β)
  | [], _ => none
  | (name, depth, body) :: rest, n => nearer scope name depth body n (nearest scope rest n)

/-- A resolved entry came from an input registration at a depth not above the
scope. -/
theorem nearest_mem {scope : Nat} {regs : List (String × Nat × β)} {n : String} :
    ∀ d v, nearest scope regs n = some (d, v) → (n, d, v) ∈ regs ∧ d ≤ scope := by
  induction regs with
  | nil =>
      intro d v h
      simp [nearest] at h
  | cons p ps ih =>
      obtain ⟨m, e, w⟩ := p
      intro d v h
      cases htail : nearest scope ps n with
      | none =>
          simp only [nearest, htail, nearer] at h
          by_cases hc : m = n ∧ e ≤ scope
          · rw [ite_eq_left hc] at h
            obtain ⟨hmn, hle⟩ := hc
            have h' : (e, w) = (d, v) := Option.some.inj h
            have hd1 : e = d := congrArg Prod.fst h'
            have hv1 : w = v := congrArg Prod.snd h'
            rw [← hd1, ← hv1]
            exact ⟨by simp [hmn], hle⟩
          · rw [ite_eq_right hc] at h
            exact absurd h (by simp)
      | some q =>
          obtain ⟨near, nearBody⟩ := q
          simp only [nearest, htail, nearer] at h
          by_cases hc : m = n ∧ e ≤ scope ∧ near < e
          · rw [ite_eq_left hc] at h
            obtain ⟨hmn, hle, _⟩ := hc
            have h' : (e, w) = (d, v) := Option.some.inj h
            have hd1 : e = d := congrArg Prod.fst h'
            have hv1 : w = v := congrArg Prod.snd h'
            rw [← hd1, ← hv1]
            exact ⟨by simp [hmn], hle⟩
          · rw [ite_eq_right hc] at h
            have h' : (near, nearBody) = (d, v) := Option.some.inj h
            have hd1 : near = d := congrArg Prod.fst h'
            have hv1 : nearBody = v := congrArg Prod.snd h'
            rw [← hd1, ← hv1]
            obtain ⟨hmem, hle⟩ := ih near nearBody htail
            exact ⟨List.mem_cons_of_mem _ hmem, hle⟩

/-- A registration at or above the scope makes the resolution succeed. -/
theorem nearest_isSome {scope : Nat} {regs : List (String × Nat × β)} {n : String} {d : Nat} {v : β}
    (hmem : (n, d, v) ∈ regs) (hle : d ≤ scope) :
    (nearest scope regs n).isSome = true := by
  induction regs with
  | nil => simp at hmem
  | cons p ps ih =>
      obtain ⟨m, e, w⟩ := p
      rw [List.mem_cons] at hmem
      cases htail : nearest scope ps n with
      | none =>
          rcases hmem with hhead | htailMem
          · have hnm : m = n := (congrArg Prod.fst hhead).symm
            have hed : e = d := (congrArg (fun p => p.2.1) hhead).symm
            have hwv : w = v := (congrArg (fun p => p.2.2) hhead).symm
            rw [hnm, hed, hwv, nearest, htail, nearer,
              ite_eq_left (show n = n ∧ d ≤ scope from ⟨rfl, hle⟩)]
            rfl
          · have hsome := ih htailMem
            rw [htail] at hsome
            exact absurd hsome (by simp)
      | some q =>
          obtain ⟨near, nearBody⟩ := q
          rw [nearest, htail, nearer]
          split <;> rfl

/-- A registration at or above the scope yields a resolved entry. -/
theorem nearest_some {scope : Nat} {regs : List (String × Nat × β)} {n : String} {d : Nat} {v : β}
    (hmem : (n, d, v) ∈ regs) (hle : d ≤ scope) :
    ∃ e w, nearest scope regs n = some (e, w) := by
  have h := nearest_isSome hmem hle
  cases hres : nearest scope regs n with
  | none =>
      rw [hres] at h
      simp at h
  | some q => exact ⟨q.1, q.2, rfl⟩

/-- The resolution is nearest: no registration of the same name at or above the
scope is defined deeper than the resolved one. -/
theorem nearest_max {scope : Nat} {regs : List (String × Nat × β)} {n : String} :
    ∀ d v, nearest scope regs n = some (d, v) →
      ∀ e w, (n, e, w) ∈ regs → e ≤ scope → e ≤ d := by
  induction regs with
  | nil =>
      intro d v h
      simp [nearest] at h
  | cons p ps ih =>
      obtain ⟨m, e, w⟩ := p
      intro d v h e' w' hmem hle'
      cases htail : nearest scope ps n with
      | none =>
          simp only [nearest, htail, nearer] at h
          by_cases hc : m = n ∧ e ≤ scope
          · rw [ite_eq_left hc] at h
            obtain ⟨hmn, hle⟩ := hc
            have h' : (e, w) = (d, v) := Option.some.inj h
            have hd1 : e = d := congrArg Prod.fst h'
            rw [← hd1]
            rcases List.mem_cons.mp hmem with hhead | htailMem
            · have he' : e' = e := congrArg (fun p => p.2.1) hhead
              exact Nat.le_of_eq he'
            · have hsome := nearest_isSome htailMem hle'
              rw [htail] at hsome
              exact absurd hsome (by simp)
          · rw [ite_eq_right hc] at h
            exact absurd h (by simp)
      | some q =>
          obtain ⟨near, nearBody⟩ := q
          simp only [nearest, htail, nearer] at h
          by_cases hc : m = n ∧ e ≤ scope ∧ near < e
          · rw [ite_eq_left hc] at h
            obtain ⟨hmn, hle, hnear⟩ := hc
            have h' : (e, w) = (d, v) := Option.some.inj h
            have hd1 : e = d := congrArg Prod.fst h'
            rw [← hd1]
            rcases List.mem_cons.mp hmem with hhead | htailMem
            · have he' : e' = e := congrArg (fun p => p.2.1) hhead
              exact Nat.le_of_eq he'
            · exact Nat.le_trans (ih near nearBody htail e' w' htailMem hle')
                (Nat.le_of_lt hnear)
          · rw [ite_eq_right hc] at h
            have h' : (near, nearBody) = (d, v) := Option.some.inj h
            have hd1 : near = d := congrArg Prod.fst h'
            rw [← hd1]
            rcases List.mem_cons.mp hmem with hhead | htailMem
            · have hnm : m = n := (congrArg Prod.fst hhead).symm
              have he' : e' = e := congrArg (fun p => p.2.1) hhead
              rw [he'] at hle' ⊢
              exact Nat.le_of_not_lt (fun hlt => hc ⟨hnm, hle', hlt⟩)
            · exact ih near nearBody htail e' w' htailMem hle'

/-- One registration resolves to itself. -/
theorem nearest_single {scope d : Nat} {n : String} {b : β} (h : d ≤ scope) :
    nearest scope [(n, d, b)] n = some (d, b) := by
  simp [nearest, nearer, h]

/-- Of two registrations of one name, the nearer one resolves. -/
theorem nearest_far_near {scope d₁ d₂ : Nat} {n : String} {b₁ b₂ : β}
    (hd : d₁ < d₂) (hs : d₂ ≤ scope) :
    nearest scope [(n, d₁, b₁), (n, d₂, b₂)] n = some (d₂, b₂) := by
  have h₁ : d₁ ≤ scope := Nat.le_trans (Nat.le_of_lt hd) hs
  have hnot : ¬ d₂ < d₁ := Nat.not_lt.mpr (Nat.le_of_lt hd)
  simp [nearest, nearer, h₁, hs, hnot]

/-! ## Projections and a restriction -/

/-- Resolve each listed name once, dropping names with no registration at or
above the scope. -/
def resolveAll (scope : Nat) (regs : List (String × Nat × β)) (names : List String) :
    List (String × Nat × β) :=
  names.filterMap fun n => (nearest scope regs n).map fun p => (n, p.1, p.2)

/-- Every resolved entry for name `n` is `n`'s nearest registration. -/
theorem mem_resolveAll {scope : Nat} {regs : List (String × Nat × β)} {names : List String}
    {n : String} {d : Nat} {v : β} (h : (n, d, v) ∈ resolveAll scope regs names) :
    n ∈ names ∧ nearest scope regs n = some (d, v) := by
  rw [resolveAll, List.mem_filterMap] at h
  obtain ⟨a, ha, hf⟩ := h
  cases hnear : nearest scope regs a with
  | none =>
      rw [hnear] at hf
      simp at hf
  | some q =>
      obtain ⟨e, w⟩ := q
      rw [hnear] at hf
      simp only [Option.map_some, Option.some.injEq, Prod.mk.injEq] at hf
      obtain ⟨rfl, rfl, rfl⟩ := hf
      exact ⟨ha, hnear⟩

/-- A name whose nearest registration resolves at or above the scope produces an
entry. -/
theorem mem_resolveAll_of {scope : Nat} {regs : List (String × Nat × β)} {names : List String}
    {n : String} {d : Nat} {v : β} (hn : n ∈ names) (h : nearest scope regs n = some (d, v)) :
    (n, d, v) ∈ resolveAll scope regs names := by
  rw [resolveAll, List.mem_filterMap]
  exact ⟨n, hn, by rw [h]; rfl⟩

/-- Sections flattened with the depth of the layer that holds them. -/
def sectionRegs (ls : List Layer) : List (String × Nat × String) :=
  ls.flatMap fun l => l.sections.map fun s => (s.1, l.depth, s.2)

/-- The section part of a request: one body per name, taken from the nearest
layer on the chain. Ordering is not modelled (see the module docstring). -/
def sectionsFrom (ls : List Layer) (scope : Nat) : List (String × String) :=
  (resolveAll scope (sectionRegs ls) (dedupNames ((sectionRegs ls).map fun r => r.1))).map
    fun r => (r.1, r.2.2)

/-- Tool names flattened with the depth that defines them. -/
def registry (ls : List Layer) : List (String × Nat) :=
  ls.flatMap fun l => l.tools.map fun n => (n, l.depth)

/-- Registrations annotated for the nearest-registration projection. The tool
body is not modelled, so the annotation carries `Unit`. -/
def toolRegs (regs : List (String × Nat)) : List (String × Nat × Unit) :=
  regs.map fun p => (p.1, p.2, ())

/-- The tool part of a request: one registration per name, the nearest one at or
above the scope. -/
def toolsFrom (regs : List (String × Nat)) (scope : Nat) : List (String × Nat) :=
  (resolveAll scope (toolRegs regs) (dedupNames (regs.map fun p => p.1))).map
    fun r => (r.1, r.2.1)

/-- A per-agent allow/deny mask. `none` allows everything the scope inherits. -/
structure Restriction where
  allow : Option (List String) := none
  deny : List String := []

/-- Whether a restriction keeps a name: every allow entry must match and no deny
entry may. -/
def Restriction.admits (r : Restriction) (name : String) : Bool :=
  (match r.allow with
    | none => true
    | some allowed => hasName allowed name) && !hasName r.deny name

/-- Apply a restriction to the resolved tool list. -/
def restrict (r : Restriction) (l : List (String × Nat)) : List (String × Nat) :=
  l.filter fun p => r.admits p.1

/-! ## The request -/

/-- One model request, reduced to the parts whose origin is checkable. Bodies are
opaque and `history` is whatever the caller's log projects. -/
structure Request where
  sections : List (String × String)
  tools : List (String × Nat)
  history : List String
  deriving Repr, DecidableEq

/-- The only constructor of a request: both projections over caller-supplied
registry data, a restriction over the resolved tools, and the caller's log. -/
def Request.assemble (ls : List Layer) (scope : Nat) (log : List String)
    (mask : Restriction) : Request :=
  { sections := sectionsFrom ls scope
    tools := restrict mask (toolsFrom (registry ls) scope)
    history := log }

/-! ## The theorems -/

/-- The registry projection. Every tool the request carries is a registration at
or above the scope, no deeper registration of the same name exists, and the names
carried are exactly the names the registry exposes at that scope. -/
theorem toolsFrom_is_registry_projection (regs : List (String × Nat)) (scope : Nat) :
    (∀ p ∈ toolsFrom regs scope,
        (p.1, p.2) ∈ regs ∧ p.2 ≤ scope ∧
          ∀ e, (p.1, e) ∈ regs → e ≤ scope → e ≤ p.2) ∧
      (∀ n, (∃ d, (n, d) ∈ regs ∧ d ≤ scope) ↔
        n ∈ (toolsFrom regs scope).map (fun p => p.1)) := by
  constructor
  · intro p hp
    rw [toolsFrom, List.mem_map] at hp
    obtain ⟨r, hr, rfl⟩ := hp
    obtain ⟨_, hnear⟩ := mem_resolveAll hr
    obtain ⟨hmem, hle⟩ := nearest_mem (r.2.1) (r.2.2) hnear
    have hreg : (r.1, r.2.1) ∈ regs := by
      rw [toolRegs, List.mem_map] at hmem
      obtain ⟨q, hq, he⟩ := hmem
      obtain ⟨q1, q2⟩ := q
      simp only [Prod.mk.injEq] at he
      obtain ⟨h1, h2, -⟩ := he
      simpa [h1, h2] using hq
    refine ⟨hreg, hle, ?_⟩
    intro e he hle'
    exact nearest_max (r.2.1) (r.2.2) hnear e () (by
      rw [toolRegs, List.mem_map]
      exact ⟨(r.1, e), he, rfl⟩) hle'
  · intro n
    constructor
    · rintro ⟨d, hd, hle⟩
      have hreg : (n, d, ()) ∈ toolRegs regs := by
        rw [toolRegs, List.mem_map]
        exact ⟨(n, d), hd, rfl⟩
      obtain ⟨e, w, he⟩ := nearest_some hreg hle
      have hn : n ∈ dedupNames (regs.map fun p => p.1) := by
        rw [mem_dedupNames, List.mem_map]
        exact ⟨(n, d), hd, rfl⟩
      rw [toolsFrom]
      refine List.mem_map.mpr ⟨(n, e), ?_, rfl⟩
      exact List.mem_map.mpr ⟨(n, e, w), mem_resolveAll_of hn he, rfl⟩
    · intro hn
      simp only [toolsFrom] at hn
      obtain ⟨a, ha, hred⟩ := List.mem_map.mp hn
      obtain ⟨r, hr, rfl⟩ := List.mem_map.mp ha
      have hred' : r.1 = n := hred
      obtain ⟨_, hnear⟩ := mem_resolveAll hr
      obtain ⟨hmem, hle⟩ := nearest_mem (r.2.1) (r.2.2) hnear
      refine ⟨r.2.1, ?_, hle⟩
      rw [toolRegs, List.mem_map] at hmem
      obtain ⟨q, hq, he⟩ := hmem
      obtain ⟨q1, q2⟩ := q
      simp only [Prod.mk.injEq] at he
      obtain ⟨h1, h2, -⟩ := he
      have hq' : (r.1, r.2.1) ∈ regs := by simpa [h1, h2] using hq
      simpa [hred'] using hq'

/-- A restriction never adds a tool and never changes one: every surviving pair
is the same pair in the input list, so its name and its defining scope are
unchanged. -/
theorem restrict_only_removes (r : Restriction) (l : List (String × Nat)) :
    (∀ p, p ∈ restrict r l → p ∈ l) ∧
      (∀ n, n ∈ (restrict r l).map (fun p => p.1) → n ∈ l.map (fun p => p.1)) := by
  constructor
  · intro p hp
    exact (List.mem_filter.mp hp).1
  · intro n hn
    rw [List.mem_map] at hn
    obtain ⟨p, hp, rfl⟩ := hn
    exact List.mem_map.mpr ⟨p, (List.mem_filter.mp hp).1, rfl⟩

/-- Two registrations of one name: the request carries the nearer one, under the
same name. Sections first, since their body is the text; then tools, whose body
is the defining scope. -/
theorem nearer_body_wins {scope d₁ d₂ : Nat} {n b₁ b₂ : String} {t₁ t₂ : List String}
    (hd : d₁ < d₂) (hs : d₂ ≤ scope) :
    (n, b₂) ∈ sectionsFrom [⟨d₁, [(n, b₁)], t₁⟩, ⟨d₂, [(n, b₂)], t₂⟩] scope := by
  have hregs : sectionRegs [⟨d₁, [(n, b₁)], t₁⟩, ⟨d₂, [(n, b₂)], t₂⟩]
      = [(n, d₁, b₁), (n, d₂, b₂)] := by
    simp [sectionRegs]
  rw [sectionsFrom, hregs, List.mem_map]
  have hnear : nearest scope [(n, d₁, b₁), (n, d₂, b₂)] n = some (d₂, b₂) :=
    nearest_far_near hd hs
  have hnames : n ∈ dedupNames ([(n, d₁, b₁), (n, d₂, b₂)].map fun r => r.1) := by
    rw [mem_dedupNames, List.mem_map]
    exact ⟨(n, d₂, b₂), by simp, rfl⟩
  exact ⟨(n, d₂, b₂), mem_resolveAll_of hnames hnear, rfl⟩

/-- The tool projection resolves a nearer registration over a farther one of the
same name. -/
theorem nearer_tool_wins {scope d₁ d₂ : Nat} {n : String} (hd : d₁ < d₂) (hs : d₂ ≤ scope) :
    (n, d₂) ∈ toolsFrom [(n, d₁), (n, d₂)] scope := by
  have hnear : nearest scope (toolRegs [(n, d₁), (n, d₂)]) n = some (d₂, ()) := by
    simp only [toolRegs, List.map_cons, List.map_nil]
    exact nearest_far_near hd hs
  have hnames : n ∈ dedupNames ([(n, d₁), (n, d₂)].map fun p => p.1) := by
    rw [mem_dedupNames, List.mem_map]
    exact ⟨(n, d₂), by simp, rfl⟩
  have hmem := mem_resolveAll_of hnames hnear
  rw [toolsFrom, List.mem_map]
  exact ⟨(n, d₂, ()), hmem, rfl⟩

/-- Every part of an assembled request traces to caller-supplied data: sections
to a layer at or above the scope, tools to a registration at or above the scope,
history to the caller's log. A request has no other constructor, so it cannot
hold a part with no source. -/
theorem request_parts_are_sourced (ls : List Layer) (scope : Nat) (log : List String)
    (mask : Restriction) :
    (∀ p ∈ (Request.assemble ls scope log mask).sections,
        ∃ l ∈ ls, l.depth ≤ scope ∧ p ∈ l.sections) ∧
      (∀ p ∈ (Request.assemble ls scope log mask).tools,
        p ∈ registry ls ∧ p.2 ≤ scope) ∧
      (∀ s ∈ (Request.assemble ls scope log mask).history, s ∈ log) := by
  refine ⟨?_, ?_, ?_⟩
  · intro p hp
    simp only [Request.assemble] at hp
    rw [sectionsFrom, List.mem_map] at hp
    obtain ⟨r, hr, rfl⟩ := hp
    obtain ⟨_, hnear⟩ := mem_resolveAll hr
    obtain ⟨hmem, hle⟩ := nearest_mem (r.2.1) (r.2.2) hnear
    rw [sectionRegs, List.mem_flatMap] at hmem
    obtain ⟨l, hl, hsec⟩ := hmem
    rw [List.mem_map] at hsec
    obtain ⟨s, hs, he⟩ := hsec
    obtain ⟨s1, s2⟩ := s
    simp only [Prod.mk.injEq] at he
    obtain ⟨h1, h2, h3⟩ := he
    refine ⟨l, hl, ?_, ?_⟩
    · rw [h2]
      exact hle
    · simpa [h1, h3] using hs
  · intro p hp
    simp only [Request.assemble] at hp
    have hres := (restrict_only_removes mask (toolsFrom (registry ls) scope)).1 p hp
    rw [toolsFrom, List.mem_map] at hres
    obtain ⟨r, hr, rfl⟩ := hres
    obtain ⟨_, hnear⟩ := mem_resolveAll hr
    obtain ⟨hmem, hle⟩ := nearest_mem (r.2.1) (r.2.2) hnear
    refine ⟨?_, hle⟩
    rw [toolRegs, List.mem_map] at hmem
    obtain ⟨q, hq, he⟩ := hmem
    obtain ⟨q1, q2⟩ := q
    simp only [Prod.mk.injEq] at he
    obtain ⟨h1, h2, -⟩ := he
    simpa [h1, h2] using hq
  · intro s hs
    simpa only [Request.assemble] using hs

end Omd.Dsh
