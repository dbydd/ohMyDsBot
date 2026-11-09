# omd-github：GitHub internal path 源 + 写工具

范围：读走路径（三个源），写走工具（四个）。

上游只做了**入站**：`refs/deepseek-harness/packages/experimental/webhook-github` 用一个精确 HTTP 路由验签 GitHub webhook（`README.md:12,40`，HMAC + `X-GitHub-Delivery`，密钥走 credential ref、每请求重新解析），再交给 `ctx.webhookRuntime.dispatch()`；自带 `examples/github-review/` 规则，把 `pull_request.ready_for_review` 变成一次 Session（`github-ready-review-rule.mjs:16-64`）。**出站一个都没有**：`@octokit/webhooks` 只用于验签，不是 API 客户端；全仓无 `api.github.com` 调用点，issue、PR、文件、提交没有读路径，也没有任何写操作。本切片补齐出站；入站事件不归它管，两者不共享代码（一个推送，一个拉取）。

## 1. 地址语法

三个源名，均 `shorthand: true`（`plugins/omd-internal-paths/src/service.ts:32-33`）。`path` 原样到达源，含 `?`（`plugins/omd-internal-paths/src/parse.ts:4-7,17-18`），查询串由源自己切。

```
issue://<n>                      issue://<owner>/<name>/<n>      issue://<owner>/<name>
pr://<n>  pr://<n>/diff  /diff/<i>  /diff/all  /files  /commits  /checks      pr://<owner>/<name>/<n>[...]
github://<owner>/<name>                    仓库概况（默认分支、可见性、size）
github://<owner>/<name>/blob/<ref>/<path>  某 ref 下文件正文
github://<owner>/<name>/tree/<ref>/<path?> 目录清单
github://<owner>/<name>/commit/<sha>       提交 + 改动文件
github://<owner>/<name>/commits?ref=&limit=
```

消歧只看首段：首段全数字 = 号（`issue` 没有子选择器；`pr` 的第二段是 `diff|files|commits|checks`）；否则是 `owner/name`（列表/概况）或 `owner/name/<n>`（单条）。写法与 omp 的 `issue://`/`pr://` 一致，模型不必学第二套。

真实地址（今天用 `gh api` 逐条核对过）：

| 地址 | 解析 | 2026-10-22 实测 |
|---|---|---|
| `dsh-resource://issue/microsoft/TypeScript/1` | source=`issue`, path=`microsoft/TypeScript/1` | 标题 `Suggestion: 'protected' modifier`，state=closed |
| `issue://cli/cli` | source=`issue`, path=`cli/cli` | 仓库 issue 列表，按 updated 倒序 |
| `pr://cli/cli/1` | path=`cli/cli/1` | state=closed，base=`trunk`，head=`gh-pr` |
| `pr://cli/cli/1/diff` | 子选择器 `diff` | unified diff，100 行，只动 `command/pr.go` |
| `github://microsoft/TypeScript/blob/main/README.md` | ref=`main`, path=`README.md` | 2741 B，blob sha `79adc1b1…` |
| `github://microsoft/TypeScript/tree/main/packages` | 目录 | `typescript`, `vscode-typescript`, `vscode-typescript-nightly` |
| `github://cli/cli/commit/5056c0a8ef34512be1d5b4120d4e4b30412ada8b` | 提交 | merge 提交，正文两行 |

逐段拆一条：`dsh-resource://issue/microsoft/TypeScript/1` = 方案 `dsh-resource://`（规范形式，浏览器侧用它）+ 源名 `issue` + `<owner>` `microsoft` + `<name>` `TypeScript` + `<n>` `1`。`github://microsoft/TypeScript/blob/main/README.md` = 源 `github` + owner + name + 动词 `blob` + ref `main` + 路径 `README.md`；ref 可换 tag、分支或 sha。

渲染是给模型读的 markdown：首行 `#12 标题` + 一行 `state · labels · assignees · author · updatedAt · url`，空行，body，再跟最近 `?comments=<n>`（默认 5，`0` 关闭）的评论。PR 多一行 head/base、draft、mergeable、checks 汇总。缓存降级时首行追加 `（stale 42s）`，永不静默。`issue`/`pr` 声明 `live: false`：跟随会烧配额，界面按需重取。

结构化读面（`ctx.github`，只读方法挂 Remote）：

```ts
interface IssueRow { repo: string; number: number; title: string; state: 'open' | 'closed'
  stateReason?: 'completed' | 'not_planned' | 'reopened'   // 列表响应里直接有，实测 not_planned
  labels: string[]; assignees: string[]; author: string; updatedAt: string; url: string; isPull: boolean }
listIssues(q: { repo: string; state?: 'open'|'closed'|'all'; labels?: string[]; assignee?: string
  since?: string; query?: string; limit?: number; includePulls?: boolean })
  : Promise<{ rows: IssueRow[]; truncated: boolean; notModified: boolean; staleMs?: number }>
```

