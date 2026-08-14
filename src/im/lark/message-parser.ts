/** 飞书消息事件的纯解析辅助（无副作用，便于单测）。 */

export interface ParsedMessage {
  messageId: string;
  chatId: string;
  threadId?: string;
  rootId?: string;
  replyToMessageId?: string;
  senderOpenId: string;
  senderName?: string;
  text: string;
  mentionedOpenIds: string[];
  resources: Array<{ type: 'image' | 'file'; key: string; name?: string }>;
}

/**
 * 从 im.message.receive_v1 的事件 data 解析出结构化消息。
 * 处理 text/image/file；资源下载由 client 层完成。
 */
export function parseMessageEvent(data: any): ParsedMessage | null {
  const msg = data?.message;
  if (!msg || !['text', 'image', 'file'].includes(msg.message_type)) return null;

  let text = '';
  let content: any;
  try {
    content = JSON.parse(msg.content ?? '{}');
    text = typeof content.text === 'string' ? content.text.trim() : '';
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
  const resources: ParsedMessage['resources'] = [];
  if (msg.message_type === 'image' && typeof content.image_key === 'string') {
    resources.push({ type: 'image', key: content.image_key });
  }
  if (msg.message_type === 'file' && typeof content.file_key === 'string') {
    resources.push({
      type: 'file',
      key: content.file_key,
      name: typeof content.file_name === 'string' ? content.file_name : undefined,
    });
  }

  return {
    messageId: msg.message_id,
    chatId: msg.chat_id,
    threadId: msg.thread_id || undefined,
    rootId: msg.root_id || undefined,
    replyToMessageId: msg.parent_id || undefined,
    senderOpenId: data?.sender?.sender_id?.open_id ?? '',
    senderName: extractSenderName(data),
    text: cleanText,
    mentionedOpenIds,
    resources,
  };
}

function extractSenderName(data: any): string | undefined {
  const sender = data?.sender;
  const candidates = [
    sender?.sender_name,
    sender?.name,
    sender?.display_name,
    sender?.user?.name,
    sender?.user?.en_name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}
