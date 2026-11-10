# omd 记忆后端移植计划（pi-hindsight → dsh）

只读调研产物，未改任何文件。引用均为仓库相对路径或上游 `refs/deepseek-harness/`（commit 687f282，tag dsh-v0.2.1-rc.2）。

## 结论先说

1. **移植的是形态，不是代码量**。pi-hindsight 24253 行、57 个模块，其中 `decision/`（16 文件，判官选 bank）、`tui/`（12 文件）、`imports/`（8 文件）与本次目标无关或不成立；`client/`+`queue/`+`recall`/`retain` 的骨架可以直接搬。
2. **记忆游标不能照抄**。pi 在 `agent_end` 读整段 transcript 减去游标；dsh 里同步读会话历史已被禁止（`refs/.../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md:15`），`appendPluginRecord` 也不给外部插件用（`packages/core/session/README.md:70`）。唯一正路：**自建 session projection + 按 turn 边界自然重置**。
3. **项目级参数是 dsh 的真实缺口**。`ctx.settings` 只编辑 profile 条目（`packages/settings/settings/README.md:33`），配置落 profile patch（`packages/boot/config-editor/README.md:67`），全无"项目"这一层。要让"左边 project 卡片里调参数"成立，必须另起一个包（§3.2），记忆插件只做它的消费者。

## 1. 架构对照

| pi-hindsight | dsh 侧 | 判定 | 理由 |
|---|---|---|---|
| `extensions/index.ts`（session_start/context/agent_end/session_shutdown） | `src/index.ts` | 需改写 | dsh 无 session_start/shutdown 钩子；`context`→`agent/pre-step`，`agent_end`→`agent/turn-stopping`（`packages/core/agent/src/runtime-types.ts:381`，在 `turn/end` 提交前 await，`agent-loop/src/agent.ts:361-387`），关停→`ctx.effect` |
| `config/config-defaults.ts`+`config.ts`+`config-normalize.ts` | `src/config.ts` | 需改写 | schemastery `Config` + `resolveConfig`；`omp-config.ts`/`setup-gate.ts`/`config-writer.ts`/`config-editing-*.ts`（TUI 表单）丢弃，dsh 的 `volatile()` 字段直接生成表单 |
| `types.ts`（713 行手写 HindsightLikeClient） | 各模块内联类型 | 丢弃外壳 | 直接用 `@vectorize-io/hindsight-client@^0.9.0` 的导出（`pi-hindsight/package.json:86`） |
| `client/client.ts`+`client-retry.ts`+`timeout.ts` | `src/client.ts` | 直接移植 | `createClient/createConfig/sdk` 同名 API，只换 abort 语义 |
| `banks/banking.ts`+`bank-selection.ts`+`bank-operations.ts` | `src/banks.ts`+`src/project.ts` | 需改写 | cwd 取 `ctx.workingDirectory.get(session)`（`packages/session/working-directory/src/index.ts:122`），不是 `header.cwd`——会话可中途换目录 |
| `banks/bank-templates.ts`+`knowledge-page-seed.ts`+`bank-settings-presenter.ts` | `ensureBank` 内联 | 丢弃 | 模板与知识页是控制面板能力；只保留 mission 写入 |
| `lifecycle/retain.ts`+`retain-job-builder.ts`+`observation-scopes.ts`+`utils/messages.ts` | `src/retain.ts` | 需改写 | 输入从 pi 消息数组换成 projection 里的 turn delta |
| `lifecycle/recall.ts`+`mental-models.ts` | `src/recall.ts` | 需改写 | 查询串改从 pre-step 消息 + projection 近期摘要拼；`retrieval-telemetry.ts` 丢弃（无 sink，dsh 用 `ctx.logger`） |
| `lifecycle/memory-lifecycle*.ts` | `src/index.ts` | 需改写 | runtime snapshot/status/notify 三层是为 TUI 写的 |
| `lifecycle/git-seed.ts`/`retain-receipts.ts`/`recall-cleanup.ts` | — | 丢弃 | 未要求；receipts 是 TUI 展示；cleanup 由 projection 跳过自身 `kind` 解决 |
| `queue/{queue,queue-lock,jsonl-queue-store,queue-delivery}.ts` | `src/queue.ts` | 直接移植 | 文件/锁/死信/合并策略与宿主无关 |
| `queue/retain-before-enqueue.ts`+`flush-presenter.ts` | — | 丢弃 | 前者是外挂命令门禁，后者是 TUI |
| `operations/*`（13 文件） | `src/tools.ts`+`src/resource.ts`+`src/commands.ts` | 需改写 | operation-catalog/presenter 由 `defineTool` 的 `output.render`/`presentCall` 取代 |
| `decision/*`（16 文件，System One 选 bank） | 延后 | 延后 | 依赖 omp 的 `role:judge`/`models` facade，dsh 侧对应物是 `plugins/judgment/omd-judgment`；两 bank 固定路由不需要它 |
| `tui/*`（12 文件） | — | 丢弃 | omd 只有 web，仓库已废 TUI（`AGENTS.md:284`） |
| `imports/*`（8 文件） | 延后 | 延后 | 导入的是 pi JSONL；dsh 自己的会话库已由 live retain 覆盖 |
| `utils/sanitize.ts` / `utils/session.ts` | `src/sanitize.ts` / `src/banks.ts` | 直接移植 / 改写 | document id 改 `dsh-session:<sessionId>`（`SessionId` 跨 resume 稳定） |
| `utils/status*.ts`/`diagnostics.ts`/`agent-profile.ts`/`session-memory-meta.ts` | — | 丢弃 | TUI 状态条与 omp agent-profile |
| `schemas/hindsight.schema.json` | — | 丢弃 | schemastery 生成表单 schema |
| `skills/hindsight-memory-doctor/SKILL.md` | 延后 | 延后 | 值得留，等 `memory://` 与命令面稳定后再改写成 dsh 诊断手册 |

