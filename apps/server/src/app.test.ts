import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { CLIENT_FEATURES_HEADER, DEFAULT_QUICK_CHAT_PRESETS, PROTOCOL_INFO } from '../../../packages/contracts/src/index.js';
import { nextCronTime, parseCron } from './orchestration/cron.js';
import { resolveNativeSessionInput } from './native/session-input.js';
import { WorkspaceService } from './workspace/index.js';
import type { Plugin } from '@riffet/plugin-api';
import type { NativeWorkbenchEvent } from '../../../packages/contracts/src/index.js';
import { Store } from './store.js';
import { NativeEventLog } from './journal/native-log.js';
import { JournalSessionDeleted, laneKey } from './journal/journal.js';
import { SessionReferenceService } from './context-references/service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/**
 * Route-surface guard for the removed ACP backend. It boots the real Fastify app with a
 * non-existent CLI so nothing can reach a model, then asserts both that the surviving
 * native routes work and that the ACP-only surface is gone rather than merely unused.
 */
async function boot(savedSettings?: Record<string, unknown>, webHtml?: string, plugins?: Plugin[], authenticated = false) {
  const stateDir = await mkdtemp(join(tmpdir(), 'riffet-app-'));
  const projectDir = await mkdtemp(join(tmpdir(), 'riffet-project-'));
  const previousClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  if (previousClaudeDir === undefined) process.env.CLAUDE_CONFIG_DIR = join(stateDir, 'claude-config');
  if (previousCodexHome === undefined) process.env.CODEX_HOME = join(stateDir, 'codex-home');
  if (savedSettings) await writeFile(join(stateDir, 'settings.json'), JSON.stringify(savedSettings), { mode: 0o600 });
  if (webHtml !== undefined) await writeFile(join(projectDir, 'index.html'), webHtml);
  const { app, settings, orchestration, store, terminal, nativeBackends, dispatch, git, quickChats, riffetMcp, contextReferences } = await createApp({ stateDir, auth: authenticated, cliPath: '/nonexistent/cursor-agent', ...(webHtml !== undefined ? { webRoot: projectDir } : {}), ...(plugins ? { plugins } : {}) });
  cleanups.push(async () => {
    if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
    await app.close();
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const status = authenticated
    ? await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: '127.0.0.1:4317' }, payload: { token: (await readFile(join(stateDir, 'access-token'), 'utf8')).trim() } })
    : await app.inject({ method: 'GET', url: '/api/auth/status', headers: { host: '127.0.0.1:4317' } });
  const cookie = String(status.headers['set-cookie']).split(';')[0]!;
  const csrf = (status.json() as { csrfToken: string }).csrfToken;
  const call = (app: FastifyInstance, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => app.inject({
    method, url, headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { app, cookie, csrf, projectDir, stateDir, settings, orchestration, store, terminal, nativeBackends, dispatch, git, quickChats, riffetMcp, contextReferences, call: (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => call(app, method, url, payload) };
}

describe('app route surface after ACP removal', () => {
  it('freezes session references across retries, queue conversion, restart and journal rebuild', async () => {
    const { app, cookie, csrf, store, projectDir, stateDir, nativeBackends, dispatch, contextReferences } = await boot();
    const kick = vi.spyOn(dispatch, 'kick').mockImplementation(() => undefined);
    const available = vi.spyOn(nativeBackends, 'assertAvailable').mockImplementation(() => undefined);
    const capability = vi.spyOn(nativeBackends, 'assertSessionReferences').mockResolvedValue();
    const project = store.createProject(projectDir, 'References');
    const source = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor', title: 'Database decisions' });
    const recipient = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor', nativeSessionId: 'native-receiver', title: 'Implementation' });
    const log = new NativeEventLog(store.journal, source.id);
    const event = (id: string, type: string, text: string, turn = 'turn-1'): NativeWorkbenchEvent => ({ sessionId: source.id, nativeId: id, nativeTurnId: turn, sequence: 1, type, createdAt: new Date().toISOString(), data: { content: { type: 'text', text } } });
    log.assign(event('question', 'user_message_chunk', 'Choose a database'));
    log.assign(event('answer', 'agent_message_chunk', 'Use SQLite because this is a local workbench.'));
    log.assignDraft('unfinished', event('unfinished', 'agent_message_chunk', 'A mutable draft must not be copied'));
    const headers = { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf, [CLIENT_FEATURES_HEADER]: 'session-references-v1' };
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload });
    const request = { commandId: 'reference-first', text: 'Review the decision', references: [{ kind: 'session', sessionId: source.id }] };
    try {
      const [a, b] = await Promise.all([post(`/api/sessions/${recipient.id}/native/send`, request), post(`/api/sessions/${recipient.id}/native/send`, request)]);
      expect(a.statusCode, a.body).toBe(202);
      expect(b.json().id).toBe(a.json().id);
      const run = store.getRun(a.json().id), ref = run.native!.contextSnapshots![0]!;
      expect(run.native!.input.references).toEqual(request.references);
      expect(ref).not.toHaveProperty('messages');
      expect(ref).not.toHaveProperty('bytes');
      const snapshot = contextReferences.snapshot(recipient.id, ref.snapshotRef);
      expect(snapshot.messages.map(message => message.text)).toEqual(['Choose a database', 'Use SQLite because this is a local workbench.']);
      expect(store.journal.sessionBlob(source.id, ref.snapshotRef)).toBeUndefined();
      expect(() => contextReferences.readForAgent(recipient.id, ref.snapshotRef)).toThrow();
      store.updateRun(run.id,{native:{...run.native!,delivery:'observed',renderedText:'delivered reference'}});
      expect(contextReferences.readForAgent(recipient.id, ref.snapshotRef,0,1)).toMatchObject({messages:[{role:'user'}],next:1});
      store.updateRun(run.id,{native:{...run.native!,delivery:'cancelled',renderedText:'delivered reference',nativeMessageId:'confirmed-input'}});
      expect(contextReferences.readForAgent(recipient.id, ref.snapshotRef,0,1)).toMatchObject({messages:[{role:'user'}],next:1});
      store.updateRun(run.id,{native:{...run.native!,delivery:'failed',renderedText:'prepared but not delivered'}});
      expect(() => contextReferences.readForAgent(recipient.id, ref.snapshotRef)).toThrow();
      expect(() => contextReferences.readForAgent(source.id, ref.snapshotRef)).toThrow();
      store.updateRun(run.id,{native:run.native});
      const rendered = await contextReferences.render(run);
      expect(rendered.text).toContain(contextReferences.path(recipient.id, ref.snapshotRef));
      expect(await readFile(contextReferences.path(recipient.id, ref.snapshotRef), 'utf8')).toContain('Use SQLite');
      expect(run.prompt).toBe(request.text);
      store.journal.rebuild(recipient.id); store.journal.sweepBlobs();
      await rm(contextReferences.path(recipient.id, ref.snapshotRef));
      const reopened = new Store(join(stateDir, 'workbench.db'));
      try {
        const recovered = new SessionReferenceService(reopened, stateDir);
        expect(recovered.snapshot(recipient.id, ref.snapshotRef).messages).toEqual(snapshot.messages);
        await recovered.render(reopened.getRun(run.id));
      } finally { reopened.close(); }
      await contextReferences.render(store.getRun(run.id));
      expect(await readFile(contextReferences.path(recipient.id, ref.snapshotRef), 'utf8')).toContain('Use SQLite');
      const steered = store.steerQueuedNativeRun(recipient.id, run.id, 'reference-steer', { nativeSessionId: 'native-receiver', turnId: 'running-turn' }, { mode: 'agent' });
      expect(steered.native!.contextSnapshots).toEqual(run.native!.contextSnapshots);
      log.assign(event('revised', 'agent_message_chunk', 'Later revision: use a remote database.', 'turn-2'));
      const interruptInput = { text: 'replacement', attachmentIds: [], context: [], references: request.references as never };
      const preparedStop = await contextReferences.prepareInterrupt(recipient.id, 'frozen-stop', interruptInput);
      log.assign(event('after-stop-prepared', 'agent_message_chunk', 'This revision comes after the prepared Stop.', 'turn-2'));
      const stopStore = new Store(join(stateDir, 'workbench.db'));
      try {
        const afterRestart = new SessionReferenceService(stopStore, stateDir);
        const retryStop = await afterRestart.prepareInterrupt(recipient.id, 'frozen-stop', interruptInput);
        expect(retryStop.map(item => item.metadata)).toEqual(preparedStop.map(item => item.metadata));
        expect(afterRestart.snapshot(recipient.id, retryStop[0]!.metadata.snapshotRef).messages.some(message => message.text.startsWith('This revision'))).toBe(false);
      } finally { stopStore.close(); }
      log.assign({ ...event('hidden-prompt', 'user_message_chunk', 'Private internal input'), data: { hidden: true, content: { type: 'text', text: 'Private internal input' } } });
      const originalPrompt = 'Follow up with the exact wording';
      const exact = store.acceptNativeRun(source.id, 'source-exact', { text: originalPrompt, attachmentIds: [], context: [] }, { mode: 'agent' });
      store.transitionNativeRun(exact.id, ['queued'], { delivery: 'observed', nativeMessageId: 'exact-original-id' });
      log.assign({ ...event('exact-new-id', 'user_message_chunk', `${originalPrompt}\n\nInjected references`), nativeAliases: ['exact-original-id'] });
      log.assign({ ...event('queue-receipt', 'native_input_receipt', 'Unrelated queue input'), runId: exact.id });
      const compacted = store.acceptNativeRun(source.id, 'source-compacted', { text: 'Persisted request before compaction', attachmentIds: [], context: [] }, { mode: 'agent' });
      store.transitionNativeRun(compacted.id, ['queued'], { delivery: 'observed', nativeMessageId: 'compacted-input', nativeTurnId: 'compacted-turn' });
      const compactedSteer = store.acceptNativeRun(source.id, 'source-compacted-steer', { text: 'Later correction before compaction', attachmentIds: [], context: [] }, { mode: 'agent' });
      store.transitionNativeRun(compactedSteer.id, ['queued'], { delivery: 'observed', nativeMessageId: 'compacted-steer', nativeTurnId: 'compacted-turn', intent: 'steer' });
      log.assign(event('compacted-answer', 'agent_message_chunk', 'The compacted turn answer', 'compacted-turn'));
      store.acceptNativeRun(source.id, 'source-not-delivered', { text: 'This request is still queued', attachmentIds: [], context: [] }, { mode: 'agent' });
      const later = await post(`/api/sessions/${recipient.id}/native/send`, { ...request, commandId: 'reference-later' });
      expect(later.statusCode, later.body).toBe(202);
      expect(later.json().native.contextSnapshots[0].snapshotRef).not.toBe(ref.snapshotRef);
      const laterTexts = contextReferences.snapshot(recipient.id, later.json().native.contextSnapshots[0].snapshotRef).messages.map(message => message.text);
      expect(laterTexts).not.toContain('Private internal input');
      expect(laterTexts).toContain(originalPrompt);
      expect(laterTexts).not.toContain(`${originalPrompt}\n\nInjected references`);
      expect(laterTexts).toContain('Unrelated queue input');
      expect(laterTexts.filter(text => text === originalPrompt)).toHaveLength(1);
      expect(laterTexts.slice(laterTexts.indexOf('The compacted turn answer') - 2, laterTexts.indexOf('The compacted turn answer'))).toEqual(['Persisted request before compaction', 'Later correction before compaction']);
      expect(laterTexts).not.toContain('This request is still queued');
      // Native history uses the same original-input mapping and supplementation as the journal.
      store.updateSession(source.id, { nativeSessionId: 'native-source' });
      const nativeReader = vi.spyOn(nativeBackends, 'contextTranscript').mockResolvedValue([
        { ...event('native-alias', 'user_message_chunk', 'Injected references'), nativeAliases: ['exact-original-id'] },
        event('native-compacted-answer', 'agent_message_chunk', 'The native compacted answer', 'compacted-turn'),
      ]);
      const nativePrepared = await contextReferences.prepare(recipient.id, { text: 'native', attachmentIds: [], context: [], references: request.references as never });
      const nativeSnapshot = JSON.parse(nativePrepared[0]!.bytes!.toString());
      expect(nativeSnapshot.messages.map((message: { text: string }) => message.text)).toEqual([originalPrompt, 'Persisted request before compaction', 'Later correction before compaction', 'The native compacted answer']);
      expect(nativeSnapshot.source.coverage).toMatchObject({ source: 'native', completeness: 'partial' });
      nativeReader.mockRestore();
      store.updateSession(source.id, { nativeSessionId: undefined });
      // MCP returns every character of a large message through bounded continuations.
      const longText = '长段😀'.repeat(35_000);
      log.assign(event('large-readable', 'agent_message_chunk', longText));
      const longRun = (await post(`/api/sessions/${recipient.id}/native/send`, { ...request, commandId: 'reference-paged' })).json();
      store.updateRun(longRun.id, { native: { ...longRun.native, delivery: 'observed', renderedText: 'delivered reference' } });
      let start = 0, offset = 0, recovered = '';
      do {
        const page = contextReferences.readForAgent(recipient.id, longRun.native.contextSnapshots[0].snapshotRef, start, 20, '长段', offset) as { messages: Array<{ text: string }>; next?: number; nextOffset?: number };
        expect(page.messages.reduce((sum, message) => sum + Buffer.byteLength(message.text), 0)).toBeLessThanOrEqual(128 * 1024);
        recovered += page.messages.map(message => message.text).join('');
        if (page.next === undefined) break;
        start = page.next; offset = page.nextOffset ?? 0;
      } while (true);
      expect(recovered).toBe(longText);
      expect(contextReferences.snapshot(recipient.id, ref.snapshotRef).messages).toHaveLength(2);
      store.journal.drop(source.id);
      const retried = await post(`/api/sessions/${recipient.id}/native/send`, request);
      expect(retried.statusCode).toBe(202);
      expect(retried.json().native.contextSnapshots[0].snapshotRef).toBe(ref.snapshotRef);
      const restored = await post(`/api/sessions/${recipient.id}/native/send`, { ...request, commandId: 'reference-restored', references: [{ ...request.references[0], fromRunId: run.id }] });
      expect(restored.statusCode, restored.body).toBe(202);
      expect(restored.json().native.contextSnapshots[0].snapshotRef).toBe(ref.snapshotRef);
      const foreign = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor' });
      expect((await post(`/api/sessions/${foreign.id}/native/send`, { ...request, commandId: 'foreign-reference', references: [{ ...request.references[0], fromRunId: run.id }] })).statusCode).toBe(409);
      expect((await post(`/api/sessions/${recipient.id}/native/send`, { ...request, references: [] })).json().error.code).toBe('COMMAND_ID_CONFLICT');
      const unnegotiated = await app.inject({ method: 'POST', url: `/api/sessions/${recipient.id}/native/send`, headers: { host: headers.host, cookie, 'x-csrf-token': csrf }, payload: { ...request, commandId: 'reference-old-client' } });
      expect(unnegotiated.json().error.code).toBe('SESSION_REFERENCES_UNSUPPORTED');
      // Capture refuses an oversized message before a Stop or a new Run is accepted.
      log.assign(event('too-large', 'agent_message_chunk', 'x'.repeat(1024 * 1024 + 1)));
      const interrupted = vi.spyOn(dispatch, 'interruptAndSend');
      const oversized = await post(`/api/sessions/${recipient.id}/native/interrupt-and-send`, { ...request, commandId: 'reference-large', stop: { requestId: 'reference-stop', nativeSessionId: 'native-receiver' } });
      expect(oversized.json().error.code).toBe('SESSION_REFERENCE_TOO_LARGE');
      expect(interrupted).not.toHaveBeenCalled();
      expect(store.findRunByCommand(recipient.id, 'reference-large')).toBeUndefined();
      interrupted.mockRestore();
    } finally { kick.mockRestore(); available.mockRestore(); capability.mockRestore(); }
  });

  it('runs a native side chat on the parent profile with its original model options and isolated history', async () => {
    const { app, cookie, csrf, store, projectDir, stateDir, nativeBackends } = await boot();
    const driver = nativeBackends.registry.require('pi');
    const stream = vi.spyOn(driver, 'streamDiscussion').mockImplementation(async (_host, _profile, request) => {
      request.onDelta('Native answer');
    });
    const shortName = 'm'.repeat(200 - 'first/[thinking=high]'.length);
    const qualified = `first/${shortName}`;
    const catalog = vi.spyOn(driver, 'listModels').mockResolvedValue([
      { value: qualified, name: 'Model', configOptions: [] },
      { value: 'second/other', name: 'Other', configOptions: [] },
    ]);
    const headers = { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf, [CLIENT_FEATURES_HEADER]: 'quick-chat,pi-agent' };
    const model = qualified + '[thinking=high]';
    const project = store.createProject(projectDir, 'Native discussion');
    const attachment = { hook: 'example.provider', id: 'private-route-id' };
    const profile = nativeBackends.catalog.validateProfile('pi');
    const parent = store.createSession({ projectId: project.id, kind: 'native', backendId: 'pi', backendProfileId: profile.id, model: shortName });
    const original = store.acceptNativeRun(parent.id, 'original', { text: 'Question', attachmentIds: [], context: [] }, { mode: 'agent', model: shortName });
    store.updateRun(original.id, { state: 'completed', native: { ...original.native!, delivery: 'observed', resolvedConfig: { mode: 'agent', model } } });
    store.updateSession(parent.id, { nativeRuntime: { address: 'local', fingerprint: 'parent', attachment } });
    const log = new NativeEventLog(store.journal, parent.id);
    log.assign({ sessionId: parent.id, nativeId: 'answer', sequence: 1, type: 'agent_message_chunk', createdAt: new Date().toISOString(),
      data: { content: { type: 'text', text: 'Original answer' } } });
    const path = `/api/sessions/${parent.id}/discussions`;
    const body = { clientSessionId: 'native-side-chat', commandId: 'first-question', text: 'Why?', anchor: { messageId: 'answer' }, quote: { exact: 'Original answer', prefix: '', suffix: '' } };
    try {
      const models = (await app.inject({ method: 'GET', url: path + '/models', headers })).json();
      expect(models.model).toBe(`pi:${profile.id}:${model}`);
      expect(models.models.map((entry: { value: string }) => entry.value)).toEqual([`pi:${profile.id}:${qualified}`]);
      const other = `pi:${profile.id}:second/other`;
      const denied = await app.inject({ method: 'POST', url: path, headers, payload: { ...body, clientSessionId: 'rejected-side-chat', commandId: 'rejected-question', model: other } });
      expect(denied.json().error.code).toBe('DISCUSSION_PROVIDER_UNAVAILABLE');
      const started = await app.inject({ method: 'POST', url: path, headers, payload: { ...body, model: models.model } });
      expect(started.json()).toMatchObject({ session: { model: models.model } });
      const child = started.json().session.id;
      await vi.waitFor(() => expect(store.findRunByCommand(child, body.commandId)?.state).toBe('completed'), { timeout: 5000 });
      expect(stream.mock.calls[0]![1].id).toBe(profile.id);
      expect(stream.mock.calls[0]![2]).toMatchObject({ model, sourceSessionId: parent.id, sourceAttachment: attachment, messages: [{ role: 'user', content: 'Why?' }], system: expect.stringContaining('Original answer') });
      expect(stream.mock.calls[0]![2].system).not.toContain(attachment.id);
      store.updateSession(parent.id, { nativeRuntime: undefined });
      for (const route of ['model', 'configure']) {
        const updated = await app.inject({ method: 'POST', url: `/api/sessions/${child}/native/${route}`, headers, payload: { model: models.model } });
        expect(updated.statusCode).toBe(200);
      }
      const tooLong = await app.inject({ method: 'POST', url: `/api/sessions/${parent.id}/native/model`, headers, payload: { model: model + 'x' } });
      expect(tooLong.json().error.code).toBe('INVALID_INPUT');
      const switched = await app.inject({ method: 'POST', url: `/api/sessions/${child}/native/model`, headers, payload: { model: other } });
      expect(switched.json().error.code).toBe('DISCUSSION_PROVIDER_UNAVAILABLE');
      await app.inject({ method: 'POST', url: `/api/sessions/${child}/native/send`, headers, payload: { commandId: 'follow-up', text: 'Explain further' } });
      await vi.waitFor(() => expect(store.findRunByCommand(child, 'follow-up')?.state).toBe('completed'), { timeout: 5000 });
      expect(stream.mock.calls[1]![2].sourceAttachment).toEqual(attachment);
      expect(stream.mock.calls[1]![2].messages).toEqual([{ role: 'user', content: 'Why?' }, { role: 'assistant', content: 'Native answer' }, { role: 'user', content: 'Explain further' }]);
      expect(store.listRuns(parent.id).map(run => run.id)).toEqual([original.id]);
      stream.mockRejectedValueOnce(new Error('Provider rejected authorization: Bearer fake-private-value'));
      await app.inject({ method: 'POST', url: `/api/sessions/${child}/native/send`, headers, payload: { commandId: 'provider-error', text: 'Try again' } });
      await vi.waitFor(() => expect(store.findRunByCommand(child, 'provider-error')?.state).toBe('failed'), { timeout: 5000 });
      const journal = await readFile(join(stateDir, 'chat', child + '.jsonl'), 'utf8');
      expect(journal).toContain('[REDACTED]');
      expect(journal).not.toContain('fake-private-value');
      // Deletion disposes the driver after the visible answer has ended. It must also stop
      // the background summary before the session's history file can be removed.
      let summarySignal: AbortSignal | undefined;
      stream.mockImplementationOnce(async (_host, _profile, request) => request.onDelta('Short answer'))
        .mockImplementationOnce(async (_host, _profile, request) => {
          summarySignal = request.signal;
          await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
        });
      const long = await app.inject({ method: 'POST', url: `/api/sessions/${child}/native/send`, headers,
        payload: { commandId: 'long-question', text: '字'.repeat(50_000) } });
      expect(long.statusCode).toBe(202);
      await vi.waitFor(() => expect(summarySignal).toBeDefined(), { timeout: 5000 });
      await nativeBackends.dispose(child);
      expect(summarySignal?.aborted).toBe(true);
      // Legacy records that only named the CLI default cannot change providers when that default changes.
      store.updateSession(child, { model: `pi:${profile.id}:` });
      const old = await app.inject({ method: 'GET', url: `/api/sessions/${child}/discussions/models`, headers });
      expect(old.json().error.code).toBe('DISCUSSION_PROVIDER_UNAVAILABLE');
      const otherProfile = nativeBackends.catalog.validateProfile('droid');
      await expect(nativeBackends.catalog.validateDiscussionModel(otherProfile, '', '')).rejects.toMatchObject({ code: 'DISCUSSION_PROVIDER_UNAVAILABLE' });
    } finally { stream.mockRestore(); catalog.mockRestore(); }
  });

  it('persists a side discussion snapshot once, sends isolated multi-turn context and retains it independently of quick chats', async () => {
    const { app, cookie, csrf, call, store, stateDir, projectDir, nativeBackends, quickChats, dispatch } = await boot();
    expect((await call('POST', '/api/backends/dsh/profiles', { id: 'discussion-gw', name: 'Gateway', apiEndpoint: 'https://discussion.example/v1', apiKey: 'k', enabledModels: ['m'] })).statusCode).toBe(200);
    expect((await call('POST', '/api/backends/dsh/profiles', { id: 'other-gw', name: 'Other gateway', apiEndpoint: 'https://other.example/v1', apiKey: 'other-key', enabledModels: ['other-model'] })).statusCode).toBe(200);
    expect((await call('PATCH', '/api/settings', { auxiliaryModels: { chat: { backendId: 'dsh', profileId: 'other-gw', model: 'other-model' } } })).statusCode).toBe(200);
    const project = store.createProject(projectDir, 'Discussion test');
    const parent = store.createSession({ projectId: project.id, kind: 'native', backendId: 'dsh', backendProfileId: 'discussion-gw', model: 'dsh:native-provider:m[effort=high]', title: 'Main task' });
    store.updateSession(parent.id, { state: 'running' });
    const event = (id: string, type: 'user_message_chunk' | 'agent_message_chunk', text: string, sequence: number): NativeWorkbenchEvent => ({ sessionId: parent.id, nativeId: id, sequence, type, createdAt: new Date().toISOString(), data: { content: { type: 'text', text } } });
    const parentEvents = [
      event('q1', 'user_message_chunk', 'Implement the main task', 1),
      event('a1', 'agent_message_chunk', 'The selected ', 2),
      event('a1b', 'agent_message_chunk', 'passage explains the tradeoff.', 2),
      event('q2', 'user_message_chunk', 'Later main question', 3),
      event('a2', 'agent_message_chunk', 'Later answer should not enter the snapshot.', 4),
    ];
    const parentLog = new NativeEventLog(store.journal, parent.id);
    parentEvents.forEach(event => parentLog.assign(event));
    const transcript = vi.spyOn(nativeBackends, 'indexableTranscript').mockRejectedValue(new Error('provider unavailable'));
    const asks = (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf, [CLIENT_FEATURES_HEADER]: 'quick-chat,plugin-agents' }, ...(payload === undefined ? {} : { payload: payload as object }) });
    const sse = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sse('First discussion answer')).mockResolvedValueOnce(sse('Second discussion answer'));
    try {
      const body = { clientSessionId: 'side-1', commandId: 'side-first', text: 'Why this tradeoff?', anchor: { messageId: 'a1' }, quote: { exact: 'selected passage', prefix: 'The ', suffix: ' explains' } };
      expect((await call('POST', `/api/sessions/${parent.id}/discussions`, body)).statusCode).toBe(409);
      const mismatched = await asks('POST', `/api/sessions/${parent.id}/discussions`, { ...body, clientSessionId: 'side-wrong-provider', model: 'dsh:other-gw:other-model' });
      expect(mismatched.json().error.code).toBe('DISCUSSION_PROVIDER_UNAVAILABLE');
      expect(store.listSessions().some(session => session.id === 'side-wrong-provider')).toBe(false);
      const cliOnly = store.createSession({ projectId: project.id, kind: 'native', backendId: 'example.unknown', title: 'No side chat driver' });
      expect((await asks('POST', `/api/sessions/${cliOnly.id}/discussions`, { ...body, clientSessionId: 'side-cli-only' })).json().error.code).toBe('DISCUSSION_PROVIDER_UNAVAILABLE');
      expect((await asks('POST', `/api/sessions/${parent.id}/discussions`, { ...body, clientSessionId: 'invalid-side', quote: { ...body.quote, exact: 'a missing passage' } })).statusCode).toBe(400);
      expect(store.listSessions().some(session => session.id === 'invalid-side')).toBe(false);
      const [created, concurrent] = await Promise.all([asks('POST', `/api/sessions/${parent.id}/discussions`, body), asks('POST', `/api/sessions/${parent.id}/discussions`, body)]);
      expect(created.statusCode).toBe(202);
      expect(concurrent.statusCode).toBe(202);
      expect(concurrent.json().run.id).toBe(created.json().run.id);
      const child = created.json().session;
      const choices = (await asks('GET', `/api/sessions/${parent.id}/discussions/models`)).json();
      expect(choices.model).toBe('dsh:discussion-gw:m[effort=high]');
      expect(choices.models.map((model: { value: string }) => model.value)).toEqual(['dsh:discussion-gw:m']);
      expect(choices.models[0].configOptions[0].options).toContainEqual({ value: 'high', name: 'high' });
      expect(child.model).toBe('dsh:discussion-gw:m[effort=high]');
      expect(child.origin).toMatchObject({ kind: 'discussion', sessionId: parent.id, discussion: { quote: body.quote } });
      const blob = store.journal.sessionBlob(child.id, child.origin.discussion.contextRef)!;
      expect(blob).toBeDefined();
      expect(store.journal.sessionBlob(parent.id, child.origin.discussion.contextRef)).toBeUndefined();
      expect(blob.bytes().toString()).toContain('Implement the main task');
      expect(blob.bytes().toString()).not.toContain('Later main question');
      await vi.waitFor(() => expect(store.findRunByCommand(child.id, body.commandId)?.state).toBe('completed'), { timeout: 5000 });
      transcript.mockRejectedValue(new Error('parent provider unavailable'));
      store.updateSession(parent.id, { model: 'dsh:native-provider:changed-main-model' });
      const retried = await asks('POST', `/api/sessions/${parent.id}/discussions`, body);
      expect(retried.statusCode).toBe(202);
      expect(retried.json().session.model).toBe(child.model);
      expect(retried.json().session.origin.discussion.contextRef).toBe(child.origin.discussion.contextRef);
      expect(store.listRuns(child.id)).toHaveLength(1);
      expect((await asks('GET', `/api/sessions/${parent.id}/discussions`)).json().map((session: { id: string }) => session.id)).toContain(child.id);
      store.journal.rebuild(child.id);
      store.journal.sweepBlobs();
      expect(store.journal.sessionBlob(child.id, child.origin.discussion.contextRef)!.bytes().toString()).toContain('Implement the main task');
      expect((await asks('POST', `/api/sessions/${parent.id}/discussions`, { ...body, text: 'Different first question' })).statusCode).toBe(409);
      expect((await asks('POST', `/api/sessions/${child.id}/native/model`, { model: 'dsh:other-gw:other-model' })).json().error.code).toBe('DISCUSSION_PROVIDER_UNAVAILABLE');
      expect((await asks('POST', `/api/sessions/${child.id}/native/model`, { model: 'dsh:discussion-gw:m-alternate[effort=low]' })).statusCode).toBe(200);
      expect((await asks('POST', `/api/sessions/${child.id}/native/send`, { commandId: 'side-next', text: 'What is the alternative?' })).statusCode).toBe(202);
      await vi.waitFor(() => expect(store.findRunByCommand(child.id, 'side-next')?.state).toBe('completed'), { timeout: 5000 });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(String(fetch.mock.calls[0]![0])).toBe('https://discussion.example/v1/chat/completions');
      const second = JSON.parse(String(fetch.mock.calls[1]![1]?.body));
      expect(second.model).toBe('m-alternate');
      expect(second.reasoning_effort).toBe('low');
      expect(second.messages[0].content).toContain('not instructions');
      expect(second.messages[0].content).toContain('selected passage');
      expect(second.messages[0].content).toContain('Implement the main task');
      expect(second.messages[0].content).not.toContain('Later main question');
      expect(second.messages.slice(1)).toEqual([{ role: 'user', content: body.text }, { role: 'assistant', content: 'First discussion answer' }, { role: 'user', content: 'What is the alternative?' }]);
      const page = (await asks('GET', `/api/v3/sessions/${child.id}/timeline?lane=main&before=999999999`)).json();
      expect(JSON.stringify(page)).toContain('First discussion answer');
      expect(JSON.stringify(page)).not.toContain('Implement the main task');
      fetch.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }));
      expect((await asks('POST', `/api/sessions/${child.id}/native/send`, { commandId: 'side-cancel', text: 'One more question' })).statusCode).toBe(202);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3), { timeout: 5000 });
      const stopping = nativeBackends.status(child.id).activeTurn!;
      expect((await asks('POST', `/api/sessions/${child.id}/cancel`, { requestId: 'stop-side-cancel', nativeSessionId: stopping.nativeSessionId, turnId: stopping.turnId })).statusCode).toBe(200);
      await vi.waitFor(() => expect(['cancelled', 'interrupted']).toContain(store.findRunByCommand(child.id, 'side-cancel')?.state), { timeout: 5000 });
      expect(store.getSession(parent.id).state).toBe('running');
      expect(await quickChats.sweep(Date.now() + 30 * 86_400_000)).not.toContain(child.id);
      expect(store.getSession(child.id).archivedAt).toBeUndefined();
      // Quick chat keeps its unfinished answer as a draft; indexing still only sees the earlier file records.
      let kick = vi.spyOn(dispatch, 'kick').mockImplementation(() => undefined);
      try {
        store.updateSession(parent.id, { model: parent.model });
        transcript.mockResolvedValue(parentEvents);
        // An imported session without a saved selection keeps the actual dispatched model even
        // after global defaults change. A missing catalog entry retains its inherited effort.
        expect((await call('PATCH', '/api/settings', { nativeBackendDefaults: { dsh: { profileId: 'discussion-gw', model: 'new-default' } } })).statusCode).toBe(200);
        const inheritedParent = store.createSession({ projectId: project.id, kind: 'native', backendId: 'dsh', backendProfileId: 'discussion-gw', title: 'Imported task' });
        const previousRun = store.acceptNativeRun(inheritedParent.id, 'imported-run', { text: 'Main question', attachmentIds: [], context: [] }, { mode: 'agent', model: 'queued-model' });
        store.updateRun(previousRun.id, { state: 'completed', native: { ...previousRun.native!, delivery: 'observed', resolvedConfig: { mode: 'agent', model: 'actual-model[effort=high]' } } });
        const inheritedChoices = (await asks('GET', `/api/sessions/${inheritedParent.id}/discussions/models`)).json();
        expect(inheritedChoices.model).toBe('dsh:discussion-gw:actual-model[effort=high]');
        expect(inheritedChoices.models[0]).toMatchObject({ value: 'dsh:discussion-gw:actual-model', configOptions: [{ currentValue: 'high', options: expect.arrayContaining([{ value: 'high', name: 'high' }]) }] });
        const inheritedSide = await asks('POST', `/api/sessions/${inheritedParent.id}/discussions`, { ...body, clientSessionId: 'side-inherited', commandId: 'side-inherited-first' });
        expect(inheritedSide.statusCode).toBe(202);
        expect(inheritedSide.json().session.model).toBe(inheritedChoices.model);
        const unknownChat = store.createSession({ projectId: child.projectId, kind: 'native', backendId: 'chat', title: 'Imported chat' });
        expect((await asks('GET', `/api/sessions/${unknownChat.id}/discussions/models`)).json().error.code).toBe('DISCUSSION_PROVIDER_UNAVAILABLE');
        expect((await call('POST', '/api/backends/claude/profiles', { id: 'discussion-claude', name: 'Claude gateway', apiEndpoint: 'https://claude-discussion.example', apiKey: 'claude-key' })).statusCode).toBe(200);
        const aliasParent = store.createSession({ projectId: project.id, kind: 'native', backendId: 'claude', backendProfileId: 'discussion-claude', model: 'opus', title: 'Claude alias' });
        fetch.mockResolvedValueOnce(Response.json({ data: [{ id: 'claude-opus-4-8' }] }));
        const aliasRequest = { ...body, clientSessionId: 'side-native-alias', commandId: 'side-native-alias-first' };
        expect((await asks('POST', `/api/sessions/${aliasParent.id}/discussions`, aliasRequest)).json().error.code).toBe('DISCUSSION_PROVIDER_UNAVAILABLE');
        expect(store.listSessions().some(session => session.id === aliasRequest.clientSessionId)).toBe(false);
        fetch.mockResolvedValueOnce(Response.json({ data: [{ id: 'opus' }] }));
        const advertisedAlias = await asks('POST', `/api/sessions/${aliasParent.id}/discussions`, { ...aliasRequest, commandId: 'side-native-alias-retry' });
        expect(advertisedAlias.statusCode).toBe(202);
        expect(advertisedAlias.json().session.model).toBe('claude:discussion-claude:opus');
        const chatParent = store.createSession({ projectId: child.projectId, kind: 'native', backendId: 'chat', model: 'dsh:discussion-gw:m', title: 'Main chat' });
        const fromChat = await asks('POST', `/api/sessions/${chatParent.id}/discussions`, { ...body, clientSessionId: 'side-from-chat', commandId: 'side-from-chat-first' });
        expect(fromChat.statusCode).toBe(202);
        expect(fromChat.json().session.model).toBe('dsh:discussion-gw:m');
        expect((await call('POST', '/api/backends/codex/profiles', { id: 'discussion-codex', name: 'Codex gateway', apiEndpoint: 'https://codex-discussion.example/v1', apiKey: 'codex-key' })).statusCode).toBe(200);
        const codexParent = store.createSession({ projectId: project.id, kind: 'native', backendId: 'codex', backendProfileId: 'discussion-codex', model: 'gpt-x[effort=xhigh,fast=true]', title: 'Codex reasoning' });
        const codexRequest = { ...body, clientSessionId: 'side-codex', commandId: 'side-codex-first' };
        const codexSide = await asks('POST', `/api/sessions/${codexParent.id}/discussions`, codexRequest);
        expect(codexSide.statusCode).toBe(202);
        expect(codexSide.json().session.model).toBe('codex:discussion-codex:gpt-x[effort=xhigh,fast=true]');
        // A compatible Responses selection reaches the same provider with both switches intact.
        const responsesAnswer = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Codex side answer' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`;
        fetch.mockImplementation(async url => String(url).includes('codex-discussion.example')
          ? new Response(responsesAnswer, { headers: { 'content-type': 'text/event-stream' } }) : sse('Saved side answer'));
        kick.mockRestore();
        dispatch.kick();
        await vi.waitFor(() => expect(store.findRunByCommand(codexSide.json().session.id, codexRequest.commandId)?.state).toBe('completed'), { timeout: 5000 });
        const codexCall = fetch.mock.calls.find(([url]) => String(url).includes('codex-discussion.example'))!;
        expect(String(codexCall[0])).toBe('https://codex-discussion.example/v1/responses');
        const codexWire = JSON.parse(String(codexCall[1]?.body));
        expect(codexWire).toMatchObject({ model: 'gpt-x', reasoning: { effort: 'xhigh' }, service_tier: 'priority' });
        kick = vi.spyOn(dispatch, 'kick').mockImplementation(() => undefined);
        const live = { nativeTurnId: 'live-turn', runId: 'live-run' };
        parentLog.assign({ ...event('live-question:user', 'user_message_chunk', 'Explain the streaming tradeoff', 5), ...live });
        const draft = { ...event('live-answer:text-draft', 'agent_message_chunk', 'An unfinished streaming answer', 6), ...live };
        parentLog.assignDraft('live-answer:text', { ...draft, data: { content: { type: 'text', text: 'An unfinished' } } });
        parentLog.assignDraft('live-answer:text', draft);
        parentLog.assignDraft('live-answer:reasoning', { ...draft, nativeId: 'live-answer:reasoning', type: 'agent_thought_chunk', data: { content: { type: 'text', text: 'private reasoning excluded' } } });
        const liveBody = { ...body, clientSessionId: 'side-live', commandId: 'side-live-first', anchor: { messageId: draft.nativeId, ...live }, quote: { exact: 'unfinished streaming answer', prefix: 'An ', suffix: '' } };
        const streaming = await asks('POST', `/api/sessions/${parent.id}/discussions`, liveBody);
        expect(streaming.statusCode).toBe(202);
        const saved = streaming.json().session;
        const snapshot = store.journal.sessionBlob(saved.id, saved.origin.discussion.contextRef)!.bytes().toString();
        expect(snapshot).toContain('Explain the streaming tradeoff');
        expect(snapshot).toContain('An unfinished streaming answer');
        expect(snapshot).not.toContain('private reasoning excluded');
        parentLog.meta('meta.turn_ended', 'meta:turn:live-turn:ended', live.nativeTurnId, draft.createdAt, { turnId: live.nativeTurnId, status: 'cancelled' });
        expect((await asks('POST', `/api/sessions/${parent.id}/discussions`, liveBody)).json().session.origin.discussion.contextRef).toBe(saved.origin.discussion.contextRef);
        // A discarded draft is absent from the visible transcript and cannot seed a new discussion.
        expect((await asks('POST', `/api/sessions/${parent.id}/discussions`, { ...liveBody, clientSessionId: 'side-discarded', commandId: 'side-discarded-first' })).statusCode).toBe(400);
        expect(fetch.mock.calls.filter(([url]) => String(url).includes('codex-discussion.example'))).toHaveLength(1);
      } finally { kick.mockRestore(); }
      const reopened = new Store(join(stateDir, 'workbench.db'));
      try {
        const saved = reopened.getSession(child.id);
        expect(saved.origin?.discussion?.contextRef).toBe(child.origin.discussion.contextRef);
        expect(reopened.journal.sessionBlob(child.id, saved.origin!.discussion!.contextRef)!.bytes().toString()).toBe(blob.bytes().toString());
        expect(reopened.listRuns(child.id)).toHaveLength(3);
      } finally { reopened.close(); }
    } finally { transcript.mockRestore(); fetch.mockRestore(); }
  });

  it('creates a projectless task atomically, remembers its receipt and promotes the same directory', async () => {
    const { app, cookie, csrf, projectDir, store, dispatch } = await boot();
    const root = join(projectDir, 'task-files');
    const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => app.inject({ method, url,
      headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf, [CLIENT_FEATURES_HEADER]: 'projectless-tasks' }, ...(payload ? { payload } : {}) });
    const kick = vi.spyOn(dispatch, 'kick').mockImplementation(() => undefined);
    try {
      const updated = await call('PATCH', '/api/settings', { taskWorkspaceRoot: root });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().taskWorkspaceRoot).toBe(await realpath(root));
      const providerHome = join(projectDir, 'provider-home');
      expect((await call('POST', '/api/backends/codex/profiles', { id: 'private-home', name: 'Private home', configDir: providerHome })).statusCode).toBe(200);
      const privateRoot = await call('PATCH', '/api/settings', { taskWorkspaceRoot: join(providerHome, 'tasks') });
      expect(privateRoot.json().error.code).toBe('INVALID_TASK_WORKSPACE_ROOT');
      await expect(readdir(providerHome)).rejects.toMatchObject({ code: 'ENOENT' });
      const location = await call('GET', '/api/task-workspaces/location');
      expect(location.json()).toEqual({ path: await realpath(root), source: 'custom', available: true });
      expect(store.listProjects().filter(project=>project.system!=='quick-chat'&&project.system!=='assistant')).toHaveLength(0);
      const request = { kind: 'native', projectless: true, backendId: 'cursor', clientSessionId: 'projectless-route-1', initialMessage: { commandId: 'first-1', text: '整理资料' } };
      const unsupportedRequest={...request,clientSessionId:'projectless-unsupported',initialMessage:{...request.initialMessage,commandId:'unsupported-first'}};
      const unsupported=await app.inject({method:'POST',url:'/api/sessions',headers:{host:'127.0.0.1:4317',cookie,'x-csrf-token':csrf},payload:unsupportedRequest});
      expect(unsupported.statusCode).toBe(409);
      expect(unsupported.json().error).toMatchObject({code:'FEATURE_REQUIRED',details:{accepted:false}});
      // A definitive rejection cannot later accept a delayed retry of the same command.
      expect((await call('POST','/api/sessions',unsupportedRequest)).json().error).toMatchObject({code:'FEATURE_REQUIRED',details:{accepted:false}});
      for (const [index,invalid] of [
        { ...request, projectId: 'other' }, { ...request, backendId: 'chat' }, { ...request, resumePicker: true },
        { ...request, initialMessage: { ...request.initialMessage, context: [{ path: '/old-project/file.md' }] } },
      ].entries()) {
        expect([400,404]).toContain((await call('POST', '/api/sessions', {...invalid,clientSessionId:`invalid-task-${index}`,initialMessage:{...invalid.initialMessage,commandId:`invalid-first-${index}`}})).statusCode);
        expect(store.listProjects().filter(project=>project.system!=='quick-chat'&&project.system!=='assistant')).toHaveLength(0);
      }
      const first = await call('POST', '/api/sessions', request);
      expect(first.statusCode).toBe(202);
      const accepted = first.json();
      expect(accepted.project.system).toBe('task-workspace');
      expect(accepted.session.projectId).toBe(accepted.project.id);
      expect(accepted.run.sessionId).toBe(accepted.session.id);
      const negotiated = await app.inject({ method: 'POST', url: '/api/sessions', payload: { ...request, backendId: 'pi', clientSessionId: 'projectless-pi', initialMessage: { commandId: 'first-pi', text: 'Pi task' } },
        headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf, [CLIENT_FEATURES_HEADER]: 'projectless-tasks,pi-agent' } });
      expect(negotiated.statusCode).toBe(202);
      expect((await call('POST', '/api/sessions', { ...request, backendId: 'pi', clientSessionId: 'projectless-pi', initialMessage: { commandId: 'first-pi', text: 'Pi task' } })).json().error.code).toBe('SESSION_NOT_FOUND');
      expect((await call('POST',`/api/projects/${accepted.project.id}/worktree-projects`,{})).json().error.code).toBe('TASK_WORKSPACE_SAVE_REQUIRED');
      const oldCall=(method:'GET'|'POST'|'PATCH'|'PUT'|'DELETE',url:string,payload?:object)=>app.inject({method,url,headers:{host:'127.0.0.1:4317',cookie,'x-csrf-token':csrf},...(payload?{payload}:{})});
      expect((await oldCall('POST','/api/projects',{cwd:accepted.project.cwd})).statusCode).toBe(404);
      expect((await call('POST','/api/projects',{cwd:accepted.project.cwd})).json().error.code).toBe('SYSTEM_PROJECT');
      await mkdir(join(accepted.project.cwd,'assets'));
      const favorite=store.createFolderFavorite('assets',accepted.project.id);
      expect((await oldCall('GET',`/api/folder-favorites?projectId=${accepted.project.id}`)).statusCode).toBe(404);
      expect((await oldCall('PATCH',`/api/folder-favorites/${favorite.id}`,{label:'hidden update'})).statusCode).toBe(404);
      expect((await oldCall('PUT','/api/folder-favorites/order',{ids:[favorite.id]})).statusCode).toBe(404);
      expect((await oldCall('DELETE',`/api/folder-favorites/${favorite.id}`)).statusCode).toBe(404);
      expect(store.getFolderFavorite(favorite.id).label).toBeUndefined();
      const mark=await call('POST','/api/marks',{id:'managed-mark',sessionId:accepted.session.id,kind:'message',anchor:{messageId:'managed-answer'},snapshot:{text:'saved answer',at:new Date().toISOString()}});
      expect(mark.statusCode).toBe(200);
      const hiddenMarks = await oldCall('GET','/api/marks');
      expect(hiddenMarks.json()).toMatchObject({total:0,marks:[]});
      expect((await call('GET','/api/marks')).json().marks.map(({id}:{id:string})=>id)).toEqual(['managed-mark']);
      expect((await oldCall('GET','/api/marks/managed-mark/prompt')).statusCode).toBe(404);
      expect((await oldCall('POST','/api/marks/delete',{ids:['managed-mark']})).statusCode).toBe(404);
      store.transitionNativeRun(accepted.run.id,['queued'],{delivery:'observed'},{state:'completed'});
      expect((await oldCall('GET','/api/stats/runs')).json().rows).toEqual([]);
      expect((await call('GET','/api/stats/runs')).json().rows.map(({runId}:{runId:string})=>runId)).toEqual([accepted.run.id]);
      expect((await call('POST', '/api/sessions', { ...request, initialMessage: { ...request.initialMessage, text: 'changed' } })).json().error.code).toBe('SESSION_ID_CONFLICT');
      await writeFile(join(accepted.project.cwd, 'result.md'), 'saved work');
      const promoted = await call('POST', `/api/projects/${accepted.project.id}/promote`, { name: 'Saved project' });
      expect(promoted.statusCode).toBe(200);
      expect(promoted.json()).toMatchObject({ id: accepted.project.id, cwd: accepted.project.cwd, name: 'Saved project' });
      expect(promoted.json().system).toBeUndefined();
      const visibleMarks = await app.inject({ method: 'GET', url: '/api/marks', headers: {
        host: '127.0.0.1:4317', cookie, 'if-none-match': hiddenMarks.headers.etag!,
      } });
      expect(visibleMarks.statusCode).toBe(200);
      expect(visibleMarks.json().marks.map(({id}:{id:string})=>id)).toEqual(['managed-mark']);
      expect((await oldCall('GET','/api/stats/runs')).json().rows.map(({runId}:{runId:string})=>runId)).toEqual([accepted.run.id]);
      const marksRevision = store.marksRevision;
      expect((await call('POST', `/api/projects/${accepted.project.id}/promote`, { name: 'Saved project' })).statusCode).toBe(200);
      expect(store.marksRevision).toBe(marksRevision);
      expect((await call('POST', `/api/projects/${accepted.project.id}/promote`, { name: 'Other name' })).json().error.code).toBe('PROJECT_PROMOTION_CONFLICT');
      await rm(accepted.project.cwd, { recursive: true });
      const replay = await call('POST', '/api/sessions', request);
      expect(replay.statusCode).toBe(202);
      expect(replay.json().run.id).toBe(accepted.run.id);
      expect(replay.json().project.system).toBeUndefined();
      expect(store.listRuns(accepted.session.id)).toHaveLength(1);
      expect((await call('PATCH', '/api/settings', { taskWorkspaceRoot: null })).json().taskWorkspaceRoot).toBeUndefined();
    } finally { kick.mockRestore(); }
  });

  it('rejects continuing a missing managed task directory while preserving history', async () => {
    const { app, cookie, csrf, projectDir, store, terminal, dispatch } = await boot();
    // Set an isolated writable root after boot; no user's Documents folder is touched.
    const root = join(projectDir, 'managed');
    const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => app.inject({ method, url,
      headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf, [CLIENT_FEATURES_HEADER]: 'projectless-tasks' }, ...(payload ? { payload } : {}) });
    const kick = vi.spyOn(dispatch, 'kick').mockImplementation(() => undefined);
    try {
      await call('PATCH', '/api/settings', { taskWorkspaceRoot: root });
      const created = await call('POST', '/api/sessions', { kind: 'native', projectless: true, backendId: 'cursor', clientSessionId: 'missing-managed', initialMessage: { commandId: 'first', text: 'Create a report' } });
      expect(created.statusCode).toBe(202);
      const result = created.json();
      await rm(result.project.cwd, { recursive: true });
      const started = await call('POST', `/api/sessions/${result.session.id}/start`, {});
      expect(started.statusCode).toBe(409);
      expect(started.json().error.code).toBe('TASK_WORKSPACE_UNAVAILABLE');
      expect((await call('POST',`/api/sessions/${result.session.id}/native/send`,{commandId:'second',text:'Continue'})).json().error.code).toBe('TASK_WORKSPACE_UNAVAILABLE');
      expect((await call('POST','/api/native/prewarm',{projectId:result.project.id,backendId:'cursor'})).json().error.code).toBe('TASK_WORKSPACE_UNAVAILABLE');
      expect((await call('POST','/api/terminals',{projectId:result.project.id})).json().error.code).toBe('TASK_WORKSPACE_UNAVAILABLE');
      await expect(terminal.create(result.project)).rejects.toMatchObject({ code: 'TASK_WORKSPACE_UNAVAILABLE' });
      await expect(terminal.createWarmup(result.project, { launchSpec: { command: 'agent', args: [], cwd: result.project.cwd }, warmup: {
        nativeSessionId: 'warmup', ownerToken: 'test', resourceKey: 'test', expiresAt: Date.now() + 60_000,
      } })).rejects.toMatchObject({ code: 'TASK_WORKSPACE_UNAVAILABLE' });
      expect(store.listTerminals()).toHaveLength(0);
      expect(store.listRuns(result.session.id)).toHaveLength(1);
      expect(store.getSession(result.session.id)).toMatchObject({ id: result.session.id });
      await expect(readdir(result.project.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { kick.mockRestore(); }
  });

  it('guards Finder handoffs with CSRF and accepts only direct local requests', async () => {
    const { app, cookie, csrf, projectDir, store, call } = await boot(undefined, undefined, undefined, true);
    const project = store.createProject(projectDir, 'Finder');
    const url = `/api/projects/${project.id}/reveal`;
    const reveal = vi.spyOn(WorkspaceService.prototype, 'revealInFinder').mockResolvedValue({ opened: true });
    try {
      const support = await call('GET', url);
      expect(support.statusCode).toBe(200);
      expect(support.json()).toEqual({ supported: process.platform === 'darwin' });
      const proxySupport = await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317', cookie, 'x-forwarded-for': '192.0.2.10' } });
      expect(proxySupport.json()).toEqual({ supported: false });
      const remoteSupport = await app.inject({ method: 'GET', url, remoteAddress: '192.0.2.10', headers: { host: '127.0.0.1:4317', cookie } });
      expect(remoteSupport.statusCode).toBe(200);
      expect(remoteSupport.json()).toEqual({ supported: false });
      const withoutCsrf = await app.inject({ method: 'POST', url, headers: { host: '127.0.0.1:4317', cookie }, payload: { path: 'artifact.json' } });
      expect(withoutCsrf.statusCode).toBe(403);
      // Served over HTTPS by a front door on this machine, so the transport allows it; the route still wants this machine.
      const proxied = await app.inject({ method: 'POST', url, headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf, 'x-forwarded-for': '192.0.2.10', 'x-forwarded-proto': 'https' }, payload: { path: 'artifact.json' } });
      expect(proxied.statusCode).toBe(403);
      expect(proxied.json().error.code).toBe('LOCAL_ACCESS_ONLY');
      const remote = await app.inject({ method: 'POST', url, remoteAddress: '192.0.2.10', headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf }, payload: { path: 'artifact.json' } });
      expect(remote.statusCode).toBe(403);
      expect(reveal).not.toHaveBeenCalled();
      const local = await call('POST', url, { path: 'artifact.json' });
      expect(local.statusCode).toBe(200);
      expect(local.json()).toEqual({ opened: true });
      expect(reveal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: project.id }), 'artifact.json', { allowOutside: true });
    } finally { reveal.mockRestore(); }
  });

  it.each(['draft', 'print'])('preserves share %s error references after switching to a progress stream', async path => {
    const { app, cookie, csrf, projectDir, store } = await boot();
    const session = store.createSession({ projectId: store.createProject(projectDir, 'share-draft').id, kind: 'native' });
    const response = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/share/${path}`,
      headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf, accept: 'application/x-ndjson' },
      payload: { appearance: { themeId: 'custom-deleted-theme', mode: 'dark', themeRevision: 'previous' } } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    expect(JSON.parse(response.body.trim())).toMatchObject({ type: 'error', messageRef: { code: 'SHARE_THEME_CHANGED' } });
  });

  it('serves the isolated Mermaid renderer without credentials and revalidates its compressed document', async () => {
    const { app } = await boot();
    const page = await app.inject({ method: 'GET', url: '/mermaid', headers: { host: '127.0.0.1:4317', 'accept-encoding': 'gzip' } });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-encoding']).toBe('gzip');
    expect(page.headers.vary).toBe('Accept-Encoding');
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("sandbox allow-scripts; default-src 'none'");
    expect(csp).not.toContain('allow-same-origin');
    const html = gunzipSync(page.rawPayload).toString('utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    const scriptPolicy = csp.split(';').find((directive) => directive.trim().startsWith('script-src'))!;
    expect(scriptPolicy).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
    for (const script of scripts) expect(scriptPolicy).toContain(`'sha256-${createHash('sha256').update(script).digest('base64')}'`);
    const cached = await app.inject({ method: 'GET', url: '/mermaid', headers: { host: '127.0.0.1:4317', 'accept-encoding': 'gzip', 'if-none-match': String(page.headers.etag) } });
    expect(cached.statusCode).toBe(304);
    expect(cached.rawPayload.length).toBe(0);
  }, 45_000);

  it('stores and downloads archives, documents and unknown binary attachments without changing their bytes or names', async () => {
    const { projectDir, call } = await boot();
    const project = (await call('POST', '/api/projects', { cwd: projectDir, name: 'attachments' })).json();
    const session = (await call('POST', '/api/sessions', { projectId: project.id, kind: 'native' })).json();
    const data = Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64');
    const attachments = [];
    for (const [name, mimeType] of [
      ['项目 资料.zip', 'application/zip'],
      ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['data.csv', 'text/csv'],
      ['unknown.custom', 'application/octet-stream'],
    ]) {
      const uploaded = await call('POST', `/api/projects/${project.id}/attachments`, { name, mimeType, dataBase64: data.toString('base64') });
      expect(uploaded.statusCode).toBe(200);
      const attachment = uploaded.json();
      attachments.push({ id: attachment.id });
      const metadata = await call('GET', `/api/attachments/${attachment.id}/metadata`);
      expect(metadata.json()).toMatchObject({ name, mimeType, size: data.length });
      const downloaded = await call('GET', `/api/attachments/${attachment.id}`);
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.rawPayload).toEqual(data);
      expect(downloaded.headers['content-type']).toBe(mimeType);
      expect(downloaded.headers['content-length']).toBe(String(data.length));
      expect(downloaded.headers['content-disposition']).toBe(`attachment; filename*=UTF-8''${encodeURIComponent(name!)}`);
      expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
    }
    // Multi-megabyte media used to overflow the base64 validation and fail with a 500.
    const video = randomBytes(4 * 1024 * 1024);
    const uploaded = await call('POST', `/api/projects/${project.id}/attachments`, { name: 'clip.mp4', mimeType: 'video/mp4', dataBase64: video.toString('base64') });
    expect(uploaded.json()).toMatchObject({ mimeType: 'video/mp4', size: video.length });
    expect((await call('POST', `/api/projects/${project.id}/attachments`, { name: 'bad.bin', mimeType: 'application/octet-stream', dataBase64: 'AA=A' })).statusCode).toBe(400);
    const sent = await call('POST', `/api/sessions/${session.id}/native/send`, { commandId: 'generic-files', text: 'Inspect these files', attachments });
    expect(sent.statusCode).toBe(202);
    expect(sent.json().native.input.attachmentIds).toEqual(attachments.map(attachment => attachment.id));
  });

  it('streams a previewed media file by range through an address scoped to that file', async () => {
    const { app, cookie, projectDir, call } = await boot(undefined, undefined, undefined, true);
    const project = (await call('POST', '/api/projects', { cwd: projectDir })).json();
    await writeFile(join(projectDir, 'clip.mp4'), Buffer.from('0123456789'));
    await writeFile(join(projectDir, 'notes.txt'), 'neighbour');
    const preview = await call('GET', `/api/projects/${project.id}/file/raw?path=clip.mp4&render=preview`);
    expect(preview.statusCode).toBe(200);
    const src = /<video[^>]* src="([^"]+)"/.exec(preview.body)?.[1];
    expect(src).toMatch(/^\.\.\/\.\.\/\.\.\/file-sites\/[^/]+\/clip\.mp4$/);
    const media = new URL(src!.replaceAll('&amp;', '&'), `http://127.0.0.1:4317/api/projects/${project.id}/file/raw`).pathname;
    const fromPage = (url: string, range?: string) => app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317', 'sec-fetch-site': 'cross-site', ...(range ? { range } : {}) } });
    const part = await fromPage(media, 'bytes=2-5');
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 2-5/10');
    expect(part.body).toBe('2345');
    expect((await fromPage(media, 'bytes=-3')).body).toBe('789');
    expect((await fromPage(media, 'bytes=20-')).statusCode).toBe(416);
    expect((await fromPage(media)).body).toBe('0123456789');
    // The address names one file; the folder it sits in stays closed.
    expect((await fromPage(media.replace(/clip\.mp4$/, 'notes.txt'))).statusCode).toBe(404);
    const raw = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/file/raw?path=clip.mp4`, headers: { host: '127.0.0.1:4317', cookie, range: 'bytes=0-0' } });
    expect(raw.statusCode).toBe(206);
  });

  it('serves a previewed page its own folder, reached from its opaque origin, until the session ends', async () => {
    const { app, projectDir, call } = await boot(undefined, undefined, undefined, true);
    const project = (await call('POST', '/api/projects', { cwd: projectDir })).json();
    await mkdir(join(projectDir, 'site', '.git'), { recursive: true });
    await writeFile(join(projectDir, 'site', 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body><a href="next.html">next</a></body></html>');
    await writeFile(join(projectDir, 'site', 'app.css'), 'body{color:red}');
    await writeFile(join(projectDir, 'site', '.env'), 'SECRET=1');
    await writeFile(join(projectDir, 'site', '.git', 'config'), '[core]');
    await writeFile(join(projectDir, 'site', 'deploy.pem'), 'key');
    await writeFile(join(projectDir, 'outside.txt'), 'project root');
    const minted = await call('GET', `/api/projects/${project.id}/file/raw?path=site%2Findex.html&render=site`);
    expect(minted.statusCode).toBe(302);
    const page = new URL(String(minted.headers.location), `http://127.0.0.1:4317/api/projects/${project.id}/file/raw`).pathname;
    expect(page).toMatch(/^\/api\/file-sites\/[^/]+\/index\.html$/);
    const site = page.slice(0, -'index.html'.length);
    // The page's own requests: no cookie, cross-site, and `Origin: null` for fetches.
    const fromPage = (url: string) => app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317', origin: 'null', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' } });
    const html = await fromPage(page);
    expect(html.statusCode, html.body).toBe(200);
    expect(String(html.headers['content-security-policy'])).toMatch(/^sandbox allow-scripts/);
    expect(String(html.headers['content-security-policy'])).not.toContain('allow-same-origin');
    expect(html.body).toMatch(/^<!doctype html><html><head><script>.*riffet-file-site/);
    const css = await fromPage(`${site}app.css`);
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    expect(css.headers['access-control-allow-origin']).toBe('*');
    expect((await app.inject({ method: 'GET', url: `${site}app.css`, headers: { host: '127.0.0.1:4317', 'if-none-match': String(css.headers.etag) } })).statusCode).toBe(304);
    // A link followed inside the frame gets a page that reports its status to the panel.
    const missing = await app.inject({ method: 'GET', url: `${site}gone.html`, headers: { host: '127.0.0.1:4317', 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain('text/html');
    expect(missing.body).toContain('status:404');
    for (const refused of ['.env', '.git/config', 'deploy.pem', '..%2Foutside.txt', '%2E%2E/outside.txt']) expect((await fromPage(`${site}${refused}`)).statusCode, refused).toBeGreaterThanOrEqual(400);
    const tampered = page.replace(/\/api\/file-sites\/([^/]+)\./, (_, payload: string) => `/api/file-sites/${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), r: projectDir })).toString('base64url')}.`);
    expect((await fromPage(tampered.replace('index.html', 'outside.txt'))).statusCode).toBe(401);
    // Other API routes still refuse the page's cross-site, cookie-less requests.
    expect((await fromPage(`/api/projects/${project.id}/file/raw?path=outside.txt`)).statusCode).toBe(403);
    expect((await call('GET', `/api/projects/${project.id}/file/raw?path=site%2Fapp.css&render=site`)).statusCode).toBe(415);
    // Reopening another page keeps the site rooted at the folder first opened.
    await mkdir(join(projectDir, 'site', 'sub'));
    await writeFile(join(projectDir, 'site', 'sub', 'a.html'), '<a href="../index.html">up</a>');
    const reopened = await call('GET', `/api/projects/${project.id}/file/raw?path=site%2Findex.html&render=site&page=sub%2Fa.html`);
    const reopenedPage = new URL(String(reopened.headers.location), `http://127.0.0.1:4317/api/projects/${project.id}/file/raw`).pathname;
    expect(reopenedPage).toMatch(/\/sub\/a\.html$/);
    expect((await fromPage(reopenedPage.replace(/sub\/a\.html$/, 'app.css'))).statusCode).toBe(200);
    expect((await call('GET', `/api/projects/${project.id}/file/raw?path=site%2Findex.html&render=site&page=..%2Foutside.txt`)).statusCode).toBe(400);
    // Outside the project only the single file opens, as the single-file read there allows.
    const elsewhere = await mkdtemp(join(tmpdir(), 'riffet-elsewhere-'));
    await writeFile(join(elsewhere, 'page.html'), '<p>outside</p>');
    await writeFile(join(elsewhere, 'neighbour.txt'), 'private');
    const outsideMint = await call('GET', `/api/projects/${project.id}/file/raw?path=${encodeURIComponent(join(elsewhere, 'page.html'))}&render=site`);
    const outsidePage = new URL(String(outsideMint.headers.location), `http://127.0.0.1:4317/api/projects/${project.id}/file/raw`).pathname;
    expect((await fromPage(outsidePage)).statusCode).toBe(200);
    expect((await fromPage(outsidePage.replace(/page\.html$/, 'neighbour.txt'))).statusCode).toBe(404);
    await rm(elsewhere, { recursive: true, force: true });
    await call('POST', '/api/auth/logout');
    expect((await fromPage(page)).statusCode).toBe(401);
    const expired = await app.inject({ method: 'GET', url: page, headers: { host: '127.0.0.1:4317', 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' } });
    expect(expired.statusCode).toBe(401);
    expect(expired.body).toContain('status:401');
  });

  it('keeps generated previews scoped and isolated while original downloads retain their bytes', async () => {
    const { projectDir, stateDir, call } = await boot();
    const project = (await call('POST', '/api/projects', { cwd: projectDir })).json();
    const data = Buffer.from('name,value\n"<script>parent.fetch(1)</script>",42\n');
    await writeFile(join(projectDir, 'data.csv'), data);
    await writeFile(join(projectDir, 'utf16.md'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# 中文', 'utf16le')]));
    const metadata = await call('GET', `/api/projects/${project.id}/file?path=utf16.md`);
    expect(metadata.json()).toMatchObject({ binary: false, content: '# 中文', render: { kind: 'markdown' } });
    await writeFile(join(projectDir, 'rule.mdc'), '---\ndescription: Rule note\nalwaysApply: true\n---\n\n# Rule Title\n');
    const mdcMeta = await call('GET', `/api/projects/${project.id}/file?path=rule.mdc`);
    expect(mdcMeta.json()).toMatchObject({ binary: false, render: { kind: 'markdown' } });
    const mdcRendered = await call('GET', `/api/projects/${project.id}/file/raw?path=rule.mdc&render=preview`);
    expect(mdcRendered.statusCode, mdcRendered.body).toBe(200);
    expect(mdcRendered.body).toContain('Rule note');
    expect(mdcRendered.body).toContain('<h1>Rule Title</h1>');
    expect(mdcRendered.body).not.toContain('<h2>description:');
    const rendered = await call('GET', `/api/projects/${project.id}/file/raw?path=data.csv&render=preview&scheme=dark&color=%23ededed`);
    expect(rendered.statusCode).toBe(200);
    expect(rendered.headers['content-type']).toContain('text/html');
    expect(rendered.headers['cache-control']).toBe('no-store');
    const csp = String(rendered.headers['content-security-policy']);
    expect(csp).toContain("sandbox allow-scripts; default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain('allow-same-origin');
    expect(rendered.body).toContain('&lt;script&gt;parent.fetch(1)&lt;/script&gt;');
    expect(rendered.body).not.toContain('<script>parent.fetch(1)</script>');
    expect((await call('GET', `/api/projects/${project.id}/file/raw?path=data.csv&download=1&render=preview`)).rawPayload).toEqual(data);
    const denied = await call('GET', `/api/projects/${project.id}/file/raw?path=${encodeURIComponent(join(stateDir, 'access-token'))}&render=preview`);
    expect(denied.statusCode).toBe(403);
    const attachment = (await call('POST', `/api/projects/${project.id}/attachments`, { name: 'data.csv', mimeType: 'text/csv', dataBase64: data.toString('base64') })).json();
    expect((await call('GET', `/api/attachments/${attachment.id}?render=preview`)).headers['content-type']).toContain('text/html');
    expect((await call('GET', `/api/attachments/${attachment.id}`)).rawPayload).toEqual(data);
    await mkdir(join(projectDir, 'docs'));
    const light = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>light-only</text></svg>');
    const dark = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>dark-only</text></svg>');
    await writeFile(join(projectDir, 'docs', 'light.svg'), light);
    await writeFile(join(projectDir, 'docs', 'dark.svg'), dark);
    await writeFile(join(projectDir, 'docs', 'README.md'), `<picture><source media="(prefers-color-scheme: dark)" srcset="dark.svg"><source media="(prefers-color-scheme: light)" srcset="light.svg"><img src="light.svg" alt="Logo" width="100%"></picture>\n\n![denied](${join(stateDir, 'access-token')})\n\n<script>parent.fetch('/api/auth/status')</script><iframe src="/api/auth/status"></iframe>`);
    for (const [scheme, selected, excluded] of [['dark', dark, light], ['light', light, dark]] as const) {
      const page = await call('GET', `/api/projects/${project.id}/file/raw?path=docs%2FREADME.md&render=preview&scheme=${scheme}`);
      expect(page.statusCode, page.body).toBe(200);
      expect(page.body).toContain(`data:image/svg+xml;base64,${selected.toString('base64')}`);
      expect(page.body).not.toContain(excluded.toString('base64'));
      expect(page.body).not.toContain('<picture');
      expect(page.body).not.toContain('srcSet=');
      expect(page.body).not.toContain('docs/dark.svg');
      expect(page.body).not.toContain(join(stateDir, 'access-token'));
      expect(page.body).not.toContain('parent.fetch');
      expect(page.body).not.toContain('<iframe');
      expect(page.body).toContain('alt="denied"');
    }
    const imageAttachment = (await call('POST', `/api/projects/${project.id}/attachments`, { name: 'dark.svg', mimeType: 'image/svg+xml', dataBase64: dark.toString('base64') })).json();
    const markdownAttachment = (await call('POST', `/api/projects/${project.id}/attachments`, { name: 'note.md', mimeType: 'text/markdown', dataBase64: Buffer.from(`![attached](attachment:${imageAttachment.id}) ![unscoped](light.svg)`).toString('base64') })).json();
    const attachedPreview = await call('GET', `/api/attachments/${markdownAttachment.id}?render=preview`);
    expect(attachedPreview.statusCode, attachedPreview.body).toBe(200);
    expect(attachedPreview.body).toContain(`data:image/svg+xml;base64,${dark.toString('base64')}`);
    expect(attachedPreview.body).not.toContain('light.svg');
    const { DatabaseSync } = await import('node:sqlite');
    const databasePath = join(projectDir, 'readonly.db');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE records (value TEXT); INSERT INTO records VALUES (\'saved value\'); CREATE VIEW hidden_view AS SELECT * FROM records;');
    database.close();
    const original = await readFile(databasePath);
    const databasePreview = await call('GET', `/api/projects/${project.id}/file/raw?path=readonly.db&render=preview`);
    expect(databasePreview.statusCode).toBe(200);
    expect(databasePreview.body).toContain('saved value');
    expect(databasePreview.body).not.toContain('hidden_view');
    expect(await readFile(databasePath)).toEqual(original);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>parent.fetch(1)</script></svg>';
    await writeFile(join(projectDir, 'vector.svg'), svg);
    const vector = await call('GET', `/api/projects/${project.id}/file/image?path=vector.svg`);
    expect(vector.statusCode).toBe(200);
    expect(vector.headers['content-type']).toContain('image/svg+xml');
    expect(vector.headers['content-security-policy']).toContain("sandbox; default-src 'none'");
    expect(vector.headers['content-security-policy']).not.toContain('allow-scripts');
  });

  it('serves the workbench after an external link navigation without opening cross-site APIs or frames', async () => {
    const html = '<!doctype html><title>Riffet</title>';
    const { app } = await boot(undefined, html);
    const headers = {
      host: '127.0.0.1:4317', 'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-user': '?1',
    };
    const page = await app.inject({ method: 'GET', url: '/', headers });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toBe(html);
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    for (const url of ['/api/bootstrap', '/api/auth/status']) {
      const response = await app.inject({ method: 'GET', url, headers });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('INVALID_ORIGIN');
    }
    const frame = await app.inject({ method: 'GET', url: '/', headers: { ...headers, 'sec-fetch-dest': 'iframe' } });
    expect(frame.statusCode).toBe(403);
    const form = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: {} });
    expect(form.statusCode).toBe(403);
  });

  it('boots with retired persisted backend settings and preserves other settings on save', async () => {
    const { stateDir, call } = await boot({ defaultBackend: 'native', defaultModel: 'legacy-model' });
    const bootstrap = await call('GET', '/api/bootstrap');
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().settings).toEqual({ defaultModel: 'legacy-model', defaultBackendId: 'claude', allowOutsideRead: true, quickChat: { presets: DEFAULT_QUICK_CHAT_PRESETS } });
    const saved = await call('PATCH', '/api/settings', { defaultBackendId: 'codex', notifications: true });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ defaultBackendId: 'codex', defaultModel: 'legacy-model', notifications: true });
    const persisted = JSON.parse(await readFile(join(stateDir, 'settings.json'), 'utf8'));
    expect(persisted).not.toHaveProperty('defaultBackend');
    expect(persisted.defaultModel).toBe('legacy-model');
    // The default presets are what a reader sees, never what is stored.
    expect(persisted).not.toHaveProperty('quickChat');
    const invalid = await call('PATCH', '/api/settings', { defaultBackend: 'native' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('INVALID_SETTINGS');
    expect((await call('PATCH', '/api/settings', { defaultBackendId: ['codex'] })).statusCode).toBe(400);
  });

  it('stores the composer Enter behavior as one of two literal values', async () => {
    const { stateDir, call } = await boot();
    // Absent means "newline" on the client; the server only has to not invent a value.
    expect((await call('GET', '/api/bootstrap')).json().settings).not.toHaveProperty('composerEnterBehavior');
    const saved = await call('PATCH', '/api/settings', { composerEnterBehavior: 'send' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().composerEnterBehavior).toBe('send');
    // A partial patch leaves the rest of the record alone, so the switch survives other saves.
    expect((await call('PATCH', '/api/settings', { notifications: true })).json()).toMatchObject({ composerEnterBehavior: 'send', notifications: true });
    expect(JSON.parse(await readFile(join(stateDir, 'settings.json'), 'utf8')).composerEnterBehavior).toBe('send');
    const invalid = await call('PATCH', '/api/settings', { composerEnterBehavior: 'steer' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('INVALID_SETTINGS');
    expect((await call('PATCH', '/api/settings', { composerEnterBehavior: 'newline' })).json().composerEnterBehavior).toBe('newline');
  });

  it('stores auxiliary models per purpose, refuses a backend that cannot serve them, and clears one with null', async () => {
    const { call } = await boot();
    const title = { backendId: 'dsh', profileId: 'gateway', model: 'deepseek-v4.1-flash' };
    const handoff = { ...title, model: 'glm-5.3' };
    expect((await call('PATCH', '/api/settings', { auxiliaryModels: { title } })).statusCode).toBe(400);
    expect((await call('POST', '/api/backends/dsh/profiles', { id: 'gateway', name: 'Gateway', apiEndpoint: 'https://gateway.example.com', enabledModels: ['deepseek-v4.1-flash'] })).statusCode).toBe(200);
    expect((await call('PATCH', '/api/settings', { auxiliaryModels: { title } })).json().auxiliaryModels).toEqual({ title });
    // A request naming one purpose leaves the others as they were.
    expect((await call('PATCH', '/api/settings', { auxiliaryModels: { handoff } })).json().auxiliaryModels).toEqual({ title, handoff });
    expect((await call('PATCH', '/api/settings', { auxiliaryModels: { handoff: { ...title, backendId: 'cursor' } } })).statusCode).toBe(400);
    expect((await call('PATCH', '/api/settings', { auxiliaryModels: { title: { ...title, extra: 1 } } })).statusCode).toBe(400);
    expect((await call('PATCH', '/api/settings', { auxiliaryModels: { weather: title } })).statusCode).toBe(400);
    expect((await call('PATCH', '/api/settings', { auxiliaryModels: { title: null } })).json().auxiliaryModels).toEqual({ handoff });
    expect((await call('PATCH', '/api/settings', { auxiliaryModels: { handoff: null } })).json()).not.toHaveProperty('auxiliaryModels');
    expect((await call('GET', '/api/auxiliary-models')).json().models).toContainEqual({ ...title, profileName: 'Gateway', transport: 'http' });
    // The canvas's summary model is a purpose of its own.
    expect((await call('PATCH', '/api/settings', { auxiliaryModels: { summary: handoff } })).json().auxiliaryModels).toEqual({ summary: handoff });
    expect((await call('PATCH', '/api/settings', { auxiliaryModels: { summary: null } })).json()).not.toHaveProperty('auxiliaryModels');
  });

  it('previews both auxiliary purposes on explicit input without saving or launching, and exposes model failures', async () => {
    const { call, store, settings } = await boot();
    const ref = { backendId: 'dsh', profileId: 'preview-gateway', model: 'preview-model' };
    expect((await call('POST', '/api/backends/dsh/profiles', {
      id: ref.profileId, name: 'Preview', apiEndpoint: 'https://preview.example/v1', apiKey: 'preview-key', enabledModels: [ref.model],
    })).statusCode).toBe(200);
    const before = settings.getSettings();
    const completion = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }), { status: 200 });
    const request = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(completion('优化辅助模型试用'))
      .mockResolvedValueOnce(completion('## 已完成\n精简菜单。\n\n## 待处理\n验证输入和生成结果。'))
      .mockResolvedValueOnce(completion(''));
    try {
      const invalid = await call('POST', '/api/auxiliary-models/preview', { ...ref, purpose: 'title' });
      expect(invalid.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
      expect((await call('POST', '/api/auxiliary-models/preview', { ...ref, purpose: 'handoff', message: '  \n ' })).statusCode).toBe(400);
      expect((await call('POST', '/api/auxiliary-models/preview', { ...ref, purpose: 'handoff', message: 'x'.repeat(150_001) })).statusCode).toBe(400);
      expect(request).not.toHaveBeenCalled();

      const message = '精简辅助模型菜单，并让用户输入后查看生成结果';
      const title = await call('POST', '/api/auxiliary-models/preview', { ...ref, purpose: 'title', message });
      expect(title.statusCode).toBe(200);
      expect(title.json()).toEqual({ text: '优化辅助模型试用' });
      const transcript = '用户：精简辅助模型菜单。\n助手：菜单已精简，输入和生成结果还需要验证。';
      const summary = await call('POST', '/api/auxiliary-models/preview', { ...ref, purpose: 'handoff', message: transcript });
      expect(summary.statusCode).toBe(200);
      expect(summary.json().text).toContain('## 已完成');
      const [titleCall, summaryCall] = request.mock.calls;
      expect(String(titleCall![0])).toBe('https://preview.example/v1/chat/completions');
      expect(titleCall![1]?.headers).toMatchObject({ authorization: 'Bearer preview-key' });
      const titleBody = JSON.parse(String(titleCall![1]?.body));
      const summaryBody = JSON.parse(String(summaryCall![1]?.body));
      expect(titleBody.model).toBe(ref.model);
      expect(titleBody.messages[1].content).toContain(message);
      expect(summaryBody.messages[1].content).toContain(transcript);
      expect(summaryBody.messages[0].content).toContain('handoff note');
      expect(summaryBody.max_tokens).toBe(8_192);
      expect(settings.getSettings()).toEqual(before);
      expect(store.listSessions()).toEqual([]);

      const failed = await call('POST', '/api/auxiliary-models/preview', { ...ref, purpose: 'handoff', message: transcript });
      expect(failed.statusCode).toBe(400);
      expect(failed.json()).toMatchObject({ error: { code: 'AUXILIARY_MODEL_FAILED', params: { message: 'model returned no summary' } } });
      expect(request).toHaveBeenCalledTimes(3);
    } finally { request.mockRestore(); }
  });

  it('runs a multi-turn quick chat against a gateway, shown only to clients that ask, and archives what nobody kept', async () => {
    const { app, cookie, csrf, call, store, quickChats } = await boot();
    expect((await call('POST', '/api/backends/dsh/profiles', { id: 'gw', name: 'Gateway', apiEndpoint: 'https://gw.example/v1', apiKey: 'k', enabledModels: ['m'] })).statusCode).toBe(200);
    const asks = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => app.inject({ method, url, headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf, 'x-riffet-features': 'quick-chat' }, ...(payload === undefined ? {} : { payload: payload as object }) });
    const project = (await asks('GET', '/api/projects')).json().find((item: { system?: string }) => item.system === 'quick-chat');
    expect(project).toBeDefined();
    expect((await call('GET', '/api/projects')).json()).not.toContainEqual(expect.objectContaining({ system: 'quick-chat' }));
    expect((await call('POST', '/api/sessions', { projectId: project.id, kind: 'native', backendId: 'codex' })).statusCode).toBe(400);
    const models=(await asks('GET', `/api/backends/chat/catalog?projectId=${project.id}`)).json().models;
    expect(models.map(({value,name}:{value:string;name:string})=>({value,name}))).toEqual([{value:'dsh:gw:m',name:'Gateway · m'}]);
    expect(models[0].configOptions.map(({id,options}:{id:string;options:Array<{value:string}>})=>({id,values:options.map(option=>option.value)}))).toEqual([{id:'effort',values:['default','low','medium','high']}]);

    const sse = (...events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const request = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sse({ choices: [{ delta: { content: 'Hello' } }] }, { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }))
      .mockResolvedValueOnce(sse({ choices: [{ delta: { content: '你好' }, finish_reason: 'stop' }] }));
    try {
      const created = await asks('POST', '/api/sessions', { projectId: project.id, kind: 'native', model: 'dsh:gw:m', clientSessionId: 'qc-1', initialMessage: { commandId: 'c1', text: 'translate hello' } });
      expect(created.statusCode).toBe(202);
      const sessionId = created.json().session.id;
      const settled = async (commandId: string) => vi.waitFor(() => {
        const run = store.findRunByCommand(sessionId, commandId);
        expect(run?.state).toBe('completed');
        return run!;
      }, { timeout: 5_000 });
      await settled('c1');
      // A preset is the chat's mode: its prompt joins the instructions from the next turn on.
      expect((await call('GET', '/api/settings')).json().quickChat.presets.map((preset: { id: string }) => preset.id)).toEqual(['translate', 'explain', 'polish']);
      expect((await asks('POST', `/api/sessions/${sessionId}/native/mode`, { mode: 'preset:translate' })).json().mode).toBe('preset:translate');
      expect((await asks('POST', `/api/sessions/${sessionId}/native/send`, { commandId: 'c2', text: 'in Chinese' })).statusCode).toBe(202);
      await settled('c2');
      const second = JSON.parse(String(request.mock.calls[1]![1]?.body));
      expect(String(request.mock.calls[1]![0])).toBe('https://gw.example/v1/chat/completions');
      expect(second).toMatchObject({ model: 'm', stream: true });
      expect(second.messages[0].content).toContain('翻译用户发来的内容');
      expect(second.messages.slice(1)).toEqual([{ role: 'user', content: 'translate hello' }, { role: 'assistant', content: 'Hello world' }, { role: 'user', content: 'in Chinese' }]);
      const page = (await asks('GET', `/api/v3/sessions/${sessionId}/timeline?lane=main&before=999999999`)).json();
      expect(JSON.stringify(page)).toContain('Hello world');
      expect(JSON.stringify(page)).toContain('你好');
      expect((await call('GET', '/api/sessions')).json()).not.toContainEqual(expect.objectContaining({ id: sessionId }));
      expect((await asks('GET', '/api/sessions')).json()).toContainEqual(expect.objectContaining({ id: sessionId, backendId: 'chat' }));

      // A file the model cannot read fails the send before anything is recorded or asked.
      const binary = (await asks('POST', `/api/projects/${project.id}/attachments`, { name: 'blob.bin', mimeType: 'application/octet-stream', dataBase64: Buffer.from([0, 1, 2, 0, 255]).toString('base64') })).json();
      expect((await asks('POST', `/api/sessions/${sessionId}/native/send`, { commandId: 'bad', text: 'read this', attachments: [{ id: binary.id }] })).statusCode).toBe(202);
      await vi.waitFor(() => expect(store.findRunByCommand(sessionId, 'bad')?.state).toBe('failed'), { timeout: 5_000 });
      expect(request).toHaveBeenCalledTimes(2);
      // `/clear` starts the context over without asking the model anything.
      expect((await asks('POST', `/api/sessions/${sessionId}/native/send`, { commandId: 'c3', text: '/clear' })).statusCode).toBe(202);
      await settled('c3');
      expect(request).toHaveBeenCalledTimes(2);

      const later = Date.now() + 8 * 86_400_000;
      store.updateSession(sessionId, { pinnedAt: new Date().toISOString() });
      expect(await quickChats.sweep(later)).toEqual([]);
      store.updateSession(sessionId, { pinnedAt: undefined });
      // Letting go of a kept chat restarts its days rather than archiving it at once.
      expect(await quickChats.sweep(later)).toEqual([]);
      expect(await quickChats.sweep(later + 8 * 86_400_000)).toEqual([sessionId]);
      expect(store.getSession(sessionId).archivedAt).toBeDefined();
    } finally {
      request.mockRestore();
    }
  });

  it('reads a saved title model as the auxiliary title model and saves the new shape', async () => {
    const titleModel = { backendId: 'dsh', profileId: 'gateway', model: 'deepseek-v4.1-flash' };
    const { call, stateDir } = await boot({ notifications: true, titleModel });
    expect((await call('GET', '/api/settings')).json()).toMatchObject({ notifications: true, auxiliaryModels: { title: titleModel } });
    expect((await call('PATCH', '/api/settings', { composerEnterBehavior: 'send' })).statusCode).toBe(200);
    const saved = JSON.parse(await readFile(join(stateDir, 'settings.json'), 'utf8'));
    expect(saved).toMatchObject({ auxiliaryModels: { title: titleModel } });
    expect(saved).not.toHaveProperty('titleModel');
  });

  it('accepts a native conversation and rejects the retired ACP kind', async () => {
    const { projectDir, call } = await boot();
    const created = await call('POST', '/api/projects', { cwd: projectDir, name: 'smoke' });
    expect(created.statusCode).toBe(200);
    const projectId = (created.json() as { id: string }).id;

    const native = await call('POST', '/api/sessions', { projectId, kind: 'native', title: 'Terminal' });
    expect(native.statusCode).toBe(200);
    expect((native.json() as { kind: string }).kind).toBe('native');

    const acp = await call('POST', '/api/sessions', { projectId, kind: 'acp' });
    expect(acp.statusCode).toBe(400);
    expect((acp.json() as { error: { code: string } }).error.code).toBe('INVALID_SESSION_KIND');
  });

  it('ranks pins: new pins go first, pin-order persists and repeats as a no-op, unpinned ids are rejected', async () => {
    const { projectDir, call, store } = await boot();
    const projectId = ((await call('POST', '/api/projects', { cwd: projectDir, name: 'pins' })).json() as { id: string }).id;
    const ids: string[] = [];
    for (const title of ['A', 'B', 'C', 'D']) ids.push(((await call('POST', '/api/sessions', { projectId, kind: 'native', title })).json() as { id: string }).id);
    const [a, b, c, d] = ids as [string, string, string, string];
    const pin = async (id: string, pinned = true) => (await call('PATCH', `/api/sessions/${id}`, { pinned })).json() as { pinRank?: number };
    // No ranked pin yet: the first pins stay unranked.
    expect((await pin(a)).pinRank).toBeUndefined();
    expect((await pin(b)).pinRank).toBeUndefined();

    const ordered = await call('PUT', '/api/sessions/pin-order', { sessionIds: [a, b] });
    expect(ordered.statusCode).toBe(200);
    expect((ordered.json() as { sessions: { id: string; pinRank?: number }[] }).sessions.map(s => [s.id, s.pinRank])).toEqual([[a, 0], [b, 1]]);
    expect((await pin(c)).pinRank).toBe(-1);
    expect(store.getSession(c).pinRank).toBe(-1);

    const sequences = () => ids.map(id => store.getEvents(id, 0).length);
    const before = sequences();
    const again = await call('PUT', '/api/sessions/pin-order', { sessionIds: [a, b] });
    expect((again.json() as { sessions: { id: string }[] }).sessions.map(s => s.id)).toEqual([c, a, b]);
    expect(sequences()).toEqual(before);

    const reversed = await call('PUT', '/api/sessions/pin-order', { sessionIds: [b, a] });
    expect((reversed.json() as { sessions: { id: string; pinRank?: number }[] }).sessions.map(s => [s.id, s.pinRank])).toEqual([[c, -1], [b, 0], [a, 1]]);

    for (const sessionIds of [[d], [a, a], ['missing']]) {
      const rejected = await call('PUT', '/api/sessions/pin-order', { sessionIds });
      expect(rejected.statusCode).toBe(400);
      expect((rejected.json() as { error: { code: string } }).error.code).toBe('INVALID_PIN_ORDER');
    }
    expect(store.getSession(a).pinRank).toBe(1);

    expect((await pin(a, false)).pinRank).toBeUndefined();
    expect(store.getSession(a).pinnedAt).toBeUndefined();
  });

  it('advertises protocol v3 and answers an unchanged session or terminal list with 304', async () => {
    const { projectDir, call, app, cookie, store } = await boot();
    expect((await call('GET', '/health')).json().protocol).toEqual(PROTOCOL_INFO);
    expect(Array.isArray((await call('GET', '/api/integrations')).json().integrations)).toBe(true);
    const projectId = ((await call('POST', '/api/projects', { cwd: projectDir, name: 'etag' })).json() as { id: string }).id;
    await call('POST', '/api/sessions', { projectId, kind: 'native', title: 'First' });
    for (const url of ['/api/sessions', '/api/terminals', '/api/projects']) {
      const first = await call('GET', url);
      const etag = String(first.headers.etag);
      expect(etag).toMatch(/^W\/"\d+"$/);
      expect(first.headers['cache-control']).toBe('no-cache');
      expect(String(first.headers.vary).toLowerCase()).toContain('x-riffet-features');
      const unchanged = await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317', cookie, 'if-none-match': etag } });
      expect(unchanged.statusCode).toBe(304);
      expect(unchanged.body).toBe('');
      expect(String(unchanged.headers.vary).toLowerCase()).toContain('x-riffet-features');
    }
    const etag = String((await call('GET', '/api/sessions')).headers.etag);
    await call('POST', '/api/sessions', { projectId, kind: 'native', title: 'Second' });
    expect(String((await call('GET', '/api/sessions')).headers.etag)).not.toBe(etag);
    for (let index=0;index<3;index++) store.createSession({projectId,kind:'native',title:`Compression ${index} ${'x'.repeat(150)}`});
    const compressed = await app.inject({ method: 'GET', url: '/api/sessions', headers: { host: '127.0.0.1:4317', cookie, 'accept-encoding': 'gzip' } });
    expect(compressed.headers['content-encoding']).toBe('gzip');
    expect(String(compressed.headers.vary).toLowerCase().split(',').map(value=>value.trim())).toEqual(expect.arrayContaining(['x-riffet-features','accept-encoding']));
  });

  it('answers a session list read since a revision with only what changed after it', async () => {
    const { projectDir, call, store } = await boot();
    const projectId = ((await call('POST', '/api/projects', { cwd: projectDir, name: 'delta' })).json() as { id: string }).id;
    const kept = store.createSession({ projectId, kind: 'native', title: 'Kept' });
    const renamed = store.createSession({ projectId, kind: 'native', title: 'Before' });
    const deleted = store.createSession({ projectId, kind: 'native', title: 'Deleted' });
    const { revisions } = (await call('GET', '/api/bootstrap')).json() as { revisions: { sessions: number; terminals: number; projects: number; workItems: number } };
    expect(revisions).toEqual({ sessions: store.listRevision, terminals: store.terminalsRevision, projects: store.projectRevision, workItems: store.workItemsRevision });
    expect((await call('GET', `/api/sessions?since=${revisions.sessions}`)).json()).toEqual({ revision: revisions.sessions, sessions: [] });
    // A terminal or project change moves only its own list.
    store.saveTerminal({ id: 't-delta', projectId, state: 'exited', epoch: 0, createdAt: new Date().toISOString() } as never);
    await call('PATCH', `/api/projects/${projectId}`, { name: 'Renamed project' });
    expect(store.listRevision).toBe(revisions.sessions);
    expect(store.terminalsRevision).toBeGreaterThan(revisions.terminals);
    store.updateSession(renamed.id, { title: 'After' });
    store.deleteSessions(deleted.id, [deleted.id]);
    const delta = await call('GET', `/api/sessions?since=${revisions.sessions}`);
    expect(delta.headers.etag).toBe(`W/"${store.listRevision}"`);
    expect(delta.json()).toEqual({ revision: store.listRevision, sessions: [expect.objectContaining({ id: renamed.id, title: 'After' })], removed: [deleted.id] });
    // A revision from before this process (a restart may have lost changes) gets the whole list.
    const full = (await call('GET', `/api/sessions?since=${revisions.sessions - 1_000_000}`)).json() as { full?: boolean; sessions: Array<{ id: string }> };
    expect(full.full).toBe(true);
    expect(full.sessions.map(item => item.id).sort()).toEqual([kept.id, renamed.id].sort());
  });

  it('no longer serves the sync v2 transcript routes', async () => {
    const { app, store, projectDir, cookie } = await boot();
    const session = store.createSession({ projectId: store.createProject(projectDir, 'v2').id, kind: 'native', backendId: 'cursor' });
    for (const path of ['/native/stream', '/native/snapshot', '/native/history?cursor=c&generation=g']) {
      const response = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}${path}`, headers: { host: '127.0.0.1:4317', cookie } });
      expect(response.statusCode).toBe(404);
    }
  });

  it('no longer exposes any ACP-only route', async () => {
    const { projectDir, call } = await boot();
    const created = await call('POST', '/api/projects', { cwd: projectDir, name: 'smoke' });
    const projectId = (created.json() as { id: string }).id;
    const session = await call('POST', '/api/sessions', { projectId, kind: 'native', title: 'Terminal' });
    const sessionId = (session.json() as { id: string }).id;

    for (const [method, url] of [
      ['GET', `/api/sessions/${sessionId}/interactions`],
      ['POST', `/api/sessions/${sessionId}/configure`],
      ['POST', `/api/sessions/${sessionId}/send`],
      ['POST', '/api/interactions/whatever/respond'],
      ['GET', `/api/projects/${projectId}/cursor-sessions`],
    ] as const) {
      const response = await call(method, url, method === 'POST' ? {} : undefined);
      expect([method, url, response.statusCode]).toEqual([method, url, 404]);
    }

    // The model catalog is native-only and reports a retryable error without a real CLI.
    const models = await call('GET', '/api/cursor/models');
    expect(models.statusCode).toBe(503);
    expect((models.json() as { error: { code: string } }).error.code).toBe('MODEL_CATALOG_UNAVAILABLE');

    const exported = await call('GET', `/api/sessions/${sessionId}/export`);
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).not.toHaveProperty('interactions');
  });

  it('checks Cursor CLI settings through its driver, keeps them in a private file and lists its project config files', async () => {
    const { stateDir, projectDir, store, call } = await boot();
    // The shape is the settings' to check, whether the CLI can launch with it is the driver's; both answer 400 INVALID_SETTINGS.
    for (const cursorCli of [{ configDir: 'relative/dir' }, { executable: 'shell:bad name' }, { hasApiKey: true }, { unknown: 1 }]) {
      const rejected = await call('PATCH', '/api/settings', { cursorCli });
      expect([cursorCli, rejected.statusCode, (rejected.json() as { error: { code: string } }).error.code]).toEqual([cursorCli, 400, 'INVALID_SETTINGS']);
    }
    const saved = await call('PATCH', '/api/settings', { cursorCli: { executable: '/nonexistent/cursor-two', apiKey: 'cursor-private-test-key' } });
    expect(saved.json().cursorCli).toEqual({ executable: '/nonexistent/cursor-two', hasApiKey: true });
    expect(saved.body).not.toContain('cursor-private-test-key');
    expect(statSync(join(stateDir, 'cursor-cli.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(stateDir, 'cursor-cli.json'), 'utf8'))).toEqual({ executable: '/nonexistent/cursor-two', apiKey: 'cursor-private-test-key' });
    expect((await call('GET', '/api/backends/cursor/profiles')).json().profiles[0]).toMatchObject({ id: 'default', executable: '/nonexistent/cursor-two', hasApiKey: true });

    const project = store.createProject(projectDir, 'configs');
    await mkdir(join(projectDir, '.cursor', 'rules'), { recursive: true });
    await writeFile(join(projectDir, '.cursor', 'rules', 'a.mdc'), 'hello');
    const listed = (await call('GET', `/api/projects/${project.id}/configs`)).json() as Array<{ id: string; path: string; exists: boolean }>;
    const rule = listed.find(item => item.path === '.cursor/rules/a.mdc')!;
    expect(rule.exists).toBe(true);
    const read = (await call('GET', `/api/projects/${project.id}/configs/${rule.id}`)).json() as { content: string; hash: string };
    expect(read.content).toBe('hello');
    expect((await call('PUT', `/api/projects/${project.id}/configs/${rule.id}`, { content: 'bye', expectedHash: 'a'.repeat(64) })).json().error.code).toBe('CONFIG_CONFLICT');
    expect((await call('PUT', `/api/projects/${project.id}/configs/${rule.id}`, { content: 'bye', expectedHash: read.hash })).json()).toMatchObject({ id: rule.id, content: 'bye' });
    expect((await call('GET', `/api/projects/${project.id}/configs/${'0'.repeat(32)}`)).json().error.code).toBe('CONFIG_NOT_FOUND');
  });

  it('stores native profile credentials privately and never returns them', async () => {
    const { stateDir, call } = await boot();
    const saved = await call('PATCH', '/api/backends/codex/profiles/local', { name: 'Private profile', executable: '/usr/bin/codex', configDir: stateDir, apiEndpoint: 'https://example.com/api', apiKey: 'profile-secret-123' });
    expect(saved.statusCode).toBe(200);
    const profile = (saved.json() as { profiles: Array<Record<string, unknown>> }).profiles.find(item => item.id === 'local');
    expect(profile).toMatchObject({ name: 'Private profile', executable: '/usr/bin/codex', hasApiKey: true });
    expect(profile).not.toHaveProperty('apiKey');
    expect(JSON.stringify(saved.json())).not.toContain('profile-secret-123');
    expect(statSync(join(stateDir, 'native-backend-profiles.json')).mode & 0o777).toBe(0o600);
    const cleared = await call('PATCH', '/api/backends/codex/profiles/local', { configDir: '', apiEndpoint: '', sourceDir: '' });
    expect(cleared.statusCode).toBe(200);
    const clearedProfile = cleared.json().profiles.find((item: { id: string }) => item.id === 'local');
    expect(clearedProfile).not.toHaveProperty('configDir');
    expect(clearedProfile).not.toHaveProperty('apiEndpoint');
    expect(clearedProfile).toMatchObject({ hasApiKey: true, name: 'Private profile' });

    // A rejected save must leave private settings readable, including at both storage limits.
    const privatePath = join(stateDir, 'native-backend-profiles.json');
    const full = JSON.stringify({ codex: Array.from({ length: 100 }, (_, index) => ({ id: `profile-${index}`, backendId: 'codex', name: `Profile ${index}` })) });
    await writeFile(privatePath, full, { mode: 0o600 });
    const tooMany = await call('POST', '/api/backends/codex/profiles', { id: 'extra', name: 'Extra' });
    expect(tooMany.statusCode).toBe(413);
    expect(await readFile(privatePath, 'utf8')).toBe(full);

    const key = 'k'.repeat(64 * 1024);
    const nearLimit = JSON.stringify({ codex: Array.from({ length: 7 }, (_, index) => ({ id: `profile-${index}`, backendId: 'codex', name: `Profile ${index}`, apiKey: key })) });
    await writeFile(privatePath, nearLimit, { mode: 0o600 });
    const tooLarge = await call('POST', '/api/backends/codex/profiles', { id: 'extra', name: 'Extra', apiKey: key });
    expect(tooLarge.statusCode).toBe(413);
    expect(await readFile(privatePath, 'utf8')).toBe(nearLimit);
    expect((await call('GET', '/api/backends/codex/profiles')).statusCode).toBe(200);
  });

  it('persists model sources and probes their declared catalog without reusing another source credential', async () => {
    // A gateway honouring the profile's overrides, and a second source with no credential of its own.
    const acme: Plugin = {
      manifest: { id: 'acme.models', vendor: 'acme', name: 'Acme', apiVersion: 1, defaultEnabled: true },
      activate: host => ({ modelSources: [
        {
          id: 'acme-gateway', label: 'Acme', backends: ['codex'],
          resolve: overrides => ({ codexBaseUrl: overrides.apiEndpoint, ...(overrides.apiKey ? { credential: { kind: 'static', key: overrides.apiKey } } : {}) }),
          catalog: async (_backend, overrides) => await host.gateway.fetchModels({ baseUrl: overrides.apiEndpoint!, apiKey: overrides.apiKey!, reasoningLevels: true }),
        },
        { id: 'acme-other', label: 'Other', backends: ['codex'], resolve: () => ({ reason: 'no key' }), catalog: async () => { throw new Error('Other has no key'); } },
      ] }),
    };
    const { call } = await boot(undefined, undefined, [acme]);
    expect((await call('GET', '/api/integrations')).json().integrations[0].contributes.modelSources[0]).toEqual({ id: 'acme-gateway', label: 'Acme', backends: ['codex'], protocols: ['openai-responses'], overridable: ['apiEndpoint', 'apiKey'] });
    const created = await call('POST', '/api/backends/codex/profiles', {
      id: 'source-gateway', name: 'Acme', modelSource: 'acme-gateway', apiEndpoint: 'https://source-test.example/v1', apiKey: 'source-test-key',
    });
    expect(created.statusCode).toBe(200);
    const profiles = (await call('GET', '/api/backends/codex/profiles')).json().profiles;
    expect(profiles.find((profile: { id: string }) => profile.id === 'source-gateway')).toMatchObject({ modelSource: 'acme-gateway', apiEndpoint: 'https://source-test.example/v1', hasApiKey: true });
    expect(JSON.stringify(profiles)).not.toContain('source-test-key');
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'source-model', context_length: 200_000, supported_reasoning_levels: ['low', 'high'], default_reasoning_level: 'high' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      const probed = await call('POST', '/api/backends/codex/model-probe', { modelSource: 'acme-gateway', profileId: 'source-gateway', apiEndpoint: 'https://source-test.example/v1' });
      expect(probed.statusCode).toBe(200);
      expect(probed.json().models).toMatchObject([{ value: 'source-model', contextWindow: 200_000, configOptions: [{ currentValue: 'high' }] }]);
      expect(request).toHaveBeenCalledTimes(1);
      expect(String(request.mock.calls[0]![0])).toBe('https://source-test.example/v1/models');
      expect(request.mock.calls[0]![1]?.headers).toMatchObject({ authorization: 'Bearer source-test-key' });
      expect((await call('GET', '/api/auxiliary-models')).json().models.some((model: { profileId: string }) => model.profileId === 'source-gateway')).toBe(false);
      const changed = await call('POST', '/api/backends/codex/model-probe', { modelSource: 'acme-other', profileId: 'source-gateway' });
      expect(changed.statusCode).toBe(400);
      expect(changed.json().error.message).toBe('Other has no key');
      expect((await call('POST', '/api/backends/codex/model-probe', { modelSource: 'acme-missing' })).statusCode).toBe(400);
      expect(request).toHaveBeenCalledTimes(1);
      expect((await call('POST', '/api/backends/traex/profiles', { id: 'unsupported', name: 'Unsupported', modelSource: 'acme-gateway' })).statusCode).toBe(400);
      expect((await call('PATCH', '/api/backends/codex/profiles/source-gateway', { modelSource: null })).statusCode).toBe(200);
      const cleared = (await call('GET', '/api/backends/codex/profiles')).json().profiles.find((profile: { id: string }) => profile.id === 'source-gateway');
      expect(cleared).not.toHaveProperty('modelSource');
    } finally { request.mockRestore(); }
  });

  it('keeps a model source no integration provides instead of failing the profile file', async () => {
    const { call, stateDir } = await boot();
    await writeFile(join(stateDir, 'native-backend-profiles.json'), JSON.stringify({ claude: [{ id: 'elsewhere', backendId: 'claude', name: 'Elsewhere', modelSource: 'acme.models' }] }), { mode: 0o600 });
    const listed = await call('GET', '/api/backends/claude/profiles');
    expect(listed.statusCode).toBe(200);
    expect(listed.json().profiles.find((profile: { id: string }) => profile.id === 'elsewhere')).toMatchObject({ modelSource: 'acme.models' });
    expect((await call('PATCH', '/api/backends/claude/profiles/elsewhere', { name: 'Renamed' })).statusCode).toBe(200);
    expect(JSON.parse(await readFile(join(stateDir, 'native-backend-profiles.json'), 'utf8')).claude[0]).toMatchObject({ name: 'Renamed', modelSource: 'acme.models' });
    expect((await call('PATCH', '/api/backends/claude/profiles/elsewhere', { modelSource: 'Not An Id' })).statusCode).toBe(400);
  });

  // DSH matches a model by exact id against its own catalog and treats an unknown id as text-only,
  // swapping every image for a placeholder before the request leaves. The declaration has to survive
  // a round trip through storage, so this pins the wire shape the model editor reads back.
  it('stores declared model input types for a DSH profile only', async () => {
    const { call } = await boot();
    const declared = { 'deepseek-v4.1-flash': ['text', 'image'] };
    const created = await call('POST', '/api/backends/dsh/profiles', { id: 'gateway', name: 'Gateway', apiEndpoint: 'https://gateway.example.com' });
    expect(created.statusCode).toBe(200);
    const saved = await call('PATCH', '/api/backends/dsh/profiles/gateway', { modelInputModalities: declared });
    expect(saved.statusCode).toBe(200);
    expect((saved.json() as { profiles: Array<Record<string, unknown>> }).profiles.find(item => item.id === 'gateway')).toMatchObject({ modelInputModalities: declared });

    const cleared = await call('PATCH', '/api/backends/dsh/profiles/gateway', { modelInputModalities: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().profiles.find((item: { id: string }) => item.id === 'gateway')).not.toHaveProperty('modelInputModalities');

    // Pointless on a backend whose catalog has no place to put it; refuse instead of silently dropping.
    const wrongBackend = await call('PATCH', '/api/backends/codex/profiles/local', { modelInputModalities: declared });
    expect(wrongBackend.statusCode).toBe(400);
    expect((wrongBackend.json() as { error: { code: string } }).error.code).toBe('INVALID_BACKEND_PROFILE');

    const unknownType = await call('PATCH', '/api/backends/dsh/profiles/gateway', { modelInputModalities: { 'a': ['text', 'audio'] } });
    expect(unknownType.statusCode).toBe(400);
    const empty = await call('PATCH', '/api/backends/dsh/profiles/gateway', { modelInputModalities: { 'a': [] } });
    expect(empty.statusCode).toBe(400);
  });

  it('deletes an idle conversation with its side chats, atomically, and no retried request brings it back', async () => {
    const { app, cookie, csrf, projectDir, stateDir, store } = await boot();
    const headers = { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf, [CLIENT_FEATURES_HEADER]: 'quick-chat' };
    const call = (method: 'GET' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    const project = store.createProject(projectDir, 'Delete');
    const input = { text: 'Plan the work', attachmentIds: [], context: [] };
    const { session: root, run } = store.createNativeSubmission('delete-root', { projectId: project.id, backendId: 'cursor' }, 'first', input);
    const chat = store.createSession({ projectId: project.id, kind: 'native', backendId: 'chat', origin: { kind: 'discussion', sessionId: root.id } as never });
    const kept = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor', origin: { kind: 'fork', sessionId: root.id } as never });
    store.journal.append(root.id, [{ kind: 'user_message_chunk', nativeId: 'q', payload: { text: 'Plan the work' } }]);
    store.journal.append(laneKey(root.id, 'sub:agent-1'), [{ kind: 'agent_message_chunk', nativeId: 'a', payload: { text: 'child' } }]);
    await mkdir(join(stateDir, 'chat'), { recursive: true });
    await writeFile(join(stateDir, 'chat', `${encodeURIComponent(chat.id)}.jsonl`), '{}\n');

    const preview = (await call('GET', `/api/sessions/${root.id}/deletion`)).json();
    expect(preview).toMatchObject({ sessionIds: [root.id, chat.id], effects: { discussions: 1, schedules: 0 }, blocker: { code: 'SESSION_DELETE_BLOCKED' } });
    // The first message is still queued: nothing is stopped or cancelled on the user's behalf.
    expect((await call('DELETE', `/api/sessions/${root.id}`, { sessionIds: preview.sessionIds })).json().error.code).toBe('SESSION_DELETE_BLOCKED');
    store.updateRun(run.id, { state: 'completed', native: { ...run.native!, delivery: 'observed' } });
    // A side chat opened after the confirmation is confirmed again rather than deleted unseen.
    expect((await call('DELETE', `/api/sessions/${root.id}`, { sessionIds: [root.id] })).json().error.code).toBe('SESSION_DELETE_SCOPE_CHANGED');

    const deleted = await call('DELETE', `/api/sessions/${root.id}`, { sessionIds: [chat.id, root.id] });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json().sessionIds).toEqual([root.id, chat.id]);
    for (const id of [root.id, chat.id]) {
      const read = await call('GET', `/api/sessions/${id}/events`);
      expect(read.statusCode).toBe(410);
      expect(read.json().error.code).toBe('SESSION_DELETED');
    }
    expect((await call('DELETE', `/api/sessions/${root.id}`, { sessionIds: [root.id, chat.id] })).statusCode).toBe(410);
    expect(store.listSessions().map(item => item.id)).toEqual([kept.id]);
    expect(store.listRuns(root.id)).toEqual([]);
    expect(store.journal.keysOf(root.id)).toEqual([]);
    expect(await readdir(join(stateDir, 'chat'))).toEqual([]);
    // A transcript read or fold finishing late writes nothing.
    expect(() => store.journal.append(root.id, [{ kind: 'user_message_chunk', nativeId: 'late', payload: {} }])).toThrow(JournalSessionDeleted);
    // Another device retrying the original creation, before or after a restart, does not recreate it.
    expect(() => store.createNativeSubmission('delete-root', { projectId: project.id, backendId: 'cursor' }, 'first', input)).toThrow(expect.objectContaining({ code: 'SESSION_DELETED', statusCode: 410 }));
    const reopened = new Store(store.path);
    try {
      expect(() => reopened.createNativeSubmission('delete-root', { projectId: project.id, backendId: 'cursor' }, 'first', input)).toThrow(expect.objectContaining({ code: 'SESSION_DELETED' }));
      expect(reopened.pendingDeletionCleanups()).toEqual([]);
    } finally { reopened.close(); }
  });

  it('returns an accepted command receipt after archive and attachment cleanup, and looks it up exactly', async () => {
    const { projectDir, stateDir, call } = await boot();
    const project = await call('POST', '/api/projects', { cwd: projectDir, name: 'retry' });
    const created = await call('POST', '/api/sessions', { projectId: project.json().id, kind: 'native' });
    const sessionId = created.json().id;
    const attachment = (await call('POST', `/api/projects/${project.json().id}/attachments`, { name: 'input.txt', mimeType: 'text/plain', dataBase64: Buffer.from('context').toString('base64') })).json();
    const payload = { commandId: 'archived-retry', text: 'Inspect this project', attachments: [{ id: attachment.id }] };
    const accepted = await call('POST', `/api/sessions/${sessionId}/native/send`, payload);
    expect(accepted.statusCode).toBe(202);
    const archived = await call('PATCH', `/api/sessions/${sessionId}`, { archived: true });
    expect(archived.statusCode).toBe(200);

    await rm(join(stateDir, 'attachments', `${attachment.id}.bin`));
    const exact = await call('GET', `/api/sessions/${sessionId}/runs?commandId=${payload.commandId}`);
    expect(exact.json().map((run: { id: string }) => run.id)).toEqual([accepted.json().id]);
    expect((await call('GET', `/api/sessions/${sessionId}/runs?commandId=missing`)).json()).toEqual([]);
    expect((await call('POST', `/api/sessions/${sessionId}/native/runs/${accepted.json().id}/resolve`, { outcome: 'discard' })).json().error.code).toBe('NATIVE_RECOVERY_REQUIRED');

    const retry = await call('POST', `/api/sessions/${sessionId}/native/send`, payload);
    expect(retry.statusCode).toBe(202);
    expect(retry.json().id).toBe(accepted.json().id);
    const conflict = await call('POST', `/api/sessions/${sessionId}/native/send`, { ...payload, text: 'Different input' });
    expect(conflict.statusCode).toBe(409);
    const newCommand = await call('POST', `/api/sessions/${sessionId}/native/send`, { ...payload, attachments: [], commandId: 'new-after-archive' });
    expect(newCommand.statusCode).toBe(409);
    expect(newCommand.json().error.code).toBe('ARCHIVED_SESSION');
  });

  it('saves any setting while a backend is off: its stored defaults pass unchecked, changing them is refused', async () => {
    const cursor = { profileId: 'default', approval: 'allowlist' };
    const { call, settings } = await boot({ defaultMode: 'agent', nativeBackendDefaults: { cursor } }, undefined, []);
    const saved = await call('PATCH', '/api/settings', { defaultMode: 'agent', nativeBackendDefaults: { cursor, codex: { model: 'codex-model' } }, notifications: false });
    expect(saved.statusCode).toBe(200);
    expect(settings.getSettings()).toMatchObject({ notifications: false, nativeBackendDefaults: { cursor, codex: { model: 'codex-model' } } });
    const changed = await call('PATCH', '/api/settings', { nativeBackendDefaults: { cursor: { ...cursor, approval: 'unrestricted' } } });
    expect(changed.statusCode).toBe(503);
    expect(changed.json().error.code).toBe('NATIVE_BACKEND_UNAVAILABLE');
    expect((await call('PATCH', '/api/settings', { defaultMode: 'plan' })).statusCode).toBe(503);
  });

  it('applies approval defaults to new sessions, permits overrides and restores CLI defaults when cleared', async () => {
    const codex = { profileId: 'local', model: 'codex-model', mode: 'agent' };
    const cursor = { profileId: 'default', approval: 'allowlist' };
    const { projectDir, stateDir, call } = await boot({ defaultBackendId: 'codex', nativeBackendDefaults: { codex, cursor } });
    const project = await call('POST', '/api/projects', { cwd: projectDir, name: 'approval-defaults' });
    const input = { projectId: project.json().id, kind: 'native' };
    const existing = await call('POST', '/api/sessions', { ...input, approval: 'on-request' });
    expect(existing.statusCode).toBe(200);

    const saved = await call('PATCH', '/api/settings', { nativeBackendDefaults: { codex: { ...codex, approval: 'read-only' }, cursor } });
    expect(saved.statusCode).toBe(200);
    const remembered = { profileModels: { local: 'codex-model' } };
    expect(saved.json().nativeBackendDefaults).toEqual({ codex: { ...codex, approval: 'read-only', ...remembered }, cursor });
    expect(JSON.parse(await readFile(join(stateDir, 'settings.json'), 'utf8')).nativeBackendDefaults.codex.approval).toBe('read-only');
    const created = await call('POST', '/api/sessions', input);
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ backendId: 'codex', model: 'codex-model', approval: 'read-only' });
    expect((await call('GET', '/api/sessions')).json().find((item: { id: string }) => item.id === existing.json().id).approval).toBe('on-request');
    expect((await call('POST', '/api/sessions', { ...input, approval: 'on-request' })).json().approval).toBe('on-request');
    expect((await call('POST', '/api/sessions', { ...input, backendId: 'cursor' })).json().approval).toBe('allowlist');

    const invalid = await call('PATCH', '/api/settings', { nativeBackendDefaults: { codex: { ...codex, approval: 'allowlist' }, cursor } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('INVALID_APPROVAL_MODE');
    const cleared = await call('PATCH', '/api/settings', { nativeBackendDefaults: { codex, cursor } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().nativeBackendDefaults).toEqual({ codex: { ...codex, ...remembered }, cursor });
    const cliDefault = await call('POST', '/api/sessions', input);
    expect(cliDefault.statusCode).toBe(200);
    expect(cliDefault.json()).not.toHaveProperty('approval');
  });

  it('syncs profile model changes only with the effective backend default', async () => {
    const { call, settings, stateDir } = await boot({ nativeBackendDefaults: { codex: { model: 'local-account-model', approval: 'read-only' } } });
    const defaults = () => settings.getSettings().nativeBackendDefaults?.codex;
    expect((await call('POST', '/api/backends/codex/profiles', { id: 'team', name: 'Team', defaultModel: 'team-model' })).statusCode).toBe(200);
    expect(defaults()).toEqual({ model: 'local-account-model', approval: 'read-only' });
    expect((await call('PATCH', '/api/backends/codex/profiles/team', { defaultModel: 'team-only-model' })).statusCode).toBe(200);
    expect(defaults()).toEqual({ model: 'local-account-model', approval: 'read-only' });

    expect((await call('PATCH', '/api/backends/codex/profiles/local', { defaultModel: 'local-next-model' })).statusCode).toBe(200);
    expect(defaults()).toEqual({ model: 'local-next-model', approval: 'read-only' });
    expect((await call('PATCH', '/api/backends/codex/profiles/local', { defaultModel: '' })).statusCode).toBe(200);
    expect(defaults()).toEqual({ approval: 'read-only' });

    settings.setSettings({ nativeBackendDefaults: { codex: { profileId: 'team', model: 'team-saved-model', approval: 'read-only' } } });
    expect((await call('PATCH', '/api/backends/codex/profiles/local', { defaultModel: 'local-only-model' })).statusCode).toBe(200);
    expect(defaults()).toEqual({ profileId: 'team', model: 'team-saved-model', approval: 'read-only', profileModels: { team: 'team-saved-model' } });
    expect((await call('PATCH', '/api/backends/codex/profiles/team', { defaultModel: 'team-next-model' })).statusCode).toBe(200);
    expect(defaults()).toEqual({ profileId: 'team', model: 'team-next-model', approval: 'read-only', profileModels: { team: 'team-next-model' } });
    expect((await call('PATCH', '/api/backends/codex/profiles/team', { defaultModel: null })).statusCode).toBe(200);
    expect(defaults()).toEqual({ profileId: 'team', approval: 'read-only' });
    expect(JSON.parse(await readFile(join(stateDir, 'settings.json'), 'utf8')).nativeBackendDefaults.codex).toEqual({ profileId: 'team', approval: 'read-only' });

    // Each provider's last model is the server's record: a switch naming no model starts on it, and a
    // client that sends a stale copy of the record (or none) does not overwrite it.
    settings.setSettings({ nativeBackendDefaults: { codex: { profileId: 'team', model: 'team-picked[effort=high]', approval: 'read-only' } } });
    expect((await call('PATCH', '/api/settings', { nativeBackendDefaults: { codex: { profileId: 'local', model: 'local-picked', approval: 'read-only', profileModels: { team: 'stale' } } } })).statusCode).toBe(200);
    const back = await call('PATCH', '/api/settings', { nativeBackendDefaults: { codex: { profileId: 'team', approval: 'read-only' } } });
    expect(back.json().nativeBackendDefaults.codex).toEqual({ profileId: 'team', model: 'team-picked[effort=high]', approval: 'read-only', profileModels: { local: 'local-picked', team: 'team-picked[effort=high]' } });
  });

  it('keeps backend defaults scoped to the selected profile and rejects unsupported modes', async () => {
    const { projectDir, call, settings } = await boot();
    const projectResponse = await call('POST', '/api/projects', { cwd: projectDir, name: 'profiles' });
    const projectId = (projectResponse.json() as { id: string }).id;
    const profile = await call('POST', '/api/backends/codex/profiles', { id: 'team', name: 'Team', defaultModel: 'team-model' });
    expect(profile.statusCode).toBe(200);
    const defaults = await call('PATCH', '/api/settings', { nativeBackendDefaults: { codex: { profileId: 'local', model: 'account-a-model' } } });
    expect(defaults.statusCode).toBe(200);

    const session = await call('POST', '/api/sessions', { projectId, kind: 'native', backendId: 'codex', backendProfileId: 'team' });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ backendId: 'codex', backendProfileId: 'team', model: 'team-model', mode: 'agent' });
    expect(JSON.stringify(session.json())).not.toContain('account-a-model');

    // Legacy/local UI state may already have persisted an empty override; it must not suppress
    // the selected profile's default model when creating a new session.
    settings.setSettings({ nativeBackendDefaults: { codex: { profileId: 'team', model: '' } } });
    const emptyModelSession = await call('POST', '/api/sessions', { projectId, kind: 'native', backendId: 'codex', backendProfileId: 'team' });
    expect(emptyModelSession.statusCode).toBe(200);
    expect(emptyModelSession.json()).toMatchObject({ backendId: 'codex', backendProfileId: 'team', model: 'team-model' });

    const unsupportedMode = await call('POST', '/api/sessions', { projectId, kind: 'native', backendId: 'codex', backendProfileId: 'team', mode: 'plan' });
    expect(unsupportedMode.statusCode).toBe(400);
    expect((unsupportedMode.json() as { error: { code: string } }).error.code).toBe('NATIVE_MODE_UNSUPPORTED');
    const traex = await call('POST', '/api/sessions', { projectId, kind: 'native', backendId: 'traex' });
    expect(traex.statusCode).toBe(200);
    expect(traex.json()).toMatchObject({ backendId: 'traex', mode: 'default' });
    const invalidReference = await call('POST', '/api/sessions', { projectId, kind: 'native', backendId: 'claude', nativeSessionId: '../../bad' });
    expect(invalidReference.statusCode).toBe(400);

    const cursorModel = await call('PATCH', '/api/backends/cursor/profiles/default', { defaultModel: 'cursor-profile-model' });
    expect(cursorModel.statusCode).toBe(200);
    expect(cursorModel.json().profiles.find((item: { id: string }) => item.id === 'default')).toMatchObject({ defaultModel: 'cursor-profile-model' });
    const cursorProfiles = await call('GET', '/api/backends/cursor/profiles');
    expect(cursorProfiles.json().profiles.find((item: { id: string }) => item.id === 'default')).toMatchObject({ defaultModel: 'cursor-profile-model' });
  });
});

describe('pi compatibility for clients that did not negotiate pi-agent', () => {
  function client(app: FastifyInstance, cookie: string, csrf: string) {
    return (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, features?: string) => app.inject({
      method, url,
      headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf, ...(features ? { [CLIENT_FEATURES_HEADER]: features } : {}) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }

  it('persists an Antigravity provider and probes Gemini with isolated private credentials', async () => {
    const { app, cookie, csrf, stateDir } = await boot();
    const ask = client(app, cookie, csrf);
    const endpoint = 'https://agy-provider.example';
    const saved = await ask('POST', '/api/backends/antigravity/profiles', {
      id: 'gemini', name: 'Gemini', apiEndpoint: endpoint, apiProtocol: 'google-generative-ai', apiKey: 'agy-private-test-key',
    }, 'antigravity-agent');
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().profiles.find((profile: { id: string }) => profile.id === 'gemini')).toMatchObject({ apiProtocol: 'google-generative-ai', hasApiKey: true });
    expect(saved.body).not.toContain('agy-private-test-key');
    const persisted = JSON.parse(await readFile(join(stateDir, 'native-backend-profiles.json'), 'utf8'));
    expect(persisted.antigravity[0]).toMatchObject({ apiProtocol: 'google-generative-ai', apiKey: 'agy-private-test-key' });
    expect((await ask('PATCH', '/api/backends/antigravity/profiles/gemini', { name: 'Renamed' }, 'antigravity-agent')).statusCode).toBe(200);
    for (const apiProtocol of ['openai-completions', 'openai-responses', 'anthropic-messages', 'unknown']) {
      expect((await ask('PATCH', '/api/backends/antigravity/profiles/gemini', { apiProtocol }, 'antigravity-agent')).statusCode).toBe(400);
    }
    expect((await ask('PATCH', '/api/backends/antigravity/profiles/gemini', { configDir: '/tmp/arbitrary-agy-root' }, 'antigravity-agent')).statusCode).toBe(400);
    const seen: Array<{ url: string; key: string | null; authorization: string | null }> = [];
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const headers = new Headers(options?.headers);
      seen.push({ url: String(url), key: headers.get('x-goog-api-key'), authorization: headers.get('authorization') });
      return new Response(JSON.stringify({ models: [
        { name: 'models/gemini-3.8-flash', displayName: 'Flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576 },
        { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
      ] }), { headers: { 'content-type': 'application/json' } });
    });
    try {
      const probe = { apiEndpoint: endpoint, profileId: 'gemini' };
      const detected = await ask('POST', '/api/backends/antigravity/model-probe', probe, 'antigravity-agent');
      expect(detected.statusCode, detected.body).toBe(200);
      expect(detected.json().models).toEqual([expect.objectContaining({ value: 'gemini-3.8-flash' })]);
      expect(seen).toEqual([{ url: `${endpoint}/v1beta/models`, key: 'agy-private-test-key', authorization: null }]);
      expect((await ask('POST', '/api/backends/antigravity/model-probe', { ...probe, apiProtocol: 'openai-completions' }, 'antigravity-agent')).statusCode).toBe(400);
      expect(seen).toHaveLength(1);
      expect((await ask('POST', '/api/backends/antigravity/model-probe', { ...probe, apiKey: 'replacement-key' }, 'antigravity-agent')).statusCode).toBe(200);
      expect(seen.at(-1)?.key).toBe('replacement-key');
      expect((await ask('POST', '/api/backends/antigravity/model-probe', { ...probe, apiKey: '' }, 'antigravity-agent')).statusCode).toBe(200);
      expect(seen.at(-1)?.key).toBeNull();
      fetcher.mockRejectedValueOnce(new Error('failed with agy-private-test-key'));
      const failed = await ask('POST', '/api/backends/antigravity/model-probe', probe, 'antigravity-agent');
      expect(failed.statusCode).toBe(400);
      expect(failed.body).not.toContain('agy-private-test-key');
    } finally { fetcher.mockRestore(); }
    const cleared = await ask('PATCH', '/api/backends/antigravity/profiles/gemini', { apiProtocol: null, apiKey: null, apiEndpoint: '' }, 'antigravity-agent');
    expect(cleared.statusCode, cleared.body).toBe(200);
    const profile = cleared.json().profiles.find((profile: { id: string }) => profile.id === 'gemini');
    expect(profile).not.toHaveProperty('apiProtocol');
    expect(profile.hasApiKey).toBe(false);
  });

  it('persists a pi provider protocol and private credentials, and rejects unsupported protocols', async () => {
    const { app, cookie, csrf, stateDir } = await boot();
    const ask = client(app, cookie, csrf);
    for (const apiProtocol of ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']) {
      const saved = await ask('PATCH', '/api/backends/pi/profiles/local', {
        apiEndpoint: 'https://provider.example/v1', apiProtocol, apiKey: 'pi-private-test-key',
        defaultModel: 'mock', modelInputModalities: { mock: ['text', 'image'] }, modelContextWindows: { mock: 32768 },
      }, 'pi-agent');
      expect(saved.statusCode).toBe(200);
      expect(saved.json().profiles.find((profile: { id: string }) => profile.id === 'local')).toMatchObject({ apiProtocol, hasApiKey: true });
      expect(saved.body).not.toContain('pi-private-test-key');
      const persisted = JSON.parse(await readFile(join(stateDir, 'native-backend-profiles.json'), 'utf8'));
      expect(persisted.pi[0]).toMatchObject({ apiProtocol, apiKey: 'pi-private-test-key' });
    }
    expect((await ask('PATCH', '/api/backends/pi/profiles/local', { apiProtocol: 'unknown' }, 'pi-agent')).statusCode).toBe(400);
    expect((await ask('PATCH', '/api/backends/codex/profiles/local', { apiProtocol: 'openai-completions' }, 'pi-agent')).statusCode).toBe(400);
    const cleared = await ask('PATCH', '/api/backends/pi/profiles/local', { apiProtocol: null, apiKey: null }, 'pi-agent');
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().profiles[0]).not.toHaveProperty('apiProtocol');
    expect(cleared.json().profiles[0].hasApiKey).toBe(false);
  });

  it('discovers a newly installed agent in a non-default profile on the next picker read', async () => {
    const { app, cookie, csrf, stateDir } = await boot();
    const ask = client(app, cookie, csrf);
    const executable = join(stateDir, 'new-pi');
    expect((await ask('PATCH', '/api/backends/pi/profiles/local', { executable: join(stateDir, 'missing-pi') }, 'pi-agent')).statusCode).toBe(200);
    expect((await ask('POST', '/api/backends/pi/profiles', { id: 'other', name: 'Other', executable, enabledModels: [] }, 'pi-agent')).statusCode).toBe(200);
    const read = async () => {
      const response = await ask('GET', '/api/backends?recheckMissing=1', undefined, 'pi-agent');
      expect(response.statusCode).toBe(200);
      return response.json().find((entry: { backendId: string }) => entry.backendId === 'pi');
    };
    expect(await read()).toMatchObject({ cliMissing: true });
    // An installed CLI can still be incompatible. The picker should show it either way.
    await writeFile(executable, '#!/bin/sh\necho 0.1.0\n', { mode: 0o755 });
    const present = await read();
    expect(present.available).toBe(false);
    expect(present.cliMissing).toBeUndefined();
    await writeFile(executable, '#!/bin/sh\necho "1.4.0 --mode rpc"\n');
    const profile = await ask('GET', '/api/backends/pi/catalog?scope=global&profileId=other', undefined, 'pi-agent,projectless-tasks');
    expect(profile.json()).toMatchObject({ available: true, models: [] });
  });

  it('hides pi from bootstrap, lists, settings and direct reads until a client negotiates pi-agent', async () => {
    const { app, cookie, csrf, projectDir, store } = await boot({ defaultBackendId: 'pi', nativeBackendDefaults: { pi: { model: 'pi-model' } } });
    const ask = client(app, cookie, csrf);
    const project = store.createProject(projectDir, 'pi-compat');
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'pi', title: 'Pi conversation' });

    const bootstrap = await ask('GET', '/api/bootstrap');
    expect(bootstrap.json().sessions.map((item: { id: string }) => item.id)).not.toContain(session.id);
    expect(bootstrap.json().settings.defaultBackendId).toBe('claude');
    expect(bootstrap.json().settings).not.toHaveProperty('nativeBackendDefaults');
    expect((await ask('GET', '/api/sessions')).json().map((item: { id: string }) => item.id)).not.toContain(session.id);
    expect((await ask('GET', '/api/backends')).json().some((item: { backendId: string }) => item.backendId === 'pi')).toBe(false);
    expect((await ask('GET', '/api/settings')).json()).toMatchObject({ defaultBackendId: 'claude' });
    expect((await ask('GET', '/api/settings')).json()).not.toHaveProperty('nativeBackendDefaults');
    expect((await ask('GET', `/api/sessions/${session.id}/events`)).statusCode).toBe(404);
    expect((await ask('GET', `/api/v3/sessions/${session.id}/timeline/changes`)).statusCode).toBe(404);

    const negotiated = await ask('GET', '/api/bootstrap', undefined, 'pi-agent');
    expect(negotiated.json().sessions.map((item: { id: string }) => item.id)).toContain(session.id);
    expect(negotiated.json().settings.defaultBackendId).toBe('pi');
    expect(negotiated.json().settings.nativeBackendDefaults.pi).toEqual({ model: 'pi-model' });
    expect((await ask('GET', '/api/backends', undefined, 'pi-agent')).json().some((item: { backendId: string }) => item.backendId === 'pi')).toBe(true);
    expect((await ask('GET', `/api/sessions/${session.id}/events`, undefined, 'pi-agent')).statusCode).toBe(200);
    expect((await ask('GET', `/api/v3/sessions/${session.id}/timeline/changes`, undefined, 'pi-agent')).statusCode).toBe(200);
  });

  it('creates an old client conversation on a compatible backend when the saved default is pi, and rejects an explicit pi request', async () => {
    const { app, cookie, csrf, projectDir } = await boot({ defaultBackendId: 'pi' });
    const ask = client(app, cookie, csrf);
    const projectId = (await ask('POST', '/api/projects', { cwd: projectDir, name: 'pi-default' })).json().id;
    const input = { projectId, kind: 'native' as const };

    const created = await ask('POST', '/api/sessions', input);
    expect(created.statusCode).toBe(200);
    expect(created.json().backendId).toBe('claude');
    const rejected = await ask('POST', '/api/sessions', { ...input, backendId: 'pi' });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('INVALID_BACKEND');

    const negotiated = await ask('POST', '/api/sessions', input, 'pi-agent');
    expect(negotiated.statusCode).toBe(200);
    expect(negotiated.json().backendId).toBe('pi');
    const explicit = await ask('POST', '/api/sessions', { ...input, backendId: 'pi' }, 'pi-agent');
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json().backendId).toBe('pi');
  });

  it('trusts internal session creation without request headers while an explicit empty header set falls back', async () => {
    const { projectDir, store, settings, nativeBackends } = await boot({ defaultBackendId: 'pi' });
    const project = store.createProject(projectDir, 'pi-internal');
    const deps = { store, settings, nativeBackends };

    const internal = await resolveNativeSessionInput(deps, { projectId: project.id });
    expect(internal.backendId).toBe('pi');
    const request = await resolveNativeSessionInput(deps, { projectId: project.id }, {});
    expect(request.backendId).toBe('claude');
    await expect(resolveNativeSessionInput(deps, { projectId: project.id, backendId: 'pi' }, {})).rejects.toMatchObject({ code: 'INVALID_BACKEND' });
  });

  it('preserves hidden pi defaults when an older client saves visible settings', async () => {
    const { call, stateDir, settings } = await boot({ defaultBackendId: 'pi', nativeBackendDefaults: { pi: { model: 'pi-model', approval: 'read-only' }, cursor: { model: 'cursor-model' } } });
    // The older client read the fallback (Claude here, no CLI is installed) and saves it back.
    const savedDefault = await call('PATCH', '/api/settings', { defaultBackendId: 'claude' });
    expect(savedDefault.statusCode).toBe(200);
    expect(savedDefault.json().defaultBackendId).toBe('claude');
    expect(settings.getSettings().defaultBackendId).toBe('pi');
    expect(JSON.parse(await readFile(join(stateDir, 'settings.json'), 'utf8')).defaultBackendId).toBe('pi');

    const savedDefaults = await call('PATCH', '/api/settings', { nativeBackendDefaults: { cursor: { model: 'cursor-next' } } });
    expect(savedDefaults.statusCode).toBe(200);
    expect(savedDefaults.json().nativeBackendDefaults).toEqual({ cursor: { model: 'cursor-next' } });
    expect(settings.getSettings().nativeBackendDefaults).toEqual({ pi: { model: 'pi-model', approval: 'read-only' }, cursor: { model: 'cursor-next' } });

    const explicitDefault = await call('PATCH', '/api/settings', { defaultBackendId: 'pi' });
    expect(explicitDefault.statusCode).toBe(400);
    expect(explicitDefault.json().error.code).toBe('INVALID_BACKEND');
    const explicitDefaults = await call('PATCH', '/api/settings', { nativeBackendDefaults: { pi: { model: 'new-model' } } });
    expect(explicitDefaults.statusCode).toBe(400);
    expect(explicitDefaults.json().error.code).toBe('INVALID_BACKEND');
    const cleared = await call('PATCH', '/api/settings', { nativeBackendDefaults: null });
    expect(cleared.statusCode).toBe(400);
    expect(cleared.json().error.code).toBe('INVALID_SETTINGS');
    const auxiliary = await call('PATCH', '/api/settings', { auxiliaryModels: { title: { backendId: 'pi', profileId: 'default', model: 'pi-model' } } });
    expect(auxiliary.statusCode).toBe(400);
    expect(auxiliary.json().error.code).toBe('INVALID_BACKEND');
  });

});

describe('worktree projects', () => {
  /** A repository with one commit; `git worktree add` needs a commit to branch from. */
  async function repo(dir: string) {
    const run = async (...args: string[]) => {
      const { execFile } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => execFile('git', args, { cwd: dir }, (error) => error ? reject(error) : resolve()));
    };
    await run('init', '-q', '-b', 'main');
    await run('config', 'user.email', 'test@example.com');
    await run('config', 'user.name', 'Test');
    await writeFile(join(dir, 'README.md'), 'seed\n');
    await run('add', '.');
    await run('commit', '-qm', 'seed');
  }

  it('creates one isolated automation session on concurrent retries, rejecting a different launch before making another worktree', async () => {
    const { projectDir, call, dispatch, git, store } = await boot();
    await dispatch.close();
    await repo(projectDir);
    const project = (await call('POST', '/api/projects', { cwd: projectDir })).json() as { id: string };
    const automation = (await call('POST', '/api/automations', { name: 'check', prompt: 'inspect', isolate: true })).json() as { id: string };
    const body = { projectId: project.id, clientSessionId: 'automation-retry', commandId: 'automation-command' };
    const responses = await Promise.all([call('POST', `/api/automations/${automation.id}/run`, body), call('POST', `/api/automations/${automation.id}/run`, body)]);
    expect(responses.map(response => response.statusCode)).toEqual([202, 202]);
    expect(responses[0].json().runId).toBe(responses[1].json().runId);
    expect(await git.worktrees(store.getProject(project.id))).toHaveLength(2);
    const other = (await call('POST', '/api/automations', { name: 'other', prompt: 'different' })).json() as { id: string };
    expect((await call('POST', `/api/automations/${other.id}/run`, body)).statusCode).toBe(409);
    const invalid = (await call('POST', '/api/automations', { name: 'invalid', prompt: 'inspect', isolate: true, target: { backendId: 'cursor', mode: 'unsupported-mode' } })).json() as { id: string };
    expect((await call('POST', `/api/automations/${invalid.id}/run`, { ...body, clientSessionId: 'invalid-launch' })).statusCode).toBe(400);
    expect(await git.worktrees(store.getProject(project.id))).toHaveLength(2);
  });

  it('resumes a partially created attempt group without repeating its completed work on concurrent retries', async () => {
    const { projectDir, call, dispatch, git, store } = await boot();
    await dispatch.close();
    await repo(projectDir);
    const project = (await call('POST', '/api/projects', { cwd: projectDir })).json() as { id: string };
    const create = git.createWorktree.bind(git);
    let creations = 0;
    vi.spyOn(git, 'createWorktree').mockImplementation(async (...args) => {
      if (++creations === 2) throw new Error('temporary worktree failure');
      return create(...args);
    });
    const body = { prompt: 'inspect', targets: [{ backendId: 'cursor' }, { backendId: 'cursor' }], requestId: 'attempt-retry' };
    expect((await call('POST', `/api/projects/${project.id}/attempts`, body)).statusCode).toBe(500);
    const partial = (await call('GET', `/api/projects/${project.id}/attempts`)).json();
    expect(partial).toHaveLength(1);
    expect(partial[0].attempts).toHaveLength(1);
    const retried = await Promise.all([call('POST', `/api/projects/${project.id}/attempts`, body), call('POST', `/api/projects/${project.id}/attempts`, body)]);
    expect(retried.map(response => response.statusCode)).toEqual([202, 202]);
    expect(retried[0].json().group.id).toBe(partial[0].id);
    expect(retried[1].json().group.attempts).toHaveLength(2);
    expect(store.listSessions().filter(session => session.origin?.groupId === partial[0].id)).toHaveLength(2);
    expect(await git.worktrees(store.getProject(project.id))).toHaveLength(3);
    expect((await call('POST', `/api/projects/${project.id}/attempts`, { ...body, base: 'main' })).statusCode).toBe(409);
  });

  it('adds an attempt to a group and discards one, archiving its session and removing its clean worktree', async () => {
    const { projectDir, call, dispatch, git, store } = await boot();
    await dispatch.close();
    await repo(projectDir);
    const project = (await call('POST', '/api/projects', { cwd: projectDir })).json() as { id: string };
    const created = (await call('POST', `/api/projects/${project.id}/attempts`, { prompt: 'inspect', targets: [{ backendId: 'cursor' }, { backendId: 'cursor', model: 'second' }], requestId: 'attempt-lifecycle' })).json();
    const group = created.group as { id: string; attempts: Array<{ sessionId: string; projectId: string }> };
    expect(group.attempts).toHaveLength(2);
    const added = await call('POST', `/api/attempts/${group.id}/attempts`, { target: { backendId: 'cursor', model: 'third' } });
    expect(added.statusCode).toBe(202);
    expect(added.json().group.attempts).toHaveLength(3);
    // The launched runs never ran (the dispatcher is closed); settle one so it can be discarded.
    const victim = group.attempts[0]!;
    for (const run of store.listRuns(victim.sessionId)) {
      store.transitionNativeRun(run.id, ['queued', 'preparing', 'dispatching', 'input_sent', 'observed', 'uncertain'], { delivery: 'failed' }, { state: 'failed' });
    }
    const discarded = await call('POST', `/api/attempts/${group.id}/discard`, { sessionId: victim.sessionId, removeWorktree: true });
    expect(discarded.statusCode).toBe(200);
    expect(discarded.json().group.attempts[0].discardedAt).toBeTruthy();
    expect(store.getSession(victim.sessionId).archivedAt).toBeTruthy();
    expect(store.getProject(victim.projectId).archivedAt).toBeTruthy();
    expect(await git.worktrees(store.getProject(project.id))).toHaveLength(3);
  });

  it('runs attempts in a directory outside Git without writing a repository into it, and merges the adopted one over later edits', async () => {
    const { projectDir, call, dispatch, store } = await boot();
    await dispatch.close();
    await writeFile(join(projectDir, 'notes.txt'), 'one\ntwo\nthree\n');
    await writeFile(join(projectDir, '.gitignore'), 'local.env\n');
    await writeFile(join(projectDir, 'local.env'), 'MINE\n');
    const project = (await call('POST', '/api/projects', { cwd: projectDir })).json() as { id: string };
    const created = await call('POST', `/api/projects/${project.id}/attempts`, { prompt: 'edit', targets: [{ backendId: 'cursor' }, { backendId: 'cursor', model: 'second' }] });
    expect(created.statusCode).toBe(202);
    expect(created.json().warnings).toEqual([]);
    const group = created.json().group as { id: string; attempts: Array<{ sessionId: string; projectId: string }> };
    expect(() => statSync(join(projectDir, '.git'))).toThrow();
    const chosen = group.attempts[0]!;
    const attemptDir = store.getProject(chosen.projectId).cwd;
    expect(await readFile(join(attemptDir, 'notes.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    await writeFile(join(attemptDir, 'notes.txt'), 'ONE\ntwo\nthree\n');
    await writeFile(join(attemptDir, 'added.txt'), 'new\n');
    // The directory moves on while the attempt runs: adopting merges into it instead of overwriting.
    await writeFile(join(projectDir, 'notes.txt'), 'one\ntwo\nTHREE\n');
    const compared = (await call('GET', `/api/attempts/${group.id}`)).json() as { attempts: Array<{ sessionId: string; comparison?: { files: Array<{ path: string }> } }> };
    expect(compared.attempts.find(item => item.sessionId === chosen.sessionId)?.comparison?.files.map(file => file.path)).toEqual(['added.txt', 'notes.txt']);
    for (const attempt of group.attempts) {
      for (const run of store.listRuns(attempt.sessionId)) {
        store.transitionNativeRun(run.id, ['queued', 'preparing', 'dispatching', 'input_sent', 'observed', 'uncertain'], { delivery: 'failed' }, { state: 'failed' });
      }
    }
    // The dispatcher is closed so the attempts never run; the merge only needs their workspaces held.
    vi.spyOn(dispatch, 'reserveWorkspace').mockReturnValue(() => undefined);
    // An attempt that starts tracking a file the directory ignores must not write over the only copy.
    const other = store.getProject(group.attempts[1]!.projectId).cwd;
    await writeFile(join(other, '.gitignore'), '');
    await writeFile(join(other, 'local.env'), 'THEIRS\n');
    const refused = await call('POST', `/api/attempts/${group.id}/adopt`, { sessionId: group.attempts[1]!.sessionId, commitPending: 'other', cleanup: 'keep' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('MERGE_CONFLICT');
    expect(await readFile(join(projectDir, 'local.env'), 'utf8')).toBe('MINE\n');
    const adopted = await call('POST', `/api/attempts/${group.id}/adopt`, { sessionId: chosen.sessionId, commitPending: 'attempt', cleanup: 'keep' });
    expect(adopted.statusCode).toBe(200);
    expect(adopted.json().merge.merged).toBe(true);
    expect(await readFile(join(projectDir, 'notes.txt'), 'utf8')).toBe('ONE\ntwo\nTHREE\n');
    expect(await readFile(join(projectDir, 'added.txt'), 'utf8')).toBe('new\n');
    expect(await readFile(join(projectDir, 'local.env'), 'utf8')).toBe('MINE\n');
    expect(() => statSync(join(projectDir, '.git'))).toThrow();
  });

  it('cuts a worktree, registers it as a project, and keeps uncommitted work behind', async () => {
    const { projectDir, call } = await boot();
    await repo(projectDir);
    // An unclean source is the normal reason to want a separate checkout, so it must not block.
    await writeFile(join(projectDir, 'README.md'), 'edited but not committed\n');
    const origin = (await call('POST', '/api/projects', { cwd: projectDir })).json() as { id: string; name: string };

    const response = await call('POST', `/api/projects/${origin.id}/worktree-projects`);
    expect(response.statusCode).toBe(200);
    const created = response.json() as { id: string; cwd: string; worktree?: { originProjectId: string; branch: string } };
    expect(created.worktree?.originProjectId).toBe(origin.id);
    expect(created.worktree?.branch).toMatch(/^riffet\/[^/]+_\d{8}-[0-9a-f]{4}$/);
    expect(created.cwd).not.toBe(projectDir);
    // The worktree is cut from the commit, so the edit stays in the original checkout only.
    expect(await readFile(join(created.cwd, 'README.md'), 'utf8')).toBe('seed\n');
    expect(await readFile(join(projectDir, 'README.md'), 'utf8')).toBe('edited but not committed\n');

    // Adopting the same worktree again returns the project that already exists.
    const again = await call('POST', `/api/projects/${origin.id}/worktree-projects`, { path: created.cwd });
    expect((again.json() as { id: string }).id).toBe(created.id);
  });

  it('refuses a worktree origin loop and keeps an origin with worktrees from being deleted', async () => {
    const { projectDir, store, call } = await boot();
    await repo(projectDir);
    const root = (await call('POST', '/api/projects', { cwd: projectDir })).json() as { id: string; cwd: string };
    const worktree = (await call('POST', `/api/projects/${root.id}/worktree-projects`)).json() as { id: string };
    // Adopting the main checkout as a worktree of its own worktree would link the chain back on itself.
    const loop = await call('POST', `/api/projects/${worktree.id}/worktree-projects`, { path: root.cwd });
    expect(loop.statusCode).toBe(409);
    expect(loop.json().error.code).toBe('PROJECT_ORIGIN_CYCLE');
    expect(store.getProject(root.id).worktree).toBeUndefined();
    const deleted = await call('DELETE', `/api/projects/${root.id}`);
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().error.code).toBe('PROJECT_HAS_WORKTREES');
  });

  it('refuses to turn an unrelated directory or the project itself into a worktree project', async () => {
    const { projectDir, stateDir, call } = await boot();
    await repo(projectDir);
    const origin = (await call('POST', '/api/projects', { cwd: projectDir })).json() as { id: string };

    const outside = await call('POST', `/api/projects/${origin.id}/worktree-projects`, { path: stateDir });
    expect(outside.statusCode).toBe(404);
    const itself = await call('POST', `/api/projects/${origin.id}/worktree-projects`, { path: projectDir });
    expect(itself.statusCode).toBe(400);
  });

  // git reports a worktree's real path, and a client can reach the same directory through a symlink
  // (macOS `/var` and `/private/var` are the same place). Comparing unresolved paths turned a real
  // worktree into an unrelated one.
  it.skipIf(process.platform === 'win32')('adopts a worktree handed over through a symlinked path', async () => {
    const { projectDir, call } = await boot();
    await repo(projectDir);
    const origin = (await call('POST', '/api/projects', { cwd: projectDir })).json() as { id: string };
    const created = (await call('POST', `/api/projects/${origin.id}/worktree-projects`)).json() as { id: string; cwd: string };

    const link = `${created.cwd}-link`;
    await symlink(created.cwd, link);
    const adopted = await call('POST', `/api/projects/${origin.id}/worktree-projects`, { path: link });
    expect(adopted.statusCode).toBe(200);
    expect((adopted.json() as { id: string }).id).toBe(created.id);
  });

  // Merging writes into the checkout the user works in, so a refused or conflicting merge must leave
  // it exactly as it was rather than half-merged.
  it('merges a worktree back only cleanly, aborting a conflict without touching the target', async () => {
    const { projectDir, call } = await boot();
    await repo(projectDir);
    const git = async (cwd: string, ...args: string[]) => {
      const { execFile } = await import('node:child_process');
      return new Promise<string>((resolve, reject) => execFile('git', args, { cwd }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    };
    const origin = (await call('POST', '/api/projects', { cwd: projectDir })).json() as { id: string };
    const created = (await call('POST', `/api/projects/${origin.id}/worktree-projects`)).json() as { id: string; cwd: string };

    await writeFile(join(created.cwd, 'feature.txt'), 'feature\n');
    const dirty = await call('POST', `/api/projects/${created.id}/worktree/merge`);
    expect(dirty.json()).toMatchObject({ error: { code: 'WORKTREE_DIRTY' } });
    const merged = await call('POST', `/api/projects/${created.id}/worktree/merge`, { commitPending: 'add feature' });
    expect(merged.json()).toMatchObject({ merged: true, commits: 1, into: 'main' });
    expect(await readFile(join(projectDir, 'feature.txt'), 'utf8')).toBe('feature\n');

    await writeFile(join(created.cwd, 'README.md'), 'from worktree\n');
    await git(created.cwd, 'commit', '-qam', 'worktree edit');
    await writeFile(join(projectDir, 'README.md'), 'from main\n');
    await git(projectDir, 'commit', '-qam', 'main edit');
    const conflict = await call('POST', `/api/projects/${created.id}/worktree/merge`);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'MERGE_CONFLICT', details: { paths: ['README.md'] } } });
    expect(await git(projectDir, 'status', '--porcelain')).toBe('');
    expect(await readFile(join(projectDir, 'README.md'), 'utf8')).toBe('from main\n');
  }, 45_000);
});

describe('orchestration submissions', () => {
  it('returns a review receipt after model changes or archival without sending a second command', async () => {
    const { projectDir, store, dispatch, call } = await boot();
    await dispatch.close();
    const project = store.createProject(projectDir, 'review');
    const session = store.createSession({ projectId: project.id, kind: 'native', model: 'first-model' });
    const body = { commandId: 'review-command', comments: [{ path: 'file.ts', line: 1, body: 'fix this' }] };
    const first = await call('POST', `/api/sessions/${session.id}/review`, body);
    expect(first.statusCode).toBe(202);
    store.updateSession(session.id, { model: 'second-model', archivedAt: new Date().toISOString() });
    const retry = await call('POST', `/api/sessions/${session.id}/review`, body);
    expect(retry.statusCode).toBe(202);
    expect(retry.json().id).toBe(first.json().id);
    expect(store.listRuns(session.id)).toHaveLength(1);
    expect((await call('POST', `/api/sessions/${session.id}/review`, { ...body, comments: [{ path: 'file.ts', body: 'different request' }] })).statusCode).toBe(409);
  });

  it('carries imported native history into a fork and rechecks source activity after preparing a handoff', async () => {
    const { projectDir, store, nativeBackends, dispatch, call } = await boot();
    await dispatch.close();
    const project = store.createProject(projectDir, 'handoff');
    const source = store.createSession({ projectId: project.id, kind: 'native', title: 'Imported conversation' });
    store.indexMessages([
      { sessionId: source.id, messageId: 'native-user', kind: 'user', text: 'Keep the migration backwards compatible', at: '2026-01-01T00:00:00.000Z' },
      { sessionId: source.id, messageId: 'native-assistant', kind: 'assistant', text: 'The old reader still accepts the new format', at: '2026-01-01T00:01:00.000Z' },
    ]);
    vi.spyOn(nativeBackends, 'indexableTranscript').mockResolvedValue([]);
    const fork = await call('POST', `/api/sessions/${source.id}/fork`, { clientSessionId: 'history-fork', commandId: 'fork-command' });
    expect(fork.statusCode).toBe(202);
    expect(fork.json().run).toBeUndefined();
    expect(store.listRuns('history-fork')).toHaveLength(0);
    // Retrying an idle fork with the same idempotency keys returns the created session.
    expect((await call('POST', `/api/sessions/${source.id}/fork`, { clientSessionId: 'history-fork', commandId: 'fork-command' })).json()).toMatchObject({ session: { id: 'history-fork' } });
    // The deferred brief rides along with the user's first message, stays idempotent on retry, and is not repeated.
    const firstSend = await call('POST', '/api/sessions/history-fork/native/send', { commandId: 'fork-first-msg', text: 'Continue with v2' });
    expect(firstSend.statusCode).toBe(202);
    expect(firstSend.json().prompt).toContain('Keep the migration backwards compatible');
    expect(firstSend.json().prompt).toContain('The old reader still accepts the new format');
    expect(firstSend.json().prompt).toContain('Continue with v2');
    const retrySend = await call('POST', '/api/sessions/history-fork/native/send', { commandId: 'fork-first-msg', text: 'Continue with v2' });
    expect(retrySend.statusCode).toBe(202);
    expect(retrySend.json().id).toBe(firstSend.json().id);
    const secondSend = await call('POST', '/api/sessions/history-fork/native/send', { commandId: 'fork-second-msg', text: 'Second turn only' });
    expect(secondSend.statusCode).toBe(202);
    expect(secondSend.json().prompt).toBe('Second turn only');
    vi.spyOn(nativeBackends, 'indexableTranscript').mockImplementationOnce(async () => {
      store.acceptNativeRun(source.id, 'new-source-command', { text: 'continue', attachmentIds: [], context: [] }, { mode: 'agent' });
      return [];
    });
    const handoff = await call('POST', `/api/sessions/${source.id}/handoff`, { clientSessionId: 'handoff-race', commandId: 'handoff-command', target: { backendId: 'cursor' } });
    expect(handoff.statusCode).toBe(409);
    expect(handoff.json()).toMatchObject({ error: { code: 'SESSION_BUSY' } });
    expect(store.listSessions().some(session => session.id === 'handoff-race')).toBe(false);
    const autonomous = store.createSession({ projectId: project.id, kind: 'native' });
    vi.spyOn(nativeBackends, 'status').mockReturnValue({ phase: 'busy' });
    const active = await call('POST', `/api/sessions/${autonomous.id}/handoff`, { clientSessionId: 'autonomous-handoff', commandId: 'handoff-command', target: { backendId: 'cursor' } });
    expect(active.json()).toMatchObject({ error: { code: 'SESSION_BUSY' } });
    expect(store.listSessions().some(session => session.id === 'autonomous-handoff')).toBe(false);
  });

  it('drafts a handoff from the transcript when the model fails, keeps an earlier brief whole, and sends the edited draft', async () => {
    const { projectDir, store, nativeBackends, dispatch, call } = await boot();
    await dispatch.close();
    const project = store.createProject(projectDir, 'drafted handoff');
    const earlier = `${'以下是更早的交接内容。'.repeat(400)}\nEARLIER-STATE-MARKER`;
    const source = store.createSession({ projectId: project.id, kind: 'native', title: 'Continued conversation', origin: { kind: 'handoff', sessionId: 'older' } });
    const opening = store.acceptNativeRun(source.id, 'opening', { text: earlier, attachmentIds: [], context: [] }, { mode: 'agent' });
    store.transitionNativeRun(opening.id, ['queued'], { delivery: 'observed' }, { state: 'completed' });
    store.indexMessages([
      { sessionId: source.id, messageId: 'reply-start', kind: 'assistant', text: 'Looking at the reader first', at: new Date(Date.parse(opening.createdAt) + 1_000).toISOString() },
      { sessionId: source.id, messageId: 'edit', kind: 'tool', text: 'Edit src/reader.ts', at: new Date(Date.parse(opening.createdAt) + 2_000).toISOString() },
      { sessionId: source.id, messageId: 'reply-end', kind: 'assistant', text: 'The reader now accepts both formats', at: new Date(Date.parse(opening.createdAt) + 3_000).toISOString() },
    ]);
    vi.spyOn(nativeBackends, 'indexableTranscript').mockResolvedValue([]);
    expect((await call('POST', '/api/backends/dsh/profiles', { id: 'offline', name: 'Offline', apiEndpoint: 'http://127.0.0.1:9', enabledModels: ['m'] })).statusCode).toBe(200);
    expect((await call('PATCH', '/api/settings', { auxiliaryModels: { handoff: { backendId: 'dsh', profileId: 'offline', model: 'm' } } })).statusCode).toBe(200);

    const draft = await call('POST', `/api/sessions/${source.id}/handoff/draft`, { target: { backendId: 'cursor' }, goal: 'Finish the writer' });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().generatedBy).toBeUndefined();
    expect(draft.json().fallbackReason).toBeTruthy();
    const text: string = draft.json().text;
    expect(text).toContain('EARLIER-STATE-MARKER');
    expect(text).toContain('Edit src/reader.ts');
    expect(text).toContain('The reader now accepts both formats');
    expect(text).toMatch(/Finish the writer$/);

    const edited = `${text}\n\nAlso keep the tests green`;
    const body = { clientSessionId: 'drafted-handoff', commandId: 'drafted-command', target: { backendId: 'cursor' }, text: edited };
    const handoff = await call('POST', `/api/sessions/${source.id}/handoff`, body);
    expect(handoff.statusCode).toBe(202);
    expect(handoff.json().run.prompt).toBe(edited);
    expect(store.getSession(source.id).handedOffTo).toBe('drafted-handoff');
    expect((await call('POST', `/api/sessions/${source.id}/handoff`, body)).json().session.id).toBe('drafted-handoff');
  });

  it('keeps an answer in its actual turn when the next prompt was queued before that answer', async () => {
    const { projectDir, store, nativeBackends, dispatch, call } = await boot();
    await dispatch.close();
    const project = store.createProject(projectDir, 'queued history');
    const session = store.createSession({ projectId: project.id, kind: 'native' });
    const first = store.acceptNativeRun(session.id, 'first', { text: 'first question', attachmentIds: [], context: [] }, { mode: 'agent' });
    const queued = store.acceptNativeRun(session.id, 'queued', { text: 'queued question', attachmentIds: [], context: [] }, { mode: 'agent' });
    const at = Date.parse(first.createdAt);
    store.transitionNativeRun(first.id, ['queued'], { delivery: 'observed', timings: { dispatchAt: at, completedAt: at + 3_000 } }, { state: 'completed' });
    store.indexMessages([{ sessionId: session.id, messageId: 'answer-first', kind: 'assistant', text: 'answer to first question', at: new Date(at + 2_000).toISOString() }]);
    vi.spyOn(nativeBackends, 'indexableTranscript').mockResolvedValue([]);
    const fork = await call('POST', `/api/sessions/${session.id}/fork`, { clientSessionId: 'queued-fork', commandId: 'fork-command', runId: first.id, note: 'follow up' });
    expect(fork.statusCode).toBe(202);
    expect(fork.json().run.prompt).toContain('answer to first question');
    expect(fork.json().run.prompt).not.toContain('queued question');
    store.transitionNativeRun(queued.id, ['queued'], { delivery: 'observed', timings: { dispatchAt: at + 4_000, completedAt: at + 6_000 } }, { state: 'completed' });
    store.indexMessages([{ sessionId: session.id, messageId: 'answer-queued', kind: 'assistant', text: 'answer to queued question', at: new Date(at + 5_000).toISOString() }]);
    const laterFork = await call('POST', `/api/sessions/${session.id}/fork`, { clientSessionId: 'later-queued-fork', commandId: 'fork-command', runId: first.id, note: 'follow up' });
    expect(laterFork.statusCode).toBe(202);
    expect(laterFork.json().run.prompt).toContain('answer to first question');
    expect(laterFork.json().run.prompt).not.toContain('answer to queued question');

    const rounded = store.createSession({ projectId: project.id, kind: 'native', backendId: 'codex' });
    const turnOne = store.acceptNativeRun(rounded.id, 'turn-1', { text: 'inspect spaces', attachmentIds: [], context: [] }, { mode: 'agent' });
    const turnTwo = store.acceptNativeRun(rounded.id, 'turn-2', { text: 'explain messages', attachmentIds: [], context: [] }, { mode: 'agent' });
    store.transitionNativeRun(turnOne.id, ['queued'], { delivery: 'observed', timings: { dispatchAt: Date.parse('2026-01-01T00:00:01.483Z') } }, { state: 'completed' });
    store.transitionNativeRun(turnTwo.id, ['queued'], { delivery: 'failed', timings: { dispatchAt: Date.parse('2026-01-01T00:01:02.777Z') } }, { state: 'failed' });
    store.journal.append(rounded.id, [
      { kind: 'user_message_chunk', nativeId: 'u1', at: '2026-01-01T00:00:05.000Z', payload: { type: 'user_message_chunk', nativeId: 'u1', createdAt: '2026-01-01T00:00:05.000Z', data: { content: { type: 'text', text: 'inspect spaces' } } } },
      { kind: 'agent_message_chunk', nativeId: 'a1', at: '2026-01-01T00:00:01.000Z', payload: { type: 'agent_message_chunk', nativeId: 'a1', createdAt: '2026-01-01T00:00:01.000Z', data: { content: { type: 'text', text: 'P0 P1 P2 proposal' } } } },
      { kind: 'user_message_chunk', nativeId: 'u2', at: '2026-01-01T00:01:05.000Z', payload: { type: 'user_message_chunk', nativeId: 'u2', createdAt: '2026-01-01T00:01:05.000Z', data: { content: { type: 'text', text: 'explain messages' } } } },
    ]);
    const roundedFork = await call('POST', `/api/sessions/${rounded.id}/fork`, { clientSessionId: 'rounded-fork', commandId: 'rounded-fork-command', runId: turnOne.id, note: 'follow up' });
    expect(roundedFork.statusCode).toBe(202);
    expect(roundedFork.json().run.prompt).toContain('P0 P1 P2 proposal');
    expect(roundedFork.json().run.prompt).not.toContain('explain messages');
  });

  it('rejects non-isolated fork while actively running, restores checkpoint in isolated fork, and enriches session references', async () => {
    const { projectDir, stateDir, store, nativeBackends, git, dispatch, call } = await boot();
    await dispatch.close();
    const project = store.createProject(projectDir, 'fork-and-ref');

    // 1) Non-isolated fork must reject an actively running conversation; isolated fork rolls back worktree on launch error.
    const active = store.createSession({ projectId: project.id, kind: 'native', title: 'Active task' });
    store.updateSession(active.id, { state: 'running' });
    const blocked = await call('POST', `/api/sessions/${active.id}/fork`, { clientSessionId: 'blocked-fork', commandId: 'blocked-cmd' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: { code: 'SESSION_BUSY' } });

    // 2) Exact identity cutoff when two turns share identical prompt text.
    const dup = store.createSession({ projectId: project.id, kind: 'native', title: 'Repeated prompt' });
    const r1 = store.acceptNativeRun(dup.id, 'dup-1', { text: 'continue', attachmentIds: [], context: [] }, { mode: 'agent' });
    const r2 = store.acceptNativeRun(dup.id, 'dup-2', { text: 'continue', attachmentIds: [], context: [] }, { mode: 'agent' });
    store.transitionNativeRun(r1.id, ['queued'], { delivery: 'observed', nativeMessageId: 'u-dup-1', nativeTurnId: 't-dup-1' }, { state: 'completed' });
    store.transitionNativeRun(r2.id, ['queued'], { delivery: 'observed', nativeMessageId: 'u-dup-2', nativeTurnId: 't-dup-2' }, { state: 'completed' });
    store.journal.append(dup.id, [
      { kind: 'user_message_chunk', nativeId: 'u-dup-1', turnId: 't-dup-1', at: '2026-01-01T00:00:01.000Z', payload: { type: 'user_message_chunk', nativeId: 'u-dup-1', nativeTurnId: 't-dup-1', runId: r1.id, createdAt: '2026-01-01T00:00:01.000Z', data: { content: { type: 'text', text: 'continue' } } } },
      { kind: 'agent_message_chunk', nativeId: 'a-dup-1', turnId: 't-dup-1', at: '2026-01-01T00:00:02.000Z', payload: { type: 'agent_message_chunk', nativeId: 'a-dup-1', nativeTurnId: 't-dup-1', runId: r1.id, createdAt: '2026-01-01T00:00:02.000Z', data: { content: { type: 'text', text: 'FIRST-TURN-ONLY' } } } },
      { kind: 'user_message_chunk', nativeId: 'u-dup-2', turnId: 't-dup-2', at: '2026-01-01T00:00:03.000Z', payload: { type: 'user_message_chunk', nativeId: 'u-dup-2', nativeTurnId: 't-dup-2', runId: r2.id, createdAt: '2026-01-01T00:00:03.000Z', data: { content: { type: 'text', text: 'continue' } } } },
      { kind: 'agent_message_chunk', nativeId: 'a-dup-2', turnId: 't-dup-2', at: '2026-01-01T00:00:04.000Z', payload: { type: 'agent_message_chunk', nativeId: 'a-dup-2', nativeTurnId: 't-dup-2', runId: r2.id, createdAt: '2026-01-01T00:00:04.000Z', data: { content: { type: 'text', text: 'SECOND-TURN-EXCLUDED' } } } },
    ]);
    vi.spyOn(nativeBackends, 'indexableTranscript').mockResolvedValue([]);
    const midFork = await call('POST', `/api/sessions/${dup.id}/fork`, { clientSessionId: 'dup-mid-fork', commandId: 'dup-mid-cmd', runId: r1.id, note: 'Try approach B' });
    expect(midFork.statusCode).toBe(202);
    expect(midFork.json().run.prompt).toContain('FIRST-TURN-ONLY');
    expect(midFork.json().run.prompt).not.toContain('SECOND-TURN-EXCLUDED');
    expect(midFork.json().run.prompt).toContain('## Next step');
    expect(midFork.json().run.prompt).toContain('Try approach B');

    // 2b) Native fork without a note stays idle with cloned nativeSessionId and no auto-sent run.
    const nativeForkSpy = vi.spyOn(nativeBackends, 'forkNativeSession').mockResolvedValue({ nativeSessionId: 'native-fork-idle' });
    const nativeIdle = await call('POST', `/api/sessions/${dup.id}/fork`, { clientSessionId: 'native-idle-fork', commandId: 'native-idle-cmd', runId: r1.id });
    expect(nativeIdle.statusCode).toBe(202);
    expect(nativeIdle.json().run).toBeUndefined();
    expect(nativeIdle.json().session).toMatchObject({ id: 'native-idle-fork', state: 'idle', nativeSessionId: 'native-fork-idle' });
    expect(store.listRuns('native-idle-fork')).toHaveLength(0);
    // Sending a message on a natively forked session sends only the user's text (no deferred brief).
    const nativeMsg = await call('POST', '/api/sessions/native-idle-fork/native/send', { commandId: 'native-user-msg', text: 'Switch to approach B' });
    expect(nativeMsg.statusCode).toBe(202);
    expect(nativeMsg.json().prompt).toBe('Switch to approach B');
    // Late retry of the fork request still resolves idempotently after user turns exist.
    expect((await call('POST', `/api/sessions/${dup.id}/fork`, { clientSessionId: 'native-idle-fork', commandId: 'native-idle-cmd', runId: r1.id })).json()).toMatchObject({ session: { id: 'native-idle-fork' } });
    nativeForkSpy.mockRestore();

    // 3) Session reference skips fork/handoff brief boilerplate in excerpt and records compact tool summaries.
    const forkedSource = store.createSession({ projectId: project.id, kind: 'native', title: 'Forked thread' });
    const recipient = store.createSession({ projectId: project.id, kind: 'native', title: 'Reader' });
    store.journal.append(forkedSource.id, [
      { kind: 'user_message_chunk', nativeId: 'fu-1', turnId: 'ft-1', at: '2026-01-01T00:00:01.000Z', payload: { type: 'user_message_chunk', nativeId: 'fu-1', nativeTurnId: 'ft-1', createdAt: '2026-01-01T00:00:01.000Z', data: { content: { type: 'text', text: 'Below is the context of another conversation ("Old").\n\n## Next step\nRefactor auth token rotation' } } } },
      { kind: 'tool_call', nativeId: 'ftool-1', turnId: 'ft-1', at: '2026-01-01T00:00:02.000Z', payload: { type: 'tool_call', nativeId: 'ftool-1', nativeTurnId: 'ft-1', createdAt: '2026-01-01T00:00:02.000Z', data: { toolName: 'Edit', title: 'Edit src/auth.ts' } } },
      { kind: 'agent_message_chunk', nativeId: 'fa-1', turnId: 'ft-1', at: '2026-01-01T00:00:03.000Z', payload: { type: 'agent_message_chunk', nativeId: 'fa-1', nativeTurnId: 'ft-1', createdAt: '2026-01-01T00:00:03.000Z', data: { content: { type: 'text', text: 'Rotated tokens with sliding expiry.' } } } },
    ]);
    const refs = new SessionReferenceService(store, stateDir);
    const prepared = await refs.prepare(recipient.id, { text: 'check', attachmentIds: [], context: [], references: [{ kind: 'session', sessionId: forkedSource.id }] });
    expect(prepared[0]!.metadata.excerpt).toContain('Refactor auth token rotation');
    expect(prepared[0]!.metadata.excerpt).not.toContain('Below is the context of another conversation');
    const snapshot = JSON.parse(prepared[0]!.bytes!.toString('utf8'));
    expect(snapshot.messages[1].tools).toEqual(['Edit src/auth.ts']);
    expect(refs.markdown(snapshot)).toContain('Tools: Edit src/auth.ts');

    // 4) Isolated fork uses turn checkpoint when available.
    const checkpointSpy = vi.spyOn(git, 'checkpoints').mockResolvedValue([{ id: 'cp-1', sessionId: dup.id, runId: r1.id, createdAt: '2026-01-01T00:00:02.000Z', partial: false, excluded: [], files: 1 } as never]);
    const fromCpSpy = vi.spyOn(git, 'createWorktreeFromCheckpoint').mockResolvedValue(undefined);
    const wtSpy = vi.spyOn(git, 'createWorktree').mockResolvedValue({ path: projectDir, branch: 'fork-cp', head: '1234567890abcdef', locked: false, prunable: false, main: false } as never);
    const isolated = await call('POST', `/api/sessions/${dup.id}/fork`, { clientSessionId: 'iso-cp-fork', commandId: 'iso-cp-cmd', runId: r1.id, isolate: true });
    expect(isolated.statusCode).toBe(202);
    expect(fromCpSpy).toHaveBeenCalledWith(expect.objectContaining({ id: project.id }), expect.objectContaining({ checkpointId: 'cp-1' }));
    checkpointSpy.mockRestore();
    fromCpSpy.mockRestore();
    wtSpy.mockRestore();
  });
});

describe('automations', () => {
  it('applies both day constraints when a cron day field uses a wildcard step', () => {
    const next = nextCronTime(parseCron('0 9 */2 * 1'), new Date(Date.UTC(2026, 0, 5, 10)), 'UTC');
    // The 12th is a Monday but not an odd day; odd weekdays before the 19th are not Mondays.
    expect(next?.getTime()).toBe(Date.UTC(2026, 0, 19, 9));
  });

  it('reads cron in its own time zone, skips a time the clock jumps over and runs a repeated one once', () => {
    const zone = 'America/New_York';
    const at = (cron: string, after: string) => nextCronTime(parseCron(cron), new Date(after), zone)?.toISOString();
    expect(at('0 9 * * *', '2026-01-10T00:00:00Z')).toBe('2026-01-10T14:00:00.000Z');
    // 02:30 does not exist on 8 March 2026; the next run is the following day.
    expect(at('30 2 * * *', '2026-03-07T12:00:00Z')).toBe('2026-03-09T06:30:00.000Z');
    // 01:30 happens twice on 1 November 2026 and runs at the first.
    expect(at('30 1 * * *', '2026-10-31T12:00:00Z')).toBe('2026-11-01T05:30:00.000Z');
    expect(at('30 1 * * *', '2026-11-01T05:30:00Z')).toBe('2026-11-02T06:30:00.000Z');
  });

  it('coalesces concurrent runs and keeps the previous busy session when a new-session automation is edited', async () => {
    const { projectDir, orchestration, store, dispatch } = await boot();
    await dispatch.close();
    const project = store.createProject(projectDir, 'scheduled');
    const automation = orchestration.saveAutomation(undefined, { name: 'check', prompt: 'inspect', projectId: project.id });
    const [first, second] = await Promise.all([orchestration.fire(automation.id), orchestration.fire(automation.id)]);
    expect(first.result).toBe('started');
    expect(second.sessionId).toBe(first.sessionId);
    expect(store.listSessions()).toHaveLength(1);
    expect(orchestration.saveAutomation(automation.id, { name: 'renamed' }).lastSessionId).toBe(first.sessionId);
    expect((await orchestration.fire(automation.id)).result).toBe('skipped');
    expect(store.listSessions()).toHaveLength(1);
    expect(orchestration.runs(automation.id).map(run => run.result)).toEqual(['skipped', 'started']);
  });

  it('does not restore a stale lastSessionId when an automation changes project during a launch', async () => {
    const { projectDir, stateDir, store, orchestration, dispatch } = await boot();
    await dispatch.close();
    const first = store.createProject(projectDir, 'first');
    const second = store.createProject(stateDir, 'second');
    const automation = orchestration.saveAutomation(undefined, { name: 'check', prompt: 'inspect', projectId: first.id, delivery: 'same' });
    const internals = orchestration as unknown as { launchAutomation: (...args: unknown[]) => Promise<unknown> };
    const launch = internals.launchAutomation.bind(orchestration);
    let release!: () => void;
    let launched!: () => void;
    const ready = new Promise<void>(resolve => { launched = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(internals, 'launchAutomation').mockImplementationOnce(async (...args) => {
      const result = await launch(...args);
      launched();
      await gate;
      return result;
    });
    const firing = orchestration.fire(automation.id);
    await ready;
    orchestration.saveAutomation(automation.id, { projectId: second.id });
    release();
    await firing;
    expect(orchestration.automation(automation.id).lastSessionId).toBeUndefined();
    const next = await orchestration.fire(automation.id);
    expect(store.getSession(next.sessionId!).projectId).toBe(second.id);
  });

  // A timer that fires twice for one slot, or catches up on a slot missed while the server slept,
  // starts unattended agent runs nobody asked for.
  it('runs a due slot once, records a long-overdue one as missed under skip and catches up once under latest', async () => {
    const { projectDir, orchestration, call } = await boot();
    const project = (await call('POST', '/api/projects', { cwd: projectDir })).json() as { id: string };
    const trigger = { kind: 'cron', cron: '0 9 * * *', timeZone: 'Asia/Shanghai' };
    const create = async (catchUp: string) => (await call('POST', '/api/automations', { name: catchUp, prompt: 'check {{project}} on {{date}}', projectId: project.id, triggers: [trigger], catchUp })).json() as { id: string; nextRunAt: string };
    const started = async (id: string) => (await call('GET', '/api/sessions')).json().filter((item: { origin?: { automationId?: string } }) => item.origin?.automationId === id);

    const skipping = await create('skip');
    const due = new Date(Date.parse(skipping.nextRunAt) + 60_000);
    await orchestration.tick(due);
    await orchestration.tick(due);
    expect(await started(skipping.id)).toHaveLength(1);
    const fired = orchestration.automation(skipping.id);
    expect(fired.lastResult).toBe('started');
    expect(Date.parse(fired.nextRunAt!)).toBeGreaterThan(due.getTime());
    await orchestration.tick(new Date(Date.parse(fired.nextRunAt!) + 2 * 60 * 60_000));
    expect(orchestration.automation(skipping.id)).toMatchObject({ lastResult: 'missed' });
    expect(orchestration.runs(skipping.id)[0]).toMatchObject({ result: 'missed', reason: 'offline' });
    expect(await started(skipping.id)).toHaveLength(1);

    // Ten daily slots passed while the server was off; the latest (yesterday's) runs once.
    const catching = await create('latest');
    const back = new Date(Date.parse(catching.nextRunAt) + 10 * 24 * 60 * 60_000 + 60_000);
    await orchestration.tick(back);
    expect(await started(catching.id)).toHaveLength(1);
    const [caught] = orchestration.runs(catching.id);
    expect(caught).toMatchObject({ cause: 'catch-up', result: 'started' });
    expect(back.getTime() - Date.parse(caught!.scheduledFor!)).toBeLessThan(24 * 60 * 60_000);
  });

  it('sends a user follow-up once and never lets the request set who made it', async () => {
    const { projectDir, store, dispatch, orchestration, call } = await boot();
    await dispatch.close();
    const project = store.createProject(projectDir, 'later');
    const session = store.createSession({ projectId: project.id, kind: 'native' });
    const at = new Date(Date.now() + 60_000).toISOString();
    expect((await call('POST', '/api/automations', { prompt: 'ping', followUp: { sessionId: session.id, by: 'agent' }, triggers: [{ kind: 'once', at }] })).statusCode).toBe(400);
    const attachment = (await call('POST', `/api/projects/${project.id}/attachments`, { name: 'note.txt', mimeType: 'text/plain', dataBase64: Buffer.from('later').toString('base64') })).json() as { id: string };
    const created = (await call('POST', '/api/automations', { id: 'follow-up-client-id', prompt: 'ping', attachments: [{ id: attachment.id }], followUp: { sessionId: session.id }, triggers: [{ kind: 'once', at }] })).json() as { id: string; followUp: { by: string } };
    // A retry with the same id and content is the same follow-up; other content under the id is refused.
    expect((await call('POST', '/api/automations', { id: 'follow-up-client-id', prompt: 'ping', attachments: [{ id: attachment.id }], followUp: { sessionId: session.id }, triggers: [{ kind: 'once', at }] })).json()).toMatchObject({ id: created.id });
    expect((await call('POST', '/api/automations', { id: 'follow-up-client-id', prompt: 'other', followUp: { sessionId: session.id }, triggers: [{ kind: 'once', at }] })).statusCode).toBe(409);
    expect(created.followUp.by).toBe('user');
    // Waiting for its time, the follow-up still holds the attachment.
    expect(store.referencedAttachmentIds(new Date(Date.now() + 3_600_000).toISOString())).toContain(attachment.id);
    const due = new Date(Date.parse(at) + 1_000);
    await Promise.all([orchestration.tick(due), orchestration.tick(due)]);
    await orchestration.tick(new Date(due.getTime() + 60_000));
    const runs = store.listRuns(session.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ commandId: `follow-up-${created.id}`, prompt: 'ping', native: { input: { attachmentIds: [attachment.id] } } });
    expect(orchestration.automation(created.id)).toMatchObject({ enabled: false, lastResult: 'started' });
    expect((await call('DELETE', `/api/automations/${created.id}`)).statusCode).toBe(409);
    // A finished one-time task stays finished when a client re-encodes its time.
    const once = orchestration.saveAutomation(undefined, { name: 'once', prompt: 'x', projectId: project.id, triggers: [{ kind: 'once', at, timeZone: 'UTC' }] });
    await orchestration.tick(due);
    expect(orchestration.saveAutomation(once.id, { triggers: [{ kind: 'once', at: new Date(Date.now() - 7_200_000).toISOString(), timeZone: 'Asia/Shanghai' }] }).nextRunAt).toBeUndefined();
  });
});

describe('Riffet MCP tools', () => {
  const credentialOf = async (file: string) => (JSON.parse(await readFile(file, 'utf8')) as { credential: string }).credential;

  // Every conversation gets Riffet's own tools; a credential must open nothing but its own conversation.
  it('lists a warm CLI the tools of the conversation the composer then opens, so the conversation can take it', async () => {
    const { app, cookie, csrf, projectDir, store, dispatch, riffetMcp, settings } = await boot({}, undefined, undefined, true);
    await dispatch.close();
    const project = store.createProject(projectDir, 'warm tools');
    const create = (id: string) => app.inject({ method: 'POST', url: '/api/sessions', headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf },
      payload: { kind: 'native', projectId: project.id, clientSessionId: id, initialMessage: { commandId: `${id}-first`, text: 'hello' } } });
    const warm = () => { const provisional = riffetMcp.provisional(project.id)!; provisional.revoke(); return provisional.signature; };
    expect((await create('plain')).statusCode).toBe(202);
    expect(riffetMcp.signature('plain')).toBe(warm());
    // With every composer conversation opening a task, the task tools are on both sides.
    settings.setSettings({ workItems: { composerSessions: true } });
    expect((await create('tasked')).statusCode).toBe(202);
    expect(store.getSession('tasked').workItemId).toBeDefined();
    expect(riffetMcp.signature('tasked')).toBe(warm());
    expect(warm()).not.toBe(riffetMcp.signature('plain'));
  });

  it('gives every conversation the base tools and scopes each credential to its own conversation', async () => {
    const { app, cookie, csrf, projectDir, store, dispatch, riffetMcp, call } = await boot({ defaultBackendId: 'cursor' }, undefined, undefined, true);
    await dispatch.close();
    const project = store.createProject(projectDir, 'tools');
    const create = (id: string, toolGroups?: string[]) => app.inject({ method: 'POST', url: '/api/sessions', headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf },
      payload: { kind: 'native', projectId: project.id, clientSessionId: id, initialMessage: { commandId: `${id}-first`, text: 'hello' }, ...(toolGroups ? { toolGroups } : {}) } });
    expect((await create('plain')).statusCode).toBe(202);
    expect((await create('other')).statusCode).toBe(202);
    // The retired `riffet.core` and a device revoked since the pick was remembered are dropped, not refused.
    expect((await create('legacy', ['riffet.core', 'device:missing'])).statusCode).toBe(202);
    expect(store.getSession('legacy').toolGroups).toBeUndefined();
    expect((await app.inject({ method: 'POST', url: '/api/sessions', headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf },
      payload: { kind: 'native', projectId: project.id, clientSessionId: 'off', initialMessage: { commandId: 'off-first', text: 'hello' }, extensionsOff: ['skill:review'] } })).statusCode).toBe(202);
    // This backend cannot switch anything off, so nothing is stored for it.
    expect(store.getSession('off').extensionsOff).toBeUndefined();
    expect((await call('PATCH', '/api/sessions/plain', { toolGroups: ['device:missing'] })).json().error.code).toBe('UNKNOWN_DEVICE');
    // Switched-off extensions are a snapshot like the tool groups; Riffet's own server cannot be switched off,
    // and a backend keeps only the kinds it can apply (Claude both, Codex only MCP).
    const claude = store.createSession({ projectId: project.id, kind: 'native', backendId: 'claude', terminalId: 'live-terminal' }).id;
    expect((await call('PATCH', `/api/sessions/${claude}`, { extensionsOff: ['mcp:docs', 'skill:review', 'mcp:riffet', 'mcp:docs'] })).statusCode).toBe(200);
    expect(store.getSession(claude).extensionsOff).toEqual(['mcp:docs', 'skill:review']);
    // A live CLI is relaunched for the change once it is idle, like for a model switch.
    expect(store.getSession(claude).configPending).toBe(true);
    expect((await call('PATCH', `/api/sessions/${claude}`, { extensionsOff: ['docs'] })).json().error.code).toBe('INVALID_EXTENSIONS_OFF');
    expect((await call('PATCH', `/api/sessions/${claude}`, { extensionsOff: [] })).statusCode).toBe(200);
    expect(store.getSession(claude).extensionsOff).toBeUndefined();
    expect((await call('PATCH', '/api/sessions/plain', { extensionsOff: ['mcp:docs'] })).statusCode).toBe(200);
    expect(store.getSession('plain').extensionsOff).toBeUndefined();
    const spec = riffetMcp.server('plain')!;
    const file = spec.args[spec.args.indexOf('--credential') + 1]!;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const token = await credentialOf(file);
    const rpc = (bearer: string, method: string, params?: unknown) => app.inject({ method: 'POST', url: '/api/riffet-mcp', headers: { host: '127.0.0.1:4317', authorization: `Bearer ${bearer}` }, payload: { method, params } });
    // A conversation opened from the composer belongs to no task, so it has no task tools. The Agent-call tools are
    // listed for every conversation but a called one; whether a call is allowed is checked when it is made.
    expect(((await rpc(token, 'tools/list')).json() as { result: { tools: Array<{ name: string }> } }).result.tools.map(tool => tool.name)).toEqual(['read_context', 'schedule_wakeup', 'cancel_wakeup', 'list_wakeups', 'schedule_task', 'notify_user', 'list_devices', 'agent_list', 'agent_call', 'agent_wait', 'agent_stop']);
    // No device was given, so none is listed.
    expect(((await rpc(token, 'tools/call', { name: 'list_devices', arguments: {} })).json() as { result: { structuredContent: { devices: unknown[] } } }).result.structuredContent.devices).toEqual([]);
    // The credential is not a device token, and a forged one is refused.
    expect((await app.inject({ method: 'GET', url: '/api/sessions', headers: { host: '127.0.0.1:4317', authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    // The last character of a random credential is `A` one time in sixteen: always forge a different one.
    expect((await rpc(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, 'tools/list')).statusCode).toBe(401);

    // Another conversation's credential cannot touch this one's wake-up.
    const scheduled = (await rpc(token, 'tools/call', { name: 'schedule_wakeup', arguments: { inMinutes: 5, note: 'check the build' } })).json() as { result: { structuredContent: { scheduled: { id: string } } } };
    const wakeupId = scheduled.result.structuredContent.scheduled.id;
    const other = await credentialOf(riffetMcp.server('other')!.args.at(-1)!);
    const foreign = (await rpc(other, 'tools/call', { name: 'cancel_wakeup', arguments: { id: wakeupId } })).json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(foreign.result.isError).toBe(true);
    expect(foreign.result.content[0]!.text).toContain('WAKEUP_NOT_FOUND');
    expect(((await rpc(other, 'tools/call', { name: 'list_wakeups', arguments: {} })).json() as { result: { structuredContent: { wakeups: unknown[] } } }).result.structuredContent.wakeups).toEqual([]);

    // Archiving revokes the credential and removes its file.
    expect((await call('PATCH', '/api/sessions/plain', { archived: true })).statusCode).toBe(200);
    expect((await rpc(token, 'tools/list')).statusCode).toBe(401);
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  // A wake-up is an unattended turn: a timer that fires twice, or into a conversation that moved on, acts on nobody's request.
  it('fires a wake-up into its own conversation exactly once and fails one whose conversation was archived', async () => {
    const { projectDir, store, dispatch, orchestration } = await boot();
    await dispatch.close();
    const project = store.createProject(projectDir, 'wake');
    const live = store.createSession({ projectId: project.id, kind: 'native', toolGroups: ['riffet.core'] });
    const archived = store.createSession({ projectId: project.id, kind: 'native', toolGroups: ['riffet.core'] });
    const dueAt = new Date(Date.now() + 60_000);
    const wakeup = orchestration.scheduleWakeup(live.id, { dueAt, note: 'look again' });
    const lost = orchestration.scheduleWakeup(archived.id, { dueAt, note: 'never' });
    store.updateSession(archived.id, { archivedAt: new Date().toISOString(), state: 'archived' });
    await orchestration.tick(new Date(dueAt.getTime() - 1_000));
    expect(store.listRuns(live.id)).toHaveLength(0);
    const at = new Date(dueAt.getTime() + 1_000);
    await Promise.all([orchestration.tick(at), orchestration.tick(at)]);
    await orchestration.tick(new Date(dueAt.getTime() + 5_000));
    const runs = store.listRuns(live.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.commandId).toBe(`wakeup-${wakeup.id}`);
    expect(runs[0]!.prompt).toContain('look again');
    expect(orchestration.wakeups(live.id)).toEqual([expect.objectContaining({ id: wakeup.id, status: 'fired', runId: runs[0]!.id })]);
    expect(orchestration.wakeups(archived.id)).toEqual([expect.objectContaining({ id: lost.id, status: 'failed' })]);
    expect(store.listRuns(archived.id)).toHaveLength(0);
    // Persisted: a restarted scheduler reads the settled record and starts nothing.
    expect(orchestration.runs(wakeup.id)).toEqual([expect.objectContaining({ result: 'started', runId: runs[0]!.id })]);
  });
});

describe('API authentication boundary', () => {
  it('authorizes native preview subresources without granting other APIs or drafts', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'riffet-preview-auth-'));
    const { app, auth } = await createApp({ stateDir, token: 'x'.repeat(32), cliPath: '/nonexistent/cursor-agent' });
    cleanups.push(async () => { await app.close(); await rm(stateDir, { recursive: true, force: true }); });
    const draftId = 'a'.repeat(32);
    const otherId = 'b'.repeat(32);
    for (const id of [draftId, otherId]) {
      const root = join(stateDir, 'shares', 'drafts', id);
      await mkdir(join(root, 'public', 'data'), { recursive: true });
      await writeFile(join(root, 'draft.json'), JSON.stringify({ id, sessionId: 'session', capturedAt: new Date().toISOString() }));
      await writeFile(join(root, 'public', 'index.html'), '<html><head></head><body></body></html>');
      await writeFile(join(root, 'public', 'data', 'session.json'), '{"format":"riffet-share-v1"}');
    }
    const { device, token } = auth.issueDevice('Mac');
    const host = { host: '127.0.0.1:4317' };
    const url = `/api/shares/drafts/${draftId}/files/`;
    const initial = await app.inject({ url: url + 'index.html', headers: { ...host, authorization: `Bearer ${token}`, 'x-riffet-share-preview': '1' } });
    expect(initial.statusCode).toBe(200);
    expect(initial.body).toContain('name="riffet-share-preview"');
    const cookie = String(initial.headers['set-cookie']).split(';')[0]!;
    expect(cookie).toMatch(/^wkn_share_preview=/);
    expect(initial.headers['set-cookie']).toContain('Max-Age=600');
    const plainBearer = await app.inject({ url: url + 'index.html', headers: { ...host, authorization: `Bearer ${token}` } });
    expect(plainBearer.headers['set-cookie']).toBeUndefined();
    for (const method of ['GET', 'HEAD'] as const) {
      const asset = await app.inject({ method, url: url + 'data/session.json', headers: { ...host, cookie } });
      expect(asset.statusCode).toBe(200);
    }
    for (const denied of ['/api/settings', `/api/shares/drafts/${otherId}/files/index.html`, url + '../draft.json', url + '%2e%2e/draft.json', url + 'data%2f..%2f..%2fdraft.json']) {
      expect((await app.inject({ url: denied, headers: { ...host, cookie } })).statusCode).toBeGreaterThanOrEqual(400);
    }
    expect((await app.inject({ method: 'POST', url: '/api/sessions/session/share', headers: { ...host, cookie }, payload: { draftId } })).statusCode).toBe(401);
    auth.revokeDevice(device.id);
    expect((await app.inject({ url: url + 'data/session.json', headers: { ...host, cookie } })).statusCode).toBe(401);
  });

  async function bootGuarded() {
    const stateDir = await mkdtemp(join(tmpdir(), 'riffet-guard-'));
    const { app } = await createApp({ stateDir, token: 'x'.repeat(32), cliPath: '/nonexistent/cursor-agent' });
    cleanups.push(async () => { await app.close(); await rm(stateDir, { recursive: true, force: true }); });
    return app;
  }
  const host = { host: '127.0.0.1' };

  it('guards percent-encoded spellings of API routes', async () => {
    const app = await bootGuarded();
    for (const url of ['/api/settings', '/%61pi/settings', '/%61%70%69/settings', '/api/%73ettings', '/api/projects/x/file?path=/etc/hosts']) {
      const response = await app.inject({ method: 'GET', url, headers: host });
      expect(response.statusCode, url).toBe(401);
    }
    const write = await app.inject({ method: 'POST', url: '/%61pi/projects', headers: host, payload: { cwd: tmpdir() } });
    expect(write.statusCode).toBe(401);
    // Public routes stay public whichever way they are spelled.
    expect((await app.inject({ method: 'GET', url: '/%61pi/auth/status', headers: host })).statusCode).toBe(200);
  });

  it('classifies every registered API route by the capability it requires', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'riffet-access-'));
    const { app, registeredRoutes } = await createApp({ stateDir, token: 'x'.repeat(32), cliPath: '/nonexistent/cursor-agent' });
    cleanups.push(async () => { await app.close(); await rm(stateDir, { recursive: true, force: true }); });
    await app.ready();
    const { classifyRoute } = await import('./access/capabilities.js');
    const missing = registeredRoutes.filter(route => route.url.startsWith('/api/') && !['HEAD', 'OPTIONS'].includes(route.method) && !classifyRoute(route.method, route.url));
    expect([...new Set(missing.map(route => `${route.method} ${route.url}`))]).toEqual([]);
  });

  it('lets a browser on an unencrypted LAN connection only read, whatever headers it sends', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'riffet-access-'));
    const token = 'z'.repeat(32);
    const { app, auth, settings } = await createApp({ stateDir, host: '0.0.0.0', token, cliPath: '/nonexistent/cursor-agent', trustedNetworks: ['10.8.0.0/24'] });
    cleanups.push(async () => { await app.close(); await rm(stateDir, { recursive: true, force: true }); });
    const as = async (remoteAddress: string, extra: Record<string, string> = {}) => {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress, headers: { host: '127.0.0.1', ...extra }, payload: { token } });
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      const csrf = (login.json() as { csrfToken: string }).csrfToken;
      return (method: string, url: string, payload?: unknown) => app.inject({ method: method as 'GET', url, remoteAddress, headers: { host: '127.0.0.1', cookie, 'x-csrf-token': csrf, ...extra }, ...(payload === undefined ? {} : { payload: payload as object }) });
    };
    const lan = await as('192.0.2.10');
    // A sign-in that crossed the network in the clear lasts a day; one over HTTPS is `__Host-` prefixed and lasts the usual 30.
    const lanLogin = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '192.0.2.10', headers: { host: '127.0.0.1' }, payload: { token } });
    expect(String(lanLogin.headers['set-cookie'])).toMatch(/^cw_session=.*Max-Age=86400$/);
    const httpsHeaders = { host: '127.0.0.1', origin: 'https://127.0.0.1', 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.10' };
    const httpsLogin = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.1', headers: httpsHeaders, payload: { token } });
    const hostCookie = [httpsLogin.headers['set-cookie']].flat().map(String).find(value => value.startsWith('__Host-cw_session='))!;
    expect(hostCookie).toMatch(/; Secure;.*Max-Age=2592000$/);
    expect((await app.inject({ method: 'GET', url: '/api/sessions', remoteAddress: '127.0.0.1', headers: { ...httpsHeaders, cookie: hostCookie.split(';')[0]! } })).statusCode).toBe(200);
    expect((await lan('GET', '/api/sessions')).statusCode).toBe(200);
    expect((await lan('GET', '/api/bootstrap')).json().access).toEqual({ secure: false, capabilities: ['read'] });
    for (const [method, url, payload] of [['POST', '/api/projects', { cwd: tmpdir() }], ['POST', '/api/pairing/code', {}], ['POST', '/api/terminals', {}], ['POST', '/api/remote/exec', { command: 'true' }], ['PATCH', '/api/settings', { allowInsecureChat: true }], ['POST', '/api/servers/7f1c2f2e-0000-4000-8000-000000000000/remote/exec', { command: 'true' }]] as const) {
      const response = await lan(method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json().error.code).toBe('INSECURE_CONNECTION_READ_ONLY');
    }
    // A client cannot claim the front door's HTTPS; only a loopback peer is believed.
    const spoofed = await as('192.0.2.10', { 'x-forwarded-proto': 'https' });
    expect((await spoofed('POST', '/api/projects', { cwd: tmpdir() })).statusCode).toBe(403);
    // A front door on this machine that served HTTPS, Tailscale, and a network the operator trusts are encrypted.
    const proxied = await as('127.0.0.1', { 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.10' });
    expect((await proxied('POST', '/api/projects', { cwd: tmpdir() })).statusCode).toBe(200);
    const plainProxy = await as('127.0.0.1', { 'x-forwarded-for': '192.0.2.10' });
    expect((await plainProxy('POST', '/api/projects', { cwd: tmpdir() })).statusCode).toBe(403);
    expect((await (await as('100.101.102.103'))('POST', '/api/projects', { cwd: tmpdir() })).statusCode).toBe(200);
    expect((await (await as('10.8.0.9'))('POST', '/api/projects', { cwd: tmpdir() })).statusCode).toBe(200);
    // The owner may let such a browser talk to agents; running things directly stays closed.
    settings.setSettings({ ...settings.getSettings(), allowInsecureChat: true });
    expect((await lan('POST', '/api/projects', { cwd: tmpdir() })).statusCode).toBe(200);
    expect((await lan('POST', '/api/terminals', {})).json().error.code).toBe('INSECURE_CONNECTION_READ_ONLY');
    // A paired app's bearer token is not narrowed by the transport until apps speak TLS (docs/TRANSPORT-SECURITY.md §11).
    const { token: deviceToken } = auth.issueDevice('Phone');
    const device = await app.inject({ method: 'POST', url: '/api/projects', remoteAddress: '192.0.2.10', headers: { host: '127.0.0.1', authorization: `Bearer ${deviceToken}` }, payload: { cwd: tmpdir() } });
    expect(device.statusCode).toBe(200);
    // A link string admits a server, so it never crosses an unencrypted connection, whoever asks.
    const invite = await app.inject({ method: 'POST', url: '/api/links/invites', remoteAddress: '192.0.2.10', headers: { host: '127.0.0.1', authorization: `Bearer ${deviceToken}` }, payload: { inbound: false } });
    expect(invite.json().error.code).toBe('LINK_INSECURE_TRANSPORT');
    // Each refusal is in the security record once per window, however often it was retried, and the record survives a restart.
    const events = (await proxied('GET', '/api/security/events')).json().events as Array<{ id: string; kind: string; subject?: string; actor: { address?: string } }>;
    const denied = events.filter(event => event.kind === 'access-denied' && event.actor.address === '192.0.2.10');
    expect(denied.map(event => event.subject)).toContain('POST /api/terminals');
    expect(new Set(denied.map(event => event.subject)).size).toBe(denied.length);
    const { SecurityAudit } = await import('./access/audit.js');
    expect(new SecurityAudit(stateDir).list().map(event => event.id)).toEqual(events.map(event => event.id));
  });

  it('speaks TLS on its own port and binds a device paired over it to its certificate', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'riffet-tls-'));
    const { app } = await createApp({ stateDir, host: '127.0.0.1', token: 't'.repeat(32), cliPath: '/nonexistent/cursor-agent' });
    cleanups.push(async () => { await app.close(); await rm(stateDir, { recursive: true, force: true }); });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as import('node:net').AddressInfo;
    const { request: httpsRequest } = await import('node:https');
    const { createIdentity, verificationCode } = await import('./links/identity.js');
    const phone = createIdentity('phone', 'p256');
    const call = (path: string, options: { method?: string; body?: unknown; bearer?: string; cert?: boolean }) => new Promise<{ status: number; json: Record<string, any>; server: string }>((resolve, reject) => {
      const request = httpsRequest({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', rejectUnauthorized: false, ...(options.cert ? { key: phone.key, cert: phone.cert } : {}),
        headers: { host: `127.0.0.1:${port}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}) } }, response => {
        const server = (response.socket as import('node:tls').TLSSocket).getPeerCertificate().fingerprint256;
        let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, json: JSON.parse(text || '{}'), server }));
      });
      request.on('error', reject);
      request.end(options.body ? JSON.stringify(options.body) : undefined);
    });
    // The pairing code names the certificate the TLS connection then presents.
    const local = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: '127.0.0.1' }, payload: { token: 't'.repeat(32) } });
    const cookie = String(local.headers['set-cookie']).split(';')[0]!;
    const pairing = (await app.inject({ method: 'POST', url: '/api/pairing/code', headers: { host: '127.0.0.1', cookie, 'x-csrf-token': local.json().csrfToken }, payload: {} })).json() as { payload: string; tlsFingerprint: string };
    const { code, fp } = JSON.parse(pairing.payload) as { code: string; fp: string };
    const paired = await call('/api/devices/pair', { method: 'POST', body: { code, name: 'Phone' }, cert: true });
    expect(paired.status).toBe(200);
    expect(paired.server).toBe(fp);
    const token = paired.json.token as string;
    // Its token works over TLS with its certificate, and nowhere else.
    expect((await call('/api/sessions', { bearer: token, cert: true })).status).toBe(200);
    expect((await call('/api/sessions', { bearer: token })).json.error.code).toBe('DEVICE_CERTIFICATE_REQUIRED');
    const plain = await app.inject({ method: 'GET', url: '/api/sessions', headers: { host: '127.0.0.1', authorization: `Bearer ${token}` } });
    expect(plain.json().error.code).toBe('DEVICE_CERTIFICATE_REQUIRED');
    // Both ends show the same comparison code.
    const listed = (await call('/api/devices', { bearer: token, cert: true })).json.devices as Array<{ id: string; verificationCode?: string }>;
    expect(listed.find(device => device.id === paired.json.device.id)?.verificationCode).toBe(verificationCode('riffet-device-sas', fp, phone.fingerprint));
    // A device paired before TLS learns the fingerprint from an answer keyed by its own record.
    const nonce = 'n'.repeat(16), hex = fp.replace(/:/g, '');
    const proved = await app.inject({ method: 'POST', url: '/api/devices/prove', headers: { host: '127.0.0.1' }, payload: { device: paired.json.device.id, nonce } });
    const { createHmac } = await import('node:crypto');
    const key = createHash('sha256').update(token).digest('base64url');
    expect(proved.json().tls).toEqual({ fingerprint: hex, proof: createHmac('sha256', key).update(`riffet-tls\n${nonce}\n${hex}`).digest('base64url') });
  });

  it('rejects absolute-form request targets before any handler, including WebSocket upgrades', async () => {
    const app = await bootGuarded();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as import('node:net').AddressInfo;
    const raw = async (request: string) => {
      const { connect } = await import('node:net');
      return await new Promise<string>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => socket.write(request));
        let data = '';
        socket.on('data', (chunk) => { data += chunk; if (data.includes('\r\n\r\n')) { socket.destroy(); resolve(data); } });
        socket.on('error', reject);
      });
    };
    const plain = await raw(`GET http://127.0.0.1:${port}/api/settings HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    expect(plain.split('\r\n')[0]).toContain('400');
    const upgrade = await raw(`GET http://127.0.0.1:${port}/api/terminals/x/ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    expect(upgrade.split('\r\n')[0]).not.toContain('101');
    const encodedUpgrade = await raw(`GET /%61pi/terminals/x/ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    expect(encodedUpgrade.split('\r\n')[0]).toContain('401');
  });
});

describe('reading files outside the project', () => {
  it('never serves the workbench state or credential files, even with outside reads enabled', async () => {
    const { call, projectDir, stateDir } = await boot();
    const project = (await call('POST', '/api/projects', { cwd: projectDir })).json() as { id: string };
    const outsideDir = await mkdtemp(join(tmpdir(), 'riffet-outside-'));
    cleanups.push(() => rm(outsideDir, { recursive: true, force: true }));
    const shot = join(outsideDir, 'shot.txt');
    await writeFile(shot, 'agent output\n');
    const read = (path: string) => call('GET', `/api/projects/${project.id}/file?path=${encodeURIComponent(path)}`);

    expect((await read(shot)).statusCode).toBe(200);
    for (const secret of [join(stateDir, 'access-token'), join(stateDir, 'cookie-secret')]) {
      const response = await read(secret);
      expect(response.statusCode, secret).toBe(403);
      expect(response.json().error.code).toBe('PATH_DENIED');
    }
    for (const name of ['.env', 'id_ed25519', 'server.pem']) {
      await writeFile(join(outsideDir, name), 'secret\n');
      expect((await read(join(outsideDir, name))).statusCode, name).toBe(403);
    }
    // A symlink outside the project cannot launder the state directory either.
    await symlink(join(stateDir, 'access-token'), join(outsideDir, 'innocent.txt'));
    expect((await read(join(outsideDir, 'innocent.txt'))).statusCode).toBe(403);

    // A project's own .env stays readable, but a project above the state directory cannot reach it.
    await writeFile(join(projectDir, '.env'), 'LOCAL=1\n');
    expect((await read('.env')).statusCode).toBe(200);
    const parent = (await call('POST', '/api/projects', { cwd: dirname(stateDir) })).json() as { id: string };
    const inside = await call('GET', `/api/projects/${parent.id}/file?path=${encodeURIComponent(`${basename(stateDir)}/access-token`)}`);
    expect(inside.statusCode).toBe(403);
  });

  it('treats a request relayed by a proxy as remote when outside reads are left unset', async () => {
    const { app, call, projectDir } = await boot();
    const project = (await call('POST', '/api/projects', { cwd: projectDir })).json() as { id: string };
    const outsideDir = await mkdtemp(join(tmpdir(), 'riffet-outside-'));
    cleanups.push(() => rm(outsideDir, { recursive: true, force: true }));
    await writeFile(join(outsideDir, 'shot.txt'), 'agent output\n');
    const url = `/api/projects/${project.id}/file?path=${encodeURIComponent(join(outsideDir, 'shot.txt'))}`;
    expect((await call('GET', url)).statusCode).toBe(200);
    const relayed = await app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317', 'x-forwarded-for': '100.64.0.7' } });
    expect(relayed.statusCode).not.toBe(200);
  });

  it('defaults outside reads off when the server listens beyond loopback', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'riffet-lan-'));
    const token = 'y'.repeat(32);
    const { app } = await createApp({ stateDir, host: '0.0.0.0', token, cliPath: '/nonexistent/cursor-agent' });
    cleanups.push(async () => { await app.close(); await rm(stateDir, { recursive: true, force: true }); });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: '127.0.0.1' }, payload: { token } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const settings = await app.inject({ method: 'GET', url: '/api/settings', headers: { host: '127.0.0.1', cookie } });
    expect(settings.json().allowOutsideRead).toBe(false);
  });
});

describe('conversation search', () => {
  it('answers an empty query with nothing, and reports how much is still to index', async () => {
    const { call, projectDir } = await boot({ defaultBackendId: 'cursor' });
    const origin = (await call('POST', '/api/projects', { cwd: projectDir })).json() as { id: string };
    await call('POST', '/api/sessions', { projectId: origin.id, kind: 'native', title: 'Build failing' });

    expect((await call('GET', '/api/search/messages?q=')).json()).toEqual({ query: '', hits: [], pending: 0 });

    const found = await call('GET', '/api/search/messages?q=build');
    expect(found.statusCode).toBe(200);
    expect((found.json() as { query: string }).query).toBe('build');
    // The conversation has never been opened, so it is still missing from the index; the client
    // asks again while this is above zero.
    expect((found.json() as { pending: number }).pending).toBe(1);
  });

  it('hides quick chats before limiting for clients without the feature', async () => {
    const { app, cookie, csrf, call, projectDir, store } = await boot();
    const project = (await call('POST', '/api/projects', { cwd: projectDir })).json() as { id: string };
    const agent = store.createSession({ projectId: project.id, kind: 'native', title: 'Agent', backendId: 'codex' });
    const quick = store.createSession({ projectId: project.id, kind: 'native', title: 'Quick chat', backendId: 'chat' });
    store.createRun(agent.id, 'agent-run', 'needle older prompt');
    store.createRun(quick.id, 'quick-run-1', 'needle newer prompt one');
    store.createRun(quick.id, 'quick-run-2', 'needle newer prompt two');
    store.indexMessages([
      { sessionId: agent.id, messageId: 'agent-answer', kind: 'assistant', text: 'needle older answer', at: '2020-01-01T00:00:00.000Z' },
      { sessionId: quick.id, messageId: 'quick-answer-1', kind: 'assistant', text: 'needle newer answer one', at: '2026-01-01T00:00:00.000Z' },
      { sessionId: quick.id, messageId: 'quick-answer-2', kind: 'assistant', text: 'needle newer answer two', at: '2026-02-01T00:00:00.000Z' },
    ]);
    // Both the indexed and the scan query paths hide quick chats before applying the limit.
    for (const query of ['needle', 'ne']) {
      const found = await call('GET', `/api/search/messages?q=${query}&limit=2`);
      expect(found.json().hits).toHaveLength(2);
      expect(found.json().hits.map((hit: { backendId: string }) => hit.backendId)).toEqual(['codex', 'codex']);
    }
    const declared = await app.inject({
      method: 'GET', url: '/api/search/messages?q=needle&limit=2',
      headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf, 'x-riffet-features': 'quick-chat' },
    });
    expect(declared.json().hits.map((hit: { backendId: string }) => hit.backendId)).toEqual(['chat', 'chat']);
  });
});

describe('conversation search scope', () => {
  it('returns only the requested session and counts only its pending transcript', async () => {
    const { call, projectDir, store } = await boot();
    const project = (await call('POST', '/api/projects', { cwd: projectDir })).json() as { id: string };
    const first = store.createSession({ projectId: project.id, kind: 'native', title: 'First' });
    const second = store.createSession({ projectId: project.id, kind: 'native', title: 'Second' });
    store.createRun(first.id, 'first-search', 'build first');
    store.createRun(second.id, 'second-search', 'build second');
    const found = await call('GET', `/api/search/messages?q=build&limit=1&sessionId=${first.id}`);
    expect(found.statusCode).toBe(200);
    expect(found.json().hits.map((hit: { sessionId: string }) => hit.sessionId)).toEqual([first.id]);
    expect(found.json().pending).toBe(1);
    const missing = await call('GET', '/api/search/messages?q=build&sessionId=missing');
    expect(missing.json()).toEqual({ query: 'build', hits: [], pending: 0 });
  });
});

describe('session list push', () => {
  it('tells an open workbench which lists moved, debounced and carrying independent revisions', async () => {
    const { app, projectDir, call, store, cookie } = await boot(undefined, undefined, undefined, true);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as import('node:net').AddressInfo;
    const { request } = await import('node:http');
    let body = '';
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/lists/stream', headers: { host: '127.0.0.1:4317', cookie } }, resolve);
      req.on('error', reject); req.end();
    });
    cleanups.unshift(async () => { response.destroy(); });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => { body += chunk; });
    const frames = () => [...body.matchAll(/event: changed\ndata: (.*)\n/g)].map(match => JSON.parse(match[1]!) as Record<string, number>);
    const current = () => ({ revision: store.listRevision, terminals: store.terminalsRevision, projects: store.projectRevision, marks: store.marksRevision, workItems: store.workItemsRevision, favorites: store.favoritesRevision });
    const stream = '/api/lists/stream';
    const host = '127.0.0.1:4317';
    await expect(app.injectWS(stream, { headers: { host } })).rejects.toThrow('401');
    await expect(app.injectWS(stream, { headers: { host, cookie, origin: 'https://cross-origin.example' } })).rejects.toThrow('403');
    const socketFrames: unknown[] = [];
    const socket = await app.injectWS(stream, { headers: { host, cookie, origin: `http://${host}` } }, {
      onInit: peer => peer.on('message', frame => socketFrames.push(JSON.parse(frame.toString()))),
    });
    cleanups.unshift(async () => { socket.terminate(); });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(body).toContain(': connected');
    // Where every list stands on connect, so a reconnect reads only what moved meanwhile.
    expect(frames()).toEqual([current()]);
    expect(socketFrames).toEqual([{ event: 'changed', data: current() }]);
    const sessions = store.listRevision;
    const created = await call('POST', '/api/projects', { cwd: projectDir });
    expect(created.statusCode).toBe(200);
    await call('PATCH', `/api/projects/${created.json().id}`, { name: 'Renamed' });
    const deadline = Date.now() + 2_000;
    while (frames().length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(frames()).toHaveLength(2);
    expect(frames()[1]).toEqual(current());
    expect(socketFrames).toEqual(frames().map(data => ({ event: 'changed', data })));
    // Projects move on their own: the session list is not read again for them.
    expect(store.listRevision).toBe(sessions);
  });
});

