# 自改：组合层可以当场改，源码层不行

## 结论

`omd` 的 profile 里写着 `dsh.profile.patchReload: live`。Loader 因此监视
`~/.dsh/profiles/omd-full/cordis.patch.yml`：手写一行 `insert`，HMR 在现场重组，
新 fiber 几秒内挂上，当前会话的工具表立刻能看到；删掉这一行，fiber 逆序卸载，
patch 回到原样。整个过程不需要重启进程。

**这是组合层的自改，不是源码层的热更。** 它改的是「挂哪些插件、怎么配」；
插件自己的 `.ts` 改动是否免重启，本次没有验证。

## 证据（2026-10-22 23:22，cordis 预设会话）

热挂 `omd-context-notes`（进程里已安装、未挂载，只注册一个 `context_notes`
工具）：

| 观测点 | 结果 |
|---|---|
| 追加 patch 行后 | `Tool.listTools` 从 34 个变 35 个，出现 `context_notes` |
| 同上 | `Config.listConfigs name=omd-context-notes` 出现 `include:omd-context-notes`，status `schema` |
| 删除该行后 | patch 与基线逐字节一致（854 行）；Config 目录 0 条；工具表回到 34 个 |
| 全程 | 没有重启，没有改 bundle，没有 pnpm 操作 |

运行记录与基线快照在 `artifacts/selfmod-pilot/live/`。

## 机制

- 改的是 patch 层，不是 `cordis.yml`。`cordis.yml` 是合成产物，下次启动会被
  重写；改它等于改一个随后被覆盖的缓存。
- HMR 的重组顺序是「先卸后挂」：被删的行按注册的逆序 unwind，新行按层序挂载。
  所以回滚天然成立，不需要补偿逻辑。
- 手写 patch 的变更不会被 `plugin-manager/changed` 广播：插件页要等下次读取才
  知道组合变了。用 `plugin_manager` 工具做的操作才会广播。

## cordis 预设在这里的角色

`plugin_manager` 两个预设都有（都受 `profileContext` 门控）。cordis 相对
standard 的唯一增量是 `cordis_inspect_*`——它不改组合，只让改完的组合**可被
观测**：`Config` 看 entry 在不在、`Tool` 看工具表、`Slots` 看界面挂载。自改的
闭环是「改 → 看 → 回滚 → 再看」，inspect 就是那个「看」。

## 边界

1. **只能挂已安装的包。** 新包要先 `dsh plugin --profile omd-full add <spec>` 进
   profile 依赖；HMR 不装依赖。
2. **YAML 写坏会整层失败。** 改前复制一份基线，改后用
   `dsh --profile omd-full --dump-config` 或直接看 HMR 日志确认。
3. **`link:` 包的源码改动不在本次结论里。** HMR 会重载模块，但 linked 包是否
   需要重建/重启，未验证。
4. **agent preset 的行是只读的**（`plugin_manager` 明确拒绝）；改预设要改
   bundle 的 preset patch 文件。
