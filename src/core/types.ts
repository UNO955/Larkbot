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
  /** 控制台可维护的系统提示词预设；下一轮消息生效，不强制重启现有 traex 进程。 */
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

export type SessionWorkLogStatus = 'completed' | 'failed' | 'stopped';

export type TicketSource = 'feishu_dm' | 'feishu_group' | 'console' | 'manual';
export type TicketStatus = 'open' | 'analyzing' | 'waiting_user' | 'resolved' | 'closed' | 'failed' | 'archived';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface Ticket {
  /** 长期问题档案。Session 只是某次执行上下文，Ticket 删除/保留策略独立于会话。 */
  id: string;
  source: TicketSource;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  ownerOpenId?: string;
  createdByOpenId?: string;
  createdByName?: string;
  chatId?: string;
  chatName?: string;
  messageId?: string;
  rootMessageId?: string;
  threadId?: string;
  currentSessionId?: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export type TicketTraceEventKind = 'turn_started' | 'trace_snapshot' | 'turn_completed' | 'turn_failed' | 'turn_stopped';

export interface TicketTraceEvent {
  id: string;
  ticketId: string;
  sessionId: string;
  turnId?: string;
  kind: TicketTraceEventKind;
  status?: SessionWorkLogStatus | 'working';
  message?: string;
  question?: string;
  answer?: string;
  trace?: string;
  createdAt: string;
}

export type AppLogLevel = 'info' | 'warn' | 'error';
export type AppLogCategory = 'daemon' | 'lark' | 'traex' | 'ticket' | 'console' | 'cleanup' | 'system';

export interface AppLogRecord {
  /** larkbot 内部日志 id，用于从控制台或聊天上下文反查一条运行日志。 */
  id: string;
  level: AppLogLevel;
  category: AppLogCategory;
  message: string;
  sessionId?: string;
  ticketId?: string;
  turnId?: string;
  traceEventId?: string;
  requestId?: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface SessionWorkLog {
  /** 一轮用户消息对应一条日志，用于办公室精确工时统计。 */
  id: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status?: SessionWorkLogStatus;
}

export interface Session {
  /** 飞书话题到 traex 原生会话的持久化路由。 */
  sessionId: string;        // larkbot 自己的会话 id
  ticketId?: string;
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
  latestQuestion?: string;
  latestQuestionMessageId?: string;
  latestAnswer?: string;
  latestKnowledge?: KnowledgeObservation;
  /** 每轮任务的起止时间；比 createdAt/closedAt 更适合做精确工时。 */
  workLogs?: SessionWorkLog[];
  closedAt?: string;
  lastMessageAt: string;
  createdAt: string;
}

export interface ExpiredSession {
  sessionId: string;
  ticketId?: string;
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
  workLogs?: SessionWorkLog[];
  deletedAt: string;
  reason: 'retention_expired';
}

export type FeedbackRating = 'positive' | 'negative';
export type FeedbackStatus = 'open' | 'reviewing' | 'resolved' | 'ignored';

export interface KnowledgeReference {
  path: string;
  source: 'trace' | 'answer' | 'structured';
  evidence?: string;
}

export interface EvidenceReference {
  value: string;
  source: 'structured';
  evidence?: string;
}

export interface KnowledgeObservation {
  /** 本轮从隐藏结构化证据和兜底文本扫描中提取到的引用来源。 */
  references: KnowledgeReference[];
  codeReferences?: EvidenceReference[];
  logReferences?: EvidenceReference[];
  noReferenceReason?: string;
  updatedAt: string;
}

export interface FeedbackRecord {
  id: string;
  ticketId?: string;
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
  question?: string;
  answer?: string;
  knowledge?: KnowledgeObservation;
  reason?: string;
  note?: string;
  reviewNote?: string;
  createdAt: string;
  updatedAt: string;
}
