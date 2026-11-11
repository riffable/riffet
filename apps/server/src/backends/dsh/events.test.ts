import { describe, expect, it } from 'vitest';
import { dshSubagentChildId, projectDshEvent } from './events.js';

const options = { sessionId: 'wb-1' };
const call = (name: string, args: unknown) => ({ type: 'tool/call', seq: 253, time: 1, data: { callId: 'call-1', name, arguments: JSON.stringify(args) } });
const result = (text: string, isError = false) => ({ type: 'tool/result', seq: 259, time: 2, data: { message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text }], isError } } });

describe('DSH subagent projection', () => {
  it('renders a subagent call as an agent tool with its description', () => {
    const [event] = projectDshEvent(call('subagent', { description: 'Implement pairing', prompt: 'Do it', run_in_background: true }), options);
    expect(event?.data).toMatchObject({ toolCallId: 'call-1', kind: 'agent', title: 'Implement pairing', subagent: { description: 'Implement pairing', prompt: 'Do it', background: true } });
  });

  it('links a started continuable child by the id in the result text', () => {
    const [event] = projectDshEvent(result('started subagent 5a14df02-1238-4943-9262-ba6565ebbd04'), options);
    expect(event?.data).toMatchObject({ toolCallId: 'call-1', status: 'completed', subagentResult: { agentId: '5a14df02-1238-4943-9262-ba6565ebbd04' } });
  });

  it('does not link a one-shot job, a failure, or ordinary output', () => {
    expect(dshSubagentChildId('started background subagent job job-7')).toBeUndefined();
    expect(dshSubagentChildId('the child said: started subagent abc')).toBeUndefined();
    expect(dshSubagentChildId('started subagent ../escape')).toBeUndefined();
    const [failed] = projectDshEvent(result('started subagent abc', true), options);
    expect(failed?.data.subagentResult).toBeUndefined();
  });

  it('shows a read_image result by the path in its envelope, with what the reference knows', () => {
    const text = '<path>/repo/shot.png</path>\n<type>image</type>\n<content>Image read successfully</content>';
    const [event] = projectDshEvent({ type: 'tool/result', seq: 260, time: 3, data: { message: { role: 'tool', toolCallId: 'call-1', isError: false, content: [
      { type: 'text', text },
      { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 120000, width: 800, height: 600 } },
    ] } } }, options);
    expect(event?.data.content).toEqual([
      { type: 'content', content: { type: 'text', text } },
      { type: 'content', content: { type: 'image', path: '/repo/shot.png', bytes: 120000, width: 800, height: 600, mimeType: 'image/png' } },
    ]);
  });

  it('draws every attachment the store resolved, and names one it could not', () => {
    const [event] = projectDshEvent({ type: 'tool/result', seq: 261, time: 4, data: { message: { role: 'tool', toolCallId: 'call-1', isError: false, content: [
      { type: 'text', text: 'read 2 images' },
      { type: 'image', hostPath: '/home/me/.riffet/dsh/attachments/v1/objects/ab/cd', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 35375, width: 512, height: 512, name: 'icon-512.png' } },
      { type: 'image', attachment: { attachmentId: 'att-2', mediaType: 'image/jpeg', bytes: 200727, width: 820, height: 520, name: 'wk-hero.jpg' } },
    ] } } }, options);
    expect(event?.data.content).toEqual([
      { type: 'content', content: { type: 'text', text: 'read 2 images' } },
      { type: 'content', content: { type: 'image', path: '/home/me/.riffet/dsh/attachments/v1/objects/ab/cd', name: 'icon-512.png', bytes: 35375, width: 512, height: 512, mimeType: 'image/png' } },
      { type: 'content', content: { type: 'image', omitted: true, name: 'wk-hero.jpg', bytes: 200727, width: 820, height: 520, mimeType: 'image/jpeg' } },
    ]);
  });

  it('leaves other tools alone', () => {
    const [event] = projectDshEvent(call('bash', { command: 'ls' }), options);
    expect(event?.data).toMatchObject({ kind: 'execute', title: 'bash' });
    expect(event?.data.subagent).toBeUndefined();
  });
});

