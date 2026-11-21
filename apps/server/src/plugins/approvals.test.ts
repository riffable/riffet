import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_APPROVAL_BUDGET } from '../../../../packages/contracts/src/index.js';
import { PluginApprovals, type PluginApprovalsDeps } from './approvals.js';

const request = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: 'Publish', body: 'Write **3** rows', actions: [{ id: 'yes', label: 'Publish', tone: 'primary' as const }, { id: 'no', label: 'Discard', tone: 'danger' as const }], ...extra });

describe('plugin approvals', () => {
  const dirs: string[] = [];
  const open: PluginApprovals[] = [];
  afterEach(() => { vi.useRealTimers(); for (const approvals of open.splice(0)) approvals.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function make(db: DatabaseSync, deps: Partial<PluginApprovalsDeps> = {}) {
    const approvals = new PluginApprovals({ db, pluginName: id => `Name of ${id}`, decide: async () => undefined, ...deps });
    open.push(approvals);
    return approvals;
  }

  it('requests idempotently, withdraws, and announces each change', () => {
    const opened = vi.fn();
    const approvals = make(new DatabaseSync(':memory:'), { opened });
    const changed = vi.fn();
    approvals.onChange(changed);
    approvals.request('acme.sheet', request('a'));
    approvals.request('acme.sheet', request('a', { title: 'Other' }));
    expect(approvals.list()).toMatchObject([{ pluginId: 'acme.sheet', pluginName: 'Name of acme.sheet', id: 'a', title: 'Publish' }]);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    approvals.withdraw('acme.sheet', 'a');
    approvals.withdraw('acme.sheet', 'a');
    expect(approvals.list()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('keeps approvals across a reload and scopes ids to the plugin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'approvals-')); dirs.push(dir);
    const file = join(dir, 'db.sqlite');
    const first = make(new DatabaseSync(file));
    first.request('acme.sheet', request('a'));
    first.request('acme.other', request('a'));
    first.close();
    const second = make(new DatabaseSync(file));
    expect(second.list().map(item => item.pluginId).sort()).toEqual(['acme.other', 'acme.sheet']);
    second.withdrawAll('acme.other');
    expect(second.list().map(item => item.pluginId)).toEqual(['acme.sheet']);
  });

  it('refuses a request past the per-plugin cap, and counts only open ones', () => {
    const approvals = make(new DatabaseSync(':memory:'));
    for (let i = 0; i < PLUGIN_APPROVAL_BUDGET.openPerPlugin; i += 1) approvals.request('acme.sheet', request(`a${i}`));
    expect(() => approvals.request('acme.sheet', request('extra'))).toThrow(/approvals open/);
    approvals.request('acme.other', request('extra'));
    approvals.withdraw('acme.sheet', 'a0');
    approvals.request('acme.sheet', request('extra'));
  });

  it('drops an approval when it expires', () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    const approvals = make(new DatabaseSync(':memory:'));
    const changed = vi.fn();
    approvals.onChange(changed);
    expect(() => approvals.request('acme.sheet', request('late', { expiresAt: '2025-12-31T00:00:00Z' }))).toThrow(/past/);
    approvals.request('acme.sheet', request('a', { expiresAt: '2026-01-01T00:01:00Z' }));
    approvals.request('acme.sheet', request('b'));
    vi.advanceTimersByTime(61_000);
    expect(changed).toHaveBeenCalledTimes(3);
    expect(approvals.list().map(item => item.id)).toEqual(['b']);
  });

  it('removes an approval only after its decision succeeded', async () => {
    const decide = vi.fn<PluginApprovalsDeps['decide']>();
    const approvals = make(new DatabaseSync(':memory:'), { decide });
    approvals.request('acme.sheet', request('a'));
    decide.mockRejectedValueOnce(new Error('sheet is locked'));
    await expect(approvals.decide('acme.sheet', 'a', 'yes')).rejects.toThrow('sheet is locked');
    expect(approvals.list()).toHaveLength(1);
    await expect(approvals.decide('acme.sheet', 'a', 'maybe')).rejects.toThrow(/Unknown action/);
    decide.mockResolvedValueOnce({ message: { en: 'Published' } });
    await expect(approvals.decide('acme.sheet', 'a', 'yes')).resolves.toEqual({ message: { en: 'Published' } });
    expect(decide).toHaveBeenLastCalledWith('acme.sheet', 'a', 'yes');
    expect(approvals.list()).toEqual([]);
    await expect(approvals.decide('acme.sheet', 'a', 'yes')).rejects.toMatchObject({ code: 'PLUGIN_APPROVAL_NOT_FOUND' });
  });

  it('runs one decision at a time per approval', async () => {
    let release!: () => void;
    const decide = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const approvals = make(new DatabaseSync(':memory:'), { decide });
    approvals.request('acme.sheet', request('a'));
    const first = approvals.decide('acme.sheet', 'a', 'yes');
    await expect(approvals.decide('acme.sheet', 'a', 'no')).rejects.toMatchObject({ code: 'PLUGIN_APPROVAL_BUSY' });
    release();
    await first;
    expect(decide).toHaveBeenCalledTimes(1);
  });
});
