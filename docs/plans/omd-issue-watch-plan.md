# omd Issue 自动检查：变化直接写进待办

结论：轮询（将来可换 webhook）发现变化后，调待办能力 `ctx.todoList.replace(session, items, 'issue')` 更新该项目主会话的 issue 待办子树。**不创建会话、不发 user 消息、不唤醒模型**；条目在模型下一次自己开轮时随待办上下文出现。

## 1. 证据

- `[观察]` 今天的 todo 只够模型自用：`TodoItem{content,status}` 无身份、`todo/write` 整表快照、last-write-wins（`refs/deepseek-harness/packages/todo/tool-todo/src/types.ts:11-26,28-46`）；`[契约，来自待办能力]` `ctx.todoList.replace(session, items, origin:'issue')`、`read(session, origin?)` 必须：`session` 能离线取得（`ctx.sessions.get` 或持久层，**不得要求 `resolveAgent`**）、按 origin **原子合并**、按 `id` **原地更新**、写待办不排 turn。
- `[观察]` 忙闲可读 `agent.status`（`refs/deepseek-harness/packages/core/agent/src/runtime-types.ts:109,172,191`）；`turn/start`、`turn/end` 可经 `session/event` 观察，验收用来证明"没有唤醒"（`refs/deepseek-harness/packages/core/session/src/index.ts:74`）。
- `[观察]` 持久状态用 `ctx.storageDomain`，落 `~/.dsh/storages/<domain>.json`（`plugins/omd-project-config/src/service.ts:47-65,114`）；凭据阶梯是 `$DSH_HOME/.credentials.yaml` > 进程环境 > cwd `.env` > `$DSH_HOME/.env`（`refs/deepseek-harness/packages/credentials/credentials-local/src/index.ts:2-10`）。
- `[假设，RepoBindingPlan / GithubSourcePlan]` `repoBinding(cwd)` → `bound{host,owner,name,slug}` | `unbound{reason}`；`ctx.github.listIssues({repo,state,labels,assignee,since})` → `{ rows: IssueRow[], truncated: boolean, notModified: boolean, staleMs?: number }`（`IssueRow` 含 `number/title/state/stateReason?/labels/assignees/updatedAt/url/isPull`），错误 `unconfigured|unauthorized|rate-limited|not-found-or-forbidden|network`。ETag 与单飞留在 github 客户端内部，不由调用方持有。

## 2. 为什么不是 (a)/(b)
- **(a) 投影/面板计数**：外部变化停在非会话状态，模型永远不知道，"自动检查"退化成没人看的数字；投影本身已被否。**(b) 投 user 消息**：必然唤醒一整轮请求，并把外部噪声写进工作会话的上下文与 KV 前缀；issue 大多是待办储备，不是需要立刻处理的打断。
- **(c) 现在成立**：以前否掉待办的两条理由（条目无身份、整表覆盖会抹掉模型条目）被新待办能力解除——稳定 id + `origin` 作用域写；目标会话不在了就不写，不必为此创建或唤醒任何会话。

## 3. 接口与条目
```ts
// plugins/omd-issues/src/types.ts
interface IssueWatchService {
  check(root: string): Promise<CheckResult>   // 定时与手动共用；同 root 单飞
  status(root: string): Promise<WatchStatus>  // lastCheckedAt / lastWriteAt / lastError / 未完成条数
}
interface CheckResult { slug: string | null; checkedAt: string; added: number; updated: number; completed: number; wroteSessionId?: string }
```

提交条目必填字段：`id`（`issue:<slug>#<number>`）、`text`（一行 `#N 标题`）、`status`、`active`、`origin:'issue'`、`source:{kind:'issue',repo,number}`、`why`（前因）、`goal`（后因）。同一次 `replace` 的三个真实条目：

```json
[ {"id":"issue:owner/repo#42","text":"#42 修复登录超时","status":"pending","active":true,"origin":"issue","source":{"kind":"issue","repo":"owner/repo","number":42},"why":"2026-10-22 新开，标签 bug，已分配 dbydd（https://github.com/owner/repo/issues/42）","goal":"定位超时根因并给出修复分支；issue 关闭即视为完成"},
  {"id":"issue:owner/repo#98","text":"#98 支持 Webhook 回调","status":"completed","active":false,"origin":"issue","source":{"kind":"issue","repo":"owner/repo","number":98},"why":"2026-10-19 进入待办；2026-10-22 上游关闭","goal":"回调可用并有文档；关闭后保留条目备查"},
  {"id":"issue:owner/repo#101","text":"#101 内存泄漏","status":"pending","active":true,"origin":"issue","source":{"kind":"issue","repo":"owner/repo","number":101},"why":"2026-10-22 从 closed 重新打开，标签 bug","goal":"定位泄漏点并补回归；issue 关闭即视为完成"} ]
```

