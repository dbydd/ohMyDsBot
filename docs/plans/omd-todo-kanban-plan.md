# 待办的目录映射与看板

2026-10-22，只读设计。上游引用一律写 `refs/deepseek-harness/` 相对路径；本仓引用写仓库相对路径。
前提：`ctx.todoList` 已提供 `read` / `replace(origin: 'model'|'user'|'file'|'issue'|'maintenance')` / `subscribe`，条目含 `content`、`state`、`explanation`、`goal`、`children`、`source`。`state` 是三态（`active` / `inactive` / `completed`），见 `docs/omd-todo.md`。

## 0. 结论

| 问题 | 结论 |
|---|---|
| 落盘单位 | **一个条目一个目录**，条目数据在目录内的 `item.md` |
| 位置 | 默认 `dshHomePath('todos')/<sessionId>/`（`packages/util/home-paths/src/index.ts:160-162`），配置项 `root` 可指到仓库里 |
| 身份 | frontmatter `id`（6 位 base36）。**目录名只是人的锚**，改目录名不改变身份 |
| 顺序 | frontmatter `order` 整数，兄弟升序、同值按 `id`；目录列表顺序无语义 |
| 真相 | `ctx.todoList`（日志）。目录是镜像；外部编辑按条目回灌，且**赢过**内存 |
| 看板 | `main` keyed 面板 `omd-todo-board` + `sidebar.panellist` 图标；不新开地址 |
| 通知 | 不唤醒模型。外部改动的唯一后果是日志多一条记录，模型下次读待办路径才看到 |
| 项目级看板 | 不做写入端。一个会话一棵树（上游 `todo_write` 单所有者，`packages/todo/tool-todo/README.md:73`）；跨会话聚合只能是只读视图 |

## 1. 目录形状

```text
~/.dsh/todos/session-034744e0-.../
├── README.md                       # 生成的图例，不参与扫描
├── 7k3m2q-设计看板与文件映射/        # 目录名 = <id>-<slug>，创建后我们不再改名
│   ├── item.md
│   ├── p2qa8c-定目录格式/
│   │   └── item.md
│   └── x9cd1f-定看板落点/
│       └── item.md
└── m4zt0w-写迁移脚本/
    └── item.md
```

`item.md`（前缀缓存友好，YAML 只放数据，正文放叙述）：

```markdown
---
id: 7k3m2q
state: active                # active | inactive | completed
order: 10
goal: 让用户能直接改文件并驱动待办
source: { kind: issue, repo: onlyne/onlyne, number: 412 }
---

# 设计看板与文件映射

模型之外的协作入口。用户可以拖卡片，也可以直接改这个文件。
```

- `# ` 标题 = `content`（恰好一行）；其后正文 = `explanation`（可多段）。`goal` 在 frontmatter，是因为它需要被程序精确读回，长句在 YAML 里加引号即可。
- 只有标题是必填。用户新建 `买牛奶/item.md` 只写一行标题，宿主补 `id`/`order`/`state` 并回写 frontmatter；缺 `goal`/`explanation` 的条目标 `incomplete` 徽标，不拒绝。
- `state` 是单一轴，不再有 `active` 与 `status` 两个事实：`active` 既表示生命周期在推进，也表示该占注意力。父条目转 `inactive` 不带动子条目；看板里 `inactive` 的根默认整枝折叠。
- `source` 只表达出处；`kind: manual` 时省略。`origin: 'issue'` 表示这一版由 issue 同步写入，和条目自带的 `source` 是两件事。
- 我们不使用的写法：markdown 复选框（状态只能二值，且会和 `state` 抢同一个事实）、一个根条目一个文件（层级退回缩进解析，深改一次重写整棵树）。

## 2. 身份、顺序与路径

- `id` 在会话内全局唯一，由宿主铸造，模型从不填。重复 `id`（用户复制目录）时，扫描时按路径序保留第一个，给其余条目**换新 id 并回写**，看板记一条提示。为什么不是删一条加一条：身份在 frontmatter，不在目录名，用户改目录名、移动目录都不会丢条目。
- 模型的整表替换没有 `id`，匹配规则依次是：完全相同的 `content`；同一父节点下兄弟数量不变且恰好剩一对未匹配（视为原地改名，保留 id）；否则新铸。否则每次改错别字都会换 id。看板与文件写入显式带 `id`，不走匹配。
- 地址只认 id，不再有 `1.2` 这种序号：重排会改变序号，而引用必须活过重排。
  - `dsh-resource://todo/<sessionId>` → 整棵树渲染成 markdown（每项带 id、三态、goal、source）。
  - `dsh-resource://todo/<sessionId>/<id>` / `…/<id>/<id>` → 子树；多段时校验祖孙关系，不成立就报错并给出当前树。
  - 源声明 `live: true`、`shorthand: true`。`InternalExec` 按 `ProcUriPlan` 的共享契约加 `agent?: Agent` 后，空路径 `todo://` 解析为调用会话；在那之前模型从 `todo` 工具结果里拿到完整地址。

