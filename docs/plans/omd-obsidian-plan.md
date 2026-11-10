# omd 原生 Obsidian：能力移植计划

目标：把 tern-obsidian 的**解析、索引、查询**搬进宿主插件，把**渲染**落在我们自己的右侧栏 tab 类型上；模型侧与界面侧共用同一个地址 `dsh-resource://vault/<vaultId>/<rel>`（模型可写简写 `vault://<vaultId>/<rel>`）。

调研范围（全部只读）：参考实现本机 `tern-obsidian/tern-obsidian/` 检出；目标侧 `plugins/`、`docs/omd-*.md`、`profiles/omd/cordis.patch.yml`、`refs/deepseek-harness/packages/client|fs/`。
标记：`[观察]` = 代码或文档里读到的事实；`[推断]` = 我的判断、或需要实测的数字。

## 0. 三个前置事实，会改变结论

1. `[观察]` 模型侧今天还读不了内部路径：`plugins/host/omd-read/src/index.ts:289-296` 仍然 `ctx.provide('readSchemes', …)`，`plugins/host/omd-internal-paths` 是仓库里唯一提到 `internalPaths` 的包，且没有任何源注册。`docs/omd-internal-paths.md:51-56` 写明了迁移步骤。不先做这一步，`vault://` 只存在于界面侧。
2. `[观察]` 客户端桥接只吐一帧：`plugins/host/omd-internal-paths/src/client/index.js:99-116` 的 `open` yield 一次就返回，而 `live` 源“界面侧跟随变化”的承诺写在 `src/service.ts:34-35` 与 `docs/omd-internal-paths.md:47`，尚未实现。所以笔记的内容刷新不能指望资源流，必须自带轮询或手动刷新。
3. `[观察]` `profiles/omd/cordis.patch.yml` 里没有 `omd-internal-paths` 行，最后一个 insert 块到 `omd-chat-shell` 为止。挂载本身是 P0 的一部分。

## 1. 能力清单

| # | 能力 | 参考实现落点 | 做法 | 性质 |
|---|---|---|---|---|
| 1 | wikilink 解析 | `helper.mjs:269-296` | 依次试：路径全匹配、相对当前笔记、路径后缀、文件名、别名；规范化用 NFC 加小写（`:250-267`）；多命中即歧义，不猜 | 查询 |
| 2 | 嵌入 `![[…]]` | `helper.mjs:305-365` | 递归读目标、按 `#标题`/`#^块` 裁剪正文后拼回；`stack` 防循环嵌入 | 渲染（宿主侧文本变换） |
| 3 | frontmatter | `helper.mjs:78-86` | 手工切 `---` 块，YAML 交给 `Bun.YAML`；值里的 wikilink 也算出链（`:201-206`） | 索引 + 渲染 |
| 4 | 标签 | `helper.mjs:88-117` | 扫正文，跳过代码、转义、wikilink 内部、纯数字；与 frontmatter `tags` 合并；支持中文与嵌套 | 索引 |
| 5 | 反向链接 | `helper.mjs:538-539` | 用索引里每篇的 `links` 反查解析结果 | 查询 |
| 6 | 标题与块锚点 | `helper.mjs:446-466`、`583-591` | 在 mdast 里定位标题树和 `^block` 段落，**换算成行号**再交给界面 | 索引 + 查询 |
| 7 | 排除规则 | `helper.mjs:15`、`17-67`、`136-156` | 硬编码跳过点开头条目与 9 个目录名；`userIgnoreFilters` 支持 `/正则/`、路径、前缀、文件名、路径段；被排除文件仍可被链接（`excluded` 标记） | 索引 |
| 8 | Bases | `bases.mjs:1-21`（全 760 行） | 自写词法 + 递归下降解析 + 求值器，零第三方依赖；表格视图，行数上限 200（`:22`）；不支持的写法显式报错 | 查询 + 渲染 |
| 9 | JSON Canvas | `helper.mjs:599-621`、`canvas.luau` | 读 `nodes`/`edges` 输出卡片与连接文字；`canvas.luau` 是 Tern 白板双向转换 | 渲染 |
| 10 | 搜索 | `window.luau:42-72` | 只搜文件名、别名、标签，没有全文检索 | 查询 |
| 11 | 索引与缓存 | `helper.mjs:171-248` | 指纹 `size:mtime:ctime`（`:185`）；并发 16（`:181`）；JSON 缓存按 root 的 sha256 前 16 位命名（`:173`）；缓存命中不重读 | 索引 |
| 12 | 图片字节 | `helper.mjs:334-336`、`host.luau:26-102` | 正文里的图片先替换成标记，宿主读真实字节、按 MIME 交给界面 | 渲染 |
| 13 | 打开入口 | `window.luau:74-81`、`123-145` | 覆盖文件打开器，注册 `obsidian://` 路由（笔记、标签、锚点三种地址） | 宿主 UI |

