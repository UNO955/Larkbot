/**
 * daemon 入口（阶段一）。
 *
 * 装配 config + 飞书长连接 + traex 会话管理，打通命脉：
 *   @机器人一句 → 建话题 → spawn traex → 写入消息 → 输出回贴话题。
 *
 * 有意做薄：具体逻辑在 im/lark 与 core/session-manager，这里只负责编排与生命周期。
 *
 * 说明（阶段一范围）：
 *   - 停止分析由「卡片按钮 / 控制台」触发，不是表情。
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
import { buildFollowUpPrompt, buildOpeningPrompt, buildThreadPrompt } from './core/prompt.js';
import { RECEIVED_REACTION } from './core/reactions.js';
import { buildTerminalCard, buildThinkingCard } from './im/lark/card-builder.js';
import { startConsoleServer, TerminalStreamStore } from './console/server.js';
import type { ImAdapter, ImChat, ImMessage, ImReaction } from './im/types.js';
import type { Bot, KnownChat, Session } from './core/types.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  logger.info(`larkbot 启动，traex cwd=${cfg.traexCwd} home=${process.env.TRAE_HOME?.trim() || '~/.trae'}`);
  const store = new JsonSessionStore();
  const terminalStore = new TerminalStreamStore();
  let activeBot = await loadActiveBot(store, cfg);

  const im = createLarkAdapter({
    appId: activeBot.appId,
    appSecret: activeBot.appSecret,
    ownerOpenId: activeBot.ownerOpenId,
    allowedOpenIds: activeBot.allowedOpenIds,
    isAuthorized: ({ openId, chatId }) => isAuthorized(activeBot, openId, chatId),
  });

  const sessions = new ConversationManager({
    cli: createTraexAdapter(),
    store,
    post: async (threadId, text, status, replyAnchorMessageId, _replyToName, replySignature, replyToId, argosSource) => {
      return im.sendCard(threadId, buildTerminalCard({ body: text, status, replySignature, replyToId, argosUrlTemplate: cfg.argosUrlTemplate, argosSource }), replyAnchorMessageId);
    },
    patch: async (messageId, text, status, _replyToName, replySignature, replyToId, argosSource) => {
      await im.updateCard(messageId, buildTerminalCard({ body: text, status, replySignature, replyToId, argosUrlTemplate: cfg.argosUrlTemplate, argosSource }));
    },
    postTrace: async (threadId, traceUrl, interruptSessionId, status, replyAnchorMessageId, footer) => {
      return im.sendCard(threadId, buildThinkingCard({ url: traceUrl, interruptSessionId, status, footer }), replyAnchorMessageId);
    },
    patchTrace: async (messageId, traceUrl, interruptSessionId, status, footer) => {
      await im.updateCard(messageId, buildThinkingCard({ url: traceUrl, interruptSessionId, status, footer }));
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
    redactTerminalInput: (sessionId, content) => {
      terminalStore.redactInput(sessionId, content);
    },
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
  const cleanupSessions = async () => {
    try {
      const result = await sessions.cleanupStaleSessions({
        idleCloseMs: cfg.sessionIdleCloseMs,
        closedRetentionMs: cfg.sessionClosedRetentionMs,
      });
      if (result.closed || result.deleted) {
        logger.info(`会话清理完成 closed=${result.closed} deleted=${result.deleted}`);
      }
    } catch (error: any) {
      logger.warn(`会话清理失败: ${error?.message ?? error}`);
    }
  };
  await cleanupSessions();
  const cleanupTimer = cfg.sessionCleanupIntervalMs > 0
    ? setInterval(() => void cleanupSessions(), cfg.sessionCleanupIntervalMs)
    : undefined;
  cleanupTimer?.unref?.();

  await im.start({
    async onChatObserved(chat: ImChat): Promise<void> {
      await rememberChat(store, activeBot, chat).then((bot) => {
        if (bot) activeBot = bot;
      }).catch((error: any) => {
        logger.warn(`记录群聊失败 chat=${chat.chatId}: ${error?.message ?? error}`);
      });
    },

    // ① @机器人（尚无话题）→ 建话题 + 建会话 + 首条消息入队
    async onMention(msg: ImMessage): Promise<void> {
      try {
        const existing = sessions.find(msg.chatId, msg.rootMessageId, msg.threadId, msg.quotedMessageId);
        if (existing) {
          await sessions.touch(existing, msg.senderId);
          await sessions.submit(existing, buildOpeningPrompt(existing, msg, promptOptions(activeBot)), buildThreadPrompt(existing, msg, promptOptions(activeBot)), msg.id, replyToName(msg), replySignature(activeBot), msg.senderId);
          return;
        }

        const receivedReactionId = await addReceivedReactionBeforeThread(im, msg.id);
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
          model: activeBot.model,
          hasHistory: false,
          ownerOpenId: activeBot.ownerOpenId,
          lastCallerOpenId: msg.senderId,
          lastMessageAt: now,
          createdAt: now,
        };
        await sessions.add(session);
        if (msg.content) {
          await sessions.submit(session, buildOpeningPrompt(session, msg, promptOptions(activeBot)), buildFollowUpPrompt(msg), msg.id, replyToName(msg), replySignature(activeBot), msg.senderId, receivedReactionId);
        }
      } catch (err: any) {
        logger.error(`建会话失败: ${err?.message ?? err}`);
      }
    },

    // ② 话题内新消息 → 入队（busy 不打断）
    async onThreadReply(msg: ImMessage): Promise<void> {
      try {
        const session = sessions.find(msg.chatId, msg.rootMessageId, msg.threadId, msg.quotedMessageId);
        if (!session) {
          logger.warn(`话题消息找不到会话 chat=${msg.chatId} root=${msg.rootMessageId} thread=${msg.threadId} quote=${msg.quotedMessageId ?? '-'}`);
          await im.reply(msg.threadId, '找不到这个话题对应的 larkbot 会话，无法恢复旧上下文。', 'text');
          return;
        }
        await sessions.touch(session, msg.senderId);
        await sessions.submit(session, buildOpeningPrompt(session, msg, promptOptions(activeBot)), buildThreadPrompt(session, msg, promptOptions(activeBot)), msg.id, replyToName(msg), replySignature(activeBot), msg.senderId);
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

    async onCardAction(action): Promise<unknown> {
      const payload = parseCardActionValue(action.value);
      if (payload.action !== 'interrupt_thinking' || typeof payload.sessionId !== 'string') return;
      const sessionId = payload.sessionId;
      void sessions.interruptSession(sessionId).then((session) => {
        if (!session) logger.warn(`停止分析失败，未找到 session=${sessionId}`);
      }).catch((error: any) => {
        logger.warn(`停止分析失败 session=${sessionId}: ${error?.message ?? error}`);
      });
      return {
        toast: { type: 'info', content: '已停止本轮分析' },
        card: {
          type: 'raw',
          data: buildThinkingCard({
            url: `${cfg.consolePublicUrl.replace(/\/+$/, '')}/terminal/${encodeURIComponent(sessionId)}`,
            interruptSessionId: sessionId,
            status: 'stopped',
          }).payload,
        },
      };
    },
  });
  await backfillKnownChatNames(store, activeBot, im).then((bot) => {
    if (bot) activeBot = bot;
  }).catch((error: any) => {
    logger.warn(`回填群聊名称失败: ${error?.message ?? error}`);
  });

  // 优雅退出
  const shutdown = () => {
    logger.info('收到退出信号，关闭所有会话…');
    if (cleanupTimer) clearInterval(cleanupTimer);
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
    allowedOpenIds: cfg.allowedOpenIds,
    allowedChatIds: [],
    knownChats: [],
    enabled: true,
    model: process.env.TRAEX_MODEL?.trim() || undefined,
    disableStreamingCard: false,
    replySignature: 'larkbot',
    systemPromptProfiles: [],
  };
  await store.saveBots([bot]);
  return bot;
}

function isAuthorized(bot: Bot, openId: string, chatId?: string): boolean {
  if (!openId) return false;
  if (openId === bot.ownerOpenId) return true;
  if (bot.allowedOpenIds?.includes(openId)) return true;
  return !!chatId && !!bot.allowedChatIds?.includes(chatId);
}

async function rememberChat(store: JsonSessionStore, activeBot: Bot, chat: ImChat): Promise<Bot | undefined> {
  if (!chat.chatId || chat.chatType === 'p2p') return undefined;
  const bots = await store.loadBots();
  const index = bots.findIndex((bot) => bot.id === activeBot.id);
  if (index < 0) return undefined;
  const bot = { ...bots[index] };
  const now = new Date().toISOString();
  const knownChats = [...(bot.knownChats ?? [])];
  const existing = knownChats.find((item) => item.chatId === chat.chatId);
  if (existing) {
    existing.name = chat.name || existing.name;
    existing.lastSeenAt = now;
    existing.source = chat.source;
  } else {
    const next: KnownChat = {
      chatId: chat.chatId,
      name: chat.name,
      lastSeenAt: now,
      source: chat.source,
    };
    knownChats.push(next);
  }
  bot.knownChats = knownChats;
  bots[index] = bot;
  await store.saveBots(bots);
  return bot;
}

async function backfillKnownChatNames(store: JsonSessionStore, activeBot: Bot, im: ImAdapter): Promise<Bot | undefined> {
  const missing = (activeBot.knownChats ?? []).filter((chat) => !chat.name?.trim());
  if (missing.length === 0) return undefined;
  const bots = await store.loadBots();
  const index = bots.findIndex((bot) => bot.id === activeBot.id);
  if (index < 0) return undefined;
  const bot = { ...bots[index] };
  const knownChats = [...(bot.knownChats ?? [])];
  let changed = false;
  for (const chat of knownChats) {
    if (chat.name?.trim()) continue;
    const name = await im.getChatName(chat.chatId);
    if (!name) continue;
    chat.name = name;
    changed = true;
  }
  if (!changed) return undefined;
  bot.knownChats = knownChats;
  bots[index] = bot;
  await store.saveBots(bots);
  logger.info(`已回填群聊名称 ${knownChats.filter((chat) => chat.name?.trim()).length}/${knownChats.length}`);
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
  return message.senderName?.trim() || '';
}

function replySignature(bot: Bot): string {
  return bot.replySignature?.trim() || 'larkbot';
}

async function addReceivedReactionBeforeThread(im: ImAdapter, messageId: string): Promise<string | undefined> {
  try {
    return await im.addReaction(messageId, RECEIVED_REACTION);
  } catch (error: any) {
    logger.warn(`首轮 Get 表情添加失败 message=${messageId.slice(0, 12)}: ${error?.message ?? error}`);
    return undefined;
  }
}

function parseCardActionValue(value: unknown): { action?: unknown; sessionId?: unknown } {
  if (value && typeof value === 'object') return value as { action?: unknown; sessionId?: unknown };
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
