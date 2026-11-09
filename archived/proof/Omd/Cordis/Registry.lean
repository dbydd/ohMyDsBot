/-
Service registration and lookup, after dsh at commit
687f282e8625c6b8d11ff58211a90524be2e4317.

Sources:

* `refs/deepseek-harness/vendor/cordis/src/reflect.ts` — `ReflectService.provide`
  throws when the key is already in the store; `ReflectService.get` reads the
  store without consulting the caller; the `get` proxy trap resolves a property
  by walking the fiber parent chain.
* `refs/deepseek-harness/vendor/cordis/src/service.ts` — a `Service` registers
  itself under exactly one name on construction.
* `refs/deepseek-harness/vendor/cordis/src/registry.ts` — `RegistryService`,
  the plugin-runtime table that the service store hangs off.
* `refs/deepseek-harness/packages/AGENTS.md` — the rule that optional services
  go through `ctx.get`: the property proxy is topology-sensitive, while strict
  `ctx.get` reads the global service store.
* `refs/deepseek-harness/docs/postmortem/0001-acp-default-export-drops-inject.md`
  — the same rule stated as a postmortem finding: the proxy resolves by an
  ancestor-only fiber walk and fails through a shadow, so a sibling's service
  is unreachable that way.

Modelled here: one flat store of `key ↦ providing context id`, honouring the
one-row-per-key rule; `get` as a total store read with no caller argument; and
`proxy` as a walk over the caller's ancestor chain, where the nearest context
that provides the key wins.

Deliberately outside the model: asynchronous disposal and fiber lifetimes (a
registration here is permanent, so registration order never matters); the
`isolate` label that shadows a store key; own properties of the context object,
which shadow a service before the walk even starts; `accessor`, `mixin` and
`set` on the same proxy; reflection *over* the registry (`keys`, `values`,
`entries`, `forEach`) and the plugin-runtime bookkeeping in `RegistryService`;
and the `strict` flag of `get`, which hides a service whose providing fiber is
not active. The real proxy throws in a live context when it cannot reach the
provider; this model answers `none`, which is what `ReflectService.get` returns.
-/
import Omd.Basic

namespace Omd.Cordis.Registry

/-- A service name, as passed to `ctx.provide(name, …)` and `ctx.get(name)`. -/
abbrev Key := String

/-- Identity of one context, i.e. one fiber. The model never builds the context
tree: an ancestor chain is supplied by the caller of `proxy`. -/
abbrev CtxId := Nat

/-- One row of the service store: the key and the context that registered it. -/
structure Registration where
  key : Key
  provider : CtxId
  deriving DecidableEq, Repr

/-- The service store. `register` is the only constructor the model offers, so
every reachable registry has at most one row per key. -/
abbrev Registry := List Registration

/-- No key is registered twice. This is the invariant `register` maintains and
the hypothesis the proxy theorems need; `get` alone does not need it. -/
def Unique (r : Registry) : Prop := (r.map Registration.key).Nodup

/-- Whether the key already has a row. -/
def hasKey (r : Registry) (k : Key) : Bool := r.any fun p => p.key == k

/-- The row a context registered for a key, if that context registered one.
This is the per-fiber store the proxy consults at each step of its walk. -/
def findAt (r : Registry) (c : CtxId) (k : Key) : Option Registration :=
  r.find? fun p => p.key == k && p.provider == c

/-- Add a row for `k`, or refuse when `k` is taken. This is `ctx.provide`, which
throws `service "…" has been registered at <…>` in the same situation. -/
def register (r : Registry) (k : Key) (c : CtxId) : Except String Registry :=
  if hasKey r k then
    .error s!"service \"{k}\" has been registered"
  else
    .ok (r ++ [{ key := k, provider := c }])

/-- Read the store by key. There is no caller argument: this is `ctx.get`,
which reads the global store rather than the caller's chain. -/
def get (r : Registry) (k : Key) : Option CtxId :=
  (r.find? fun p => p.key == k).map Registration.provider

/-- The `ctx.<key>` property proxy. `chain` is the caller's fiber followed by
its ancestors, nearest first; the walk answers with the first context on that
chain that provides `k`, and `none` when the chain has no such context. -/
def proxy (r : Registry) : List CtxId → Key → Option CtxId
  | [], _ => none
  | c :: rest, k =>
    match findAt r c k with
    | some p => some p.provider
    | none => proxy r rest k

/-! ## Registration -/

