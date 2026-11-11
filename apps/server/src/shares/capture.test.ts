import { describe, expect, it, vi } from 'vitest';
import type { NativeWorkbenchEvent, Run, Session, ShareSelection } from '../../../../packages/contracts/src/index.js';
import { captureShareSnapshot, shareTurnCatalog } from './capture.js';

const at = '2026-10-23T10:00:00.000Z';
const session = { id: 'session', projectId: 'project', kind: 'native', backendId: 'codex', nativeSessionId: 'thread', title: 'Shared', tags: [], mode: 'agent', state: 'running', createdAt: at, updatedAt: at } as Session;

describe('frozen share capture', () => {
  it('exports only selected response models and uses the execution owner without mixing a fallback model', async () => {
    const event = (id: string, turn: string, type: string): NativeWorkbenchEvent => ({ sequence: 1, nativeId: id, nativeTurnId: turn, sessionId: session.id, type, data: { content: { text: id }, phase: 'final_answer' }, createdAt: at });
    const events = [event('old-user', 'old', 'user_message_chunk'), event('old-answer', 'old', 'agent_message_chunk'), event('user', 'new', 'user_message_chunk'), event('answer', 'new', 'agent_message_chunk'), event('unknown-user', 'unknown', 'user_message_chunk'), event('unknown-answer', 'unknown', 'agent_message_chunk')];
    const execution = { id: 'owner', sessionId: session.id, state: 'completed', native: { nativeSessionId: 'thread', nativeTurnId: 'new', resolvedConfig: { model: 'requested[effort=high,fast=true]' } } } as Run;
    const runs = [execution,
      { ...execution, id: 'steer', native: { ...execution.native, ownerRunId: 'owner', intent: 'steer', resolvedConfig: { model: 'WRONG-steer' } } },
      { ...execution, id: 'other-chat', native: { ...execution.native, nativeSessionId: 'other-thread', resolvedConfig: { model: 'WRONG-chat' } } },
    ] as Run[];
    const transcript = { events, subagents: [], turnModels: { old: { model: 'EXCLUDED', source: 'history' }, new: { model: 'actual', source: 'history', apiKey: 'secret' } } };
    const deps = { store: { getSession: () => ({ ...session, model: 'WRONG-current' }), listRuns: () => runs }, nativeBackends: { readShareTranscript: async () => transcript } } as never;
    const snapshot = await captureShareSnapshot(deps, session.id, { selection: { mode: 'selected', turnIds: ['new', 'unknown'] } });
    expect(snapshot.modelInfo).toEqual({ answer: { model: 'actual', source: 'history' } });
    expect(JSON.stringify(snapshot)).not.toMatch(/WRONG|EXCLUDED|secret|requested/);
    transcript.turnModels.new.model = 'requested';
    expect((await captureShareSnapshot(deps, session.id)).modelInfo?.answer).toEqual({ model: 'requested', reasoningEffort: 'high', fast: true, source: 'history' });
    delete (transcript.turnModels as Record<string, unknown>).new;
    expect((await captureShareSnapshot(deps, session.id)).modelInfo?.answer).toEqual({ model: 'requested', reasoningEffort: 'high', fast: true, source: 'resolved' });
    execution.native!.resolvedConfig!.model = 'requested[fast=default]';
    expect((await captureShareSnapshot(deps, session.id)).modelInfo?.answer).toEqual({ model: 'requested', source: 'resolved' });
    Object.assign(transcript, { ambiguousModelTurns: ['new'] });
    expect((await captureShareSnapshot(deps, session.id)).modelInfo?.answer).toBeUndefined();
  });

  it('keeps reading content and receipt attachments while excluding provider and execution state', async () => {
    const events: NativeWorkbenchEvent[] = [{ sequence: 1, nativeId: 'message', sessionId: session.id, runId: 'run', type: 'user_message_chunk', data: { content: { type: 'text', text: 'Question' }, apiKey: 'secret' }, raw: { apiKey: 'secret', attachments: [{ id: 'file', name: 'x.png', token: 'secret' }] }, createdAt: at }];
    const run: Run = { id: 'run', sessionId: session.id, commandId: 'command', prompt: 'Question', state: 'running', createdAt: at, updatedAt: at, native: { input: { text: 'Question', attachmentIds: ['file'], context: [{ path: '/private/workspace' }] }, config: { mode: 'agent', model: 'private-provider' }, fingerprint: 'private-fingerprint', delivery: 'observed', attempt: 1, configRevision: 4, nativeMessageId: 'message', nativeSessionId: 'thread', terminalId: 'private-terminal', renderedText: 'private-runtime-context' } };
    const readShareTranscript = vi.fn(async () => ({ events, subagents: [], warnings: [] }));
    const snapshot = await captureShareSnapshot({ store: { getSession: () => session, listRuns: () => [run] } as never, nativeBackends: { readShareTranscript } as never }, session.id);
    expect(readShareTranscript).toHaveBeenCalledOnce();
    expect(snapshot.events[0]).toMatchObject({ nativeId: 'message', data: { attachments: [{ id: 'file', name: 'x.png' }] } });
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.subagents).toEqual([]);
    expect(readShareTranscript).toHaveBeenCalledWith(session.id, expect.objectContaining({ messagesOnly: true }));
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|private-/);
    expect(events[0]?.raw).toBeDefined();
    expect(run.native?.config.model).toBe('private-provider');
  });

  it('refuses a capture whose native conversation changed during the read', async () => {
    let current = session;
    await expect(captureShareSnapshot({ store: { getSession: () => current, listRuns: () => [] } as never, nativeBackends: { readShareTranscript: async () => { current = { ...session, nativeSessionId: 'other-thread' }; return { events: [], subagents: [] }; } } as never }, session.id)).rejects.toMatchObject({ code: 'SHARE_HISTORY_CHANGED' });
  });

  it.each(['recent', 'selected'] as const)('keeps %s turns and their referenced data without exporting unselected runs or children', async mode => {
    const event = (sequence: number, nativeTurnId: string, type: string, data: Record<string, unknown>): NativeWorkbenchEvent => ({ sequence, nativeId: `receipt-${sequence}`, nativeTurnId, sessionId: session.id, runId: nativeTurnId, type, data, createdAt: at });
    const events = [
      event(1, 'old', 'user_message_chunk', { content: { text: 'EXCLUDED question' }, attachments: [{ id: 'EXCLUDED-attachment', name: 'secret' }] }),
      event(2, 'old', 'tool_call', { toolCallId: 'EXCLUDED-tool' }),
      event(3, 'new', 'user_message_chunk', { content: { text: 'Included question' } }),
      event(4, 'new', 'tool_call', { toolCallId: 'child-tool' }),
      event(5, 'old', 'tool_call_update', { toolCallId: 'EXCLUDED-tool', rawOutput: 'EXCLUDED late result' }),
      event(6, 'new', 'agent_message_chunk', { content: { text: 'Included answer' } }),
    ];
    const runs = ['old', 'new'].map(turn => ({ id: turn, sessionId: session.id, commandId: turn, prompt: turn === 'old' ? 'EXCLUDED run' : 'Included question', state: 'completed', createdAt: at, updatedAt: at, native: { input: { text: '', attachmentIds: turn === 'old' ? ['EXCLUDED-file'] : [], context: [] }, config: { mode: '' }, fingerprint: '', delivery: 'observed', attempt: 0, configRevision: 0, nativeTurnId: turn, nativeSessionId: 'thread' } } as Run));
    const readShareTranscript = vi.fn(async () => ({ events, subagents: [
      { toolCallId: 'EXCLUDED-tool', agentId: 'EXCLUDED-agent', events: [event(1, 'child', 'agent_message_chunk', { content: { text: 'EXCLUDED child' } })] },
      { toolCallId: 'child-tool', agentId: 'child', events: [event(1, 'old', 'agent_message_chunk', { content: { text: 'EXCLUDED copied parent history' } }), event(2, 'child', 'tool_call', { toolCallId: 'nested-tool' })] },
      { toolCallId: 'nested-tool', agentId: 'nested', events: [] },
    ], jobs: [{ toolCallId: 'EXCLUDED-tool', output: 'EXCLUDED job' }], warnings: ['子 Agent EXCLUDED-agent 的历史不可用'] }));
    const deps = { store: { getSession: () => session, listRuns: () => runs } as never, nativeBackends: { readShareTranscript } as never };
    const selection: ShareSelection = mode === 'recent' ? { mode, count: 1 } : { mode, turnIds: ['new'], nativeChatId: 'thread' };
    const snapshot = await captureShareSnapshot(deps, session.id, { selection });
    expect(snapshot.events.map(event => event.sequence)).toEqual([3, 6]);
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.subagents).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain('EXCLUDED');
    expect((await shareTurnCatalog(deps, session.id)).turns.map(turn => turn.id)).toEqual(['old', 'new']);
    await expect(captureShareSnapshot(deps, session.id, { selection: { mode: 'selected', turnIds: ['absent'], nativeChatId: 'thread' } })).rejects.toMatchObject({ code: 'SHARE_SELECTION_CHANGED' });
    await expect(captureShareSnapshot(deps, session.id, { selection: { mode: 'selected', turnIds: ['new'], nativeChatId: 'other-thread' } })).rejects.toMatchObject({ code: 'SHARE_HISTORY_CHANGED' });
  });

  it('exports final answers rather than process prose, tools, reasoning or subagent histories', async () => {
    const event = (sequence: number, type: string, data: Record<string, unknown>): NativeWorkbenchEvent => ({ sequence, nativeId: `item-${sequence}`, nativeTurnId: 'turn', sessionId: session.id, type, data, createdAt: at });
    const events = [
      event(1, 'user_message_chunk', { content: { text: 'Question' } }),
      event(2, 'agent_message_chunk', { content: { text: 'PROCESS commentary without a phase' } }),
      event(3, 'tool_call', { toolCallId: 'background', rawOutput: 'PROCESS secret output', attachments: [{ id: 'PROCESS-file' }] }),
      event(4, 'agent_thought_chunk', { content: { text: 'PROCESS reasoning' } }),
      event(5, 'agent_message_chunk', { content: { text: 'The complete answer with code and images' } }),
      event(5.5, 'tool_call_update', { toolCallId: 'background', rawOutput: 'PROCESS late result' }),
      event(6, 'run_completed', {}),
      event(7, 'user_message_chunk', { content: { text: 'Next question' } }),
      event(8, 'agent_message_chunk', { phase: 'final_answer', content: { text: 'Explicit final answer' } }),
      event(9, 'share_process', {}),
      event(10, 'agent_message_chunk', { phase: 'commentary', content: { text: 'PROCESS follow-up' } }),
    ];
    const deps = { store: { getSession: () => session, listRuns: () => [] } as never, nativeBackends: { readShareTranscript: async () => ({ events, subagents: [{ toolCallId: 'tool', agentId: 'PROCESS-child', events }], jobs: [{ output: 'PROCESS job' }] }) } as never };
    const snapshot = await captureShareSnapshot(deps, session.id);
    expect(snapshot.events.map(event => event.sequence)).toEqual([1, 5, 7, 8]);
    expect(JSON.stringify(snapshot)).not.toContain('PROCESS');
    expect(snapshot.jobs).toEqual([]);
  });
});
