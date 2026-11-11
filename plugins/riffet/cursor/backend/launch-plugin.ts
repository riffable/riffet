import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionAtLeast } from '@riffet/plugin-api';
import { runCursor, type CursorLaunchProfile } from '../cli-driver.js';

const probes = new Map<string, Promise<boolean>>();
const moduleDir = dirname(fileURLToPath(import.meta.url));
// The hook transport is shared with the core's other CLIs. A build copies it next to the bundle; a source checkout reads it where it lives.
const sourceHook = resolve(moduleDir, '../../../../apps/server/src/backends/shared/hook-cli.mjs');
const hookScript = existsSync(sourceHook) ? sourceHook : resolve(moduleDir, 'hook-cli.mjs');

const HOOK_STEER_MIN_VERSION = '2026.10.01';

/** Older/unknown CLI builds have not been verified to preserve postToolUse context. */
export function cursorSupportsHookSteer(version: string, help: string): boolean {
  const printed = version.trim();
  return /^\d{4}\.\d{2}\.\d{2}-[a-z\d]+$/i.test(printed) && versionAtLeast(printed, HOOK_STEER_MIN_VERSION) && /--plugin-dir\b/.test(help);
}

export function probeCursorHookSteer(profile: CursorLaunchProfile): Promise<boolean> {
  const key = profile.identityKey;
  let probe = probes.get(key);
  if (!probe) {
    probe = Promise.all(['--version', '--help'].map(flag => runCursor(profile, [flag], {
      cwd: process.cwd(), timeoutMs: 8000, maxOutputBytes: 128 * 1024,
    }))).then(([version, help]) => Boolean(version?.code === 0 && help?.code === 0
      && cursorSupportsHookSteer(version.stdout, help.stdout))).catch(() => false);
    probes.set(key, probe);
  }
  return probe;
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** Only server state is written. A running CLI rereads bridge credentials on every hook call. */
export async function writeCursorHookPlugin(stateDir: string, bridge: { url: string; token: string }): Promise<string> {
  const root = join(stateDir, 'cursor-hook');
  const plugin = join(root, 'plugin');
  await mkdir(join(plugin, '.cursor-plugin'), { recursive: true, mode: 0o700 });
  await mkdir(join(plugin, 'hooks'), { recursive: true, mode: 0o700 });
  const config = join(root, 'bridge.json');
  const temporary = `${config}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(bridge), { mode: 0o600 });
  await rename(temporary, config);
  const command = `${quote(process.execPath)} ${quote(hookScript)} 8000 --config ${quote(config)}`;
  await writeFile(join(plugin, '.cursor-plugin/plugin.json'), JSON.stringify({
    name: 'riffet-steer', version: '1.0.0', hooks: './hooks/hooks.json',
  }), { mode: 0o600 });
  await writeFile(join(plugin, 'hooks/hooks.json'), JSON.stringify({
    version: 1,
    hooks: Object.fromEntries(['beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'stop', 'sessionEnd', 'preCompact']
      .map(event => [event, [{ command, timeout: 10 }]])),
  }), { mode: 0o600 });
  return plugin;
}
