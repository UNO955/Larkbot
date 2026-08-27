import { describe, expect, it } from 'vitest';
import { buildDailyReportSummary } from '../src/core/daily-report.js';
import type { ExpiredSession, Session } from '../src/core/types.js';

describe('buildDailyReportSummary', () => {
  it('统计当天轮次、最忙群聊、最长一轮和改动最多一轮', () => {
    const current: Session[] = [
      session('lm-1', '群 A', [
        {
          id: 'w1',
          startedAt: localIso(2026, 7, 27, 1, 0),
          endedAt: localIso(2026, 7, 27, 1, 10),
          durationMs: 10 * 60 * 1000,
          status: 'completed',
          changedFileCount: 2,
          changedFiles: ['src/a.ts', 'src/b.ts'],
        },
        {
          id: 'w2',
          startedAt: localIso(2026, 7, 27, 2, 0),
          endedAt: localIso(2026, 7, 27, 2, 30),
          durationMs: 30 * 60 * 1000,
          status: 'failed',
          changedFileCount: 0,
        },
      ]),
      session('lm-2', '群 B', [
        {
          id: 'w3',
          startedAt: localIso(2026, 7, 26, 23, 30),
          endedAt: localIso(2026, 7, 26, 23, 40),
          durationMs: 10 * 60 * 1000,
          status: 'completed',
          changedFileCount: 5,
        },
      ]),
    ];
    const expired: ExpiredSession[] = [
      {
        ...session('lm-3', '群 A', [
          {
            id: 'w4',
            startedAt: localIso(2026, 7, 27, 3, 0),
            endedAt: localIso(2026, 7, 27, 3, 5),
            durationMs: 5 * 60 * 1000,
            status: 'stopped',
            changedFileCount: 4,
            changedFiles: ['src/c.ts'],
          },
        ]),
        deletedAt: localIso(2026, 7, 27, 4, 0),
        reason: 'retention_expired',
      },
    ];

    const report = buildDailyReportSummary(current, expired, new Date(2026, 7, 27, 23, 55));

    expect(report.totalTurns).toBe(3);
    expect(report.completed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.stopped).toBe(1);
    expect(report.busiestChat).toEqual({ label: '群 A', count: 3 });
    expect(report.longestTurn?.sessionId).toBe('lm-1');
    expect(report.longestTurn?.durationMs).toBe(30 * 60 * 1000);
    expect(report.mostChangedTurn?.sessionId).toBe('lm-3');
    expect(report.mostChangedTurn?.changedFileCount).toBe(4);
    expect(report.remark).toContain('刹车');
  });
});

function session(sessionId: string, chatName: string, workLogs: Session['workLogs']): Session {
  return {
    sessionId,
    chatId: `chat-${chatName}`,
    rootMessageId: `msg-${sessionId}`,
    scope: 'thread',
    title: `任务 ${sessionId}`,
    status: 'closed',
    workingDir: '/repo',
    cliId: 'traex',
    hasHistory: true,
    chatName,
    workLogs,
    lastMessageAt: localIso(2026, 7, 27, 4, 0),
    createdAt: localIso(2026, 7, 27, 0, 0),
  };
}

function localIso(year: number, month: number, day: number, hour: number, minute: number): string {
  return new Date(year, month, day, hour, minute).toISOString();
}