参考实现**没做**的三件，决定我们的取舍：

- `.gitignore` 完全不读——`helper.mjs` 全文没有 gitignore，只管点开头目录与 `userIgnoreFilters`。我们要补（见第 5 节），这是需求里点名的。
- `attachmentFolderPath` 读了但没用（`helper.mjs:55`）。我们不需要：读路径不依赖附件目录约定。
- 全文检索没有。界面侧留到 P5，模型侧不做（见待定问题 3）。
- `export.luau:1-322` 与 `canvas.luau` 的白板互转、`window.luau:179-269` 的“另存为笔记/导入画布”都是 Tern 专有形态，不移植。

## 2. 两侧分工

| 工作 | 落点 | 理由 |
|---|---|---|
| vault 根发现、id 分配、配置解析 | 宿主 | 需要文件系统与配置 |
| 排除规则合并（点目录、`.obsidian/app.json`、`.gitignore`） | 宿主 | 一处判定，读取与索引都过同一个函数 |
| 遍历、`stat`、指纹、增量索引 | 宿主 | 只读磁盘；并发与节流都由宿主定 |
| markdown 解析、wikilink/嵌入/别名解析、callout 归一、frontmatter | 宿主 | 客户端没有解析库，也不该有 |
| Bases 求值、Canvas JSON 解析 | 宿主 | 纯数据计算，与界面无关 |
| 标签页、搜索结果、反向链接清单的**数据** | 宿主 | 界面只做画法 |
| 附件字节 | 宿主读、客户端做 blob URL | 客户端不碰 `node:` |
| 右侧栏 tab 类型与 body、指南入口 | 客户端 | slot 只在页面里 |
| `MarkdownText` 渲染、属性表、tag 胶囊、大纲、反向链接列表 | 客户端 | 用 platform seed，零打包 |
| 链接点击 → `tab.actions.openResource` | 客户端 | 导航是界面的动作 |
| Canvas 卡片列表（P3）、图形视图（P5） | 客户端 | 版面 |
| 刷新按钮、可见时轮询版本 | 客户端 | 界面节奏 |

硬约束的落法：客户端是手写 `.js`（`AGENTS.md:82`），不 import `node:`（同 `:84`），不拥有状态、不写会话日志（`:83`）；所有取数经 remote。

## 3. 地址语法

```
规范形式  dsh-resource://vault/<vaultId>/<rel>
简写      vault://<vaultId>/<rel>            （源声明 shorthand: true，仅模型侧接受）
<rel>     vault 内相对路径，/ 分隔，不带前导 /，可含一次百分号编码
保留段    <rel> 的第一段为 .omd 时属于我们，不是磁盘路径
```

`<vaultId>` 由本源自己的语法校验：`[A-Za-z0-9-]`，比较时统一转小写（内部路径的源名规则只管源名 `vault` 本身）。地址里**不带** `#锚点`：锚点是导航参数 `params: { anchor, line }`，因为 tab 以 (kind, 整个地址) 作去重标识（`ui-sidebar-right/README.md:93`、`ui-sidebar-documentpreview/README.md:31`），带 fragment 会把同一条笔记拆成两个 tab。

