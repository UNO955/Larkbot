/**
 * traex 的 CliAdapter 实现。
 *
 * traex 屏幕层没有 completionPattern，一轮结束完全靠 IdleDetector 的
 * quiescence（静默）+ spinner guard + readyPattern gate 三重启发式判定。
 */
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
      // directory?" 的 trust 确认界面（`❯ 1. Yes 2. No`）。远程遥控没有人去
      // 手动按 1，会卡住整条队列，所以默认用 codex 家族的启动参数直接跳过
      // trust + sandbox；设 TRAEX_SANDBOX=1 可关掉 bypass（保守回退，需人工过 trust）。
      // --no-alt-screen 关掉备用屏，避免全屏 TUI 的光标/清屏转义污染回贴文本。
      const bypass = process.env.TRAEX_SANDBOX?.trim() !== '1';
      const args = [
        ...(bypass ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
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

    // traex 同时出现过 Codex 风格的 `›` 和 Claude 风格的 `❯` 提示符，
    // 并会渲染 "Context 100% left" 状态栏。启动的 trust/选择器界面用 `❯ 1.`
    // 作为菜单光标，必须排除带数字的选择行，否则会把首条消息误投进选择界面。
    readyPattern: /(?:^|[\n\r])\s*[›❯](?!\s*\d+\.)|\d+% left/,

    // traex 无显式完成标记。
    completionPattern: undefined,
  };
}
