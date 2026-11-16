import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeWorkbenchEvent, Session } from '../../../../../packages/contracts/src/index.js';
import { ActivityLedger, activityOfEvent } from '../../journal/activity.js';
import { projectEvents } from '../../../../../packages/timeline/src/projectEvents.js';
import { ClaudeActivities } from './activity.js';
import { ClaudeSubagentDiscovery } from './subagents.js';
import { JournalLaneWriter, pullLane, turnMetaId } from '../../journal/ingest.js';
import { assertUnchanged, checkSession, rowsOf, runIngestContract, snapshot, visibleLanes, type IngestContractFixture } from '../../journal/ingest-contract.js';
import { Journal, laneKey } from '../../journal/journal.js';
import { ClaudeTranscript } from './history.js';
import { activeTurnOf, initialState, phaseOf, reduce } from './session-state.js';
import { ClaudeTranscriptChanges, ClaudeTranscriptSource } from './transcript-source.js';

/** A Claude Code session file as the CLI writes it, with its subagents beside it in `<id>/subagents/`. */
class SessionFile {
  private clock = 0;
  constructor(readonly dir: string, readonly id: string) { writeFileSync(this.path, ''); }
  get path(): string { return join(this.dir, `${this.id}.jsonl`); }
  private at(): string { return new Date(Date.UTC(2026, 9, 20) + (this.clock += 1) * 1000).toISOString(); }

  write(...rows: Array<Record<string, unknown>>): this {
    appendFileSync(this.path, rows.map(row => `${JSON.stringify({ isSidechain: false, sessionId: this.id, timestamp: this.at(), ...row })}\n`).join(''));
    return this;
  }

  prompt(id: string, text = `question ${id}`, fields: Record<string, unknown> = {}): this {
    return this.write({ type: 'user', uuid: `u-${id}`, promptId: `p-${id}`, origin: { kind: 'human' }, message: { role: 'user', content: text }, ...fields });
  }

  call(id: string, name: string, input: Record<string, unknown>): this {
    return this.write({ type: 'assistant', uuid: `c-${id}`, message: { id: `m-c-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } });
  }

  result(id: string, content: string, toolUseResult: Record<string, unknown> = {}, error = false): this {
    return this.write({ type: 'user', uuid: `r-${id}`, toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(error ? { is_error: true } : {}) }] } });
  }

  answer(id: string): this {
    return this.write({ type: 'assistant', uuid: `a-${id}`, message: { id: `m-a-${id}`, role: 'assistant', content: [{ type: 'thinking', thinking: 'so' }, { type: 'text', text: `answer ${id}` }], stop_reason: 'end_turn' } });
  }

  duration(id: string): this { return this.write({ type: 'system', subtype: 'turn_duration', uuid: `d-${id}`, durationMs: 1000 }); }

  /** Claude's own request record: big, and nothing a transcript shows. */
  request(bytes: number): this { return this.write({ type: 'api-request', id: `req-${this.clock}`, body: 'x'.repeat(bytes) }); }

  turn(id: string, work: (file: this) => void = () => undefined): this {
    this.prompt(id);
    work(this);
    return this.answer(id).duration(id);
  }

  subagent(toolUseId: string, agentId: string): this {
    const root = join(this.dir, this.id, 'subagents');
    mkdirSync(root, { recursive: true });
    const row = (uuid: string, type: string, message: Record<string, unknown>) => JSON.stringify({ type, uuid, isSidechain: true, agentId, sessionId: this.id, timestamp: this.at(), message });
    writeFileSync(join(root, `agent-${agentId}.jsonl`), [
      row(`${agentId}-u`, 'user', { role: 'user', content: 'Look around' }),
      row(`${agentId}-c`, 'assistant', { id: `${agentId}-m1`, role: 'assistant', content: [{ type: 'tool_use', id: `${agentId}-read`, name: 'Read', input: { file_path: '/repo/a.ts' } }], stop_reason: 'tool_use' }),
      row(`${agentId}-r`, 'user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${agentId}-read`, content: 'file' }] }),
      row(`${agentId}-a`, 'assistant', { id: `${agentId}-m2`, role: 'assistant', content: [{ type: 'text', text: 'found it' }], stop_reason: 'end_turn' }),
    ].join('\n') + '\n');
    writeFileSync(join(root, `agent-${agentId}.meta.json`), JSON.stringify({ toolUseId, agentType: 'Explore', description: 'Explore' }));
    return this.call(toolUseId, 'Agent', { description: 'Explore', prompt: 'Look around', subagent_type: 'Explore' }).result(toolUseId, 'found it');
  }
}

const OUTPUT = '/private/tmp/claude-501/-repo/sess/tasks/bsh1.output';
const notice = (fields: string) => `<task-notification>\n${fields}\n</task-notification>`;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** What the live view's mapping of the same files shows (`ClaudeTranscript`): each entity once, where it first appears. */
async function historyOrder(file: SessionFile): Promise<Record<string, string[]>> {
  const transcript = new ClaudeTranscript({ id: 'wb', nativeSessionId: file.id, updatedAt: '' } as Session, file.id);
  await transcript.setFile(file.path);
  const ids = (events: NativeWorkbenchEvent[]) => [...new Set(events.filter(event => event.type !== 'run_completed' && event.type !== 'run_cancelled').map(event => event.nativeId))];
  return Object.fromEntries([['main', ids(transcript.allEvents())], ...transcript.subagentFrames().map(frame => [`sub:${frame.toolCallId}`, ids(frame.events)])]);
}

