/**
 * daemon 入口（阶段一）。
 *
 * 装配 config + 飞书长连接 + traex 会话管理，打通命脉：
 *   @机器人一句 → 建话题 → spawn traex → 写入消息 → 输出回贴话题。
 *
 * 有意做薄：具体逻辑在 im/lark 与 core/session-manager，这里只负责编排与生命周期。
 *
 * 说明（阶段一范围）：
 *   - 关闭会话由「卡片按钮 / 控制台」触发（阶段三/四实现），不是表情。
 *   - 表情是「关闭流式卡片」后的轻量进度指示（收到→GoGoGo，完成→DONE），
 *     属阶段三卡片体系的一部分，阶段一不实现。
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { logger } from './utils/logger.js';
import { createLarkAdapter } from './im/lark/client.js';
import { createTraexAdapter } from './adapters/cli/traex.js';
import { ConversationManager } from './core/conversation-manager.js';
import { JsonSessionStore } from './core/store.js';
import { buildFollowUpPrompt, buildOpeningPrompt } from './core/prompt.js';
import { buildTerminalCard } from './im/lark/card-builder.js';
import type { ImMessage, ImReaction } from './im/types.js';
import type { Session } from './core/types.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  logger.info(`larkmux 启动，traex cwd=${cfg.traexCwd}`);

  const im = createLarkAdapter({
    appId: cfg.larkAppId,
    appSecret: cfg.larkAppSecret,
    ownerOpenId: cfg.ownerOpenId,
  });

  const sessions = new ConversationManager({
    cli: createTraexAdapter(),
    store: new JsonSessionStore(),
    // 首帧：在话题里发一张「运行中」终端卡片，返回 message_id
    post: async (threadId, text, status, replyAnchorMessageId) => {
      return im.sendCard(threadId, buildTerminalCard({ body: text, status }), replyAnchorMessageId);
    },
    // 后续帧：patch 同一张卡片，原地刷新（不再新发消息，杜绝刷屏）
    patch: async (messageId, text, status) => {
      await im.updateCard(messageId, buildTerminalCard({ body: text, status }));
    },
    notify: async (threadId, text, replyAnchorMessageId) => {
      await im.reply(threadId, text, 'text', replyAnchorMessageId);
    },
    addReaction: async (messageId, emojiType) => {
      return im.addReaction(messageId, emojiType);
    },
    removeReaction: async (messageId, reactionId) => {
      await im.removeReaction(messageId, reactionId);
    },
  });
  const restored = await sessions.restore();
  for (const session of restored) {
    if (session.status === 'active' && session.threadId && session.anchorMessageId) {
      im.registerThreadAnchor(session.threadId, session.anchorMessageId);
    }
  }

  await im.start({
    // ① @机器人（尚无话题）→ 建话题 + 建会话 + 首条消息入队
    async onMention(msg: ImMessage): Promise<void> {
      try {
        const existing = sessions.find(msg.chatId, msg.rootMessageId, msg.threadId);
        if (existing) {
          await sessions.touch(existing, msg.senderId);
          await sessions.submit(existing, buildOpeningPrompt(existing, msg), buildFollowUpPrompt(msg), msg.id);
          return;
        }

        const { threadId, messageId } = await im.replyCardInThread(
          msg.id,
          buildTerminalCard({ body: '', status: 'working' }),
        );
        im.registerThreadAnchor(threadId, msg.id);
        const now = new Date().toISOString();
        const session: Session = {
          sessionId: randomUUID(),
          chatId: msg.chatId,
          rootMessageId: msg.id,
          threadId,
          anchorMessageId: msg.id,
          initialCardMessageId: messageId,
          scope: 'thread',
          title: msg.content.slice(0, 80) || '飞书会话',
          status: 'active',
          workingDir: cfg.traexCwd,
          cliId: 'traex',
          hasHistory: false,
          ownerOpenId: cfg.ownerOpenId,
          lastCallerOpenId: msg.senderId,
          lastMessageAt: now,
          createdAt: now,
        };
        await sessions.add(session);
        if (msg.content) {
          await sessions.submit(session, buildOpeningPrompt(session, msg), buildFollowUpPrompt(msg), msg.id);
        }
      } catch (err: any) {
        logger.error(`建会话失败: ${err?.message ?? err}`);
      }
    },

    // ② 话题内新消息 → 入队（busy 不打断）
    async onThreadReply(msg: ImMessage): Promise<void> {
      try {
        const session = sessions.find(msg.chatId, msg.rootMessageId, msg.threadId);
        if (!session) {
          await im.reply(msg.threadId, '找不到这个话题对应的 larkmux 会话，无法恢复旧上下文。', 'text');
          return;
        }
        await sessions.touch(session, msg.senderId);
        await sessions.submit(session, buildOpeningPrompt(session, msg), buildFollowUpPrompt(msg), msg.id);
      } catch (err: any) {
        logger.error(`处理话题消息失败: ${err?.message ?? err}`);
        await im.reply(msg.threadId, `消息处理失败：${err?.message ?? err}`, 'text');
      }
    },

    // ③ 表情事件：阶段一不处理。
    //    关会话走卡片按钮/控制台；表情用于「卡片关闭时的进度指示」，均在阶段三实现。
    async onReaction(_reaction: ImReaction): Promise<void> {
      /* no-op（阶段一） */
    },
  });

  // 优雅退出
  const shutdown = () => {
    logger.info('收到退出信号，关闭所有会话…');
    sessions.shutdownAll();
    im.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('larkmux 就绪，等待飞书消息…');
}

main().catch((err) => {
  logger.error(`启动失败: ${err?.message ?? err}`);
  process.exit(1);
});
