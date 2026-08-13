/** 从环境变量（.env）加载全局配置。 */
import 'dotenv/config';

export interface Config {
  larkAppId: string;
  larkAppSecret: string;
  ownerOpenId: string;   // 白名单：只响应这个 open_id
  traexCwd: string;      // traex 执行工作目录
  consolePort: number;
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
    consolePort: Number(process.env.CONSOLE_PORT) || 8787,
  };
}