## 2. 差距清单

1. **没有可用的会话历史读接口**。`Session.eventAt/snapshotEvents/ownEvents` 全部 `@deprecated` 且"new calls are prohibited"（同 note:15）。等价物：`ctx.sessionProjections.register` 自建 units（`packages/session/session-projection/README.md:34-58`），折叠 `user/message`/`assistant/message`/`tool/result`/`turn/start`/`turn/end`。
2. **没有插件可写的游标事件**。`appendPluginRecord` 只给 `packages/experimental/`（session README:70；`preset/agent-preset/skills/cordis-plugin-development/references/practices.md:21` 明确外部插件不得用）。等价物：pending 在 fold 里按 `turn/start`/`turn/end` 重置，水位线从队列尾部 job 的 `throughSeq` 恢复。
3. **`agent/turn-stopping` 不携带消息**（payload 只有 agent/turn/signal）。等价物：projection 状态。
4. **`ctx.jobs` 不适合内部队列**。job 归 agent session 所有、可为模型所见（`packages/jobs/jobs/README.md:38-44`）。等价物：自持 JSONL + `ctx.interval`（base 的 `timer` 插件提供，`refs/.../packages/bundle/base/cordis.patch.yml:24`）。
5. **没有 `session_shutdown`**。等价物：`ctx.effect` 逆序 unwind + `agent/disposed`；刷新用有界 `Promise.race`，默认 2s。
6. **上下文注入的语义不同**。pi 返回 context patch；dsh 的 pre-step 把消息 append 成 `user/message` 持久事件（`agent-loop/src/agent.ts:427-435`）。所以注入内容必须能被自己识别并排除在 retain 之外——用 `createUserMessage({ source: { kind: 'memory', form: 'recall' } })`，`form: 'recall'` 本来就是"从别的会话搬来的材料"（`packages/llm/llm/src/message.ts:60-67`）。
7. **无 `models` facade / `role:judge`**（`extensions/decision/host.ts` 依赖 omp 专有）。等价物：`plugins/judgment/omd-judgment` 的判官服务；本阶段不用。
8. **无 per-agent 记忆 profile**（`utils/agent-profile.ts`）。dsh 的 `agent/created` 能识别子代理，但"子代理不来读记忆"只需判断 subagent 来源，不需要独立配置。
9. **凭据解析是升级而非缺口**。`ctx.credentials.resolve(credentialRef('HINDSIGHT_API_KEY'))`，优先级 `$DSH_HOME/.credentials.yaml` > 进程环境 > cwd `.env` > `$DSH_HOME/.env`（`packages/credentials/credentials-local/src/index.ts:1-9`），替换旧插件的 40 行手搓 flat parser。
10. **项目级参数完全不成立**。无 per-workspace 配置任何形式。需要新包（§3.2）。
11. **没有 `ctx.ui`**。pi 的 `/hindsight` hub 无对应物；人对记忆的控制走 `ctx.commands.register`（`packages/interaction/commands/README.md:32-46`）+ web 面板。
12. **`memory://` 与 `dsh-resource://` 不是一回事**。后者是浏览器侧协议，provider 在 client 包内、读不到宿主 Hindsight（`packages/client/resources/README.md:36-61,84`）。模型侧走 `ctx.readSchemes`。

