import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Bot, KnownChat, Session, SystemPromptProfile } from './types.js';

export interface SessionStore {
  loadBots(): Promise<Bot[]>;
  saveBots(bots: Bot[]): Promise<void>;
  loadSessions(): Promise<Session[]>;
  saveSessions(sessions: Session[]): Promise<void>;
}

export class JsonSessionStore implements SessionStore {
  readonly sessionsPath: string;
  readonly botsPath: string;
  private pendingSessionWrite: Promise<void> = Promise.resolve();
  private pendingBotWrite: Promise<void> = Promise.resolve();

  constructor(sessionsPath = defaultSessionsPath(), botsPath = defaultBotsPath()) {
    this.sessionsPath = sessionsPath;
    this.botsPath = botsPath;
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
}

function defaultSessionsPath(): string {
  const stateDir = process.env.LARKBOT_STATE_DIR?.trim() || join(homedir(), '.larkbot');
  return join(stateDir, 'sessions.json');
}

function defaultBotsPath(): string {
  const stateDir = process.env.LARKBOT_STATE_DIR?.trim() || join(homedir(), '.larkbot');
  return join(stateDir, 'bots.json');
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
    && session.scope === 'thread'
    && (session.status === 'active' || session.status === 'closed');
}
