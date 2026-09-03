/** 飞书消息事件的纯解析辅助（无副作用，便于单测）。 */

export interface ParsedMessage {
  messageId: string;
  chatId: string;
  chatType?: 'group' | 'p2p' | string;
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
 * 处理 text/post/image/file；资源下载由 client 层完成。
 */
export function parseMessageEvent(data: any): ParsedMessage | null {
  const msg = data?.message;
  if (!msg || !['text', 'post', 'image', 'file'].includes(msg.message_type)) return null;

  let text = '';
  let content: any;
  try {
    content = JSON.parse(msg.content ?? '{}');
    text = msg.message_type === 'post'
      ? extractPostText(content.content)
      : typeof content.text === 'string' ? content.text.trim() : '';
  } catch {
    return null;
  }

  const mentions: any[] = Array.isArray(msg.mentions) ? msg.mentions : [];
  const mentionedOpenIds = unique([
    ...mentions
      .map((m) => m?.id?.open_id)
      .filter((x): x is string => typeof x === 'string'),
    ...extractPostMentionOpenIds(content.content),
  ]);

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
  if (msg.message_type === 'post') {
    resources.push(...extractPostResources(content.content));
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
    chatType: msg.chat_type || undefined,
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

function extractPostText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const rows: string[] = [];
  for (const row of content) {
    if (!Array.isArray(row)) continue;
    const pieces: string[] = [];
    for (const node of row) {
      const text = node?.text ?? node?.un_escape_text;
      if (typeof text === 'string' && text.trim()) pieces.push(text.trim());
    }
    if (pieces.length) rows.push(pieces.join(''));
  }
  return rows.join('\n').trim();
}

function extractPostResources(content: unknown): ParsedMessage['resources'] {
  if (!Array.isArray(content)) return [];
  const resources: ParsedMessage['resources'] = [];
  for (const row of content) {
    if (!Array.isArray(row)) continue;
    for (const node of row) {
      if (node?.tag === 'img' && typeof node.image_key === 'string') {
        resources.push({ type: 'image', key: node.image_key });
      }
      if (node?.tag === 'file' && typeof node.file_key === 'string') {
        resources.push({
          type: 'file',
          key: node.file_key,
          name: typeof node.file_name === 'string' ? node.file_name : undefined,
        });
      }
    }
  }
  return resources;
}

function extractPostMentionOpenIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const row of content) {
    if (!Array.isArray(row)) continue;
    for (const node of row) {
      if (node?.tag !== 'at') continue;
      const candidates = [node.open_id, node.user_id, node.id?.open_id];
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) ids.push(candidate.trim());
      }
    }
  }
  return ids;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