## 3. 文件级实现

### 3.1 `plugins/archived/omd-memory/`（新建，一个能力一个包）

判据：单一用途（Hindsight 记忆），无第二个 provider、无第二个 consumer，不拆（`AGENTS.md:54-59`）。宿主入口 `src/index.ts`，本阶段无 client 半边。

| 文件 | 职责 / 关键导出 |
|---|---|
| `src/index.ts` | `name='omd-memory'`；`inject=['tools','agents','sessionProjections','workingDirectory','credentials']`；`apply(ctx,config)`：注册 projection、`agent/pre-step`、`agent/turn-stopping`、`agent/disposed`、`ctx.interval` flush、`ctx.effect` 关停；`ctx.inject(['readSchemes'],…)` 注册 `memory://`；`ctx.inject(['commands'],…)` 注册 `/memory` |
| `src/config.ts` | `Config` 接口 + schemastery `Config` + `resolveConfig` |
| `src/project.ts` | `projectIdentity(cwd,config)`（远程→basename→pin，同 `banking.ts:124-160`）、`projectTag`、`overridesFor(ctx,projectId)`（读 §3.2，缓存 + `domain/changed` 失效） |
| `src/client.ts` | `createClient(config)`：`recall/retain/reflect/ensureBank/listBanks/listMentalModels`；`HindsightError{status}`；超时与重试 |
| `src/banks.ts` | `ensureCodingBank`/`ensureUserBank`（mission + `retain_extraction_mode`）、`codingBank(session)`、`recallTagGroups(...)` |
| `src/pending.ts` | `memoryPending` projection（state：`{ turn, throughSeq, entries[], recent[] }`）、`readPending`、`readRecent` |
| `src/retain.ts` | `projectTurn(state,config)`（跳过 `source.kind==='memory'`；tool 只留 name+target；结果只留 error）、`buildRetainJob`、`retainTurn`（**只入队**） |
| `src/queue.ts` | `MemoryQueue`：`append/readTolerant/coalesce/flush/remove`；锁；`.dead.jsonl`/`.malformed.jsonl`；job 带 `{sessionId,turn,throughSeq}` |
| `src/recall.ts` | `buildQuery`、`runRecall`（scopes 并发）、`renderRecall`（`<hindsight-memory>` 信封）、`loadMentalModels` |
| `src/tools.ts` | `recall` / `retain` / `reflect` 三个工具 |
| `src/resource.ts` | `memory://` handler + `parseAddress` |
| `src/address.ts` | 地址文法（模型侧与未来界面侧共用） |
| `src/sanitize.ts` | `redactSecrets`/`redactError`（照搬 `utils/sanitize.ts`） |
| `package.json` | `private:true`；deps：`@vectorize-io/hindsight-client`、`zod`；peer：`cordis`、`dsh-tools`、`dsh-llm`、`dsh-session`、`dsh-agent`、`dsh-credentials`、`dsh-home-paths`、`dsh-working-directory`、`dsh-session-projection`、`schemastery` |
| `README.md` | 键表、地址表、project 覆盖清单、已知取舍 |

关键实现约束：

