import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
    listSessions(): PublicSession[];
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
    if (req.method === 'GET' && url.pathname === '/office') {
      sendHtml(res, renderOfficeHtml());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/vendor/three.module.js') {
      await sendThreeModule(res);
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

type PublicSession = Session & { runtimeStatus?: 'idle' | 'busy'; turnStartedAt?: string; createdByDisplayName?: string; lastCallerDisplayName?: string };

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

async function sendThreeModule(res: ServerResponse): Promise<void> {
  const moduleUrl = new URL('../../node_modules/three/build/three.module.js', import.meta.url);
  const source = await readFile(moduleUrl, 'utf8');
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'public, max-age=31536000, immutable',
  });
  res.end(source);
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
      --fun: oklch(63% 0.19 330);
      --fun-soft: oklch(95% 0.045 330);
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
    .console-shell {
      max-width: none;
      min-height: 100vh;
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr);
      gap: 0;
      background: var(--bg);
    }
    .console-sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      padding: 22px 18px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      border-right: 1px solid var(--border);
      background: var(--surface);
      box-shadow: var(--shadow-sm);
      z-index: 5;
    }
    .brand-block { display: flex; align-items: center; gap: 12px; }
    .brand-mark {
      width: 42px;
      height: 42px;
      border-radius: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--primary);
      color: white;
      box-shadow: 0 14px 30px oklch(55% 0.18 258 / .18);
    }
    .brand-name { margin: 0; font-size: 20px; line-height: 1.2; font-weight: 850; }
    .brand-subtitle { margin: 2px 0 0; color: var(--text-muted); font-size: 12px; }
    .side-status {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 13px;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: var(--surface-soft);
    }
    .status-dot {
      width: 9px;
      height: 9px;
      margin-top: 5px;
      border-radius: 999px;
      background: var(--success);
      box-shadow: 0 0 0 4px var(--success-soft);
      flex: 0 0 auto;
    }
    .side-status strong { display: block; font-size: 13px; line-height: 1.4; }
    .side-status span { display: block; margin-top: 2px; color: var(--text-muted); font-size: 12px; line-height: 1.45; }
    .side-nav { display: grid; gap: 6px; }
    .nav-item {
      min-height: 40px;
      padding: 0 12px;
      display: flex;
      align-items: center;
      gap: 10px;
      border-radius: var(--radius);
      color: var(--text-soft);
      text-decoration: none;
      font-size: 14px;
      font-weight: 750;
    }
    .nav-item.active,
    .nav-item:hover {
      background: var(--primary-soft);
      color: var(--primary);
    }
    .side-note {
      margin-top: auto;
      display: flex;
      gap: 10px;
      padding: 13px;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: var(--bg);
      color: var(--text-muted);
      font-size: 12px;
      line-height: 1.55;
    }
    .side-note p { margin: 0; }
    .workspace {
      min-width: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .workspace-header {
      min-height: 108px;
      padding: 22px 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in oklch, var(--bg) 82%, white);
    }
    .eyebrow {
      margin: 0 0 6px;
      color: var(--primary);
      font-size: 11px;
      font-weight: 850;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    .workspace-header h1 { font-size: 30px; letter-spacing: 0; }
    .workspace-copy { margin: 8px 0 0; color: var(--text-soft); line-height: 1.6; max-width: 760px; }
    .header-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .content-frame {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 22px 28px 30px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 336px;
      gap: 20px;
    }
    .primary-column,
    .observer-column {
      min-width: 0;
      display: grid;
      gap: 18px;
      align-content: start;
    }
    .observer-column { position: sticky; top: 0; }
    .overview-card header { background: var(--surface); }
    .overview-title-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
    }
    .office-banner {
      margin-top: 16px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(260px, 360px);
      align-items: center;
      gap: 18px;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 18px;
      background:
        linear-gradient(135deg, oklch(97% 0.025 245), oklch(99% 0.012 120));
      box-shadow: inset 0 1px 0 rgba(255,255,255,.9);
    }
    .office-copy {
      padding: 18px 0 18px 18px;
      min-width: 0;
    }
    .office-copy strong {
      display: block;
      margin-top: 10px;
      font-size: 20px;
      line-height: 1.35;
      color: var(--text);
    }
    .office-copy p {
      margin: 8px 0 0;
      max-width: 620px;
      color: var(--text-soft);
      line-height: 1.65;
      font-size: 14px;
    }
    .office-tags {
      margin-top: 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .office-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 28px;
      padding: 0 10px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--surface);
      color: var(--text-soft);
      font-size: 12px;
      font-weight: 800;
    }
    .office-tag .icon { width: 14px; height: 14px; color: var(--primary); }
    .office-floor {
      min-width: 0;
      align-self: stretch;
      padding: 14px;
      display: grid;
      gap: 10px;
      align-content: center;
      background: oklch(100% 0 0 / .54);
      border-left: 1px solid oklch(89.8% 0.014 255 / .7);
    }
    .office-workers {
      min-width: 0;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(138px, 1fr));
      gap: 10px;
    }
    .worker-card {
      position: relative;
      min-width: 0;
      min-height: 154px;
      padding: 10px;
      display: grid;
      gap: 8px;
      align-content: end;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: linear-gradient(180deg, var(--surface) 0%, var(--surface-soft) 100%);
      box-shadow: var(--shadow-sm);
      overflow: hidden;
    }
    .worker-card.slow {
      border-color: oklch(72% 0.12 72);
      background: linear-gradient(180deg, oklch(99% 0.012 92) 0%, var(--surface) 100%);
    }
    .worker-card.office-nudged .worker-head {
      animation: officeNudge .42s ease-out;
    }
    .worker-time {
      position: absolute;
      top: 8px;
      left: 50%;
      max-width: calc(100% - 18px);
      transform: translateX(-50%);
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--surface);
      color: var(--text);
      font-size: 12px;
      font-weight: 850;
      line-height: 1.25;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .worker-scene {
      height: 72px;
      display: grid;
      place-items: end center;
    }
    .worker-avatar {
      position: relative;
      width: 86px;
      height: 64px;
    }
    .worker-head {
      position: absolute;
      left: 31px;
      top: 2px;
      width: 28px;
      height: 28px;
      border: 2px solid oklch(63% 0.13 76);
      border-radius: 999px;
      background: oklch(91% 0.11 88);
      box-shadow: inset 0 -2px 0 oklch(80% 0.1 82);
    }
    .worker-head::before,
    .worker-head::after {
      content: "";
      position: absolute;
      top: 10px;
      width: 3px;
      height: 3px;
      border-radius: 999px;
      background: var(--text);
    }
    .worker-head::before { left: 7px; }
    .worker-head::after { right: 7px; }
    .worker-body {
      position: absolute;
      left: 24px;
      top: 30px;
      width: 40px;
      height: 28px;
      border: 2px solid oklch(43% 0.14 258);
      border-radius: 12px 12px 6px 6px;
      background: var(--primary);
    }
    .worker-screen {
      position: absolute;
      right: 0;
      bottom: 0;
      width: 36px;
      height: 27px;
      border: 2px solid oklch(76% 0.05 245);
      border-radius: 6px;
      background: var(--surface);
    }
    .worker-screen::before,
    .worker-screen::after {
      content: "";
      position: absolute;
      left: 7px;
      height: 3px;
      border-radius: 999px;
      background: var(--primary);
      animation: officeScan 2.8s ease-in-out infinite;
    }
    .worker-screen::before { top: 8px; width: 14px; }
    .worker-screen::after { top: 16px; width: 22px; animation-delay: .35s; }
    .worker-name {
      min-width: 0;
      color: var(--text);
      font-size: 12px;
      font-weight: 850;
      line-height: 1.35;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: center;
    }
    .worker-meta {
      min-width: 0;
      color: var(--text-muted);
      font-size: 11px;
      line-height: 1.35;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: center;
    }
    .worker-actions {
      display: flex;
      justify-content: center;
    }
    .worker-actions button {
      height: 28px;
      padding: 0 9px;
      font-size: 12px;
    }
    .office-empty {
      min-height: 132px;
      display: grid;
      place-items: center;
      padding: 16px;
      border: 1px dashed var(--border-strong);
      border-radius: var(--radius);
      color: var(--text-muted);
      font-size: 13px;
      line-height: 1.5;
      text-align: center;
      background: var(--surface);
    }
    #office-status {
      min-height: 18px;
      color: var(--text-muted);
      font-size: 12px;
      line-height: 1.45;
    }
    @keyframes officeScan {
      0%, 100% { opacity: .32; transform: translateX(0); }
      50% { opacity: 1; transform: translateX(6px); }
    }
    @keyframes officeNudge {
      0%, 100% { transform: translateX(0) rotate(0deg); }
      25% { transform: translateX(-4px) rotate(-7deg); }
      55% { transform: translateX(4px) rotate(7deg); }
      80% { transform: translateX(-2px) rotate(-3deg); }
    }
    .pipeline {
      margin-top: 14px;
      display: grid;
      grid-template-columns: repeat(5, minmax(120px, 1fr));
      align-items: center;
      gap: 10px;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface-soft);
    }
    .pipeline-step {
      position: relative;
      min-height: 54px;
      padding: 10px 12px;
      display: flex;
      align-items: center;
      gap: 9px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface);
      color: var(--text);
      font-size: 13px;
      font-weight: 850;
      white-space: nowrap;
      box-shadow: 0 8px 18px oklch(27% 0.03 255 / .05);
    }
    .pipeline-step:not(:last-child)::after {
      content: "";
      position: absolute;
      right: -11px;
      top: 50%;
      width: 10px;
      border-top: 2px solid var(--border-strong);
      transform: translateY(-50%);
      z-index: 1;
    }
    .pipeline-step .icon {
      width: 18px;
      height: 18px;
      color: var(--primary);
      flex: 0 0 auto;
    }
    .side-panel {
      padding: 16px;
      display: grid;
      gap: 12px;
    }
    .side-panel .toolbar {
      padding: 0;
      border: 0;
      background: transparent;
    }
    .side-panel h2 { font-size: 16px; }
    .queue-list, .policy-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      gap: 10px;
    }
    .queue-list li {
      display: flex;
      gap: 10px;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface-soft);
    }
    .queue-index {
      color: var(--primary);
      font: 800 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .queue-list strong { display: block; font-size: 13px; }
    .queue-list p { margin: 2px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.45; }
    .terminal-preview {
      margin: 0;
      max-height: 240px;
      overflow: auto;
      border-radius: var(--radius);
      border: 1px solid oklch(29% 0.025 255);
      background: oklch(22% 0.025 255);
      color: oklch(91% 0.01 255);
      padding: 14px;
      font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap;
    }
    .policy-list li {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 9px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
    }
    .policy-list li:last-child { border-bottom: 0; padding-bottom: 0; }
    .policy-list span { color: var(--text-muted); text-align: right; }
    .mini-stat {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      width: fit-content;
      min-height: 26px;
      padding: 0 10px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--surface-soft);
      color: var(--text-soft);
      font-size: 12px;
      font-weight: 800;
    }
    @media (max-width: 1180px) {
      .console-shell { grid-template-columns: 220px minmax(0, 1fr); }
      .content-frame { grid-template-columns: 1fr; }
      .observer-column { position: static; }
      .office-banner { grid-template-columns: 1fr; }
      .office-copy { padding: 16px 16px 0; }
      .office-floor { border-left: 0; border-top: 1px solid oklch(89.8% 0.014 255 / .7); }
      .pipeline { grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); }
      .pipeline-step:not(:last-child)::after { display: none; }
    }
    @media (max-width: 820px) {
      .console-shell { display: block; }
      .console-sidebar { position: static; height: auto; }
      .workspace { height: auto; }
      .workspace-header { flex-direction: column; align-items: flex-start; }
      .content-frame { overflow: visible; padding: 16px; }
      .header-actions { width: 100%; }
      .header-actions button { flex: 1; }
      .office-banner {
        grid-template-columns: minmax(0, 1fr) 180px;
        gap: 10px;
      }
      .office-copy { padding: 14px 0 14px 14px; }
      .office-copy strong { font-size: 18px; }
      .office-copy p { font-size: 13px; }
      .office-workers { grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); }
    }
    @media (max-width: 480px) {
      .office-banner { grid-template-columns: 1fr; }
      .office-copy { padding: 14px 14px 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .worker-screen::before,
      .worker-screen::after,
      .worker-card.office-nudged .worker-head {
        animation: none;
      }
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
    <symbol id="i-check" viewBox="0 0 24 24"><path d="m20 6-11 11-5-5"/></symbol>
    <symbol id="i-database" viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></symbol>
    <symbol id="i-terminal" viewBox="0 0 24 24"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></symbol>
    <symbol id="i-radio" viewBox="0 0 24 24"><path d="M4.9 19.1a10 10 0 0 1 0-14.2"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M19.1 4.9a10 10 0 0 1 0 14.2"/></symbol>
  </svg>
  <main class="console-shell">
    <aside class="console-sidebar" aria-label="控制台导航">
      <div class="brand-block">
        <span class="brand-mark"><svg class="icon"><use href="#i-bot"></use></svg></span>
        <div>
          <p class="brand-name">larkbot</p>
          <p class="brand-subtitle">Developer Stand-in</p>
        </div>
      </div>
      <div class="side-status">
        <span class="status-dot"></span>
        <div>
          <strong id="side-daemon-status">daemon 运行中</strong>
          <span>飞书消息进入后由本地 traex runtime 接管执行。</span>
        </div>
      </div>
      <nav class="side-nav">
        <a class="nav-item active" href="#region-health"><svg class="icon sm"><use href="#i-activity"></use></svg><span>总览</span></a>
        <a class="nav-item" href="/office"><svg class="icon sm"><use href="#i-terminal"></use></svg><span>办公室</span></a>
        <a class="nav-item" href="#region-config"><svg class="icon sm"><use href="#i-settings"></use></svg><span>配置</span></a>
        <a class="nav-item" href="#region-chats"><svg class="icon sm"><use href="#i-users"></use></svg><span>群聊</span></a>
        <a class="nav-item" href="#region-feedback"><svg class="icon sm"><use href="#i-thumbs"></use></svg><span>反馈</span></a>
        <a class="nav-item" href="#region-sessions"><svg class="icon sm"><use href="#i-database"></use></svg><span>会话</span></a>
      </nav>
      <div class="side-note">
        <svg class="icon sm"><use href="#i-shield"></use></svg>
        <p>Owner 控制授权入口；群成员通过飞书提问，本地 daemon 保留会话路由、trace 和反馈闭环。</p>
      </div>
    </aside>
    <section class="workspace">
      <header class="workspace-header">
        <div>
          <p class="eyebrow">Local operations cockpit</p>
          <h1>控制台</h1>
          <p class="workspace-copy">飞书作为团队入口，本地 daemon 负责路由、执行、观察、打断与反馈复盘。</p>
        </div>
        <div class="header-actions">
          <button id="refresh-all" type="button" class="ghost"><svg class="icon sm"><use href="#i-refresh"></use></svg>刷新</button>
          <button id="top-save" type="submit" form="bot-form"><svg class="icon sm"><use href="#i-save"></use></svg>保存</button>
        </div>
      </header>
      <div class="content-frame">
        <div class="primary-column">
    <section id="region-health" class="card overview-card">
      <header>
        <div class="overview-title-row">
        <div class="app-title">
          <span class="title-icon"><svg class="icon"><use href="#i-bot"></use></svg></span>
          <h2>运行健康概览</h2>
        </div>
        <span class="mini-stat"><svg class="icon sm"><use href="#i-radio"></use></svg>长连接模式</span>
        </div>
        <div class="sub">核心链路：飞书事件进入后，larkbot daemon 将消息路由到独立 traex PTY runtime，并把结果回传为卡片。</div>
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
        <div class="pipeline" aria-label="处理链路">
          <span class="pipeline-step"><svg class="icon"><use href="#i-radio"></use></svg>飞书消息</span>
          <span class="pipeline-step"><svg class="icon"><use href="#i-activity"></use></svg>daemon 路由</span>
          <span class="pipeline-step"><svg class="icon"><use href="#i-terminal"></use></svg>traex PTY</span>
          <span class="pipeline-step"><svg class="icon"><use href="#i-message"></use></svg>分析卡</span>
          <span class="pipeline-step"><svg class="icon"><use href="#i-thumbs"></use></svg>反馈闭环</span>
        </div>
      </header>
    </section>
    <section id="region-config" class="card">
      <div class="toolbar">
        <div>
          <div class="section-title">
            <span class="title-icon"><svg class="icon"><use href="#i-settings"></use></svg></span>
            <h2>配置面板</h2>
          </div>
          <div class="sub">调整当前 bot 配置。App 凭证变更需要重启 daemon 后生效。</div>
        </div>
      </div>
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
    <section id="region-chats" class="card">
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
    <section id="region-feedback" class="card">
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
    <section id="region-sessions" class="card">
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
        </div>
        <aside class="observer-column" aria-label="右侧观察栏">
          <section class="card side-panel">
            <div class="toolbar">
              <div>
                <div class="section-title">
                  <span class="title-icon"><svg class="icon"><use href="#i-activity"></use></svg></span>
                  <h2>实时观察</h2>
                </div>
                <div class="sub">用于快速确认当前运行姿态。</div>
              </div>
            </div>
            <ol class="queue-list">
              <li><span class="queue-index">01</span><div><strong>模型</strong><p id="observer-model">默认模型</p></div></li>
              <li><span class="queue-index">02</span><div><strong>提示词</strong><p id="observer-profile">未启用 profile</p></div></li>
              <li><span class="queue-index">03</span><div><strong>反馈</strong><p id="observer-feedback">暂无反馈</p></div></li>
            </ol>
          </section>
          <section class="card side-panel">
            <div class="toolbar">
              <div>
                <div class="section-title">
                  <span class="title-icon"><svg class="icon"><use href="#i-terminal"></use></svg></span>
                  <h2>只读终端</h2>
                </div>
                <div class="sub">从会话表进入完整 trace。</div>
              </div>
            </div>
            <pre class="terminal-preview">[daemon] websocket connected
[route] feishu thread -> larkbot session
[runtime] traex PTY isolated by session
[card] final answer + evidence refs
[feedback] owner review queue ready</pre>
          </section>
          <section class="card side-panel">
            <div class="toolbar">
              <div>
                <div class="section-title">
                  <span class="title-icon"><svg class="icon"><use href="#i-clock"></use></svg></span>
                  <h2>清理策略</h2>
                </div>
              </div>
            </div>
            <ul class="policy-list">
              <li><strong>活跃会话</strong><span id="observer-sessions">0</span></li>
              <li><strong>授权群聊</strong><span id="observer-chats">0</span></li>
              <li><strong>过程入口</strong><span id="observer-terminal">只读</span></li>
            </ul>
            <div class="warn"><svg class="icon sm"><use href="#i-shield"></use></svg><span>关闭会话会终止 runtime；删除只移除 larkbot 路由记录。</span></div>
          </section>
        </aside>
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
    const refreshAll = document.querySelector('#refresh-all');
    const sideDaemonStatus = document.querySelector('#side-daemon-status');
    const observerModel = document.querySelector('#observer-model');
    const observerProfile = document.querySelector('#observer-profile');
    const observerFeedback = document.querySelector('#observer-feedback');
    const observerSessions = document.querySelector('#observer-sessions');
    const observerChats = document.querySelector('#observer-chats');
    const observerTerminal = document.querySelector('#observer-terminal');
      const officeWorkers = document.querySelector('#office-workers');
      const officeStatus = document.querySelector('#office-status');
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
        sideDaemonStatus.textContent = latestBot.enabled ? 'daemon 运行中' : 'daemon 已停用';
        observerModel.textContent = latestBot.model || '使用 traex 默认模型';
        const activeProfile = (latestBot.systemPromptProfiles || []).find((item) => item.id === latestBot.activeSystemPromptProfileId);
        observerProfile.textContent = activeProfile ? activeProfile.name : '未启用 profile';
      }
      const enabledChats = latestChats.filter((chat) => chat.enabled).length;
      const openFeedbacks = latestFeedbacks.filter((item) => item.status === 'open').length;
      const negativeFeedbacks = latestFeedbacks.filter((item) => item.rating === 'negative').length;
      const activeSessions = latestSessions.filter((session) => session.status === 'active').length;
      summaryChats.textContent = latestChats.length ? enabledChats + ' / ' + latestChats.length : '0';
      summarySessions.textContent = String(activeSessions);
      observerSessions.textContent = String(activeSessions);
      observerChats.textContent = latestChats.length ? enabledChats + ' / ' + latestChats.length : '0';
      observerFeedback.textContent = latestFeedbacks.length
        ? '待处理 ' + openFeedbacks + '，差评 ' + negativeFeedbacks
        : '暂无反馈';
      observerTerminal.textContent = activeSessions ? '可进入' : '等待会话';
      renderOffice();
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

    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '刚开始';
      const minutes = Math.floor(ms / 60000);
      if (minutes < 1) return '刚开始';
      if (minutes < 60) return minutes + ' 分钟';
      const hours = Math.floor(minutes / 60);
      const restMinutes = minutes % 60;
      if (hours < 24) return hours + ' 小时' + (restMinutes ? ' ' + restMinutes + ' 分钟' : '');
      const days = Math.floor(hours / 24);
      const restHours = hours % 24;
      return days + ' 天' + (restHours ? ' ' + restHours + ' 小时' : '');
    }

    function renderOffice() {
      if (!officeWorkers || !officeStatus) return;
      const active = latestSessions.filter((session) => session.status === 'active');
      if (!active.length) {
        officeWorkers.innerHTML = '<div class="office-empty">办公室暂时没人加班，新的飞书话题会自动变成员工工位。</div>';
        officeStatus.textContent = '等待会话进入办公室';
        return;
      }
      const now = Date.now();
      const visible = active.slice(0, 6);
      const slowCount = active.filter((session) => {
        const workingSince = Date.parse(session.turnStartedAt || '');
        return session.runtimeStatus === 'busy' && Number.isFinite(workingSince) && now - workingSince >= 3 * 60 * 1000;
      }).length;
      officeWorkers.innerHTML = visible.map((session) => {
        const workingSince = Date.parse(session.turnStartedAt || '');
        const working = Number.isFinite(workingSince) ? now - workingSince : 0;
        const busy = session.runtimeStatus === 'busy';
        const slow = busy && working >= 3 * 60 * 1000;
        const workerName = session.title || session.createdByDisplayName || session.createdByName || session.sessionId;
        const meta = compact(session.chatName || session.chatId || '群聊', 18);
        return '<article class="worker-card ' + (slow ? 'slow' : '') + '" data-session="' + esc(session.sessionId) + '">' +
          '<div class="worker-time" title="' + esc(busy ? '本轮问题处理时长' : '当前没有正在处理的问题') + '">' + esc(busy ? '等 ' + formatDuration(working) : '待命') + '</div>' +
          '<div class="worker-scene" aria-hidden="true">' +
            '<div class="worker-avatar">' +
              '<span class="worker-head"></span>' +
              '<span class="worker-body"></span>' +
              '<span class="worker-screen"></span>' +
            '</div>' +
          '</div>' +
          '<div class="worker-name" title="' + esc(workerName) + '">' + esc(compact(workerName, 18)) + '</div>' +
          '<div class="worker-meta" title="按当前 runtime 状态判断">' + esc(meta) + ' · ' + esc(busy ? (slow ? '超过 3 分钟' : '处理中') : '在办公室') + '</div>' +
          '<div class="worker-actions">' +
            '<button type="button" class="' + (slow ? 'danger' : 'ghost') + '" data-office-nudge="' + esc(session.sessionId) + '" aria-label="敲打 ' + esc(workerName) + '" title="只触发控制台提醒动画，不会影响会话运行"' + (slow ? '' : ' disabled') + '>' +
              '<svg class="icon sm"><use href="#i-activity"></use></svg>' + (slow ? '敲打' : (busy ? '处理中' : '待命')) +
            '</button>' +
          '</div>' +
        '</article>';
      }).join('');
      const busyCount = active.filter((session) => session.runtimeStatus === 'busy').length;
      officeStatus.textContent = active.length + ' 个员工在办公室，' + busyCount + ' 个正在干活' + (slowCount ? '，' + slowCount + ' 个超过 3 分钟可敲打' : '') + (active.length > visible.length ? '，其余在会话表' : '');
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
      updateSummary();
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

    officeWorkers?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-office-nudge]');
      if (!button) return;
      const id = button.dataset.officeNudge;
      const card = id ? officeWorkers.querySelector('[data-session="' + CSS.escape(id) + '"]') : null;
      const session = latestSessions.find((item) => item.sessionId === id);
      if (!card || !session) return;
      card.classList.remove('office-nudged');
      void card.offsetWidth;
      card.classList.add('office-nudged');
      button.textContent = '已敲打';
      officeStatus.textContent = '已敲打 ' + compact(session.title || session.sessionId, 22) + '，只是控制台动画，不会打断任务。';
      window.setTimeout(() => {
        card.classList.remove('office-nudged');
        renderOffice();
      }, 900);
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

    refreshAll.addEventListener('click', () => {
      Promise.all([
        loadBot(),
        loadModels(),
        loadChats(),
        loadSessions(),
        loadFeedbacks(),
      ]).catch((error) => alert('刷新失败：' + error.message));
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
    window.setInterval(renderOffice, 30000);
  </script>
</body>
</html>`;
}

function renderOfficeHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>办公室 · larkbot 控制台</title>
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
      --danger-soft: oklch(94% 0.045 24);
      --warning: oklch(54% 0.12 70);
      --warning-soft: oklch(96% 0.055 78);
      --radius: 8px;
      --shadow-sm: 0 1px 2px oklch(24% 0.02 255 / .06);
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    .icon { width: 16px; height: 16px; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; fill: none; flex: 0 0 auto; }
    .icon.sm { width: 14px; height: 14px; }
    .console-shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr);
      background: var(--bg);
    }
    .console-sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      padding: 22px 18px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      border-right: 1px solid var(--border);
      background: var(--surface);
      box-shadow: var(--shadow-sm);
      z-index: 5;
    }
    .brand-block { display: flex; align-items: center; gap: 12px; }
    .brand-mark {
      width: 42px;
      height: 42px;
      border-radius: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--primary);
      color: white;
      box-shadow: 0 14px 30px oklch(55% 0.18 258 / .18);
    }
    .brand-name { margin: 0; font-size: 20px; line-height: 1.2; font-weight: 850; }
    .brand-subtitle { margin: 2px 0 0; color: var(--text-muted); font-size: 12px; }
    .side-status {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 13px;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: var(--surface-soft);
    }
    .status-dot {
      width: 9px;
      height: 9px;
      margin-top: 5px;
      border-radius: 999px;
      background: var(--success);
      box-shadow: 0 0 0 4px var(--success-soft);
      flex: 0 0 auto;
    }
    .side-status strong { display: block; font-size: 13px; line-height: 1.4; }
    .side-status span { display: block; margin-top: 2px; color: var(--text-muted); font-size: 12px; line-height: 1.45; }
    .side-nav { display: grid; gap: 6px; }
    .nav-item {
      min-height: 40px;
      padding: 0 12px;
      display: flex;
      align-items: center;
      gap: 10px;
      border-radius: var(--radius);
      color: var(--text-soft);
      text-decoration: none;
      font-size: 14px;
      font-weight: 750;
    }
    .nav-item.active,
    .nav-item:hover { background: var(--primary-soft); color: var(--primary); }
    .side-note {
      margin-top: auto;
      display: flex;
      gap: 10px;
      padding: 13px;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: var(--bg);
      color: var(--text-muted);
      font-size: 12px;
      line-height: 1.55;
    }
    .side-note p { margin: 0; }
    .office-workspace {
      min-width: 0;
      height: 100vh;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .office-header {
      min-height: 108px;
      padding: 22px 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in oklch, var(--bg) 82%, white);
    }
    .eyebrow { margin: 0 0 6px; color: var(--primary); font-size: 11px; font-weight: 850; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; font-size: 30px; line-height: 1.25; letter-spacing: 0; }
    .office-copy { margin: 8px 0 0; color: var(--text-soft); line-height: 1.6; max-width: 760px; }
    .office-stats { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .stat-pill {
      min-height: 30px;
      padding: 0 11px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--surface);
      color: var(--text-soft);
      font-size: 12px;
      font-weight: 850;
      white-space: nowrap;
    }
    .stat-pill.warn { background: var(--warning-soft); color: var(--warning); border-color: oklch(82% 0.08 78); }
    .office-stage {
      position: relative;
      min-height: 0;
      overflow: hidden;
      background:
        radial-gradient(circle at 20% 18%, oklch(97% 0.025 245), transparent 28%),
        linear-gradient(180deg, oklch(99% 0.008 250), oklch(94% 0.018 245));
    }
    #office-canvas {
      width: 100%;
      height: 100%;
      min-height: 520px;
      display: block;
      outline: 0;
    }
    .office-overlay {
      position: absolute;
      left: 20px;
      right: 20px;
      bottom: 18px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 12px;
      pointer-events: none;
    }
    #office-status {
      max-width: min(680px, 100%);
      padding: 10px 12px;
      border: 1px solid oklch(100% 0 0 / .6);
      border-radius: var(--radius);
      background: oklch(100% 0 0 / .78);
      color: var(--text-soft);
      font-size: 13px;
      line-height: 1.5;
      box-shadow: var(--shadow-sm);
      backdrop-filter: blur(10px);
    }
    .office-empty {
      position: absolute;
      inset: 0;
      display: none;
      place-items: center;
      padding: 24px;
      color: var(--text-muted);
      font-size: 14px;
      text-align: center;
      pointer-events: none;
    }
    .office-empty.visible { display: grid; }
    button {
      height: 36px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius);
      background: var(--surface);
      color: var(--text);
      padding: 0 16px;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
      transition: background .15s ease, box-shadow .15s ease, transform .15s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      white-space: nowrap;
    }
    button:hover { background: var(--surface-tint); transform: translateY(-1px); box-shadow: 0 8px 18px oklch(24% 0.02 255 / .08); }
    @media (max-width: 820px) {
      .console-shell { display: block; }
      .console-sidebar { position: static; height: auto; }
      .office-workspace { height: auto; min-height: 100vh; }
      .office-header { flex-direction: column; align-items: flex-start; padding: 18px; }
      .office-stats { justify-content: flex-start; }
      #office-canvas { min-height: 620px; }
      .office-overlay { left: 14px; right: 14px; bottom: 14px; }
    }
    @media (prefers-reduced-motion: reduce) {
      * { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; }
    }
  </style>
</head>
<body>
  <svg aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">
    <symbol id="i-bot" viewBox="0 0 24 24"><path d="M12 8V4"/><path d="M8 4h8"/><rect x="5" y="8" width="14" height="11" rx="3"/><path d="M9 13h.01"/><path d="M15 13h.01"/><path d="M9 17h6"/></symbol>
    <symbol id="i-users" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></symbol>
    <symbol id="i-message" viewBox="0 0 24 24"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></symbol>
    <symbol id="i-settings" viewBox="0 0 24 24"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.08V21a2 2 0 0 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.08-.4H3a2 2 0 0 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.08V3a2 2 0 0 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.08.4H21a2 2 0 0 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z"/></symbol>
    <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-5"/></symbol>
    <symbol id="i-activity" viewBox="0 0 24 24"><path d="M22 12h-4l-3 8-6-16-3 8H2"/></symbol>
    <symbol id="i-terminal" viewBox="0 0 24 24"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></symbol>
    <symbol id="i-database" viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3"/></symbol>
  </svg>
  <main class="console-shell">
    <aside class="console-sidebar" aria-label="控制台导航">
      <div class="brand-block">
        <span class="brand-mark"><svg class="icon"><use href="#i-bot"></use></svg></span>
        <div>
          <p class="brand-name">larkbot</p>
          <p class="brand-subtitle">Developer Stand-in</p>
        </div>
      </div>
      <div class="side-status">
        <span class="status-dot"></span>
        <div>
          <strong id="side-daemon-status">daemon 运行中</strong>
          <span>飞书消息进入后由本地 traex runtime 接管执行。</span>
        </div>
      </div>
      <nav class="side-nav">
        <a class="nav-item" href="/"><svg class="icon sm"><use href="#i-activity"></use></svg><span>总览</span></a>
        <a class="nav-item active" href="/office"><svg class="icon sm"><use href="#i-terminal"></use></svg><span>办公室</span></a>
        <a class="nav-item" href="/#region-config"><svg class="icon sm"><use href="#i-settings"></use></svg><span>配置</span></a>
        <a class="nav-item" href="/#region-chats"><svg class="icon sm"><use href="#i-users"></use></svg><span>群聊</span></a>
        <a class="nav-item" href="/#region-feedback"><svg class="icon sm"><use href="#i-shield"></use></svg><span>反馈</span></a>
        <a class="nav-item" href="/#region-sessions"><svg class="icon sm"><use href="#i-database"></use></svg><span>会话</span></a>
      </nav>
      <div class="side-note">
        <svg class="icon sm"><use href="#i-shield"></use></svg>
        <p>员工常驻对应活跃会话；慢工位点一下，办公室会立刻热闹起来。</p>
      </div>
    </aside>
    <section class="office-workspace">
      <header class="office-header">
        <div>
          <p class="eyebrow">Office floor</p>
          <h1>办公室</h1>
          <p class="office-copy">每个飞书话题会话是一名员工；待命说明人还在办公室，正在处理时会显示本轮等待时长。</p>
        </div>
        <div class="office-stats">
          <span class="stat-pill"><svg class="icon sm"><use href="#i-users"></use></svg><span id="stat-employees">0 员工</span></span>
          <span class="stat-pill"><svg class="icon sm"><use href="#i-activity"></use></svg><span id="stat-working">0 干活</span></span>
          <span class="stat-pill warn"><svg class="icon sm"><use href="#i-terminal"></use></svg><span id="stat-slow">0 可敲打</span></span>
        </div>
      </header>
      <div class="office-stage">
        <canvas id="office-canvas" aria-label="三维办公室员工视图"></canvas>
        <div id="office-empty" class="office-empty">办公室暂时空着。</div>
        <div class="office-overlay">
          <div id="office-status">办公室加载中</div>
          <button id="refresh-office" type="button"><svg class="icon sm"><use href="#i-activity"></use></svg>刷新</button>
        </div>
      </div>
    </section>
  </main>
  <script type="module">
    import * as THREE from '/vendor/three.module.js';

    const canvas = document.querySelector('#office-canvas');
    const statusEl = document.querySelector('#office-status');
    const emptyEl = document.querySelector('#office-empty');
    const statEmployees = document.querySelector('#stat-employees');
    const statWorking = document.querySelector('#stat-working');
    const statSlow = document.querySelector('#stat-slow');
    const refreshOffice = document.querySelector('#refresh-office');
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const slowMs = 3 * 60 * 1000;
    let latestSessions = [];
    let selectedId = '';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf5f7fb);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 7.2, 8.8);
    camera.lookAt(0, 0, 0);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const hemi = new THREE.HemisphereLight(0xffffff, 0xcbd5e1, 1.8);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(4, 8, 5);
    sun.castShadow = true;
    scene.add(sun);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 14),
      new THREE.MeshStandardMaterial({ color: 0xe8eef8, roughness: 0.82 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(18, 18, 0xb8c3d5, 0xd9e1ee);
    grid.position.y = 0.01;
    scene.add(grid);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const workers = new Map();
    const clickable = [];

    const materials = {
      idleBody: new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.55 }),
      busyBody: new THREE.MeshStandardMaterial({ color: 0x4f7df3, roughness: 0.5 }),
      slowBody: new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.5 }),
      head: new THREE.MeshStandardMaterial({ color: 0xf5c06f, roughness: 0.5 }),
      desk: new THREE.MeshStandardMaterial({ color: 0x8aa2bd, roughness: 0.75 }),
      laptop: new THREE.MeshStandardMaterial({ color: 0x263241, roughness: 0.45 }),
      screen: new THREE.MeshStandardMaterial({ color: 0x8bd3ff, emissive: 0x1d4ed8, emissiveIntensity: 0.18, roughness: 0.25 }),
    };

    function esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[ch]));
    }

    function compact(value, len) {
      const text = String(value ?? '').trim();
      return text.length > len ? text.slice(0, len - 1) + '…' : text;
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '刚开始';
      const minutes = Math.floor(ms / 60000);
      if (minutes < 1) return '刚开始';
      if (minutes < 60) return minutes + ' 分钟';
      const hours = Math.floor(minutes / 60);
      const restMinutes = minutes % 60;
      if (hours < 24) return hours + ' 小时' + (restMinutes ? ' ' + restMinutes + ' 分钟' : '');
      const days = Math.floor(hours / 24);
      const restHours = hours % 24;
      return days + ' 天' + (restHours ? ' ' + restHours + ' 小时' : '');
    }

    function makeLabelTexture(text, tone) {
      const c = document.createElement('canvas');
      c.width = 384;
      c.height = 128;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.fillStyle = tone === 'slow' ? '#fff7ed' : tone === 'busy' ? '#eff6ff' : '#f8fafc';
      ctx.strokeStyle = tone === 'slow' ? '#d97706' : tone === 'busy' ? '#4f7df3' : '#94a3b8';
      ctx.lineWidth = 4;
      roundRect(ctx, 18, 24, 348, 68, 28);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#1f2937';
      ctx.font = '700 30px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 192, 58);
      const texture = new THREE.CanvasTexture(c);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    }

    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function createWorker(session) {
      const group = new THREE.Group();
      group.userData.sessionId = session.sessionId;
      group.userData.nudgeUntil = 0;

      const desk = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.18, 0.72), materials.desk);
      desk.position.set(0, 0.45, 0.04);
      desk.castShadow = true;
      desk.receiveShadow = true;
      group.add(desk);

      const laptop = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.36, 0.04), materials.laptop);
      laptop.position.set(0.25, 0.76, -0.22);
      laptop.rotation.x = -0.35;
      laptop.castShadow = true;
      group.add(laptop);

      const screen = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.24, 0.025), materials.screen);
      screen.position.set(0.25, 0.77, -0.247);
      screen.rotation.x = -0.35;
      group.add(screen);

      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.42, 6, 12), materials.idleBody);
      body.position.set(-0.24, 0.88, 0.05);
      body.castShadow = true;
      body.userData.pickable = true;
      group.add(body);

      const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 24, 16), materials.head);
      head.position.set(-0.24, 1.32, 0.05);
      head.castShadow = true;
      head.userData.pickable = true;
      group.add(head);

      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.52, 12), materials.head);
      arm.position.set(0.02, 0.93, -0.12);
      arm.rotation.z = -1.05;
      arm.rotation.x = 0.6;
      arm.castShadow = true;
      group.add(arm);

      const labelMaterial = new THREE.SpriteMaterial({ map: makeLabelTexture('待命', 'idle'), transparent: true });
      const label = new THREE.Sprite(labelMaterial);
      label.position.set(-0.24, 1.88, 0.05);
      label.scale.set(1.35, 0.45, 1);
      group.add(label);

      const reactionMaterial = new THREE.SpriteMaterial({ map: makeLabelTexture('马上！', 'slow'), transparent: true, opacity: 0 });
      const reaction = new THREE.Sprite(reactionMaterial);
      reaction.position.set(0.32, 2.25, 0.12);
      reaction.scale.set(1.05, 0.36, 1);
      group.add(reaction);

      const pop = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 16, 10),
        new THREE.MeshStandardMaterial({ color: 0xf472b6, emissive: 0xbe185d, emissiveIntensity: 0.15, roughness: 0.35 })
      );
      pop.position.set(0.34, 1.52, 0.08);
      pop.visible = false;
      group.add(pop);
      group.userData.body = body;
      group.userData.arm = arm;
      group.userData.label = label;
      group.userData.labelMaterial = labelMaterial;
      group.userData.reaction = reaction;
      group.userData.reactionMaterial = reactionMaterial;
      group.userData.pop = pop;
      group.traverse((object) => {
        if (object.isMesh && object.userData.pickable) clickable.push(object);
      });
      scene.add(group);
      return group;
    }

    function updateLabel(group, text, tone) {
      if (group.userData.labelText === text && group.userData.labelTone === tone) return;
      group.userData.labelText = text;
      group.userData.labelTone = tone;
      const oldMap = group.userData.labelMaterial.map;
      group.userData.labelMaterial.map = makeLabelTexture(text, tone);
      group.userData.labelMaterial.needsUpdate = true;
      oldMap?.dispose();
    }

    function layoutPosition(index, total) {
      const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(total))));
      const rows = Math.ceil(total / cols);
      const col = index % cols;
      const row = Math.floor(index / cols);
      return {
        x: (col - (cols - 1) / 2) * 2.6,
        z: (row - (rows - 1) / 2) * 2.15,
      };
    }

    function renderWorkers() {
      const active = latestSessions.filter((session) => session.status === 'active');
      const activeIds = new Set(active.map((session) => session.sessionId));
      for (const [id, group] of workers) {
        if (!activeIds.has(id)) {
          scene.remove(group);
          group.traverse((object) => {
            if (object.geometry) object.geometry.dispose();
          });
          workers.delete(id);
        }
      }
      clickable.length = 0;
      const now = Date.now();
      let busyCount = 0;
      let slowCount = 0;
      active.slice(0, 16).forEach((session, index) => {
        let group = workers.get(session.sessionId);
        if (!group) {
          group = createWorker(session);
          workers.set(session.sessionId, group);
        } else {
          group.traverse((object) => {
            if (object.isMesh && object.userData.pickable) clickable.push(object);
          });
        }
        const pos = layoutPosition(index, Math.min(active.length, 16));
        group.position.x += (pos.x - group.position.x) * 0.25;
        group.position.z += (pos.z - group.position.z) * 0.25;
        const workingSince = Date.parse(session.turnStartedAt || '');
        const working = Number.isFinite(workingSince) ? now - workingSince : 0;
        const busy = session.runtimeStatus === 'busy';
        const slow = busy && working >= slowMs;
        if (busy) busyCount += 1;
        if (slow) slowCount += 1;
        group.userData.slow = slow;
        group.userData.title = session.title || session.sessionId;
        group.userData.body.material = slow ? materials.slowBody : busy ? materials.busyBody : materials.idleBody;
        updateLabel(group, busy ? '等 ' + formatDuration(working) : '待命', slow ? 'slow' : busy ? 'busy' : 'idle');
      });
      statEmployees.textContent = active.length + ' 员工';
      statWorking.textContent = busyCount + ' 干活';
      statSlow.textContent = slowCount + ' 可敲打';
      emptyEl.classList.toggle('visible', active.length === 0);
      statusEl.textContent = active.length
        ? active.length + ' 个员工在办公室，' + busyCount + ' 个正在干活' + (slowCount ? '，' + slowCount + ' 个超过 3 分钟可敲打' : '')
        : '办公室暂时空着。';
    }

    async function loadOffice() {
      const res = await fetch('/api/sessions');
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      latestSessions = Array.isArray(payload.sessions) ? payload.sessions : [];
      renderWorkers();
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(320, rect.width);
      const height = Math.max(360, rect.height);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.position.set(0, width < 720 ? 8.2 : 7.2, width < 720 ? 10.5 : 8.8);
      camera.updateProjectionMatrix();
    }

    function animate() {
      requestAnimationFrame(animate);
      const now = performance.now();
      for (const group of workers.values()) {
        const busy = group.userData.labelTone === 'busy' || group.userData.labelTone === 'slow';
        const nudge = now < group.userData.nudgeUntil;
        const pop = group.userData.pop;
        const reaction = group.userData.reaction;
        group.rotation.y = nudge ? Math.sin(now / 30) * 0.28 : 0;
        group.userData.arm.rotation.z = nudge
          ? -1.05 + Math.sin(now / 42) * 0.42
          : busy && !prefersReducedMotion ? -1.05 + Math.sin(now / 190) * 0.16 : -1.05;
        group.position.y = nudge ? Math.abs(Math.sin(now / 52)) * 0.18 : 0;
        if (reaction) {
          reaction.material.opacity = nudge ? 1 : 0;
          reaction.position.y = nudge ? 2.25 + Math.sin(now / 80) * 0.06 : 2.25;
        }
        if (pop) {
          pop.visible = nudge;
          const pulse = nudge ? 1 + Math.abs(Math.sin(now / 65)) * 1.4 : 1;
          pop.scale.setScalar(pulse);
        }
      }
      renderer.render(scene, camera);
    }

    canvas.addEventListener('click', (event) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(clickable, false)[0];
      if (!hit) return;
      const group = hit.object.parent;
      if (!group?.userData?.sessionId) return;
      selectedId = group.userData.sessionId;
      if (group.userData.slow) {
        group.userData.nudgeUntil = performance.now() + 1300;
        statusEl.textContent = '叩叩！' + compact(group.userData.title, 24) + ' 抬头看了一眼，手速 +1。';
      } else {
        statusEl.textContent = compact(group.userData.title, 24) + ' 正在稳稳推进，先别催他。';
      }
    });

    canvas.addEventListener('pointermove', (event) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(clickable, false).find((item) => item.object.parent?.userData?.slow);
      canvas.style.cursor = hit ? 'pointer' : 'default';
    });

    refreshOffice.addEventListener('click', () => {
      loadOffice().catch((error) => {
        statusEl.textContent = '刷新失败：' + error.message;
      });
    });
    window.addEventListener('resize', resize);
    resize();
    animate();
    loadOffice().catch((error) => {
      statusEl.textContent = '加载失败：' + error.message;
    });
    window.setInterval(() => {
      loadOffice().catch((error) => {
        statusEl.textContent = '刷新失败：' + error.message;
      });
    }, 15000);
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
