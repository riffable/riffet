import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess } from '@riffet/plugin-api';
import { agySessionPaths } from './config.js';
import { prepareBridge, readJson, writeJson } from './bridge.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'riffet-agy-bridge-'));
  roots.push(base);
  const paths = agySessionPaths(await realpath(base), 'session');
  await writeJson(paths.settingsPath, { statusLine: { type: 'command', command: "printf 'original\\n'; cat", padding: 1 } });
  await mkdir(paths.bridgeDir, { recursive: true });
  const nonce = 'a'.repeat(48);
  await prepareBridge(paths, nonce);
  return { paths, nonce, script: join(paths.root, 'bridge', 'capture.cjs') };
}
describe('Antigravity observation bridge', () => {
  it('bounds JSON reads and refuses linked files and ancestors', async () => {
    const base = await mkdtemp(join(tmpdir(), 'riffet-agy-json-'));
    roots.push(base);
    const file = join(base, 'safe.json');
    await writeJson(file, { private: true });
    expect(await readJson(file)).toEqual({ private: true });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const link = join(base, 'linked.json');
    await symlink(file, link);
    expect(await readJson(link)).toBeUndefined();
    await expect(writeJson(link, {})).rejects.toThrow('regular');
    const directory = join(base, 'external');
    await mkdir(directory);
    await writeFile(join(directory, 'data.json'), '{}');
    await symlink(directory, join(base, 'linked-dir'));
    expect(await readJson(join(base, 'linked-dir', 'data.json'))).toBeUndefined();
    await expect(writeJson(join(base, 'linked-dir', 'data.json'), {})).rejects.toThrow('linked');
    const huge = join(base, 'huge.json');
    await writeFile(huge, '{}');
    await truncate(huge, 4 * 1024 * 1024 + 1);
    expect(await readJson(huge)).toBeUndefined();
    expect((await readdir(base)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
  it('records only bound status and identity while forwarding original stdout', async () => {
    const f = await fixture();
    const payload = {
      conversation_id: '11111111-1111-1111-1111-111111111111',
      agent_state: 'idle',
      pending_input_count: 2,
      task_count: 1,
      cycle_mode: 'plan',
      token_count: 42,
      model: { id: 'model', effort: 'medium', secret: 'hidden' },
      subagents: [{ name: 'child', status: 'running', role: 'private-child-prompt' }],
      prompt: 'private-parent-prompt',
      apiKey: 'secret',
    };
    const raw = JSON.stringify(payload);
    const result = await runProcess(process.execPath, [f.script, 'status'], {
      cwd: f.paths.bridgeDir,
      input: Buffer.from(raw),
      timeoutMs: 6000,
      maxOutputBytes: 8192,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`original\n${raw}`);
    const saved = await readJson(join(f.paths.root, 'bridge', 'status.json'));
    expect(saved?.nonce).toBe(f.nonce);
    expect(saved?.payload).toMatchObject({
      pending_input_count: 2,
      task_count: 1,
      token_count: 42,
      cycle_mode: 'plan',
      subagents: [{ name: 'child', status: 'running' }],
    });
    expect(JSON.stringify(saved)).not.toContain('private-parent-prompt');
    expect(JSON.stringify(saved)).not.toContain('private-child-prompt');
    expect(JSON.stringify(saved)).not.toContain('secret');
    const id = payload.conversation_id;
    const hook = await runProcess(process.execPath, [f.script, 'hook'], {
      cwd: f.paths.bridgeDir,
      input: Buffer.from(
        JSON.stringify({
          conversationId: id,
          cwd: f.paths.bridgeDir,
          workspacePaths: [f.paths.bridgeDir],
          lastUserInput: 'private prompt',
        }),
      ),
      timeoutMs: 6000,
    });
    expect(hook.stdout).toBe('{}');
    expect((await readJson(join(f.paths.root, 'bridge', `${id}.json`)))?.payload).not.toHaveProperty('lastUserInput');
    await prepareBridge(f.paths, f.nonce);
    expect((await readJson(join(f.paths.root, 'bridge', 'statusline.json')))?.original.command).toBe("printf 'original\\n'; cat");
  });
  it('records status before killing a stalled original command within the native deadline', async () => {
    const f = await fixture();
    const settings = await readJson(f.paths.settingsPath);
    await writeJson(f.paths.settingsPath, { ...settings, statusLine: { command: 'sleep 20' } });
    await prepareBridge(f.paths, f.nonce);
    const start = Date.now();
    const result = await runProcess(process.execPath, [f.script, 'status'], {
      cwd: f.paths.bridgeDir,
      input: Buffer.from('{"agent_state":"idle"}'),
      timeoutMs: 6000,
    });
    expect(result.code).toBe(0);
    expect(Date.now() - start).toBeLessThan(5500);
    expect((await readJson(join(f.paths.root, 'bridge', 'status.json')))?.payload.agent_state).toBe('idle');
  });
});