`state` 默认 `open`；**要看到关闭就必须 `state:'all'`**（关闭的条目在 `open` 列表里直接消失，无法与删除/转移区分）。`truncated` 为真表示 `per_page=100` 之外还有更多——调用方不得据此推断"条目消失"。`isPull` 由 `pull_request` 字段有无得出，`includePulls` 默认 false。`notModified` 表示这次条件请求吃了 304、`rows` 是缓存里同一份内容：调用方据此跳过 diff，但**拿不到也不需要 ETag**（ETag 归 client，不外泄，避免调用方自己发条件请求绕过单飞与水位）。

`repo`/`n` 相对形式需要 cwd，而 `InternalExec` 只有 `signal`（`plugins/omd-internal-paths/src/service.ts:22-26`）。已与 ProcUriPlan 协同：`InternalExec` 统一扩成 `{ signal?: AbortSignal; agent?: Agent; cwd?: string }`（`omd-read:221` 已解析出 cwd，直接下传；proc 源用 agent，github 相对寻址用 cwd）。无 cwd（浏览器预览、定时任务）时相对地址直接报错，不给默认仓。

## 2. 后端：REST + 全局 fetch，不包 `gh`

选择理由落在错误面上，不在"少写代码"上。今天在本机实测的两种后端失败形态：

- `gh`（已登录本机）在 `GH_CONFIG_DIR` 指向空目录后直接失能：`gh: To use GitHub CLI in automation, set the GH_TOKEN environment variable.`，退出码 4；换个无效 token 则是 `gh: Bad credentials (HTTP 401)` 但**退出码 1**，与 404（`gh: Not Found (HTTP 404)`，同为 1）和网络失败同码。要分 401 / 403 限流 / 私有仓无权，只能正则 stderr 文本。
- REST 直接给结构化判别：401 → `{"message":"Bad credentials",…,"status":"401"}`；404 → `{"message":"Not Found",…}`；未认证超额 → 403 且 `API rate limit exceeded for 45.149.92.7 …`；认证后超额 → 403/429 且 `x-ratelimit-remaining: 0`，重置时间在 `x-ratelimit-reset`（epoch 秒），二级限流另带 `retry-after`。

结论：HTTP 直接用 Node 全局 fetch（上游自己也这么干：`packages/boot/plugin-market/src/index.ts:270`），`gh` 只作为可选的 token 来源（`tokenSource: 'gh-cli'`），不是运行时依赖——`gh` 未安装时默认路径不受影响。凭据走 `ctx.credentials`，而 `gh` 的登录态是环境里的隐式状态，一次 `GH_CONFIG_DIR` 偏移就整体失能，正是上面那条实测。

GraphQL 明确否决：POST-only 无 ETag（本设计的一半收益来自 304 不计配额），限流点数是另一套模型，错误面也要再写一遍。搜索也不做（搜索端点 30/min，代码搜索 10/min，是独立配额与独立源），需要时另开一个源。

## 3. 凭据

`tokenRef`（默认 `GITHUB_TOKEN`）→ `ctx.credentials.resolve(credentialRef(...))`，**每次操作重新解析**，不跨操作缓存（`packages/credentials/credentials/src/index.ts:176-184`）。这一层已含四层来源，顺序是存储文件优先：`$DSH_HOME/.credentials.yaml` > 继承的进程环境 > cwd `.env` > `$DSH_HOME/.env`（`credentials-local/src/index.ts:2-10`），所以不另造读取器。配置面板要显示"已配置 / 来源 / 可写"时用同服务的 `describe()`（`index.ts:186-192`），它跨 Remote 传输也不含值。键名不沿用 webhook 那边的 `secretEnv`（那是 webhook secret，不是 API token），也不硬凑 hindsight/memory 的 `apiKeyRef`。

未配置时抛 `GithubError{kind:'unconfigured'}`，消息写明三件事：引用名、上面四层的位置、以及 `gh auth login` + `tokenSource:'gh-cli'` 这条可选路。**不发任何 HTTP**，因此"没 token"永远不可能呈现为空列表或 0 条 issue。`tokenSource:'gh-cli'` 时执行一次 `gh auth token`，结果缓存到 `credentials/reference-updated` 事件为止。所有错误消息与日志都不含 token 值。

## 4. 写工具（四个，全部 `defineTool` 注册）

| 工具 | 最小参数 | 端点 |
|---|---|---|
| `github_comment` | `number`, `body`；`repo?` | `POST /repos/{o}/{r}/issues/{n}/comments`（issue 与 PR 共用） |
| `github_issue_open` | `title`, `body`；`repo?`, `labels?`, `assignees?` | `POST /repos/{o}/{r}/issues` |
| `github_issue_update` | `number` + `state?`/`labels?`/`assignees?` 至少一项；`repo?` | `PATCH /repos/{o}/{r}/issues/{n}` |
| `github_pull_open` | `title`, `head`, `base`；`repo?`, `body?`, `draft?` | `POST /repos/{o}/{r}/pulls` |

