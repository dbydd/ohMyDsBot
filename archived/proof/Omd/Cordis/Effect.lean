/-
The reversible-effect stack of one Cordis fibre.

Sources: `refs/deepseek-harness/vendor/cordis/src/fiber.ts` and
`refs/deepseek-harness/vendor/cordis/src/context.ts` of the deepseek-harness
checkout at commit `687f282e8625c6b8d11ff58211a90524be2e4317`, together with the
rule stated in `refs/deepseek-harness/packages/AGENTS.md` ("Registry
contributions prove disposal") and `refs/deepseek-harness/docs/cordis-primer.md`
("Registrations are reversible effects … unwind them predictably").

What the source does, and what this file models. `Fiber.effect(execute)` runs an
effect body immediately, collects the disposers it returns in the effect's own
list, and runs that list newest-first when the disposer is called; the fibre's
`_disposables` is a `DisposableList` whose `clear()` returns its values reversed
(`src/utils.ts`), so `Fiber._unload` tears the fibre down newest-first as well.
`ctx.on` and the service registry contribute through the same channel. So a
fibre owns an ordered stack of registrations, and teardown is that stack
disposed in reverse.

Modelled: the stack as a list of `(service key, registration id)` pairs. `Op.reg`
appends a registration and rejects a key that is already live; `Op.dispose`
removes exactly the named registration and rejects one that is absent; `unwind`
is the teardown of a program — the registrations the program leaves live, newest
first, as disposals. A program is well formed for a starting stack when its
registration keys are distinct, every disposal names a registration the same
program made earlier, the program runs (so every disposal names a *live*
registration), and no registration collides with one already on the stack.

Deliberately outside the model: effect bodies are not modelled at all (`reg` and
`dispose` stand for "this registration is on the stack" and "this registration
left it"), so async effect bodies (`Promise<Disposable>`, `AsyncIterable`, the
setup barrier and its `executing`/`setupFailed` flags in `Fiber.effect`), fibre
statuses and the `LOADING`/`UNLOADING`/`inertia` transitions, `restart`/`update`
reload paths, `isolate` and `intercept` scoping, logger effects and the
diagnostic `EffectMeta` tree, disposers that throw or reject, and reentrancy (an
effect body that registers a further effect, or a disposer called while the
stack is being unwound) are all out of scope. `_unload` runs a fibre's
disposables concurrently through `Promise.all`; this model keeps the reverse
order `DisposableList.clear` hands out and drops the concurrency.
-/
import Omd.Basic

namespace Omd.Cordis

/-- A registration: the service key it provides and its registration id. -/
abbrev Reg := String × Nat

/-- One fibre's effect stack, newest last. -/
abbrev Stack := List Reg

/-- The two operations a program performs on the stack. -/
inductive Op where
  | reg (key : String) (id : Nat)
  | dispose (key : String) (id : Nat)
  deriving DecidableEq, Repr

/-- The disposal of a registration. -/
def disposeOf (p : Reg) : Op := .dispose p.1 p.2

/-- Is the key already taken by a live registration? -/
def keyLive (k : String) : Stack → Bool
  | [] => false
  | (k', _) :: t => if k' = k then true else keyLive k t

/-- Is the named registration on the stack? -/
def hasReg (p : Reg) : Stack → Bool
  | [] => false
  | q :: t => if q = p then true else hasReg p t

/-- Drop the named registration; a missing one is left alone. -/
def eraseReg (p : Reg) : Stack → Stack
  | [] => []
  | q :: t => if q = p then t else q :: eraseReg p t

/-- Run a program on a stack. -/
def exec : Stack → List Op → Except String Stack
  | σ, [] => .ok σ
  | σ, .reg k n :: rest =>
      if keyLive k σ then .error s!"duplicate registration: {k}"
      else exec (σ ++ [(k, n)]) rest
  | σ, .dispose k n :: rest =>
      if hasReg (k, n) σ then exec (eraseReg (k, n) σ) rest
      else .error s!"absent registration: {k}#{n}"

/-- One step of a program on the stack, ignoring the duplicate and absent cases. -/
def applyOp (σ : Stack) : Op → Stack
  | .reg k n => σ ++ [(k, n)]
  | .dispose k n => eraseReg (k, n) σ

/-- The stack a program leaves behind. -/
def survives (σ : Stack) (prog : List Op) : Stack := prog.foldl applyOp σ

/-- The stack a program builds on top of the empty stack. -/
def survivors (prog : List Op) : Stack := survives [] prog

/-- The teardown of a program: its surviving registrations, newest first. -/
def unwind (prog : List Op) : List Op := (survivors prog).reverse.map disposeOf

/-- Registrations a program makes, in order. -/
def regs : List Op → Stack
  | [] => []
  | .reg k n :: rest => (k, n) :: regs rest
  | .dispose _ _ :: rest => regs rest

/-- Registrations a program disposes, in order. -/
def disposalsList : List Op → Stack
  | [] => []
  | .reg _ _ :: rest => disposalsList rest
  | .dispose k n :: rest => (k, n) :: disposalsList rest

/-! ### Stack operations -/

@[simp] theorem hasReg_nil (p : Reg) : hasReg p [] = false := rfl

@[simp] theorem hasReg_cons_eq (p : Reg) (t : Stack) : hasReg p (p :: t) = true := by
  simp [hasReg]

theorem hasReg_cons_ne {p q : Reg} (t : Stack) (h : q ≠ p) :
    hasReg p (q :: t) = hasReg p t := by
  simp [hasReg, h]

@[simp] theorem eraseReg_nil (p : Reg) : eraseReg p [] = [] := rfl

@[simp] theorem eraseReg_cons_eq (p : Reg) (t : Stack) : eraseReg p (p :: t) = t := by
  simp [eraseReg]

theorem eraseReg_cons_ne {p q : Reg} (t : Stack) (h : q ≠ p) :
    eraseReg p (q :: t) = q :: eraseReg p t := by
  simp [eraseReg, h]

theorem eraseReg_subset {p : Reg} : ∀ {σ : Stack} {q : Reg}, q ∈ eraseReg p σ → q ∈ σ := by
  intro σ
  induction σ with
  | nil => intro q h; simp at h
  | cons r t ih =>
      intro q h
      by_cases hr : r = p
      · subst hr
        rw [eraseReg_cons_eq] at h
        exact List.mem_cons_of_mem r h
      · rw [eraseReg_cons_ne t hr] at h
        rcases List.mem_cons.mp h with hq | hq
        · exact hq ▸ (by simp : r ∈ r :: t)
        · exact List.mem_cons_of_mem r (ih hq)

theorem hasReg_iff {p : Reg} {σ : Stack} : hasReg p σ = true ↔ p ∈ σ := by
  induction σ with
  | nil => simp
  | cons q t ih =>
      by_cases hq : q = p
      · subst hq
        simp
      · rw [hasReg_cons_ne t hq]
        constructor
        · exact fun h => List.mem_cons_of_mem q (ih.mp h)
        · intro h
          rcases List.mem_cons.mp h with h0 | h1
          · exact absurd h0.symm hq
          · exact ih.mpr h1

theorem hasReg_append_single (p : Reg) (σ : Stack) : hasReg p (σ ++ [p]) = true := by
  rw [hasReg_iff]
  exact List.mem_append.mpr (Or.inr (by simp))

theorem eraseReg_append_of_not_mem {p : Reg} {σ : Stack} (h : p ∉ σ) (τ : Stack) :
    eraseReg p (σ ++ τ) = σ ++ eraseReg p τ := by
  induction σ with
  | nil => simp
  | cons r t ih =>
      have hr : r ≠ p := fun he => h (he ▸ List.mem_cons_self)
      have ht : p ∉ t := fun ht => h (List.mem_cons_of_mem r ht)
      show eraseReg p (r :: (t ++ τ)) = r :: (t ++ eraseReg p τ)
      rw [eraseReg_cons_ne _ hr, ih ht]

theorem eraseReg_append_single_of_not_mem {p : Reg} {σ : Stack} (h : p ∉ σ) :
    eraseReg p (σ ++ [p]) = σ := by
  rw [eraseReg_append_of_not_mem h, eraseReg_cons_eq, List.append_nil]

/-! ### Folding a program over a stack -/

@[simp] theorem survives_nil (σ : Stack) : survives σ [] = σ := rfl

theorem survives_cons (σ : Stack) (op : Op) (prog : List Op) :
    survives σ (op :: prog) = survives (applyOp σ op) prog := rfl

theorem survives_append_untouched {σ : Stack} (prog : List Op)
    (h : ∀ q ∈ disposalsList prog, q ∉ σ) (τ : Stack) :
    survives (σ ++ τ) prog = σ ++ survives τ prog := by
  induction prog generalizing τ with
  | nil => simp
  | cons op rest ih =>
      cases op with
      | reg k n =>
          have h' : ∀ q ∈ disposalsList rest, q ∉ σ := by
            intro q hq
            exact h q (by simpa [disposalsList] using hq)
          show survives ((σ ++ τ) ++ [(k, n)]) rest = σ ++ survives (τ ++ [(k, n)]) rest
          rw [List.append_assoc]
          exact ih h' (τ ++ [(k, n)])
      | dispose k n =>
          have h' : ∀ q ∈ disposalsList rest, q ∉ σ := by
            intro q hq
            exact h q (by simpa [disposalsList] using List.mem_cons_of_mem (k, n) hq)
          have hlen : (k, n) ∉ σ := h (k, n) (by simp [disposalsList])
          show survives (eraseReg (k, n) (σ ++ τ)) rest
              = σ ++ survives (eraseReg (k, n) τ) rest
          rw [eraseReg_append_of_not_mem hlen]
          exact ih h' (eraseReg (k, n) τ)

/-- A program of registrations only adds its registrations to the stack. -/
theorem survives_regs {σ : Stack} (ks : Stack) :
    survives σ (ks.map (fun p => Op.reg p.1 p.2)) = σ ++ ks := by
  induction ks generalizing σ with
  | nil => simp
  | cons p t ih =>
      show survives (σ ++ [p]) (t.map (fun p => Op.reg p.1 p.2)) = σ ++ (p :: t)
      rw [ih]
      simp [List.append_assoc]

/-- A program that only registers: teardown is the reverse of those registrations. -/
theorem unwind_regs (ks : Stack) :
    unwind (ks.map (fun p => Op.reg p.1 p.2)) = ks.reverse.map disposeOf := by
  have h : survivors (ks.map (fun p => Op.reg p.1 p.2)) = ks := by
    simpa [survivors] using survives_regs (σ := []) ks
  simp [unwind, h]

/-! ### Executing a program -/

theorem exec_ok_survives (σ : Stack) (prog : List Op) :
    ∀ τ : Stack, exec σ prog = .ok τ → τ = survives σ prog := by
  induction prog generalizing σ with
  | nil =>
      intro τ h
      simp only [exec] at h
      have hστ : σ = τ := by simpa using h
      subst hστ
      rfl
  | cons op rest ih =>
      intro τ h
      cases op with
      | reg k n =>
          simp only [exec] at h
          by_cases hk : keyLive k σ = true
          · simp only [hk, ite_true] at h
            exact absurd h (by simp)
          · simp only [hk] at h
            exact (ih (σ ++ [(k, n)]) τ h).trans (by simp [survives_cons, applyOp])
      | dispose k n =>
          simp only [exec] at h
          by_cases hr : hasReg (k, n) σ = true
          · simp only [hr, ite_true] at h
            exact (ih (eraseReg (k, n) σ) τ h).trans (by simp [survives_cons, applyOp])
          · simp only [hr] at h
            exact absurd h (by simp)

/-! ### Distinct registrations -/

/-- No registration occurs twice. -/
def NoDup : Stack → Prop
  | [] => True
  | p :: t => p ∉ t ∧ NoDup t

theorem nodup_eraseReg {σ : Stack} : ∀ {p : Reg}, NoDup σ → NoDup (eraseReg p σ) := by
  induction σ with
  | nil => intro p _; trivial
  | cons q t ih =>
      intro p h
      by_cases hq : q = p
      · subst hq
        rw [eraseReg_cons_eq]
        exact h.2
      · rw [eraseReg_cons_ne t hq]
        exact ⟨fun hr => h.1 (eraseReg_subset hr), ih h.2⟩

theorem nodup_append_single {σ : Stack} : ∀ {p : Reg}, NoDup σ → p ∉ σ → NoDup (σ ++ [p]) := by
  induction σ with
  | nil => intro p _ _; simp [NoDup]
  | cons q t ih =>
      intro p h hp
      refine ⟨?_, ?_⟩
      · intro hq
        rcases List.mem_append.mp hq with h0 | h1
        · exact h.1 h0
        · have hqp : q = p := by simpa using h1
          exact hp (hqp ▸ List.mem_cons_self)
      · exact ih h.2 (fun ht => hp (List.mem_cons_of_mem q ht))

theorem nodup_append_single_left {σ : Stack} : ∀ {p : Reg}, NoDup (σ ++ [p]) → NoDup σ := by
  induction σ with
  | nil => intro p _; trivial
  | cons q t ih =>
      intro p h
      have h' : q ∉ t ++ [p] := h.1
      exact ⟨fun hq => h' (List.mem_append.mpr (Or.inl hq)), ih h.2⟩

theorem not_mem_of_nodup_append_single {σ : Stack} :
    ∀ {p : Reg}, NoDup (σ ++ [p]) → p ∉ σ := by
  induction σ with
  | nil => intro p _; simp
  | cons q t ih =>
      intro p h
      have h' : q ∉ t ++ [p] := h.1
      have hpq : p ≠ q := fun he => h' (he ▸ List.mem_append.mpr (Or.inr (by simp)))
      intro hp
      rcases List.mem_cons.mp hp with h0 | h1
      · exact hpq h0
      · exact ih h.2 h1

/-- Registrations a survivor list can only come from the program's registrations. -/
theorem survives_mem (prog : List Op) :
    ∀ (σ : Stack) (p : Reg), p ∈ survives σ prog → p ∈ σ ∨ p ∈ regs prog := by
  induction prog with
  | nil => intro σ p hp; exact Or.inl (by simpa using hp)
  | cons op rest ih =>
      cases op with
      | reg k n =>
          intro σ p hp
          have hp' : p ∈ survives (σ ++ [(k, n)]) rest := by
            simpa [survives_cons, applyOp] using hp
          rcases ih (σ ++ [(k, n)]) p hp' with h0 | h1
          · rcases List.mem_append.mp h0 with h2 | h3
            · exact Or.inl h2
            · right
              have hpk : p = (k, n) := by simpa using h3
              exact hpk ▸ (by simp [regs] : (k, n) ∈ regs (Op.reg k n :: rest))
          · exact Or.inr (List.mem_cons_of_mem (k, n) h1)
      | dispose k n =>
          intro σ p hp
          have hp' : p ∈ survives (eraseReg (k, n) σ) rest := by
            simpa [survives_cons, applyOp] using hp
          rcases ih (eraseReg (k, n) σ) p hp' with h0 | h1
          · exact Or.inl (eraseReg_subset h0)
          · exact Or.inr h1

theorem survivors_subset_regs (prog : List Op) : ∀ p ∈ survivors prog, p ∈ regs prog := by
  intro p hp
  rcases survives_mem prog [] p hp with h | h
  · simp at h
  · exact h

/-- No two registrations of the program share a key. -/
def keysDistinct : List Op → Prop
  | [] => True
  | .reg k _ :: rest => (∀ q ∈ regs rest, q.1 ≠ k) ∧ keysDistinct rest
  | .dispose _ _ :: rest => keysDistinct rest

/-- Every disposal names a registration the same program made earlier. -/
def disposalsMatchFrom (seen : Stack) : List Op → Prop
  | [] => True
  | .reg k n :: rest => disposalsMatchFrom (seen ++ [(k, n)]) rest
  | .dispose k n :: rest => (k, n) ∈ seen ∧ disposalsMatchFrom seen rest

/-- Every disposal of the program names a registration the program made earlier. -/
def disposalsMatch (prog : List Op) : Prop := disposalsMatchFrom [] prog

/-- The program runs from the stack: no duplicate key, no absent registration. -/
def runs (σ : Stack) (prog : List Op) : Prop := ∃ τ, exec σ prog = .ok τ

/-- Well-formedness of a program for the stack it starts on: distinct registration
keys, disposals of the program's own earlier registrations, a program that runs,
and no registration colliding with a registration already live. -/
def WF (σ : Stack) (prog : List Op) : Prop :=
  keysDistinct prog ∧ disposalsMatch prog ∧ runs σ prog ∧ (∀ p ∈ regs prog, p ∉ σ)

/-- Disposals a well-formed program makes are registrations the same program made. -/
theorem disposals_subset (prog : List Op) :
    disposalsMatchFrom [] prog → ∀ q ∈ disposalsList prog, q ∈ regs prog := by
  have aux : ∀ (seen : Stack), disposalsMatchFrom seen prog →
      ∀ q ∈ disposalsList prog, q ∈ seen ∨ q ∈ regs prog := by
    induction prog with
    | nil => intro seen _ q hq; simp [disposalsList] at hq
    | cons op rest ih =>
        intro seen hm
        cases op with
        | reg k n =>
            intro q hq
            rcases ih (seen ++ [(k, n)]) hm q hq with h0 | h1
            · rcases List.mem_append.mp h0 with h2 | h3
              · exact Or.inl h2
              · right
                have hqk : q = (k, n) := by simpa using h3
                exact hqk ▸ (by simp [regs] : (k, n) ∈ regs (Op.reg k n :: rest))
            · exact Or.inr (by simpa [regs] using List.mem_cons_of_mem (k, n) h1)
        | dispose k n =>
            intro q hq
            have hm' : (k, n) ∈ seen ∧ disposalsMatchFrom seen rest := hm
            rcases List.mem_cons.mp hq with hq0 | hq1
            · exact Or.inl (hq0 ▸ hm'.1)
            · rcases ih seen hm'.2 q hq1 with h0 | h1
              · exact Or.inl h0
              · exact Or.inr h1
  intro hm q hq
  rcases aux [] hm q hq with h | h
  · simp at h
  · exact h

/-! ### Survivors of a well-formed program -/

theorem survives_nodup (prog : List Op) :
    ∀ (σ : Stack), keysDistinct prog → NoDup σ →
      (∀ p ∈ σ, ∀ q ∈ regs prog, p.1 ≠ q.1) → NoDup (survives σ prog) := by
  induction prog with
  | nil =>
      intro σ _ hσ _
      simpa using hσ
  | cons op rest ih =>
      intro σ hk hσ hcross
      cases op with
      | reg k n =>
          have hk' : keysDistinct rest := hk.2
          have hfresh : ∀ q ∈ regs rest, q.1 ≠ k := hk.1
          have hnotmem : (k, n) ∉ σ := by
            intro hp
            exact absurd rfl (hcross (k, n) hp (k, n) (by simp [regs]))
          have hnodup : NoDup (σ ++ [(k, n)]) := nodup_append_single hσ hnotmem
          have hcross' : ∀ p ∈ σ ++ [(k, n)], ∀ q ∈ regs rest, p.1 ≠ q.1 := by
            intro p hp q hq
            rcases List.mem_append.mp hp with h0 | h1
            · exact hcross p h0 q (by simpa [regs] using List.mem_cons_of_mem (k, n) hq)
            · have hpk : p = (k, n) := by simpa using h1
              subst hpk
              exact fun he => hfresh q hq he.symm
          exact (by simpa [survives_cons, applyOp]
            using ih (σ ++ [(k, n)]) hk' hnodup hcross')
      | dispose k n =>
          have hk' : keysDistinct rest := hk
          have hnodup : NoDup (eraseReg (k, n) σ) := nodup_eraseReg hσ
          have hcross' : ∀ p ∈ eraseReg (k, n) σ, ∀ q ∈ regs rest, p.1 ≠ q.1 := by
            intro p hp q hq
            exact hcross p (eraseReg_subset hp) q hq
          exact (by simpa [survives_cons, applyOp]
            using ih (eraseReg (k, n) σ) hk' hnodup hcross')

theorem survivors_nodup (prog : List Op) (h : keysDistinct prog) : NoDup (survivors prog) :=
  survives_nodup prog [] h (by trivial) (by intro p hp; simp at hp)

theorem survivors_disjoint {σ : Stack} (prog : List Op)
    (h : ∀ p ∈ regs prog, p ∉ σ) : ∀ p ∈ survivors prog, p ∉ σ :=
  fun p hp => h p (survivors_subset_regs prog p hp)

/-! ### Disposing a stack in reverse -/

/-- Disposing `l.reverse`'s registrations newest first, from the stack `σ ++ l.reverse`,
restores `σ`. -/
theorem exec_dispose_reverse (l : Stack) :
    ∀ (σ : Stack), NoDup l.reverse → (∀ p ∈ l.reverse, p ∉ σ) →
      exec (σ ++ l.reverse) (l.map disposeOf) = .ok σ := by
  induction l with
  | nil => intro σ _ _; simp [exec]
  | cons p t ih =>
      rcases p with ⟨k, n⟩
      intro σ hnd hdis
      have hrev : ((k, n) :: t).reverse = t.reverse ++ [(k, n)] := by simp
      have hnd' : NoDup (t.reverse ++ [(k, n)]) := by simpa [hrev] using hnd
      have hnd'' : NoDup t.reverse := nodup_append_single_left hnd'
      have hpq : (k, n) ∉ t.reverse := not_mem_of_nodup_append_single hnd'
      have hqσ : (k, n) ∉ σ := hdis (k, n) (by rw [hrev]; simp)
      have hnot : (k, n) ∉ σ ++ t.reverse :=
        fun h => (List.mem_append.mp h).elim hqσ hpq
      have hstep : exec (σ ++ (t.reverse ++ [(k, n)]))
          (Op.dispose k n :: t.map disposeOf)
          = exec (σ ++ t.reverse) (t.map disposeOf) := by
        have hassoc : σ ++ (t.reverse ++ [(k, n)]) = (σ ++ t.reverse) ++ [(k, n)] := by
          simp [List.append_assoc]
        rw [hassoc]
        simp only [exec]
        rw [hasReg_append_single]
        rw [eraseReg_append_single_of_not_mem hnot]
        rfl
      rw [hrev]
      show exec (σ ++ (t.reverse ++ [(k, n)])) (Op.dispose k n :: t.map disposeOf) = .ok σ
      rw [hstep]
      exact ih σ hnd'' (fun q hq => hdis q (by rw [hrev]; exact List.mem_append.mpr (Or.inl hq)))

/-! ### The three statements -/

/-- Running a well-formed program and then its teardown restores the stack it
started from. -/
theorem unwind_restores (σ τ : Stack) (prog : List Op)
    (h : exec σ prog = .ok τ) (hwf : WF σ prog) : exec τ (unwind prog) = .ok σ := by
  have hτ : τ = survives σ prog := exec_ok_survives σ prog τ h
  have hdisp : ∀ q ∈ disposalsList prog, q ∉ σ := by
    intro q hq
    exact hwf.2.2.2 q (disposals_subset prog hwf.2.1 q hq)
  have hpref : survives σ prog = σ ++ survivors prog := by
    have := survives_append_untouched (σ := σ) prog hdisp []
    simpa [survivors] using this
  rw [hτ, hpref]
  show exec (σ ++ survivors prog) ((survivors prog).reverse.map disposeOf) = .ok σ
  have := exec_dispose_reverse (survivors prog).reverse σ
    (by simpa using survivors_nodup prog hwf.1)
    (by intro p hp; exact survivors_disjoint prog hwf.2.2.2 p (by simpa using hp))
  simpa using this

/-- For a two-registration program the teardown disposes the later registration
first. -/
theorem unwind_order_is_reverse (k₁ : String) (n₁ : Nat) (k₂ : String) (n₂ : Nat) :
    unwind [Op.reg k₁ n₁, Op.reg k₂ n₂] = [Op.dispose k₂ n₂, Op.dispose k₁ n₁] := by
  simpa [disposeOf] using unwind_regs [(k₁, n₁), (k₂, n₂)]

/-- Disposing a registration that is not live is an error, never a silent no-op. -/
theorem dispose_absent_fails (σ : Stack) (k : String) (n : Nat) (h : (k, n) ∉ σ) :
    ∃ msg, exec σ [Op.dispose k n] = .error msg := by
  refine ⟨s!"absent registration: {k}#{n}", ?_⟩
  simp [exec, hasReg_iff, h]

end Omd.Cordis
