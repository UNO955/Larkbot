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
  };
}
