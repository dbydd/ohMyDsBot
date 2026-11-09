// 由 ssot gen 从 contract/*.vdmsl 生成；只读，不要手改。
module Vdm {
  type Opt[a] = | Nil | Some(a)
}
module dsh_cow {
  type BranchId = str
  type Baseline = str
  type Patch = str
  type CowAlloc = { allocated: BranchId -> Baseline }
  pure val initial: CowAlloc = { allocated: Map() }
  type Call =
    | allocate({ branch: BranchId, base: Baseline })
    | collect({ branch: BranchId, result: Patch })
    | release({ branch: BranchId })
}
module dsh_history {
  type Slice = str
  type Archive = { archived: Set[Slice] }
  pure val initial: Archive = { archived: Set() }
  type Call =
    | archive({ s: Slice })
}
module dsh_memory {
  type Epoch = str
  type ReflectOutcome = | ReflectOutcome_Settled | ReflectOutcome_TimedOut
  type Facts = { settled: Set[Epoch] }
  pure val initial: Facts = { settled: Set() }
  type Call =
    | reflect({ e: Epoch, result: ReflectOutcome })
}
module dsh_tavern_lorebook {
  import Vdm as Vdm
  import dsh_memory as dsh_memory
  type EntryId = str
  type Key = str
  type Priority = int
  type Tokens = int
  type Entry = { id: EntryId, keys: Set[Key], priority: Priority, cost: Tokens, constant: bool }
  type LorebookState = { epoch: Vdm::Opt[dsh_memory::Epoch], singleEntryMaxTokens: Tokens, catalog: EntryId -> Entry, frozenConstants: Set[EntryId], activeSet: Set[EntryId] }
  pure val initial: LorebookState = { epoch: Vdm::Nil, singleEntryMaxTokens: 1000, catalog: Map(), frozenConstants: Set(), activeSet: Set() }
  type Call =
    | reseed({ e: dsh_memory::Epoch })
    | registerEntry({ id: EntryId, keys: Set[Key], prio: Priority, cost: Tokens, isConstant: bool })
    | matchEntries({ observedKeys: Set[Key], budgetCap: Tokens, result: Set[EntryId] })
}
module contract {
  import dsh_cow as dsh_cow
  import dsh_history as dsh_history
  import dsh_memory as dsh_memory
  import dsh_tavern_lorebook as dsh_tavern_lorebook
  type Call =
    | NoCall
    | dsh_cow(dsh_cow::Call)
    | dsh_history(dsh_history::Call)
    | dsh_memory(dsh_memory::Call)
    | dsh_tavern_lorebook(dsh_tavern_lorebook::Call)
}
