# 打包 OMD 桌面应用

日常组合是 `profiles/omd-full`：官方 dsh bundle、钉在 `95602e97` 的修改版 ds-bot（`ctx.provide('dsBot')` 与 `hub.registerDetailsTab`；公开 npm 上的 ds-bot 没有这两样），以及本仓库的 omd 插件。脚本在 `scripts/pack-desktop.mjs`。它不改 `ds-bot` 子模块的提交，只复制 `ds-bot/app` 再叠上这套组合。

## 为什么界面会变成原版 DS Bot

`@deepseek-ai/dsh-client-modules` 0.2.2-rc.1 把浏览器模块图的 id 定成插件 `package.json` 的 `"name"`。Loader 行的 `name` 就是它去解析的包名，解析到的 `package.json` 名字必须一致。浏览器执行客户端脚本时，`__ModuleLoader__.load({ id })` 也必须是这个名字，否则脚本加载了也不算注册成功，这一行被静默跳过。

所以三处要相同：

| 位置 | 例子 |
|---|---|
| `package.json` `"name"` | `@dbydd/omd-workbench` |
| profile 行的 `name`（`id` 仍可不带 scope） | `name: "@dbydd/omd-workbench"` |
| `src/client/index.js` 的 `load({ id })` | `id: '@dbydd/omd-workbench'` |

`omd-onlyne` 的包名本身就不带 scope，所以它原来就能进图。其余带 `@dbydd/` 的客户端以前用 `omd-*` 注册，图对不上，顶栏、聊天壳、项目配置、详情页签都不会出现。

宿主源码里的 `from 'omd-internal-paths'` 仍走无 scope 的名字。`profiles/omd-full/package.json` 用同一条 `link:` 再挂一个无 scope 别名。打包时别名是指向带 scope 那份的符号链接，避免装出两份模块。

`omd-context-notes` 和 `omd-context-tavern` 注册详情页签的方式和 `omd-onlyne` 相同：`window.dshBot` 已在就直接 `registerDetailsTab`，否则推进 `window.dshBotQueue`。这条路径在改 id 之前就已经在。

## 密钥

包里没有密钥。dsh 从该应用自己的 `$DSH_HOME/.credentials.yaml` 和配置里的 `apiKeyEnv` 读密钥。桌面进程的 `DSH_HOME` 是应用数据目录（未设置 `DS_BOT_HOME` 时默认 `~/.ds-bot`），不是仓库，也不是 `~/.dsh`。不要把 `.credentials.yaml`、`.env` 或 API key 写进 profile。

## 命令

安装钉死的 dsh 0.2.2-rc.1 需要 Node `>=24.9.0`（`ds-bot/app` 的引擎声明）。打包机用这个版本；打出来的 Linux 宿主进程用应用自带的 Node 24，不看打包机的 Node。

在仓库根目录：

```sh
node scripts/pack-desktop.mjs --check          # 只核对 pin、三名一致、别名、密钥扫描
node --test scripts/pack-desktop.test.mjs      # 同上，并检查 staging 出的宿主补丁
node scripts/pack-desktop.mjs                   # Linux：安装依赖并打出目录包
node scripts/pack-desktop.mjs --dir --mac --publish never   # 在 Mac 上打 zip；不要在 Linux 上交叉编译
```

插件源码是 TypeScript。桌面宿主的 Node 拒绝剥离 `node_modules` 里的类型，所以打包前会把每个插件的 `src/**/*.ts` 编成 `dist/**/*.js`，客户端本来就是 `.js`，原样带上。

默认产物：

```text
build/omd-desktop/dist-pack/linux-unpacked/
```

二进制名是 `omd`，应用 id 是 `io.github.dbydd.omd`，不会替换已经装好的 DS Bot。`build/` 不进 git。

macOS 沿用 ds-bot 现成的 electron-builder 流程（zip、临时签名、不公证）。必须在对应芯片的 Mac 上构建：脚本继承了上游的架构检查，Linux 上打 mac 包会在打包前停下来。不需要证书。

## 启动后要看什么

无图形界面的环境打得出包，但开不了窗口。在有显示器的机器上：

```sh
DS_BOT_HOME=<空目录> DS_BOT_SHELL_DATA=<另一空目录> \
  build/omd-desktop/dist-pack/linux-unpacked/omd
```

这次无界面启动能走到团队窗口。日志里如果出现 `typescript-language-server` 找不到，是 profile 里的 LSP 行在找本机二进制，窗口仍然起来。要消掉这行，装上那个语言服务器，或删掉 `omd-full` patch 里 `lsp-tool` 的 `servers.typescript`。

确认这些是 omd-full 而不是原版 DS Bot：

- 顶栏是 workbench 自己的（会话标题、新会话、侧栏开关），不是上游那条。
- 空白会话的输入卡贴在底部（chat-shell）。
- 项目行上有项目配置入口（project-config）。
- Bot 详情抽屉里有笔记页签，酒馆页签在；Onlyne 网络页签在 `omd-onlyne` 挂上之后出现。
- 数据目录里没有从包里带出来的 `.credentials.yaml`。模型密钥在应用的数据目录里另配。

`profiles/omd` 是不带 ds-bot 的 Web 组合，行的 `name` 已经是包名。它的皮肤客户端 id 以前仍是 `omd-skin`，和 `@dbydd/omd-skin` 不一致，同一条规则下也会被丢掉。现在和 omd-full 一样对齐了。

`dsh-motion-ui` 0.8.9 只声明兼容到 dsh 0.2.1-rc.5。钉死的桌面宿主是 dsh 0.2.2-rc.1，把它放进「必须加载」的 bundle 列表会让宿主直接退出。包仍会装进应用，但不进这份桌面的 bundle 列表。要在 0.2.2 上用动效，需要一份声明了该运行时的 motion-ui，或按 dsh 的提示做精确版本豁免后再自己加回 bundle。
