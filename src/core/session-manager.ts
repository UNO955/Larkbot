/**
 * 会话管理（阶段二：接入 IdleDetector）。
 *
 * 一个飞书话题（threadId）对应一个 Session：一个 traex PTY + FIFO 队列 + 一个 IdleDetector。
 * 一轮是否结束由 IdleDetector 判定（quiescence + spinner guard + readyPattern gate），
 * 取代阶段一的裸静默超时。判 idle → 回 idle 态 → drain 队列下一条；drain 前 reset detector。
 */
import * as pty from 'node-pty';
import type { Session, SessionStatus } from './types.js';
import type { CliAdapter } from '../adapters/cli/types.js';
import { IdleDetector } from '../utils/idle-detector.js';
import { logger } from '../utils/logger.js';

const FLUSH_INTERVAL_MS = 800;  // 回贴节流间隔

export interface SessionManagerDeps {
  cli: CliAdapter;
  cwd: string;
  /** 把会话的最新输出回贴到飞书话题。阶段一是纯文本 create/patch。 */
  emit(threadId: string, text: string): Promise<void>;
}

interface SessionRuntime {
  session: Session;
  detector: IdleDetector;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

export class SessionManager {
  private runtimes = new Map<string, SessionRuntime>();

  constructor(private deps: SessionManagerDeps) {}

  has(threadId: string): boolean {
    return this.runtimes.has(threadId);
  }

  /** 建会话：spawn traex PTY，接好输出流 + idle 检测。 */
  create(threadId: string, chatId: string, botId: string): Session {
    const spec = this.deps.cli.spawnSpec(this.deps.cwd);
    const p = pty.spawn(spec.command, spec.args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: spec.cwd,
      env: spec.env ?? (process.env as Record<string, string>),
    });

    const session: Session = {
      threadId, chatId, botId,
      pty: p,
      status: 'idle',
      queue: [],
      screenBuffer: '',
      lastDataAt: Date.now(),
      spawnedAt: Date.now(),
    };

    const detector = new IdleDetector(this.deps.cli);
    const rt: SessionRuntime = { session, detector, flushTimer: null };
    this.runtimes.set(threadId, rt);

    // 一轮结束 → 回 idle，处理队列下一条
    detector.onIdle((source) => {
      if (session.status !== 'busy') return;
      session.status = 'idle';
      logger.info(`一轮结束（${source}）thread=${threadId.slice(0, 10)}`);
      this.drain(rt);
    });

    p.onData((chunk) => this.onData(rt, chunk));
    p.onExit(({ exitCode }) => {
      logger.warn(`traex 退出 thread=${threadId.slice(0, 10)} code=${exitCode}`);
      this.teardown(threadId);
    });

    logger.info(`会话已创建 thread=${threadId.slice(0, 10)} pid=${p.pid}`);
    return session;
  }

  /** 收到用户消息：入队。busy 时不打断，idle 时立即 drain。 */
  enqueue(threadId: string, text: string): void {
    const rt = this.runtimes.get(threadId);
    if (!rt) return;
    rt.session.queue.push(text);
    if (rt.session.status === 'idle') this.drain(rt);
  }

  close(threadId: string): void {
    const rt = this.runtimes.get(threadId);
    if (!rt) return;
    try { rt.session.pty.kill(); } catch { /* 已退出 */ }
    this.teardown(threadId);
    logger.info(`会话已关闭 thread=${threadId.slice(0, 10)}`);
  }

  closeAll(): void {
    for (const id of [...this.runtimes.keys()]) this.close(id);
  }

  // ── 内部 ──────────────────────────────────────────────

  private drain(rt: SessionRuntime): void {
    const s = rt.session;
    if (s.queue.length === 0) return;
    const next = s.queue.shift()!;
    s.status = 'busy';
    s.screenBuffer = '';
    s.currentTurnText = next;
    rt.detector.reset();          // 新一轮：重新武装 idle 检测
    s.pty.write(next + '\r');
    logger.info(`→ traex thread=${s.threadId.slice(0, 10)}: ${next.slice(0, 40)}`);
  }

  private onData(rt: SessionRuntime, chunk: string): void {
    const s = rt.session;
    s.screenBuffer += chunk;
    s.lastDataAt = Date.now();
    rt.detector.feed(chunk);      // 驱动 idle 判定
    this.armFlush(rt);
  }

  /** 节流把当前 screenBuffer 回贴飞书。 */
  private armFlush(rt: SessionRuntime): void {
    if (rt.flushTimer) return;
    rt.flushTimer = setTimeout(() => {
      rt.flushTimer = null;
      const text = stripAnsi(rt.session.screenBuffer).trim();
      if (text) this.deps.emit(rt.session.threadId, text).catch((e) => logger.error(`回贴失败: ${e?.message ?? e}`));
    }, FLUSH_INTERVAL_MS);
  }

  private teardown(threadId: string): void {
    const rt = this.runtimes.get(threadId);
    if (!rt) return;
    if (rt.flushTimer) { clearTimeout(rt.flushTimer); rt.flushTimer = null; }
    rt.detector.dispose();
    rt.session.status = 'closed';
    this.runtimes.delete(threadId);
  }
}

/** 去除 ANSI 转义序列（阶段一纯文本回贴用；阶段三换 headless xterm 渲染）。导出仅供单测。 */
export function stripAnsi(input: string): string {
  return (
    input
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') // CSI（含私有模式）
      // OSC：traex 会发色彩查询 OSC 10/11，可能以 BEL(\x07) 或 ST(\x1b\\) 结尾；
      // 早先只匹配 BEL 结尾导致 `]10;?\]11;?\` 残留到回贴文本。两种终止符都要处理。
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[()][0-9A-B]/g, '') // 字符集选择
  );
}
