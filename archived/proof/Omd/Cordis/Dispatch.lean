/-
Dispatch modes of the Cordis event service.

Sources, commit 687f282e8625c6b8d11ff58211a90524be2e4317:
- `refs/deepseek-harness/vendor/cordis/src/events.ts`: `EventsService.emit`,
  `waterfall`, `parallel`, `serial`, `bail`, `register` (`push` for ordinary
  registrations, `unshift` for `prepend`), `isBailed`, and the `next` closure
  built inside `waterfall`.
- `refs/deepseek-harness/docs/cordis-primer.md`: the dispatch-mode table and
  the waterfall rules — a listener receives `next`, a listener that returns
  without calling `next()` short-circuits the rest of the chain including the
  built-in behaviour, values propagate through `next()`'s return value, and
  `prepend: true` puts a listener before ordinary registrations.

Modelled: the order in which listeners are invoked (`emit`, `serial`, `bail`,
`parallel`), where a bail value stops the walk, where `prepend` inserts a
registration, and the value a `waterfall` chain returns.

Deliberately outside the model:
- Awaiting. `serial` and `parallel` are `async` in the source; listeners here
  are total pure functions, so `serial` and `bail` share one dispatch shape and
  the only difference between them — whether each listener is awaited — has no
  trace in the model.
- `parallel` interleaving. The source starts every listener, then awaits
  `Promise.allSettled`. The model records that all listeners run, not the order
  in which they settle or resume.
- Listener errors. A thrown exception and `parallel`'s `AggregateError` are
  outside; every listener is assumed to return.
- `isBailed` is true unless the return value is `null`, `false`, or
  `undefined`. The model carries a bail value as `Option V`, so `none`
  conflates `null` and `undefined`, and a `V = Bool` event cannot express JS
  `false` as a non-bailing return.
- Re-entrant `next`. The source's `next` shifts one shared array, so a listener
  that calls `next()` twice resumes the chain where it left off. The model's
  `next` always runs the same tail, which covers the single-delegation case the
  primer describes and not the double-call case.
- Fiber ownership, disposers, `unregister`, context filtering
  (`Context.filter`), the `internal/listener` bail dispatch that can veto a
  registration, and the `internal/dispatch` re-emission are outside. `prepend`
  is modelled only through its insertion position.
- `waterfall` passes the original argument list to every listener and uses the
  caller's `inner` as the innermost continuation. The model passes one value of
  the result type, identified both with that argument and with `inner()`, so it
  cannot express a listener that sees the original arguments but returns a
  different type.
-/

namespace Omd.Cordis.Dispatch

/-- One registration: its label, the listener, and the `prepend` flag of
`ctx.on(name, listener, { prepend: true })`. -/
structure Hook (L : Type) where
  id : Nat
  fn : L
  prepend : Bool
  deriving Repr

/-- The labels of a registration list, in list order. -/
def ids {L : Type} (l : List (Hook L)) : List Nat := l.map fun h => h.id

/-- Add one registration the way `EventsService.register` does: `unshift` when
`prepend` is set, `push` otherwise. -/
def register {L : Type} (h : Hook L) (l : List (Hook L)) : List (Hook L) :=
  if h.prepend then h :: l else l ++ [h]

theorem register_prepend {L : Type} (h : Hook L) (l : List (Hook L))
    (hp : h.prepend = true) : register h l = h :: l := by
  simp [register, hp]

theorem register_push {L : Type} (h : Hook L) (l : List (Hook L))
    (hp : h.prepend = false) : register h l = l ++ [h] := by
  simp [register, hp]

/-- An `emit`/`parallel` listener: it observes the value and its return value is
discarded. -/
abbrev Observer (V : Type) := V → Unit

/-- A `bail`/`serial` listener: `some w` is a bail value, `none` is the
`undefined`/`null`/`false` case of `isBailed`. -/
abbrev Decider (V : Type) := V → Option V

/-- The `next` continuation of a waterfall listener. It is nullary in the
source, and its return value is what propagates. -/
abbrev Next (V : Type) := Unit → V

