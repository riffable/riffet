import { expect, it, vi } from 'vitest';

it('keeps the browser navigation and its private workbench document intact under service-worker control', async () => {
  const worker = new EventTarget();
  const enable = vi.fn().mockResolvedValue(undefined);
  const cache = { keys: async () => [], open: vi.fn() };
  const fetch = vi.fn();
  vi.stubGlobal('self', Object.assign(worker, {
    location: { origin: 'http://127.0.0.1' },
    registration: { navigationPreload: { enable } },
    clients: { claim: async () => {} },
  }));
  vi.stubGlobal('caches', cache);
  vi.stubGlobal('fetch', fetch);
  try {
    await import('./sw');
    const waitUntil = vi.fn();
    worker.dispatchEvent(Object.assign(new Event('activate'), { waitUntil }));
    await waitUntil.mock.calls[0]![0];
    expect(enable).toHaveBeenCalledOnce();

    const document = new Response('<html></html>', { headers: {
      'Content-Type': 'text/html', 'Cache-Control': 'private, no-store', 'Cross-Origin-Opener-Policy': 'same-origin',
    } });
    const respondWith = vi.fn();
    worker.dispatchEvent(Object.assign(new Event('fetch'), {
      request: { url: 'http://127.0.0.1/c/assistant', method: 'GET', mode: 'navigate', headers: new Headers() },
      preloadResponse: Promise.resolve(document), waitUntil, respondWith,
    }));
    await expect(respondWith.mock.calls[0]![0]).resolves.toBe(document);
    expect(fetch).not.toHaveBeenCalled();
    expect(cache.open).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
