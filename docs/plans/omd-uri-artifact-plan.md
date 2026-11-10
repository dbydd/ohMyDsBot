# artifact 源：溢出的大输出

**结论**：`artifact://<id>` 不是新工具，是 spill 存储的读面。用 `omd-artifact` 替换 `spill-local`：仍实现 `ctx.spillStore`、仍写 `<root>/session-<hash>/`，但 locator 从绝对路径改成内容寻址的 `artifact://<id>`；同一个包把 `artifact` 注册进 `ctx.internalPaths`。模型侧 `read` 通过新增的**宿主侧** `locate()` 取得真实文件，复用现有文件读取（行选择器、流式、绝对行号）；字节范围复用 `ctx.fs.readByteRange`。不改上游、不解析 notice 文本、不另造工具。

## 1. 承载服务与落盘事实

| 事实 | 证据 |
|---|---|
| `SpillStore` 只有 `saveText`；locator 是不透明句柄，消费方不解析 | `refs/deepseek-harness/packages/spill/spill/src/index.ts:45-56`、`.../spill/src/types.ts:75-80` |
| 本地后端返回**绝对路径** locator 与固定 hint；落盘 `<root>/session-<sha256 前12>/<12 hex 随机>-<安全名>`，目录 0700、文件 0600 | `.../spill-local/src/index.ts:149-161`、`.../spill-local/src/store.ts:78-81,108-130` |
| `root` 默认是每进程随机 `$TMPDIR/dsh-spill-XXXXXX`；`cleanupPeriodDays` 默认 30，启动时一次性清扫 | `.../spill-local/src/store.ts:36-39`、`.../spill-local/src/index.ts:66-69,95-101` |
| 清扫只进 `session-<12 hex>` 目录，删过期**普通文件**，不跟 symlink；根目录下的非 session 条目跳过 | `.../spill-local/src/cleanup.ts:225-261,302-306` |
| 策略在结果超过 `maxInlineTokens`（base 配 12500）时保存全文，把 notice 接在预览后；`read` 结果不参与 | `.../spill-policy/src/index.ts:26-27,103-118,133-150`、`.../spill-policy/src/notice.ts:21-24` |
| `omd-shake` 的省略标记会保留 notice 里的 locator + hint，因此 locator 必须自解释 | `plugins/archived/omd-shake/src/shake.ts:88-107` |
| 内部路径只有 `read`（无窗口），Remote 只导出 `sources`/`read`；`InternalExec` 今天只有 `signal`，共享契约加 `agent?: Agent` 与 Main 的 `cwd?`（artifact 不消费） | `plugins/host/omd-internal-paths/src/service.ts:22-45,142-146,187-190` |
| `read` 的 scheme 分支目前把整串交给 handler，再 `buildWindow`；`selector.raw` 只解析未用于 render | `plugins/host/omd-read/src/index.ts:376,386-410`、`plugins/host/omd-read/src/selector.ts:22-26` |
| `ctx.fs.readByteRange(target,{offset,length})` 已存在，按窗口取字节且不缓冲整文件 | `refs/deepseek-harness/packages/fs/fs/src/index.ts:230-243` |

## 2. 地址语法

行语法直接复用 `parseSelectorSuffix`（`plugins/host/omd-read/src/selector.ts:28-78`）；`b` 开头是本设计新增的字节语法。`<id>` = `sha256(content)` 前 16 位小写 hex；行段与字节段不得混用，`:raw` 只对行段有效，抑制 `N|`。

```text
artifact://3f2a9c1d4e5f6071                 # 头一页
artifact://3f2a9c1d4e5f6071:1200-1400       # 行，1-based，闭区间；保留绝对行号
artifact://3f2a9c1d4e5f6071:-200            # 末 200 行
artifact://3f2a9c1d4e5f6071:5-16,900-910    # 多段
artifact://3f2a9c1d4e5f6071:b0-65535        # 字节 [0,65536)，0-based 半开
artifact://3f2a9c1d4e5f6071:b1048576+65536  # 从 1 MiB 起 64 KiB
artifact://3f2a9c1d4e5f6071:-b65536          # 末 64 KiB
dsh-resource://artifact/3f2a9c1d4e5f6071     # 规范形式，界面侧
```

