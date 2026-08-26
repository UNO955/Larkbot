/** 极简分级日志：带时间戳，统一前缀。 */
import { randomUUID } from 'node:crypto';
import type { SessionStore } from '../core/store.js';
import type { AppLogCategory, AppLogLevel, AppLogRecord } from '../core/types.js';

type Level = AppLogLevel;

export interface LogContext {
  category?: AppLogCategory;
  sessionId?: string;
  ticketId?: string;
  turnId?: string;
  traceEventId?: string;
  requestId?: string;
  data?: Record<string, unknown>;
}

let appLogStore: Pick<SessionStore, 'appendAppLog'> | undefined;
let pendingAppLogWrite: Promise<void> = Promise.resolve();

export function configureAppLogger(store: Pick<SessionStore, 'appendAppLog'> | undefined): void {
  appLogStore = store;
}

export async function flushAppLogger(): Promise<void> {
  await pendingAppLogWrite.catch(() => undefined);
}

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(level: Level, msg: string, context: LogContext = {}): void {
  const line = `[${ts()}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  appendStructuredLog(level, msg, context);
}

export const logger = {
  info: (msg: string, context?: LogContext) => log('info', msg, context),
  warn: (msg: string, context?: LogContext) => log('warn', msg, context),
  error: (msg: string, context?: LogContext) => log('error', msg, context),
};

function appendStructuredLog(level: Level, message: string, context: LogContext): void {
  if (!appLogStore?.appendAppLog) return;
  const createdAt = new Date().toISOString();
  const record: AppLogRecord = {
    id: createLogId(createdAt),
    level,
    category: context.category ?? 'system',
    message,
    sessionId: context.sessionId,
    ticketId: context.ticketId,
    turnId: context.turnId,
    traceEventId: context.traceEventId,
    requestId: context.requestId,
    data: context.data,
    createdAt,
  };
  pendingAppLogWrite = pendingAppLogWrite
    .catch(() => undefined)
    .then(() => appLogStore?.appendAppLog?.(record))
    .catch((error) => {
      console.warn(`[${ts()}] WARN  app log write failed: ${error?.message ?? error}`);
    });
}

function createLogId(createdAt: string): string {
  const compactTime = createdAt.replace(/\D/g, '').slice(0, 14);
  return `log_${compactTime}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}
