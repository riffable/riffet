import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Project, Session } from '../../../../../packages/contracts/src/index.js';
import type { NativeControlMessage } from '../types.js';
import type { NativeBackendHost } from '../types.js';
import { DroidRuntime, droidAutonomy, droidModelInfos, droidModelValue, droidSettingsOverlay } from './runtime.js';
import { findDroidTranscript, readDroidSessionSettings } from './history.js';

vi.mock('./history.js', async importOriginal => ({
  ...await importOriginal<typeof import('./history.js')>(),
  findDroidTranscript: vi.fn(async () => undefined),
  readDroidSessionSettings: vi.fn((await importOriginal<typeof import('./history.js')>()).readDroidSessionSettings),
}));

describe('Droid models', () => {
  it('offers reasoning effort only for models that have a real choice', () => {
    const models = droidModelInfos([
      { id: 'claude-opus-4-6', displayName: 'Opus 4.6', supportedReasoningEfforts: ['off', 'low', 'high'], defaultReasoningEffort: 'high' },
      { id: 'glm-4.7', displayName: 'GLM 4.7', supportedReasoningEfforts: ['none'], defaultReasoningEffort: 'none' },
      { id: 'old', deprecated: true },
    ]);
    expect(models.map(model => model.value)).toEqual(['claude-opus-4-6', 'glm-4.7']);
    expect(models[0]?.configOptions?.[0]).toMatchObject({ id: 'effort', currentValue: 'high', options: [{ value: 'off' }, { value: 'low' }, { value: 'high' }] });
    expect(models[1]?.configOptions).toEqual([]);
  });

  it('spells a selection the way the workbench parses it', () => {
    expect(droidModelValue('claude-opus-4-6', 'high')).toBe('claude-opus-4-6[effort=high]');
    expect(droidModelValue('glm-4.7', 'none')).toBe('glm-4.7');
  });

  it('falls back to asking first for an unknown autonomy level', () => {
    expect(droidAutonomy('medium')).toBe('medium');
    expect(droidAutonomy('yolo')).toBe('off');
  });

  it('installs the context budget in the process-only overlay', () => {
    expect(droidSettingsOverlay({ modelId: 'builtin', compactionTokenLimit: 1_000_000 })).toEqual({
      compactionTokenLimitPerModel: { builtin: 1_000_000 },
    });
    expect(droidSettingsOverlay({ modelId: 'builtin' })).toBeUndefined();
  });

  it('offers a native-clamped long-context request only for known built-in non-router models', () => {
    const models = droidModelInfos([
      { id: 'builtin', isCustom: false, supportedReasoningEfforts: ['low', 'high'] },
      { id: 'auto-fast', isCustom: false, kind: 'router' },
      { id: 'custom:tiny', isCustom: true },
      { id: 'unknown-origin' },
    ]);
    expect(models.map(model => model.configOptions.some(option => option.id === 'context'))).toEqual([true, false, false, false]);
    expect(models[0]?.configOptions.find(option => option.id === 'context')).toMatchObject({ category: 'model_config', currentValue: 'default', options: [{ value: 'default' }, { value: 'long' }] });
    expect(droidModelValue('builtin', 'high', 1_000_000)).toBe('builtin[effort=high,context=long]');
  });
});

/** A fake CLI exercises only the external protocol and process overlay, never a real Droid session. */
async function harness(confirmBudget = true, backgroundChild = false, contextReplies?: Array<{ result: Record<string, unknown>; delayMs?: number }>, protocol: { settingsAck?: 'missing' | 'mismatch' | 'timeout'; mismatchedSettings?: Record<string, string>; initialModel?: string; driftModel?: string; routedModel?: string; holdSettingsModel?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'riffet-droid-test-'));
  const executable = join(directory, 'droid');
  const callsFile = join(directory, 'calls.jsonl');
  const childRelease = join(directory, 'finish-child');
  const notificationsFile = join(directory, 'notification.json');
  const releaseSettings = join(directory, 'release-settings');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
