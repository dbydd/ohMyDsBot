# local 源：跨代理共享的耐久文档

只读设计，未改仓库文件。上游引用为 `refs/deepseek-harness/`（dsh 0.2.1-rc.2）。定位按本轮澄清固定：写一次、多个会话按地址反复读的共享文档，不是代理间传话；没有通知、订阅、权限。

## 结论

- 专用目录 `<DSH_HOME>/local/v1/`，每个 `$DSH_HOME` 一份、跨会话可读；不用 `storageDomain`。
- 读面是 `ctx.internalPaths` 的 `local` 源（简写 `local://`）；写面是 `ctx.localDocs.write()`，模型侧入口是排在源之后的 `omd-write`。`live: false`，没有订阅或广播；需要别人知道，用消息说。
- 覆盖：整篇替换，同名即覆盖，结果带 `replaced` 与旧 mtime；不做版本追加。
- 并发：进程内按路径串行、原子发布；跨进程最后写者胜，无锁无合并。
- 清理与上限：单篇 4 MiB、深度 4、清单 200 条；没有总量配额与自动清理，根是普通目录，由人按需删。

## 一、承载服务的证据

- 源契约只有读：`plugins/host/omd-internal-paths/src/service.ts:28-45`（`InternalSource`）、`:66-91,134-146`（注册/解析/读）。`InternalExec` 只有 `signal`（`:22-26`），而 proc、terminal 需要的 `agent?` 会由那条共享契约加上；local 不消费它，因为全局开放读与阅读者身份无关，不要为「统一」硬塞。路径余量原样透传、允许为空：`plugins/host/omd-internal-paths/src/parse.ts:17-18,37`；网页桥的 `open(address)` 也不带会话（`plugins/host/omd-internal-paths/src/client/index.js:99-115`），所以共享的 local 在模型侧与界面侧共用一套读法。
- 私有目录落盘已有先例：`<DSH_HOME>/attachments/v1`（`refs/deepseek-harness/packages/attachment/attachment-local/README.md:55`）；`<root>/session-<hash>/…`、0700、独占创建、启动清扫（`refs/deepseek-harness/packages/spill/spill-local/README.md:54-59,91`）。home 路径用 `dshHomePath`（`refs/deepseek-harness/packages/util/home-paths/src/index.ts:160-162`）。
- 写留在工具侧（`docs/omd-internal-paths.md:71-79`）；工具名不许自造词（`AGENTS.md:223-229`）。
- omp 实测的 `local://` 按顶层会话分目录；这里刻意不分：需求是跨会话共享，omp 的会话目录会让另一会话读不到。目录式寻址与「根清单 + 递归排序」照搬，清单另补大小与 mtime 供自证。

## 二、为什么不用 storageDomain

- 名字被布局绑死：per-record 要求 key 匹配 `[a-zA-Z0-9_-]+`（`refs/deepseek-harness/packages/storage/storage-json/src/per-record-unit.ts:16-17,38-39`），`omd-uri-local-plan.md` 要编码；`single` 不限 key，但每次写重发整单元、全量驻内存（`refs/deepseek-harness/packages/storage/storage-json/src/single-unit.ts:5-8,41-49,140-147`）。
- 域是给结构化权威数据设计的：文档形态各异，没有稳定 schema，编空壳只是把校验变成摆设；坏记录还会让整个域打不开，只有 per-record 能 `backup-and-skip`（`refs/deepseek-harness/packages/storage/storage-domain/src/spec.ts:57-67`）。
- 并发原语用不上：`update` 的原子读改写（`refs/deepseek-harness/packages/storage/storage-domain/src/domain.ts:83-89`）是给同一记录合并的；local 是整篇替换。
- 跨进程更差：`domain/changed` 只在进程内可见（`refs/deepseek-harness/packages/storage/storage-domain/README.md:146`），JSON `single` 下两个进程会互相盖掉整个单元；逐文件 rename 至少不撕裂。
- 可检查性：目录里的 `.md` 能被 `bash`、`grep`、编辑器读删；域里的文档只在 JSON blob 内。`project-config` 用域是对的，它存少量结构化参数（`plugins/workbench/omd-project-config/src/service.ts:63-67,153-168`）。

