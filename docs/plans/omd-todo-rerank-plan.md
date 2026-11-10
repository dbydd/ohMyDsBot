# 待办重排（rerank）：文本顺序就是注意力预算

只读设计，未改仓库文件。范围：**条目在文本里的相对位置**，不是"谁更重要"的抽象排序，也不是工具/路径候选排序。前提取 `local://omd-todo-maintenance-plan.md:4` 已定的三态 `state: 'active' | 'inactive' | 'completed'`（无 `in_progress`）；现状 `status` + `active` 的映射归维护线。

## 0. 结论

| 问题 | 结论 |
|---|---|
| 可读端 | **排前面**：四处读者都从头读，唯一带预算的读者裁的是尾部（§1）。 |
| 谁参与 | 只有 `active` 兄弟组参与重排；`inactive`/`completed` 的秩由维护决定，重排不重复分段。 |
| 排序键 | 段内先按最近活跃度（确定性折叠），再由判官分布细化；判官不能跨秩搬动、不能增删。 |
| 判官给什么 | 一批条目的**完整分布**="这一批里谁该更靠近可读端"；语义上的过时/重复也由它标，但只能降位，删除归维护。 |
| 写回 | `replace(session, 置换树, 'judge')`：该 origin 只允许置换，字段一律取当前树。 |
| 触发 | `agent/turn-stopping`，内容哈希 + "组首未变" 双门控，`ensureFresh()` 单飞；不在每次 `todo_write` 后。 |
| 降级 | 判官不可用 / 未标定 / margin 不足 / 组首未变 → 保持原序，不写回，不发事件。 |

## 1. 前提核对：待办现在注入在哪

**目前没有任何常驻注入。** `omd-todo` 只注册工具、投影、路径源（`plugins/host/omd-todo/src/index.ts` 的 `apply` 末四行）；上游 `tool-todo` 也只注册 `todos` 投影（`refs/deepseek-harness/packages/todo/tool-todo/src/index.ts:123-134`）。模型看到待办只有两条路：`todo_write` 的返回 `todoTreeEcho`（树序、`content + status + active`，不含 goal，`tree.ts:322-330`）；按需读 `dsh-resource://todo/<session>`（`render.ts:30-52`，计数头在最前、正文按树序）。另外两个读者是看板与判官上下文（配方第 2 段超 30 条**截尾**，`docs/omd-judge-context.md:14`）。

所以"可读端 = 前"依据的是四处的取舍方式，不是 token 距离：四处都从头部开始读（计数行 → 第一条就是要做的事）；唯一有预算的读者裁的是尾部，排后面的条目最先消失。若今后要常驻注入，只有两条既有通道——system prompt 分节（`plugins/context/omd-context-notes/src/index.ts:55,68`，`sectionOrder: 85`）或 pre-step 消息（`plugins/context/omd-hindsight/src/index.ts:73`）；两者都把整块放在当前请求之前、整块一次读完，截断与阅读顺序的差异比"离请求更近"更硬。

待验证的假设：若注入块变长且模型倾向回读尾部，这条要翻转。落地后用"实际先动的那条在排序里的位置"观测一次即可判断，不加配置开关。

## 2. 证据

| 事实 | 位置 |
|---|---|
| 树序 = 数组序；`todo/write` 按深度前序平铺 | `tree.ts:239-247` |
| 读侧必须 `mergeTodoTree` 才拿到 goal/explanation/active | `tree.ts:297-312` |
| 非 `model` 的 origin 只能写自己拥有的根；子节点顺序完全来自入参 | `service.ts:137, 230-283` |
| 每 session 写入 FIFO；维护在主路径 `#apply` 内跑 | `service.ts:122-128, 138-162` |
| 状态秩 + 同秩保序已由维护定，五个读者共用同序 | `maintenance-plan:30` |
| 条目无时间戳，年龄只能从日志折叠（事件带 `time`） | `maintenance-plan:23` |
| `turn-stopping` handler 可 async 并 await 判官 | `plugins/archived/omd-unexpected-stop/src/index.ts:143` |
| 判官一次最多 16 个 question，超出切片、state 每片重发 | `plugins/judgment/omd-judgment/src/index.ts:90`，`native.ts:206-215` |

