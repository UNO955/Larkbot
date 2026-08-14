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
      closeUrl: (id) => `http://console/sessions/${id}/close`,
      isStreamingCardDisabled: () => false,
    });

    await manager.restore();
    expect(spawnSpec).not.toHaveBeenCalled();

    await manager.submit(session, 'OPENING', 'FOLLOW_UP');
    expect(spawnSpec).toHaveBeenCalledWith('/repo', { resumeSessionId: 'trae-1' });
    expect(writeInput).not.toHaveBeenCalled();

    child.emitData('❯ ');
    await vi.waitFor(() => expect(writeInput).toHaveBeenCalledWith(child, 'FOLLOW_UP'));
    expect(saved[0].cliSessionId).toBe('trae-1');
    manager.shutdownAll();
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
      closeUrl: (id) => `http://console/sessions/${id}/close`,
      isStreamingCardDisabled: () => false,
    });
    await manager.restore();
    await manager.submit(session, 'OPENING', 'FOLLOW_UP');

    resumed.emitExit(1);
    await vi.waitFor(() => expect(spawnSpec).toHaveBeenCalledTimes(2));
    expect(spawnSpec.mock.calls[1][1]).toEqual({ resumeSessionId: undefined });
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
      closeUrl: (id) => `http://console/sessions/${id}/close`,
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
      closeUrl: (id) => `http://console/sessions/${id}/close`,
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
    manager.shutdownAll();
  });

  it('思考卡 footer 展示当前 traex 会话累计 token，完成回复卡标记回复对象', async () => {
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
      closeUrl: (id) => `http://console/sessions/${id}/close`,
      isStreamingCardDisabled: () => false,
    });

    await manager.add(session);
    await manager.submit(session, 'OPENING', 'FOLLOW_UP', 'om-current-user', '孟宁', '只读排查助手');
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
    ), { timeout: 1500 });
    await vi.waitFor(() => expect(postTrace).toHaveBeenCalledWith(
      'omt-1',
      'http://console/trace/lm-1',
      'http://console/sessions/lm-1/close',
      'completed',
      'om-current-user',
      '🪙 累计 Token ↑15K ↓3.5K · gpt-5.5',
    ), { timeout: 1500 });
    expect(patchTrace).not.toHaveBeenCalled();
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
      closeUrl: (id) => `http://console/sessions/${id}/close`,
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
    ), { timeout: 1500 });
    manager.shutdownAll();
  });
});
