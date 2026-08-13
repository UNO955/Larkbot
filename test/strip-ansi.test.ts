import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../src/core/session-manager.js';

describe('stripAnsi', () => {
  it('去除 CSI/SGR 颜色序列', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('去除以 BEL 结尾的 OSC 序列', () => {
    expect(stripAnsi('\x1b]0;title\x07hello')).toBe('hello');
  });

  // 真机联调回归：traex 首屏发色彩查询 OSC 10/11，以 ST(ESC \) 结尾，
  // 早先 stripAnsi 只匹配 BEL 结尾，导致 `]10;?\]11;?\` 残留进回贴文本。
  it('去除以 ST(ESC \\) 结尾的 OSC 序列（traex 色彩查询）', () => {
    const raw = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\> ready';
    expect(stripAnsi(raw)).toBe('> ready');
  });

  it('去除字符集选择序列', () => {
    expect(stripAnsi('\x1b(Btext')).toBe('text');
  });

  it('保留普通文本不变', () => {
    expect(stripAnsi('plain text 123')).toBe('plain text 123');
  });
});