实测（`POST 127.0.0.1:3425/v1/systemone`，`group/decider` → `clef-flash-oQ4e`）：5 条 active 单组（labels = `content — goal`，state 含用户上一句）`475 in / 0 out`、`0.18s`，分布 `.9150/.0384/.0260/.0135/.0072`（和 `1.0001`，margin `.8766`）——**重排前** ①②③④⑤ → **重排后** ①③②⑤④（仅 ②③ 交换）。一次请求 3 个 question（根组 + 两个子组）`561 in / 0 out`：`0.9857/0.0143`、`0.8815/0.0738/0.0448`、`0.8176/0.1824`。24/32/40 个选项均返回完整分布（和 `.9997/1.0003/.9996`，无缺项），但首位概率随集合摊薄（3 项 `.88`、5 项 `.92`、24 项 `.31`、40 项 `.26`）→ 分组而非堆大集合。同一请求重发逐字节相同。

## 3. 排序规则

1. **状态分段不归重排**：`active` → `inactive` → `completed` 的秩与淘汰/归档是维护的确定性规则（`maintenance-plan:30,32-39`）。重排只在 `active` 兄弟组内部工作；写回后维护再按秩保序落一次，两侧不互相覆盖。
2. **最近活跃度是底序（确定性）**：折叠 `todo/write` 时给每条记 `lastTouched`（`state/content/parent` 变了才刷新），active 段按它降序、同值按原序。这就是"三天没动的高优条目压不过刚更新条目"的机制——我们没有 priority 字段，"高优"只在 goal 文本里。
3. **判官分布细化 active 段（语义）**：一次 `choice`，分布降序即新顺序；不跨组、不增删、不改字段。
4. `lastTouched` 的折叠放进 `omd-todo` 的 service 折叠（`service.ts:91-97,196-207`），维护的 `completedAtMs` 读同一份：一份折叠、两个读者，不许各折一次。

## 4. 判官怎么问

```ts
questions[groupKey] = {
  type: 'choice',
  instructions: `这些是同一父节点下仍在推进的条目。哪些应当更靠近可读端（先被看到、先被处理）？（组：${parentContent ?? '根'}）`,
  criteria: Object.fromEntries(active.map(c =>
    [`${c.content} — goal: ${c.goal} —— 上次动于 ${age(c.lastTouched)}`, null])),
}
```

每组一题、一次请求发完；组数 > 16 时 native 自动切片、state 每片重发——超过 16 组说明树该先整理，记 warn。组内 active > 窗口（默认 16）：只把最近活跃的 16 条放进选项，其余按 recency 留在段尾，不截断分布、不跨窗口比较。可选第二阶段：同一请求再为每条加一个 `noul`（"是否已被本轮工作满足/与另一条重复"），`p ≥ 0.8` 降位到 active 段尾、**不删除**；默认关。state 用 `docs/omd-judge-context.md` 的共享组装（`purpose: 'order'`），不另拼。

## 5. 写回：置换，不是整表覆盖

新包 `plugins/omd-todo-order`（`omd-todo` 保持无判官依赖，它是存储与校验层），只暴露 `ensureFresh(session, signal)`（单飞；哈希未变立即返回）与 `lastRanks(session)`（每组 `{parent, ranked, margin, applied}`）。

`omd-todo` 只加一处：`TodoOrigin` 增 `'judge'`，`#apply` 为它走**置换分支**——入参必须与当前树是同一节点集合（按 `(父路径, content)` 多重集比对，任何增删抛错）；`state/active/explanation/goal/source` 一律取当前树，入参只提供顺序。于是重排**不可能**删条目、改字段、复活已删节点。不采用"用 `origin: 'model'` 整表写回"：那会把一次排序变成有删除权的写入，并抹掉"谁改的顺序"。

必须写回：看板、路径渲染、`todo_write` 回显、判官上下文四处都按树序读，各排一次必漂。

## 6. 触发、串行、降级