describe('DSH todo snapshots', () => {
  it('projects a persisted todo/write whole-list event as a plan snapshot', () => {
    // The native shape is from packages/todo/tool-todo: `todo_write` appends `todo/write` with the
    // complete validated list, including content and one of pending/in_progress/completed.
    const [event] = projectDshEvent({ type: 'todo/write', seq: 260, time: 3, data: { todos: [
      { content: 'read the code', status: 'completed' },
      { content: 'write the fix', status: 'in_progress' },
      { content: 'review the diff', status: 'pending' },
    ] } }, options);
    expect(event).toMatchObject({
      type: 'plan',
      nativeId: '260:todo/write:0',
      data: { sessionUpdate: 'plan', entries: [
        { content: 'read the code', status: 'completed' },
        { content: 'write the fix', status: 'in_progress' },
        { content: 'review the diff', status: 'pending' },
      ] },
    });
  });

  it('preserves an explicit empty snapshot and ignores invalid snapshots', () => {
    const [empty] = projectDshEvent({ type: 'todo/write', seq: 261, time: 4, data: { todos: [] } }, options);
    expect(empty?.data.entries).toEqual([]);
    expect(projectDshEvent({ type: 'todo/write', seq: 262, time: 5, data: { todos: [{ content: 'unknown status', status: 'started' }] } }, options)).toEqual([]);
    expect(projectDshEvent({ type: 'todo/write', seq: 263, time: 6, data: {} }, options)).toEqual([]);
  });
});

