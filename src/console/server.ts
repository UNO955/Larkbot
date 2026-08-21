import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { SessionStore } from '../core/store.js';
import type { Bot, FeedbackRecord, FeedbackStatus, KnownChat, Session, SystemPromptProfile } from '../core/types.js';
import { logger } from '../utils/logger.js';

export interface ConsoleServerOpts {
  host: string;
  port: number;
  store: SessionStore;
  botId: string;
  traceStore?: TurnTraceStore;
  terminalStore?: TerminalStreamStore;
  sessionManager?: {
    listSessions(): Session[];
    closeSession(sessionId: string): Promise<Session | undefined>;
    interruptSession(sessionId: string): Promise<Session | undefined>;
    deleteSession(sessionId: string): Promise<boolean>;
  };
  onBotUpdated?(bot: Bot): void;
}

type PublicBot = Omit<Bot, 'appSecret'> & { appSecretSet: boolean };
export type TurnTraceStatus = 'working' | 'completed' | 'failed';

export interface TurnTrace {
  id: string;
  sessionId: string;
  title: string;
  status: TurnTraceStatus;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export class TurnTraceStore {
  private traces = new Map<string, TurnTrace>();

  create(input: { id: string; sessionId: string; title: string }): TurnTrace {
    const now = new Date().toISOString();
    const trace: TurnTrace = {
      id: input.id,
      sessionId: input.sessionId,
      title: input.title,
      status: 'working',
      content: '',
      createdAt: now,
      updatedAt: now,
    };
    this.traces.set(trace.id, trace);
    return trace;
  }

  update(id: string, patch: { content?: string; status?: TurnTraceStatus }): TurnTrace | undefined {
    const trace = this.traces.get(id);
    if (!trace) return undefined;
    if (patch.content !== undefined) trace.content = patch.content;
    if (patch.status) trace.status = patch.status;
    trace.updatedAt = new Date().toISOString();
    return trace;
  }

  get(id: string): TurnTrace | undefined {
    return this.traces.get(id);
  }
}

export class TerminalStreamStore {
  private buffers = new Map<string, string[]>();
  private subscribers = new Map<string, Set<ServerResponse>>();
  private filters = new Map<string, TerminalPromptEchoFilter>();

  constructor(private maxChars = 200_000) {}

  redactInput(sessionId: string, content: string): void {
    this.filter(sessionId).redactInput(content);
  }

  append(sessionId: string, chunk: string): void {
    const filtered = this.filter(sessionId).push(chunk);
    if (!filtered) return;
    const buffer = this.buffers.get(sessionId) ?? [];
    buffer.push(filtered);
    let size = buffer.reduce((sum, item) => sum + item.length, 0);
    while (size > this.maxChars && buffer.length > 1) {
      const removed = buffer.shift() ?? '';
      size -= removed.length;
    }
    this.buffers.set(sessionId, buffer);
    this.publish(sessionId, 'data', { chunk: filtered });
  }

  snapshot(sessionId: string, maxChars = this.maxChars): string {
    const content = (this.buffers.get(sessionId) ?? []).join('');
    const visible = stripTerminalControl(content).trim();
    return visible.length > maxChars ? visible.slice(-maxChars) : visible;
  }

  close(sessionId: string): void {
    this.publish(sessionId, 'status', { status: 'closed' });
  }

  subscribe(sessionId: string, res: ServerResponse): void {
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(res);
    for (const chunk of this.buffers.get(sessionId) ?? []) {
      writeSse(res, 'data', { chunk });
    }
    writeSse(res, 'status', { status: 'connected' });
    res.on('close', () => {
      set?.delete(res);
      if (set?.size === 0) this.subscribers.delete(sessionId);
    });
  }

  private publish(sessionId: string, event: string, data: unknown): void {
    for (const res of this.subscribers.get(sessionId) ?? []) {
      writeSse(res, event, data);
    }
  }

  private filter(sessionId: string): TerminalPromptEchoFilter {
    let filter = this.filters.get(sessionId);
    if (!filter) {
      filter = new TerminalPromptEchoFilter();
      this.filters.set(sessionId, filter);
    }
    return filter;
  }
}

class TerminalPromptEchoFilter {
  private hiddenBlock = false;
  private sensitiveLines = new Set<string>();

  redactInput(content: string): void {
    for (const line of extractSensitiveLines(content)) {
      this.sensitiveLines.add(line);
    }
  }

  push(chunk: string): string {
    const visible = stripTerminalControl(chunk);
    if (!visible.trim()) return chunk;
    const shouldHide = this.shouldHide(visible);
    return shouldHide ? '' : chunk;
  }