库根怎么定——两个都要，优先级明确：

1. 插件 `Config.vaults`：`[{ id, root }]` 或 `["notes=~/Notes"]`，显式、可移植，发布给别人时唯一可靠的来源。
2. `Config.discover.cwd`（默认 `true`）：读地址时若 id 未命中，从调用方 cwd 向上找 `.obsidian/`（与参考实现的 `findVault`、`bridge.find` 同规则），懒注册，id 取根目录 basename。
3. `Config.discover.appData`（默认 `false`）：读 Obsidian 自己的 `obsidian.json`（参考实现 `helper.mjs:551-559`）。默认关，理由是 `AGENTS.md:89-96` 的机器无关原则。
4. 冲突：显式配置赢；两个自动发现同 basename 时后者加 `-2`；`.omd/vaults` 页列出每个 id 的真实根路径供模型消歧。

示例（假设 `~/Notes` 注册为 `notes`）：

1. `vault://notes/Daily/2026-10-22.md` —— 笔记，模型读原文
2. `dsh-resource://vault/notes/Daily/2026-10-22.md` —— 同一条，规范形式，tab 里记的就是它
3. `vault://notes/attachments/Pasted%20image%2020261012.png` —— 附件，界面出图；模型读会得到“二进制，请按绝对路径读”的错误并附上绝对路径
4. `vault://notes/Projects/Board.canvas` —— 画布
5. `vault://notes/Databases/Books.base` —— Bases
6. `vault://notes/.omd/vaults` —— 保留页：已注册的库清单
7. `vault://notes/.omd/tag/reading/deep` —— 保留页：标签页（嵌套标签用 `/`，不做二次编码）
8. `vault://notes/.omd/search/obsidian` —— 保留页：搜索结果（P4）

读取宽容一条：`<rel>` 不带扩展名且 `rel + '.md'` 存在时按后者读（Obsidian 习惯），但**规范地址永远带 `.md`**，且地址字符串只由宿主生成（`view`/`resolve`/`search` 的返回值里给 `address` 字段），客户端不自己拼——这是 tab 去重的唯一保证。

## 4. 渲染落点：注册自己的 tab 类型

结论：走 (a)，为 vault 注册一个资源 tab 类型，body 自己渲染整篇文档。不碰上游 `MarkdownText` 的扩展点。

(b) 为什么不可行，两条事实各自都够封死：

- `render.tsx:53-68` 的 `sanitizeUrl` 只放行 `http:`/`https:`/`mailto:`，其余一律返回空串；`renderSafeLink`（`:542-546`）拿到空串就只渲染文字。`dsh-resource:` 与相对路径都进不去（`docs/omd-ui-backlog.md:40` 记的是同一件事）。
- 围栏没有座位：`renderNode` 的 `switch`（`:274-372`）里代码块只有 `case 'code' → renderCode`（`:336-337`），加扩展点必须改上游，而 dsh 不收 PR 与 issue（`docs/omd-ui-backlog.md:50`）。

中间路线也不成立：给 `ui-sidebar-documentpreview` 加一个 `.md` 渲染器，走的是它自己的 `text` 类型，而那个类型的 `canOpen` **只认 Session 地址**（`ui-sidebar-documentpreview/README.md:31`），vault 地址进不去，且它占 `fallback` 档，我们在外面没有喂地址的入口。

(a) 为什么成立，以及它仍然复用什么：