theorem hasKey_iff_exists (r : Registry) (k : Key) :
    hasKey r k = true ↔ ∃ p ∈ r, p.key = k := by
  unfold hasKey
  rw [List.any_eq_true]
  constructor
  · rintro ⟨p, hp, hpk⟩
    exact ⟨p, hp, by simpa using hpk⟩
  · rintro ⟨p, hp, hpk⟩
    exact ⟨p, hp, by simp [hpk]⟩

/-- A key that is already taken cannot be registered again. -/
theorem register_duplicate_fails {r : Registry} {k : Key} {c : CtxId}
    (h : hasKey r k = true) :
    ∃ e, register r k c = .error e := by
  refine ⟨s!"service \"{k}\" has been registered", ?_⟩
  simp [register, h]

/-- A fresh key is registered and appended to the store. -/
theorem register_fresh {r : Registry} {k : Key} {c : CtxId}
    (h : hasKey r k = false) :
    register r k c = .ok (r ++ [{ key := k, provider := c }]) := by
  simp [register, h]

/-- No key means the store lookup finds nothing. -/
theorem find?_eq_none_of_no_key {r : Registry} {k : Key} (h : hasKey r k = false) :
    r.find? (fun p => p.key == k) = none := by
  rw [List.find?_eq_none]
  intro p hp hpk
  have hkey : hasKey r k = true := (hasKey_iff_exists r k).mpr ⟨p, hp, by simpa using hpk⟩
  rw [hkey] at h
  exact Bool.noConfusion h

/-- A successful registration leaves the key reachable through `get`. -/
theorem get_register_fresh {r : Registry} {k : Key} {c : CtxId}
    (h : hasKey r k = false) : get (r ++ [{ key := k, provider := c }]) k = some c := by
  have hp : (fun p : Registration => p.key == k) { key := k, provider := c } = true := by
    simp
  unfold get
  rw [List.find?_append, find?_eq_none_of_no_key h]
  simp only [Option.none_or]
  rw [List.find?_cons_of_pos (p := fun p : Registration => p.key == k)
        (a := { key := k, provider := c }) (l := []) hp]
  rfl

