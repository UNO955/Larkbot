/**
 * 会话编排核心。
 *
 * ConversationManager 把一个飞书话题映射到一个长期 traex PTY：
 *   Session 是可持久化路由；Runtime 是内存里的进程、队列、终端快照和按钮状态。
 *
 * 关键约束：
 *   - 同一 Session 内消息必须按顺序串行投递，不能并发写 PTY。
 *   - 飞书卡片 patch 可能慢于 PTY 输出，flush 需要合并状态，避免旧的 working 覆盖 completed。
 *   - 工时统计以 turn 为单位写 workLogs，关闭/停止/失败都必须补 endedAt。
 */
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { CliAdapter, SessionTokenUsage } from '../adapters/cli/types.js';
import { IdleDetector } from '../utils/idle-detector.js';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { TerminalRenderer } from '../utils/terminal-renderer.js';
import { DONE_REACTION, RECEIVED_REACTION } from './reactions.js';
import type { SessionStore } from './store.js';
import type { EvidenceReference, KnowledgeObservation, KnowledgeReference, ExpiredSession, Session, SessionWorkLogStatus, Ticket, TicketStatus } from './types.js';

const FLUSH_INTERVAL_MS = 800;
const FIRST_PROMPT_FALLBACK_MS = 15_000;
const FINAL_MESSAGE_WAIT_MS = 1_500;
const FINAL_MESSAGE_POLL_MS = 150;
const INTERRUPT_SESSION_ID_WAIT_MS = 1_500;
const INTERRUPT_SESSION_ID_POLL_MS = 150;
const PTY_COLS = 100;
const PTY_ROWS = 30;

interface QueuedTurn {
  content: string;
  fallbackOpening: string;
  question?: string;
  questionMessageId?: string;
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
  // ready=false 表示 PTY 已拉起但还没看到可输入提示符；此时消息先进队列。
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
  turnStartedAtMs?: number;
  turnWorkLogId?: string;
  lastCardStatus?: CardStatus;
  turnFinalBaselineKey?: string;
  pendingFlushStatus?: CardStatus;
  firstPromptTimer: ReturnType<typeof setTimeout> | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  posting: boolean;
}

type CardStatus = 'working' | 'completed' | 'failed' | 'stopped';

export interface SessionCleanupResult {
  closed: number;
  deleted: number;
  closedSessions: Session[];
  deletedSessions: ExpiredSession[];
}

