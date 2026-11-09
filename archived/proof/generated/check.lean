/-
The generated facts checked against the kernel predicates.

`kernel`, `order`, `external` come from `scripts/extract.mjs`; the predicates come
from `Omd/Kernel/Spec.lean`; the activation bridge comes from
`Omd/Kernel/Composition.lean`. Every `#eval` here is a proof obligation of
`Omd/Kernel/Facts.lean` — this file is the readable run log, the Facts file is the
one that must build.
-/
import Omd.Kernel.Spec
import Omd.Kernel.Generated
import Omd.Kernel.Composition

open Omd
open Omd.Kernel

/-- Enabled rows whose requirement no enabled row provides. The launcher keys
(`external`) are expected here; they are provided by the bridge's synthetic rows. -/
def unprovided (asg : List (String × Bool)) (l : List Entry) : List (String × String) :=
  l.flatMap fun e =>
    if e.enabled asg then
      (e.requires.filter fun k => !provided asg l k).map fun k => (e.id, k)
    else []

/-- Keys with more than one enabled provider. -/
def duplicated (asg : List (String × Bool)) (l : List Entry) : List String :=
  let keys := (l.filter fun e => e.enabled asg).flatMap fun e => e.provides
  keys.filter fun k =>
    1 < (keys.filter fun k' => k' == k).length

-- 1. No enabled row has a requirement that no enabled row provides, except the launcher keys.
#eval unprovided env kernel
-- expected: only (row, key) pairs where key ∈ external

-- 2. No key has two enabled providers.
#eval duplicated env kernel
-- expected: []

-- 3. The interface rows are enabled.
#eval interfaceRows.filter fun i => !(enabledIds env kernel).contains i
-- expected: []

-- 4. No human-facing row is enabled.
#eval rowsThatNeedAHuman.filter fun i => (enabledIds env kernel).contains i
-- expected: []

-- 5. No machine-bound row is enabled.
#eval rowsBoundToThisMachine.filter fun i => (enabledIds env kernel).contains i
-- expected: []

-- 6. `order` covers `kernel` exactly once (the bridge's `coversOk`).
#eval coversOk order kernel
-- expected: true

-- 7. The topological check holds under `env`.
#eval topoOk env external order kernel
-- expected: true

-- 8. Launcher row ids never collide with real entry ids (the bridge's `hdisj`).
#eval external.all fun k => !(order.contains ("launcher:" ++ k))
-- expected: true

-- 9. Enabled rows under `env`, for the record.
#eval (enabledIds env kernel).length
#eval kernel.length
#eval order.length
#eval external