/-- A waterfall listener receives the dispatched value and `next`. -/
abbrev Listener (V : Type) := V → Next V → V

/-! ## `emit` -/

/-- Call every listener in list order, discarding the results. -/
def emit {V : Type} (l : List (Hook (Observer V))) (v : V) : Unit :=
  l.foldl (fun _ h => h.fn v) ()

/-- The labels `emit` observes, appended in invocation order. The order does not
depend on the dispatched value, so the value is not a parameter. -/
def emitTrace {V : Type} (l : List (Hook (Observer V))) : List Nat :=
  l.foldl (fun acc h => acc ++ [h.id]) []

theorem emitTrace_foldl {V : Type} (l : List (Hook (Observer V))) (acc : List Nat) :
    l.foldl (fun acc h => acc ++ [h.id]) acc = acc ++ ids l := by
  induction l generalizing acc with
  | nil => simp [ids]
  | cons h t ih => simp [List.foldl_cons, ih, ids, List.append_assoc]

/-- `emit` visits every registered listener, in registration order. -/
theorem emit_order_is_registration_order {V : Type} (l : List (Hook (Observer V))) :
    emitTrace l = ids l := by
  simpa [emitTrace] using emitTrace_foldl l []

/-! ## `serial` and `bail` -/

/-- Walk the registrations in order and stop at the first bail value. `serial`
is the same walk with each listener awaited; awaiting leaves no trace in the
model, so the two share this definition. -/
def bail {V : Type} : List (Hook (Decider V)) → V → Option V
  | [], _ => none
  | h :: t, v => match h.fn v with
      | some w => some w
      | none => bail t v

/-- The awaited variant of `bail`; see the module docstring for why it is not a
separate fold. -/
abbrev serial {V : Type} (l : List (Hook (Decider V))) (v : V) : Option V := bail l v

/-- The labels `serial` observes, appended in invocation order, ending with the
listener that bailed. -/
def serialTrace {V : Type} : List (Hook (Decider V)) → V → List Nat
  | [], _ => []
  | h :: t, v => match h.fn v with
      | some _ => [h.id]
      | none => h.id :: serialTrace t v

/-- `serial` observes a prefix of the registration list: it never reorders the
listeners it visits, it only stops early. -/
theorem serial_order_is_registration_order {V : Type} (l : List (Hook (Decider V))) (v : V) :
    serialTrace l v <+: ids l := by
  induction l with
  | nil => simp [serialTrace, ids]
  | cons h t ih =>
      rw [serialTrace, ids]
      cases hf : h.fn v with
      | some w => exact List.cons_prefix_cons.mpr ⟨rfl, List.nil_prefix⟩
      | none => exact List.cons_prefix_cons.mpr ⟨rfl, ih⟩

