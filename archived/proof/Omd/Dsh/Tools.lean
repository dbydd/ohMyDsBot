/-
The dsh tool registry and tool-call pipeline.

Source: `refs/deepseek-harness/packages/core/tools/src/index.ts` and
`refs/deepseek-harness/packages/core/tools/README.md`, at commit
687f282e8625c6b8d11ff58211a90524be2e4317. The scope rule this module restates
is also stated in `refs/deepseek-harness/docs/glossary.md` under "shadowing"
and in `refs/deepseek-harness/docs/subsystems/tools.md`, which reproduces the
registry's JSDoc.

Modelled:

* Registration. A tool is a model-facing name owned by one scope layer
  (`ToolRuntime.register` inserting into `ToolLayer.tools`). A second
  registration under a name the same layer already holds throws; the same name
  in a different layer is a different slot and is accepted (`register`).
* Lookup. `ToolRuntime.view` builds the inherited surface farthest-ancestor
  first and lets a nearer layer overwrite a same-name entry, then adds the
  scope's own registrations; `get(name, scope)` reads that map, so one scope
  sees one definition per name and the nearest registration wins (`findAt`,
  `resolve`).
* The call pipeline. `prepareScheduledExecution` runs the `tools/pre-execute`
  waterfall and then the monotonic guards, `dispatchScheduledExecution` runs
  `tools/execute` around the body, `finalizeScheduledExecution` runs
  `tools/post-execute`, and `finishScheduledExecution` emits the observe-only
  `tools/result`. `ToolGuard` returns a denial reason or `undefined` and has no
  allow result, so a guard denial cannot be turned back into permission
  (`preExecute`, `guards`, `execute`, `postExecute`, `result`, `run`).

Deliberately outside the model:

* Argument and output schemas: `defineTool`'s schema DSL,
  `assertSupportedJsonSchema`, `validateArgs`, `validateJsonSchemaValue`, and
  `ToolOutputError`. A modelled call carries its name only, and a registration
  is its name and scope: the `execute` body, `timeoutMs`, `isConcurrencySafe`,
  and `output` are not represented.
* Presentation: the `native` / `ptc` modes, the reserved `run_code` transport,
  the generated SDK, `deferLoading`, `presentCall` / `presentResult`, and the
  `presentAs` override.
* Asynchronous dispatch: the promise waterfall, `AbortSignal` fusion,
  `ABORTED_BEFORE_DISPATCH` / `ABORTED`, `timeoutMs`, and the
  `parallel` / `exclusive` scheduler. Every stage here is synchronous and total.
* Post-execute over a failure: `finalizeScheduledExecution` still runs
  `tools/post-execute` for a denied or failed call (a `post-result`); it may
  replace the content but may not replace a failed result's value. The model
  makes a denial absorbing and a body failure a denial, so the outcome class
  (still a failure) survives while content replacement does not.
* Restrictions: `ctx.tools.restrict` filters the inherited surface per scope
  (`ToolView.visible`, `ToolLayer.admits`) and is absent here, so resolution is
  registration-only.
* Registry plumbing: the disposer returned by `register`, `ScopedLayers` chain
  construction, `tools/change`, content projectors and finalizers,
  `additionalContexts`, and durable result materialization.

Scopes are modelled as natural numbers, `0` being the global layer; the layer
chain is linear, as `ScopedLayers.chainLayers` makes it, so "the caller's scope
or an ancestor" is `≤`.
-/
import Omd.Basic

namespace Omd.Dsh.Tools

/-! ## The registry -/

/-- One registration: a model-facing name and the scope layer that owns it. -/
structure Tool where
  name : String
  scope : Nat
  deriving DecidableEq, Repr

/-- Whether `l` already holds `t`'s name in `t`'s own scope. -/
def duplicate (l : List Tool) (t : Tool) : Bool :=
  l.any fun u => u.name == t.name && u.scope == t.scope

theorem duplicate_iff {l : List Tool} {t : Tool} :
    duplicate l t = true ↔ ∃ u ∈ l, u.name = t.name ∧ u.scope = t.scope := by
  simp [duplicate, List.any_eq_true, Bool.and_eq_true]

/-- Register one tool into the calling layer. The same name in another layer is
a different slot; only a name the layer already owns is rejected. -/
def register (l : List Tool) (t : Tool) : Except String (List Tool) :=
  if duplicate l t then
    .error s!"tool \"{t.name}\" is already registered in scope {t.scope}"
  else
    .ok (t :: l)

