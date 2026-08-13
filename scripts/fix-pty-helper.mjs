/**
 * 修复 node-pty 在 macOS 上的 spawn-helper 执行权限。
 *
 * 背景：node-pty 用 prebuild 分发（prebuilds/<platform-arch>/），fork 子进程时
 * 必须 exec 其中的 spawn-helper。正常由 node-pty 的 postinstall 脚本 chmod +x，
 * 但在开启 npm `allow-scripts` 安全策略的环境里 postinstall 会被拦，导致 helper
 * 缺少执行位 → 运行期报 `posix_spawnp failed`。此脚本幂等补上执行权限。
 */
import { chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bases = ['darwin-arm64', 'darwin-x64'];

for (const base of bases) {
  const helper = join(root, 'node_modules', 'node-pty', 'prebuilds', base, 'spawn-helper');
  if (existsSync(helper)) {
    try {
      chmodSync(helper, 0o755);
      console.log(`[fix-pty-helper] chmod +x ${base}/spawn-helper`);
    } catch (err) {
      console.warn(`[fix-pty-helper] 跳过 ${base}: ${err.message}`);
    }
  }
}
