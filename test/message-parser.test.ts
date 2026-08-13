import { describe, it, expect } from 'vitest';
import { parseMessageEvent } from '../src/im/lark/message-parser.js';

/** 构造一个 im.message.receive_v1 的最小事件 data。 */
function evt(over: Record<string, any> = {}): any {
  return {
    sender: { sender_id: { open_id: over.senderOpenId ?? 'ou_owner' } },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      message_type: over.messageType ?? 'text',
      content: over.content ?? JSON.stringify({ text: 'hello' }),
      mentions: over.mentions,
      thread_id: over.threadId,
    },
  };
}

describe('parseMessageEvent', () => {
  it('解析纯文本消息', () => {
    const r = parseMessageEvent(evt());
    expect(r).not.toBeNull();
    expect(r!.text).toBe('hello');
    expect(r!.senderOpenId).toBe('ou_owner');
    expect(r!.chatId).toBe('oc_1');
  });

  it('非 text 类型返回 null', () => {
    expect(parseMessageEvent(evt({ messageType: 'image' }))).toBeNull();
  });

  it('剥离 @ 占位符得到干净正文', () => {
    const r = parseMessageEvent(evt({
      content: JSON.stringify({ text: '@_user_1 部署一下' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
    }));
    expect(r!.text).toBe('部署一下');
    expect(r!.mentionedOpenIds).toContain('ou_bot');
  });

  it('携带 thread_id 时解析出话题', () => {
    const r = parseMessageEvent(evt({ threadId: 'omt_9' }));
    expect(r!.threadId).toBe('omt_9');
  });

  it('content 非法 JSON 返回 null', () => {
    expect(parseMessageEvent(evt({ content: '{bad' }))).toBeNull();
  });
});
