import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMember, AgentMention, ModelInfo, NativeBackendCapabilities, NativeBackendCatalogEntry, Run, Session } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { Store } from '../store.js';
import { AgentCallService } from './service.js';

const CODEX: NativeBackendCatalogEntry = {
  backendId: 'codex', label: 'Codex', available: true, models: [],
  profiles: [{ id: 'default', backendId: 'codex', name: 'Default', isDefault: true }, { id: 'work', backendId: 'codex', name: 'Work', isDefault: false }],
  capabilities: { consultPermission: 'read-only' } as NativeBackendCapabilities,
};
const select = (id: string, category: string, currentValue: string, values: string[]) => ({ id, name: id, category, type: 'select' as const, currentValue, options: values.map(value => ({ value, name: value })) });
const MODELS: ModelInfo[] = [{
  value: 'gpt-5.5', name: 'GPT-5.5',
  configOptions: [select('effort', 'thought_level', 'medium', ['low', 'medium', 'high']), select('fast', 'model_config', 'false', ['false', 'true'])],
}];

const text = (value: string) => ({ text: value, attachmentIds: [], context: [] });

/** A server's worth of calls over an in-memory store; turns end when the test says so, with the answer it gives. */
function harness(members: AgentMember[] = []) {
  const store = new Store(':memory:');
  const project = store.createProject('/tmp/agent-calls', 'Example');
  const answers = new Map<string, string>();
  const messages: Array<{ sessionId: string; text: string; commandId: string }> = [];
  const service = new AgentCallService({
    store,
    team: () => ({ list: () => members, find: id => members.find(item => item.id === id) }),
    timeline: {
      ready: async () => ({ generation: 'g', headSeq: 0 }),
      outline: sessionId => ({ generation: 'g', turnCount: 0, turns: store.listRuns(sessionId).map(run => ({ turn: run.id, turnId: run.id, startPos: 0, status: 'completed' as const, at: run.createdAt, rows: 0, runId: run.id })) }),
      turnText: (_sessionId, turn) => answers.has(turn) ? { question: '', answer: answers.get(turn)! } : undefined,
      page: () => ({ generation: 'g', rows: [], hasBefore: false, hasAfter: false }),
    },
    orchestration: {
      async start(body, first, origin, ids) {
        return store.createNativeSubmission(ids.sessionId, {
          projectId: body.projectId!, title: body.title, backendId: body.backendId as 'codex', origin,
          ...(body.agentMemberId ? { agentMemberId: body.agentMemberId } : {}),
          ...(body.backendProfileId ? { backendProfileId: body.backendProfileId } : {}), ...(body.model ? { model: body.model } : {}), ...(body.approval ? { approval: body.approval } : {}),
        }, ids.commandId, text(first)).session;
      },
      message(sessionId, body, commandId) {
        messages.push({ sessionId, text: body, commandId });
        return store.acceptNativeRun(sessionId, commandId, text(body), { mode: 'default' });
      },
    },
    agents: async () => [CODEX],
    capabilities: async () => CODEX.capabilities,
    catalog: async () => ({ ...CODEX, models: MODELS, defaultModel: 'gpt-5.5' }),
    usage: async () => undefined,
    worktree: async () => { throw new AppError('NO_WORKTREE', 'not in this test'); },
    cancel: (_sessionId, runId) => { store.updateRun(runId, { state: 'cancelled' }); },
    notify: () => {},
    label: backendId => backendId === 'codex' ? 'Codex' : backendId,
  });
  /** A conversation of the owner's whose first message mentions `agents`; its turn has ended. */
  const caller = (agents?: AgentMention[], agentMemberId?: string): Session => {
    const { session, run } = store.createNativeSubmission(crypto.randomUUID(), { projectId: project.id, title: 'Caller', backendId: 'claude', ...(agentMemberId ? { agentMemberId } : {}) }, crypto.randomUUID(), { ...text('look at this'), ...(agents ? { agents } : {}) });
    store.updateRun(run.id, { state: 'completed' });
    return store.updateSession(session.id, { state: 'idle' });
  };
  const finish = (run: Pick<Run, 'id'>, answer: string) => { answers.set(run.id, answer); store.updateRun(run.id, { state: 'completed' }); };
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  return { store, project, service, caller, finish, settle, messages };
}

let open: ReturnType<typeof harness> | undefined;
afterEach(() => { open?.service.close(); open = undefined; });