  private shouldHide(visible: string): boolean {
    const normalized = normalizeTerminalText(visible);
    if (normalized && [...this.sensitiveLines].some((line) => normalized.includes(line))) return true;
    if (this.hiddenBlock) {
      if (HIDDEN_PROMPT_BLOCK_END_RE.test(visible)) this.hiddenBlock = false;
      return true;
    }
    if (PROMPT_ECHO_LINE_RE.test(visible)) return true;
    if (HIDDEN_PROMPT_SINGLE_RE.test(visible)) return true;
    if (HIDDEN_PROMPT_BLOCK_START_RE.test(visible)) {
      this.hiddenBlock = !HIDDEN_PROMPT_BLOCK_END_RE.test(visible);
      return true;
    }
    return false;
  }
}

const HIDDEN_PROMPT_BLOCK_START_RE = /<\/?(?:larkbot_routing|larkbot_reminder|larkbot_evidence|system_prompt_profile|user_message|quoted_message|attachments)\b/i;
const HIDDEN_PROMPT_BLOCK_END_RE = /<\/(?:larkbot_routing|larkbot_reminder|larkbot_evidence|system_prompt_profile|user_message|quoted_message|attachments)>/i;
const HIDDEN_PROMPT_SINGLE_RE = /<\/?(?:session_id|sender|image|file)\b/i;
const PROMPT_ECHO_LINE_RE = /^\s*▍/;

function stripTerminalControl(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function extractSensitiveLines(content: string): string[] {
  const lines = new Set<string>();
  for (const raw of content.split(/\r?\n/)) {
    addSensitiveLine(lines, raw);
    addSensitiveLine(lines, xmlUnescape(raw));
  }
  return [...lines];
}

function addSensitiveLine(lines: Set<string>, raw: string): void {
  const line = normalizeTerminalText(raw);
  if (line.length >= 2) lines.add(line);
}

function normalizeTerminalText(value: string): string {
  return stripTerminalControl(value)
    .replace(/[─━│┌┐└┘├┤┬┴┼╭╮╯╰]/g, ' ')
    .replace(/^\s*[›❯▍]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export async function startConsoleServer(opts: ConsoleServerOpts): Promise<Server> {
  const server = createServer((req, res) => {
    void handleRequest(opts, req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  logger.info(`控制台已启动 http://${address.address}:${address.port}`);
  return server;
}

async function handleRequest(opts: ConsoleServerOpts, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url || '/', 'http://larkbot.local');
    if (req.method === 'GET' && url.pathname === '/') {
      sendHtml(res, renderConsoleHtml());
      return;
    }
    const traceMatch = url.pathname.match(/^\/trace\/([^/]+)$/);
    if (req.method === 'GET' && traceMatch) {
      const trace = opts.traceStore?.get(decodeURIComponent(traceMatch[1]));
      if (!trace) throw httpError(404, 'trace_not_found');
      sendHtml(res, renderTraceHtml(trace));
      return;
    }
    const sessionInterruptMatch = url.pathname.match(/^\/sessions\/([^/]+)\/interrupt$/);
    if (req.method === 'GET' && sessionInterruptMatch) {
      const sessionId = decodeURIComponent(sessionInterruptMatch[1]);
      const session = await interruptSession(opts, sessionId);
      sendHtml(res, renderSessionInterruptedHtml(session));
      return;
    }
    const terminalMatch = url.pathname.match(/^\/terminal\/([^/]+)$/);
    if (req.method === 'GET' && terminalMatch) {
      const sessionId = decodeURIComponent(terminalMatch[1]);
      const session = (await listSessions(opts)).find((item) => item.sessionId === sessionId);
      if (!session) throw httpError(404, 'session_not_found');
      sendHtml(res, renderTerminalHtml(session));
      return;
    }
    const terminalEventsMatch = url.pathname.match(/^\/api\/terminal\/([^/]+)\/events$/);
    if (req.method === 'GET' && terminalEventsMatch) {
      const sessionId = decodeURIComponent(terminalEventsMatch[1]);
      if (!opts.terminalStore) throw httpError(404, 'terminal_not_available');
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      opts.terminalStore.subscribe(sessionId, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/bot') {
      const bot = await requireBot(opts);
      sendJson(res, { bot: toPublicBot(bot) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/models') {
      sendJson(res, { models: await loadTraexModels() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      sendJson(res, { sessions: await listSessions(opts) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/chats') {
      sendJson(res, { chats: await listChats(opts) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/feedbacks') {
      sendJson(res, { feedbacks: await listFeedbacks(opts) });
      return;
    }
    const feedbackMatch = url.pathname.match(/^\/api\/feedbacks\/([^/]+)$/);
    if (feedbackMatch && req.method === 'PATCH') {
      const feedbackId = decodeURIComponent(feedbackMatch[1]);
      const patch = await readJsonBody(req);
      sendJson(res, { feedback: await updateFeedback(opts, feedbackId, patch) });
      return;
    }
    if (feedbackMatch && req.method === 'DELETE') {
      const feedbackId = decodeURIComponent(feedbackMatch[1]);
      await deleteFeedback(opts, feedbackId);
      sendJson(res, { ok: true });
      return;
    }
    const chatMatch = url.pathname.match(/^\/api\/chats\/([^/]+)$/);
    if (chatMatch && req.method === 'PATCH') {
      const chatId = decodeURIComponent(chatMatch[1]);
      const patch = await readJsonBody(req);
      const bot = await updateChatAuthorization(opts, chatId, patch);
      opts.onBotUpdated?.(bot);
      sendJson(res, { bot: toPublicBot(bot), chats: toPublicChats(bot) });
      return;
    }
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === 'PATCH') {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      const patch = await readJsonBody(req);
      sendJson(res, { session: await updateSession(opts, sessionId, patch) });
      return;
    }
    if (sessionMatch && req.method === 'DELETE') {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      await deleteSession(opts, sessionId);
      sendJson(res, { ok: true });
      return;
    }
    if (req.method === 'PATCH' && url.pathname === '/api/bot') {
      const patch = await readJsonBody(req);
      const bot = await updateBot(opts, patch);
      opts.onBotUpdated?.(bot);
      sendJson(res, { bot: toPublicBot(bot) });
      return;
    }
    sendJson(res, { error: 'not_found' }, 404);
  } catch (error: any) {
    const status = error?.statusCode || 500;
    sendJson(res, { error: error?.message || 'internal_error' }, status);
  }
}

async function requireBot(opts: ConsoleServerOpts): Promise<Bot> {
  const bot = (await opts.store.loadBots()).find((item) => item.id === opts.botId);
  if (!bot) throw httpError(404, 'bot_not_found');
  return bot;
}

type PublicSession = Session & { createdByDisplayName?: string; lastCallerDisplayName?: string };

async function listSessions(opts: ConsoleServerOpts): Promise<PublicSession[]> {
  const bot = await requireBot(opts).catch(() => undefined);
  const sessions = opts.sessionManager
    ? opts.sessionManager.listSessions()
    : await opts.store.loadSessions();
  return sessions
    .map((session) => enrichSessionChatName(session, bot))
    .map((session) => enrichSessionUserNames(session, bot))
    .sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt));
}

function enrichSessionChatName(session: Session, bot: Bot | undefined): Session {
  const name = bot?.knownChats?.find((chat) => chat.chatId === session.chatId)?.name;
  return name && name !== session.chatName ? { ...session, chatName: name } : session;
}

function enrichSessionUserNames(session: Session, bot: Bot | undefined): PublicSession {
  const createdByDisplayName = displayUserName(session.createdByName, session.createdByOpenId, bot);
  const lastCallerDisplayName = displayUserName(undefined, session.lastCallerOpenId, bot);
  return { ...session, createdByDisplayName, lastCallerDisplayName };
}

function displayUserName(name: string | undefined, openId: string | undefined, bot: Bot | undefined): string | undefined {
  if (name?.trim()) return name.trim();
  if (openId && bot?.ownerOpenId === openId) return 'Owner';
  return openId;
}

async function listChats(opts: ConsoleServerOpts): Promise<PublicChat[]> {
  const bot = await requireBot(opts);
  return toPublicChats(bot);
}

async function listFeedbacks(opts: ConsoleServerOpts): Promise<FeedbackRecord[]> {
  if (!opts.store.loadFeedbacks) return [];
  const feedbacks = await opts.store.loadFeedbacks();
  return [...feedbacks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

async function updateFeedback(opts: ConsoleServerOpts, feedbackId: string, patch: unknown): Promise<FeedbackRecord> {
  if (!opts.store.loadFeedbacks || !opts.store.saveFeedbacks) throw httpError(404, 'feedback_store_not_available');
  if (!patch || typeof patch !== 'object') throw httpError(400, 'invalid_json');
  const input = patch as Record<string, unknown>;
  const status = input.status;
  const reviewNote = input.reviewNote;
  if (status !== undefined && !isFeedbackStatus(status)) throw httpError(400, 'unsupported_feedback_status');
  if (reviewNote !== undefined && typeof reviewNote !== 'string') throw httpError(400, 'invalid_review_note');
  if (status === undefined && reviewNote === undefined) throw httpError(400, 'unsupported_feedback_update');
  const feedbacks = await opts.store.loadFeedbacks();
  const feedback = feedbacks.find((item) => item.id === feedbackId);
  if (!feedback) throw httpError(404, 'feedback_not_found');
  if (status !== undefined) feedback.status = status;
  if (typeof reviewNote === 'string') feedback.reviewNote = clean(reviewNote, 1000);
  feedback.updatedAt = new Date().toISOString();
  await opts.store.saveFeedbacks(feedbacks);
  return feedback;
}

async function deleteFeedback(opts: ConsoleServerOpts, feedbackId: string): Promise<void> {
  if (!opts.store.loadFeedbacks || !opts.store.saveFeedbacks) throw httpError(404, 'feedback_store_not_available');
  const feedbacks = await opts.store.loadFeedbacks();
  const next = feedbacks.filter((item) => item.id !== feedbackId);
  if (next.length === feedbacks.length) throw httpError(404, 'feedback_not_found');
  await opts.store.saveFeedbacks(next);
}

async function updateSession(opts: ConsoleServerOpts, sessionId: string, patch: unknown): Promise<Session> {
  if (!patch || typeof patch !== 'object') throw httpError(400, 'invalid_json');
  const status = (patch as Record<string, unknown>).status;
  if (status !== 'closed') throw httpError(400, 'unsupported_session_update');
  const session = opts.sessionManager
    ? await opts.sessionManager.closeSession(sessionId)
    : await closeStoredSession(opts.store, sessionId);
  if (!session) throw httpError(404, 'session_not_found');
  return session;
}

async function interruptSession(opts: ConsoleServerOpts, sessionId: string): Promise<Session> {
  const session = opts.sessionManager
    ? await opts.sessionManager.interruptSession(sessionId)
    : (await listSessions(opts)).find((item) => item.sessionId === sessionId);
  if (!session) throw httpError(404, 'session_not_found');
  return session;
}

async function deleteSession(opts: ConsoleServerOpts, sessionId: string): Promise<void> {
  const deleted = opts.sessionManager
    ? await opts.sessionManager.deleteSession(sessionId)
    : await deleteStoredSession(opts.store, sessionId);
  if (!deleted) throw httpError(404, 'session_not_found');
}

async function closeStoredSession(store: SessionStore, sessionId: string): Promise<Session | undefined> {
  const sessions = await store.loadSessions();
  const session = sessions.find((item) => item.sessionId === sessionId);
  if (!session) return undefined;
  session.status = 'closed';
  session.closedAt = new Date().toISOString();
  await store.saveSessions(sessions);
  return session;
}

async function deleteStoredSession(store: SessionStore, sessionId: string): Promise<boolean> {
  const sessions = await store.loadSessions();
  const next = sessions.filter((item) => item.sessionId !== sessionId);
  if (next.length === sessions.length) return false;
  await store.saveSessions(next);
  return true;
}

async function updateBot(opts: ConsoleServerOpts, patch: unknown): Promise<Bot> {
  if (!patch || typeof patch !== 'object') throw httpError(400, 'invalid_json');
  const bots = await opts.store.loadBots();
  const index = bots.findIndex((item) => item.id === opts.botId);
  if (index < 0) throw httpError(404, 'bot_not_found');
  const next = { ...bots[index] };
  const input = patch as Record<string, unknown>;

  if (typeof input.name === 'string') next.name = clean(input.name, 80);
  if (typeof input.appId === 'string') next.appId = clean(input.appId, 128);
  if (typeof input.appSecret === 'string' && input.appSecret.trim()) next.appSecret = input.appSecret.trim();
  if (typeof input.cwd === 'string') next.cwd = clean(input.cwd, 500);
  if (typeof input.ownerOpenId === 'string') next.ownerOpenId = clean(input.ownerOpenId, 128);
  if (Array.isArray(input.allowedOpenIds)) next.allowedOpenIds = sanitizeOpenIds(input.allowedOpenIds);
  if (typeof input.allowedOpenIds === 'string') next.allowedOpenIds = sanitizeOpenIds(input.allowedOpenIds.split(/[\s,;]+/));
  if (Array.isArray(input.allowedChatIds)) next.allowedChatIds = sanitizeChatIds(input.allowedChatIds);
  if (typeof input.enabled === 'boolean') next.enabled = input.enabled;
  if (typeof input.model === 'string') next.model = sanitizeModel(input.model) || undefined;
  if (typeof input.disableStreamingCard === 'boolean') next.disableStreamingCard = input.disableStreamingCard;
  if (typeof input.replySignature === 'string') next.replySignature = clean(input.replySignature, 80);
  if (Array.isArray(input.systemPromptProfiles)) {
    next.systemPromptProfiles = sanitizeSystemPromptProfiles(input.systemPromptProfiles);
  }
  if (typeof input.activeSystemPromptProfileId === 'string') {
    const activeId = clean(input.activeSystemPromptProfileId, 128);
    next.activeSystemPromptProfileId = activeId || undefined;
  }

  if (!next.name) throw httpError(400, 'name_required');
  if (!next.appId) throw httpError(400, 'app_id_required');
  if (!next.appSecret) throw httpError(400, 'app_secret_required');
  if (!next.cwd) throw httpError(400, 'cwd_required');
  if (!next.ownerOpenId) throw httpError(400, 'owner_open_id_required');
  if (!next.systemPromptProfiles?.some((profile) => profile.id === next.activeSystemPromptProfileId)) {
    next.activeSystemPromptProfileId = undefined;
  }

  bots[index] = next;
  await opts.store.saveBots(bots);
  return next;
}

async function updateChatAuthorization(opts: ConsoleServerOpts, chatId: string, patch: unknown): Promise<Bot> {
  if (!chatId) throw httpError(400, 'chat_id_required');
  if (!patch || typeof patch !== 'object') throw httpError(400, 'invalid_json');
  const input = patch as Record<string, unknown>;
  if (typeof input.enabled !== 'boolean') throw httpError(400, 'enabled_required');
  const bots = await opts.store.loadBots();
  const index = bots.findIndex((item) => item.id === opts.botId);
  if (index < 0) throw httpError(404, 'bot_not_found');
  const next = { ...bots[index] };
  const allowed = new Set(next.allowedChatIds ?? []);
  if (input.enabled) allowed.add(chatId);
  else allowed.delete(chatId);
  next.allowedChatIds = [...allowed];
  bots[index] = next;
  await opts.store.saveBots(bots);
  return next;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw httpError(413, 'body_too_large');
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString('utf8').trim();
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw httpError(400, 'invalid_json');
  }
}

function toPublicBot(bot: Bot): PublicBot {
  const { appSecret: _appSecret, ...rest } = bot;
  return { ...rest, appSecretSet: !!bot.appSecret };
}

interface PublicChat extends KnownChat {
  enabled: boolean;
}

function toPublicChats(bot: Bot): PublicChat[] {
  const enabled = new Set(bot.allowedChatIds ?? []);
  return [...(bot.knownChats ?? [])]
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    .map((chat) => ({ ...chat, enabled: enabled.has(chat.chatId) }));
}

function clean(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function sanitizeModel(value: string): string {
  const model = value.trim().slice(0, 80);
  return /^[A-Za-z0-9._:-]+$/.test(model) ? model : '';
}

function sanitizeOpenIds(values: unknown[]): string[] {
  return unique(values
    .filter((item): item is string => typeof item === 'string')
    .map((item) => clean(item, 128))
    .filter(Boolean));
}

function sanitizeChatIds(values: unknown[]): string[] {
  return unique(values
    .filter((item): item is string => typeof item === 'string')
    .map((item) => clean(item, 160))
    .filter(Boolean));
}

async function loadTraexModels(): Promise<string[]> {
  const candidates = [
    process.env.TRAEX_BIN?.trim(),
    'traex',
    `${homedir()}/.local/share/traex/current/traex`,
  ].filter(Boolean) as string[];
  for (const bin of candidates) {
    if (bin.includes('/') && !existsSync(bin)) continue;
    try {
      const { stdout } = await execFileText(bin, ['models'], 5_000);
      const models = unique(stdout.split(/\r?\n/)
        .map(sanitizeModel)
        .filter(Boolean));
      if (models.length > 0) return models;
    } catch {
      // Try the next candidate.
    }
  }
  return [];
}

function execFileText(file: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return value === 'open' || value === 'reviewing' || value === 'resolved' || value === 'ignored';
}

function sanitizeSystemPromptProfiles(value: unknown[]): Bot['systemPromptProfiles'] {
  const profiles: SystemPromptProfile[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.content !== 'string') continue;
    const id = clean(raw.id, 128) || `profile-${profiles.length + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    profiles.push({
      id,
      name: clean(raw.name, 80) || '未命名提示词',
      content: raw.content.trim().slice(0, 20_000),
    });
  }
  return profiles;
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function renderConsoleHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>larkbot 控制台</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --bg: oklch(97.4% 0.012 255);
      --surface: oklch(100% 0 0);
      --surface-soft: oklch(98.6% 0.01 255);
      --surface-tint: oklch(96.5% 0.018 255);
      --border: oklch(89.8% 0.014 255);
      --border-strong: oklch(84.8% 0.02 255);
      --text: oklch(24% 0.02 255);
      --text-soft: oklch(44% 0.025 255);
      --text-muted: oklch(59% 0.025 255);
      --primary: oklch(55% 0.18 258);
      --primary-hover: oklch(49% 0.18 258);
      --primary-soft: oklch(93.5% 0.045 258);
      --success: oklch(48% 0.13 150);
      --success-soft: oklch(94% 0.055 150);
      --danger: oklch(56% 0.18 24);
      --danger-hover: oklch(49% 0.17 24);
      --danger-soft: oklch(94% 0.045 24);
      --warning: oklch(54% 0.12 70);
      --warning-soft: oklch(96% 0.055 78);
      --radius: 8px;
      --shadow-sm: 0 1px 2px oklch(24% 0.02 255 / .06);
      --shadow-md: 0 14px 36px oklch(24% 0.02 255 / .08);
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    main { max-width: 1280px; margin: 28px auto; padding: 0 24px; display: grid; gap: 20px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-sm); overflow: hidden; }
    .card:first-child { box-shadow: var(--shadow-md); }
    header { padding: 24px 28px 22px; border-bottom: 1px solid var(--border); background: linear-gradient(180deg, var(--surface) 0%, var(--surface-soft) 100%); }
    h1 { margin: 0; font-size: 22px; line-height: 1.25; letter-spacing: 0; }
    .app-title, .section-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .title-icon { width: 32px; height: 32px; border-radius: var(--radius); display: inline-flex; align-items: center; justify-content: center; background: var(--primary-soft); color: var(--primary); flex: 0 0 auto; }
    .section-title .title-icon { width: 28px; height: 28px; }
    .icon { width: 16px; height: 16px; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; fill: none; flex: 0 0 auto; }
    .icon.sm { width: 14px; height: 14px; }
    .sub { margin-top: 6px; color: var(--text-soft); font-size: 13px; line-height: 1.6; }
    .summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 18px; }
    .summary-item { min-width: 0; display: grid; gap: 5px; padding: 13px 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow-sm); }
    .summary-label { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: 12px; font-weight: 700; }
    .summary-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 18px; line-height: 1.25; font-weight: 800; color: var(--text); }
    form { padding: 24px 28px 28px; display: grid; gap: 16px; }
    label { display: grid; gap: 7px; font-weight: 700; font-size: 13px; color: var(--text); }
      input[type="text"], input[type="password"], select, textarea { width: 100%; border: 1px solid var(--border-strong); border-radius: var(--radius); padding: 0 12px; font: inherit; background: var(--surface); color: var(--text); transition: border-color .15s ease, box-shadow .15s ease, background .15s ease; }
      input[type="text"], input[type="password"], select { height: 38px; }
      textarea { min-height: 144px; padding: 10px 12px; resize: vertical; line-height: 1.5; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      input:hover, select:hover, textarea:hover { border-color: var(--text-muted); }
      input:focus, select:focus, textarea:focus { outline: 0; border-color: var(--primary); box-shadow: 0 0 0 3px oklch(55% 0.18 258 / .14); }
    .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
    .check { display: flex; align-items: center; gap: 10px; min-height: 28px; font-weight: 600; color: var(--text); }
    .check input { width: 16px; height: 16px; accent-color: var(--primary); }
    .hint { color: var(--text-muted); font-size: 12px; font-weight: 400; line-height: 1.5; }
    footer { display: flex; align-items: center; gap: 12px; padding-top: 4px; }
    button { height: 36px; border: 1px solid transparent; border-radius: var(--radius); background: var(--primary); color: white; padding: 0 16px; font: inherit; font-weight: 800; cursor: pointer; transition: background .15s ease, border-color .15s ease, box-shadow .15s ease, transform .15s ease; display: inline-flex; align-items: center; justify-content: center; gap: 7px; white-space: nowrap; }
    button:hover:not(:disabled) { background: var(--primary-hover); transform: translateY(-1px); box-shadow: 0 8px 18px oklch(55% 0.18 258 / .16); }
    button:active:not(:disabled) { transform: translateY(0); box-shadow: none; }
    button:focus-visible { outline: 0; box-shadow: 0 0 0 3px oklch(55% 0.18 258 / .18); }
    button:disabled { opacity: .55; cursor: not-allowed; }
    #status { color: var(--text-soft); font-size: 13px; }
    .warn { display: flex; align-items: flex-start; gap: 8px; background: var(--warning-soft); color: var(--warning); border: 1px solid oklch(87% 0.075 78); border-radius: var(--radius); padding: 10px 12px; font-size: 13px; line-height: 1.5; }
    .warn .icon { margin-top: 2px; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 28px; border-bottom: 1px solid var(--border); background: var(--surface-soft); }
    .toolbar h2 { margin: 0; font-size: 18px; line-height: 1.3; letter-spacing: 0; }
    .ghost { background: var(--surface); color: var(--text); border-color: var(--border-strong); }
    .ghost:hover:not(:disabled) { background: var(--surface-tint); box-shadow: 0 8px 18px oklch(24% 0.02 255 / .08); }
    .danger { background: var(--danger); }
    .danger:hover:not(:disabled) { background: var(--danger-hover); box-shadow: 0 8px 18px oklch(56% 0.18 24 / .15); }
    .sessions { padding: 0 28px 24px; overflow-x: auto; scrollbar-color: #c9cdd4 transparent; }
    .empty { padding: 18px 28px 24px; color: var(--text-muted); font-size: 14px; }
    table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; table-layout: fixed; }
    .chat-table { min-width: 760px; }
    .session-table { min-width: 1180px; }
    .feedback-table { min-width: 1040px; }
    th, td { text-align: left; border-bottom: 1px solid var(--border); padding: 13px 10px; vertical-align: top; }
    th { color: var(--text-soft); font-weight: 800; background: var(--surface); position: sticky; top: 0; z-index: 1; }
    tbody tr:hover td { background: var(--surface-soft); }
    code { background: var(--surface-tint); border: 1px solid var(--border); border-radius: 6px; padding: 2px 5px; color: var(--text-soft); font-size: 12px; }
    .muted { color: var(--text-muted); }
    .line { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.55; }
    .line strong { font-weight: 700; }
    .context-lines { display: grid; gap: 5px; }
    .context-line { color: var(--text-soft); line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .context-line strong { color: var(--text); font-weight: 800; }
    .feedback-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .feedback-controls select { width: auto; min-width: 124px; height: 34px; }
    .feedback-stats { display: flex; gap: 8px; flex-wrap: wrap; padding: 0 28px 16px; }
    .feedback-stat { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; background: var(--surface-tint); color: var(--text-soft); border: 1px solid var(--border); padding: 5px 10px; font-size: 12px; font-weight: 800; }
    .feedback-stat.negative { background: var(--danger-soft); color: var(--danger); border-color: oklch(62% 0.19 24 / .22); }
    .review-note { min-width: 190px; min-height: 58px; border: 1px solid var(--border-strong); border-radius: var(--radius); padding: 8px 10px; resize: vertical; font: inherit; font-size: 13px; line-height: 1.45; }
    .session-table th:last-child,
    .session-table td:last-child { position: sticky; right: 0; background: inherit; box-shadow: -12px 0 18px oklch(100% 0 0 / .94); }
    .session-table th:last-child { z-index: 2; }
    .status { display: inline-flex; align-items: center; min-width: 56px; justify-content: center; gap: 6px; border-radius: 999px; padding: 3px 9px; font-weight: 700; font-size: 12px; line-height: 1.4; }
    .status::before { content: ""; width: 6px; height: 6px; border-radius: 999px; background: currentColor; }
    .status.active, .status.positive, .status.resolved { background: var(--success-soft); color: var(--success); }
    .status.closed, .status.ignored { background: var(--surface-tint); color: var(--text-soft); }
    .status.negative, .status.open { background: var(--danger-soft); color: var(--danger); }
    .status.reviewing { background: var(--warning-soft); color: var(--warning); }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .actions button { height: 30px; padding: 0 10px; font-size: 13px; }
      .actions select { height: 30px; max-width: 116px; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); color: var(--text); font: inherit; font-size: 13px; font-weight: 800; }
      .feedback-status-select.open { color: var(--danger); border-color: oklch(62% 0.19 24 / .35); background: var(--danger-soft); }
      .feedback-status-select.reviewing { color: var(--warning); border-color: oklch(65% 0.16 74 / .38); background: var(--warning-soft); }
      .feedback-status-select.resolved { color: var(--success); border-color: oklch(55% 0.15 150 / .35); background: var(--success-soft); }
      .feedback-status-select.ignored { color: var(--text-soft); border-color: var(--border-strong); background: var(--surface-tint); }
      .prompt-box { border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; display: grid; gap: 14px; background: var(--surface-soft); }
      .prompt-title { display: flex; align-items: center; gap: 8px; }
      .prompt-title .icon { color: var(--primary); }
      .prompt-head { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: end; }
    .empty-state { display: inline-flex; align-items: center; gap: 8px; min-height: 48px; color: var(--text-muted); }
    .empty-state .icon { color: var(--text-muted); }
    .source-pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; background: var(--surface-tint); color: var(--text-soft); padding: 3px 9px; font-weight: 700; font-size: 12px; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
    }
    @media (max-width: 720px) {
      main { margin: 18px auto; padding: 0 14px; gap: 14px; }
      header, .toolbar { padding: 18px; }
      form { padding: 18px; }
      .sessions { padding: 0 18px 18px; }
      .row, .prompt-head { grid-template-columns: 1fr; }
      .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .toolbar { align-items: flex-start; flex-direction: column; }
      .toolbar button { width: 100%; }
    }
    @media (max-width: 480px) {
      .summary-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <svg aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">
    <symbol id="i-bot" viewBox="0 0 24 24"><path d="M12 8V4"/><path d="M8 4h8"/><rect x="5" y="8" width="14" height="11" rx="3"/><path d="M9 13h.01"/><path d="M15 13h.01"/><path d="M9 17h6"/></symbol>
    <symbol id="i-users" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></symbol>
    <symbol id="i-message" viewBox="0 0 24 24"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></symbol>
    <symbol id="i-inbox" viewBox="0 0 24 24"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="m5.45 5.11-3.3 6.6A2 2 0 0 0 2 12.6V19a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6.4a2 2 0 0 0-.15-.89l-3.3-6.6A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></symbol>
    <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M18 2v4h4"/><path d="M6 22v-4H2"/></symbol>
    <symbol id="i-save" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></symbol>
    <symbol id="i-settings" viewBox="0 0 24 24"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.08V21a2 2 0 0 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.08-.4H3a2 2 0 0 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.08V3a2 2 0 0 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.08.4H21a2 2 0 0 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z"/></symbol>
    <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-5"/></symbol>
    <symbol id="i-activity" viewBox="0 0 24 24"><path d="M22 12h-4l-3 8-6-16-3 8H2"/></symbol>
    <symbol id="i-cpu" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 1v3"/><path d="M15 1v3"/><path d="M9 20v3"/><path d="M15 20v3"/><path d="M20 9h3"/><path d="M20 14h3"/><path d="M1 9h3"/><path d="M1 14h3"/></symbol>
    <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol>
    <symbol id="i-thumbs" viewBox="0 0 24 24"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h3l3.6-5.4A2 2 0 0 1 12.26 4H13a2 2 0 0 1 2 1.88Z"/></symbol>
    <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14"/><path d="M5 12h14"/></symbol>
    <symbol id="i-trash" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></symbol>
    <symbol id="i-power" viewBox="0 0 24 24"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/></symbol>
    <symbol id="i-x" viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></symbol>
  </svg>
  <main>
    <section class="card">
      <header>
        <div class="app-title">
          <span class="title-icon"><svg class="icon"><use href="#i-bot"></use></svg></span>
          <h1>larkbot 控制台</h1>
        </div>
        <div class="sub">调整当前 bot 配置。App 凭证变更需要重启 daemon 后生效。</div>
        <div class="summary-grid" aria-label="运行概览">
          <div class="summary-item">
            <span class="summary-label"><svg class="icon sm"><use href="#i-shield"></use></svg>Bot 状态</span>
            <span id="summary-bot" class="summary-value">加载中</span>
          </div>
          <div class="summary-item">
            <span class="summary-label"><svg class="icon sm"><use href="#i-users"></use></svg>已启用群</span>
            <span id="summary-chats" class="summary-value">-</span>
          </div>
          <div class="summary-item">
            <span class="summary-label"><svg class="icon sm"><use href="#i-activity"></use></svg>活跃会话</span>
            <span id="summary-sessions" class="summary-value">-</span>
          </div>
          <div class="summary-item">
            <span class="summary-label"><svg class="icon sm"><use href="#i-cpu"></use></svg>当前模型</span>
            <span id="summary-model" class="summary-value">默认</span>
          </div>
        </div>
      </header>
      <form id="bot-form">
        <div class="row">
          <label>名称
            <input name="name" type="text" autocomplete="off">
          </label>
          <label>工作目录
            <input name="cwd" type="text" autocomplete="off">
          </label>
        </div>
        <div class="row">
          <label>Lark App ID
            <input name="appId" type="text" autocomplete="off">
          </label>
          <label>Lark App Secret
            <input name="appSecret" type="password" autocomplete="new-password" placeholder="留空表示不修改">
          </label>
        </div>
        <label>Owner Open ID
          <input name="ownerOpenId" type="text" autocomplete="off">
          <span class="hint">管理者 open_id，默认也具备提问和操作权限。</span>
        </label>
        <label>授权用户 Open IDs
          <textarea name="allowedOpenIds" rows="3" autocomplete="off" placeholder="每行一个 open_id，也支持用逗号分隔"></textarea>
          <span class="hint">允许 QA、客户端、前端同学在群里直接提问或操作卡片；Owner 不需要重复填写。</span>
        </label>
        <label>Trae 模型
          <select name="model">
            <option value="">使用 traex 默认模型</option>
          </select>
          <span class="hint">选项来自开发机执行的 traex models；保存后新建会话生效，已有会话保持原模型。</span>
        </label>
        <label class="check">
          <input name="enabled" type="checkbox"> 启用 bot
        </label>
          <label class="check">
            <input name="disableStreamingCard" type="checkbox"> 关闭流式卡片，只使用表情进度
          </label>
          <label>回复卡落款
            <input name="replySignature" type="text" autocomplete="off" placeholder="例如：larkbot">
            <span class="hint">最终回复卡底部只展示落款。留空则使用默认落款。</span>
          </label>
          <section class="prompt-box">
            <div>
              <div class="prompt-title"><svg class="icon"><use href="#i-settings"></use></svg><strong>系统提示词</strong></div>
              <div class="hint">可保存多份提示词，选择后下一轮消息立即生效。</div>
            </div>
            <div class="prompt-head">
              <label>当前提示词
                <select id="prompt-select"></select>
              </label>
              <div class="actions">
                <button id="new-prompt" type="button" class="ghost"><svg class="icon sm"><use href="#i-plus"></use></svg>新建</button>
                <button id="delete-prompt" type="button" class="danger"><svg class="icon sm"><use href="#i-trash"></use></svg>删除</button>
            </div>
            </div>
            <label>提示词名称
              <input id="prompt-name" type="text" autocomplete="off" placeholder="例如：代码审查 / 简洁回答 / 产品顾问">
            </label>
            <label>提示词内容
              <textarea id="prompt-content" placeholder="这里写入会注入到 traex 每轮 prompt 的系统提示词。留空表示不使用。"></textarea>
            </label>
          </section>
        <div class="warn"><svg class="icon sm"><use href="#i-clock"></use></svg><span>当前版本先做配置读写。涉及飞书连接身份的字段保存后，需要重启 daemon 才会重新连接。</span></div>
        <footer>
          <button id="save" type="submit"><svg class="icon sm"><use href="#i-save"></use></svg>保存设置</button>
          <span id="status"></span>
        </footer>
      </form>
    </section>
    <section class="card">
      <div class="toolbar">
        <div>
          <div class="section-title">
            <span class="title-icon"><svg class="icon"><use href="#i-users"></use></svg></span>
            <h2>群聊授权</h2>
          </div>
          <div class="sub">展示 bot 已感知到的群聊。启用后，该群内成员可直接 @ bot 提问；Owner 始终可用。</div>
        </div>
        <button id="refresh-chats" type="button" class="ghost"><svg class="icon sm"><use href="#i-refresh"></use></svg>刷新</button>
      </div>
      <div class="sessions">
        <table class="chat-table">
          <thead>
            <tr>
              <th>群聊</th>
              <th>状态</th>
              <th>来源</th>
              <th>最近感知</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="chats-body">
            <tr><td colspan="5" class="muted">加载中…</td></tr>
          </tbody>
        </table>
      </div>
    </section>
    <section class="card">
      <div class="toolbar">
        <div>
          <div class="section-title">
            <span class="title-icon"><svg class="icon"><use href="#i-thumbs"></use></svg></span>
            <h2>反馈中心</h2>
          </div>
          <div class="sub">查看群成员对分析质量的反馈，支持筛选、复盘备注、状态标记和删除。</div>
        </div>
        <div class="feedback-controls">
          <select id="feedback-filter" aria-label="反馈状态筛选">
            <option value="">全部状态</option>
            <option value="open">未处理</option>
            <option value="reviewing">处理中</option>
            <option value="resolved">已处理</option>
            <option value="ignored">忽略</option>
          </select>
          <button id="refresh-feedbacks" type="button" class="ghost"><svg class="icon sm"><use href="#i-refresh"></use></svg>刷新</button>
        </div>
      </div>
      <div id="feedback-stats" class="feedback-stats"></div>
      <div class="sessions">
        <table class="feedback-table">
          <colgroup>
            <col style="width: 120px">
            <col style="width: 110px">
            <col style="width: 330px">
            <col style="width: 180px">
            <col style="width: 150px">
            <col style="width: 260px">
            <col style="width: 230px">
          </colgroup>
          <thead>
            <tr>
              <th>评价</th>
              <th>状态</th>
              <th>问题 / 回答 / 知识库</th>
              <th>群聊 / 点击人</th>
              <th>原因</th>
              <th>复盘备注</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="feedbacks-body">
            <tr><td colspan="7" class="muted">加载中…</td></tr>
          </tbody>
        </table>
      </div>
    </section>
    <section class="card">
      <div class="toolbar">
        <div>
          <div class="section-title">
            <span class="title-icon"><svg class="icon"><use href="#i-message"></use></svg></span>
            <h2>会话管理</h2>
          </div>
          <div class="sub">查看飞书话题到 traex 原生会话的路由。关闭会杀掉正在运行的 runtime，删除会移除路由记录。</div>
        </div>
        <button id="refresh-sessions" type="button" class="ghost"><svg class="icon sm"><use href="#i-refresh"></use></svg>刷新</button>
      </div>
      <div class="sessions">
        <table class="session-table">
          <colgroup>
            <col style="width: 300px">
            <col style="width: 92px">
            <col style="width: 116px">
            <col style="width: 170px">
            <col style="width: 120px">
            <col style="width: 230px">
            <col style="width: 140px">
            <col style="width: 112px">
          </colgroup>
          <thead>
            <tr>
              <th>会话</th>
              <th>状态</th>
              <th>发起人</th>
              <th>群聊</th>
              <th>CLI</th>
              <th>位置</th>
              <th>时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="sessions-body">
            <tr><td colspan="8" class="muted">加载中…</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const form = document.querySelector('#bot-form');
    const status = document.querySelector('#status');
    const save = document.querySelector('#save');
    const sessionsBody = document.querySelector('#sessions-body');
    const refreshSessions = document.querySelector('#refresh-sessions');
    const chatsBody = document.querySelector('#chats-body');
    const refreshChats = document.querySelector('#refresh-chats');
    const feedbacksBody = document.querySelector('#feedbacks-body');
    const refreshFeedbacks = document.querySelector('#refresh-feedbacks');
    const feedbackFilter = document.querySelector('#feedback-filter');
    const feedbackStats = document.querySelector('#feedback-stats');
      const summaryBot = document.querySelector('#summary-bot');
      const summaryChats = document.querySelector('#summary-chats');
      const summarySessions = document.querySelector('#summary-sessions');
      const summaryModel = document.querySelector('#summary-model');
      const promptSelect = document.querySelector('#prompt-select');
      const promptName = document.querySelector('#prompt-name');
      const promptContent = document.querySelector('#prompt-content');
      const newPrompt = document.querySelector('#new-prompt');
      const deletePrompt = document.querySelector('#delete-prompt');
      let latestBot = null;
      let latestChats = [];
      let latestSessions = [];
      let latestFeedbacks = [];
      let promptProfiles = [];
      let activePromptId = '';

    function setStatus(text, failed = false) {
      status.textContent = text;
      status.style.color = failed ? 'var(--danger)' : 'var(--text-soft)';
    }

    function updateSummary() {
      if (latestBot) {
        summaryBot.textContent = latestBot.enabled ? '已启用' : '已停用';
        summaryModel.textContent = latestBot.model || '默认模型';
      }
      const enabledChats = latestChats.filter((chat) => chat.enabled).length;
      summaryChats.textContent = latestChats.length ? enabledChats + ' / ' + latestChats.length : '0';
      summarySessions.textContent = String(latestSessions.filter((session) => session.status === 'active').length);
    }

    async function loadModels() {
      const selected = form.model.value;
      const res = await fetch('/api/models');
      if (!res.ok) throw new Error(await res.text());
      const { models } = await res.json();
      form.model.innerHTML = '<option value="">使用 traex 默认模型</option>';
      for (const model of Array.isArray(models) ? models : []) {
        ensureModelOption(model);
      }
      ensureModelOption(selected);
      form.model.value = selected;
    }

    async function loadBot() {
      const res = await fetch('/api/bot');
      if (!res.ok) throw new Error(await res.text());
      const { bot } = await res.json();
      latestBot = bot;
      form.name.value = bot.name || '';
      form.cwd.value = bot.cwd || '';
      form.appId.value = bot.appId || '';
      form.appSecret.value = '';
      form.ownerOpenId.value = bot.ownerOpenId || '';
      form.allowedOpenIds.value = Array.isArray(bot.allowedOpenIds) ? bot.allowedOpenIds.join('\\n') : '';
      ensureModelOption(bot.model || '');
      form.model.value = bot.model || '';
      form.enabled.checked = !!bot.enabled;
      form.disableStreamingCard.checked = !!bot.disableStreamingCard;
        form.replySignature.value = bot.replySignature || '';
      form.appSecret.placeholder = bot.appSecretSet ? '已设置，留空表示不修改' : '尚未设置';
        promptProfiles = Array.isArray(bot.systemPromptProfiles) ? bot.systemPromptProfiles.map((p) => ({ ...p })) : [];
        activePromptId = bot.activeSystemPromptProfileId || '';
        renderPromptProfiles();
      updateSummary();
      setStatus('已加载');
    }

      function syncPromptEditorToState() {
        if (!activePromptId) return;
        const profile = promptProfiles.find((item) => item.id === activePromptId);
        if (!profile) return;
        profile.name = promptName.value;
        profile.content = promptContent.value;
      }

      function renderPromptProfiles() {
        if (activePromptId && !promptProfiles.some((item) => item.id === activePromptId)) activePromptId = '';
        promptSelect.innerHTML = '<option value="">不使用系统提示词</option>' + promptProfiles.map((profile) =>
          '<option value="' + esc(profile.id) + '">' + esc(profile.name || '未命名提示词') + '</option>'
        ).join('');
        promptSelect.value = activePromptId;
        const profile = promptProfiles.find((item) => item.id === activePromptId);
        promptName.value = profile?.name || '';
        promptContent.value = profile?.content || '';
        promptName.disabled = !profile;
        promptContent.disabled = !profile;
        deletePrompt.disabled = !profile;
      }

      promptSelect.addEventListener('change', () => {
        syncPromptEditorToState();
        activePromptId = promptSelect.value;
        renderPromptProfiles();
      });

      promptName.addEventListener('input', () => {
        syncPromptEditorToState();
        const option = promptSelect.querySelector('option[value="' + CSS.escape(activePromptId) + '"]');
        if (option) option.textContent = promptName.value || '未命名提示词';
      });
      promptContent.addEventListener('input', syncPromptEditorToState);

      newPrompt.addEventListener('click', () => {
        syncPromptEditorToState();
        const profile = {
          id: 'profile-' + Date.now().toString(36),
          name: '新提示词',
          content: '',
        };
        promptProfiles.push(profile);
        activePromptId = profile.id;
        renderPromptProfiles();
        promptName.focus();
        promptName.select();
      });

      deletePrompt.addEventListener('click', () => {
        if (!activePromptId) return;
        const profile = promptProfiles.find((item) => item.id === activePromptId);
        if (profile && !confirm('删除提示词「' + (profile.name || '未命名提示词') + '」？')) return;
        promptProfiles = promptProfiles.filter((item) => item.id !== activePromptId);
        activePromptId = '';
        renderPromptProfiles();
      });

    function esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[ch]));
    }

    function ensureModelOption(value) {
      const model = String(value || '').trim();
      if (!model) return;
      if ([...form.model.options].some((option) => option.value === model)) return;
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      form.model.appendChild(option);
    }

    function compact(value, len = 32) {
      const text = String(value ?? '').trim();
      return text.length > len ? text.slice(0, len - 1) + '…' : text;
    }

    function formatTime(value) {
      if (!value) return '-';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    }

    function statusText(value) {
      return value === 'active' ? '运行中' : value === 'closed' ? '已关闭' : value;
    }

    function sourceText(value) {
      return value === 'bot_added' ? '入群事件' : '群消息';
    }

    function feedbackStatusText(value) {
      return value === 'open' ? '未处理'
        : value === 'reviewing' ? '处理中'
        : value === 'resolved' ? '已处理'
        : value === 'ignored' ? '已忽略'
        : value;
    }

    function ratingText(value) {
      return value === 'positive' ? '👍 有帮助' : '👎 拉完了';
    }

    function oneLine(value, len = 90) {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      return text.length > len ? text.slice(0, len - 1) + '…' : text;
    }

    function knowledgeText(item) {
      const knowledge = item.knowledge;
      if (!knowledge) return '知识库：暂无记录';
      if (Array.isArray(knowledge.references) && knowledge.references.length) {
        return '知识库：' + knowledge.references.slice(0, 3).map((ref) => ref.path).join('、');
      }
      return '知识库：' + (knowledge.noReferenceReason || '未检测到知识库引用');
    }

    function feedbackStatsHtml(feedbacks) {
      const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const recentNegatives = feedbacks.filter((item) => item.rating === 'negative' && Date.parse(item.createdAt) >= since);
      const reasons = new Map();
      for (const item of recentNegatives) {
        const key = item.reason || '未补充原因';
        reasons.set(key, (reasons.get(key) || 0) + 1);
      }
      const parts = ['<span class="feedback-stat negative">近 7 天差评 ' + recentNegatives.length + '</span>'];
      for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
        parts.push('<span class="feedback-stat">' + esc(reason) + ' × ' + count + '</span>');
      }
      return parts.join('');
    }

    async function loadSessions() {
      const res = await fetch('/api/sessions');
      if (!res.ok) throw new Error(await res.text());
      const { sessions } = await res.json();
      latestSessions = Array.isArray(sessions) ? sessions : [];
      updateSummary();
      if (!sessions.length) {
        sessionsBody.innerHTML = '<tr><td colspan="8"><span class="empty-state"><svg class="icon sm"><use href="#i-inbox"></use></svg>暂无会话</span></td></tr>';
        return;
      }
      sessionsBody.innerHTML = sessions.map((s) => {
        const closed = s.status === 'closed';
        return '<tr>' +
          '<td><span class="line"><strong>' + esc(s.title || s.sessionId) + '</strong></span><span class="line muted"><code>' + esc(s.sessionId) + '</code></span></td>' +
          '<td><span class="status ' + esc(s.status) + '">' + esc(statusText(s.status)) + '</span></td>' +
          '<td><span class="line">' + esc(s.createdByDisplayName || s.createdByName || s.createdByOpenId || '-') + '</span><span class="line muted">' + esc(s.lastCallerDisplayName || s.lastCallerOpenId || '-') + '</span></td>' +
          '<td><span class="line">' + esc(s.chatName || s.chatId || '-') + '</span><span class="line muted">' + esc(s.chatId || '-') + '</span></td>' +
          '<td><span class="line">' + esc(s.cliId || '-') + '</span><span class="line muted">' + esc(s.cliSessionId || 'no cli session') + '</span></td>' +
          '<td><span class="line muted">' + esc(s.workingDir || '-') + '</span><span class="line muted">' + esc(s.threadId || s.rootMessageId || '-') + '</span></td>' +
          '<td><span class="line muted">创建 ' + esc(formatTime(s.createdAt)) + '</span><span class="line muted">最后 ' + esc(formatTime(s.lastMessageAt)) + '</span></td>' +
          '<td><div class="actions">' +
            '<button type="button" class="ghost" data-action="close" data-session="' + esc(s.sessionId) + '"' + (closed ? ' disabled' : '') + '><svg class="icon sm"><use href="#i-x"></use></svg>关闭</button>' +
            '<button type="button" class="danger" data-action="delete" data-session="' + esc(s.sessionId) + '"><svg class="icon sm"><use href="#i-trash"></use></svg>删除</button>' +
          '</div></td>' +
        '</tr>';
      }).join('');
    }

    async function loadChats() {
      const res = await fetch('/api/chats');
      if (!res.ok) throw new Error(await res.text());
      const { chats } = await res.json();
      latestChats = Array.isArray(chats) ? chats : [];
      updateSummary();
      if (!chats.length) {
        chatsBody.innerHTML = '<tr><td colspan="5"><span class="empty-state"><svg class="icon sm"><use href="#i-inbox"></use></svg>暂无群聊。把 bot 拉进群，或在群里 @ bot 一次后会出现在这里。</span></td></tr>';
        return;
      }
      chatsBody.innerHTML = chats.map((chat) => (
        '<tr>' +
          '<td><strong>' + esc(chat.name || '未命名群聊') + '</strong><br><span class="muted"><code>' + esc(compact(chat.chatId, 32)) + '</code></span></td>' +
          '<td><span class="status ' + (chat.enabled ? 'active' : 'closed') + '">' + (chat.enabled ? '已启用' : '未启用') + '</span></td>' +
          '<td><span class="source-pill">' + esc(sourceText(chat.source)) + '</span></td>' +
          '<td><span class="muted">' + esc(formatTime(chat.lastSeenAt)) + '</span></td>' +
          '<td><div class="actions"><button type="button" class="' + (chat.enabled ? 'danger' : 'ghost') + '" data-chat="' + esc(chat.chatId) + '" data-enabled="' + (chat.enabled ? 'false' : 'true') + '"><svg class="icon sm"><use href="' + (chat.enabled ? '#i-x' : '#i-power') + '"></use></svg>' + (chat.enabled ? '停用' : '启用') + '</button></div></td>' +
        '</tr>'
      )).join('');
    }

    async function loadFeedbacks() {
      const res = await fetch('/api/feedbacks');
      if (!res.ok) throw new Error(await res.text());
      const { feedbacks } = await res.json();
      latestFeedbacks = Array.isArray(feedbacks) ? feedbacks : [];
      feedbackStats.innerHTML = feedbackStatsHtml(latestFeedbacks);
      const statusFilter = feedbackFilter.value;
      const visibleFeedbacks = statusFilter
        ? latestFeedbacks.filter((item) => item.status === statusFilter)
        : latestFeedbacks;
      if (!visibleFeedbacks.length) {
        feedbacksBody.innerHTML = '<tr><td colspan="7"><span class="empty-state"><svg class="icon sm"><use href="#i-inbox"></use></svg>暂无反馈</span></td></tr>';
        return;
      }
      feedbacksBody.innerHTML = visibleFeedbacks.map((item) => (
        '<tr>' +
          '<td><span class="status ' + esc(item.rating) + '">' + esc(ratingText(item.rating)) + '</span><span class="line muted">' + esc(formatTime(item.createdAt)) + '</span></td>' +
          '<td><span class="status ' + esc(item.status) + '">' + esc(feedbackStatusText(item.status)) + '</span></td>' +
          '<td><div class="context-lines">' +
            '<span class="context-line"><strong>' + esc(item.sessionTitle || item.sessionId) + '</strong></span>' +
            '<span class="context-line">问：' + esc(oneLine(item.question || item.sessionTitle || '-', 110)) + '</span>' +
            '<span class="context-line">答：' + esc(oneLine(item.answer || '-', 130)) + '</span>' +
            '<span class="context-line">' + esc(oneLine(knowledgeText(item), 130)) + '</span>' +
            '<span class="line muted"><code>' + esc(item.sessionId) + '</code></span>' +
          '</div></td>' +
          '<td><span class="line">' + esc(item.chatName || item.chatId || '未知群聊') + '</span><span class="line muted">' + esc(item.operatorName || item.operatorId || '-') + '</span></td>' +
          '<td><span class="line">' + esc(item.reason || '-') + '</span><span class="line muted">' + esc(item.note || '') + '</span></td>' +
          '<td><textarea class="review-note" data-feedback-note="' + esc(item.id) + '" placeholder="记录复盘结论">' + esc(item.reviewNote || '') + '</textarea></td>' +
          '<td><div class="actions">' +
            '<select class="feedback-status-select ' + esc(item.status) + '" data-feedback-status="' + esc(item.id) + '" aria-label="反馈状态">' +
              '<option value="open"' + (item.status === 'open' ? ' selected' : '') + '>未处理</option>' +
              '<option value="reviewing"' + (item.status === 'reviewing' ? ' selected' : '') + '>处理中</option>' +
              '<option value="resolved"' + (item.status === 'resolved' ? ' selected' : '') + '>已处理</option>' +
              '<option value="ignored"' + (item.status === 'ignored' ? ' selected' : '') + '>忽略</option>' +
            '</select>' +
            '<button class="ghost" type="button" data-feedback-save-note="' + esc(item.id) + '"><svg class="icon sm"><use href="#i-check"></use></svg>保存备注</button>' +
            '<a href="' + esc(item.terminalUrl || ('/terminal/' + encodeURIComponent(item.sessionId))) + '" target="_blank"><button class="ghost" type="button"><svg class="icon sm"><use href="#i-message"></use></svg>过程</button></a>' +
            '<button class="danger" type="button" data-feedback-delete="' + esc(item.id) + '"><svg class="icon sm"><use href="#i-trash"></use></svg>删除</button>' +
          '</div></td>' +
        '</tr>'
      )).join('');
    }

    sessionsBody.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const id = button.dataset.session;
      const action = button.dataset.action;
      if (action === 'delete' && !confirm('删除这个会话路由？这不会删除 traex 原生日志，但会让 larkbot 忘记这条飞书话题映射。')) return;
      button.disabled = true;
      try {
        const res = await fetch('/api/sessions/' + encodeURIComponent(id), {
          method: action === 'close' ? 'PATCH' : 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: action === 'close' ? JSON.stringify({ status: 'closed' }) : undefined,
        });
        if (!res.ok) throw new Error(await res.text());
        await loadSessions();
      } catch (error) {
        alert('操作失败：' + error.message);
        button.disabled = false;
      }
    });

    refreshSessions.addEventListener('click', () => {
      loadSessions().catch((error) => alert('刷新失败：' + error.message));
    });

    chatsBody.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-chat]');
      if (!button) return;
      const chatId = button.dataset.chat;
      const enabled = button.dataset.enabled === 'true';
      if (!enabled && !confirm('停用这个群聊？群内非 Owner 用户将不能继续使用 bot。')) return;
      button.disabled = true;
      try {
        const res = await fetch('/api/chats/' + encodeURIComponent(chatId), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });
        if (!res.ok) throw new Error(await res.text());
        await loadChats();
      } catch (error) {
        alert('操作失败：' + error.message);
        button.disabled = false;
      }
    });

    refreshChats.addEventListener('click', () => {
      loadChats().catch((error) => alert('刷新失败：' + error.message));
    });

    feedbacksBody.addEventListener('change', async (event) => {
      const select = event.target.closest('select[data-feedback-status]');
      if (!select) return;
      select.disabled = true;
      try {
        const res = await fetch('/api/feedbacks/' + encodeURIComponent(select.dataset.feedbackStatus), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: select.value }),
        });
        if (!res.ok) throw new Error(await res.text());
        await loadFeedbacks();
      } catch (error) {
        alert('更新反馈状态失败：' + error.message);
        await loadFeedbacks().catch(() => undefined);
      }
    });

    feedbacksBody.addEventListener('click', async (event) => {
      const saveNote = event.target.closest('button[data-feedback-save-note]');
      if (saveNote) {
        const feedbackId = saveNote.dataset.feedbackSaveNote;
        const textarea = [...feedbacksBody.querySelectorAll('textarea[data-feedback-note]')]
          .find((item) => item.dataset.feedbackNote === feedbackId);
        saveNote.disabled = true;
        try {
          const res = await fetch('/api/feedbacks/' + encodeURIComponent(feedbackId), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reviewNote: textarea ? textarea.value : '' }),
          });
          if (!res.ok) throw new Error(await res.text());
          await loadFeedbacks();
        } catch (error) {
          alert('保存复盘备注失败：' + error.message);
          saveNote.disabled = false;
        }
        return;
      }
      const button = event.target.closest('button[data-feedback-delete]');
      if (!button) return;
      if (!confirm('删除这条反馈记录？')) return;
      button.disabled = true;
      try {
        const res = await fetch('/api/feedbacks/' + encodeURIComponent(button.dataset.feedbackDelete), { method: 'DELETE' });
        if (!res.ok) throw new Error(await res.text());
        await loadFeedbacks();
      } catch (error) {
        alert('删除反馈失败：' + error.message);
        button.disabled = false;
      }
    });

    refreshFeedbacks.addEventListener('click', () => {
      loadFeedbacks().catch((error) => alert('刷新反馈失败：' + error.message));
    });

    feedbackFilter.addEventListener('change', () => {
      loadFeedbacks().catch((error) => alert('筛选反馈失败：' + error.message));
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      save.disabled = true;
      setStatus('保存中…');
        syncPromptEditorToState();
      const payload = {
        name: form.name.value,
        cwd: form.cwd.value,
        appId: form.appId.value,
        appSecret: form.appSecret.value,
        ownerOpenId: form.ownerOpenId.value,
        allowedOpenIds: form.allowedOpenIds.value,
        model: form.model.value,
        enabled: form.enabled.checked,
        disableStreamingCard: form.disableStreamingCard.checked,
          replySignature: form.replySignature.value,
          systemPromptProfiles: promptProfiles,
          activeSystemPromptProfileId: activePromptId,
      };
      try {
        const res = await fetch('/api/bot', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(await res.text());
        form.appSecret.value = '';
        await loadBot();
        setStatus('已保存');
      } catch (error) {
        setStatus('保存失败：' + error.message, true);
      } finally {
        save.disabled = false;
      }
    });

    loadModels()
      .catch((error) => setStatus('模型列表加载失败：' + error.message, true))
      .finally(() => loadBot().catch((error) => setStatus('加载失败：' + error.message, true)));
    loadSessions().catch((error) => {
      sessionsBody.innerHTML = '<tr><td colspan="8"><span class="empty-state"><svg class="icon sm"><use href="#i-x"></use></svg>加载失败：' + esc(error.message) + '</span></td></tr>';
    });
    loadChats().catch((error) => {
      chatsBody.innerHTML = '<tr><td colspan="5"><span class="empty-state"><svg class="icon sm"><use href="#i-x"></use></svg>加载失败：' + esc(error.message) + '</span></td></tr>';
    });
    loadFeedbacks().catch((error) => {
      feedbacksBody.innerHTML = '<tr><td colspan="7"><span class="empty-state"><svg class="icon sm"><use href="#i-x"></use></svg>加载失败：' + esc(error.message) + '</span></td></tr>';
    });
  </script>
</body>
</html>`;
}

function renderTraceHtml(trace: TurnTrace): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(trace.title)} · 分析过程</title>
  <style>
    :root { color-scheme: light; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7fb; color: #1f2329; }
    main { max-width: 1080px; margin: 32px auto; padding: 0 20px; }
    .card { background: #fff; border: 1px solid #dee0e3; border-radius: 16px; box-shadow: 0 10px 30px rgba(31,35,41,.06); overflow: hidden; }
    header { padding: 22px 26px; border-bottom: 1px solid #eff0f1; }
    h1 { margin: 0; font-size: 22px; }
    .meta { margin-top: 8px; color: #646a73; font-size: 13px; display: flex; gap: 12px; flex-wrap: wrap; }
    pre { margin: 0; padding: 24px 26px; white-space: pre-wrap; word-break: break-word; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .empty { color: #8f959e; }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <header>
        <h1>${escapeHtml(trace.title || '分析过程')}</h1>
        <div class="meta">
          <span>状态：${escapeHtml(trace.status)}</span>
          <span>创建：${escapeHtml(trace.createdAt)}</span>
          <span>更新：${escapeHtml(trace.updatedAt)}</span>
          <span>Turn：${escapeHtml(trace.id)}</span>
        </div>
      </header>
      <pre class="${trace.content.trim() ? '' : 'empty'}">${escapeHtml(trace.content.trim() || '暂无分析过程。')}</pre>
    </section>
  </main>
</body>
</html>`;
}

function renderTerminalHtml(session: Session): string {
  const eventUrl = `/api/terminal/${encodeURIComponent(session.sessionId)}/events`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(session.title || '分析过程')} · 只读终端</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css">
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; background: #1a1b26; color: #a9b1d6; overflow: hidden; }
    body { display: flex; flex-direction: column; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 14px; border-bottom: 1px solid #2f3549; background: #16161e; }
    .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 700; }
    .meta { color: #7c8199; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: nowrap; }
    #terminal { flex: 1; min-height: 0; width: 100%; }
    #terminal .xterm { height: 100%; padding: 8px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important; font-size: 13px !important; }
    #status { position: fixed; right: 12px; bottom: 10px; z-index: 10; padding: 3px 8px; border-radius: 999px; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: rgba(26,27,38,.86); color: #e0af68; }
    #status.ok { color: #9ece6a; }
    #status.err { color: #f7768e; }
  </style>
</head>
<body>
  <header>
    <div class="title">${escapeHtml(session.title || '分析过程')}</div>
    <div class="meta">只读 · ${escapeHtml(session.sessionId.slice(0, 8))}</div>
  </header>
  <div id="terminal"></div>
  <div id="status">connecting</div>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.min.js"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0/lib/addon-fit.min.js"><\/script>
  <script>
    const status = document.querySelector('#status');
    const term = new Terminal({
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      scrollback: 5000,
      theme: {
        background: '#1a1b26',
        foreground: '#a9b1d6',
        cursor: '#c0caf5',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#c0caf5',
      },
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(document.querySelector('#terminal'));
    const refit = () => requestAnimationFrame(() => fit.fit());
    if (document.fonts?.ready) document.fonts.ready.then(refit).catch(refit);
    refit();
    window.addEventListener('resize', refit);
    function setStatus(text, cls) {
      status.textContent = text;
      status.className = cls || '';
    }
    let hiddenPromptBlock = false;
    function stripTerminalControl(value) {
      return value
        .replace(/\\x1b\\][^\\x07]*(?:\\x07|\\x1b\\\\)/g, '')
        .replace(/\\x1b\\[[0-?]*[ -/]*[@-~]/g, '');
    }
    function redactPromptEcho(chunk) {
      const visible = stripTerminalControl(chunk);
      if (!visible.trim()) return chunk;
      if (hiddenPromptBlock) {
        if (/<\\/(?:larkbot_routing|larkbot_reminder|larkbot_evidence|system_prompt_profile|user_message|quoted_message|attachments)>/i.test(visible)) hiddenPromptBlock = false;
        return '';
      }
      if (/^\\s*▍/.test(visible)) return '';
      if (/<\\/?(?:session_id|sender|image|file)\\b/i.test(visible)) return '';
      if (/<\\/?(?:larkbot_routing|larkbot_reminder|larkbot_evidence|system_prompt_profile|user_message|quoted_message|attachments)\\b/i.test(visible)) {
        hiddenPromptBlock = !/<\\/(?:larkbot_routing|larkbot_reminder|larkbot_evidence|system_prompt_profile|user_message|quoted_message|attachments)>/i.test(visible);
        return '';
      }
      return chunk;
    }
    const events = new EventSource(${JSON.stringify(eventUrl)});
    events.addEventListener('data', (event) => {
      const payload = JSON.parse(event.data);
      if (payload.chunk) {
        const chunk = redactPromptEcho(payload.chunk);
        if (chunk) term.write(chunk);
      }
      setStatus('live', 'ok');
    });
    events.addEventListener('status', (event) => {
      const payload = JSON.parse(event.data);
      setStatus(payload.status || 'connected', payload.status === 'closed' ? '' : 'ok');
    });
    events.onerror = () => setStatus('disconnected', 'err');
  </script>
</body>
</html>`;
}

function renderSessionInterruptedHtml(session: Session): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>分析已停止</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f8fa; color: #1f2329; font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(420px, calc(100vw - 32px)); border: 1px solid #dee0e3; border-radius: 14px; background: #fff; padding: 24px; box-shadow: 0 12px 32px rgba(31,35,41,.08); }
    h1 { margin: 0 0 8px; font-size: 18px; }
    p { margin: 0; color: #646a73; line-height: 1.6; }
    code { color: #3370ff; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  </style>
</head>
<body>
  <main>
    <h1>分析已停止</h1>
    <p>会话 <code>${escapeHtml(session.sessionId)}</code> 仍会保留，可以继续发送新消息。</p>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
