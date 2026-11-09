# 项目级配置：面板、存储与触发位置

目标：在 Web UI 里按项目改参数（记忆 bank、子代理并发等），改动只影响该项目，不改 dsh 的配置体系。

## 1. 事实前提（源码证据）

- dsh 的配置层序是 bundle 层 → `$DSH_HOME/profiles/<name>/cordis.patch.yml` → home patch → 命令行覆盖，**没有按工作目录生效的层**（`refs/deepseek-harness/packages/boot/config-editor/README.md:67`、`packages/settings/settings/README.md:12`）。
- 左侧的"项目卡片"就是 Workspace 行，每行是 `ProjectRowItem`（`refs/deepseek-harness/packages/client/ui-workspace/src/client/rows/Rows.tsx:219`），数据里有规范化的 `workspace.path`。
- **它的 "..." 菜单是硬编码的**：`workspaceMenuItems` 只有 rename 与 delete 两项，按 id 派发，没有 slot 座位（`Rows.tsx:238-296`）。已声明的座位里只有 **Session 行**的菜单与悬停按钮（`sidebar.workspaces.session.menu.item`、`sidebar.workspaces.session.row.action`，见 `ui-workspace/src/client/contract/slots.ts:171-189`），没有任何 Workspace 行菜单座位。

结论：面板与存储可以完全由我们实现；"点在项目卡片的菜单上打开"需要上游在 `ProjectRowItem` 里加一个 list 座位（约十行改动），这是唯一缺口。已落地的入口放在侧栏底部动作座位 `sidebar.footer.action`（`ui-sidebar/src/client/index.ts:86`，owner 只给 `wide`）。

## 2. 存储与解析

一个项目的配置由三层合成，后者覆盖前者：

1. 插件默认值（机器无关，写在 `Config` 里）。
2. 仓库内文件 `<project root>/.omd/config.json`：可提交、团队共享。
3. 个人覆盖：`ctx.storageDomain` 中名为 `omd_project_config` 的域、`overrides` 表，以项目根为键。存储栈负责 schema 校验、持久化与 `domain/changed` 事件；没有 `storageDomain` 时插件不激活，不做内存退化。

项目根 = `git -C <cwd> rev-parse --show-toplevel`，失败时退到 `cwd`。键是规范化绝对路径（`realpath`）。`cwd → root` 按目录缓存；仓库文件按 mtime 缓存，mtime 变化即重读。两层都不存在时返回默认值，不抛错；坏 JSON 或未知字段抛错并带上文件路径。

## 3. 服务与接口

Host 半边提供 `ctx.projectConfig`：

```ts
interface ProjectConfigService {
  schema(): readonly FieldSpec[]                                  // 表单行（类型 + 默认值）
  resolve(cwd: string): Promise<ResolvedProjectConfig>            // 合成值 + 每字段来源
  list(): Promise<ProjectConfigEntry[]>                           // 已知项目及其层使用情况
  layers(root: string): Promise<{ repo?: ConfigLayer; user?: ConfigLayer }>
  write(root: string, patch: ProjectConfigPatch): Promise<ResolvedProjectConfig>  // 合并进个人层，保留未列出的键
  clear(root: string, path?: string): Promise<ResolvedProjectConfig>              // 清一个字段或整个个人层
  subscribe(listener: (change: { root: string; config: ResolvedProjectConfig }) => void): () => void
}
```

同一组方法经 `projectConfig` remote 命名空间暴露给浏览器；客户端挂载一份手写 descriptor（strict codec），Host 侧用 source-mode 的 `src-json` 分发。

配置字段是渲染无关的纯数据，客户端按同一份 schema 生成表单：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `memory.enabled` | boolean | `false` | 该项目是否启用记忆 |
| `memory.bank` | string \| null | `null` | 该项目写入与召回使用的 bank；null 表示按项目路径派生 |
| `memory.recallTokens` | number | `1500` | 单次注入上限 |
| `delegation.maxActive` | number | `4` | 该项目允许的同时运行的子代理数，由我们的派发器排队执行 |
| `roles.overrides` | Record<string, RoleRoute> | `{}` | 该项目对角色路由的覆盖（角色名 → provider/model） |

`delegation.maxActive` 只作用于我们自己的队列；dsh 的 `subagent.maxActiveSubagents` 仍是进程级硬上限，不随项目变化。

## 4. 界面

一个面板（`shell.overlay` 对话框），由 Host 的 schema 生成表单：项目标题与路径只读，字段分组显示，每个字段旁边标出"来自仓库文件 / 来自个人覆盖 / 默认值"，并提供单字段与整层的"清除个人覆盖"。写入走 remote 命名空间，按字段合并（因此不会与另一个浏览器的写入互相覆盖未提交的字段）；写失败保留草稿并显示错误，关闭后重开即重新读取。

触发位置：

1. **已落地**：侧栏底部动作 `sidebar.footer.action` 的一个按钮。该座位是 root 作用域、拿不到 Session，项目取"当前工作区"：当前主视图 Session 所属 Workspace 的 `path`。没有当前工作区时按钮置灰并说明原因，不猜 `cwd`。
   在 DS Bot 里，它自己的固定左列把 shell 侧栏压成 0 宽，这个座位点不到；插件改把同一个按钮 portal 进 `.bt-leftcol-foot`，两处互斥只留一个（列存在时只用列里的，否则回到 shell 座位）。
2. **命令**：`/project-config` 动作命令，与按钮打开同一个面板；没有当前工作区时不出现在候选里。
3. **档位所需的最终位置**：Workspace 行 "..." 菜单里的一项，与 rename/delete 同级。等上游座位落地。

## 5. 消费者

`omd-hindsight` 与 `omd-task`（以及将来的角色覆盖）通过 `ctx.get('projectConfig')` 可选读取：服务不在场时退回各自的 `Config`。服务只接受一个 `cwd` 并返回项目根与合成值；消费者侧必须用 `ctx.workingDirectory.get(session)` 解析当前工作目录（会话中途可以 cd），不要缓存会话头里的 `cwd`，也不要用 Workspace 根顶替。项目配置的每次变化通过服务上的订阅通知消费者，消费者不缓存到会话之外。
