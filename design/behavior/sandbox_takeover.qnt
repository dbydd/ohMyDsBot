// 担心 1：工作区在未 collect 时被提前 release，导致改动丢失；或 release 后仍被 collect 产生幽灵 patch（REQ-9）。
// 担心 2：人类通过 noVNC 介入接管桌面时，Agent 的自动化指令仍并发派发，打乱输入状态（REQ-12）。
// 盒子：COW 分配器契约盒子 dsh_cow；Agent 执行控制；人类接管观察者。
module sandbox_takeover {
  import contract.* from "../.gen/contract"
  import Vdm.* from "../.gen/contract"
  import dsh_cow as Cow from "../.gen/contract"

  pure val BRANCHES = Set("b1", "b2")
  pure val BASELINES = Set("base1", "base2")
  pure val PATCHES = Set("patch1", "patch2")

  type InputOwner = | Agent | Human

  // COW 契约反馈线
  var cowState: Cow::CowAlloc
  // 沙箱工作区：当前正在运行的分支（Nil 或 Some(branch)）
  var activeBranch: Opt[Cow::BranchId]
  // 已成功提取的 patch 集合
  var collected: Set[Cow::BranchId]
  // 当前桌面控制权属：Agent 自动化还是人类接管
  var desktopControl: InputOwner
  // Agent 操作锁：当前是否处于安全执行状态
  var agentCanInput: bool
  // 最近一次契约调用记录
  var lastCall: Call

  pure def cowAfter(s: Cow::CowAlloc, call: Call): Cow::CowAlloc = match call {
    | dsh_cow(op) => match op {
        | allocate(a) => { ...s, allocated: s.allocated.put(a.branch, a.base) }
        | collect(_) => s
        | release(a) => { ...s, allocated: s.allocated.keys().filter(k => k != a.branch).mapBy(k => s.allocated.get(k)) }
      }
    | _ => s
  }

  action init = all {
    cowState' = Cow::initial,
    activeBranch' = Nil,
    collected' = Set(),
    desktopControl' = Agent,
    agentCanInput' = true,
    lastCall' = NoCall,
  }

  // 动作 1：为任务分配 COW 隔离工作区
  action allocateWorkspace(branch: Cow::BranchId, base: Cow::Baseline): bool = all {
    activeBranch == Nil,
    not(cowState.allocated.keys().contains(branch)),
    val c = dsh_cow(Cow::allocate({ branch: branch, base: base }))
    all {
      cowState' = cowAfter(cowState, c),
      activeBranch' = Some(branch),
      collected' = collected,
      desktopControl' = Agent,
      agentCanInput' = true,
      lastCall' = c,
    }
  }

  // 动作 2：Agent 在 VM 内执行命令与桌面操作（要求拥有控制权）
  action agentStep: bool = all {
    activeBranch != Nil,
    desktopControl == Agent,
    agentCanInput,
    cowState' = cowState,
    activeBranch' = activeBranch,
    collected' = collected,
    desktopControl' = desktopControl,
    agentCanInput' = true,
    lastCall' = NoCall,
  }

  // 动作 3：人类通过 noVNC 触发接管（抢占控制权，挂起 Agent 输入）
  action humanTakeover: bool = all {
    activeBranch != Nil,
    desktopControl == Agent,
    cowState' = cowState,
    activeBranch' = activeBranch,
    collected' = collected,
    desktopControl' = Human,
    agentCanInput' = false,
    lastCall' = NoCall,
  }

  // 动作 4：人类结束接管，归还控制权给 Agent
  action humanRelease: bool = all {
    activeBranch != Nil,
    desktopControl == Human,
    cowState' = cowState,
    activeBranch' = activeBranch,
    collected' = collected,
    desktopControl' = Agent,
    agentCanInput' = true,
    lastCall' = NoCall,
  }

  // 动作 5：任务结束，收集工作区 Diff 补丁
  action collectWorkspace(b: Cow::BranchId, resultPatch: Cow::Patch): bool = all {
    activeBranch == Some(b),
    cowState.allocated.keys().contains(b),
    desktopControl == Agent,
    val c = dsh_cow(Cow::collect({ branch: b, result: resultPatch }))
    all {
      cowState' = cowAfter(cowState, c),
      activeBranch' = activeBranch,
      collected' = collected.union(Set(b)),
      desktopControl' = desktopControl,
      agentCanInput' = false,
      lastCall' = c,
    }
  }

  // 动作 6：原子释放已完成收集的工作区并销毁靶机挂载
  action releaseWorkspace(b: Cow::BranchId): bool = all {
    activeBranch == Some(b),
    cowState.allocated.keys().contains(b),
    collected.contains(b),
    val c = dsh_cow(Cow::release({ branch: b }))
    all {
      cowState' = cowAfter(cowState, c),
      activeBranch' = Nil,
      collected' = collected.filter(k => k != b),
      desktopControl' = Agent,
      agentCanInput' = true,
      lastCall' = c,
    }
  }

  action step = any {
    nondet b = BRANCHES.oneOf()
    nondet base = BASELINES.oneOf()
    allocateWorkspace(b, base),
    agentStep,
    humanTakeover,
    humanRelease,
    nondet cb = BRANCHES.oneOf()
    nondet p = PATCHES.oneOf()
    collectWorkspace(cb, p),
    nondet rb = BRANCHES.oneOf()
    releaseWorkspace(rb),
  }

  // ---------- 安全性质与不变式 ----------

  // 不变量 1：活跃工作区必须处于 allocated 集合中（REQ-9：未分配即无工作区）。
  def activeIsAllocated: bool = match activeBranch {
    | Some(b) => cowState.allocated.keys().contains(b)
    | Nil => true
  }

  // REQ-12：人类接管期间 Agent 不可能输入；REQ-9：工作区始终是已分配的那一个。
  val safety = ((desktopControl == Human) implies not(agentCanInput)) and activeIsAllocated

  // 覆盖目标 1：见证一次完整的人类接管并在活跃工作区中成功交替
  val witnessHumanTakeoverInActive =
    desktopControl == Human and not(agentCanInput) and (activeBranch != Nil)
}
