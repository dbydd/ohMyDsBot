# `@` 提及 issue / PR：设计切片

## 0. 五个问题的结论

1. **不新增触发器类别。** `TriggerChar` 是闭集 `'/' | '@'`（`ui-input-trigger/src/types.ts:34`），但**同一触发字符可以挂多个源**：`ui-reference` 注册 `@`/`reference`，`ui-commands` 与 `ui-skill` 都注册 `/`。我们注册第二个 `@` 源，名字 `issue`，不碰上游。
2. **候选来自绑定仓库的 issue 列表，不做全文搜索。** GitHub 搜索 API 认证后只有 30 次/分，逐键必炸；`listIssues` 在宿主内存里过滤 ETag 缓存页，逐键调用是 304（不计入配额）。空 query 给最近 20 条；无绑定或请求失败 → 该组零行，菜单自动跳过（`core/menu.ts:78-79`、`MenuView.tsx:137-138`），与 `ui-reference`「某个域不可用只影响该域」的既定行为一致（`ui-reference/README.md:38`）。
3. **编辑器里是原子 chip，进模型上下文的永远是文本。** 提交时 `facade.ts:751-771` 按 occurrence 用 `codec.serialize(ref)` 的返回值**覆盖** chip 的 clipboard 区间，再 `trim()` 交给 `session.prompt`；序列化失败直接拒绝发送，不会静默降级成可见文本。
4. **选中只插入引用，不附正文。** 理由见 §4。
5. 切片与验收见 §5。

## 1. 上游机制：一个客户端插件怎么加源（证据）

- 源契约：`candidates/onPick/header/matchSpace/matchEnter/matchClaim/warm/lexicon/subscribeLexicon/openReference/codec`，全部可选实现，实现即参与（`ui-input-trigger/src/types.ts:160-242`）。
- 注册：`ctx.effect(() => inputTriggers.registerSource(src), '…')`；`(trigger,name)` 重复直接抛错（`service.ts:57-59`），dispose 即摘组（`:71-77`）。菜单组按 `order ?? 0` 升序（`:103`），`ui-reference` 是 0，我们取 10 排在文件/会话之后。
- 座位与服务：`inject: ['inputTriggers', 'locale', 'sessions', 'remote', 'sidebarRight', 'slots', 'uiConversation']`，另加 `workspaces`（取当前会话所属工作区路径）。`MenuView` 已由 `ui-input-trigger` 自己注册进 `conversation.input.overlay`，我们的源不需要注册任何 UI 座位。
- 候选取数在 controller 里逐源发起，query 变化即 abort 上一代，失败只打 console 并摘组（`controller.ts:539-566`）；pending 且无旧行时菜单显示骨架（`MenuView.tsx:147-152`）。**没有 debounce**：宿主 ETag 缓存已经让逐键调用变便宜，加 debounce 只会推迟首屏。
- `hint` 字段在 `MenuView` 里根本没被渲染（`MenuView.tsx:186-190` 只有 label/alias/description），不要用。
- 预热：`warm(session)` 在会话作用域诞生时被调一次（`controller.ts:106-115`；后注册的源走 `:442-445`），在那里发一次 `candidates({ query: '' })`，把绑定与 issue 页灌进缓存，第一次敲 `@` 直接出结果而不是骨架。

## 2. 地址与接口（真实示例）

上游 GitHub 侧由 peer 的 `omd-github` 提供：源名 `issue` / `pr` / `github`，`parse.ts` 在源名后的第一个 `/` 处切分，`shorthand: true`。

```
@[#142 flaky e2e](dsh-resource://issue/acme/web/142)        用户消息里的 wire 形态（模型可见）
dsh-resource://issue/acme/web/142?comments=0                模型 read 它拿正文（不带评论尾巴）
dsh-resource://pr/acme/web/87                               isPull 为真时用 pr 源
```

宿主 RPC（本包新增，客户端**不自己拼地址**）：

```ts
remote.issueMention.candidates({ cwd: string, query: string, limit?: number, fresh?: boolean })
// → { kind:'ready', rows: MentionRow[], truncated: boolean, staleMs?: number }
//   | { kind:'unbound', reason:'no-git'|'no-origin'|'unparsable-origin', detail?: string }
// MentionRow = { number, title, state, labels[], author, updatedAt, isPull, address }
```

客户端侧：

