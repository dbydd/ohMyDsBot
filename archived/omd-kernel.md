# omd kernel：只有后端的内核

## 一句话

`omd` 内核是一份 dsh 组合：agent 运行时加上一条机器接口（stdio JSON-RPC），
没有任何人类界面。它在 `profiles/omd-kernel/`，可以启动、可以跑完一个真实回合；
它为什么是对的，写在 `proof/` 的 Lean 里。

## 组合是什么

两个 bundle：

| bundle | 贡献 |
|---|---|
| `@deepseek-ai/dsh-base` | 模型适配器、会话日志、工具注册表、文件系统与沙箱、子进程、子代理、压缩、溢出存储 |
| `@deepseek-ai/dsh-sdk-app` | `sdk-app-startup`（零参数命令提供者）与 `sdk-jsonrpc-server`（stdio 上的 JSON-RPC 服务） |

`@deepseek-ai/dsh-web-app` 整层不进组合：没有 webserver，没有 client modules，
没有浏览器外壳。`dsh --profile omd-kernel --dump-config` 共 100 行：76 行启用，
6 行按平台或环境条件启用，18 行显式关闭。

关闭的行分三类，理由只有一条：内核里没有人的位置。

| 类别 | 行 | 为什么关 |
|---|---|---|
| 人机协商 | `user-questions` `commands` `command-feedback` `command-compact` `command-goal` `plan-mode` `approval` `permission` | 这些行要一个人打字、点评或点头才能得到答复。关掉之后，需要人批准的工具调用会失败而不是等待 |
| 给人看的装饰 | `settings` `config-editor` `session-title` `session-title-llm` `plugin-manager` `tool-plugin-manager` | 面板、标题、组合编辑页都属于界面，内核没有界面 |
| 本机绑定 | `llm-pi-ai` `deepseek-account` `llm-deepseek-account` | 前者的路由读 `$DSH_HOME/models.yml`，后两者要浏览器里走完的登录。内核不带只在一台机器上成立的取值：模型路由由客户端在 `initialize` 里给出 |

`hmr` 由 sdk-app 组合关闭（`patchReload: startup`）：一个 stdio 对端不该在中途
看见插件树被替换。`sdk-app-startup` 的 `config.profile` 被改成 `omd-kernel`，
否则它会在自己的 `--help` 里冒充 `sdk`。

## 唯一的对外接口

stdio 上每行一帧的 JSON-RPC 2.0。七个请求，四个通知：

| 方向 | 方法 | 作用 |
|---|---|---|
| 客户端 → 内核 | `initialize` | 就绪边界：等整棵插件树 settle，再校验 provider / model（可选 `reasoningEffort`、`maxTokens`），返回 `serverInfo` |
| | `session/prompt` | 入队一条用户消息，立刻回 durable 回执 `messageId`；它不是回答 |
| | `session/resume` | 按 id 恢复一份已持久化的会话 |
| | `session/wait` | 等这个会话与它托管的子代理跑完 |
| | `session/working-directory/get` / `set` | 读写会话的工作目录 |
| | `shutdown` | 回 `{}`，随后卸载整棵树并退出 0 |
| 内核 → 客户端 | `session.event` | 每一个 durable 会话事件 |
| | `session.status` | `running` / `idle` |
| | `subagent.started` / `subagent.finished` | 子代理起止 |

三条边界值得单独说。stdout 只放协议帧，诊断走 stderr，所以内核里不能挂 stdout
日志插件。模型密钥不进 profile：`ctx.credentials` 按请求解析，本机取值留在
`~/.dsh/.credentials.yaml` 或环境变量里。`initialize` 之前 `session/prompt` 会被拒，
因为路由要到握手时才确定。

## 它确实能启动

接了这条接口之后，内核不是"跑不起来所以只能证明"：

- `--dump-config` 组合出 100 行，stderr 为空。
- `--help` 直接打印自己的名字和用法并退出。
- 从 stdin 喂一条 `shutdown`：回 `{}`，退出 0，stderr 为空——没有任何 entry
  "did not activate"。
- 一个真实回合：`initialize` → `session/prompt` → `session.event` 流
  （`turn/start`、`system/message`、`user/message`、`request/header`、
  `request/context`、`assistant/attempt`、`turn/end`）→ `session/wait` →
  `shutdown`，退出 0，全程 stderr 为空。

命令与逐条输出的记录在 `artifacts/kernel-verify/session.md`。

## 那为什么还要形式化

一次运行看不到四件事：在这台机器上处于休眠分支的行，平台相关的行，卸载顺序，
以及没人试过的挂载顺序。这四件正是内核成立与否的地方，所以论证从代码开始，
分三层。

