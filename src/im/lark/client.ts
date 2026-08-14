/**
 * 飞书接入层：WSClient 长连接 + Client API 调用。实现 ImAdapter。
 *
 * 长连接（WSClient）模式：开发机主动连出去订阅事件，无需公网 IP / webhook 回调。
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ImAdapter, ImEventHandler, ImCard, MsgFormat } from '../types.js';
import { parseMessageEvent, type ParsedMessage } from './message-parser.js';
import { logger } from '../../utils/logger.js';

export interface LarkClientOpts {
  appId: string;
  appSecret: string;
  ownerOpenId: string;   // 白名单：只响应这个 open_id
}

export function createLarkAdapter(opts: LarkClientOpts): ImAdapter {
  const client = new lark.Client({ appId: opts.appId, appSecret: opts.appSecret });
  let wsClient: lark.WSClient | null = null;
  let botOpenId: string | undefined;
  // threadId(omt_) -> 话题内锚点 messageId。回贴时 reply 到锚点并 reply_in_thread，
  // 消息即落进该话题（message.create 不支持 receive_id_type='thread_id'）。
  const threadAnchors = new Map<string, string>();

  async function reply(threadId: string, content: string, _format: MsgFormat, replyAnchorMessageId?: string): Promise<string> {
    // 有话题锚点：reply 到锚点消息并 reply_in_thread，回复落进该话题。
    const anchor = replyAnchorMessageId || threadAnchors.get(threadId);
    if (anchor) {
      const res: any = await client.im.v1.message.reply({
        path: { message_id: anchor },
        data: { msg_type: 'text', content: JSON.stringify({ text: content }), reply_in_thread: true },
      });
      if (res.code !== 0) throw new Error(`回贴失败: ${res.msg} (code ${res.code})`);
      return res.data?.message_id ?? '';
    }
    // 无锚点回落：把 threadId 当 chat_id 直发（群/单聊场景）。
    const res: any = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: threadId, msg_type: 'text', content: JSON.stringify({ text: content }) },
    });
    if (res.code !== 0) throw new Error(`发送失败: ${res.msg} (code ${res.code})`);
    return res.data?.message_id ?? '';
  }

  async function replyInThread(rootMessageId: string, content: string): Promise<{ threadId: string; messageId: string }> {
    const res: any = await client.im.v1.message.reply({
      path: { message_id: rootMessageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: content }),
        reply_in_thread: true,   // 关键：把回复变成一个话题
      },
    });
    if (res.code !== 0) throw new Error(`建话题失败: ${res.msg} (code ${res.code})`);
    const threadId = res.data?.thread_id ?? '';
    const messageId = res.data?.message_id ?? '';
    // 记住话题锚点，后续 reply() 回贴走 reply_in_thread 落进本话题。
    if (threadId && messageId) threadAnchors.set(threadId, messageId);
    return { threadId, messageId };
  }

  async function replyCardInThread(rootMessageId: string, card: ImCard): Promise<{ threadId: string; messageId: string }> {
    const res: any = await client.im.v1.message.reply({
      path: { message_id: rootMessageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card.payload),
        reply_in_thread: true,
      },
    });
    if (res.code !== 0) throw new Error(`建话题卡片失败: ${res.msg} (code ${res.code})`);
    const threadId = res.data?.thread_id ?? '';
    const messageId = res.data?.message_id ?? '';
    if (threadId && messageId) threadAnchors.set(threadId, messageId);
    return { threadId, messageId };
  }

  async function sendCard(threadId: string, card: ImCard, replyAnchorMessageId?: string): Promise<string> {
    // 与 reply 同理：卡片也必须 reply 到话题锚点并 reply_in_thread 才能落进话题；
    // message.create 不支持 thread_id，直发会报 invalid receive_id(230001)。
    const anchor = replyAnchorMessageId || threadAnchors.get(threadId);
    if (anchor) {
      const res: any = await client.im.v1.message.reply({
        path: { message_id: anchor },
        data: { msg_type: 'interactive', content: JSON.stringify(card.payload), reply_in_thread: true },
      });
      if (res.code !== 0) throw new Error(`发卡失败: ${res.msg} (code ${res.code})`);
      return res.data?.message_id ?? '';
    }
    // 无锚点回落：把 threadId 当 chat_id 直发（群/单聊场景）。
    const res: any = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: threadId, msg_type: 'interactive', content: JSON.stringify(card.payload) },
    });
    if (res.code !== 0) throw new Error(`发卡失败: ${res.msg} (code ${res.code})`);
    return res.data?.message_id ?? '';
  }

  async function updateCard(messageId: string, card: ImCard): Promise<void> {
    const res: any = await client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card.payload) },
    });
    if (res.code !== 0) throw new Error(`更新卡片失败: ${res.msg} (code ${res.code})`);
  }

  async function addReaction(messageId: string, emojiType: string): Promise<string> {
    const res: any = await client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
    if (res.code !== 0) throw new Error(`加表情失败: ${res.msg} (code ${res.code})`);
    return res.data?.reaction_id ?? '';
  }

  async function removeReaction(messageId: string, reactionId: string): Promise<void> {
    const res: any = await client.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
    if (res.code !== 0) throw new Error(`删表情失败: ${res.msg} (code ${res.code})`);
  }

  async function probeBotOpenId(): Promise<void> {
    try {
      const res: any = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
      botOpenId = res?.bot?.open_id ?? res?.data?.bot?.open_id;
      if (botOpenId) logger.info(`bot open_id = ${botOpenId}`);
    } catch (err: any) {
      logger.warn(`探测 bot open_id 失败（不阻断启动）: ${err?.message ?? err}`);
    }
  }

  return {
    async start(handler: ImEventHandler): Promise<void> {
      await probeBotOpenId();

      const dispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: any) => {
          const msg = parseMessageEvent(data);
          if (!msg) return;

          // 白名单：只响应 owner 本人
          if (msg.senderOpenId !== opts.ownerOpenId) {
            logger.info(`忽略非 owner 消息（sender=${msg.senderOpenId.slice(0, 10)}）`);
            return;
          }

          // 已在话题内 → 视为会话内回复
          if (msg.threadId) {
            threadAnchors.set(msg.threadId, msg.messageId);
            await handler.onThreadReply(await toImMessage(msg));
            return;
          }

          // 不在话题内：仅当 @ 到本 bot 才建会话
          const atBot = botOpenId ? msg.mentionedOpenIds.includes(botOpenId) : msg.mentionedOpenIds.length > 0;
          if (atBot) {
            await handler.onMention(await toImMessage(msg));
          }
        },

        'im.message.reaction.created_v1': async (data: any) => {
          const operatorId = data?.operator_id?.open_id ?? '';
          if (operatorId !== opts.ownerOpenId) return;
          await handler.onReaction({
            messageId: data?.message_id ?? '',
            emoji: data?.reaction_type?.emoji_type ?? '',
            operatorId,
          });
        },
      });

      wsClient = new lark.WSClient({
        appId: opts.appId,
        appSecret: opts.appSecret,
        loggerLevel: process.env.DEBUG ? lark.LoggerLevel.info : lark.LoggerLevel.warn,
      });
      wsClient.start({ eventDispatcher: dispatcher });
      logger.info('飞书 WSClient 长连接已启动');
    },

    async stop(): Promise<void> {
      // SDK 无显式 stop；进程退出即断开。预留钩子。
      wsClient = null;
    },

    reply,
    replyInThread,
    replyCardInThread,
    registerThreadAnchor(threadId: string, messageId: string): void {
      if (threadId && messageId) threadAnchors.set(threadId, messageId);
    },
    sendCard,
    updateCard,
      ackRead,
    addReaction,
    removeReaction,
    getBotOpenId: () => botOpenId,
  };

  async function toImMessage(m: ParsedMessage) {
    return {
      id: m.messageId,
      threadId: m.threadId ?? m.messageId,   // 建话题前用 messageId 占位
      rootMessageId: m.rootId ?? m.messageId,
      chatId: m.chatId,
      senderId: m.senderOpenId,
      senderType: 'user' as const,
      content: m.text,
      attachments: await downloadAttachments(m),
      quotedMessageId: m.replyToMessageId,
      quotedMessage: m.replyToMessageId ? await fetchQuotedMessage(m.replyToMessageId) : undefined,
      createTime: String(Date.now()),
    };
  }

  async function fetchQuotedMessage(messageId: string) {
    try {
      const res: any = await client.im.v1.message.get({
        path: { message_id: messageId },
      });
      if (res.code !== 0) throw new Error(`${res.msg} (code ${res.code})`);
      const item = Array.isArray(res.data?.items) ? res.data.items[0] : undefined;
      const content = extractMessageText(item);
      return { messageId, content };
    } catch (error: any) {
      logger.warn(`读取引用消息失败 message=${messageId}: ${error?.message ?? error}`);
      return { messageId };
    }
  }

  async function ackRead(messageId: string): Promise<void> {
    let ackMessageId = '';
    try {
      const res: any = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text: '\u200b' }),
          reply_in_thread: true,
        },
      });
      if (res.code !== 0) throw new Error(`${res.msg} (code ${res.code})`);
      ackMessageId = res.data?.message_id ?? '';
    } catch (error: any) {
      logger.warn(`发送已读 ack 失败 message=${messageId}: ${error?.message ?? error}`);
      return;
    }

    if (!ackMessageId) return;
    try {
      const res: any = await client.im.v1.message.delete({
        path: { message_id: ackMessageId },
      });
      if (res.code !== 0) throw new Error(`${res.msg} (code ${res.code})`);
    } catch (error: any) {
      logger.warn(`撤回已读 ack 失败 message=${ackMessageId}: ${error?.message ?? error}`);
    }
  }

  function extractMessageText(item: any): string | undefined {
    const raw = item?.body?.content ?? item?.content;
    if (typeof raw !== 'string') return undefined;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.text === 'string') return parsed.text.trim();
      if (Array.isArray(parsed.content)) return extractPostText(parsed.content);
    } catch {
      return raw.trim() || undefined;
    }
    return undefined;
  }

  function extractPostText(content: any[]): string | undefined {
    const pieces: string[] = [];
    for (const row of content) {
      if (!Array.isArray(row)) continue;
      for (const node of row) {
        const text = node?.text ?? node?.un_escape_text;
        if (typeof text === 'string' && text.trim()) pieces.push(text.trim());
      }
    }
    return pieces.join('\n').trim() || undefined;
  }

  async function downloadAttachments(message: ParsedMessage) {
    if (message.resources.length === 0) return undefined;
    const dir = join(homedir(), '.larkmux', 'attachments', safeName(message.messageId));
    await mkdir(dir, { recursive: true });
    const attachments = [];
    for (const resource of message.resources) {
      const fallback = resource.type === 'image' ? `${resource.key}.png` : resource.key;
      const path = join(dir, safeName(resource.name || fallback));
      try {
        const download = await client.im.v1.messageResource.get({
          params: { type: resource.type },
          path: { message_id: message.messageId, file_key: resource.key },
        });
        await download.writeFile(path);
        attachments.push({ type: resource.type, path, name: resource.name });
      } catch (error: any) {
        logger.warn(`下载消息附件失败 message=${message.messageId}: ${error?.message ?? error}`);
      }
    }
    return attachments.length > 0 ? attachments : undefined;
  }

  function safeName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'attachment';
  }
}
