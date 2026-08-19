# 核心数据模型与状态机

数据模型围绕一个核心问题设计：飞书里的话题如何稳定映射到开发机上的 traex 会话。

因此 larkbot 把状态拆成两层：
- **持久路由状态**：Bot 和 Session，写入 JSON 文件，用来跨 daemon 重启恢复“这条飞书话题应该连回哪个会话”。
- **运行时执行状态**：Runtime，只存在内存里，用来管理 PTY、队列、idle 检测和卡片更新。

这避免了把不可序列化的 PTY 句柄落盘，同时保留了恢复 traex 原生会话所需的最小信息。

## 1. Bot

Bot 由控制台创建 / 编辑，持久化在 `~/.larkbot/bots.json`。

```typescript
interface Bot {
  id: string;
  name: string;
  appId: string;
  appSecret: string;
  cwd: string;
  ownerOpenId: string;
  allowedOpenIds?: string[];
  allowedChatIds?: string[];
  knownChats?: KnownChat[];
  enabled: boolean;
  model?: string;
  disableStreamingCard?: boolean;
  replySignature?: string;
  systemPromptProfiles?: SystemPromptProfile[];
  activeSystemPromptProfileId?: string;
}

interface KnownChat {
  chatId: string;
  name?: string;
  lastSeenAt: string;
  source: 'message' | 'bot_added';
}

interface SystemPromptProfile {
  id: string;
  name: string;
  content: string;
}
```

字段说明：
- `cwd`：traex 的执行目录。
- `ownerOpenId`：管理者 open_id，默认具备提问和操作权限。
- `allowedChatIds`：已启用的群聊列表。群聊启用后，群内成员可以直接 @ bot 提问或操作卡片。
- `knownChats`：bot 已感知到的群聊列表，来自入群事件或群消息，用于控制台展示和启用。
- `allowedOpenIds`：额外授权用户列表，适合单聊或临时放开某个用户；团队群使用优先走群聊授权。
- `model`：新建 traex 会话时透传为 `--model <model>`；已有会话不被静默切换。
- `disableStreamingCard`：关闭实时分析卡片时，改用 `Get` / `DONE` 表情指示进度。
- `replySignature`：最终回复卡 footer 落款，默认 `larkbot`。
- `systemPromptProfiles`：控制台维护的系统提示词集合。
- `activeSystemPromptProfileId`：新消息包装 prompt 时使用的 profile。

## 2. Session

Session 是 larkbot 的会话路由，持久化在 `~/.larkbot/sessions.json`。它不保存 PTY 句柄；
daemon 重启后只恢复路由，下一条消息再 lazy resume traex 原生会话。

```typescript
type SessionStatus = 'active' | 'closed';

interface Session {
  sessionId: string;
  chatId: string;
  rootMessageId: string;
  threadId?: string;
  anchorMessageId?: string;
  initialCardMessageId?: string;
  traceCardMessageId?: string;
  answerCardMessageId?: string;
  scope: 'thread';
  title: string;
  status: SessionStatus;

  workingDir: string;
  cliId: 'traex';
  model?: string;
  cliSessionId?: string;
  hasHistory: boolean;

  ownerOpenId?: string;
  createdByOpenId?: string;
  createdByName?: string;
  lastCallerOpenId?: string;
  chatName?: string;
  closedAt?: string;
  lastMessageAt: string;
  createdAt: string;
}
```

关键字段：
- `rootMessageId` / `threadId`：飞书话题身份。
- `anchorMessageId`：用于 reply_in_thread 的锚点。
- `initialCardMessageId`：建话题时预发的首张分析卡；首轮输出直接 patch 它。
- `traceCardMessageId`：最近一张分析卡，用于引用/按钮反查会话。
- `answerCardMessageId`：最近一张最终回复卡，用于引用回复反查会话。
- `cliSessionId`：traex 原生会话 id，用于 resume、token usage、final message 读取。
- `model`：创建该 Session 时使用的模型。
- `createdByOpenId / createdByName`：会话发起人，用于控制台追踪是谁开启的会话。
- `chatName`：建会话时记录的群聊快照；控制台展示时优先用 `knownChats` 中回填后的最新群名。
- `closedAt`：会话被控制台或清理任务关闭的时间。

