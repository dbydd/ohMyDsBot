# Web UI 能不能承载 LSP 编辑

## 结论

三档都能做，但底盘都在“新增一个视图”，不在“给现有代码预览加东西”。上游没有可编辑代码组件；能逐行挂标记的通道存在（`useCodeHighlighter`），可 `CodeBlock` 定稿路径走 `dangerouslySetInnerHTML`，行号是 CSS 计数器，没有行级 DOM 钩子。推荐只做第一档（只读带诊断），落在 `documentPreviews` 的查看器下拉位；第三档要自建编辑器 + 持久文档会话 + 写盘通道，是另一个数量级。

## 1. 可复用的视图组件

### `CodeBlock`（`refs/deepseek-harness/packages/client/ui-primitives/src/markdown/CodeBlock.tsx`）

- props `13-43`：输入只有 `code: string`、`lang`、`streaming`、`lineNumbers`、`wrap`、`contentRef`。没有 onChange、光标、选区、dirty —— 组件是纯渲染，只读。
- 渲染 `175-185`：非 streaming 把 shiki 生成的 HTML 直接 `dangerouslySetInnerHTML`；streaming 与 plain 分支才逐行产出 `<span class="line">` React 节点。
- 行号 `CodeBlock.module.css:122-145`：`counter-increment: source-line` 画在 `.line::before` 上。HTML 串里没有可挂载的 React 节点，行级诊断标记只能靠 `:nth-child` 选 CSS，脆。
- 高亮 `markdown/highlight.ts:1-42`：shiki core + JS regex 引擎（无 oniguruma WASM），boot 只带 ts/shell/json，其余 53+ 语言懒加载，颜色走 CSS 变量主题。
- 能力边界：只读、有高亮、无编辑面、无行级装饰面。

### documentpreview 的 code / text 渲染器

- `src/client/code/CodeBody.tsx:14-34`：`CodeBlock` + `lineNumbers` + `streaming={!content.eof}`，只读。
- `src/client/code/index.ts:15-25`：注册 `extensions: CODE_HIGHLIGHT_EXTENSIONS`、`priority: 'builtin'`、`loading: 'text-pages'`、`wrap: true`，body 挂 keyed slot `sidebar.right.tab.document`。
- `src/client/text/TextBody.tsx:9-34`：兜底纯文本，每行带 `data-textpreview-line`；**只有这里**消费 `tab.navigation.params.line` 做目标行高亮（`11-12`、`21-26`）。code 渲染器没有这段，所以“跳到第 N 行”在代码视图里今天不生效。
- 内容模型 `src/client/document/contract.ts:17-30`：`{kind:'text',text,pages,eof}` / `bytes` / `renderer`（body 自管加载）。`33-46`：`resourceAddress`、`addResource`、`setResources`、`wrap`、`scrollportRef`；`102-107` 转发 `useTabInfo`。
- 读取 `src/client/rpc.ts:25-31, 80-82`：一页 `remote.workspaceFiles.read(sessionId, path, {offset}, signal)`，请求-响应，页长由 Host 的 `maxLines` 定。
- 多渲染器并存 `src/client/document/registry.ts:36-49`：`extension` 档 > `builtin` 档 > 更长后缀 > 注册顺序；`README.md:32` 说多个候选时标题栏出现查看器下拉。
- 能力边界：只读、分页、渲染器可替换；没有编辑面。

### deliverables 的 diff

- `README.md:49`：按 hunk 列双侧行号，两侧各自 shiki 高亮，unified/并排、wrap、5000 行上限。只读。
- `src/client/FileDiff.tsx:35-58`：把每行文本喂给 `useCodeHighlighter`，得到 `Map<行号, HighlightSpan[]>`，`DiffText` 逐行渲染 —— 全仓唯一“行是 React 节点且有行号”的实现。
- `src/client/FileDiff.tsx:13-14, 66-109`：5000 行上限、hunk→行、并排配对。
- 能力边界：只读；但它的行级渲染写法就是诊断视图该抄的样板。

### 地址与入口（3 个真实例子）

- `dsh-resource://file/session/<sessionId>/<path>` — `refs/deepseek-harness/packages/util/workspace-path/src/file-address.ts:14-16`；documentpreview 以 `fallback` 档认领（`src/client/definition.ts:45-54`）。
- `dsh-resource://changes-review/session/<sessionId>/<seq>/<turn>` — `refs/deepseek-harness/packages/client/ui-deliverables/README.md:67`。
- 面板按钮不需要地址：`sidebar.footer.action`，omd 已在用（`plugins/omd-project-config/src/client/index.js:520`）。

诊断视图不必新造地址：它作为同一批后缀的另一个 document renderer 出现，用户从查看器下拉切换。

## 2. 只读带诊断：能，四步

需要的 slot / 服务：

- `ctx.get('documentPreviews').register({ id, extensions, priority, title, loading: 'text-pages', wrap: true })`；registry 由 `src/client/index.ts:90-91` 用 `ctx.reflect.provide` 暴露。
- `ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({ name: 'sidebar.right.tab.document', key: id }, Body))`，写法照 `src/client/index.ts:103-117`。
- 可选按钮位：`sidebar.right.tab.document.actions`（`contract.ts` 同处声明，`index.ts:108`）。
- Remote：host 新 namespace，omd 已有现成写法 `plugins/omd-project-config/src/remote.ts:29-51` + 客户端 `$mount`/`remote.call`（`plugins/omd-project-config/src/client/index.js:144-198`）。

数据侧今天在哪：

