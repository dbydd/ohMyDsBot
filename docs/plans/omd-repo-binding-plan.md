# 仓库绑定：`repo.slug` 与 github 源的取用约定

目标：一个项目根绑一个仓库，绑定作为项目级配置的一项；面板、github 源、issue 监听读同一份。`[观察]` = 代码/命令读到的事实，`[推断]` = 我的判断。

## 0 结论

| 问题 | 结论 |
|---|---|
| 字段形状 | 不是 `{ provider, owner, name, defaultBranch? }`。只要一个叶子 `repo.slug`，语法 `[<host>/]<owner>/<name>` |
| 多仓库 | 不做。子模块与多 checkout 各自是独立项目根，天然各绑各的 |
| 来源 | 存储值（个人层 > 仓库文件）> origin 推导 > 未绑定；推导不落盘、不用网 |
| 消费 | `ctx.get('projectConfig')?.repoBinding(cwd)`；`resolve()` 只给存储值，不 spawn git |
| 校验 | 格式在写入与层加载时；仓库是否存在在首次使用时 |

- `provider` 与 `owner`+`name` 的拆分都去掉：只有一个 provider 时它是一张单项下拉，还要给客户端加一种 kind；后半段没有各自语义，拆开会让层文件出现"有 owner 没 name"的半绑定、面板多一行、`write`/`clear` 多一种部分状态，而 origin 推导本来是一次原子写入。第二个 provider 用自己的 section（`gitlab.slug`），section 名就是 provider。`defaultBranch` 同样不存：它是仓库元数据，API 的 repo 响应自带 `default_branch`；进配置就是第二个真相，改名后静默过期。
- 多仓库不做的依据：`external-plugins/dsh-motion-ui` 是子模块，在它里面 `rev-parse --show-toplevel` 返回子模块目录本身，于是它是独立项目根、独立绑定。临时读别的仓库用完整地址显式寻址。

## 1 证据

- 闭表与合成：`plugins/workbench/omd-project-config/src/schema.ts:33`（`configLayerSchema`，`.strict()`）、`:58`（`FIELD_PATHS`）、`:70`（`FieldKind`，无 select/enum）、`:184`（`resolveFields`，纯函数无 I/O）、`:210`（`mergeLayer`）、`:253`（`kindOf`）；项目根与层：`src/store.ts:40`（`rev-parse --show-toplevel`，失败退 cwd）、`:96`（按 mtime 缓存层）、`:22`（`run = promisify(execFile)`，读 origin 复用）。
- 服务面：`plugins/workbench/omd-project-config/src/service.ts:97`（`REMOTE_METHODS`）、`:122`（`resolve(cwd)`）、`:153`（`write` 先过 zod）、`:212`（`composite`）。
- 面板由 schema 驱动：`plugins/workbench/omd-project-config/src/client/index.js:258`（`buildPatch` 按 kind）、`:285`（`FieldControl`）、`:429`（按 `path.split('.')[0]` 分组，标题 `group.<name>`）、`:162`（手写 descriptor）、`:220`（入口拿 Workspace 路径，与 `docs/omd-project-config.md:59` 一致）。
- 消费方缺 cwd：`plugins/host/omd-internal-paths/src/service.ts:25-28`，`InternalExec` 只有 `signal`；而 `omd-read` 已经算出了它（`plugins/host/omd-read/src/index.ts:221`）。统一契约（与 proc 侧对齐，一次加完）：`agent?: Agent`（proc 按 agent 围栏）+ `cwd?: string`（绑定/库发现只要目录，免得每个源都自己 `ensure`）；两个都可缺，缺了就按"相对地址不可解析"报。

## 2 字段形状

```ts
repo: z.object({ slug: repoSlug.nullable().optional() }).strict().optional(),   // schema.ts
// repoSlug = z.string().min(3).max(160).refine(v => parseRepoRef(v) !== undefined,
//                                             { message: 'expected "[host/]owner/name"' })
```

- `FIELD_PATHS` 首位插 `'repo.slug'`（分组顺序跟 schema 顺序，仓库身份排在记忆/委派/角色之前）；`kindOf` → `'string-or-null'`（复用现成控件）；`defaultLayer` 加 `repo: { slug: null }`；`mergeLayer` 复制 `repo` 段；`deleteField` 不改（段空即删已是通用逻辑）。`repo.ts` 不得 import `schema.ts`（schema 要 import 它），保持零依赖纯函数。
- storageDomain 不升版：新键可选，旧记录缺 `repo` 仍合法；反向不成立——收紧语法会让旧记录在读取时被拒，所以语法只能放宽。

## 3 来源、优先级与退路

