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
import { buildTerminalCard, buildThinkingCard } from './im/lark/card-builder.js';
import { startConsoleServer, TerminalStreamStore } from './console/server.js';
import type { ImMessage, ImReaction } from './im/types.js';
import type { Bot, Session } from './core/types.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  logger.info(`larkbot 启动，traex cwd=${cfg.traexCwd}`);
  const store = new JsonSessionStore();
  const terminalStore = new TerminalStreamStore();
  let activeBot = await loadActiveBot(store, cfg);

  const im = createLarkAdapter({
    appId: activeBot.appId,
    appSecret: activeBot.appSecret,
    ownerOpenId: activeBot.ownerOpenId,
  });

  const sessions = new ConversationManager({
    cli: createTraexAdapter(),
    store,
    post: async (threadId, text, status, replyAnchorMessageId, replyToName, replySignature) => {
      return im.sendCard(threadId, buildTerminalCard({ body: text, status, replyToName, replySignature }), replyAnchorMessageId);
    },
    patch: async (messageId, text, status, replyToName, replySignature) => {
      await im.updateCard(messageId, buildTerminalCard({ body: text, status, replyToName, replySignature }));
    },
    postTrace: async (threadId, traceUrl, closeUrl, status, replyAnchorMessageId, footer) => {
      return im.sendCard(threadId, buildThinkingCard({ url: traceUrl, closeUrl, status, footer }), replyAnchorMessageId);
    },
    patchTrace: async (messageId, traceUrl, closeUrl, status, footer) => {
      await im.updateCard(messageId, buildThinkingCard({ url: traceUrl, closeUrl, status, footer }));
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
    createTrace: (input) => {
      void input;
    },
    updateTrace: (id, trace, status) => {
      void id; void trace; void status;
    },
    traceUrl: (id) => `${cfg.consolePublicUrl.replace(/\/+$/, '')}/terminal/${encodeURIComponent(id)}`,
    closeUrl: (id) => `${cfg.consolePublicUrl.replace(/\/+$/, '')}/sessions/${encodeURIComponent(id)}/close`,
    recordTerminalOutput: (sessionId, chunk) => {
      terminalStore.append(sessionId, chunk);
    },
    closeTerminal: (sessionId) => {
      terminalStore.close(sessionId);
    },
    isStreamingCardDisabled: () => activeBot.disableStreamingCard === true,
  });
  const consoleServer = await startConsoleServer({
    host: cfg.consoleHost,
    port: cfg.consolePort,
    store,
    botId: activeBot.id,
    terminalStore,
    sessionManager: sessions,
    onBotUpdated(bot) {
      activeBot = bot;
      logger.info(`bot 配置已更新 name=${bot.name} cwd=${bot.cwd}`);
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
          await sessions.submit(existing, buildOpeningPrompt(existing, msg, promptOptions(activeBot)), buildFollowUpPrompt(msg, promptOptions(activeBot)), msg.id, replyToName(msg), replySignature(activeBot));
          return;
        }

        const { threadId } = await im.replyInThread(msg.id, '🧵 会话已创建，启动中…');
        im.registerThreadAnchor(threadId, msg.id);
        const now = new Date().toISOString();
        const session: Session = {
          sessionId: randomUUID(),
          chatId: msg.chatId,
          rootMessageId: msg.id,
          threadId,
          anchorMessageId: msg.id,
          scope: 'thread',
          title: msg.content.slice(0, 80) || '飞书会话',
          status: 'active',
          workingDir: activeBot.cwd,
          cliId: 'traex',
          hasHistory: false,
          ownerOpenId: activeBot.ownerOpenId,
          lastCallerOpenId: msg.senderId,
          lastMessageAt: now,
          createdAt: now,
        };
        await sessions.add(session);
        if (msg.content) {
          await sessions.submit(session, buildOpeningPrompt(session, msg, promptOptions(activeBot)), buildFollowUpPrompt(msg, promptOptions(activeBot)), msg.id, replyToName(msg), replySignature(activeBot));
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
          await im.reply(msg.threadId, '找不到这个话题对应的 larkbot 会话，无法恢复旧上下文。', 'text');
          return;
        }
        await sessions.touch(session, msg.senderId);
        await sessions.submit(session, buildOpeningPrompt(session, msg, promptOptions(activeBot)), buildFollowUpPrompt(msg, promptOptions(activeBot)), msg.id, replyToName(msg), replySignature(activeBot));
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
    consoleServer.close();
    im.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('larkbot 就绪，等待飞书消息…');
}

main().catch((err) => {
  logger.error(`启动失败: ${err?.message ?? err}`);
  process.exit(1);
});

async function loadActiveBot(store: JsonSessionStore, cfg: ReturnType<typeof loadConfig>): Promise<Bot> {
  const bots = await store.loadBots();
  const existing = bots.find((bot) => bot.enabled) ?? bots[0];
  if (existing) return existing;

  const bot: Bot = {
    id: 'default',
    name: process.env.BOT_NAME?.trim() || 'larkbot-dev',
    appId: cfg.larkAppId,
    appSecret: cfg.larkAppSecret,
    cwd: cfg.traexCwd,
    ownerOpenId: cfg.ownerOpenId,
    enabled: true,
    disableStreamingCard: false,
    replySignature: 'larkbot',
    systemPromptProfiles: [],
  };
  await store.saveBots([bot]);
  return bot;
}

function promptOptions(bot: Bot): { systemPrompt?: string; systemPromptName?: string } {
  const profiles = bot.systemPromptProfiles ?? [];
  const profile = profiles.find((item) => item.id === bot.activeSystemPromptProfileId);
  if (!profile?.content.trim()) return {};
  return {
    systemPrompt: profile.content,
    systemPromptName: profile.name,
  };
}

function replyToName(message: ImMessage): string {
  return message.senderName?.trim() || message.senderId.slice(0, 12);
}

function replySignature(bot: Bot): string {
  return bot.replySignature?.trim() || 'larkbot';
}