```js
inputTriggers.registerSource({ trigger:'@', name:'issue', order:10, showGroupTitle:false, … })
sidebarRight.openResource('dsh-resource://issue/acme/web/142')   // chip 点击 = 侧栏预览
```

绑定来自 `remote.projectConfig.repoBinding(cwd, { fresh })`（peer 契约：`{kind:'bound', slug, host, owner, name, source}` / `{kind:'unbound', reason}`）。`cwd` 取「当前会话所属工作区」的 `path`（`workspaces.list.items[].sessionIds.includes(sessionId)` → `item.path`，与 `plugins/omd-project-config/src/client/index.js:220-234,490-491` 同一取法），取不到再退到 `sessions.list.byId[sessionId].cwd`；两者都没有 → 零行。`fresh: query === ''`：菜单打开时重读绑定，键入过程中吃缓存。

候选细节：`{ repo: slug, state:'all', query, limit: 20 }`；行文案 `name = "#142 flaky e2e"`（不带 `label`，否则 `MenuView` 会把 name 当别名再渲染一遍，`MenuView.tsx:186-189`）、`description = "open · test, ci · li · 3h"`、`section = t('section.issues') | t('section.pulls')`。用 `section` 而不是组标题：组标题的键就是源名，取 `ui-input-trigger` 自己的字典，未注册时原样显示 `issue`，要本地化就得往别人的命名空间注册同名字典（`locale.register(ns,…)` 是否合并取决于实现，不去赌）；`section` 是我们自己的字符串。query 命中 `/^#?(\d+)$/` 时宿主额外 `getIssue` 一次（窗口外/已关闭的老 issue 靠这条进入候选），并按 `isPull` 选 `issue`/`pr` 源。限流：宿主返回 `staleMs` 时该页是配额耗尽后的旧缓存，客户端在 `description` 末尾加 `·cached`；无缓存且请求失败 → RPC 抛错 → 该组零行。`truncated` 只体现在宿主返回值里，v1 不做「还有更多」提示行——菜单没有不可选行的座位，硬塞一个可选行会变成假候选。

## 3. 插入形态、序列化与复原

chip 是 Lexical decorator 节点，只活在编辑器里；模型的形态只由 codec 决定。

| 位置 | 值 | 说明 |
|---|---|---|
| `insert.label` | `#142` | 编辑器与草稿里的紧凑显示 |
| `insert.appearance` | 省略 | 闭集只有 `session/file/folder`（`draft-editor.ts:14-20`），省略时 chip 渲染 `@` 前缀标记（`input/editor/ReferenceChip.tsx:30-31`） |
| `insert.ref` | 整条 wire mention | `codec.serialize` 只收到 `ref`，标题必须可从中恢复 |
| `clipboardText` | 同 `ref` | 草稿快照要求区间文本 == clipboardText（`draft-editor.ts:36-44`） |
| `codec.serialize` / `clipboardText` | 恒等 | 与 `ui-reference` 的会话引用同构（`:171-174`） |
| 侧栏/web 协议 | `dsh-resource://…` | 由 `omd-internal-paths` 桥按源名注册协议（`plugins/omd-internal-paths/src/client/index.js:99-115`） |

标题进 wire 前清洗：去 `[` `]` 与换行、空白折叠、截 72 字符。复原：草稿快照自带 `{source, ref, label, clipboardText, offset, length}`（`Occurrence`，`draft-editor.ts:113-132`；`chip-node.tsx:72-83`），重载后直接重建 chip，**不需要**任何联网或查源。只有当插件被卸载时，`serializeReference` 才报 `no serializer for reference source "issue"` 并拒绝发送（`facade.ts:752`）——宁可拒绝也不发一条丢掉引用的消息。

点击 chip 时 `openReference` 收到的只有整条 `ref`（`reference-activation.ts:26-30`，`appearance` 缺省就不带），用 `/^@\[[^\]\n]*\]\(([^)\s]+)\)$/` 取地址；取不到返回 `false`，编辑器手势原样。

发送后的正文渲染：注册 `UserTextRule<'issue'>`，匹配 wire 形态（抄 `session-reference-rule.ts:20-26` 的做法），`slots.register('conversation.user.text.node', { key:'issue', … })` 渲染 `<ReferenceChip appearance="command" …>`（`ui-primitives/user-text.tsx:23-43`：闭集里只有 `command` 是「无图标、等宽」的中性样式）。点击 → `openResource(address)`。

