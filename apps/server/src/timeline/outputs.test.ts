import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Journal } from '../journal/journal.js';
import { JournalLaneWriter } from '../journal/ingest.js';
import { SessionFileSnapshots } from '../backends/shared/file-snapshots.js';
import { aggregateSessionOutputs, normalizeOutputPath, OutputDiffCache, readSessionOutputDiff, type StoredRowOutput } from './outputs.js';
import { TimelineService } from './service.js';

describe('session outputs & snapshot ledger', () => {
  let dir: string;
  let db: DatabaseSync;
  let journal: Journal;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'riffet-outputs-'));
    db = new DatabaseSync(':memory:');
    journal = new Journal(db);
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('chains continuous edits into exact net deltas and drops net-zero files', async () => {
    const project = join(dir, 'repo');
    const snapshots = new SessionFileSnapshots(join(dir, 'obs'));
    snapshots.configure({ putBlob: (id, bytes, mime) => journal.putSessionBlob(id, bytes, mime) });
    const file = join(project, 'a.ts');
    await writeFile(join(dir, 'placeholder'), '');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(project, { recursive: true });

    // Edit 1: create file with 3 lines.
    await snapshots.beginEdit('s1', 't1', file);
    await writeFile(file, 'one\ntwo\nthree\n');
    const r1 = await snapshots.finishEdit('s1', 't1', { applied: true, rawPath: file });
    expect(r1).toHaveLength(1);
    expect(r1![0]).toMatchObject({ status: 'created', added: 3, removed: 0 });

    // Edit 2: modify one line and add another -> net vs absent should be +4 -0, status still created.
    await snapshots.beginEdit('s1', 't2', file);
    await writeFile(file, 'one\nTWO\nthree\nfour\n');
    const r2 = await snapshots.finishEdit('s1', 't2', { applied: true, rawPath: file });
    expect(r2).toHaveLength(1);
    expect(r2![0]).toMatchObject({ status: 'modified', added: 2, removed: 1 });

    const records: StoredRowOutput[] = [...r1!, ...r2!].map(item => ({
      path: item.path, added: item.added, removed: item.removed, created: item.status === 'created',
      status: item.status, accuracy: 'exact', preHash: item.preHash, postHash: item.postHash,
    }));
    const readBlob = (hash: string) => journal.sessionBlob('s1', hash)?.bytes();
    const net = aggregateSessionOutputs(records, { root: project, readBlob, diffCache: new OutputDiffCache() });
    expect(net.total).toBe(1);
    expect(net.items[0]).toMatchObject({ path: 'a.ts', status: 'created', created: true, added: 4, removed: 0, accuracy: 'exact', hasSnapshotDiff: true });

    const diff = readSessionOutputDiff(records, 'a.ts', { root: project, readBlob });
    expect(diff).toEqual({
      path: 'a.ts', before: '', after: 'one\nTWO\nthree\nfour\n', status: 'created', source: 'session',
    });

    // Edit 3: delete the newly created file -> net-zero, omitted from outputs.
    await snapshots.beginEdit('s1', 't3', file);
    await rm(file);
    const r3 = await snapshots.finishEdit('s1', 't3', { applied: true, rawPath: file });
    expect(r3![0]).toMatchObject({ status: 'deleted', postHash: null });
    const allRecords: StoredRowOutput[] = [...records, {
      path: r3![0]!.path, added: r3![0]!.added, removed: r3![0]!.removed, created: false,
      status: r3![0]!.status, accuracy: 'exact', preHash: r3![0]!.preHash, postHash: r3![0]!.postHash,
    }];
    expect(aggregateSessionOutputs(allRecords, { root: project, readBlob }).items).toEqual([]);
  });

  it('separates intervening external edits so user changes are not counted as agent output', async () => {
    const project = join(dir, 'repo');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(project, { recursive: true });
    const file = join(project, 'app.ts');
    await writeFile(file, 'a\nb\n');

    const snapshots = new SessionFileSnapshots(join(dir, 'obs'));
    snapshots.configure({ putBlob: (id, bytes, mime) => journal.putSessionBlob(id, bytes, mime) });

    // Agent edit 1: +1 line.
    await snapshots.beginEdit('s1', 't1', file);
    await writeFile(file, 'a\nb\nc\n');
    const r1 = (await snapshots.finishEdit('s1', 't1', { applied: true, rawPath: file }))!;

    // External user edit: +20 lines without going through the agent.
    await writeFile(file, `a\nb\nc\n${Array.from({ length: 20 }, (_, i) => `user-${i}`).join('\n')}\n`);

    // Agent edit 2: +1 line.
    await snapshots.beginEdit('s1', 't2', file);
    await writeFile(file, `a\nb\nc\n${Array.from({ length: 20 }, (_, i) => `user-${i}`).join('\n')}\nagent-tail\n`);
    const r2 = (await snapshots.finishEdit('s1', 't2', { applied: true, rawPath: file }))!;

    const records: StoredRowOutput[] = [...r1, ...r2].map(item => ({
      path: item.path, added: item.added, removed: item.removed, created: item.status === 'created',
      status: item.status, accuracy: 'exact', preHash: item.preHash, postHash: item.postHash,
    }));
    const readBlob = (hash: string) => journal.sessionBlob('s1', hash)?.bytes();
    const summary = aggregateSessionOutputs(records, { root: project, readBlob });
    expect(summary.items).toHaveLength(1);
    // Only the agent's two +1 edits are counted, not the 20 lines written externally between them.
    expect(summary.items[0]).toMatchObject({ path: 'app.ts', status: 'modified', added: 2, removed: 0 });
    const diff = readSessionOutputDiff(records, 'app.ts', { root: project, readBlob });
    expect(diff?.externalEdits).toBe(true);
  });

  it('normalizes path aliases and flags outside-project paths', () => {
    expect(normalizeOutputPath('/private/tmp/repo/./src//a.ts', '/tmp/repo')).toEqual({ path: 'src/a.ts', outsideProject: false });
    expect(normalizeOutputPath('/var/other/out.txt', '/tmp/repo')).toEqual({ path: '/var/other/out.txt', outsideProject: true });
  });

  it('aggregates pre-truncation diffs across nested subagents and excludes unsettled edits in TimelineService', async () => {
    const timeline = new TimelineService({
      db,
      journal,
      listRuns: () => [],
      coldSweep: false,
      debounceMs: 0,
      projectRoot: () => '/repo',
    });
    try {
      const main = JournalLaneWriter.open(journal, 's1');
      const largeBody = Array.from({ length: 900 }, (_, i) => `export const line_${i} = ${i};`).join('\n');
      const now = '2026-11-28T00:00:00.000Z';
      main.turnStarted('turn-1', now);
      main.commit({
        events: [
          // Oversized completed write (> 16 KiB, truncated by fitRow in timeline_rows, preserved intact in timeline_row_outputs).
          {
            sequence: 0, sessionId: 's1', type: 'tool_call', nativeId: 'm-1', nativeTurnId: 'turn-1', createdAt: now,
            data: { toolCallId: 'm-1', title: 'Write big.ts', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: '/repo/big.ts', oldText: '', newText: largeBody, status: 'created' }] },
          },
          // Unsettled in-progress edit must NOT appear in outputs.
          {
            sequence: 0, sessionId: 's1', type: 'tool_call', nativeId: 'm-2', nativeTurnId: 'turn-1', createdAt: now,
            data: { toolCallId: 'm-2', title: 'Edit pending.ts', kind: 'edit', status: 'in_progress', content: [{ type: 'diff', path: '/repo/pending.ts', oldText: 'a', newText: 'b' }] },
          },
          // Parent spawns subagent A.
          {
            sequence: 0, sessionId: 's1', type: 'tool_call', nativeId: 'm-sub-a', nativeTurnId: 'turn-1', createdAt: now,
            data: { toolCallId: 'sub-a', title: 'Agent A', kind: 'agent', status: 'completed', subagent: { prompt: 'do A' } },
          },
        ],
        cursor: '1',
      });

      // Subagent A spawns nested Subagent B.
      const subA = main.child('sub-a', 'agent-a');
      subA.turnStarted('ta-1', '2026-11-28T00:00:01.000Z');
      subA.commit({
        events: [
          {
            sequence: 0, sessionId: 's1', type: 'tool_call', nativeId: 'a-sub-b', nativeTurnId: 'ta-1', createdAt: '2026-11-28T00:00:01.000Z',
            data: { toolCallId: 'sub-b', title: 'Agent B', kind: 'agent', status: 'completed', subagent: { prompt: 'do B' } },
          },
        ],
        cursor: '1',
      });
      const subB = subA.child('sub-b', 'agent-b');
      subB.turnStarted('tb-1', '2026-11-28T00:00:02.000Z');
      subB.commit({
        events: [
          {
            sequence: 0, sessionId: 's1', type: 'tool_call', nativeId: 'b-edit', nativeTurnId: 'tb-1', createdAt: '2026-11-28T00:00:02.000Z',
            data: { toolCallId: 'b-edit', title: 'Edit deep.ts', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: '/repo/deep.ts', oldText: 'old', newText: 'new\nline2', status: 'modified' }] },
          },
        ],
        cursor: '1',
      });

      await timeline.ready('s1', 'sub:sub-b');
      await timeline.ready('s1', 'sub:sub-a');
      await timeline.ready('s1', 'main');

      const summary = timeline.outputs('s1');
      expect(summary.items.map(item => item.path)).toEqual(['deep.ts', 'big.ts']);
      // Full 900 lines preserved even though fitRow truncated the wire row at 16 KiB.
      expect(summary.items.find(item => item.path === 'big.ts')).toMatchObject({ status: 'created', added: 900, removed: 0 });
      // Nested grandchild subagent B's edit surfaces in main session outputs.
      expect(summary.items.find(item => item.path === 'deep.ts')).toMatchObject({ status: 'modified', added: 2, removed: 1 });
    } finally {
      timeline.close();
    }
  });
});
