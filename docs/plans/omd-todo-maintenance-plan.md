# 待办维护：瘦身、排序与归档

2026-10-22，只读设计。上游引用写 `refs/deepseek-harness/`，本仓写仓库相对路径。
前提（已定）：三态 `state: 'active' | 'inactive' | 'completed'`，无 `in_progress`；上游 `todo/write` 映射 `active→in_progress`、`inactive→pending`、`completed→completed`，profile 置 `allowParallelInProgress: true`（`plugins/host/omd-todo/src/tree.ts:226-232`）。

归档时补一条跨计划决议（§9 风险 3 的处置）：**写入载荷不许做视图过滤**。`flat` 与 `detail` 必须同构，永远是整棵树；「只带 active」「只看未完成」这类过滤只允许出现在读取侧的渲染与投影（`render()`、看板投影、判官上下文），不允许出现在 `todo/write` 的参数或 detail 记录里。`omd-todo-kanban-plan.md:74` 的那条按此改写。

## 0 结论

| 问题 | 结论 |
|---|---|
| completed 保留 | 最近 4 个 completed 根（整枝）无条件留；其余满足「写完 6 次」或「24 小时」即归档 |
| inactive 保留 | 7 天或 20 次写，先到者归档；含 active 后代的根不动 |
| 上限 | 活树 80 节点 / 16 根（淘汰线）；200 仍是写入拒绝线（`MAX_ITEMS`，`tree.ts:27-28`），不动 |
| 淘汰顺序 | 最旧 completed 根 → 最旧 inactive 根 → 放宽 keep 到 0 再淘汰 completed → 仍超只提示 |
| 归档去哪 | 日志 detail 记录（`archived[]`）；地址 `/archive[/<id>]`；磁盘 `archive/` 只是投影 |
| 触发 | 写入口一处（`service.replace` 的 `#apply`，`service.ts:138-162`），所有 origin 共用；不做定时器 |
| 判官窗口 | 只有 `active` 进；压力 = active 条数 × 单条长度，与 completed 无关 |
| 谁执行 | 结构淘汰 = 宿主确定性规则；语义合并 = 判官（`origin: 'maintenance'`），默认关 |

## 1 证据

- 唯一拒绝线 `MAX_ITEMS = 200`（`tree.ts:27,87`）；写入口唯一在 `#apply`（`service.ts:143-161`），不会被绕过。
- 读 = 折叠日志（`service.ts:196-207,293`）；`snapshotOf` 要求 detail 与 flat 同构，否则退回平铺树并丢掉 goal/explanation（`:387-395`）。归档条目**绝不能留在 items 里**。
- 条目无时间戳（`types.ts:45-60`），年龄只能从日志折叠；每次写的成本 ∝ 树大小（参数与回显都带整树，`index.ts:183-199`，80 节点约 4–6k token/次）。
- 判官配方第 2 段只放 active 且未完成，超 30 条截断，预算 4000（`docs/omd-judge-context.md:14,23`）。
- 路径源只读 live 会话（`index.ts:312-317,382`）；fork 复制日志前缀（`inbox.spec.ts:157`，`resume.spec.ts:1015-1019,1064-1067`）。

## 2 输入与排序

`maintain(tree, fold, now, config) → { tree, archived, order }` 纯函数。读当前树、折叠出的年龄（`pathKey → { completedAtMs, completedAtWrite }`，pathKey 为 content 链）、时钟。改名/挪位 = 新身份 = 年龄重置（保守）。
`order`：state 秩（active=0, inactive=1, completed=2）+ 同秩保序。写时按它排，存储、回显、路径、看板、判官共用同序；同秩内由模型写序决定优先级，模型重写沿用上次回显，不抖动。

## 3 淘汰规则

先按 §2 排序，再按序整枝淘汰，直到 `节点 ≤ 80 且 根 ≤ 16`：
1. **completed 根**：不在最近 4 根内，且（`now - completedAt ≥ 24h` 或 `writeIndex - completedAtWrite ≥ 6`）。最旧先。
2. **inactive 根**：无任何 active 后代，且（`≥ 7d` 或 `≥ 20 次写`）。最旧先。
3. 仍超：keep 放宽到 0，继续淘汰最旧 completed 根。
4. 仍超：不淘汰，只提示。
**永不淘汰**：任何 active 节点与含 active 后代的根（active = 推进中，自动归档等于替模型弃工）。并存 6 次写与 24h：短会话时钟不动靠写次数（真实成本源），长会话靠时钟。

## 4 归档去哪

**真相在日志**。`plugin:omd-todo/detail` payload 增可选 `archived?: TodoArchiveEntry[]`（只带本次新增）：
`{ id: string (6位base36), path: string[], items: TodoItem[], archivedAt: number, reason: string, seq: number }`。折叠时按 id 累积。
- 地址：`dsh-resource://todo/<sessionId>/archive`（最新 50 条列表与原因）；`…/archive/<id>`（整枝原文）；`…/<sessionId>` 只给活树。
- **只从树里移除、不留索引（否掉）**：历史仍在日志，fork/重启仍一致，但两个 `todo` 地址都读不到它，只能扫会话日志——归档等于不可寻址。
- 磁盘：`omd-todo-files` 存在时移到 `todos/<sessionId>/archive/<id>-<slug>/`，扫描器忽略 `archive/`，手改不回灌；文件镜像缺失时仍可从日志/路径读。文件镜像的「目录消失=删除」必须由本模块主动搬目录并在 `lastWrittenHash` 记账，避免误判。
- fork / 重启：归档已提交进日志前缀，fork/resume 自然一致。**绝不能在 `read()` 里按当前时钟动态算**，否则同一日志不同时刻读出不同树。已关闭会话不可寻址（既有约束）。
- 上游面板代价：`todos` projection 只折 flat，归档后只显活树（注意力视图，符合预期）。

