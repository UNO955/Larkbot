import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultSessionStore, JsonSessionStore, SQLiteSessionStore } from '../src/core/store.js';
import type { Bot, Session, Ticket, TicketTraceEvent } from '../src/core/types.js';

const dirs: string[] = [];

function session(): Session {
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
  };
}

function bot(): Bot {
  return {
    id: 'default',
    name: 'larkbot-dev',
    appId: 'cli_xxx',
    appSecret: 'secret',
    cwd: '/repo',
    ownerOpenId: 'ou_xxx',
    allowedChatIds: ['oc_team'],
    knownChats: [{ chatId: 'oc_team', name: '项目群', lastSeenAt: '2026-01-01T00:00:00.000Z', source: 'message' }],
    enabled: true,
    disableStreamingCard: false,
  };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('JsonSessionStore', () => {
  it('原子保存并恢复纯路由会话', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'larkbot-store-'));
    dirs.push(dir);
    const path = join(dir, 'sessions.json');
    const store = new JsonSessionStore(path);
    await store.saveSessions([session()]);

    expect(await store.loadSessions()).toEqual([session()]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(1);
  });

  it('保存并恢复会话工时日志', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'larkbot-store-'));
    dirs.push(dir);
    const path = join(dir, 'sessions.json');
    const store = new JsonSessionStore(path);
    const item = session();
    item.workLogs = [{
      id: 'lm-1:1760000000000:1',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:02:00.000Z',
      durationMs: 120000,
      status: 'completed',
    }];

    await store.saveSessions([item]);

    expect(await store.loadSessions()).toEqual([item]);
  });

  it('文件不存在时返回空路由表', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'larkbot-store-'));
    dirs.push(dir);
    expect(await new JsonSessionStore(join(dir, 'missing.json')).loadSessions()).toEqual([]);
  });

  it('保存并恢复 bot 配置', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'larkbot-store-'));
    dirs.push(dir);
    const store = new JsonSessionStore(join(dir, 'sessions.json'), join(dir, 'bots.json'));
    await store.saveBots([bot()]);

    expect(await store.loadBots()).toEqual([bot()]);
    expect(JSON.parse(await readFile(join(dir, 'bots.json'), 'utf8'))).toHaveLength(1);
  });

  it('保存并恢复工单档案', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'larkbot-store-'));
    dirs.push(dir);
    const store = new JsonSessionStore(
      join(dir, 'sessions.json'),
      join(dir, 'bots.json'),
      join(dir, 'expired-sessions.json'),
      join(dir, 'feedback.json'),
      join(dir, 'tickets.json'),
    );
    const ticket: Ticket = {
      id: 'tk-1',
      source: 'feishu_group',
      title: '排查线上错误',
      status: 'waiting_user',
      priority: 'normal',
      chatId: 'oc-1',
      rootMessageId: 'om-1',
      currentSessionId: 'lm-1',
      sessionIds: ['lm-1'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    };

    await store.saveTickets([ticket]);

    expect(await store.loadTickets()).toEqual([ticket]);
    expect(JSON.parse(await readFile(join(dir, 'tickets.json'), 'utf8'))).toHaveLength(1);
  });

  it('保存并恢复工单分析事件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'larkbot-store-'));
    dirs.push(dir);
    const store = new JsonSessionStore(
      join(dir, 'sessions.json'),
      join(dir, 'bots.json'),
      join(dir, 'expired-sessions.json'),
      join(dir, 'feedback.json'),
      join(dir, 'tickets.json'),
      join(dir, 'ticket-trace-events.json'),
    );
    const event: TicketTraceEvent = {
      id: 'ev-1',
      ticketId: 'tk-1',
      sessionId: 'lm-1',
      turnId: 'lm-1:1760000000000:1',
      kind: 'trace_snapshot',
      status: 'working',
      trace: 'searching logs',
      createdAt: '2026-01-01T00:01:00.000Z',
    };

    await store.saveTicketTraceEvents([event]);

    expect(await store.loadTicketTraceEvents()).toEqual([event]);
    expect(JSON.parse(await readFile(join(dir, 'ticket-trace-events.json'), 'utf8'))).toHaveLength(1);
  });
});

describe('SQLiteSessionStore', () => {
  it('保存并恢复核心集合', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'larkbot-sqlite-store-'));
    dirs.push(dir);
    const store = new SQLiteSessionStore(join(dir, 'larkbot.sqlite'));
    const ticket: Ticket = {
      id: 'tk-1',
      source: 'feishu_group',
      title: '排查线上错误',
      status: 'waiting_user',
      priority: 'normal',
      chatId: 'oc-1',
      rootMessageId: 'om-1',
      currentSessionId: 'lm-1',
      sessionIds: ['lm-1'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    };
    const event: TicketTraceEvent = {
      id: 'ev-1',
      ticketId: 'tk-1',
      sessionId: 'lm-1',
      kind: 'turn_completed',
      status: 'completed',
      answer: 'done',
      createdAt: '2026-01-01T00:02:00.000Z',
    };

    await store.saveBots([bot()]);
    await store.saveSessions([session()]);
    await store.saveTickets([ticket]);
    await store.saveTicketTraceEvents([event]);

    expect(await store.loadBots()).toEqual([bot()]);
    expect(await store.loadSessions()).toEqual([session()]);
    expect(await store.loadTickets()).toEqual([ticket]);
    expect(await store.loadTicketTraceEvents()).toEqual([event]);
    store.close();
  });

  it('从现有 JSON 文件导入空 SQLite 库', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'larkbot-sqlite-migrate-'));
    dirs.push(dir);
    const jsonStore = new JsonSessionStore(
      join(dir, 'sessions.json'),
      join(dir, 'bots.json'),
      join(dir, 'expired-sessions.json'),
      join(dir, 'feedback.json'),
      join(dir, 'tickets.json'),
      join(dir, 'ticket-trace-events.json'),
    );
    await jsonStore.saveBots([bot()]);
    await jsonStore.saveSessions([session()]);

    const sqliteStore = new SQLiteSessionStore(join(dir, 'larkbot.sqlite'));
    await sqliteStore.migrateFromJson(jsonStore);

    expect(await sqliteStore.loadBots()).toEqual([bot()]);
    expect(await sqliteStore.loadSessions()).toEqual([session()]);
    sqliteStore.close();
  });

  it('默认工厂优先创建 SQLite store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'larkbot-default-store-'));
    dirs.push(dir);
    const previousStateDir = process.env.LARKBOT_STATE_DIR;
    const previousStore = process.env.LARKBOT_STORE;
    process.env.LARKBOT_STATE_DIR = dir;
    delete process.env.LARKBOT_STORE;
    try {
      const store = await createDefaultSessionStore();
      expect(store).toBeInstanceOf(SQLiteSessionStore);
      await store.saveSessions([session()]);
      expect(await store.loadSessions()).toEqual([session()]);
      (store as SQLiteSessionStore).close();
    } finally {
      if (previousStateDir === undefined) delete process.env.LARKBOT_STATE_DIR;
      else process.env.LARKBOT_STATE_DIR = previousStateDir;
      if (previousStore === undefined) delete process.env.LARKBOT_STORE;
      else process.env.LARKBOT_STORE = previousStore;
    }
  });
});
