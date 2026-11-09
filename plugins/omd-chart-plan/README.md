# omd-chart-plan

把一张 Markdown 表格读成图表计划。纯函数：不接 `ctx`，不注册工具或服务，不写记录，不画图，也不调模型。启发式与判官两半都在这里：前者从单元格算出计划，后者把只有语义能定的那几项问出来、再把答案合回去。

```ts
import { analyzeTable, buildSpec, planChart } from 'omd-chart-plan'

const analysis = analyzeTable(markdown) // TableAnalysis | undefined：文本里没有表格时为 undefined
const plan = analysis && planChart(analysis) // ChartPlan | null：这张表不该画图为 null
const spec = analysis && plan && buildSpec(analysis, plan) // 渲染器要的类目与数值
```

- `analyzeTable(markdown)` 只读文本里的第一张表（表头行 + 分隔行 + 至少一行数据）。
- `planChart(analysis, config?)` 走下面的门槛与级联，返回计划或 `null`。
- `buildSpec(analysis, plan)` 把列下标展开成类目名和每个系列的数值。
- `worthCharting(spec)` 判断这张图是否比表格本身更好读。
- `shouldJudge(analysis, plan)` 判断判官是否有可改的余地（≥2 个度量列且 ≥3 行）。
- `buildChartState(markdown, analysis, config?)` 出判官要看的 state（表格 + 列类型）。
- `buildChartQuestions(analysis, plan, config?)` 出判官要答的题（见下文「判官侧」）。
- `mergeChartAnswers(plan, analysis, answers, config?)` 把答案按各自门槛合回计划，并返回逐题审计。

数值一律用基本单位：时长是毫秒，大小是字节（`KiB` 按 1024，`KB` 按 1000），百分比是百分点，其余是原值。渲染方按 `dim` 自己排版。

## 能读的单元格

| 写法 | 读成 |
|---|---|
| `42`、`1,400`、`3.25` | 数（`count`） |
| `~1,400`、`≈12`、`-3`、`+12` | 估算、带符号的数 |
| `≤ 200`、`< 5`、`≥ 10`、`> 0` | 带边界的数，`bound` 为真 |
| `87%`、`21.5 %` | 百分点（`percent`） |
| `$0.42` | 金额（`currency`），只认 `$` |
| `120 ms`、`1.5 s`、`900 us`、`200 µs`、`2 h` | 时长，换成毫秒（`duration`） |
| `3 MiB`、`16 KiB`、`512 MB`、`4 GB`、`1024 B` | 大小，换成字节（`bytes`） |
| `17 (21.5%)` | 主数 17，括号里的注释被忽略 |
| `154/160` | 分数；整列都是分数时读成 160 的百分比 |
| `24–72 h`、`12 — 18`、`24 to 72` | 区间，取低端作值，`upper` 存高端 |
| `12 → 15`、`12 -> 15` | 转移，`to` 存 15（这张表不会画图，见下） |
| `2026-01-05` | 日期（`temporal`） |
| `#2233` | 行标识（`id`），不参与数值 |
| 空白、`—`、`n/a`、`none` | 缺失 |

表头写了单位时，下面不带单位的裸数字沿用这个单位：`Latency ms` 下的 `18400`、`Memory (MiB)` 下的 `320`、`Pass %` 下的 `87`。

## 读不了的单元格

认不出的写法一律当文字，不做猜测；一列文字不是度量列，整张表因此可能不出图。

- 复合时长：`1m 56s`、`4:14`。
- 缩写量级：`3.4G`、`12k`、`1.2M`。
- 速率：`1.2 tok/s`、`500 req/s`。
- 带状态符号的数字：`12 ✅`、`4**`（符号粘在数字后面）。
- 非 ISO 日期、月份缩写、相对时间（`yesterday`）。
- 只有一个字母的 `m`（分钟还是百万无法区分）、小写 `b`。
- 货币：除了 `$` 以外的符号，以及 `$1.2k` 这类带缩写的形式。

## 列角色

| 角色 | 判定 |
|---|---|
| `temporal` | ≥80% 的单元格是 ISO 日期 |
| `index` | 第一列，≥3 个裸整数且逐行加 1；或表头是 `#`、`id`、`rank` 等 |
| `sequence` | 表头是有序步骤词（`Step`、`Pass`、`Run`、`Workers`）且数值单调 |
| `measure` | ≥80% 是数字；或 ≥60% 是数字、其余是 24 字符以内的短词 |
| `label` | 其余（文字列） |

列的补充事实：`constant`（数据行里值全一样，不当度量）、`restates`（数值是另一列的固定倍数，删掉）、`scores`（整列是 `a/b` 分数）、`mixed`（数值量纲不一致）。

汇总行按行名剥离：`Total`、`Totals`、`Sum`、`Overall`、`Grand total`、`Subtotal`、`Average`、`Avg`、`Mean`、`Median` 开头的行不进数据行，只留在 `totals`。

## 图种（先命中先赢）

