/** 核心类型。所有模块从此导入，保持 IM/CLI 无关。 */
import type { IPty } from 'node-pty';

export interface Bot {
  id: string;
  name: string;
  appId: string;
  appSecret: string;
  cwd: string;          // traex 执行工作目录
  ownerOpenId: string;  // 白名单：只响应这个 open_id
  enabled: boolean;
  disableStreamingCard?: boolean; // bot 级：关闭流式卡片，改用表情进度指示（默认 false）
}

export type SessionStatus = 'idle' | 'busy' | 'closed';

export interface Session {
  threadId: string;         // 飞书话题 id —— 会话身份
  chatId: string;
  botId: string;
  pty: IPty;
  status: SessionStatus;
  queue: string[];          // FIFO，未处理的用户消息（不打断当前 turn）
  screenBuffer: string;     // 累积 PTY 输出（渲染 / idle 判定）
  cardMessageId?: string;   // 当前流式卡片 message_id
  currentTurnText?: string;
  lastDataAt: number;       // 最近 pty.onData 时间戳（idle 判定）
  spawnedAt: number;
  // 表情进度指示（仅 disableStreamingCard 时使用）：收到活儿加「进行中」表情并记录，
  // 一轮结束时删掉它再加「完成」表情。阶段三实现。
  pendingAckReactions?: Array<{ messageId: string; reactionId?: string }>;
}
