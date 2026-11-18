import { describe, expect, it } from 'vitest';
import type { NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { toolFoldedDetail } from '../../../../../packages/timeline/src/findText.js';
import { toolDataKind, toolTitleOf } from '../../../../../packages/timeline/src/toolTitle.js';
import { projectCompletedTool, projectStartedTool, projectToolItem } from './transcript.js';
import type { RpcItem } from './types.js';

const createdAt = '2026-10-15T00:00:00Z';
const event = (nativeId: string, type: string, data: Record<string, unknown>): NativeWorkbenchEvent => ({
  sequence: 0, sessionId: 'session', nativeId, type, data, createdAt,
});
const commandItem = (extra: Record<string, unknown> = {}): RpcItem => ({
  type: 'commandExecution', id: 'command', command: '/bin/zsh', cwd: '/repo',
  status: 'completed', aggregatedOutput: 'complete output\n', exitCode: 0, ...extra,
});
const project = (item: RpcItem) => projectToolItem(item, event, 'thread:turn:command');

describe('Codex command action projection', () => {
  it('renders standard parsed reads as files and preserves the full command and output', () => {
    const payload = "sed -n '1,160p' /repo/SKILL.md";
    const item = commandItem({ commandActions: [{ type: 'read', command: payload, name: 'SKILL.md', path: '/repo/SKILL.md' }] });
    const [call, result] = project(item);
    expect(call?.data).toMatchObject({
      toolName: 'Read', kind: 'read', title: 'Read /repo/SKILL.md',
      locations: [{ path: '/repo/SKILL.md' }], rawInput: { command: payload, originalCommand: '/bin/zsh', cwd: '/repo' },
    });
    expect(result?.data).toMatchObject({
      status: 'completed', exitCode: 0, content: [{ type: 'content', content: { type: 'text', text: 'complete output\n' } }],
    });
  });

  it('shows a search query and path supplied by Codex', () => {
    const [call] = project(commandItem({ commandActions: [{ type: 'search', command: 'rg Transcript apps', query: 'Transcript', path: 'apps' }] }));
    expect(call?.data).toMatchObject({
      kind: 'search', title: 'Search Transcript in apps', locations: [{ path: 'apps' }], rawInput: { command: 'rg Transcript apps' },
    });
  });

  it('shows listing files separately from a query search, including a null path', () => {
    expect(project(commandItem({ commandActions: [{ type: 'listFiles', command: 'ls apps', path: 'apps' }] }))[0]?.data)
      .toMatchObject({ kind: 'search', title: 'List files apps', locations: [{ path: 'apps' }] });
    const [call] = project(commandItem({ commandActions: [{ type: 'listFiles', command: 'ls', path: null }] }));
    expect(call?.data).toMatchObject({ kind: 'search', title: 'List files', rawInput: { command: 'ls' } });
    expect(call?.data).not.toHaveProperty('locations');
  });

  it.each(['-c', '-lc', '-cl'])('unwraps provider shell argv with %s without interpreting its payload', flag => {
    const payload = "printf '%s\\n' 'a b'\ncat <<'EOF'\n/bin/zsh -lc text\nEOF";
    const wrapper = `/bin/zsh ${flag} <display text>`;
    const [call] = project(commandItem({ command: wrapper, commandActions: [{
      type: 'unknown', command: wrapper, input: { type: 'shell', command: ['/bin/zsh', flag, payload] },
    }] }));
    expect(call?.data).toMatchObject({ kind: 'execute', title: payload, rawInput: { command: payload, originalCommand: wrapper } });
  });

  it('uses an already unpacked unknown action command when shell argv is absent', () => {
    expect(project(commandItem({ commandActions: [{ type: 'unknown', command: 'npm test -- --run' }] }))[0]?.data)
      .toMatchObject({ kind: 'execute', title: 'npm test -- --run', rawInput: { command: 'npm test -- --run' } });
  });

  it('does not reinterpret unknown printable shell syntax or script arguments', () => {
    const command = "/bin/zsh -lc 'echo unknown'";
    const [call] = project(commandItem({ command, commandActions: [{
      type: 'unknown', command, input: { type: 'shell', command: ['/bin/zsh', 'script.zsh', '-c', 'not a payload'] },
    }] }));
    expect(call?.data).toMatchObject({ kind: 'execute', title: command, rawInput: { command } });
    expect(call?.data.rawInput).not.toHaveProperty('originalCommand');
    expect(project(commandItem({ command }))[0]?.data).toMatchObject({ kind: 'execute', title: command, rawInput: { command } });
  });

  it('includes every file in a multi-read command rather than only its first action', () => {
    const payload = 'cat /repo/SKILL.md /repo/README.md';
    const [call] = project(commandItem({ command: payload, commandActions: [
      { type: 'read', command: payload, name: 'SKILL.md', path: '/repo/SKILL.md' },
      { type: 'read', command: payload, name: 'README.md', path: '/repo/README.md' },
    ] }));
    expect(call?.data).toMatchObject({
      kind: 'read', title: 'Read SKILL.md, README.md',
      locations: [{ path: '/repo/SKILL.md' }, { path: '/repo/README.md' }], rawInput: { command: payload },
    });
  });

  it('deduplicates repeated reads of one file and disambiguates colliding basenames', () => {
    const sameFile = project(commandItem({ commandActions: [
      { type: 'read', command: "sed -n '1,50p' /repo/app.ts", path: '/repo/app.ts' },
      { type: 'read', command: "sed -n '51,100p' /repo/app.ts", path: '/repo/app.ts' },
      { type: 'read', command: "sed -n '101,150p' /repo/app.ts", path: '/repo/app.ts' },
      { type: 'read', command: "sed -n '151,200p' /repo/app.ts", path: '/repo/app.ts' },
    ] }));
    expect(sameFile[0]?.data).toMatchObject({
      kind: 'read', title: 'Read /repo/app.ts', locations: [{ path: '/repo/app.ts' }],
    });
    const colliding = project(commandItem({ commandActions: [
      { type: 'read', command: 'cat claude/index.ts', path: 'apps/server/src/backends/claude/index.ts' },
      { type: 'read', command: 'cat codex/index.ts', path: 'apps/server/src/backends/codex/index.ts' },
    ] }));
    expect(colliding[0]?.data).toMatchObject({
      kind: 'read', title: 'Read claude/index.ts, codex/index.ts',
    });
    const pureExplore = project(commandItem({ commandActions: [
      { type: 'search', command: 'rg getRun run.ts', query: 'getRun', path: 'packages/contracts/src/run.ts' },
      { type: 'search', command: 'rg BUDGET index.ts', query: 'BUDGET', path: 'packages/contracts/src/index.ts' },
      { type: 'read', command: 'cat docs/ASSISTANT.md', path: 'docs/ASSISTANT.md' },
    ] }));
    expect(pureExplore[0]?.data).toMatchObject({
      kind: 'search', title: 'Search getRun in run.ts, BUDGET in index.ts · Read ASSISTANT.md',
    });
    const heredoc = "python3 - <<'PY'\nfrom pathlib import Path\ndef edit(path, a, b):\n  pass\nPY";
    expect(toolTitleOf({ title: heredoc, rawInput: { command: heredoc } }, 'Tool')).toEqual({
      title: "python3 - <<'PY'", command: heredoc,
    });
    expect(toolFoldedDetail("python3 - <<'PY'", heredoc, undefined, [
      { type: 'diff', path: '/repo/CHANGELOG.md' },
      { type: 'diff', path: '/repo/CHANGELOG.zh-CN.md' },
    ], '/repo')).toBe('CHANGELOG.md, CHANGELOG.zh-CN.md');
    expect(toolDataKind({ kind: 'other', rawInput: pureExplore[0]!.data.rawInput })).toBe('search');
    const noMatchSearch = project(commandItem({
      status: 'failed', exitCode: 1,
      commandActions: [{ type: 'search', command: 'rg missing apps', query: 'missing', path: 'apps' }],
    }));
    expect(noMatchSearch[1]?.data).toMatchObject({ status: 'completed', exitCode: 1 });
  });

  it('summarizes mixed actions while retaining the complete shell payload and all locations', () => {
    const payload = 'cat SKILL.md && rg Transcript apps; ls docs; npm test';
    const input = { type: 'shell', command: ['/bin/zsh', '-lc', payload] };
    const actions = [
      { type: 'read', command: 'cat SKILL.md', name: 'SKILL.md', path: 'SKILL.md', input },
      { type: 'search', command: 'rg Transcript apps', query: 'Transcript', path: 'apps', input },
      { type: 'listFiles', command: 'ls docs', path: 'docs', input },
      { type: 'unknown', command: 'npm test', input },
    ];
    const [call] = project(commandItem({ commandActions: actions }));
    expect(call?.data).toMatchObject({
      kind: 'other', title: '1 file read · 1 search · 1 file listing · 1 command',
      locations: [{ path: 'SKILL.md' }, { path: 'apps' }, { path: 'docs' }],
      rawInput: { command: payload, originalCommand: '/bin/zsh', commandActions: actions },
    });
  });

  it('does not invent a compound command from distinct parsed segments', () => {
    const command = "cat README.md | rg 'line'";
    const [call] = project(commandItem({ command, commandActions: [
      { type: 'read', command: 'cat README.md', path: 'README.md' },
      { type: 'unknown', command: "rg 'line'" },
    ] }));
    expect(call?.data).toMatchObject({ kind: 'other', title: 'Read README.md · Run command', rawInput: { command } });
  });

  it('keeps TRAE built-in argument semantics in both live and shell-shaped history actions', () => {
    const action = { type: 'read', command: 'Read', name: 'README.md', path: '/repo/README.md' };
    const live = project(commandItem({ command: 'Read', commandActions: [{ ...action,
      input: { type: 'builtin', name: 'Read', arguments: { file_path: '/repo/README.md', limit: 3 } },
    }] }));
    expect(live[0]?.data).toMatchObject({ kind: 'read', title: 'Read /repo/README.md', rawInput: { file_path: '/repo/README.md', limit: 3 } });
    expect(live[0]?.data.rawInput).not.toHaveProperty('command');
    const history = project(commandItem({ command: 'Read', commandActions: [{ ...action, input: { type: 'shell', command: ['Read'] } }] }));
    expect(history[0]?.data).toMatchObject({ kind: 'read', rawInput: { file_path: '/repo/README.md' } });
    expect(history[1]?.data).toHaveProperty('exitCode', 0);
  });

  it('uses the same projection for started/completed events and failed history items', () => {
    const item = commandItem({ status: 'failed', exitCode: 2, aggregatedOutput: 'full failure\n', commandActions: [{
      type: 'search', command: 'rg bad apps', query: 'bad', path: 'apps',
    }] });
    const history = project(item);
    const started = projectStartedTool(item, 'session', 'thread', 'turn', undefined, createdAt);
    const completed = projectCompletedTool(item, 'session', 'thread', 'turn', undefined, createdAt);
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(started[0]?.data).toMatchObject(history[0]!.data);
    expect(completed[0]?.data).toMatchObject(history[1]!.data);
    expect(started[0]?.raw).toEqual(item);
    expect(completed[0]?.data).toMatchObject({ status: 'failed', exitCode: 2,
      content: [{ type: 'content', content: { type: 'text', text: 'full failure\n' } }],
    });
  });

  it('corrects an initial shell header when parsed actions arrive only on completion', () => {
    const initial = commandItem({ status: 'inProgress' });
    const finished = commandItem({ commandActions: [{ type: 'read', command: 'cat README.md', name: 'README.md', path: '/repo/README.md' }] });
    const [started] = projectStartedTool(initial, 'session', 'thread', 'turn', undefined, createdAt);
    const [completed] = projectCompletedTool(finished, 'session', 'thread', 'turn', undefined, createdAt);
    expect(started?.data).toMatchObject({ kind: 'execute', title: '/bin/zsh' });
    expect(completed?.type).toBe('tool_call_update');
    expect(completed?.data).toMatchObject({
      toolCallId: 'command', kind: 'read', title: 'Read /repo/README.md', status: 'completed',
      locations: [{ path: '/repo/README.md' }], rawInput: { command: 'cat README.md', originalCommand: '/bin/zsh' },
    });
  });
});

describe('Codex tool item projection', () => {
  it('places each diff hunk at its own start line', () => {
    const diff = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -3,2 +3,2 @@', ' keep', '-old', '+new', '@@ -40,1 +42,2 @@', ' tail', '+--- added', '\\ No newline at end of file', ''].join('\n');
    const [, result] = project({ type: 'fileChange', id: 'edit', status: 'completed', changes: [{ path: '/repo/src/a.ts', diff }] });
    expect(result?.data.content).toEqual([
      { type: 'diff', path: '/repo/src/a.ts', oldText: 'keep\nold', newText: 'keep\nnew', lineOffset: 2 },
      { type: 'diff', path: '/repo/src/a.ts', oldText: 'tail', newText: 'tail\n--- added', lineOffset: 39, newLineOffset: 41 },
    ]);
    const [, added] = project({ type: 'fileChange', id: 'add', status: 'completed', changes: [{ path: '/repo/new.ts', kind: { type: 'add' }, diff: 'import x\n-flag\n export y' }] });
    expect(added?.data.content).toEqual([{ type: 'diff', path: '/repo/new.ts', oldText: '', newText: 'import x\n-flag\n export y' }]);
    const [, prefixed] = project({ type: 'fileChange', id: 'add2', status: 'completed', changes: [{ path: '/repo/new.ts', kind: 'add', diff: '+one\n+two' }] });
    expect(prefixed?.data.content).toEqual([{ type: 'diff', path: '/repo/new.ts', oldText: '', newText: 'one\ntwo' }]);
  });

  it('keeps a web search query as its input and title', () => {
    const [call] = project({ type: 'webSearch', id: 'search', status: 'inProgress', query: '', action: { type: 'search', queries: ['codex app server'] } });
    expect(call?.data).toMatchObject({ toolName: 'Web search', kind: 'fetch', title: 'codex app server', rawInput: { query: 'codex app server' } });
  });
});
