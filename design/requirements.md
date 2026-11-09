# omd-context-tavern 需求

- REQ-1 **前缀缓存保护**：「后面的滑动区域仍然保持线性增长」，在触发压缩前严禁在历史中间插入或修改任何内容——「如果不利用稳定前缀的话真的会很烧钱」。
- REQ-2 **纪元换届**：「前面的动态呼吸区则每次compact时刷新」：达到阈值后把滑出窗口的历史归档、做一轮记忆反思、重播种动态世界书，并生成新的冻结前缀。
- REQ-3 **深度临门一脚**：Author's Note 与当前最高优先级的心智模型紧贴当前用户输入上方注入（Depth 1）；「hindsight是动态注入，更多变」。
- REQ-4 **全参弹性配置**：「各个部分的阈值和宽容范围需要做成可配置项」——判定模型超时（50ms～15000ms 随设备与模型漂移）、「波动范围其实会很大，不适合写死」。
- REQ-5 **历史逃生通道**：「但我们还可以额外保留一个history://让他自己去读完整历史」：移出实时窗口的远期历史按会话暴露为只读内部路径，模型可自主调阅。
- REQ-6 **AGENTS.md 保留与 Prewalk 接管**：「agents.md给他关掉先别删就行，说不定真的还有用得上的时候」，后续「把爬到的信息先用prewalk agent给拆进世界书里」。
- REQ-7 **DS-Bot 双生换届融合**：在 DS-Bot 团队会话（Bot 单聊与群聊）中，接管 DS-Bot Context Steward 的原地凝聚（`compact` / `[Checkpoint N]`）与跨段切换（`switch` / `[Handoff · part N]`）两条路径；每次换届同步触发纪元归档、记忆沉淀、世界书重播种与 DS-Bot 自身记忆快照刷新（`renewMemory`），并按 `botId` / `roomId` / `team` 三层作用域隔离世界书目录。
- REQ-8 **双模 Web GUI 面板接入**：在 DS-Bot 模式下通过 `window.dshBot.registerDetailsTab` 挂入右侧 Bot/群聊详情抽屉标签页，在普通 Agent 模式下通过 `sidebar.footer.action` + `shell.overlay` 挂入工作区浮层；面板展示当前纪元与冻结前缀状态、世界书条目库（常驻/动态开关、关键词、优先级、Token 开销）及 Author's Note（Depth 1 临门一脚）编辑器，且用户对常驻条目与 Author's Note 的修改在当前纪元内只暂存（Staged）、不直接改写已冻结前缀，待下一次换届（或手动触发重播种）时再生效，严格守护前缀缓存。

## 沙箱环境与 Agent-with-VM 系统需求

- REQ-9 **工作区极简 COW 隔离（去 Git 化）**：工作区彻底抛弃 Git Worktree 依赖，采用 OVNFS 风格的极简 COW 方案（基于宿主 APFS clonefile 或轻量 Overlay 目录），支持秒级无拷贝创建独立分支工作区、写时穿透与基于快照基线的差异比对，用完原子回收，零磁盘冗余。
- REQ-10 **Agent-with-VM 控制与执行解耦**：Agent 控制器（Prompt 组装、Session 日志、LLM 网关、长期记忆）驻留宿主，Linux 虚拟机仅作为无状态执行靶机，通过双向安全通信通道派发任务，避免在虚拟机内运行重型宿主环境。
- REQ-11 **原生 ARM64 极简虚拟桌面**：沙箱运行时严格采用 ARM64（aarch64）架构（零指令转译开销与低功耗），基础镜像采用 Debian 12 minimal（无 snapd 沉重服务，glibc 兼容性完备，内存开销 ~130MB），内部运行 Xvfb / 虚拟显示服务。
- REQ-12 **双向可视化监控与人工无缝接管**：虚拟机桌面通过 noVNC / WebSocket 实时推流至宿主 WebUI 任务卡片，用户可实时旁路观察 Agent 的桌面操作，并在需要时通过点击与输入实现人工实时接管（Human-in-the-loop）。
- REQ-13 **语义化 Computer Use 控件打标与操作**：在 VM 内部集成基于 Linux 原生 AT-SPI2 的桌面控制桥（如 `computer-use-linux`），为桌面控件建立语义压缩树与 `@eN` 编号，Agent 优先使用控件句柄执行动作，并支持单往返操作后置自动回读与验证。
- REQ-14 **内置 Browser Use 靶场与 DOM 降噪**：浏览器（Chromium）运行于 VM 虚拟桌面内，其界面直接呈现在桌面视频流中；面向模型的控制接口提供紧凑的 Accessibility / Bounding Box 元素打标封装，避免向模型暴露原始复杂 CDP。

## 身份系统、VM 所有权与人机协同需求

- REQ-15 **调用方拥有的 Worker 与会话延续**：每个被唤起的编码 Agent 视为其调用者（Bot 或 Session）拥有的 subagent；任务生命周期与 VM 绑定；针对未完成工单的 `review` 反馈必须命中同一 worker 与同一台 VM，严禁重新分配机器或创建孤儿工作区。
- REQ-16 **语义化内部路径与资源映射**：模型可见的交互严格使用语义化 internal path（形如 `onlyne://runner/issue/<id>`），底层传输系统（Onlyne NodeId）保持既有格式；系统维护单一显式映射表（`internal path ↔ resource identity`），不强制篡改协议底层格式，不搞多格式兼容垫片。
- REQ-17 **右侧栏可视化靶场与实时插话**：DS-Bot 右侧栏提供 Worker 状态卡片集，展示其所属父 Bot、执行进度、资源占用与内嵌 noVNC 桌面，并提供实时交互输入通道（插话），允许人类向运行中的 Agent 随时注入自然语言指导。
- REQ-18 **Bot 创建向导的能力预设分步**：Bot 创建流程分为身份（名称、头像、角色设定）与能力（世界书、Onlyne 域、VM 沙箱策略：`always` / `on-demand` / `none`）两步；VM 的基础策略配置在创建时完成，所有敏感凭证（如 VNC 密钥）由模块内部静默自签，严禁进入用户配置视野或模型上下文。
