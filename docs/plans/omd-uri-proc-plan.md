# proc 源：后台作业与服务状态

结论：`proc://` 覆盖两个注册表——`ctx.jobs`（后台作业）与 `ctx.terminals`（常驻 PTY 会话，omp 里"服务"的对应物）。只读、非消耗、按会话围栏；`kill`/`close`/`signal` 一律留在工具与 Remote，路径里不出现动词。

已定（2026-10-22，Main）：terminal 一起做，语义是"这台机器上正在跑的东西"，缺席时写 `unavailable`；浏览器半边先不带会话身份，web 侧作业权威面是 `ui-jobs`，将来要读也复用它的数据源而不是另起名册。

## 1. 承载服务（证据）
- `ctx.jobs`：抽象 seam `refs/deepseek-harness/packages/jobs/jobs/src/index.ts:88-196`；`list(caller):120`、`get(id, caller):129`、消耗式 `read:139`、非消耗式 `readAt(id, from, caller):151`、`kill:163`、`remove:186`。
- 会话围栏：`refs/deepseek-harness/packages/jobs/jobs-local/src/index.ts:310-314`（`owner === undefined || owner.id === caller`），`:397-414`（`unknown job` / `belongs to another session` 是两条不同错误）。
- 投影字段：`refs/deepseek-harness/packages/jobs/jobs/src/view.ts:64-99`（`id/kind/label/status/progress/detail/startedAt/finishedAt/output{total,earliest,spillPaths}`）。
- 输出环坐标：`refs/deepseek-harness/packages/jobs/jobs/src/types.ts:227-240`（`readAt` 返回整块 chunk、`next` 是下一个绝对字节偏移、`lossy`）。
- 现有渲染口径（必须对齐）：`refs/deepseek-harness/packages/jobs/tool-jobs/src/index.ts:360-363`（名册行 `<id> [<kind>] <status> — <label>`，空为 `(no background jobs)`）、`render.ts:76-83`（丢弃 `log` 通道、stderr 归到 `[stderr]`、丢失字节时给 spill 提示）、`render.ts:56-60`（`[status: …, <detail>]`）。
- `ctx.terminals`：`refs/deepseek-harness/packages/terminal/terminal/src/index.ts:105-137`；`list(owner):308`、`read(owner,id,{offset,count}):263`、`kill:285`、`signal:274`；快照 `types.ts:133-145`、回滚页 `types.ts:103-123`；id 形状 `pty-<n>`（`index.ts:166`）。围栏是 `Agent` 对象同一性（`:310`），不是字符串。
- 内部路径契约：`plugins/host/omd-internal-paths/src/service.ts:22-45`（`InternalExec` 今天只有 `signal`）、`parse.ts:17-18`（源名 `[a-z0-9-]+`）。
- 组合事实：`ctx.jobs` 恒在（`refs/deepseek-harness/packages/bundle/base/cordis.patch.yml:96-97`、`:289-290`）；terminal 是可选行，只在 `plugins/archived/omd-core/cordis.patch.yml:98-105`，profile 的 patch 里没有——所以 terminal 半边默认休眠，不能假设它在。`omd-internal-paths` 那行已经挂在 `profiles/omd-full/cordis.patch.yml:83-86`（`~/.dsh/profiles/omd-full` 同步有，`--dump-config` 退出 0、stderr 空），不需要再加。

## 2. 地址语法
```
dsh-resource://proc/                 (模型简写 proc://)   名册：作业 + 会话
dsh-resource://proc/<id>            单条详情：头部 + 保留输出/回滚页
dsh-resource://proc/<id>/output     单条详情去掉头部，只有作业输出正文
```
真实示例：
1. `proc://` → `scope: session sess_7f2c…` 后接 `jobs (2)` / `bash-4f81c9a0b1234567 [bash] running — npm run dev` / `sessions (1)` / `pty-1 (main) [shell] running pid=48213`；全空时 `(no background jobs or sessions)`。
2. `proc://bash-4f81c9a0b1234567` → 头部 `bash-4f81c9a0b1234567 [bash] running — npm run dev`、`scope: session sess_7f2c…`、`started 2026-10-22T09:12:31.000Z`、`output: bytes 0..8192 retained (total 8192, earliest 0)`、`spill: <path>`（有则给）、`action: job_kill(job_id="bash-4f81c9a0b1234567") to stop`，空行后是正文。结算后同一行变成 `[status: killed, cancelled by the model: …]`（`detail` 并入状态行，`render.ts:56-60`），`action:` 行消失。
3. `proc://pty-1` → `pty-1 (main) [shell] running pid=48213`、`scope: session sess_7f2c…`、`action: terminal_close(sessionId="pty-1") to close; terminal_signal(sessionId="pty-1", signal="SIGINT") to interrupt`，空行后是最近一页回滚，末行 `(older lines: terminal_read(sessionId="pty-1", offset=<lineBegin>))`。
4. `proc://bash-4f81c9a0b1234567/output` → 只有正文，头部信息全部缺席。

`InternalSource` 声明：`grammar` 为上面三形，`shorthand: true`，`live: true`（数据在读取期间会变；客户端今天只取一帧，不跟随）。

