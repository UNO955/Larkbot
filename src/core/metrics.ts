import { appendFile, mkdir, readFile, readdir, rm, statfs } from 'node:fs/promises';
import { homedir, loadavg, cpus, freemem, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExpiredSession, Session, SessionWorkLog } from './types.js';
import type { SessionStore } from './store.js';

export const METRIC_SAMPLE_INTERVAL_MS = 60_000;
export const METRIC_RETENTION_MS = 15 * 24 * 60 * 60 * 1000;

export interface MetricSnapshot {
  timestamp: string;
  process: {
    pid: number;
    uptimeMs: number;
  };
  system: {
    cpuCount: number;
    load1: number;
    load5: number;
    load15: number;
    loadPercent: number;
    memoryTotalBytes: number;
    memoryFreeBytes: number;
    memoryUsedBytes: number;
    memoryUsedPercent: number;
  };
  disk: {
    path: string;
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
  };
  larkbot: {
    activeSessions: number;
    runningTurns: number;
    recentWindowMs: number;
    completedTurns: number;
    failedTurns: number;
    stoppedTurns: number;
    noReplyTurns: number;
    avgDurationMs: number;
    p95DurationMs: number;
  };
}

export interface CollectMetricsOptions {
  sessions: Session[];
  expiredSessions?: ExpiredSession[];
  projectDir: string;
  now?: Date;
  recentWindowMs?: number;
}

export interface SampleMetricsOptions {
  store: SessionStore;
  projectDir: string;
  metricsDir?: string;
  now?: Date;
  recentWindowMs?: number;
}

export interface ReadMetricSnapshotsOptions {
  metricsDir?: string;
  sinceMs: number;
  untilMs?: number;
  limit?: number;
}

export async function collectStoreMetrics(opts: SampleMetricsOptions): Promise<MetricSnapshot> {
  const [sessions, expiredSessions] = await Promise.all([
    opts.store.loadSessions(),
    opts.store.loadExpiredSessions?.() ?? Promise.resolve([]),
  ]);
  return collectMetrics({
    sessions,
    expiredSessions,
    projectDir: opts.projectDir,
    now: opts.now,
    recentWindowMs: opts.recentWindowMs,
  });
}

export function defaultMetricsDir(): string {
  const stateDir = process.env.LARKBOT_STATE_DIR?.trim() || join(homedir(), '.larkbot');
  return join(stateDir, 'metrics');
}

export async function sampleAndStoreMetrics(opts: SampleMetricsOptions): Promise<MetricSnapshot> {
  const snapshot = await collectStoreMetrics(opts);
  await appendMetricSnapshot(opts.metricsDir ?? defaultMetricsDir(), snapshot);
  return snapshot;
}

export async function collectMetrics(opts: CollectMetricsOptions): Promise<MetricSnapshot> {
  const now = opts.now ?? new Date();
  const recentWindowMs = opts.recentWindowMs ?? METRIC_SAMPLE_INTERVAL_MS;
  const [load1, load5, load15] = loadavg();
  const cpuCount = Math.max(1, cpus().length);
  const memoryTotalBytes = totalmem();
  const memoryFreeBytes = freemem();
  const memoryUsedBytes = Math.max(0, memoryTotalBytes - memoryFreeBytes);
  const disk = await collectDiskMetrics(opts.projectDir);
  const sessions = opts.sessions ?? [];
  const expiredSessions = opts.expiredSessions ?? [];
  const recentTurns = recentFinishedTurns([...sessions, ...expiredSessions], now.getTime(), recentWindowMs);
  const durations = recentTurns
    .map((turn) => durationMs(turn.log))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);

  return {
    timestamp: now.toISOString(),
    process: {
      pid: process.pid,
      uptimeMs: Math.max(0, Math.round(process.uptime() * 1000)),
    },
    system: {
      cpuCount,
      load1,
      load5,
      load15,
      loadPercent: clampPercent((load1 / cpuCount) * 100),
      memoryTotalBytes,
      memoryFreeBytes,
      memoryUsedBytes,
      memoryUsedPercent: percent(memoryUsedBytes, memoryTotalBytes),
    },
    disk,
    larkbot: {
      activeSessions: sessions.filter((session) => session.status === 'active').length,
      runningTurns: countRunningTurns(sessions),
      recentWindowMs,
      completedTurns: recentTurns.filter((turn) => turn.log.status === 'completed').length,
      failedTurns: recentTurns.filter((turn) => turn.log.status === 'failed').length,
      stoppedTurns: recentTurns.filter((turn) => turn.log.status === 'stopped').length,
      noReplyTurns: recentTurns.filter((turn) => turn.log.status === 'completed' && !sessionAnswer(turn.session).trim()).length,
      avgDurationMs: average(durations),
      p95DurationMs: percentile(durations, 0.95),
    },
  };
}

