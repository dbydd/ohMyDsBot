# Web UI 可改边界与可视化待办

本文记录两件事：dsh Web UI 的修改边界（哪里能插、哪里必须动上游），以及已确认但暂不实现的输出可视化缺口。

## 1. 修改边界

客户端插件是真正运行在页面里的代码（React 组件，与宿主同一页面），所以"能不能注入"不是问题；问题在于**只能落在上游已经声明的座位里**。`ui-slots` 的规则是：声明一个 slot 就等于认领它，注册进未声明的 slot、重复声明已声明的子 slot 都会在加载期抛错（`refs/deepseek-harness/packages/client/ui-slots/README.md:48`）。

座位有四种：`single`（一个占用者）、`list`（有序条目）、`keyed`（按键分派）、`chain`（条目自荐）。

**现在就能用的空位**（都由上游声明、我们可直接注册）：

| 座位 | 种类 | 能做什么 |
|---|---|---|
| `main` + `sidebar.panellist` | keyed + list | 完整的全局面板：`main` 按 key 分派内容，`panellist` 的 id 就是面板 id，侧栏左轨出现图标（`ui-layout/src/client/index.ts:73`、`ui-sidebar/src/client/index.ts:83`） |
| `shell.overlay` | list | 任意对话框 |
| `sidebar.footer.action` | list | 侧栏底部、Settings 旁边的按钮 |
| `sidebar.workspaces.session.menu.item` | list | Session 行 "..." 菜单项 |
| `sidebar.workspaces.session.row.action` | list | Session 行悬停按钮 |
| `sidebar.session.row.leading` / `.hover` | list | Session 行的前置装饰与悬停卡片内容 |
| `tool.call.toolview` | keyed（按 wire 工具名） | 给某个工具定制结果卡片，这是输出可视化最主要的扩展点 |
| `settings.section` / `settings.plugins.tab` | list | 设置页分区与 Plugins 页标签 |
| `conversation.*` | 多种 | 会话区插槽（输入框、hero 等） |

**没有座位、必须动上游的**：Workspace（项目）行的 "..." 菜单。`ProjectRowItem` 里 `workspaceMenuItems` 是硬编码的两项（`ui-workspace/src/client/rows/Rows.tsx:238-296`），没有任何 slot；`sidebar.workspaces` 本身是 `single`，由 ui-workspace 独占填满整个浏览区，不能往里加东西。

结论：想"在项目卡片上打开"，唯一干净的做法是上游给 `ProjectRowItem` 加一个 list 座位（约十行）。在等到它之前，等价入口有三个，都不需要动上游：Session 行菜单项（用该会话 cwd 定位项目）、侧栏底部动作按钮、或者一个完整的 `main` 面板加左轨图标。

DOM 级注入（直接改页面元素）技术上可行，因为插件就在同一页面里；但它依赖上游 DOM 结构，升级即碎，不作为方案。

## 2. 输出可视化：已确认的缺口

上游自带、无需我们补的：Markdown、KaTeX、shiki 高亮、五类工具结果卡、diff（3 行上下文、256 行上限）、粘贴位图、图片灯箱、轮次轨、Trajectory 时序总览、子代理谱系。

缺口与落点：

