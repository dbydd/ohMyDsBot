# omd-context-tavern

酒馆模块与上下文装配的 Web 前端，加上这份配置的真实后端。

世界书、纪元、故事笔记和 Author's Note 不再是浏览器本地数据，而是每个 Bot 项目一份的 JSON 文档。同一个工作目录下的所有会话、所有浏览器窗口读写同一份文件；agent 也能通过 `tavern://` 内部路径读写它。

## 状态归属

项目的键是一个绝对路径：Bot 会话的工作目录（`session.cwd`）。用户原话是「世界书算是一种项目集（目录级）配置」，所以键就是目录，不是 botId，也不是 sessionId。

文件落在 dsh 数据区：

```
$DSH_HOME/data/omd-context-tavern/projects/<sha256(规范化绝对路径)>.json
```

文件名只来自哈希，不含路径分隔符。文档形状：

```json
{
  "version": 1,
  "revision": 7,
  "project": "/abs/path",
  "epochId": "E-02",
  "epochStartedAt": 1793884205021,
  "lorebook": [{
    "id": "lore-x", "name": "工程纪律", "keys": ["规范"], "constant": true, "content": "…",
    "meta": { "secondaryKeys": ["底线"], "selectiveLogic": 3, "order": 100, "source": { "format": "character-card", "version": "V2", "file": "ren.png" } }
  }],
  "frozenEntryIds": ["lore-x"],
  "epochs": [{ "id": "E-01", "at": 0, "archivedAt": 0, "tokens": 1066, "entries": ["工程纪律"] }],
  "authorNote": "…",
  "storyNotes": "…"
}
```

写入规则：同一项目的写入排成一条队列，一次只落一份；每个文件先写临时文件再 `rename`，进程被杀不会留下半截 JSON。`revision` 由服务端持有，每次写入加 1；客户端写的时候必须带上它读到的 revision，对不上就回 409，不覆盖别人的修改。

## HTTP 路由

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/plugins/omd-context-tavern/project?project=<encodeURIComponent(绝对路径)>` | 返回文档；该项目从没写过时返回 revision 0 的空文档。缺 `project` 或给的是相对路径回 400。 |
| POST | 同上 | 体 `{ project, expectedRevision, document }`。成功回 `{ ok: true, revision }`；`expectedRevision` 不是当前 revision 回 409 `{ error, revision }`，`revision` 是磁盘上的当前值。 |
| GET | `/api/plugins/omd-context-tavern/roots` | 部署的默认工作区根目录（`sandboxPolicy.workspaceRoot`）。没有会话支撑的全局设置页用它当页面 cwd 解析相对图片地址。 |

## Agent 侧的 `tavern://`

宿主把这份文档注册成 `internalPaths` 源 `tavern`，地址一律按调用会话的 `cwd` 解析：

```
tavern://
tavern://author-note.md     读 / 写（整文件替换）
tavern://story.md           读 / 写（整文件替换）
tavern://lorebook/<id>.md   读 / 写（替换该条目正文）
tavern://epochs.json        只读
```

- 读根地址返回条目索引（id、名称、关键词、是否常驻、文件路径）。
- 调用会话没有 `cwd` 时报错说明「需要项目会话」，不做猜测。
- 写入走同一个 store 的同一条队列，所以人和 agent 同时改同一个项目不会互相覆盖：后到的写入基于刚刚读到的 revision 递增。

## 格式兼容：角色卡与世界书

世界书域工具条的「导入」按钮吃 `.json` 和 `.png`，全部在浏览器里解析，然后作为**一次**文档写入提交：服务端 revision 只 +1。遇到 409 走既有冲突条，导入内容留在 updater 里，不会半落地。

### 支持的版本

| 输入 | 识别方式 |
| --- | --- |
| 角色卡 V2 / V3 | JSON 顶层 `spec` 为 `chara_card_v2*` / `chara_card_v3*`，字段在 `data` 下 |
| 角色卡 V1 | JSON 平铺对象；同时认 TavernAI 老字段名 |
| PNG 卡 | 扫 PNG 块，读 `tEXt`（也读未压缩的 `iTXt`）里关键字 `ccv3` 或 `chara` 的 base64 JSON；`ccv3` 优先 |
| 世界书 | JSON 顶层 `entries`：SillyTavern World Info 的 `{ "<uid>": {...} }` 对象，或 V2/V3 `character_book` 的数组 |

PNG 里没有 `chara`/`ccv3` 块、块不是 base64、JSON 不合法、对象既没有卡名也没有 `entries`，都会在导入摘要里给出对应的中文原因，不做猜测性兜底。

### 已映射：直接进条目

