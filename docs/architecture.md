# 架构设计

## 1. 总体架构

larkbot 的本质是一个“开发机替身”：飞书负责接收意图和展示结果，开发机负责真实执行。
它不把代码仓库、CLI 凭证、知识库或运行环境搬到云端，而是在本地 daemon 中管理 traex 会话，
读取开发机上的共享 public 知识库，再把会话状态和结论映射回飞书话题。

Agent Runtime 的专项设计见 [agent-runtime.md](agent-runtime.md)。本文只展开系统模块和主流程。

这个架构有三个核心约束：
- **远程入口**：启用后的飞书群成员可以发起、继续、停止任务，Owner 始终可用。
- **本地执行**：所有 traex、代码仓库、共享知识库、状态文件都留在开发机。
- **可观察性**：用户能看到当前分析状态、最终回复和完整只读终端过程。

```
飞书用户
  │ @ / 话题回复 / 引用回复
  ▼
飞书长连接 WSClient
  ▼
src/daemon.ts
  ├─ LarkClient：收消息、发卡片、patch 卡片、表情、下载附件
  ├─ ConversationManager：会话路由、队列、PTY、idle、恢复、停止
  ├─ ConsoleServer：本地控制台、只读终端、模型列表、bot 配置
  ├─ JsonSessionStore：~/.larkbot/bots.json 与 sessions.json
  ├─ Public Knowledge Base：脱敏同步后的共享项目知识
  └─ TraexAdapter：spawn / resume / usage / final message
```

核心原则：
- 一个飞书话题对应一个 larkbot Session。
- 同一 Session 内消息按 FIFO 排队，不打断正在执行的 turn。
- 每个 turn 通过 node-pty 写入 traex，并用 IdleDetector 判断完成。
- 卡片只展示分析状态和最终结果；完整终端输出通过控制台只读页查看。

## 2. 关键设计取舍

### 2.1 为什么是单进程 daemon

当前使用场景是单开发机代理：可以服务群里的多个授权提问者，但真实执行资源仍集中在一台开发机。
瓶颈不在多租户吞吐，而在会话状态、PTY 输出、知识库读取和飞书回贴的稳定性。因此 v1 选择单进程
管理所有运行时，避免 worker IPC、跨进程状态同步和额外故障面。

后续如果要支持多用户或多 CLI 并发，可以在 `CliAdapter` 和 `SessionStore` 抽象上扩展，而不需要
改 IM 接入和卡片协议。

### 2.2 为什么搭配共享 public 知识库

QA、客户端和前端同学提问时，问题通常不是“执行一个命令”，而是“这个业务对象为什么没生效”。
这类问题需要先对齐项目口径：对象是什么、承载在哪个字段、相邻链路有哪些、判定点是什么。

因此 larkbot 把开发机上的 public 知识库作为排查前置输入。知识库由本地资料脱敏同步而来，
Agent 先读知识库建立判定口径，再用日志和代码验证。这样飞书里的非研发提问者也能得到可转述的
服务端结论，而不是只看到原始日志片段。

### 2.3 为什么用 PTY 而不是普通子进程 stdout

traex 是交互式全屏 CLI，会依赖 TTY、光标控制、备用屏和 ready prompt。普通 stdout 无法完整模拟
真实用户终端。larkbot 用 node-pty 启动 traex，再用 `TerminalRenderer` 清洗终端控制字符，保留
对 CLI 的真实交互能力。

### 2.4 为什么卡片和终端拆开

飞书卡片适合承载状态、按钮和最终结果，不适合高频展示全屏 TUI 重绘。实时终端输出放在控制台
只读 xterm 中，飞书卡片只保留“正在全力分析中… / 分析完成 / 已停止分析”与耗时、token。
这能减少消息噪音，也避免把 prompt 包装、工具轨迹和敏感 echo 暴露到飞书正文。

## 3. 当前模块

