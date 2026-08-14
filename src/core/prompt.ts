import type { ImAttachment, ImMessage } from '../im/types.js';
import type { Session } from './types.js';

export interface PromptOptions {
  systemPrompt?: string;
  systemPromptName?: string;
}

const ROUTING = [
  '你运行在 larkbot 中。',
  '用户在飞书话题中与你对话。',
  '回复用户时直接输出最终答案，不需要解释桥接细节。',
  '如果消息包含 <quoted_message>，它只是用户引用的历史上下文；必须以最后的 <user_message> 作为当前请求。',
].join('\n');

export function buildOpeningPrompt(session: Session, message: ImMessage, opts: PromptOptions = {}): string {
  return [
    `<larkbot_routing>\n${ROUTING}\n</larkbot_routing>`,
    `<session_id>${xmlEscape(session.sessionId)}</session_id>`,
    systemPromptBlock(opts),
    senderTag(message),
    quotedBlock(message.quotedMessageId, message.quotedMessage?.content),
    attachmentsBlock(message.attachments),
    userMessageBlock(message.content),
  ].filter(Boolean).join('\n\n');
}

export function buildFollowUpPrompt(message: ImMessage, opts: PromptOptions = {}): string {
  return [
    '<larkbot_reminder>\n这是同一个飞书话题中的后续消息。请基于当前 traex 会话上下文继续处理。\n</larkbot_reminder>',
    systemPromptBlock(opts),
    senderTag(message),
    quotedBlock(message.quotedMessageId, message.quotedMessage?.content),
    attachmentsBlock(message.attachments),
    userMessageBlock(message.content),
  ].filter(Boolean).join('\n\n');
}

function userMessageBlock(content: string): string {
  return `<user_message>\n${content}\n</user_message>`;
}

function systemPromptBlock(opts: PromptOptions): string {
  const content = opts.systemPrompt?.trim();
  if (!content) return '';
  const name = opts.systemPromptName?.trim();
  const nameAttr = name ? ` name="${xmlEscape(name)}"` : '';
  return `<system_prompt_profile${nameAttr}>\n${xmlEscape(content)}\n</system_prompt_profile>`;
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

function quotedBlock(messageId?: string, content?: string): string {
  if (!messageId) return '';
  if (!content?.trim()) return `<quoted_message message_id="${xmlEscape(messageId)}" unavailable="true" />`;
  return `<quoted_message message_id="${xmlEscape(messageId)}">\n${xmlEscape(content.trim())}\n</quoted_message>`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;');
}
