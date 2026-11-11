import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { api,HttpError,listNativeSendRequests,nativeSteerInput,removeNativeSendRequest,saveNativeSendRequest,submitNativeSendRequest,type NativeSendOutboxEntry } from './api';
import { migrateNativeOutbox } from './native-outbox-storage';
import { isUncertainRequest } from '../app/session/nativeOutbox';

const target = { nativeSessionId: 'original-thread', turnId: 'original-turn' };
const entry = (): NativeSendOutboxEntry => ({ sessionId: 's1', body: { commandId: 'c1', text: 'retain the current tool', attachments: [{ id: 'attachment' }], context: [{ path: 'src/a.ts', line: 12 }] }, createdAt: '2026-10-16T01:00:00Z', version: 2, steerTarget: { ...target } });

beforeEach(() => {
  const values = new Map<string, string>();
  const persistent = new Map<string, string>();
  vi.stubGlobal('localStorage', { get length() { return persistent.size; }, key: (index: number) => [...persistent.keys()][index] ?? null, getItem: (key: string) => persistent.get(key) ?? null, setItem: (key: string, value: string) => persistent.set(key, value), removeItem: (key: string) => persistent.delete(key) });
  vi.stubGlobal('sessionStorage', { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, setItem: (key: string, value: string) => values.set(key, value), getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => values.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());

describe('steer outbox and transport', () => {
  it('isolates steering from old scanners while merging both outbox formats', () => {
    saveNativeSendRequest({ sessionId: 's1', body: { commandId: 'normal', text: 'next turn', expectedConfigRevision: 8 }, createdAt: '2026-10-16T00:00:00Z' });
    saveNativeSendRequest(entry());
    expect(localStorage.key(1)).toBe('riffet.outbox.v1.riffet.native-steer.v2.s1.c1');
    expect([...Array(localStorage.length)].map((_, index) => localStorage.key(index)).filter(key => key?.startsWith('riffet.outbox.v1.riffet.native-send.'))).toEqual(['riffet.outbox.v1.riffet.native-send.s1.normal']);
    expect(listNativeSendRequests('s1').map(item => item.body.commandId)).toEqual(['normal', 'c1']);
    expect(listNativeSendRequests('other-session')).toEqual([]);
    removeNativeSendRequest('s1', 'c1');
    expect(listNativeSendRequests('s1').map(item => item.body.commandId)).toEqual(['normal']);
  });

  it('keeps a reference preflight failure definitive before any submission is sent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } })));
    await api.logout();
    const saved = { ...entry(), body: { ...entry().body, references: [{ kind: 'session' as const, sessionId: 'source' }] } };
    const fetcher = vi.fn().mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetcher);
    saveNativeSendRequest(saved);
    const failure = await submitNativeSendRequest(saved).catch(error => error);
    expect(failure).toMatchObject({ code: 'REFERENCE_PREFLIGHT_FAILED', details: { accepted: false } });
    expect(isUncertainRequest(failure)).toBe(false);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/bootstrap']);
    expect(listNativeSendRequests('s1')[0]?.body).toEqual(saved.body);
  });

  it('preserves session references through durable steering retry without sending display metadata', async () => {
    const saved: NativeSendOutboxEntry = { ...entry(), body: { ...entry().body, references: [{ kind: 'session', sessionId: 'source', fromRunId: 'previous-run' }] } };
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }));
    // Negotiation occurs once at the transport boundary, including after restoring an outbox.
    vi.stubGlobal('fetch', fetcher);
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: '', protocol: { version: 3, features: ['session-references-v1'] } }), { headers: { 'content-type': 'application/json' } }));
    saveNativeSendRequest(saved);
    await submitNativeSendRequest(listNativeSendRequests('s1')[0]!);
    const call = fetcher.mock.calls.find(([path]) => path === '/api/sessions/s1/native/steer');
    expect(JSON.parse(call?.[1].body).references).toEqual(saved.body.references);
    expect(listNativeSendRequests('s1')[0]?.body.references).toEqual(saved.body.references);
  });

  it('rejects ambiguous, incomplete or configuration-bearing records before network side effects', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (const invalid of [ { ...entry(), mode: 'interrupt' as const }, { ...entry(), version: undefined }, { ...entry(), steerTarget: undefined }, { ...entry(), body: { ...entry().body, expectedConfigRevision: 4 } } ]) {
      expect(() => nativeSteerInput(invalid)).toThrow();
      expect(() => saveNativeSendRequest(invalid)).toThrow();
    }
    sessionStorage.setItem('riffet.native-steer.v2.s1.c1', JSON.stringify({ ...entry(), steerTarget: undefined }));
    const invalid = listNativeSendRequests('s1')[0]!;
    expect(invalid.invalidReason).toBeTruthy();
    await expect(submitNativeSendRequest(invalid)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps the exact action across tab closure and migrates without sending', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    sessionStorage.setItem('riffet.native-steer.v2.s1.c1', JSON.stringify(entry()));
    migrateNativeOutbox();
    expect(sessionStorage.length).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    // A new tab has no legacy tab-local storage; the persisted command and target still exist.
    vi.stubGlobal('sessionStorage', { length: 0, key: () => null, getItem: () => null, removeItem: () => {} });
    const restored = listNativeSendRequests('s1')[0]!;
    expect(restored).toEqual(entry());
    await submitNativeSendRequest(restored);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/sessions/s1/native/steer');
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toEqual(nativeSteerInput(entry()));
  });

  it('refuses conflicting command content and retains both migration candidates for diagnosis', () => {
    saveNativeSendRequest(entry());
    const conflicting = { ...entry(), body: { ...entry().body, text: 'different input' } };
    expect(() => saveNativeSendRequest(conflicting)).toThrow();
    sessionStorage.setItem('riffet.native-steer.v2.s1.c1', JSON.stringify(conflicting));
    const restored = listNativeSendRequests('s1');
    expect(restored).toHaveLength(1);
    expect(restored[0]?.invalidReason).toBeTruthy();
    expect(sessionStorage.length).toBe(1);
  });

  it('does not claim a durable submission when persistent storage rejects or drops the write', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    expect(() => saveNativeSendRequest(entry())).toThrow();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('quota'); } });
    expect(() => saveNativeSendRequest(entry())).toThrow('quota');
  });

  it('retains interrupt-and-send identity when stopping is unconfirmed before a run exists', async () => {
    const saved: NativeSendOutboxEntry = {
      sessionId: 's1', mode: 'interrupt', createdAt: '2026-10-16T01:00:00Z',
      body: { commandId: 'interrupt-command', text: 'next task', stop: { requestId: 'original-stop', ...target } },
    };
    saveNativeSendRequest(saved);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'NATIVE_STOP_UNCONFIRMED', message: 'Stop still pending' } }), { status: 409, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('{}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    const failure = await submitNativeSendRequest(saved).catch(error => error);
    expect(isUncertainRequest(failure)).toBe(true);
    expect(isUncertainRequest(new HttpError(409, 'Rejected', 'CLI_INPUT_REJECTED'))).toBe(false);
    expect(isUncertainRequest(new HttpError(409, 'The original task changed', 'NATIVE_STOP_TARGET_CHANGED'))).toBe(false);
    expect(listNativeSendRequests('s1')).toEqual([saved]);
    await submitNativeSendRequest(listNativeSendRequests('s1')[0]!);
    expect(fetcher.mock.calls.map(([path, init]) => [path, JSON.parse(init.body)])).toEqual([
      ['/api/sessions/s1/native/interrupt-and-send', saved.body],
      ['/api/sessions/s1/native/interrupt-and-send', saved.body],
    ]);
  });

});