- 两段式注册是公开契约：`ctx.sidebarRightTabs.register({ id, kind, patterns, priority, canOpen, title, guide })` + keyed 座位 `sidebar.right.pane.tab`（`ui-sidebar-right/README.md:81-88`、`tab-registry.ts:94-139`），documentpreview 自己就是个活例子。pattern 写 `dsh-resource://vault/**`（带 `:` 的 pattern 匹配整个地址，`tab-registry.ts:196-221`），档位默认 `extension`。
- 正文仍然用 `MarkdownText`：`@deepseek-ai/dsh-client-ui-primitives` 是 platform seed（`client/web/src/platform.ts:8-15`），并导出了 `MarkdownText`、`MarkdownDelegateProvider`（`ui-primitives/src/index.ts:107-110`）。`require` 即得，零打包。
- wikilink 由宿主转成 `[别名](相对路径.md#L12)`：`renderAnchor` 先过 `parseFileLink`（`render.tsx:572-579`、`markdown/file-link.ts:10-31`），命中本地路径就走 `MarkdownFileLink`，点击交给 `MarkdownDelegateProvider.openFile`，我们把它接到 `tab.actions.openResource(address, { params: { line } })`。锚点已在宿主换算成行号，所以标题跳转与 documentpreview 的 `{ line }` 语义一致。
- 图片走 `pathImages.resolve`（`render.tsx:103-108`，`vocabularyImageUrl` 允许 `blob:`；`:81-92`）：客户端拿到 `vault.readBytes` 的字节后建 blob URL。第一版没有灯箱——灯箱要 `fileImages` 及其 4 条 label（`MarkdownDelegate.tsx:15-18`），P4 再接。

降级，与参考实现一致（`helper.mjs:390-444`）：callout 归一成 `> **Note**` 加引文（上游 blockquote 没有 callout 概念，`render.tsx:281-289`）；`%%注释%%` 删；`==高亮==` 变粗体；`#tag` 变成本文档内的链接，指向 `.omd/tag/<tag>`。

被拒绝的第三种做法：把整篇笔记转成 HTML 塞进 iframe（documentpreview 对 HTML 就是这样，还配了两个沙箱模式）。它省掉渲染器，却让我们重新实现一套主题、选中、搜索、链接导航，并且拿不到 tab 级别的 `useTabInfo`/`useResource`。不做。

## 5. 排除规则

三份输入、两档结果：

| 来源 | 匹配方式 | 档位 |
|---|---|---|
| 任何路径段以 `.` 开头（覆盖 `.obsidian`、`.trash`、`.git`），以及 `node_modules`、`.smart-env` 等参考实现在 `helper.mjs:15` 列的名字 | 段名精确 | ignored |
| `.obsidian/app.json` 的 `userIgnoreFilters` | `/…/` 走正则；否则依次比路径全等、`clean/` 前缀、basename、路径段包含（`helper.mjs:26-52`） | excluded |
| 库根的 `.gitignore`（P1）与嵌套 `.gitignore`（P4） | 标准 gitignore 语义：锚定、`**`、目录-only、`!` 反选 | ignored |

- **ignored**：读失败、不进索引、不进搜索、不进 Bases。这是需求里“排除规则命中的文件读不到”对应的那一档。
- **excluded**：不解析元数据、不进搜索与 Bases，但按精确地址仍可读、仍能被链接解析到（参考实现 `helper.mjs:143-148`、`230-239` 就是这么分的，并且写成了注释：被排除文件保持可链接）。这档是 Obsidian 自己有语义——`userIgnoreFilters` 只藏不删。
- 优先级：ignored 先判、先赢。判定函数只有一个 `decide(rel, kind)`，遍历、读取、链接解析、Bases 求值全部调它，不在别处重复写规则。
- 失效：`.obsidian/app.json` 与每个 `.gitignore` 用 `ctx.fs.watch`（`fs/fs/README.md:38`，支持单文件与目录直接子项）盯着，任一变就丢掉内存索引与磁盘缓存，下次读重建。规则文件的指纹（内容 sha256 前 16 位）与索引一起缓存，进程重启时不一致就整库重扫。

## 6. 索引与搜索

存什么，每条笔记一条记录：

