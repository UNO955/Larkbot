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
const ENVELOPE_ECHO_RE = /^\s*▍/;
const XML_ENVELOPE_RE = /^\s*<\/?(?:larkbot_routing|larkbot_reminder|larkbot_evidence|session_id|system_prompt_profile|user_message|sender|attachments|quoted_message)\b/i;
const LARKBOT_EVIDENCE_RE = /<larkbot_evidence\b[^>]*>[\s\S]*?<\/larkbot_evidence>/gi;
const TRAEX_NOISE_RES = [
  /TraeCode CLI/i,
  /^\s*Good (?:morning|afternoon|evening)/i,
  /^\s*(?:model|directory|permissions):\s/i,
  /^\s*Tip:\s/i,
  /^\s*(?:the\s+)?background\.\s*$/i,
  /Context \d+% left/i,
  /Full Access(?:\s|\(|$)/i,
  /Working…|esc to interrupt/i,
  /^\s*[▄▀█]+\s*$/,
  /^\s*█\s*◆\s*◆\s*█\s*$/,
];
const TOOL_TRACE_RE = /^(?:Ran|Read|Searched for|Edited|Wrote|Opened|Listed|Globbed|Grep|Fetched|Called|Running)\b/i;
const TOOL_TRACE_CONTINUATION_RE = /^\s+(?:\/|[A-Za-z0-9_.-]+\/|[A-Za-z]:\\|~\/)/;
const THINKING_RE = /\b(?:I see the user|I want to|I think|I should|I shouldn't|I need to|I'll|Let's|we're getting this right|The user mentioned|it’s best to|it's best to)\b/i;

export class TerminalRenderer {
  private term: InstanceType<typeof Terminal>;
  private lastHash = '';
  private lastPartsHash = '';
  private turnStartY: number | undefined;

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

  /** 新一轮开始：记录当前终端行，只展示本轮之后产生的内容。 */
  markNewTurn(): void {
    this.lastHash = '';
    this.lastPartsHash = '';
    const buf = this.term.buffer.active;
    this.turnStartY = buf.baseY + buf.cursorY;
  }

  /**
   * 读取当前视口快照，过滤提示符和输入回显行。
   * 返回 content 和 changed 标记（与上次快照对比）。
   */
  snapshot(): { content: string; changed: boolean } {
    const content = this.snapshotParts().answer;
    const hash = createHash('md5').update(content).digest('hex');
    const changed = hash !== this.lastHash;
    this.lastHash = hash;
    return { content, changed };
  }

  snapshotParts(): { answer: string; trace: string; changed: boolean } {
    const projected = projectVisibleContent(this.readViewport(true, this.turnStartY));
    const hash = createHash('md5').update(`${projected.answer}\0${projected.trace}`).digest('hex');
    const changed = hash !== this.lastPartsHash;
    this.lastPartsHash = hash;
    return { ...projected, changed };
  }

  /**
   * 原始视口快照，不过滤提示符。
   * 用于需要完整屏幕内容的场景（如 idle 检测）。
   */
  rawSnapshot(): string {
    return this.readViewport(false);
  }

  private readViewport(filter: boolean, requestedStartY?: number): string {
    const buf = this.term.buffer.active;
    const baseY = buf.baseY;
    const rows = this.term.rows;
    const endY = baseY + rows;
    const startY = Math.max(baseY, requestedStartY ?? baseY);

    const lines: string[] = [];
    let hiddenEvidenceBlock = false;
    for (let y = startY; y < endY; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const s = cleanBoxDrawing(line.translateToString(true));
      if (filter) {
        if (hiddenEvidenceBlock) {
          if (/<\/larkbot_evidence>/i.test(s)) hiddenEvidenceBlock = false;
          continue;
        }
        if (/<larkbot_evidence\b/i.test(s)) {
          hiddenEvidenceBlock = !/<\/larkbot_evidence>/i.test(s);
          continue;
        }
      }
      if (filter && isDisplayNoise(s)) continue;
      lines.push(s);
    }

    // 去掉首尾空行
    if (filter) {
      for (let i = 0; i < lines.length; i++) {
        lines[i] = lines[i].replace(/^\s*[◆◇✦✧◈❖⋄]\s+/, '');
      }
      while (lines.length > 0 && BLANK_RE.test(lines[0])) lines.shift();
    }
    while (lines.length > 0 && BLANK_RE.test(lines[lines.length - 1])) lines.pop();

    return lines.join('\n').trim();
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

function isDisplayNoise(line: string): boolean {
  return BARE_PROMPT_RE.test(line)
    || INPUT_ECHO_RE.test(line)
    || ENVELOPE_ECHO_RE.test(line)
    || XML_ENVELOPE_RE.test(line)
    || TRAEX_NOISE_RES.some((pattern) => pattern.test(line));
}

function projectVisibleContent(content: string): { answer: string; trace: string } {
  const trimmed = content.replace(LARKBOT_EVIDENCE_RE, '').trim();
  if (!trimmed) return { answer: '', trace: '' };

  const paragraphs = trimmed.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return { answer: '', trace: '' };

  const internal = paragraphs.map(isInternalTraceParagraph);
  const hasInternal = internal.some(Boolean);
  if (!hasInternal) return { answer: trimmed, trace: '' };

  let lastInternalIndex = -1;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    if (internal[i]) {
      lastInternalIndex = i;
      break;
    }
  }
  const answerParagraphs = paragraphs.slice(lastInternalIndex + 1).filter((paragraph) => !isInternalTraceParagraph(paragraph));
  if (answerParagraphs.length === 0) return { answer: '', trace: trimmed };

  return {
    answer: answerParagraphs.join('\n\n').trim(),
    trace: paragraphs.slice(0, lastInternalIndex + 1).join('\n\n').trim(),
  };
}

function isInternalTraceParagraph(paragraph: string): boolean {
  const rawLines = paragraph.split('\n');
  const lines = rawLines.map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  const text = lines.join(' ');
  return THINKING_RE.test(text)
    || lines.some((line) => TOOL_TRACE_RE.test(line))
    || rawLines.every((line) => TOOL_TRACE_CONTINUATION_RE.test(line))
    || lines.every((line) => /^\(?ctrl\+o to expand\)?$/i.test(line));
}