describe('DSH tool titles', () => {
  const data = (name: string, args: unknown) => {
    const [event] = projectDshEvent(call(name, args), options);
    return (event?.data ?? {}) as Record<string, unknown>;
  };

  it('names the file a read was pointed at', () => {
    // The regression this guards: the call arguments were carried in `rawInput` but never read, so
    // every read row in a DSH session rendered as the bare word "read".
    expect(data('read', { path: '/repo/src/app.ts', offset: 40 })).toMatchObject({
      kind: 'read',
      title: 'Read app.ts',
      locations: [{ path: '/repo/src/app.ts', line: 40 }],
    });
    expect(data('read', { file_path: '/repo/README.md' })).toMatchObject({ title: 'Read README.md' });
  });

  it('names the file an edit touched, and carries the diff', () => {
    expect(data('edit', { path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' })).toMatchObject({
      kind: 'edit',
      title: 'Edit app.ts',
      locations: [{ path: '/repo/src/app.ts' }],
      content: [{ type: 'diff', path: '/repo/src/app.ts', oldText: 'a', newText: 'b' }],
    });
    expect(data('write', { path: '/repo/new.ts', contents: 'hello' })).toMatchObject({
      title: 'Write new.ts',
      content: [{ type: 'diff', path: '/repo/new.ts', oldText: '', newText: 'hello' }],
    });
  });

  it('reads as the search it is', () => {
    expect(data('grep', { pattern: 'todo', path: '/repo' })).toMatchObject({ kind: 'search', title: 'grep todo' });
    expect(data('glob', { glob_pattern: '**/*.kt' })).toMatchObject({ kind: 'search', title: 'glob **/*.kt' });
  });

  it('keeps a tool it has no rule for at least named', () => {
    expect(data('mystery_tool', { path: '/repo/x' })).toMatchObject({ kind: 'other', title: 'mystery_tool' });
  });

  // The shapes below are copied verbatim from a real DSH session
  // (`…/sessions/--srv-…-riffet--/riffet-fe4b3ecce561060161d006fa5ad4c26a/session.v4.jsonl.zstd`)
  // rather than invented: `read` calls carry `file_path` (an absolute path) plus optional
  // `limit`/`offset`, `edit` calls carry `file_path`/`old_string`/`new_string`, and `write` calls
  // carry `file_path`/`content`. Note the write key: DSH says `content`, not Cursor's `contents`.
  it('names a real read call with an absolute file_path and an offset', () => {
    const file = '/Users/dev/workspace/riffet/apps/mobile/shared/src/commonMain/kotlin/riffet/ui/composer/Composer.kt';
    expect(data('read', { file_path: file, offset: 280, limit: 120 })).toMatchObject({
      kind: 'read',
      title: 'Read Composer.kt',
      locations: [{ path: file, line: 280 }],
    });
    // A whole-file read carries no offset, so the location has no line.
    expect(data('read', { file_path: file })).toMatchObject({
      kind: 'read',
      title: 'Read Composer.kt',
      locations: [{ path: file }],
    });
  });

  it('names a real edit call and carries its old/new strings as a diff', () => {
    const file = '/Users/dev/workspace/riffet/apps/mobile/shared/src/commonMain/kotlin/riffet/ui/icons/RiffetIcons.kt';
    expect(data('edit', { file_path: file, old_string: 'val PanelLeft', new_string: 'val Menu' })).toMatchObject({
      kind: 'edit',
      title: 'Edit RiffetIcons.kt',
      locations: [{ path: file }],
      content: [{ type: 'diff', path: file, oldText: 'val PanelLeft', newText: 'val Menu' }],
    });
  });

  it('names a real write call whose payload key is `content`', () => {
    expect(data('write', { file_path: '/repo/new.ts', content: 'hello' })).toMatchObject({
      kind: 'edit',
      title: 'Write new.ts',
      content: [{ type: 'diff', path: '/repo/new.ts', oldText: '', newText: 'hello' }],
    });
  });

  // A real edit result (`deepseek-harness/snapshots/web/changed-files-turn/session.v4.jsonl`): the
  // text is an acknowledgement, the change itself rides in `meta.diffs`.
  const editResult = (meta: unknown, isError = false) => ({ type: 'tool/result', seq: 259, time: 2, data: {
    message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'The file /repo/intro.md has been updated successfully.' }], isError },
    meta,
  } });

  it('carries the applied hunks of an edit result instead of its acknowledgement', () => {
    // The regression this guards: the result's text replaced the call's diff on the card, so a
    // finished DSH edit showed "has been updated successfully" and no diff at all.
    const [event] = projectDshEvent(editResult({ operation: 'update', diffs: [
      { path: 'intro.md', oldText: '# 示例项目\n\n一个用于演示的仓库。', newText: '# 项目说明\n\n一个用于演示的仓库。' },
      { path: 'intro.md', oldText: null, newText: 'appended' },
    ] }), options);
    expect(event?.data.content).toEqual([
      { type: 'diff', path: 'intro.md', oldText: '# 示例项目\n\n一个用于演示的仓库。', newText: '# 项目说明\n\n一个用于演示的仓库。' },
      { type: 'diff', path: 'intro.md', oldText: '', newText: 'appended' },
    ]);
  });

  it('leaves the call diff in place when a file change produced no hunk', () => {
    const [event] = projectDshEvent(editResult({ operation: 'create', diffs: [] }), options);
    expect(event?.data).toMatchObject({ status: 'completed' });
    expect(event?.data.content).toBeUndefined();
  });

  it('still shows why a failed edit failed', () => {
    const [event] = projectDshEvent(editResult({ diffs: [] }, true), options);
    expect(event?.data.content).toEqual([{ type: 'content', content: { type: 'text', text: 'The file /repo/intro.md has been updated successfully.' } }]);
  });

  it('degrades to the bare tool name when a call carries no arguments', () => {
    // No such record exists in the captured sessions (all 342 `tool/call` records carry non-empty,
    // well-formed JSON), so this only pins the fallback: an argument-less call must not throw or
    // invent a path, and the row reads as the verb alone rather than "undefined".
    for (const argumentsValue of ['', '{}']) {
      const [event] = projectDshEvent(
        { type: 'tool/call', seq: 253, time: 1, data: { callId: 'call-1', name: 'read', arguments: argumentsValue } },
        options,
      );
      expect(event?.data).toMatchObject({ kind: 'read', title: 'Read', rawInput: argumentsValue === '' ? '' : {} });
      expect(event?.data.locations).toBeUndefined();
    }
  });
});

describe('DSH goal tools', () => {
  const data = (name: string, args: unknown) => {
    const [event] = projectDshEvent(call(name, args), options);
    return (event?.data ?? {}) as Record<string, unknown>;
  };

  it('carries the objective a create_goal set', () => {
    // The dock above the composer reads this: the goal lives on the harness side, so the call is the
    // only place a client can learn it from.
    expect(data('create_goal', { objective: '把移动端的测试跑绿', max_goal_rounds: 12 })).toMatchObject({
      kind: 'goal',
      title: '把移动端的测试跑绿',
      rawInput: { objective: '把移动端的测试跑绿', max_goal_rounds: 12 },
    });
  });

  it('names the transition when the call carries no objective', () => {
    expect(data('update_goal', { action: 'complete', goal_id: 'goal-1', revision: 2 })).toMatchObject({
      kind: 'goal',
      title: '已完成',
    });
    expect(data('get_goal', {})).toMatchObject({ kind: 'goal', title: '目标' });
  });
});