## 3. 读取语义与错误形态
- **红线（读之前先看）：正文只走 `readAt(id, view.output.earliest, caller)`，永不调用 `read`。** `read` 会推进模型消费游标（`jobs-local/src/index.ts:88-89`、`:470-472`），一次路径读就会让 `job_output` 少掉一段本应属于它的增量，而且没有任何报错——这是本源唯一"读一下就损坏别的读者"的陷阱，评审时必须逐行确认没有 `registry.read(`。
- 头部固定三段，缺一不可：状态行（含 `detail`）、`scope: session <id>` 或 `scope: unfenced`、`output:` 窗口与 `action:`。`scope` 不是装饰：`exec.agent` 缺席时名册只剩无主作业，没这一行就表现为"作业消失了"，没人能诊断。
- 名册：`ctx.jobs.list(agent.id)` 逐行用 `job_list` 的同一格式；`ctx.terminals?.list(agent)` 逐行用 `terminal_list` 的同一格式（`render.ts:166-176`）。两个 section 各自带条数，空的 section 省略；`ctx.jobs` 缺席时写 `jobs: unavailable (no ctx.jobs)`。
- 详情：`get` 取头部；正文按上一条红线读，再按 `tool-jobs/render.ts:76-83` 的同一口径渲染：丢 `log` 通道、stderr 归组、`lossy` 或任一 chunk 带 `gapBefore` 时在末尾给 `[some output was dropped from memory; full output: …]`。名册同样带 `scope:` 行。
- 保留窗口就是上限（运行期 256 KiB、结算后 16 KiB，`docs/subsystems/jobs.md:386`）：路径读到的字节数不超过环，不另设截断；再往下的行/字节窗口由 read 工具自己做（`plugins/host/omd-read/src/index.ts:395-403`）。
- 会话详情：`ctx.terminals.read(agent, id)` 取最新一页；`read` 的 `offset/count` 分页仍归 `terminal_read`，地址不发明第二套坐标。
- 错误（统一一句话，不暴露存在性）：
  - 未知 id 或他人 id：`cannot read "proc://x": no job or session "x" for this session (roster: proc://)`——刻意不区分 `unknown job` 与 `belongs to another session`，尽管注册表内部区分（`jobs-local:397-414`）。
  - 对着会话 id 写 `/output`：`cannot read "proc://pty-1/output": pty-1 is a terminal session; read "proc://pty-1" or use terminal_read(sessionId="pty-1")`。
  - 终端服务缺席：`cannot read "proc://pty-1": no terminal service is mounted in this profile`。
  - 非法子路径：`cannot read "proc://<id>/foo": proc accepts "", "<id>", "<id>/output"`。

## 4. 写动作用什么形态（本设计的核心答案）
路径永远只读；停止/关闭/信号三个动作都走已有的写面，路径只负责把"该用哪一次调用"印在详情头部。
- 模型侧：头部给可复制的调用文本——`job_kill(job_id=…)`、`terminal_close(sessionId=…)`、`terminal_signal(sessionId=…, signal=…)`。工具是唯一入口，所以经过审批、落 `tool/result`、并进 `job_kill` 的投递台账（`tool-jobs/src/index.ts:257-261`：模型自己发起的 kill 不会再收到重复完成通知）。
- 界面侧：`ctx.remote.job.kill({sessionId, jobId})` 已经存在（`refs/deepseek-harness/packages/api/job-controller/src/index.ts:109-127`，理由记的是 `cancelled by the user`），`ui-jobs` 的停止按钮就走它。proc 的资源协议只提供数据，按钮复用这个 Remote。
- 被否决的三形：`proc://<id>/kill`（读一次就产生副作用——预览、缓存预热、HTTP 重试都会二次触发，`read` 的 `isConcurrencySafe` 与资源缓存假设同时被破坏）；`proc://<id>?kill=1`（`parse.ts:4-8` 明确把 `?` 留在 path 里交给源，它不是 query，会变成 id 的一部分）；新增 `proc_kill` 工具（`job_kill` 的第二个门，授权同一个 `caller` 围栏、投递台账却要各自维护）。

## 5. 与现有工具的重合面
| 需求 | 已有 | proc | 处理 |
|---|---|---|---|
| 名册 | `job_list` / `terminal_list` | `proc://` | 保留工具：上游 `tool-jobs` 不可单独拆掉一个工具，fork 不划算；两者行格式逐字对齐 |
| 增量读取 | `job_output`（消耗式） | — | 不覆盖；路径刻意不碰游标 |
| 全量/稳定地址 | 无 | `proc://<id>/output` | 路径的唯一独占价值：可缓存、可贴进界面、可重复读 |
| 停止 | `job_kill` / `terminal_close` / `terminal_signal` | — | 写动作只在这里 |