- **触发**：`agent/turn-stopping`（每回合一次）叠两道门——候选内容哈希（active 组内 content 列表 + 父路径）与"组首项变化"（`ranked[0] !== 当前组首`）。任一未过就不调判官。不在 `todo_write` 后立刻重排：一回合可能连写几次，那是抖动源。
- **串行**：维护在 `#apply` 内先跑，重排的写入也走它，所以秩与淘汰总是最后生效。重排调判官前记树哈希、写回前再算一次，不等就放弃；期间被维护删掉的条目会让置换校验失败 → 放弃、不复活。
- **驱动**：`omd-todo-driver` 在 `turn-stopping` 里先 `await ctx.get('todoOrder')?.ensureFresh(session, signal)` 再 `read()`，nudge 才指对一条。重排自己也挂同一事件（没驱动时看板也要新鲜）；`ensureFresh` 单飞且幂等，谁先跑都只产生一次调用、一次写入，不依赖 listener 注册顺序。
- **降级**：判官不可用 / 超时 / 解析失败 / `calibrated === false`（chat 的 one-hot 是假信心）/ `margin < minMargin`（默认 0.1）→ 保持原序、不写。放行 one-hot 会把"某条 1.0"当确定排序，比不排更糟。

## 7. 缓存与成本

键 = `sha256(state + questions)`（`plugins/judgment/omd-judgment/src/cache.ts:20-24`），state 含整棵树与用户上一句，树变键就变；哈希门在前，缓存只防"同一棵树重复调"，别指望它省掉真实重排。TTL 600s（`index.ts:88`）。单组 5 条约 475 输入 token、0 输出；选项顺序不影响分布（逆序请求相同），建问题时按 content 字典序排 labels，同组键稳定。

## 8. 切片与验收

| 切片 | 文件 | 改动 |
|---|---|---|
| S1 | `plugins/host/omd-todo/src/types.ts`、`service.ts` | `'judge'` origin + 置换分支（多重集校验、字段取当前树） |
| S2 | `plugins/host/omd-todo/src/service.ts` | 折叠维护每节点 `lastTouched`，维护共用 |
| S3 | 新 `plugins/omd-todo-order` | 哈希门、窗口、`ensureFresh` 单飞、写回、`turn-stopping` listener、`enabled/minMargin/maxGroupOptions/window` |

依赖：三态迁移（维护线 S1）先落地；重排按语义写，迁移前后都成立。

验收（临时 profile）：① `--dump-config` 退出 0、stderr 空，启动无 `did not activate`；② 真实会话 5 条 active，一次 `turn-stopping` 后新增一对 `origin: "judge"` 的 detail 与 `todo/write`，看板/路径/回显/判官上下文四处同序（§2 已用同一路由跑出前后顺序与分布）；③ 树未变的下一轮 cache 计数不增、日志不新增；④ 判官不可用或 chat 兜底：顺序不变、无事件；⑤ 判官调用与写回之间插一次维护式归档：写入被拒、归档条目不复活；⑥ `inactive` 不被搬进 active 段，`completed` 留在组尾，被降位的条目只降位不删除。

## 9. 风险（3）

1. **"前 = 可读"是待验证假设**。依据是截断与阅读顺序而非 token 距离；注入块变长后可能翻转。用一次观测判定，不叠开关。
2. **顺序抖动**：判官换个说法摆尾部，看板就会动。哈希/margin/组首三道门已够；margin 设太低会抖，默认 0.1，出现 `<0.05` 的分歧再上调。
3. **双写者交错**：FIFO 保证先后不保证语义。判官调用期间树被模型、文件同步或维护改动 → 置换或哈希校验失败即放弃，代价是本轮顺序不更新。可接受。

## 10. 待定（默认建议）

- `lastTouched` 从事件折叠、不加存储字段；改名/挪位视为新身份（与维护 pathKey 一致）。
- `minMargin 0.1`、`maxGroupOptions 32`、`window 16`、`staleProbe off` 进配置面。
- 重排只动兄弟顺序，永不跨父移动；看板第二阶段的用户拖拽复用同一置换校验（`origin: 'user'`）。
- 与维护的接口只有两条：秩由它定、`lastTouched` 折叠共用一份。
