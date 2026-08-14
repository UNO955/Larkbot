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
    expect(prompt).toContain('<larkbot_routing>');
    expect(prompt).toContain('<session_id>lm-1</session_id>');
    expect(prompt).toContain('<user_message>\n检查当前改动\n</user_message>');
    expect(prompt).toContain('<sender type="user" open_id="ou-1" name="MN" />');
    expect(prompt).toContain('<image n="1" path="/tmp/a.png" />');
    expect(prompt).toContain('<quoted_message message_id="om-parent" unavailable="true" />');
    expect(prompt).not.toContain('larkbot history');
  });

  it('跟帖只包含轻量 reminder，不重复 routing', () => {
    const prompt = buildFollowUpPrompt(message);
    expect(prompt).toContain('<larkbot_reminder>');
    expect(prompt).not.toContain('<larkbot_routing>');
    expect(prompt).not.toContain('<session_id>');
  });

  it('可注入当前系统提示词 profile', () => {
    const prompt = buildOpeningPrompt(session, message, {
      systemPromptName: '代码审查',
      systemPrompt: '优先指出风险，避免冗余表扬。',
    });
    expect(prompt).toContain('<system_prompt_profile name="代码审查">\n优先指出风险，避免冗余表扬。\n</system_prompt_profile>');
    expect(prompt.indexOf('<system_prompt_profile')).toBeLessThan(prompt.lastIndexOf('<user_message>'));
  });

  it('引用消息只作为上下文，当前消息保持最后', () => {
    const prompt = buildFollowUpPrompt({
      ...message,
      content: 'Summarize recent commits',
      quotedMessage: {
        messageId: 'om-parent',
        content: '帮我写个3000字议论文',
      },
    });

    expect(prompt).toContain('<quoted_message message_id="om-parent">\n帮我写个3000字议论文\n</quoted_message>');
    expect(prompt.trim()).toMatch(/<user_message>\nSummarize recent commits\n<\/user_message>$/);
    expect(prompt.indexOf('<quoted_message')).toBeLessThan(prompt.indexOf('<user_message>'));
  });
});