## 3. 读取语义

- **模型侧**：`read` 先切选择器；地址命中已注册源且该源有 `locate` 时，`await locate(<id>)` 得到宿主文件，再用现有文件分支读。所有 model-facing 文本（`<path>`、footer、错误）用地址，绝不出现宿主路径。行窗口一次流式扫描全文件、只保留目标行，因此行号与总行数都是真实的；上限沿用 `maxLines=2000`、`maxBytes=50 KiB`、`maxLineLength=2000`。无选择器时 `offset=1, limit=500` 读头一页，footer 给总量与继续地址。
- **字节页**：`b<start>-<end>` 半开、`b<start>-` 到 EOF、`b<start>+<len>`、`-b<len>`（用 `stat.size` 求尾）；内部转成 `readByteRange({offset,length})`，`length` 截到 `maxBytes`。UTF-8 解码时丢掉窗口首部续字节与尾部不完整序列，footer 报调整后的字节区间与总量；字节页不显示行号。
- **无选择器**的代价：文件不整串进内存，但为得到总行数会线性扫一遍（见风险）。
- **界面侧**：`internalPaths.read(address)` 只返回头 `previewBytes`（默认 64 KiB）或 `:b…` 窗口；行分页是 `read` 的能力，界面发来行范围时明确拒绝而不是静默给 head。`locate` 不导出到 Remote。
- **存储**：`saveText` 先走 `LocalSpillStore.saveText` 拿到已写文件，再改名成 `<id>.<safeTool>.log`（同目录原子 rename，同 id 同内容直接覆盖）。随后追加一行 `<root>/artifacts.jsonl`：`{id,dir,name,bytes,tool,at}`。解析优先查 ledger，未命中再扫 `session-*` 找 `<id>.*`，因此 ledger 写失败不影响读。内容相同即同 id，重跑同一命令得到同一地址；fork/restart 不需要复制文件。

## 4. 错误形态

| 情形 | 模型看到 |
|---|---|
| id 不是 16 hex 或地址带非法后缀 | `cannot read "artifact://…": artifact id must be 16 lowercase hex characters; use :1200-1400 for lines or :b0-65535 for bytes` |
| ledger 有记录、文件不在、`cleanupPeriodDays > 0` | `cannot read "artifact://<id>": expired — the startup spill cleanup removes files older than <N> days; re-run the tool call that produced it` |
| ledger 有记录、文件不在、cleanup 已关 | `… missing from the artifact store (cleanup is disabled; the file was removed outside the store)` |
| 无 ledger 记录且扫不到 | `… not found; available: <最多 5 个 id>` |
| 行 0、end<start、空段 | `… invalid line range "<suffix>": lines are 1-based and end must not precede start` |
| 行段与字节段混用 | `… mixed line and byte ranges are not supported` |
| 根目录不是 0700 / 非当前用户 | `artifact store root is not private; set root to a user-only directory`（启动时报，不静默降级） |

清理是**启动时一次性**扫（`spill-local/src/index.ts:95-101`），所以“过期”指上次启动后已被删，不是立即删除；`cleanupPeriodDays: 0` 时不会发生过期。

## 5. 安全边界

- 地址只接受 `[0-9a-f]{16}` 与已定义的选择器，**从不**把地址拼进路径；ledger 的 `dir`/`name` 也要匹配 `session-<12 hex>` 与 `<id>.<安全名>` 后才 join。
- 根目录创建为 0700 并在激活时校验（目录、当前用户、`mode & 0o077 === 0`）；文件沿用 0600。扫描用 `lstat`，符号链接一律不跟。
- 源只读；不提供写、删、清理入口。清理仍归 backend 的启动 sweep。
- 内容不出宿主：界面经 Remote 拿文本，模型拿 id；日志只记 id/code，不记内容与宿主路径。

## 6. 实施切片