export async function appendMetricSnapshot(metricsDir: string, snapshot: MetricSnapshot): Promise<void> {
  const path = metricFilePath(metricsDir, new Date(snapshot.timestamp));
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(snapshot)}\n`, 'utf8');
}

export async function readMetricSnapshots(opts: ReadMetricSnapshotsOptions): Promise<MetricSnapshot[]> {
  const metricsDir = opts.metricsDir ?? defaultMetricsDir();
  const untilMs = opts.untilMs ?? Date.now();
  const limit = Math.max(1, Math.min(5000, opts.limit ?? 1440));
  let entries: string[];
  try {
    entries = await readdir(metricsDir);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = entries
    .filter((entry) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry))
    .sort()
    .reverse();
  const snapshots: MetricSnapshot[] = [];
  for (const file of files) {
    const content = await readFile(join(metricsDir, file), 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean).reverse();
    for (const line of lines) {
      const snapshot = parseMetricSnapshot(line);
      if (!snapshot) continue;
      const time = Date.parse(snapshot.timestamp);
      if (!Number.isFinite(time) || time > untilMs) continue;
      if (time < opts.sinceMs) {
        if (snapshots.length) return snapshots.sort(compareSnapshotTime);
        continue;
      }
      snapshots.push(snapshot);
      if (snapshots.length >= limit) return snapshots.sort(compareSnapshotTime);
    }
  }
  return snapshots.sort(compareSnapshotTime);
}

export async function cleanupMetricFiles(metricsDir = defaultMetricsDir(), olderThanMs = METRIC_RETENTION_MS, now = new Date()): Promise<{ deleted: number }> {
  let entries: string[];
  try {
    entries = await readdir(metricsDir);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { deleted: 0 };
    throw error;
  }
  const cutoff = startOfLocalDay(new Date(now.getTime() - olderThanMs)).getTime();
  let deleted = 0;
  for (const entry of entries) {
    const match = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(entry);
    if (!match) continue;
    const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
    if (!Number.isFinite(day) || day >= cutoff) continue;
    await rm(join(metricsDir, entry), { force: true });
    deleted++;
  }
  return { deleted };
}

export function renderPrometheusMetrics(snapshot: MetricSnapshot): string {
  const lines: string[] = [
    '# HELP larkbot_process_uptime_seconds Larkbot daemon process uptime in seconds.',
    '# TYPE larkbot_process_uptime_seconds gauge',
    metricLine('larkbot_process_uptime_seconds', snapshot.process.uptimeMs / 1000),
    '# HELP larkbot_system_cpu_load_percent System 1-minute load divided by CPU count.',
    '# TYPE larkbot_system_cpu_load_percent gauge',
    metricLine('larkbot_system_cpu_load_percent', snapshot.system.loadPercent),
    '# HELP larkbot_system_load_average System load average.',
    '# TYPE larkbot_system_load_average gauge',
    metricLine('larkbot_system_load_average', snapshot.system.load1, { window: '1m' }),
    metricLine('larkbot_system_load_average', snapshot.system.load5, { window: '5m' }),
    metricLine('larkbot_system_load_average', snapshot.system.load15, { window: '15m' }),
    '# HELP larkbot_system_memory_bytes System memory by state.',
    '# TYPE larkbot_system_memory_bytes gauge',
    metricLine('larkbot_system_memory_bytes', snapshot.system.memoryTotalBytes, { state: 'total' }),
    metricLine('larkbot_system_memory_bytes', snapshot.system.memoryUsedBytes, { state: 'used' }),
    metricLine('larkbot_system_memory_bytes', snapshot.system.memoryFreeBytes, { state: 'free' }),
    '# HELP larkbot_system_memory_used_percent System memory used percent.',
    '# TYPE larkbot_system_memory_used_percent gauge',
    metricLine('larkbot_system_memory_used_percent', snapshot.system.memoryUsedPercent),
    '# HELP larkbot_disk_bytes Project filesystem disk bytes by state.',
    '# TYPE larkbot_disk_bytes gauge',
    metricLine('larkbot_disk_bytes', snapshot.disk.totalBytes, { state: 'total', path: snapshot.disk.path }),
    metricLine('larkbot_disk_bytes', snapshot.disk.usedBytes, { state: 'used', path: snapshot.disk.path }),
    metricLine('larkbot_disk_bytes', snapshot.disk.freeBytes, { state: 'free', path: snapshot.disk.path }),
    '# HELP larkbot_disk_used_percent Project filesystem disk used percent.',
    '# TYPE larkbot_disk_used_percent gauge',
    metricLine('larkbot_disk_used_percent', snapshot.disk.usedPercent, { path: snapshot.disk.path }),
    '# HELP larkbot_sessions_active Active Larkbot sessions.',
    '# TYPE larkbot_sessions_active gauge',
    metricLine('larkbot_sessions_active', snapshot.larkbot.activeSessions),
    '# HELP larkbot_turns_running Running analysis turns.',
    '# TYPE larkbot_turns_running gauge',
    metricLine('larkbot_turns_running', snapshot.larkbot.runningTurns),
    '# HELP larkbot_turns_recent Recent analysis turns by status in the scrape window.',
    '# TYPE larkbot_turns_recent gauge',
    metricLine('larkbot_turns_recent', snapshot.larkbot.completedTurns, { status: 'completed', window: `${snapshot.larkbot.recentWindowMs}ms` }),
    metricLine('larkbot_turns_recent', snapshot.larkbot.failedTurns, { status: 'failed', window: `${snapshot.larkbot.recentWindowMs}ms` }),
    metricLine('larkbot_turns_recent', snapshot.larkbot.stoppedTurns, { status: 'stopped', window: `${snapshot.larkbot.recentWindowMs}ms` }),
    metricLine('larkbot_turns_recent', snapshot.larkbot.noReplyTurns, { status: 'no_reply', window: `${snapshot.larkbot.recentWindowMs}ms` }),
    '# HELP larkbot_turn_duration_seconds Recent analysis turn duration in seconds.',
    '# TYPE larkbot_turn_duration_seconds gauge',
    metricLine('larkbot_turn_duration_seconds', snapshot.larkbot.avgDurationMs / 1000, { quantile: 'avg' }),
    metricLine('larkbot_turn_duration_seconds', snapshot.larkbot.p95DurationMs / 1000, { quantile: 'p95' }),
    '# HELP larkbot_metrics_sample_timestamp_seconds Last generated larkbot metrics sample timestamp.',
    '# TYPE larkbot_metrics_sample_timestamp_seconds gauge',
    metricLine('larkbot_metrics_sample_timestamp_seconds', Date.parse(snapshot.timestamp) / 1000),
  ];
  return `${lines.join('\n')}\n`;
}

function metricFilePath(metricsDir: string, date: Date): string {
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  return join(metricsDir, `${yyyy}-${mm}-${dd}.jsonl`);
}

async function collectDiskMetrics(projectDir: string): Promise<MetricSnapshot['disk']> {
  const stats = await statfs(projectDir);
  const blockSize = Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * blockSize;
  const freeBytes = Number(stats.bavail) * blockSize;
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    path: projectDir,
    totalBytes,
    freeBytes,
    usedBytes,
    usedPercent: percent(usedBytes, totalBytes),
  };
}

function recentFinishedTurns(sessions: Array<Session | ExpiredSession>, nowMs: number, windowMs: number): Array<{ session: Session | ExpiredSession; log: SessionWorkLog }> {
  const startMs = nowMs - windowMs;
  const turns: Array<{ session: Session | ExpiredSession; log: SessionWorkLog }> = [];
  for (const session of sessions) {
    for (const log of session.workLogs ?? []) {
      if (!log.status || !log.endedAt) continue;
      const endedAtMs = Date.parse(log.endedAt);
      if (!Number.isFinite(endedAtMs) || endedAtMs < startMs || endedAtMs > nowMs) continue;
      turns.push({ session, log });
    }
  }
  return turns;
}

function countRunningTurns(sessions: Session[]): number {
  let count = 0;
  for (const session of sessions) {
    for (const log of session.workLogs ?? []) {
      if (!log.endedAt) count++;
    }
  }
  return count;
}

function parseMetricSnapshot(line: string): MetricSnapshot | undefined {
  try {
    const value = JSON.parse(line) as Partial<MetricSnapshot>;
    if (!value || typeof value !== 'object' || typeof value.timestamp !== 'string') return undefined;
    if (!value.process || !value.system || !value.disk || !value.larkbot) return undefined;
    return value as MetricSnapshot;
  } catch {
    return undefined;
  }
}

function compareSnapshotTime(a: MetricSnapshot, b: MetricSnapshot): number {
  return Date.parse(a.timestamp) - Date.parse(b.timestamp);
}

function metricLine(name: string, value: number, labels?: Record<string, string>): string {
  const normalized = Number.isFinite(value) ? value : 0;
  const labelText = labels && Object.keys(labels).length
    ? `{${Object.entries(labels).map(([key, labelValue]) => `${key}="${escapeMetricLabel(labelValue)}"`).join(',')}}`
    : '';
  return `${name}${labelText} ${normalized}`;
}

function escapeMetricLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function sessionAnswer(session: Session | ExpiredSession): string {
  return 'latestAnswer' in session && typeof session.latestAnswer === 'string' ? session.latestAnswer : '';
}

function durationMs(log: SessionWorkLog): number {
  if (typeof log.durationMs === 'number' && Number.isFinite(log.durationMs)) return Math.max(0, log.durationMs);
  if (!log.endedAt) return 0;
  const startedAtMs = Date.parse(log.startedAt);
  const endedAtMs = Date.parse(log.endedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) return 0;
  return Math.max(0, endedAtMs - startedAtMs);
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], rank: number): number {
  if (!values.length) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * rank) - 1));
  return values[index];
}

function percent(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return clampPercent((used / total) * 100);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