```text
rel, ext, name, size, mtime, ctime, fingerprint
props（frontmatter 解析结果）, aliases[], tags[], links[], embeds[], headings[{title,level,line}], blocks{id→line}, lineCount
excluded: true|false, error?: string
```

放哪：内存为主，磁盘只做冷启动缓存，写到 `dshCachePath('omd-vault', '<id>-<sha256(root)[:16]>.json')`（`@deepseek-ai/dsh-home-paths` 已在链接层里，`plugins/link-host-runtime.mjs:30-44`，`dshCachePath` 见其 README:41）。不用 `ctx.storageDomain`：它的写入是逐条持久且校验的，3 000 条冷建就是 3 000 次耐久写；把整库塞进一条记录又会变成每次变更重写数 MB。索引是可从库重新算出来的派生物，不该按“权威状态”对待（`omd-memory/src/storage.ts:1-40` 那种域适合水位线，不适合这里）。

增量：每次 `ensureIndex` 走一遍遍历加 `stat`，只对指纹变了的文件重读重解析；消失的 `rel` 直接删。节流：5 秒内不重复遍历，除非显式 `refresh: true`。

预算（`[推断]`，P2 验收时实测）：

- 3 000 篇、平均 3 KB：遍历加 `stat`、并发 16，预计 0.2～0.5 秒；冷解析 remark 约 1～3 毫秒/篇，即 3～9 秒 CPU；每 32 篇 `await` 一次让出事件循环，避免卡住正在跑的回合。
- 缓存命中时 `reread = 0`，只为 `stat` 付钱，预期 0.4 秒内。
- 缓存文件 0.6～1.2 KB/篇，3 000 篇约 2～4 MB。
- 单文件上限：索引只解析 ≤ 1 MiB 的 `.md`，且笔记数超过 50 000 时打一条告警继续（不设硬截断）。附件读字节上限 8 MiB/张。

remote 方法（客户端用 `descriptor()` 声明，照 `plugins/workbench/omd-project-config/src/client/index.js:144-198` 的成熟写法；模型侧的原文读取**不**在这里，走 `internalPaths.read`）：

```text
vaults()                                   → { id, root, notes, excluded, indexedAt, indexing }[]
index(vaultId?, { refresh? })              → { id, notes, reread, tookMs, warnings }
resolve(target, from?)                     → { address, rel, anchor, line } | { error, candidates[] }
view(address, { anchor? })                 → { address, kind: 'note'|'base'|'canvas'|'page', title, version,
                                             properties, tags[], outline[], links[], backlinks[],
                                             markdown, images: { rel, mime }[], warnings[] }
readBytes(address, maxBytes)               → Uint8Array
version(address)                           → string（指纹，供可见时轮询）
search(query, { vaultId?, tags?, limit? }) → { tookMs, total, hits: { address, rel, title, tags[], why }[] }
backlinks(address)                         → { address, rel, title }[]
```

`view.kind` 决定 body 走哪条渲染分支，tab 类型只有一个。`markdown` 是已转换的正文（wikilink→链接、嵌入已拼入、callout 已归一、`base` 围栏已展开成表格）。

## 7. 依赖

宿主侧新增依赖（都只跑在 Node 里，不进浏览器）：

| 包 | 用途 | 体积 |
|---|---|---|
| `remark-parse`、`remark-gfm` | CommonMark + GFM 的 mdast | unified 生态约 20 个传递包，磁盘 1～2 MB `[推断]` |
| `unist-util-visit`、`mdast-util-to-string` | 遍历与取纯文本 | 各几十 KB |
| `yaml` | frontmatter 解析（参考实现用 `Bun.YAML`，Node 没有对应物） | 约 400 KB |
| `ignore` | `.gitignore` 语义，别手写反选与锚定 | 约 40 KB |

不引入 `remark-wiki-link`：参考实现虽然装了它，真正干活的是它自己扫 `wikiLink`/`text` 节点再正则匹配的循环（`helper.mjs:96-114`），那个包只影响 AST 里的节点类型，去掉不影响结果。`remark-gfm` 保留，表格与删除线要用。

