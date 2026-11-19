import { describe, expect, it } from 'vitest';
import type { PluginHost } from '@riffet/plugin-api';
import { Translator } from './translator.js';

const error: PluginHost['error'] = (code, message, statusCode) =>
  Object.assign(new Error(message), { code, statusCode });

describe('Translator', () => {
  it('reuses cached pieces on retry and only aborts a shared piece call when all callers abort', async () => {
    let calls = 0;
    let secondCallCount = 0;
    const translator = new Translator({
      id: 'riffet.translate',
      stateDir: async () => '/tmp',
      settings: () => ({ target: 'en' }),
      secrets: { get: () => undefined, set: async () => undefined },
      runProcess: async () => ({ stdout: '', stderr: '', code: 0, timedOut: false, truncated: false }),
      resolveCli: () => undefined,
      gateway: {} as never,
      invalidateModelCatalogs: () => undefined,
      modelSourceInUse: () => false,
      models: {
        complete: async ({ content, signal }) => {
          calls += 1;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, content.startsWith('P1') ? 5 : 15);
            signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
          });
          if (content.startsWith('P2')) {
            secondCallCount += 1;
            if (secondCallCount === 1) throw error('PLUGIN_MODEL_TIMEOUT', 'The model timed out', 504);
          }
          return `EN:${content.slice(0, 2)}`;
        },
      },
      error,
    });
    const longFirst = `P1 ${'a'.repeat(6_100)}`;
    const message = { role: 'assistant' as const, text: `${longFirst}\n\nP2 second piece` };
    await expect(translator.run({ args: {}, message, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'PLUGIN_MODEL_TIMEOUT' });
    expect(calls).toBe(2);
    // Retrying the same message reuses P1 from the piece cache and only calls the model for P2.
    await expect(translator.run({ args: {}, message, signal: new AbortController().signal })).resolves.toEqual({
      kind: 'text',
      text: 'EN:P1\n\nEN:P2',
      title: { 'zh-Hans': '译文', en: 'Translation' },
    });
    expect(calls).toBe(3);

    // Aborting one caller while another waits on the same piece keeps the second caller alive.
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const fresh = { role: 'assistant' as const, text: 'P3 concurrent piece' };
    const p1 = translator.run({ args: {}, message: fresh, signal: firstAbort.signal });
    const p2 = translator.run({ args: {}, message: fresh, signal: secondAbort.signal });
    firstAbort.abort(new Error('closed'));
    await expect(p1).rejects.toThrow('closed');
    await expect(p2).resolves.toMatchObject({ kind: 'text', text: 'EN:P3' });
  });

  it('streams pieces in order even when a later concurrent piece finishes first', async () => {
    const deltas: string[] = [];
    const translator = new Translator({
      id: 'riffet.translate',
      stateDir: async () => '/tmp',
      settings: () => ({ target: 'en' }),
      secrets: { get: () => undefined, set: async () => undefined },
      runProcess: async () => ({ stdout: '', stderr: '', code: 0, timedOut: false, truncated: false }),
      resolveCli: () => undefined,
      gateway: {} as never,
      invalidateModelCatalogs: () => undefined,
      modelSourceInUse: () => false,
      models: {
        complete: async () => '',
        stream: async ({ content, onDelta }) => {
          if (content.startsWith('P1')) {
            await new Promise(resolve => setTimeout(resolve, 25));
            onDelta('First ');
            onDelta('part');
            return 'First part';
          }
          await new Promise(resolve => setTimeout(resolve, 5));
          onDelta('Second part');
          return 'Second part';
        },
      },
      error,
    });
    const text = `P1 ${'a'.repeat(6_100)}\n\nP2 tail`;
    const result = await translator.run({
      args: {},
      message: { role: 'assistant', text },
      signal: new AbortController().signal,
      onTextDelta: delta => deltas.push(delta),
    });
    expect(result).toEqual({ kind: 'text', text: 'First part\n\nSecond part', title: { 'zh-Hans': '译文', en: 'Translation' } });
    expect(deltas.join('')).toBe('First part\n\nSecond part');

    // A full cache hit returns directly without re-streaming.
    const cachedDeltas: string[] = [];
    await expect(translator.run({
      args: {},
      message: { role: 'assistant', text },
      signal: new AbortController().signal,
      onTextDelta: delta => cachedDeltas.push(delta),
    })).resolves.toEqual(result);
    expect(cachedDeltas).toEqual([]);
  });
});
