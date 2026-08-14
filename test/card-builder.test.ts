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

  it('完成态只保留正文，不渲染底部状态栏', () => {
    const card: any = buildTerminalCard({
      body: '处理完成',
      status: 'completed',
    }).payload;
    expect(card.header).toBeUndefined();
    expect(card.elements).toHaveLength(1);
    expect(card.elements[0].content).toBe('处理完成');
  });

  it('思考卡可在底部展示累计 token', () => {
    const card: any = buildThinkingCard({
      url: 'http://console/terminal/lm-1',
      status: 'completed',
      footer: '🪙 累计 Token ↑15K ↓3.5K',
    }).payload;
    expect(card.header.template).toBe('green');
    expect(card.elements.at(-1).content).toContain('累计 Token ↑15K ↓3.5K');
  });
});
