# 表格派生图表：判官 / 确定性启发式双路

只读设计，2026-10-22。omp 侧只读于 `~/.bun/install/global/node_modules/@oh-my-pi/`，本仓库未改一个文件。

## 1. 结论

1. 两条路共用同一个计划对象：启发式先算出一份 `ChartPlan`，判官只覆盖它覆盖不动的部分（标题、重点行、哪边是更好、什么算竞争、行序、画哪几列）。判官不可用或解析失败 → 用启发式那份，绝不空白。
2. 落点选**宿主侧算计划 → 结构化记录 → 客户端渲染 SVG**，不走围栏、不走 DOM 后处理。围栏要开 fork 而且装不下我们需要的图表种类；DOM 后处理没有结构化记录，判官的判断每次重渲染都要重算。
3. v1 只实现 8 种图形：bar / grouped / stacked / paired（哑铃）/ line / heatmap / multiples / progress，外加 bullet 与 timeline 两条弱规则。omp 的另外 11 种（slope、butterfly、waterfall、range、scatter、dots、share、diverging、ladder、histogram、change）明确不做。

## 2. 证据

- 判官接入：`pi-coding-agent/src/auto-graph/planner.ts:57-78`（`PICK_TIMEOUT_MS=15000`，本机候选只答 kind 一问）、`:96-169`（逐项置信度门槛、`MAX_QUESTIONS=25`、`SEMANTIC_PRIORITY`）、`:339-379`（判官 state = 表格 markdown 截到 4000 字符 + 每列推断类型）、`:557-735`（`planFromAnswers`：缺答、低于门槛、选项不合法，一律保留启发式）。
- 启发式：`pi-tui/src/charts/chart-plan.ts:804-992`（`guessShape` 级联，先命中先赢）、`:614-616`（`shouldJudge`：≥2 个度量列）、`:4149-4229`（`worthCharting`：类目 ≥4，或画出的点 ≥9，或系列内极差 ≥3×）、`:1480-1494`（`proseLed`）、`:4898-4915`（`guessShading`）、`:4818-4849`（`guessNaming`）。
- 单元格与列型：`pi-tui/src/charts/table-data.ts:14-115`（`Dimension`、`CellFit`、`ColumnRole`、`TableColumn`）、`:715-838`（`analyzeTable`：汇总行剥离、常量列、复述列、composition）、`:1213-1292`（`readColumn`：角色判定）。
- 判官问题集全文：`pi-coding-agent/src/prompts/judge/auto-graph.json`（21 种 kind 定义 + title / rivals / polarity / focus / move / order / reference / label / pair / group / name / column / transpose / shading）。
- 我们的判官：`plugins/judgment/omd-judgment/src/types.ts:24-56`（`ChoiceAnswer.probabilities` + `confidence`，门槛直接读概率）、`docs/omd-judge-context.md:29-31`（不可用或解析失败 → 按"不做"处理）。
- 落点：`docs/omd-ui-backlog.md:50-56`（围栏无座位、上游不收 PR、DOM 后处理零结构化记录）、`:75-93`（`appendPluginRecord` 记录形状，通道已验证通）、`:104-118`（工具 `data.meta` 不需要许可，但只覆盖我们自己的工具结果）。
- 渲染能力上限：`local://omd-visual-contract.md:28`（motion-ui 扩展 `chart` 只有 `bars|line|donut` 且单系列）。这就是围栏装不下图表语义的直接原因。

实测（在 omp 源码上跑，未落任何文件）：4 行 × 3 个同维度 ms 列 → stacked（Input+Output=Total 精确加总）；4 行 × 1 个分数列 `154/160` → progress；4 行 × Before/After 两列 → paired 且自动带标题；4 行散文 + 1 个小整数列、4 行 × 3 个纯文本列 → 都不出图；4 行 × 1 个 ms 列 → bar；5 行 × 3 个不同量纲列 → multiples。前三个还会问判官（度量列 ≥2），后四个不问。

## 3. 能力边界（伪代码）

```
能画，需同时满足：
  rows >= 2                                   # 剥离 Total / Average 汇总行之后
  && measures.length >= 1                     # 非常量列、不复述别的列、不是 index / 标识列
  && !proseLed(measures)                      # 正文列中位长 >= 40，且要画的值全是 <= 5 的整数
  && worthCharting(spec)                      # 类目 >= 4，或画出的点 >= 9，或系列内极差 >= 3×

特例放行：
  分数列    a/b（b 是整数总数）→ 读成 b 的百分比；只有这一列 → progress（154/160）
  before/after  两列同维度且表头说清前后 → paired（哑铃），跨量纲 → change（v1 不出图）
  单列 + 行名是指标词（Metric / Value / Stat）→ 不画，每行各是一种量
  一列数值 + 一列标签 → bar

不画：
  measures 为空（非数值、只有一列标签）
  rows < 2，或 rows == 2 且只有一列数值
  proseLed（表格是散文带几个小数字）
  worthCharting 不通过（2~3 行，或所有值长得一样）
```

## 4. 类型选择规则表（无判官时，先命中先赢）

