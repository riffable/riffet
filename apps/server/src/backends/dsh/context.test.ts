import { describe, expect, it } from 'vitest';
import { dshNativeContext, dshPromptTokens, foldDshContext, type DshContextFacts } from './context.js';

const route = (seq: number, contextWindow: unknown) => ({ type: 'request/context', seq, time: 1, data: { provider: 'deepseek-official', model: 'deepseek-v4.1-flash', contextWindow } });
const step = (seq: number, usage: unknown) => ({ type: 'assistant/message', seq, time: 2, data: { turn: 1, step: 1, message: { role: 'assistant' }, usage } });

describe('DSH context facts', () => {
  it('counts prompt-side pressure and leaves output out of it', () => {
    // The same shape DSH commits: a cached long prefix next to a small uncached remainder.
    expect(dshPromptTokens({ inputTokens: 8457, outputTokens: 7527, cacheReadTokens: 118528, cacheWriteTokens: 0, totalTokens: 134512 })).toBe(126985);
    expect(dshPromptTokens({ inputTokens: 30, outputTokens: 900 })).toBe(30);
    expect(dshPromptTokens(undefined)).toBeUndefined();
    expect(dshPromptTokens({ outputTokens: 900 })).toBeUndefined();
  });

  it('publishes nothing until both the occupancy and the window are known', () => {
    const facts: DshContextFacts = {};
    foldDshContext(facts, [step(4, { inputTokens: 100 })]);
    expect(dshNativeContext(facts)).toBeUndefined();
    foldDshContext(facts, [route(6, 1_000_000)]);
    expect(dshNativeContext(facts)).toEqual({ used: 100, size: 1_000_000, breakdown: [] });
  });

  it('keeps the newest fact when the same records are replayed or an older page arrives late', () => {
    const facts: DshContextFacts = {};
    foldDshContext(facts, [route(2, 100_000), step(3, { inputTokens: 500 }), step(5, { inputTokens: 800 })]);
    expect(dshNativeContext(facts)).toEqual({ used: 800, size: 100_000, breakdown: [] });
    // A history page read later replays older records; neither fact may go backwards.
    foldDshContext(facts, [route(1, 8_000), step(3, { inputTokens: 500 })]);
    expect(dshNativeContext(facts)).toEqual({ used: 800, size: 100_000, breakdown: [] });
  });

  it('reports the window of a model switch, not the one it replaced', () => {
    const facts: DshContextFacts = {};
    foldDshContext(facts, [route(2, 100_000), step(3, { inputTokens: 500 }), route(9, 1_000_000), step(10, { inputTokens: 1200 })]);
    expect(dshNativeContext(facts)).toEqual({ used: 1200, size: 1_000_000, breakdown: [] });
  });

  it('ignores records that carry no sequence, no window, or no accounting', () => {
    const facts: DshContextFacts = {};
    expect(foldDshContext(facts, [
      { type: 'assistant/message', data: { usage: { inputTokens: 50 } } },
      route(4, 0),
      route(5, undefined),
      { type: 'assistant/attempt', seq: 6, data: { stream: [] } },
      { type: 'assistant/message', seq: 7, data: {} },
    ])).toBe(false);
    expect(dshNativeContext(facts)).toBeUndefined();
  });

  it('lists the live session composition beside the measured occupancy, never inside it', () => {
    const facts: DshContextFacts = {};
    foldDshContext(facts, [route(2, 1_000_000), step(3, { inputTokens: 273_706 })]);
    // The three parts are the meter's own heuristic, so they do not add up to `used` — that is the
    // projection's contract, and folding them into it would be the invented number this backend
    // refuses to publish.
    expect(dshNativeContext(facts, { systemTokens: 623, toolsTokens: 4633, messageTokens: 245_877 })).toEqual({
      used: 273_706,
      size: 1_000_000,
      breakdownEstimated: true,
      breakdown: [
        { id: 'system_prompt', label: '系统提示词', tokens: 623 },
        { id: 'tools', label: '工具定义', tokens: 4633 },
        { id: 'conversation', label: '对话', tokens: 245_877 },
      ],
    });
  });

  it('drops empty parts and falls back to one bar without a composition', () => {
    const facts: DshContextFacts = {};
    foldDshContext(facts, [route(2, 1_000_000), step(3, { inputTokens: 40_000 })]);
    expect(dshNativeContext(facts, { systemTokens: 0, toolsTokens: 4633, messageTokens: 0 })?.breakdown)
      .toEqual([{ id: 'tools', label: '工具定义', tokens: 4633 }]);
    // No live projection (an offset session, or a DSH without the registry): the ratio still
    // publishes, because it is measured, and the popover draws it as a single bar.
    expect(dshNativeContext(facts)?.breakdown).toEqual([]);
  });
});