配置字段（`plugins/omd-project-config/src/schema.ts` 增 5 行，默认机器无关）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `issues.watch.enabled` | `false` | 是否检查该项目 |
| `issues.watch.intervalSeconds` | `900` | 最小 60；`0` 等同关闭 |
| `issues.watch.labels` | `[]` | 只看这些标签；空 = 全部 open |
| `issues.watch.assignee` | `null` | 指定人；`null` = 不过滤（不默认 `@me`）|
| `issues.watch.mainSessionId` | `null` | 待办写进哪个会话；`null` → 不写，记 `no-main-session` |

## 4. 状态同步规则

| 外部变化 | 条目动作 | 写待办 |
|---|---|---|
| 新出现且匹配 filter | 新增 `pending` + `active:true` | 一次 |
| 标题/正文变化 | 只改 `text`；`why` 时间戳不动 | 否（不重新提醒）|
| `closed` | `status:'completed'`，**保留条目**，`why` 追加关闭时间与 `stateReason` | 一次 |
| 重新打开 | `status:'pending'` + `active:true`，`why` 追加重开时间 | 一次 |
| 分配给我 / 加上关注标签 | `active:true`，`why` 追加原因 | 一次 |
| 不再匹配 filter（去标签/取消分配）| `active:false`，文本与状态保留 | 否 |
| 不在本页且 `truncated=false`（删除/无权限）| `active:false`，`status` 不变 | 否 |

`items` 顺序：`active` 按 `updatedAt` 降序在前，其余按 `id` 稳定排列。写入是 origin 作用域内的全量替换，所以"本次判定不再出现的 issue"只会落到最后两行，绝不静默删除条目。**`truncated=true` 时"不在本页"不构成任何证据**：条目原样保留，也不改 `lastError`。

## 5. 频率、作用域、主会话
- **按项目绑定跑，全局单 timer**：每个 `watches` 行是一个项目根；`unbound` 静默跳过（不是失败）；取最近一次到期。默认 900 秒，最小 60，可关。条件请求由 github 客户端发（`If-None-Match` 归它），`304` 不扣主配额，我不自己设这个头。
- **查询口径**：一律 `state:'all'`——只取 open 会让"关闭"看不见，并把关闭误判成"消失"；首轮不带 `since` 取全页，之后 `since = 上次成功检查`；`per_page=100`。`notModified=true` → 跳过 diff，什么都不写。`staleMs` 命中缓存页时只做"已有条目更新"，**不做删除推断、不推进 `since`**（缓存比现在旧，缺页不等于删除）；两个标志同时出现按"未变化"处理，不动 `lastError`。
- **目标是项目主会话**：`issues.watch.mainSessionId`，在项目设置面板从该项目会话中选。没有就不写、不猜、不创建，`lastError={kind:'no-main-session'}`。
- **忙只推迟写入时机**：`agent.status==='running'` 或该会话待办写入 FIFO 未清空时，本轮只更新去重表、保留 `writtenAt` 未写，下轮**合并成一次**写入；不排队多次写，不打断模型。
- **写入不是唤醒**：不排 turn、不 `resolveAgent`。将来接入 webhook 只替换"发现变化"这层（`webhookRuntime.register` 规则按 `payload.repository.full_name` 找 watch 行；webhook 用独立 secret，不与 API token 共用），写待办路径不变。`refs/deepseek-harness/packages/experimental/webhook-github/README.md:12-14,41-53`

## 6. 去重与存储
- 域 `omd_issue_watch`、表 `watches`，键为规范化项目根；行 `{ slug, since?, lastSuccessAt?, lastCheckedAt, lastWriteAt?, lastError?, nextAllowedAt?, issues: Record<number,{state,labels,assignees,updatedAt,writtenAt,todoId}> }`。`since`/`lastSuccessAt` 只在真 200 且非 stale 的一轮推进。不进会话事件：检查是项目级，要在任何会话写入之前就能工作。**指纹 = state + 关注标签集合 + 分配人集合**（不含标题/正文/评论数）；标题变化只更新 `text`，`writtenAt` 不变。
- **已读收敛到待办本身**：条目的 `active` 与 `status` 就是可读状态（模型和人都在这个面上），插件不再维护第二套已读位；`status()` 的未完成条数从待办读。
- 每项目保留 500 条 issue 记录，超量淘汰 `completed` 且 30 天未动的。

