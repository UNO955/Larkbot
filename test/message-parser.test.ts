import { describe, it, expect } from 'vitest';
import { parseMessageEvent } from '../src/im/lark/message-parser.js';

/** 构造一个 im.message.receive_v1 的最小事件 data。 */
function evt(over: Record<string, any> = {}): any {
  return {
    sender: {
      sender_id: { open_id: over.senderOpenId ?? 'ou_owner' },
      sender_name: over.senderName,
    },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: over.chatType,
      message_type: over.messageType ?? 'text',
      content: over.content ?? JSON.stringify({ text: 'hello' }),
      mentions: over.mentions,
      thread_id: over.threadId,
      root_id: over.rootId,
      parent_id: over.parentId,
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

  it('解析群聊类型', () => {
    const r = parseMessageEvent(evt({ chatType: 'group' }));
    expect(r!.chatType).toBe('group');
  });

  it('解析发送人展示名', () => {
    const r = parseMessageEvent(evt({ senderName: '孟宁' }));
    expect(r!.senderName).toBe('孟宁');
  });

  it('不支持的消息类型返回 null', () => {
    expect(parseMessageEvent(evt({ messageType: 'audio' }))).toBeNull();
  });

  it('解析图片资源和引用消息', () => {
    const r = parseMessageEvent(evt({
      messageType: 'image',
      content: JSON.stringify({ image_key: 'img_1' }),
      parentId: 'om_parent',
    }));
    expect(r!.resources).toEqual([{ type: 'image', key: 'img_1' }]);
    expect(r!.replyToMessageId).toBe('om_parent');
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
    const r = parseMessageEvent(evt({ threadId: 'omt_9', rootId: 'om_root' }));
    expect(r!.threadId).toBe('omt_9');
    expect(r!.rootId).toBe('om_root');
  });

  it('content 非法 JSON 返回 null', () => {
    expect(parseMessageEvent(evt({ content: '{bad' }))).toBeNull();
  });
});
