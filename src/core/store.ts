/**
 * 持久化抽象。
 *
 * v1 用 JSON 文件实现（~/.larkmux/bots.json）。会话本身（含 PTY 句柄）不落盘，
 * daemon 重启即丢弃重开。预留 save/loadSessions 供后续 resume。
 */
import type { Bot } from './types.js';

export interface SessionStore {
  loadBots(): Promise<Bot[]>;
  saveBots(bots: Bot[]): Promise<void>;
  // 预留（v1 不实现）：
  // loadSessions(): Promise<PersistedSession[]>;
  // saveSessions(sessions: PersistedSession[]): Promise<void>;
}
