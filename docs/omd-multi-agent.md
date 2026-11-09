# omd 多 agent 调度与角色：现状与决定

本文固定五件事：dsh 原生给到的东西、重合面审计、角色系统设计、IRC 机制评估、隔离与回收。写代码前先读这里。

## 1. dsh 原生给到的（绝不重复造轮子）

| 能力 | 位置 | 说明 |
|---|---|---|
| 子代理服务 | `ctx.subagents` | 命名 provider 注册表；`spawn` 与 `fork` 在进程内；ACP / Codex / SDK 进程级后端 |
| 并发与深度配置 | `subagent` entry 的 `Config` | `maxActiveSubagents`（默认 8）与 `maxDepth`（默认 1），两者都是 `.volatile()`：profile patch 里可以直接改，Plugins → Subagent 页面也可改 |
| 容量语义 | 服务内部 | 满了直接拒绝（`ACTIVATION_LIMIT_REACHED`），不排队。理由是“父等子时不能等自己的槽位” |
| 派发工具 | `subagent` / `subagent_fork` | 立即返回 childId，完成后父会话收到完成通知（最终文本 + 结构化结果） |
| 父子消息 | `send_message` / `interrupt_agent` / `list_agents` | 直接父子之间可用；工作中的目标在最近 step 边界收 steer，空闲目标被唤醒或冷恢复 |
| 代理名册 | `subagentCatalog` 投影 | 自动折叠，重启后仍能枚举所有子代理；`list_agents` 读它 |

**关于 Claude Code**：完全不使用，不挂载 `@deepseek-ai/dsh-subagent-claude-code`，也不在任何 profile 或配置中引用。

## 2. omd-task 与 dsh 的重合面审计

dsh 的原生工具已经覆盖了**单一代理派发**、**父子消息**、**中断**和**名册查询**。

`omd-task` 只保留 dsh 没有的三件事，其余重合面全部砍掉：
1. **批处理（Batch）**：一次调用接收 `tasks[]`，同时派发多个子代理，每个 item 可带独立说明与 schema。
2. **排队（Queue）**：当 live 子代理数量达到 dsh 的 `maxActiveSubagents` 时，超出的任务在队列中等待槽位，而不是像 dsh 那样直接抛错失败。
3. **隔离与带回（Isolate & Apply-back）**：`isolated: true` 时先向分配器要一个独立工作树，将路径作为子代理的 `cwd` 传给 dsh；子代理结束后提取 diff，串行应用回父工作树，冲突则如实报错。

**不重造的**：
- 不做自定义消息工具（用原生的 `send_message`）。
- 不做自定义名册投影（用原生的 `subagentCatalog` 和 `list_agents`，因此不挂 `omd-agents-hub`）。

## 3. 角色系统设计（`omd-roles`，服务键 `ctx.modelRoles`）

dsh 只有全局唯一的 `agent-default-model`，或者子代理在创建时覆盖 `agentOptions`。
omp 的核心模式是**把角色当作一次带 schema 的函数调用**：判断、摘要、精简、审查等都不应该走完整的多轮 Agent，而是单次快速调用。

服务接口契约：
```ts
export interface RoleRoute {
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
}

export interface RoleCallRequest {
  prompt?: string
  messages?: unknown[]
  schema?: unknown
  signal?: AbortSignal
}

export interface RoleCallResult {
  text: string
  value?: unknown
}

export interface ModelRolesService {
  get(name: string): RoleRoute
  list(): string[]
  call(name: string, request: RoleCallRequest): Promise<RoleCallResult>
}
```

- 配置：`roles: Record<string, RoleRoute>`（volatile）、`fallback: string[]`（默认 `['default']`）。
- 未命中的角色走 fallback 链，兜底退回到 `agent-default-model`。
- `call` 通过 `ctx.llm` 发起单次请求；提供 `schema` 时解析 JSON，如果失败重试一次，仍然失败则响亮抛错。
- 命名不用 `ctx.roles`（与 schemastery 的 `.role()` 冲突），使用 `modelRoles`。

## 4. IRC 消息机制说明

dsh 原生的消息通道（`send_message`）严格局限在**直接父子**之间。
- 子代理不能向兄弟代理发送消息。
- 无法广播。
在 dsh 架构下实现真正的全双工或兄弟间 IRC，需要跨会话注入（利用父作为中继，或者外挂全局 event bus）。
本阶段**优先保证父子间稳定通信**（dsh 原生 `send_message` 足够用），兄弟间的协调通过父代理统一汇总和派发。

## 5. 隔离分配器与回收器（`omd-worktree-alloc`）

只有一种隔离方式：APFS clonefile 复制。不需要 git 仓库，普通目录同样适用。

1. **复制**：在 macOS APFS 卷上，`cp -cR` 把调用者指定的目录复制进池子，秒级完成，未跟踪文件与已装依赖一并带过去，写之前不占额外空间。非 APFS 卷直接报错，不退化成逐字节复制。
2. **两份副本**：同一目录复制两份。一份作为 baseline 保持不动，另一份交给子代理；工作副本从 baseline 再复制，所以两份起始内容完全一致。
3. **收集**：子代理完成时由调度器触发。逐路径比较 baseline 与工作副本的文件大小和修改时间，元数据仍一致的路径再逐字节比较，生成带 `diff --git` 头的统一 diff。二进制改动只报文件名和字节数，不进 patch。
4. **打回**：patch 用 `git apply` 串行写回源目录。只需要 git 可执行文件，不需要仓库；patch 里没有 blob 名，所以没有三方合并。先对整份 patch 做 `--check`，冲突时一个字节都不写，把 git 拒绝的文件列表返回给调用者。
5. **释放**：打回成功后工作副本与 baseline 一起删除，两者是一个整体。进程不再持有的孤儿条目由定时扫池清理，只剩下 baseline 的条目也一并回收。

## 6. 挂载策略

`subagent` / `task` 这一套不放半套进 profile。等四个部件都齐了再一次性 patch 上去，避免出现"有派发没回收"或"有角色没候选"的中间态：

| 部件 | 包 | 状态 |
|---|---|---|
| 原生子代理服务与工具 | 上游 `subagent`、`tool-subagent`、`tool-subagent-control`、`list-agents` | 已在 base |
| 批处理、排队、隔离派发 | `omd-task` | 已实现，未挂载 |
| 隔离分配与回收（APFS clonefile） | `omd-worktree-alloc` | 已实现，未挂载 |
| 角色解析与单轮函数式调用 | `omd-roles` | 已实现，未挂载（`omd-judgment` 已在用它的可选接口） |
| 项目级并发上限 | `omd-project-config` 的 `delegation.maxActive` | 实现中 |

挂载时要一起改的两处：`subagent` entry 的 `maxActiveSubagents`（进程级硬上限）与 `omd-task` 的 `maxConcurrency`（我们的队列上限），前者不低于后者，否则队列永远等不到槽位。
