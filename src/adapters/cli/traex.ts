/**
 * traex 的 CliAdapter 实现。
 *
 * traex 屏幕层没有 completionPattern，一轮结束完全靠 IdleDetector 的
 * quiescence（静默）+ spinner guard + readyPattern gate 三重启发式判定。
 */
import { realpathSync } from 'node:fs';
import type { CliAdapter, SpawnSpec } from './types.js';

export function createTraexAdapter(): CliAdapter {
  return {
    id: 'traex',

    spawnSpec(cwd: string): SpawnSpec {
      // 远程开发机的登录 shell PATH 常不含 ~/.local/bin，裸 'traex' 会 spawn 失败。
      // 允许用 TRAEX_BIN 指定可执行文件的绝对路径（如
      // /home/you/.local/share/traex/current/traex），缺省回落到 PATH 里的 'traex'。
      const bin = process.env.TRAEX_BIN?.trim() || 'traex';

      // traex 首次进入一个目录会弹 "Do you trust the contents of this
      // directory?" 的 folder-trust 界面（`❯ 1. Yes 2. No`）。远程遥控没有人去
      // 手动按 1，会卡住整条队列。
      //
      // 注意：`--dangerously-bypass-approvals-and-sandbox` 只跳过“命令执行”的
      // approval/sandbox，并不跳过 folder trust——后者是按目录持久化在
      // traecli.toml 的独立门（[projects."<dir>"].trust_level）。所以这里直接用
      // `-c` 把当前目录的 trust_level 注入为 trusted，从根上不弹 trust 界面。
      //
      // traex 内部用 realpath 归一化目录 key（如 /home→/data00/home 软链），
      // 因此 key 必须用规范化后的真实路径，否则匹配不上、trust 仍会弹。
      let trustPath = cwd;
      try {
        trustPath = realpathSync(cwd);
      } catch {
        // cwd 尚不存在等边界情况：回落到原始路径，不阻断启动。
      }

      // TRAEX_SANDBOX=1 时保守回退：既不注入 trust 也不 bypass，交由人工过 trust。
      const bypass = process.env.TRAEX_SANDBOX?.trim() !== '1';
      const args = [
        ...(bypass
          ? [
              '-c',
              `projects.${JSON.stringify(trustPath)}.trust_level="trusted"`,
              '--dangerously-bypass-approvals-and-sandbox',
            ]
          : []),
        // 关掉备用屏，避免全屏 TUI 的光标/清屏转义污染回贴文本。
        '--no-alt-screen',
      ];

      return {
        command: bin,
        args,
        cwd,
        env: {
          ...process.env as Record<string, string>,
          TERM: 'xterm-256color',
        },
      };
    },

    // traex 的 ❯ 提示符嵌在状态栏中间（`──────❯ 你好呀──────`），不在行首。
// 只能匹配 ❯/› 本身，用负向前瞻排除 trust 菜单的 `❯ 1.` 行。
readyPattern: /[›❯](?!\s*\d+\.)/,

    // traex 无显式完成标记。
    completionPattern: undefined,
  };
}
