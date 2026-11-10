# cfg：运行时配置快照

只读源，回答三件事：某个 profile 条目此刻拿到的配置是什么、每个值是哪一层给的、哪些字段能在设置表单里直接改。写配置不进这个源。

## 1. 承载服务与证据

- 条目 id 就是命名空间。`SettingsNamespace` 是有品牌的 profile entry id（`refs/deepseek-harness/packages/settings/settings/src/types.ts:6-7`，`.../settings/settings/src/index.ts:326`），不是插件名：同一插件挂两次是两个 id，重复 id 不可寻址（`.../boot/config-editor/src/index.ts:39-44`），嵌套 Include 里的条目也不在（`:36-37`）。
- 生效值来自运行中的 fiber，不是 YAML：`value = projectForm(form, plainConfig(entry.fiber.config))`（`.../settings/settings/src/index.ts:319`）。
- 分层：`base` 在 profile patch 之下，`user` 是 patch 里显式写下的（`:320-322`）。两者都是 form 投影后的子集，所以层表不能只靠 `describe()`。
- 层序：bundle → `$DSH_HOME/profiles/<p>/cordis.patch.yml` → home patch → 命令行覆盖（`.../boot/app-boot/src/profile-context.ts:77-80`）。`configuration()` 只读前两层（`.../boot/config-editor/src/index.ts:49-70`），home patch 与命令行只在运行时值里出现。
- 层之间整段替换：`target[key] = value`（`vendor/include/src/index.ts:120-123`）。所以「bundle 里有这个字段」不等于「值来自 bundle」：profile 一写 `config`，bundle 那段整体作废。
- 表单边界：`describe()` 只收有 volatile 字段的条目（`.../settings/settings/src/index.ts:307-310`），判定是「最近的 volatile 祖先」（`.../settings/settings/src/schema.ts:37-47`）。`roles` 这个 dict 标了 volatile，它下面每个叶子都可实时改。
- 脱敏：`role('secret')` 子树整体剔除，只留 `{path, set}`（`.../settings/settings/src/redact.ts:53-56`、`:106-116`）；schema 里 secret 的 `default`/`required` 也要删（`.../settings/settings/src/schema.ts:23`）。

## 2. 地址语法

```
cfg://                                    条目清单（有表单的带 [form]）
cfg://<ns>                                生效快照，每行一个叶子
cfg://<ns>/<pointer>                      单个叶子的生效值
cfg://<ns>/@default|@bundle|@profile      某一层的原样文档
cfg://<ns>/@<layer>/<pointer>             某层里的单个叶子
cfg://<ns>/@schema[/<pointer>]            字段表：type / default / volatile / 说明
```

`<pointer>` 是 JSON Pointer：`/` 分段，`~0` 转义 `~`，`~1` 转义 `/`；首段以 `@` 开头保留给层名。规范形式 `dsh-resource://cfg/…`，模型侧可写 `cfg://…`（注册时声明 `shorthand: true`）。

真实例子（取值见 `profiles/omd/cordis.patch.yml:38-42`）：

- `cfg://omd-roles` →

  ```
  # omd-roles · 3 leaves
  default fallback = ["default"]
  profile roles/judge/model = "group/decider"  [live]
  profile roles/judge/provider = "magpie"  [live]
  ```

- `cfg://omd-roles/@profile/roles/judge/provider` → `"magpie"`（该层原文，不填默认值）
- `cfg://omd-read/@schema` →

  ```
  # omd-read · schema
  mode    | union(selector,native) | "selector" | yes | selector 读 path:50-200，native 读单窗口
  maxLines | natural                | 2000       | no  | 每次返回的硬上限
  ```
- `dsh-resource://cfg/omd-memory` → 与 `cfg://omd-memory` 同一份内容

值表行格式 `<source> <pointer> = <JSON>`，`source ∈ default|bundle|profile|runtime`，按 pointer 排序。对象展到叶子；数组不展开，整个数组算一行。`[live]` 表示该字段在设置表单里，`[form]` 表示该条目有表单（`describe()` 收它）。`runtime` 是标记不是层，没有 `@runtime`：它的意思是「三层都没有、只在运行时值里有」，即 home patch、命令行覆盖，或 volatile 引用被就地改过。secret 位置写 `<secret set>` / `<secret unset>`。

`@schema` 是字段表，列固定为 `path | type | default | volatile | description`，以 `|` 分隔、按列宽补齐。动态 dict（如 `omd-roles.roles`）只列节点本身，键从生效快照里看。

## 3. 读取语义与错误形态

- 每次 read 现组一份快照，不缓存：`configEditor.entries()` 定位条目，`configuration()` 取 `inherited`/`override`，`describe({redactSecrets: true})` 取 form 面。
- 来源逐叶判定：`@profile`、`@bundle` 各自先 `interpolate` 再 `resolveConfig(fiber.runtime, …)` 求值，与生效值逐叶比。命中且该路径确实写在那一层 → `profile`/`bundle`；等于 schema 默认 → `default`；都不等 → `runtime`。「整段替换」由「该路径确实写在那层」这一步吸收。
- 值一律 JSON（compact，不加空格）；条目与路径按字典序，输出可 diff。
- 走 `read` 的行窗口（默认 500 行）。截断时按 pointer 下钻，而不是翻页。
- `live: true`：数据随运行时变化；客户端当前只读一帧、不跟随（客户端半边的债，不在本切片）。
- 不按 agent 收窄：profile 配置是进程级的，`exec.agent`（`InternalExec` 新增的读者身份）对 cfg 不参与判定，别在这里凭空造一个按 agent 过滤的分支。
- 错误形态都带下一步：未知条目 `no config entry "x"; addressable: …`；未知层 `unknown layer "lol"; layers: default, bundle, profile`；无此字段 `no field "maxLines" in omd-read@profile (2 leaves)`；条目未激活 `entry "x" is not active`；无 schema `entry "x" has no Config schema`。