- projection 的 `apply` 对无关事件必须**返回同一引用**；relevant 事件才新建数组（README:54）。state 上限 `retainMaxContentChars`，超出丢最旧并记 `truncated:true`。
- 注入时机：`step === 1` 且 `turn % recallEveryNTurns === 0`，追加到 `decision.messages` 尾部（尾部追加保住前缀 KV 缓存）。prefetch（turn-stopping 预取下一轮、step 1 消费）照搬 `plugins/context/omd-hindsight/src/autorecall.ts:8-20`，`prefetch:false` 回落到同步路径。
- retain 时机：`turn-stopping` 里只做"投影→job→append 到 JSONL"，await 一次文件追加（毫秒级），然后唤醒 flusher；网络投递在后台。
- 水位线：内存 `Map<sessionId,throughSeq>`，启动时从队列尾部 job 恢复；`turn/start` 时清零 pending。
- 工具命名：`recall`/`retain`/`reflect`，不用 `memory_*` 前缀（`AGENTS.md:220-228`：模型没见过的名字等于不存在；这三个词是 MCP 暴露面里模型已经见过的动词）。

### 3.2 `plugins/workbench/omd-project-config/`（新建，独立能力）

判据：它不是记忆的一部分——subagent 并发、判官候选等都要读它；拆开才能单独回滚（`AGENTS.md:75`）。

| 文件 | 职责 |
|---|---|
| `src/index.ts` | `defineDomain({name:'project-config',version:1,tables:{overrides:domainTable(schema)}})`；`ctx.projectConfig.get(projectId,pluginId)` / `set` / `delete`；`ctx.effect` 内 `open`+`close` |
| `src/types.ts` | 记录形状 `{projectId,pluginId,values:Record<string,JsonValue>}`，key=`${pluginId}/${projectId}`；消费者自校验值类型 |
| `src/remote.ts` | typert remote（照 `packages/schedule/schedule/package.json:29-37` 的 `./typert`/`./remote` 导出） |
| `src/client/` | project 卡片上的入口 + 面板；`dsh.client:{platform:'web'}`（`AGENTS.md:77-87`） |

落地顺序：先 `src/index.ts`（记忆插件已可读），remote+面板最后做。上游没有 per-project settings 的先例，`settings-controller` 不可扩展——这是**新增能力**，不是配置项。

## 4. `memory://` 地址

- 协议名 `memory`，第一段是资源种类：`bank` | `models` | `queue` | `recall`。
- **模型侧**：`omd-memory` 在 `ctx.inject(['readSchemes'])` 里 `register('memory', handler)`，复用 `plugins/host/omd-read/src/schemes.ts:18-25` 的注册表，返回纯文本（read 工具负责行选择器/信封）。
- **界面侧**：将来是 `dsh-resource://memory/...`，由 `omd-project-config` 或记忆包自己的 client 半边提供 provider。两段共享 `src/address.ts` 的文法，不共享实现。

```
memory://bank/coding                        → bank profile + stats + mission
memory://models/coding                      → 该 bank 的 mental models（renderMentalModelsBlock）
memory://recall/coding?q=<percent-encoded>  → 一次性 recall，与 recall 工具同一路径
memory://queue                              → pending/dead/malformed 计数 + 最老 job 年龄
```

bank 段接受角色别名 `coding`/`user`，解析到实际 `bankId`（角色稳定、id 可换，`pi-hindsight/CONTEXT.md:39-41`）。project 不作地址段：它由会话工作目录推出，写进 tag，不进地址。

## 5. 配置 schema（profile 层，`Volatile` 即可在 Settings 表单里改）

包内默认值只表达"没配置时是什么状态"，不含任何本机事实：地址空、bank 空、凭据名只给通用变量名。本机取值（网关地址、真实 bank id、`projectId` 钉值）一律落在 `$DSH_HOME/profiles/omd/cordis.patch.yml` 的 `omd-memory` 行；仓库副本 `profiles/omd/cordis.patch.yml` 里也不写个人值（`AGENTS.md:88-96`）。

