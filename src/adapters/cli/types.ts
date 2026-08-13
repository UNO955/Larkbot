/**
 * CLI 抽象层。
 *
 * v1 只有 traex 实现，但把「怎么启动这个 CLI」「如何判定它一轮结束（idle）」
 * 收进接口 —— 后续可接 codex / claude 而不改会话调度逻辑。
 */
import type { IPty } from 'node-pty';

export type CliId = 'traex';

export interface SpawnSpec {
  command: string;      // 可执行文件，如 'traex'
  args: string[];       // 启动参数
  cwd: string;          // 工作目录
  env?: Record<string, string>;
}

export interface SpawnOptions {
  resumeSessionId?: string;
}

export interface SubmitResult {
  submitted: boolean;
  cliSessionId?: string;
}

export interface CliAdapter {
  id: CliId;

  /** 返回拉起该 CLI 的 PTY spawn 规格。 */
  spawnSpec(cwd: string, options?: SpawnOptions): SpawnSpec;

  /** 原子提交一轮输入；多行内容不能被拆成多个 turn。 */
  writeInput(pty: IPty, content: string): Promise<SubmitResult>;

  /** 用 larkmux session id 从 CLI 原生记录反查会话 id。 */
  findSessionId(sessionId: string): string | undefined;

  /**
   * 输入提示符（composer）渲染出来的特征。IdleDetector 用它做 gate：
   * 设了该正则时，提示符出现前不判 idle（每轮 reset 后重新等待），
   * 避免「屏幕暂时不动但其实还没回到可输入态」被误判为空闲。
   */
  readyPattern?: RegExp;

  /**
   * CLI 明确的「完成标记」（如 Claude 的 "✳ Worked for 5s"）。
   * 命中即走快速确认路径判 idle。traex 没有，留空 → 纯靠 quiescence + readyPattern。
   */
  completionPattern?: RegExp;
}
