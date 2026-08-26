/**
 * JSON 文件持久化层。
 *
 * 当前项目用本地文件而不是数据库，是为了让开发机部署和备份足够轻。
 * 这里负责两件事：一是把运行状态落到 ~/.larkbot，二是读回时做最小结构校验，
 * 避免坏文件或旧版本字段把 daemon 启动流程拖垮。
 */
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AppLogRecord, Bot, ExpiredSession, FeedbackRecord, KnownChat, Session, SystemPromptProfile, Ticket, TicketTraceEvent } from './types.js';

export interface SessionStore {
  loadBots(): Promise<Bot[]>;
  saveBots(bots: Bot[]): Promise<void>;
  loadSessions(): Promise<Session[]>;
  saveSessions(sessions: Session[]): Promise<void>;
  loadExpiredSessions?(): Promise<ExpiredSession[]>;
  saveExpiredSessions?(sessions: ExpiredSession[]): Promise<void>;
  loadFeedbacks?(): Promise<FeedbackRecord[]>;
  saveFeedbacks?(feedbacks: FeedbackRecord[]): Promise<void>;
  loadTickets?(): Promise<Ticket[]>;
  saveTickets?(tickets: Ticket[]): Promise<void>;
  loadTicketTraceEvents?(): Promise<TicketTraceEvent[]>;
  saveTicketTraceEvents?(events: TicketTraceEvent[]): Promise<void>;
  loadAppLogs?(): Promise<AppLogRecord[]>;
  saveAppLogs?(logs: AppLogRecord[]): Promise<void>;
  appendAppLog?(log: AppLogRecord): Promise<void>;
}

export async function createDefaultSessionStore(): Promise<SessionStore> {
  const backend = process.env.LARKBOT_STORE?.trim().toLowerCase();
  if (backend === 'json') return new JsonSessionStore();
  try {
    const store = new SQLiteSessionStore();
    await store.migrateFromJson(new JsonSessionStore());
    return store;
  } catch (error) {
    if (backend === 'sqlite') throw error;
    return new JsonSessionStore();
  }
}

export class JsonSessionStore implements SessionStore {
  readonly sessionsPath: string;
  readonly botsPath: string;
  readonly expiredSessionsPath: string;
  readonly feedbackPath: string;
  readonly ticketsPath: string;
  readonly ticketTraceEventsPath: string;
  readonly appLogsPath: string;
  // 同类 JSON 写入串行化，避免并发事件同时 save 时后写入覆盖先写入的完整快照。
  private pendingSessionWrite: Promise<void> = Promise.resolve();
  private pendingBotWrite: Promise<void> = Promise.resolve();
  private pendingExpiredSessionWrite: Promise<void> = Promise.resolve();
  private pendingFeedbackWrite: Promise<void> = Promise.resolve();
  private pendingTicketWrite: Promise<void> = Promise.resolve();
  private pendingTicketTraceEventWrite: Promise<void> = Promise.resolve();
  private pendingAppLogWrite: Promise<void> = Promise.resolve();

  constructor(
    sessionsPath = defaultSessionsPath(),
    botsPath = defaultBotsPath(),
    expiredSessionsPath = defaultExpiredSessionsPath(),
    feedbackPath = defaultFeedbackPath(),
    ticketsPath = defaultTicketsPath(),
    ticketTraceEventsPath = defaultTicketTraceEventsPath(),
    appLogsPath = defaultAppLogsPath(),
  ) {
    this.sessionsPath = sessionsPath;
    this.botsPath = botsPath;
    this.expiredSessionsPath = expiredSessionsPath;
    this.feedbackPath = feedbackPath;
    this.ticketsPath = ticketsPath;
    this.ticketTraceEventsPath = ticketTraceEventsPath;
    this.appLogsPath = appLogsPath;
  }

