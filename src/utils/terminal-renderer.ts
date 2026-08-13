/**
 * 用 headless xterm 把 PTY 裸字节流渲染成「整屏文本快照」。
 *
 * 为什么需要它：traex 是全屏 TUI，会用光标移动 / 清屏 / 重绘（logo、边框、
 * 状态栏、光标形状 DECSCUSR `[0 q` 等）不断刷新同一块屏幕。直接把 PTY 流做
 * 正则 stripAnsi 再回贴，会把每一帧重绘都当成新文本，导致刷屏 + 乱码。
 *
 * 正确做法：把字节流喂给一个真正的终端模拟器（@xterm/headless），让它维护
 * 屏幕缓冲，我们只读「当前屏幕上实际显示的字符」。这样无论底层重绘多少次，
 * 拿到的都是一份干净、去重后的可读快照。
 */
import { Terminal } from '@xterm/headless';

export class TerminalRenderer {
  private term: Terminal;

  constructor(cols = 100, rows = 30) {
    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 1000,
    });
  }

  /** 喂入一段 PTY 输出。 */
  write(data: string): void {
    this.term.write(data);
  }

  /**
   * 读取当前屏幕快照（含 scrollback 内已滚出的行），逐行 trimEnd 后拼接，
   * 去掉首尾空行。返回适合回贴的纯文本。
   */
  snapshot(): string {
    const buf = this.term.buffer.active;
    const total = buf.length;                 // scrollback + viewport 总行数
    const lines: string[] = [];
    for (let y = 0; y < total; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true).replace(/\s+$/u, '') : '');
    }
    // 去掉整体首尾空行，保留中间结构
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start] === '') start++;
    while (end > start && lines[end - 1] === '') end--;
    return lines.slice(start, end).join('\n');
  }

  dispose(): void {
    this.term.dispose();
  }
}
