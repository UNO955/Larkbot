import { describe, expect, it } from 'vitest';
import { buildTerminalCard, buildThinkingCard } from '../src/im/lark/card-builder.js';

describe('buildTerminalCard', () => {
  it('运行态使用蓝色状态头和原生 Markdown 正文', () => {
    const card: any = buildTerminalCard({
      body: '**正在检查**',
      status: 'working',
    }).payload;
    expect(card.header.template).toBe('blue');
    expect(card.header.title.content).toContain('正在处理');
    expect(card.elements[0].content).toBe('**正在检查**');
    expect(card.elements[0].content).not.toContain('```');
  });

  it('完成态保留正文并显示回复对象落款', () => {
    const card: any = buildTerminalCard({
      body: '处理完成',
      status: 'completed',
      replySignature: '只读排查助手',
    }).payload;
    expect(card.header).toBeUndefined();
    expect(card.elements).toHaveLength(3);
    expect(card.elements[0].content).toBe('处理完成');
    expect(card.elements.at(-1).content).toContain('只读排查助手');
    expect(card.elements.at(-1).content).not.toContain('发送给');
  });

  it('思考完成后停止按钮不可点击', () => {
    const card: any = buildThinkingCard({
      url: 'http://console/terminal/lm-1',
      interruptSessionId: 'lm-1',
      status: 'completed',
      footer: '🪙 累计 Token ↑15K ↓3.5K',
    }).payload;
    expect(card.header.template).toBe('green');
    expect(card.elements[1].actions[0].text.content).toBe('打开思考过程');
    expect(card.elements[1].actions[0].multi_url.url).toBe('http://console/terminal/lm-1');
    expect(card.elements[1].actions[1].text.content).toBe('思考已完成');
    expect(card.elements[1].actions[1].disabled).toBe(true);
    expect(card.elements[1].actions[1].value).toEqual({ action: 'interrupt_thinking', sessionId: 'lm-1' });
    expect(card.elements[1].actions[1].behaviors).toEqual([
      { type: 'callback', value: { action: 'interrupt_thinking', sessionId: 'lm-1' } },
    ]);
    expect(card.elements[1].actions[1].multi_url).toBeUndefined();
    expect(card.elements.at(-1).content).toContain('累计 Token ↑15K ↓3.5K');
  });

  it('思考中可停止，停止后按钮不可点击', () => {
    const working: any = buildThinkingCard({
      url: 'http://console/terminal/lm-1',
      interruptSessionId: 'lm-1',
      status: 'working',
    }).payload;
    expect(working.elements[1].actions[1].text.content).toBe('停止思考');
    expect(working.elements[1].actions[1].type).toBe('danger');
    expect(working.elements[1].actions[1].disabled).toBe(false);
    expect(working.elements[1].actions[1].value).toEqual({ action: 'interrupt_thinking', sessionId: 'lm-1' });
    expect(working.elements[1].actions[1].behaviors).toEqual([
      { type: 'callback', value: { action: 'interrupt_thinking', sessionId: 'lm-1' } },
    ]);
    expect(working.elements[1].actions[1].multi_url).toBeUndefined();

    const stopped: any = buildThinkingCard({
      url: 'http://console/terminal/lm-1',
      interruptSessionId: 'lm-1',
      status: 'stopped',
    }).payload;
    expect(stopped.header.title.content).toBe('⏹️ 已停止思考');
    expect(stopped.elements[1].actions[1].text.content).toBe('思考已停止');
    expect(stopped.elements[1].actions[1].disabled).toBe(true);
  });
});
