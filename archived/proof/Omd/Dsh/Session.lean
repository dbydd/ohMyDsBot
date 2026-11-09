import Omd.Basic

/-!
# The session log: append-only admission, the surface, and "model-visible ⟺ logged"

Source: `refs/deepseek-harness` at commit `687f282e8625c6b8d11ff58211a90524be2e4317`.

* `packages/core/session/src/index.ts` — `Session.append` (the event is admitted at the
  next free position and only once it validates), `Session.commit` (the candidate is
  validated by the surface manager before the log grows), `isOwnSeq`, and the
  `seq = log.length` contiguity contract.
* `packages/core/session/src/surface.ts` — `SurfaceOp` (`'append'` or
  `{ op: 'replace', startSeq, endSeq }`), `replacementRange` (the shadowed nodes are
  exactly the current surface nodes in the cited inclusive range) and
  `applySurfacePlan` (the replacement node takes the range's place; the log keeps the
  shadowed events).
* `packages/core/session/src/known-event-types.ts` — `KNOWN_SESSION_EVENT_TYPES`, the
  closed vocabulary generated from the `SessionEventMap` declarations, and the read
  path's refusal to interpret a log holding a type outside it.
* `packages/core/session/README.md` — "surface events", `surfaceOp`, the replacement
  rule, "Model-visible means logged", and the note that a `replace` removes shadowed
  entries from future inputs without deleting their raw log records.
* `AGENTS.md:137` — "Model-visible ⟺ logged: anything that reaches a model request
  must be reconstructable from the session log; a new model-visible input requires a
  session event."

## What is modelled

* Admission: a single writer appends one event whose sequence number is strictly
  above the last logged one, and whose type belongs to a fixed vocabulary. A rejected
  append has no effect, because `append` returns a new log rather than mutating one.
* The surface: an append adds a node; a replacement hides a set of surface nodes while
  the log keeps them.
* The request: the payloads of the model-visible events, assembled from the log alone,
  so that a driver replaying the log rebuilds the same request (`assemble_congr`,
  `assemble_append`) and every assembled string is the payload of a logged event
  (`request_only_logged`).
* One abstract loop step whose only input is the log, and whose consumed request is
  therefore already logged (`step_inputs_logged`).

## What is left outside the model

* Message projections: `MESSAGE_PROJECTION_EVENT_TYPES` and `foldSurface`'s
  `projectedMessages` rewrite message content without rewriting events. Here the
  payload is opaque and `visible` already means "projects to a non-empty message".
* Durability: `ctx.sessions.flush`, write-behind backends, and the fact that a settled
  attempt is what survives a process loss. `append` is total and immediate; a rejected
  or unwritten event simply does not appear.
* Persistence: JSONL files, `snapshotJsonValue` lossless-JSON validation, restore and
  adoption, `SESSION_FORMAT_VERSION`, `ignorable` records.
* Redaction: nothing is redacted on the way into the log or out of it.
* The event-type catalogue itself: `KNOWN_SESSION_EVENT_TYPES` has 62 generated names.
  `knownKinds` below holds only the names this model uses, and every admission theorem
  is stated through `knownKind`, so no proof depends on which names the list holds.
* Sequence contiguity: the source maintains `seq = log.length`. The model enforces
  only strict increase, so gaps are admitted; every theorem below is stated for the
  weaker rule.
* Forking: `inheritedEventCount`, seed validation, and the closing events a fork adds.
  `isOwnSeq` is modelled on the raw position test the log supports.
* Request headers and tool history (`request/header`, `foldRequestHeader`,
  `toolHistory`), `sourceEventSeqs` citation coverage, the tool-result rewrite and
  system-head protection rules of `surface.ts`, and all message content and roles.
* The positional splice: a replacement lands at the position of the nodes it hides.
  `Surface.replace` records the hidden sequences, and `surface` places `added` before
  the surviving nodes, so the model proves which nodes are visible, not their order.
-/

namespace Omd.Dsh

/-- One accepted session event, with the payload kept opaque.

`seq` is the log position. The source derives it from the log length; the model
accepts a supplied position and checks it against the last one, which is the rule an
append must enforce on a value it did not build itself.

`visible` is the projection fact: the event contributes a non-empty message to a
model request. An empty `system/message` or `developer/message` node sits on the
surface and contributes nothing, which is why visibility is per event and not a
property of the event kind. -/
structure Event where
  seq : Nat
  kind : String
  visible : Bool
  payload : String
  deriving Repr, DecidableEq