链：`个人层 → <root>/.omd/config.json → git remote get-url origin → 未绑定`。推导全程离线（只读 `.git/config`）。默认主机不落盘：`github.com/o/n` 归一成 `o/n`，由读它的源用自己的 host 补全，团队提交的文件因此可移植；GHE 显式带主机。真实取值：

| 输入 | 结果 |
|---|---|
| `https://github.com/deepseek-ai/deepseek-harness.git`（`refs/deepseek-harness`） | `deepseek-ai/deepseek-harness` |
| `https://github.com/Scorp1o117/dsh-motion-ui.git`（子模块） | `Scorp1o117/dsh-motion-ui`，owner 大小写照抄 |
| `git@github.com:o/n.git`、`ssh://git@github.com:22/o/n.git` | 同上；scp 语法与端口都要认，端口丢弃 |
| `https://user:token@github.com/o/n` | 凭据丢弃，且不进 `detail`/日志 |
| `git@github-work:team/infra.git`、`/tmp/mirror.git`、`file:///…` | 不可解析：ssh 别名没有点、本地镜像没有身份 |
| `https://ghe.corp.example/team/infra.git` | `ghe.corp.example/team/infra`，钉住主机 |

- 无 remote / 非 git 目录 / 不可解析 → 未绑定 + 原因，**不抛错**，手填永远可达。本仓检出没有 remote，界面显示 `no-origin` 是常态而非错误。保存时也不校验仓库存在：`write` 是一次 patch，网络失败会连带挡住无关字段，且配置插件里没有 token——存在性由源在首次读取时报，错误里带它解析到的 `host/owner/name`。

## 4 接口

```ts
// 新 remote 方法 repoBinding(cwd, { fresh? })
type RepoBinding =
  | { kind: 'bound'; slug: string; host: string | null; owner: string; name: string
      source: 'user' | 'repo' | 'origin' }
  | { kind: 'unbound'; reason: 'no-git' | 'no-origin' | 'unparsable-origin'; detail?: string }
```

`host === null` = slug 没钉主机（`o/n` 形态），由读它的源用自己的 host 决定 apiBase；非 null 只在用户写了 `host/o/n`、或 origin 的主机不是默认值时出现，因此 `source:'origin'` 也可能给出 `host: null`。`fresh: true` 绕过 origin 缓存，`invalidateCaches()` 一并清。

1. `repoBinding('refs/deepseek-harness')` → `{kind:'bound', slug:'deepseek-ai/deepseek-harness', host:null, owner:'deepseek-ai', name:'deepseek-harness', source:'origin'}`
2. `repoBinding('.')`（本仓根，无 remote）→ `{kind:'unbound', reason:'no-origin'}`
3. 个人层写 `{"repo":{"slug":"deepseek-ai/deepseek-harness"}}` 后同一 cwd → `source:'user'`；此后 origin 改成自己的 fork 也不改结论（fork 检出钉上游正是用途），而 `repoBinding('external-plugins/dsh-motion-ui')` 仍各自解析出 `Scorp1o117/dsh-motion-ui`、`source:'origin'`

## 5 消费与错误文案

github 源的地址语法由它自己定，这里只约定取绑定：`await ctx.get('projectConfig')?.repoBinding(cwd)`；服务不在场时退化为"只支持完整地址"。相对地址（`issue://12`、`pr://12`）查绑定，完整地址（`issue://owner/name/12`、`github://owner/name/…`）不查。issue 监听与 `@` 触发都从这里取仓库，它们的开关（是否轮询、间隔、过滤）属于 issue-watch 的字段行，不进 `repo.*`，绑定保持"一个事实"。错误必须单句、带实际取值、给两条出路：

1. 未绑定：`cannot read "issue://12": <repo root> has no GitHub binding (origin is not set). Set repo.slug in Project settings, add {"repo":{"slug":"owner/name"}} to .omd/config.json, or read issue://owner/name/12.`
2. 不可解析：`…: origin is "git@github-work:team/infra.git", which is not a host/owner/name remote (ssh alias?). Set repo.slug explicitly.`
3. 主机不符：`…: the binding names host ghe.corp.example but this source is configured for github.com. Fix the binding or the omd-github host config.`；404 单独一句：`GitHub 404 for owner/name: the repository does not exist, or the configured token cannot see it.`

## 6 面板