| 字段 | 类型 / 默认 | volatile | 说明 |
|---|---|---|---|
| `enabled` | `boolean` / `true` | ✓ | 整个记忆后端的总开关 |
| `baseUrl` | `string` / `''` | ✓ | Hindsight 地址；**空 = 未配置**，不做 localhost 兜底（`AGENTS.md:88-96`） |
| `apiKeyRef` | `string` / `'HINDSIGHT_API_KEY'` | ✓ | 凭据引用名，值走 `ctx.credentials` |
| `timeoutMs` | `number` / `30000` | ✓ | 单次 HTTP 上限 |
| `codingBank` | `string` / `''` | ✓ | 空 = 由 `bankPrefix` 派生；显式值即固定 bank id |
| `bankPrefix` | `string` / `'dsh-coding'` | ✓ | 派生 bank 的前缀 |
| `userBank` | `string` / `''` | ✓ | 空 = 不启用 life bank（显式 retain 才会写它） |
| `scopeMode` | `'domain-tagged'\|'isolated-bank'` / `'domain-tagged'` | ✓ | 项目隔离方式（ADR-005） |
| `projectIdStrategy` | `'remote'\|'basename'\|'pin'` / `'remote'` | ✓ | 项目标识来源 |
| `projectId` | `string` / `''` | ✓ | 显式钉住项目标识 |
| `includeSharedObservations` | `boolean` / `false` | ✓ | recall 是否带 bank 内无 tag 观察 |
| `autoRecall` | `boolean` / `true` | ✓ | 每轮自动召回 |
| `prefetch` | `boolean` / `true` | ✓ | 上一轮末尾预取、下一轮消费 |
| `recallEveryNTurns` | `number` / `1` | ✓ | 每 N 轮召回一次 |
| `recallBudget` | `'low'\|'mid'\|'high'` / `'mid'` | ✓ | 服务器召回预算 |
| `recallMaxTokens` | `number` / `800` | ✓ | 项目 bank 召回 token 上限 |
| `recallTopK` | `number` / `8` | ✓ | 渲染条数上限 |
| `recallTypes` | `string[]` / `['observation']` | ✓ | 召回事实类型 |
| `recallContextTurns` | `number` / `2` | ✓ | 查询串里带几轮对话 |
| `recallMaxQueryChars` | `number` / `800` | ✓ | 查询串截断 |
| `recallTimeoutMs` | `number` / `40000` | ✓ | 召回超时 |
| `mentalModels` | `boolean` / `true` | ✓ | 召回块是否附 mental models |
| `mentalModelsMaxChars` | `number` / `6000` | ✓ | 附件字符预算 |
| `autoRetain` | `boolean` / `true` | ✓ | 轮末自动 retain |
| `retainAsync` | `boolean` / `true` | ✓ | 服务器后台抽取 |
| `retainUpdateMode` | `'append'\|'replace'` / `'append'` | ✓ | 写入模式 |
| `retainToolResults` | `'errors-only'\|'none'\|'all'` / `'errors-only'` | ✓ | 工具结果保留策略 |
| `retainMaxContentChars` | `number` / `20000` | ✓ | 单 job 内容上限，同时是 projection 上限 |
| `redactSecrets` | `boolean` / `true` | ✓ | 入队前脱敏 |
| `flushIntervalMs` | `number` / `30000` | ✓ | 后台投递间隔 |
| `flushMaxJobsPerPass` | `number` / `4` | ✓ | 单次投递条数 |
| `shutdownFlushMs` | `number` / `2000` | ✓ | 关停刷新预算，超时即放弃（job 留在盘上） |
| `queuePath` | `string` / `''` | ✗ | 空 = `dshHomePath('memory','retain-queue.jsonl')`；不进表单 |

**项目级可覆盖**：`codingBank`、`userBank`、`scopeMode`、`autoRecall`、`recallEveryNTurns`、`recallBudget`、`recallMaxTokens`、`mentalModels`、`includeSharedObservations`、`autoRetain`、`retainToolResults`。其余只在 profile 层。

**项目参数解析规则**：

1. 锚点是 `ctx.workingDirectory.get(agent.session)`（有效工作目录），**不是** `header.cwd`（原始项目，可能已被 `cd` 离开），也**不是** workspace 根（同一 workspace 可有子目录会话）。
2. 项目标识与 bank tag 用同一个函数 `projectIdentity(cwd,config)`，保证"写进哪个 bank/tag"和"读哪份项目参数"永远一致。
3. 缓存：`Map<projectId,{overrides,fetchedAt}>`，进程内常驻；失效靠 `ctx.on('domain/changed')` 中 `domain==='project-config'` 的事件（该事件在落盘后按写序发出，`storage-domain/src/events.ts:36-47`），不设 TTL。
4. 退回层级：项目记录无该键 → profile `Config` 值；整个记录不存在 → profile `Config` 值；`storageDomain` 未挂载 → profile `Config` 值 + 一次性 warn，不失败。
5. 记录不随目录消失删除（与 workspace 语义一致，`packages/workspace/workspace/README.md:73-77`）；UI 里显式删除才删。

