// 担心：换届（compaction）在回合未闭合时开始，会把同一回合的消息撕裂到两个纪元（REQ-1 的边界）；
// 判定模型超时（REQ-4 的漂移）不能把换届挂死在反思一步，超时之后纪元必须照样收束（REQ-2）。
// 盒子：回合侧（行为侧，产出闭合回合与换届请求）、换届过程（行为侧，archive → reflect → reseed → freeze 顺接），
// 契约盒子 dsh_history、dsh_memory、dsh_tavern_lorebook；判定超时以 reflect 的 TimedOut 结局由环境选择。
// 每个 var 是一条带延迟的线；先后只来自线上的值，不记“走到哪一步”。
module epoch_lifecycle {
  import contract.* from "../.gen/contract"
  import Vdm.* from "../.gen/contract"
  import dsh_history as History from "../.gen/contract"
  import dsh_memory as Memory from "../.gen/contract"
  import dsh_tavern_lorebook as Lorebook from "../.gen/contract"

  pure val SLICES = Set("s1", "s2", "s3")
  pure val EPOCHS = Set("e1", "e2", "e3")
  pure val ENTRIES = Set("lore1", "lore2")

  type Phase = | Growing | Compacting

  // 契约盒子的反馈线。
  var hist: History::Archive
  var mem: Memory::Facts
  var lore: Lorebook::LorebookState
  // 回合侧：是否有未闭合的回合。
  var openTurn: bool
  // 换届侧：当前纪元在追加（Growing）还是在换届（Compacting）。
  var phase: Phase
  // 换届已被请求（阈值达到）但还没开始。
  var wanted: bool
  // 已经进入过换届的纪元身份。
  var touched: Set[Memory::Epoch]
  // 换届过程各步之间的线（进程内）。归档线上带着切片与它所属的纪元。
  var toArchive: Set[(History::Slice, Memory::Epoch)]
  var toReflect: Set[Memory::Epoch]
  var toReseed: Set[Memory::Epoch]
  var lastCall: Call

  // ---------- 契约盒子的反馈线按 VDM post 前进 ----------
  pure def historyAfter(s: History::Archive, call: Call): History::Archive = match call {
    | dsh_history(op) => match op {
        | archive(a) => { ...s, archived: s.archived.union(Set(a.s)) }
      }
    | _ => s
  }

  pure def memoryAfter(s: Memory::Facts, call: Call): Memory::Facts = match call {
    | dsh_memory(op) => match op {
        | reflect(a) => match a.result {
            | ReflectOutcome_Settled => { ...s, settled: s.settled.union(Set(a.e)) }
            | ReflectOutcome_TimedOut => s
          }
      }
    | _ => s
  }

  pure def lorebookAfter(s: Lorebook::LorebookState, call: Call): Lorebook::LorebookState = match call {
    | dsh_tavern_lorebook(op) => match op {
        | reseed(a) => {
            ...s,
            epoch: Some(a.e),
            frozenConstants: s.catalog.keys().filter(id => s.catalog.get(id).constant),
            activeSet: s.catalog.keys().filter(id => s.catalog.get(id).constant)
          }
        | registerEntry(a) => {
            ...s,
            catalog: s.catalog.put(a.id, { id: a.id, keys: a.keys, priority: a.prio, cost: a.cost, constant: a.isConstant })
          }
        | matchEntries(a) => {
            ...s,
            activeSet: a.result
          }
      }
    | _ => s
  }

  action commit(call: Call): bool = all {
    lastCall' = call,
    hist' = historyAfter(hist, call),
    mem' = memoryAfter(mem, call),
    lore' = lorebookAfter(lore, call),
  }

  // 进程内的线都不变。
  action processWiresUnchanged = all {
    toArchive' = toArchive,
    toReflect' = toReflect,
    toReseed' = toReseed,
  }

  action init = all {
    hist' = History::initial,
    mem' = Memory::initial,
    lore' = Lorebook::initial,
    openTurn' = false,
    phase' = Growing,
    wanted' = false,
    touched' = Set(),
    toArchive' = Set(), toReflect' = Set(), toReseed' = Set(),
    lastCall' = NoCall,
  }

  // ---------- 回合侧：REQ-1 的线性追加 ----------
  action turnOpen: bool = all {
    phase == Growing,
    not(openTurn),
    openTurn' = true,
    phase' = phase, wanted' = wanted, touched' = touched,
    processWiresUnchanged,
    commit(NoCall),
  }

  action turnClose: bool = all {
    openTurn,
    openTurn' = false,
    phase' = phase, wanted' = wanted, touched' = touched,
    processWiresUnchanged,
    commit(NoCall),
  }

  // 阈值达到：换届被请求。请求可以在回合中途到来，换届本身必须等回合闭合。
  // （同时覆盖 DS-Bot Steward 的 compact/switch 触发或 Web GUI 面板的手动“立即重播种”按钮）
  action requestCompaction: bool = all {
    phase == Growing,
    not(wanted),
    wanted' = true,
    openTurn' = openTurn, phase' = phase, touched' = touched,
    processWiresUnchanged,
    commit(NoCall),
  }