| 缺口 | 落点 | 性质 |
|---|---|---|
| Mermaid 无实现，且代码围栏**没有扩展点**（唯一入口是 `render.tsx` 里的一个 `switch`） | `ui-primitives/src/markdown/render.tsx` | 需上游加 keyed 座位；之后做成 `omd-md-fence` 包 |
| Markdown 链接只放行 http/https/mailto 与文件路径，`local://`、`dsh-resource://`、`memory://` 这类内部地址进不去 | `render.tsx:55-62` 的 `sanitizeUrl`（解析在前，delegate 在后，`render.tsx:541-548` 对不放行协议只渲染裸文本） | 只能改上游；`MarkdownDelegateProvider` 是 React context（`MarkdownDelegate.tsx:29`），不是注册表，改不了合法性判定 |
| 没有消息引用，没有编辑重发 | `ui-chat/src/client/chat/MessageIconActions.tsx`、`conversation-nodes/` | 需上游座位或加座位 |
| rewind 只剩一个上下文代次枚举，没有任何回退界面 | `ui-chat/src/client/model/conversation-context.ts:5-6` | 前端界面可独立做（消费日志里的 surface replacement 与 turn/seq）；宿主能力另装社区包，`docs/omd-design.md:162` 记录过但未确认安装 |
| 代码围栏无行号、无折叠；读图仍挂在独立的 `read_image` | `ui-primitives`、`ui-tool` | 随围栏座位一起做 |
| `omd-read` 落到 GenericToolCard：无读文件卡、无图片卡、无 diff，输入输出塞进 IN/OUT 双栏，图片显示为附件引用 JSON | 我们自己的 client 半边注册 `tool.call.toolview` 的 `omd-read` 键（分派在 `ui-tool/src/client/tool/ToolCallTree.tsx:50-55`，`entryKey` 是工具名精确匹配，无前缀无通配） | 完全在我们这边，不需要动上游 |

上游已声明的专用卡都带工具名门禁，改名字解决不了，也不该解决：读文件卡要求 `call.name === 'read'`（`read-card-model.ts:40-43`）、diff 卡只认 `write`/`edit`/`str_replace_editor`（`diff-card-model.ts:52-80`）、图片卡要求 `read_image` 且 GenericToolCard 不传图相关 prop（`image-card-model.ts:186-200`、`GenericToolCard.tsx:33`）。

围栏扩展点的最小上游 diff（约十行，两个文件）：`render.tsx:185-200` 给 `MarkdownRenderContext` 加可选 `fence`；`render.tsx:336-337` 改成 `context.fence?.(node, key) ?? renderCode(...)`；`MarkdownText.tsx:174-196` 加 `fence` prop 并在 settled context 透传（流式 context 刻意置空 `pathImages`/`fileMentions`，围栏只在结算时传，行为与 TeX 一致）；消费点按需 opt-in，主入口是 `ui-chat/src/client/chat/AssistantMarkdown.tsx`。

**上游这条路不通（2026-10-22 定）**：dsh 不接受 PR 与 issue，所有改动只能我们自己做。原先的三条"上游请求"作废，逐条改成我们自己的做法：