1. `plugins/omd-artifact/src/store.ts`：继承 `LocalSpillStore`，`Config = { root: required, cleanupPeriodDays=30, previewBytes=65536 }`；实现 id、rename、ledger、根目录校验。`package.json` peer 依赖 `@deepseek-ai/dsh-spill-local`、`@deepseek-ai/dsh-spill`、`omd-internal-paths`。
2. `plugins/omd-artifact/src/source.ts` + `index.ts`：注册 `artifact`（`shorthand: true`），实现宿主侧 `locate(id)` 与界面侧 `read(path)`（head/字节页），`static inject = ['internalPaths', 'fs']`。
3. 契约交接，不单独落 `plugins/host/omd-internal-paths/src/service.ts`：它的唯一编辑归共享迁移 owner，把 `InternalSource.locate?(path, exec): Promise<string | undefined>` 与 Main 的 `agent?`/`cwd?` 合并进同一次编辑。`locate` 返回宿主绝对路径，仅宿主侧，绝不进 `markRemoteMethods`（`service.ts:187-190`）；`undefined` 表示非文件源，缺失/过期由源抛错。新增 `src/range.ts` 放行/字节选择器纯函数（从 `omd-read/src/selector.ts` 迁出，行为不变），`omd-read` 改从此处 import。
4. 共享迁移之上改 `plugins/host/omd-read/src/index.ts`：先解析地址＋选择器，再 `internalPaths.resolve`；后缀解析失败时按整段地址处理、由源报错（沿用 literal-path-wins）。有 `locate` 走文件分支（`displayPath` 用地址），无 `locate` 保留现有文本＋`buildWindow`。新增字节页返回 `{rawText, bytes}`、`render` 走无行号 envelope、`presentationMeta` 返回 undefined；顺手让 `selector.raw` 生效。`package.json` 增加 `omd-internal-paths` 依赖。
5. 共享前置（谁先落地谁做）：`omd-internal-paths` 挂 profile 行 + `omd-read` 迁到 `ctx.internalPaths`（`docs/omd-internal-paths.md §5` 第 2、3 步，不保留 `readSchemes`）。本切片在其后只加 `omd-artifact` 行并禁用 `spill-local`，`config.root: !!js dshHomePath('spill')`；更新 `docs/omd-internal-paths.md` 与 `plugins/README.md`。

```sh
dsh --profile omd-full --dump-config            # exit 0，stderr 空，spill-local 不在 roster，omd-artifact 在
# 用 seq/yes 制造 >12500 tokens 的 bash 输出，确认 notice 里是 artifact://<16hex> 且没有 /tmp 路径
read 'artifact://<id>:100-110'              # 行号 100..110，footer 报真实总行数
read 'artifact://<id>:b0-65535'             # 前 64 KiB，字节 footer，无行号
read 'artifact://<id>:-5'                   # 末 5 行
# 删掉 backing 文件后重读：expired 而非 not found；界面 dsh-resource://artifact/<id> 返回 head 预览
```

## 7. 风险（2）

1. **无选择器读会为总行数扫完整个文件**（内存有界、I/O 线性）。GB 级输出应直接用 `:b…` 或带范围的行读；hint 与 footer 都教这件事。若实测不可接受，再加“头 N 字节快路径 + 总行数标为 ≥”的降级，不改地址。
2. **ledger 只增不压**，长期使用会线性增长；损坏或写失败时过期判定退化为 not found（读仍靠目录扫描）。先按每 (session,id) 一行去重，超过 10 万行时下次启动原子重写保留最近 30 天。

## 8. 待定（给调用方拍板，带推荐默认）

- **id 用内容哈希而非 omp 的数字**：推荐哈希。dsh 的数字 id 是 session 级，且 `InternalExec` 不带 session，跨会话/跨 root 会歧义；哈希 id 一段自足，fork/重启不用复制。
- **替换 `spill-local` 而非在 notice 之后做适配器**：推荐替换。适配器要解析并改写模型可见的 notice 文本，且漏掉 `session-reference` 的保存路径；替换只改 locator 的产出，消费方契约不变。
- **`root` 必填并由 profile 写成 `!!js dshHomePath('spill')`，不留 temp 默认**：推荐。否则每次启动换随机 root，ledger 与旧地址跨重启失效；`$DSH_HOME` 是用户私有目录，符合“无本机独有配置”。