| 输入字段 | 落到哪里 |
| --- | --- |
| 卡 `name`（或 `char_name`） | 一条 `constant: true` 的条目，名字就是卡名，进冻结前缀 |
| `description` / `personality` / `scenario` / `first_mes` / `mes_example` | 卡条目里各自的 `## 角色描述` / `## 性格` / `## 场景` / `## 开场白` / `## 对话示例` 小节；空字段不写标题 |
| `system_prompt` | 卡条目里的 `## 系统提示词`，同时**仅当**作者注为空时补进 `authorNote` |
| `creator_notes` | 卡条目里的 `## 作者注记` |
| `post_history_instructions` | `authorNote`，有内容时覆盖旧值 |
| `character_book.entries` | 与世界书同一套映射，逐条追加 |
| 世界书每条的 `key` / `keys` | 条目触发关键词 |
| `keysecondary` / `secondary_keys` | `meta.secondaryKeys`（次关键词），**不**并入 `keys`：并进去会把条件触发变成无条件触发 |
| `comment` / `name` | 条目名；都没有时用 `条目 N` |
| `content` | 条目正文 |
| `constant` | 常驻开关 |
| `disable: true` / `enabled: false` | 跳过该条，只计数 |

名字冲突不覆盖：同名的后来者追加 `（2）`、`（3）`，导入摘要报出加了几条。重复导入同一张卡因此是追加而不是静默覆盖。

### 已保留待判官：`meta`

每个世界书条目有一个**可选**的 `meta`，导入时把酒馆注入引擎要用的字段原样装进去。本插件不解释它们：没有装配器，条目根本不进模型请求，这些值只是被保存、在界面上可见，将来由判官（decision）决定怎么生效。

| `meta` 字段 | 来源字段 | 将来由判官决定什么 |
| --- | --- | --- |
| `secondaryKeys` | `keysecondary` / `secondary_keys` | 次关键词在什么条件下参与触发 |
| `selective` | `selective` | 次关键词是否参与触发 |
| `selectiveLogic` | `selectiveLogic` / `selective_logic` | 主次关键词的组合逻辑：0 AND_ANY · 1 NOT_ALL · 2 NOT_ANY · 3 AND_ALL |
| `caseSensitive` | `caseSensitive` / `case_sensitive` | 关键词是否区分大小写 |
| `matchWholeWords` | `matchWholeWords` / `match_whole_words` | 关键词是否按整词匹配 |
| `order` | `order` / `insertion_order` | 同批注入时的先后顺序 |
| `group` / `groupWeight` / `useGroupScoring` | 同名字段 | 分组竞争时留哪一条、权重怎么算 |
| `sticky` / `cooldown` / `delay` | 同名字段 | 命中后持续几轮、冷却几轮、延迟几轮才可再次触发 |
| `role` | `role` | 插入时挂在哪个角色消息上 |
| `extensions` | `extensions` | 原样透传的第三方扩展数据 |
| `source` | 导入时写入 | 追溯条目来自哪种卡（`character-card` / `world-info`）、版本与文件名 |

规则：

- 全部字段可选，`meta` 整个缺失也合法。meta 之前写的项目文档照旧读写，`version` 仍是 1。
- `meta` 用 `catchall` 透传未知键：新版酒馆导出多带字段不会让整份文档被拒收。
- 只有卡里真有的字段才写进 `meta`，缺省不补默认值；`false` 与 `null` 是两种不同的值，照原样存。
- 编辑器在关键词下面显示一条**只读**摘要（次关键词个数、选择逻辑、顺序、分组、粘性、冷却、概率、深度、位置、来源……），只列与酒馆默认值不同的项；没有任何 meta 的条目不显示这一行，也不提供编辑控件。

### 本轮不实现：probability / depth / position

触发概率 `probability`、注入深度 `depth`、插入位置 `position` 同样原样进 `meta`（`position` 的世界书数字形式与 V2 卡的 `before_char` 字符串形式都收），但本轮**不做语义**：概率不会掷骰，深度和位置不会改变注入点。它们属于后续打磨的部分，先保住数据不丢。

### 卡面 → Bot 头像

PNG 卡自带角色图。在 DS-Bot 详情抽屉的「上下文装配」页签里导入时，工具条多一个「把卡面设为 Bot 头像」开关（默认开）：卡面在浏览器里方裁到 256×256、按需从 PNG 降到 JPEG 质量，直到 data URL 不超过宿主的 160000 字符上限，再走 DS-Bot 自己的 `api/bot` → `update-bot`（`avatar: { shape, image }`，保留原有角色形状）。头像写失败不影响条目导入，摘要里单列一行「头像未更新：<原因>」。状态条弹出的工作台没有 Bot id，那里不显示这个开关；JSON 卡没有卡面，也不会写头像。

## Markdown 与媒体地址

