/** 从环境变量（.env）加载全局配置。 */
import 'dotenv/config';

export interface Config {
  larkAppId: string;
  larkAppSecret: string;
  ownerOpenId: string;   // 管理者 open_id，默认也具备使用权限
  allowedOpenIds: string[]; // 额外允许直接提问 / 操作卡片的用户 open_id
  traexCwd: string;      // traex 执行工作目录
  consoleHost: string;
  consolePort: number;
  consolePublicUrl: string;
  argosUrlTemplate: string;
  sessionIdleCloseMs: number;
  sessionClosedRetentionMs: number;
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
    allowedOpenIds: parseList(process.env.ALLOWED_OPEN_IDS),
    traexCwd: process.env.TRAEX_CWD?.trim() || process.cwd(),
    consoleHost: process.env.CONSOLE_HOST?.trim() || '127.0.0.1',
    consolePort: Number(process.env.CONSOLE_PORT) || 8787,
    consolePublicUrl: process.env.CONSOLE_PUBLIC_URL?.trim() || `http://127.0.0.1:${Number(process.env.CONSOLE_PORT) || 8787}`,
    argosUrlTemplate: process.env.ARGOS_URL_TEMPLATE?.trim() || 'https://cloud.bytedance.net/argos/streamlog/info_overview/log_id_search?data_source_uid=&logId={logid}&log_search=false&psm={psm}&psmList=&region=China-North&x-bc-region-id=bytedance&x-resource-account=public',
    sessionIdleCloseMs: readDurationMs('SESSION_IDLE_CLOSE_HOURS', 72, 60 * 60 * 1000),
    sessionClosedRetentionMs: readDurationMs('SESSION_CLOSED_RETENTION_DAYS', 7, 24 * 60 * 60 * 1000),
  };
}

function parseList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return [...new Set(value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
}

function readDurationMs(name: string, defaultValue: number, unitMs: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue * unitMs;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return defaultValue * unitMs;
  return value * unitMs;
}