- 核心 `ctx.lsp` 只有 4 个只读导航操作，明确 “no protocol escape hatch”（`refs/deepseek-harness/packages/lsp/lsp/src/types.ts:110-111`）。安装版 `dsh` 0.2.1-rc.2 的 `node_modules/@deepseek-ai` 里没有 `dsh-lsp*`；只有 refs 检出（tag `dsh-v0.2.1-rc.2`）有 `packages/lsp/`。
- 实际可用的是社区 `dsh-tool-lsp`：`lib/runner.js:335-357` 持久 didOpen/didChange，`380-406` `settlePublished`/didClose，`424-431` 通用 `request`，`269-277` 抓 `publishDiagnostics`；`lib/translate.js:262` 的 `normalizeDiagnostics(payload, decode)` 直接给结构化结果。
- 反例说明为什么要在 host 侧拿结构化数据：`plugins/omd-lsp-writethrough/src/index.ts:21-24, 201-216` 现在靠调 `lsp_diagnostics` 工具再解析渲染后的文本。

四步，全部在 omd 内，不改 dsh：

1. host 半新包 `omd-lsp-view`，照 `plugins/omd-lsp-nav/src/index.ts:10-40` 的 internal-import 方式拿 `LspSession`（继承同一份升级即断风险）。
2. 新 Remote 方法 `diagnostics(cwd, path)`：`openDocument` → `session.request('textDocument/diagnostic')` + `settlePublished` 合并 → `normalizeDiagnostics` → 返回 `{ line, character, endLine, endCharacter, severity, message, code, source }[]`。
3. client 半（手写 `window.__ModuleLoader__.load`，见 `plugins/omd-read/src/client/index.js:1-16`）：注册 renderer；`priority: 'extension'` 抢默认视图，`'builtin'` 只做下拉备选（`registry.ts:43` 按 rank 比较）。body 用 `require('@deepseek-ai/dsh-client-ui-primitives')` 的 `useCodeHighlighter` 逐行渲染，右侧标记列，hover 出消息。
4. 失效与刷新：以页面的 `version`/`eof` 为键请求一次；用 `workspaceFiles.changes` 流（`refs/deepseek-harness/packages/api/workspace-files/src/index.ts:340-343`）收到变更后重取。

代价：约 250–400 行、0 依赖、0 上游改动。这档是唯一“便宜且立刻有用”的。

## 3. 完整 LSP 编辑器的前置

- 编辑器基座：没有。全仓无 codemirror/monaco（装好的前端 bundle 里也搜不到）；`ui-primitives` 只有 `Input` 与最多六行自增高度的 `InlineEditor`（`InlineEditor.tsx:20-27`）。平台种子只有 react/zod/tanstack-virtual/client-store 等（`packages/client/web/src/platform.ts:8-21`），所以 CodeMirror 只能随插件私有打包 —— 而 omd 的 client 半边现在是手写、被 dsh 原样服务的 JS，没有打包步骤。
- 能不能接 LSP：host 侧已具备（持久文档 + 通用 `request` + 取消分类 + `PositionCodec`，`lib/translate.js:52`）。补全只差 `textDocument/completion` 一个调用与 `completionProvider` 检查（不在 `lib/tools.js:74-80` 的五个工具里）。
- remote 是请求-响应还是有流：两种都有。一元走 HTTP POST JSON；流走 `/api/remote.mux` WebSocket，且流自带 client→host uplink（`packages/api/gateway/README.md:12, 39, 43`）。产品里唯一双向先例是终端 `attach(...): RemoteStream<TerminalFrame, TerminalInput>`（`packages/api/terminal-controller/src/index.ts:216`）。客户端 `$mount` 支持流描述符（`dsh-api-gateway/lib/client.browser.js:1669-1690, 1842-1850`），但 omd 没用过流式 namespace。
- 还缺：每 tab 一份文档会话的生死（open/change/close 跟编辑器走；今天 session 按 server 常驻、按文件 didOpen）、按键级 debounce + cancel、补全/签名/hover 的 UI、rename 落盘（`lib/tools.js:267-340` 已会写多文件，但那是 agent 工具授权面）。
- 写通道本身也不存在：`workspaceFiles` 明确 “exposes no mutations”（`packages/api/workspace-files/src/index.ts:11`，README:12），浏览器侧没有第二个写入口。

## 4. 三档代价与推荐落点

| 档 | 新增 | 代价 | 备注 |
|---|---|---|---|
| 只读带诊断 | host 1 包 + client 1 renderer | ~300 行，0 依赖，不改 dsh | 落点 `documentPreviews` + `sidebar.right.tab.document`；推荐 |
| 可编辑无补全 | 新 Remote（版本冲突 + 原子写）、tab 改 `loading:'renderer'` 自管全量内容、编辑控件、dirty/close 生命周期（`ui-sidebar-right/README.md:108`） | 约 3–5× 第一档 | 分页读取不适合编辑；控件最终会被第三档推翻。不推荐做中间档 |
| 完整 LSP | CodeMirror 私有打包 + 构建步骤、双向流会话、补全/跳转/重命名 UI、写盘授权与冲突 | 2–4k 行 client + 数百行 host | 绑死在未发布的内部 client 库上 |

推荐落点：先做第一档。它复用 omd 已有的 Remote 与 client 两套脚手架，用户拿到的是“代码 + 行级诊断标记 + 悬停消息”。第二档跳过；真要编辑器就按第三档立独立 feature，写通道单独切片。

## 风险

1. host 侧全靠 `dsh-tool-lsp/lib/*` 内部模块（`omd-lsp-nav` 已同此风险），社区包升级即断；安装版里 `ctx.lsp` 并不存在，没有稳定官方接缝可退。
2. UI 写盘会成为 agent 工具链之外的第二条变更路径：`omd-lsp-writethrough` 只挂 `tools/post-execute`，UI 保存既不触发诊断回写，也不进 `workspace/changes` 的 turn 记录。第三档必须先定这条归属。
