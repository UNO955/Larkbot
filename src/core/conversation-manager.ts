import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { CliAdapter, SessionTokenUsage } from '../adapters/cli/types.js';
import { IdleDetector } from '../utils/idle-detector.js';
import { logger } from '../utils/logger.js';
import { TerminalRenderer } from '../utils/terminal-renderer.js';
import { DONE_REACTION, RECEIVED_REACTION } from './reactions.js';
import type { SessionStore } from './store.js';
import type { Session } from './types.js';

const FLUSH_INTERVAL_MS = 800;
const FIRST_PROMPT_FALLBACK_MS = 15_000;
const FINAL_MESSAGE_WAIT_MS = 1_500;
const FINAL_MESSAGE_POLL_MS = 150;
const PTY_COLS = 100;
const PTY_ROWS = 30;

interface QueuedTurn {
  content: string;
  fallbackOpening: string;
  replyAnchorMessageId?: string;
  receivedReactionId?: string;
  replyToId?: string;
  replySignature?: string;
  replyToName?: string;
}

interface Runtime {
  route: Session;
  pty: IPty;
  detector: IdleDetector;
  renderer: TerminalRenderer;
  queue: QueuedTurn[];
  status: 'idle' | 'busy';
  ready: boolean;
  resumeAttempt: boolean;
  draining: boolean;
  intentionalClose: boolean;
  answerCardMessageId?: string;
  traceCardMessageId?: string;
  traceTurnId?: string;
  traceUrl?: string;
  interruptSessionId?: string;
  streamingCardDisabled: boolean;
  currentReplyAnchorMessageId?: string;
  currentReplyToId?: string;
  currentReplySignature?: string;
  currentReplyToName?: string;
  receivedReactionId?: string;
  doneReactionSent: boolean;
  turnStopped: boolean;
  lastCardStatus?: CardStatus;
  turnFinalBaselineKey?: string;
  pendingFlushStatus?: CardStatus;
  firstPromptTimer: ReturnType<typeof setTimeout> | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  posting: boolean;
}

type CardStatus = 'working' | 'completed' | 'failed' | 'stopped';

export interface ConversationManagerDeps {
  cli: CliAdapter;
  store: SessionStore;
  spawnPty?: (command: string, args: string[], options: Parameters<typeof pty.spawn>[2]) => IPty;
  post(threadId: string, text: string, status: CardStatus, replyAnchorMessageId?: string, replyToName?: string, replySignature?: string, replyToId?: string): Promise<string>;
  patch(messageId: string, text: string, status: CardStatus, replyToName?: string, replySignature?: string, replyToId?: string): Promise<void>;
  postTrace(threadId: string, traceUrl: string, interruptSessionId: string, status: CardStatus, replyAnchorMessageId?: string, footer?: string): Promise<string>;
  patchTrace(messageId: string, traceUrl: string, interruptSessionId: string, status: CardStatus, footer?: string): Promise<void>;
  notify(threadId: string, text: string, replyAnchorMessageId?: string): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  createTrace(input: { id: string; sessionId: string; title: string }): void;
  updateTrace(id: string, trace: string, status: CardStatus): void;
  traceUrl(id: string): string;
  recordTerminalOutput?(sessionId: string, chunk: string): void;
  closeTerminal?(sessionId: string): void;
  isStreamingCardDisabled(): boolean;
}

export class ConversationManager {
  private sessions = new Map<string, Session>();
  private runtimes = new Map<string, Runtime>();

  constructor(private deps: ConversationManagerDeps) {}

  async restore(): Promise<Session[]> {
    const sessions = await this.deps.store.loadSessions();
    for (const session of sessions) this.sessions.set(session.sessionId, session);
    logger.info(`已恢复 ${sessions.filter((session) => session.status === 'active').length} 个会话路由`);
    return sessions;
  }

  find(chatId: string, rootMessageId: string, threadId?: string, relatedMessageId?: string): Session | undefined {
    return [...this.sessions.values()].find((session) =>
      session.status === 'active'
      && session.chatId === chatId
      && (session.rootMessageId === rootMessageId
        || (!!threadId && session.threadId === threadId)
        || (!!relatedMessageId && (
          session.anchorMessageId === relatedMessageId
          || session.initialCardMessageId === relatedMessageId
          || session.traceCardMessageId === relatedMessageId
          || session.answerCardMessageId === relatedMessageId
        ))));
  }

