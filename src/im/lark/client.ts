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
  ownerOpenId: string;   // 管理者 open_id，默认也具备使用权限
  allowedOpenIds?: string[]; // 额外允许直接提问 / 操作卡片的用户 open_id
  isAuthorized?(input: { openId: string; chatId?: string }): boolean;
}

export function createLarkAdapter(opts: LarkClientOpts): ImAdapter {
  const client = new lark.Client({ appId: opts.appId, appSecret: opts.appSecret });
  const staticAllowedOpenIds = new Set([opts.ownerOpenId, ...(opts.allowedOpenIds ?? [])].filter(Boolean));
  let wsClient: lark.WSClient | null = null;
  let botOpenId: string | undefined;
  const userNameCache = new Map<string, string | undefined>();
  const chatNameCache = new Map<string, string | undefined>();
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

  async function sendDirect(openId: string, content: string): Promise<string> {
    const res: any = await client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text: content }),
      },
    });
    if (res.code !== 0) throw new Error(`私聊发送失败: ${res.msg} (code ${res.code})`);
    return res.data?.message_id ?? '';
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

          await observeMessageChat(handler, msg);

          if (!isAuthorized(msg.senderOpenId, msg.chatId)) {
            logger.info(`忽略未授权用户消息（sender=${msg.senderOpenId.slice(0, 10)}）`);
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
          const chatId = data?.chat_id ?? data?.event?.chat_id;
          if (!isAuthorized(operatorId, chatId)) return;
          await handler.onReaction({
            messageId: data?.message_id ?? '',
            emoji: data?.reaction_type?.emoji_type ?? '',
            operatorId,
          });
        },

        'im.chat.member.bot.added_v1': async (data: any) => {
          const event = data?.event ?? data;
          const chatId = event?.chat_id ?? event?.chat?.chat_id ?? '';
          if (!chatId) return;
          await handler.onChatObserved?.({
            chatId,
            name: event?.chat?.name ?? event?.chat_name ?? await resolveChatName(chatId),
            chatType: 'group',
            source: 'bot_added',
          });
        },

        'card.action.trigger': async (data: any) => {
          return await handleCardAction(data, handler);
        },

        'card.action.trigger_v1': async (data: any) => {
          return await handleCardAction(data, handler);
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
    sendDirect,
    addReaction,
    removeReaction,
    getBotOpenId: () => botOpenId,
    getChatName: resolveChatName,
  };

  async function toImMessage(m: ParsedMessage) {
    return {
      id: m.messageId,
      threadId: m.threadId ?? m.messageId,   // 建话题前用 messageId 占位
      rootMessageId: m.rootId ?? m.messageId,
      chatId: m.chatId,
      chatType: m.chatType,
      senderId: m.senderOpenId,
      senderType: 'user' as const,
      senderName: m.senderName ?? await resolveUserName(m.senderOpenId),
      content: m.text,
      attachments: await downloadAttachments(m),
      quotedMessageId: m.replyToMessageId,
      quotedMessage: m.replyToMessageId ? await fetchQuotedMessage(m.replyToMessageId) : undefined,
      createTime: String(Date.now()),
    };
  }

  async function resolveUserName(openId: string): Promise<string | undefined> {
    if (!openId) return undefined;
    if (userNameCache.has(openId)) return userNameCache.get(openId);
    try {
      const res: any = await client.request({
        method: 'GET',
        url: `/open-apis/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`,
      });
      const user = res?.data?.user ?? res?.user;
      const name = pickUserName(user);
      userNameCache.set(openId, name);
      return name;
    } catch (error: any) {
      logger.warn(`查询发送人名称失败 open_id=${openId.slice(0, 12)}: ${error?.message ?? error}`);
      userNameCache.set(openId, undefined);
      return undefined;
    }
  }

  function pickUserName(user: any): string | undefined {
    const candidates = [user?.name, user?.en_name, user?.nickname, user?.email];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return undefined;
  }

  async function resolveChatName(chatId: string): Promise<string | undefined> {
    if (!chatId) return undefined;
    if (chatNameCache.has(chatId)) return chatNameCache.get(chatId);
    try {
      const res: any = await client.request({
        method: 'GET',
        url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
      });
      const chat = res?.data?.chat ?? res?.data ?? res?.chat;
      const name = pickChatName(chat);
      chatNameCache.set(chatId, name);
      return name;
    } catch (error: any) {
      logger.warn(`查询群聊名称失败 chat=${chatId.slice(0, 12)}: ${error?.message ?? error}`);
      chatNameCache.set(chatId, undefined);
      return undefined;
    }
  }

  function pickChatName(chat: any): string | undefined {
    const candidates = [chat?.name, chat?.chat_name, chat?.title, chat?.avatar?.name];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return undefined;
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
    const dir = join(homedir(), '.larkbot', 'attachments', safeName(message.messageId));
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

  async function handleCardAction(data: any, handler: ImEventHandler): Promise<unknown> {
    const action = normalizeCardAction(data);
    if (!action) {
      logger.warn('收到卡片回调但无法解析 action');
      return undefined;
    }
    if (!isAuthorized(action.operatorId, action.chatId)) {
      logger.info(`忽略未授权用户卡片回调（operator=${action.operatorId.slice(0, 10)}）`);
      return undefined;
    }
    logger.info(`收到卡片回调 message=${action.messageId.slice(0, 12)} value=${compactJson(action.value)}`);
    return await handler.onCardAction(action);
  }

  function normalizeCardAction(data: any) {
    const event = data?.event ?? data;
    const operatorId = event?.operator?.open_id
      ?? event?.operator?.user_id
      ?? event?.operator?.userId
      ?? '';
    const value = event?.action?.value ?? event?.action?.option ?? event?.action;
    if (!operatorId || value === undefined) return undefined;
    return {
      messageId: event?.context?.open_message_id
        ?? event?.context?.openMessageId
        ?? event?.open_message_id
        ?? event?.openMessageId
        ?? '',
      operatorId,
      chatId: event?.context?.open_chat_id
        ?? event?.context?.chat_id
        ?? event?.open_chat_id
        ?? event?.chat_id
        ?? undefined,
      value,
    };
  }

  async function observeMessageChat(handler: ImEventHandler, msg: ParsedMessage): Promise<void> {
    if (msg.chatType === 'p2p') return;
    await handler.onChatObserved?.({
      chatId: msg.chatId,
      name: await resolveChatName(msg.chatId),
      chatType: msg.chatType,
      source: 'message',
    });
  }

  function isAuthorized(openId: string, chatId?: string): boolean {
    return opts.isAuthorized?.({ openId, chatId }) ?? staticAllowedOpenIds.has(openId);
  }

  function compactJson(value: unknown): string {
    try {
      return JSON.stringify(value).slice(0, 300);
    } catch {
      return String(value).slice(0, 300);
    }
  }
}