describe('native startup workspace reservations', () => {
  it('serializes configuration changes while excluding project restores, and fences prewarm in both directions', async () => {
    const { store, projectDir, call, dispatch, nativeBackends } = await boot({ defaultBackendId: 'cursor' });
    const project = store.createProject(projectDir, 'startup fence');
    const session = store.createSession({ projectId: project.id, kind: 'native' });
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      return { promise, resolve };
    };
    const entered = [deferred(), deferred()], gates = [deferred(), deferred()];
    let count = 0;
    const configure = vi.spyOn(nativeBackends, 'configure').mockImplementation(async current => {
      const index = count++;
      entered[index]!.resolve();
      await gates[index]!.promise;
      return current;
    });
    const first = call('POST', `/api/sessions/${session.id}/native/configure`, { model: 'first' }).then(response => response);
    await entered[0]!.promise;
    const second = call('POST', `/api/sessions/${session.id}/native/configure`, { model: 'second' }).then(response => response);
    expect(() => dispatch.reserveWorkspace([project.id])).toThrow(expect.objectContaining({ code: 'PROJECT_BUSY' }));
    gates[0]!.resolve();
    await entered[1]!.promise;
    expect((await first).statusCode).toBe(200);
    expect(() => dispatch.reserveWorkspace([project.id])).toThrow(expect.objectContaining({ code: 'PROJECT_BUSY' }));
    gates[1]!.resolve();
    expect((await second).statusCode).toBe(200);
    expect(configure).toHaveBeenCalledTimes(2);
    const release = dispatch.reserveWorkspace([project.id]);
    try {
      expect((await call('POST', `/api/sessions/${session.id}/native/configure`, { model: 'blocked' })).statusCode).toBe(409);
      expect((await call('POST', `/api/sessions/${session.id}/start`)).statusCode).toBe(409);
      expect((await call('POST', '/api/native/prewarm', { projectId: project.id })).json()).toEqual({ state: 'skipped', reason: 'workspace_busy' });
      expect(configure).toHaveBeenCalledTimes(2);
    } finally { release(); }
    const prewarmEntered = deferred(), prewarmGate = deferred();
    vi.spyOn(nativeBackends.registry.require('cursor') as { prewarm: NonNullable<import('./backends/types.js').NativeBackendDriver['prewarm']> }, 'prewarm').mockImplementation(async () => {
      prewarmEntered.resolve();
      await prewarmGate.promise;
      return { state: 'skipped', reason: 'test' };
    });
    const prewarming = call('POST', '/api/native/prewarm', { projectId: project.id }).then(response => response);
    await prewarmEntered.promise;
    expect(() => dispatch.reserveWorkspace([project.id])).toThrow(expect.objectContaining({ code: 'PROJECT_BUSY' }));
    prewarmGate.resolve();
    expect((await prewarming).statusCode).toBe(200);
    dispatch.reserveWorkspace([project.id])();
  });
});

