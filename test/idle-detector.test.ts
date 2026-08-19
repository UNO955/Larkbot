import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IdleDetector, type IdleEvidenceSource } from '../src/utils/idle-detector.js';
import type { CliAdapter } from '../src/adapters/cli/types.js';

/** 造一个测试用 CLI 适配器，可注入 readyPattern。 */
function mkCli(over: Partial<CliAdapter> = {}): CliAdapter {
  return {
    id: 'traex',
    spawnSpec: () => ({ command: 'traex', args: [], cwd: '/tmp' }),
    readyPattern: over.readyPattern,
    completionPattern: over.completionPattern,
  };
}

/** 收集 onIdle 触发。 */
function attach(d: IdleDetector) {
  const fires: IdleEvidenceSource[] = [];
  d.onIdle((src) => fires.push(src));
  return fires;
}

describe('IdleDetector', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('提示符出现后静默 2s 判 idle', () => {
    const d = new IdleDetector(mkCli({ readyPattern: /❯/ }));
    const fires = attach(d);
    d.feed('❯ ');                 // 提示符出现
    expect(fires).toHaveLength(0);
    vi.advanceTimersByTime(2000);
    expect(fires).toEqual(['screen']);
  });

  it('readyPattern gate：提示符未出现则永不判 idle', () => {
    const d = new IdleDetector(mkCli({ readyPattern: /❯/ }));
    const fires = attach(d);
    d.feed('正在分析...');        // 没有提示符
    vi.advanceTimersByTime(10_000);
    expect(fires).toHaveLength(0);
  });

  it('提示符出现后的状态栏 spinner 字符不计入抑制，仍能正常判 idle', () => {
    const d = new IdleDetector(mkCli({ readyPattern: /❯/ }));
    const fires = attach(d);
    d.feed('❯ ');                 // 先见提示符 → readySeen
    d.feed('⠋ working');          // readySeen 后 spinner 不更新 lastSpinnerAt
    vi.advanceTimersByTime(2000);
    expect(fires).toEqual(['screen']);
  });

  it('提示符之前出现的 spinner 触发 3s guard，抑制 idle', () => {
    const d = new IdleDetector(mkCli()); // 无 readyPattern，纯 quiescence
    const fires = attach(d);
    d.feed('⠙ 生成中');          // spinner，更新 lastSpinnerAt
    vi.advanceTimersByTime(2000); // 静默到点，但距 spinner 仅 2s < 3s guard
    expect(fires).toHaveLength(0);
    vi.advanceTimersByTime(1200); // 再过 1.2s，越过 3s guard + 余量
    expect(fires).toEqual(['screen']);
  });

  it('中途持续输出不会误判 idle（定时器每次重排）', () => {
    const d = new IdleDetector(mkCli({ readyPattern: /❯/ }));
    const fires = attach(d);
    d.feed('❯ ');
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1500); // 每 1.5s 来一段（< 2s）
      d.feed(`输出块 ${i}`);
    }
    expect(fires).toHaveLength(0); // 从未连续静默 2s
    vi.advanceTimersByTime(2000);
    expect(fires).toEqual(['screen']);
  });

  it('reset 后重新武装（下一轮需重新等待提示符）', () => {
    const d = new IdleDetector(mkCli({ readyPattern: /❯/ }));
    const fires = attach(d);
    d.feed('❯ ');
    vi.advanceTimersByTime(2000);
    expect(fires).toEqual(['screen']);

    d.reset();                    // 新一轮
    d.feed('处理中，无提示符');
    vi.advanceTimersByTime(5000);
    expect(fires).toHaveLength(1); // 未再触发（提示符没出现）
    d.feed('❯ ');
    vi.advanceTimersByTime(2000);
    expect(fires).toEqual(['screen', 'screen']);
  });

  it('fireIdle 权威信号立即判 idle，且一轮内幂等', () => {
    const d = new IdleDetector(mkCli({ readyPattern: /❯/ }));
    const fires = attach(d);
    d.fireIdle();
    expect(fires).toEqual(['external']);
    d.fireIdle();                 // 幂等
    expect(fires).toEqual(['external']);
  });

  it('已 idle 后再来数据视为新一轮', () => {
    const d = new IdleDetector(mkCli({ readyPattern: /❯/ }));
    const fires = attach(d);
    d.feed('❯ ');
    vi.advanceTimersByTime(2000);
    expect(fires).toEqual(['screen']);
    // 新数据 → 新一轮；再次见提示符 + 静默才再判
    d.feed('新任务输出');
    vi.advanceTimersByTime(5000);
    expect(fires).toHaveLength(1);
    d.feed('❯ ');
    vi.advanceTimersByTime(2000);
    expect(fires).toEqual(['screen', 'screen']);
  });
});