| 顺序 | 条件 | kind |
|---|---|---|
| 1 | 有 target 列（每行写 `≤ 200 µs`、`budget 120 ms`） | bullet |
| 2 | 一列 `a → b` 且 arrowShare ≥ 0.6，行间同量纲 | paired |
| 3 | composition：parts 在每一行都精确加总成 whole | stacked |
| 4 | 结果计数（ok / fail / skip 三列） | stacked |
| 5 | 有序 bins（`1`、`2–5`、`6–20`）作标签 | histogram |
| 6 | ≥2 列同维度，表头说 before / after | paired |
| 7 | 标签列是 temporal / sequence，且 rows ≥ 4 | line |
| 8 | 只有一列，且是分数列 | progress |
| 9 | 一列，signedShare ≥ 0.6 且有负值 | diverging |
| 10 | 同维度 ≥4 列且 rows ≥ 3 | heatmap |
| 11 | 维度数 ≥2（量纲不同） | multiples |
| 12 | offset 列（`Offset` / `Start`）且 ≥75% 行首尾相接 | timeline |
| 13 | 2 列同维度 | grouped |
| 14 | 其余 | bar |

第 12 条是全表最弱的一条，做不出来就先砍掉，不影响前 11 条。

## 5. 判官接管点

| 判官决定 | 问题 | 门槛 | 启发式兜底 |
|---|---|---|---|
| 图表类型 | kind | 无门槛 | 第 4 节的表 |
| 行序 | order | 0.6 | 保持表内顺序 |
| 哪边是更好 | polarity `p{i}` | 0.7 | 表头关键词 + 维度（duration→lower、分数→higher） |
| 什么算竞争 | rivals | 0.7 | 标签列表头含 models / configs / variants → rows |
| 谁是重点行 | focus | 0.75；表里也加粗或标 `(current)` 时 0.4 | 少数加粗行、`(current)`、✅ |
| 标题 | title | 0.4；平庸事实 0.75 | 第一个 striking 事实 |
| 画哪几列 | `c{i}`（是非题） | 0.5 | 剔除聚合列、常量列、复述列 |
| 行名列 / 限定列 / 分组 | label、`n{i}`、`g{i}` | 0.5 | `guessNaming` |
| 转置 | transpose | 0.5 | 只有 mixed 度量时才问 |

**只有语义能决定**：标题、谁是重点行、哪边是"更好"、什么算竞争、哪一列其实只是行名、两列是不是同一量的两种条件。这些从数字里读不出来。
**交给启发式**：单元格是不是数字、量纲、列角色、汇总行、parts 是否加总、值是否太像、这张表值不值得画。

与 omp 的划分一致，只有一处偏离要说清：omp 把 kind 也交给判官。我们同样允许判官覆盖 kind，但结构事实压过判官选择——实测 flush 表（5 行，Delivered / Dropped / Latency），判官选 `grouped`，最终仍是 `stacked`，因为 Delivered+Dropped 在每一行精确等于 Queued。这与 omp `planFromAnswers` 的行为相同（`planner.ts:626-646`）。

判官是 `ctx.judgment` 的第三个消费者，但**不消费** `docs/omd-judge-context.md` 的会话组装——它的 state 是表格本身（markdown + 列类型），配方文档约束的是"要不要画"那个消费者，两边不冲突。

## 6. 落点

| 方案 | 代价 | 结论 |
|---|---|---|
| A. `omd-visual` 围栏，子代理产出 | 每个表格一次 fork；motion-ui 扩展 `chart` 只有 3 种 kind 且单系列，装不下 stacked / heatmap / multiples / order / focus | 不选。表格图表是确定性计算加一次判官调用，开 fork 是拿最贵的资源做最便宜的事 |
| B. 客户端 DOM 后处理 | 零结构化记录；判官配了之后每次重渲染都要重算，而缓存没有合法位置 | 只作兜底：没有记录的历史消息走这条 |
| C. 宿主算计划 → 记录 → 客户端渲染 | 客户端要写一个 SVG 渲染器（约 300 行）；记录写入依赖 `appendPluginRecord` 这条上游政策关掉的路径 | **选这条** |

C 的形状：

```json
{ "targetSeq": 42, "component": "table-chart",
  "plan": { "kind": "stacked", "series": [2, 3], "order": null,
            "focus": [0], "rivals": "columns", "title": "pass 1 has the highest Queued jobs (42)" },
  "decidedBy": { "role": "judge", "model": "…", "answers": { "kind": "grouped", "rivals": "columns" } } }
```

宿主不含渲染器：记录里带 `ChartSpec`（类目、系列、值、顺序、focus、极性、标题），客户端渲染成 SVG。刷新、fork、resume 得到同一张图——这是用户第 36 条要的"某条消息插入了组件，这事要进 session 历史"。启发式路径在收轮时零模型调用直接写记录；判官路径等判官返回（≤15 s）再写，图表可能比消息晚到一会儿，记录是耐久的，不影响正确性。不新引依赖，不用 ECharts，不与 motion-ui 的 3 种 kind 纠缠。

