# 核心数据模型与状态机

## 1. Bot（机器人配置）

由控制台创建 / 编辑，持久化在 `~/.larkbot/bots.json`。

```typescript
interface Bot {
  id: string;           // 内部唯一 id
  name: string;         // 展示名
  appId: string;        // 飞书应用 App ID
  appSecret: string;    // 飞书应用 App Secret
  cwd: string;          // traex 在开发机上的执行工作目录
  ownerOpenId: string;  // 白名单：只有这个 open_id 发的消息才响应
  enabled: boolean;
  disableStreamingCard?: boolean; // bot 级：关闭流式卡片，改用表情进度指示（默认 false）
}
```

> v1 只支持你自己（单 owner）。`ownerOpenId` 是唯一的权限边界，不做跨应用身份校验。
>
> `disableStreamingCard` 是 **bot 级全局开关**：开启后该 bot 的所有会话都不发实时刷新的
> 流式卡片，而是用表情回复指示进度（见 §6）。默认关闭（走流式卡片）。

## 2. Session（会话 = 话题）

内存对象，一个飞书话题（thread）唯一对应一个 Session。

```typescript
type SessionStatus = 'idle' | 'busy' | 'closed';

interface Session {
  threadId: string;         // 飞书话题 id —— 会话身份
  chatId: string;           // 所在会话（群/单聊）id
  botId: string;            // 归属的 Bot
  pty: IPty;                // node-pty 进程句柄
  status: SessionStatus;
  queue: string[];          // 未处理的用户消息（FIFO，不打断当前 turn）
  screenBuffer: string;     // 累积的 PTY 输出（供渲染 / idle 判定）
  cardMessageId?: string;   // 当前流式卡片 message_id，用于增量 PATCH
  currentTurnText?: string; // 当前轮的用户输入（卡片标题用）
  lastDataAt: number;       // 最近一次 pty.onData 时间戳（idle 判定用）
  spawnedAt: number;
  // 表情进度指示（仅 disableStreamingCard 时使用，见 §6）：
  pendingAckReactions?: Array<{ messageId: string; reactionId?: string }>;
}
```

## 3. 状态机

```
          @机器人 / 首条消息
   (none) ───────────────▶ idle
                            │
        queue 非空 & drain  │
            ┌───────────────┘
            ▼
          busy ──── pty 输出流式 PATCH 卡片（或表情进度，见 §6）
            │
   idle-detector 判定一轮结束
            │
            ▼
          idle ──── queue 还有 → 继续 drain；空 → 等待
            │
   卡片按钮 / 控制台 close
            ▼
         closed（pty.kill + 冻结卡片 + 从 map 删除）
```

状态转移规则：

| 事件 | 前置状态 | 动作 | 后置状态 |
|---|---|---|---|
| @机器人建话题 | none | spawn PTY | idle |
| 收到消息 | idle | `queue.push` + drain | busy |
| 收到消息 | busy | `queue.push`（不打断） | busy |
| idle-detector 触发 | busy | 冻结卡片；`queue` 非空则再 drain | idle / busy |
| 卡片按钮 / 控制台 close | any | `pty.kill` | closed |
| PTY 意外退出 | any | 通知 + 标记 | closed |

> **关闭会话** 由卡片上的按钮或控制台触发，**不是表情**。表情另有用途，见 §6。

## 4. 队列语义（核心卖点）

- **不打断**：busy 时到达的消息一律入队，绝不 `pty.write` 打断当前 turn
- **FIFO**：严格先进先出，一轮只发一条
- **边界情况**：
  - 空闲时连发 N 条 → 逐条按序执行（每条等上一条 idle）
  - 会话关闭时队列直接丢弃
  - 后续可扩展：合并相邻消息、优先级、`/stop` 强制打断（v1 不做）

## 5. 持久化（SessionStore 抽象）

```typescript
interface SessionStore {
  loadBots(): Promise<Bot[]>;
  saveBots(bots: Bot[]): Promise<void>;
  // v1：会话不持久化，daemon 重启即丢弃重开
  // 预留：saveSessions / loadSessions 供后续 resume
}
```

v1 用 JSON 文件实现。会话本身（含 PTY 句柄）不落盘，daemon 重启后活跃会话丢弃、下次 @ 重开。

## 6. 表情进度指示（关闭流式卡片时）

当 bot 配置 `disableStreamingCard = true`，会话不再发实时刷新的流式卡片，而是用
**表情回复**在触发消息上指示进度。只用两个表情：

| 阶段 | emoji_type | 含义 |
|---|---|---|
| 收到活儿 / 进行中 | `Get` | 已接收，开始处理 |
| 一轮做完 | `DONE` | ✅ 完成 |

流转：

- **收到活儿**：给用户那条触发消息 `addReaction` 一个 `Get`，并把
  `{ messageId, reactionId }` 记入 `session.pendingAckReactions`
- **一轮做完**（busy → idle 的边沿）：对每条待确认消息先 `removeReaction` 删掉 `Get`，
  再 `addReaction` 一个 `DONE`——两次独立 API，不是原地替换

```
用户消息 ──收到──▶ +Get（记 reactionId）
                     │
              一轮结束(busy→idle)
                     ▼
                -Get，+DONE
```

> 只保留 `Get` / `DONE` 两个表情，不引入更多中间状态。
> 这套逻辑属阶段三卡片体系的一部分；阶段一只打通纯文本闭环，不实现表情。
