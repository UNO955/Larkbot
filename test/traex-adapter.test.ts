import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
  });

  it('默认注入 realpath 归一化的 trust_level 并跳过 trust', () => {
    const spec = createTraexAdapter().spawnSpec(dir);
    const real = realpathSync(dir); // macOS tmpdir 也是软链，验证归一化
    const i = spec.args.indexOf('-c');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(spec.args[i + 1]).toBe(`projects.${JSON.stringify(real)}.trust_level="trusted"`);
    expect(spec.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(spec.args).toContain('--no-alt-screen');
  });

  it('TRAEX_SANDBOX=1 时不注入 trust/bypass，仅保留 --no-alt-screen', () => {
    process.env.TRAEX_SANDBOX = '1';
    const spec = createTraexAdapter().spawnSpec(dir);
    expect(spec.args).not.toContain('-c');
    expect(spec.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
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
});