装在哪：写进 `plugins/omd-vault/package.json` 的 `dependencies`，实体装到 `plugins/node_modules`。不能指望 profile 的 `pnpm`：`plugins/link-host-runtime.mjs:5-19` 记录了这个坑——插件按自己的真实路径解析裸导入，profile 的 `node_modules` 根本不在链上。做法是给 `plugins/` 加一个私有 `package.json` 并在那里装一次（或 `npm install --prefix plugins remark-parse …`），装完跑一次 `node plugins/link-host-runtime.mjs` 补链接。

客户端侧：**零依赖**。只 `require('react')` 与 `require('@deepseek-ai/dsh-client-ui-primitives')`，两者都是 platform seed。所以没有“预构建自包含 `.js`”这一步——需要预构建的唯一理由是在浏览器里跑 remark，而我们把转换放在宿主，正好绕开。

真到需要浏览器端 mdast 扩展的那天（例如 mermaid），配方是：`esbuild src/client/vendor-src.js --bundle --format=iife --outfile=src/client/vendor.js` 一次产出并提交，把产物内联进 `src/client/index.js` 顶部（同一个文件里先挂一个 IIFE 到局部变量，再在 factory 里用），不要指望 `require('./vendor.js')`——模块表的解析顺序是 seed、已物化记录、启动图行、已注册 factory（`client/modules/src/client/system.ts:327-336`），相对路径不在其中。

## 8. 分阶段

| 阶段 | 内容 | 独立验收 |
|---|---|---|
| P0 | 把 `omd-read` 迁到 `ctx.internalPaths`（删 `readSchemes`，`skill` 源改注册进去），profile 挂 `omd-internal-paths` + `omd-vault` | 模型 `read` 一个 `skill://` 与一个 `dsh-resource://skill/…` 内容一致；`--dump-config` 有这两行；启动无 “did not activate” |
| P1 | `omd-vault` 骨架：Config、根发现、排除规则（点目录 + `userIgnoreFilters` + 根 `.gitignore`）、`vault` 源（原文、`.md` 补全、保留段 `.omd/vaults`）、`view` 只做原样 markdown、客户端 tab 类型 + body + 手动刷新 | 模型读到原文；界面同一地址打开同一条笔记；ignored 文件读失败、excluded 文件按地址仍可读；改一行文件后点刷新看到新内容 |
| P2 | 索引（遍历、指纹、内存 + 缓存）、wikilink/嵌入/别名/锚点、frontmatter 属性表、标签与标签页、大纲、反向链接、callout 归一、指南入口与 picker 页 | 重名链接给出歧义提示；`[[A]]` 点击跳到 A；标签页列出全部命中；3 000 篇库冷索引耗时达标 |
| P3 | Bases（移植 `bases.mjs`，产出 markdown 表格）、Canvas 卡片列表与连接 | `.base` 的筛选、排序、分组、limit 与截图对得上；行数超 200 显示总数；坏表达式在视图里报错而不是空表 |
| P4 | 搜索 API 与搜索界面、图片 blob、`version` 轮询（可见时 2 秒）、嵌套 `.gitignore` | 搜名字/别名/标签命中；ignored 文件搜不到；两台机器同库同结果 |
| P5 | 全文搜索、Canvas 图形视图、图片灯箱（补 `fileImages` 的 4 条 label） | 各自单独验收 |

P1 到 P3 之间不依赖重建：每阶段关掉行就回滚干净（`ctx.effect` 逐项登记）。

## 9. 验收

