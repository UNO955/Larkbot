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
import { loadConfig } from './config.js';
import { logger } from './utils/logger.js';
import { createLarkAdapter } from './im/lark/client.js';
import { createTraexAdapter } from './adapters/cli/traex.js';
import { SessionManager } from './core/session-manager.js';
import { buildTerminalCard } from './im/lark/card-builder.js';
import type { ImMessage, ImReaction } from './im/types.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  logger.info(`larkmux 启动，traex cwd=${cfg.traexCwd}`);

  const im = createLarkAdapter({
    appId: cfg.larkAppId,
    appSecret: cfg.larkAppSecret,
    ownerOpenId: cfg.ownerOpenId,
  });

  const sessions = new SessionManager({
    cli: createTraexAdapter(),
    cwd: cfg.traexCwd,
    // 首帧：在话题里发一张「运行中」终端卡片，返回 message_id
    post: async (threadId, text) => {
      return im.sendCard(threadId, buildTerminalCard({ title: 'traex · 运行中', body: text, template: 'blue' }));
    },
    // 后续帧：patch 同一张卡片，原地刷新（不再新发消息，杜绝刷屏）
    patch: async (messageId, text) => {
      await im.updateCard(messageId, buildTerminalCard({ title: 'traex · 运行中', body: text, template: 'blue' }));
    },
  });

  await im.start({
    // ① @机器人（尚无话题）→ 建话题 + 建会话 + 首条消息入队
    async onMention(msg: ImMessage): Promise<void> {
      try {
        const { threadId } = await im.replyInThread(msg.id, '🧵 会话已创建，traex 启动中…');
        sessions.create(threadId, msg.chatId, cfg.larkAppId);
        if (msg.content) sessions.enqueue(threadId, msg.content);
      } catch (err: any) {
        logger.error(`建会话失败: ${err?.message ?? err}`);
      }
    },

    // ② 话题内新消息 → 入队（busy 不打断）
    async onThreadReply(msg: ImMessage): Promise<void> {
      if (!sessions.has(msg.threadId)) {
        // 话题存在但会话已丢失（daemon 重启后）→ 阶段一提示重新 @
        await im.reply(msg.threadId, '⚠️ 会话已失效，请重新 @ 我开启新会话。', 'text');
        return;
      }
      sessions.enqueue(msg.threadId, msg.content);
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
    sessions.closeAll();
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
