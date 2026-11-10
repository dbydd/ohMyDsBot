# omd-uri-history-plan: `history://` 内部路径设计

## 1. 承载服务证据
- **禁用 API**：`refs/deepseek-harness/packages/core/session/src/index.ts:706,719,738`（`eventAt`、`snapshotEvents`、`ownEvents` 均已标记 `@deprecated`，禁止新增调用）；决策依据见 `refs/deepseek-harness/.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md:15`（禁止同步读历史事件，强制使用异步分页与窗口）。
- **合法读事件途径**：`refs/deepseek-harness/packages/session-query/session-query/src/index.ts:140` 的 `ctx.sessionQuery.observeSession(id, {projectionMode, signal})`，返回 `SessionObservation`（含 `events`、`header`、`cursor` 与 `[Symbol.dispose]` 租约）。上游 Web 历史控制器同款用法见 `refs/deepseek-harness/packages/api/session-controller/src/history.ts:85,250`。
- **语料枚举**：`packages/session-query/session-query/src/index.ts:174` 的 `ctx.sessionQuery.listSessions(signal)`（确定性按创建倒序）。
- **转录源判定**：`packages/core/session/src/surface.ts:82,89` 的 `isAppendSurfaceEvent(event)`（`surfaceOp` 是事件顶层字段，无需 surface fold）；上游注释明确「人读转录必须用 append-origin 事件，current surface 是错的来源」；分页规则同 `api/session-controller/src/history.ts:399-426`（消息边界 + `sourceEventSeqs` 引证组对齐）。
- **合法但不采用的低层途径**：`sessionPersistence.open(id, 'read')` + `handle.read(offset, length)`（只读句柄、异步、带 `eventState`）本身合规（`session-persistence/README.md:41,49`），但要自己重做 live 优先、中断轮补齐与历史格式迁移，且 `read` 仍先全量解析文件（`packages/session-persistence-jsonl/src/storage.ts:171`）；因此只走 `sessionQuery`，不做第二条退路。

## 2. 地址语法与示例
规范形态为 `dsh-resource://history/<path>`；声明 `shorthand: true`，模型侧使用 `history://<path>`。
- `history://`：枚举全部会话（倒序表格：id、创建时间、cwd、parent、live/persisted），支持 `?limit=30`（默认 30，上限 200）。
- `history://<id>`：最新一页对话文本转录（默认最后 30 条消息，保持消息与引证完整）。
- `history://<id>?before=120&limit=20`：以 `seq=120` 为排他上限向前翻页（查更早历史）。
- `history://<id>?turn=3`：第 3 轮（`turn/start` 到 `turn/end` 闭区间，未闭合则到 `cursor`）。
- `history://<id>?seq=412`：单个事件（等价于 `?from=412&to=412`）。
- `history://<id>?from=100&to=140`：原始事件闭区间（上限 400 条，超出报错）。
- 格式修饰：选择器只决定窗口，`format` 只决定编码。默认文本转录；加 `&format=json` 输出该窗口的原始事件紧凑 JSON 数组（`{session, inheritedEventCount, cursor, startSeq, endSeq, events}`）。
- **列表不带标题**：`session-title/README.md:28` 定义标题只给客户端看、不进模型；而按需从日志折出预览等于给每个候选会话读一遍完整日志。跨会话「找那个聊过 X 的会话」由 `memory://` 承担，`history://` 负责打开已知 id。
- **范围与格式决策**：
  - 支持轮（turn）与原始范围（from/to/seq），**不支持步（step）**：轮是人类与 UI 分页的心智单位；步属于模型调用的内部轮次，在对应 turn 的 JSON 中可直接观察 `step/start`，无需多增一层语法。
  - **默认文本转录，JSON 显式选用**：一个默认值、一条规则，不按事件类型偷偷切换编码。文本只保留消息正文、`tool/call` 的名字与参数、`tool/result` 的内容，剔除 `assistant/message` 的 `stream` 原始帧、`request/header` 与 token 用量，比 JSON 小一个量级；纯结构事件（`request/header`、`step/start`、`turn/end` 等）压成一行标记，并给出该 seq 的 `&format=json` 地址。

