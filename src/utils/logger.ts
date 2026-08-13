/** 极简分级日志：带时间戳，统一前缀。 */
type Level = 'info' | 'warn' | 'error';

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(level: Level, msg: string): void {
  const line = `[${ts()}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (msg: string) => log('info', msg),
  warn: (msg: string) => log('warn', msg),
  error: (msg: string) => log('error', msg),
};
