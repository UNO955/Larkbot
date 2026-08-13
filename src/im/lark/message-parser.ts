/** 飞书消息事件的纯解析辅助（无副作用，便于单测）。 */

export interface ParsedMessage {
  messageId: string;
  chatId: string;
  threadId?: string;
  rootId?: string;
  senderOpenId: string;
  text: string;
  mentionedOpenIds: string[];
}

/**
 * 从 im.message.receive_v1 的事件 data 解析出结构化消息。
 * 只处理 text 类型；非 text 返回 null（阶段一不支持富文本/文件）。
 */
export function parseMessageEvent(data: any): ParsedMessage | null {
  const msg = data?.message;
  if (!msg || msg.message_type !== 'text') return null;

  let text = '';
  try {
    text = (JSON.parse(msg.content ?? '{}').text ?? '').trim();
  } catch {
    return null;
  }

  const mentions: any[] = Array.isArray(msg.mentions) ? msg.mentions : [];
  const mentionedOpenIds = mentions
    .map((m) => m?.id?.open_id)
    .filter((x): x is string => typeof x === 'string');

  // 去掉 @xxx 占位符（形如 "@_user_1"），得到干净正文
  let cleanText = text;
  for (const m of mentions) {
    if (m?.key) cleanText = cleanText.split(m.key).join('');
  }
  cleanText = cleanText.replace(/\s+/g, ' ').trim();

  return {
    messageId: msg.message_id,
    chatId: msg.chat_id,
    threadId: msg.thread_id || undefined,
    rootId: msg.root_id || undefined,
    senderOpenId: data?.sender?.sender_id?.open_id ?? '',
    text: cleanText,
    mentionedOpenIds,
  };
}