世界书条目正文、Author's Note、故事笔记都是 Markdown 字段，编辑态是 textarea，预览态走完整渲染器：标题、强调、删除线、列表与任务列表、引用、围栏代码、表格、链接、图片、分隔线。渲染器是内联进 client bundle 的 marked 15.0.12（MIT）加 DOMPurify 3.4.17（Apache-2.0 OR MPL-2.0），零额外网络请求；它们输出 HTML 后必须过 DOMPurify 才进入 DOM。

图片地址按**页面语义**解析：`http(s):`、`data:image/`、`blob:` 原样保留；其它 scheme（含 `javascript:`、`file:`）降级成纯文本；绝对路径与相对路径都折算成绝对路径，再拼成 `/api/file?path=<encodeURIComponent(绝对路径)>`（session-controller 提供的文件路由），相对 `document.baseURI`。

- Bot 页面（状态条弹窗、详情抽屉）：cwd 是该会话的工作目录，也就是项目根。
- 没有会话支撑的页面（将来的全局设置页）：cwd 取上面的 `roots` 路由。

## 界面

1. **上下文状态条（ContextStrip）**：输入框上方常驻，显示纪元徽标、分段占比（系统工具 / 冻结前缀 / 活跃世界书 / 对话历史）、80% 压缩线与 95% 硬上限刻度、浮层明细；右侧只有一个扳手按钮，打开工作台。
2. **酒馆工作台（Tavern Studio）**：配置 / 心智 / 上下文 / 纪元 / 故事 / 沙箱六个页签，既能从状态条弹出，也能作为 DS-Bot 详情抽屉的「上下文装配」页签嵌入。
3. **配置页**：Bot 配置中心。左侧导航分两组：「Bot 专属配置」是日常设置的四个域，世界书（检索、新建、改名称与关键词、常驻开关、正文编辑、删除，以及从角色卡/世界书导入；导入条目的酒馆元数据在关键词下方以只读摘要行显示）、长效记忆（Hindsight 项目配置：记忆启用、默认记忆库、写入策略、召回条数与预览字符，带 revision 冲突提示）、能力与技能（该 Bot 已挂接的 MCP 与技能包，附管理入口）、定时任务（经 `/api/bot` 的 `schedules` 端点列出归属该 Bot 的任务，附定时任务页入口）；「隔离靶机与环境」画在虚线琥珀框里，只有沙箱靶机（切到工作台的沙箱页）与 Onlyne 节点（读 `onlyne://directory` 显示本节点、密钥指纹与在线节点，并可打开详情抽屉的「电脑」页）两项，不与日常设置混在一起。
4. **心智页**：Author's Note 编辑。
5. **上下文页**：全景分段条与「重建冻结前缀」。重建会归档当前纪元、把常驻条目写进 `frozenEntryIds`、纪元号递增，全部写回服务端。
6. **纪元页**：归档列表。
7. **故事页**：故事笔记本。
8. **电脑页与旁观窗口**：详情抽屉的「电脑」页签是数据驱动的：打开期间每 5 秒读一次 `onlyne://runner/workers`，先列出这个节点上运行中的 Worker（短 id、workUnit、state、machine，`reclaimAt` 存在时带自动回收倒计时），点一条就把它设为当前 Worker；`vm://` 的机器跟在后面，被点名 worker 的那台提到最前面（标「当前 Worker」）。Worker 与机器的对应关系只认 runner 自己给出的 `machine` 字段，不按机器名后缀猜；点了 worker 才能对它「全屏旁观」「关闭并回收」，未选中时插话按钮不可用并给出提示。关闭并回收只在新的 `vm://` 读数里该机器消失后才算完成，按钮在等待期间显示「回收中…」；聊天行上的同一动作只表示「已请求回收」。页签关闭（组件卸载）轮询即停。旁观窗口铺满整个窗口，里面是宿主路由当场签发的 noVNC 地址（每开一次签一次，地址只活在这个组件里），底部「请求介入辅助操作」向 worker 的 Onlyne 线程投一条 `review`，让它让出鼠标键盘。

   机器状态按 `desktop` 判断，不按 `state` 的字面猜：`desktop !== true` 且机器没结束时标签写「桌面初始化中」，并给出一条量级说明（本机实测约 100 秒；首次装桌面栈更久），这段时间「全屏旁观」「打开桌面」保持不可点，但机器本身已经在跑命令。`state === 'absent'` 照旧显示「已结束」。

