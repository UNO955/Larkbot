/**
 * daemon 入口。
 *
 * 装配 config + 飞书长连接 + traex 会话管理，打通命脉：
 *   @机器人一句 → 建话题 → spawn traex → 写入消息 → 输出回贴话题。
 *
 * 有意做薄：具体逻辑在 im/lark 与 core/conversation-manager，这里只负责编排与生命周期。
 *
 * 说明：
 *   - 停止分析由「卡片按钮 / 控制台」触发，只中断当前 turn。
 *   - 关闭流式卡片后，使用 Get / DONE 表情做轻量进度指示。
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { logger } from './utils/logger.js';
import { createLarkAdapter } from './im/lark/client.js';
import { createTraexAdapter } from './adapters/cli/traex.js';
import { ConversationManager } from './core/conversation-manager.js';
import { buildDailyReportSummary, type DailyReportTurn } from './core/daily-report.js';
import { cleanupMetricFiles, METRIC_RETENTION_MS, METRIC_SAMPLE_INTERVAL_MS, sampleAndStoreMetrics } from './core/metrics.js';
import { JsonSessionStore } from './core/store.js';
import { buildFollowUpPrompt, buildOpeningPrompt, buildThreadPrompt } from './core/prompt.js';
import { RECEIVED_REACTION } from './core/reactions.js';
import { buildDailyReportCard, buildFeedbackOwnerCard, buildMaintenanceCard, buildTerminalCard, buildThinkingCard, type FeedbackRating } from './im/lark/card-builder.js';
import { startConsoleServer, TerminalStreamStore } from './console/server.js';
import type { ImAdapter, ImChat, ImMessage, ImReaction } from './im/types.js';
import type { Bot, ExpiredSession, FeedbackRecord, KnownChat, Session } from './core/types.js';
import type { SessionStore } from './core/store.js';

const DAILY_CLEANUP_HOUR = 3;
const DAILY_REPORT_HOUR = 23;
const DAILY_REPORT_MINUTE = 55;
const TRAEX_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const cfg = loadConfig();
  logger.info(`larkbot 启动，traex cwd=${cfg.traexCwd} home=${process.env.TRAE_HOME?.trim() || '~/.trae'}`);
  const store = new JsonSessionStore();
  const terminalStore = new TerminalStreamStore();
  let activeBot = await loadActiveBot(store, cfg);
  const cli = createTraexAdapter();

  const im = createLarkAdapter({
    appId: activeBot.appId,
    appSecret: activeBot.appSecret,
    ownerOpenId: activeBot.ownerOpenId,
    allowedOpenIds: activeBot.allowedOpenIds,
    isAuthorized: ({ openId, chatId }) => isAuthorized(activeBot, openId, chatId),
  });

  // ConversationManager 只依赖“发卡/改卡/回文本”的抽象动作；
  // 飞书 API 细节留在 adapter 层，核心会话逻辑不绑定具体 IM 平台。
  const sessions = new ConversationManager({
    cli,
    store,
    post: async (threadId, text, status, replyAnchorMessageId, _replyToName, replySignature, replyToId, argosSource, knowledge) => {
      return im.sendCard(threadId, buildTerminalCard({ body: text, status, replySignature, replyToId, argosUrlTemplate: cfg.argosUrlTemplate, argosSource, knowledge }), replyAnchorMessageId);
    },
    patch: async (messageId, text, status, _replyToName, replySignature, replyToId, argosSource, knowledge) => {
      await im.updateCard(messageId, buildTerminalCard({ body: text, status, replySignature, replyToId, argosUrlTemplate: cfg.argosUrlTemplate, argosSource, knowledge }));
    },
    postTrace: async (threadId, traceUrl, interruptSessionId, status, replyAnchorMessageId, footer, knowledge) => {
      return im.sendCard(threadId, buildThinkingCard({ url: traceUrl, interruptSessionId, status, footer, knowledge }), replyAnchorMessageId);
    },
    patchTrace: async (messageId, traceUrl, interruptSessionId, status, footer, knowledge) => {
      await im.updateCard(messageId, buildThinkingCard({ url: traceUrl, interruptSessionId, status, footer, knowledge }));
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
    cli,
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
    try {
      const result = cli.cleanupSessionRawLogs?.({ olderThanMs: TRAEX_LOG_RETENTION_MS });
      if (result && result.deleted > 0) {
        logger.info(`traex 日志清理完成 deleted=${result.deleted} bytes=${result.bytes}`);
      }
    } catch (error: any) {
      logger.warn(`traex 日志清理失败: ${error?.message ?? error}`);
    }
    try {
      const result = await cleanupMetricFiles(undefined, METRIC_RETENTION_MS);
      if (result.deleted > 0) {
        logger.info(`指标日志清理完成 deleted=${result.deleted}`);
      }
    } catch (error: any) {
      logger.warn(`指标日志清理失败: ${error?.message ?? error}`);
    }
  };
  const sendDailyReport = async () => {
    try {
      await notifyDailyReport(im, activeBot, store, cfg.consolePublicUrl);
    } catch (error: any) {
      logger.warn(`发送今日战报失败 owner=${activeBot.ownerOpenId.slice(0, 10)}: ${error?.message ?? error}`);
    }
  };
  const cleanupTimer = scheduleDailyTask(cleanupSessions, DAILY_CLEANUP_HOUR, 0, '会话清理任务');
  const dailyReportTimer = scheduleDailyTask(sendDailyReport, DAILY_REPORT_HOUR, DAILY_REPORT_MINUTE, '今日战报任务');
  const metricsTimer = scheduleIntervalTask(async () => {
    await sampleAndStoreMetrics({ store, projectDir: activeBot.cwd });
  }, METRIC_SAMPLE_INTERVAL_MS, '指标采样任务');

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
          await sessions.submit(existing, buildOpeningPrompt(existing, msg, promptOptions(activeBot)), buildThreadPrompt(existing, msg, promptOptions(activeBot)), msg.id, replyToName(msg), replySignature(activeBot), msg.senderId, undefined, msg.content);
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
          await sessions.submit(session, buildOpeningPrompt(session, msg, promptOptions(activeBot)), buildFollowUpPrompt(msg), msg.id, replyToName(msg), replySignature(activeBot), msg.senderId, receivedReactionId, msg.content);
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
        await sessions.submit(session, buildOpeningPrompt(session, msg, promptOptions(activeBot)), buildThreadPrompt(session, msg, promptOptions(activeBot)), msg.id, replyToName(msg), replySignature(activeBot), msg.senderId, undefined, msg.content);
      } catch (err: any) {
        logger.error(`处理话题消息失败: ${err?.message ?? err}`);
        await im.reply(msg.threadId, `消息处理失败：${err?.message ?? err}`, 'text');
      }
    },

    // 表情事件暂不作为用户控制入口；停止和反馈统一走卡片按钮/控制台。
    async onReaction(_reaction: ImReaction): Promise<void> {
      /* no-op */
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
    dailyReportTimer.cancel();
    metricsTimer.cancel();
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
  // 私聊按人授权；群聊可按 chat_id 开关。Owner 永远允许，便于控制台救场。
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

