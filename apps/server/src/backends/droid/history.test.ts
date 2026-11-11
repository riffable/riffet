import { describe, expect, it } from 'vitest';
import { parseDroidTranscript, projectDroidChain, validateDroidSessionId } from './history.js';

const line = (value: unknown) => JSON.stringify(value);
const message = (id: string, parentId: string, seq: number, role: string, content: unknown[]) =>
  line({ type: 'message', id, parentId, seq, timestamp: new Date(Date.parse('2026-10-12T03:00:00.000Z') + seq * 1000).toISOString(), message: { role, content } });

const transcript = [
  line({ type: 'session_start', id: 's1', title: 'First prompt', cwd: '/repo' }),
  message('context-u1', 'root', 0, 'user', [{ type: 'text', text: '<system-reminder>' }]),
  message('u1', 'context-u1', 1, 'user', [{ type: 'text', text: 'Run ls' }]),
  message('a1', 'u1', 2, 'assistant', [{ type: 'tool_use', id: 'toolu_1', name: 'Execute', input: { command: 'ls' } }]),
  message('t1', 'a1', 3, 'user', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.ts' }]),
  line({ type: 'agent_turn_outcome', turnId: 'u1', reason: 'completed', resultKind: 'success' }),
  // A rewind: the edited prompt branches from the first context message.
  message('u1b', 'context-u1', 4, 'user', [{ type: 'text', text: 'Run pwd' }]),
  line({ type: 'session_title_updated', title: 'Run pwd' }),
  '{"type":"message","id":"half',
].join('\n');

describe('Droid transcript', () => {
  const parsed = parseDroidTranscript(transcript, '/s/s1.jsonl', 's1');

  it('follows the current branch back from the last message', () => {
    expect(parsed.chain.map(item => item.id)).toEqual(['context-u1', 'u1b']);
    expect(parsed).toMatchObject({ title: 'Run pwd', cwd: '/repo', lastSeq: 4, generation: 's1:context-u1' });
  });

  it('places a turn outcome after the last message written before it', () => {
    expect(parsed.outcomes.get('u1')).toMatchObject({ reason: 'completed', lastSeq: 3 });
  });

  it('projects the chain with each turn outcome after its last message', () => {
    const linear = parseDroidTranscript(transcript.split('\n').slice(0, 6).join('\n'), '/s/s1.jsonl', 's1');
    const events = projectDroidChain(linear, { sessionId: 'wb' }, id => id === 'u1' ? { commandId: 'cmd-1', runId: 'run-1' } : undefined);
    expect(events.map(event => [event.type, event.nativeId])).toEqual([
      ['user_message_chunk', 'msg:u1'],
      ['tool_call', 'tool:toolu_1'],
      ['tool_call_update', 'tool:toolu_1:result'],
      ['run_completed', 'turn:u1:end'],
    ]);
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(events.at(-1)).toMatchObject({ data: { commandId: 'cmd-1' } });
    expect(projectDroidChain(linear, { sessionId: 'wb' }, false).map(event => event.type)).not.toContain('run_completed');
  });

  it('accepts only plain session ids', () => {
    expect(() => validateDroidSessionId('9dce7613-50ab-4921-81d9-3ab19ec1abdd')).not.toThrow();
    expect(() => validateDroidSessionId('../etc')).toThrow();
  });
});