  // REQ-8：用户在 Web GUI 面板（DS-Bot 详情抽屉 Tab 或 Agent 浮层）新增/暂存一条常驻世界书条目。
  // 暂存只更新 catalog，当前纪元的 frozenConstants 保持不变，直到下一次 reseed 才进入冻结前缀。
  action stageGuiEntry(id: Lorebook::EntryId): bool = all {
    not(id.in(lore.catalog.keys())),
    openTurn' = openTurn, phase' = phase, wanted' = wanted, touched' = touched,
    processWiresUnchanged,
    commit(dsh_tavern_lorebook(Lorebook::registerEntry({
      id: id,
      keys: Set(),
      prio: 10,
      cost: 50,
      isConstant: true,
    }))),
  }

  // ---------- 换届过程：archive → reflect → reseed → freeze ----------
  // REQ-1：回合未闭合时不开始换届；切片与它所属的纪元一起进入归档线。
  action beginCompaction(s: History::Slice, e: Memory::Epoch): bool = all {
    wanted,
    not(openTurn),
    phase == Growing,
    not(s.in(hist.archived)),
    not(e.in(touched)),
    phase' = Compacting,
    wanted' = false,
    touched' = touched.union(Set(e)),
    toArchive' = toArchive.union(Set((s, e))),
    toReflect' = toReflect,
    toReseed' = toReseed,
    openTurn' = openTurn,
    commit(NoCall),
  }

  action archiveSlice(s: History::Slice, e: Memory::Epoch): bool = all {
    (s, e).in(toArchive),
    toArchive' = toArchive.exclude(Set((s, e))),
    toReflect' = toReflect.union(Set(e)),
    toReseed' = toReseed,
    openTurn' = openTurn, phase' = phase, wanted' = wanted, touched' = touched,
    commit(dsh_history(History::archive({ s: s }))),
  }

  // REQ-2/REQ-4：反思的结局由环境选择——判定超时以 TimedOut 回来，换届照样往下走。
  action reflectEpoch(e: Memory::Epoch, settled: bool): bool = all {
    e.in(toReflect),
    not(e.in(mem.settled)),
    val res = if (settled) Memory::ReflectOutcome_Settled else Memory::ReflectOutcome_TimedOut
    all {
      toReflect' = toReflect.exclude(Set(e)),
      toReseed' = toReseed.union(Set(e)),
      toArchive' = toArchive,
      openTurn' = openTurn, phase' = phase, wanted' = wanted, touched' = touched,
      commit(dsh_memory(Memory::reflect({ e: e, result: res }))),
    }
  }

  action reseedLorebook(e: Memory::Epoch): bool = all {
    e.in(toReseed),
    toReseed' = toReseed.exclude(Set(e)),
    toArchive' = toArchive,
    toReflect' = toReflect,
    openTurn' = openTurn, phase' = phase, wanted' = wanted, touched' = touched,
    commit(dsh_tavern_lorebook(Lorebook::reseed({ e: e }))),
  }

  // REQ-2：重播种完成、换届各线清空之后冻结前缀，纪元回到追加态。
  action freeze: bool = all {
    phase == Compacting,
    toArchive == Set(),
    toReflect == Set(),
    toReseed == Set(),
    phase' = Growing,
    openTurn' = openTurn, wanted' = wanted, touched' = touched,
    processWiresUnchanged,
    commit(NoCall),
  }

  action step: bool = {
    nondet s = SLICES.oneOf()
    nondet e = EPOCHS.oneOf()
    nondet id = ENTRIES.oneOf()
    nondet settled = Set(true, false).oneOf()
    any {
      turnOpen, turnClose,
      requestCompaction,
      stageGuiEntry(id),
      beginCompaction(s, e), archiveSlice(s, e), reflectEpoch(e, settled), reseedLorebook(e), freeze,
    }
  }

  // ---------- 性质：写在对外可观察的线上 ----------
  // REQ-1：回合未闭合时纪元必在追加态——openTurn 与 phase 两条线之间的不变式。
  // REQ-8：已冻结的常驻集必须是 catalog 的子集，且 GUI 暂存不会在未重播种时破坏 openTurn 边界。
  val safety = (openTurn implies phase == Growing) and lore.frozenConstants.subseteq(lore.catalog.keys())

  // ---------- 覆盖目标：说明模型确实走到了这些情形 ----------
  // REQ-2：换届在纪元完成沉淀后冻结。
  val witnessSettledFreeze = touched.exists(e => e.in(mem.settled)) and phase == Growing
  // REQ-2/REQ-4：判定超时的纪元没有挂死换届——超时之后仍然冻结。
  val witnessTimedOutStillFrozen = touched.exists(e => not(e.in(mem.settled))) and phase == Growing
  // REQ-1：换届请求在回合未闭合时到达，换届被推迟。
  val witnessDeferredCompaction = wanted and openTurn
  pure val maxSteps_witnessDeferredCompaction = 40
  // REQ-8：GUI 面板暂存了新的常驻条目（在 catalog 中但尚未进入 frozenConstants），保护当前纪元前缀不失效。
  val witnessGuiStagedWithoutPrefixBreak = lore.catalog.keys().exclude(lore.frozenConstants) != Set() and phase == Growing
}