## 三、地址与命名

规范形 `dsh-resource://local/<path>`，模型侧简写 `local://<path>`（源声明 `shorthand: true`）。真实形态：

- `local://`：根清单，空余量与单个 `/` 同义。
- `local://omd-uri-local-plan.md`：一篇文档。
- `local://task-log/Main.md`：目录式两层；`local://task-log` 或 `local://task-log/`：该目录的直接子项。

规则：

- 余量按 `/` 分段。段非空、不是 `.` 或 `..`、不以 `.` 开头；不含 `\`、NUL、控制字符；单段 ≤200 字节，深度 ≤4，整条 ≤400 字节。空格与中文原样允许，不做百分号解码。
- 全局命名空间，没有会话段。跨主题重名靠目录前缀避开（`task-log/`、`omd-uri/`），不自动加命名空间。
- 扩展名不强制，散文建议 `.md`。名字标识以介质为准：APFS 默认大小写不敏感，清单回显磁盘拼写。
- `.tmp` 段保留；余量以 `/` 开头且不是只有 `/` 时报错，不做就地规范化。

## 四、读取与列出

- 文件：整篇 UTF-8 文本，空文件返回空串；源不做选择器，行窗口由 `read` 层统一处理（`plugins/host/omd-read/src/index.ts:394-403`）。超过 `maxDocumentBytes` 报 `5.2 MiB exceeds maxDocumentBytes (4 MiB)`，非 UTF-8 报 `not UTF-8 text`，不截断。
- 目录：不带尾斜杠且是目录时，返回直接子项，排序，目录带 `/`。根清单为 `# Local`、`Root: <绝对路径>`、`N files available:`，每行 `- <path> — <size> — <UTC ISO mtime>`；超过 `listingLimit` 时末行 `(+K more)`。清单与列表不创建目录，根不存在时返回 `0 files available.`。
- 缺失：`cannot read "local://x.md": no such local document (root: <绝对路径>)`。
- 非法名字：报违反的那条，例如 `invalid local name segment ".."`、`path depth 5 exceeds 4`、`address must be relative`。
- 符号链接不是文档：清单跳过，读取报 `symbolic link is not a local document`。

## 五、覆盖、并发与清理

- `ctx.localDocs.write(path, content, signal?)` 是唯一写实现，内部地址由 `internalPaths.write` 路由到这里，返回 `{ path, bytes, replaced, previousUpdatedAt? }`。整篇替换；没有追加、patch、改名、复制、删除，也没有文件内版本历史。
- 版本追加否决：一份文档一个当前版本；要留旧版就写新名字（如 `report-v2.md`）。会话日志里的工具调用内容能复盘谁写了什么，但不代替共享文档本身。
- 进程内按绝对路径串行（promise 链，按到达顺序）；不同路径并行。发布原子：先写 `<DSH_HOME>/local/v1/.tmp/<uuid>`，再 `rename`；读方只看到旧版或新版。
- 跨进程只有 rename 的原子性：最后一次写胜出，没有锁与合并；读-改-写可能丢更新。文档按「写一次、读多次」使用，这条可接受；需要共同编辑就拆成多篇，由一个人合成。
- 清理：存储层不做 GC、不按时间删。根是普通目录，删一篇或多篇由人或带外的文件操作决定；`rm -rf <root>` 会丢全部文档。上限只按次执行（4 MiB / 深度 4 / 清单 200 条），不设总量配额。

## 六、内容自证

- 写方在文首自报：`# 标题`、`Generated: <ISO 时间>`、`Source: <根会话 id 或 agent 名>`。存储层不校验、不改写正文；`write` 工具的描述要求这三行，散文文档自然满足。
- 机器可证的部分只有 mtime 与大小，清单里逐篇给出；`Source` 是自报字段，没有鉴权，因为读是开放的。不写 sidecar、xattr 或 YAML 头：文档类型不限于 Markdown，代写会破坏对照表、JSON、CSV 的原样字节。

## 七、安全边界

