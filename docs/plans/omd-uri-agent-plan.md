# agent 源：子代理的最新产出与状态

结论：`agent://<子代理 SessionId>` 只回答"这条子代理现在什么状态、最后说了什么"；整段过程归 `history://<同一个 id>`。不新造 id、不用 label 寻址。子代理是独立 Session，读它不需要拉起 Agent。

## 1. 定位一个子代理：三个面，一个 id

| 面 | 事实 | 证据 |
|---|---|---|
| `ctx.subagents` | 命名 provider 注册表（spawn/fork/acp…）；`list()` 返回的是 **provider 名**，不是子代理 | `refs/deepseek-harness/packages/subagent/subagent/src/index.ts:581`、`:193-200` |
| 父的名册 | `ctx.subagents.listChildren(parentId)` 读父 Session 的 `subagentCatalog` 投影，行含 `id/createdAt/mode/label` | 同文件 `:405`；`.../src/catalog.ts:121`；`.../src/projection-types.ts:10-20` |
| 子自身 | `header.origin === 'subagent'`、`header.parentSession`、`delegationDepth`；`isSeeded` 标记 fork 前缀 | `packages/core/session/src/types.ts:107-124` |
| 活性 | `ctx.agents.get(id)?.status` ∈ `running｜idle`；不在注册表即非驻留 | `packages/core/agent/src/index.ts:568`；`packages/core/agent/src/runtime-types.ts:109,172` |
| 结果 | 子 Session 自己的事件后缀上跑 `finalAssistantOutput(events)`（最后一条非空 assistant） | `.../src/assistant-output.ts:3-8,67` |

地址里的 id 就是**子 SessionId**：派发工具已把 `childId` 交给模型（`tool-subagent/src/index.ts:337`），`list_agents` 也用它，且它跨 Activation 不变（`control-types.ts:27`）。label 只在父名册内唯一、one-shot 可缺，不能当 id。

取回最终结果只有一条正路：`ctx.sessionQuery.readSession(childId)` → `{ session: header, inheritedEventCount, events }`（`packages/session-query/session-query/src/index.ts:184`；`.../src/types.ts:51-58`），再把 `events` 从 `inheritedEventCount` 切片后交给 `finalAssistantOutput`。不切片就错：fork 子代理的前缀里有父的 assistant 消息，子没说话时会返回**父的话**。同一理由让上游身份投影用 `isOwnSeq(seq)` 自证（`projection-types.ts:52-58`），也让 `foldSubagentDescriptor` 不能直接吃全量日志（`descriptor.ts:252-269` 取第一条，前缀里可能是祖先的描述符）。
`subagent/end` 只用于观察、不进日志（`subagent/src/index.ts:149-166`；`types.ts:98-115`），所以状态不能从它读。

## 2. 地址语法（`shorthand: true`）

```
agent://                          # 调用者这一层的直系子代理（父名册，事件序）
agent://<id>                      # 状态头 + 最终产出（全文）
agent://<id>/status               # 只有状态行，不取产出
```
例：`agent://`、`agent://6d1f…a7`、`agent://6d1f…a7/status`，界面规范形 `dsh-resource://agent/`。
名册走 `ctx.subagents.listChildren(调用者.id)`——只读调用者自己的 `subagentCatalog`，不扫语料、不跨项目。调用者身份从 `InternalExec.agent` 来（§5）：模型侧由 agent loop 在 `ToolExecution.agent` 上给出（`packages/core/tools/src/index.ts:338-340`，实填在 `:1418-1425`），`omd-read` 把它转交；界面侧 `readRemote` 没有 agent（`plugins/host/omd-internal-paths/src/service.ts:156-158`），此时空名册必须报错并给出 `agent://<id>` 的走法，不得退化成"全机子代理列表"。
错误形态一律由本源 `throw`，界面侧自然成一帧失败：`provider.open` 已经 catch Host read 的拒绝并转成 `internal-paths/read-failed` 帧（`plugins/host/omd-internal-paths/src/client/index.js:86-116`），本源不得自己拼帧、也不得把错误塞进正文——同一个地址在模型侧与界面侧必须是同一种结局。
`/status` 对活子代理走注册表、不碰日志；冷子代理付一次日志读，写进 grammar 说明，不假装便宜。
渲染固定小节：id / parent / mode / label / status / last-turn（`completed｜aborted(user)｜error｜max-tokens｜interrupted｜open`，`session/src/types.ts:202-230`）/ 耗时 / `## Result`。非 text 的 content block 打一行 `[tool-call name]`，不静默丢弃。
mode/label 取子自身描述符（`foldSubagentDescriptor(events.slice(inheritedEventCount))`）；父名册的行只用于交叉核对，冲突以子为准。描述符缺失或版本不认识时写 `mode: unknown (descriptor missing)`，不猜成 one-shot。

## 3. 中间过程：不放进 `agent://`

数据在（子 Session 日志完整；上游只是没让 `readOutput()` 暴露它，`2026-06-20-generic-long-running-tool-runtime.md:99`），但同一个问题不能有两个源。过程读 `history://<id>`（同一 id、按行切片），`agent://` 只给结果。omp 就是这么切的：`agent://` 取最新产出，`history://` 取原文。

## 4. 跨父/子链：放开，读任何子代理