## 6. 安全边界
- 围栏靠 `agent`：`InternalExec` 定型为 `{ signal, cwd?: string, agent?: Agent }`（一次改完，别分两次动同一个类型），由 `omd-read` 传 `exec.agent` 与它已经解析好的 `exec.cwd`（`plugins/host/omd-read/src/index.ts:221`）；`jobs` 用 `agent.id`，`terminals` 用对象本身。`cwd` 是给仓库/文件类源的，proc 不收相对地址，因此**不用** `cwd`。缺 `agent` 的调用（浏览器 `readRemote`）按注册表语义只看无主作业——浏览器本来也没有会话身份，界面侧作业观测的权威面是 `ui-jobs`。
- `agent` 的语义只是**作业与终端的归属**，不是历史读权限；跨会话读历史的开放决定与本源无关，别把两者混成一条围栏。
- 不放大错误：不把"他人的 id"翻成"别人的作业"，也不在名册里列出别人的条目。
- 不新增过滤：输出就是 producer 写进环的字节，与 `job_output` 同源；沙箱对环境的清洗在 spawn 前完成，这里不做二次审查。
- 无秘密入口：`proc` 只读两个注册表已围栏的投影，不碰会话日志、不碰 fs。

## 7. 实施切片与验收
1. 前置：`ReadMigration` 正在做 `plugins/host/omd-read/src/index.ts:289-299` 删 `readSchemes`、改 `inject: ['internalPaths']`、读地址走 `ctx.internalPaths.read(address, { signal, agent: exec.agent, cwd })`（`docs/omd-internal-paths.md:51-56` 第 2、3 步）；proc 不重复做，只等它落地。profile 那行已就位。
2. `plugins/host/omd-internal-paths/src/service.ts:22-26`：`InternalExec` 加 `agent?: Agent` 与 `cwd?: string`（type-only import `@deepseek-ai/dsh-agent`），注释写清"agent = 归属围栏；cwd = 相对地址解析；两者都可缺"。`InternalSource` 的宿主侧 `locate?(path, exec): Promise<string | undefined>` 与这两字段同一次改完（artifact 要复用 read 的文件分支），**不进** `markRemoteMethods`（`service.ts:187-190`）；proc 不实现它，`locate` 缺省时 read 走文本分支，窗口行为不变。
3. 新建 `plugins/omd-proc/`：`package.json`（peer: `@deepseek-ai/dsh-jobs`、`@deepseek-ai/dsh-terminal`、`@deepseek-ai/dsh-agent`、`omd-internal-paths`）、`src/index.ts`（`inject: ['internalPaths']`，`ctx.get('jobs')` / `ctx.get('terminals')` 在**读取时**取，注册 `proc`）、`src/render.ts`（名册/头部/正文三个渲染器，口径抄 `tool-jobs/src/render.ts`）。`Config` 为空对象：可调项已经分别在 read 工具（`maxBytes`/`maxLines`）与 `jobs-local`（`retainBytes`/`settledRetainBytes`）上，proc 不再造第二份。
4. `profiles/omd-full/cordis.patch.yml` 只追加 `omd-proc` 一行 insert（`omd-internal-paths` 已有，见 §1），`dsh plugin --profile omd-full add plugins/omd-proc` 建 link。每个源插件各带自己的行，别把行挂在别的源的切片里。
5. 验收：
   - `dsh --profile omd-full --dump-config` 退出码 0、stderr 为空；启动日志无 `did not activate`。
   - `bash("npx vite", run_in_background: true)` 后 `read("proc://")` 出现同一 id，行与 `job_list` 逐字相同。
   - `read("proc://bash-<id>")` 后再 `job_output(job_id)` 仍拿到完整增量（游标未被路径推进），完成通知仍到达。
   - `read("proc://bash-<id>/output")` 等于该详情的正文部分；`read("proc://nope")` 报第 3 节的错误且不带名册以外的信息。
   - 第二个会话读第一个会话的 id：同一条错误，不泄露存在性。
   - 挂上 terminal 行后：`terminal_open` → `read("proc://pty-1")` 出状态、回滚页、`action:` 行；`read("proc://pty-1/output")` 报形状错误。

## 8. 风险
1. **结算后只剩 16 KiB，路径却像"日志本体"**：用户/模型会把 `proc://<id>/output` 当完整日志导出，拿到截断文件而不自觉。缓解：丢失信息写在**头部第一行**（`output: bytes 4096..57344 retained (earliest 4096 — 4096 bytes dropped; full output: <spillPath>)`；没有 spill 文件时写 `full output: unavailable`），不是结尾小字。
2. **读者身份丢了就静默变空名册**：`exec.agent` 在嵌套 PTC 派发里可能缺席，roster 会只剩无主作业，看起来像"作业消失了"。缓解：头部固定一行 `scope: session <id>` 或 `scope: unfenced`，让错误视图显形；`agent` 缺失时 `sessions` section 直接写 `sessions: unavailable (no caller)`。

## 已定（不留待议）
1. terminal 一起做：omp 的 `proc` 本就含服务；terminal 行缺席时自动只剩 jobs，并写 `sessions: unavailable (no ctx.terminals)`。
2. 浏览器半边不带会话身份：`ui-jobs` 的 `job.list/follow/kill` 已是界面侧权威面；真要做 proc 预览时复用它的数据源，而不是给 `internalPaths.read` 另开一条带身份的读法。
