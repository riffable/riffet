import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, CLIENT_FEATURES, restoreContext, restoreNewSessionContext, mergeRestoredReferences, listNativeCreateRequests, removeNativeCreateRequest, saveNativeCreateRequest, withClientFeatures } from './api';
import { acknowledgeRecoveredCreationDraft } from '../app/session/Composer';

beforeEach(() => {
  const values = new Map<string, string>();
  const persistent = new Map<string, string>();
  vi.stubGlobal('localStorage', { get length() { return persistent.size; }, key: (index: number) => [...persistent.keys()][index] ?? null, getItem: (key: string) => persistent.get(key) ?? null, setItem: (key: string, value: string) => persistent.set(key, value), removeItem: (key: string) => persistent.delete(key) });
  vi.stubGlobal('sessionStorage', {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('projectless request contract', () => {
  it('keeps the exact first-send identity without a project through retry and acknowledgement', () => {
    const body = { clientSessionId: 'creation-id', projectless: true, backendId: 'codex' as const, model: 'gpt-5.4?effort=high', initialMessage: { commandId: 'command-id', text: '分析文件', attachments: [{ id: 'attachment-id' }] } };
    saveNativeCreateRequest(body);
    expect(listNativeCreateRequests()).toEqual([body]);
    removeNativeCreateRequest(body.clientSessionId);
    expect(listNativeCreateRequests()).toEqual([]);
  });

  it('persists draft consumption separately from the submitted creation payload', async () => {
    const body = { clientSessionId: 'creation-id', projectless: true, backendId: 'codex' as const, initialMessage: { commandId: 'command-id', text: 'submitted task' } };
    saveNativeCreateRequest(body);
    saveNativeCreateRequest({ ...body, draftCleared: true });
    expect(listNativeCreateRequests()).toEqual([{ ...body, draftCleared: true }]);
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    await api.createNativeSession(listNativeCreateRequests()[0]!);
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toEqual({ ...body, kind: 'native' });
  });

  it('retains a definitively rejected creation with its complete input until recovery acknowledges it', async () => {
    const body = { clientSessionId: 'creation-id', projectless: true, draftCleared: true,
      initialMessage: { commandId: 'command-id', text: 'editable task', attachments: [{ id: 'image-id' }], context: [{ path: 'source.ts', line: 7 }] } };
    saveNativeCreateRequest(body);
    const failed = { ...body, rejected: true, invalidReason: 'The request was not accepted' };
    saveNativeCreateRequest(failed);
    expect(listNativeCreateRequests()).toEqual([failed]);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(api.createNativeSession(listNativeCreateRequests()[0]!)).rejects.toThrow(failed.invalidReason);
    expect(fetcher).not.toHaveBeenCalled();
    // Only the draft-persistence acknowledgement removes the old identity. A subsequent submission
    // owns fresh IDs; recording the failure must not rewrite the old body or discard its files.
    expect(listNativeCreateRequests()[0]?.initialMessage).toEqual(body.initialMessage);
    removeNativeCreateRequest(body.clientSessionId);
    const edited = { clientSessionId: 'new-creation', projectless: true, initialMessage: { ...body.initialMessage, commandId: 'new-command', text: 'edited task' } };
    saveNativeCreateRequest(edited);
    expect(listNativeCreateRequests()).toEqual([edited]);
  });

  it('does not choose or submit one of two conflicting migrated first messages', async () => {
    const body = { clientSessionId: 'creation-id', projectless: true, initialMessage: { commandId: 'command-id', text: 'first task' } };
    saveNativeCreateRequest(body);
    sessionStorage.setItem('riffet.native-create.creation-id', JSON.stringify({ ...body, initialMessage: { ...body.initialMessage, text: 'another task' } }));
    const restored = listNativeCreateRequests();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.invalidReason).toBeTruthy();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(api.createNativeSession(restored[0]!)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('clears accepted attachment IDs while preserving newer draft input and another directory’s references', () => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    const attachment = (id: string) => ({ id, name: `${id}.txt`, mimeType: 'text/plain', path: id, size: 1 });
    const body = { clientSessionId: 'creation-id', projectless: true, backendId: 'codex' as const, initialMessage: { commandId: 'command-id', text: 'submitted task', attachments: [{ id: 'submitted' }] } };
    const newer = { text: 'next task', attachments: [attachment('submitted'), attachment('new')], references: [{ path: 'notes.md' }], projectId: 'new-project', keys: { submitted: 'old-key', new: 'new-key' } };
    sessionStorage.setItem('riffet.draft.new:home', JSON.stringify(newer));
    expect(acknowledgeRecoveredCreationDraft(body)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('riffet.draft.new:home')!)).toEqual({ ...newer, attachments: [attachment('new')], keys: { new: 'new-key' } });
  });

  it('clears only accepted file references in the original directory and keeps parked task references for chat', () => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    const draft = { text: 'submitted task', attachments: [], references: [{ path: 'sent.md' }, { path: 'new.md' }], projectId: 'project' };
    const body = { clientSessionId: 'creation-id', projectId: 'project', backendId: 'codex' as const, initialMessage: { commandId: 'command-id', text: 'submitted task', context: [{ path: 'sent.md' }] } };
    sessionStorage.setItem('riffet.draft.new:home', JSON.stringify(draft));
    expect(acknowledgeRecoveredCreationDraft(body)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('riffet.draft.new:home')!)).toEqual({ ...draft, text: '', references: [{ path: 'new.md' }] });
    sessionStorage.setItem('riffet.draft.new:home', JSON.stringify(draft));
    expect(acknowledgeRecoveredCreationDraft({ ...body, backendId: 'chat' })).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('riffet.draft.new:home')!)).toEqual({ ...draft, text: '' });
  });

  it('drops recipient-bound snapshot reuse when restoring into a new home conversation', () => {
    const input = { references: [{ kind: 'session' as const, sessionId: 'source', fromRunId: 'old-recipient-run' }] };
    expect(restoreNewSessionContext(input)).toEqual([{ kind: 'session', sessionId: 'source' }]);
  });

  it('retains a chosen prior snapshot while recovering a rejected local submission', () => {
    const references = [{ kind: 'session' as const, sessionId: 'source', fromRunId: 'accepted-prior-run' }];
    const local = { id: 'local-command', native: { fingerprint: 'client-pending', contextSnapshots: undefined } } as never;
    expect(restoreContext({ references }, local)).toEqual(references);
    expect(mergeRestoredReferences([{ kind: 'session', sessionId: 'source' }], restoreContext({ references }, local))).toEqual(references);
  });

  it('clears accepted session references independently of the draft project while retaining newer references', () => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    const accepted = { kind: 'session' as const, sessionId: 'source', title: 'Research' };
    const newer = { kind: 'session' as const, sessionId: 'other', title: 'New research' };
    const draft = { text: 'submitted task', attachments: [], references: [accepted, newer, { path: 'notes.md' }], projectId: 'new-project' };
    sessionStorage.setItem('riffet.draft.new:home', JSON.stringify(draft));
    const body = { clientSessionId: 'created', projectless: true, backendId: 'codex' as const, initialMessage: { commandId: 'command', text: 'submitted task', references: [{ kind: 'session' as const, sessionId: 'source' }] } };
    expect(acknowledgeRecoveredCreationDraft(body)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('riffet.draft.new:home')!).references).toEqual([newer, { path: 'notes.md' }]);
  });

  it('does not clean a mounted composer’s persisted remainder again when newer input matches the submitted text', () => {
    const body = { clientSessionId: 'creation-id', projectless: true, backendId: 'codex' as const, initialMessage: { commandId: 'command-id', text: 'same task' } };
    const remainder = { text: 'same task', attachments: [{ id: 'new', name: 'new.txt', mimeType: 'text/plain', path: 'new', size: 1 }], references: [] };
    const persisted = JSON.stringify(remainder);
    const dispatchEvent = vi.fn((event: CustomEvent<{ handled: boolean; saved: boolean }>) => {
      // The mounted composer has already decided which input belongs to the remaining draft.
      sessionStorage.setItem('riffet.draft.new:home', persisted);
      event.detail.handled = true;
      event.detail.saved = true;
      return true;
    });
    vi.stubGlobal('window', { dispatchEvent });
    expect(acknowledgeRecoveredCreationDraft(body)).toBe(true);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('riffet.draft.new:home')).toBe(persisted);
  });

  it('queries global management scope and uploads before allocating a task', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    await api.backendCatalog('codex', 'profile');
    await api.backendUsage('codex', { scope: 'global', profileId: 'profile' });
    await api.slashCatalog('codex', { scope: 'global', profileId: 'profile' });
    await api.upload('', { name: 'file.txt', mimeType: 'text/plain', dataBase64: 'YQ==' });
    for (const [path, options] of fetcher.mock.calls.slice(0, 3)) {
      const query = new URL(path, 'https://riffet.test').searchParams;
      expect(query.get('scope')).toBe('global');
      expect(query.has('projectId')).toBe(false);
      expect(new Headers(options.headers).get('x-riffet-features')).toBe(CLIENT_FEATURES);
    }
    expect(fetcher.mock.calls[3]?.[0]).toBe('/api/attachments');
  });

  it('advertises browser capabilities on direct file and media URLs', () => {
    const path = withClientFeatures('/api/projects/p/file/raw?path=a%23b.md&download=1#L2');
    const url = new URL(path, 'https://riffet.test');
    expect(url.searchParams.get('features')).toBe(CLIENT_FEATURES);
    expect(url.searchParams.get('path')).toBe('a#b.md');
    expect(url.hash).toBe('#L2');
  });
});
