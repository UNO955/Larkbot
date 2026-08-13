import type { ImAttachment, ImMessage } from '../im/types.js';
import type { Session } from './types.js';

const ROUTING = [
  '你运行在 larkmux 中。',
  '用户在飞书话题中与你对话。',
  '回复用户时直接输出最终答案，不需要解释桥接细节。',
  '如果需要查看话题历史，可使用 larkmux history。',
].join('\n');

export function buildOpeningPrompt(session: Session, message: ImMessage): string {
  return [
    `<larkmux_routing>\n${ROUTING}\n</larkmux_routing>`,
    `<session_id>${xmlEscape(session.sessionId)}</session_id>`,
    userMessageBlock(message.content),
    senderTag(message),
    attachmentsBlock(message.attachments),
    quotedBlock(message.quotedMessageId),
  ].filter(Boolean).join('\n\n');
}

export function buildFollowUpPrompt(message: ImMessage): string {
  return [
    '<larkmux_reminder>\n这是同一个飞书话题中的后续消息。请基于当前 traex 会话上下文继续处理。\n</larkmux_reminder>',
    userMessageBlock(message.content),
    senderTag(message),
    attachmentsBlock(message.attachments),
    quotedBlock(message.quotedMessageId),
  ].filter(Boolean).join('\n\n');
}

function userMessageBlock(content: string): string {
  return `<user_message>\n${content}\n</user_message>`;
}

function senderTag(message: ImMessage): string {
  const attrs = [
    `type="${xmlEscape(message.senderType)}"`,
    `open_id="${xmlEscape(message.senderId)}"`,
  ];
  if (message.senderName) attrs.push(`name="${xmlEscape(message.senderName)}"`);
  return `<sender ${attrs.join(' ')} />`;
}

function attachmentsBlock(attachments?: ImAttachment[]): string {
  if (!attachments?.length) return '';
  const items = attachments.map((attachment, index) => {
    const attrs = [
      `n="${index + 1}"`,
      `path="${xmlEscape(attachment.path)}"`,
    ];
    if (attachment.name) attrs.push(`name="${xmlEscape(attachment.name)}"`);
    return `  <${attachment.type} ${attrs.join(' ')} />`;
  });
  return `<attachments>\n${items.join('\n')}\n</attachments>`;
}

function quotedBlock(messageId?: string): string {
  return messageId
    ? `<quoted_message message_id="${xmlEscape(messageId)}" />`
    : '';
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;');
}
