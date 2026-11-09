# 渲染层：我们的界面怎么叠在 DS-Bot 上

组合是 DS-Bot 组合（其 patch 层已归档在 `archived/retired-profiles/omd-full/`）：`dsh-base` + `dsh-web-app` + `ds-bot` + `dsh-motion-ui`，
再加 21 个本地插件。DS-Bot 与 motion-ui 都是只读 submodule，这里不改它们一行。

## 三条叠加规则

界面在 dsh 里是一个 keyed slot 表，所有对话行都经
`conversation.chat.node` 分派，按 key 选组件、按优先级选赢家（数值小的赢）。

| 规则 | 做法 | 用在哪些功能 |
|---|---|---|
| 新 key，互不干涉 | 自己发一种对话节点（如 `omdChartCard`、`omdReadCard`），DS-Bot 不认这个 key，它就不会覆盖 | 表格成图、read 卡片、可视化 |
| 原生 key 被 DS-Bot 占了就让位 | DS-Bot 在 Bot 模式用 `priority: -100` 接管 `tool-call`、`assistant-step` 等 key；我们的卡片检测到这一点后改走自己的节点，不跟它抢 | read 卡片 |
| 工具面按需开关 | 宿主用 `presentationMeta` 声明卡片，模型侧看不到；`omd-tools-policy` 只收 `create_goal`/`get_goal`/`update_goal`/`lsp_diagnostics`，motion 的渲染工具保持可见 | 工具策略 |

## 实测结果

在 DS-Bot 组合上真实回合验证（Magpie `group/labor` 路由）：

| 能力 | 插件 | 实测 |
|---|---|---|
| read 结果渲染成可折叠代码卡 | `omd-read` | Bot 会话出现 `.omd-read-card`，路径行 + 折叠正文；同一会话里旧记录也补渲染 |
| 定稿回答的表格自动成图 | `omd-table-chart` + `omd-chart-plan` | 出现 `figure.omd-chart` 与 `svg.omd-chart-svg`，坐标轴、图例、柱形齐全 |
| `dsh-ui` / `motion-ui` / `svg` 围栏内联渲染 | `dsh-motion-ui` | 出现 `[data-dsh-generative-ui]` 与围栏宿主；原文围栏被隐藏，渲染结果占据原位 |
| DS-Bot 原生卡片共存 | `ds-bot` | `show_view` 卡片、消息气泡、侧栏照常工作 |

一个已知的渲染门槛：图表不是"有表格就画"。`omd-chart-plan` 的置信度闸门在
`minConfidence: 0.6`，中文表头（`月份|销量`）和三行小表会被判为"保持表格"。
四行两列且第二列是数值的表（如 `Region|Revenue`）会成图。这是设计取舍，不是缺陷。

## 一个未解决的冲突

Bot 会话的工具面由 DS-Bot 裁剪：它用 `HIDDEN_TOOLS` 屏蔽 `subagent` 一类工具，
并用自己的 `show_view` 代替 motion 的 `render_text`。结果是 motion 的 15 个渲染
工具在 Bot 会话里不可见，只在普通 Agent 会话可用。要让 Bot 也能直接调用它们，
就得改 DS-Bot 的工具面——那是上游文件，按约定不动。

## 文件

- `plugins/omd-read/src/client/index.js`：新增 `omdReadCard` 投影与渲染器。
- `plugins/omd-table-chart/src/client/index.js`、`plugins/omd-visual/src/client/index.js`：
  原本就是"自有节点 + keyed 渲染"的写法，无需改动。
- `archived/retired-profiles/omd-full/cordis.patch.yml`：组合层，冲突处让 DS-Bot 的行先。
