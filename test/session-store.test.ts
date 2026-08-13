import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonSessionStore } from '../src/core/store.js';
import type { Session } from '../src/core/types.js';

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

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('JsonSessionStore', () => {
  it('原子保存并恢复纯路由会话', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'larkmux-store-'));
    dirs.push(dir);
    const path = join(dir, 'sessions.json');
    const store = new JsonSessionStore(path);
    await store.saveSessions([session()]);

    expect(await store.loadSessions()).toEqual([session()]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(1);
  });

  it('文件不存在时返回空路由表', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'larkmux-store-'));
    dirs.push(dir);
    expect(await new JsonSessionStore(join(dir, 'missing.json')).loadSessions()).toEqual([]);
  });
});
