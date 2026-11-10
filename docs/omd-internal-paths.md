# internal path：一个可扩展的一等公民模块

目标：把"内部路径"收敛成一个服务，而不是散在各处。今后 `filesystem`（内部路径寻址）与 `role` 一样，是我们可以依赖的基础设施；任何新数据源只注册一次，模型侧与界面侧同时可用。

## 1. 现状与问题

- 模型侧：`omd-read` 自带一张 scheme 表（`ctx.readSchemes`），目前只有 `skill://`；表在 `omd-read` 包里，别的包想加一个源就得依赖 `omd-read`。
- 界面侧：`ctx.resources` 按 `dsh-resource://<protocol>/…` 注册协议，与模型侧语法不同、注册表不同。
- 结果：同一个数据源要写两遍；`memory://`、`skill://` 之类两侧各自实现；模型拿到界面里可用的地址读不了。

## 2. 统一语法

- **规范形式**：`dsh-resource://<source>/<path>`。`source` 是数据源名（小写、字母数字与 `-`），`path` 由该源自己解释，不做跨源规范化。
- **简写**：仅对声明了 `shorthand: true` 的源，允许模型侧写 `<source>://<path>`（例如 `skill://omd-read`）。简写只在模型侧接受；界面侧永远是规范形式。
- **`file`**：保持现状，是文件系统路径，不经过本模块；`file://` 与普通路径同义。

## 3. 宿主服务 `ctx.internalPaths`

```ts
interface InternalSource {
  /** 这个源接受的可读地址形态，用于错误信息与文档。 */
  readonly grammar: string
  /** 是否允许模型侧写 `<source>://…` 简写。 */
  readonly shorthand?: boolean
  /** 地址是否为实时数据（界面侧会跟随变化）。 */
  readonly live?: boolean
  /** 读取：返回文本。二进制源声明 `binary: true` 并返回字节。 */
  read(path: string, exec: InternalExec): Promise<string | Uint8Array>
}

interface InternalPathsService {
  /** 注册一个源；返回 disposer。同名重复注册抛错，不静默覆盖。 */
  register(source: string, provider: InternalSource): () => void
  /** 已注册的源，排序。 */
  sources(): { source: string; grammar: string; shorthand: boolean; live: boolean }[]
  /** 解析地址：规范形式或简写形式都接受。 */
  resolve(address: string): { source: string; path: string; provider: InternalSource }
  /** 读取地址；未注册的源抛错并列出已注册项。 */
  read(address: string, exec: InternalExec): Promise<string | Uint8Array>
}
```

地址解析是纯函数：`dsh-resource://memory/notes/x` → `{source: 'memory', path: 'notes/x'}`；`skill://omd-read` → `{source: 'skill', path: 'omd-read'}`，但仅当该源声明了 `shorthand`，否则按普通文件路径处理（不能把一个恰好叫 `skill:` 的目录误判成资源）。

## 4. 界面侧桥接

- 宿主发布一个 remote 命名空间 `internalPaths`：`sources()`、`read(address)`、可选的 `follow(address)`（仅 `live: true`）。
- 客户端的 `omd-internal-paths` 半边在启动时枚举源，为每个源注册一个 `ctx.resources` 协议（`protocol: <source>`），`open(address)` 通过 remote 读一帧，`live` 源继续跟随。这样地址天然就是 `dsh-resource://memory/…`，不需要第二套命名。
- 客户端不得 import `node:` 内置模块；所有取数经 remote。

## 5. 迁移与首个消费者

1. 新建 `plugins/host/omd-internal-paths/`（宿主半边 + client 半边），实现第 3、4 节。
2. `omd-read` 删掉自己的 scheme 表，改为 `inject: ['internalPaths']`；读地址时先问 `resolve`，命中就 `read`，未命中按文件路径处理。`skill` 源的注册留在 `omd-read`（它依赖 `ctx.skills`），只是改为注册进 `ctx.internalPaths`，并声明 `shorthand: true`。
3. 兼容：`ctx.readSchemes` 不再提供；仓库内没有别的消费者，直接删除，不留别名。
4. `omd-memory` 之后把 `memory` 源注册进来即可获得两侧能力，不需要再碰 `omd-read` 或客户端。

## 6. 验收

- 模型侧：`read` 一个 `skill://<name>` 与一个 `dsh-resource://skill/<name>` 都成功且内容一致；未注册源报错信息里带已注册列表；一个名为 `skill:12` 的真实文件仍按文件路径读取（简写不误判）。
- 宿主侧：注册/注销的 disposer 幂等；重复注册同名源抛错；`sources()` 排序稳定。
- 界面侧：`useResource('dsh-resource://skill/<name>')` 能读到文本；源不存在时返回 `none` 而不是抛错；client 半边是纯 `.js`。
- `dsh --profile omd-full --dump-config` 退出码 0、stderr 为空；`dsh --profile omd-full` 启动无 "did not activate"。验完 profile 逐字节恢复（用临时 profile，不改 `~/.dsh/profiles/omd-full`）。

