import { describe,expect,it } from 'vitest';
import { APPEARANCE_PRUNE_MESSAGE,appearanceAssetsToKeep,isShellResponse,serviceWorkerStrategy } from './service-worker-strategy';

const ORIGIN = 'https://riffet.local';
const request = (url: string, init: { method?: string; mode?: string; accept?: string } = {}) => ({
  url: `${ORIGIN}${url}`,
  method: init.method ?? 'GET',
  ...(init.mode === undefined ? {} : { mode: init.mode }),
  ...(init.accept === undefined ? {} : { accept: init.accept }),
});

describe('serviceWorkerStrategy', () => {
  it('always bypasses /api, whatever the method or the calling context', () => {
    // The transcript and its SSE stream live under /api; a cached one would be a lie.
    expect(serviceWorkerStrategy(request('/api/bootstrap'))).toBe('bypass');
    expect(serviceWorkerStrategy(request('/api/sessions'))).toBe('bypass');
    expect(serviceWorkerStrategy(request('/api/sessions/abc/native/stream'))).toBe('bypass');
    expect(serviceWorkerStrategy(request('/api/sessions/abc/native/send', { method: 'POST' }))).toBe('bypass');
    // Only a content-addressed plugin asset is kept, and still only for a read.
    expect(serviceWorkerStrategy(request('/api/appearance/assets/riffet.appearance-paper/' + 'a'.repeat(64)))).toBe('immutable');
    expect(serviceWorkerStrategy(request('/api/appearance'))).toBe('bypass');
    expect(serviceWorkerStrategy(request('/api/appearance/assets/riffet.appearance-paper/' + 'a'.repeat(64), { method: 'POST' }))).toBe('bypass');
    // Even a navigation-shaped or event-stream-shaped request to /api stays uncached.
    expect(serviceWorkerStrategy(request('/api/sessions', { mode: 'navigate' }))).toBe('bypass');
    expect(serviceWorkerStrategy(request('/api/sessions/abc/native/stream', { accept: 'text/event-stream' }))).toBe('bypass');
    // The bare `/api` path is the same surface as `/api/...`.
    expect(serviceWorkerStrategy(request('/api'))).toBe('bypass');
  });

  it('bypasses writes, upgrades and foreign origins', () => {
    expect(serviceWorkerStrategy(request('/assets/app.js', { method: 'POST' }))).toBe('bypass');
    expect(serviceWorkerStrategy(request('/api/sessions', { mode: 'websocket' }))).toBe('bypass');
    expect(serviceWorkerStrategy({ url: 'https://example.com/asset.js', method: 'GET' }, ORIGIN)).toBe('bypass');
    expect(serviceWorkerStrategy({ url: 'not a url', method: 'GET' }, ORIGIN)).toBe('bypass');
    expect(serviceWorkerStrategy({ url: 'wss://riffet.local/api/terminals/1/ws', method: 'GET' }, ORIGIN)).toBe('bypass');
  });

  it('keeps isolated renderers out of the offline app shell cache', () => {
    expect(serviceWorkerStrategy(request('/mermaid', { mode: 'navigate' }))).toBe('bypass');
    expect(serviceWorkerStrategy(request('/diagram?engine=dot', { mode: 'navigate' }))).toBe('bypass');
    expect(serviceWorkerStrategy(request('/content-preview', { mode: 'navigate' }))).toBe('bypass');
  });
});

describe('isShellResponse', () => {

  it('refuses anything that would replace the shell with another page', () => {
    expect(isShellResponse({ ok: true, type: 'basic', contentType: 'application/json; charset=utf-8' })).toBe(false);
    expect(isShellResponse({ ok: true, type: 'basic', contentType: null })).toBe(false);
    expect(isShellResponse({ ok: false, type: 'basic', contentType: 'text/html' })).toBe(false);
    expect(isShellResponse({ ok: true, type: 'opaqueredirect', contentType: 'text/html' })).toBe(false);
  });
});

describe('appearanceAssetsToKeep', () => {
  it('keeps the listed asset paths, and ignores anything that is not a well-formed prune message', () => {
    const sha = 'a'.repeat(64);
    const keep = appearanceAssetsToKeep({ type: APPEARANCE_PRUNE_MESSAGE, urls: [`/api/appearance/assets/riffet.appearance-paper/${sha}`, '/api/sessions', 'not a url'] });
    expect([...keep!]).toEqual([`/api/appearance/assets/riffet.appearance-paper/${sha}`]);
    expect(appearanceAssetsToKeep({ type: APPEARANCE_PRUNE_MESSAGE, urls: [] })?.size).toBe(0);
    expect(appearanceAssetsToKeep({ type: 'other', urls: [] })).toBeUndefined();
    expect(appearanceAssetsToKeep({ type: APPEARANCE_PRUNE_MESSAGE })).toBeUndefined();
    expect(appearanceAssetsToKeep({ type: APPEARANCE_PRUNE_MESSAGE, urls: [1] })).toBeUndefined();
    expect(appearanceAssetsToKeep(null)).toBeUndefined();
  });
});