/-- The log: the accepted events in append order. -/
structure Log where
  events : List Event
  deriving Repr, DecidableEq

/-- The kind of every event admitted here. See the module docstring: the real
vocabulary is generated from the `SessionEventMap` declarations and is outside the
model; this list names the kinds the model itself produces. -/
def knownKinds : List String :=
  ["system/message", "developer/message", "user/message", "assistant/message",
   "tool/result", "step/start", "step/end", "turn/start", "turn/end",
   "assistant/attempt", "request/header"]

/-- Membership in the closed vocabulary. -/
def knownKind (kind : String) : Bool := knownKinds.contains kind

/-- The sequence number of the last logged event, `none` for an empty log. -/
def lastSeqOf : List Event → Option Nat
  | [] => none
  | [a] => some a.seq
  | _ :: b :: rest => lastSeqOf (b :: rest)

/-- The sequence number the next append has to exceed. -/
def nextSeqOf : List Event → Nat
  | [] => 0
  | [a] => a.seq + 1
  | _ :: b :: rest => nextSeqOf (b :: rest)

/-- The sequence number of the last logged event. -/
def Log.lastSeq (l : Log) : Option Nat := lastSeqOf l.events

/-- The position an event appended to this log must take at the earliest. -/
def Log.nextSeq (l : Log) : Nat := nextSeqOf l.events

@[simp] theorem lastSeqOf_append_singleton (evs : List Event) (e : Event) :
    lastSeqOf (evs ++ [e]) = some e.seq := by
  induction evs with
  | nil => rfl
  | cons a t ih =>
    cases t with
    | nil => rfl
    | cons b rest => simpa [lastSeqOf] using ih

theorem lastSeqOf_lt_nextSeqOf : ∀ (evs : List Event) (n : Nat),
    lastSeqOf evs = some n → n < nextSeqOf evs
  | [], n, h => by simp [lastSeqOf] at h
  | [a], n, h => by
    simp only [lastSeqOf, Option.some.injEq] at h
    subst h
    simp [nextSeqOf]
  | _ :: b :: rest, n, h => lastSeqOf_lt_nextSeqOf (b :: rest) n (by simpa [lastSeqOf] using h)

/-- A non-empty log has a last sequence number. -/
theorem lastSeqOf_isSome : ∀ (evs : List Event), evs ≠ [] → ∃ n, lastSeqOf evs = some n
  | [], h => absurd rfl h
  | [_], _ => ⟨_, rfl⟩
  | _ :: b :: rest, _ => lastSeqOf_isSome (b :: rest) (by simp)

/-- Only the empty log has no last sequence number. -/
theorem eq_nil_of_lastSeqOf_eq_none {evs : List Event} (h : lastSeqOf evs = none) :
    evs = [] := by
  cases evs with
  | nil => rfl
  | cons a t =>
    exfalso
    obtain ⟨n, hn⟩ := lastSeqOf_isSome (a :: t) (by simp)
    rw [h] at hn
    cases hn

/-- Append one event, as `Session.append` does.

Two rejections, both on values the caller supplies: a `seq` that does not exceed the
last logged one (single writer, append-only) and a `kind` outside the vocabulary. The
source checks the candidate through the surface manager before the log grows; both
checks are rejections that leave the log untouched, which is immediate here because
`append` returns a new log. -/
def append (l : Log) (e : Event) : Except String Log :=
  if _hk : knownKind e.kind = true then
    match _hlast : l.lastSeq with
    | some n =>
      if _hlt : n < e.seq then
        .ok ⟨l.events ++ [e]⟩
      else
        .error s!"session seq {e.seq} does not exceed the last logged seq {n}"
    | none => .ok ⟨l.events ++ [e]⟩
  else
    .error s!"unknown session event kind: {e.kind}"

/-- Sequence numbers strictly increase along the log. -/
def SeqStrict : List Event → Prop
  | [] => True
  | [_] => True
  | a :: b :: rest => a.seq < b.seq ∧ SeqStrict (b :: rest)