- `repo` 组自动出现（schema 驱动），一行文本框。把 `'string-or-null'` 分支里硬编码的 `t('bank.placeholder')`（`client/index.js:308`）改成 `t(\`field.${spec.path}.placeholder\`)，新增 `field.repo.slug.placeholder = "owner/name（默认 github.com）"`；descriptor 加 `descriptor('repoBinding', [{ name: 'cwd' }, { name: 'options', optional: true }])`，与 `REMOTE_METHODS` 同步。
- 组内加一行状态，数据来自 `repoBinding`（与 `schema`/`resolve` 并行拉）：未存储但 origin 可解析 → `origin: github.com/o/n` + `[使用]`（点击只改草稿，保存才落盘）；已存储且与 origin 不同 → `[按 origin 覆盖]`；未绑定 → 一句原因。面板只写个人层、不写 `.omd/config.json`（`store.ts:1-8` 的既有不变量）：写仓库文件会弄脏工作树，且无法与提交原子完成。团队共享 = 有人提交那一行，面板会显示"来自仓库文件"。不做"存在性校验"按钮：那要 config 插件依赖 github 源并联网，违反可选服务约定，而首次读取的错误已经够用。

## 7 校验与归一

- 段语法：owner `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`；name `^[A-Za-z0-9._-]{1,100}$` 且不是 `.`/`..`；host 必须含点（排除 ssh 别名）。只当"打字错误捕手"，最终裁决是 API。
- 归一：host 转小写（DNS 不区分，也是唯一比较基础）；owner/name **保留原样**（`Scorp1o117` 不该被改写），相等判断与缓存键用 `toLowerCase()`；去尾部 `/`、`.git`、凭据、端口；`github.com` 前缀不落盘。格式校验走 zod refine，`write` 与两层加载共用同一 schema，坏值报文件路径 + 键（`parseFile` 已有形态）；存在性在首次使用，404 同时意味"不存在"与"无权访问"，文案必须两者都说。

## 8 实施切片

1. `plugins/workbench/omd-project-config/src/repo.ts`（新）：`parseRepoRef`、`parseRemoteUrl`、`normalizeSlug`、`redactUrl`。
2. `plugins/workbench/omd-project-config/src/schema.ts`：`repo` 段 + refine、`FIELD_PATHS` 首位、`kindOf`、`defaultLayer`、`mergeLayer`。
3. `plugins/workbench/omd-project-config/src/store.ts`：`originUrl(root, fresh?)`，按 root 缓存，`invalidateCaches()` 清。
4. `plugins/workbench/omd-project-config/src/service.ts`：`repoBinding` + `REMOTE_METHODS` 加一项。
5. `plugins/workbench/omd-project-config/src/client/index.js` 与 `docs/omd-project-config.md`：locale（`group.repo`、`field.repo.slug*`）、descriptor、状态行与两个按钮、placeholder 泛化；文档补字段表一行、`repoBinding` 三态、优先级、错误文案。
6. 跨包（不属本切片，由 `omd-read` 迁移那一片一次做完）：`InternalExec` 同时加 `agent?: Agent` 与 `cwd?: string`，`omd-read` 把已算出的两者传进 `internalPaths.read`；此前相对地址在有会话时不可用。

验收：

```sh
cd refs/deepseek-harness && node --import tsx/esm --input-type=module -e '
const m = await import("<repo root>/plugins/workbench/omd-project-config/src/repo.ts")
for (const s of ["https://github.com/deepseek-ai/deepseek-harness.git","https://github.com/Scorp1o117/dsh-motion-ui.git","git@github.com:o/n.git","ssh://git@github.com:22/o/n.git","https://user:token@github.com/o/n","git@github-work:team/infra.git","/tmp/mirror.git","https://ghe.corp.example/team/infra.git"]) console.log(s, "->", m.parseRepoRef(s))'
dsh --profile omd --dump-config   # 退出码 0、stderr 空（不改 profile）
```

界面：本仓根打开面板 → `repo` 组显示"未绑定 · 没有 origin"；`refs/deepseek-harness` 的 cwd → 显示 origin 推导值 + `[使用]`；点它并保存 → 来源变"来自个人覆盖"；填 `ghe.corp.example/x/y` 保存成功；填 `github-work:x/y` 报 `expected "[host/]owner/name"`；手写坏 slug 到 `.omd/config.json` → 面板错误带文件路径。

## 9 风险

1. fork 检出上 origin 指向 fork：存储值优先、面板显示生效来源；残留问题是消费方静默用了 fork 的名字——要求源的错误与 issue 列表抬头回显它解析到的 `host/owner/name`。
2. `git` 不在 PATH → `no-git`，手填仍可用；`repoBinding` 未命中缓存时 spawn 一次 git，所以推导不进 `resolve`（`resolve` 每轮都可能被调）。
3. 层里坏 slug 会让该项目的每次 `resolve` 抛错（与坏 JSON 同待遇，loud by design），对不关心 repo 的消费者也是硬失败。要软化只能降级成"未绑定 + 诊断"，不许静默忽略。