describe('service monitor', () => {
  it('stops only a process in its own tree, never itself or anything outside', async () => {
    const { call } = await boot();
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    const exited = new Promise(resolve => child.once('exit', (_code, signal) => resolve(signal)));
    cleanups.push(async () => { child.kill('SIGKILL'); });
    const snapshot = (await call('GET', '/api/system/monitor')).json();
    expect(snapshot.processes[0]).toMatchObject({ pid: process.pid, kind: 'server', canTerminate: false });
    expect(snapshot.processes.find((item: { pid: number }) => item.pid === child.pid)).toMatchObject({ kind: 'child', canTerminate: true });
    expect(snapshot.requests.total).toBeGreaterThan(0);
    expect((await call('POST', `/api/system/processes/${process.pid}/terminate`)).statusCode).toBe(403);
    for (const pid of [process.ppid, 1]) expect((await call('POST', `/api/system/processes/${pid}/terminate`)).statusCode).toBe(404);
    expect((await call('POST', '/api/system/processes/-1/terminate')).statusCode).toBe(400);
    expect((await call('POST', `/api/system/processes/${child.pid}/terminate`)).json()).toEqual({ ok: true });
    expect(await exited).toBe('SIGTERM');
    expect((await call('GET', '/api/system/monitor')).json().requests.inFlight).toBe(1);
  });
});