/-- Every logged sequence is at most the last one. -/
theorem seqStrict_le_lastSeq : ∀ (evs : List Event), SeqStrict evs →
    ∀ (n : Nat), lastSeqOf evs = some n → ∀ y ∈ evs, y.seq ≤ n
  | [], h, n, hl, y, hy => by simp at hy
  | [a], h, n, hl, y, hy => by
    simp only [lastSeqOf, Option.some.injEq] at hl
    subst hl
    simp only [List.mem_singleton] at hy
    subst hy
    exact Nat.le_refl _
  | a :: b :: rest, h, n, hl, y, hy => by
    have h1 : a.seq < b.seq := h.1
    have h2 : SeqStrict (b :: rest) := h.2
    have hl' : lastSeqOf (b :: rest) = some n := by simpa [lastSeqOf] using hl
    have ih := seqStrict_le_lastSeq (b :: rest) h2 n hl'
    rcases List.mem_cons.mp hy with rfl | hy'
    · exact Nat.le_trans (Nat.le_of_lt h1) (ih b (by simp))
    · exact ih y hy'

/-- A singleton appended past every logged sequence keeps the invariant. -/
theorem seqStrict_append_singleton : ∀ (evs : List Event) (e : Event), SeqStrict evs →
    (∀ y ∈ evs, y.seq < e.seq) → SeqStrict (evs ++ [e])
  | [], e, _, _ => by simp [SeqStrict]
  | [a], e, _, hall => by
    simp only [List.singleton_append, SeqStrict]
    exact ⟨hall a (by simp), trivial⟩
  | a :: b :: rest, e, h, hall => by
    have h1 : a.seq < b.seq := h.1
    have h2 : SeqStrict (b :: rest) := h.2
    have hall' : ∀ y ∈ b :: rest, y.seq < e.seq := by
      intro y hy
      exact hall y (List.mem_cons_of_mem a hy)
    have ih := seqStrict_append_singleton (b :: rest) e h2 hall'
    simp only [List.cons_append, SeqStrict]
    exact ⟨h1, ih⟩

/-- The accepted event's sequence is above the last logged one. -/
theorem append_seq_gt_last {l l' : Log} {e : Event} (h : append l e = .ok l') :
    ∀ n, l.lastSeq = some n → n < e.seq := by
  unfold append at h
  split at h
  · split at h
    · rename_i n hlast
      split at h
      · rename_i hlt
        intro m hm
        rw [hlast] at hm
        simp only [Option.some.injEq] at hm
        subst hm
        exact hlt
      · cases h
    · rename_i hnone
      intro m hm
      rw [hnone] at hm
      cases hm
  · cases h