## 3. 同步与冲突

- 监听用 `ctx.fs.watch`（`packages/fs/fs/src/index.ts:92-105`，本地实现走 chokidar，`packages/fs/fs-local/src/index.ts:10`），每个目录一个 watcher：会话根 + 每个条目目录，最多 201 个。防抖 `ctx.debounce(tick, 250)`（`vendor/timer/src/index.ts:138-144`）。
- 回环：每次自己写完记 `lastWrittenHash`；事件到达后重算磁盘哈希，相等即自己的回声，丢弃。哈希是唯一判据，mtime 只用来跳过读取。
- 合并是**补丁**不是整树覆盖：磁盘哈希 ≠ `lastWrittenHash` 的条目从磁盘取；整棵目录消失的 `id` 才算删除；其余条目保留内存值。这样用户保存 A 条目不会顺手回滚模型刚写的 B。目录还在但 `item.md` 缺失或改名，是隔离，不是删除——用户把 `item.md` 改成 `note.md` 不该抹掉一条待办。
- 结构错误**按条目隔离**，不整份拒绝：frontmatter 非法、缺 `# 标题`、`state` 越界、`source` 形状错、超过三层、超过 200 条、父条目 `completed` 但还有未完成后代。坏条目留在磁盘、不进树，看板顶部列出路径与行号，其余条目照常生效。`content` 重复是唯一成对隔离的规则（两条都隔离，不挑一条）。
- 半截保存/编辑器临时文件：解析失败的那一条标 `dirty`，保留上一次好值并**停止向该文件写入**，其他条目不受影响。用户修好后按外部编辑回灌；也可以在看板按"用当前状态覆盖文件"强制收敛。绝不把用户未保存的缓冲区直接覆盖掉。
- 冲突判据是"这一条的磁盘哈希变了"，不引入版本号；冲突时**文件赢**（人的意图优先）。被覆盖的那一版已经在日志里，看板给一条横幅："文件在 18:40:12 覆盖了 seq 42 的 model 改动"，第三阶段再给"回到 seq 42"。
- 同一秒内两次修改：所有 transition 进一条串行队列，按到达顺序应用，最后一个被接受的赢；每次 transition 先追加 `plugin:omd-todo/detail`（整棵树 + `id`/`order`/`state`/`source`/`goal`/`explanation` + `origin`），再追加 `todo/write`。`todo/write` 的条目被上游校验为**恰好两个键**（`packages/session/session-format-v0-to-v1/src/payload-validation.ts:226-229`），所以它只带 `content`+`status`，按树的深度优先前序排列、**带整棵树、不做视图过滤**：detail 与 flat 必须同构，任何过滤都会让 `snapshotOf` 判定不同构并退回平铺树，goal/explanation 全丢。要弱化上游面板的噪音只能改读取侧渲染，不能改写入载荷；三态映射见 `docs/omd-todo.md`。上游面板与看板同时打开不会分叉——两者都从日志派生。
- 写入插件记录走 `appendPluginRecord`，理由与风险见 `docs/omd-ui-backlog.md:69-71`。

## 4. 看板

