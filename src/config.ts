/** 从环境变量（.env）加载全局配置。 */
import 'dotenv/config';

export interface Config {
  larkAppId: string;
  larkAppSecret: string;
  ownerOpenId: string;   // 白名单：只响应这个 open_id
  traexCwd: string;      // traex 执行工作目录
  consoleHost: string;
  consolePort: number;
  consolePublicUrl: string;
  sessionIdleCloseMs: number;
  sessionClosedRetentionMs: number;
  sessionCleanupIntervalMs: number;
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`缺少必需的环境变量 ${name}（见 .env.example）`);
  return v;
}

export function loadConfig(): Config {
  return {
    larkAppId: required('LARK_APP_ID'),
    larkAppSecret: required('LARK_APP_SECRET'),
    ownerOpenId: required('OWNER_OPEN_ID'),
    traexCwd: process.env.TRAEX_CWD?.trim() || process.cwd(),
    consoleHost: process.env.CONSOLE_HOST?.trim() || '127.0.0.1',
    consolePort: Number(process.env.CONSOLE_PORT) || 8787,
    consolePublicUrl: process.env.CONSOLE_PUBLIC_URL?.trim() || `http://127.0.0.1:${Number(process.env.CONSOLE_PORT) || 8787}`,
    sessionIdleCloseMs: readDurationMs('SESSION_IDLE_CLOSE_HOURS', 24, 60 * 60 * 1000),
    sessionClosedRetentionMs: readDurationMs('SESSION_CLOSED_RETENTION_DAYS', 7, 24 * 60 * 60 * 1000),
    sessionCleanupIntervalMs: readDurationMs('SESSION_CLEANUP_INTERVAL_MINUTES', 10, 60 * 1000),
  };
}

function readDurationMs(name: string, defaultValue: number, unitMs: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue * unitMs;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return defaultValue * unitMs;
  return value * unitMs;
}
