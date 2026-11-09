# 源码对应清单

每个 Lean 模块对应一段 dsh 源码。本清单记录：源文件与 commit、模型收进了什么、
什么被有意留在模型外、以及建模时发现的模型与源码不一致之处（这部分最有价值，
它们是"文档说 A、代码做 B"的位置）。

上游检出：`refs/deepseek-harness`，commit
`687f282e8625c6b8d11ff58211a90524be2e4317`（tag `dsh-v0.2.1-rc.2`，稀疏检出，
只读）。运行时证据对应全局安装的 `dsh` 0.2.1-rc.2。

一个模块要进入这张表，必须满足：文件头 docstring 写明源文件路径与该 commit；
模型外清单写进 docstring；下表"偏差"一栏记录的每一条都能指回源码行。

## Cordis 框架（vendor/cordis）

| Lean 模块 | 源文件 | 收进模型 | 留在模型外 | 偏差 |
|---|---|---|---|---|
| `Omd/Cordis/Effect.lean` | `src/context.ts`（`ctx.effect`、`ctx.on`）、`src/fiber.ts`（effect 栈、逆序卸载） | 注册/卸载作为栈操作；良构程序逆序卸载复原（`unwind_restores`）；后注册先卸载；卸载不存在的注册报错 | 异步 effect 体、fiber 状态机、`isolate`/`intercept`、logger、`restart`/`update`、`Promise.all` 并发卸载 | Cordis 对重复/缺席的卸载是静默 no-op（`DisposableList.delete` 返回 `false`），模型故意更严：报错。另外 `provide` 的键按 `ctx[symbols.isolate]` 分域，模型只有单一键空间 |
| `Omd/Cordis/Fiber.lean` | `src/fiber.ts`（`FiberState`、`_refresh`/`_setEpoch`）、`src/reflect.ts`（`ReflectService.notify`） | `inject` 门控；轮次化激活（`ready`/`step`/`closure`）；秩见证 `Stratified`；闭包稳定；公平调度收敛到同一集合；需求未满足的行永不激活 | 异步激活、激活失败（`FAILED`）、卸载与重挂、loader 并发与 `inertia`、`Impl.check`、一插件多 fiber、`disabled` 的重评 | 无。`ready` 对应 `_refresh` 的实现存在性检查；`step` 对应 `notify` 的全量重查。关键发现：单纯"需求被启用行提供"不足以保证激活——两行互供对方需求会同死，cordis 的 `_refresh` 同样如此，所以定理需要无环（秩）假设 |
| `Omd/Cordis/Registry.lean` | `src/registry.ts`（`inject`→plugin、`plugin`）、`src/service.ts`、`src/reflect.ts`（`provide`、handler.get） | 注册表全局唯一键；`get` 无调用者参数；属性代理只走祖先链 | 异步卸载、`isolate` 键遮蔽、自有属性先于服务、`accessor`/`mixin`/`set`、反射遍历、`strict` 读取 | "每 context 一个实现"实为"每根一个"：`ReflectService.provide` 抛错查的是根 service 的单张表。代理链从调用者 fiber 自身开始（先查自己的 store），不是从父开始。代理中途还会因 `!fiber.runtime` 或 isolate 遮蔽提前抛错，模型只建模"查不到" |
| `Omd/Cordis/Dispatch.lean` | `src/events.ts` | 五种派发模式的顺序律：全委派 waterfall 返回原值、不调 `next` 短路、`serial`/`emit` 按注册顺序、`bail` 首个非 `none` 决定、`prepend` 先跑 | 异步等待、`parallel` 交错时序、监听器异常、`internal/dispatch`、`unregister` | 三条实差：`next` 在源码里是共享可变游标（可二次委派恢复执行点），模型是可重入 fold（只建模单次委派）；`waterfall` 用同一数组当参数栈、监听器可见原始载荷且可返回不同类型，模型统一成一个 `V`；`emit` 先跑 `internal/dispatch` 再跑本事件监听器，模型没有这一层。`bail` 的 `null`/`undefined`/`false` 之分在 `Option V` 里塌缩 |

## dsh 核心（packages/core）

