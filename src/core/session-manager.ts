/**
 * 会话管理（阶段二：接入 IdleDetector；阶段三：流式卡片 patch + xterm 渲染）。
 *
 * 一个飞书话题（threadId）对应一个 Session：一个 traex PTY + FIFO 队列 +
 * 一个 IdleDetector + 一个 TerminalRenderer。
 *
 * 一轮是否结束由 IdleDetector 判定（quiescence + spinner guard + readyPattern gate）。
 * 判 idle → 回 idle 态 → drain 队列下一条；drain 前 reset detector + 起新卡片。
 *
 * 回贴策略（关键，防刷屏）：
 *   - traex 是全屏 TUI，会不断重绘同一块屏幕。用 TerminalRenderer（headless
 *     xterm）维护屏幕缓冲，回贴的是「当前屏幕快照」而非 PTY 裸流。
 *   - 每一轮只维护「一条」流式卡片：首帧 create 拿 messageId，之后同一轮内
 *     patch 更新它；快照内容没变化就不发，避免无意义刷屏。
 */
import * as pty from 'node-pty';
import type { Session } from './types.js';
import type { CliAdapter } from '../adapters/cli/types.js';
import { IdleDetector } from '../utils/idle-detector.js';
import { TerminalRenderer } from '../utils/terminal-renderer.js';
import { logger } from '../utils/logger.js';

const FLUSH_INTERVAL_MS = 800;   // 回贴节流间隔
const PTY_COLS = 100;
const PTY_ROWS = 30;

export interface SessionManagerDeps {
  cli: CliAdapter;
  cwd: string;
  /** 首次回贴：在话题里创建一条流式消息，返回其 message_id。 */
  post(threadId: string, text: string): Promise<string>;
  /** 后续回贴：patch 更新已创建的那条流式消息。 */
  patch(messageId: string, text: string): Promise<void>;
}

interface SessionRuntime {
  session: Session;
  detector: IdleDetector;
  renderer: TerminalRenderer;
  flushTimer: ReturnType<typeof setTimeout> | null;
  posting: boolean;        // 正在发/patch，避免并发重入
}

export class SessionManager {
  private runtimes = new Map<string, SessionRuntime>();

  constructor(private deps: SessionManagerDeps) {}

  has(threadId: string): boolean {
    return this.runtimes.has(threadId);
  }

  /** 建会话：spawn traex PTY，接好输出流 + idle 检测 + xterm 渲染。 */
  create(threadId: string, chatId: string, botId: string): Session {
    const spec = this.deps.cli.spawnSpec(this.deps.cwd);
    const p = pty.spawn(spec.command, spec.args, {
      name: 'xterm-256color',
      cols: PTY_COLS,
      rows: PTY_ROWS,
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
    const renderer = new TerminalRenderer(PTY_COLS, PTY_ROWS);
    const rt: SessionRuntime = {
      session, detector, renderer, flushTimer: null, posting: false,
    };
    this.runtimes.set(threadId, rt);

    // 一轮结束 → 最后回贴一次终态 → 回 idle → 处理队列下一条
    detector.onIdle((source) => {
      if (session.status !== 'busy') return;
      session.status = 'idle';
      logger.info(`一轮结束（${source}）thread=${threadId.slice(0, 10)}`);
      this.flushNow(rt);   // 收尾贴一次最终快照
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
    s.currentTurnText = next;
    // 新一轮：起一条全新的流式卡片，重置渲染器 hash
    s.cardMessageId = undefined;
    rt.renderer.markNewTurn();
    rt.detector.reset();          // 重新武装 idle 检测
    s.pty.write(next + '\r');
    logger.info(`→ traex thread=${s.threadId.slice(0, 10)}: ${next.slice(0, 40)}`);
  }

  private onData(rt: SessionRuntime, chunk: string): void {
    const s = rt.session;
    s.screenBuffer += chunk;      // idle 判定仍看累积流
    s.lastDataAt = Date.now();
    rt.renderer.write(chunk);     // 屏幕快照渲染
    rt.detector.feed(chunk);      // 驱动 idle 判定
    this.armFlush(rt);
  }

  /** 节流：到点回贴一次当前屏幕快照。 */
  private armFlush(rt: SessionRuntime): void {
    if (rt.flushTimer) return;
    rt.flushTimer = setTimeout(() => {
      rt.flushTimer = null;
      void this.flushNow(rt);
    }, FLUSH_INTERVAL_MS);
  }

  /** 立即回贴当前快照：内容变化才发；首帧 create，后续 patch。 */
  private async flushNow(rt: SessionRuntime): Promise<void> {
    if (rt.posting) return;                              // 避免并发重入
    const { content, changed } = rt.renderer.snapshot();
    if (!content || !changed) return;                    // 空或没变，不发
    rt.posting = true;
    const body = content.length > 3800 ? content.slice(-3800) : content;  // 飞书文本上限保护
    try {
      if (!rt.session.cardMessageId) {
        rt.session.cardMessageId = await this.deps.post(rt.session.threadId, body);
      } else {
        await this.deps.patch(rt.session.cardMessageId, body);
      }
    } catch (e: any) {
      logger.error(`回贴失败: ${e?.message ?? e}`);
    } finally {
      rt.posting = false;
    }
  }

  private teardown(threadId: string): void {
    const rt = this.runtimes.get(threadId);
    if (!rt) return;
    if (rt.flushTimer) { clearTimeout(rt.flushTimer); rt.flushTimer = null; }
    rt.detector.dispose();
    rt.renderer.dispose();
    rt.session.status = 'closed';
    this.runtimes.delete(threadId);
  }
}
