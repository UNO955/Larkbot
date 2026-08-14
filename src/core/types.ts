/** 核心类型。所有模块从此导入，保持 IM/CLI 无关。 */

export interface Bot {
  id: string;
  name: string;
  appId: string;
  appSecret: string;
  cwd: string;          // traex 执行工作目录
  ownerOpenId: string;  // 白名单：只响应这个 open_id
  enabled: boolean;
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

export type SessionStatus = 'active' | 'closed';

export interface Session {
  sessionId: string;        // larkbot 自己的会话 id
  chatId: string;
  rootMessageId: string;    // 飞书话题根消息
  threadId?: string;
  anchorMessageId?: string; // 话题内用于 reply_in_thread 的锚点消息
  initialCardMessageId?: string; // 建话题时发出的首张运行中卡片，首轮输出直接 patch 它
  scope: 'thread';
  title: string;
  status: SessionStatus;

  workingDir: string;
  cliId: 'traex';
  cliSessionId?: string;
  hasHistory: boolean;

  ownerOpenId?: string;
  lastCallerOpenId?: string;
  lastMessageAt: string;
  createdAt: string;
}