/-- A duplicate name in the same scope is refused, so a registered layer never
holds two tools under one name at one depth. -/
theorem duplicate_same_scope_rejected {l : List Tool} {t : Tool}
    (h : ∃ u ∈ l, u.name = t.name ∧ u.scope = t.scope) :
    ∃ msg, register l t = .error msg := by
  have hd : duplicate l t = true := duplicate_iff.mpr h
  cases hreg : register l t with
  | error msg => exact ⟨msg, rfl⟩
  | ok l' =>
    exfalso
    simp [register, hd] at hreg

/-- The same name at another scope is a different slot: registration succeeds
and keeps the existing tool. -/
theorem register_allows_other_scope {l : List Tool} {u t : Tool}
    (hfresh : ∀ x ∈ l, x.name = t.name → x.scope ≠ t.scope)
    (hname : u.name = t.name) (hscope : u.scope ≠ t.scope) :
    register (u :: l) t = .ok (t :: u :: l) := by
  have hdup : duplicate (u :: l) t = false := by
    simp [duplicate, hname, hscope]
    exact hfresh
  simp [register, hdup]

/-! ## Resolution -/

/-- The tool registered under `n` in exactly scope `k`, if any. -/
def findAt : List Tool → String → Nat → Option Tool
  | [], _, _ => none
  | t :: rest, n, k =>
      if t.name = n ∧ t.scope = k then some t else findAt rest n k

theorem findAt_cons_some {t : Tool} {rest : List Tool} {n : String} {k : Nat}
    (h : t.name = n ∧ t.scope = k) : findAt (t :: rest) n k = some t := by
  simp only [findAt]
  rw [ite_eq_left h]

theorem findAt_cons_none {t : Tool} {rest : List Tool} {n : String} {k : Nat}
    (h : ¬ (t.name = n ∧ t.scope = k)) : findAt (t :: rest) n k = findAt rest n k := by
  simp only [findAt]
  rw [ite_eq_right h]

theorem findAt_spec {l : List Tool} {n : String} {k : Nat} {t : Tool}
    (h : findAt l n k = some t) : t ∈ l ∧ t.name = n ∧ t.scope = k := by
  induction l with
  | nil => simp [findAt] at h
  | cons u rest ih =>
    by_cases hc : u.name = n ∧ u.scope = k
    · rw [findAt_cons_some hc] at h
      have hut : u = t := by injection h
      subst hut
      exact ⟨by simp, hc.1, hc.2⟩
    · rw [findAt_cons_none hc] at h
      obtain ⟨hm, hn, hk⟩ := ih h
      exact ⟨List.mem_cons_of_mem u hm, hn, hk⟩

theorem findAt_isSome {l : List Tool} {n : String} {k : Nat} {u : Tool}
    (hu : u ∈ l) (hn : u.name = n) (hk : u.scope = k) : (findAt l n k).isSome = true := by
  induction l with
  | nil => simp at hu
  | cons w rest ih =>
    by_cases hc : w.name = n ∧ w.scope = k
    · rw [findAt_cons_some hc]
      simp
    · rw [findAt_cons_none hc]
      rcases List.mem_cons.mp hu with rfl | hmem
      · exact absurd ⟨hn, hk⟩ hc
      · exact ih hmem

theorem findAt_none {l : List Tool} {n : String} {k : Nat} :
    findAt l n k = none → ∀ u ∈ l, u.name = n → u.scope ≠ k := by
  induction l with
  | nil => intro h u hu; simp at hu
  | cons w rest ih =>
    intro h u hu hn hk
    by_cases hc : w.name = n ∧ w.scope = k
    · rw [findAt_cons_some hc] at h
      simp at h
    · rw [findAt_cons_none hc] at h
      rcases List.mem_cons.mp hu with rfl | hmem
      · exact hc ⟨hn, hk⟩
      · exact ih h u hmem hn hk

/-- The tool a caller at scope `s` sees under name `n`. Lookup starts at the
caller's own depth and walks down the chain, so the nearest registration at or
above the caller wins; a registration deeper than the caller is invisible. -/
def resolve : List Tool → Nat → String → Option Tool
  | l, 0, n => findAt l n 0
  | l, k + 1, n =>
      match findAt l n (k + 1) with
      | some t => some t
      | none => resolve l k n

theorem resolve_zero (l : List Tool) (n : String) : resolve l 0 n = findAt l n 0 := rfl

theorem resolve_succ {l : List Tool} {n : String} (k : Nat) :
    resolve l (k + 1) n =
      (match findAt l n (k + 1) with
       | some t => some t
       | none => resolve l k n) := rfl

