import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startConsoleServer, TerminalStreamStore } from '../src/console/server.js';
import type { SessionStore } from '../src/core/store.js';
import type { Bot, Session } from '../src/core/types.js';

const bot: Bot = {
  id: 'bot-1',
  name: 'larkmux-dev',
  appId: 'cli_x',
  appSecret: 'secret',
  cwd: '/repo',
  ownerOpenId: 'ou_1',
  enabled: true,
};

const session: Session = {
  sessionId: 'lm-1',
  chatId: 'oc-1',
  rootMessageId: 'om-1',
  threadId: 'omt-1',
  anchorMessageId: 'om-anchor',
  scope: 'thread',
  title: '测试会话',
  status: 'active',
  workingDir: '/repo',
  cliId: 'traex',
  cliSessionId: 'trae-1',
  hasHistory: true,
  lastMessageAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('console terminal page', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('提供只读 xterm 页面和 SSE 终端输出', async () => {
    const terminalStore = new TerminalStreamStore();
    const store: SessionStore = {
      loadBots: async () => [bot],
      saveBots: async () => undefined,
      loadSessions: async () => [session],
      saveSessions: async () => undefined,
    };
    server = await startConsoleServer({
      host: '127.0.0.1',
      port: 0,
      store,
      botId: 'bot-1',
      terminalStore,
    });
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const page = await fetch(`${base}/terminal/lm-1`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('@xterm/xterm');
    expect(html).toContain('/api/terminal/lm-1/events');

    terminalStore.append('lm-1', 'hello terminal');
    const events = await fetch(`${base}/api/terminal/lm-1/events`);
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    try {
      let text = '';
      for (let i = 0; i < 8 && !text.includes('hello terminal'); i++) {
        const { value } = await reader.read();
        text += new TextDecoder().decode(value);
      }
      expect(text).toContain('hello terminal');
    } finally {
      await reader.cancel();
    }
  });
});
