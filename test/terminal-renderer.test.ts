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

  it('过滤 traex 启动信息、XML 输入回显和状态栏', async () => {
    const r = new TerminalRenderer(100, 20);
    r.markNewTurn();
    await r.writeAndFlush([
      ' directory: /repo',
      ' permissions: YOLO mode',
      ' Tip: hello',
      'background.',
      '▍ <larkbot_routing>',
      '▍ routing text',
      '▍ </larkbot_routing>',
      '▍ <user_message>',
      '▍ 你好',
      '▍ </user_message>',
      '◆ 你好，我在。',
      ' GPT-5.5 (MAX) xhigh · Context 100% left · /repo · Full Access',
    ].join('\r\n'));
    expect(r.snapshot().content).toBe('你好，我在。');
    r.dispose();
  });

  it('markNewTurn 后不展示上一轮已经滚出起点的内容', async () => {
    const r = new TerminalRenderer(30, 4);
    await r.writeAndFlush('old-1\r\nold-2\r\nold-3\r\n');
    r.markNewTurn();
    await r.writeAndFlush('◆ new answer');
    const content = r.snapshot().content;
    expect(content).toContain('new answer');
    expect(content).not.toContain('old-1');
    expect(content).not.toContain('old-2');
    r.dispose();
  });

  it('过滤 traex 暴露出的英文自述分析段，只保留最终回复', async () => {
    const r = new TerminalRenderer(100, 20);
    r.markNewTurn();
    await r.writeAndFlush([
      "I see the user greeted me with \"你好,\" which means \"hello\" in Chinese. Since I'm",
      'responding as a',
      "coding agent, there's no need for tools here, just a simple and direct reply in Chinese.",
      'I want to',
      "make sure my response feels friendly and welcoming. Let's go ahead and reply in",
      'Chinese!',
      '',
      '你好，我在。有什么需要我处理的？',
    ].join('\r\n'));
    expect(r.snapshot().content).toBe('你好，我在。有什么需要我处理的？');
    r.dispose();
  });

  it('把工具轨迹和分析过程拆到 trace，最终回复单独作为 answer', async () => {
    const r = new TerminalRenderer(120, 30);
    r.markNewTurn();
    await r.writeAndFlush([
      "Ran find ~/.larkbot -maxdepth 4 -type f 2>/dev/null | sed -n '1,200p'",
      ' /home/mengning.uno/.larkbot/sessions.json',
      '',
      'Read src/im/lark/client.ts (ctrl+o to expand)',
      '',
      '我找到了本机的 .larkbot 状态文件和飞书 app 凭证入口。现在会用飞书 API 直接拉取这条引用消息。',
      '',
      'Searched for "message.get|im.v1.message.get|/op…" in node-sdk, read 3 files (ctrl+o to expand)',
      '',
      "I want to make sure we're getting this right. The user mentioned a vague request, so I should ask for specifics.",
      '',
      '可以。你这条引用的是刚才的“你好”，里面没有具体问题内容。',
      '',
      '把要解决的事情直接发我就行。',
    ].join('\r\n'));
    const parts = r.snapshotParts();
    expect(parts.answer).toBe('可以。你这条引用的是刚才的“你好”，里面没有具体问题内容。\n\n把要解决的事情直接发我就行。');
    expect(parts.trace).toContain('Ran find');
    expect(parts.trace).toContain('I want to make sure');
    expect(r.snapshot().content).toBe('可以。你这条引用的是刚才的“你好”，里面没有具体问题内容。\n\n把要解决的事情直接发我就行。');
    r.dispose();
  });
});