## 4. 为什么选中不附正文

`session-reference` 之所以在 `agent/pre-step` 插一条 `## Referenced sessions` 快照（`session-reference/README.md:32,34-36`），是因为会话快照没有别的可寻址读取方式；issue 有：地址就是 `read` 的入参。附带成本是每次提及都多一份 300–900 token 的正文（含评论可到数千），并且要再实现一份 budget + spill 机制。结论：**只插入指针**；模型需要正文时自己 `read …?comments=0`，一次工具调用。若日后实测模型不肯主动读，再单独切一片「默认关闭的 `inlineBody`」，不塞进本次。

## 5. 实施切片与验收

1. `plugins/omd-issue-mention/package.json`：`exports { ".": "./src/index.ts", "./client": "./src/client/index.js" }`，`dsh.client: { platform: 'web' }`。缺 `./client` 会启动即 `MissingClientBundleError`。
2. `src/index.ts` + `src/service.ts` + `src/remote.ts`（两个 helper 从 `omd-internal-paths/src/remote.ts` 复制，本仓每个包各自持一份是既有做法）：`inject: ['github', 'projectConfig']`（缺任一就不激活，不做内存退化）；`bindRemote(this, 'issueMention')`，`markRemoteMethods(…, ['candidates'])`。
3. `src/client/index.js`：mount `issueMention` descriptor（照 `omd-project-config/src/client/index.js:162-198`）；`ctx.effect` 注册源；注册 locale、user-text 规则、`conversation.user.text.node` 渲染器。
4. 包 README + 各导出 JSDoc 契约（AGENTS.md 硬性要求）。

前置依赖（不属本切片）：`omd-github` 的 `ctx.github` 与 `issue` 源、`omd-project-config` 的 `repoBinding` 字段与方法、`omd-internal-paths` 的源桥，以及 `omd-read` 从 `ctx.readSchemes` 迁到 `ctx.internalPaths`（`docs/omd-internal-paths.md` §5 那一片，连同 profile 里的挂载行）。缺任一，本包的宿主半边不激活，`@` 里就没有 issue 组。

验收（临时 profile，绝不改 `~/.dsh/profiles/omd`，AGENTS.md:295）：

```sh
cp -R ~/.dsh/profiles/omd ~/.dsh/profiles/omd-slice-verify
dsh plugin --profile omd-slice-verify add ./plugins/omd-issue-mention
dsh --profile omd-slice-verify --dump-config > /dev/null   # 退出码 0
dsh --profile omd-slice-verify                             # 无 "did not activate"
```

界面验收（真浏览器）：`@fla` 出 issue 组并可键盘选中；`@"flaky e2e` 多词过滤可用（`@` token 不吃空格，必须引号）；`@#99999` 走单号直查；选中后 chip 显示 `#142` 且带尾随空格；发送后正文是 wire mention、记录里是 chip；刷新页面未发送的草稿 chip 仍在；点 chip 打开侧栏预览；模型 `read dsh-resource://issue/acme/web/142` 成功。无绑定的仓库：`@` 菜单只剩文件/会话两组。验完删掉临时 profile 目录。

## 6. 风险（3 条）

1. **地址语法是三方共用的单点**：wire mention、侧栏协议、模型 `read` 必须是同一串。缓解：地址只由宿主 `candidates` 产出，客户端逐字使用；`omd-github` 若改语法，这里跟着改一处。
2. **协议注册有延迟**：侧栏预览依赖 `omd-internal-paths` 桥在启动/15s 轮询后注册 `issue` 协议；协议未就绪时点 chip 不弹预览（chip 与发送都不受影响）。
3. **chip 里的标题是快照**：issue 改名或换仓库后，草稿与历史正文仍显示旧标题，address 仍可解析——与 session mention 现有行为一致，不做回填。

## 7. 否掉的方案

- 新增 `#` 触发字符：`TriggerChar` 闭集要改上游，且 `#` 在 markdown 里含义重叠。
- `appearance: 'issue'`：`ReferenceInsert['appearance']` 与 `ReferenceIconKind` 都是闭集，改上游违反「不动上游」；代价只是 composer chip 少一个专属图标。
- 逐键调 GitHub 搜索 API：30 次/分，输入一个词就打光。
- 复用 `session-reference` 的 pre-step 快照机制来「预热」正文：见 §4。