export interface ConversationManagerDeps {
  cli: CliAdapter;
  store: SessionStore;
  spawnPty?: (command: string, args: string[], options: Parameters<typeof pty.spawn>[2]) => IPty;
  post(threadId: string, text: string, status: CardStatus, replyAnchorMessageId?: string, replyToName?: string, replySignature?: string, replyToId?: string, argosSource?: string, knowledge?: KnowledgeObservation): Promise<string>;
  patch(messageId: string, text: string, status: CardStatus, replyToName?: string, replySignature?: string, replyToId?: string, argosSource?: string, knowledge?: KnowledgeObservation): Promise<void>;
  postTrace(threadId: string, traceUrl: string, interruptSessionId: string, status: CardStatus, replyAnchorMessageId?: string, footer?: string, knowledge?: KnowledgeObservation): Promise<string>;
  patchTrace(messageId: string, traceUrl: string, interruptSessionId: string, status: CardStatus, footer?: string, knowledge?: KnowledgeObservation): Promise<void>;
  notify(threadId: string, text: string, replyAnchorMessageId?: string): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  createTrace(input: { id: string; sessionId: string; title: string }): void;
  updateTrace(id: string, trace: string, status: CardStatus): void;
  traceUrl(id: string): string;
  redactTerminalInput?(sessionId: string, content: string): void;
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
    await this.backfillTickets(sessions);
    logger.info(`已恢复 ${sessions.filter((session) => session.status === 'active').length} 个会话路由`);
    return sessions;
  }

  find(chatId: string, rootMessageId: string, threadId?: string, relatedMessageId?: string): Session | undefined {
    // 飞书事件里不同入口会带 root/thread/被引用 message_id 的不同组合。
    // 这里集中做“同一话题”的归并，避免引用卡片、回复卡片时误开新会话。
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

  findClosed(chatId: string, rootMessageId: string, threadId?: string, relatedMessageId?: string): Session | undefined {
    return [...this.sessions.values()].find((session) =>
      session.status === 'closed'
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
    await this.ensureTicketForSession(session);
    await this.persist();
  }

  async touch(session: Session, callerOpenId: string): Promise<void> {
    session.lastCallerOpenId = callerOpenId;
    session.lastMessageAt = new Date().toISOString();
    await this.persist();
  }

  listSessions(): Array<Session & { runtimeStatus?: Runtime['status']; turnStartedAt?: string }> {
    return [...this.sessions.values()]
      .map((session) => {
        const runtime = this.runtimes.get(session.sessionId);
        return {
          ...session,
          runtimeStatus: runtime?.status,
          turnStartedAt: runtime?.status === 'busy' && runtime.turnStartedAtMs ? new Date(runtime.turnStartedAtMs).toISOString() : undefined,
        };
      })
      .sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt));
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  async closeSession(sessionId: string): Promise<Session | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.status = 'closed';
    session.closedAt = new Date().toISOString();
    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      runtime.intentionalClose = true;
      this.endWorkLog(runtime, 'stopped');
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
      this.endWorkLog(runtime, 'stopped');
    }
    await this.waitForPosting(runtime);
    await this.captureInterruptedCliSession(session);
    await this.patchTraceStopped(runtime);
    this.disposeRuntime(runtime);
    await this.persist();
    logger.info(`已停止本轮分析 session=${sessionId.slice(0, 8)}`);
    return session;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      runtime.intentionalClose = true;
      this.endWorkLog(runtime, 'stopped');
      try { runtime.pty.kill(); } catch { /* already exited */ }
      this.teardown(runtime);
    }
    this.sessions.delete(sessionId);
    await this.persist();
    await this.detachTicketSession(session);
    return true;
  }

  async cleanupStaleSessions(opts: {
    idleCloseMs: number;
    closedRetentionMs: number;
    now?: Date;
  }): Promise<SessionCleanupResult> {
    const now = opts.now ?? new Date();
    const nowMs = now.getTime();
    const deletedAt = now.toISOString();
    const closedSessions: Session[] = [];
    const deletedSessions: ExpiredSession[] = [];
    for (const session of [...this.sessions.values()]) {
      const idleMs = nowMs - sessionTimestamp(session);
      if (opts.closedRetentionMs > 0 && idleMs >= opts.closedRetentionMs) {
        const runtime = this.runtimes.get(session.sessionId);
        if (runtime) {
          if (runtime.status === 'busy' || runtime.draining) continue;
          runtime.intentionalClose = true;
          this.endWorkLog(runtime, 'stopped');
          try { runtime.pty.kill(); } catch { /* already exited */ }
          this.teardown(runtime);
          this.deps.closeTerminal?.(session.sessionId);
        }
        this.sessions.delete(session.sessionId);
        deletedSessions.push(toExpiredSession(session, deletedAt));
        await this.detachTicketSession(session);
        continue;
      }
      if (session.status === 'active' && opts.idleCloseMs > 0 && idleMs >= opts.idleCloseMs) {
        const runtime = this.runtimes.get(session.sessionId);
        if (runtime && (runtime.status === 'busy' || runtime.draining)) continue;
        session.status = 'closed';
        session.closedAt = deletedAt;
        if (runtime) {
          runtime.intentionalClose = true;
          this.endWorkLog(runtime, 'stopped');
          try { runtime.pty.kill(); } catch { /* already exited */ }
          this.teardown(runtime);
          this.deps.closeTerminal?.(session.sessionId);
        }
        closedSessions.push(structuredClone(session));
      }
    }
    if (closedSessions.length || deletedSessions.length) {
      await this.persist();
      if (deletedSessions.length) await this.persistExpiredSessions(deletedSessions, nowMs);
    }
    return {
      closed: closedSessions.length,
      deleted: deletedSessions.length,
      closedSessions,
      deletedSessions,
    };
  }

  async findExpired(chatId: string, rootMessageId: string, threadId?: string, relatedMessageId?: string): Promise<ExpiredSession | undefined> {
    if (!this.deps.store.loadExpiredSessions) return undefined;
    const sessions = await this.deps.store.loadExpiredSessions();
    return sessions.find((session) =>
      session.chatId === chatId
      && (session.rootMessageId === rootMessageId
        || (!!threadId && session.threadId === threadId)
        || (!!relatedMessageId && (
          session.anchorMessageId === relatedMessageId
          || session.traceCardMessageId === relatedMessageId
          || session.answerCardMessageId === relatedMessageId
        ))));
  }

  async submit(session: Session, opening: string, followUp: string, replyAnchorMessageId?: string, replyToName?: string, replySignature?: string, replyToId?: string, receivedReactionId?: string, question?: string): Promise<void> {
    await this.ensureTicketForSession(session);
    let runtime = this.runtimes.get(session.sessionId);
    if (!runtime) {
      const resume = await this.resolveResume(session);
      runtime = this.spawn(session, resume);
    }
    runtime.queue.push({
      // 恢复过原生 CLI 历史或本地已有历史时，只投递 followUp；新会话首轮才投递完整 opening 信封。
      content: runtime.resumeAttempt || session.hasHistory ? followUp : opening,
      fallbackOpening: opening,
      question,
      questionMessageId: replyAnchorMessageId,
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
    // Session 持久化里只保存 larkbot 维度路由；traex 原生 session id 可能来自旧 history。
    // 找不到时主动降级新上下文，并在话题里透明告知用户。
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
    const spec = this.deps.cli.spawnSpec(session.workingDir, { resumeSessionId, model: session.model });
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
      // 启动阶段先只喂 IdleDetector 找 readyPattern。ready 前不写用户输入，
      // 否则可能落进 folder trust / 欢迎页之类的非 composer 界面。
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
    runtime.turnStartedAtMs = Date.now();
    runtime.turnWorkLogId = this.beginWorkLog(runtime.route, runtime.turnStartedAtMs);
    runtime.lastCardStatus = undefined;
    runtime.turnFinalBaselineKey = runtime.route.cliSessionId
      ? this.deps.cli.getSessionFinal?.(runtime.route.cliSessionId)?.key
      : undefined;
    await this.updateTicketStatus(runtime.route, 'analyzing');
    // 记录本轮开始点，办公室工时统计和 trace footer 都依赖它。
    runtime.pendingFlushStatus = undefined;
    runtime.renderer.markNewTurn();
    runtime.detector.reset();
    try {
      if (!runtime.receivedReactionId) {
        runtime.receivedReactionId = await this.addReaction(runtime.currentReplyAnchorMessageId, RECEIVED_REACTION);
      }
      this.deps.redactTerminalInput?.(runtime.route.sessionId, turn.content);
      runtime.route.latestQuestion = turn.question;
      runtime.route.latestQuestionMessageId = turn.questionMessageId;
      const result = await this.deps.cli.writeInput(runtime.pty, turn.content);
      if (!result.submitted) throw new Error('traex 未确认接收输入');
      runtime.route.hasHistory = true;
      if (result.cliSessionId) runtime.route.cliSessionId = result.cliSessionId;
      await this.persist();
      logger.info(`→ traex session=${runtime.route.sessionId.slice(0, 8)}`);
    } catch (error: any) {
      this.endWorkLog(runtime, 'failed');
      await this.updateTicketStatus(runtime.route, 'failed');
      runtime.status = 'idle';
      await this.removeReceivedReaction(runtime);
      if (runtime.route.threadId) {
        await this.deps.notify(
          runtime.route.threadId,
          `消息投递失败：${error?.message ?? error}`,
          runtime.currentReplyAnchorMessageId,
        );
      }
      await this.persist();
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
    this.endWorkLog(runtime, 'completed');
    await this.updateTicketStatus(runtime.route, 'waiting_user');
    await this.persist();
    void this.drain(runtime);
  }

  private async onExit(runtime: Runtime, exitCode: number): Promise<void> {
    if (this.runtimes.get(runtime.route.sessionId) !== runtime) return;
    const recover = runtime.resumeAttempt && !runtime.ready && !runtime.intentionalClose;
    const queued = [...runtime.queue];
    if (!runtime.intentionalClose && runtime.ready && runtime.status === 'busy') {
      await this.flushNow(runtime, 'failed');
      await this.removeReceivedReaction(runtime);
      this.endWorkLog(runtime, 'failed');
      await this.updateTicketStatus(runtime.route, 'failed');
      await this.persist();
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
    // 只有“恢复旧 traex 会话失败且还没 ready”才自动重开新上下文。
    // 已经 ready 后退出属于真实运行失败，不能悄悄重跑，避免重复执行命令。
    if (runtime.route.threadId) {
      await this.deps.notify(runtime.route.threadId, 'traex 原生会话恢复失败，已降级为新上下文继续处理。');
    }
    const fresh = this.spawn(runtime.route);
    fresh.queue.push(...queued.map((turn) => ({
      content: turn.fallbackOpening,
      fallbackOpening: turn.fallbackOpening,
      question: turn.question,
      questionMessageId: turn.questionMessageId,
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
      // patch/post 还在飞书网络请求中时，只记录更强的目标状态。
      // 否则 completed 先到、working 后到，会把最终卡片回滚成处理中。
      runtime.pendingFlushStatus = strongerStatus(runtime.pendingFlushStatus, status);
      return;
    }
    const { answer, trace, changed } = runtime.renderer.snapshotParts();
    if (!answer && !trace && (!changed && runtime.lastCardStatus === status)) return;
    runtime.posting = true;
    const final = status === 'working' ? undefined : await this.waitForSessionFinal(runtime);
    const rawAnswer = final?.text || answer;
    // 参考资料只从完成后的完整 trace/final 中抽取，避免 working 过程里的半截证据污染最终卡。
    const knowledge = status === 'working' ? undefined : extractKnowledgeObservation(trace, rawAnswer);
    const answerCardKnowledge = knowledge?.references.length ? knowledge : undefined;
    const sourceAnswer = cleanAnswer(rawAnswer);
    const answerBody = sourceAnswer.length > 3800 ? sourceAnswer.slice(-3800) : sourceAnswer;
    const traceBody = trace.length > 20000 ? trace.slice(-20000) : trace;
    const argosSource = /https?:\/\/aiops-argos\.byted\.org\/agent_center\/s\/[A-Za-z0-9_-]+/.test(trace)
      ? `${sourceAnswer}\n${trace}`
      : undefined;
    const usage = runtime.route.cliSessionId ? this.deps.cli.getSessionUsage?.(runtime.route.cliSessionId) : undefined;
    const footer = status === 'working'
      ? undefined
      : traceFooter(usage, elapsedMs(runtime.turnStartedAtMs));
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
            knowledge,
          );
          runtime.route.traceCardMessageId = runtime.traceCardMessageId;
          await this.persist();
        } else {
          await this.deps.patchTrace(runtime.traceCardMessageId, runtime.traceUrl, runtime.interruptSessionId, status, footer, knowledge);
        }
      }
      if (status !== 'working') {
        runtime.route.latestAnswer = answerBody;
        runtime.route.latestKnowledge = knowledge;
        await this.persist();
      }
      if (status !== 'working' && answerBody) {
        if (!runtime.answerCardMessageId) {
          const postArgs: Parameters<ConversationManagerDeps['post']> = [
            runtime.route.threadId,
            answerBody,
            status,
            runtime.currentReplyAnchorMessageId,
            runtime.currentReplyToName,
            runtime.currentReplySignature,
            runtime.currentReplyToId,
          ];
          if (argosSource || answerCardKnowledge) postArgs.push(argosSource);
          if (answerCardKnowledge) postArgs.push(answerCardKnowledge);
          runtime.answerCardMessageId = await this.deps.post(...postArgs);
          runtime.route.answerCardMessageId = runtime.answerCardMessageId;
          await this.persist();
        } else {
          const patchArgs: Parameters<ConversationManagerDeps['patch']> = [
            runtime.answerCardMessageId,
            answerBody,
            status,
            runtime.currentReplyToName,
            runtime.currentReplySignature,
            runtime.currentReplyToId,
          ];
          if (argosSource || answerCardKnowledge) patchArgs.push(argosSource);
          if (answerCardKnowledge) patchArgs.push(answerCardKnowledge);
          await this.deps.patch(...patchArgs);
        }
        await this.persist();
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
      await this.deps.patchTrace(
        runtime.traceCardMessageId,
        runtime.traceUrl,
        runtime.interruptSessionId,
        'stopped',
        traceFooter(
          runtime.route.cliSessionId ? this.deps.cli.getSessionUsage?.(runtime.route.cliSessionId) : undefined,
          elapsedMs(runtime.turnStartedAtMs),
        ),
      );
      runtime.lastCardStatus = 'stopped';
    } catch (error: any) {
      logger.warn(`更新停止分析卡失败 session=${runtime.route.sessionId.slice(0, 8)}: ${error?.message ?? error}`);
    }
  }

  private async waitForPosting(runtime: Runtime): Promise<void> {
    const deadline = Date.now() + 1_500;
    while (runtime.posting && Date.now() < deadline) {
      await delay(50);
    }
  }

  private async captureInterruptedCliSession(session: Session): Promise<void> {
    if (session.cliSessionId) {
      session.hasHistory = true;
      return;
    }
    const deadline = Date.now() + INTERRUPT_SESSION_ID_WAIT_MS;
    do {
      const cliSessionId = this.deps.cli.findSessionId(session.sessionId);
      if (cliSessionId) {
        session.cliSessionId = cliSessionId;
        session.hasHistory = true;
        logger.info(`停止时捕获 traex session=${session.sessionId.slice(0, 8)} cli=${cliSessionId}`);
        return;
      }
      await delay(INTERRUPT_SESSION_ID_POLL_MS);
    } while (Date.now() < deadline);
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

  private beginWorkLog(session: Session, startedAtMs: number): string {
    const startedAt = new Date(startedAtMs).toISOString();
    const workLogs = session.workLogs ?? [];
    const id = `${session.sessionId}:${startedAtMs}:${workLogs.length + 1}`;
    session.workLogs = [...workLogs, { id, startedAt }];
    return id;
  }

  private endWorkLog(runtime: Runtime, status: SessionWorkLogStatus): void {
    // endWorkLog 允许重复调用。中断、PTY 退出、正常完成可能从不同路径抵达，
    // 第一次写 endedAt 后后续调用应成为 no-op。
    const id = runtime.turnWorkLogId;
    if (!id) return;
    const workLogs = runtime.route.workLogs;
    const log = workLogs?.find((item) => item.id === id);
    if (!log || log.endedAt) {
      runtime.turnWorkLogId = undefined;
      return;
    }
    const endedAtMs = Date.now();
    const startedAtMs = Date.parse(log.startedAt);
    log.endedAt = new Date(endedAtMs).toISOString();
    log.durationMs = Number.isFinite(startedAtMs) ? Math.max(0, endedAtMs - startedAtMs) : 0;
    log.status = status;
    runtime.turnWorkLogId = undefined;
  }

  private persist(): Promise<void> {
    return this.deps.store.saveSessions([...this.sessions.values()]);
  }

  private async backfillTickets(sessions: Session[]): Promise<void> {
    if (!this.deps.store.loadTickets || !this.deps.store.saveTickets) return;
    let changed = false;
    for (const session of sessions) {
      const before = session.ticketId;
      await this.ensureTicketForSession(session);
      if (session.ticketId !== before) changed = true;
    }
    if (changed) await this.persist();
  }

  private async ensureTicketForSession(session: Session): Promise<Ticket | undefined> {
    if (!this.deps.store.loadTickets || !this.deps.store.saveTickets) return undefined;
    const tickets = await this.deps.store.loadTickets();
    const now = new Date().toISOString();
    let ticket = session.ticketId ? tickets.find((item) => item.id === session.ticketId) : undefined;
    ticket ??= tickets.find((item) =>
      item.sessionIds.includes(session.sessionId)
      || (!!session.rootMessageId && item.rootMessageId === session.rootMessageId)
      || (!!session.threadId && item.threadId === session.threadId));
    if (!ticket) {
      ticket = createTicketFromSession(session, now);
      tickets.unshift(ticket);
    } else {
      ticket.updatedAt = now;
      ticket.title = ticket.title || session.title;
      ticket.ownerOpenId ??= session.ownerOpenId;
      ticket.createdByOpenId ??= session.createdByOpenId;
      ticket.createdByName ??= session.createdByName;
      ticket.chatId ??= session.chatId;
      ticket.chatName ??= session.chatName;
      ticket.rootMessageId ??= session.rootMessageId;
      ticket.threadId ??= session.threadId;
      ticket.currentSessionId = session.status === 'active' ? session.sessionId : ticket.currentSessionId;
      if (!ticket.sessionIds.includes(session.sessionId)) ticket.sessionIds.push(session.sessionId);
    }
    session.ticketId = ticket.id;
    await this.deps.store.saveTickets(sortTickets(tickets));
    return ticket;
  }

  private async updateTicketStatus(session: Session, status: TicketStatus): Promise<void> {
    if (!this.deps.store.loadTickets || !this.deps.store.saveTickets) return;
    const ticket = await this.ensureTicketForSession(session);
    if (!ticket) return;
    const tickets = await this.deps.store.loadTickets();
    const stored = tickets.find((item) => item.id === ticket.id);
    if (!stored) return;
    stored.status = status;
    stored.updatedAt = new Date().toISOString();
    if (status === 'closed') stored.closedAt = stored.updatedAt;
    await this.deps.store.saveTickets(sortTickets(tickets));
  }

  private async detachTicketSession(session: Session): Promise<void> {
    if (!session.ticketId || !this.deps.store.loadTickets || !this.deps.store.saveTickets) return;
    const tickets = await this.deps.store.loadTickets();
    const ticket = tickets.find((item) => item.id === session.ticketId);
    if (!ticket) return;
    if (ticket.currentSessionId === session.sessionId) ticket.currentSessionId = undefined;
    if (!ticket.sessionIds.includes(session.sessionId)) ticket.sessionIds.push(session.sessionId);
    ticket.updatedAt = new Date().toISOString();
    await this.deps.store.saveTickets(sortTickets(tickets));
  }

  private async persistExpiredSessions(deleted: ExpiredSession[], nowMs: number): Promise<void> {
    if (!this.deps.store.loadExpiredSessions || !this.deps.store.saveExpiredSessions) return;
    const cutoffMs = nowMs - 30 * 24 * 60 * 60 * 1000;
    const existing = await this.deps.store.loadExpiredSessions();
    const byId = new Map<string, ExpiredSession>();
    for (const session of existing) {
      if (Date.parse(session.deletedAt) >= cutoffMs) byId.set(session.sessionId, session);
    }
    for (const session of deleted) byId.set(session.sessionId, session);
    await this.deps.store.saveExpiredSessions([...byId.values()].sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt)));
  }
}

function createTicketFromSession(session: Session, now: string): Ticket {
  return {
    id: randomUUID(),
    source: session.chatId.startsWith('ou_') ? 'feishu_dm' : 'feishu_group',
    title: session.title || session.latestQuestion || '飞书工单',
    status: session.status === 'active' ? 'open' : 'closed',
    priority: 'normal',
    ownerOpenId: session.ownerOpenId,
    createdByOpenId: session.createdByOpenId,
    createdByName: session.createdByName,
    chatId: session.chatId,
    chatName: session.chatName,
    messageId: session.anchorMessageId,
    rootMessageId: session.rootMessageId,
    threadId: session.threadId,
    currentSessionId: session.status === 'active' ? session.sessionId : undefined,
    sessionIds: [session.sessionId],
    createdAt: session.createdAt || now,
    updatedAt: now,
    closedAt: session.closedAt,
  };
}

function sortTickets(tickets: Ticket[]): Ticket[] {
  return [...tickets].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function toExpiredSession(session: Session, deletedAt: string): ExpiredSession {
  return {
    sessionId: session.sessionId,
    ticketId: session.ticketId,
    chatId: session.chatId,
    chatName: session.chatName,
    rootMessageId: session.rootMessageId,
    threadId: session.threadId,
    anchorMessageId: session.anchorMessageId,
    traceCardMessageId: session.traceCardMessageId,
    answerCardMessageId: session.answerCardMessageId,
    title: session.title,
    createdByOpenId: session.createdByOpenId,
    createdByName: session.createdByName,
    lastCallerOpenId: session.lastCallerOpenId,
    lastMessageAt: session.lastMessageAt,
    createdAt: session.createdAt,
    closedAt: session.closedAt,
    workLogs: session.workLogs,
    deletedAt,
    reason: 'retention_expired',
  };
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

function traceFooter(usage: SessionTokenUsage | undefined, elapsed: number | undefined): string | undefined {
  const parts = [
    elapsed === undefined ? undefined : `⏱️ 总耗时：${formatDuration(elapsed)}`,
    sessionUsageFooter(usage),
  ].filter((part): part is string => !!part);
  return parts.length ? parts.join('\n') : undefined;
}

function sessionUsageFooter(usage: SessionTokenUsage | undefined): string | undefined {
  if (!usage) return undefined;
  const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreateTokens;
  const output = usage.outputTokens;
  if (input <= 0 && output <= 0) return undefined;
  const model = usage.model ? ` · ${usage.model}` : '';
  return `🪙 累计 Token ↑${formatTokenCount(input)} ↓${formatTokenCount(output)}${model}`;
}

function elapsedMs(startedAtMs: number | undefined): number | undefined {
  if (!startedAtMs) return undefined;
  return Math.max(0, Date.now() - startedAtMs);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${pad2(minutes)}分${pad2(seconds)}秒`;
  if (minutes > 0) return `${minutes}分${pad2(seconds)}秒`;
  return `${seconds}秒`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function cleanAnswer(answer: string): string {
  const text = stripLarkbotEvidence(answer).trim();
  // BOTMUX_* is kept only for older rollout history.
  if (text === 'LARKBOT_NOTHING_TO_SEND' || text === 'BOTMUX_NOTHING_TO_SEND') return '';
  return text;
}

function extractKnowledgeObservation(trace: string, answer: string): KnowledgeObservation {
  // 优先信任隐藏的 <larkbot_evidence> 结构化上报；文本扫描只作为兼容旧输出的兜底。
  const structured = extractStructuredEvidence(`${answer}\n${trace}`);
  const refs = uniqueKnowledgeReferences([
    ...structured.knowledgeReferences,
    ...extractKnowledgeReferences(trace, 'trace'),
    ...extractKnowledgeReferences(answer, 'answer'),
  ]);
  const codeReferences = uniqueEvidenceReferences(structured.codeReferences);
  const logReferences = uniqueEvidenceReferences(structured.logReferences);
  return {
    references: refs,
    codeReferences: codeReferences.length ? codeReferences : undefined,
    logReferences: logReferences.length ? logReferences : undefined,
    noReferenceReason: refs.length
      ? undefined
      : structured.seen
        ? '本轮结构化证据未上报知识库引用。'
        : '未在分析过程或最终回答中检测到知识库文件读取记录。',
    updatedAt: new Date().toISOString(),
  };
}

const LARKBOT_EVIDENCE_RE = /<larkbot_evidence\b[^>]*>([\s\S]*?)<\/larkbot_evidence>/gi;

function stripLarkbotEvidence(text: string): string {
  return text.replace(LARKBOT_EVIDENCE_RE, '').trim();
}

function extractStructuredEvidence(text: string): {
  seen: boolean;
  knowledgeReferences: KnowledgeReference[];
  codeReferences: EvidenceReference[];
  logReferences: EvidenceReference[];
} {
  const knowledgeReferences: KnowledgeReference[] = [];
  const codeReferences: EvidenceReference[] = [];
  const logReferences: EvidenceReference[] = [];
  let seen = false;
  for (const match of text.matchAll(LARKBOT_EVIDENCE_RE)) {
    seen = true;
    const payload = parseEvidencePayload(match[1]);
    if (!payload) continue;
    for (const ref of structuredValues(payload.knowledge_refs ?? payload.knowledgeRefs)) {
      const path = normalizeStructuredKnowledgeRef(ref);
      if (path) knowledgeReferences.push({ path, source: 'structured', evidence: '<larkbot_evidence>' });
    }
    for (const ref of structuredValues(payload.code_refs ?? payload.codeRefs)) {
      const value = normalizeStructuredEvidenceRef(ref, ['path', 'file', 'function', 'symbol', 'value', 'name']);
      if (value) codeReferences.push({ value, source: 'structured', evidence: '<larkbot_evidence>' });
    }
    for (const ref of structuredValues(payload.log_refs ?? payload.logRefs)) {
      const value = normalizeStructuredEvidenceRef(ref, ['log_id', 'logId', 'argos', 'url', 'psm', 'method', 'value', 'name']);
      if (value) logReferences.push({ value, source: 'structured', evidence: '<larkbot_evidence>' });
    }
  }
  return { seen, knowledgeReferences, codeReferences, logReferences };
}

function parseEvidencePayload(raw: string): Record<string, unknown> | undefined {
  const text = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  for (const candidate of [text, text.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function structuredValues(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20);
}

function normalizeStructuredKnowledgeRef(value: unknown): string | undefined {
  const ref = normalizeStructuredEvidenceRef(value, ['path', 'title', 'name', 'value', 'url']);
  if (!ref) return undefined;
  if (/(知识库|knowledge|kb|41-WORK-PROJECT-PUBLIC|one-page|playbook|\.md|docs\/|\/)/i.test(ref)) return ref;
  return `知识库《${ref}》`;
}

function normalizeStructuredEvidenceRef(value: unknown, keys: string[]): string | undefined {
  if (typeof value === 'string') return cleanStructuredRef(value);
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of keys) {
    const item = record[key];
    if (typeof item === 'string' && item.trim()) parts.push(item.trim());
  }
  if (!parts.length) return undefined;
  return cleanStructuredRef(parts.join(' '));
}

function cleanStructuredRef(value: string): string | undefined {
  const text = value.replace(/[),.;，。；、]+$/g, '').trim();
  if (!text || text.length < 2) return undefined;
  return text.slice(0, 300);
}

function extractKnowledgeReferences(text: string, source: KnowledgeReference['source']): KnowledgeReference[] {
  const refs: KnowledgeReference[] = [];
  const lines = text.split(/\r?\n/);
  const pathRe = /(?:\/data00\/home\/[^\s`'"]+|\/Users\/[^\s`'"]+|(?:docs|public|knowledge|kb|41-WORK-PROJECT-PUBLIC)\/[^\s`'"]+|[A-Za-z0-9_.-]*知识库[A-Za-z0-9_./-]*|[A-Za-z0-9_./-]+\.md)/g;
  const titleRe = /(?:项目页记录|public\s*(?:知识库|页)?|知识库|Playbook|playbook)[：:，,\s]*(?:《([^》]{2,80})》|“([^”]{2,80})”|"([^"]{2,80})")/gi;
  for (const line of lines) {
    if (!/(知识库|knowledge|kb|41-WORK-PROJECT-PUBLIC|one-page|playbook|项目页记录|public\s*页|\.md|docs\/)/i.test(line)) continue;
    for (const match of line.matchAll(pathRe)) {
      const path = cleanKnowledgePath(match[0]);
      if (!path) continue;
      refs.push({ path, source, evidence: line.trim().slice(0, 240) });
    }
    for (const match of line.matchAll(titleRe)) {
      const title = (match[1] || match[2] || match[3] || '').trim();
      if (!title) continue;
      refs.push({ path: `知识库《${title}》`, source, evidence: line.trim().slice(0, 240) });
    }
  }
  return refs.slice(0, 20);
}

function cleanKnowledgePath(value: string): string | undefined {
  const path = value.replace(/[),.;，。；、]+$/g, '').trim();
  if (!path || path.length < 4) return undefined;
  if (!/(知识库|knowledge|kb|41-WORK-PROJECT-PUBLIC|one-page|playbook|\.md|docs\/)/i.test(path)) return undefined;
  return path.slice(0, 300);
}

function uniqueKnowledgeReferences(refs: KnowledgeReference[]): KnowledgeReference[] {
  const seen = new Set<string>();
  const result: KnowledgeReference[] = [];
  for (const ref of refs) {
    const key = `${ref.source}:${ref.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result.slice(0, 12);
}

function uniqueEvidenceReferences(refs: EvidenceReference[]): EvidenceReference[] {
  const seen = new Set<string>();
  const result: EvidenceReference[] = [];
  for (const ref of refs) {
    const key = `${ref.source}:${ref.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result.slice(0, 12);
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