| 模块 | 文件 | 职责 |
|---|---|---|
| Daemon | `src/daemon.ts` | 装配配置、飞书 client、会话管理、控制台、清理任务 |
| Lark Client | `src/im/lark/client.ts` | 飞书长连接、消息解析、卡片/文本/表情 API、附件下载 |
| Message Parser | `src/im/lark/message-parser.ts` | 飞书消息、引用、附件、mention 解析 |
| Card Builder | `src/im/lark/card-builder.ts` | 分析卡片、最终回复卡、停止按钮、耗时/token footer |
| ConversationManager | `src/core/conversation-manager.ts` | 会话路由、PTY 生命周期、队列、恢复、停止、卡片更新 |
| Store | `src/core/store.ts` | bot/session JSON 持久化，默认 `~/.larkbot/` |
| Prompt | `src/core/prompt.ts` | larkbot routing/reminder、用户消息、附件、profile prompt 包装 |
| Reactions | `src/core/reactions.ts` | `Get` / `DONE` 表情常量 |
| Traex Adapter | `src/adapters/cli/traex.ts` | traex 启动参数、模型透传、resume、usage/final 读取 |
| Terminal Renderer | `src/utils/terminal-renderer.ts` | 终端输出清洗、trace/answer 拆分、提示词 echo 隐藏 |
| Idle Detector | `src/utils/idle-detector.ts` | quiescence + spinner guard + readyPattern idle 判定 |
| Console Server | `src/console/server.ts` | 控制台 HTML/API、独立页面、只读 xterm、SSE 输出、模型列表 |

## 4. 关键流程

### 4.1 首次 @ 机器人

1. `LarkClient` 通过 WSClient 收到 `im.message.receive_v1`。
2. `daemon` 校验 bot、Owner、群聊授权 / 用户授权和消息触发规则。
3. 发送首张“正在全力分析中…”卡片，并用 `reply_in_thread` 建话题。
4. 创建 `Session` 路由，持久化到 `~/.larkbot/sessions.json`。
5. `ConversationManager` spawn traex PTY，等待 ready prompt 后写入用户消息。

### 4.2 话题后续消息

1. 通过 `threadId`、root message、anchor/card message id 反查 Session。
2. 如果 runtime 已存在，消息进入当前 FIFO 队列。
3. 如果 daemon 重启后只有路由，下一条消息触发 lazy resume。
4. resume 失败时清空 cliSessionId，以新上下文降级继续处理。

### 4.3 一轮分析

1. turn 入队后，`ConversationManager` 设置 busy，并记录开始时间。
2. `TraexAdapter.writeInput` 通过 bracketed paste 写入 PTY。
3. `TerminalRenderer` 清洗终端输出，隐藏 larkbot prompt 包装和敏感 echo。
4. 分析卡片展示“正在全力分析中…”，footer 同步 token 和耗时。
5. `IdleDetector` 或 traex rollout final 判定 turn 结束。
6. 完成后 patch 分析卡片为“分析完成”，再发送最终回复卡。

### 4.4 停止本轮分析

停止入口来自卡片按钮或控制台 `/sessions/:id/interrupt`。

停止只中断当前 turn：
- 关闭当前 PTY。
- patch 分析卡片为“已停止分析”，footer 保留总耗时和 token。
- 捕获可用的 traex 原生 session id。
- 下一条消息到来时尝试 resume；失败则降级新上下文。

### 4.5 控制台

控制台默认监听 `CONSOLE_PORT`，未配置时为 `8787`。

主要能力：
- `GET /`：控制台总览。
- `GET /config`：bot 配置、系统提示词 profiles、模型和落款。
- `GET /chats`：群聊发现和授权。
- `GET /sessions`：按全部 / 活跃 / 已关闭筛选会话路由。
- `GET /feedback`：查看好评 / 差评反馈。
- `GET /office`：3D 办公室视图、员工状态和工时统计。
- `GET /api/models`：执行 `traex models` 获取模型列表。
- `PATCH /api/bot`：保存 bot 配置，模型只影响新会话。
- `GET /terminal/:sessionId`：只读 xterm 页面。
- `GET /api/terminal/:sessionId/events`：SSE 推送终端输出。
- `PATCH /api/sessions/:id`：关闭会话路由。
- `GET /sessions/:id/interrupt`：停止当前 turn。

## 5. 持久化

默认状态目录：`~/.larkbot/`。

| 文件 | 内容 |
|---|---|
| `bots.json` | bot 配置、模型、prompt profiles、落款、流式卡片开关 |
| `sessions.json` | 会话路由、发起人、群聊、thread/root/card message id、模型、cliSessionId |
| `expired-sessions.json` | 被 7 天清理策略删除的路由墓碑，用于旧话题过期提示和清理审计 |

可以通过 `LARKBOT_STATE_DIR` 覆盖状态目录。

## 6. 命名

代码包名、控制台标题、状态目录和文档统一使用 `larkbot`。