有了 `exec.agent`，"只读自己子树"是**做得到**的，所以这是一次取舍，不是做不到。
不做的理由：
(1) 上游把约束责任明说交给消费者（`.../session-query/README.md:149`：`No caller authorization` —— a model tool or UI must constrain which sessions its caller may inspect），所以这是**我们主动不设**，不是没人负责。依据是同一份数据另有地址：`history://<id>` 读同一个语料、同一套服务，且已定为不拦。要拦就两个源同时沿 `header.parentSession` 走链，单边设防只挡住诚实的调用者。
(2) 不借用 `ctx.jobs` / `ctx.terminals` 的围栏：它们围的是**活的工作**——job 按 `owner.id` 分派读取与通知（`jobs/src/index.ts:62-63`），terminal 按确切 Agent 对象拒绝他人操作（`terminal/src/index.ts:84,231`；`terminal/README.md:52`）。那是运行中资源的控制权，与"读一段已落盘的历史"不是同一种权限；把 `owner.id` 检查搬进只读源，等于把控制权与可见性混成一种。
(3) 协作要读兄弟/表亲的结果：id 是模型唯一的句柄（第 50 条要的 @ 式协作、irc 传话），按子树切断正好切掉协作本身。上游的直系限制是实现约束（`docs/omd-multi-agent.md:69-76`），不是策略。
(4) 本机单用户，Session 日志明文在 `$DSH_HOME` 下，进程内再加一道不增加保密性，只增加一处会撒谎的授权代码。
保留的边界：`origin !== 'subagent'` 的 Session 一律拒绝，指向 `history://`——`agent://` 不是普通会话的后门。本源**不做** owner check，这是与 `history://` 对齐的结果，不是遗漏。

错误形态（都带可执行下一步）：
- 无此 id：`no session <id>; agent:// lists this session's subagents`
- 非子代理：`session <id> is not a subagent (no origin); use history://<id>`
- external 子代理：`agent <id> has no local session (mode external); no transcript`
- 空名册无调用者：`agent:// needs a calling agent; name one subagent: agent://<id>`
- 路径更深：`agent path "<…>" accepts "", "<id>", "<id>/status"`
- 缺服务：点名缺 `sessionQuery`/`agents`/`subagents`，照上游 `SUBAGENT_CONTROL_*` 的写法，不返回空。

## 5. 实施切片

1. **共享切片（不是本源独有）**：`plugins/host/omd-internal-paths/src/service.ts:23-26` 的 `InternalExec` 加 `agent?: Agent`；`omd-read` 从 `ctx.readSchemes` 迁到 `ctx.internalPaths` 时把 `{ signal: exec.signal, agent: exec.agent }` 传下去（`docs/omd-internal-paths.md:51-56` 步骤 2-3）。这是**一个**切片，谁先落谁拥有；本源只消费，不改 `omd-read`、不改 `omd-internal-paths`。（与 ProcUriPlan 已就此对齐。）
2. 新包 `plugins/omd-agent-paths/`：`src/index.ts`（`name='omd-agent-paths'`，`inject=['internalPaths']`，`agents`/`subagents`/`sessionQuery` 只在读时 `ctx.get`）、`src/read.ts`（名册 + 定位 + 切片 + 折叠）、`src/render.ts`（两种视图）、`src/types.ts`。注册 `agent`，`shorthand: true`，`live: false`——界面半边今天只开一帧、不跟随（`plugins/host/omd-internal-paths/src/client/index.js:99-116`），写 `true` 就是谎。
3. `Config`：`statusStaleAfterMs`（默认 0=不判超时）。无本机值。
4. 挂载：`profiles/omd-full/cordis.patch.yml` 里给 `omd-internal-paths` 与本源各一行（profile 今天两者都没有）。
5. 不动的：`omd-agents-hub` 的 `omdAgents` 投影保留为面板名册，结果字段恒为 `null`（`fold.ts:57-59`），与本源零重合；`list_agents` 工具保留，本源补的是"通知滚走后还能取结果"这个工具缺口。

验收：
```
dsh --profile omd-full --dump-config >/dev/null     # 退出 0、stderr 空（用临时 profile）
```
- 派一个子代理，`read agent://<id>` 的 `## Result` 与完成通知逐字一致；
- 结算后 `read agent://<id>/status` 首行 `status: inactive`、`last-turn: completed`，且不出现 Result 段；
- fork 子代理什么都没说时，`agent://<id>` 报"无产出"，不得出现父的最后一条消息；
- `read agent://` 只列本会话的直系子代理；界面侧同一地址出 `read-failed` 帧，消息里点名 `agent://<id>`；
- `read dsh-resource://agent/<id>` 在侧栏预览得到同一段文本。

## 6. 风险

1. 共享切片排期：`InternalExec.agent` 与 `omd-read` 迁移没落地前，模型侧读不到任何内部路径；本源可先注册但绝不能自己塞一个假的 agent 让名册"看起来能用"（那会把一次迁移延后变成一处错误数据）。
2. 冷子代理一次全量日志读：长会话上是 MB 级、每次读都付。上游把这条列为已知限制（`.../session-query/README.md:151`：exact reads replay whole logs），并接受子代理名册的 compute-and-discard（`2026-08-06-subagent-list-identity-projection.md:174-176`）；这里沿用，只把 Result 段写进模型上下文，状态行不重复拉全文。
