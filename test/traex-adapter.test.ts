import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';

describe('traex adapter spawnSpec', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lm-traex-')); });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TRAEX_SANDBOX;
    delete process.env.TRAEX_BIN;
    delete process.env.TRAE_HOME;
  });

  it('默认注入 realpath 归一化的 trust_level 并跳过 trust', () => {
    const spec = createTraexAdapter().spawnSpec(dir);
    const real = realpathSync(dir); // macOS tmpdir 也是软链，验证归一化
    const i = spec.args.indexOf('-c');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(spec.args[i + 1]).toBe(`projects.${JSON.stringify(real)}.trust_level="trusted"`);
    expect(spec.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(spec.args).toContain('--dangerously-bypass-hook-trust');
    expect(spec.args).toContain('--no-alt-screen');
  });

  it('TRAEX_SANDBOX=1 时不注入 trust/bypass，仅保留 --no-alt-screen', () => {
    process.env.TRAEX_SANDBOX = '1';
    const spec = createTraexAdapter().spawnSpec(dir);
    expect(spec.args).not.toContain('-c');
    expect(spec.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(spec.args).not.toContain('--dangerously-bypass-hook-trust');
    expect(spec.args).toContain('--no-alt-screen');
  });

  it('TRAEX_BIN 指定绝对路径作为 command', () => {
    process.env.TRAEX_BIN = '/opt/traex/bin/traex';
    expect(createTraexAdapter().spawnSpec(dir).command).toBe('/opt/traex/bin/traex');
  });

  it('resume 时把原生 session id 放在通用参数之后', () => {
    const spec = createTraexAdapter().spawnSpec(dir, { resumeSessionId: 'trae-session-1' });
    expect(spec.args[0]).toBe('resume');
    expect(spec.args.at(-1)).toBe('trae-session-1');
    expect(spec.args).toContain('--no-alt-screen');
  });

  it('指定模型时追加 --model 参数', () => {
    const spec = createTraexAdapter().spawnSpec(dir, { model: 'gpt-5.5' });
    expect(spec.args).toContain('--model');
    expect(spec.args[spec.args.indexOf('--model') + 1]).toBe('gpt-5.5');
    expect(spec.args.indexOf('--model')).toBeLessThan(spec.args.indexOf('--no-alt-screen') + 3);
  });

  it('从 traex rollout token_count 读取会话累计 token', () => {
    const home = mkdtempSync(join(tmpdir(), 'lm-trae-home-'));
    process.env.TRAE_HOME = home;
    const sessionDir = join(home, 'cli', 'sessions', '2026', '08', '13');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'rollout-2026-08-13T21-15-35-trae-1.jsonl'), [
      JSON.stringify({
        type: 'turn_context',
        payload: {
          model: 'gpt-5.5',
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 12345,
              output_tokens: 678,
              cached_input_tokens: 1000,
            },
          },
        },
      }),
    ].join('\n') + '\n');
    writeFileSync(join(sessionDir, 'rollout-2026-08-13T21-15-35-trae-2.jsonl'), [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 1,
              output_tokens: 2,
            },
          },
        },
      }),
    ].join('\n') + '\n');

    expect(createTraexAdapter().getSessionUsage?.('trae-1')).toEqual({
      inputTokens: 12345,
      outputTokens: 678,
      cacheReadTokens: 1000,
      cacheCreateTokens: 0,
      model: 'gpt-5.5',
    });
  });

  it('从 traex rollout task_complete 读取最终回复', () => {
    const home = mkdtempSync(join(tmpdir(), 'lm-trae-home-'));
    process.env.TRAE_HOME = home;
    const sessionDir = join(home, 'cli', 'sessions', '2026', '08', '13');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'rollout-2026-08-13T21-15-35-trae-1.jsonl'), [
      JSON.stringify({
        timestamp: '2026-08-13T13:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-old',
          last_agent_message: '旧回复',
        },
      }),
      JSON.stringify({
        timestamp: '2026-08-13T13:01:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-new',
          completed_at: '2026-08-13T13:01:01.000Z',
          last_agent_message: '你好，我在。',
        },
      }),
    ].join('\n') + '\n');

    expect(createTraexAdapter().getSessionFinal?.('trae-1')).toEqual({
      key: 'turn-new:2026-08-13T13:01:01.000Z',
      text: '你好，我在。',
    });
  });

  it('忽略 traex 空回复哨兵', () => {
    const home = mkdtempSync(join(tmpdir(), 'lm-trae-home-'));
    process.env.TRAE_HOME = home;
    const sessionDir = join(home, 'cli', 'sessions', '2026', '08', '13');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'rollout-2026-08-13T21-15-35-trae-1.jsonl'), [
      JSON.stringify({
        timestamp: '2026-08-13T13:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-empty',
          last_agent_message: 'LARKBOT_NOTHING_TO_SEND',
        },
      }),
      JSON.stringify({
        timestamp: '2026-08-13T13:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-empty-old',
          last_agent_message: 'BOTMUX_NOTHING_TO_SEND',
        },
      }),
    ].join('\n') + '\n');

    expect(createTraexAdapter().getSessionFinal?.('trae-1')).toBeUndefined();
  });

  it('忽略以 legacy botmux 空回复哨兵开头但混入启动文本的 final', () => {
    const home = mkdtempSync(join(tmpdir(), 'lm-trae-home-'));
    process.env.TRAE_HOME = home;
    const sessionDir = join(home, 'cli', 'sessions', '2026', '08', '13');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'rollout-2026-08-13T21-15-35-trae-1.jsonl'), [
      JSON.stringify({
        timestamp: '2026-08-13T13:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-empty',
          last_agent_message: 'BOTMUX_NOTHING_TO_SEND\n\nInitialize Larkbot environment',
        },
      }),
    ].join('\n') + '\n');

    expect(createTraexAdapter().getSessionFinal?.('trae-1')).toBeUndefined();
  });

  it('读取 traex rollout 原生日志供控制台诊断', () => {
    const home = mkdtempSync(join(tmpdir(), 'lm-trae-home-'));
    process.env.TRAE_HOME = home;
    const sessionDir = join(home, 'cli', 'sessions', '2026', '08', '13');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'rollout-2026-08-13T21-15-35-trae-1.jsonl'), [
      JSON.stringify({
        timestamp: '2026-08-13T13:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_reasoning_raw_content', text: 'raw reasoning' },
      }),
    ].join('\n') + '\n');

    const raw = createTraexAdapter().getSessionRawLog?.('trae-1');
    expect(raw?.path).toContain('rollout-2026-08-13T21-15-35-trae-1.jsonl');
    expect(raw?.content).toContain('agent_reasoning_raw_content');
    expect(raw?.content).toContain('raw reasoning');
    expect(raw?.updatedAt).toBeTruthy();
  });

  it('列出 traex rollout 原生日志索引', () => {
    const home = mkdtempSync(join(tmpdir(), 'lm-trae-home-'));
    process.env.TRAE_HOME = home;
    const sessionDir = join(home, 'cli', 'sessions', '2026', '08', '13');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'rollout-2026-08-13T21-15-35-trae-1.jsonl'), '{}\n');
    writeFileSync(join(sessionDir, 'rollout-2026-08-13T21-16-35-trae-2.jsonl'), '{}\n');
    writeFileSync(join(sessionDir, 'other.jsonl'), '{}\n');

    const logs = createTraexAdapter().listSessionRawLogs?.() || [];
    expect(logs.map((item) => item.cliSessionId).sort()).toEqual(['trae-1', 'trae-2']);
    expect(logs[0].path).toContain('.jsonl');
    expect(logs[0].sizeBytes).toBeGreaterThan(0);
    expect(logs[0].updatedAt).toBeTruthy();
  });

  it('清理超过保留期的 traex rollout 原生日志', () => {
    const home = mkdtempSync(join(tmpdir(), 'lm-trae-home-'));
    process.env.TRAE_HOME = home;
    const sessionDir = join(home, 'cli', 'sessions', '2026', '08', '13');
    mkdirSync(sessionDir, { recursive: true });
    const oldRollout = join(sessionDir, 'rollout-2026-08-13T21-15-35-trae-old.jsonl');
    const freshRollout = join(sessionDir, 'rollout-2026-08-13T21-16-35-trae-fresh.jsonl');
    const otherJsonl = join(sessionDir, 'other.jsonl');
    writeFileSync(oldRollout, 'old\n');
    writeFileSync(freshRollout, 'fresh\n');
    writeFileSync(otherJsonl, 'other\n');
    const now = Date.UTC(2026, 8, 1);
    const oldDate = new Date(now - 31 * 24 * 60 * 60 * 1000);
    const freshDate = new Date(now - 5 * 24 * 60 * 60 * 1000);
    utimesSync(oldRollout, oldDate, oldDate);
    utimesSync(freshRollout, freshDate, freshDate);
    utimesSync(otherJsonl, oldDate, oldDate);

    const result = createTraexAdapter().cleanupSessionRawLogs?.({
      olderThanMs: 30 * 24 * 60 * 60 * 1000,
      now,
    });

    expect(result).toEqual({ deleted: 1, bytes: 4 });
    expect(existsSync(oldRollout)).toBe(false);
    expect(existsSync(freshRollout)).toBe(true);
    expect(existsSync(otherJsonl)).toBe(true);
  });
});