## 3. 读取语义与错误形态
- **读取语义**：每次读取通过 `using obs = await ctx.sessionQuery.observeSession(id, {projectionMode: 'none', signal})` 取得快照并自动释放；冷会话命中 5 容量 LRU 缓存（`observation.ts:88`），不激活 Agent；转录过滤 `isAppendSurfaceEvent`，每段以 `[seq N] t<turn>/s<step> <kind>` 起头（seq 与 turn 就是两个地址坐标），单事件正文超上限即截断并注明该事件的单事件地址；转录尾部生成 `<history>` 自导航元数据（总事件数、轮数、`?before=` 下一页地址；活会话的页可能停在未闭合的轮上，以 `cursor` 为准）。`inheritedEventCount > 0` 时在边界插一行 `[inherited prefix ends at seq N]`：此前的对话与 turn 号来自父会话，`?turn=` 按日志原样解析、不做重编号。
- **配置项而非常量**：页大小默认值与上限、单事件正文上限、范围事件上限、列表默认/上限全部进插件 `z` 配置（`AGENTS.md:183` 第 9 条：可调参数不许硬编码）；不读本机状态。
- **错误形态**：
  - 会话不存在：返回 `history://<id>: no such session (corpus has N sessions; see history://)`。
  - 序号/轮次越界：返回 `history://<id>?seq=N: seq beyond cursor (available: 0–M)` 或 `no such turn`。
  - 范围倒置或超限：返回 `from must be <= to`，或 `range exceeds 400 events; use page mode`。
  - 参数非法：列出支持的白名单参数（before, limit, turn, from, to, seq, format）。
  - 损坏与失效：透传 `SESSION_QUERY_CORRUPT_SESSION` 等稳定错误码与根因；支持的历史版本由底座透明升级，不报错。

## 4. 安全边界
- **严格只读**：不调用写句柄（`open('write')`），不执行会话提升（`promote`），不向活跃池派生 Agent，不污染全局状态。
- **不按调用者收窄**：`InternalExec` 会新增 `agent?`（`ProcUriPlan` 的共享契约），`history` 故意不用它。`sessionQuery` 没有调用者鉴权（`session-query/README.md:149`），拿 `agent.id` 去猜亲缘就是假授权；本地单用户语料按地址全量可读。
- **id 与亲缘**：每个会话（含子代理）有自己的 SessionId，父只是 `header.parentSession`（`subagent/src/child-agent.ts:146`）；fork 子会话另有一段父日志前缀，长度以 `inheritedEventCount` 为准。所以「读到父的对话」来自继承前缀，不是 id 共享——转录里必须把这条边界画出来。
- **资源防御**：单事件 2000 字符截断 + 单页 100 消息上限 + 范围 400 事件上限，叠加 `omd-read` 50 KiB 外层熔断保护。

## 5. 实施切片
- **切片 1（本票：源本体）**：新建 `plugins/omd-history/`（`inject: ['sessionQuery', 'internalPaths']`），注册 `source: 'history'`（`shorthand: true`，`live: false`），实现参数解析、`observeSession` 调用、转录与 JSON 两个编码器；并在 `profiles/omd-full/cordis.patch.yml` 加一条 `omd-history` insert 行。
  - 验收：临时 profile 副本里 `dsh --profile omd-slice-verify --dump-config` 退出码 0、stderr 为空（不改 `~/.dsh/profiles/omd-full`，见 `AGENTS.md:295`）。
- **切片 2（共享前置，不归本票）**：`omd-internal-paths` 补 profile row、`omd-read` 迁到 `ctx.internalPaths.resolve/read` 并删掉 `readSchemes`（`docs/omd-internal-paths.md` §5 第 2–3 条）。这是所有源的共同前置，谁先落地谁拥有，不按源各做一份。
  - 验收（web 组合不做一次性任务，`bundle/web-app/README.md:16`，因此用 headless + overlay）：`pnpm dsh --profile headless --patch /tmp/history-verify.yml "read history://"` 列会话；同法 `read history://<id>` 出转录取页、`read "history://<id>?before=<seq>&limit=5"` 取更早一页、`read "history://<id>?seq=3&format=json"` 出单事件、`read history://nope` 的报错带现有 id。overlay 只插 `omd-internal-paths` / `omd-history` / `omd-read`、按 omd 的做法关掉 `tool-fs` 的 `read`/`readImage`，并从已装 omd profile 拷贝 Magpie 模型行。
- **切片 3（界面侧直通）**：`omd-internal-paths` 客户端自动同步并注册 `dsh-resource://history` 协议。
  - 验收：Web 端 `ctx.resources.open('dsh-resource://history/<id>')` 成功收到单帧转录。

## 6. 风险与权衡
1. **跨会话内容检索受限**：base bundle 中 `session-query-sqlite` 的 `openAt` 为 `never`，全文检索不可用；`history://` 仅支持按时间倒序翻阅，无法做关键词会话定位，需后续单独开启 FTS 配置。
2. **`format=json` 遇到大型助手消息有膨胀风险**：未裁切的 `assistant/message` 携带 `stream` 完整数据，长对话直接转 JSON 体积可达数十 KB；已设立 400 事件硬顶与推荐使用精准 `?seq=` 规避。
