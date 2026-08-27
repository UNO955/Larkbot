import type { ExpiredSession, Session, SessionWorkLog, SessionWorkLogStatus } from './types.js';

export interface DailyReportTurn {
  sessionId: string;
  sessionTitle: string;
  chatId: string;
  chatName?: string;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  status: SessionWorkLogStatus | 'unknown';
  changedFileCount: number;
  changedFiles: string[];
}

export interface DailyReportSummary {
  dateLabel: string;
  totalTurns: number;
  completed: number;
  failed: number;
  stopped: number;
  totalDurationMs: number;
  busiestChat?: { label: string; count: number };
  longestTurn?: DailyReportTurn;
  mostChangedTurn?: DailyReportTurn;
  remark: string;
}

type ReportSession = Session | ExpiredSession;

export function buildDailyReportSummary(current: Session[], expired: ExpiredSession[], now = new Date()): DailyReportSummary {
  const start = startOfLocalDay(now).getTime();
  const end = now.getTime();
  const turns = [...current, ...expired].flatMap((session) => dailyTurns(session, start, end));
  const completed = turns.filter((turn) => turn.status === 'completed').length;
  const failed = turns.filter((turn) => turn.status === 'failed').length;
  const stopped = turns.filter((turn) => turn.status === 'stopped').length;
  const totalDurationMs = turns.reduce((sum, turn) => sum + turn.durationMs, 0);
  return {
    dateLabel: now.toLocaleDateString('zh-CN'),
    totalTurns: turns.length,
    completed,
    failed,
    stopped,
    totalDurationMs,
    busiestChat: busiestChat(turns),
    longestTurn: maxBy(turns, (turn) => turn.durationMs),
    mostChangedTurn: maxBy(turns.filter((turn) => turn.changedFileCount > 0), (turn) => turn.changedFileCount),
    remark: dailyRemark(turns.length, failed, stopped),
  };
}

function dailyTurns(session: ReportSession, start: number, end: number): DailyReportTurn[] {
  return (session.workLogs ?? []).flatMap((log) => {
    const startedAtMs = Date.parse(log.startedAt);
    if (!Number.isFinite(startedAtMs) || startedAtMs < start || startedAtMs > end) return [];
    return [toReportTurn(session, log, startedAtMs)];
  });
}

function toReportTurn(session: ReportSession, log: SessionWorkLog, startedAtMs: number): DailyReportTurn {
  const endedAtMs = log.endedAt ? Date.parse(log.endedAt) : Number.NaN;
  const durationMs = typeof log.durationMs === 'number' && Number.isFinite(log.durationMs)
    ? log.durationMs
    : Number.isFinite(endedAtMs)
    ? Math.max(0, endedAtMs - startedAtMs)
    : 0;
  return {
    sessionId: session.sessionId,
    sessionTitle: session.title || session.sessionId,
    chatId: session.chatId,
    chatName: session.chatName,
    startedAt: log.startedAt,
    endedAt: log.endedAt,
    durationMs,
    status: log.status || 'unknown',
    changedFileCount: typeof log.changedFileCount === 'number' && Number.isFinite(log.changedFileCount) ? log.changedFileCount : 0,
    changedFiles: Array.isArray(log.changedFiles) ? log.changedFiles : [],
  };
}

function busiestChat(turns: DailyReportTurn[]): { label: string; count: number } | undefined {
  const counts = new Map<string, { label: string; count: number }>();
  for (const turn of turns) {
    const key = turn.chatId || turn.chatName || 'unknown';
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
    } else {
      counts.set(key, { label: turn.chatName || turn.chatId || '未知群聊', count: 1 });
    }
  }
  return maxBy([...counts.values()], (item) => item.count);
}

function maxBy<T>(items: T[], score: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const item of items) {
    const value = score(item);
    if (value > bestScore) {
      best = item;
      bestScore = value;
    }
  }
  return best;
}

function dailyRemark(total: number, failed: number, stopped: number): string {
  if (total === 0) return '今天很安静，没有处理记录。';
  if (failed === 0 && stopped === 0) return '今天收工很顺，所有记录都落在完成态。';
  if (failed > 0 && stopped > 0) return '今天有刹车也有报错，值得明早扫一眼复盘。';
  if (failed > 0) return '今天有失败记录，建议挑最重的一轮先看。';
  return '今天有人及时踩了停止键，省下了一些无效等待。';
}

function startOfLocalDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}
