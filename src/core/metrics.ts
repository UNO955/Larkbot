import { appendFile, mkdir, readdir, rm, statfs } from 'node:fs/promises';
import { homedir, loadavg, cpus, freemem, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExpiredSession, Session, SessionWorkLog } from './types.js';
import type { SessionStore } from './store.js';

export const METRIC_SAMPLE_INTERVAL_MS = 60_000;
export const METRIC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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

export function defaultMetricsDir(): string {
  const stateDir = process.env.LARKBOT_STATE_DIR?.trim() || join(homedir(), '.larkbot');
  return join(stateDir, 'metrics');
}

export async function sampleAndStoreMetrics(opts: SampleMetricsOptions): Promise<MetricSnapshot> {
  const [sessions, expiredSessions] = await Promise.all([
    opts.store.loadSessions(),
    opts.store.loadExpiredSessions?.() ?? Promise.resolve([]),
  ]);
  const snapshot = await collectMetrics({
    sessions,
    expiredSessions,
    projectDir: opts.projectDir,
    now: opts.now,
    recentWindowMs: opts.recentWindowMs,
  });
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
