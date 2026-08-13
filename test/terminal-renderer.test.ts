import { describe, it, expect } from 'vitest';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';

describe('TerminalRenderer', () => {
  it('把普通文本渲染成快照', () => {
    const r = new TerminalRenderer(80, 10);
    r.write('hello world');
    expect(r.snapshot()).toBe('hello world');
    r.dispose();
  });

  it('吸收全屏重绘：清屏后只保留最终内容（不累积每帧）', () => {
    const r = new TerminalRenderer(80, 10);
    r.write('frame-A line1\r\nframe-A line2\r\n');
    r.write('\x1b[2J\x1b[H');
    r.write('frame-B only');
    const snap = r.snapshot();
    expect(snap).toContain('frame-B only');
    expect(snap).not.toContain('frame-A');
    r.dispose();
  });

  it('消化光标形状 DECSCUSR 等噪音转义（[0 q 不进快照）', () => {
    const r = new TerminalRenderer(80, 10);
    r.write('\x1b[0 qclean\x1b[0 q');
    expect(r.snapshot()).toBe('clean');
    r.dispose();
  });

  it('去掉首尾空行', () => {
    const r = new TerminalRenderer(80, 10);
    r.write('\r\n\r\ncontent\r\n\r\n');
    expect(r.snapshot()).toBe('content');
    r.dispose();
  });
});
