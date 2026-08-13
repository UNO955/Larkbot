/**
 * Idle 检测：判定一个交互式 CLI（traex）是否「一轮结束、回到等待输入」。
 *
 * 屏幕层没有可靠的完成标记，只能靠启发式，核心是三重判据，缺一会误判：
 *   1) quiescence —— PTY 输出静默 ≥ QUIESCENCE_MS
 *   2) spinner guard —— 最近 SPINNER_GUARD_MS 内见过 spinner 就不判 idle（防思考期误判）
 *   3) readyPattern gate —— 设了提示符正则时，提示符出现前不判 idle（每轮 reset 重新等待）
 * 匹配前必须剥 ANSI，并只保留输出尾部 500 字符。
 *
 * 另外保留 fireIdle(external) 作为「权威信号」通道：屏幕启发式终究是概率判断，
 * 后续可接 traex rollout 的 task_complete 事件作为确定性的一轮结束信号。
 */
import type { CliAdapter } from '../adapters/cli/types.js';
import { logger } from './logger.js';

export type IdleEvidenceSource = 'screen' | 'external';

/** Spinner 帧字符（Claude / Gemini braille / 进度条），CLI 工作时会动。 */
const SPINNER_RE = /[·✢✳✶✻✽⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏■⬝]/;

const QUIESCENCE_MS = 2_000;      // 静默多久算候选 idle
const SPINNER_GUARD_MS = 3_000;   // 最近见过 spinner 的抑制窗口
const COMPLETION_CONFIRM_MS = 500; // 命中完成标记后的确认延时

export class IdleDetector {
  private outputTail = '';
  private lastSpinnerAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private isIdle = false;
  private idleCallback: ((source: IdleEvidenceSource) => void) | null = null;
  private readonly completionPattern?: RegExp;
  private readonly readyPattern?: RegExp;
  private readySeen = false;

  constructor(cli: CliAdapter) {
    this.completionPattern = cli.completionPattern;
    this.readyPattern = cli.readyPattern;
  }

  onIdle(cb: (source: IdleEvidenceSource) => void): void {
    this.idleCallback = cb;
  }

  /** 喂入一段原始 PTY 输出。 */
  feed(data: string): void {
    // 已 idle 后再来数据 = 新一轮（本地输入等也能重新走 idle）
    if (this.isIdle) {
      this.isIdle = false;
      this.outputTail = '';
      this.readySeen = false;
      this.lastSpinnerAt = Date.now();
    }

    const stripped = this.stripAnsi(data);
    this.outputTail = (this.outputTail + stripped).slice(-500);

    // 提示符出现 → 记 readySeen（当前 chunk 和 tail 都查，避免被状态栏挤出窗口）
    if (this.readyPattern && (this.readyPattern.test(stripped) || this.readyPattern.test(this.outputTail))) {
      if (!this.readySeen) {
        logger.info(`[idle] readySeen ← true (stripped=${JSON.stringify(stripped.slice(0, 80))})`);
      }
      this.readySeen = true;
    }

    // spinner 追踪：完成标记的一部分不算，readySeen 之后的状态栏字符也不算
    const isCompletion = this.completionPattern?.test(stripped) || this.completionPattern?.test(this.outputTail);
    if (SPINNER_RE.test(stripped) && !isCompletion && !this.readySeen) {
      this.lastSpinnerAt = Date.now();
    }

    // Strategy 1：完成标记 → 短延时确认后判 idle
    if (isCompletion) {
      this.clearTimer();
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.isIdle) this.markIdle('screen');
      }, COMPLETION_CONFIRM_MS);
      return;
    }

    // Strategy 2：quiescence。设了 readyPattern 时，提示符出现前不启动静默判定。
    if (this.readyPattern && !this.readySeen) return;

    this.clearTimer();
    this.timer = setTimeout(() => this.quiescenceCheck(), QUIESCENCE_MS);
  }

  /** 提交新输入前调用：清证据、重新武装。 */
  reset(): void {
    this.isIdle = false;
    this.outputTail = '';
    this.readySeen = false;
    this.lastSpinnerAt = Date.now();
    this.clearTimer();
  }

  /** 权威外部信号（如 transcript task_complete）直接判 idle，绕过屏幕启发式。一轮内幂等。 */
  fireIdle(): void {
    if (this.isIdle) return;
    this.markIdle('external');
  }

  dispose(): void {
    this.clearTimer();
    this.idleCallback = null;
  }

  private quiescenceCheck(): void {
    this.timer = null;
    if (this.isIdle) return;
    const sinceSpinner = Date.now() - this.lastSpinnerAt;
    if (sinceSpinner < SPINNER_GUARD_MS) {
      // spinner 抑制未过：等到窗口结束再复查（+200ms 余量）
      this.timer = setTimeout(() => this.quiescenceCheck(), SPINNER_GUARD_MS - sinceSpinner + 200);
      return;
    }
    this.markIdle('screen');
  }

  private markIdle(source: IdleEvidenceSource): void {
    this.isIdle = true;
    this.outputTail = '';
    this.clearTimer();
    this.idleCallback?.(source);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private stripAnsi(str: string): string {
    return str
      .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Number(n) || 1))
      .replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x1b\[[?]?[0-9;]*[hlmsuJ]/g, '');
  }
}
