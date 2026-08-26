import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonSessionStore } from '../src/core/store.js';
import type { Bot, Session, Ticket } from '../src/core/types.js';

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
});