## 5 触发时机

- **主路径**：`#apply` 合并后、两次 append 前跑 `maintain`。一次写仍产出一对事件；工具结果回显 `archived: [{id, content, reason}]`，description 加一句「done 条目自动归档，勿重加」。
- **不做超限拒绝**：200 那条留着。维护线不拒绝：拒绝导致模型重发整树重试，比重发更贵且模型不知该删哪条。
- **不做定时器 / turn-stopping 顺带做**：无人读时归档无收益，定时写破坏「读=折叠」确定性。唯一例外是语义合并。
- **兜底**：读侧活树超线但全是 active 时，只在渲染头加 `over budget: N/80`，不写日志。

## 6 与判官窗口的关系（核对配方后）

配方第 2 段只收 active，completed/inactive 根本不进（`docs/omd-judge-context.md:14`）。
- **completed 不占判官窗口**，只占磁盘、回显与模型每次重发的上下文。撞的是 200 硬门，不是 4000。
- **判官压力 = active 数 × 单条长度**。条均 60–80 token，30 条就是 1.8–2.4k，已占预算一半；再扣任务说明、用户消息（≤800 字）与 3 条助手消息（各 ~600 字），第 5 段的调用记录只剩几百 token，降级顺序会先砍它（`docs/omd-judge-context.md:23`）。
- 结论：**瘦身与判官窗口无关**；重排只决定 30 截断切在谁身上（模型写序的尾部），不能缩小窗口。能缩小窗口的是 active 数与单条长度。配方落地取 `order` 前 N（N=30 且第 2 段总量 ≤ 预算一半），`activeWarn: 15` 是留一半预算给消息与调用记录的保守提示线，超线只提示收束，不归档。

## 7 谁执行与配置

结构淘汰宿主确定性执行（同入同出、零 token、判官挂了照跑）。语义合并（判官）在 `turn-stopping` 跑，默认关，判官失败按不合并处理；`TodoOrigin` 需加 `'maintenance'`，合并语义等同 `model`（整表替换），不强制 `requireDetail`。
配置（数值项 `volatile()`）：
`liveNodeCap: 80`, `liveRootCap: 16`, `activeWarn: 15`, `completedKeepRoots: 4`, `completedTtlHours: 24`, `completedWrites: 6`, `inactiveTtlDays: 7`, `inactiveWrites: 20`, `archiveListLimit: 50`, `semanticMerge: false`。

## 8 切片与验收

1. 三态迁移（依赖，别人做）：字段与映射，profile 开 parallel。
2. 维护纯函数 + 写入口：`src/maintenance.ts` + `service.ts` 接 `#apply` + 工具输出加 `archived`。
3. 归档记录 + 地址：detail payload `archived[]` + `/archive[/<id>]` + README。
4. 文件镜像 `archive/`（依赖 `omd-todo-files`）。
5. 语义合并（判官 + `turn-stopping`，默认关）。

验收（临时 profile，`AGENTS.md:316`）：
1. **超限淘汰**：写 6 个 completed 根 + 1 个 active 根，配 keep=2、writes=1。下次写后工具回显 `archived` 含最旧 2 根；`todos` 少 2 根；日志仅一条 `todo/write`（剪后数）；`dsh-resource://todo/current` 不含它们。
2. **归档可按地址读**：`/archive` 列出 2 条及 reason；`/archive/<id>` 读出原文（含 goal/explanation）；resume 后同一地址内容与 id 不变。
3. **不伤 active**：写 90 个 active 节点 → 归档数 0，回显带 `over budget: 90/80`。
4. **判官窗口不随 completed 涨**：加 40 个 completed 前后，判官请求体第 2 段内容与 token 数不变，零 completed 条目。
5. **fork 一致**：父归档后拉起子代理，子 `/archive/<id>` 与活树均一致、无幽灵节点。

## 9 风险与待定

1. **身份靠 content 链**：改名挪位年龄重置；写回已归档条目年龄归零会再归档一次（幂等）。日志显示频繁再加墓碑。
2. **模型反复写回已归档项**：靠回显与下次写再判收敛；反复发生则调大 `completedWrites`。
3. **文件镜像同构不变式**：`service.ts:390` 要求 detail 与 flat 同构。`kanban-plan:74` 若单方面让 flat「只带 active」，读会丢 goal/explanation 且 `/archive` 失联。两边必须同步过滤。
4. **待定**：「轮」默认以写次数计（反映真实成本），要按 turn 计则改读 `turn/start`；80/16/15 阈值在首个真实会话后按判官请求体微调；默认不设「复活」写回入口。