1. 组合面：`dsh --profile omd --dump-config` 输出里有 `omd-internal-paths` 与 `omd-vault` 两行；stderr 为空；退出码 0。
2. 模型侧原文：`dsh headless --patch /tmp/omd-vault-row.yml "read vault://notes/Daily/2026-10-22.md and quote its first heading"`，期望模型引用的标题与磁盘上的文件逐字一致，且工具入参里出现的是 `vault://` 而不是绝对路径。
3. 界面侧同址：`dsh --profile omd` 起网页，右侧栏指南里的 Vault 入口挑一篇，期望 tab 标题是文件名、正文是文档排版、属性与标签各成一段；再确认 tab 记录里存的是 `dsh-resource://vault/notes/…`。
4. 排除规则：库根 `.gitignore` 写入 `raw/`，`vault://notes/raw/secret.md` 读取失败并说明命中的规则名；同一路径用绝对路径读仍然成功（我们只拦 vault 地址）；`userIgnoreFilters` 命中的文件在搜索里消失、按精确地址仍可读。
5. 索引预算：`node --experimental-strip-types -e "…"` 直接调 P2 的构建函数跑真实库，期望 3 000 篇冷建 ≤ 3 秒、二次（指纹全命中）≤ 0.4 秒且 `reread = 0`、进程 RSS 增量 ≤ 60 MB；超出就把数字写进文档并改预算，不改代码迁就。
6. 无构建步骤：改完 `src/client/index.js` 直接重启 `dsh`，浏览器控制台没有 `require(...) missed the module table`；仓库 `git status` 里不出现任何构建产物。
7. 规则失效：跑着的时候往 `.obsidian/app.json` 的 `userIgnoreFilters` 加一条并保存，不重启，下一次搜索结果里该文件消失。
8. 回滚：把 `omd-vault` 行 `disabled: true` 后重启，指南入口与 tab 类型消失，`vault://` 读取报错里带已注册源清单。

## 10. 风险

1. **上游 markdown 变形**：`MarkdownText` 的 props、`MarkdownDelegate` 的字段、tab 类型注册的字段都在预发布线上（`dsh-v0.2.1-rc.2`，上游自己写明会有破坏性变更）。倾向：接受。我们只用 seed 里的公开导出与一个文档化钩子，转换产物限制在 GFM 内，换渲染器只改一层。检测点：升级后先跑验收第 2、3 条。
2. **P0 迁移拖住一切**：`internalPaths` 的客户端跟随没实现、`omd-read` 没迁。倾向：先做 P0，且**不加** `readSchemes` 兼容分支——两套 scheme 表正是 `docs/omd-internal-paths.md:9` 要消灭的东西。
3. **Obsidian 语法漂移**：callout 种类、Bases 表达式面、JSON Canvas 版本都在动。倾向：只做文档化的子集，不认识的写法在视图里显式报错（参考实现 `bases.mjs:18-20` 就是这个原则），转换器带一个版本号，升级即对比快照。
4. **大库成本**：万篇以上、含大附件时，遍历加解析会拖慢启动后的第一个请求。倾向：先按第 6 节的预算实现并**实测**，再决定要不要 `worker_threads`；不在第一版引入线程池。
5. **gitignore 语义与 APFS 大小写**：`ignore` 包按 git 规则匹配，APFS 默认大小写不敏感，`Raw/x.md` 与 `raw/` 的规则可能对不上。倾向：匹配时路径与规则都做一次规范化（Unicode NFC），并在文档里写明“按大小写不敏感处理”，与 Obsidian 在本机的观感一致。

## 待定问题（各给推荐默认）

1. vault 要不要写能力（新建、改、删笔记）？推荐：第一版只读，写继续走现有 `write`/`edit` 的绝对路径，不新增地址动词（`docs/omd-internal-paths.md:79-80` 把写排除在路径之外）。
2. `.base` 的 `summaries`、第三方视图、Dataview？推荐：不支持，视图内显式提示，与参考实现边界一致。
3. 全文搜索要不要给模型？推荐：不给。`grep` 工具已能按绝对路径搜内容；界面侧搜索是人的需求，不必变成模型可见能力。
4. 多库 id 冲突时是否允许用户改 id？推荐：允许，`vaults` 每项带可选 `id`；自动发现的按第 3 节规则加后缀。