| 原来想请上游做的 | 现在自己做 |
|---|---|
| Workspace 行菜单座位 | 不改 `ui-workspace`。面板入口已经在 `sidebar.footer.action`；要在项目卡片行里出现按钮，只能做 DOM 注入（观察 `[data-row-key^="workspace:"]` 行，往 `.rowActions` 里插一个我们自己的按钮），或者以后整包 fork `ui-workspace`。前者脆弱但小，后者要永久维护一个很大的客户端包，为一个菜单项不值得。 |
| 代码围栏 keyed 座位 | 走 motion-ui 已验证的路线：DOM 后处理。扫 `div.md-code-block,pre` 拿围栏原文，识别 ```mermaid 之类的语言，把原块 `display:none`，在旁边挂一个我们自己渲染的容器。代价与 motion-ui 相同：这条路径没有结构化记录。要结构化记录的那部分内容，改用我们自己的工具产出（走 `data.meta`）。 |
| `appendPluginRecord` 开放给外部包 | 直接调用。运行时没有任何检查拦外部包，只有上游仓库的 `verify-plugin-record-callers` 会拦——那个脚本不在我们仓库里。按 `plugin:omd/<record>` 命名、载荷无损 JSON、客户端用 Definition 渲染。 |

## 3. 组件插入决定要进会话历史

需求：某条消息被渲染成什么组件，这件事要写进会话日志，刷新、重连、fork 之后都得到同一结果，而不是每次重新问模型。

dsh 里正好有一种事件形态适合：**ignorable 插件记录**。

- 事件名是 `plugin:<owner>/<record>`，信封带 `ignorable: true`；不认识的读方保留并跳过它，它永不进入模型可见面，fork 与 resume 会把它随日志带走（`refs/deepseek-harness/packages/core/session/README.md:66-76`）。
- 载荷必须是无损 JSON；读回来时 `data` 故意是 `unknown`，由记录的属主自己校验（同文件 `:76`）。
- 恢复时用 `pluginRecordOf(event)` 把记录取出来重建状态（同文件 `:76`）。
- 未知类型不带 `ignorable` 会让持久化读路径拒绝解释整份日志，所以"自定义类型随便 append"这条路是堵死的（`packages/core/session/src/known-event-types.ts:8-21`）。

**卡点只有一个：写入方被政策关掉了。** `appendPluginRecord` 只允许上游仓库里 `packages/experimental/` 下的包调用，文档同时写着"本仓库之外的插件同样不得调用它"（`packages/core/session/README.md:70`）。公开的 `session.append` 无法产生 `ignorable` 事件，也不能声明 `plugin:` 命名空间。也就是说机制是给这件事准备的，但钥匙没给我们。

**决定：直接调用 `appendPluginRecord`。** 上游不接受 issue 与 PR，等不到授权；而运行时不拦外部包——唯一的拦截是上游仓库自己的 `verify-plugin-record-callers` 脚本，它不在我们仓库里。需要接受的风险是：上游随时可能把这条路径收紧，届时要按新的读路径改写（记录本身仍留在日志里，不会丢数据）。

落地约束：类型上在 `PluginRecordMap` 里声明 `plugin:omd/<record>` 与载荷类型；载荷无损 JSON；读回来自己校验（`data` 是 `unknown`）；客户端用 Definition 渲染，别指望默认视图。

记录形状（三条路共用）：

```json
{ "targetSeq": 42, "component": "chart", "props": { "spec": "..." }, "decidedBy": { "role": "judge", "model": "..." }, "at": 1761000000000 }
```

`targetSeq` 指向被装饰的消息事件。做表面替换（compaction）后目标可能不存在，读取方按"目标不在窗口里就跳过"处理，与 ignorable 记录本身的语义一致。

原待验证项已结论：客户端事件窗口**包含**非 surface 的 ignorable 记录，Definition 也能按 `event.type` 字符串匹配到它（证据见下）。

### 已验证：这条路通，只差写入许可

- **Host 送得到客户端**：`api/session-controller/src/history.ts:146-150` 的实时推送只按 `session.id` 过滤，不做类型白名单；冷启动与翻页走 `paginate`（`:392-426`），返回连续区间，区间内的非消息事件全带上。发送路径上 `KNOWN_SESSION_EVENT_TYPES` 只出现在注释里。
- **客户端代码不改就不会吞**：总线的连续性由 `follows: right === left + 1` 强制（`client/transport.ts:162`），`page()` 还做位置对齐校验（`history.ts:96-99`）。任何一层过滤掉记录，客户端会看到不连续并走修复页，而不是静默跳过。
- **Definition 能接住**：assembler 对每个注册的 Definition 直接调 `match(event)`，不检查类型是否已知（`ui-conversation/src/client/conversation/assembler.ts:489-518`）；`event` 上是原始条目，`seq`/`time`/`data` 都在。类型层面要一次断言：`(event.type as string)` 加 `event.data as unknown as X`，因为 `PluginRecordType` 按设计永远不是 `SessionEventMap` 成员。
- **它是耐久条目，不是瞬时帧**：seq 是真实整数，占一个槽位，不落 gap，重连整窗替换时会重放；Assistant settlement 只清瞬时匹配。
- **默认什么也不显示**：Chat 的 fallback 只接 surface append，`turnOutline` 投影对未知类型返回原 state。要让组件出现，必须自己注册 Definition 并 `buildViewNode`——compaction 是同类先例（`ui-chat/src/client/conversation-nodes/compaction.ts:31-57`）。

因此唯一的闸门仍是写入许可：`appendPluginRecord` 的政策（上游请求清单第三条）。记录载荷里**显式带 `{ turn, step }`** 最稳，别依赖位置解析的继承。

## 5. motion-ui 实测结论：能渲染，不能承载外部决定的组件化

- 声明 **0 个**座位，消费 6 个；没有自定义 renderer API（`README.md:81`），`registerFactory` 0 次，`lib/*` 被 `exports` 封住。组件核心是 vendor 的 dsh-genui（MIT）。
- 它处理代码围栏靠 **DOM 后处理**：扫 `[data-conversation-scroll]` 里的 `div.md-code-block,pre`，文本相等就把原块 `display:none`，插 host div 再 `createPortal`（`src/fence-view.js:35-36`、`src/markers.js:19-27`）。这条路径零结构化记录；组件状态存 `$DSH_HOME/plugins/dsh-generative-ui`，不在会话日志里（`index.js:55`）。只有工具路径留了 `meta.dshGenerativeUi`。
- 它真正的扩展点是自己的会话 Definition（`dshUiFences`/`dshUiStream`/`dshMotionMedia`，kind 与 chat node key 一一对应）——这正是我们自己造消息节点该用的手法，不必拥有整个渲染核心。
- 兼容性真正卡在 `package.json:53-58` 把 `dsh-tools`、`dsh-home-paths` 精确钉在三个 rc 版本上（判定在 `packages/boot/app-boot/src/plugin-compatibility.ts:55-62`）；`dsh.compatibility` 那段元数据在 dsh 源码里没有消费者。升 dsh 会整行被拦，除非 profile 的 `compatibility.json` 豁免。

结论：上游贡献为主，我们只做 tool 与路由级依赖，不 fork 整包。

## 6. 自己产出的工具结果：用 `data.meta`，不需要插件记录

`tool/result.data` 的类型里已有 `meta`（`packages/core/session/src/types.ts:376-386`），对 core 不透明、由产出工具自己解释，要求无损 JSON。写入路径是工具输出的 `output.presentationMeta`（`packages/core/tools/src/index.ts:1852-1861` → `packages/core/agent-loop/src/tool-calls.ts:282-289`），客户端直接读 `match.event.data.meta`（`packages/client/ui-chat/src/client/conversation-nodes/tool.ts:114-116`），控制器原样透传、不做归一化。

它不进模型面：`deriveEventMessage` 对 `tool/result` 只返回 `data.message`（`packages/core/session/src/surface.ts:144-146`）；请求侧工具定义重建只读 `request/header` 与 `developer/message`（`packages/core/session/src/tool-history.ts:26-62`）。运行时校验对 `tool/result` 只查两条不变式（`data` 是对象；`error` 存在时 `message.isError === true`，`surface.ts:212-219`），不拒绝多余键；重载路径 `adoptSessionEvent` 同样放行。

因此分工是：

| 场景 | 通道 | 是否需要上游许可 |
|---|---|---|
| 我们自己的工具（`omd-read`、记忆工具等） | 工具输出 `presentationMeta` → `tool/result.data.meta` | 不需要 |
| 给**别人**的工具结果挂组件 | 另 append 一条带 `sourceEventSeqs: [resultSeq]` 的事件（ignorable 记录或投影事件） | 需要（写入许可） |
| 给一条纯文本助手消息挂组件 | 同上，指向该消息的 seq | 需要 |

`meta` 的形状由工具自己定，客户端按 `meta.kind` 分派；没有 `meta` 的历史结果走通用卡片兜底。

### 实现时踩到的三条（`omd-read` 已按此落地）

1. **`tool.call.toolview` 的键是 wire 工具名，不是包名。** `omd-read` 注册的工具名是 `read`（profile 关掉了 `tool-fs.read`），所以键必须是 `read`；写成 `omd-read` 永远不会被派发。
2. **同名条目要抢上游的行，靠 priority 遮蔽。** 上游 `ui-tool` 自己注册了 `read`，同优先级重复注册会抛错；座位的替换机制是“注册成不同优先级来遮蔽它（最低者渲染）”，因此我们注册 `priority: -1`。
3. **keyed 视图没法退回 GenericToolCard。** 座位没有按条目拒绝的路径，所以“没有 `meta` 的历史结果”只能在同一个组件里复现通用卡片的信息（摘要行加扁平正文），不是交给上游组件。另外 `presentationMeta` 只在成功结果里执行（`tools/src/index.ts:1852-1861`），失败结果永远没有 `meta`——错误态就是“无 meta”那一支，用 `block.isError` 决定样式。