/-- Registration preserves key uniqueness. -/
theorem register_unique {r : Registry} {k : Key} {c : CtxId} {r' : Registry}
    (hu : Unique r) (h : register r k c = .ok r') : Unique r' := by
  by_cases hk : hasKey r k = true
  · obtain ⟨e, he⟩ := register_duplicate_fails (c := c) hk
    rw [he] at h
    cases h
  · have hk' : hasKey r k = false := by simpa using hk
    rw [register_fresh hk'] at h
    cases h
    unfold Unique at *
    rw [List.map_append, List.map_cons, List.map_nil, List.nodup_append]
    refine ⟨hu, by simp, ?_⟩
    intro x hx y hy hxy
    have hy' : y = k := by simpa using hy
    have hxk : k ∈ r.map Registration.key := by
      have hxy' : x = k := by rw [hxy, hy']
      rw [← hxy']
      exact hx
    obtain ⟨p, hp, hpk⟩ := List.mem_map.mp hxk
    have hkey : hasKey r k = true := (hasKey_iff_exists r k).mpr ⟨p, hp, hpk⟩
    rw [hkey] at hk'
    exact Bool.noConfusion hk'

/-! ## Store reads -/

/-- A registration in the store is what `get` returns for its key, provided the
store has one row per key. -/
theorem get_eq_provider_of_mem {r : Registry} (hu : Unique r) {row : Registration}
    (hp : row ∈ r) : get r row.key = some row.provider := by
  induction r with
  | nil => exact absurd hp (by simp)
  | cons hd tl ih =>
    unfold Unique at hu
    rw [List.map_cons, List.nodup_cons] at hu
    obtain ⟨hhd, htl⟩ := hu
    rcases List.mem_cons.mp hp with hrow | hp
    · rw [hrow]
      unfold get
      rw [List.find?_cons_of_pos (p := fun x : Registration => x.key == hd.key)
            (a := hd) (l := tl) (by simp)]
      rfl
    · have hne : ¬ (fun x : Registration => x.key == row.key) hd = true := by
        intro hh
        have hk : hd.key = row.key := by simpa using hh
        have hmem : hd.key ∈ tl.map Registration.key :=
          List.mem_map.mpr ⟨row, hp, hk.symm⟩
        exact absurd hmem hhd
      unfold get
      rw [List.find?_cons_of_neg (p := fun x : Registration => x.key == row.key)
            (a := hd) (l := tl) hne]
      exact ih htl hp

/-- In a store with one row per key, a row found by key has the provider `get`
reports. -/
theorem provider_eq_of_mem {r : Registry} (hu : Unique r) {p : Registration}
    (hp : p ∈ r) {c : CtxId} (h : get r p.key = some c) : p.provider = c := by
  have hrow := get_eq_provider_of_mem hu hp
  rw [hrow] at h
  exact Option.some.inj h

/-- `get` only ever answers with a registered row's provider. -/
theorem exists_of_get_eq_some {r : Registry} {k : Key} {c : CtxId}
    (h : get r k = some c) : ∃ p ∈ r, p.key = k ∧ p.provider = c := by
  unfold get at h
  cases hf : r.find? (fun p => p.key == k) with
  | none => rw [hf] at h; simp at h
  | some p =>
    have hp : p ∈ r := List.mem_of_find?_eq_some hf
    have hpk : p.key = k := by simpa using List.find?_some hf
    have hpc : p.provider = c := by rw [hf] at h; simpa using h
    exact ⟨p, hp, hpk, hpc⟩

/-- Caller-independent read: `peek` is `get` with a caller argument that the
body ignores, which is the shape of `ctx.get(name)`. -/
def peek (_caller : CtxId) (r : Registry) (k : Key) : Option CtxId := get r k

/-- Two contexts in the same registry read the same `get` value, whatever sits
between them in the tree. -/
theorem get_independent_of_caller (r : Registry) (k : Key) (c₁ c₂ : CtxId) :
    peek c₁ r k = peek c₂ r k := rfl

/-! ## Proxy reads -/

/-- The proxy answers with a context on the chain it walked. -/
theorem proxy_mem_chain {r : Registry} {chain : List CtxId} {k : Key} {c : CtxId}
    (h : proxy r chain k = some c) : c ∈ chain := by
  induction chain with
  | nil => simp [proxy] at h
  | cons a rest ih =>
    cases hf : findAt r a k with
    | none =>
      have hval : proxy r (a :: rest) k = proxy r rest k := by simp [proxy, hf]
      rw [hval] at h
      exact List.mem_cons_of_mem a (ih h)
    | some p =>
      have hval : proxy r (a :: rest) k = some p.provider := by simp [proxy, hf]
      rw [hval] at h
      unfold findAt at hf
      have hpred := List.find?_some hf
      rw [Bool.and_eq_true] at hpred
      have hpa : p.provider = a := by simpa using hpred.2
      have hpc : p.provider = c := by simpa using h
      rw [← hpc, hpa]
      exact List.mem_cons_self

/-- A provider on the caller's chain is what the proxy returns, and it agrees
with `get`. -/
theorem proxy_sees_ancestor {r : Registry} (hu : Unique r) {k : Key} {c : CtxId}
    (h : get r k = some c) {chain : List CtxId} (hc : c ∈ chain) :
    proxy r chain k = some c := by
  induction chain with
  | nil => exact absurd hc (by simp)
  | cons a rest ih =>
    rcases List.mem_cons.mp hc with rfl | hc
    · cases hf : findAt r c k with
      | some q =>
        have hval : proxy r (c :: rest) k = some q.provider := by simp [proxy, hf]
        rw [hval]
        unfold findAt at hf
        have hpred := List.find?_some hf
        rw [Bool.and_eq_true] at hpred
        have hqc : q.provider = c := by simpa using hpred.2
        rw [hqc]
      | none =>
        obtain ⟨p, hp, hpk, hpc⟩ := exists_of_get_eq_some h
        have hpred : (fun p : Registration => p.key == k && p.provider == c) p = true := by
          rw [Bool.and_eq_true]
          exact ⟨by simp [hpk], by simp [hpc]⟩
        unfold findAt at hf
        rw [List.find?_eq_none] at hf
        exact absurd hpred (hf p hp)
    · cases hf : findAt r a k with
      | none =>
        have hval : proxy r (a :: rest) k = proxy r rest k := by simp [proxy, hf]
        rw [hval]
        exact ih hc
      | some q =>
        have hval : proxy r (a :: rest) k = some q.provider := by simp [proxy, hf]
        rw [hval]
        unfold findAt at hf
        have hpred := List.find?_some hf
        rw [Bool.and_eq_true] at hpred
        have hqk : q.key = k := by simpa using hpred.1
        have hqmem : q ∈ r := List.mem_of_find?_eq_some hf
        have hqc : q.provider = c :=
          provider_eq_of_mem hu hqmem (by rw [hqk]; exact h)
        rw [hqc]

/-- Whatever the proxy returns, `get` returns too: the proxy can only narrow the
store, never invent a value. -/
theorem proxy_agrees_with_get {r : Registry} (hu : Unique r) {chain : List CtxId}
    {k : Key} {c : CtxId} (h : proxy r chain k = some c) : get r k = some c := by
  induction chain with
  | nil => simp [proxy] at h
  | cons a rest ih =>
    cases hf : findAt r a k with
    | none =>
      have hval : proxy r (a :: rest) k = proxy r rest k := by simp [proxy, hf]
      rw [hval] at h
      exact ih h
    | some q =>
      have hval : proxy r (a :: rest) k = some q.provider := by simp [proxy, hf]
      rw [hval] at h
      have hqc : q.provider = c := by simpa using h
      unfold findAt at hf
      have hpred := List.find?_some hf
      rw [Bool.and_eq_true] at hpred
      have hqk : q.key = k := by simpa using hpred.1
      have hqmem : q ∈ r := List.mem_of_find?_eq_some hf
      rw [← hqk, get_eq_provider_of_mem hu hqmem, hqc]

/-- A provider off the caller's chain is invisible to the proxy. -/
theorem proxy_none_of_off_chain {r : Registry} (hu : Unique r) {k : Key} {c : CtxId}
    (h : get r k = some c) {chain : List CtxId} (hc : c ∉ chain) :
    proxy r chain k = none := by
  cases hp : proxy r chain k with
  | none => rfl
  | some c' =>
    have hmem : c' ∈ chain := proxy_mem_chain hp
    have hget : get r k = some c' := proxy_agrees_with_get hu hp
    rw [h] at hget
    have hcc : c = c' := Option.some.inj hget
    subst hcc
    exact absurd hmem hc

/-- Sibling branches: the store is shared, the chain is not. Two leaves under one
root, each providing a key of its own; the root provides a third. Each leaf sees
its own provider and the root's, and not its sibling's, while `get` still
returns the sibling's provider. -/
theorem sibling_hidden_from_proxy_visible_to_get {r : Registry} (hu : Unique r)
    {keyA keyB keyRoot : Key} {a b root : CtxId}
    (hA : get r keyA = some a) (hB : get r keyB = some b) (hR : get r keyRoot = some root)
    (hNotB : a ∉ [b, root]) (hNotA : b ∉ [a, root]) :
    proxy r [b, root] keyA = none ∧ get r keyA = some a ∧
    proxy r [a, root] keyB = none ∧ get r keyB = some b ∧
    proxy r [b, root] keyRoot = some root ∧ proxy r [a, root] keyRoot = some root := by
  refine ⟨proxy_none_of_off_chain hu hA hNotB, hA,
          proxy_none_of_off_chain hu hB hNotA, hB,
          proxy_sees_ancestor hu hR (by simp), proxy_sees_ancestor hu hR (by simp)⟩

/-! ## A concrete registry

Root context `0`; branch leaves `1` and `2` under it. `1` provides `fs`, `2`
provides `net`, the root provides `logger`. -/

/-- The root context id used by the sample tree. -/
def rootCtx : CtxId := 0

/-- Chain of the `fs` branch, nearest first. -/
def chainFs : List CtxId := [1, 0]

/-- Chain of the `net` branch, nearest first. -/
def chainNet : List CtxId := [2, 0]

/-- Three registrations, one per context. -/
def demoRegistry : Registry :=
  [{ key := "logger", provider := rootCtx },
   { key := "fs", provider := 1 },
   { key := "net", provider := 2 }]

/-- The sample store never registers a key twice. -/
theorem demoRegistry_unique : Unique demoRegistry := by
  show (demoRegistry.map Registration.key).Nodup
  decide

/-- The sibling rule on the sample tree: `net` is invisible from the `fs` branch
through the proxy, and readable from both branches through `get`. -/
theorem demo_sibling_hidden_from_proxy :
    proxy demoRegistry chainFs "net" = none ∧
    get demoRegistry "net" = some 2 ∧
    proxy demoRegistry chainNet "net" = some 2 ∧
    proxy demoRegistry chainNet "fs" = none ∧
    get demoRegistry "fs" = some 1 ∧
    proxy demoRegistry chainFs "logger" = some rootCtx ∧
    proxy demoRegistry chainNet "logger" = some rootCtx := by
  decide

/-- The proxy's answer depends on the caller's chain; `get`'s does not. -/
theorem proxy_depends_on_caller :
    proxy demoRegistry chainFs "net" ≠ proxy demoRegistry chainNet "net" ∧
    peek 1 demoRegistry "net" = peek 2 demoRegistry "net" := by
  decide

end Omd.Cordis.Registry
