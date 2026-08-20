/** 核心类型。所有模块从此导入，保持 IM/CLI 无关。 */

export interface Bot {
  id: string;
  name: string;
  appId: string;
  appSecret: string;
  cwd: string;          // traex 执行工作目录
  ownerOpenId: string;  // 管理者 open_id，默认也具备使用权限
  allowedOpenIds?: string[]; // 额外允许直接提问 / 操作卡片的用户 open_id
  allowedChatIds?: string[]; // 启用后允许群内成员直接使用的群聊 chat_id
  knownChats?: KnownChat[]; // bot 已感知到的群聊，用于控制台启用
  enabled: boolean;
  model?: string;       // traex 启动模型，留空表示使用 CLI 默认
  disableStreamingCard?: boolean; // bot 级：关闭流式卡片，改用表情进度指示（默认 false）
  replySignature?: string;
  systemPromptProfiles?: SystemPromptProfile[];
  activeSystemPromptProfileId?: string;
}

export interface SystemPromptProfile {
  id: string;
  name: string;
  content: string;
}

export interface KnownChat {
  chatId: string;
  name?: string;
  lastSeenAt: string;
  source: 'message' | 'bot_added';
}

export type SessionStatus = 'active' | 'closed';

export interface Session {
  sessionId: string;        // larkbot 自己的会话 id
  chatId: string;
  rootMessageId: string;    // 飞书话题根消息
  threadId?: string;
  anchorMessageId?: string; // 话题内用于 reply_in_thread 的锚点消息
  initialCardMessageId?: string; // 建话题时发出的首张运行中卡片，首轮输出直接 patch 它
  traceCardMessageId?: string; // 最近一张分析卡 message_id，用于引用/回复卡片时反查会话
  answerCardMessageId?: string; // 最近一张最终回复卡 message_id，用于引用/回复卡片时反查会话
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

export interface ExpiredSession {
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

export type FeedbackRating = 'positive' | 'negative';
export type FeedbackStatus = 'open' | 'reviewing' | 'resolved' | 'ignored';

export interface FeedbackRecord {
  id: string;
  rating: FeedbackRating;
  status: FeedbackStatus;
  sessionId: string;
  sessionTitle: string;
  chatId?: string;
  chatName?: string;
  operatorId: string;
  operatorName?: string;
  terminalUrl: string;
  traceExcerpt?: string;
  reason?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}