配置面（profile + 项目级面板，全部 volatile）：`mode: off | heuristic | judge`、`minConfidence`（默认 0.6）、`pickTimeoutMs`（15000）、`maxTableChars`（4000）、`maxQuestions`（25）、`minRows`（2）。本机不写死任何值。

## 7. 许可与署名

omp 是 MIT（`pi-tui/LICENSE`：Copyright (c) 2025 Mario Zechner、Copyright (c) 2025-2026 Can Bölük、Copyright (c) 2026 Stencil Labs, Inc.）。MIT 只要求署名，没有传染性义务。

- **照逻辑重写、不复制文件**：不构成"复制或实质性使用其代码"，但结构、级联顺序、门槛数值、问题措辞都来自它。结论：仍要署名。在仓库根建 `NOTICE.md`，写清来源仓库 `github.com/can1357/oh-my-pi`、路径 `packages/tui/src/charts/` 与 `packages/coding-agent/src/auto-graph/`、许可证 MIT、三段版权原文，以及"我们重写了什么、砍掉了什么"。本仓库现在没有根级 NOTICE，只有 `external-plugins/dsh-motion-ui/vendor/dsh-genui/NOTICE.md` 这个先例，照它的体例写。
- **直接借用代码片段**：MIT 要求版权与许可原文随副本保留。结论：被借文件头部保留完整版权与许可原文，或在该目录放 `LICENSE` + `NOTICE.md` 点名文件；二选一，不能只写一句"参考了 omp"。
- 另外：omd 将来要对外发布，我们自己的许可证还没定。MIT 兼容任何选择，但发布前必须显式定一个，否则 NOTICE 写了上游却没有下游许可，法务上是空的。

## 8. 切片与验收

1. **读取与启发式**：新建 `plugins/workbench/omd-chart-plan/`，`src/analyze.ts`（单元格 → 列角色 → `TableAnalysis`）、`src/plan.ts`（第 3、4 节的级联 + `worthCharting` + `shouldJudge`）。验收：第 2 节实测那 7 张表格逐行复现，尤其"散文表与纯标签表不出图"和"分数列出 progress"。
2. **判官路径**：`src/judge.ts`，问题集照 `auto-graph.json` 砍到 kind / rivals / polarity / focus / order / title / `c{i}` 七类，15 s 超时，逐项门槛，`ctx.judgment.available()` 为假直接走启发式。验收：同一张表配与不配各跑一次，不配的输出与切片 1 逐字节相同；配的那次把判官原始答案与最终计划一起贴出来。
3. **记录与渲染**：宿主在收轮时写 `plugin:omd/table-chart` 记录；客户端注册 Definition 按 `event.type` 匹配并 `buildViewNode`，按 spec 画 SVG。验收：刷新、fork、resume 三跳之后图表一致；无记录的表格渲染成普通表格。
4. **配置面**：上述字段进 profile patch 与项目级面板，`mode: 'off'` 时切片 3 一条记录都不写。

验收用一张真实表格（5 行，flush 场景，取自 `docs/plans/omd-memory-port-plan.md` 的记忆队列投递）：`Flush pass | Queued jobs | Delivered | Dropped | Latency ms` 五列，行依次为 `pass 1 | 42 | 38 | 4 | 18400`、`pass 2 | 31 | 31 | 0 | 9200`、`pass 3 | 12 | 9 | 3 | 6100`、`pass 4 | 0 | 0 | 0 | 400`、`pass 5 | 18 | 18 | 0 | 7300`。

不配判官（omp 实测输出）：

```
kind=stacked  series=[Delivered, Dropped]  categories=[pass 1..5]  title=无
```

配判官（把确定答案喂进 omp 的 `planFromAnswers` 重放，不是活模型调用：kind=grouped 0.9、rivals=columns 0.9、各列 polarity=lower 0.9、focus=pass 1 0.95、order=descending 0.95、title=top:Queued jobs 0.8）：

```
kind=stacked  series=[Delivered, Dropped]  focus=[0]
polarity={Delivered: lower, Dropped: lower, Latency ms: lower}  rivals=columns
title="pass 1 has the highest Queued jobs (42)"
```

判官选 grouped 被精确加总压回 stacked，kind 不变、语义全变——这正是双路设计的形状。活模型那一次验收要跑真的 `omd-judgment` 候选，把实际答案记下来，我这次没有可用路由，没有伪造。

## 9. 风险

1. omp 的启发式靠大量单元格解析特例（`m` 是分钟还是百万、`3.4G` 是字节还是吉、`4:14` 是时刻还是时长）。我们只实现窄子集，边界表格会给不出图或给出不同答案。缓解：文档写明支持哪些写法，其余按"不画"处理，不猜。
2. `appendPluginRecord` 是上游政策关掉的路径，随时可能收紧（`docs/omd-ui-backlog.md:71` 已接受）。收紧时退回方案 B，图表还在，只是判断要重算。
3. 判官答案不可复现：同一张表两次调用可能给不同 focus 或 title。缓解：记录里带 `decidedBy` 与答案摘要，重渲染只读记录、不重新问。
