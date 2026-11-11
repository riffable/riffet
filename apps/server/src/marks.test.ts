import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MarkCreateRequest, WorkbenchEvent } from '../../../packages/contracts/src/index.js';
import { MarkStore } from './marks.js';
import { Store } from './store.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function open(path?: string) {
  if (!path) { const directory = mkdtempSync(join(tmpdir(), 'riffet-marks-')); directories.push(directory); path = join(directory, 'workbench.db'); }
  const store = new Store(path);
  return { path, store, marks: new MarkStore(store, join(dirname(path), 'marks')) };
}
const answer = (nativeId: string, uuid: string, text: string, sequence: number): WorkbenchEvent =>
  ({ sequence, sessionId: 's', type: 'agent_message_chunk', createdAt: '2026-01-01T00:00:00.000Z', data: { content: { type: 'text', text } }, nativeId, nativeAliases: [uuid] }) as WorkbenchEvent;

describe('marks', () => {
  it('creates idempotently, folds duplicates into the first mark, and survives a restart', () => {
    const { path, store, marks } = open();
    const session = store.createSession({ projectId: store.createProject('/tmp/marks', 'marks').id, kind: 'native', backendId: 'claude', title: 'Plan' });
    const request: MarkCreateRequest = { id: 'm1', sessionId: session.id, kind: 'message', anchor: { messageId: 'claude:a:u1:0', aliases: ['u1'] }, snapshot: { text: 'The answer', at: '2026-01-01T00:00:00.000Z' } };
    const revision = store.marksRevision;
    const first = marks.create(request);
    expect(first).toMatchObject({ projectId: session.projectId, backendId: 'claude', state: 'ok', snapshot: { sessionTitle: 'Plan' } });
    expect(store.marksRevision).toBeGreaterThan(revision);
    expect(marks.create(request)).toEqual(first);
    expect(marks.create({ ...request, id: 'm2' }).id).toBe('m1');
    const span = { ...request, id: 'm3', kind: 'span' as const, quote: { exact: 'answer', prefix: 'The ', suffix: '' } };
    expect(marks.create(span).id).toBe('m3');
    expect(marks.create({ ...span, id: 'm4' }).id).toBe('m3');
    expect(() => marks.create({ ...request, id: 'm5', anchor: { messageId: 'claude:a:run:c1:text' } })).toThrow(/runId/);
    expect(() => marks.create({ ...request, id: 'm6', sessionId: 'missing' })).toThrow(/does not exist/);
    store.close();
    const reopened = open(path);
    expect(reopened.marks.list({}, 50)).toMatchObject({ total: 2, marks: [{ id: 'm3' }, { id: 'm1' }] });
    reopened.store.close();
  });

  it('re-anchors by alias when the id moved, and orphans a mark whose message is gone', async () => {
    const { store, marks } = open();
    const session = store.createSession({ projectId: store.createProject('/tmp/marks', 'marks').id, kind: 'native', backendId: 'claude' });
    marks.create({ id: 'm1', sessionId: session.id, kind: 'span', anchor: { messageId: 'claude:old:u1:0', aliases: ['u1'], sequence: 3 },
      quote: { exact: 'second', prefix: 'the ', suffix: '' }, snapshot: { text: 'the second answer', at: '2026-01-01T00:00:00.000Z' } });
    // The provider session id changed, so the transcript names the same message differently.
    const transcript = [answer('claude:new:u0:0', 'u0', 'the first answer', 1), answer('claude:new:u1:0', 'u1', 'the second answer', 7)];
    const located = await marks.locate('m1', async () => transcript);
    expect(located).toMatchObject({ found: true, messageId: 'claude:new:u1:0', sequence: 7 });
    expect(marks.get('m1')).toMatchObject({ state: 'ok', anchor: { messageId: 'claude:new:u1:0', aliases: ['u1'], sequence: 7 } });
    const gone = await marks.locate('m1', async () => [answer('claude:new:u0:0', 'u0', 'the first answer', 1)]);
    expect(gone).toMatchObject({ found: false, mark: { state: 'orphaned' } });
    expect(marks.list({ state: 'orphaned' }, 50).total).toBe(1);
    store.close();
  });

  it('retains a streaming selection when the provider commits a different message identity', async () => {
    const { store, marks } = open();
    const session = store.createSession({ projectId: store.createProject('/tmp/marks', 'marks').id, kind: 'native', backendId: 'claude' });
    marks.create({ id: 'stream', sessionId: session.id, kind: 'span', anchor: { messageId: 'claude:a:run:command:text', runId: 'run' },
      quote: { exact: 'selected words', prefix: 'The ', suffix: '' }, snapshot: { text: 'The selected words', at: '2026-01-01T00:00:00.000Z' } });
    const final = answer('claude:a:uuid:0', 'uuid', 'The selected words and the rest of the answer.', 4);
    expect(await marks.locate('stream', async () => [final])).toMatchObject({ found: true, messageId: 'claude:a:uuid:0', mark: { quote: { exact: 'selected words' } } });
    store.close();
  });

  it('finds a quote taken from the rendered answer in its Markdown source', async () => {
    const { store, marks } = open();
    const session = store.createSession({ projectId: store.createProject('/tmp/marks', 'marks').id, kind: 'native', backendId: 'codex' });
    // What a reader selects: no heading marks, list number, emphasis, backticks or link target.
    marks.create({ id: 'm1', sessionId: session.id, kind: 'span', anchor: { messageId: 't:turn:msg_1:assistant' },
      quote: { exact: '性能问题\n\n没有记忆化。 Sidebar 不是 memo 组件，见 文档。', prefix: '', suffix: '' }, snapshot: { text: 'x', at: '2026-01-01T00:00:00.000Z' } });
    const source = '### 性能问题\n1. **没有记忆化。** `Sidebar` 不是 memo 组件，见 [文档](https://example.com/a)。';
    const located = await marks.locate('m1', async () => [answer('t:turn:msg_1:assistant', 'msg_1', source, 4)]);
    expect(located).toMatchObject({ found: true, messageId: 't:turn:msg_1:assistant' });
    store.close();
  });

  it('answers with the prompt sent before the marked answer, not a later one', () => {
    const { store, marks } = open();
    const session = store.createSession({ projectId: store.createProject('/tmp/marks', 'marks').id, kind: 'native', backendId: 'claude' });
    marks.create({ id: 'm1', sessionId: session.id, kind: 'message', anchor: { messageId: 'a2' }, snapshot: { text: 'second answer', at: '2026-01-01T00:02:00.000Z' } });
    expect(marks.prompt('m1')).toEqual({});
    store.indexMessages([
      { sessionId: session.id, messageId: 'p1', kind: 'user', text: 'first question', at: '2026-01-01T00:00:00.000Z' },
      { sessionId: session.id, messageId: 'p2', kind: 'user', text: 'second question', at: '2026-01-01T00:01:00.000Z' },
      { sessionId: session.id, messageId: 'a2', kind: 'assistant', text: 'second answer', at: '2026-01-01T00:02:00.000Z' },
      { sessionId: session.id, messageId: 'p3', kind: 'user', text: 'third question', at: '2026-01-01T00:03:00.000Z' },
    ]);
    expect(marks.prompt('m1')).toEqual({ text: 'second question' });
    store.close();
  });

  it('matches a prompt stamped with only seconds against a millisecond answer', () => {
    const { store, marks } = open();
    const session = store.createSession({ projectId: store.createProject('/tmp/marks', 'marks').id, kind: 'native', backendId: 'claude' });
    marks.create({ id: 'm1', sessionId: session.id, kind: 'message', anchor: { messageId: 'a1' }, snapshot: { text: 'answer', at: '2026-01-01T00:02:00.000Z' } });
    store.indexMessages([
      { sessionId: session.id, messageId: 'p1', kind: 'user', text: 'same-second question', at: '2026-01-01T00:02:00Z' },
    ]);
    expect(marks.prompt('m1')).toEqual({ text: 'same-second question' });
    store.close();
  });

  it('keeps a saved image until its mark is deleted, once per picture', () => {
    const { store, marks } = open();
    const session = store.createSession({ projectId: store.createProject('/tmp/marks', 'marks').id, kind: 'native', backendId: 'claude' });
    const picture = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const request: MarkCreateRequest = { id: 'i1', sessionId: session.id, kind: 'image', anchor: { messageId: 'claude:a:tool1:0' },
      asset: { name: 'shot.png', mimeType: 'image/png', data: picture.toString('base64') }, snapshot: { text: 'shot.png', at: '2026-01-01T00:00:00.000Z' } };
    const mark = marks.create(request);
    expect(mark.asset).toMatchObject({ name: 'shot.png', stored: true, bytes: picture.length });
    expect(JSON.stringify(mark)).not.toContain(picture.toString('base64'));
    const file = marks.assetFile('i1')!;
    expect(readFileSync(file)).toEqual(picture);
    expect(marks.create({ ...request, id: 'i2' }).id).toBe('i1');
    marks.remove(['i1']);
    expect(existsSync(file)).toBe(false);
    store.close();
  });
});


it('filters managed marks before pagination and makes them visible after promotion', () => {
  const {store,marks}=open();
  try {
    const ordinary=store.createProject('/tmp/ordinary-mark','ordinary');
    const managed=store.updateProject(store.createProject('/tmp/managed-mark','managed').id,{system:'task-workspace'});
    for(const [id,projectId] of [['a-visible',ordinary.id],['z-hidden',managed.id]]) {
      const session=store.createSession({projectId:projectId!,kind:'native',backendId:'codex'});
      marks.create({id:id!,sessionId:session.id,kind:'message',anchor:{messageId:'answer'},snapshot:{text:'answer',at:'2026-01-01T00:00:00.000Z'}});
    }
    expect(marks.list({},1,true)).toMatchObject({total:1,marks:[{id:'a-visible'}]});
    expect(marks.list({},50,false).total).toBe(2);
    store.promoteTaskWorkspace(managed.id,'Saved');
    expect(marks.list({},50,true).total).toBe(2);
  }finally{store.close();}
});