**第一层，dsh 自己的代码。** 每个 Lean 文件对应一个源文件，文件头的 docstring
写明抽象了哪部分、什么被有意留在模型外。

| Lean 文件 | 源文件 | 证到的关键结论 |
|---|---|---|
| `Omd/Cordis/Effect.lean` | `vendor/cordis/src/context.ts`、`fiber.ts` | 注册与卸载是一个栈：良构的程序按逆序卸载后回到原状态（`unwind_restores`），后注册的先卸载（`unwind_order_is_reverse`） |
| `Omd/Cordis/Fiber.lean` | `vendor/cordis/src/fiber.ts`、`reflect.ts` | 激活由 `inject` 门控：需求没被满足的行永不激活（`pending_never_activates_unsatisfied`）；有秩见证时闭包恰等于启用集（`closure_stable`）；任何公平调度得到同一个集合（`schedule_reaches_closure`、`maximal_schedules_agree`） |
| `Omd/Cordis/Registry.lean` | `vendor/cordis/src/registry.ts`、`service.ts`、`reflect.ts` | 一个键只能有一个实现（`register_duplicate_fails`）；`get` 与调用者无关（`get_independent_of_caller`），属性代理只沿祖先链（`sibling_hidden_from_proxy_visible_to_get`） |
| `Omd/Cordis/Dispatch.lean` | `vendor/cordis/src/events.ts` | 五种派发：全委派时 waterfall 返回原值、不调 `next` 就短路、`serial` 按注册顺序、`bail` 首个非 `none` 决定、`prepend` 先跑 |
| `Omd/Dsh/Session.lean` | `packages/core/session/src/index.ts` | 日志只追加（`append_preserves_prefix`）、序列严格递增且可保持、可见事件相同的两份日志装配出同一个请求（`assemble_congr`）、替换恰好遮蔽列出的序号（`replace_hides_exactly`）、一步消费的模型输入都出现在日志的可见事件里（`step_inputs_logged`） |
| `Omd/Dsh/Tools.lean` | `packages/core/tools/src/index.ts` | 最近作用域胜出（`nearest_scope_wins`）、同层重名被拒（`duplicate_same_scope_rejected`）、遮蔽只影响该作用域及其后代（`shadowing_is_scoped`）、守卫一旦拒绝不可被后续阶段翻回（`guard_denial_irreversible`） |
| `Omd/Dsh/Prompt.lean` | `packages/core/system-prompt/src/index.ts` | 提示段落按作用域合并，近层覆盖（`nearest_layer_wins`）、缺失的段就是缺失（`absent_section_is_absent`）、同层重名被拒（`duplicate_in_layer_rejected`） |
| `Omd/Dsh/Request.lean` | 同上，加 `packages/core/tools/src/index.ts` | 请求里的工具名恰好是注册表在该作用域暴露的集合（`toolsFrom_is_registry_projection`）、`restrict` 只删不加（`restrict_only_removes`）、近层同名的工具体胜出（`nearer_body_wins`）、请求的每一部分都有来源（`request_parts_are_sourced`） |

**第二层，真实组合的数据。** `proof/scripts/extract.mjs` 读
`dsh --profile omd-kernel --dump-config` 的结果，逐包解析模块得到服务的提供者与
需求（`super(ctx, "key")`、`ctx.provide("key", …)`、跨包 `extends` 链），产出
`proof/Omd/Kernel/Generated.lean`：100 行的 `provides` / `requires` / 守卫条件、
依赖图的拓扑序、以及三个由启动器提供的键（`loader`、`cmdlineArgs`、`profileContext`）。
两次运行产物逐字节相同。

这条管道换掉了原先按 `docs/capability-seams.md` 表格推 `provides` 的做法，因为
那张表既少又滥：少记了 `pwsh-sandbox` 提供 `shell`（Windows 上 `tool-pwsh` 因此
没有提供者），把注册进别人的注册表也当成提供了那个键（`subagent-spawn-in-process`
看起来提供了它自己需要的 `subagents`）。现在的 `provides` 只认代码里的注册点。

**第三层，数据接到理论上。** `proof/Omd/Kernel/Spec.lean` 写谓词，
`proof/Omd/Kernel/Composition.lean` 把拓扑序变成激活定理要的秩见证（启动器提供的
键在模型里是显式的合成行，所以"由行提供"和"由启动器提供"不会混为一谈），
`proof/Omd/Kernel/Facts.lean` 用 `decide` 把九条谓词落到具体数据上：组合没有悬空
需求、拓扑序合法且覆盖全部行、每个启用行激活到 `active`、一个键只有一个提供者、
没有面向人的行、没有本机绑定的行、接口行全部在场。哪条 `decide` 失败，构建就在
哪条失败——那是组合变了的通知，不是证明的失败。

