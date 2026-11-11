import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeHookServer } from './hook-server.js';

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const hook = fileURLToPath(new URL('./hook-cli.mjs', import.meta.url));

async function invoke(args: string[], payload: unknown, env: Record<string, string> = {}) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [hook, ...args], { env: { ...process.env,
      RIFFET_HOOK_URL: '', RIFFET_HOOK_TOKEN: '', RIFFET_CLAUDE_HOOK_URL: '', RIFFET_CLAUDE_HOOK_TOKEN: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe('native hook loopback transport', () => {
  it('requires the private token, accepts bounded JSON, and never echoes handler errors', async () => {
    const handler = vi.fn(async () => ({ additional_context: 'accepted' }));
    const server = new NativeHookServer(handler); cleanups.push(() => server.close());
    const { url, token } = await server.start();
    const send = (body: string, authorization = `Bearer ${token}`) => fetch(`${url}/hook`, { method: 'POST', headers: { authorization }, body });
    expect((await send('{}', 'Bearer incorrect')).status).toBe(404);
    expect((await send('[]')).status).toBe(400);
    expect((await send(JSON.stringify({ deliveryId: 'test', payload: {} }))).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((await send(JSON.stringify({ deliveryId: 'test', payload: { text: 'a'.repeat(1024 * 1024) } }))).status).toBe(400);
    expect(handler).toHaveBeenCalledTimes(1);
    handler.mockImplementationOnce(async () => { throw new Error('sensitive native input'); });
    expect(await (await send(JSON.stringify({ deliveryId: 'test', payload: {} }))).text()).toBe('{}');
  });

  it('rereads a private config on every CLI invocation after a bridge restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-hook-transport-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
    const config = join(root, 'bridge.json');
    const firstHandler = vi.fn(async (_payload: Record<string, unknown>) => ({ additional_context: 'first' }));
    const first = new NativeHookServer(firstHandler); cleanups.push(() => first.close());
    await writeFile(config, JSON.stringify(await first.start()), { mode: 0o600 });
    const a = await invoke(['8000', '--config', config], { hook_event_name: 'postToolUse', generation_id: 'generation-1' });
    expect(a).toEqual({ code: 0, stdout: '{"additional_context":"first"}\n', stderr: '' });
    await first.close();
    const secondHandler = vi.fn(async (_payload: Record<string, unknown>) => ({ additional_context: 'second' }));
    const second = new NativeHookServer(secondHandler); cleanups.push(() => second.close());
    await writeFile(config, JSON.stringify(await second.start()), { mode: 0o600 });
    const b = await invoke(['--config', config, '8000'], { hook_event_name: 'postToolUse', generation_id: 'generation-2' });
    expect(b).toEqual({ code: 0, stdout: '{"additional_context":"second"}\n', stderr: '' });
    expect(firstHandler).toHaveBeenCalledTimes(1); expect(secondHandler).toHaveBeenCalledTimes(1);
    expect(firstHandler.mock.calls[0]![0]).toMatchObject({ generation_id: 'generation-1' });
    expect(secondHandler.mock.calls[0]![0]).toMatchObject({ generation_id: 'generation-2' });
  });

  it('fails open without connecting when the descriptor is abandoned, and never trusts one it does not own', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-hook-descriptor-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
    const descriptor = join(root, 'claude-hook.json');
    const handler = vi.fn(async () => ({ additional_context: 'served' }));
    const server = new NativeHookServer(handler); cleanups.push(() => server.close());
    const { url, token } = await server.start();
    const dead = spawn(process.execPath, ['-e', '']); await new Promise(resolve => dead.on('close', resolve));
    const write = async (patch: Record<string, unknown>, mode = 0o600) => {
      await writeFile(descriptor, JSON.stringify({ version: 1, url, token, pid: process.pid, heartbeatAt: Date.now(), ...patch }));
      await chmod(descriptor, mode);
    };
    const payload = { hook_event_name: 'PreToolUse', session_id: 'session' };

    await write({});
    expect((await invoke(['8000', '--descriptor', descriptor], payload)).stdout).toBe('{"additional_context":"served"}\n');
    expect(handler).toHaveBeenCalledTimes(1);
    for (const stale of [{ heartbeatAt: Date.now() - 120_000 }, { pid: dead.pid }, { url: 'http://example.com:80' }]) {
      await write(stale);
      const started = Date.now();
      expect(await invoke(['8000', '--descriptor', descriptor], payload)).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(Date.now() - started).toBeLessThan(2_000);
    }
    await write({}, 0o644);
    expect((await invoke(['8000', '--descriptor', descriptor], payload)).stdout).toBe('');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
