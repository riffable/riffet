import { describe, expect, it } from 'vitest';
import { externalEntryOf, holderOf, listExternalThreads } from './external.js';

const thread = (over: Record<string, unknown>) => ({ id: 't1', cwd: '/w', preview: 'hello', updatedAt: 100, source: 'cli', ...over });

describe('codex external sessions', () => {
  it('maps threads and leaves subagents out', () => {
    expect(externalEntryOf(thread({ name: 'Named', gitInfo: { branch: 'main' } }))).toMatchObject({ title: 'Named', preview: 'hello', gitBranch: 'main', updatedAt: 100_000, source: 'cli' });
    expect(externalEntryOf(thread({ preview: '', source: 'vscode' }))).toMatchObject({ title: 't1', source: 'ide' });
    expect(externalEntryOf(thread({ originator: 'Codex Desktop', source: 'appServer' }))?.source).toBe('desktop');
    expect(externalEntryOf(thread({ source: { subAgent: { thread_spawn: {} } } }))).toBeUndefined();
    expect(externalEntryOf(thread({ parentThreadId: 'p' }))).toBeUndefined();
  });

  it('pages until the limit and finds the holder', async () => {
    const pages = [{ data: [thread({ id: 'a' }), thread({ id: 'b', parentThreadId: 'a' })], nextCursor: 'n' }, { data: [thread({ id: 'c' })], nextCursor: null }];
    const seen: unknown[] = [];
    const entries = await listExternalThreads(async params => { seen.push(params.cursor); return pages.shift(); }, { includeNonInteractive: false, limit: 10, signal: new AbortController().signal });
    expect(entries.map(entry => entry.nativeSessionId)).toEqual(['a', 'c']);
    expect(seen).toEqual([undefined, 'n']);
    const rows = [{ pid: 5, argv: ['/bin/codex', '--remote', 'unix:/s', 'resume', 'a'] }, { pid: 6, argv: ['codex', 'app-server', 'a'] }];
    expect(holderOf(rows, 'a', new Set(['codex']), new Set(['unix:/s']))).toEqual({ pid: 5, ours: true });
    expect(holderOf(rows, 'a', new Set(['codex']), new Set())).toEqual({ pid: 5 });
  });
});