describe('folder favorites', () => {
  it('keeps one host favorite per canonical folder, marks it in browse and stamps it when a project opens there', async () => {
    const { call, projectDir, store } = await boot();
    const root = await realpath(await mkdtemp(join(tmpdir(), 'riffet-favorites-')));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'a')); await mkdir(join(root, 'b')); await symlink(join(root, 'a'), join(root, 'link'));
    const listRevision = store.listRevision, favoritesRevision = store.favoritesRevision;
    const first = await call('POST', '/api/folder-favorites', { path: join(root, 'link'), label: '  Alpha  ' });
    expect(first.statusCode).toBe(200);
    // A favorite moves its own revision on the lists stream, not the session list's.
    expect(store.favoritesRevision).toBeGreaterThan(favoritesRevision);
    expect(store.listRevision).toBe(listRevision);
    expect(first.json()).toMatchObject({ path: join(root, 'a'), label: 'Alpha', sort: 0, exists: true });
    expect(first.json().projectId).toBeUndefined();
    const again = (await call('POST', '/api/folder-favorites', { path: `${root}/a/` })).json();
    expect(again).toEqual(first.json());
    const second = (await call('POST', '/api/folder-favorites', { path: join(root, 'b') })).json();
    expect(second.sort).toBe(1);
    const browse = (await call('POST', '/api/browse', { path: root })).json();
    expect(Object.fromEntries(browse.entries.map((entry: { name: string; favoriteId?: string }) => [entry.name, entry.favoriteId]))).toEqual({ a: first.json().id, b: second.id, link: first.json().id });
    expect((await call('POST', '/api/browse', { path: join(root, 'b') })).json().favoriteId).toBe(second.id);
    expect((await call('PUT', '/api/folder-favorites/order', { ids: [second.id] })).statusCode).toBe(400);
    expect((await call('PUT', '/api/folder-favorites/order', { ids: [second.id, second.id] })).statusCode).toBe(400);
    const ordered = (await call('PUT', '/api/folder-favorites/order', { ids: [second.id, first.json().id] })).json();
    expect(ordered.favorites.map((item: { id: string }) => item.id)).toEqual([second.id, first.json().id]);
    expect((await call('POST', '/api/projects', { cwd: join(root, 'b') })).statusCode).toBe(200);
    const [stamped] = (await call('GET', '/api/folder-favorites')).json().favorites;
    expect(stamped).toMatchObject({ id: second.id, lastUsedAt: expect.any(String) });
    expect((await call('GET', `/api/folder-favorites?projectId=${encodeURIComponent((await call('POST', '/api/projects', { cwd: projectDir })).json().id)}`)).json()).toEqual({ favorites: [] });
  });

  it('keeps project favorites inside the project and drops them with it', async () => {
    const { call, projectDir, stateDir, store } = await boot();
    await mkdir(join(projectDir, 'src', 'lib'), { recursive: true });
    await symlink(stateDir, join(projectDir, 'outside'));
    await symlink(join(projectDir, 'src'), join(projectDir, 'inside'));
    const project = (await call('POST', '/api/projects', { cwd: projectDir })).json() as { id: string };
    for (const path of ['../x', 'src/../../x', '/etc', 'outside', '.', 'index.html']) {
      expect((await call('POST', '/api/folder-favorites', { path, projectId: project.id })).statusCode).toBe(400);
    }
    const created = (await call('POST', '/api/folder-favorites', { path: 'src/lib/', projectId: project.id })).json();
    expect(created).toMatchObject({ path: 'src/lib', projectId: project.id, exists: true });
    const viaLink = (await call('POST', '/api/folder-favorites', { path: 'inside', projectId: project.id })).json();
    expect(viaLink.path).toBe('src');
    expect((await call('GET', '/api/folder-favorites')).json()).toEqual({ favorites: [] });
    expect((await call('GET', `/api/folder-favorites?projectId=${project.id}`)).json().favorites.map((item: { path: string }) => item.path)).toEqual(['src/lib', 'src']);
    expect((await call('DELETE', `/api/projects/${project.id}`)).json()).toEqual({ ok: true });
    expect(store.listFolderFavorites(project.id)).toEqual([]);
    expect((await call('PATCH', `/api/folder-favorites/${created.id}`, { used: true })).statusCode).toBe(404);
    expect((await call('GET', `/api/folder-favorites?projectId=${project.id}`)).statusCode).toBe(404);
  });
});