theorem resolve_succ_some (l : List Tool) (n : String) (k : Nat) {t : Tool}
    (h : findAt l n (k + 1) = some t) : resolve l (k + 1) n = some t := by
  rw [resolve_succ, h]

theorem resolve_succ_none (l : List Tool) (n : String) (k : Nat)
    (h : findAt l n (k + 1) = none) : resolve l (k + 1) n = resolve l k n := by
  rw [resolve_succ, h]

theorem resolve_spec {l : List Tool} {s : Nat} {n : String} {t : Tool}
    (h : resolve l s n = some t) : t ∈ l ∧ t.name = n ∧ t.scope ≤ s := by
  induction s generalizing t with
  | zero =>
    rw [resolve_zero] at h
    obtain ⟨hm, hn, hk⟩ := findAt_spec h
    exact ⟨hm, hn, by omega⟩
  | succ k ih =>
    cases hf : findAt l n (k + 1) with
    | none =>
      rw [resolve_succ_none l n k hf] at h
      obtain ⟨hm, hn, hk⟩ := ih h
      exact ⟨hm, hn, by omega⟩
    | some b =>
      rw [resolve_succ_some l n k hf] at h
      have hbt : b = t := by injection h
      subst hbt
      obtain ⟨hm, hn, hk⟩ := findAt_spec hf
      exact ⟨hm, hn, by omega⟩

/-- A name that some visible tool carries always resolves to something. -/
theorem resolve_isSome {l : List Tool} {n : String} {v : Tool}
    (hv : v ∈ l) (hn : v.name = n) : ∀ s, v.scope ≤ s → (resolve l s n).isSome = true := by
  intro s
  induction s with
  | zero =>
    intro hs
    rw [resolve_zero]
    exact findAt_isSome hv hn (by omega)
  | succ k ih =>
    intro hs
    cases hf : findAt l n (k + 1) with
    | some b =>
      rw [resolve_succ_some l n k hf]
      simp
    | none =>
      rw [resolve_succ_none l n k hf]
      have hne : v.scope ≠ k + 1 := findAt_none hf v hv hn
      exact ih (by omega)

/-- Resolution lands on a tool at the highest scope no deeper than the caller. -/
theorem resolve_nearest {l : List Tool} {n : String} {u : Tool}
    (hu : u ∈ l) (hn : u.name = n) :
    ∀ {s : Nat} {t : Tool}, resolve l s n = some t → u.scope ≤ s → u.scope ≤ t.scope := by
  intro s
  induction s with
  | zero =>
    intro t h hs
    rw [resolve_zero] at h
    obtain ⟨-, -, hk⟩ := findAt_spec h
    omega
  | succ k ih =>
    intro t h hs
    cases hf : findAt l n (k + 1) with
    | some b =>
      rw [resolve_succ_some l n k hf] at h
      have hbt : b = t := by injection h
      subst hbt
      obtain ⟨-, -, hk⟩ := findAt_spec hf
      omega
    | none =>
      rw [resolve_succ_none l n k hf] at h
      have hne : u.scope ≠ k + 1 := findAt_none hf u hu hn
      exact ih h (by omega)

/-- The nearest-scope rule: if `t` is the only tool named `n` at the shallowest
scope visible to a caller at `c`, then `resolve` answers `t`. `hnearest` says
nothing visible sits nearer; `hslot` is the registry invariant that a
(name, scope) slot holds at most one tool. -/
theorem nearest_scope_wins {l : List Tool} {n : String} {c : Nat} {t : Tool}
    (ht : t ∈ l) (hn : t.name = n) (hc : t.scope ≤ c)
    (hnearest : ∀ v ∈ l, v.name = n → v.scope ≤ c → v.scope ≤ t.scope)
    (hslot : ∀ v ∈ l, v.name = n → v.scope = t.scope → v = t) :
    resolve l c n = some t := by
  have hs : (resolve l c n).isSome = true := resolve_isSome ht hn c hc
  cases hr : resolve l c n with
  | none =>
    rw [hr] at hs
    simp at hs
  | some b =>
    have hspec : b ∈ l ∧ b.name = n ∧ b.scope ≤ c := resolve_spec hr
    have h1 : t.scope ≤ b.scope := resolve_nearest ht hn hr hc
    have h2 : b.scope ≤ t.scope := hnearest b hspec.1 hspec.2.1 hspec.2.2
    have hb : b = t := hslot b hspec.1 hspec.2.1 (by omega)
    rw [hb]

