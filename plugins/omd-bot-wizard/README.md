# omd-bot-wizard

Bot 创建的第 2 步，作为一个覆盖层挂在 DS-Bot 自己的创建对话框后面。

第 1 步仍然是 DS-Bot 的：外观、名字、模型，一行没改。本插件补的是它没有字段的两件事：

- **说明与分工设定**：这个 Bot 负责什么、不负责什么、和谁交接。写进它的 `instructions`。
- **Linux 虚拟机沙箱策略**：`按需拉起`（on-demand）/ `常驻靶机`（always）/ `不分配 VM`（none）。

## 它拥有什么，委派了什么

| 部分 | 归属 |
| --- | --- |
| 第 1 步：外观、名字、模型、创建按钮 | DS-Bot `src/client/create-bot.js`，原样 |
| 第 2 步：说明与策略表单 | 本插件，挂在 `document.body` 上的独立 React 根 |
| 落库：Bot 记录、`instructions` 字段、`state` 视图 | DS-Bot 宿主 `/api/bot` 路由，原样 |
| 策略这条记录的语义 | 本插件定义，写在 `instructions` 末尾一行（见下） |

本插件不注册工具、不写会话事件、不拥有 Bot 状态的第二份副本：答案通过 DS-Bot 本来就有的端点落进 Bot 记录，界面读回来也是同一个 `state`。

## 怎么接上去的

DS-Bot 的客户端把每个 Bot 操作发给一个固定路由：

```js
// ds-bot/ds-bot/src/client/api.js
POST api/bot   { endpoint, payload }
```

宿主 `src/host/channel.js` 的 `handle()` 认的端点是（与创建相关的部分）：

| endpoint | 读的字段 |
| --- | --- |
| `create-bot` | `name` `role` `color` `instructions` `brief` `avatar` `model` `effort` `workDir` |
| `update-bot` | `id` + 上面任何一项（含 `instructions`） |
| `duplicate-bot` / `delete-bot` / `set-main` / `set-flags` … | 见 `channel.js` |

`create-bot` **本来就吃 `instructions`**，所以第 2 步不需要「先创建再补一刀」：本插件在创建请求离开浏览器之前接住它，把答案并进同一个 `payload.instructions` 再放行。一次往返，Bot 从第一刻起就带着说明。

`channel.js` 的 `handle()` 接受的全部端点名（`switch (endpoint)`）：

```text
state models efforts thinking providers provider-key provider-add provider-models
provider-remove duplicate-bot set-prefs exchange exchange-text file-text earlier
chat run-stats usage room-progress create-bot update-bot resume avatar-library
avatar-import avatar-delete delete-bot private-release set-main create-room
update-room folders folder-pick folder-list team-workspace add-agent agent-session
agent-adopt agent-archive agent-rename remove-agent set-flags delete-room
approval-answer stop-member-work stop-room-work goal-draft goal-control
dismiss-question dismiss-view secret-set secret-allow secret-cancel secret-update
secret-delete connector-connect connector-disconnect connector-retry
capability-save capability-delete capability-approve bot-capability schedules
schedule-create schedule-delete memory-view memory-ask memory-forget memory-history
memory-restore learning-answer answer-question view-reply send btw-delete side-new
side-ask side-cancel side-close update-check update-install dsh-update-install
repo-stars browser-wait browser-result browser-takeover browser-give-back
browser-stop diagnostics diagnostics-log diagnostics-clear
```

其中能把自由文本写进 Bot 记录的只有 `create-bot` 与 `update-bot` 的 `instructions`（另有 `role`，24 字上限）；没有任何 bot 级沙箱字段，`bot-capability` 只能挂已注册的能力条目，不是通用设置存储。所以策略没有字段可以发明，只能落在已有的 `instructions` 上（见下）。

选择这条路而不是 `update-bot`，理由是副作用：`update-bot` 改到 `instructions` 时会向 Bot 的对话投递一条 `Your instructions now read: …`（`roster.js` 的 `notes`）。创建后立刻补写，等于让新 Bot 先收到一条没人要的系统消息，甚至多跑一个回合。

拦截的范围窄到只有一件事：`POST` 到 `*/api/bot`、`payload.endpoint === 'create-bot'`、请求体是 `api.js` 那种 JSON 字符串。其余请求原参数转给原来的 `fetch`，不做解析、不改写。拿不到请求体（`Request` 对象）、解析失败、别的端点，一律直通——最坏情况是 Bot 的 `instructions` 为空，也就是这个包存在之前的行为。

用户在第 2 步取消时，插件不创建 Bot，而是回一个 `api.js` 已经认识的拒绝形状：

```json
{ "ok": false, "error": { "code": "bot/refused", "message": "已取消创建：没有创建 Bot。" } }
```

DS-Bot 的创建对话框把这句话显示在原处，人留在第 1 步，什么都没发生。请求带 `AbortSignal` 时，等待期间被中止会让拦截器以 `AbortError` 退出，和普通 `fetch` 一致。

## 策略记在哪，怎么读回来

宿主的 Bot 记录里没有 bot 级沙箱字段：`create-bot` 与 `update-bot` 只认上表那些键。所以策略写在 Bot 自己的 `instructions` 末尾，一行，人和机器都读得懂：

```
沙箱策略：on-demand（按需拉起）
```

说明非空时两者用空行隔开，完整形态是：

```
<用户写的说明>

沙箱策略：on-demand（按需拉起）
```

宿主侧以后要读这条策略，正则取最后一条匹配即可：

```
/^沙箱策略：(always|on-demand|none)/m
```

读回来的位置是 DS-Bot 自己的 `state` 视图：`bots[].instructions` 里就能看到这段文字（Bot 详情页展示的也是同一个字段，人可以直接改）。这也是为什么本插件不需要第二份存储：策略和说明是同一份 Bot 记录的一部分，跟随 Bot 一起复制、导出、备份。

## 为什么没有一行上游改动

- `ds-bot/` 是钉在 tag 上的子模块，本地改一行就是每次升级都要还一次的合并债。
- DS-Bot 的公开客户端扩展点 `window.dshBot` 只有 `registerShape` / `registerTheme` / `registerDetailsTab`，没有创建流程的 hook；要在对话框里插一步，只能改它的文件。
- 宿主已经把该有的都给了：`create-bot` 收 `instructions`，客户端只走一个 `fetch`。缺的只是「表单」和「请求改写」，两件都在浏览器这边。

## 挂载

```yaml
- insert:
    - id: omd-bot-wizard
      name: omd-bot-wizard
```

宿主半边 `src/index.ts` 是一个空 `apply()`：全部贡献在浏览器侧，这一行的存在只是让 Loader 把 Client 模块挂进 boot manifest（`dsh.client.immediately` 让脚本在启动阶段就取到，早于任何人点「新建 Bot」）。

## 层叠与外观

`shell.overlay` 在框架的浮层里（`z-index: 20`，`position: absolute; inset: 0`），而 DS-Bot 的创建面板是 `position: fixed; z-index: 45`。挂进 slot 的组件会渲染在自己所属对话框的**下面**，所以本插件在 `document.body` 上自建根节点，画在所有 DS-Bot 面板之上（`z-index: 120`，高于设置 60、命令面板 70），随 fiber 一起卸载。

样式只用 `--dsw-*` 全局 token 与 `color-mix`，跟随明暗主题与 `omd-skin` 的取值，不新增调色板。文案走 `ctx.locale`，中英各一份。