  async loadBots(): Promise<Bot[]> {
    try {
      const parsed = JSON.parse(await readFile(this.botsPath, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isBot);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async saveBots(bots: Bot[]): Promise<void> {
    this.pendingBotWrite = this.pendingBotWrite.catch(() => undefined).then(() => writeJsonAtomic(this.botsPath, bots));
    await this.pendingBotWrite;
  }

  async loadSessions(): Promise<Session[]> {
    try {
      const parsed = JSON.parse(await readFile(this.sessionsPath, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isSession);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async saveSessions(sessions: Session[]): Promise<void> {
    this.pendingSessionWrite = this.pendingSessionWrite.catch(() => undefined).then(() => writeJsonAtomic(this.sessionsPath, sessions));
    await this.pendingSessionWrite;
  }

  async loadExpiredSessions(): Promise<ExpiredSession[]> {
    try {
      const parsed = JSON.parse(await readFile(this.expiredSessionsPath, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isExpiredSession);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async saveExpiredSessions(sessions: ExpiredSession[]): Promise<void> {
    this.pendingExpiredSessionWrite = this.pendingExpiredSessionWrite
      .catch(() => undefined)
      .then(() => writeJsonAtomic(this.expiredSessionsPath, sessions));
    await this.pendingExpiredSessionWrite;
  }

  async loadFeedbacks(): Promise<FeedbackRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.feedbackPath, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isFeedbackRecord);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async saveFeedbacks(feedbacks: FeedbackRecord[]): Promise<void> {
    this.pendingFeedbackWrite = this.pendingFeedbackWrite
      .catch(() => undefined)
      .then(() => writeJsonAtomic(this.feedbackPath, feedbacks));
    await this.pendingFeedbackWrite;
  }

  async loadTickets(): Promise<Ticket[]> {
    try {
      const parsed = JSON.parse(await readFile(this.ticketsPath, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isTicket);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async saveTickets(tickets: Ticket[]): Promise<void> {
    this.pendingTicketWrite = this.pendingTicketWrite
      .catch(() => undefined)
      .then(() => writeJsonAtomic(this.ticketsPath, tickets));
    await this.pendingTicketWrite;
  }

  async loadTicketTraceEvents(): Promise<TicketTraceEvent[]> {
    try {
      const parsed = JSON.parse(await readFile(this.ticketTraceEventsPath, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isTicketTraceEvent);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async saveTicketTraceEvents(events: TicketTraceEvent[]): Promise<void> {
    this.pendingTicketTraceEventWrite = this.pendingTicketTraceEventWrite
      .catch(() => undefined)
      .then(() => writeJsonAtomic(this.ticketTraceEventsPath, events));
    await this.pendingTicketTraceEventWrite;
  }

  async loadAppLogs(): Promise<AppLogRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.appLogsPath, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isAppLogRecord);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async saveAppLogs(logs: AppLogRecord[]): Promise<void> {
    this.pendingAppLogWrite = this.pendingAppLogWrite
      .catch(() => undefined)
      .then(() => writeJsonAtomic(this.appLogsPath, logs));
    await this.pendingAppLogWrite;
  }

  async appendAppLog(log: AppLogRecord): Promise<void> {
    this.pendingAppLogWrite = this.pendingAppLogWrite.catch(() => undefined).then(async () => {
      const logs = await this.loadAppLogs();
      logs.push(log);
      await writeJsonAtomic(this.appLogsPath, logs.slice(-10_000));
    });
    await this.pendingAppLogWrite;
  }
}

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  close(): void;
};

export class SQLiteSessionStore implements SessionStore {
  readonly dbPath: string;
  private readonly db: SqliteDatabase;

  constructor(dbPath = defaultDatabasePath()) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDatabase };
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS records (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      );
      CREATE INDEX IF NOT EXISTS idx_records_collection_updated ON records(collection, updated_at);
    `);
  }

  async migrateFromJson(jsonStore: JsonSessionStore): Promise<void> {
    await Promise.all([
      this.seedCollection('bots', await jsonStore.loadBots(), (item) => item.id),
      this.seedCollection('sessions', await jsonStore.loadSessions(), (item) => item.sessionId),
      this.seedCollection('expired_sessions', await jsonStore.loadExpiredSessions(), (item) => item.sessionId),
      this.seedCollection('feedbacks', await jsonStore.loadFeedbacks(), (item) => item.id),
      this.seedCollection('tickets', await jsonStore.loadTickets(), (item) => item.id),
      this.seedCollection('ticket_trace_events', await jsonStore.loadTicketTraceEvents(), (item) => item.id),
      this.seedCollection('app_logs', await jsonStore.loadAppLogs(), (item) => item.id),
    ]);
  }

  async loadBots(): Promise<Bot[]> {
    return this.loadCollection('bots', isBot);
  }

  async saveBots(bots: Bot[]): Promise<void> {
    this.saveCollection('bots', bots, (item) => item.id, (item) => item.id);
  }

  async loadSessions(): Promise<Session[]> {
    return this.loadCollection('sessions', isSession);
  }

  async saveSessions(sessions: Session[]): Promise<void> {
    this.saveCollection('sessions', sessions, (item) => item.sessionId, (item) => item.lastMessageAt || item.createdAt);
  }

  async loadExpiredSessions(): Promise<ExpiredSession[]> {
    return this.loadCollection('expired_sessions', isExpiredSession);
  }

  async saveExpiredSessions(sessions: ExpiredSession[]): Promise<void> {
    this.saveCollection('expired_sessions', sessions, (item) => item.sessionId, (item) => item.deletedAt);
  }

  async loadFeedbacks(): Promise<FeedbackRecord[]> {
    return this.loadCollection('feedbacks', isFeedbackRecord);
  }

  async saveFeedbacks(feedbacks: FeedbackRecord[]): Promise<void> {
    this.saveCollection('feedbacks', feedbacks, (item) => item.id, (item) => item.updatedAt);
  }

  async loadTickets(): Promise<Ticket[]> {
    return this.loadCollection('tickets', isTicket);
  }

  async saveTickets(tickets: Ticket[]): Promise<void> {
    this.saveCollection('tickets', tickets, (item) => item.id, (item) => item.updatedAt);
  }

  async loadTicketTraceEvents(): Promise<TicketTraceEvent[]> {
    return this.loadCollection('ticket_trace_events', isTicketTraceEvent);
  }

  async saveTicketTraceEvents(events: TicketTraceEvent[]): Promise<void> {
    this.saveCollection('ticket_trace_events', events, (item) => item.id, (item) => item.createdAt);
  }

  async loadAppLogs(): Promise<AppLogRecord[]> {
    return this.loadCollection('app_logs', isAppLogRecord);
  }

  async saveAppLogs(logs: AppLogRecord[]): Promise<void> {
    this.saveCollection('app_logs', logs, (item) => item.id, (item) => item.createdAt);
  }

  async appendAppLog(log: AppLogRecord): Promise<void> {
    this.insertRecord('app_logs', log.id, log, log.createdAt);
    this.db.exec(`
      DELETE FROM records
      WHERE collection = 'app_logs'
        AND id NOT IN (
          SELECT id FROM records
          WHERE collection = 'app_logs'
          ORDER BY updated_at DESC, id ASC
          LIMIT 10000
        );
    `);
  }

  close(): void {
    this.db.close();
  }

  private async seedCollection<T>(
    collection: string,
    items: T[],
    idOf: (item: T) => string,
  ): Promise<void> {
    const existing = this.db.prepare('SELECT id FROM records WHERE collection = ? LIMIT 1').all(collection);
    if (existing.length > 0 || items.length === 0) return;
    this.saveCollection(collection, items, idOf, (item) => readUpdatedAt(item));
  }

  private loadCollection<T>(collection: string, guard: (value: unknown) => value is T): T[] {
    const rows = this.db.prepare('SELECT json FROM records WHERE collection = ? ORDER BY updated_at DESC, id ASC').all(collection) as Array<{ json: string }>;
    const values: T[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.json);
        if (guard(parsed)) values.push(parsed);
      } catch {
        // Ignore malformed rows; the JSON store behaved the same way for malformed items.
      }
    }
    return values;
  }

  private saveCollection<T>(
    collection: string,
    items: T[],
    idOf: (item: T) => string,
    updatedAtOf: (item: T) => string | undefined,
  ): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM records WHERE collection = ?').run(collection);
      const insert = this.db.prepare('INSERT INTO records(collection, id, json, updated_at) VALUES (?, ?, ?, ?)');
      for (const item of items) {
        insert.run(collection, idOf(item), JSON.stringify(item), updatedAtOf(item) || new Date().toISOString());
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private insertRecord(collection: string, id: string, item: unknown, updatedAt: string): void {
    this.db.prepare(`
      INSERT INTO records(collection, id, json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(collection, id) DO UPDATE SET
        json = excluded.json,
        updated_at = excluded.updated_at
    `).run(collection, id, JSON.stringify(item), updatedAt);
  }
}

function defaultSessionsPath(): string {
  const stateDir = process.env.LARKBOT_STATE_DIR?.trim() || join(homedir(), '.larkbot');
  return join(stateDir, 'sessions.json');
}

function defaultBotsPath(): string {
  const stateDir = process.env.LARKBOT_STATE_DIR?.trim() || join(homedir(), '.larkbot');
  return join(stateDir, 'bots.json');
}

function defaultExpiredSessionsPath(): string {
  const stateDir = process.env.LARKBOT_STATE_DIR?.trim() || join(homedir(), '.larkbot');
  return join(stateDir, 'expired-sessions.json');
}

function defaultFeedbackPath(): string {
  const stateDir = process.env.LARKBOT_STATE_DIR?.trim() || join(homedir(), '.larkbot');
  return join(stateDir, 'feedback.json');
}

function defaultTicketsPath(): string {
  const stateDir = process.env.LARKBOT_STATE_DIR?.trim() || join(homedir(), '.larkbot');
  return join(stateDir, 'tickets.json');
}

function defaultTicketTraceEventsPath(): string {
  const stateDir = process.env.LARKBOT_STATE_DIR?.trim() || join(homedir(), '.larkbot');
  return join(stateDir, 'ticket-trace-events.json');
}

function defaultAppLogsPath(): string {
  const stateDir = process.env.LARKBOT_STATE_DIR?.trim() || join(homedir(), '.larkbot');
  return join(stateDir, 'app-logs.json');
}

function defaultDatabasePath(): string {
  const stateDir = process.env.LARKBOT_STATE_DIR?.trim() || join(homedir(), '.larkbot');
  return process.env.LARKBOT_DB_PATH?.trim() || join(stateDir, 'larkbot.sqlite');
}

function readUpdatedAt(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { updatedAt?: unknown; lastMessageAt?: unknown; createdAt?: unknown; deletedAt?: unknown };
  return typeof record.updatedAt === 'string' ? record.updatedAt
    : typeof record.lastMessageAt === 'string' ? record.lastMessageAt
    : typeof record.deletedAt === 'string' ? record.deletedAt
    : typeof record.createdAt === 'string' ? record.createdAt
    : undefined;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const snapshot = JSON.stringify(value, null, 2);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${snapshot}\n`, 'utf8');
  // POSIX rename 在同一目录内是原子替换；daemon 崩溃时最多留下 tmp 文件，
  // 不会把主 JSON 写成半截。
  await rename(tmp, path);
}

// 下面这些 guard 有意保持宽松：只验证运行依赖的核心字段。
// 新字段可以向前兼容，缺失的旧字段由上层逻辑兜底。
function isBot(value: unknown): value is Bot {
  if (!value || typeof value !== 'object') return false;
  const bot = value as Partial<Bot>;
  return typeof bot.id === 'string'
    && typeof bot.name === 'string'
    && typeof bot.appId === 'string'
    && typeof bot.appSecret === 'string'
    && typeof bot.cwd === 'string'
    && typeof bot.ownerOpenId === 'string'
    && (bot.allowedOpenIds === undefined || (Array.isArray(bot.allowedOpenIds) && bot.allowedOpenIds.every((item) => typeof item === 'string')))
    && (bot.allowedChatIds === undefined || (Array.isArray(bot.allowedChatIds) && bot.allowedChatIds.every((item) => typeof item === 'string')))
    && (bot.knownChats === undefined || (Array.isArray(bot.knownChats) && bot.knownChats.every(isKnownChat)))
    && typeof bot.enabled === 'boolean'
    && (bot.model === undefined || typeof bot.model === 'string')
    && (bot.replySignature === undefined || typeof bot.replySignature === 'string')
    && (bot.systemPromptProfiles === undefined || (Array.isArray(bot.systemPromptProfiles) && bot.systemPromptProfiles.every(isSystemPromptProfile)))
    && (bot.activeSystemPromptProfileId === undefined || typeof bot.activeSystemPromptProfileId === 'string');
}

function isKnownChat(value: unknown): value is KnownChat {
  if (!value || typeof value !== 'object') return false;
  const chat = value as Partial<KnownChat>;
  return typeof chat.chatId === 'string'
    && (chat.name === undefined || typeof chat.name === 'string')
    && typeof chat.lastSeenAt === 'string'
    && (chat.source === 'message' || chat.source === 'bot_added');
}

function isSystemPromptProfile(value: unknown): value is SystemPromptProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<SystemPromptProfile>;
  return typeof profile.id === 'string'
    && typeof profile.name === 'string'
    && typeof profile.content === 'string';
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<Session>;
  return typeof session.sessionId === 'string'
    && (session.ticketId === undefined || typeof session.ticketId === 'string')
    && typeof session.chatId === 'string'
    && typeof session.rootMessageId === 'string'
    && typeof session.workingDir === 'string'
    && session.cliId === 'traex'
    && (session.model === undefined || typeof session.model === 'string')
    && (session.workLogs === undefined || (Array.isArray(session.workLogs) && session.workLogs.every(isSessionWorkLog)))
    && session.scope === 'thread'
    && (session.status === 'active' || session.status === 'closed');
}

function isExpiredSession(value: unknown): value is ExpiredSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<ExpiredSession>;
  return typeof session.sessionId === 'string'
    && (session.ticketId === undefined || typeof session.ticketId === 'string')
    && typeof session.chatId === 'string'
    && typeof session.rootMessageId === 'string'
    && typeof session.title === 'string'
    && typeof session.lastMessageAt === 'string'
    && typeof session.createdAt === 'string'
    && (session.workLogs === undefined || (Array.isArray(session.workLogs) && session.workLogs.every(isSessionWorkLog)))
    && typeof session.deletedAt === 'string'
    && session.reason === 'retention_expired';
}

function isSessionWorkLog(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const log = value as { id?: unknown; startedAt?: unknown; endedAt?: unknown; durationMs?: unknown; status?: unknown };
  return typeof log.id === 'string'
    && typeof log.startedAt === 'string'
    && (log.endedAt === undefined || typeof log.endedAt === 'string')
    && (log.durationMs === undefined || (typeof log.durationMs === 'number' && Number.isFinite(log.durationMs)))
    && (log.status === undefined || log.status === 'completed' || log.status === 'failed' || log.status === 'stopped');
}

function isFeedbackRecord(value: unknown): value is FeedbackRecord {
  if (!value || typeof value !== 'object') return false;
  const feedback = value as Partial<FeedbackRecord>;
  return typeof feedback.id === 'string'
    && (feedback.ticketId === undefined || typeof feedback.ticketId === 'string')
    && (feedback.rating === 'positive' || feedback.rating === 'negative')
    && (feedback.status === 'open' || feedback.status === 'reviewing' || feedback.status === 'resolved' || feedback.status === 'ignored')
    && typeof feedback.sessionId === 'string'
    && typeof feedback.sessionTitle === 'string'
    && (feedback.chatId === undefined || typeof feedback.chatId === 'string')
    && (feedback.chatName === undefined || typeof feedback.chatName === 'string')
    && typeof feedback.operatorId === 'string'
    && (feedback.operatorName === undefined || typeof feedback.operatorName === 'string')
    && typeof feedback.terminalUrl === 'string'
    && (feedback.traceExcerpt === undefined || typeof feedback.traceExcerpt === 'string')
    && (feedback.question === undefined || typeof feedback.question === 'string')
    && (feedback.answer === undefined || typeof feedback.answer === 'string')
    && (feedback.knowledge === undefined || isKnowledgeObservation(feedback.knowledge))
    && (feedback.reason === undefined || typeof feedback.reason === 'string')
    && (feedback.note === undefined || typeof feedback.note === 'string')
    && (feedback.reviewNote === undefined || typeof feedback.reviewNote === 'string')
    && typeof feedback.createdAt === 'string'
    && typeof feedback.updatedAt === 'string';
}

function isTicket(value: unknown): value is Ticket {
  if (!value || typeof value !== 'object') return false;
  const ticket = value as Partial<Ticket>;
  return typeof ticket.id === 'string'
    && (ticket.source === 'feishu_dm' || ticket.source === 'feishu_group' || ticket.source === 'console' || ticket.source === 'manual')
    && typeof ticket.title === 'string'
    && (ticket.status === 'open' || ticket.status === 'analyzing' || ticket.status === 'waiting_user' || ticket.status === 'resolved' || ticket.status === 'closed' || ticket.status === 'failed' || ticket.status === 'archived')
    && (ticket.priority === 'low' || ticket.priority === 'normal' || ticket.priority === 'high' || ticket.priority === 'urgent')
    && (ticket.ownerOpenId === undefined || typeof ticket.ownerOpenId === 'string')
    && (ticket.createdByOpenId === undefined || typeof ticket.createdByOpenId === 'string')
    && (ticket.createdByName === undefined || typeof ticket.createdByName === 'string')
    && (ticket.chatId === undefined || typeof ticket.chatId === 'string')
    && (ticket.chatName === undefined || typeof ticket.chatName === 'string')
    && (ticket.messageId === undefined || typeof ticket.messageId === 'string')
    && (ticket.rootMessageId === undefined || typeof ticket.rootMessageId === 'string')
    && (ticket.threadId === undefined || typeof ticket.threadId === 'string')
    && (ticket.currentSessionId === undefined || typeof ticket.currentSessionId === 'string')
    && Array.isArray(ticket.sessionIds)
    && ticket.sessionIds.every((item) => typeof item === 'string')
    && typeof ticket.createdAt === 'string'
    && typeof ticket.updatedAt === 'string'
    && (ticket.closedAt === undefined || typeof ticket.closedAt === 'string');
}

function isTicketTraceEvent(value: unknown): value is TicketTraceEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<TicketTraceEvent>;
  return typeof event.id === 'string'
    && typeof event.ticketId === 'string'
    && typeof event.sessionId === 'string'
    && (event.turnId === undefined || typeof event.turnId === 'string')
    && (event.kind === 'turn_started' || event.kind === 'trace_snapshot' || event.kind === 'turn_completed' || event.kind === 'turn_failed' || event.kind === 'turn_stopped')
    && (event.status === undefined || event.status === 'working' || event.status === 'completed' || event.status === 'failed' || event.status === 'stopped')
    && (event.message === undefined || typeof event.message === 'string')
    && (event.question === undefined || typeof event.question === 'string')
    && (event.answer === undefined || typeof event.answer === 'string')
    && (event.trace === undefined || typeof event.trace === 'string')
    && typeof event.createdAt === 'string';
}

function isAppLogRecord(value: unknown): value is AppLogRecord {
  if (!value || typeof value !== 'object') return false;
  const log = value as Partial<AppLogRecord>;
  return typeof log.id === 'string'
    && (log.level === 'info' || log.level === 'warn' || log.level === 'error')
    && (log.category === 'daemon'
      || log.category === 'lark'
      || log.category === 'traex'
      || log.category === 'ticket'
      || log.category === 'console'
      || log.category === 'cleanup'
      || log.category === 'system')
    && typeof log.message === 'string'
    && (log.sessionId === undefined || typeof log.sessionId === 'string')
    && (log.ticketId === undefined || typeof log.ticketId === 'string')
    && (log.turnId === undefined || typeof log.turnId === 'string')
    && (log.traceEventId === undefined || typeof log.traceEventId === 'string')
    && (log.requestId === undefined || typeof log.requestId === 'string')
    && (log.data === undefined || (typeof log.data === 'object' && log.data !== null && !Array.isArray(log.data)))
    && typeof log.createdAt === 'string';
}

function isKnowledgeObservation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const observation = value as { references?: unknown; codeReferences?: unknown; logReferences?: unknown; noReferenceReason?: unknown; updatedAt?: unknown };
  return Array.isArray(observation.references)
    && observation.references.every(isKnowledgeReference)
    && (observation.codeReferences === undefined || (Array.isArray(observation.codeReferences) && observation.codeReferences.every(isEvidenceReference)))
    && (observation.logReferences === undefined || (Array.isArray(observation.logReferences) && observation.logReferences.every(isEvidenceReference)))
    && (observation.noReferenceReason === undefined || typeof observation.noReferenceReason === 'string')
    && typeof observation.updatedAt === 'string';
}

function isKnowledgeReference(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const ref = item as { path?: unknown; source?: unknown; evidence?: unknown };
  return typeof ref.path === 'string'
    && (ref.source === 'trace' || ref.source === 'answer' || ref.source === 'structured')
    && (ref.evidence === undefined || typeof ref.evidence === 'string');
}

function isEvidenceReference(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const ref = item as { value?: unknown; source?: unknown; evidence?: unknown };
  return typeof ref.value === 'string'
    && ref.source === 'structured'
    && (ref.evidence === undefined || typeof ref.evidence === 'string');
}