theorem resolve_skip {l : List Tool} {n : String} {t : Tool} :
    ∀ {c : Nat}, (∀ k, k ≤ c → findAt (t :: l) n k = findAt l n k) →
      resolve (t :: l) c n = resolve l c n := by
  intro c
  induction c with
  | zero =>
    intro h
    rw [resolve_zero, resolve_zero, h 0 (Nat.le_refl 0)]
  | succ k ih =>
    intro h
    have hk : findAt (t :: l) n (k + 1) = findAt l n (k + 1) := h (k + 1) (Nat.le_refl _)
    cases hf : findAt l n (k + 1) with
    | none =>
      rw [resolve_succ_none (t :: l) n k (by rw [hk, hf]), resolve_succ_none l n k hf]
      exact ih (fun j hj => h j (by omega))
    | some b =>
      rw [resolve_succ_some (t :: l) n k (by rw [hk, hf]), resolve_succ_some l n k hf]

/-- A registration deeper than the caller leaves that caller's answer alone. -/
theorem resolve_above {l : List Tool} {t : Tool} {n : String} {c : Nat}
    (h : c < t.scope) : resolve (t :: l) c n = resolve l c n :=
  resolve_skip fun _ hk => findAt_cons_none fun hc => by omega

/-- Registering one tool changes resolution for that name only. -/
theorem unrelated_names_unaffected {l : List Tool} {t : Tool} {n m : String} {c : Nat}
    (hname : t.name = n) (hne : m ≠ n) : resolve (t :: l) c m = resolve l c m :=
  resolve_skip fun _ _ =>
    findAt_cons_none fun hc => hne (hc.1.symm.trans hname)

/-- A tool registered at or above the caller, with nothing same-named nearer,
is the answer for that caller. -/
theorem resolve_cons_own {l : List Tool} {n : String} {t : Tool} :
    ∀ {c : Nat}, t.name = n → t.scope ≤ c →
      (∀ v ∈ l, v.name = n → v.scope ≤ c → v.scope ≤ t.scope) →
      resolve (t :: l) c n = some t := by
  intro c
  induction c with
  | zero =>
    intro hn hc _
    have hsc : t.scope = 0 := by omega
    rw [resolve_zero, findAt_cons_some (rest := l) ⟨hn, hsc⟩]
  | succ k ih =>
    intro hn hc hmax
    by_cases hle : t.scope ≤ k
    · have hne : ¬ (t.name = n ∧ t.scope = k + 1) := by
        intro hc'
        omega
      have hnone : findAt l n (k + 1) = none := by
        cases hf : findAt l n (k + 1) with
        | none => rfl
        | some b =>
          obtain ⟨hm, hbn, hbk⟩ := findAt_spec hf
          have := hmax b hm hbn (by omega)
          omega
      have hfail : findAt (t :: l) n (k + 1) = none := by
        rw [findAt_cons_none (rest := l) hne, hnone]
      rw [resolve_succ_none (t :: l) n k hfail]
      exact ih hn hle fun v hv hvn hvc => hmax v hv hvn (by omega)
    · have hsc : t.scope = k + 1 := by omega
      rw [resolve_succ (l := t :: l) (n := n) k,
        findAt_cons_some (rest := l) ⟨hn, hsc⟩]

/-- Shadowing is scoped. Registering `nearer` under a name the parent layer also
holds changes what a caller at `nearer`'s depth or deeper resolves, and leaves a
caller above `nearer` with exactly the answer it had. -/
theorem shadowing_is_scoped {l : List Tool} {nearer : Tool} {n : String} {c p : Nat}
    (hnear : nearer.name = n) (hp : p < nearer.scope) (hc : nearer.scope ≤ c)
    (hmax : ∀ v ∈ l, v.name = n → v.scope ≤ c → v.scope ≤ nearer.scope) :
    resolve (nearer :: l) c n = some nearer ∧
      resolve (nearer :: l) p n = resolve l p n :=
  ⟨resolve_cons_own hnear hc hmax, resolve_above hp⟩

/-! ## The call pipeline -/

/-- One tool call as the pipeline sees it: the name the model asked for.
Arguments are outside the model. -/
structure Call where
  name : String
  deriving DecidableEq, Repr

/-- What the pipeline carries between stages: a call still dispatchable, a call
a stage settled as denied with a reason, or the value a body produced. -/
inductive State where
  | pending (c : Call)
  | denied (reason : String)
  | accepted (value : String)
  deriving DecidableEq, Repr

/-- One pipeline stage; denial is a settled state, not a value. -/
def Stage := State → State