## 6. 验证计划

前置：Hindsight 可达（`@vectorize-io/hindsight-client` 的 `health()` 成功，或 `curl -s "$BASE/health"` 返回 2xx；端点以服务端实际部署为准），`dsh --version` 为 0.2.1-rc.2。

1. **装载**：`dsh plugin --profile omd add ./plugins/archived/omd-memory` → `dsh --profile omd` 启动无插件加载错误，工具表里出现 `recall`/`retain`/`reflect`；`$DSH_HOME/profiles/omd/cordis.patch.yml` 里出现 `omd-memory` 段，`config.baseUrl` 已填，Magpie 的 `llm-pi-ai` 段未被触碰。
2. **配置缺失不炸**：临时把 `baseUrl` 置空重启 → 启动成功，记忆工具仍注册但调用返回"未配置"错误；会话正常结束。
3. **`memory://` 读取**：会话里让模型 `read` `memory://bank/coding` → 返回 bank profile 与 stats，而不是"unknown resource scheme"；`read` `memory://queue` → 输出 pending 计数。
4. **retain→recall 往返**：同一会话说"记一下：这个仓库的发布分支叫 release-x"→ 等 1 个 flush 周期 → `cat $DSH_HOME/memory/retain-queue.jsonl` 该行为空（已投递）→ 新开会话问"发布分支叫什么" → 首轮上下文出现 `<hindsight-memory>` 且含该事实。
5. **召回不回流**：在含召回块的会话继续对话 → 库里该 document 的内容不含 `<hindsight-memory>` 字样（`curl` recall 或 `memory://recall` 自查）。
6. **离线不阻塞轮次**：把 `baseUrl` 指向死端口 → 提一句、等一轮结束 → 轮次正常关闭（无长等），队列文件新增一条 valid job，`.dead.jsonl` 为空。
7. **退出不被队列拖住**：`time dsh --profile omd` 起会话、说一句、退出 → 退出耗时 < `shutdownFlushMs` + 3s，job 留在盘上而非丢失。
8. **恢复投递**：改回正确 `baseUrl` 重启 → 30s 内队列排空；`.dead.jsonl` 仍为空。
9. **项目覆盖生效**：给当前项目写入 `recallMaxTokens: 200` → 同会话下一轮召回请求的 `max_tokens` 为 200（`ctx.logger` 或 `memory://recall?...` 观察）；删掉记录 → 回到 profile 值。
10. **子目录不串项目**：在同一 workspace 的子目录开会话 → `project:` tag 与父目录会话一致（同 git remote），`memory://bank/coding` 不变。

## 7. 风险与未决

1. **注入即持久消息，会推进前缀缓存失效点**。倾向：每轮一次、追加到尾部、预算 800 token；`recallEveryNTurns` 默认 1 但保留调大能力。不改成系统提示注入——那会让"模型可见⟺已记录"断裂。
2. **中断的一轮可能重复 retain**。projection 随 turn 边界重置，队列尾部水位线覆盖常规重启；崩溃在"已入队未写水位"之间会至少一次重投。倾向：接受 at-least-once（Hindsight `append` 语义下重复是追加，不是覆盖），死信可查。
3. **`@vectorize-io/hindsight-client` 的运行时解析**。`plugins/link-host-runtime.mjs` 只软链 `@deepseek-ai/*`，这个依赖必须由包自身依赖树提供。倾向：写进 `dependencies`（不是 peer），`dsh plugin add` 走 pnpm 安装；CI 冒烟里加一次 import 检查。
4. **项目标识随 git remote 变动而漂移**（fork/改名 → 记忆孤岛）。倾向：`projectIdStrategy:'remote'` 保持默认，同时在 `memory://bank` 输出 `basis`，需要时用 §3.2 钉 `projectId`。
5. **两 bank 固定路由 vs pi 的判官选 bank**。倾向：本阶段不做判官；等 `omd-judgment` 的服务面稳定后，把 `decision.model: role:judge` 映射过去，只用来决定"这轮要不要召回/召回哪个 bank"，不用来决定写哪个 bank（写入必须确定）。