## 7. 边界

- 不动上游。不引入依赖。不写测试文件。
- 不把 `file` 塞进这个模块；文件系统路径与内部路径是两条道，`resolve` 只处理 `dsh-resource://` 与声明过简写的源。
- 地址里不做转义/编码的二次解释：`path` 原样交给源，源自己决定要不要解码。

## 8. 规则：面向模型的复杂能力一律走路径

（2026-10-22 定）新能力如果给模型用、且不是简单的一次函数调用，就不再单独造工具形态，而是注册成一个内部路径源。理由：

- 一个源同时喂模型侧与界面侧，不需要各写一遍；界面能按地址直接预览。
- 地址是可缓存的读单位：同一个 `dsh-resource://vault/x.md` 在模型读与界面看之间是同一份内容。
- 工具面保持小且稳定，新能力不往工具目录里加条目，前缀缓存不被扰动。

例外的两种情形仍然做工具：需要**写**或产生副作用的动作（改文件、跑命令、发请求），以及需要模型参与多轮判断的交互。只读、可寻址的数据面走路径。

### 跨会话读不设人为限制

（2026-10-22 定）`agent://` 与 `history://` 对子代理会话、历史转录的读取**不按父/子链设限**。理由有两条，后者是决定性的：

1. 子代理之间本来就有传话通道（IRC / `send_message`），信息本来就能横向流动；给只读路径设限，只是让“看”比“说”更难，没有安全收益。
2. 读不是授权域。`InternalExec` 后来确实补上了 `agent`，但它是为**资源归属**（谁的后台作业、谁的终端）准备的，不是为历史读准备：历史日志本来就是可复盘的东西，给它加一条“只能读自己的子链”的规则，只会让读比说更难。能被绕过的检查比没有检查更坏。

保留的唯一硬边界不是授权而是语义：`agent://` 只接受 `origin === 'subagent'` 的会话，其它会话走 `history://`。

### 最终接口形状（2026-10-22 定，六个源共用）

```ts
interface InternalExec {
  signal?: AbortSignal
  /** 当前会话的工作目录；`issue://`、`pr://` 这类相对寻址用它解析项目绑定的仓库。 */
  cwd?: string
  /** 读者身份；`proc` 用它划分后台作业与终端的归属。不是历史读权限。 */
  agent?: Agent
}

interface InternalSource {
  grammar: string
  shorthand?: boolean
  live?: boolean
  read(path: string, exec: InternalExec): Promise<string | Uint8Array>
  /** 可选写面：实现了才可写，`源只读`因此是类型事实而不是工具白名单。 */
  write?(path: string, content: string, exec: InternalExec): Promise<void>
  /** 仅宿主：把地址映射到一个真实文件，让 `read` 复用它已有的窗口与行号逻辑。不进 Remote。 */
  locate?(path: string): Promise<{ path: string; offset?: number } | undefined>
}
```

四条来自实现的教训，写进契约避免重复踩：

1. **读正文不要用会推进消费游标的 API。** `proc` 正文只能走 `readAt`；`read` 会推进模型的消费游标，读一眼就静默吃掉增量输出。
2. **路径永不承载副作用。** `proc://<id>/kill`、`?kill=1` 都被否决：前者让缓存预热或 HTTP 重试二次触发动作，后者在 `?` 属于 path 的解析下会变成 id 的一部分。动词只存在于工具与已有的 Remote 方法。
3. **错误要能分辨是谁拒绝的**：地址语法、源不存在、源只读、源自身校验失败，四种分开写。
4. **缺 `agent` 时必须显形**：`proc` 头部固定打印 `scope: session <id>` 或 `scope: unfenced`，让“看不到作业”不会被误读成“没有作业”。

5. **源里解析分层服务必须传完整 lookup。** 宿主服务大多按 agent 作用域分层（技能、工具、文件系统都是）。从全局 ctx 直接 `get(name)` 会解析到“没有这个 agent 的层”，表现成“东西明明存在却查不到”。正确形状照上游 `tool-skill`：`{ cwd, signal, scope: exec.agent }` 一起传（`refs/deepseek-harness/packages/skill/tool-skill/src/index.ts:134-136`）。这条是在 `skill://` 上真踩过的：模型读 `skill://chinese-writing-standard` 报 `no such skill`，而同一个名字用 `skill` 工具能读到——差别只在这个 lookup。