describe('browser diagnostics', () => {
  it('takes crash reports without credentials within tight limits, and jank batches only with them', async () => {
    const { app, stateDir } = await boot(undefined, '<html></html>', undefined, true);
    const headers = { host: '127.0.0.1:4317', 'content-type': 'application/reports+json' };
    const crash = { type: 'crash', url: 'http://127.0.0.1:4317/a?secret=1', body: { reason: 'unresponsive', stack: 'at loop (/assets/index-abc.js:1:2)\nat x', extra: 'dropped' } };
    const post = (payload: string) => app.inject({ method: 'POST', url: '/api/client-reports', headers, payload });
    const dir = join(stateDir, 'diagnostics', 'browser');
    const shell = await app.inject({ method: 'GET', url: '/deep/link', headers: { host: '127.0.0.1:4317' } });
    expect(shell.headers['document-policy']).toBe('include-js-call-stacks-in-crash-reports');
    expect(String(shell.headers['reporting-endpoints'])).toContain('default="/api/client-reports"');

    expect((await post('{"not":"an array"}')).statusCode).toBe(400);
    expect((await post(JSON.stringify([{ type: 'deprecation', body: {} }]))).statusCode).toBe(204);
    expect((await post(JSON.stringify([{ type: 'crash', body: { stack: 'x'.repeat(70_000) } }]))).statusCode).toBe(413);
    expect((await app.inject({ method: 'POST', url: '/api/client-reports', headers: { host: '127.0.0.1:4317', 'content-type': 'text/plain' }, payload: '[]' })).statusCode).toBe(400);
    await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' });

    expect((await post(JSON.stringify([crash]))).statusCode).toBe(204);
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const saved = JSON.parse(await readFile(join(dir, files[0]!), 'utf8'));
    expect(saved[0]).toMatchObject({ url: 'http://127.0.0.1:4317/a', reason: 'unresponsive' });
    expect(saved[0]).not.toHaveProperty('extra');
    let limited = 0;
    for (let i = 0; i < 8; i += 1) if ((await post(JSON.stringify([crash]))).statusCode === 429) limited += 1;
    expect(limited).toBeGreaterThan(0);

    expect((await app.inject({ method: 'POST', url: '/api/client-jank', headers: { host: '127.0.0.1:4317' }, payload: { entries: [] } })).statusCode).toBe(401);
  });
});
