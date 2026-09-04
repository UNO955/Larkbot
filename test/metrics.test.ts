import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupMetricFiles, collectMetrics, readMetricSnapshots, renderPrometheusMetrics, sampleAndStoreMetrics } from '../src/core/metrics.js';
import type { Session } from '../src/core/types.js';
import type { SessionStore } from '../src/core/store.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('metrics', () => {
  it('采集 larkbot 会话运行指标', async () => {
    const now = new Date('2026-09-04T10:00:00.000Z');
    const snapshot = await collectMetrics({
      sessions: [
        session({
          status: 'active',
          latestAnswer: '',
          workLogs: [
            { id: 'w1', startedAt: '2026-09-04T09:59:40.000Z' },
            { id: 'w2', startedAt: '2026-09-04T09:58:00.000Z', endedAt: '2026-09-04T09:59:30.000Z', durationMs: 90_000, status: 'completed' },
            { id: 'w3', startedAt: '2026-09-04T09:59:20.000Z', endedAt: '2026-09-04T09:59:50.000Z', durationMs: 30_000, status: 'failed' },
          ],
        }),
        session({
          sessionId: 'lm-2',
          status: 'closed',
          latestAnswer: 'ok',
          workLogs: [
            { id: 'w4', startedAt: '2026-09-04T09:59:10.000Z', endedAt: '2026-09-04T09:59:55.000Z', durationMs: 45_000, status: 'completed' },
            { id: 'old', startedAt: '2026-09-04T09:50:00.000Z', endedAt: '2026-09-04T09:51:00.000Z', durationMs: 60_000, status: 'stopped' },
          ],
        }),
      ],
      projectDir: process.cwd(),
      now,
      recentWindowMs: 60_000,
    });

    expect(snapshot.timestamp).toBe('2026-09-04T10:00:00.000Z');
    expect(snapshot.larkbot.activeSessions).toBe(1);
    expect(snapshot.larkbot.runningTurns).toBe(1);
    expect(snapshot.larkbot.completedTurns).toBe(2);
    expect(snapshot.larkbot.failedTurns).toBe(1);
    expect(snapshot.larkbot.stoppedTurns).toBe(0);
    expect(snapshot.larkbot.noReplyTurns).toBe(1);
    expect(snapshot.larkbot.avgDurationMs).toBe(55_000);
    expect(snapshot.larkbot.p95DurationMs).toBe(90_000);
    expect(snapshot.system.cpuCount).toBeGreaterThan(0);
    expect(snapshot.disk.totalBytes).toBeGreaterThan(0);
  });

  it('按日期追加写入 metrics JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'larkbot-metrics-'));
    dirs.push(dir);
    const store: SessionStore = {
      loadBots: async () => [],
      saveBots: async () => undefined,
      loadSessions: async () => [session()],
      saveSessions: async () => undefined,
      loadExpiredSessions: async () => [],
    };

    await sampleAndStoreMetrics({
      store,
      projectDir: process.cwd(),
      metricsDir: dir,
      now: new Date('2026-09-04T10:00:00.000Z'),
    });

    const raw = await readFile(join(dir, '2026-09-04.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).timestamp).toBe('2026-09-04T10:00:00.000Z');
  });

  it('清理超过保留期的 metrics 文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'larkbot-metrics-clean-'));
    dirs.push(dir);
    await writeFile(join(dir, '2026-08-01.jsonl'), '{}\n', 'utf8');
    await writeFile(join(dir, '2026-09-03.jsonl'), '{}\n', 'utf8');
    await writeFile(join(dir, 'note.txt'), 'keep\n', 'utf8');

    const result = await cleanupMetricFiles(dir, 30 * 24 * 60 * 60 * 1000, new Date('2026-09-04T10:00:00.000Z'));

    expect(result.deleted).toBe(1);
    await expect(readFile(join(dir, '2026-08-01.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(dir, '2026-09-03.jsonl'), 'utf8')).toBe('{}\n');
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('keep\n');
  });

  it('按时间范围读取 metrics JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'larkbot-metrics-read-'));
    dirs.push(dir);
    await writeFile(join(dir, '2026-09-03.jsonl'), [
      JSON.stringify(minimalSnapshot('2026-09-03T23:59:00.000Z', 1)),
      JSON.stringify(minimalSnapshot('2026-09-04T00:00:00.000Z', 2)),
    ].join('\n') + '\n', 'utf8');
    await writeFile(join(dir, '2026-09-04.jsonl'), [
      JSON.stringify(minimalSnapshot('2026-09-04T10:00:00.000Z', 3)),
      'not-json',
      JSON.stringify(minimalSnapshot('2026-09-04T10:01:00.000Z', 4)),
    ].join('\n') + '\n', 'utf8');

    const samples = await readMetricSnapshots({
      metricsDir: dir,
      sinceMs: Date.parse('2026-09-04T00:00:00.000Z'),
      untilMs: Date.parse('2026-09-04T10:00:30.000Z'),
    });

    expect(samples.map((sample) => sample.larkbot.activeSessions)).toEqual([2, 3]);
  });

  it('渲染 Prometheus text exposition', async () => {
    const snapshot = minimalSnapshot('2026-09-04T10:00:00.000Z', 2);
    snapshot.disk.path = '/tmp/larkbot"repo';
    snapshot.system.loadPercent = 12.5;
    snapshot.larkbot.runningTurns = 1;
    const text = renderPrometheusMetrics(snapshot);

    expect(text).toContain('# HELP larkbot_sessions_active Active Larkbot sessions.');
    expect(text).toContain('larkbot_sessions_active 2');
    expect(text).toContain('larkbot_turns_running 1');
    expect(text).toContain('larkbot_system_cpu_load_percent 12.5');
    expect(text).toContain('path="/tmp/larkbot\\"repo"');
  });
});

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'lm-1',
    chatId: 'oc-1',
    rootMessageId: 'om-1',
    threadId: 'thread-1',
    scope: 'thread',
    title: 'test',
    status: 'active',
    workingDir: '/repo',
    cliId: 'traex',
    hasHistory: true,
    lastMessageAt: '2026-09-04T10:00:00.000Z',
    createdAt: '2026-09-04T09:00:00.000Z',
    ...overrides,
  };
}

function minimalSnapshot(timestamp: string, activeSessions: number) {
  return {
    timestamp,
    process: { pid: 1, uptimeMs: 1000 },
    system: {
      cpuCount: 1,
      load1: 0,
      load5: 0,
      load15: 0,
      loadPercent: 0,
      memoryTotalBytes: 1,
      memoryFreeBytes: 1,
      memoryUsedBytes: 0,
      memoryUsedPercent: 0,
    },
    disk: {
      path: '/repo',
      totalBytes: 1,
      freeBytes: 1,
      usedBytes: 0,
      usedPercent: 0,
    },
    larkbot: {
      activeSessions,
      runningTurns: 0,
      recentWindowMs: 60_000,
      completedTurns: 0,
      failedTurns: 0,
      stoppedTurns: 0,
      noReplyTurns: 0,
      avgDurationMs: 0,
      p95DurationMs: 0,
    },
  };
}