function scenario() {
  const dir = mkdtempSync(join(tmpdir(), 'riffet-claude-transcript-'));
  dirs.push(dir);
  const changes = new ClaudeTranscriptChanges();
  let main = new SessionFile(dir, '11111111-2222-4333-8444-555555555555');
  const source = () => new ClaudeTranscriptSource({
    sessionId: 'wb', nativeSessionId: () => main.id, locate: async id => id === main.id ? main.path : undefined, watch: wake => changes.on('wb', wake),
  });
  main
    .turn('t1', file => file.call('bash1', 'Bash', { command: 'ls', description: 'List files' }).result('bash1', 'a.ts'))
    .turn('plan', file => file
      .call('tc1', 'TaskCreate', { subject: 'Read notes' }).result('tc1', 'Task #1 created successfully: Read notes', { task: { id: '1', subject: 'Read notes' } })
      .call('tu1', 'TaskUpdate', { taskId: '1', status: 'in_progress' }).result('tu1', 'Updated task #1 status', { success: true, taskId: '1', statusChange: { from: 'pending', to: 'in_progress' } }))
    // A background command keeps running after its turn; its report comes later (`update`).
    .turn('bg', file => file.call('bsh', 'Bash', { command: 'make test', description: 'run tests', run_in_background: true })
      .result('bsh', `Command running in background with ID: bsh1. Output is being written to: ${OUTPUT}`, { backgroundTaskId: 'bsh1' }))
    // `/compact`: one bubble, a compaction that ends at its boundary, the summary and output folded into it.
    .prompt('compact', '/compact')
    .write({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', compactMetadata: { trigger: 'manual', preTokens: 36965, postTokens: 1778, durationMs: 6000 } })
    .write({ type: 'user', uuid: 'sum', promptId: 'p-compact', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation.' } })
    .write({ type: 'user', uuid: 'cmd', promptId: 'p-cmd', message: { role: 'user', content: '<command-name>/compact</command-name>\n <command-message>compact</command-message>\n <command-args></command-args>' } })
    .write({ type: 'user', uuid: 'out', promptId: 'p-compact', message: { role: 'user', content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' } })
    // 2.1.322 writes the boundary and summary before the command, without a preceding bare `/compact`, and dims its output.
    .write({ type: 'system', subtype: 'compact_boundary', uuid: 'b-late', compactMetadata: { trigger: 'manual' } })
    .write({ type: 'user', uuid: 'sum-late', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued after another compaction.' } })
    .write({ type: 'user', uuid: 'cmd-late', promptId: 'p-compact-late', message: { role: 'user', content: '<command-name>/compact</command-name>\n <command-message>compact</command-message>\n <command-args></command-args>' } })
    .write({ type: 'user', uuid: 'out-late', promptId: 'p-compact-late', message: { role: 'user', content: '<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m\n\u001b[2mPreCompact [\'node\' \'hook-cli.mjs\'] completed successfully\u001b[22m</local-command-stdout>' } })
    // A local command ends with its output; a Monitor's queued event is one more state of its activity.
    .write({ type: 'user', uuid: 'cost', promptId: 'p-cost', message: { role: 'user', content: '<command-name>/cost</command-name>\n <command-message>cost</command-message>\n <command-args></command-args>' } })
    .write({ type: 'user', uuid: 'cost-out', promptId: 'p-cost', message: { role: 'user', content: '<local-command-stdout>Total cost: $0.12</local-command-stdout>' } })
    .turn('mon', file => file.call('mon', 'Monitor', { command: 'tail -f log', description: 'watch log' }).result('mon', 'ok', { taskId: 'bmon1' })
      .write({ type: 'queue-operation', operation: 'enqueue', content: notice('<task-id>bmon1</task-id>\n<summary>Monitor event: "watch log"</summary>\n<event>line 1</event>') }))
    // An older CLI writes no end for a turn: the next prompt ends it.
    .prompt('old').answer('old')
    .turn('agent', file => file.subagent('tool-a1', 'agent-1'));
  // Past one pull, and mostly records no row shows, so the first import serves a tail window meanwhile.
  for (let index = 0; index < 10; index += 1) {
    main.request(300 * 1024).turn(`big${index}`, file => file.call(`read${index}`, 'Read', { file_path: `/repo/big${index}` }).result(`read${index}`, 'x'.repeat(450 * 1024)));
  }
  // The CLI is in the middle of writing a line.
  appendFileSync(main.path, '{"type":"assistant","uuid":"a-torn","mess');

  let order: Record<string, string[]> = {};
  const settle = async () => { order = await historyOrder(main); changes.emit('wb'); };
  let appended = 0;
  const fixture: IngestContractFixture = {
    scratch: true,
    source,
    order: () => order,
    append: async () => {
      appended += 1;
      if (appended === 1) appendFileSync(main.path, 'age":{"id":"m-torn","role":"assistant","content":[{"type":"text","text":"late"}],"stop_reason":"end_turn"}}\n');
      main.turn(`more${appended}`);
      await settle();
    },
    // The background command reports: its activity, read already, gets a new state.
    update: async () => {
      main.write({ type: 'user', uuid: 'n-bsh1', promptId: 'p-n', origin: { kind: 'task-notification' }, message: { role: 'user', content: notice(`<task-id>bsh1</task-id>\n<tool-use-id>bsh</tool-use-id>\n<output-file>${OUTPUT}</output-file>\n<status>failed</status>\n<summary>Background command "run tests" failed with exit code 2</summary>`) } })
        .answer('n').duration('n');
      await settle();
    },
    // Typed into the terminal and stopped there: the CLI's marker ends it.
    terminalTurn: async () => {
      main.prompt('typed').call('bash2', 'Bash', { command: 'sleep 100' }).result('bash2', "The user doesn't want to proceed with this tool use.", {}, true)
        .write({ type: 'user', uuid: 'stop', promptId: 'p-typed', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
      await settle();
    },
    subagent: async () => { main.turn('t-sub', file => file.subagent('tool-a2', 'agent-2')); await settle(); },
    changeIdentity: async () => { main = new SessionFile(dir, '99999999-2222-4333-8444-555555555555').turn('n1'); await settle(); },
  };
  return { fixture, settle, file: () => main, source, dir };
}

async function importAll(source: ClaudeTranscriptSource, journal: Journal): Promise<JournalLaneWriter> {
  const writer = JournalLaneWriter.open(journal, 'wb');
  for (let pulls = 0; !(await pullLane(source, writer, new AbortController().signal)).caughtUp; pulls += 1) expect(pulls).toBeLessThan(20);
  return writer;
}

describe('Claude transcript source', () => {
  it.each(['running', 'finished', 'stopped'] as const)('recovers a %s fork beyond an old cursor without reopening finished work or duplicating lanes', async (outcome) => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-claude-fork-recovery-'));
    dirs.push(dir);
    const file = new SessionFile(dir, 'fork-session');
    const root = join(dir, file.id, 'subagents');
    mkdirSync(root, { recursive: true });
    const metaPath = join(root, 'agent-review.meta.json');
    writeFileSync(metaPath, JSON.stringify({ agentType: 'general-purpose', description: '/code-review high' }));
    writeFileSync(join(root, 'agent-review.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'review-u', isSidechain: true, agentId: 'review', timestamp: '2026-10-20T00:00:04.000Z', message: { role: 'user', content: 'Review' } })}\n`);
    file.turn('review', file => file.call('skill', 'Skill', { skill: 'code-review', args: 'high' })
      .result('skill', 'Launched', { success: true, status: 'forked', background: true, commandName: 'code-review', agentId: 'review' }));
    file.turn('later', file => {
      if (outcome === 'stopped') file.call('stop', 'TaskStop', { task_id: 'review' }).result('stop', 'Stopped', { task_id: 'review' });
    });
    const journal = new Journal(new DatabaseSync(':memory:'));
    const source = () => new ClaudeTranscriptSource({ sessionId: 'wb', nativeSessionId: () => file.id, locate: async () => file.path });
    // The previous adapter consumed these bytes but understood neither the activity nor the binding.
    const launched = vi.spyOn(ClaudeActivities.prototype, 'launched').mockReturnValue([]);
    const discover = vi.spyOn(ClaudeSubagentDiscovery.prototype, 'read').mockResolvedValue([]);
    let writer: JournalLaneWriter;
    try { writer = await importAll(source(), journal); } finally { launched.mockRestore(); discover.mockRestore(); }
    const before = journal.head('wb'), oldCursor = JSON.parse(writer!.cursor!);
    if (outcome === 'finished') writeFileSync(metaPath, JSON.stringify({ agentType: 'general-purpose', description: '/code-review high', finished: true }));
    expect(writer!.subagents).toEqual([]);

    const committed = snapshot(journal, 'wb');
    const commit = writer!.commit.bind(writer!);
    const failure = vi.spyOn(writer!, 'commit').mockImplementationOnce(batch => { commit(batch); throw new Error('fork recovery fault'); });
    const recovering = source();
    try { await expect(recovering.pull(writer!, new AbortController().signal)).rejects.toThrow('fork recovery fault'); }
    finally { failure.mockRestore(); }
    assertUnchanged(committed, snapshot(journal, 'wb'), 'failed fork recovery');
    expect(writer!.activities.get('claude:review')).toBeUndefined();
    // Retry on the very same writer, not a new writer whose empty memory would hide the bug.
    while (!(await pullLane(recovering, writer!, new AbortController().signal)).caughtUp) { /* drain */ }
    expect(writer.subagents).toEqual([{ toolCallId: 'skill', agentId: 'review', title: '/code-review high', subagentType: 'general-purpose' }]);
    expect(activityOfEvent(journal.entity('wb', 'claude:review')?.payload)).toMatchObject({ status: outcome === 'finished' ? 'completed' : outcome === 'stopped' ? 'stopped' : 'running', toolCallId: 'skill', task: { kind: 'agent' } });
    expect(journal.entity('wb', 'claude:review')?.turnId).toBe('p-review');
    expect(journal.head('wb').generation).toBe(before.generation);
    expect(JSON.parse(writer.cursor!)).toMatchObject({ f: oldCursor.f, o: oldCursor.o, s: { t: oldCursor.s.t } });
    const recovered = snapshot(journal, 'wb');
    await importAll(source(), journal);
    assertUnchanged(recovered, snapshot(journal, 'wb'), 'fork recovery after a restart');

    writeFileSync(metaPath, JSON.stringify({ agentType: 'general-purpose', description: '/code-review high', finished: true }));
    writer = await importAll(source(), journal);
    expect(activityOfEvent(journal.entity('wb', 'claude:review')?.payload)?.status).toBe(outcome === 'stopped' ? 'stopped' : 'completed');
    expect(rowsOf(journal, laneKey('wb', 'sub:skill')).find(row => row.kind === 'meta.turn_ended')?.payload).toMatchObject({ status: 'completed' });
    expect(writer.activities.live()).toEqual([]);
    const settled = snapshot(journal, 'wb');
    await importAll(source(), journal);
    assertUnchanged(settled, snapshot(journal, 'wb'), 'finished fork after a restart');
    checkSession(journal, 'wb');
  });

  it('discovers nested forks after a split result arrives and keeps them in their actual parent lane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-claude-nested-fork-'));
    dirs.push(dir);
    const file = new SessionFile(dir, 'nested-session').turn('parent', file => file.subagent('parent-call', 'parent'));
    const root = join(dir, file.id, 'subagents');
    writeFileSync(join(root, 'agent-review.meta.json'), JSON.stringify({ parentAgentId: 'parent', description: '/code-review high' }));
    const parent = join(root, 'agent-parent.jsonl');
    appendFileSync(parent, `${JSON.stringify({ type: 'assistant', uuid: 'nested-call', isSidechain: true, agentId: 'parent', timestamp: '2026-10-20T00:00:10.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'nested-skill', name: 'Skill', input: { skill: 'code-review' } }], stop_reason: 'tool_use' } })}\n`);
    const result = JSON.stringify({ type: 'user', uuid: 'nested-result', isSidechain: true, agentId: 'parent', timestamp: '2026-10-20T00:00:11.000Z',
      toolUseResult: { success: true, status: 'forked', background: true, agentId: 'review', commandName: 'code-review' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'nested-skill', content: 'Launched' }] } });
    appendFileSync(parent, result.slice(0, 90));
    const source = new ClaudeTranscriptSource({ sessionId: 'wb', nativeSessionId: () => file.id, locate: async () => file.path });
    const journal = new Journal(new DatabaseSync(':memory:'));
    await importAll(source, journal);
    expect(journal.entity(laneKey('wb', 'sub:parent-call'), 'meta:subagent:nested-skill')).toBeUndefined();
    appendFileSync(parent, `${result.slice(90)}\n`);
    await importAll(source, journal);
    expect(journal.entity('wb', 'meta:subagent:nested-skill')).toBeUndefined();
    expect(journal.entity(laneKey('wb', 'sub:parent-call'), 'meta:subagent:nested-skill')?.payload).toMatchObject({ agentId: 'review', lane: 'sub:nested-skill' });
    // The child file itself can arrive later than both metadata and the result.
    writeFileSync(join(root, 'agent-review.jsonl'), `${JSON.stringify({ type: 'assistant', uuid: 'review-answer', isSidechain: true, agentId: 'review', timestamp: '2026-10-20T00:00:12.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Reviewed' }], stop_reason: 'end_turn' } })}\n`);
    await importAll(source, journal);
    expect(rowsOf(journal, laneKey('wb', 'sub:nested-skill')).some(row => row.kind === 'agent_message_chunk')).toBe(true);
    const held = snapshot(journal, 'wb');
    await importAll(new ClaudeTranscriptSource({ sessionId: 'wb', nativeSessionId: () => file.id, locate: async () => file.path }), journal);
    assertUnchanged(held, snapshot(journal, 'wb'), 'nested fork restart');
  });

  it('binds a fork to its issuing turn after a multi-pull import reaches the launch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-claude-fork-import-'));
    dirs.push(dir);
    const file = new SessionFile(dir, 'large-session').turn('old');
    for (let i = 0; i < 5; i += 1) file.request(1024 * 1024);
    file.turn('review', file => file.call('skill', 'Skill', { skill: 'code-review' })
      .result('skill', 'Launched', { success: true, status: 'forked', background: true, agentId: 'review' }));
    file.turn('last');
    for (let i = 0; i < 5; i += 1) file.request(1024 * 1024);
    const root = join(dir, file.id, 'subagents');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'agent-review.meta.json'), JSON.stringify({ description: '/code-review' }));
    const journal = new Journal(new DatabaseSync(':memory:'));
    await importAll(new ClaudeTranscriptSource({ sessionId: 'wb', nativeSessionId: () => file.id, locate: async () => file.path }), journal);
    expect(journal.entity('wb', 'meta:subagent:skill')?.turnId).toBe('p-review');
  });

  it.each(['rewrite', 'conflict'] as const)('retracts a fork after a confirmed %s, preserving it across incomplete evidence', async (change) => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-claude-fork-invalid-'));
    dirs.push(dir);
    const file = new SessionFile(dir, 'invalid-session').prompt('main');
    const launch = (call: string) => file.call(call, 'Skill', { skill: 'code-review' })
      .result(call, 'Launched', { success: true, status: 'forked', background: true, agentId: 'review' });
    launch('first');
    const root = join(dir, file.id, 'subagents');
    mkdirSync(root, { recursive: true });
    const meta = join(root, 'agent-review.meta.json');
    writeFileSync(meta, JSON.stringify({ description: '/code-review' }));
    writeFileSync(join(root, 'agent-review.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'review-u', agentId: 'review', isSidechain: true, timestamp: '2026-10-20T00:00:01.000Z', message: { role: 'user', content: 'Review' } })}\n`);
    const source = () => new ClaudeTranscriptSource({ sessionId: 'wb', nativeSessionId: () => file.id, locate: async () => file.path });
    const journal = new Journal(new DatabaseSync(':memory:'));
    const live = new ClaudeTranscript({ id: 'wb', nativeSessionId: file.id, updatedAt: '' } as Session, file.id);
    await live.setFile(file.path);
    await importAll(source(), journal);
    let time = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => time);
    const refresh = async () => { time += 1100; await live.refresh(); return importAll(source(), journal); };
    try {
      writeFileSync(meta, '{');
      let writer = await refresh();
      expect(writer.subagents).toHaveLength(1);
      expect(live.subagentFrames()).toHaveLength(1);
      expect(live.backgroundAgents()).toHaveLength(1);
      writeFileSync(meta, JSON.stringify({ description: '/code-review' }));
      if (change === 'rewrite') {
        writeFileSync(file.path, '{"type":"user","tool_result":\n');
        await live.refresh();
        time += 1100; await live.refresh();
        expect(live.subagentFrames()).toHaveLength(1); // Complete newline is not valid evidence.
        writeFileSync(file.path, `${JSON.stringify({ type: 'user', uuid: 'replacement', promptId: 'replacement', origin: { kind: 'human' }, timestamp: '2026-10-20T00:01:00.000Z', message: { role: 'user', content: 'New conversation' } })}\n`);
      } else launch('second');
      writer = await refresh();
      expect(live.subagentFrames()).toEqual([]);
      expect(live.backgroundAgents()).toEqual([]);
      expect(live.activities().filter(activity => activity.task?.kind === 'agent')).toEqual([]);
      expect(writer.subagents).toEqual([]);
      expect(writer.activities.live()).toEqual([]);
      if (change === 'conflict') {
        expect(journal.entity('wb', 'meta:subagent:first')?.kind).toBe('tombstone');
        expect(journal.entity('wb', `claude:${file.id}:c-first:0`)?.kind).toBe('tool_call');
        expect(journal.entity('wb', `claude:${file.id}:r-first:0`)?.kind).toBe('tool_call_update');
      }
      const cold = new ClaudeTranscript({ id: 'wb', nativeSessionId: file.id, updatedAt: '' } as Session, file.id);
      await cold.setFile(file.path);
      expect(cold.subagentFrames()).toEqual(live.subagentFrames());
      expect(cold.backgroundAgents()).toEqual(live.backgroundAgents());
      const held = snapshot(journal, 'wb');
      await importAll(source(), journal);
      assertUnchanged(held, snapshot(journal, 'wb'), 'invalid fork after restart');
    } finally { now.mockRestore(); }
  });

  it('keeps a turn running through a tool-use stream error, retries and an absorbed input across restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-claude-stream-error-'));
    dirs.push(dir);
    const file = new SessionFile(dir, '11111111-2222-4333-8444-555555555555').prompt('original').call('first', 'Bash', {});
    const source = () => new ClaudeTranscriptSource({ sessionId: 'wb', nativeSessionId: () => file.id, locate: async () => file.path });
    const journal = new Journal(new DatabaseSync(':memory:'));
    let live = new ClaudeTranscript({ id: 'wb', nativeSessionId: file.id, updatedAt: '' } as Session, file.id);
    await live.setFile(file.path);
    let state = initialState('alive');
    const refresh = async () => {
      const { lifecycle } = await live.refresh();
      if (lifecycle.replay) state = initialState('alive');
      for (const signal of lifecycle.signals) state = reduce(state, signal).state;
      return importAll(source(), journal);
    };
    await refresh();
    // Claude Code 2.1.322: the stream cuts after a tool call, then the CLI retries under the same prompt.
    const error = 'API Error: Connection lost mid-response. The response above may be incomplete.';
    file.write({ type: 'assistant', uuid: 'stream-error', isApiErrorMessage: true, apiError: 'connection_failed', streamCutCause: 'stale_connection',
      message: { id: 'm-stream-error', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: error }], stop_reason: 'tool_use' } });
    await refresh();
    expect(phaseOf(state)).toBe('busy');
    expect(rowsOf(journal, 'wb').filter(row => row.kind === 'meta.turn_ended')).toEqual([]);
    file.result('first', 'Transient classifier failure', {}, true)
      .write({ type: 'queue-operation', operation: 'enqueue', content: 'continue' })
      .call('retry', 'Bash', {})
      .write({ type: 'queue-operation', operation: 'remove', content: 'continue', reason: 'absorbed_mid_turn' })
      .result('retry', 'done');
    let writer = await refresh();
    expect(activeTurnOf(state.mainTurn)?.promptId).toBe('p-original');
    expect(state.cliQueue).toEqual([]);
    expect(source().activeTurn(writer)).toEqual({ turnId: 'p-original', promptId: 'p-original' });
    expect(rowsOf(journal, 'wb').filter(row => row.kind === 'meta.turn_started')).toHaveLength(1);
    expect(journal.entity('wb', `claude:${file.id}:c-retry:0`)?.turnId).toBe('p-original');
    expect(rowsOf(journal, 'wb').filter(row => JSON.stringify(row.payload).includes(error))).toHaveLength(1);

    live = new ClaudeTranscript({ id: 'wb', nativeSessionId: file.id, updatedAt: '' } as Session, file.id);
    await live.setFile(file.path);
    writer = await refresh();
    expect(phaseOf(state)).toBe('busy');
    expect(source().activeTurn(writer)?.promptId).toBe('p-original');
    expect(live.allEvents().filter(event => event.type === 'run_failed')).toEqual([]);
    file.answer('original').duration('original');
    await refresh();
    expect(phaseOf(state)).toBe('idle');
    expect(live.allEvents().filter(event => event.type === 'run_completed')).toHaveLength(1);
    const ended = rowsOf(journal, 'wb').filter(row => row.kind === 'meta.turn_ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.payload).toEqual({ turnId: 'p-original', status: 'completed' });
  });

  it('keeps continuation ownership and the native prompt together through old cursor recovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-claude-continuation-'));
    dirs.push(dir);
    const file = new SessionFile(dir, '11111111-2222-4333-8444-555555555555').prompt('original').call('first', 'Bash', {});
    const source = () => new ClaudeTranscriptSource({ sessionId: 'wb', nativeSessionId: () => file.id, locate: async () => file.path });
    const journal = new Journal(new DatabaseSync(':memory:'));
    const writer = await importAll(source(), journal);
    await source().endTurn(writer, 'cancelled', '2026-10-20T00:00:03.000Z', 'p-original');
    file.call('continued', 'Bash', {});
    await importAll(source(), journal);
    const continued = journal.entity('wb', `claude:${file.id}:c-continued:0`)!.payload as NativeWorkbenchEvent;
    expect(continued).toMatchObject({ runId: 'claude-turn:c-continued', nativeTurnId: 'claude-turn:c-continued' });
    expect(source().activeTurn(writer)).toEqual({ turnId: 'claude-turn:c-continued', promptId: 'p-original' });

    // Upgrade an already committed pre-fix cursor, without replaying the native file or its commands.
    const legacy = JSON.parse(writer.cursor!);
    delete legacy.s.t.p;
    delete legacy.s.t.a;
    writer.commit({ events: [], cursor: JSON.stringify(legacy) });
    expect(source().activeTurn(writer)).toEqual({ turnId: 'claude-turn:c-continued', promptId: 'p-original' });
    file.call('later', 'Bash', {});
    await importAll(source(), journal);
    expect(journal.entity('wb', `claude:${file.id}:c-later:0`)!.payload).toMatchObject({ runId: continued.runId, nativeTurnId: continued.nativeTurnId });
    expect(rowsOf(journal, 'wb').filter(row => row.kind === 'meta.turn_ended')).toHaveLength(1);
  });

  it('uses the same Stop boundary for live state and the journal, including blocked hooks across restart', async () => {
    const { file, source, fixture } = scenario();
    const journal = new Journal(new DatabaseSync(':memory:'));
    await fixture.append();
    file().prompt('stop-boundary').answer('stop-boundary').write({ type: 'system', uuid: 'stop-summary', subtype: 'stop_hook_summary' });
    let writer = await importAll(source(), journal);
    expect(source().activeTurn(writer)).toBeUndefined();
    expect(writer.turnEndStatus('p-stop-boundary')).toBe('completed');

    file().prompt('next-after-stop').write({ type: 'system', uuid: 'old-duration', parentUuid: 'stop-summary', subtype: 'turn_duration' });
    writer = await importAll(source(), journal);
    expect(source().activeTurn(writer)?.promptId).toBe('p-next-after-stop');
    const live = new ClaudeTranscript({ id: 'wb', nativeSessionId: file().id, updatedAt: '' } as Session, file().id);
    await live.setFile(file().path);
    const state = (await live.refresh()).lifecycle.signals.reduce((state, signal) => reduce(state, signal).state, initialState('alive'));
    expect(activeTurnOf(state.mainTurn)?.promptId).toBe('p-next-after-stop');

    // A bounded parent cache must not assign an evicted old Stop's duration to this new prompt.
    for (let index = 0; index < 257; index += 1) file().write({ type: 'attachment', uuid: `between-${index}` });
    file().write({ type: 'system', uuid: 'evicted-duration', parentUuid: 'stop-summary', subtype: 'turn_duration' });
    await importAll(source(), journal);
    const afterEviction = (await live.refresh()).lifecycle.signals.reduce((state, signal) => reduce(state, signal).state, state);
    expect(activeTurnOf(afterEviction.mainTurn)?.promptId).toBe('p-next-after-stop');
    expect(source().activeTurn(writer)?.promptId).toBe('p-next-after-stop');
    file().write({ type: 'system', uuid: 'next-stop', parentUuid: 'between-256', subtype: 'stop_hook_summary' });
    await importAll(source(), journal);
    expect(source().activeTurn(writer)).toBeUndefined();

    file().prompt('blocked').answer('blocked').write({ type: 'user', uuid: 'feedback', isMeta: true,
      message: { role: 'user', content: 'Stop hook feedback:\nRun the checks first.' } });
    await importAll(source(), journal);
    file().write({ type: 'system', uuid: 'blocked-summary', subtype: 'stop_hook_summary' });
    writer = await importAll(source(), journal);
    expect(source().activeTurn(writer)?.promptId).toBe('p-blocked');
    file().write({ type: 'system', uuid: 'context-summary', subtype: 'stop_hook_summary', hookAdditionalContext: ['Keep working'] });
    await importAll(source(), journal);
    expect(writer.turnEndStatus('p-blocked')).toBeUndefined();
    file().answer('blocked-final').write({ type: 'system', uuid: 'final-summary', subtype: 'stop_hook_summary' });
    await importAll(source(), journal);
    const before = snapshot(journal, 'wb');
    file().duration('blocked');
    await importAll(source(), journal);
    expect(writer.turnEndStatus('p-blocked')).toBe('completed');
    assertUnchanged(before, snapshot(journal, 'wb'), 'late duration after Stop');
  });

  it('records a child API failure as failed without treating a recoverable stream error as its end', async () => {
    const { file, source, dir } = scenario();
    const root = join(dir, file().id, 'subagents');
    mkdirSync(root, { recursive: true });
    const child = new SessionFile(root, 'agent-failed').prompt('child').call('before-error', 'Bash', {});
    const error = (id: string, stop: string) => ({ type: 'assistant', uuid: id, isSidechain: true, agentId: 'failed', isApiErrorMessage: true,
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: connection failed' }], stop_reason: stop } });
    child.write(error('retryable', 'tool_use'));
    writeFileSync(join(root, 'agent-failed.meta.json'), JSON.stringify({ toolUseId: 'failed-call' }));
    const journal = new Journal(new DatabaseSync(':memory:'));
    await importAll(source(), journal);
    const key = laneKey('wb', 'sub:failed-call');
    expect(rowsOf(journal, key).filter(row => row.kind === 'meta.turn_ended')).toEqual([]);
    child.result('before-error', 'retry').write(error('terminal', 'stop_sequence'));
    await importAll(source(), journal);
    const ends = rowsOf(journal, key).filter(row => row.kind === 'meta.turn_ended');
    expect(ends).toHaveLength(1);
    expect(ends[0]?.payload).toMatchObject({ status: 'failed', error: 'API Error: connection failed' });
    const childWriter = JournalLaneWriter.open(journal, 'wb').child('failed-call', 'failed');
    childWriter.turnEnded(String(ends[0]!.turnId), 'completed', ends[0]!.at);
    const legacy = JSON.parse(childWriter.cursor!);
    delete legacy.lifecycle;
    legacy.s.x = [['end', ends[0]!.turnId, 'completed', ends[0]!.at]];
    childWriter.commit({ events: [], cursor: JSON.stringify(legacy) });
    await importAll(source(), journal);
    expect(childWriter.turnEndStatus(String(ends[0]!.turnId))).toBe('failed');
    writeFileSync(join(root, 'agent-failed.meta.json'), JSON.stringify({ toolUseId: 'failed-call', finished: true }));
    const before = snapshot(journal, 'wb');
    await importAll(source(), journal);
    assertUnchanged(before, snapshot(journal, 'wb'), 'finished metadata after failure');
  });

  it.each(['running', 'completed', 'cancelled'])('repairs a legacy stream-error end and continuation while preserving a control-path stop: %s', async outcome => {
    const finished = outcome === 'completed';
    const cancelled = outcome === 'cancelled';
    const dir = mkdtempSync(join(tmpdir(), 'riffet-claude-lifecycle-upgrade-'));
    dirs.push(dir);
    const file = new SessionFile(dir, '11111111-2222-4333-8444-555555555555').prompt('original').call('first', 'Bash', {});
    const source = () => new ClaudeTranscriptSource({ sessionId: 'wb', nativeSessionId: () => file.id, locate: async () => file.path });
    const journal = new Journal(new DatabaseSync(':memory:'));
    let writer = await importAll(source(), journal);
    const error = 'API Error: Connection lost mid-response. The response above may be incomplete.';
    const at = '2026-10-20T00:00:03.000Z';
    file.write({ type: 'assistant', uuid: 'broken-stream', isApiErrorMessage: true, timestamp: at,
      message: { role: 'assistant', model: '<synthetic>', stop_reason: 'tool_use', content: [{ type: 'text', text: error }] } });
    await importAll(source(), journal);
    await source().endTurn(writer, 'failed', at, 'p-original');
    // The old implementation suppressed the error text and incorrectly closed the original turn.
    writer.turnEnded('p-original', 'failed', at, error);
    writer.commit({ events: [], retire: [`claude:${file.id}:broken-stream:0`], cursor: writer.cursor });
    file.call('retry', 'Bash', {});
    if (outcome !== 'running') file.result('retry', 'ok');
    if (finished) file.answer('original').duration('original');
    writer = await importAll(source(), journal);
    if (cancelled) await source().endTurn(writer, 'cancelled', '2026-10-20T00:00:08.000Z', 'p-original');
    const anonymous = 'claude-turn:c-retry';
    expect(journal.entity('wb', `claude:${file.id}:c-retry:0`)?.turnId).toBe(anonymous);
    const legacy = JSON.parse(writer.cursor!);
    delete legacy.lifecycle;
    if (finished) legacy.s.x = [['end', anonymous, 'completed', '2026-10-20T00:00:09.000Z']];
    writer.commit({ events: [], cursor: JSON.stringify(legacy) });
    const generation = writer.generation;
    if (outcome === 'running') {
      const beforeFailure = snapshot(journal, 'wb');
      const append = journal.append.bind(journal);
      const fail = vi.spyOn(journal, 'append').mockImplementation((sessionId, events, options) => {
        const result = append(sessionId, events, options);
        if (events.some(event => event.nativeId === `claude:${file.id}:c-retry:0`)) throw new Error('interrupted repair');
        return result;
      });
      await expect(importAll(source(), journal)).rejects.toThrow('interrupted repair');
      fail.mockRestore();
      assertUnchanged(beforeFailure, snapshot(journal, 'wb'), 'rollback interrupted repair');
      expect(writer.cursor).toBe(JSON.stringify(legacy));
    }
    writer = await importAll(source(), journal);
    expect(writer.generation).toBe(generation);
    expect(journal.entity('wb', `claude:${file.id}:c-retry:0`)?.turnId).toBe(cancelled ? anonymous : 'p-original');
    expect(journal.entity('wb', turnMetaId(anonymous, 'started'))?.kind).toBe(cancelled ? 'meta.turn_started' : 'tombstone');
    expect(writer.turnEndStatus('p-original')).toBe(cancelled ? 'failed' : finished ? 'completed' : undefined);
    expect(source().activeTurn(writer)?.promptId).toBe(finished || cancelled ? undefined : 'p-original');
    const before = snapshot(journal, 'wb');
    await importAll(source(), journal);
    assertUnchanged(before, snapshot(journal, 'wb'), 'restart after lifecycle repair');
    if (outcome === 'running') {
      file.result('retry', 'late result');
      await importAll(source(), journal);
      const call = journal.entity('wb', `claude:${file.id}:c-retry:0`)?.payload as NativeWorkbenchEvent;
      expect(journal.entity('wb', `claude:${file.id}:r-retry:0`)?.payload).toMatchObject({ runId: call.runId, nativeTurnId: call.nativeTurnId });
    }
  });

  it.each(['remove', 'dequeue'])('preserves external queue order across restart before associating an identical queued prompt: %s', async operation => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-claude-queue-'));
    dirs.push(dir);
    const file = new SessionFile(dir, '11111111-2222-4333-8444-555555555555').prompt('original')
      .write({ type: 'queue-operation', operation: 'enqueue', content: 'same input' })
      .write({ type: 'queue-operation', operation: 'enqueue', content: 'same input', tracked: true });
    const removed: Array<string | undefined> = [];
    const source = () => new ClaudeTranscriptSource({ sessionId: 'wb', nativeSessionId: () => file.id, locate: async () => file.path,
      hooks: { commandForUserMessage: message => message.uuid === 'u-external' ? 'riffet-command' : undefined, queuedInput: (row, position) => {
        if (row.operation === 'remove') removed.push(position.receipt?.commandId);
        return row.tracked === true ? [{ sequence: 0, sessionId: 'wb', runId: 'riffet-run', nativeId: 'queue-receipt',
          createdAt: row.timestamp as string, type: 'native_input_receipt', data: { commandId: 'riffet-command', content: { type: 'text', text: 'same input' } } }] : [];
      } },
    });
    const journal = new Journal(new DatabaseSync(':memory:'));
    await importAll(source(), journal);
    file.write({ type: 'queue-operation', operation, content: 'same input', reason: 'absorbed_mid_turn' });
    if (operation === 'dequeue') file.prompt('external', 'same input');
    await importAll(source(), journal);
    expect(removed).toEqual(operation === 'remove' ? [undefined] : []);
    if (operation === 'dequeue') {
      expect((journal.entity('wb', `claude:${file.id}:u-external:0`)!.payload as NativeWorkbenchEvent).data).not.toHaveProperty('commandId');
    }
    file.write({ type: 'queue-operation', operation: 'dequeue' }).prompt('queued', 'same input');
    await importAll(source(), journal);
    expect(journal.entity('wb', `claude:${file.id}:u-queued:0`)!.payload).toMatchObject({ data: { commandId: 'riffet-command' } });
    const before = snapshot(journal, 'wb');
    await importAll(source(), journal);
    assertUnchanged(before, snapshot(journal, 'wb'), 'queued prompt after restart');
  });

  it('consumes a dequeued task notification across restart before associating the next human input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-claude-notification-queue-'));
    dirs.push(dir);
    const notification = notice('<task-id>background</task-id><status>completed</status><summary>Background complete</summary>');
    const file = new SessionFile(dir, '11111111-2222-4333-8444-555555555555').prompt('original')
      .write({ type: 'queue-operation', operation: 'enqueue', content: notification }, { type: 'queue-operation', operation: 'dequeue' });
    const source = () => new ClaudeTranscriptSource({ sessionId: 'wb', nativeSessionId: () => file.id, locate: async () => file.path,
      hooks: { queuedInput: row => row.tracked === true ? [{ sequence: 0, sessionId: 'wb', runId: 'riffet-run', nativeId: 'queue-receipt',
        createdAt: row.timestamp as string, type: 'native_input_receipt', data: { commandId: 'riffet-command', content: { type: 'text', text: 'human input' } } }] : [] } });
    const journal = new Journal(new DatabaseSync(':memory:'));
    await importAll(source(), journal);
    file.prompt('notification', notification, { origin: { kind: 'task-notification' } });
    let writer = await importAll(source(), journal);
    expect(JSON.parse(writer.cursor!).s.q ?? []).toEqual([]);
    file.write({ type: 'queue-operation', operation: 'enqueue', content: 'human input', tracked: true }, { type: 'queue-operation', operation: 'dequeue' })
      .prompt('human', 'human input');
    writer = await importAll(source(), journal);
    expect(journal.entity('wb', `claude:${file.id}:u-human:0`)!.payload).toMatchObject({ data: { commandId: 'riffet-command' } });
    expect((JSON.parse(writer.cursor!).s.q ?? []).filter((input: { consumed?: number }) => !input.consumed)).toEqual([]);
  });

  it('holds the journal write contract, in the order the live view maps the same files', async () => {
    const { fixture, settle } = scenario();
    await settle();
    const report = await runIngestContract(fixture, { sessionId: 'wb', openLastTurn: true });
    expect(report.served.map(item => item.scratch)).toEqual([true, false]);
    expect(Object.keys(report.lanes).sort()).toEqual(['main']);
  });

  it('ends what a CLI that is gone left open, after what it wrote, and keeps it ended across reads and restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-claude-exit-'));
    dirs.push(dir);
    const file = new SessionFile(dir, '11111111-2222-4333-8444-555555555555');
    let exited: string | undefined;
    const source = () => new ClaudeTranscriptSource({ sessionId: 'wb', nativeSessionId: () => file.id, locate: async () => file.path, exited: () => exited });
    file.turn('t1').prompt('t2')
      .call('bsh', 'Bash', { command: 'make', run_in_background: true }).result('bsh', 'Command running in background with ID: bsh9.', { backgroundTaskId: 'bsh9' })
      .call('long', 'Bash', { command: 'sleep 100' });
    const journal = new Journal(new DatabaseSync(':memory:'));
    await importAll(source(), journal);
    const ended = (turnId: string) => rowsOf(journal, 'wb').find(row => row.kind === 'meta.turn_ended' && row.turnId === turnId);
    const activity = () => activityOfEvent(journal.entity('wb', 'claude:bsh9')?.payload);
    expect(ended('p-t2')).toBeUndefined();
    expect(activity()?.status).toBe('running');

    // The CLI wrote one more row and was found gone: that row is read first, then the turn and the task end as of then (G6).
    file.result('long', 'interrupted');
    exited = '2026-10-21T00:00:00.000Z';
    await importAll(source(), journal);
    const end = ended('p-t2');
    expect(end?.payload).toMatchObject({ status: 'interrupted' });
    expect(end!.seq).toBeGreaterThan(rowsOf(journal, 'wb').find(row => row.nativeId.includes('r-long'))!.seq);
    expect(activity()).toMatchObject({ status: 'unknown', endedAt: exited });
    checkSession(journal, 'wb');

    // Read again from the committed cursor, by the same reader or a restarted one: nothing new (G7).
    const before = snapshot(journal, 'wb');
    await importAll(source(), journal);
    assertUnchanged(before, snapshot(journal, 'wb'), 'a read after the exit');

    // Resumed: its rows open a turn of their own, and the abandoned task is not brought back by the mapping's state.
    exited = undefined;
    file.turn('t3');
    const writer = await importAll(source(), journal);
    expect(ended('p-t3')?.payload).toMatchObject({ status: 'completed' });
    expect(rowsOf(journal, 'wb').filter(row => row.kind === 'meta.turn_ended' && row.turnId === 'p-t2')).toHaveLength(1);
    expect(activity()?.status).toBe('unknown');
    expect(writer.activities.live()).toEqual([]);

    // The control path's end of a turn the CLI took back without a row: only that prompt's turn.
    file.prompt('t4');
    expect(await source().endTurn(writer, 'cancelled', '2026-10-22T00:00:00.000Z', 'p-other')).toBeUndefined();
    expect(await source().endTurn(writer, 'cancelled', '2026-10-22T00:00:00.000Z', 'p-t4')).toBe('p-t4');
    expect(ended('p-t4')?.payload).toMatchObject({ status: 'cancelled' });
    checkSession(journal, 'wb');
  });

  it('runs a compaction from its PreCompact hook and completes the same one at the boundary 2.1.322 writes later', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-claude-precompact-'));
    dirs.push(dir);
    const file = new SessionFile(dir, '11111111-2222-4333-8444-555555555555').turn('t1');
    const source = () => new ClaudeTranscriptSource({ sessionId: 'wb', nativeSessionId: () => file.id, locate: async () => file.path });
    const journal = new Journal(new DatabaseSync(':memory:'));
    const writer = await importAll(source(), journal);
    const id = 'claude:compaction:hook-1';
    const compactions = () => rowsOf(journal, 'wb').map(row => activityOfEvent(row.payload)).filter(activity => activity?.kind === 'compaction');
    await source().compactionHooked(writer, id, 'manual', '2026-10-20T00:00:10.000Z');
    // Heard twice (a retried delivery): still one compaction.
    await source().compactionHooked(writer, 'claude:compaction:hook-2', 'manual', '2026-10-20T00:00:11.000Z');
    expect(compactions().map(activity => [activity!.id, activity!.status])).toEqual([[id, 'running']]);

    // A restarted reader picks the compaction up from the cursor; the boundary, summary and command follow.
    file.write({ type: 'system', subtype: 'compact_boundary', uuid: 'b', compactMetadata: { trigger: 'manual', preTokens: 900, postTokens: 100 } })
      .write({ type: 'user', uuid: 'sum', promptId: 'p-c', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued.' } })
      .write({ type: 'user', uuid: 'cmd', promptId: 'p-c', message: { role: 'user', content: '<command-name>/compact</command-name>\n <command-message>compact</command-message>\n <command-args></command-args>' } })
      .write({ type: 'user', uuid: 'out', promptId: 'p-c', message: { role: 'user', content: '<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m\n\u001b[2mPreCompact [\'node\' \'hook-cli.mjs\'] completed successfully\u001b[22m</local-command-stdout>' } });
    await importAll(source(), journal);
    expect(new Set(compactions().map(activity => activity!.id))).toEqual(new Set([id]));
    expect(compactions().at(-1)).toMatchObject({ status: 'completed', startedAt: '2026-10-20T00:00:10.000Z', compaction: { trigger: 'manual', preTokens: 900, postTokens: 100 } });
    checkSession(journal, 'wb');
  });

  it('places an automatic compaction heard before its prompt row in that prompt\'s turn, after the prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-claude-precompact-auto-'));
    dirs.push(dir);
    const file = new SessionFile(dir, '11111111-2222-4333-8444-555555555555').turn('t1');
    const source = () => new ClaudeTranscriptSource({ sessionId: 'wb', nativeSessionId: () => file.id, locate: async () => file.path });
    const journal = new Journal(new DatabaseSync(':memory:'));
    const writer = await importAll(source(), journal);
    const id = 'claude:compaction:hook-auto';
    const rows = () => rowsOf(journal, 'wb');
    const compactionRows = () => rows().filter(row => activityOfEvent(row.payload)?.kind === 'compaction');
    // The CLI compacts on submit before the prompt's row is on disk.
    await source().compactionHooked(writer, id, 'auto', '2026-10-20T00:00:10.000Z', 'p-t2');
    expect(compactionRows()).toEqual([]);

    file.prompt('t2');
    await importAll(source(), journal);
    const prompt = rows().find(row => row.kind === 'user_message_chunk' && row.turnId === 'p-t2')!;
    expect(compactionRows().map(row => [activityOfEvent(row.payload)!.id, activityOfEvent(row.payload)!.status, row.turnId, row.seq > prompt.seq]))
      .toEqual([[id, 'running', 'p-t2', true]]);

    file.write({ type: 'system', subtype: 'compact_boundary', uuid: 'b', compactMetadata: { trigger: 'auto', preTokens: 900, postTokens: 100 } }).answer('t2').duration('t2');
    await importAll(source(), journal);
    expect(new Set(compactionRows().map(row => activityOfEvent(row.payload)!.id))).toEqual(new Set([id]));
    expect(activityOfEvent(compactionRows().at(-1)!.payload)).toMatchObject({ status: 'completed', compaction: { trigger: 'auto' } });
    checkSession(journal, 'wb');
  });

  it('settles a finished background subagent and an ended task from the files beside the transcript, once, across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-claude-settle-'));
    // Only a file under the CLI's own temporary directory is read as a task's output.
    const tasks = join(mkdtempSync('/tmp/claude-'), 'proj', 'tasks');
    dirs.push(dir, dirname(dirname(tasks)));
    mkdirSync(tasks, { recursive: true });
    const output = join(tasks, 'bsh1.output');
    const file = new SessionFile(dir, '11111111-2222-4333-8444-555555555555');
    const blobs: string[] = [];
    const source = () => new ClaudeTranscriptSource({
      sessionId: 'wb', nativeSessionId: () => file.id, locate: async () => file.path,
      hooks: { putBlob: text => { blobs.push(text); return `blob-${blobs.length}`; } },
    });
    const root = join(dir, file.id, 'subagents');
    mkdirSync(root, { recursive: true });
    const meta = (fields: Record<string, unknown>) => writeFileSync(join(root, 'agent-bg1.meta.json'), JSON.stringify({ toolUseId: 'agent1', agentType: 'Explore', description: 'Dig', requestShape: 'background', model: 'sonnet', ...fields }));
    meta({});
    writeFileSync(join(root, 'agent-bg1.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'bg1-u', isSidechain: true, agentId: 'bg1', timestamp: '2026-10-20T00:00:01.000Z', message: { role: 'user', content: 'Dig' } })}\n`);
    file.prompt('t1')
      .call('agent1', 'Agent', { description: 'Dig', prompt: 'Dig', subagent_type: 'Explore', run_in_background: true })
      .result('agent1', 'Async agent launched', { isAsync: true, status: 'async_launched', agentId: 'bg1', description: 'Dig' })
      .call('bsh', 'Bash', { command: 'make', description: 'build', run_in_background: true })
      .result('bsh', `Command running in background with ID: bsh1. Output is being written to: ${output}`, { backgroundTaskId: 'bsh1' })
      .answer('t1').duration('t1');
    // More ended activities than a cursor remembers: the task that ends after them is still the one written.
    for (let index = 0; index < 18; index += 1) {
      file.write({ type: 'user', uuid: `cmd${index}`, promptId: `p-cmd${index}`, message: { role: 'user', content: '<command-name>/cost</command-name>\n <command-message>cost</command-message>\n <command-args></command-args>' } })
        .write({ type: 'user', uuid: `out${index}`, promptId: `p-cmd${index}`, message: { role: 'user', content: `<local-command-stdout>Total cost: $${index}</local-command-stdout>` } });
    }
    const journal = new Journal(new DatabaseSync(':memory:'));
    const live = source();
    await importAll(live, journal);
    const state = (id: string) => activityOfEvent(journal.entity('wb', id)?.payload);
    expect(state('claude:bg1')?.status).toBe('running');
    expect(journal.entity('wb', 'meta:subagent:agent1')?.payload).toMatchObject({ agentId: 'bg1', title: 'Dig', subagentType: 'Explore', model: 'sonnet' });
    const childKey = laneKey('wb', 'sub:agent1');
    const childBefore = journal.head(childKey);
    meta({ description: 'Dig deeper' });
    await importAll(live, journal);
    expect(journal.entity('wb', 'meta:subagent:agent1')?.payload).toMatchObject({ title: 'Dig deeper', subagentType: 'Explore', model: 'sonnet' });
    expect(journal.head(childKey)).toEqual(childBefore);

    // While the service is down the agent finishes and the command reports; a restarted reader settles both.
    writeFileSync(output, 'compiling\nall 12 targets built\n');
    meta({ finished: true });
    file.write({ type: 'user', uuid: 'n-bsh1', promptId: 'p-n', origin: { kind: 'task-notification' }, message: { role: 'user', content: notice(`<task-id>bsh1</task-id>\n<tool-use-id>bsh</tool-use-id>\n<output-file>${output}</output-file>\n<status>completed</status>\n<summary>Background command "build" completed (exit code 0)</summary>`) } })
      .answer('n').duration('n');
    await importAll(source(), journal);
    expect(state('claude:bg1')).toMatchObject({ status: 'completed', endedAt: expect.any(String) });
    expect(state('claude:bsh1')).toMatchObject({ status: 'completed', detail: 'compiling\nall 12 targets built', blobRef: 'blob-1' });
    checkSession(journal, 'wb');

    // The tail is read once: a later change of the file, a restart and a read again write nothing.
    writeFileSync(output, 'rewritten\n');
    const before = snapshot(journal, 'wb');
    const writer = await importAll(source(), journal);
    assertUnchanged(before, snapshot(journal, 'wb'), 'a restart after the settle');
    expect(blobs).toHaveLength(1);
    expect(writer.activities.live()).toEqual([]);
  });

  // Protocol/recovery guarantee: a reused task id needs a proven new launch, while old reports
  // and a restored cursor cannot revive a finished execution or terminate its replacement.
  it('keeps a relaunched background agent separate from replayed terminal states', () => {
    const stamp = (second: number) => new Date(Date.UTC(2026, 9, 20, 0, 0, second)).toISOString();
    let mapper = new ClaudeActivities('wb');
    const launch = (call: string, at: number, run: string) => mapper.launched(
      { name: 'Agent', input: { description: 'Review' } }, call,
      { isAsync: true, status: 'async_launched', agentId: 'a1' }, '', stamp(at), run,
    );
    const report = (call: string, at: number) => mapper.notified(
      { taskId: 'a1', toolUseId: call, status: 'failed', sourceStatus: 'failed', title: 'Review' }, stamp(at), 'notice',
    );
    const old = [...launch('call-1', 1, 'run-1'), ...report('call-1', 2)];
    mapper = ClaudeActivities.restore('wb', {}, JSON.parse(JSON.stringify(mapper.state())));
    expect(launch('call-1', 3, 'run-1')).toEqual([]);
    const [restarted] = launch('call-2', 4, 'run-2');
    expect(restarted?.runId).toBe('run-2');
    const current = mapper.get('claude:a1')!;
    expect(current).toMatchObject({ status: 'running', toolCallId: 'call-2', startedAt: stamp(4) });
    expect(current.endedAt).toBeUndefined();
    expect(current.durationMs).toBeUndefined();
    expect(report('call-1', 5)).toEqual([]);
    expect(launch('call-1', 1, 'run-1')).toEqual([]);

    // Both the writer's ledger and the event projection can receive an older terminal state again.
    const events = [...old, restarted!, old.at(-1)!].map((event, index) => ({ ...event, sequence: index + 1 }));
    const ledger = new ActivityLedger(() => undefined);
    for (const event of events) ledger.apply(activityOfEvent(event)!);
    expect(ledger.get('claude:a1')).toEqual(current);
    expect(activityOfEvent(projectEvents(events)[0])).toEqual(current);
    expect(report('call-2', 6)).toHaveLength(1);
    expect(mapper.get('claude:a1')?.status).toBe('failed');
  });

  it('ends each turn as Claude recorded it, and starts over when the file is replaced under the same name', async () => {
    const { fixture, file, source } = scenario();
    await fixture.append();
    await fixture.terminalTurn();
    // A turn whose API call failed for good: the CLI writes the error as an assistant row of its own, then the duration.
    const failure = 'Please run /login · API Error: 403 model not allowed';
    file().prompt('failed').write({
      type: 'assistant', uuid: 'e-failed', isApiErrorMessage: true, error: 'authentication_failed', apiErrorStatus: 403,
      message: { id: 'm-e-failed', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: failure }], stop_reason: 'stop_sequence' },
    }).duration('failed');
    const journal = new Journal(new DatabaseSync(':memory:'));
    const writer = await importAll(source(), journal);
    checkSession(journal, 'wb', { openLastTurn: true });
    const ends = Object.fromEntries(rowsOf(journal, 'wb').filter(row => row.kind === 'meta.turn_ended').map(row => [row.turnId, (row.payload as { status: string }).status]));
    expect(ends).toMatchObject({ 'p-t1': 'completed', 'p-compact': 'completed', 'p-compact-late': 'completed', 'p-cost': 'completed', 'p-old': 'completed', 'p-typed': 'cancelled', 'p-failed': 'failed' });
    const failed = rowsOf(journal, 'wb').filter(row => row.turnId === 'p-failed');
    expect(failed.find(row => row.kind === 'meta.turn_ended')?.payload).toMatchObject({ error: failure });
    expect(failed.filter(row => JSON.stringify(row.payload).includes(failure))).toHaveLength(1);
    expect(Object.keys(visibleLanes(journal, 'wb')).sort()).toEqual(['main', 'sub:tool-a1']);

    const generation = writer.generation;
    writeFileSync(file().path, '');
    file().turn('rewritten');
    await importAll(source(), journal);
    expect(writer.generation).not.toBe(generation);
    const fresh = new Journal(new DatabaseSync(':memory:'));
    await importAll(source(), fresh);
    expect(visibleLanes(journal, 'wb')).toEqual(visibleLanes(fresh, 'wb'));
  });
});