| 顺序 | 条件 | 图种 | 启发式 |
|---|---|---|---|
| 1 | 有 target 列（表头写 target/budget/SLO，或 ≥60% 的单元格带 `≤`、`<` 边界） | bullet | 不做：有 target 列时直接不出图 |
| 2 | 一列 `a → b`，占比 ≥60% | paired | 不做：这种列直接不出图 |
| 3 | 若干度量列在每一行精确加总成另一列 | stacked | 做了 |
| 4 | 结果计数列（`Pass`/`Fail`/`Skip` 这类表头）≥2 列 | stacked | 做了 |
| 5 | 有序分箱（`1`、`2–5`、`6–20`）作行名 | histogram | 不做 |
| 6 | ≥2 列同量纲，表头写 before/after | paired | 做了 |
| 7 | 行名列是日期或有序步骤，且 ≥4 行 | line | 做了 |
| 8 | 只有一列，且是分数列 | progress | 做了 |
| 9 | 一列带符号、有负值，占比 ≥60% | diverging | 不做 |
| 10 | ≥4 列同量纲，且 ≥3 行 | heatmap | 做了 |
| 11 | 量纲 ≥2 种 | multiples | 做了 |
| 12 | offset 列（`Offset`、`Start`）且 75% 行首尾相接 | timeline | 不做 |
| 13 | ≥2 列同量纲 | grouped | 做了 |
| 14 | 其余 | bar | 做了 |

第 3 条只认精确加总：每一行里部分和与整体的差不超过 1e-9 相对量，且部分列至少各有一个非零值，覆盖至少 3 行。百分比四舍五入到整数造成的 99 与 100 之差不算加总。

## 不出图的条件

剥离汇总行之后，下列任何一条成立就返回 `null`：

- 数据行少于 `minRows`（默认 2）。
- 没有度量列（没有数字，或唯一的数值列被认成 index / 常量 / 复述列）。
- 只有 2 行且只有 1 个度量列。
- 有 target 列（第 1 条图种未实现）。
- 有 ≥60% 的 `a → b` 单元格（第 2 条图种未实现）。
- 表头写 before/after 的两列量纲不同（跨量纲是 `change`，本切片不画；同理一张图混不进两种单位）。
- 只有 1 个度量列，且行名列的表头是 `Metric`、`Value`、`Stat` 这类词：每一行各是一种量，没有共同坐标轴。
- 正文压过数字：除行名列外还有文字列，每行中位长度合计 ≥40 字符，而要画的值全是 ≤5 的非负整数。
- `worthCharting` 不过：类目 <4、画出的点 <9、且系列内极差 <3 倍（三条都不满足）；或者一个 ≥4 个点的系列里，除一个值以外全都相同。

## 未做的图种

这个切片只做 8 种：`bar`、`grouped`、`stacked`、`paired`、`line`、`heatmap`、`multiples`、`progress`。

六处缺口，逐项列出：

1. `bullet`：target 列（`≤ 200 µs`、`budget 120 ms`）要的图型。
2. `histogram`：有序分箱计数。
3. `diverging`：正负分叉的单列。
4. `timeline`：offset 列首尾相接的甘特式图。
5. `change`：跨量纲的 before/after 与跨行变化倍数。
6. `paired` 的转移形态：单列 `a → b` 单元格画哑铃，需要同时画起点和终点。

omp 还有 8 种从未采纳：`slope`、`butterfly`、`waterfall`、`range`、`scatter`、`dots`、`share`、`ladder`。

六处缺口的处理方式，都不猜：

- 第 1、5、6 项的输入（target 列、`a → b` 单元格）**直接不出图**，因为换成 bar 或 grouped 会丢掉表里写明的对照关系。
- 其余没做的规则不拦路：表格会继续落到后面的规则，例如分箱计数的表会画成 bar。分箱本身已是有序坐标轴，bar 不失真。

## 判官侧

启发式先算出完整计划，判官只覆盖它覆盖不动的字段。这一半也是纯函数，不问模型、不写记录：

```ts
import { analyzeTable, buildChartQuestions, buildChartState, mergeChartAnswers, planChart } from 'omd-chart-plan'

const analysis = analyzeTable(markdown)!
const plan = planChart(analysis)! // 启发式那份
const state = buildChartState(markdown, analysis) // 判官看到的全部：表格本身 + 每列推断类型
const questions = buildChartQuestions(analysis, plan) // 交给判官的问题，选项、兜底值和门槛都在里面
const { plan: merged, trace } = mergeChartAnswers(plan, analysis, answers) // answers 按 id 索引
```

`answers` 的形状是 `Record<id, { choice, confidence }>`。`applyChartAnswers` 是只要计划、不要 trace 的简写。

判官的 state 是**表格本身**：Markdown 截到 `maxTableChars`（默认 4000）+ 每列的推断类型（`number (duration)`、`number (score out of a total)`、`text`、`ordered step`、`row index`、`date/time`）。不是会话上下文，也不读 `omd-judge-context` 的会话组装——那份配方约束的是"要不要画"那个消费者。

### 问题表