describe('AgentCallService', () => {
  it('calls only an Agent the owner mentioned, in a conversation of its own that the caller cannot be called back from', async () => {
    const h = open = harness();
    const stranger = h.caller();
    await expect(h.service.agentCall(stranger, { agent: 'codex', prompt: 'review', wait: 0 })).rejects.toMatchObject({ code: 'AGENT_NOT_ALLOWED' });

    const caller = h.caller([{ backendId: 'codex' }]);
    const result = await h.service.agentCall(caller, { agent: 'codex', prompt: 'review the diff', wait: 0 });
    expect(result).toMatchObject({ agent: 'Codex', state: 'working' });
    const called = h.store.getSession(result.call);
    expect(called.origin).toMatchObject({ kind: 'call', sessionId: caller.id });
    expect(called.approval).toBe('read-only');
    // Depth 1: the called conversation cannot call further.
    await expect(h.service.agentCall(called, { agent: 'codex', prompt: 'again', wait: 0 })).rejects.toMatchObject({ code: 'TOOL_NOT_AVAILABLE' });
  });

  it('runs on what the owner picked for the Agent, else on the model and parameters the caller chose from its catalog', async () => {
    const h = open = harness();
    const picked = h.caller([{ backendId: 'codex', backendProfileId: 'work', model: 'gpt-5.5[effort=low]' }]);
    const first = await h.service.agentCall(picked, { agent: 'codex', prompt: 'review', model: 'gpt-5.5', params: { effort: 'high' }, wait: 0 });
    expect(h.store.getSession(first.call)).toMatchObject({ backendProfileId: 'work', model: 'gpt-5.5[effort=low]' });
    expect(first.note).toContain('not used');
    await expect(h.service.agentCall(picked, { agent: 'codex/default', prompt: 'review', wait: 0 })).rejects.toMatchObject({ code: 'AGENT_NOT_ALLOWED' });

    const free = h.caller([{ backendId: 'codex' }]);
    await expect(h.service.agentCall(free, { agent: 'codex', prompt: 'review', params: { effort: 'extreme' }, wait: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const chosen = await h.service.agentCall(free, { agent: 'codex/work', prompt: 'review', params: { effort: 'high' }, wait: 0 });
    expect(h.store.getSession(chosen.call)).toMatchObject({ backendProfileId: 'work', model: 'gpt-5.5[effort=high,fast=false]' });
  });

  it('hands an answer back once: as a message when the caller stopped waiting, never again after', async () => {
    const h = open = harness();
    const caller = h.caller([{ backendId: 'codex' }]);
    const result = await h.service.agentCall(caller, { agent: 'codex', prompt: 'review the diff', wait: 0 });
    const run = h.store.listRuns(result.call)[0]!;
    h.finish(run, 'Looks fine.');
    await h.settle();
    const delivered = h.messages.filter(item => item.sessionId === caller.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.commandId).toBe(`call-${run.id}`);
    expect(delivered[0]!.text).toContain('Looks fine.');
    // The caller's new turn ends and the stores change again: nothing more is sent.
    h.store.updateRun(h.store.listRuns(caller.id).at(-1)!.id, { state: 'completed' });
    await h.settle();
    expect(h.messages.filter(item => item.sessionId === caller.id)).toHaveLength(1);
  });

  it('opens a check on behalf of a conversation that is listed under it and never handed back to it', async () => {
    const h = open = harness();
    const caller = h.caller();
    const { sessionId, runId } = await h.service.consultFor(caller.id, { backendId: 'codex' }, 'Check task #1', 'Check the work');
    expect(h.store.getSession(sessionId)).toMatchObject({ origin: { kind: 'call', sessionId: caller.id }, approval: 'read-only' });
    expect(h.service.list(caller.id).map(call => call.id)).toEqual([sessionId]);
    // Out of the caller's own reach.
    await expect(h.service.agentWait(caller, { call: sessionId, wait: 0 })).rejects.toMatchObject({ code: 'CALL_NOT_FOUND' });
    h.finish({ id: runId }, '结论：通过');
    await h.settle();
    expect(await h.service.answerOf(sessionId, runId)).toBe('结论：通过');
    expect(h.messages).toHaveLength(0);
  });

  it('sends nothing for an answer the caller took with agent_wait', async () => {
    const h = open = harness();
    const caller = h.caller([{ backendId: 'codex' }]);
    const result = await h.service.agentCall(caller, { agent: 'codex', prompt: 'review the diff', wait: 0 });
    const run = h.store.listRuns(result.call)[0]!;
    // The caller is busy with its own turn, so the answer waits for it to be idle.
    h.store.updateSession(caller.id, { state: 'running' });
    h.finish(run, 'Looks fine.');
    await expect(h.service.agentWait(caller, { call: result.call, wait: 1 })).resolves.toMatchObject({ state: 'completed', answer: 'Looks fine.' });
    h.store.updateSession(caller.id, { state: 'idle' });
    await h.settle();
    expect(h.messages.filter(item => item.sessionId === caller.id)).toHaveLength(0);
  });

  it('stops the turn a caller waits on when the caller is stopped, and sends nothing for it', async () => {
    const h = open = harness();
    const caller = h.caller([{ backendId: 'codex' }]);
    // The caller's own turn is running and its tool call waits; Esc ends the turn but not the tool call.
    const own = h.store.acceptNativeRun(caller.id, crypto.randomUUID(), text('ask codex'), { mode: 'default' });
    h.store.updateRun(own.id, { state: 'running' });
    h.store.updateSession(caller.id, { state: 'running' });
    const waiting = h.service.agentCall(caller, { agent: 'codex', prompt: 'review the diff', wait: 30 });
    await h.settle();
    h.store.updateRun(own.id, { state: 'cancelled' });
    const result = await waiting;
    expect(result.state).toBe('cancelled');
    expect(h.store.listRuns(result.call)[0]!.state).toBe('cancelled');
    h.store.updateSession(caller.id, { state: 'idle' });
    await h.settle();
    expect(h.messages.filter(item => item.sessionId === caller.id)).toHaveLength(0);
  });

  it('answers agent_stop on a turn that already ended instead of dropping its answer', async () => {
    const h = open = harness();
    const caller = h.caller([{ backendId: 'codex' }]);
    const result = await h.service.agentCall(caller, { agent: 'codex', prompt: 'review the diff', wait: 0 });
    h.store.updateSession(caller.id, { state: 'running' });
    h.finish(h.store.listRuns(result.call)[0]!, 'Looks fine.');
    await expect(h.service.agentStop(caller, { call: result.call })).resolves.toMatchObject({ state: 'completed', answer: 'Looks fine.' });
    h.store.updateSession(caller.id, { state: 'idle' });
    await h.settle();
    expect(h.messages.filter(item => item.sessionId === caller.id)).toHaveLength(0);
  });

  it('calls team members with explicit @mention even without memberCalls, routes project scope, blocks self-call and enforces autonomous memberCalls', async () => {
    const members: AgentMember[] = [];
    const h = open = harness(members);
    const releaseProject = h.store.createProject('/tmp/arch-agent', 'ArchAgent');
    const now = new Date().toISOString();
    const baseCaps = { workspace: true, taskBoard: false, delegations: false, memberCalls: false, externalTools: false, workbenchAdmin: false };
    members.push(
      { id: 'default', name: '个人助理', scope: { kind: 'global' }, sessionMode: 'continuous', projectId: h.project.id, capabilities: { ...baseCaps, memberCalls: true }, memory: { consolidation: true }, budget: { dailyRuns: 24 }, createdAt: now, updatedAt: now },
      { id: 'release', name: 'ArchAgent 发版', description: '负责发版与打包', scope: { kind: 'project', projectIds: [releaseProject.id] }, sessionMode: 'fresh', projectId: releaseProject.id, target: { backendId: 'codex', profileId: 'work', model: 'gpt-5.5[effort=high]' }, capabilities: { ...baseCaps, workspace: false }, memory: { consolidation: true }, budget: { dailyRuns: 24 }, createdAt: now, updatedAt: now },
      { id: 'finance', name: '投资理财', scope: { kind: 'personal' }, sessionMode: 'continuous', projectId: h.project.id, capabilities: { ...baseCaps, memberCalls: false }, memory: { consolidation: true }, budget: { dailyRuns: 24 }, createdAt: now, updatedAt: now },
    );

    // Autonomous member without `memberCalls` cannot call another member without explicit `@`.
    const financeNoMention = h.caller(undefined, 'finance');
    await expect(h.service.agentCall(financeNoMention, { agent: 'member/release', prompt: 'status', wait: 0 })).rejects.toMatchObject({ code: 'AGENT_NOT_ALLOWED' });

    // Explicit user `@member` authorizes the call even when caller member has `memberCalls: false`.
    const financeMentioned = h.caller([{ backendId: 'codex', memberId: 'release', label: 'ArchAgent 发版' }], 'finance');
    const call = await h.service.agentCall(financeMentioned, { agent: 'member/release', prompt: '发版状态如何', wait: 0 });
    expect(call).toMatchObject({ agent: 'ArchAgent 发版', state: 'working' });
    const calledSession = h.store.getSession(call.call);
    expect(calledSession).toMatchObject({
      projectId: releaseProject.id,
      agentMemberId: 'release',
      backendProfileId: 'work',
      model: 'gpt-5.5[effort=high]',
      origin: { kind: 'call', sessionId: financeMentioned.id },
    });
    expect(h.service.list(financeMentioned.id)[0]).toMatchObject({ memberId: 'release', memberName: 'ArchAgent 发版' });
    // Project member without `workspace` capability rejects `work` mode.
    await expect(h.service.agentCall(financeMentioned, { agent: 'member/release', prompt: '改文件', mode: 'work', wait: 0 })).rejects.toMatchObject({ code: 'WORKSPACE_DISABLED' });

    // Member with `memberCalls: true` lists peers (excluding itself) and can call autonomously, but never itself.
    const chief = h.caller(undefined, 'default');
    const listed = await h.service.agentList(chief);
    const listedAgents = (listed.agents as Array<{ agent: string }>).map(item => item.agent);
    expect(listedAgents).toContain('member/release');
    expect(listedAgents).toContain('member/finance');
    expect(listedAgents).not.toContain('member/default');
    await expect(h.service.agentCall(chief, { agent: 'member/default', prompt: 'self', wait: 0 })).rejects.toMatchObject({ code: 'AGENT_NOT_ALLOWED' });
  });
});
