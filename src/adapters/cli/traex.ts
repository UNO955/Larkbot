/**
 * traex 的 CliAdapter 实现。
 *
 * traex 屏幕层没有 completionPattern，一轮结束完全靠 IdleDetector 的
 * quiescence（静默）+ spinner guard + readyPattern gate 三重启发式判定。
 */
import {
  closeSync,
  existsSync,
  readdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliAdapter, SessionFinalMessage, SessionTokenUsage, SpawnSpec } from './types.js';

export function createTraexAdapter(): CliAdapter {
  return {
    id: 'traex',

    spawnSpec(cwd: string, options): SpawnSpec {
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
        ...(options?.resumeSessionId ? ['resume'] : []),
        ...(bypass
          ? [
              '-c',
              `projects.${JSON.stringify(trustPath)}.trust_level="trusted"`,
              '--dangerously-bypass-approvals-and-sandbox',
              '--dangerously-bypass-hook-trust',
            ]
          : []),
        // 关掉备用屏，避免全屏 TUI 的光标/清屏转义污染回贴文本。
        '--no-alt-screen',
        ...(options?.resumeSessionId ? [options.resumeSessionId] : []),
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

    async writeInput(pty, content) {
      const historyPath = traeHistoryPath();
      const baseByte = fileSize(historyPath);
      try {
        pty.write(`\x1b[200~${content}\x1b[201~`);
        await delay(200);
        pty.write('\r');
      } catch {
        return { submitted: false };
      }

      for (let attempt = 0; attempt < 20; attempt++) {
        await delay(500);
        const cliSessionId = findHistoryMatch(historyPath, baseByte, content);
        if (cliSessionId) return { submitted: true, cliSessionId };
      }
      return { submitted: false };
    },

    findSessionId(sessionId: string): string | undefined {
      const path = traeHistoryPath();
      if (!existsSync(path)) return undefined;
      try {
        const content = readFileSync(path, 'utf8');
        const marker = `<session_id>${sessionId}</session_id>`;
        for (const line of content.trimEnd().split('\n').reverse()) {
          try {
            const entry = JSON.parse(line);
            if (typeof entry?.text === 'string'
              && entry.text.includes(marker)
              && typeof entry?.session_id === 'string') {
              return entry.session_id;
            }
          } catch {
            // 忽略并发写入留下的半行或旧格式行。
          }
        }
      } catch {
        return undefined;
      }
      return undefined;
    },

    getSessionUsage(cliSessionId: string): SessionTokenUsage | undefined {
      const rolloutPath = findTraexRolloutPath(cliSessionId);
      return rolloutPath ? readTraexSessionUsage(rolloutPath) : undefined;
    },

    getSessionFinal(cliSessionId: string): SessionFinalMessage | undefined {
      const rolloutPath = findTraexRolloutPath(cliSessionId);
      return rolloutPath ? readTraexSessionFinal(rolloutPath) : undefined;
    },

    // traex 的 ❯ 提示符嵌在状态栏中间（`──────❯ 你好呀──────`），不在行首。
    // 只匹配 ❯/› 本身，用负向前瞻排除 trust 菜单的 `❯ 1.` 行。
    readyPattern: /[›❯](?!\s*\d+\.)/,

    // traex 无显式完成标记。
    completionPattern: undefined,
  };
}

function traeHistoryPath(): string {
  const home = process.env.TRAE_HOME?.trim() || join(homedir(), '.trae');
  return join(home, 'cli', 'history.jsonl');
}

function traeSessionsDir(): string {
  const home = process.env.TRAE_HOME?.trim() || join(homedir(), '.trae');
  return join(home, 'cli', 'sessions');
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function findHistoryMatch(path: string, fromByte: number, expectedText: string): string | undefined {
  const size = fileSize(path);
  if (size <= fromByte) return undefined;
  const buffer = Buffer.alloc(size - fromByte);
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    readSync(fd, buffer, 0, buffer.length, fromByte);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  const delta = buffer.toString('utf8');
  const lines = delta.endsWith('\n') ? delta.split('\n') : delta.split('\n').slice(0, -1);
  const expected = normalizeText(expectedText);
  for (const line of lines) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.text === 'string'
        && normalizeText(entry.text) === expected
        && typeof entry?.session_id === 'string') {
        return entry.session_id;
      }
    } catch {
      // 忽略不完整行。
    }
  }
  return undefined;
}