9. **执行流页**：详情抽屉的「执行流」页签读 `onlyne://runner/issue/<workerId>/events`（`{ worker, state, events, truncated, note }`），把 `{ at, kind, role, text, tool, args, result }` 一条条按时间顺序画成只读时间线：模型文字原样换行，工具调用是「工具名 · 参数摘要」的折叠块，结果另起一个折叠块（参数与结果都能是整段文件，所以默认收起），`kind` 显示为中文小标签（指令 / 回复 / 推理记录 / 工具调用 / 工具结果）。runner 自己的提示与运行时上下文占满开头几行，所以 `kind: user` 的记录默认折叠成一行摘要。`note` 是中性状态行（例如 runner 还没建好会话时说「正在准备 Worker 的会话…」），不是失败。抽屉宽度只有两百多像素，所以工具条上有「全屏查看」，把同一份事件列表挂进铺满窗口的浮层，按 Escape 或「关闭」退出。打开期间每 2 秒轮询，切走页签即停。没有聚焦 Worker 时提示先去「电脑」页点一条；地址 404、或者文档里没有 `events` 数组，都按同一件事处理——显示「该 Worker 还没有事件流」加地址本身，不把传输层错误抛给使用者；`truncated` 为真时额外说明只显示最近 300 条、单字段只显示前 2000 字符。

聊天里出现 `onlyne://runner/issue/<id>`，或 Bot 交给 issue-runner 活时留下的「已发消息给 issue-runner」事件行，都会变成可点的 chip：点击即打开详情抽屉的「电脑」页签并把那台机器设为当前 Worker。聊天行仍由 DS-Bot 渲染，插件只在原地标记文本并代理点击，不接管行组件。

数据层只有一份：面板打开时按当前会话的 `cwd` 拉取文档，编辑留在本地草稿，保存走 POST。遇到 409，界面顶部显示冲突条，给出「重新载入」和「覆盖」两条路；覆盖是把本次编辑重新应用在新拉到的文档上，不是拿旧文档盖掉别人的改动。草稿不会因为冲突被丢掉。

状态条与详情抽屉各自解析自己的会话：`projectCwdOf(sessionId)` 读 `sessions.list` 快照里的 `byId[sessionId].cwd`。会话没有工作目录时，面板显示提示而不是猜测一个项目。

状态条上的四段只瓜分**已用** token：系统与工具优先读 `contextBreakdown` 的 `systemTokens + toolsTokens`，对话历史是剩余量；也就是四段之和等于已用，没占满的窗口显示为空槽。

## 只有宿主会话能把消息投进 Onlyne

`/api/paths` 把内部地址当脚本来服务，而 `onlyne://` 只接受「命中了一个挂着 Onlyne 节点的主机会话」的调用：不带会话名的写入当场被拒，报错原文是

```
onlyne:// POST needs a sender: run it from an agent session, pass ?session=<session id>, or set meta.from to a node id
```

所以本插件每一次 `onlyne://` 调用都带两样东西：

- 查询串 `&session=<会话 id>`，从 `localStorage['dsh.sessions.current']` 读。当前客户端写的是 `{"sessionId":"session-…"}`，旧版直接写 id 字符串，两种都认；解析不出来就不猜 id，只保留下一项。统一入口是 `pathsUrl()`。
- body 的 `meta.from: "urn:onlyne:agent:dsh"`，即这个页面的发送者身份。

关闭并回收（`close`）、请求介入、抽屉里的实时插话（`review`）三条路径都走这一套。插话还额外看响应状态：没成功就不清空输入框，而不是「消息没发出去、界面却当发出去了」。

## 层次

- `src/index.ts` — 宿主半边：注册 `project` 路由、`roots` 路由和 `tavern://` 内部路径源。
- `src/document.ts` — 文档形状、默认文档、读取时的形状校验（坏文档报错，不静默重置）。
- `src/store.ts` — 每项目一个文件的存储：路径哈希、按项目串行、临时文件 + rename、revision 冲突。
- `src/source.ts` — `tavern://` 的实现：路径语法、按 `cwd` 解析项目、读写各自对应的字段。
- `src/client/index.js` — 手写 module-loader factory；React 壳 + 面板 + 状态条 + 内联渲染器。

DS-Bot 的 `DetailsDrawer` 用 `h(pluginTab.component, { sessionId, subjectId, bot, room })` 渲染插件页签，所以 `TavernTab` 是 React 函数组件，内部用 `react-dom/client` 挂载（同 `omd-context-notes` 的模式）。

## 组合

`profiles/omd`（无 DS-Bot）只挂宿主壳；`profiles/omd-full`（含 `ds-bot` bundle）才看得到抽屉页签。内部路径需要 `omd-internal-paths` 在场；它不在场时插件只注册路由。

## 尚未做的部分

- Author's Note 的注入与提醒机制没有接：现在它只是被保存、可被 agent 读写，由 harness 决定何时注入。
- 「重建冻结前缀」只重写 `frozenEntryIds` 与纪元号，冻结集还没有真正进入模型请求的前缀。
- Token 数字仍是浏览器端的估算，界面标了 `~`。
- 纪元归档只记 `entries` 的名称与估算 token，没有存当时每条条目的正文快照。
- 服务端只校验文档形状，VDMSL 里的不变量（冻结集是 catalog 子集、单条 token 上限）留给装配器切片。
