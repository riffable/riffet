import { describe, expect, it, vi } from 'vitest';
import { Store } from '../store.js';
import { CouncilService } from './service.js';
import { extractStreamingField, parseJsonObject, splitDocumentParagraphs } from './prompts.js';

const listBackendProfiles = (backendId: string) => {
  if (backendId === 'claude') return [{ id: 'p1', name: 'Claude Code', isDefault: true }];
  if (backendId === 'codex') return [{ id: 'codex-cli', name: 'Codex CLI', isDefault: true }, { id: 'custom-relay', name: 'custom-relay' }];
  if (backendId === 'dsh') return [{ id: 'p3', name: 'DeepSeek Harness', isDefault: true }];
  if (backendId === 'cursor') return [{ id: 'cursor-cli', name: 'Cursor CLI', isDefault: true }];
  return [];
};

describe('CouncilService', () => {
  it('parses fenced JSON, extracts partial streaming fields, and splits document paragraphs cleanly', () => {
    expect(parseJsonObject('Some intro\n```json\n{"a": 1}\n```\ntrailing')).toEqual({ a: 1 });
    expect(extractStreamingField('```json\n{"claim":"x","argument":"Hello\\nWorld')).toBe('Hello\nWorld');
    expect(extractStreamingField('Plain prose streaming')).toBe('Plain prose streaming');
    expect(splitDocumentParagraphs('First paragraph.\n\nSecond paragraph.')).toEqual([
      { id: 'P1', text: 'First paragraph.' },
      { id: 'P2', text: 'Second paragraph.' },
    ]);
  });

  it('supports multi-side multi-model debate, dynamic rounds, host steer, conclude, and export', async () => {
    const store = new Store(':memory:');
    const createWorkItem = vi.fn(() => 'wi-1');
    const openSession = vi.fn(async () => 'sess-1');
    const runAgentTurn = vi.fn(async (req: { prompt: string }) => {
      if (req.prompt.includes('当前轮次：第 1 轮')) {
        return { text: JSON.stringify({ claim: 'R1 claim', argument: 'R1 arg', questionTarget: '反方', questionSummary: 'Q1', question: 'Why?' }), inputTokens: 10, outputTokens: 20 };
      }
      if (req.prompt.includes('当前轮次：第 2 轮')) {
        return { text: JSON.stringify({ reply: 'Answering Q1', replyStatus: 'direct', claim: 'R2 claim', weakness: 'Sync lag', argument: 'R2 arg', questionSummary: 'Q2', question: 'How?' }), inputTokens: 12, outputTokens: 22 };
      }
      if (req.prompt.includes('技术方案评委')) {
        return { text: JSON.stringify({ winner: '折中方案更稳妥', takeaway: 'Adopt modular tables.' }), inputTokens: 8, outputTokens: 12 };
      }
      return { text: 'Host follow-up reply', inputTokens: 5, outputTokens: 5 };
    });

    const service = new CouncilService({
      db: store.db,
      listBackendProfiles,
      runAgentTurn,
      exports: { createWorkItem, openSession },
    });

    const created = await service.create({
      mode: 'debate',
      topic: 'Separate tables vs NativeSession',
      rhythm: 'pause',
      sides: [
        { id: 'pro', label: '正方', models: [{ backendId: 'claude', profileId: 'p1', model: 'claude-opus-4.8' }, { backendId: 'dsh', profileId: 'p3', model: 'deepseek-v4-pro' }] },
        { id: 'con', label: '反方', models: [{ backendId: 'codex', profileId: 'codex-cli', model: 'gpt-6.2-sol' }] },
        { id: 'side-3', label: '折中派', models: [{ backendId: 'cursor', profileId: 'cursor-cli', model: 'claude-sonnet' }] },
      ],
      judgeModel: { backendId: 'cursor', profileId: 'cursor-cli', model: 'claude-sonnet' },
    });
    expect(created.status).toBe('paused');
    expect(created.debate!.sides).toHaveLength(3);

    // Round 1
    await service.advance(created.id, 'next-round');
    await vi.waitFor(() => {
      expect(service.get(created.id).status).toBe('paused');
    });
    expect(service.get(created.id).debate?.rounds).toHaveLength(1);
    expect(service.get(created.id).debate?.rounds[0]?.turns).toHaveLength(4);

    // Round 2
    await service.advance(created.id, 'next-round');
    await vi.waitFor(() => {
      expect(service.get(created.id).status).toBe('paused');
    });
    expect(service.get(created.id).debate?.rounds).toHaveLength(2);

    // Host follow-up
    const steered = await service.steer(created.id, 'What about mobile?');
    expect(steered.debate?.hostTurns).toHaveLength(1);
    expect(steered.debate?.hostTurns[0]?.replies).toHaveLength(4);

    // Conclude
    await service.advance(created.id, 'conclude');
    await vi.waitFor(() => {
      expect(service.get(created.id).status).toBe('done');
    });
    expect(service.get(created.id).debate?.verdict?.winner).toBe('折中方案更稳妥');

    const exported = await service.exportDiscussion(created.id, { kind: 'task', body: 'Do it' });
    expect(exported).toEqual({ kind: 'task', id: 'wi-1' });
    expect(createWorkItem).toHaveBeenCalledTimes(1);

    service.close();
    store.close();
  });

  it('runs prism pause -> deepen -> verdict with exact selected agents and profiles', async () => {
    const store = new Store(':memory:');
    const runAgentTurn = vi.fn(async (req: { prompt: string }) => {
      if (req.prompt.includes('独立思考的技术顾问')) {
        return { text: JSON.stringify({ stance: 'No bus', thought: 'Keep isolated', text: 'Do not push events across projects.' }), outputTokens: 10 };
      }
      if (req.prompt.includes('冷静的分析者')) {
        return {
          text: JSON.stringify({
            contradictions: [{ title: 'Scope leak', leftModelId: 'codex:codex-cli:gpt-6.2-sol', leftQuote: 'Do not push', rightModelId: 'cursor:cursor-cli:claude-sonnet', rightQuote: 'events across', question: 'Is metadata safe?' }],
            gaps: ['RPC overhead'],
          }),
          outputTokens: 10,
        };
      }
      if (req.prompt.includes('本轮必须回应的追问')) {
        return { text: JSON.stringify({ shifted: true, newStance: 'Pull API', challenge: 'Scope leak', text: 'Switch to pull API.' }), outputTokens: 10 };
      }
      return { text: JSON.stringify({ headline: 'Use on-demand pull API', analysis: '1. Query on demand.' }), outputTokens: 10 };
    });

    const service = new CouncilService({
      db: store.db,
      listBackendProfiles,
      runAgentTurn,
    });

    const created = await service.create({
      mode: 'prism',
      topic: 'Cross-session events',
      rhythm: 'pause',
      participants: [
        { backendId: 'codex', profileId: 'codex-cli', model: 'gpt-6.2-sol' },
        { backendId: 'cursor', profileId: 'cursor-cli', model: 'claude-sonnet' },
      ],
      observerModel: { backendId: 'codex', profileId: 'custom-relay', model: 'deepseek-v4-pro' },
    });
    await vi.waitFor(() => {
      expect(service.get(created.id).status).toBe('paused');
    });

    await service.advance(created.id);
    await vi.waitFor(() => {
      expect(service.get(created.id).status).toBe('done');
    });

    expect(service.get(created.id).prism?.verdict?.headline).toBe('Use on-demand pull API');
    expect(runAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'codex',
      profileId: 'custom-relay',
      model: 'deepseek-v4-pro',
    }));

    service.close();
    store.close();
  });
});
