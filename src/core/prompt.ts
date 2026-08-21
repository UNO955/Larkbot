import type { ImAttachment, ImMessage } from '../im/types.js';
import type { Session } from './types.js';

export interface PromptOptions {
  systemPrompt?: string;
  systemPromptName?: string;
}

const ROUTING = [
  '你运行在 larkbot 中。',
  '用户在飞书话题中与你对话；话题内后续消息不一定会 @ 机器人，只要被传入就是当前用户请求。',
  '回复用户时只需要直接输出最终答案，larkbot 桥接层会负责把你的最终答案发回飞书。',
  '禁止调用 botmux-send、lark-send、飞书发送类技能或任何额外回传机制；不要读取这些技能说明。',
  '如果消息包含 <quoted_message>，它只是用户引用的历史上下文；必须以最后的 <user_message> 作为当前请求。',
  evidenceReportingInstruction(),
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

export function buildFollowUpPrompt(message: ImMessage): string {
  return [
    `<larkbot_reminder>\n这是同一个飞书话题中的后续消息。请基于当前 traex 会话上下文继续处理；只回答最后的用户消息，不要调用任何发送类技能。\n${evidenceReportingInstruction()}\n</larkbot_reminder>`,
    senderTag(message),
    quotedBlock(message.quotedMessageId, message.quotedMessage?.content),
    attachmentsBlock(message.attachments),
    userMessageBlock(message.content),
  ].filter(Boolean).join('\n\n');
}

export function buildThreadPrompt(session: Session, message: ImMessage, opts: PromptOptions = {}): string {
  return session.answerCardMessageId ? buildFollowUpPrompt(message) : buildOpeningPrompt(session, message, opts);
}

function userMessageBlock(content: string): string {
  return `<user_message>\n${xmlEscape(content)}\n</user_message>`;
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

function evidenceReportingInstruction(): string {
  return [
    '每次最终回答正文之后，必须额外追加一个仅供 larkbot 解析的结构化证据块；不要把它放进 Markdown 代码块：',
    '<larkbot_evidence>',
    '{"knowledge_refs":[],"code_refs":[],"log_refs":[]}',
    '</larkbot_evidence>',
    'knowledge_refs 填本轮实际读取或引用的知识库、项目页、Playbook、文档标题或路径；code_refs 填关键代码文件/函数；log_refs 填 LogID、Argos、PSM/method 等日志证据。没有则填空数组。',
  ].join('\n');
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;');
}