| id | 决定 | 门槛 | 启发式兜底 | 什么时候问 |
|---|---|---|---|---|
| `kind` | 图种 | 不看置信度 | 上面的级联 | 总是问；选项只列这些列画得出来的图种 |
| `order` | 行序 | 0.6 | `null`（保持表内顺序） | 行名是文字列、≥4 行、首个系列的数值还没排好序 |
| `c{i}` | 第 i 列画不画 | 0.5 | 该列在 `series` 里为 `yes`，否则 `no` | 每个度量列 |
| `p{i}` | 第 i 列哪边更好 | 0.7 | 表头与量纲推出的极性，没有则 `neutral` | 可画的度量列，最多 6 个，`series` 里的列排在前面 |
| `rivals` | 什么算竞争 | 0.7 | 行名表头含 models/configs/variants 等词为 `rows`，否则 `columns` | ≥3 行 |
| `focus` | 谁是重点行 | 0.75；表里也加粗或标 `(current)` 的那行 0.4 | 启发式的 `focus`，没有则 `none` | 3–12 行 |
| `title` | 标题 | 概括整张表的事实 0.4；单个最值事实 0.75 | `none`（启发式不写标题） | 表里算得出一句话 |

顺序就是表里的顺序：先 `kind`，再结构性的行序与逐列问题，最后按语义优先级 `title` → `rivals` → `p{i}` → `focus`。总数超过 `maxQuestions`（默认 25）时从尾部裁，所以宽表先丢重点行和标题，不会先丢列的问题。

标题的选项不是自由文本，是本地算出来的三族事实：`top:<列>` 写成"某行 has the highest 某列 (值)"，`low:<列>` 同理取最低，`trend:<列>` 是"每一行都严格上升/下降"。前两族只复述一个值，所以要 0.75；第三族说的是整张表，0.4 就够。判官只选 key，措辞由我们给，同一次合并因此可复现。

### 合并规则

- 答案缺失、选项不在该题的 `options` 里、置信度低于该题门槛 → 一律保留启发式原值，不整体作废。
- **结构事实压过判官**：每一行的若干列精确加总成另一列（`analysis.composition`）时，`kind` 一律 `stacked`、`series` 一律那几列、`whole` 一律那一列。判官选 `grouped` 也改不动，trace 里记 `structural-override`。
- 判官选的 `kind` 用选中的列画不出来（`paired` 要两列同量纲、`stacked` 要两列可加、`heatmap` 要四列同量纲、`progress` 要恰好一列……）→ `kind` 与 `series` 一起退回启发式，记 `not-drawable`。
- `p{i}` 只对最终 `series` 里的列生效；没画的列保留启发式的极性，记 `not-plotted`。
- 每个 `c{i}` 各自决定自己那一列，没回答就等于保持启发式的位置；答案把列删空时整体保留启发式的 `series`。

不能覆盖的：`label`（它是哪一列由单元格读出来）、加总关系本身、单元格是不是数字与列角色。这些从数字里读，判官改不动。

### 审计

`mergeChartAnswers` 返回的 `trace` 每题一条，够写一行日志：

```json
{
  "entries": [
    { "id": "kind", "kind": "kind", "answer": "grouped", "confidence": 0.9,
      "threshold": 0, "adopted": false, "reason": "structural-override",
      "before": "stacked", "after": "stacked" }
  ],
  "adopted": ["order", "title", "rivals", "p2", "p3", "focus"],
  "ignored": ["kind", "c1", "c2", "c3", "c4", "p1", "p4"]
}
```

`reason` 的取值：`adopted`、`missing`、`unknown-question`、`unknown-option`、`below-threshold`、`not-plotted`、`structural-override`、`not-drawable`。

### 与 omp 的四处偏离

1. omp 对 `stacked` 这类自带坐标轴的图不追问行序（`OWN_FRAME`），我们照设计第 5 节问：判官可以重排堆叠图的行。
2. omp 的 `c{i}` 只要有任何一个 `yes` 就整体替换 `series`，我们让每一列各自决定。
3. omp 的 focus 答案即使低于门槛也会清空启发式的 focus，我们低于门槛就保留。
4. omp 的 `line`/`waterfall` 等图种在这里不存在，问题集只留 8 种图能画的那些。

## 门槛数值

`Config` 里本包真的读了三个：`minRows`（默认 2，启发式）、`maxQuestions`（默认 25）与 `maxTableChars`（默认 4000，`buildChartState` 的截断长度）；`mode` 与 `pickTimeoutMs` 由调用方（宿主）用，本包不碰传输与时序。`minConfidence`（默认 0.6）是某一题没写自己门槛时用的值，现在这七类都写了设计给的门槛。

级联自身的门槛是 `src/plan.ts` 顶部的命名常量：图表值得画的三条（4 个类目、9 个点、3 倍极差）、正文门槛（40 字符、≤5）、折线最少 4 行、小多图最多 6 个面板、热力图至少 4 列 3 行。判官侧的门槛（0.6 / 0.7 / 0.75 / 0.4 / 0.5、3–12 行才能问重点行、极性最多问 6 列）在 `src/judge.ts` 顶部，同样是命名常量。`src/analyze.ts` 里的门槛（80% 数字占比、3 行才认加总与比例）是读取层的判定标准，不属于用户可调项。


