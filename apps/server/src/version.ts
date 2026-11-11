import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { BuildInfo } from '@contracts';

declare const __RIFFET_BUILD_RECORD__: { build: BuildInfo; sourceRoot: string };

function sourceBuildRecord(): { build: BuildInfo; sourceRoot?: string } {
  try {
    // tsx development only. A built program always uses its frozen embedded identity.
    const script = fileURLToPath(new URL('../../../scripts/build-info.mjs', import.meta.url));
    return JSON.parse(execFileSync(process.execPath, [script, '--stdout'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch {
    return { build: { version: 'unknown', buildNumber: 0, tag: null, commit: null, dirty: true } };
  }
}

const record = typeof __RIFFET_BUILD_RECORD__ === 'undefined' ? sourceBuildRecord() : __RIFFET_BUILD_RECORD__;
export const SERVER_BUILD: BuildInfo = Object.freeze({ ...record.build });
export const SERVER_VERSION = SERVER_BUILD.version;
/** Private local association. Never include in public health/check responses. Empty in public builds. */
export const SOURCE_ROOT: string | undefined = record.sourceRoot || undefined;

export type ServerManager = 'cli' | 'launchd' | 'app';

/** Who keeps this process running, as the launcher that started it reported (`RIFFET_MANAGED_BY`). */
export function serverManager(env: NodeJS.ProcessEnv = process.env): ServerManager | undefined {
  const value = env.RIFFET_MANAGED_BY;
  return value === 'cli' || value === 'launchd' || value === 'app' ? value : undefined;
}

/**
 * Read once at startup and removed from the environment, so the terminals and agents this server
 * spawns (and any server started from one of them) do not inherit a launcher that is not theirs.
 */
export const LAUNCHED_BY: ServerManager | undefined = serverManager();
delete process.env.RIFFET_MANAGED_BY;
