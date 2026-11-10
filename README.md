# oh-my-ds-bot

dsh（[DS-Bot](https://github.com/dbydd/DS-Bot)）的树外插件套件、omd profile 组合，以及把这套组合打成桌面应用的脚本。定制写在插件和 profile 里；`ds-bot` 与 `dsh-motion-ui` 两个 submodule 保持只读。

## 先看哪里

```text
ohMyDsBot/
├── plugins/                 插件，按角色分组。包名仍是 @dbydd/omd-*
│   ├── workbench/           窗口：顶栏、聊天壳、皮肤、图表、项目配置
│   ├── context/             笔记、酒馆、记忆、技能目录
│   ├── judgment/            判官、角色路由、回合规则
│   ├── onlyne/              Onlyne 总线（omd-onlyne，不发布）
│   ├── compute/             沙箱、租约、issue runner、worktree
│   ├── host/                内部路径，以及其上的工具、待办、子代理
│   ├── archived/            未挂载的旧包
│   ├── npm-packages/        安装 @onlyne/lib 的位置
│   ├── link-host-runtime.mjs
│   └── README.md            每个包做什么
├── profiles/
│   ├── omd/                 发布用 Web 组合，依赖 npm 上的 @dbydd/*
│   └── omd-full/            开发用桌面组合，link: 指向本仓库
├── scripts/                 pack-desktop.mjs、publish-all.mjs、path
├── docs/                    设计说明。打包见 docs/pack-desktop.md
├── design/                  Quint / VDM-SL / LikeC4
├── ds-bot/                  只读 submodule，钉在 95602e97（DS-Bot v0.2.7）
├── external-plugins/        只读 submodule：dsh-motion-ui v0.8.9
└── archived/                Lean 实验与退役 profile
```

包名不跟目录走。三处必须仍是同一个名字，否则浏览器模块图会丢掉客户端：`package.json` 的 `"name"`、profile 行的 `name`、`src/client/index.js` 里的 `__ModuleLoader__.load({ id })`。宿主源码里的 `from 'omd-internal-paths'` 走无 scope 的别名，`profiles/omd-full/package.json` 用同一条 `link:` 再挂一次。

## 第一次跑

前置：Node 22+（打桌面包要 Node `>=24.9`）、pnpm、全局 `dsh` 0.2.1-rc.5。

```sh
git clone --recurse-submodules https://github.com/dbydd/ohMyDsBot.git
cd ohMyDsBot
cd ds-bot/ds-bot && pnpm install --prod --ignore-scripts --lockfile=false --config.auto-install-peers=false && cd ../..
cd external-plugins/dsh-motion-ui && pnpm install --prod --ignore-scripts --lockfile=false --config.auto-install-peers=false && cd ../..
node plugins/link-host-runtime.mjs
```

`link-host-runtime.mjs` 把宿主运行时和兄弟插件链进 `plugins/node_modules`。它要一份已经启动过的 dsh profile（默认 `~/.dsh`）；没有的话先 `dsh --profile omd --no-open` 一次，或传 `--dsh-home <dir>`。

开发 profile 是 `profiles/omd-full`。里面的 `link:` 相对这个目录，把目录复制到别处链接就断了。用符号链接挂进 dsh，这样不改共享的 `omd` profile，仓库里也不写密钥或本机 provider 行：

```sh
mkdir -p "${DSH_HOME:-$HOME/.dsh}/profiles"
ln -sfn "$PWD/profiles/omd-full" "${DSH_HOME:-$HOME/.dsh}/profiles/omd-dev"
dsh --profile omd-dev --no-open    # Web UI 默认 http://127.0.0.1:3080
```

`profiles/omd` 是给别人用的 Web 组合，插件来自 npm。判官的 `candidates` 与 `endpoints` 在仓库里是占位；本机取值写在自己的 `$DSH_HOME/profiles/omd/cordis.patch.yml`，不配则判官工具不注册。

## 测试

在仓库根目录：

```sh
node --test scripts/pack-desktop.test.mjs
node scripts/pack-desktop.mjs --check
node --test plugins/compute/omd-compute/src/bus.test.ts
bun test plugins/onlyne/omd-onlyne plugins/compute/omd-compute plugins/compute/omd-issue-runner
```

`pack-desktop.mjs --check` 只核对 ds-bot 的 pin、三名一致、无 scope 别名，并扫描 profile 里有没有密钥。它不安装、不打包。各包自己的检查写在包 README 里。

写插件的加载、命名和测试纪律见 [AGENTS.md](AGENTS.md)。装某一个本地包用 `dsh plugin --profile <name> add plugins/<group>/<pkg>`，不必发 npm。

## 许可

GPL-3.0-or-later（见 [LICENSE](LICENSE)）。第三方引用的归属见 [NOTICE.md](NOTICE.md)。
