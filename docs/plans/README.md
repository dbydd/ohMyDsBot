# 设计计划归档

| 文件 | 主题一句话 | 状态 |
|---|---|---|
| `docs/plans/omd-uri-agent-plan.md` | `agent://`：子代理的状态头与最终产出 | 仅设计 |
| `docs/plans/omd-uri-history-plan.md` | `history://`：会话转录、分页与错误形态 | 仅设计 |
| `docs/plans/omd-uri-artifact-plan.md` | `artifact://`：溢出输出的内容寻址读面 | 仅设计 |
| `docs/plans/omd-uri-proc-plan.md` | `proc://`：后台作业与 PTY 会话状态 | 仅设计 |
| `docs/plans/omd-uri-local-plan.md` | `local://`：跨会话共享的耐久文档与写入口 | 仅设计 |
| `docs/plans/omd-uri-cfg-plan.md` | `cfg://`：profile 条目的生效配置与层来源 | 仅设计 |
| `docs/plans/omd-github-plan.md` | `issue://` / `pr://` / `github://` 三个源与四个写工具 | 仅设计 |
| `docs/plans/omd-repo-binding-plan.md` | 项目根绑定 `repo.slug` 的存储、来源与消费约定 | 仅设计 |
| `docs/plans/omd-mention-trigger-plan.md` | `@` 提及 issue / PR 的候选、chip 与序列化 | 仅设计 |
| `docs/plans/omd-issue-watch-plan.md` | issue 变化轮询后直接写进待办，不唤醒会话 | 仅设计 |
| `docs/plans/omd-obsidian-plan.md` | Obsidian 原生能力：路径映射、解析索引与渲染 | 仅设计 |
| `docs/plans/omd-lsp-editor-survey.md` | Web UI 承载 LSP 编辑的档位与组件边界 | 仅设计（编辑视图）；LSP 挂载实现中 |
| `docs/plans/omd-todo-kanban-plan.md` | 待办一个条目一个目录，镜像到看板 | 实现中 |
| `docs/plans/omd-todo-maintenance-plan.md` | 待办瘦身、三态排序与归档地址 | 仅设计 |
| `docs/plans/omd-todo-rerank-plan.md` | 待办条目按判官分布重排（文本顺序即注意力） | 仅设计 |
| `docs/plans/omd-table-chart-plan.md` | 表格派生图表：启发式计划 + 判官补语义 | 仅设计 |
| `docs/plans/omd-memory-port-plan.md` | pi-hindsight 移植为 dsh 记忆后端 | 已实现（核心已实现、未挂载） |
| `docs/omd-internal-paths.md` | internal path 一等公民模块：源注册与统一语法 | 已实现 |
| `docs/omd-project-config.md` | 项目级配置：面板、存储与触发位置 | 已实现 |
| `docs/omd-multi-agent.md` | 多 agent 调度、角色系统、隔离与回收 | 已实现（`omd-roles`、`omd-task`、`omd-worktree-alloc`） |
| `docs/omd-design.md` | 宿主能力设计、组合拓扑与 dsh 缺口 | 已实现（`omd-chat-shell`、`omd-read` 卡片、`omd-memory-observe`）；`omd-read` 服务端迁移中 |
| `docs/omd-ui-backlog.md` | Web UI 可改边界与可视化缺口 | 仅设计（缺口已记录，未实现） |
| `docs/omd-selfmod.md` | 组合层自改：patchReload live、HMR 重组与回滚 | 已实测（组合层；源码层未验证） |

这些文档是某个时间点的设计结论，不是当前实现的说明书；状态列指的是当时该方向走到哪一步。
实现以 `plugins/*/README.md` 为准。
