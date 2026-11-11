import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cursorSupportsHookSteer, writeCursorHookPlugin } from './launch-plugin.js';

describe('Cursor private hook plugin', () => {
  it('gates unknown/old CLI versions and requires plugin loading', () => {
    expect(cursorSupportsHookSteer('2026.10.01-e373342', '--plugin-dir <path>')).toBe(true);
    expect(cursorSupportsHookSteer('2026.09.30-deadbeef', '--plugin-dir <path>')).toBe(false);
    expect(cursorSupportsHookSteer('unknown', '--plugin-dir <path>')).toBe(false);
    expect(cursorSupportsHookSteer('2026.10.01-e373342', '--help')).toBe(false);
  });

  it('writes only private server state and keeps restart credentials out of the hook command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cursor-plugin-test-'));
    const plugin = await writeCursorHookPlugin(root, { url: 'http://127.0.0.1:1234', token: 'first-secret' });
    const config = join(root, 'cursor-hook/bridge.json');
    const hooks = JSON.parse(await readFile(join(plugin, 'hooks/hooks.json'), 'utf8'));
    expect(hooks.hooks.postToolUse[0].command).toContain('--config');
    expect(hooks.hooks.postToolUse[0].command).not.toContain('first-secret');
    expect(hooks.hooks.postToolUseFailure).toBeDefined();
    expect((await stat(config)).mode & 0o777).toBe(0o600);
    expect(await writeCursorHookPlugin(root, { url: 'http://127.0.0.1:5678', token: 'next-secret' })).toBe(plugin);
    expect(JSON.parse(await readFile(config, 'utf8'))).toEqual({ url: 'http://127.0.0.1:5678', token: 'next-secret' });
  });
});