- 路径：逐段校验后 `join`，再断言 `relative(root, target)` 不含 `..` 且不是绝对路径；不跟随符号链接（读用 `lstat`，写前逐段确认父级是真实目录）。
- 权限：目录 0700、文件 0600，由本插件创建；不改动已存在目录的权限。没有按会话或用户的读权限模型，与 `agent://`、`history://` 一致。
- 不经过 `ctx.fs`：本地文档不应受 sandbox 模式围栏（`refs/deepseek-harness/packages/fs/README.md:31` 说明 fs-sandbox 按每次调用的 sandbox 模式围栏写入），也不能被换成远端文件系统；裸 `node:fs` 与 attachment-local、spill-local 同路。
- 内容不脱敏：它是本机私有共享区，不是秘密存储；不要把凭据写进去。

## 八、实施切片

1. 新建 `plugins/omd-local-docs/`：`src/store.ts`（无 Cordis：校验、清单、原子写、按路径链）、`src/index.ts`（`Config`、`register('local', …)`、`provide('localDocs')`）。`inject: ['internalPaths']`，不依赖 `agents`、`storageDomain`。
2. `Config`：`root?`（默认 `dshHomePath('local','v1')`，本机取值只进 profile）、`maxDocumentBytes`（4 MiB）、`listingLimit`（200）、`maxDepth`（4）。全部机器无关默认值。
3. `InternalSource`：`shorthand: true`；`live` 不声明（无订阅），`binary` 不声明（文本）。
4. profile：`profiles/omd-full/cordis.patch.yml` 加 `omd-local-docs` 行，并 `dsh plugin --profile omd-full add ./plugins/omd-local-docs`；`omd-internal-paths` 自己那行与模型侧可达性由 `omd-read` 迁移那个统一切片补。
5. `omd-internal-paths`：`InternalSource` 加可选 `write(path, content, exec)`，服务加 `write(address, content, exec)` 只做路由；`local` 实现它，其余源保持只读。`omd-write` 只负责普通路径与内部地址的分流以及消息。

验收（一次性脚本放 `/tmp`，不提交）：

- `node /tmp/omd-local-check.ts` 调 `store.ts`：写入后逐字节读回；`task-log/Main.md` 嵌套创建；顺序覆盖时 `replaced` 为 true 且 `previousUpdatedAt` 存在；同名并发写后内容是其中一篇的完整版本；`../x`、`/etc/passwd`、`.tmp/x`、5 段路径分别被拒；`stat` 看到 0700/0600；清单含大小、mtime、排序与计数。
- Cordis 冒烟：临时脚本挂 `omd-internal-paths` 与 `omd-local-docs`，`ctx.localDocs.write('a.md', 'hi')` 后 `ctx.internalPaths.read('local://a.md', {})` 返回 `hi`，根清单含 `a.md`；再注册一个只读假源，四种写失败各命中一次：`dsh-resource:///x`（语法）、`dsh-resource://nope/x`（源不存在）、`dsh-resource://ro/x`（源只读）、`local://../x`（源校验，带源名）。
- `dsh --profile omd-full --dump-config` 退出码 0、stderr 为空；`dsh --profile omd-full` 启动无 “did not activate”。

## 九、风险与写面

- 风险一：全局命名空间没有隔离，两个主题可能取同一个名字，后写会静默替换前一篇。结果里的 `replaced` 与旧 mtime 让替换可见；约定一篇文档一个所有者、按目录前缀分主题。没有权限模型是刻意的。
- 风险二：跨进程最后写者胜，读-改-写会丢更新。文档按「写一次、读多次」使用；需要共同编辑就拆篇，不引入锁。
- 写面已定：`omd-write` 照 `omd-read` 的形状替换上游 `write`，普通路径仍走 `ctx.fs.writeText`，内部地址走 `internalPaths.write`，profile 里 `tool-fs.write: false`。排序：`omd-read` 迁移 → `local` 源 → `omd-write`。
- `omd-write` 验收：普通文件写入与上游逐项一致（同样的 diff 展示、同样的错误文案）；内部地址失败分开报「地址语法错 / 源不存在 / 源只读 / 源校验没过」，不合并成「写入失败」。
