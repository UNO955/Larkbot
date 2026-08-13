import { describe, it, expect } from 'vitest';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';

describe('TerminalRenderer', () => {
  it('普通文本渲染为视口快照', async () => {
    const r = new TerminalRenderer(80, 10);
    await r.writeAndFlush('hello world');
    const { content, changed } = r.snapshot();
    expect(content).toBe('hello world');
    expect(changed).toBe(true);
    r.dispose();
  });

  it('内容不变时 changed=false', async () => {
    const r = new TerminalRenderer(80, 10);
    await r.writeAndFlush('hello');
    expect(r.snapshot().changed).toBe(true);
    expect(r.snapshot().changed).toBe(false);
    r.dispose();
  });

  it('markNewTurn 重置 hash，下一帧一定 changed=true', async () => {
    const r = new TerminalRenderer(80, 10);
    await r.writeAndFlush('hello');
    r.snapshot();           // changed=true, 记 hash
    expect(r.snapshot().changed).toBe(false);
    r.markNewTurn();
    expect(r.snapshot().changed).toBe(true);
    r.dispose();
  });

  it('清屏后只保留最终视口内容（不累积旧帧）', async () => {
    const r = new TerminalRenderer(80, 10);
    await r.writeAndFlush('frame-A line1\r\nframe-A line2\r\n');
    await r.writeAndFlush('\x1b[2J\x1b[H');
    await r.writeAndFlush('frame-B only');
    const { content } = r.snapshot();
    expect(content).toContain('frame-B only');
    expect(content).not.toContain('frame-A');
    r.dispose();
  });

  it('消化 DECSCUSR 等光标形状噪音转义', async () => {
    const r = new TerminalRenderer(80, 10);
    await r.writeAndFlush('\x1b[0 qclean\x1b[0 q');
    expect(r.snapshot().content).toBe('clean');
    r.dispose();
  });

  it('去掉首尾空行', async () => {
    const r = new TerminalRenderer(80, 10);
    await r.writeAndFlush('\r\n\r\ncontent\r\n\r\n');
    expect(r.snapshot().content).toBe('content');
    r.dispose();
  });

  it('过滤裸提示符和输入回显行', async () => {
    const r = new TerminalRenderer(80, 10);
    await r.writeAndFlush('output line 1\r\n❯\r\noutput line 2\r\n');
    const { content } = r.snapshot();
    expect(content).toContain('output line 1');
    expect(content).toContain('output line 2');
    expect(content).not.toContain('❯');
    r.dispose();
  });

  it('cleanBoxDrawing 去除制表符', async () => {
    const r = new TerminalRenderer(80, 10);
    await r.writeAndFlush('╭─── header ───╮\r\n│  content   │\r\n╰──────────────╯');
    const { content } = r.snapshot();
    expect(content).not.toContain('╭');
    expect(content).not.toContain('│');
    expect(content).not.toContain('╰');
    expect(content).toContain('header');
    expect(content).toContain('content');
    r.dispose();
  });

  it('rawSnapshot 不过滤提示符', async () => {
    const r = new TerminalRenderer(80, 10);
    await r.writeAndFlush('❯\r\noutput');
    expect(r.rawSnapshot()).toContain('❯');
    expect(r.snapshot().content).not.toContain('❯');
    r.dispose();
  });

  it('writeAndFlush 等待 xterm 消费完再读', async () => {
    const r = new TerminalRenderer(80, 10);
    await r.writeAndFlush('FLUSHED');
    expect(r.rawSnapshot()).toContain('FLUSHED');
    r.dispose();
  });
});