import { describe, expect, it } from 'vitest';
import { ClaudeRequestRecords } from '../claude/request-records.js';
import { CodexRequestRecords } from '../codex/request-records.js';

// The agents' request records as their CLIs write them (docs/TRACE.md §2.1), trimmed to the fields read.

describe('Claude Code request records', () => {
  it('keeps one prompt per shape, resolves injected tail messages, and counts the conversation ones', () => {
    const records = new ClaudeRequestRecords('main');
    const lines = [
      { type: 'api-request-blob', hash: 'h-env', message: { role: 'system', content: [{ type: 'text', text: '# Environment\nYou have been invoked…' }] } },
      { type: 'api-request-shape', shapeHash: 's1', shape: { system: [{ type: 'text', text: 'You are Claude Code.' }], tools: [{ name: 'Bash', description: 'Run a command', input_schema: { type: 'object' } }, { name: 'mcp__riffet__notify_user', description: 'Notify' }] } },
      { type: 'api-request', id: 'r1', timestamp: '2026-11-21T00:00:00.000Z', version: '2.1.322', querySource: 'repl_main_thread', shapeHash: 's1', params: { model: 'claude-opus-5-5', max_tokens: 128000 }, keep: 0, tail: ['h-env', 'h-user'] },
      { type: 'api-request', id: 'r2', timestamp: '2026-11-21T00:00:05.000Z', shapeHash: 's1', params: { model: 'claude-opus-5-5', max_tokens: 128000 }, keep: 2, tail: ['h-a', 'h-tool', 'h-late'] },
      // A blob may be written after the request that carries it.
      { type: 'api-request-blob', hash: 'h-late', message: { role: 'user', content: '<system-reminder>The user has not heard from you</system-reminder>' } },
    ];
    for (const line of lines) records.line(line);
    const result = records.result();
    expect(result).toMatchObject({ status: 'ok', backendId: 'claude', version: '2.1.322', granularity: 'request' });
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]!.tools.map((tool) => [tool.group, tool.name])).toEqual([[undefined, 'Bash'], ['riffet', 'mcp__riffet__notify_user']]);
    expect(result.requests.map((request) => [request.prompt, request.messages, request.added])).toEqual([
      ['s1', 2, ['h-env', null]],
      ['s1', 5, [null, null, 'h-late']],
    ]);
    expect(Object.keys(result.params)).toHaveLength(1);
    expect(result.context['h-env']).toMatchObject({ role: 'system', label: 'Environment' });
    expect(result.context['h-late']).toMatchObject({ role: 'user', label: 'system-reminder' });
  });

  it('answers unrecognized for a transcript without request records', () => {
    const records = new ClaudeRequestRecords('main');
    records.line({ type: 'assistant', message: { role: 'assistant', content: [] } });
    expect(records.result().status).toBe('unrecognized');
  });
});

describe('Codex request records', () => {
  it('reads the base instructions, namespaced tools, and the context each turn carries', () => {
    const records = new CodexRequestRecords('main', 'codex');
    const message = (role: string, ...texts: string[]) => ({ type: 'response_item', timestamp: '2026-11-21T00:00:00.000Z', payload: { type: 'message', role, content: texts.map((text) => ({ type: 'input_text', text })) } });
    const lines = [
      { type: 'session_meta', timestamp: '2026-11-21T00:00:00.000Z', payload: { cli_version: '0.171.0', base_instructions: { text: 'You are Codex.' } } },
      { type: 'response_item', timestamp: '2026-11-21T00:00:00.000Z', payload: { type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'exec', description: 'Run code', parameters: { type: 'object' } }] }] } },
      message('developer', 'You are Codex.'),
      message('developer', '<skills_instructions>…</skills_instructions>', '<permissions instructions>…'),
      message('user', '# AGENTS.md instructions\n<INSTRUCTIONS>…', '<environment_context><cwd>/w</cwd></environment_context>'),
      { type: 'turn_context', timestamp: '2026-11-21T00:00:01.000Z', payload: { turn_id: 't1', model: 'gpt-6.2', effort: 'xhigh', cwd: '/w' } },
      message('user', 'Look at the server'),
      { type: 'turn_context', timestamp: '2026-11-21T00:05:00.000Z', payload: { turn_id: 't2', model: 'gpt-6.2', effort: 'xhigh', cwd: '/w' } },
      message('user', 'What is in it', '<image name=[Image #1]>'),
    ];
    for (const line of lines) records.line(line);
    const result = records.result();
    expect(result).toMatchObject({ status: 'ok', backendId: 'codex', version: '0.171.0', granularity: 'turn' });
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]!.system).toEqual([{ role: 'system', text: 'You are Codex.' }]);
    expect(result.prompts[0]!.tools).toEqual([{ name: 'exec', description: 'Run code', schema: { type: 'object' }, group: 'functions' }]);
    const [first, second] = result.requests;
    expect(first).toMatchObject({ id: 't1', turnId: 't1', model: 'gpt-6.2' });
    // The base instructions echoed as a developer message are the prompt's, not context; the person's own message is conversation.
    expect(first!.added!.map((id) => id === null ? null : result.context[id]!.label)).toEqual(['skills_instructions', 'permissions', 'AGENTS.md instructions', 'environment_context', null]);
    // An attached image is the person's, not something Codex injected.
    expect(second!.added).toEqual([null, null]);
    expect(first!.params).toBe(second!.params);
  });
});
