/-
Shared vocabulary for the dsh formalisation.

Nothing here is specific to one module. A *guard* is a Boolean condition over
named platform atoms, which is how a composed row's `disabled:` field is
modelled: `disabled: !!js "process.platform === 'win32'"` becomes
`Cond.atom "win32"`, a literal `disabled: true` becomes `Cond.always`, and a row
with no `disabled:` key becomes `Cond.never`.
-/
namespace Omd

/-- A Boolean condition over named atoms.

`atom "always"` and `atom "never"` are fixed by `eval`; every other atom is read
from the platform assignment. That keeps a literal `disabled: true` true under
every assignment, so a universal statement over assignments is still a statement
about the real composition. -/
inductive Cond where
  | atom (name : String)
  | neg (c : Cond)
  | all (a b : Cond)
  | any (a b : Cond)
  deriving DecidableEq, Repr

namespace Cond

/-- Evaluate a condition under one assignment of platform atoms. -/
def eval (asg : List (String × Bool)) : Cond → Bool
  | .atom "always" => true
  | .atom "never" => false
  | .atom n => (asg.lookup n).getD false
  | .neg c => !eval asg c
  | .all a b => eval asg a && eval asg b
  | .any a b => eval asg a || eval asg b

/-- The always-true condition. -/
def always : Cond := .atom "always"

/-- The always-false condition. -/
def never : Cond := .atom "never"

@[simp] theorem eval_always (asg : List (String × Bool)) : always.eval asg = true := rfl

@[simp] theorem eval_never (asg : List (String × Bool)) : never.eval asg = false := rfl

end Cond

/-- One row of a composed profile, reduced to what activation depends on.

`guard` is the condition under which the row is *disabled*. `requires` is the
row's declared `inject` list. `provides` is the set of service keys the row's
module registers; it is read off the package, not off the row. -/
structure Entry where
  id : String
  package : String
  provides : List String
  requires : List String
  guard : Cond
  deriving Repr, DecidableEq

/-- A row is mounted exactly when its guard does not hold. -/
def Entry.enabled (asg : List (String × Bool)) (e : Entry) : Bool :=
  !e.guard.eval asg

/-- Some enabled row provides the key. -/
def provided (asg : List (String × Bool)) (l : List Entry) (k : String) : Bool :=
  l.any fun e => e.enabled asg && e.provides.contains k

@[simp] theorem provided_nil (asg : List (String × Bool)) (k : String) :
    provided asg [] k = false := rfl

theorem provided_of_mem {asg : List (String × Bool)} {l : List Entry} {e : Entry}
    (h : e ∈ l) (he : e.enabled asg = true) (hk : k ∈ e.provides) :
    provided asg l k = true := by
  unfold provided
  apply List.any_eq_true.mpr
  exact ⟨e, h, by simp [he, hk]⟩

end Omd
