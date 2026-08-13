/**
 * 用 headless xterm 把 PTY 裸字节流渲染成「当前视口文本快照」。
 *
 * 为什么需要它：traex 是全屏 TUI，会用光标移动 / 清屏 / 重绘不断刷新同一块
 * 屏幕。直接把 PTY 流做正则 stripAnsi 再回贴，会把每一帧重绘都当成新文本，
 * 导致刷屏 + 乱码。
 *
 * 正确做法：把字节流喂给一个真正的终端模拟器（@xterm/headless），让它维护
 * 屏幕缓冲，只读「当前视口」上实际显示的字符。这样无论底层重绘多少次，
 * 拿到的都是一份干净、去重后的可读快照。
 */
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;
import { createHash } from 'node:crypto';

/** 去除制表符并把连续空格压缩。 */
function cleanBoxDrawing(line: string): string {
  return line
    .replace(/[─━│┌┐└┘├┤┬┴┼╭╮╯╰]/g, ' ')
    .replace(/  +/g, ' ')
    .trimEnd();
}

/** 裸提示符：❯ (Codex) 或 › (Aiden) 后跟可选空白 */
const BARE_PROMPT_RE = /^[›❯]\s*$/;
/** 输入回显：❯ 或 › 后跟用户输入 */
const INPUT_ECHO_RE = /^[›❯]\s+\S/;
/** 纯空白行 */
const BLANK_RE = /^\s*$/;

export class TerminalRenderer {
  private term: InstanceType<typeof Terminal>;
  private lastHash = '';

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
   * 喂入 PTY 输出并等待 xterm 消费完队列中所有字节。
   * 调用方在 write 后立即检查 buffer 时必须用此方法。
   */
  writeAndFlush(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.term.write(data, resolve);
      } catch (error) {
        reject(error);
      }
    });
  }

  /** 新一轮开始：重置变化检测 hash，确保下一帧快照被识别为 changed。 */
  markNewTurn(): void {
    this.lastHash = '';
  }

  /**
   * 读取当前视口快照，过滤提示符和输入回显行。
   * 返回 content 和 changed 标记（与上次快照对比）。
   */
  snapshot(): { content: string; changed: boolean } {
    const content = this.readViewport(true);
    const hash = createHash('md5').update(content).digest('hex');
    const changed = hash !== this.lastHash;
    this.lastHash = hash;
    return { content, changed };
  }

  /**
   * 原始视口快照，不过滤提示符。
   * 用于需要完整屏幕内容的场景（如 idle 检测）。
   */
  rawSnapshot(): string {
    return this.readViewport(false);
  }

  private readViewport(filter: boolean): string {
    const buf = this.term.buffer.active;
    const baseY = buf.baseY;
    const rows = this.term.rows;
    const endY = baseY + rows;

    const lines: string[] = [];
    for (let y = baseY; y < endY; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const s = cleanBoxDrawing(line.translateToString(true));
      if (filter && (BARE_PROMPT_RE.test(s) || INPUT_ECHO_RE.test(s))) continue;
      lines.push(s);
    }

    // 去掉首尾空行
    if (filter) {
      while (lines.length > 0 && BLANK_RE.test(lines[0])) lines.shift();
    }
    while (lines.length > 0 && BLANK_RE.test(lines[lines.length - 1])) lines.pop();

    return lines.join('\n');
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /** 暴露底层 xterm 实例，供截图等高级用途。 */
  get xterm(): InstanceType<typeof Terminal> { return this.term; }

  dispose(): void {
    this.term.dispose();
  }
}