## 3. Runtime

Runtime 只存在于内存中，由 `ConversationManager` 管理。

```typescript
interface Runtime {
  route: Session;
  pty: IPty;
  detector: IdleDetector;
  renderer: TerminalRenderer;
  queue: QueuedTurn[];
  status: 'idle' | 'busy';
  ready: boolean;
  resumeAttempt: boolean;
  intentionalClose: boolean;
  streamingCardDisabled: boolean;
  turnStartedAtMs?: number;
}
```

Runtime 负责：
- 持有 PTY 进程。
- 维护 FIFO turn 队列。
- 通过 `IdleDetector` 判断 turn 完成。
- 通过 `TerminalRenderer` 拆分分析过程和最终回复。
- 记录 turn 开始时间，用于分析卡 footer 展示总耗时。

## 4. 状态机

```
无路由
  │ @ bot / 首条消息
  ▼
active + runtime idle
  │ turn 入队
  ▼
active + runtime busy
  │ idle / rollout final
  ▼
active + runtime idle
  │ 控制台关闭
  ▼
closed
```

规则：
- busy 时新消息只入队，不打断当前 turn。
- idle 后如果队列非空，继续 drain 下一条。
- 停止本轮分析会杀掉当前 PTY，但 Session 仍为 `active`，下一条消息尝试 resume。
- 关闭会话才会将 Session 标记为 `closed`。
- 每天凌晨 3 点执行生命周期清理：关闭 3 天以上未活跃的会话，删除 7 天以上未活跃的路由。
- 被删除的路由会写入 `expired-sessions.json`，旧话题再次 @ bot 时会得到“会话已过期清理，请重新发起”的明确提示。
- 清理任务只在实际关闭或删除会话时私聊 Owner 汇总明细，不做空跑打扰。

## 5. ExpiredSession

`ExpiredSession` 是被清理路由的最小墓碑记录，持久化在 `~/.larkbot/expired-sessions.json`。
它不保存对话内容，只保存识别旧话题和审计清理结果所需的信息。

```typescript
interface ExpiredSession {
  sessionId: string;
  chatId: string;
  chatName?: string;
  rootMessageId: string;
  threadId?: string;
  anchorMessageId?: string;
  traceCardMessageId?: string;
  answerCardMessageId?: string;
  title: string;
  createdByOpenId?: string;
  createdByName?: string;
  lastCallerOpenId?: string;
  lastMessageAt: string;
  createdAt: string;
  closedAt?: string;
  deletedAt: string;
  reason: 'retention_expired';
}
```

## 6. 分析卡片状态

分析卡片状态来自 `CardStatus`：

| 状态 | 展示文案 | 含义 |
|---|---|---|
| `working` | 正在全力分析中… | turn 正在执行 |
| `completed` | 分析完成 | turn 已完成 |
| `stopped` | 已停止分析 | 当前 turn 被用户停止 |
| `failed` | 分析失败 | traex 或链路失败 |

完成或停止状态的 footer 包含：
- `⏱️ 总耗时：xx`
- 当前 traex 会话累计 token（如果能从 rollout 读取）

## 7. 模型选择

控制台通过 `GET /api/models` 执行 `traex models` 动态获取可用模型。

保存 bot 的 `model` 后：
- 新建 Session 时透传为 `--model <model>`。
- 已存在 Session 保持创建时的模型。
- 空模型表示使用 traex CLI 默认模型。

## 8. 表情进度指示

当 `disableStreamingCard = true` 时，不发送实时分析卡片，改用触发消息上的表情表示进度。

| 阶段 | emoji_type | 含义 |
|---|---|---|
| 收到 / 进行中 | `Get` | 已接收，开始处理 |
| 完成 | `DONE` | 一轮完成 |

一轮完成时会先删除 `Get`，再添加 `DONE`。
