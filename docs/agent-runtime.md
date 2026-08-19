# Agent Runtime

## 1. 定位

larkbot 的 Agent 层不是一个普通问答机器人，而是把飞书协作入口、开发机上的 traex CLI、会话路由、
权限治理和过程可观测性组合成一个团队可用的 Agent Runtime。

它解决的问题是：QA、客户端、前端或研发同学在群里提出项目排查问题时，不需要知道具体仓库、
日志平台、知识库路径或 CLI 操作方式。larkbot 负责把飞书里的自然语言请求路由到开发机上的
Agent 会话，让 Agent 在受控目录中读取共享 public 知识库、日志和代码，再把结论回到飞书话题。

## 2. Agent 会话路由

飞书本身只提供消息、群聊和话题。larkbot 在这之上建立了一层稳定的会话路由：

```text
chat_id + root_message_id / thread_id
        -> larkbot sessionId
        -> traex 原生 sessionId
```

这层路由的作用是把“群里的一个话题”绑定到“开发机上的一个 Agent 上下文”。用户在同一个话题中
继续追问时，daemon 能找到原来的 session，并尝试恢复同一个 traex 原生会话，而不是每次都新建
上下文。

路由状态分为两类：
- `active`：路由可继续使用，下一条话题消息会尝试 lazy resume。
- `closed`：路由保留用于控制台审计，但不再恢复上下文；用户继续 @ bot 时会提示重新发起新话题。

路由删除后会写入 `expired-sessions.json`。这样旧话题再次 @ bot 时，系统能明确告诉用户会话已过期，
而不是表现成静默失败或普通“找不到会话”。

## 3. Runtime 编排

每个 active session 在执行时会对应一个 traex PTY runtime。larkbot 没有把 Agent 逻辑重写一遍，
而是把成熟的开发机 CLI 当成可编排 runtime：

- 使用 `node-pty` 拉起 traex，保留 TTY、全屏输出和交互式输入能力。
- 每个 session 独立维护 runtime、队列、终端输出和卡片状态。
- 同一个 session 内多条消息按 FIFO 排队，不打断正在运行的 turn。
- 卡片或控制台的“停止分析”只中断当前 turn，不关闭 session 路由。
- daemon 重启后只恢复路由索引，不立即恢复所有 runtime；下一条消息到来时再 lazy resume。

这个模型把 Agent 的长上下文和运行时进程解耦：路由可以持久化，runtime 可以按需创建、停止、恢复或降级。

## 4. Turn 生命周期

一次用户请求在 larkbot 中被建模为一个 turn：

```text
飞书消息
  -> 权限和触发判断
  -> 找到或创建 Session
  -> 入队
  -> spawn / resume traex
  -> 写入 Prompt
  -> 采集 PTY 输出
  -> idle / final 判定
  -> 更新分析卡片
  -> 发送最终回复
```

关键点：
- busy 时新消息只入队，不抢占当前 turn。
- `IdleDetector` 结合终端 quiet 时间、spinner 状态和 ready prompt 判断一轮是否结束。
- 如果 traex rollout 中已经出现明确 final，优先使用 rollout final 作为最终回复。
- 如果 resume 失败，会清掉原 cli session id，并降级为新上下文继续处理，避免会话彻底不可用。

## 5. Prompt 注入

larkbot 不只是把用户原文转发给 traex。每次输入都会包装一层结构化上下文：

- session 路由信息；
- sender open_id 和可用昵称；
- 当前 bot 的 system prompt profile；
- 用户消息；
- 引用消息；
- 图片或文件附件；
- larkbot 自身的运行提醒。

Prompt Profile 由控制台管理，可用于切换 Agent 行为。例如只读日志排查、代码审查、简洁回答等。
这让同一个 runtime 框架可以承载不同工作模式，而不用为每种场景单独写一套 bot。

## 6. 安全边界

larkbot 的安全边界放在 Agent Runtime 外层，而不是依赖模型自觉：

- Owner 始终可用，负责配置和运维。
- 群聊必须在控制台启用后，群内成员才能使用。
- 单独用户授权通过 `allowedOpenIds` 补充。
- 执行目录固定在 bot 配置的 `cwd`。
- 飞书卡片只暴露状态、最终回复和只读终端入口。
- 控制台终端是只读视图，不提供直接写入 shell 的入口。
- 会话自动关闭和过期清理，避免长期遗留可恢复上下文。

这套边界的目标不是做复杂多租户系统，而是在单开发机 Agent 模型下，把“谁能用、在哪用、能恢复多久、
能看到什么”控制清楚。

## 7. 可观测性

Agent 执行过程不是黑盒。larkbot 提供了三层可观测性：

- 飞书分析卡片：展示“正在全力分析中… / 分析完成 / 已停止分析”、总耗时和 token。
- 只读终端页面：通过控制台查看完整 traex 输出，适合 Owner 或研发定位 Agent 行为。
- 会话管理：展示会话状态、发起人、群聊、模型、时间、工作目录和原生 cli session id。

此外，daemon 重启和定时清理会通过飞书私聊通知 Owner。通知里包含版本、未结束会话、恢复路由数量、
执行目录和清理策略，便于判断运行状态是否符合预期。

## 8. 生命周期治理

会话生命周期分为运行期和路由期：

- 运行期：PTY runtime 存在，正在执行或等待下一轮消息。
- 路由期：runtime 可以不存在，但 `sessions.json` 中仍保留恢复索引。

当前策略：
- 每天 03:00 执行清理。
- 3 天以上未活跃的 active 会话会被关闭，状态变为 `closed`。
- 7 天以上未活跃的路由会被删除，并写入过期墓碑。
- 有实际关闭或删除动作时，私聊 Owner 汇总明细。

这样做的原因是：Agent 上下文需要可恢复，但不能无限期保存。关闭和删除分开，可以同时满足控制台审计、
用户提示和状态文件收敛。

## 9. 技术取舍

| 取舍 | 原因 |
|---|---|
| 用飞书长连接而不是 webhook | 开发机主动连出，不需要公网入口或内网穿透 |
| 用 PTY 而不是普通 stdout | traex 是交互式 CLI，需要真实 TTY 语义 |
| 单进程 daemon | 当前是单开发机代理，优先降低状态同步和部署复杂度 |
| JSON 文件持久化 | MVP 阶段状态量小，便于检查和迁移 |
| 卡片和终端拆分 | 飞书承载状态和结果，控制台承载高频过程输出 |
| lazy resume | 重启后不批量拉起 runtime，降低启动成本和副作用 |

## 10. 可扩展方向

当前抽象已经为后续扩展留出接口：

- `ImAdapter` 可替换飞书为其他 IM。
- `CliAdapter` 可替换 traex 为其他 Agent CLI。
- `SessionStore` 可从 JSON 文件迁移到 SQLite。
- Prompt Profile 可扩展为按群、按项目或按任务类型自动选择。
- 生命周期清理可扩展为可配置策略和手动归档。

这些扩展不改变核心模型：larkbot 始终是飞书入口到开发机 Agent Runtime 的安全路由和编排层。