## 4. 安全边界

1. 实现落点：`plugins/omd-cfg/src/projection.ts` 的 `redact()` 是唯一出口，内部一次 `redactSecrets(完整 Config schema, 值)`；四个值（生效、三层）都从这个函数出来，`source.ts` 只格式化它返回的结构，不碰原始值。
2. secret 子树整体消失（`redact.ts:53-56`），只留 `{path, set}`。叶子读返回 `secret set` / `secret unset`，不返回长度、哈希或前缀。
3. `@schema` 的字段表同样要脱：schema 里 secret 带着 `default`（`plainSchema` 正为此删 `default`/`required`，`schema.ts:23`），所以 secret 行的 default 列写 `set: true` / `set: false`，不写值。
4. 永不调用无参 `describe()`：只有 `describe({redactSecrets: true})` 才脱敏（`settings/settings/src/index.ts:327-330`）。把这次调用收进一个私有访问器，别让调用点散开。
5. 写配置不进路径，理由不是洁癖：脱敏视图是残文档，拿它整段回写会删掉从未返回的 secret（`settings/settings/src/index.ts:73-80` 记的就是这次事故）。要改走 `ctx.remote.settings.mutate`（带 `expectedRevision`）或直接改 patch 文件。
6. 暴露面：cfg = 运行中 fiber 持有的配置减 secret 子树。比设置页宽（设置页只见 volatile 字段），但不宽于用户自己的 patch 文件加上 `!!js` 求值结果。要让某个值挡住，只能把它声明成 `role('secret')` 或改成凭据引用（`omd-memory.apiKeyRef` 就是后者），不另加关键字黑名单。

## 5. 实施切片

1. `plugins/omd-cfg/src/projection.ts`（纯函数）：`plain()` 镜像 `.../settings/settings/src/schema.ts:10-17`（`isVolatile` 用 `@deepseek-ai/cosmokit`）、`leaves()`、`at()`（JSON Pointer）、`defaults()`、`schemaRows()`（字段表，secret 行的 default 换成 `set`）。验收：`node --experimental-strip-types --input-type=module -e "…"` 断言数组不展开、`~1` 反转义、secret 行不出现默认值。
2. `plugins/omd-cfg/src/source.ts` + `src/index.ts`：`inject = ['settings', 'configEditor', 'internalPaths']`，`register('cfg', { grammar, shorthand: true, live: true, read })`，`ctx.effect` 归还 disposer。验收：`dsh --profile omd --dump-config` 退出码 0、stderr 无 `not found`；启动后读 `dsh-resource://cfg/omd-roles`，三行与 patch 一致。
3. 运行时链接与挂载：`plugins/omd-cfg/package.json` 声明 `@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-config-editor`（type-only）、`@deepseek-ai/cordis-plugin-loader`、`@deepseek-ai/cosmokit`；`plugins/link-host-runtime.mjs:30-44` 的 `RUNTIME_PACKAGES` 补这三个；`profiles/omd/cordis.patch.yml:83-86` 已有 `omd-internal-paths` 行，别重复 insert，只在它后面加 `omd-cfg` 自己那一行（先后由 `inject` 保证，行序只为可读）。验收：`node plugins/link-host-runtime.mjs` 退出 0；`dsh --profile omd` 无 `did not activate`。
4. 模型侧可达不在本切片：`omd-read` 还没改走 `ctx.internalPaths`（`plugins/host/omd-read/src/index.ts:289-299` 仍是自己的 `readSchemes`）。那次迁移是一整片，一次改完所有源，cfg 不为它改一行：`resolve()` 按注册表分发，注册即生效。迁移前只有 Web 侧 `dsh-resource://cfg/…` 能读；迁移后验收 `read {path:"cfg://omd-roles/@profile/roles/judge/model"}` 返回 `"group/decider"`。

## 6. 风险

1. 复刻上游内部：`plain()`、层序、`resolveConfig` 求值、整段替换语义都绑在 `dsh-settings`/`config-editor` 的当前实现上，上游一变 cfg 会静默标错来源（值不受影响，值直接来自 fiber）。缓解：镜像集中在一个文件并注明被镜像的行号；三张层表永远是原样文档，不经任何合成。
2. 非 secret 字段里的求值结果：`fiber.config` 带着 `!!js` 求值后的值，schema 没标 secret 就会进 cfg（设置页对 volatile 字段本来也如此）。这是 schema 的责任边界，不在这里加第二套规则。

## 7. 已定

1. 保留 `bundle` 这一档：三个可寻址层 `@default`、`@bundle`、`@profile` 加每行一个 `runtime` 标记。不并成三档的理由：dsh 自带 bundle 与我们的 patch 是两份不同文件，合掉就答不出「这个值是上游默认还是我们自己改的」，而这正是最常问的问题。
2. `@schema` 输出字段表，不吐原始 schemastery JSON。读它的人要的是「有哪些可配项、类型、默认、一句话说明」，原始 JSON 对模型和人都是噪声。机器格式等真有消费者再加 `?format=json`，现在不做。
3. `ctx.projectConfig`（`docs/omd-project-config.md`）不进 cfg，由它自己注册 `dsh-resource://project-config/…`。两者生命周期与作用域不同（cfg 是 profile 条目，projectConfig 按项目根解析），塞进一个源会让地址语义含混。
