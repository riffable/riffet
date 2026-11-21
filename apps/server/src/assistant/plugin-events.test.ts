import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Store } from '../store.js';
import { AssistantDelegations } from './delegations.js';
import { syncPluginPacks } from './plugin-packs.js';

it('queues one run per subscribed delegation and event key, and drops an oversized payload', () => {
  const store = new Store(':memory:');
  const fire = vi.fn();
  const delegations = new AssistantDelegations({
    store, nextCron: () => undefined, timeZone: () => 'UTC', fire, expired: vi.fn(),
    taskStatuses: { baseline: () => ({ workItemId: 'w', taskNumber: 1, cursor: 'c' }), events: () => [], subscribe: () => () => {} },
    pluginEvents: { declared: topic => topic === 'acme.fin/alert', backlog: () => 0 },
  });
  expect(() => delegations.create({ goal: 'g', attention: 'a', trigger: { kind: 'plugin-event', topic: 'acme.fin/other' } })).toThrow();
  const watch = delegations.create({ goal: 'g', attention: 'a', trigger: { kind: 'plugin-event', topic: 'acme.fin/alert' } });
  expect(delegations.pluginEvent('acme.fin/alert', { symbol: 'X' }, 'k1')).toEqual({ delegations: 1 });
  expect(delegations.pluginEvent('acme.fin/alert', { symbol: 'X' }, 'k1')).toEqual({ delegations: 0 });
  expect(fire).toHaveBeenCalledTimes(1);
  expect(fire.mock.calls[0]![0]).toMatchObject({ key: `delegation-event:${watch.id}:k1`, cursor: 'k1' });
  expect(delegations.get(watch.id).cursor).toBe('k1');
  expect(delegations.pluginEvent('acme.fin/alert', { n: 1 })).toEqual({ delegations: 1 });
  expect(delegations.pluginEvent('acme.fin/none', {}, 'k')).toEqual({ delegations: 0 });
  expect(() => delegations.pluginEvent('acme.fin/alert', 'x'.repeat(20_000), 'big')).toThrow();
});

it('installs, replaces and removes a plugin pack, and refuses a name that is not its own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'riffet-packs-'));
  const cwd = join(dir, 'assistant');
  const root = join(dir, 'plugin');
  const write = (name: string, version: string) => {
    mkdirSync(join(root, 'assets/pack/.claude-plugin'), { recursive: true });
    writeFileSync(join(root, 'assets/pack/.claude-plugin/plugin.json'), JSON.stringify({ name, version }));
  };
  mkdirSync(join(cwd, 'packs', 'mine/.claude-plugin'), { recursive: true });
  writeFileSync(join(cwd, 'packs/mine/.claude-plugin/plugin.json'), '{"name":"mine"}');
  const source = (version: string) => ({ pluginId: 'acme.fin', version, root, path: 'assets/pack' });

  write('fin', '1');
  expect((await syncPluginPacks(cwd, [source('1')])).changed).toBe(true);
  expect(existsSync(join(cwd, 'packs/fin/.claude-plugin/plugin.json'))).toBe(true);
  expect((await syncPluginPacks(cwd, [source('1')])).changed).toBe(false);
  write('fin', '2');
  expect((await syncPluginPacks(cwd, [source('2')])).changed).toBe(true);

  write('mine', '2');
  const clash = await syncPluginPacks(cwd, [source('2')]);
  expect(clash.problems.get('acme.fin')).toMatch(/not installed/);
  expect(readdirSync(join(cwd, 'packs')).filter(name => !name.startsWith('.')).sort()).toEqual(['mine']);

  write('fin', '2');
  await syncPluginPacks(cwd, [source('2')]);
  expect((await syncPluginPacks(cwd, [])).changed).toBe(true);
  expect(existsSync(join(cwd, 'packs/fin'))).toBe(false);
  expect(existsSync(join(cwd, 'packs/mine'))).toBe(true);
});