| Lean 模块 | 源文件 | 收进模型 | 留在模型外 | 偏差 |
|---|---|---|---|---|
| `Omd/Dsh/Session.lean` | `packages/core/session/src/index.ts`、`known-event-types.ts`；`AGENTS.md:136` | append-only（拒绝乱序 seq）；封闭词表（拒绝未知 kind）；表面替换恰好遮蔽列出的 seq；装配只读可见事件（`assemble_congr`）；一步消费的输入必已落盘（`step_inputs_logged`） | 消息投影、持久化与 flush、JSONL 格式、脱敏、fork/`isOwnSeq` 的恢复路径、事件词表本体 | 无发现。词表本身是一张生成表，模型把它当作外部数据 |
| `Omd/Dsh/Tools.lean` | `packages/core/tools/src/index.ts`、`README.md`；`AGENTS.md` agent 作用域一节 | 同层重名拒绝、跨层重名允许；最近作用域胜出；遮蔽只影响该作用域及后代；`pre-execute`→guards→`execute`→`post-execute`→`result` 顺序固定；守卫拒绝不可逆 | zod schema、PTC 模式、`presentAs`、异步派发与超时、并发调度、`restrict` 的抛错分支 | 无发现。守卫不可逆对应 `ToolGuard` 的返回类型（只有 reason，没有 allow） |
| `Omd/Dsh/Prompt.lean` | `packages/core/system-prompt/src/index.ts`（`ScopedLayers.merge`）、`packages/core/scope/src/store.ts` | 段落按层合并、近层覆盖、缺失即缺失、同层重名拒绝；`UniquePerDepth` 下合并与列表顺序无关 | 渲染排序（`order` 字段、名字决胜）、`{{model}}` 插值、`complete` 段、runtime contexts、token 计量、locale/命令段 | 源码的 merge 返回 `Map` 且从不见同层两份（每层一个 `ScopeKey`）；模型的 `pick` 平局决胜只为全函数化，`register` 才是抛错点。全局分支的错误文案与 scoped 分支不同，模型只收 scoped |
| `Omd/Dsh/Request.lean` | `packages/core/system-prompt/src/index.ts`、`packages/core/tools/src/index.ts` | 请求三部分各有来源；工具名集合 = 注册表在该作用域的投影；`restrict` 只删不改；近层工具体胜出 | runtime contexts、token 预算、adapter 默认值、reasoning effort | 源码的 `ToolRuntime.view` 只对继承名（全局+祖先）施加 restrict，本层自己的注册豁免；模型对整个解析结果过滤——模型更严，按"已知差距"记录。同层重名在源码里根本不可能（`NamedEntries` 抛错），模型的平局决胜同理只是全函数化 |

## 内核实例（本仓库）

| Lean 模块 | 源 | 内容 | 说明 |
|---|---|---|---|
| `Omd/Kernel/Spec.lean` | `profiles/omd-kernel/cordis.patch.yml`、`docs/capability-seams.md` | 谓词与行分类（`closed`、`uniqueProvider`、`noHumanSurface`、`noMachineBinding`、`interfacePresent`；`rowsThatNeedAHuman`、`rowsBoundToThisMachine`、`interfaceRows`） | 分类是"关这些行的理由"的形式化；改组合若改了分类，先改这里 |
| `Omd/Kernel/Generated.lean` | `scripts/extract.mjs` 的输出 | 100 行的 `provides`/`requires`/守卫、拓扑序 `order`、启动器键 `external`、每个需求的来源文件 | **生成文件**，不手改。守卫映射表不认识的表达式会让脚本退出非零 |
| `Omd/Kernel/Composition.lean` | `vendor/cordis/src/fiber.ts`、`reflect.ts`、`docs/capability-seams.md` | 启动器键变合成行；拓扑序变秩见证；`Stratified` ⇒ 全部激活（`no_pending`） | `ordered_stratified` 需要额外假设 `hdisj`：启动器行 id 不与真实行 id 撞名（若撞名，秩不再从 0 起）。对生成数据成立且被 `kernel_disjoint` 检查 |
| `Omd/Kernel/Facts.lean` | `Generated.lean` + `Spec.lean` + `Composition.lean` | 九条 `decide` 定理把谓词落到数据上 | 组合一变，`decide` 失败即构建失败；失败本身就是发现 |
| `Omd/Plugins/Contract.lean` | `refs/deepseek-harness/packages/AGENTS.md`、`AGENTS.md:131,136`、本仓库 `AGENTS.md` | 插件五条契约（inject 闭合、注册可逆、目标唯一、模型可见必有日志、宿主不碰 client 半边、Config 无本机绑定）+ `mount_preserves_closed` | 契约目前是声明式的（`Plugin` 记录逐字段读包）；逐插件实例化是挂载前的门 |

## 抽取管道的模型边界

`scripts/extract.mjs` 静态读代码，以下注册点它看不见：

- 运行期由配置或闭包计算出来的服务键（`storageBackendServiceKey("json")` 这类）。
- `ctx.inject(…)` 在激活之后才建立的依赖。
- 子路径入口模块（如 `dsh-tool-subagent` 的 `./model-selection-settings`）单独
  注册的键——它们不在行的入口模块里，由 `external` 或报告显式列出。
- `dsh-pwsh-sandbox` 提供 `shell` 这类"表格漏记、代码可证"的事实，靠跨包
  `extends` 链解决（`SandboxPwshExecutor → PwshLocalExecutor → ShellExecutor`，
  `super(ctx, "shell")` 在 `dsh-shell/lib/index.js:85`）。

## 证据

- 运行时：`artifacts/kernel-verify/session.md`（组合、启动、真实回合）。
- 构建：`cd proof && lake build`，全绿。
- 卫生：`cd proof && lake env lean checks/axioms.lean`——没有定理依赖
  `sorryAx`；内核九条里六条零公理，其余只依赖 Lean 标准公理
  （`propext`、`Classical.choice`、`Quot.sound`）。
