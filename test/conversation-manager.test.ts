import { describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import type { CliAdapter, SpawnOptions } from '../src/adapters/cli/types.js';
import { ConversationManager } from '../src/core/conversation-manager.js';
import type { SessionStore } from '../src/core/store.js';
import type { Session } from '../src/core/types.js';

function route(over: Partial<Session> = {}): Session {
  return {
    sessionId: 'lm-1',
    chatId: 'oc-1',
    rootMessageId: 'om-1',
    threadId: 'omt-1',
    anchorMessageId: 'om-anchor',
    scope: 'thread',
    title: 'test',
    status: 'active',
    workingDir: '/repo',
    cliId: 'traex',
    cliSessionId: 'trae-1',
    hasHistory: true,
    lastMessageAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function fakePty(): IPty & { emitData(data: string): void; emitExit(exitCode: number): void } {
  let dataHandler: (data: string) => void = () => undefined;
  let exitHandler: (event: { exitCode: number; signal?: number }) => void = () => undefined;
  return {
    pid: 42,
    cols: 100,
    rows: 30,
    process: 'traex',
    handleFlowControl: false,
    onData(handler) {
      dataHandler = handler;
      return { dispose: () => undefined };
    },
    onExit(handler) {
      exitHandler = handler;
      return { dispose: () => undefined };
    },
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    kill: vi.fn(() => exitHandler({ exitCode: 0 })),
    pause: vi.fn(),
    resume: vi.fn(),
    emitData(data: string) {
      dataHandler(data);
    },
    emitExit(exitCode: number) {
      exitHandler({ exitCode });
    },
  } as unknown as IPty & { emitData(data: string): void; emitExit(exitCode: number): void };
}

describe('ConversationManager', () => {
  it('恢复时只加载路由，下一条消息才 lazy resume', async () => {
    const session = route();
    let saved: Session[] = [];
    const store: SessionStore = {
      loadBots: async () => [],
      saveBots: async () => undefined,
      loadSessions: async () => [session],
      saveSessions: async (sessions) => { saved = structuredClone(sessions); },
    };
    const spawnSpec = vi.fn((_cwd: string, options?: SpawnOptions) => ({
      command: 'traex',
      args: options?.resumeSessionId ? ['resume', options.resumeSessionId] : [],
      cwd: '/repo',
    }));
    const writeInput = vi.fn(async () => ({ submitted: true, cliSessionId: 'trae-1' }));
    const cli: CliAdapter = {
      id: 'traex',
      spawnSpec,
      writeInput,
      findSessionId: () => undefined,
      readyPattern: /❯/,
    };
    const child = fakePty();
    const manager = new ConversationManager({
      cli,
      store,
      spawnPty: () => child,
      post: async () => 'card-1',
      patch: async () => undefined,
      postTrace: async () => 'trace-card-1',
      patchTrace: async () => undefined,
      notify: async () => undefined,
      addReaction: async () => 'reaction-1',
      removeReaction: async () => undefined,
      createTrace: () => undefined,
      updateTrace: () => undefined,
      traceUrl: (id) => `http://console/trace/${id}`,
      isStreamingCardDisabled: () => false,
    });

    await manager.restore();
    expect(spawnSpec).not.toHaveBeenCalled();

    await manager.submit(session, 'OPENING', 'FOLLOW_UP');
    expect(spawnSpec).toHaveBeenCalledWith('/repo', { resumeSessionId: 'trae-1', model: undefined });
    expect(writeInput).not.toHaveBeenCalled();

    child.emitData('❯ ');
    await vi.waitFor(() => expect(writeInput).toHaveBeenCalledWith(child, 'FOLLOW_UP'));
    expect(saved[0].cliSessionId).toBe('trae-1');
    manager.shutdownAll();
  });

  it('创建 traex 进程时透传 session 模型', async () => {
    const session = route({ hasHistory: false, cliSessionId: undefined, model: 'gpt-5.5' });
    const store: SessionStore = {
      loadBots: async () => [],
      saveBots: async () => undefined,
      loadSessions: async () => [],
      saveSessions: async () => undefined,
    };
    const spawnSpec = vi.fn(() => ({ command: 'traex', args: [], cwd: '/repo' }));
    const cli: CliAdapter = {
      id: 'traex',
      spawnSpec,
      writeInput: vi.fn(async () => ({ submitted: true, cliSessionId: 'trae-new' })),
      findSessionId: () => undefined,
      readyPattern: /❯/,
    };
    const child = fakePty();
    const manager = new ConversationManager({
      cli,
      store,
      spawnPty: () => child,
      post: async () => 'card-1',
      patch: async () => undefined,
      postTrace: async () => 'trace-card-1',
      patchTrace: async () => undefined,
      notify: async () => undefined,
      addReaction: async () => 'reaction-1',
      removeReaction: async () => undefined,
      createTrace: () => undefined,
      updateTrace: () => undefined,
      traceUrl: (id) => `http://console/trace/${id}`,
      isStreamingCardDisabled: () => false,
    });

    await manager.add(session);
    await manager.submit(session, 'OPENING', 'FOLLOW_UP');

    expect(spawnSpec).toHaveBeenCalledWith('/repo', { resumeSessionId: undefined, model: 'gpt-5.5' });
    manager.shutdownAll();
  });

  it('能通过分析卡或回复卡 message_id 反查会话', async () => {
    const session = route({
      traceCardMessageId: 'om-trace-card',
      answerCardMessageId: 'om-answer-card',
    });
    const store: SessionStore = {
      loadBots: async () => [],
      saveBots: async () => undefined,
      loadSessions: async () => [],
      saveSessions: async () => undefined,
    };
    const manager = new ConversationManager({
      cli: {
        id: 'traex',
        spawnSpec: () => ({ command: 'traex', args: [], cwd: '/repo' }),
        writeInput: vi.fn(async () => ({ submitted: true })),
        findSessionId: () => undefined,
        readyPattern: /❯/,
      },
      store,
      post: async () => 'card-1',
      patch: async () => undefined,
      postTrace: async () => 'trace-card-1',
      patchTrace: async () => undefined,
      notify: async () => undefined,
      createTrace: () => undefined,
      traceUrl: (id) => `http://console/trace/${id}`,
      isStreamingCardDisabled: () => false,
    });

    await manager.add(session);
    expect(manager.find('oc-1', 'om-other-root', undefined, 'om-trace-card')?.sessionId).toBe('lm-1');
    expect(manager.find('oc-1', 'om-other-root', undefined, 'om-answer-card')?.sessionId).toBe('lm-1');
  });

  it('定期清理会关闭闲置会话并删除过期关闭记录', async () => {
    const activeOld = route({
      sessionId: 'lm-active-old',
      lastMessageAt: '2026-01-01T00:00:00.000Z',
      status: 'active',
    });
    const activeFresh = route({
      sessionId: 'lm-active-fresh',
      lastMessageAt: '2026-01-02T00:00:00.000Z',
      status: 'active',
    });
    const closedOld = route({
      sessionId: 'lm-closed-old',
      lastMessageAt: '2025-12-20T00:00:00.000Z',
      status: 'closed',
    });
    let saved: Session[] = [];
    let expired: any[] = [];
    const store: SessionStore = {
      loadBots: async () => [],
      saveBots: async () => undefined,
      loadSessions: async () => [activeOld, activeFresh, closedOld],
      saveSessions: async (sessions) => { saved = structuredClone(sessions); },
      loadExpiredSessions: async () => expired,
      saveExpiredSessions: async (sessions) => { expired = structuredClone(sessions); },
    };
    const cli: CliAdapter = {
      id: 'traex',
      spawnSpec: () => ({ command: 'traex', args: [], cwd: '/repo' }),
      writeInput: vi.fn(async () => ({ submitted: true })),
      findSessionId: () => undefined,
      readyPattern: /❯/,
    };
    const manager = new ConversationManager({
      cli,
      store,
      post: async () => 'card-1',
      patch: async () => undefined,
      postTrace: async () => 'trace-card-1',
      patchTrace: async () => undefined,
      notify: async () => undefined,
      addReaction: async () => 'reaction-1',
      removeReaction: async () => undefined,
      createTrace: () => undefined,
      updateTrace: () => undefined,
      traceUrl: (id) => `http://console/trace/${id}`,
      isStreamingCardDisabled: () => false,
    });

    await manager.restore();
    const result = await manager.cleanupStaleSessions({
      idleCloseMs: 12 * 60 * 60 * 1000,
      closedRetentionMs: 7 * 24 * 60 * 60 * 1000,
      now: new Date('2026-01-02T00:00:00.000Z'),
    });

    expect(result.closed).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.closedSessions.map((session) => session.sessionId)).toEqual(['lm-active-old']);
    expect(result.deletedSessions.map((session) => session.sessionId)).toEqual(['lm-closed-old']);
    expect(saved.map((session) => [session.sessionId, session.status])).toEqual([
      ['lm-active-old', 'closed'],
      ['lm-active-fresh', 'active'],
    ]);
    expect(saved[0].closedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ sessionId: 'lm-closed-old', reason: 'retention_expired' });
  });

  it('resume 在 composer 前失败时提示并用 opening 降级为新会话', async () => {
    const session = route();
    const store: SessionStore = {
      loadBots: async () => [],
      saveBots: async () => undefined,
      loadSessions: async () => [session],
      saveSessions: async () => undefined,
    };
    const spawnSpec = vi.fn((_cwd: string, options?: SpawnOptions) => ({
      command: 'traex',
      args: options?.resumeSessionId ? ['resume', options.resumeSessionId] : [],
      cwd: '/repo',
    }));
    const writeInput = vi.fn(async () => ({ submitted: true, cliSessionId: 'trae-new' }));
    const cli: CliAdapter = {
      id: 'traex',
      spawnSpec,
      writeInput,
      findSessionId: () => undefined,
      readyPattern: /❯/,
    };
    const resumed = fakePty();
    const fresh = fakePty();
    const processes = [resumed, fresh];
    const notify = vi.fn(async () => undefined);
    const manager = new ConversationManager({
      cli,
      store,
      spawnPty: () => processes.shift()!,
      post: async () => 'card-1',
      patch: async () => undefined,
      postTrace: async () => 'trace-card-1',
      patchTrace: async () => undefined,
      notify,
      addReaction: async () => 'reaction-1',
      removeReaction: async () => undefined,
      createTrace: () => undefined,
      updateTrace: () => undefined,
      traceUrl: (id) => `http://console/trace/${id}`,
      isStreamingCardDisabled: () => false,
    });
    await manager.restore();
    await manager.submit(session, 'OPENING', 'FOLLOW_UP');

    resumed.emitExit(1);
    await vi.waitFor(() => expect(spawnSpec).toHaveBeenCalledTimes(2));
    expect(spawnSpec.mock.calls[1][1]).toEqual({ resumeSessionId: undefined, model: undefined });
    expect(notify).toHaveBeenCalledWith('omt-1', expect.stringContaining('恢复失败'));

    fresh.emitData('❯ ');
    await vi.waitFor(() => expect(writeInput).toHaveBeenCalledWith(fresh, 'OPENING'));
    expect(session.cliSessionId).toBe('trae-new');
    manager.shutdownAll();
  });

  it('每轮失败通知绑定到当前用户消息', async () => {
    const session = route({ hasHistory: false, cliSessionId: undefined });
    const store: SessionStore = {
      loadBots: async () => [],
      saveBots: async () => undefined,
      loadSessions: async () => [],
      saveSessions: async () => undefined,
    };
    const cli: CliAdapter = {
      id: 'traex',
      spawnSpec: () => ({ command: 'traex', args: [], cwd: '/repo' }),
      writeInput: vi.fn(async () => ({ submitted: false })),
      findSessionId: () => undefined,
      readyPattern: /❯/,
    };
    const child = fakePty();
    const notify = vi.fn(async () => undefined);
    const manager = new ConversationManager({
      cli,
      store,
      spawnPty: () => child,
      post: async () => 'card-1',
      patch: async () => undefined,
      postTrace: async () => 'trace-card-1',
      patchTrace: async () => undefined,
      notify,
      addReaction: async () => 'reaction-1',
      removeReaction: async () => undefined,
      createTrace: () => undefined,
      updateTrace: () => undefined,
      traceUrl: (id) => `http://console/trace/${id}`,
      isStreamingCardDisabled: () => false,
    });

    await manager.add(session);
    await manager.submit(session, 'OPENING', 'FOLLOW_UP', 'om-current-user');
    child.emitData('❯ ');

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        'omt-1',
        expect.stringContaining('消息投递失败'),
        'om-current-user',
      );
    });
    manager.shutdownAll();
  });

  it('每轮开始加 Get，完成时删 Get 再加 DONE', async () => {
    const session = route({ hasHistory: false, cliSessionId: undefined });
    let saved: Session[] = [];
    const store: SessionStore = {
      loadBots: async () => [],
      saveBots: async () => undefined,
      loadSessions: async () => [],
      saveSessions: async (sessions) => { saved = structuredClone(sessions); },
    };
    const cli: CliAdapter = {
      id: 'traex',
      spawnSpec: () => ({ command: 'traex', args: [], cwd: '/repo' }),
      writeInput: vi.fn(async () => ({ submitted: true, cliSessionId: 'trae-new' })),
      findSessionId: () => undefined,
      readyPattern: /❯/,
      completionPattern: /TURN_DONE/,
    };
    const child = fakePty();
    const addReaction = vi.fn(async () => 'reaction-1');
    const removeReaction = vi.fn(async () => undefined);
    const manager = new ConversationManager({
      cli,
      store,
      spawnPty: () => child,
      post: async () => 'card-1',
      patch: async () => undefined,
      postTrace: async () => 'trace-card-1',
      patchTrace: async () => undefined,
      notify: async () => undefined,
      addReaction,
      removeReaction,
      createTrace: () => undefined,
      updateTrace: () => undefined,
      traceUrl: (id) => `http://console/trace/${id}`,
      isStreamingCardDisabled: () => false,
    });

    await manager.add(session);
    await manager.submit(session, 'OPENING', 'FOLLOW_UP', 'om-current-user');
    child.emitData('❯ ');
    await vi.waitFor(() => expect(addReaction).toHaveBeenCalledWith('om-current-user', 'Get'));

    child.emitData('TURN_DONE');
    await vi.waitFor(() => expect(removeReaction).toHaveBeenCalledWith('om-current-user', 'reaction-1'), { timeout: 1500 });
    await vi.waitFor(() => expect(addReaction).toHaveBeenCalledWith('om-current-user', 'DONE'), { timeout: 1500 });
    expect(removeReaction.mock.invocationCallOrder[0]).toBeLessThan(addReaction.mock.invocationCallOrder[1]);
    expect(saved.at(-1)?.workLogs).toHaveLength(1);
    expect(saved.at(-1)?.workLogs?.[0]).toMatchObject({ status: 'completed' });
    expect(saved.at(-1)?.workLogs?.[0].endedAt).toBeTruthy();
    expect(saved.at(-1)?.workLogs?.[0].durationMs).toEqual(expect.any(Number));
    manager.shutdownAll();
  });

  it('首轮已预加 Get 时不重复添加，完成时清理该表情', async () => {
    const session = route({ hasHistory: false, cliSessionId: undefined });
    const store: SessionStore = {
      loadBots: async () => [],
      saveBots: async () => undefined,
      loadSessions: async () => [],
      saveSessions: async () => undefined,
    };
    const cli: CliAdapter = {
      id: 'traex',
      spawnSpec: () => ({ command: 'traex', args: [], cwd: '/repo' }),
      writeInput: vi.fn(async () => ({ submitted: true, cliSessionId: 'trae-new' })),
      findSessionId: () => undefined,
      readyPattern: /❯/,
      completionPattern: /TURN_DONE/,
    };
    const child = fakePty();
    const addReaction = vi.fn(async () => 'reaction-late');
    const removeReaction = vi.fn(async () => undefined);
    const manager = new ConversationManager({
      cli,
      store,
      spawnPty: () => child,
      post: async () => 'card-1',
      patch: async () => undefined,
      postTrace: async () => 'trace-card-1',
      patchTrace: async () => undefined,
      notify: async () => undefined,
      addReaction,
      removeReaction,
      createTrace: () => undefined,
      updateTrace: () => undefined,
      traceUrl: (id) => `http://console/trace/${id}`,
      isStreamingCardDisabled: () => false,
    });

    await manager.add(session);
    await manager.submit(session, 'OPENING', 'FOLLOW_UP', 'om-current-user', undefined, undefined, undefined, 'reaction-pre');
    child.emitData('❯ ');
    await vi.waitFor(() => expect(cli.writeInput).toHaveBeenCalled());
    expect(addReaction).not.toHaveBeenCalledWith('om-current-user', 'Get');

    child.emitData('TURN_DONE');
    await vi.waitFor(() => expect(removeReaction).toHaveBeenCalledWith('om-current-user', 'reaction-pre'), { timeout: 1500 });
    await vi.waitFor(() => expect(addReaction).toHaveBeenCalledWith('om-current-user', 'DONE'), { timeout: 1500 });
    manager.shutdownAll();
  });

  it('停止分析只中断当前轮并更新分析卡，不关闭会话', async () => {
    const session = route({ hasHistory: false, cliSessionId: undefined, initialCardMessageId: 'trace-card-1' });
    let saved: Session[] = [];
    const store: SessionStore = {
      loadBots: async () => [],
      saveBots: async () => undefined,
      loadSessions: async () => [],
      saveSessions: async (sessions) => { saved = structuredClone(sessions); },
    };
    const spawnSpec = vi.fn(() => ({ command: 'traex', args: [], cwd: '/repo' }));
    const cli: CliAdapter = {
      id: 'traex',
      spawnSpec,
      writeInput: vi.fn(async () => ({ submitted: true, cliSessionId: 'trae-new' })),
      findSessionId: () => undefined,
      readyPattern: /❯/,
    };
    const child = fakePty();
    const fresh = fakePty();
    const children = [child, fresh];
    const removeReaction = vi.fn(async () => undefined);
    const patchTrace = vi.fn(async () => undefined);
    const manager = new ConversationManager({
      cli,
      store,
      spawnPty: () => children.shift() ?? fakePty(),
      post: async () => 'card-1',
      patch: async () => undefined,
      postTrace: async () => 'trace-card-1',
      patchTrace,
      notify: async () => undefined,
      addReaction: async () => 'reaction-1',
      removeReaction,
      createTrace: () => undefined,
      updateTrace: () => undefined,
      traceUrl: (id) => `http://console/trace/${id}`,
      isStreamingCardDisabled: () => false,
    });

    await manager.add(session);
    await manager.submit(session, 'OPENING', 'FOLLOW_UP', 'om-current-user');
    child.emitData('❯ ');
    await vi.waitFor(() => expect(cli.writeInput).toHaveBeenCalled());
    child.emitData('\r\n仍在输出，已安排 working flush');

    const interrupted = await manager.interruptSession('lm-1');
    expect(interrupted?.status).toBe('active');
    expect(child.write).toHaveBeenCalledWith('\x03');
    expect(child.kill).toHaveBeenCalled();
    expect(interrupted?.hasHistory).toBe(true);
    expect(interrupted?.cliSessionId).toBe('trae-new');
    expect(saved.at(-1)?.hasHistory).toBe(true);
    expect(saved.at(-1)?.cliSessionId).toBe('trae-new');
    expect(saved.at(-1)?.workLogs).toHaveLength(1);
    expect(saved.at(-1)?.workLogs?.[0]).toMatchObject({ status: 'stopped' });
    expect(saved.at(-1)?.workLogs?.[0].endedAt).toBeTruthy();
    expect(removeReaction).toHaveBeenCalledWith('om-current-user', 'reaction-1');
    expect(patchTrace).toHaveBeenCalledWith(
      'trace-card-1',
      'http://console/trace/lm-1',
      'lm-1',
      'stopped',
      expect.stringContaining('⏱️ 总耗时：'),
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(patchTrace.mock.calls.some((call) => call[3] === 'working')).toBe(false);

    await manager.submit(session, 'OPENING-2', 'FOLLOW_UP-2', 'om-next-user');
    expect(spawnSpec).toHaveBeenLastCalledWith('/repo', { resumeSessionId: 'trae-new', model: undefined });
    fresh.emitData('❯ ');
    await vi.waitFor(() => expect(cli.writeInput).toHaveBeenLastCalledWith(fresh, 'FOLLOW_UP-2'));
    manager.shutdownAll();
  });

  it('停止时兜底捕获尚未返回的 traex 原生会话 id', async () => {
    const session = route({ hasHistory: false, cliSessionId: undefined, initialCardMessageId: 'trace-card-1' });
    let saved: Session[] = [];
    let resolveWrite: ((value: { submitted: boolean; cliSessionId?: string }) => void) | undefined;
    const store: SessionStore = {
      loadBots: async () => [],
      saveBots: async () => undefined,
      loadSessions: async () => [],
      saveSessions: async (sessions) => { saved = structuredClone(sessions); },
    };
    const cli: CliAdapter = {
      id: 'traex',
      spawnSpec: (_cwd, options) => ({
        command: 'traex',
        args: options?.resumeSessionId ? ['resume', options.resumeSessionId] : [],
        cwd: '/repo',
      }),
      writeInput: vi.fn(() => new Promise((resolve) => { resolveWrite = resolve; })),
      findSessionId: vi.fn(() => 'trae-late'),
      readyPattern: /❯/,
      completionPattern: /❯/,
    };
    const child = fakePty();
    const manager = new ConversationManager({
      cli,
      store,
      spawnPty: () => child,
      post: async () => 'card-1',
      patch: async () => undefined,
      postTrace: async () => 'trace-card-1',
      patchTrace: async () => undefined,
      notify: async () => undefined,
      addReaction: async () => 'reaction-1',
      removeReaction: async () => undefined,
      createTrace: () => undefined,
      updateTrace: () => undefined,
      traceUrl: (id) => `http://console/trace/${id}`,
      isStreamingCardDisabled: () => false,
    });

    await manager.add(session);
    await manager.submit(session, 'OPENING', 'FOLLOW_UP', 'om-current-user');
    child.emitData('❯ ');
    await vi.waitFor(() => expect(cli.writeInput).toHaveBeenCalled());

    const interrupted = await manager.interruptSession('lm-1');
    expect(cli.findSessionId).toHaveBeenCalledWith('lm-1');
    expect(interrupted?.hasHistory).toBe(true);
    expect(interrupted?.cliSessionId).toBe('trae-late');
    expect(saved.at(-1)?.hasHistory).toBe(true);
    expect(saved.at(-1)?.cliSessionId).toBe('trae-late');
    resolveWrite?.({ submitted: true, cliSessionId: 'trae-late' });
    manager.shutdownAll();
  });

  it('输入尚未确认提交时 screen idle 不会完成本轮', async () => {
    vi.useFakeTimers();
    try {
      const session = route({ hasHistory: false, cliSessionId: undefined });
      let resolveWrite: ((value: { submitted: boolean; cliSessionId?: string }) => void) | undefined;
      const store: SessionStore = {
        loadBots: async () => [],
        saveBots: async () => undefined,
        loadSessions: async () => [],
        saveSessions: async () => undefined,
      };
      const cli: CliAdapter = {
        id: 'traex',
        spawnSpec: () => ({ command: 'traex', args: [], cwd: '/repo' }),
        writeInput: vi.fn(() => new Promise((resolve) => { resolveWrite = resolve; })),
        findSessionId: () => undefined,
        readyPattern: /❯/,
      };
      const child = fakePty();
      const postTrace = vi.fn(async () => 'trace-card-1');
      const patchTrace = vi.fn(async () => undefined);
      const notify = vi.fn(async () => undefined);
      const manager = new ConversationManager({
        cli,
        store,
        spawnPty: () => child,
        post: async () => 'card-1',
        patch: async () => undefined,
        postTrace,
        patchTrace,
        notify,
        addReaction: async () => 'reaction-1',
        removeReaction: async () => undefined,
        createTrace: () => undefined,
        updateTrace: () => undefined,
        traceUrl: (id) => `http://console/trace/${id}`,
        isStreamingCardDisabled: () => false,
      });

      await manager.add(session);
      await manager.submit(session, 'OPENING', 'FOLLOW_UP', 'om-current-user');
      child.emitData('❯ ');
      await vi.waitFor(() => expect(cli.writeInput).toHaveBeenCalled());

      child.emitData('❯ ');
      await vi.advanceTimersByTimeAsync(2_500);
      expect(postTrace.mock.calls.some(call => call[3] === 'completed')).toBe(false);
      expect(patchTrace.mock.calls.some(call => call[3] === 'completed')).toBe(false);
      expect(notify).not.toHaveBeenCalled();

      resolveWrite?.({ submitted: false });
      await vi.runAllTimersAsync();
      await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('omt-1', '消息投递失败：traex 未确认接收输入', 'om-current-user'));
      manager.shutdownAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('分析卡 footer 展示当前 traex 会话累计 token，完成回复卡使用自定义落款', async () => {
    const session = route({ hasHistory: false, cliSessionId: undefined });
    const store: SessionStore = {
      loadBots: async () => [],
      saveBots: async () => undefined,
      loadSessions: async () => [],
      saveSessions: async () => undefined,
    };
    const cli: CliAdapter = {
      id: 'traex',
      spawnSpec: () => ({ command: 'traex', args: [], cwd: '/repo' }),
      writeInput: vi.fn(async () => ({ submitted: true, cliSessionId: 'trae-new' })),
      findSessionId: () => undefined,
      getSessionUsage: vi.fn(() => ({
        inputTokens: 12000,
        outputTokens: 3456,
        cacheReadTokens: 3000,
        cacheCreateTokens: 0,
        model: 'gpt-5.5',
      })),
      getSessionFinal: vi.fn(() => ({
        key: 'turn-token:done',
        text: '最终回复',
      })),
      readyPattern: /❯/,
      completionPattern: /❯/,
    };
    const child = fakePty();
    const post = vi.fn(async () => 'card-1');
    const postTrace = vi.fn(async () => 'trace-card-1');
    const patchTrace = vi.fn(async () => undefined);
    const manager = new ConversationManager({
      cli,
      store,
      spawnPty: () => child,
      post,
      patch: async () => undefined,
      postTrace,
      patchTrace,
      notify: async () => undefined,
      addReaction: async () => 'reaction-1',
      removeReaction: async () => undefined,
      createTrace: () => undefined,
      updateTrace: () => undefined,
      traceUrl: (id) => `http://console/trace/${id}`,
      isStreamingCardDisabled: () => false,
    });

    await manager.add(session);
    await manager.submit(session, 'OPENING', 'FOLLOW_UP', 'om-current-user', '孟宁', '只读排查助手', 'ou_123');
    child.emitData('❯ ');
    await vi.waitFor(() => expect(cli.writeInput).toHaveBeenCalled());

    child.emitData('\r\n最终回复');
    await new Promise((resolve) => setTimeout(resolve, 20));
    child.emitData('\r\n❯ ');
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(
      'omt-1',
      expect.any(String),
      'completed',
      'om-current-user',
      '孟宁',
      '只读排查助手',
      'ou_123',
    ), { timeout: 1500 });
    await vi.waitFor(() => expect(postTrace).toHaveBeenCalledWith(
      'omt-1',
      'http://console/trace/lm-1',
      'lm-1',
      'completed',
      'om-current-user',
      expect.stringContaining('🪙 累计 Token ↑15K ↓3.5K · gpt-5.5'),
      expect.objectContaining({
        references: [],
        noReferenceReason: expect.any(String),
      }),
    ), { timeout: 1500 });
    expect(postTrace.mock.calls[0]?.[5]).toContain('⏱️ 总耗时：');
    expect(patchTrace).not.toHaveBeenCalled();
    manager.shutdownAll();
  });

  it('能识别最终回答里的项目页知识库标题引用', async () => {
    const session = route({ hasHistory: false, cliSessionId: undefined });
    const store: SessionStore = {
      loadBots: async () => [],
      saveBots: async () => undefined,
      loadSessions: async () => [],
      saveSessions: async () => undefined,
    };
    const cli: CliAdapter = {
      id: 'traex',
      spawnSpec: () => ({ command: 'traex', args: [], cwd: '/repo' }),
      writeInput: vi.fn(async () => ({ submitted: true, cliSessionId: 'trae-new' })),
      findSessionId: () => undefined,
      getSessionFinal: vi.fn(() => ({
        key: 'turn-knowledge:done',
        text: '项目页记录：public 知识库《进私视频带入私信会话》记录当前线上形态是进私吸底视频卡。',
      })),
      readyPattern: /❯/,
      completionPattern: /❯/,
    };
    const child = fakePty();
    const postTrace = vi.fn(async () => 'trace-card-1');
    const manager = new ConversationManager({
      cli,
      store,
      spawnPty: () => child,
      post: async () => 'card-1',
      patch: async () => undefined,
      postTrace,
      patchTrace: async () => undefined,
      notify: async () => undefined,
      addReaction: async () => 'reaction-1',
      removeReaction: async () => undefined,
      createTrace: () => undefined,
      updateTrace: () => undefined,
      traceUrl: (id) => `http://console/trace/${id}`,
      isStreamingCardDisabled: () => false,
    });

    await manager.add(session);
    await manager.submit(session, 'OPENING', 'FOLLOW_UP', 'om-current-user');
    child.emitData('❯ ');
    await vi.waitFor(() => expect(cli.writeInput).toHaveBeenCalled());
    child.emitData('\r\n❯ ');
    await vi.waitFor(() => expect(postTrace).toHaveBeenCalled(), { timeout: 1500 });
    expect(postTrace.mock.calls[0]?.[6]).toMatchObject({
      references: [expect.objectContaining({
        path: '知识库《进私视频带入私信会话》',
        source: 'answer',
      })],
    });
    manager.shutdownAll();
  });

  it('优先解析 larkbot evidence 结构化证据并从最终回复中隐藏', async () => {
    const session = route({ hasHistory: false, cliSessionId: undefined });
    const store: SessionStore = {
      loadBots: async () => [],
      saveBots: async () => undefined,
      loadSessions: async () => [],
      saveSessions: async () => undefined,
    };
    const cli: CliAdapter = {
      id: 'traex',
      spawnSpec: () => ({ command: 'traex', args: [], cwd: '/repo' }),
      writeInput: vi.fn(async () => ({ submitted: true, cliSessionId: 'trae-new' })),
      findSessionId: () => undefined,
      getSessionFinal: vi.fn(() => ({
        key: 'turn-structured-knowledge:done',
        text: [
          '**结论：进私视频吸底卡 未下发。**',
          '',
          '服务端侧直接原因是素材 owner 校验未通过。',
          '',
          '<larkbot_evidence>',
          '{"knowledge_refs":["进私视频带入私信会话"],"code_refs":["pack.go:52 QueryItemById"],"log_refs":["20260820205942ECFDEE54DC3DFE43C88E"]}',
          '</larkbot_evidence>',
        ].join('\n'),
      })),
      readyPattern: /❯/,
      completionPattern: /❯/,
    };
    const child = fakePty();
    const post = vi.fn(async () => 'card-1');
    const postTrace = vi.fn(async () => 'trace-card-1');
    const manager = new ConversationManager({
      cli,
      store,
      spawnPty: () => child,
      post,
      patch: async () => undefined,
      postTrace,
      patchTrace: async () => undefined,
      notify: async () => undefined,
      addReaction: async () => 'reaction-1',
      removeReaction: async () => undefined,
      createTrace: () => undefined,
      updateTrace: () => undefined,
      traceUrl: (id) => `http://console/trace/${id}`,
      isStreamingCardDisabled: () => false,
    });

    await manager.add(session);
    await manager.submit(session, 'OPENING', 'FOLLOW_UP', 'om-current-user');
    child.emitData('❯ ');
    await vi.waitFor(() => expect(cli.writeInput).toHaveBeenCalled());
    child.emitData('\r\n❯ ');
    await vi.waitFor(() => expect(postTrace).toHaveBeenCalled(), { timeout: 1500 });
    expect(post.mock.calls[0]?.[1]).toContain('素材 owner 校验未通过');
    expect(post.mock.calls[0]?.[1]).not.toContain('larkbot_evidence');
    expect(postTrace.mock.calls[0]?.[6]).toMatchObject({
      references: [expect.objectContaining({
        path: '知识库《进私视频带入私信会话》',
        source: 'structured',
      })],
      codeReferences: [expect.objectContaining({ value: 'pack.go:52 QueryItemById' })],
      logReferences: [expect.objectContaining({ value: '20260820205942ECFDEE54DC3DFE43C88E' })],
    });
    manager.shutdownAll();
  });

  it('完成回复优先使用 traex rollout 的 task_complete final', async () => {
    const session = route({ hasHistory: false, cliSessionId: undefined });
    const store: SessionStore = {
      loadBots: async () => [],
      saveBots: async () => undefined,
      loadSessions: async () => [],
      saveSessions: async () => undefined,
    };
    const cli: CliAdapter = {
      id: 'traex',
      spawnSpec: () => ({ command: 'traex', args: [], cwd: '/repo' }),
      writeInput: vi.fn(async () => ({ submitted: true, cliSessionId: 'trae-new' })),
      findSessionId: () => undefined,
      getSessionFinal: vi.fn(() => ({
        key: 'turn-1:done',
        text: '你好，我在。需要我帮你看什么？',
      })),
      readyPattern: /❯/,
      completionPattern: /TURN_DONE/,
    };
    const child = fakePty();
    const post = vi.fn(async () => 'card-1');
    const manager = new ConversationManager({
      cli,
      store,
      spawnPty: () => child,
      post,
      patch: async () => undefined,
      postTrace: async () => 'trace-card-1',
      patchTrace: async () => undefined,
      notify: async () => undefined,
      addReaction: async () => 'reaction-1',
      removeReaction: async () => undefined,
      createTrace: () => undefined,
      updateTrace: () => undefined,
      traceUrl: (id) => `http://console/trace/${id}`,
      isStreamingCardDisabled: () => true,
    });

    await manager.add(session);
    await manager.submit(session, 'OPENING', 'FOLLOW_UP', 'om-current-user');
    child.emitData('❯ ');
    await vi.waitFor(() => expect(cli.writeInput).toHaveBeenCalled());

    child.emitData('\r\nworktree setup on supported filesystems.\r\n\r\n你好，我在。');
    child.emitData('\r\nTURN_DONE');
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(
      'omt-1',
      '你好，我在。需要我帮你看什么？',
      'completed',
      'om-current-user',
      undefined,
      undefined,
      undefined,
    ), { timeout: 1500 });
    manager.shutdownAll();
  });

  it('空回复哨兵不发送最终回复卡', async () => {
    const session = route({ hasHistory: false, cliSessionId: undefined });
    const store: SessionStore = {
      loadBots: async () => [],
      saveBots: async () => undefined,
      loadSessions: async () => [],
      saveSessions: async () => undefined,
    };
    const cli: CliAdapter = {
      id: 'traex',
      spawnSpec: () => ({ command: 'traex', args: [], cwd: '/repo' }),
      writeInput: vi.fn(async () => ({ submitted: true, cliSessionId: 'trae-new' })),
      findSessionId: () => undefined,
      getSessionFinal: vi.fn(() => ({
        key: 'turn-empty:done',
        text: 'LARKBOT_NOTHING_TO_SEND',
      })),
      getSessionUsage: vi.fn(() => ({
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      })),
      readyPattern: /❯/,
      completionPattern: /TURN_DONE/,
    };
    const child = fakePty();
    const post = vi.fn(async () => 'card-1');
    const postTrace = vi.fn(async () => 'trace-card-1');
    const manager = new ConversationManager({
      cli,
      store,
      spawnPty: () => child,
      post,
      patch: async () => undefined,
      postTrace,
      patchTrace: async () => undefined,
      notify: async () => undefined,
      addReaction: async () => 'reaction-1',
      removeReaction: async () => undefined,
      createTrace: () => undefined,
      updateTrace: () => undefined,
      traceUrl: (id) => `http://console/trace/${id}`,
      isStreamingCardDisabled: () => false,
    });

    await manager.add(session);
    await manager.submit(session, 'OPENING', 'FOLLOW_UP', 'om-current-user');
    child.emitData('❯ ');
    await vi.waitFor(() => expect(cli.writeInput).toHaveBeenCalled());

    child.emitData('\r\nLARKBOT_NOTHING_TO_SEND\r\nTURN_DONE');
    await vi.waitFor(() => expect(postTrace).toHaveBeenCalled(), { timeout: 1500 });
    expect(post).not.toHaveBeenCalled();
    manager.shutdownAll();
  });

  it('终端兜底输出以 legacy botmux 空回复哨兵开头时不发送最终回复卡', async () => {
    const session = route({ hasHistory: false, cliSessionId: undefined });
    const store: SessionStore = {
      loadBots: async () => [],
      saveBots: async () => undefined,
      loadSessions: async () => [],
      saveSessions: async () => undefined,
    };
    const cli: CliAdapter = {
      id: 'traex',
      spawnSpec: () => ({ command: 'traex', args: [], cwd: '/repo' }),
      writeInput: vi.fn(async () => ({ submitted: true, cliSessionId: 'trae-new' })),
      findSessionId: () => undefined,
      getSessionFinal: vi.fn(() => undefined),
      readyPattern: /❯/,
      completionPattern: /TURN_DONE/,
    };
    const child = fakePty();
    const post = vi.fn(async () => 'card-1');
    const addReaction = vi.fn(async () => 'reaction-1');
    const manager = new ConversationManager({
      cli,
      store,
      spawnPty: () => child,
      post,
      patch: async () => undefined,
      postTrace: async () => 'trace-card-1',
      patchTrace: async () => undefined,
      notify: async () => undefined,
      addReaction,
      removeReaction: async () => undefined,
      createTrace: () => undefined,
      updateTrace: () => undefined,
      traceUrl: (id) => `http://console/trace/${id}`,
      isStreamingCardDisabled: () => false,
    });

    await manager.add(session);
    await manager.submit(session, 'OPENING', 'FOLLOW_UP', 'om-current-user');
    child.emitData('❯ ');
    await vi.waitFor(() => expect(cli.writeInput).toHaveBeenCalled());

    child.emitData('\r\nBOTMUX_NOTHING_TO_SEND\r\n\r\nInitialize Larkbot environment\r\nTURN_DONE');
    await vi.waitFor(() => expect(addReaction).toHaveBeenCalledWith('om-current-user', 'DONE'), { timeout: 3000 });
    expect(post).not.toHaveBeenCalled();
    manager.shutdownAll();
  });
});