const file = args.indexOf('--settings');
const overlayPath = file < 0 ? undefined : args[file + 1];
const overlay = overlayPath ? JSON.parse(fs.readFileSync(overlayPath, 'utf8')) : {};
const log = value => fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({pid:process.pid, ...value})+'\\n');
log({launch:true, overlay, overlayPath});
let settings = {modelId:'builtin', reasoningEffort:'low', autonomyLevel:'off', interactionMode:'auto'};
let childStarted = false;
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const notify = notification => send({type:'notification', method:'droid.session_notification', params:{notification}});
const contextReplies = ${JSON.stringify(contextReplies)};
const protocol = ${JSON.stringify(protocol)};
let contextRequest = 0;
if(contextReplies) fs.watchFile(${JSON.stringify(notificationsFile)},{interval:10},stat=>{
  if(stat.size) notify(JSON.parse(fs.readFileSync(${JSON.stringify(notificationsFile)},'utf8')));
});
readline.createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line); log({method:request.method, params:request.params});
  let result={};
  if(request.method==='droid.list_models') result={models:[{id:'builtin',isCustom:false},{id:'custom:tiny',isCustom:true},{id:'auto',isCustom:false,kind:'router'}]};
  if(request.method==='droid.initialize_session') {settings={...settings,...request.params,...(protocol.initialModel?{modelId:protocol.initialModel}:{})};result={sessionId:'riffet-fake-droid-budget',settings};}
  if(request.method==='droid.load_session') result={sessionId:request.params.sessionId,settings};
  if(request.method==='droid.update_session_settings') {
    if(request.params.modelId===protocol.holdSettingsModel && protocol.holdSettingsModel) {
      fs.watchFile(${JSON.stringify(releaseSettings)},{interval:10},stat=>{
        if(!stat.size) return;
        fs.unwatchFile(${JSON.stringify(releaseSettings)});
        settings={...settings,...request.params};
        log({settingsApplied:settings.modelId});
        notify({type:'settings_updated',requestId:request.id,settings});
        send({type:'response',id:request.id,result:{}});
      });
      return;
    }
    settings={...settings,...request.params,...(protocol.settingsAck==='mismatch'?(protocol.mismatchedSettings??{modelId:'kimi-k3'}):{})};
    log({settingsApplied:settings.modelId});
    if(protocol.settingsAck==='timeout') return;
    if(protocol.settingsAck!=='missing') notify({type:'settings_updated',requestId:request.id,settings});
  }
  if(request.method==='droid.get_context_breakdown') {
    const index = contextRequest++;
    const fixture = contextReplies?.[index];
    if(fixture) {
      setTimeout(()=>{send({type:'response',id:request.id,result:fixture.result});log({contextResponse:index});},fixture.delayMs??0);
      return;
    }
    result=${confirmBudget ? "{contextBudget:Math.min(overlay.compactionTokenLimitPerModel?.[settings.modelId]??175000,settings.reasoningEffort==='high'?800000:872000),usedTokens:25000,lastCallCompactionTokens:25,categories:[]}" : '{}'};
  }
  send({type:'response',id:request.id,result});
  if(request.method==='droid.add_user_message') {
    notify({type:'create_message',requestId:request.id,message:{id:request.id,role:'user',seq:1,createdAt:Date.now(),content:[{type:'text',text:request.params.text}]}});
    if(protocol.driftModel) {
      settings.modelId=protocol.driftModel;
      notify({type:'droid_working_state_changed',newState:'compacting_conversation'});
      notify({type:'settings_updated',settings});
      notify({type:'create_message',message:{id:'budget-notice',role:'user',visibility:'user_only',seq:2,createdAt:Date.now(),content:[{type:'text',text:'Your standard model budget is exhausted. You have been switched to kimi-k3 (Droid Core) to continue this session as per your overage preference. To set your preferences, run the /limits slash command.'}]}});
      // A late completion from the old process must not report the drifted turn as successful.
      notify({type:'agent_turn_completed',turnId:request.id,reason:'completed'});
    }
    if(protocol.routedModel) notify({type:'settings_updated',settings:{...settings,routedModelId:protocol.routedModel,specModeModelId:protocol.routedModel}});
    if(${backgroundChild} && !childStarted) {
      childStarted=true;
      notify({type:'create_message',message:{id:'assistant-bg',role:'assistant',seq:2,createdAt:Date.now(),content:[{type:'tool_use',id:'background-task',name:'Task',input:{description:'Background work',await:false}}]}});
      notify({type:'child_session_available',toolUseId:'background-task',childSessionId:'fake-background-child'});
      fs.watchFile(${JSON.stringify(childRelease)},{interval:10},stat=>{
        if(!stat.size) return;
        fs.unwatchFile(${JSON.stringify(childRelease)});
        log({childEnded:true});
        notify({type:'tool_result',toolUseId:'background-task',messageId:'background-result',content:'done',isError:false});
      });
    }
    setTimeout(()=>{
      settings.reasoningEffort='high';notify({type:'settings_updated',settings});
      log({ended:true});notify({type:'agent_turn_completed',turnId:request.id,reason:'completed'});
    },100);
  }
  if(request.method==='droid.close_session') setImmediate(()=>process.exit(0));
});
`, { mode: 0o700 });
  let session = { id: 's1', projectId: 'p1', title: 'Session', kind: 'native', mode: 'agent', model: 'builtin[effort=low,context=long]', approval: 'off', state: 'idle', tags: [], createdAt: '', updatedAt: '' } as Session;
  const project = { id: 'p1', name: 'Project', cwd: directory, createdAt: '', updatedAt: '' } as Project;
  const profile = { id: 'local', backendId: 'droid' as const, name: 'Droid', isDefault: true, config: { executable } };
  let lockTail: Promise<unknown> = Promise.resolve();
  const withSessionLock = <T>(_id: string, operation: () => Promise<T>): Promise<T> => {
    const task = lockTail.then(operation);
    lockTail = task.catch(() => undefined);
    return task;
  };
  const host = {
    withSessionLock,
    getSession: () => session,
    updateSession: (_id: string, patch: Partial<Session>) => (session = { ...session, ...patch }),
    bumpConfig: (_id: string, patch: Partial<Session>) => (session = { ...session, ...patch }),
    setNativeSessionId: (_id: string, nativeSessionId: string) => (session = { ...session, nativeSessionId }),
  } as unknown as NativeBackendHost;
  const runtime = new DroidRuntime(host);
  const dispatches: unknown[] = [];
  const calls = async () => (await readFile(callsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, any>);
  const send = async (cancelBeforeDispatch = false) => {
    let checks = 0;
    let resolved: unknown;
    await withSessionLock(session.id, () => runtime.send({ session, project, profile, commandId: `cmd-${Date.now()}`, runId: 'r1', input: { text: 'fake prompt', attachmentIds: [], context: [] }, config: { model: session.model, mode: 'agent', approval: 'off' }, isCancelled: () => cancelBeforeDispatch && ++checks > 1, commitDispatchFence: value => { resolved = value?.resolvedConfig; dispatches.push(value); } }));
    return resolved;
  };
  const configure = (patch: { model?: string; mode?: string; approval?: string }) => withSessionLock(session.id, async () => {
    await runtime.configure(session, project, profile, patch);
    host.updateSession(session.id, patch);
  });
  return { runtime, profile, project, host, calls, send, configure, dispatches, releaseSettings: () => writeFile(releaseSettings, 'released'), emitNotification: (notification: Record<string, unknown>) => writeFile(notificationsFile, JSON.stringify(notification)), finishChild: () => writeFile(childRelease, 'finished'), get session() { return session; }, async close() { await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}

describe('Droid context budget protocol', () => {
  it('finishes an older deferred setter before a newer configure and same-settings send can dispatch', async () => {
    const h = await harness(true, false, undefined, { holdSettingsModel: 'builtin-b' });
    try {
      h.host.updateSession(h.session.id, { model: 'builtin[effort=low]' });
      await h.send();
      await h.configure({ model: 'builtin-b[effort=high]' });
      await vi.waitFor(async () => expect((await h.calls()).some(call => call.method === 'droid.update_session_settings' && call.params.modelId === 'builtin-b')).toBe(true));
      const configure = h.configure({ model: 'builtin-c[effort=high]' });
      const send = h.send();
      await new Promise(resolve => setTimeout(resolve, 30));
      const waiting = await h.calls();
      expect(waiting.filter(call => call.method === 'droid.add_user_message')).toHaveLength(1);
      expect(waiting.some(call => call.method === 'droid.update_session_settings' && call.params.modelId === 'builtin-c')).toBe(false);
      await h.releaseSettings();
      await configure;
      expect(await send).toMatchObject({ model: 'builtin-c[effort=high]' });
      const calls = await h.calls();
      expect(calls.filter(call => call.settingsApplied).map(call => call.settingsApplied)).toEqual(['builtin-b', 'builtin-c']);
      expect(calls.filter(call => call.method === 'droid.add_user_message')).toHaveLength(2);
      expect(h.session.model).toBe('builtin-c[effort=high]');
      expect(h.runtime.status(h.session).notice).toBeUndefined();
      expect(calls.some(call => call.method === 'droid.close_session')).toBe(false);
    } finally { await h.close(); }
  });

  it('drops an older deferred callback when a newer configure took the session lock first', async () => {
    const h = await harness();
    let release!: () => void;
    try {
      h.host.updateSession(h.session.id, { model: 'builtin[effort=low]' });
      await h.send();
      await h.configure({ model: 'builtin-b[effort=high]' });
      let entered!: () => void;
      const acquired = new Promise<void>(resolve => { entered = resolve; });
      const held = h.host.withSessionLock(h.session.id, async () => {
        entered();
        await new Promise<void>(resolve => { release = resolve; });
      });
      await acquired;
      const configure = h.configure({ model: 'builtin-c[effort=high]' });
      await vi.waitFor(async () => expect((await h.calls()).some(call => call.ended)).toBe(true));
      const send = h.send();
      release();
      await held;
      await configure;
      expect(await send).toMatchObject({ model: 'builtin-c[effort=high]' });
      const calls = await h.calls();
      expect(calls.some(call => call.method === 'droid.update_session_settings' && call.params.modelId === 'builtin-b')).toBe(false);
      expect(calls.filter(call => call.settingsApplied).map(call => call.settingsApplied)).toEqual(['builtin-c']);
      expect(h.session.model).toBe('builtin-c[effort=high]');
      expect(h.runtime.status(h.session).notice).toBeUndefined();
    } finally { release?.(); await h.close(); }
  });

  it.each(['missing', 'mismatch'] as const)('requires the correlated actual settings before dispatch (%s acknowledgement)', async settingsAck => {
    const h = await harness(true, false, undefined, { initialModel: 'kimi-k3', settingsAck });
    try {
      await expect(h.send()).rejects.toMatchObject({ code: 'NATIVE_SETTINGS_UNCONFIRMED' });
      expect(h.dispatches).toEqual([]);
      expect(h.session.model).toBe('builtin[effort=low,context=long]');
      const calls = await h.calls();
      expect(calls.some(call => call.method === 'droid.add_user_message')).toBe(false);
      expect(calls.filter(call => call.method === 'droid.close_session')).toHaveLength(1);
    } finally { await h.close(); }
  });

  it('confirms the requested model after native resume returns an older model', async () => {
    const h = await harness(true, false, undefined, { initialModel: 'kimi-k3' });
    try {
      expect(await h.send()).toMatchObject({ model: 'builtin[effort=low,context=long]' });
      expect(h.dispatches).toHaveLength(1);
      expect((await h.calls()).filter(call => call.method === 'droid.update_session_settings').at(-1)?.params).toMatchObject({ modelId: 'builtin', reasoningEffort: 'low' });
      expect(h.session.model).toBe('builtin[effort=low,context=long]');
    } finally { await h.close(); }
  });

  it('rejects an acknowledged permission different from the requested permission before dispatch', async () => {
    const h = await harness(true, false, undefined, { initialModel: 'kimi-k3', settingsAck: 'mismatch', mismatchedSettings: { autonomyLevel: 'high' } });
    try {
      await expect(h.send()).rejects.toMatchObject({ code: 'NATIVE_SETTINGS_UNCONFIRMED', message: expect.stringContaining('autonomyLevel: expected off, actual high') });
      expect(h.dispatches).toEqual([]);
      expect((await h.calls()).some(call => call.method === 'droid.add_user_message')).toBe(false);
      expect(h.session.approval).toBe('off');
    } finally { await h.close(); }
  });

  it('does not dispatch when the settings request times out, and stops the process once', async () => {
    const h = await harness(true, false, undefined, { initialModel: 'kimi-k3', settingsAck: 'timeout' });
    try {
      await expect(h.send()).rejects.toMatchObject({ code: 'NATIVE_SETTINGS_UNCONFIRMED' });
      expect(h.dispatches).toEqual([]);
      const calls = await h.calls();
      expect(calls.some(call => call.method === 'droid.add_user_message')).toBe(false);
      expect(calls.filter(call => call.method === 'droid.close_session')).toHaveLength(1);
      expect(h.session.model).toBe('builtin[effort=low,context=long]');
    } finally { await h.close(); }
  }, 20_000);

  it('stops unexpected main-model changes once, preserves the requested model, and exposes the budget notice without inventing a user turn', async () => {
    const h = await harness(true, false, undefined, { driftModel: 'kimi-k3' });
    const messages: NativeControlMessage[] = [];
    const unsubscribe = h.runtime.subscribe(h.session, h.project, h.profile, message => messages.push(message));
    try {
      await h.send();
      await vi.waitFor(async () => expect((await h.calls()).filter(call => call.method === 'droid.close_session')).toHaveLength(1));
      await vi.waitFor(() => expect(h.runtime.isRunning(h.session.id)).toBe(false));
      expect(h.session.model).toBe('builtin[effort=low,context=long]');
      expect(h.runtime.status(h.session).notice).toContain('from builtin to kimi-k3');
      expect(h.runtime.status(h.session).notice).toContain('standard model budget is exhausted');
      expect(messages.some(message => message.type === 'status' && message.status.phase === 'attention')).toBe(true);
    } finally { unsubscribe(); await h.close(); }
  });

  it('accepts routed and spec models without changing the selected main model', async () => {
    const h = await harness(true, false, undefined, { routedModel: 'kimi-k3' });
    try {
      h.host.updateSession(h.session.id, { model: 'auto[effort=low]' });
      await h.send();
      await vi.waitFor(async () => expect((await h.calls()).some(call => call.ended)).toBe(true));
      expect(h.session.model).toBe('auto[effort=high]');
      expect(h.runtime.status(h.session).notice).toBeUndefined();
      expect((await h.calls()).filter(call => call.method === 'droid.close_session')).toHaveLength(0);
    } finally { await h.close(); }
  });

  it('keeps deferred picker choices when the old turn reports its settings, then follows later CLI changes', async () => {
    const h = await harness(true, false, []);
    try {
      await h.send();
      const desired = { model: 'builtin[effort=low,context=long]', mode: 'spec', approval: 'high' };
      await h.runtime.configure(h.session, h.project, h.profile, desired);
      h.host.updateSession(h.session.id, desired);
      await vi.waitFor(async () => expect((await h.calls()).some(call => call.ended)).toBe(true));
      await vi.waitFor(async () => expect((await h.calls()).filter(call => call.method === 'droid.update_session_settings').at(-1)?.params).toEqual({ reasoningEffort: 'low', autonomyLevel: 'high', interactionMode: 'spec' }));
      expect(h.session).toMatchObject(desired);
      // The deferred update is now acknowledged. A genuinely newer CLI choice may be followed.
      await h.emitNotification({ type: 'settings_updated', settings: { modelId: 'builtin', reasoningEffort: 'high', autonomyLevel: 'off', interactionMode: 'auto' } });
      await vi.waitFor(() => expect(h.session).toMatchObject({ model: 'builtin[effort=high,context=long]', mode: 'agent', approval: 'off' }));
    } finally { await h.close(); }
  });

  it('does not overwrite choices made while an imported session sidecar is being read', async () => {
    const h = await harness();
    try {
      const path = join(h.project.cwd, 'imported.jsonl');
      await writeFile(path, JSON.stringify({ type: 'session_start', cwd: h.project.cwd }));
      h.host.updateSession(h.session.id, { nativeSessionId: 'imported', model: undefined, approval: undefined });
      vi.mocked(findDroidTranscript).mockResolvedValueOnce(path);
      let finish!: (settings: { model: string; autonomyLevel: string }) => void;
      vi.mocked(readDroidSessionSettings).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const unsubscribe = h.runtime.subscribe(h.session, h.project, h.profile, () => undefined);
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      const desired = { model: 'builtin[effort=high,context=long]', approval: 'high' };
      h.host.updateSession(h.session.id, desired);
      finish({ model: 'custom:tiny', autonomyLevel: 'off' });
      await new Promise(resolve => setTimeout(resolve, 20));
      unsubscribe();
      expect(h.session).toMatchObject(desired);
    } finally { await h.close(); }
  });

  it('scopes overrides to the process, preserves effort and actual budget, and returns to native defaults after a busy turn', async () => {
    const h = await harness();
    try {
      expect(await h.send()).toMatchObject({ model: 'builtin[effort=low,context=long]' });
      expect(h.runtime.context(h.session)?.size).toBe(872000);
      const launched = (await h.calls()).filter(call => call.launch && call.overlayPath);
      expect(launched).toHaveLength(1);
      expect(launched[0]?.overlay).toEqual({ compactionTokenLimitPerModel: { builtin: 1_000_000 } });
      await vi.waitFor(() => expect(h.session.model).toBe('builtin[effort=high,context=long]'));
      await vi.waitFor(() => expect(h.runtime.context(h.session)?.size).toBe(800000));
      await h.runtime.configure(h.session, h.project, h.profile, { model: 'builtin[effort=low,context=long]' });
      h.host.updateSession(h.session.id, { model: 'builtin[effort=low,context=long]' });
      expect((await h.calls()).filter(call => call.method === 'droid.update_session_settings').at(-1)?.params).toEqual({ reasoningEffort: 'low' });
      await vi.waitFor(() => expect(h.runtime.context(h.session)?.size).toBe(872000));

      // The next fake turn stays active long enough to change its setting without killing it.
      await h.send();
      await h.runtime.configure(h.session, h.project, h.profile, { model: 'builtin[effort=high]' });
      h.host.updateSession(h.session.id, { model: 'builtin[effort=high]' });
      const beforeEnd = await h.calls();
      expect(beforeEnd.filter(call => call.method === 'droid.close_session')).toHaveLength(0);
      await vi.waitFor(async () => expect((await h.calls()).some(call => call.method === 'droid.close_session')).toBe(true));
      await h.send(true);
      await vi.waitFor(() => expect(h.runtime.context(h.session)?.size).toBe(175000));
      const calls = await h.calls();
      expect(calls.some(call => call.method === 'droid.load_session')).toBe(true);
      expect(calls.filter(call => call.launch).at(-1)?.overlay).toEqual({});
      expect(calls.filter(call => call.method === 'droid.update_session_settings').every(call => !('compactionTokenLimit' in call.params) && !('compactionTokenLimitPerModel' in call.params))).toBe(true);
      await vi.waitFor(async () => expect(await readFile(launched[0]!.overlayPath, 'utf8').catch(() => undefined)).toBeUndefined());
    } finally { await h.close(); }
  });

  it('rejects manual long-context requests for custom or router models before starting a session', async () => {
    const h = await harness();
    try {
      for (const model of ['custom:tiny[context=long]', 'auto[context=long]', 'builtin[context=guess]']) {
        await expect(h.runtime.configure(h.session, h.project, h.profile, { model })).rejects.toMatchObject({ code: 'INVALID_MODEL' });
      }
      expect((await h.calls()).some(call => call.method === 'droid.initialize_session' || call.method === 'droid.update_session_settings')).toBe(false);
    } finally { await h.close(); }
  });

  it('does not dispatch a prompt when Droid cannot report the actual budget', async () => {
    const h = await harness(false);
    try {
      await expect(h.send()).rejects.toMatchObject({ code: 'NATIVE_CONTEXT_BUDGET_UNCONFIRMED' });
      const calls = await h.calls();
      expect(calls.some(call => call.method === 'droid.add_user_message')).toBe(false);
      expect(calls.some(call => call.method === 'droid.close_session')).toBe(true);
    } finally { await h.close(); }
  });

  it('uses native call measurements, keeps category estimates separate, and rejects stale refreshes or absent measurements', async () => {
    const estimates = { usedTokens: 814277, categories: [{ name: 'Messages', tokens: 799696 }] };
    const h = await harness(true, false, [
      { result: { contextBudget: 250000, ...estimates } },
      { result: { contextBudget: 250000, lastCallCompactionTokens: 149025, ...estimates } },
      { result: { contextBudget: 250000, lastCallCompactionTokens: 300000, ...estimates } },
      { result: { contextBudget: 250000, lastCallCompactionTokens: 700000, ...estimates }, delayMs: 150 },
      { result: { contextBudget: 250000, lastCallCompactionTokens: 120000, ...estimates } },
      { result: { contextBudget: 250000, ...estimates } },
    ]);
    try {
      const messages: NativeControlMessage[] = [];
      h.runtime.subscribe(h.session, h.project, h.profile, message => messages.push(message));
      expect(messages).toEqual([{ type: 'context' }]);
      // A brand-new session can confirm its threshold before it has made any model call.
      await h.send(true);
      expect(h.runtime.context(h.session)).toBeUndefined();
      expect((await h.calls()).some(call => call.method === 'droid.add_user_message')).toBe(false);

      const usage = { inputTokens: 4573, cacheReadTokens: 143298, outputTokens: 1154 };
      await h.emitNotification({ type: 'session_token_usage_changed', lastCallTokenUsage: usage });
      await vi.waitFor(() => expect(h.runtime.context(h.session)).toMatchObject({ used: 149025, size: 250000, limitKind: 'compaction', breakdownEstimated: true, breakdown: [{ tokens: 799696 }] }));
      await h.emitNotification({ type: 'settings_updated', settings: { reasoningEffort: 'high' } });
      await vi.waitFor(() => expect(h.runtime.context(h.session)?.used).toBe(300000));

      await h.emitNotification({ type: 'session_compacted' });
      await vi.waitFor(async () => expect((await h.calls()).filter(call => call.method === 'droid.get_context_breakdown')).toHaveLength(4));
      await h.emitNotification({ type: 'session_token_usage_changed', lastCallTokenUsage: { ...usage, cacheCreationTokens: 15 } });
      await vi.waitFor(() => expect(h.runtime.context(h.session)?.used).toBe(120000));
      await vi.waitFor(async () => expect((await h.calls()).some(call => call.contextResponse === 3)).toBe(true));
      expect(h.runtime.context(h.session)?.used).toBe(120000);

      await h.emitNotification({ type: 'session_compacted' });
      await vi.waitFor(() => expect(h.runtime.context(h.session)).toBeUndefined());
      expect(messages.at(-1)).toEqual({ type: 'context' });
    } finally { await h.close(); }
  });

  it('keeps a background child alive across its parent turn and applies the new budget only after the child finishes', async () => {
    const h = await harness(true, true);
    try {
      await h.send();
      await vi.waitFor(async () => expect((await h.calls()).some(call => call.ended)).toBe(true));
      await h.runtime.configure(h.session, h.project, h.profile, { model: 'builtin[effort=low]' });
      h.host.updateSession(h.session.id, { model: 'builtin[effort=low]' });
      await expect(h.send(true)).rejects.toMatchObject({ code: 'CLI_BUSY' });
      const waiting = await h.calls();
      expect(waiting.some(call => call.method === 'droid.close_session')).toBe(false);
      expect(waiting.filter(call => call.method === 'droid.add_user_message')).toHaveLength(1);

      const finished = new Promise<void>(resolve => {
        h.runtime.subscribe(h.session, h.project, h.profile, message => {
          if (message.type === 'subagent' && message.toolCallId === 'background-task' && message.running === false) resolve();
        });
      });
      await h.finishChild();
      await finished;
      expect((await h.calls()).some(call => call.method === 'droid.close_session')).toBe(false);
      await h.send(true);
      await vi.waitFor(() => expect(h.runtime.context(h.session)?.size).toBe(175000));
      const calls = await h.calls();
      expect(calls.findIndex(call => call.method === 'droid.close_session')).toBeGreaterThan(calls.findIndex(call => call.childEnded));
      expect(calls.filter(call => call.launch).at(-1)?.overlay).toEqual({});

      // The pending low-effort selection was consumed by the resume, so it cannot undo a newer one.
      await h.runtime.configure(h.session, h.project, h.profile, { model: 'builtin[effort=high]' });
      h.host.updateSession(h.session.id, { model: 'builtin[effort=high]' });
      await h.send();
      await vi.waitFor(async () => {
        const resumed = await h.calls();
        expect(resumed.filter(call => call.ended)).toHaveLength(2);
        expect(resumed.slice(resumed.findLastIndex(call => call.ended) + 1).some(call => call.method === 'droid.get_context_breakdown')).toBe(true);
        expect(resumed.filter(call => call.method === 'droid.update_session_settings').at(-1)?.params).toEqual({ reasoningEffort: 'high' });
      });
    } finally { await h.close(); }
  });

  it('counts a fireAndForget Execute as a running background task and compaction as compacting', async () => {
    const h = await harness(true, false, []);
    const messages: NativeControlMessage[] = [];
    h.runtime.subscribe(h.session, h.project, h.profile, message => messages.push(message));
    try {
      await h.send();
      await h.emitNotification({ type: 'create_message', message: { id: 'assistant-ff', role: 'assistant', seq: 2, createdAt: Date.now(), content: [{ type: 'tool_use', id: 'ff-1', name: 'Execute', input: { command: 'npx tsx server.ts', fireAndForget: true } }] } });
      // The notification reaches the runtime through the fake CLI's pipe.
      await new Promise(resolve => setTimeout(resolve, 200));
      await h.emitNotification({ type: 'tool_result', toolUseId: 'ff-1', messageId: 'tool-ff', isError: false, content: 'Background process started (PID: 79218)\nCommand: npx tsx server.ts\nOutput: /tmp/droid-bg-1.out\nStatus: Running in background' });
      await vi.waitFor(() => expect(h.runtime.status(h.session).activity).toEqual({ compacting: false, background: 1 }));

      await h.emitNotification({ type: 'droid_working_state_changed', newState: 'compacting_conversation' });
      await vi.waitFor(() => expect(h.runtime.status(h.session).activity?.compacting).toBe(true));
      await h.emitNotification({ type: 'session_compacted' });
      await vi.waitFor(() => expect(h.runtime.status(h.session).activity).toEqual({ compacting: false, background: 1 }));
    } finally { await h.close(); }
  });
});
