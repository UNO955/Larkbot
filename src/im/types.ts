/**
 * IM 平台抽象层。
 *
 * v1 只有飞书实现（src/im/lark/），但所有发消息 / 发卡 / 加表情 / 收事件都走这层接口，
 * 主流程不直接依赖飞书 SDK —— 后续可接企业微信 / Slack 而不改编排逻辑。
 */

export type MsgFormat = 'text' | 'rich';

export interface ImAttachment {
  type: 'image' | 'file';
  path: string;
  name?: string;
}

export interface ImMessage {
  id: string;
  threadId: string;
  rootMessageId: string;
  chatId: string;
  senderId: string;
  senderType: 'user' | 'bot';
  senderName?: string;
  content: string;
  attachments?: ImAttachment[];
  quotedMessageId?: string;
  createTime: string;
}

export interface ImReaction {
  messageId: string;
  emoji: string;
  operatorId: string;
}

export interface ImCard {
  payload: unknown;
}

/** 编排层向 IM 层注册的事件回调。 */
export interface ImEventHandler {
  /** 用户 @ 机器人（尚无话题）—— 触发建话题 + 建会话。 */
  onMention(msg: ImMessage): Promise<void>;
  /** 已存在的话题内收到新消息 —— 入队。 */
  onThreadReply(msg: ImMessage): Promise<void>;
  /** 表情回复事件（阶段一 no-op；阶段三用于进度指示相关判定）。 */
  onReaction(reaction: ImReaction): Promise<void>;
}

export interface ImAdapter {
  start(handler: ImEventHandler): Promise<void>;
  stop(): Promise<void>;

  /** 在指定话题回复文本；返回新消息 message_id。 */
  reply(threadId: string, content: string, format: MsgFormat, replyAnchorMessageId?: string): Promise<string>;
  /** 首次 @ 时创建话题并回复；返回 { threadId, messageId }。 */
  replyInThread(rootMessageId: string, content: string): Promise<{ threadId: string; messageId: string }>;
  /** 首次 @ 时用卡片创建话题并回复；返回 { threadId, messageId }。 */
  replyCardInThread(rootMessageId: string, card: ImCard): Promise<{ threadId: string; messageId: string }>;
  /** daemon 恢复路由表后重新注册话题回复锚点。 */
  registerThreadAnchor(threadId: string, messageId: string): void;

  sendCard(threadId: string, card: ImCard, replyAnchorMessageId?: string): Promise<string>;
  updateCard(messageId: string, card: ImCard): Promise<void>;

  /** 给某条消息加表情，返回 reactionId（用于后续删除）。阶段三进度指示用。 */
  addReaction(messageId: string, emojiType: string): Promise<string>;
  /** 删除某条消息上的指定表情。 */
  removeReaction(messageId: string, reactionId: string): Promise<void>;

  getBotOpenId(): string | undefined;
}
