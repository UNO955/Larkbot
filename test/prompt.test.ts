import { describe, expect, it } from 'vitest';
import { buildFollowUpPrompt, buildOpeningPrompt } from '../src/core/prompt.js';
import type { Session } from '../src/core/types.js';
import type { ImMessage } from '../src/im/types.js';

const session: Session = {
  sessionId: 'lm-1',
  chatId: 'oc-1',
  rootMessageId: 'om-1',
  threadId: 'omt-1',
  scope: 'thread',
  title: 'test',
  status: 'active',
  workingDir: '/repo',
  cliId: 'traex',
  hasHistory: false,
  lastMessageAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const message: ImMessage = {
  id: 'om-2',
  threadId: 'omt-1',
  rootMessageId: 'om-1',
  chatId: 'oc-1',
  senderId: 'ou-1',
  senderType: 'user',
  senderName: 'MN',
  content: '检查当前改动',
  attachments: [{ type: 'image', path: '/tmp/a.png' }],
  quotedMessageId: 'om-parent',
  createTime: '1',
};

describe('prompt envelope', () => {
  it('首轮包含 routing、session 和发送者信息', () => {
    const prompt = buildOpeningPrompt(session, message);
    expect(prompt).toContain('<larkmux_routing>');
    expect(prompt).toContain('<session_id>lm-1</session_id>');
    expect(prompt).toContain('<user_message>\n检查当前改动\n</user_message>');
    expect(prompt).toContain('<sender type="user" open_id="ou-1" name="MN" />');
    expect(prompt).toContain('<image n="1" path="/tmp/a.png" />');
    expect(prompt).toContain('<quoted_message message_id="om-parent" />');
  });

  it('跟帖只包含轻量 reminder，不重复 routing', () => {
    const prompt = buildFollowUpPrompt(message);
    expect(prompt).toContain('<larkmux_reminder>');
    expect(prompt).not.toContain('<larkmux_routing>');
    expect(prompt).not.toContain('<session_id>');
  });
});
