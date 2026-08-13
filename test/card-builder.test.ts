import { describe, expect, it } from 'vitest';
import { buildTerminalCard } from '../src/im/lark/card-builder.js';

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

  it('完成态原地显示绿色状态', () => {
    const card: any = buildTerminalCard({
      body: '处理完成',
      status: 'completed',
    }).payload;
    expect(card.header.template).toBe('green');
    expect(card.header.title.content).toContain('已完成');
  });
});
