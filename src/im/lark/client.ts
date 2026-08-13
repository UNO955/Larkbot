/**
 * 飞书接入层：WSClient 长连接 + Client API 调用。实现 ImAdapter。
 *
 * 长连接（WSClient）模式：开发机主动连出去订阅事件，无需公网 IP / webhook 回调。
 */
import * as lark from '@larksuiteoapi/node-sdk';
import type { ImAdapter, ImEventHandler, ImCard, MsgFormat } from '../types.js';
import { parseMessageEvent } from './message-parser.js';
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

  async function reply(threadId: string, content: string, _format: MsgFormat): Promise<string> {
    // 有话题锚点：reply 到锚点消息并 reply_in_thread，回复落进该话题。
    const anchor = threadAnchors.get(threadId);
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

  async function sendCard(threadId: string, card: ImCard): Promise<string> {
    // 与 reply 同理：卡片也必须 reply 到话题锚点并 reply_in_thread 才能落进话题；
    // message.create 不支持 thread_id，直发会报 invalid receive_id(230001)。
    const anchor = threadAnchors.get(threadId);
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
            await handler.onThreadReply(toImMessage(msg));
            return;
          }

          // 不在话题内：仅当 @ 到本 bot 才建会话
          const atBot = botOpenId ? msg.mentionedOpenIds.includes(botOpenId) : msg.mentionedOpenIds.length > 0;
          if (atBot) {
            await handler.onMention(toImMessage(msg));
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
    sendCard,
    updateCard,
    addReaction,
    removeReaction,
    getBotOpenId: () => botOpenId,
  };

  function toImMessage(m: NonNullable<ReturnType<typeof parseMessageEvent>>) {
    return {
      id: m.messageId,
      threadId: m.threadId ?? m.messageId,   // 建话题前用 messageId 占位
      chatId: m.chatId,
      senderId: m.senderOpenId,
      senderType: 'user' as const,
      content: m.text,
      createTime: String(Date.now()),
    };
  }
}