## 7. 失败姿态与日志

**任何失败都不写待办、不唤醒模型**，只记 `lastError` 与 warn；`unbound` 静默跳过且不写 `lastError`：

| 情形 | 姿态 |
|---|---|
| `unconfigured`（无 token）| 这是配置状态而非事件：停止定时，`lastError` 与日志只在状态变化时写一次；只在凭据更新或配置保存时重试。阶梯是"文件 > 环境"，`.credentials.yaml` 里的值压过导出的环境变量 |
| `rate-limited` | `nextAllowedAt = resetAt`（`retry-after` 优先），不周期重试 |
| `unauthorized` / `not-found-or-forbidden` | 退避 1h → 6h，`lastError` 写明两种可能（不存在 / 无权限）|
| `network` | 按原周期自然重试 |
| 写待办失败（契约抛错或合并冲突）| 保留未写状态，下轮重试；同类错误只记一次 |

日志：`ctx.logger.warn('omd-issues: …')`，与宿主进程日志同出口（本机落 `~/.dsh/logs/startup-*.log`），同类错误进程内去重。`lastError` 同时写存储域，供设置面板回显（诊断读取，不是投影）。

## 8. 切片与验收
1. **纯逻辑**：`plugins/omd-issues/src/fingerprint.ts`（指纹与上表七种迁移）、`entries.ts`（条目生成、排序、`why`/`goal` 文案；标题截断 120 字符并剥离控制字符）。无 Cordis 依赖。
2. **状态与调度**：`storage.ts`（`omd_issue_watch` 域、`watches` 表、500 条淘汰）、`timer.ts`（单 timer、每 root 单飞、退避）、`writer.ts`（读旧条目 → 按 id 合并 → `todoList.replace(session, items, 'issue')`）、`index.ts`（`inject: ['github','projectConfig','storageDomain']`，发布 `ctx.issueWatch`）。
3. **接入**：`schema.ts` 增 5 字段；client 半边照 `plugins/omd-project-config/src/client/index.js:528-535` 加 `/issues-check`（action）与"主会话"选择器。依赖顺序：待办能力（无唤醒写 + origin 合并）→ `github` 源与仓库绑定（含 `state:'all'` 与 `truncated`）→ 本切片；`omd-read` 迁移只影响模型能否 `read issue://N` 看正文，不在关键路径。

验收（临时 profile，不改 `~/.dsh/profiles/omd`，见 `AGENTS.md:295`）：

```sh
dsh --profile omd-watch-verify --dump-config     # 退出码 0，stderr 空，无 "did not activate"
dsh --profile omd-watch-verify                   # intervalSeconds=60 起服务
```

断言只取自待办内容、会话事件流与存储文件：

1. 新 issue → `/issues-check` → 主会话待办出现 `issue:owner/repo#N`，`source`/`why`/`goal` 齐全；该会话事件流里**没有**新的 `turn/start`。
2. 立刻再 `/issues-check` → 本轮 `notModified=true`，条目与 `writtenAt` 均不变；改标题 → `text` 变、条目数不变、`writtenAt` 不变。换一个匹配数 >100 的仓库 → 首轮 `truncated=true`，条目原样保留、`lastError` 不动。
3. 在 issue 上 close（`state:'all'` 下才可见）→ 条目 `completed` 且仍在；reopen → `pending` + `active:true`。
4. 清空 `mainSessionId` → 下一轮不写，`status().lastError.kind == 'no-main-session'`；主会话 `running` → 本轮不写，`writtenAt` 未更新，转 idle 后下一轮一次写入合并所有变化。
5. 模型自己 `todo_write` 之后 → 下一次 `/issues-check` 只更新 issue 条目，模型条目原样保留。

## 9. 风险
1. **待办写路径若强依赖 `resolveAgent`，本方案就变成"写待办 = 唤醒"**——这是唯一的结构性依赖，待办能力必须提供无唤醒写（直接 append 事件或写持久层）。不满足则切片不能落地，先在待办能力里补这条。
2. **并发写同一会话**：模型的 `todo_write` 与我们的 `replace(..., 'issue')` 靠 origin 作用域合并 + 单写 FIFO 共存；若待办能力仍整表覆盖会互相抹掉（验收第 5 条守这条）。
3. **主会话被归档或删除**：不自动创建、不唤醒，记 `no-main-session` 等人重新指认；issue 记录留在存储域，指认后下一轮补齐。
