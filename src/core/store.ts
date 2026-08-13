import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Bot, Session } from './types.js';

export interface SessionStore {
  loadBots(): Promise<Bot[]>;
  saveBots(bots: Bot[]): Promise<void>;
  loadSessions(): Promise<Session[]>;
  saveSessions(sessions: Session[]): Promise<void>;
}

export class JsonSessionStore implements SessionStore {
  readonly sessionsPath: string;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(path = defaultSessionsPath()) {
    this.sessionsPath = path;
  }

  async loadBots(): Promise<Bot[]> {
    return [];
  }

  async saveBots(_bots: Bot[]): Promise<void> {
    // Bot 配置仍由环境变量提供。
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
    const snapshot = JSON.stringify(sessions, null, 2);
    this.pendingWrite = this.pendingWrite.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.sessionsPath), { recursive: true });
      const tmp = `${this.sessionsPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, `${snapshot}\n`, 'utf8');
      await rename(tmp, this.sessionsPath);
    });
    await this.pendingWrite;
  }
}

function defaultSessionsPath(): string {
  const stateDir = process.env.LARKMUX_STATE_DIR?.trim() || join(homedir(), '.larkmux');
  return join(stateDir, 'sessions.json');
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<Session>;
  return typeof session.sessionId === 'string'
    && typeof session.chatId === 'string'
    && typeof session.rootMessageId === 'string'
    && typeof session.workingDir === 'string'
    && session.cliId === 'traex'
    && session.scope === 'thread'
    && (session.status === 'active' || session.status === 'closed');
}
