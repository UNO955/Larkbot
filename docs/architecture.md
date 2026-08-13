# 架构设计

## 1. 总体架构

larkmux 是一个**单进程 daemon**，跑在你的开发机上。因为只有一个 CLI、且都在本机，
v1 刻意**不 fork worker 子进程**：PTY 直接在 daemon 进程内管理，省掉跨进程 IPC 层。
崩溃隔离等问题留到后续再考虑。

```
┌──────────────────────────────────────────────────────┐
│  开发机（单进程 daemon）                                 │
│                                                        │
│   飞书长连接 (WSClient)   ← 主动连出，无需公网 IP         │
│         │  events                                      │
│   ┌─────▼──────┐   ┌────────────────┐                  │
│   │ IM 接入层   │──▶│ 会话编排器       │                 │
│   │ event-router│◀──│ SessionManager  │                │
│   └─────┬──────┘   └───────┬────────┘                  │
│         │ send/patch card  │ 每会话一个                  │
│         │           ┌──────▼────────┐                   │
│         │           │ Session        │                  │
│         │           │ ├ PTY(traex)   │                  │
│         │           │ ├ FSM idle/busy │                 │
│         │           │ ├ queue (FIFO) │                  │
│         │           │ └ renderer     │                  │
│         │           └──────┬────────┘                   │
│         │                  │ onData                     │
│   ┌─────▼──────┐    ┌──────▼────────┐                   │
│   │ card 渲染   │◀───│ idle-detector  │                 │
│   └────────────┘    └───────────────┘                   │
│                                                          │
│   控制台 Web (localhost) ── CRUD bot / 看会话 / 注入命令   │
└──────────────────────────────────────────────────────┘
```

## 2. 模块拆分

| 模块 | 文件 | 职责 |
|---|---|---|
| Daemon | `src/daemon.ts` | 启动、装配各模块、优雅退出 |
| Lark Client | `src/im/lark/client.ts` | 长连接订阅 + 发消息 / 发卡 / 加表情 |
| Event Router | `src/im/lark/event-router.ts` | 消息 → 建话题 / 入队；reaction → 进度指示 |
| Card Builder | `src/im/lark/card.ts` | 构建 / PATCH 流式卡片 |
| IM 抽象 | `src/im/types.ts` | `ImAdapter` 接口（预留多平台） |
| Session | `src/core/session.ts` | 单会话：PTY + 状态机 + 队列 |
| SessionManager | `src/core/session-manager.ts` | 话题 ↔ 会话映射、create / close |
| Idle Detector | `src/utils/idle-detector.ts` | 判断 traex 一轮是否结束 |
| CLI 抽象 | `src/adapters/cli/types.ts` | `CliAdapter` 接口（预留多 CLI） |
| traex 适配器 | `src/adapters/cli/traex.ts` | traex 的启动参数 / idle 特征 |
| 控制台 | `src/console/server.ts` | 建 / 编辑 bot、看会话、注入命令 |

## 3. 三个关键抽象

即使 v1 只有飞书 + traex，也把三处收进 interface，让后续扩展不需要重构主流程：

1. **`ImAdapter`**（IM 平台抽象）：发消息 / 发卡 / 加表情 / 收事件都走接口。后续可接企微、Slack。
2. **`CliAdapter`**（CLI 抽象）：traex 的 spawn 命令、idle 判定特征收进接口。后续可接 codex / claude。
3. **`SessionStore`**（持久化抽象）：v1 用 JSON 文件实现，接口留好。后续可换 SQLite / 支持 resume。

## 4. 关键流程

### 4.1 @机器人 → 建话题建会话

1. WSClient 收到 `im.message.receive_v1`，判断 mention 命中本 bot 且发送者在白名单
2. `reply` + `reply_in_thread: true` 回一条 → 拿到 `thread_id`（话题诞生）
3. `SessionManager.create(threadId)`：spawn `pty = spawn(traex, args, { cwd })`，状态置 `idle`
4. 首条消息进队列，触发 drain

### 4.2 话题内新消息 → 队列不打断

```
onMessage(threadId, text):
  s = sessions[threadId]
  s.queue.push(text)
  if s.status === 'idle': drain(s)   // 空闲才发，busy 就攒着

drain(s):
  if s.queue is empty: return
  s.status = 'busy'
  s.pty.write(s.queue.shift() + '\r')
```

### 4.3 流式卡片 + idle 检测

- `pty.onData` → 累积屏幕缓冲 → 每 ~500ms 节流 PATCH 卡片
- `idle-detector` 判定 traex 回到等待输入态 → `status = 'idle'`，冻结当前卡片，`drain(s)` 取下一条
- **这是全项目技术含量最高、也最可能拖期的一块**（见 roadmap 风险）

### 4.4 关闭会话 / 表情进度指示

- **关闭会话**：卡片按钮或控制台触发 → `pty.kill()` + 冻结卡片 + 从 map 删除
- **表情进度**：当 bot 关闭流式卡片时，订阅 `im.message.reaction.*`，在触发消息上用
  `Get`（收到）→ `DONE`（完成）标注一轮进度（详见 data-model §6）

### 4.5 主动命令注入

- 控制台 / 本地 HTTP：`POST /session/:threadId/inject { text }` → 等价用户发消息，进队列
- 为后续「定时任务 / 外部触发」预留入口
