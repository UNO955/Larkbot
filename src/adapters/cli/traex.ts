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
      return {
        command: 'traex',
        args: [],
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