`repo?` 缺省取 `repoBinding(cwd)` 的 `bound.slug`；`unbound` 时报错并给出两个修法（见 §7）。工具名用普通词，不用 `gh_*`/`xd_*` 之类自造前缀。这四个工具只注册到工具面，不挂 Remote：浏览器侧能做的只有读。

绝不自动做：不 close（`state:'closed'` 只在该轮用户明确要求时由模型传入，工具不做任何隐式状态迁移，也不"评论后顺带关闭"）、不 merge、不 approve、不 request reviewers、不 push 分支或写仓库文件、不建/删仓库、不改设置与 webhook、一次调用只动一个对象（不做批量）。写请求不缓存、不自动重试：POST 在网络层失败时报 `outcome unknown` 并附上人工核对地址，重发可能双发评论。

## 5. 缓存与限流

- 键 = `METHOD + url + Accept`，不含 token（单进程单身份）。条目存 `{etag, body, fetchedAt, klass}`。
- 三档：不可变（blob sha、commit sha、按 head sha 取的 diff）会话内不重取；半可变（单条 issue/PR、仓库概况）默认 60s `cacheTtlMs`；列表 30s。两者都带 `If-None-Match`，304 时刷新 `fetchedAt`——按 GitHub 文档，正确认证的 304 不计入主配额，这是省配额的主机制。
- 单飞：同 url 的在飞请求共享一个 promise，界面预览与模型读同一地址只花一次配额。
- 水位：跟 `x-ratelimit-remaining`，低于 `rateFloor`（默认 100）或收到 403/429 时，半可变与列表档直接读缓存并在输出首行标 `stale`，不重试、不在 `x-ratelimit-reset` 前重发。不回退到未认证请求（60/h，且私有仓全 404）。
- 不缓存写请求与任何错误响应；响应体 > 1 MiB 不入缓存但仍返回。
- `blob/` 用 `Accept: application/vnd.github.raw+json`（1–100 MiB 可用；>100 MiB 明确报错），`tree/` 用 `object+json` 取 `entries`；目录超过 1000 项时报错并指出要用 Git Trees API。

## 6. 实施切片

1. `plugins/omd-github/{package.json,src/config.ts,src/errors.ts,src/client.ts}`：fetch 封装、`GithubError` 五种 kind、ETag/TTL/单飞/水位。
2. `src/sources/{issue,pr,repo}.ts` + `src/render.ts` + `src/index.ts`：注册三个源，发布 `ctx.github`（`resolveRepo`/`listIssues`/`getIssue`/`listPulls`/`getPull`/`getFile`/`getTree`/`getCommit`/`getDiff`）并只把读方法挂 Remote。
3. `src/tools.ts`：四个写工具。
4. `plugins/omd-internal-paths/src/service.ts`：`InternalExec` 扩展（`agent?` + `cwd?`）；`plugins/omd-read/src/index.ts` 接入 `ctx.internalPaths` 并下传 agent 与 cwd；`profiles/omd/cordis.patch.yml` 补齐 `omd-internal-paths` 插件条目。
5. `docs/omd-project-config.md`：加入 `repo.slug`（归 RepoBindingPlan）；本插件不读 `.omd/config.json`。

验收：`dsh --profile omd --dump-config` 退出码 0、stderr 空；在会话里对上面 7 个地址各 `read` 一次，与 `gh api` 同资源输出对比（标题/state/sha/文件行数一致）；对同一地址连读两次，第二次日志显示 304 且 `x-ratelimit-used` 不变；清空 `GITHUB_TOKEN` 后读 `issue://12` 必须报 `unconfigured` 而非空结果；把 `rateFloor` 调到 `999999`（第一次读之后水位必低于它），第二次读同一地址首行必须出现 `stale`——这条同时验证降级路径和标记不被吞。

## 7. 风险

1. `InternalExec` 的 `agent?`/`cwd?` 是跨切片共享接口（§6 第 4 步与 proc 源同一处改动）：不同步改 `omd-read`，相对地址就只剩报错一条路（全限定地址始终可用，功能不崩）。
2. ref 含 `/`（`feat/x`）时 `blob/` 的首段切分有歧义：404 时按另一种切法重试一次，两次都 404 才报错；分支名恰好叫 `blob`/`tree` 时与动词冲突，报错文本说明可用 commit sha 规避。
3. 水位逻辑判断失误会有两种坏结果——烧配额或长期吃旧数据。唯一防线是"降级必标注 stale"，所以 `stale` 标记不是装饰，任何路径都不得吞掉它。
