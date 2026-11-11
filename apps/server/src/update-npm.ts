import type { BuildInfo, UpdateCheck } from '@contracts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareReleaseTags } from './update.js';

export const NPM_UPGRADE_COMMAND = 'npm i -g riffet@latest';

/**
 * Whether this program was installed from the npm package: the published manifest next to dist/
 * is not private, unlike a checkout's and the App payload's. Under tsx it resolves to nothing.
 */
export function isNpmInstall(from: URL = new URL('../package.json', import.meta.url)): boolean {
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(from), 'utf8')) as { name?: unknown; private?: unknown };
    return manifest.name === 'riffet' && manifest.private !== true;
  } catch { return false; }
}

/**
 * Release check for an npm install, which has no Git clone to inspect. The registry only names a
 * version, so `latest` stays null rather than inventing a commit; the fixed message carries it.
 */
export async function checkNpmUpdate(current: BuildInfo): Promise<UpdateCheck> {
  try {
    const response = await fetch('https://registry.npmjs.org/riffet/latest', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    const version = response.ok ? (await response.json() as { version?: unknown }).version : undefined;
    // Only a stable x.y.z reaches the message; anything else from the network is dropped.
    if (typeof version !== 'string') throw new Error('Unexpected registry response.');
    const order = compareReleaseTags(`v${current.version}`, `v${version}`);
    const upgrade = `请在服务器所在电脑运行 ${NPM_UPGRADE_COMMAND}，再运行 riffet restart。`;
    return order < 0
      ? { status: 'available', current, latest: null, source: null, message: `发现新的发布版本 ${version}。${upgrade}` }
      : { status: order > 0 ? 'ahead' : 'current', current, latest: null, source: null, message: order > 0 ? '当前版本高于 npm 上的最新发布版本。' : '当前是最新发布版本。' };
  } catch {
    return { status: 'unavailable', current, latest: null, source: null, message: '无法查询 npm 上的最新版本，请确认服务器所在电脑能访问 npm registry。' };
  }
}