/-- With no bail value anywhere, `serial` observes every registration, in
registration order. -/
theorem serial_trace_eq_of_no_bail {V : Type} (l : List (Hook (Decider V))) (v : V)
    (h : ∀ x ∈ l, x.fn v = none) : serialTrace l v = ids l := by
  induction l with
  | nil => simp [serialTrace, ids]
  | cons hd t ih =>
      have hd' : hd.fn v = none := h hd (List.mem_cons_self ..)
      have ht : ∀ x ∈ t, x.fn v = none := fun x hx => h x (List.mem_cons_of_mem _ hx)
      simp [serialTrace, ids, hd', ih ht]

/-- `bail` returns the first bail value; the listeners after it, `l₂`, cannot
change that result. -/
theorem bail_stops_at_first {V : Type} (v w : V) (d : Hook (Decider V))
    (l₁ l₂ : List (Hook (Decider V)))
    (h₁ : ∀ x ∈ l₁, x.fn v = none) (hd : d.fn v = some w) :
    bail (l₁ ++ d :: l₂) v = some w := by
  induction l₁ with
  | nil => simp [bail, hd]
  | cons a t ih =>
      have ha : a.fn v = none := h₁ a (List.mem_cons_self ..)
      have ht : ∀ x ∈ t, x.fn v = none := fun x hx => h₁ x (List.mem_cons_of_mem _ hx)
      simp [bail, ha, ih ht]

/-- With no bail value anywhere, `bail` returns `none` — the source returns
`undefined` there. -/
theorem bail_none_of_all_none {V : Type} (l : List (Hook (Decider V))) (v : V)
    (h : ∀ x ∈ l, x.fn v = none) : bail l v = none := by
  induction l with
  | nil => simp [bail]
  | cons a t ih =>
      have ha : a.fn v = none := h a (List.mem_cons_self ..)
      have ht : ∀ x ∈ t, x.fn v = none := fun x hx => h x (List.mem_cons_of_mem _ hx)
      simp [bail, ha, ih ht]

/-! ## `parallel` -/

/-- Start every listener and collect what each returns. The source settles them
concurrently through `Promise.allSettled`; the collection order here is the
model's, not the source's. -/
def parallel {V : Type} (l : List (Hook (Observer V))) (v : V) : List Unit :=
  l.map fun h => h.fn v

/-- `parallel` observes every registered listener. -/
theorem parallel_observes_all {V : Type} (l : List (Hook (Observer V))) (v : V) :
    (parallel l v).length = l.length := by
  simp [parallel]

/-! ## `waterfall` -/

/-- Run the outermost listener first. `base` is the caller's `inner()`: the value
the chain returns when every listener delegates, and the value of an empty
registration list. -/
def waterfall {V : Type} (base : V) : List (Hook (Listener V)) → V
  | [] => base
  | h :: t => h.fn base fun _ => waterfall base t

/-- The listener that delegates immediately. -/
def delegate {V : Type} : Listener V := fun _ next => next ()

/-- Every listener delegates, so the chain returns the caller's value. -/
theorem waterfall_all_delegate {V : Type} (base : V) (l : List (Hook (Listener V)))
    (hl : ∀ x ∈ l, x.fn = delegate) : waterfall base l = base := by
  induction l with
  | nil => simp [waterfall]
  | cons h t ih =>
      have hh : h.fn = delegate := hl h (List.mem_cons_self ..)
      have ht : ∀ x ∈ t, x.fn = delegate := fun x hx => hl x (List.mem_cons_of_mem _ hx)
      simp [waterfall, hh, delegate, ih ht]

/-- A listener whose result does not depend on its continuation. -/
def IgnoresNext {V : Type} (l : Listener V) : Prop :=
  ∀ (v : V) (n₁ n₂ : Next V), l v n₁ = l v n₂

/-- A listener that ignores `next` makes every later listener unobservable: the
chain returns what it would return if the registration list ended there. -/
theorem waterfall_short_circuit {V : Type} (base : V) (d : Hook (Listener V))
    (l₁ l₂ : List (Hook (Listener V))) (hd : IgnoresNext d.fn) :
    waterfall base (l₁ ++ d :: l₂) = waterfall base (l₁ ++ [d]) := by
  induction l₁ with
  | nil => exact hd base _ _
  | cons a t ih => simp [waterfall, ih]

/-- The constant listener, which is what `return value` in a waterfall handler
without `next()` compiles to. -/
def shortCircuit {V : Type} (w : V) : Listener V := fun _ _ => w

theorem shortCircuit_ignores_next {V : Type} (w : V) : IgnoresNext (shortCircuit w) :=
  fun _ _ _ => rfl

/-! ## `prepend` -/

/-- A prepended registration is the outermost listener, so it runs before every
registration already present. -/
theorem prepend_runs_first {V : Type} (base : V) (h : Hook (Listener V))
    (l : List (Hook (Listener V))) (hp : h.prepend = true) :
    waterfall base (register h l) = h.fn base (fun _ => waterfall base l) := by
  simp [register, hp, waterfall]

/-- The same placement, read off the observation trace of `emit`. -/
theorem prepend_observed_first {V : Type} (h : Hook (Observer V))
    (l : List (Hook (Observer V))) (hp : h.prepend = true) :
    emitTrace (register h l) = h.id :: emitTrace l := by
  simp [register, hp, emitTrace, List.foldl_cons]

end Omd.Cordis.Dispatch