  async add(session: Session): Promise<void> {
    this.sessions.set(session.sessionId, session);
    await this.persist();
  }

  async touch(session: Session, callerOpenId: string): Promise<void> {
    session.lastCallerOpenId = callerOpenId;
    session.lastMessageAt = new Date().toISOString();
    await this.persist();
  }

  listSessions(): Session[] {
    return [...this.sessions.values()].sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt));
  }

  async closeSession(sessionId: string): Promise<Session | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.status = 'closed';
    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      runtime.intentionalClose = true;
      try { runtime.pty.kill(); } catch { /* already exited */ }
      this.teardown(runtime);
    }
    await this.persist();
    return session;
  }

  async interruptSession(sessionId: string): Promise<Session | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return session;
    runtime.queue = [];
    this.clearFirstPromptFallback(runtime);
    this.clearFlushTimer(runtime);
    runtime.pendingFlushStatus = undefined;
    runtime.turnStopped = true;
    const wasBusy = runtime.status === 'busy' || runtime.draining;
    runtime.status = 'idle';
    runtime.draining = false;
    runtime.detector.reset();
    if (wasBusy) {
      try { runtime.pty.write('\x03'); } catch { /* process may already be gone */ }
      await this.removeReceivedReaction(runtime);
    }
    await this.waitForPosting(runtime);
    await this.patchTraceStopped(runtime);
    this.disposeRuntime(runtime);
    await this.persist();
    logger.info(`已停止本轮思考 session=${sessionId.slice(0, 8)}`);
    return session;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      runtime.intentionalClose = true;
      try { runtime.pty.kill(); } catch { /* already exited */ }
      this.teardown(runtime);
    }
    this.sessions.delete(sessionId);
    await this.persist();
    return true;
  }

  async cleanupStaleSessions(opts: {
    idleCloseMs: number;
    closedRetentionMs: number;
    now?: Date;
  }): Promise<{ closed: number; deleted: number }> {
    const nowMs = opts.now?.getTime() ?? Date.now();
    let closed = 0;
    let deleted = 0;
    for (const session of [...this.sessions.values()]) {
      const idleMs = nowMs - sessionTimestamp(session);
      if (session.status === 'active' && opts.idleCloseMs > 0 && idleMs >= opts.idleCloseMs) {
        const runtime = this.runtimes.get(session.sessionId);
        if (runtime && (runtime.status === 'busy' || runtime.draining)) continue;
        session.status = 'closed';
        if (runtime) {
          runtime.intentionalClose = true;
          try { runtime.pty.kill(); } catch { /* already exited */ }
          this.teardown(runtime);
          this.deps.closeTerminal?.(session.sessionId);
        }
        closed += 1;
        continue;
      }
      if (session.status === 'closed' && opts.closedRetentionMs > 0 && idleMs >= opts.closedRetentionMs) {
        const runtime = this.runtimes.get(session.sessionId);
        if (runtime) {
          runtime.intentionalClose = true;
          try { runtime.pty.kill(); } catch { /* already exited */ }
          this.teardown(runtime);
          this.deps.closeTerminal?.(session.sessionId);
        }
        this.sessions.delete(session.sessionId);
        deleted += 1;
      }
    }
    if (closed || deleted) await this.persist();
    return { closed, deleted };
  }

  async submit(session: Session, opening: string, followUp: string, replyAnchorMessageId?: string, replyToName?: string, replySignature?: string, replyToId?: string, receivedReactionId?: string): Promise<void> {
    let runtime = this.runtimes.get(session.sessionId);
    if (!runtime) {
      const resume = await this.resolveResume(session);
      runtime = this.spawn(session, resume);
    }
    runtime.queue.push({
      content: runtime.resumeAttempt || session.hasHistory ? followUp : opening,
      fallbackOpening: opening,
      replyAnchorMessageId,
      receivedReactionId,
      replyToId,
      replySignature,
      replyToName,
    });
    if (!runtime.ready) this.armFirstPromptFallback(runtime);
    if (runtime.ready && runtime.status === 'idle') void this.drain(runtime);
  }

  shutdownAll(): void {
    for (const runtime of [...this.runtimes.values()]) {
      runtime.intentionalClose = true;
      try { runtime.pty.kill(); } catch { /* already exited */ }
      this.teardown(runtime);
    }
  }

  private async resolveResume(session: Session): Promise<string | undefined> {
    if (!session.hasHistory) return undefined;
    const cliSessionId = session.cliSessionId ?? this.deps.cli.findSessionId(session.sessionId);
    if (cliSessionId) {
      if (session.cliSessionId !== cliSessionId) {
        session.cliSessionId = cliSessionId;
        await this.persist();
      }
      return cliSessionId;
    }

    session.hasHistory = false;
    await this.persist();
    if (session.threadId) {
      await this.deps.notify(session.threadId, '旧的 traex 上下文无法恢复，本条消息将开启新上下文。');
    }
    return undefined;
  }

  private spawn(session: Session, resumeSessionId?: string): Runtime {
    if (!session.threadId) throw new Error(`会话 ${session.sessionId} 缺少 threadId`);
    const spec = this.deps.cli.spawnSpec(session.workingDir, { resumeSessionId });
    const child = (this.deps.spawnPty ?? pty.spawn)(spec.command, spec.args, {
      name: 'xterm-256color',
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: spec.cwd,
      env: spec.env ?? (process.env as Record<string, string>),
    });
    const runtime: Runtime = {
      route: session,
      pty: child,
      detector: new IdleDetector(this.deps.cli),
      renderer: new TerminalRenderer(PTY_COLS, PTY_ROWS),
      queue: [],
      status: 'idle',
      ready: false,
      resumeAttempt: !!resumeSessionId,
      draining: false,
      intentionalClose: false,
      streamingCardDisabled: false,
      doneReactionSent: false,
      turnStopped: false,
      flushTimer: null,
      firstPromptTimer: null,
      posting: false,
    };
    this.runtimes.set(session.sessionId, runtime);

    runtime.detector.onIdle((source) => {
      if (runtime.status !== 'busy') return;
      runtime.status = 'idle';
      logger.info(`一轮结束（${source}）session=${session.sessionId.slice(0, 8)}`);
      void this.finishTurn(runtime);
    });
    child.onData((chunk) => this.onData(runtime, chunk));
    child.onExit(({ exitCode }) => void this.onExit(runtime, exitCode));
    logger.info(`${resumeSessionId ? '恢复' : '创建'} traex session=${session.sessionId.slice(0, 8)} cli=${resumeSessionId ?? 'new'} pid=${child.pid}`);
    return runtime;
  }

  private onData(runtime: Runtime, chunk: string): void {
    this.deps.recordTerminalOutput?.(runtime.route.sessionId, chunk);
    runtime.renderer.write(chunk);
    if (!runtime.ready) {
      runtime.detector.feed(chunk);
      if (runtime.detector.ready) {
        runtime.ready = true;
        this.clearFirstPromptFallback(runtime);
        runtime.detector.reset();
        logger.info(`traex 已就绪 session=${runtime.route.sessionId.slice(0, 8)}`);
        void this.drain(runtime);
      }
      return;
    }
    runtime.detector.feed(chunk);
    if (runtime.status === 'busy') this.armFlush(runtime);
  }

  private async drain(runtime: Runtime): Promise<void> {
    if (runtime.draining || !runtime.ready || runtime.status !== 'idle') return;
    const turn = runtime.queue.shift();
    if (!turn) return;
    runtime.draining = true;
    runtime.status = 'busy';
    this.clearFirstPromptFallback(runtime);
    runtime.answerCardMessageId = undefined;
    runtime.traceCardMessageId = undefined;
    runtime.streamingCardDisabled = this.deps.isStreamingCardDisabled();
    if (!runtime.streamingCardDisabled && runtime.route.initialCardMessageId) {
      runtime.traceCardMessageId = runtime.route.initialCardMessageId;
      runtime.route.traceCardMessageId = runtime.traceCardMessageId;
      runtime.route.initialCardMessageId = undefined;
      await this.persist();
    }
    runtime.traceTurnId = runtime.route.sessionId;
    runtime.traceUrl = this.deps.traceUrl(runtime.route.sessionId);
    runtime.interruptSessionId = runtime.route.sessionId;
    runtime.currentReplyAnchorMessageId = turn.replyAnchorMessageId;
    runtime.currentReplyToId = turn.replyToId;
    runtime.currentReplySignature = turn.replySignature;
    runtime.currentReplyToName = turn.replyToName;
    runtime.receivedReactionId = turn.receivedReactionId;
    runtime.doneReactionSent = false;
    runtime.turnStopped = false;
    runtime.lastCardStatus = undefined;
    runtime.turnFinalBaselineKey = runtime.route.cliSessionId
      ? this.deps.cli.getSessionFinal?.(runtime.route.cliSessionId)?.key
      : undefined;
    runtime.pendingFlushStatus = undefined;
    runtime.renderer.markNewTurn();
    runtime.detector.reset();
    try {
      if (!runtime.receivedReactionId) {
        runtime.receivedReactionId = await this.addReaction(runtime.currentReplyAnchorMessageId, RECEIVED_REACTION);
      }
      const result = await this.deps.cli.writeInput(runtime.pty, turn.content);
      if (!result.submitted) throw new Error('traex 未确认接收输入');
      runtime.route.hasHistory = true;
      if (result.cliSessionId) runtime.route.cliSessionId = result.cliSessionId;
      await this.persist();
      logger.info(`→ traex session=${runtime.route.sessionId.slice(0, 8)}`);
    } catch (error: any) {
      runtime.status = 'idle';
      await this.removeReceivedReaction(runtime);
      if (runtime.route.threadId) {
        await this.deps.notify(
          runtime.route.threadId,
          `消息投递失败：${error?.message ?? error}`,
          runtime.currentReplyAnchorMessageId,
        );
      }
    } finally {
      runtime.draining = false;
      if (runtime.status === 'idle') void this.drain(runtime);
    }
  }

  private async finishTurn(runtime: Runtime): Promise<void> {
    if (runtime.turnStopped) {
      void this.drain(runtime);
      return;
    }
    await this.flushNow(runtime, 'completed');
    if (!runtime.doneReactionSent) {
      runtime.doneReactionSent = true;
      await this.removeReceivedReaction(runtime);
      await this.addReaction(runtime.currentReplyAnchorMessageId, DONE_REACTION);
    }
    void this.drain(runtime);
  }

  private async onExit(runtime: Runtime, exitCode: number): Promise<void> {
    if (this.runtimes.get(runtime.route.sessionId) !== runtime) return;
    const recover = runtime.resumeAttempt && !runtime.ready && !runtime.intentionalClose;
    const queued = [...runtime.queue];
    if (!runtime.intentionalClose && runtime.ready && runtime.status === 'busy') {
      await this.flushNow(runtime, 'failed');
      await this.removeReceivedReaction(runtime);
    }
    this.teardown(runtime);
    this.deps.closeTerminal?.(runtime.route.sessionId);
    logger.warn(`traex 退出 session=${runtime.route.sessionId.slice(0, 8)} code=${exitCode}`);
    if (!recover) {
      if (!runtime.intentionalClose && !runtime.ready && runtime.route.threadId) {
        await this.deps.notify(runtime.route.threadId, `traex 启动失败（退出码 ${exitCode}），消息未被处理。`);
      }
      return;
    }

    runtime.route.cliSessionId = undefined;
    runtime.route.hasHistory = false;
    await this.persist();
    if (runtime.route.threadId) {
      await this.deps.notify(runtime.route.threadId, 'traex 原生会话恢复失败，已降级为新上下文继续处理。');
    }
    const fresh = this.spawn(runtime.route);
    fresh.queue.push(...queued.map((turn) => ({
      content: turn.fallbackOpening,
      fallbackOpening: turn.fallbackOpening,
      replyAnchorMessageId: turn.replyAnchorMessageId,
      receivedReactionId: turn.receivedReactionId,
      replyToId: turn.replyToId,
      replySignature: turn.replySignature,
      replyToName: turn.replyToName,
    })));
  }

  private armFlush(runtime: Runtime): void {
    if (runtime.turnStopped) return;
    if (runtime.flushTimer) return;
    runtime.flushTimer = setTimeout(() => {
      runtime.flushTimer = null;
      void this.flushNow(runtime, 'working');
    }, FLUSH_INTERVAL_MS);
  }

  private armFirstPromptFallback(runtime: Runtime): void {
    if (runtime.ready || runtime.firstPromptTimer) return;
    runtime.firstPromptTimer = setTimeout(() => {
      runtime.firstPromptTimer = null;
      if (runtime.ready || runtime.status !== 'idle' || runtime.queue.length === 0) return;
      runtime.ready = true;
      runtime.detector.reset();
      logger.warn(`traex readyPattern 超时，强制投递首条消息 session=${runtime.route.sessionId.slice(0, 8)}`);
      void this.drain(runtime);
    }, FIRST_PROMPT_FALLBACK_MS);
    runtime.firstPromptTimer.unref?.();
  }

  private clearFirstPromptFallback(runtime: Runtime): void {
    if (!runtime.firstPromptTimer) return;
    clearTimeout(runtime.firstPromptTimer);
    runtime.firstPromptTimer = null;
  }

  private clearFlushTimer(runtime: Runtime): void {
    if (!runtime.flushTimer) return;
    clearTimeout(runtime.flushTimer);
    runtime.flushTimer = null;
  }

  private async flushNow(runtime: Runtime, status: CardStatus): Promise<void> {
    if (!runtime.route.threadId) return;
    if (runtime.turnStopped) return;
    if (runtime.posting) {
      runtime.pendingFlushStatus = strongerStatus(runtime.pendingFlushStatus, status);
      return;
    }
    const { answer, trace, changed } = runtime.renderer.snapshotParts();
    if (!answer && !trace && (!changed && runtime.lastCardStatus === status)) return;
    runtime.posting = true;
    const final = status === 'working' ? undefined : await this.waitForSessionFinal(runtime);
    const sourceAnswer = cleanAnswer(final?.text || answer);
    const answerBody = sourceAnswer.length > 3800 ? sourceAnswer.slice(-3800) : sourceAnswer;
    const traceBody = trace.length > 20000 ? trace.slice(-20000) : trace;
    const usage = runtime.route.cliSessionId ? this.deps.cli.getSessionUsage?.(runtime.route.cliSessionId) : undefined;
    const footer = status === 'working' ? undefined : sessionUsageFooter(usage);
    try {
      if (runtime.turnStopped) return;
      if (!runtime.streamingCardDisabled && runtime.traceUrl && runtime.interruptSessionId && (runtime.traceCardMessageId || traceBody || status === 'working' || !!footer)) {
        if (!runtime.traceCardMessageId) {
          runtime.traceCardMessageId = await this.deps.postTrace(
            runtime.route.threadId,
            runtime.traceUrl,
            runtime.interruptSessionId,
            status,
            runtime.currentReplyAnchorMessageId,
            footer,
          );
          runtime.route.traceCardMessageId = runtime.traceCardMessageId;
          await this.persist();
        } else {
          await this.deps.patchTrace(runtime.traceCardMessageId, runtime.traceUrl, runtime.interruptSessionId, status, footer);
        }
      }
      if (status !== 'working' && answerBody) {
        if (!runtime.answerCardMessageId) {
          runtime.answerCardMessageId = await this.deps.post(
            runtime.route.threadId,
            answerBody,
            status,
            runtime.currentReplyAnchorMessageId,
            runtime.currentReplyToName,
            runtime.currentReplySignature,
            runtime.currentReplyToId,
          );
          runtime.route.answerCardMessageId = runtime.answerCardMessageId;
          await this.persist();
        } else {
          await this.deps.patch(runtime.answerCardMessageId, answerBody, status, runtime.currentReplyToName, runtime.currentReplySignature, runtime.currentReplyToId);
        }
      }
      runtime.lastCardStatus = status;
    } catch (error: any) {
      logger.error(`回贴失败: ${error?.message ?? error}`);
    } finally {
      runtime.posting = false;
      const pending = runtime.pendingFlushStatus;
      runtime.pendingFlushStatus = undefined;
      if (pending && !runtime.turnStopped) void this.flushNow(runtime, pending);
    }
  }

  private async addReaction(messageId: string | undefined, emojiType: string): Promise<string | undefined> {
    if (!messageId) return undefined;
    try {
      return await this.deps.addReaction(messageId, emojiType);
    } catch (error: any) {
      logger.warn(`加表情失败 message=${messageId.slice(0, 12)} emoji=${emojiType}: ${error?.message ?? error}`);
      return undefined;
    }
  }

  private async removeReceivedReaction(runtime: Runtime): Promise<void> {
    const messageId = runtime.currentReplyAnchorMessageId;
    const reactionId = runtime.receivedReactionId;
    if (!messageId || !reactionId) return;
    runtime.receivedReactionId = undefined;
    try {
      await this.deps.removeReaction(messageId, reactionId);
    } catch (error: any) {
      logger.warn(`删 Get 表情失败 message=${messageId.slice(0, 12)} reaction=${reactionId}: ${error?.message ?? error}`);
    }
  }

  private async patchTraceStopped(runtime: Runtime): Promise<void> {
    if (runtime.streamingCardDisabled || !runtime.traceUrl || !runtime.interruptSessionId || !runtime.traceCardMessageId) return;
    try {
      await this.deps.patchTrace(runtime.traceCardMessageId, runtime.traceUrl, runtime.interruptSessionId, 'stopped');
      runtime.lastCardStatus = 'stopped';
    } catch (error: any) {
      logger.warn(`更新停止思考卡失败 session=${runtime.route.sessionId.slice(0, 8)}: ${error?.message ?? error}`);
    }
  }

  private async waitForPosting(runtime: Runtime): Promise<void> {
    const deadline = Date.now() + 1_500;
    while (runtime.posting && Date.now() < deadline) {
      await delay(50);
    }
  }

  private async waitForSessionFinal(runtime: Runtime): Promise<{ key: string; text: string } | undefined> {
    const cliSessionId = runtime.route.cliSessionId;
    if (!cliSessionId || !this.deps.cli.getSessionFinal) return undefined;
    const deadline = Date.now() + FINAL_MESSAGE_WAIT_MS;
    do {
      const final = this.deps.cli.getSessionFinal(cliSessionId);
      if (final && final.key !== runtime.turnFinalBaselineKey) return final;
      await delay(FINAL_MESSAGE_POLL_MS);
    } while (Date.now() < deadline);
    return undefined;
  }

  private teardown(runtime: Runtime): void {
    this.clearFlushTimer(runtime);
    this.clearFirstPromptFallback(runtime);
    runtime.detector.dispose();
    runtime.renderer.dispose();
    this.runtimes.delete(runtime.route.sessionId);
  }

  private disposeRuntime(runtime: Runtime): void {
    if (this.runtimes.get(runtime.route.sessionId) !== runtime) return;
    runtime.intentionalClose = true;
    try { runtime.pty.kill(); } catch { /* already exited */ }
    this.teardown(runtime);
    this.deps.closeTerminal?.(runtime.route.sessionId);
  }

  private persist(): Promise<void> {
    return this.deps.store.saveSessions([...this.sessions.values()]);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function strongerStatus(current: CardStatus | undefined, next: CardStatus): CardStatus {
  const rank: Record<CardStatus, number> = { working: 0, completed: 1, stopped: 2, failed: 3 };
  return !current || rank[next] > rank[current] ? next : current;
}

function sessionTimestamp(session: Session): number {
  const parsed = Date.parse(session.lastMessageAt || session.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sessionUsageFooter(usage: SessionTokenUsage | undefined): string | undefined {
  if (!usage) return undefined;
  const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreateTokens;
  const output = usage.outputTokens;
  if (input <= 0 && output <= 0) return undefined;
  const model = usage.model ? ` · ${usage.model}` : '';
  return `🪙 累计 Token ↑${formatTokenCount(input)} ↓${formatTokenCount(output)}${model}`;
}

function cleanAnswer(answer: string): string {
  const text = answer.trim();
  if (text === 'BOTMUX_NOTHING_TO_SEND') return '';
  return text;
}

function formatTokenCount(value: number): string {
  const n = Math.max(0, Math.round(value));
  if (n >= 1_000_000) return `${trimNumber(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trimNumber(n / 1_000)}K`;
  return String(n);
}

function trimNumber(value: number): string {
  return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, '');
}