function findTraexRolloutPath(cliSessionId: string): string | undefined {
  const root = traeSessionsDir();
  if (!existsSync(root)) return undefined;
  const matches: { path: string; mtimeMs: number }[] = [];
  try {
    walkSessionFiles(root, (path) => {
      if (!path.endsWith('.jsonl')) return;
      if (!path.includes(cliSessionId)) return;
      try {
        matches.push({ path, mtimeMs: statSync(path).mtimeMs });
      } catch {
        // Ignore files that disappear while scanning.
      }
    });
  } catch {
    return undefined;
  }
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.path;
}

function walkSessionFiles(dir: string, onFile: (path: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSessionFiles(path, onFile);
    } else if (entry.isFile()) {
      onFile(path);
    }
  }
}

function readTraexSessionUsage(path: string): SessionTokenUsage | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const content = readFileSync(path, 'utf8');
    let latest: SessionTokenUsage | undefined;
    let model = '';
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const nextModel = extractModel(entry);
      if (nextModel) model = nextModel;
      const usage = extractTokenCountUsage(entry);
      if (usage) latest = { ...usage, model: model || usage.model };
    }
    return latest;
  } catch {
    return undefined;
  }
}

function readTraexSessionFinal(path: string): SessionFinalMessage | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const content = readFileSync(path, 'utf8');
    let latest: SessionFinalMessage | undefined;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const final = extractTaskCompleteFinal(entry);
      if (final) latest = final;
    }
    return latest;
  } catch {
    return undefined;
  }
}

function extractTaskCompleteFinal(entry: any): SessionFinalMessage | undefined {
  if (entry?.type !== 'event_msg' || entry?.payload?.type !== 'task_complete') return undefined;
  const turnId = entry.payload?.turn_id;
  if (typeof turnId !== 'string' || !turnId.trim()) return undefined;
  const text = typeof entry.payload?.last_agent_message === 'string'
    ? entry.payload.last_agent_message.trim()
    : '';
  if (!text || isEmptyFinalSentinel(text)) return undefined;
  const completedAt = typeof entry.payload?.completed_at === 'string' ? entry.payload.completed_at : '';
  const timestamp = typeof entry?.timestamp === 'string' ? entry.timestamp : '';
  return {
    key: `${turnId}:${completedAt || timestamp}`,
    text,
  };
}

function isEmptyFinalSentinel(text: string): boolean {
  return text === 'BOTMUX_NOTHING_TO_SEND';
}

function extractModel(entry: any): string {
  const candidates = [
    entry?.model,
    entry?.payload?.model,
    entry?.payload?.collaboration_mode?.settings?.model,
    entry?.message?.model,
    entry?.response?.model,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function extractTokenCountUsage(entry: any): SessionTokenUsage | undefined {
  if (entry?.type !== 'event_msg' || entry?.payload?.type !== 'token_count') return undefined;
  const usage = entry.payload?.info?.total_token_usage;
  if (!usage || typeof usage !== 'object') return undefined;

  const inputTokens = pickNum(usage, ['input_tokens', 'inputTokens']);
  const outputTokens = pickNum(usage, ['output_tokens', 'outputTokens']);
  const cacheReadTokens = pickNum(usage, ['cached_input_tokens', 'cachedInputTokens', 'cache_read_input_tokens', 'cacheReadInputTokens']);
  const cacheCreateTokens = pickNum(usage, ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'cache_write_input_tokens', 'cacheWriteInputTokens']);
  if (inputTokens <= 0 && outputTokens <= 0 && cacheReadTokens <= 0 && cacheCreateTokens <= 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    model: extractModel(entry),
  };
}

function pickNum(obj: any, keys: string[]): number {
  if (!obj || typeof obj !== 'object') return 0;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  }
  return 0;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
