import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startConsoleServer, TerminalStreamStore } from '../src/console/server.js';
import type { SessionStore } from '../src/core/store.js';
import type { Bot, FeedbackRecord, Session } from '../src/core/types.js';

const bot: Bot = {
  id: 'bot-1',
  name: 'larkbot-dev',
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

    terminalStore.redactInput('lm-1', [
      '<larkbot_reminder>',
      '这是同一个飞书话题中的后续消息。',
      '</larkbot_reminder>',
      '<user_message>',
      '你可以干嘛',
      '</user_message>',
    ].join('\n'));
    terminalStore.append('lm-1', '\x1b[32m▍ <system_prompt_profile>\r\n');
    terminalStore.append('lm-1', '▍ secret rule\r\n');
    terminalStore.append('lm-1', '▍ </system_prompt_profile>\r\n');
    terminalStore.append('lm-1', '▍ <larkbot_reminder>\r\n');
    terminalStore.append('lm-1', '▍ 这是同一个飞书话题中的后续消息。\r\n');
    terminalStore.append('lm-1', '▍ </larkbot_reminder>\r\n');
    terminalStore.append('lm-1', '▍ <quoted_message message_id="om-1">\r\n');
    terminalStore.append('lm-1', '▍ quoted prompt context\r\n');
    terminalStore.append('lm-1', '▍ </quoted_message>\r\n');
    terminalStore.append('lm-1', '▍ <user_message>\r\n');
    terminalStore.append('lm-1', '▍ current user text\r\n');
    terminalStore.append('lm-1', '▍ </user_message>\r\n');
    terminalStore.append('lm-1', '▍ leaked prompt text without tag\r\n');
    terminalStore.append('lm-1', '❯ 你可以干嘛\r\n');
    terminalStore.append('lm-1', '你可以干嘛\r\n');
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
      expect(text).not.toContain('system_prompt_profile');
      expect(text).not.toContain('secret rule');
      expect(text).not.toContain('larkbot_reminder');
      expect(text).not.toContain('quoted prompt context');
      expect(text).not.toContain('current user text');
      expect(text).not.toContain('leaked prompt text without tag');
      expect(text).not.toContain('你可以干嘛');
    } finally {
      await reader.cancel();
    }
  });

  it('保存并返回系统提示词 profiles', async () => {
    let savedBots: Bot[] = [structuredClone(bot)];
    const store: SessionStore = {
      loadBots: async () => savedBots,
      saveBots: async (bots) => { savedBots = structuredClone(bots); },
      loadSessions: async () => [session],
      saveSessions: async () => undefined,
    };
    server = await startConsoleServer({
      host: '127.0.0.1',
      port: 0,
      store,
      botId: 'bot-1',
    });
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const patch = await fetch(`${base}/api/bot`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        replySignature: '只读排查助手',
        model: 'gpt-5.5',
        allowedOpenIds: 'ou_qa\nou_client,ou_qa',
        systemPromptProfiles: [
          { id: 'review', name: '代码审查', content: '先列风险。' },
          { id: 'brief', name: '简洁回答', content: '直接给结论。' },
        ],
        activeSystemPromptProfileId: 'review',
      }),
    });
    expect(patch.status).toBe(200);

    const res = await fetch(`${base}/api/bot`);
    const { bot: publicBot } = await res.json();
    expect(publicBot.replySignature).toBe('只读排查助手');
    expect(publicBot.model).toBe('gpt-5.5');
    expect(publicBot.allowedOpenIds).toEqual(['ou_qa', 'ou_client']);
    expect(publicBot.systemPromptProfiles).toHaveLength(2);
    expect(publicBot.activeSystemPromptProfileId).toBe('review');
    expect(publicBot.systemPromptProfiles[0]).toMatchObject({ id: 'review', name: '代码审查', content: '先列风险。' });
    expect(publicBot.appSecret).toBeUndefined();
    expect(publicBot.appSecretSet).toBe(true);
  });

  it('展示并切换群聊授权', async () => {
    let savedBots: Bot[] = [{
      ...structuredClone(bot),
      knownChats: [{ chatId: 'oc_team', name: '项目群', lastSeenAt: '2026-01-01T00:00:00.000Z', source: 'message' }],
      allowedChatIds: [],
    }];
    const store: SessionStore = {
      loadBots: async () => savedBots,
      saveBots: async (bots) => { savedBots = structuredClone(bots); },
      loadSessions: async () => [],
      saveSessions: async () => undefined,
    };
    const onBotUpdated = vi.fn();
    server = await startConsoleServer({
      host: '127.0.0.1',
      port: 0,
      store,
      botId: 'bot-1',
      onBotUpdated,
    });
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const before = await fetch(`${base}/api/chats`);
    expect(await before.json()).toEqual({
      chats: [{ chatId: 'oc_team', name: '项目群', lastSeenAt: '2026-01-01T00:00:00.000Z', source: 'message', enabled: false }],
    });

    const patch = await fetch(`${base}/api/chats/oc_team`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(patch.status).toBe(200);
    expect(savedBots[0].allowedChatIds).toEqual(['oc_team']);
    expect(onBotUpdated).toHaveBeenCalledWith(expect.objectContaining({ allowedChatIds: ['oc_team'] }));

    const after = await fetch(`${base}/api/chats`);
    expect((await after.json()).chats[0].enabled).toBe(true);
  });

  it('管理反馈记录状态并支持删除', async () => {
    let feedbacks: FeedbackRecord[] = [{
      id: 'fb-1',
      rating: 'negative',
      status: 'open',
      sessionId: 'lm-1',
      sessionTitle: '猜答手机号按钮排查',
      chatId: 'oc-1',
      chatName: '项目群',
      operatorId: 'ou_qa',
      operatorName: 'QA',
      terminalUrl: 'http://console/terminal/lm-1',
      reason: '证据不足',
      note: '没说为什么',
      question: '为什么猜答手机号按钮未下发？',
      answer: '结论：猜答手机号按钮未下发。',
      knowledge: {
        references: [{ path: 'docs/playbook.md', source: 'trace' }],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }];
    const store: SessionStore = {
      loadBots: async () => [bot],
      saveBots: async () => undefined,
      loadSessions: async () => [session],
      saveSessions: async () => undefined,
      loadFeedbacks: async () => feedbacks,
      saveFeedbacks: async (next) => { feedbacks = structuredClone(next); },
    };
    server = await startConsoleServer({
      host: '127.0.0.1',
      port: 0,
      store,
      botId: 'bot-1',
    });
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const list = await fetch(`${base}/api/feedbacks`);
    expect(list.status).toBe(200);
    expect((await list.json()).feedbacks[0]).toMatchObject({ id: 'fb-1', rating: 'negative', status: 'open' });

    const patch = await fetch(`${base}/api/feedbacks/fb-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'reviewing' }),
    });
    expect(patch.status).toBe(200);
    expect(feedbacks[0].status).toBe('reviewing');

    const notePatch = await fetch(`${base}/api/feedbacks/fb-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewNote: '已修 prompt，待回归' }),
    });
    expect(notePatch.status).toBe(200);
    expect(feedbacks[0].reviewNote).toBe('已修 prompt，待回归');

    const del = await fetch(`${base}/api/feedbacks/fb-1`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(feedbacks).toEqual([]);
  });

  it('卡片停止入口只中断本轮分析，不关闭会话', async () => {
    const interrupted = structuredClone(session);
    const interruptSession = vi.fn(async () => interrupted);
    const store: SessionStore = {
      loadBots: async () => [bot],
      saveBots: async () => undefined,
      loadSessions: async () => [interrupted],
      saveSessions: async () => undefined,
    };
    server = await startConsoleServer({
      host: '127.0.0.1',
      port: 0,
      store,
      botId: 'bot-1',
      sessionManager: {
        listSessions: () => [interrupted],
        closeSession: async () => interrupted,
        interruptSession,
        deleteSession: async () => true,
      },
    });
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const interrupt = await fetch(`${base}/sessions/lm-1/interrupt`);
    expect(interrupt.status).toBe(200);
    expect(await interrupt.text()).toContain('分析已停止');

    expect(interruptSession).toHaveBeenCalledWith('lm-1');
    expect(interrupted.status).toBe('active');
  });
});
