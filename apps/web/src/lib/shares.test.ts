import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShareDraft } from '@contracts';
import { setCsrfToken } from './api';
import { shares } from './shares';

afterEach(() => { vi.unstubAllGlobals(); setCsrfToken(''); });

const draft: ShareDraft = { id: 'draft', sessionId: 'session', capturedAt: '2026-10-23T12:00:00Z', previewUrl: '/preview', warnings: [], bytes: 12 };
function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }), { headers: { 'content-type': 'application/x-ndjson' } });
}

describe('share draft stream', () => {
  it('reports progress across chunks and requires the ready result while preserving mutation authentication', async () => {
    const fetcher = vi.fn().mockResolvedValue(streamResponse(['{"type":"progress","progress":{"stage":"history"}}\n{"ty', `pe":"ready","draft":${JSON.stringify(draft)}}`]));
    vi.stubGlobal('fetch', fetcher);
    setCsrfToken('csrf');
    const progress = vi.fn();
    const controller = new AbortController();
    const selection = { mode: 'selected' as const, turnIds: ['turn-1'], nativeChatId: 'native-chat' };
    const appearance = { themeId: 'custom-example-theme', mode: 'dark' as const, themeRevision: 'library-revision' };
    await expect(shares.draft('session', progress, controller.signal, selection, appearance)).resolves.toEqual(draft);
    expect(progress).toHaveBeenCalledWith({ stage: 'history' });
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf');
    expect(init.credentials).toBe('same-origin');
    expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(init.body as string)).toEqual({ selection, appearance });
  });

  it('rejects an interrupted stream instead of accepting progress as a completed draft', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(['{"type":"progress","progress":{"stage":"history"}}\n'])));
    await expect(shares.draft('session')).rejects.toThrow('预览连接已中断');
  });

  it('prepares local print drafts through the authenticated print route with the selected content and appearance', async () => {
    const fetcher = vi.fn().mockResolvedValue(streamResponse([`{"type":"progress","progress":{"stage":"history"}}\n{"type":"ready","draft":${JSON.stringify(draft)}}\n`]));
    vi.stubGlobal('fetch', fetcher);
    setCsrfToken('csrf');
    const controller = new AbortController();
    const progress = vi.fn();
    const selection = { mode: 'recent' as const, count: 5 };
    const appearance = { themeId: 'riffet', mode: 'light' as const };
    await expect(shares.printDraft('session/id', progress, controller.signal, selection, appearance)).resolves.toEqual(draft);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe('/api/sessions/session%2Fid/share/print');
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf');
    expect(init.credentials).toBe('same-origin');
    expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(init.body as string)).toEqual({ selection, appearance });
    expect(progress).toHaveBeenCalledWith({ stage: 'history' });
  });

  it('rejects a server failure sent after stream headers', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(streamResponse(['{"type":"error","message":"登录已过期"}\n']))
      .mockResolvedValueOnce(streamResponse(['{"type":"error","message":"Switch account","messageRef":{"code":"SHARE_ACCOUNT_CHANGED","params":{"reason":"switch","username":"publisher"}}}\n'])));
    await expect(shares.draft('session')).rejects.toThrow('登录已过期');
    await expect(shares.draft('session')).rejects.toMatchObject({ code: 'SHARE_ACCOUNT_CHANGED', params: { reason: 'switch', username: 'publisher' } });
  });

  it('keeps abort errors available to callers and accepts legacy JSON responses', async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = new DOMException('Aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(aborted).mockResolvedValueOnce(new Response(JSON.stringify(draft), { headers: { 'content-type': 'application/json' } })));
    await expect(shares.draft('session', undefined, controller.signal)).rejects.toBe(aborted);
    await expect(shares.draft('session')).resolves.toEqual(draft);
  });

  it('fetches the turn catalog with the caller cancellation signal', async () => {
    const catalog = { turns: [{ id: 'turn-1', text: 'Question', createdAt: '2026-10-23T12:00:00Z' }], nativeChatId: 'native-chat' };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    await expect(shares.turns('session/id', controller.signal)).resolves.toEqual(catalog);
    expect(fetcher.mock.calls[0]![0]).toBe('/api/sessions/session%2Fid/share/turns');
    expect((fetcher.mock.calls[0]![1] as RequestInit).signal).toBe(controller.signal);
  });
});