- 座位：`main` keyed（`packages/client/ui-layout/src/client/index.ts:73`）+ `sidebar.panellist`（`packages/client/ui-sidebar/src/client/index.ts:83`），照抄 `ui-schedule` 的注册形态（`packages/client/ui-schedule/src/client/index.ts:168-184`）。右侧栏太窄，`main` 才是看板该在的地方。
- 目标是哪个会话：`main` 是 root 作用域，没有会话绑定，当前选中会话只存在私有 store 里（`packages/client/ui-workspace/src/client/navigation.ts:159-161`），不碰它。改为 `sidebar.workspaces.session.row.action`（`packages/client/ui-workspace/src/client/index.ts:303`）加一个"待办"按钮：设置看板目标会话并 `ctx.layout.selectPanel('omd-todo-board')`；左轨图标打开上次的目标，空态提示从会话行进入。
- 三列按 `state`：`active` / `inactive` / `completed`；卡片 = 根条目；默认只展开 `active` 列，顶部开关展开另两列（整枝折叠）。
- 卡片显示：`content` 作标题，`goal` 一行，`explanation` 两行截断，`source` 徽标（issue 显示 `owner/name#412`，第一阶段只显示文字不跳转）。
- 子任务在卡片内就地勾选，不另开列：列是状态的划分，把子任务拖进列会把它从父卡片里拆出去，三层树在 260px 宽的列里读不了。子条目给三态控件（点击在 `active`/`completed` 间切换，菜单选 `inactive`），孙条目收在"展开 N 项"后面。
- 拖根卡片改状态。拖到 `completed` 要求所有后代都 `completed`（`inactive` 也算未完成），否则 toast 列出阻塞的子条目、卡片弹回；把已完成的卡片拖回 `active` 不重开子条目。
- 加条目：每列一个 "+"，表单要 content/goal/explanation 三项（与模型同一条纪律），新条目落在该列的状态。
- 第一阶段交互：读、拖根卡片、勾子条目、加条目、打开目录、问题横幅。第二阶段：改文字、删除、重排。第三阶段：来源徽标跳转、revision 恢复。
- 写入统一走 `todo.replace({ sessionId, items, baseRevision? })`，`baseRevision` 就是看板读到的最后一条 detail 记录的 `seq`（不另造计数器）：宿主追加 detail + `todo/write`、写目录，看板从该会话的事件流刷新；seq 对不上返回 `todo/conflict` 和当前树，看板只显示"已过期，重新载入"，不做合并。

## 5. 看板不做成地址

不做 `dsh-resource://todo/<sessionId>/board`。`docs/omd-internal-paths.md:79` 的规则是只读、可寻址的数据面走路径，写与副作用走工具或服务；看板是交互面，且它的内容就是同一棵树的第二种渲染。客户端要预览树，`omd-internal-paths` 已经按源自动注册协议（`docs/omd-internal-paths.md:48`），`dsh-resource://todo/…` 在界面侧直接可读。

## 6. 切片与验收

第一阶段（最先能用）：`omd-todo` 加树/`id`/`state`/`source`/`order` 与 `todo` 路径源；新增 `omd-todo-files` 只做**导出**（三态 → 目录，稳定命名）；看板只读。这一阶段结束时，一次 `todo` 调用就能在磁盘上得到可读、可提交的目录。
第二阶段：导入（监听 + 补丁合并 + 按条目隔离 + dirty）与看板写操作（拖、勾、加）。协作闭环在这里成立。
第三阶段：看板改文字/删除/重排、issue 来源徽标、按 detail `seq` 恢复。

验收（临时 profile，不改 `~/.dsh/profiles/omd`，见 `AGENTS.md:295`）：

1. `dsh --profile omd-slice-verify --dump-config` 退出码 0、stderr 为空。
2. 一次 `todo` 调用后 `find ~/.dsh/todos/<sessionId> -name item.md` 的条目数与工具入参一致；三个层级各自成目录。
3. `jq -c 'select(.type=="plugin:omd-todo/detail")|{seq,origin:.data.origin}' <sessionId>/session.v*.jsonl` 每次改动恰好一条，且顺序在 `todo/write` 之前。
4. 模型读 `dsh-resource://todo/<sessionId>/<id>` 得到子树；给错误 id 时错误里含当前树。
5. 手改某条 `item.md` 的 `state`：看板 1 秒内变、日志出现 `origin: "file"`、其他条目未被重写。
6. 把某条改成非法 YAML：该条进问题列表、文件不被覆盖、其余条目照常；改回合法后自动收敛。

## 7. 风险

1. **每个会话最多 201 个 watcher。** 倾向：接受，只为已打开过的会话建 watcher，会话关闭即释放；超过 100 条时再考虑 chokidar 递归一次。理由是一层一个 watcher 是 `ctx.fs.watch` 的语义，不为它加轮询。
2. **文件赢会静默丢掉模型刚写的那一版。** 倾向：接受。日志里完整保留，看板给横幅和时间点；真要合并是第三阶段的事，第一阶段不猜。代价是模型可能在下一轮看到自己没写过的状态。
3. **镜像走 `node:fs` 而不是 `ctx.fs`**：`workspace-write` 下 `~/.dsh/todos` 的写入会被 `fs-sandbox` 拒绝（`packages/fs/fs-sandbox/src/index.ts:122-142`），而镜像不该为了写自己的数据做权限升级。倾向：`node:fs/promises` + `ctx.fs.watch` 混用，并在 README 写清这是宿主私有数据；`root` 指进仓库时行为不变，但文件工具看不到它受沙箱约束。