/-- Every logged sequence is below the one being appended, so a single writer keeps
the log ordered. -/
theorem append_seq_strict {l l' : Log} {e : Event} (hmono : SeqStrict l.events)
    (h : append l e = .ok l') : ∀ y ∈ l.events, y.seq < e.seq := by
  intro y hy
  cases hl : l.lastSeq with
  | none =>
    have hempty : l.events = [] := eq_nil_of_lastSeqOf_eq_none hl
    rw [hempty] at hy
    cases hy
  | some n =>
    exact Nat.lt_of_le_of_lt (seqStrict_le_lastSeq l.events hmono n hl y hy)
      (append_seq_gt_last h n hl)

/-- The accepted event is appended; rejection has no effect because `append` returns
a new log. -/
theorem append_events {l l' : Log} {e : Event} (h : append l e = .ok l') :
    l'.events = l.events ++ [e] := by
  unfold append at h
  split at h
  · split at h
    · split at h
      · simp only [Except.ok.injEq] at h
        exact congrArg Log.events h.symm
      · cases h
    · simp only [Except.ok.injEq] at h
      exact congrArg Log.events h.symm
  · cases h

/-- The log only grows: the previous events remain, in order, ahead of the new one. -/
theorem append_preserves_prefix {l l' : Log} {e : Event} (h : append l e = .ok l') :
    l.events <+: l'.events := by
  have hev : l'.events = l.events ++ [e] := append_events h
  rw [hev]
  exact List.prefix_append _ _

/-- The invariant survives one append. -/
theorem append_preserves_seqStrict {l l' : Log} {e : Event} (hmono : SeqStrict l.events)
    (h : append l e = .ok l') : SeqStrict l'.events := by
  rw [append_events h]
  exact seqStrict_append_singleton l.events e hmono (append_seq_strict hmono h)

/-- An unknown kind never enters the log. -/
theorem append_unknown_kind {l l' : Log} {e : Event} (hk : knownKind e.kind = false)
    (h : append l e = .ok l') : False := by
  unfold append at h
  simp [hk] at h

/-- The next free position admits every known kind: admission rejects only a stale
sequence or an unknown kind, never a well-formed event. -/
theorem append_nextSeq {l : Log} {kind : String} {visible : Bool} {payload : String}
    (hk : knownKind kind = true) :
    ∃ l', append l ⟨l.nextSeq, kind, visible, payload⟩ = .ok l' := by
  unfold append
  split
  · split
    · split
      · exact ⟨_, rfl⟩
      · rename_i hnot
        exact absurd (lastSeqOf_lt_nextSeqOf l.events _ (by assumption)) hnot
    · exact ⟨_, rfl⟩
  · rename_i hnot
    exact absurd hk hnot

/-- A replay or restore appends a whole sequence of events in order. The first
rejection fails the whole replay, so a partly applied sequence never yields a log. -/
def appendAll : Log → List Event → Except String Log
  | l, [] => .ok l
  | l, e :: es =>
    match append l e with
    | .error msg => .error msg
    | .ok l' => appendAll l' es

/-- A successful replay appends every event, in order. -/
theorem appendAll_events : ∀ (es : List Event) (l l' : Log),
    appendAll l es = .ok l' → l'.events = l.events ++ es
  | [], l, l', h => by
    simp only [appendAll, Except.ok.injEq] at h
    subst h
    rw [List.append_nil]
  | e :: es, l, l', h => by
    simp only [appendAll] at h
    split at h
    · cases h
    · rename_i l'' heq
      have h1 : l''.events = l.events ++ [e] := append_events heq
      have h2 : l'.events = l''.events ++ es := appendAll_events es l'' l' h
      rw [h2, h1, List.append_assoc, List.singleton_append]

/-- The invariant survives a whole sequence of appends. -/
theorem appendAll_seqStrict : ∀ (es : List Event) (l l' : Log), SeqStrict l.events →
    appendAll l es = .ok l' → SeqStrict l'.events
  | [], l, l', hmono, h => by
    simp only [appendAll, Except.ok.injEq] at h
    subst h
    exact hmono
  | e :: es, l, l', hmono, h => by
    simp only [appendAll] at h
    split at h
    · cases h
    · rename_i l'' heq
      exact appendAll_seqStrict es l'' l' (append_preserves_seqStrict hmono heq) h

/-! ### The request

`assemble` folds the model-visible events of a list into the strings a model request
carries. It takes the event list and nothing else, which is the property the
replay guarantee rests on: a driver holding the log rebuilds the request. -/

/-- The events that project to a message, in log order. -/
def modelVisible (evs : List Event) : List Event := evs.filter fun e => e.visible

/-- The request built from a list of events: the payloads of the visible ones. -/
def assemble (evs : List Event) : List String := (modelVisible evs).map Event.payload

theorem mem_modelVisible {e : Event} {evs : List Event} (h : e ∈ modelVisible evs) :
    e ∈ evs ∧ e.visible = true := by
  simpa [modelVisible] using (List.mem_filter.mp h)

/-- Every request string is the payload of a visible event of the same list. -/
theorem assemble_mem {evs : List Event} {s : String} (h : s ∈ assemble evs) :
    ∃ e ∈ evs, e.visible = true ∧ e.payload = s := by
  rw [assemble, List.mem_map] at h
  obtain ⟨e, he, hp⟩ := h
  obtain ⟨hmem, hvis⟩ := mem_modelVisible he
  exact ⟨e, hmem, hvis, hp⟩

/-- Two logs whose visible events agree build the same request. This is the replay
guarantee: the request is a function of the log's visible projection alone. -/
theorem assemble_congr {l₁ l₂ : Log}
    (h : modelVisible l₁.events = modelVisible l₂.events) :
    assemble l₁.events = assemble l₂.events := by
  rw [assemble, assemble, h]

theorem modelVisible_append (a b : List Event) :
    modelVisible (a ++ b) = modelVisible a ++ modelVisible b := by
  simp [modelVisible, List.filter_append]

/-- A replay driver extends the request by one event without reading anything else. -/
theorem assemble_append (evs : List Event) (e : Event) :
    assemble (evs ++ [e]) =
      (if e.visible then assemble evs ++ [e.payload] else assemble evs) := by
  by_cases he : e.visible = true
  · simp [assemble, modelVisible, List.filter_append, he]
  · have he' : e.visible = false := by simpa using he
    simp [assemble, modelVisible, List.filter_append, he']

/-! ### The surface

A surface event either joins the tail of the ordered view or replaces nodes already
on it. The log keeps every event; the model records which sequences a replacement
hides, which is the whole set `replacementRange` computes from the cited endpoints. -/

/-- One surface operation. `append` adds a node; `replace` hides the listed sequences
and adds its own events. -/
inductive Surface where
  | append (e : Event)
  | replace (hidden : List Nat) (added : List Event)
  deriving Repr

/-- Drop the nodes whose sequence a replacement hides. -/
def without (hidden : List Nat) (evs : List Event) : List Event :=
  evs.filter fun e => !decide (e.seq ∈ hidden)

theorem mem_without {hidden : List Nat} {evs : List Event} {e : Event} :
    e ∈ without hidden evs ↔ e ∈ evs ∧ e.seq ∉ hidden := by
  simp [without, List.mem_filter]

@[simp] theorem without_nil (evs : List Event) : without [] evs = evs := by
  induction evs with
  | nil => rfl
  | cons x t _ => simp [without]

/-- The model-visible surface of a log's operations. Ops are folded so that a
replacement hides nodes already on the surface, which is the node set
`applySurfacePlan` removes from the current node list. -/
def surface : List Surface → List Event
  | [] => []
  | .append e :: rest => e :: surface rest
  | .replace hidden added :: rest => added ++ without hidden (surface rest)

/-- A replacement hides exactly the listed sequences and nothing else: what remains
visible is its own events plus the surface nodes whose sequence it did not list.
The replacement's own events are not subject to its own hiding; in the source a
replacement is logged after every node it shadows, so its sequence never collides
with a listed one. -/
theorem replace_hides_exactly {hidden : List Nat} {added : List Event}
    {rest : List Surface} {e : Event} :
    e ∈ surface (.replace hidden added :: rest) ↔
      e ∈ added ∨ (e ∈ surface rest ∧ e.seq ∉ hidden) := by
  simp only [surface, List.mem_append, mem_without]

/-- Every node the replacement did not list stays on the surface. -/
theorem unlisted_events_survive {hidden : List Nat} {added : List Event}
    {rest : List Surface} {e : Event} (hmem : e ∈ surface rest)
    (h : e.seq ∉ hidden) : e ∈ surface (.replace hidden added :: rest) :=
  replace_hides_exactly.mpr (Or.inr ⟨hmem, h⟩)

/-- A node whose sequence is listed is gone from the surface unless the replacement
itself carries it. -/
theorem listed_events_hidden {hidden : List Nat} {added : List Event}
    {rest : List Surface} {e : Event} (hadded : e ∉ added) (h : e.seq ∈ hidden) :
    e ∉ surface (.replace hidden added :: rest) := by
  intro hmem
  rcases replace_hides_exactly.mp hmem with h' | ⟨_, h'⟩
  · exact hadded h'
  · exact h' h

/-- A replacement that hides nothing only adds. -/
theorem replace_without_hidden_is_pure_append (added : List Event)
    (rest : List Surface) :
    surface (.replace [] added :: rest) = added ++ surface rest := by
  simp only [surface, without_nil]

/-- Every event the surface exposes was logged: a replacement adds events, it cannot
invent one, and the nodes it keeps come from earlier operations. -/
def loggedEvents : List Surface → List Event
  | [] => []
  | .append e :: rest => e :: loggedEvents rest
  | .replace _ added :: rest => added ++ loggedEvents rest

theorem surface_mem_logged : ∀ (ops : List Surface) {e : Event},
    e ∈ surface ops → e ∈ loggedEvents ops
  | [], e, h => by simp [surface] at h
  | Surface.append x :: rest, e, h => by
    simp only [surface, List.mem_cons] at h
    rcases h with rfl | h
    · simp [loggedEvents]
    · exact List.mem_cons_of_mem x (surface_mem_logged rest h)
  | Surface.replace hidden added :: rest, e, h => by
    rw [replace_hides_exactly] at h
    simp only [loggedEvents]
    rcases h with h | ⟨h, _⟩
    · exact List.mem_append_left _ h
    · exact List.mem_append_right _ (surface_mem_logged rest h)

/-- The request a surface fold sends. -/
def request (ops : List Surface) : List String := assemble (surface ops)

/-- Every string a request carries is the payload of a visible event the operations
logged. Read together with `assemble_congr` this is the model-visible direction of
"model-visible ⟺ logged". -/
theorem request_only_logged {ops : List Surface} {s : String}
    (h : s ∈ request ops) :
    ∃ e ∈ loggedEvents ops, e.visible = true ∧ e.payload = s := by
  obtain ⟨e, hsurf, hvis, hp⟩ := assemble_mem h
  exact ⟨e, surface_mem_logged ops hsurf, hvis, hp⟩

/-! ### One loop step

The step has no input besides the log. That is the whole point: the request it sends
is `assemble` of the log, so a step cannot smuggle an unlogged input into a request —
an input that is not a visible event cannot appear among the strings it sends. -/

/-- One abstract loop step: it opens a step boundary in the log and sends the request
assembled from the log as it stood. It abstracts the model call, the stream, and the
outcome event (`assistant/message` or `assistant/attempt`); the boundary is a log-only
event, so it adds no message. -/
def step (l : Log) : Option (Log × List String) :=
  match append l ⟨l.nextSeq, "step/start", false, ""⟩ with
  | .error _ => none
  | .ok l' => some (l', assemble l.events)

theorem step_events {l l' : Log} {req : List String} (h : step l = some (l', req)) :
    l'.events = l.events ++ [⟨l.nextSeq, "step/start", false, ""⟩] := by
  unfold step at h
  split at h
  · cases h
  · rename_i l'' heq
    simp only [Option.some.injEq, Prod.mk.injEq] at h
    rw [← h.1]
    exact append_events heq

theorem step_request {l l' : Log} {req : List String} (h : step l = some (l', req)) :
    req = assemble l.events := by
  unfold step at h
  split at h
  · cases h
  · simp only [Option.some.injEq, Prod.mk.injEq] at h
    exact h.2.symm

/-- A step only appends. -/
theorem step_prefix {l l' : Log} {req : List String} (h : step l = some (l', req)) :
    l.events <+: l'.events := by
  have hev := step_events h
  rw [hev]
  exact List.prefix_append _ _

/-- A step always runs: its boundary event carries a known kind at the next free
position, so the admission check never rejects it. -/
theorem step_isSome (l : Log) : ∃ l' req, step l = some (l', req) := by
  unfold step
  obtain ⟨l', h⟩ := append_nextSeq (l := l) (kind := "step/start") (visible := false)
    (payload := "") (by decide)
  rw [h]
  exact ⟨l', _, rfl⟩

/-- **The completeness side.** Every string the step sends is the payload of a visible
event of the log it leaves behind: the step consumed nothing that was not logged. -/
theorem step_inputs_logged {l l' : Log} {req : List String}
    (h : step l = some (l', req)) :
    ∀ s ∈ req, ∃ e ∈ l'.events, e.visible = true ∧ e.payload = s := by
  intro s hs
  rw [step_request h] at hs
  obtain ⟨e, he, hvis, hp⟩ := assemble_mem hs
  exact ⟨e, (step_events h) ▸ List.mem_append_left _ he, hvis, hp⟩

/-- Every event the step consumed is still logged afterwards, so the next step's
assembler still sees it: the request never loses an input by advancing. -/
theorem step_visible_preserved {l l' : Log} {req : List String}
    (h : step l = some (l', req)) {e : Event} (he : e ∈ l.events) : e ∈ l'.events :=
  (step_events h) ▸ List.mem_append_left _ he

/-- `Session.isOwnSeq`: the position lies at or after the fork boundary and inside the
log. The source states exactly `inheritedEventCount ≤ seq < log length`. Contiguity is
outside this model, so with gaps this test is necessary but not sufficient for the
position actually holding an event. -/
def isOwnSeq (inheritedEventCount : Nat) (l : Log) (s : Nat) : Bool :=
  decide (inheritedEventCount ≤ s) && decide (s < l.events.length)

theorem isOwnSeq_iff {inheritedEventCount : Nat} {l : Log} {s : Nat} :
    isOwnSeq inheritedEventCount l s = true ↔
      inheritedEventCount ≤ s ∧ s < l.events.length := by
  simp [isOwnSeq]

end Omd.Dsh