## 证了什么

对 `omd-kernel` 这份组合，在非 Windows、无 authoring runtime 的环境赋值下：

1. **没有悬空的需求。** 每个启用行的每个需求，都由某个启用行或启动器提供。
2. **没有待死的行。** 拓扑序给出秩见证，所以每个启用行都会激活到 `active`：
   挂载顺序不改变结果。
3. **一个键只有一个提供者。** 组合里没有两个启用行提供同一个服务键。
4. **没有人面向的行被启用。** 那 14 个 id 全部不在启用集里。
5. **没有本机绑定的行被启用。** `llm-pi-ai`、`deepseek-account`、
   `llm-deepseek-account` 全部关闭。
6. **接口在场。** `sdk-app-startup`、`sdk-jsonrpc-server` 以及它们依赖的
   `agent`、`agent-loop`、`session`、`llm`、`tools`、`system-prompt` 都在启用集里。
7. **模型可见的输入都能从日志重建。** 装配只读日志，所以同一段可见事件永远装配
   出同一个请求；一步消费的输入必然已经作为可见事件落盘。

第 1 到 6 条是 `proof/Omd/Kernel/Facts.lean` 里的九个定理（`kernel_closed`、
`kernel_covers`、`kernel_topo`、`kernel_disjoint`、`kernel_stratified`、
`kernel_no_pending`、`kernel_no_pending_status`、`kernel_unique`、
`kernel_no_human`、`kernel_no_machine`、`kernel_interface`），全部由 `decide`
对生成数据检查；第 7 条是 `proof/Omd/Dsh/Session.lean` 的
`assemble_congr` 与 `step_inputs_logged`，是关于装配函数的结构定理，不依赖
具体组合。

## 假设与边界

- **平台赋值。** 事实在一个固定赋值下检查：`win32 = false`，两个 authoring
  runtime 的原子为假。Windows 分支的行（`pwsh-sandbox`、`tool-pwsh`）存在且
  对称；换平台就重跑抽取脚本、重新检查，不是把结论搬过去。
- **`profileContext` 由启动器提供。** 组合里 `plugin-manager`、`hmr`、
  `config-editor`、`settings` 的守卫是 `!ctx.get('profileContext')`，模型把它
  读成 `.never`（启动器总会提供该服务）。这一条是假设，写在 `Generated.lean` 的
  `external` 里，不是隐式约定。
- **`provides` / `requires` 是静态读出来的。** 运行期由配置或闭包计算出来的
  注册点看不出来；`ctx.inject(…)` 之后才建立的依赖也不在模型里。
- **事件词表没有证。** 哪些事件类型合法是一张生成出来的表，`Session.lean` 只把
  "未知类型被拒"当作契约用。
- **异步、超时、取消、遥测、权限**没有进模型：它们不改变服务图与日志的结构，
  但会改变单次调用的时序。
- **卸载只证到顺序与恢复。** `Effect.lean` 证良构程序逆序卸载可复原；
  `Fiber.lean` 只证单向激活，不证卸载后重挂。
- **模型本身的行为不在论证范围。** 证的是运行时结构：谁提供什么、什么必然激活、
  什么必然落盘。

## 怎么重跑

```sh
cd proof
node scripts/extract.mjs     # 重抽组合事实，写 Omd/Kernel/Generated.lean
lake build                   # 检查全部定理
lake env lean checks/axioms.lean   # 确认没有 sorryAx
```

改组合之后 `extract.mjs` 会自己报告：改变了 `provides` 的行、没有提供者的需求、
自环、以及每个赋值下的闭包检查。它退出非零就说明组合本身有问题，不是脚本的问题。

## 下一步：我们自己的插件

内核现在是空的 omd 层——一个插件都没挂。挂之前先把契约写下来，写在
`Omd/Plugins/Contract.lean`：

1. 声明的每个 `inject` 都由组合提供（`depsClosed`）。
2. 每个注册都通过 `ctx.effect` / `ctx.on`，可卸载（`allReversible`），且一个插件
   对同一目标只注册一次（`distinctTargets`）。
3. 模型可见的内容要么是注册表拥有的 schema，要么有会话事件支撑
   （`modelVisibleIsLogged`）。
4. 宿主半边不 import 客户端半边（`clientStaysOut`）。
5. `Config` 默认值不绑定任何一台机器（`machineFree`）。

配套的定理是 `mount_preserves_closed`：组合原本没有悬空需求，新挂的行需求已被
满足，那么挂上之后仍然没有。于是插件可以一个一个挂、一个一个检查，而内核的结论
不会在挂载过程中失效。这套契约要先落到具体插件上，再谈把它们挂进内核。