/-- `tools/pre-execute`: the extensible allow/deny gate. -/
def preExecute (decide : Call → Option String) : Stage :=
  fun s =>
    match s with
    | .pending c =>
        match decide c with
        | some r => .denied r
        | none => .pending c
    | other => other

/-- The first guard that denies, in registration order. -/
def firstDenial : List (Call → Option String) → Call → Option String
  | [], _ => none
  | g :: gs, c =>
      match g c with
      | some r => some r
      | none => firstDenial gs c

/-- The monotonic guards, run after the gate. A guard returns a reason or
nothing; it has no allow result, so it can only add a denial. -/
def guards (gs : List (Call → Option String)) : Stage :=
  fun s =>
    match s with
    | .pending c =>
        match firstDenial gs c with
        | some r => .denied r
        | none => .pending c
    | other => other

/-- `tools/execute`: the tool body, whose failure is a denial. -/
def execute (body : Call → Except String String) : Stage :=
  fun s =>
    match s with
    | .pending c =>
        match body c with
        | .ok v => .accepted v
        | .error e => .denied e
    | other => other

/-- `tools/post-execute`: may replace an accepted value or block it. It only
sees a value the body produced. -/
def postExecute (decide : String → Except String String) : Stage :=
  fun s =>
    match s with
    | .accepted v =>
        match decide v with
        | .ok v' => .accepted v'
        | .error e => .denied e
    | other => other

/-- `tools/result`: observe only, so it changes nothing. -/
def result : Stage := fun s => s

/-- The five stages of one call, in the order the registry runs them. -/
def pipeline (pre gs ex post : Stage) : List Stage := [pre, gs, ex, post, result]

/-- Run stages left to right, threading the state. -/
def run : List Stage → State → State
  | [], s => s
  | f :: fs, s => run fs (f s)

/-- The stages run in exactly the declared order: pre-execute, then the guards,
then the body, then post-execute, and `tools/result` receives what those four
produced. -/
theorem stage_order_fixed (pre gs ex post : Stage) (s : State) :
    run (pipeline pre gs ex post) s = result (post (ex (gs (pre s)))) := rfl

/-- The order is not bookkeeping: swapping two stages over one call changes the
outcome, because post-execute only ever sees a value the body produced. -/
theorem stage_order_is_load_bearing :
    ∃ (ex post : Stage) (s : State), run [ex, post] s ≠ run [post, ex] s := by
  refine ⟨execute (fun _ => .ok "v"), postExecute (fun _ => .error "blocked"),
    State.pending ⟨"echo"⟩, ?_⟩
  intro h
  exact State.noConfusion h

/-- A guard denial settles the call there and then. -/
theorem guards_deny_of_head (g : Call → Option String) (gs : List (Call → Option String))
    (c : Call) (r : String) (h : g c = some r) :
    guards (g :: gs) (.pending c) = .denied r := by
  simp [guards, firstDenial, h]

/-- The guard stage has no allow result: over a pending call it either denies or
leaves the call as it was, and over a settled state it does nothing. -/
theorem guards_only_deny (gs : List (Call → Option String)) (s : State) :
    guards gs s = s ∨ ∃ r, guards gs s = .denied r := by
  cases s with
  | pending c =>
    cases hf : firstDenial gs c with
    | none => exact Or.inl (by simp [guards, hf])
    | some r => exact Or.inr ⟨r, by simp [guards, hf]⟩
  | denied r => exact Or.inl (by simp [guards])
  | accepted w => exact Or.inl (by simp [guards])

/-- Once a guard denies, the stages after it keep the denial: the body does not
run, post-execute has nothing to replace, and `tools/result` only observes. -/
theorem guard_denial_irreversible (pre : Stage) (gs : List (Call → Option String))
    (body : Call → Except String String) (post : String → Except String String)
    (s : State) (r : String) (h : guards gs (pre s) = .denied r) :
    run (pipeline pre (guards gs) (execute body) (postExecute post)) s = .denied r := by
  rw [stage_order_fixed, h]
  rfl

/-- No later stage turns a guard denial into an allowed value. -/
theorem no_value_after_guard_denial (pre : Stage) (gs : List (Call → Option String))
    (body : Call → Except String String) (post : String → Except String String)
    (s : State) (r v : String) (h : guards gs (pre s) = .denied r) :
    run (pipeline pre (guards gs) (execute body) (postExecute post)) s ≠ .accepted v := by
  rw [guard_denial_irreversible pre gs body post s r h]
  intro hc
  exact State.noConfusion hc

end Omd.Dsh.Tools