function scheduleDailyTask(task: () => Promise<void>, hour: number, minute: number, label: string): { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const scheduleNext = (): void => {
    if (cancelled) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    const delayMs = next.getTime() - now.getTime();
    timer = setTimeout(() => {
      void task().finally(() => {
        scheduleNext();
      });
    }, delayMs);
    timer.unref?.();
    logger.info(`${label}已调度到 ${formatDateTime(next.toISOString())}`);
  };
  scheduleNext();
  return {
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

function scheduleIntervalTask(task: () => Promise<void>, intervalMs: number, label: string): { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let running = false;
  const run = async (): Promise<void> => {
    if (cancelled) return;
    if (running) {
      scheduleNext();
      return;
    }
    running = true;
    try {
      await task();
    } catch (error: any) {
      logger.warn(`${label}失败: ${error?.message ?? error}`);
    } finally {
      running = false;
      scheduleNext();
    }
  };
  const scheduleNext = (): void => {
    if (cancelled) return;
    timer = setTimeout(() => {
      void run();
    }, intervalMs);
    timer.unref?.();
  };
  scheduleNext();
  logger.info(`${label}已启动，interval=${intervalMs}ms`);
  return {
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function notifyDailyReport(
  im: ImAdapter,
  bot: Bot,
  store: SessionStore,
  dashboardUrl: string,
): Promise<void> {
  const [current, expired] = await Promise.all([
    store.loadSessions(),
    store.loadExpiredSessions?.() ?? Promise.resolve([]),
  ]);
  const report = buildDailyReportSummary(current, expired);
  const card = buildDailyReportCard({
    dateLabel: report.dateLabel,
    totalTurns: report.totalTurns,
    completed: report.completed,
    failed: report.failed,
    stopped: report.stopped,
    totalDuration: formatDuration(report.totalDurationMs),
    busiestChat: report.busiestChat,
    longestTurn: report.longestTurn ? reportTurnView(report.longestTurn) : undefined,
    mostChangedTurn: report.mostChangedTurn ? changedTurnView(report.mostChangedTurn) : undefined,
    remark: report.remark,
    dashboardUrl,
  });
  await im.sendDirectCard(bot.ownerOpenId, card);
  logger.info(`今日战报已发送 turns=${report.totalTurns} failed=${report.failed} stopped=${report.stopped}`);
}

function reportTurnView(turn: DailyReportTurn): { title: string; chat: string; duration: string; status: string } {
  return {
    title: turn.sessionTitle,
    chat: turn.chatName || turn.chatId || '未知群聊',
    duration: formatDuration(turn.durationMs),
    status: reportStatusText(turn.status),
  };
}

function changedTurnView(turn: DailyReportTurn): { title: string; chat: string; changedFileCount: number; files: string[] } {
  return {
    title: turn.sessionTitle,
    chat: turn.chatName || turn.chatId || '未知群聊',
    changedFileCount: turn.changedFileCount,
    files: turn.changedFiles,
  };
}

function reportStatusText(status: DailyReportTurn['status']): string {
  if (status === 'completed') return '完成';
  if (status === 'failed') return '失败';
  if (status === 'stopped') return '停止';
  return '未知';
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
    cleanupPolicy: `每天 03:00，${formatRetention(cfg.sessionIdleCloseMs)}未活跃关闭，${formatRetention(cfg.sessionClosedRetentionMs)}未活跃删除路由，traex 原生日志保留 30 天`,
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

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 分钟';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} 小时${rest ? ` ${rest} 分钟` : ''}`;
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
  // 用户点好评/差评后，原思考卡会被替换成反馈态卡片；
  // Owner 同时收到一张私聊归档卡，便于后续在控制台跟进。
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
    question: session?.latestQuestion,
    answer: session?.latestAnswer,
    knowledge: session?.latestKnowledge,
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
      question: record.question,
      answer: record.answer,
      knowledge: record.knowledge,
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
        knowledge: record.knowledge,
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
  // 差评第一跳只记录 rating；第二跳把快捷原因/手写说明补回同一条反馈记录。
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
    question: session?.latestQuestion,
    answer: session?.latestAnswer,
    knowledge: session?.latestKnowledge,
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
      question: record?.question || session.latestQuestion,
      answer: record?.answer || session.latestAnswer,
      knowledge: record?.knowledge || session.latestKnowledge,
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
        knowledge: record?.knowledge,
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
  question?: string;
  answer?: string;
  knowledge?: FeedbackRecord['knowledge'];
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
      question: input.question,
      answer: input.answer,
      knowledge: input.knowledge,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    feedbacks.unshift(record);
  }
  record.reason = input.reason || record.reason;
  record.note = input.note || record.note;
  record.question = input.question || record.question;
  record.answer = input.answer || record.answer;
  record.knowledge = input.knowledge || record.knowledge;
  record.traceExcerpt = input.traceExcerpt || record.traceExcerpt;
  record.updatedAt = new Date().toISOString();
  await store.saveFeedbacks(feedbacks.slice(0, 500));
  return record;
}
