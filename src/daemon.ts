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
import { buildFeedbackOwnerCard, buildMaintenanceCard, buildTerminalCard, buildThinkingCard, type FeedbackRating } from './im/lark/card-builder.js';
import { startConsoleServer, TerminalStreamStore } from './console/server.js';
import type { ImAdapter, ImChat, ImMessage, ImReaction } from './im/types.js';
import type { Bot, ExpiredSession, FeedbackRecord, KnownChat, Session } from './core/types.js';
import type { SessionStore } from './core/store.js';

const DAILY_CLEANUP_HOUR = 3;

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
  await backfillSessionUserNames(store, im).catch((error: any) => {
    logger.warn(`回填会话发起人名称失败: ${error?.message ?? error}`);
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
        await notifyCleanupResult(im, activeBot, result);
      }
    } catch (error: any) {
      logger.warn(`会话清理失败: ${error?.message ?? error}`);
    }
  };
  const cleanupTimer = scheduleDailyCleanup(cleanupSessions, DAILY_CLEANUP_HOUR);

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
          createdByOpenId: msg.senderId,
          createdByName: replyToName(msg),
          lastCallerOpenId: msg.senderId,
          chatName: chatName(activeBot, msg.chatId),
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
          const closed = sessions.findClosed(msg.chatId, msg.rootMessageId, msg.threadId, msg.quotedMessageId);
          if (closed) {
            logger.info(`话题会话已关闭 chat=${msg.chatId} root=${msg.rootMessageId} thread=${msg.threadId}`);
            await im.reply(msg.threadId, '这个会话已关闭，请重新@bot发起新话题', 'text', msg.id);
            return;
          }
          const expired = await sessions.findExpired(msg.chatId, msg.rootMessageId, msg.threadId, msg.quotedMessageId);
          if (expired) {
            logger.info(`话题会话已过期清理 chat=${msg.chatId} root=${msg.rootMessageId} thread=${msg.threadId}`);
            await im.reply(
              msg.threadId,
              `这个 larkbot 会话已因超过 7 天未活跃被清理，无法继续恢复上下文。请重新 @ bot 发起一个新话题。\n\n原会话：${expired.title || expired.sessionId}\n最后活跃：${formatDateTime(expired.lastMessageAt)}`,
              'text',
              msg.id,
            );
            return;
          }
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
      if (payload.action === 'rate_thinking' && typeof payload.sessionId === 'string' && isFeedbackRating(payload.rating)) {
        return await handleThinkingFeedback({
          im,
          bot: activeBot,
          store,
          sessions,
          terminalStore,
          consolePublicUrl: cfg.consolePublicUrl,
          action,
          sessionId: payload.sessionId,
          rating: payload.rating,
          footer: typeof payload.footer === 'string' ? payload.footer : undefined,
        });
      }
      if (payload.action === 'submit_negative_feedback' && typeof payload.sessionId === 'string') {
        return await handleNegativeFeedbackSupplement({
          im,
          bot: activeBot,
          store,
          sessions,
          terminalStore,
          consolePublicUrl: cfg.consolePublicUrl,
          action,
          sessionId: payload.sessionId,
          feedbackId: typeof payload.feedbackId === 'string' ? payload.feedbackId : undefined,
          reason: typeof payload.reason === 'string' ? payload.reason : undefined,
          footer: typeof payload.footer === 'string' ? payload.footer : undefined,
        });
      }
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
  await notifyStartup(im, activeBot, cfg, restored).catch((error: any) => {
    logger.warn(`发送重启私聊失败 owner=${activeBot.ownerOpenId.slice(0, 10)}: ${error?.message ?? error}`);
  });

  // 优雅退出
  const shutdown = () => {
    logger.info('收到退出信号，关闭所有会话…');
    cleanupTimer.cancel();
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

async function backfillSessionUserNames(store: JsonSessionStore, im: ImAdapter): Promise<void> {
  const sessions = await store.loadSessions();
  let changed = false;
  for (const session of sessions) {
    if (session.createdByName?.trim() || !session.createdByOpenId) continue;
    const name = await im.getUserName(session.createdByOpenId, session.chatId);
    if (!name) continue;
    session.createdByName = name;
    changed = true;
  }
  if (!changed) return;
  await store.saveSessions(sessions);
  logger.info(`已回填会话发起人名称 ${sessions.filter((session) => session.createdByName?.trim()).length}/${sessions.length}`);
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

function chatName(bot: Bot, chatId: string): string | undefined {
  return bot.knownChats?.find((chat) => chat.chatId === chatId)?.name;
}

function scheduleDailyCleanup(task: () => Promise<void>, hour: number): { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const scheduleNext = (): void => {
    if (cancelled) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    const delayMs = next.getTime() - now.getTime();
    timer = setTimeout(() => {
      void task().finally(() => {
        scheduleNext();
      });
    }, delayMs);
    timer.unref?.();
    logger.info(`会话清理任务已调度到 ${formatDateTime(next.toISOString())}`);
  };
  scheduleNext();
  return {
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function notifyCleanupResult(
  im: ImAdapter,
  bot: Bot,
  result: { closedSessions: Session[]; deletedSessions: ExpiredSession[] },
): Promise<void> {
  if (!result.closedSessions.length && !result.deletedSessions.length) return;
  const lines = [
    'larkbot 会话清理完成',
    '',
    `关闭会话：${result.closedSessions.length} 个`,
    ...result.closedSessions.slice(0, 20).map((session) => `- ${sessionSummary(session)}`),
    '',
    `删除路由：${result.deletedSessions.length} 个`,
    ...result.deletedSessions.slice(0, 20).map((session) => `- ${expiredSessionSummary(session)}`),
  ];
  if (result.closedSessions.length > 20 || result.deletedSessions.length > 20) {
    lines.push('', '仅展示前 20 条，完整记录可查看状态文件。');
  }
  try {
    await im.sendDirect(bot.ownerOpenId, lines.join('\n'));
  } catch (error: any) {
    logger.warn(`发送会话清理私聊失败 owner=${bot.ownerOpenId.slice(0, 10)}: ${error?.message ?? error}`);
  }
}

async function notifyStartup(
  im: ImAdapter,
  bot: Bot,
  cfg: ReturnType<typeof loadConfig>,
  restored: Session[],
): Promise<void> {
  const activeCount = restored.filter((session) => session.status === 'active').length;
  const closedCount = restored.filter((session) => session.status === 'closed').length;
  const lines = [
    `恢复路由：${restored.length} 个（active ${activeCount} / closed ${closedCount}）`,
    `执行目录：${bot.cwd}`,
  ];
  const card = buildMaintenanceCard({
    status: '🔄 larkbot 已重启',
    version: `v${process.env.npm_package_version || '0.1.0'}`,
    unfinishedSessions: activeCount,
    dashboardUrl: cfg.consolePublicUrl,
    cleanupPolicy: `每天 03:00，${formatRetention(cfg.sessionIdleCloseMs)}未活跃关闭，${formatRetention(cfg.sessionClosedRetentionMs)}未活跃删除路由`,
    details: lines,
  });
  await im.sendDirectCard(bot.ownerOpenId, card);
}

function formatRetention(ms: number): string {
  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  if (ms > 0 && ms % dayMs === 0) return `${ms / dayMs} 天以上`;
  if (ms > 0 && ms % hourMs === 0) return `${ms / hourMs} 小时以上`;
  return `${Math.round(ms / 1000)} 秒以上`;
}

function sessionSummary(session: Session): string {
  return `${session.title || session.sessionId}｜${session.createdByName || session.createdByOpenId || '未知发起人'}｜${session.chatName || session.chatId}｜最后活跃 ${formatDateTime(session.lastMessageAt)}｜${session.sessionId}`;
}

function expiredSessionSummary(session: ExpiredSession): string {
  return `${session.title || session.sessionId}｜${session.createdByName || session.createdByOpenId || '未知发起人'}｜${session.chatName || session.chatId}｜最后活跃 ${formatDateTime(session.lastMessageAt)}｜${session.sessionId}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

async function addReceivedReactionBeforeThread(im: ImAdapter, messageId: string): Promise<string | undefined> {
  try {
    return await im.addReaction(messageId, RECEIVED_REACTION);
  } catch (error: any) {
    logger.warn(`首轮 Get 表情添加失败 message=${messageId.slice(0, 12)}: ${error?.message ?? error}`);
    return undefined;
  }
}
async function handleThinkingFeedback(opts: {
  im: ImAdapter;
  bot: Bot;
  store: SessionStore;
  sessions: ConversationManager;
  terminalStore: TerminalStreamStore;
  consolePublicUrl: string;
  action: { operatorId: string; chatId?: string };
  sessionId: string;
  rating: FeedbackRating;
  footer?: string;
}): Promise<unknown> {
  const session = opts.sessions.getSession(opts.sessionId);
  const terminalUrl = `${opts.consolePublicUrl.replace(/\/+$/, '')}/terminal/${encodeURIComponent(opts.sessionId)}`;
  const operatorName = await opts.im.getUserName(opts.action.operatorId, opts.action.chatId).catch(() => undefined);
  const traceExcerpt = opts.terminalStore.snapshot(opts.sessionId, 2600);
  const record: FeedbackRecord = {
    id: randomUUID(),
    rating: opts.rating,
    status: 'open',
    sessionId: opts.sessionId,
    sessionTitle: session?.title || opts.sessionId,
    chatName: session?.chatName || (session ? chatName(opts.bot, session.chatId) : undefined),
    chatId: session?.chatId || opts.action.chatId,
    operatorName,
    operatorId: opts.action.operatorId,
    terminalUrl,
    traceExcerpt,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await appendFeedback(opts.store, record).catch((error: any) => {
    logger.warn(`写入反馈记录失败 session=${opts.sessionId.slice(0, 8)}: ${error?.message ?? error}`);
  });
  if (session) {
    const card = buildFeedbackOwnerCard({
      rating: opts.rating,
      sessionTitle: record.sessionTitle,
      sessionId: record.sessionId,
      chatName: record.chatName,
      chatId: record.chatId,
      operatorName: record.operatorName,
      operatorId: record.operatorId,
      terminalUrl,
      traceExcerpt,
    });
    void opts.im.sendDirectCard(opts.bot.ownerOpenId, card).catch((error: any) => {
      logger.warn(`发送反馈私聊失败 owner=${opts.bot.ownerOpenId.slice(0, 10)} session=${opts.sessionId.slice(0, 8)}: ${error?.message ?? error}`);
    });
  } else {
    logger.warn(`收到反馈但未找到 session=${opts.sessionId}`);
  }
  return {
    toast: {
      type: opts.rating === 'positive' ? 'success' : 'info',
      content: opts.rating === 'positive' ? '感谢反馈' : '已收到反馈',
    },
    card: {
      type: 'raw',
      data: buildThinkingCard({
        url: terminalUrl,
        interruptSessionId: opts.sessionId,
        status: 'completed',
        feedback: opts.rating === 'negative' ? 'negative_pending' : opts.rating,
        feedbackId: record.id,
        footer: opts.footer,
      }).payload,
    },
  };
}

async function handleNegativeFeedbackSupplement(opts: {
  im: ImAdapter;
  bot: Bot;
  store: SessionStore;
  sessions: ConversationManager;
  terminalStore: TerminalStreamStore;
  consolePublicUrl: string;
  action: { operatorId: string; chatId?: string; formValue?: Record<string, unknown> };
  sessionId: string;
  feedbackId?: string;
  reason?: string;
  footer?: string;
}): Promise<unknown> {
  const session = opts.sessions.getSession(opts.sessionId);
  const terminalUrl = `${opts.consolePublicUrl.replace(/\/+$/, '')}/terminal/${encodeURIComponent(opts.sessionId)}`;
  const operatorName = await opts.im.getUserName(opts.action.operatorId, opts.action.chatId).catch(() => undefined);
  const reason = cleanFeedbackText(opts.reason || '') || stringFormValue(opts.action.formValue, 'feedback_reason');
  const note = stringFormValue(opts.action.formValue, 'feedback_note');
  const traceExcerpt = opts.terminalStore.snapshot(opts.sessionId, 2600);
  const record = await updateNegativeFeedbackSupplement(opts.store, {
    feedbackId: opts.feedbackId,
    sessionId: opts.sessionId,
    sessionTitle: session?.title || opts.sessionId,
    chatName: session?.chatName || (session ? chatName(opts.bot, session.chatId) : undefined),
    chatId: session?.chatId || opts.action.chatId,
    operatorName,
    operatorId: opts.action.operatorId,
    terminalUrl,
    traceExcerpt,
    reason,
    note,
  }).catch((error: any) => {
    logger.warn(`写入差评原因失败 session=${opts.sessionId.slice(0, 8)}: ${error?.message ?? error}`);
    return undefined;
  });
  if (session) {
    const card = buildFeedbackOwnerCard({
      rating: 'negative',
      sessionTitle: record?.sessionTitle || session.title,
      sessionId: record?.sessionId || session.sessionId,
      chatName: record?.chatName || session.chatName || chatName(opts.bot, session.chatId),
      chatId: record?.chatId || session.chatId,
      operatorName: record?.operatorName || operatorName,
      operatorId: record?.operatorId || opts.action.operatorId,
      terminalUrl,
      traceExcerpt,
      reason,
      note,
      supplemental: true,
    });
    void opts.im.sendDirectCard(opts.bot.ownerOpenId, card).catch((error: any) => {
      logger.warn(`发送差评原因私聊失败 owner=${opts.bot.ownerOpenId.slice(0, 10)} session=${opts.sessionId.slice(0, 8)}: ${error?.message ?? error}`);
    });
  } else {
    logger.warn(`收到差评原因但未找到 session=${opts.sessionId}`);
  }
  return {
    toast: { type: 'success', content: '已提交原因' },
    card: {
      type: 'raw',
      data: buildThinkingCard({
        url: terminalUrl,
        interruptSessionId: opts.sessionId,
        status: 'completed',
        feedback: 'negative',
        feedbackReason: reason,
        feedbackNote: note,
        feedbackId: record?.id || opts.feedbackId,
        footer: opts.footer,
      }).payload,
    },
  };
}

function parseCardActionValue(value: unknown): { action?: unknown; sessionId?: unknown; feedbackId?: unknown; rating?: unknown; reason?: unknown; footer?: unknown } {
  if (value && typeof value === 'object') return value as { action?: unknown; sessionId?: unknown; feedbackId?: unknown; rating?: unknown; reason?: unknown; footer?: unknown };
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function isFeedbackRating(value: unknown): value is FeedbackRating {
  return value === 'positive' || value === 'negative';
}

function stringFormValue(formValue: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = formValue?.[key];
  if (typeof value === 'string') return cleanFeedbackText(value);
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => typeof item === 'string' ? item : undefined)
      .filter((item): item is string => !!item)
      .join('、');
    return cleanFeedbackText(joined);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const candidate of [record.value, record.text, record.content]) {
      if (typeof candidate === 'string') return cleanFeedbackText(candidate);
    }
  }
  return undefined;
}

function cleanFeedbackText(value: string): string | undefined {
  const text = value.trim().slice(0, 500);
  return text || undefined;
}

async function appendFeedback(store: SessionStore, record: FeedbackRecord): Promise<void> {
  if (!store.loadFeedbacks || !store.saveFeedbacks) return;
  const feedbacks = await store.loadFeedbacks();
  feedbacks.unshift(record);
  await store.saveFeedbacks(feedbacks.slice(0, 500));
}

async function updateNegativeFeedbackSupplement(store: SessionStore, input: {
  feedbackId?: string;
  sessionId: string;
  sessionTitle: string;
  chatName?: string;
  chatId?: string;
  operatorName?: string;
  operatorId: string;
  terminalUrl: string;
  traceExcerpt: string;
  reason?: string;
  note?: string;
}): Promise<FeedbackRecord | undefined> {
  if (!store.loadFeedbacks || !store.saveFeedbacks) return undefined;
  const feedbacks = await store.loadFeedbacks();
  let record = feedbacks.find((item) => item.id === input.feedbackId);
  if (!record) {
    record = feedbacks.find((item) =>
      item.rating === 'negative'
      && item.sessionId === input.sessionId
      && item.operatorId === input.operatorId
    );
  }
  if (!record) {
    record = {
      id: randomUUID(),
      rating: 'negative',
      status: 'open',
      sessionId: input.sessionId,
      sessionTitle: input.sessionTitle,
      chatId: input.chatId,
      chatName: input.chatName,
      operatorId: input.operatorId,
      operatorName: input.operatorName,
      terminalUrl: input.terminalUrl,
      traceExcerpt: input.traceExcerpt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    feedbacks.unshift(record);
  }
  record.reason = input.reason || record.reason;
  record.note = input.note || record.note;
  record.traceExcerpt = input.traceExcerpt || record.traceExcerpt;
  record.updatedAt = new Date().toISOString();
  await store.saveFeedbacks(feedbacks.slice(0, 500));
  return record;
}
