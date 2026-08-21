import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Bot, ExpiredSession, FeedbackRecord, KnownChat, Session, SystemPromptProfile } from './types.js';

export interface SessionStore {
  loadBots(): Promise<Bot[]>;
  saveBots(bots: Bot[]): Promise<void>;
  loadSessions(): Promise<Session[]>;
  saveSessions(sessions: Session[]): Promise<void>;
  loadExpiredSessions?(): Promise<ExpiredSession[]>;
  saveExpiredSessions?(sessions: ExpiredSession[]): Promise<void>;
  loadFeedbacks?(): Promise<FeedbackRecord[]>;
  saveFeedbacks?(feedbacks: FeedbackRecord[]): Promise<void>;
}

export class JsonSessionStore implements SessionStore {
  readonly sessionsPath: string;
  readonly botsPath: string;
  readonly expiredSessionsPath: string;
  readonly feedbackPath: string;
  private pendingSessionWrite: Promise<void> = Promise.resolve();
  private pendingBotWrite: Promise<void> = Promise.resolve();
  private pendingExpiredSessionWrite: Promise<void> = Promise.resolve();
  private pendingFeedbackWrite: Promise<void> = Promise.resolve();

  constructor(
    sessionsPath = defaultSessionsPath(),
    botsPath = defaultBotsPath(),
    expiredSessionsPath = defaultExpiredSessionsPath(),
    feedbackPath = defaultFeedbackPath(),
  ) {
    this.sessionsPath = sessionsPath;
    this.botsPath = botsPath;
    this.expiredSessionsPath = expiredSessionsPath;
    this.feedbackPath = feedbackPath;
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

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const snapshot = JSON.stringify(value, null, 2);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${snapshot}\n`, 'utf8');
  await rename(tmp, path);
}

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
