import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { SessionStore } from '../core/store.js';
import type { Bot, Session, SystemPromptProfile } from '../core/types.js';
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

const HIDDEN_PROMPT_BLOCK_START_RE = /<\/?(?:larkbot_routing|larkbot_reminder|system_prompt_profile|user_message|quoted_message|attachments)\b/i;
const HIDDEN_PROMPT_BLOCK_END_RE = /<\/(?:larkbot_routing|larkbot_reminder|system_prompt_profile|user_message|quoted_message|attachments)>/i;
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

async function listSessions(opts: ConsoleServerOpts): Promise<Session[]> {
  if (opts.sessionManager) return opts.sessionManager.listSessions();
  return (await opts.store.loadSessions())
    .sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt));
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

function clean(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function sanitizeModel(value: string): string {
  const model = value.trim().slice(0, 80);
  return /^[A-Za-z0-9._:-]+$/.test(model) ? model : '';
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
    :root { color-scheme: light; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7fb; color: #1f2329; }
    main { max-width: 1100px; margin: 40px auto; padding: 0 20px; display: grid; gap: 20px; }
    .card { background: #fff; border: 1px solid #dee0e3; border-radius: 16px; box-shadow: 0 10px 30px rgba(31,35,41,.06); overflow: hidden; }
    header { padding: 24px 28px; border-bottom: 1px solid #eff0f1; }
    h1 { margin: 0; font-size: 24px; }
    .sub { margin-top: 8px; color: #646a73; font-size: 14px; }
    form { padding: 24px 28px 28px; display: grid; gap: 18px; }
    label { display: grid; gap: 8px; font-weight: 600; font-size: 14px; }
      input[type="text"], input[type="password"], select, textarea { border: 1px solid #bbbfc4; border-radius: 10px; padding: 0 12px; font: inherit; }
      input[type="text"], input[type="password"], select { height: 42px; }
      textarea { min-height: 160px; padding: 12px; resize: vertical; line-height: 1.5; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      input:focus, select:focus, textarea:focus { outline: 2px solid #3370ff33; border-color: #3370ff; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .check { display: flex; align-items: center; gap: 10px; font-weight: 500; color: #343840; }
    .hint { color: #8f959e; font-size: 12px; font-weight: 400; }
    footer { display: flex; align-items: center; gap: 12px; padding-top: 6px; }
    button { height: 40px; border: 0; border-radius: 10px; background: #3370ff; color: white; padding: 0 18px; font: inherit; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: .6; cursor: not-allowed; }
    #status { color: #646a73; font-size: 14px; }
    .warn { background: #fff7e6; color: #8f5a00; border: 1px solid #ffd591; border-radius: 10px; padding: 10px 12px; font-size: 13px; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 28px; border-bottom: 1px solid #eff0f1; }
    .toolbar h2 { margin: 0; font-size: 18px; }
    .ghost { background: #f2f3f5; color: #1f2329; }
    .danger { background: #f54a45; }
    .sessions { padding: 0 28px 24px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; border-bottom: 1px solid #eff0f1; padding: 12px 8px; vertical-align: top; }
    th { color: #646a73; font-weight: 700; }
    code { background: #f2f3f5; border-radius: 6px; padding: 2px 5px; }
    .muted { color: #8f959e; }
    .status { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 8px; font-weight: 700; font-size: 12px; }
    .status.active { background: #e8f7ee; color: #178b3a; }
    .status.closed { background: #eff0f1; color: #646a73; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .actions button { height: 32px; padding: 0 10px; font-size: 13px; }
      .prompt-box { border: 1px solid #eff0f1; border-radius: 14px; padding: 16px; display: grid; gap: 14px; background: #fbfcff; }
      .prompt-head { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: end; }
    @media (max-width: 720px) { .row { grid-template-columns: 1fr; } main { margin: 20px auto; } }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <header>
        <h1>larkbot 控制台</h1>
        <div class="sub">调整当前 bot 配置。App 凭证变更需要重启 daemon 后生效。</div>
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
              <strong>系统提示词</strong>
              <div class="hint">可保存多份提示词，选择后下一轮消息立即生效。</div>
            </div>
            <div class="prompt-head">
              <label>当前提示词
                <select id="prompt-select"></select>
              </label>
              <div class="actions">
                <button id="new-prompt" type="button" class="ghost">新建</button>
                <button id="delete-prompt" type="button" class="danger">删除</button>
            </div>
            </div>
            <label>提示词名称
              <input id="prompt-name" type="text" autocomplete="off" placeholder="例如：代码审查 / 简洁回答 / 产品顾问">
            </label>
            <label>提示词内容
              <textarea id="prompt-content" placeholder="这里写入会注入到 traex 每轮 prompt 的系统提示词。留空表示不使用。"></textarea>
            </label>
          </section>
        <div class="warn">当前版本先做配置读写。涉及飞书连接身份的字段保存后，需要重启 daemon 才会重新连接。</div>
        <footer>
          <button id="save" type="submit">保存设置</button>
          <span id="status"></span>
        </footer>
      </form>
    </section>
    <section class="card">
      <div class="toolbar">
        <div>
          <h2>会话管理</h2>
          <div class="sub">查看飞书话题到 traex 原生会话的路由。关闭会杀掉正在运行的 runtime，删除会移除路由记录。</div>
        </div>
        <button id="refresh-sessions" type="button" class="ghost">刷新</button>
      </div>
      <div class="sessions">
        <table>
          <thead>
            <tr>
              <th>会话</th>
              <th>状态</th>
              <th>CLI</th>
              <th>位置</th>
              <th>时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="sessions-body">
            <tr><td colspan="6" class="muted">加载中…</td></tr>
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
      const promptSelect = document.querySelector('#prompt-select');
      const promptName = document.querySelector('#prompt-name');
      const promptContent = document.querySelector('#prompt-content');
      const newPrompt = document.querySelector('#new-prompt');
      const deletePrompt = document.querySelector('#delete-prompt');
      let promptProfiles = [];
      let activePromptId = '';

    function setStatus(text, failed = false) {
      status.textContent = text;
      status.style.color = failed ? '#d93026' : '#646a73';
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
      form.name.value = bot.name || '';
      form.cwd.value = bot.cwd || '';
      form.appId.value = bot.appId || '';
      form.appSecret.value = '';
      form.ownerOpenId.value = bot.ownerOpenId || '';
      ensureModelOption(bot.model || '');
      form.model.value = bot.model || '';
      form.enabled.checked = !!bot.enabled;
      form.disableStreamingCard.checked = !!bot.disableStreamingCard;
        form.replySignature.value = bot.replySignature || '';
      form.appSecret.placeholder = bot.appSecretSet ? '已设置，留空表示不修改' : '尚未设置';
        promptProfiles = Array.isArray(bot.systemPromptProfiles) ? bot.systemPromptProfiles.map((p) => ({ ...p })) : [];
        activePromptId = bot.activeSystemPromptProfileId || '';
        renderPromptProfiles();
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

    async function loadSessions() {
      const res = await fetch('/api/sessions');
      if (!res.ok) throw new Error(await res.text());
      const { sessions } = await res.json();
      if (!sessions.length) {
        sessionsBody.innerHTML = '<tr><td colspan="6" class="muted">暂无会话</td></tr>';
        return;
      }
      sessionsBody.innerHTML = sessions.map((s) => {
        const closed = s.status === 'closed';
        return '<tr>' +
          '<td><strong>' + esc(compact(s.title || s.sessionId, 48)) + '</strong><br><span class="muted"><code>' + esc(compact(s.sessionId, 18)) + '</code></span></td>' +
          '<td><span class="status ' + esc(s.status) + '">' + esc(s.status) + '</span></td>' +
          '<td>' + esc(s.cliId || '-') + '<br><span class="muted">' + esc(compact(s.cliSessionId || 'no cli session', 22)) + '</span></td>' +
          '<td><span class="muted">' + esc(compact(s.workingDir || '-', 42)) + '</span><br><span class="muted">' + esc(compact(s.threadId || s.rootMessageId || '-', 24)) + '</span></td>' +
          '<td><span class="muted">创建 ' + esc(formatTime(s.createdAt)) + '</span><br><span class="muted">最后 ' + esc(formatTime(s.lastMessageAt)) + '</span></td>' +
          '<td><div class="actions">' +
            '<button type="button" class="ghost" data-action="close" data-session="' + esc(s.sessionId) + '"' + (closed ? ' disabled' : '') + '>关闭</button>' +
            '<button type="button" class="danger" data-action="delete" data-session="' + esc(s.sessionId) + '">删除</button>' +
          '</div></td>' +
        '</tr>';
      }).join('');
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
      sessionsBody.innerHTML = '<tr><td colspan="6" class="muted">加载失败：' + esc(error.message) + '</td></tr>';
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
  <title>${escapeHtml(trace.title)} · 思考过程</title>
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
        <h1>${escapeHtml(trace.title || '思考过程')}</h1>
        <div class="meta">
          <span>状态：${escapeHtml(trace.status)}</span>
          <span>创建：${escapeHtml(trace.createdAt)}</span>
          <span>更新：${escapeHtml(trace.updatedAt)}</span>
          <span>Turn：${escapeHtml(trace.id)}</span>
        </div>
      </header>
      <pre class="${trace.content.trim() ? '' : 'empty'}">${escapeHtml(trace.content.trim() || '暂无思考过程。')}</pre>
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
  <title>${escapeHtml(session.title || '思考过程')} · 只读终端</title>
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
    <div class="title">${escapeHtml(session.title || '思考过程')}</div>
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
        if (/<\\/(?:larkbot_routing|larkbot_reminder|system_prompt_profile|user_message|quoted_message|attachments)>/i.test(visible)) hiddenPromptBlock = false;
        return '';
      }
      if (/^\\s*▍/.test(visible)) return '';
      if (/<\\/?(?:session_id|sender|image|file)\\b/i.test(visible)) return '';
      if (/<\\/?(?:larkbot_routing|larkbot_reminder|system_prompt_profile|user_message|quoted_message|attachments)\\b/i.test(visible)) {
        hiddenPromptBlock = !/<\\/(?:larkbot_routing|larkbot_reminder|system_prompt_profile|user_message|quoted_message|attachments)>/i.test(visible);
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
  <title>思考已停止</title>
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
    <h1>思考已停止</h1>
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
