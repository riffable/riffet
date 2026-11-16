import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session, AuxiliaryModelRef } from '../../../../packages/contracts/src/index.js';
import type { NativeBackendProfileConfig } from '../backends/types.js';
import { Store } from '../store.js';
import { scratchKeyOf } from '../journal/journal.js';
import { listAuxiliaryModels } from '../auxiliary/models.js';
import type { TitleRequest } from './request.js';
import { TitleService } from './service.js';

const stores: Store[] = [];
const services: TitleService[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const service of services.splice(0)) service.close();
  for (const store of stores.splice(0)) store.close();
});

const REF: AuxiliaryModelRef = { backendId: 'dsh', profileId: 'gateway', model: 'dsh:deepseek-official:deepseek-v4.1-flash[effort=max]' };
const PROFILE: NativeBackendProfileConfig = {
  id: 'gateway', backendId: 'dsh', name: 'Gateway',
  config: { apiEndpoint: 'https://gateway.example', apiKey: 'secret', enabledModels: ['dsh:deepseek-official:deepseek-v4.1-flash', 'dsh:deepseek-official:glm-5.3-flash[effort=high]'] },
};

function setup(options: { ref?: AuxiliaryModelRef; title?: string; onTitled?: (session: Session) => void; request?: (request: TitleRequest) => Promise<string> } = {}) {
  const store = new Store(':memory:');
  stores.push(store);
  const project = store.createProject('/tmp/titles', 'titles');
  const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'dsh' });
  const requests: TitleRequest[] = [];
  const service = new TitleService({
    store,
    titleModel: () => 'ref' in options ? options.ref : REF,
    gatewayProfiles: backendId => backendId === 'dsh' ? [PROFILE] : [],
    delayMs: 1_000,
    request: options.request ?? (async request => { requests.push(request); return options.title ?? '优化统计页面样式'; }),
    ...(options.onTitled ? { onTitled: options.onTitled } : {}),
  });
  services.push(service);
  return { store, session, service, requests };
}

function send(store: Store, sessionId: string, text: string) {
  return store.acceptNativeRun(sessionId, `c-${Math.random()}`, { text, attachmentIds: [], context: [] }, { mode: 'agent' });
}

function complete(store: Store, runId: string) {
  store.transitionNativeRun(runId, ['queued'], { delivery: 'observed' }, { state: 'completed' });
}

describe('TitleService', () => {
  it('names a conversation from its first message once the first turn completes', async () => {
    vi.useFakeTimers();
    const titled: Session[] = [];
    const { store, session, requests } = setup({ onTitled: value => titled.push(value) });
    const run = send(store, session.id, '帮我看一下统计页面，现在 web 的样式着实需要优化');
    expect(store.getSession(session.id)).toMatchObject({ titleSource: 'prompt' });
    complete(store, run.id);
    expect(requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests[0]).toMatchObject({ protocol: 'chat', baseUrl: 'https://gateway.example', apiKey: 'secret', model: 'deepseek-v4.1-flash', message: '帮我看一下统计页面，现在 web 的样式着实需要优化' });
    expect(store.getSession(session.id)).toMatchObject({ title: '优化统计页面样式', titleSource: 'generated' });
    expect(titled.map(item => item.title)).toEqual(['优化统计页面样式']);
  });

  it('passes the first answer along when the transcript has been indexed', async () => {
    vi.useFakeTimers();
    const { store, session, requests } = setup();
    const run = send(store, session.id, '看一下这个报错');
    store.indexMessages([{ sessionId: session.id, messageId: 'a1', kind: 'assistant', text: 'TypeError 来自 stats 页面的空数组', at: new Date().toISOString() }]);
    complete(store, run.id);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests[0]?.reply).toBe('TypeError 来自 stats 页面的空数组');
  });

  it('leaves a conversation alone when a CLI title or a rename arrived first', async () => {
    vi.useFakeTimers();
    const { store, session, requests } = setup();
    const run = send(store, session.id, '帮我看一下统计页面');
    complete(store, run.id);
    store.updateSession(session.id, { title: 'Codex 起的名字', titleSource: 'generated' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests).toHaveLength(0);
    expect(store.getSession(session.id).title).toBe('Codex 起的名字');
  });

  it('does not overwrite a rename made while the model was answering', async () => {
    const { store, session, service } = setup();
    send(store, session.id, '帮我看一下统计页面');
    const pending = service.name(session.id, '帮我看一下统计页面');
    store.updateSession(session.id, { title: '我的名字', titleSource: 'user' });
    expect(await pending).toBeUndefined();
    expect(store.getSession(session.id).title).toBe('我的名字');
  });

  it('does not name a conversation archived while the model was answering', async () => {
    const { store, session, service } = setup();
    send(store, session.id, '帮我看一下统计页面');
    const pending = service.name(session.id, '帮我看一下统计页面');
    store.updateSession(session.id, { archivedAt: new Date().toISOString() });
    expect(await pending).toBeUndefined();
    expect(store.getSession(session.id)).toMatchObject({ titleSource: 'prompt' });
  });

  it('runs once per conversation, only for its first completed turn, and only when a model is chosen', async () => {
    vi.useFakeTimers();
    const first = setup();
    const run = send(first.store, first.session.id, '第一条消息');
    complete(first.store, run.id);
    complete(first.store, run.id);
    const second = send(first.store, first.session.id, '第二条消息');
    complete(first.store, second.id);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first.requests).toHaveLength(1);

    const off = setup({ ref: undefined });
    const quiet = send(off.store, off.session.id, '没有标题模型');
    complete(off.store, quiet.id);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(off.requests).toHaveLength(0);
    expect(off.store.getSession(off.session.id).titleSource).toBe('prompt');
  });

  it.each([
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ] as const)('uses the first prompt when the first run is %s and a later run completes', async (firstState, delivery) => {
    vi.useFakeTimers();
    const { store, session, requests } = setup();
    const firstPrompt = `第一条${firstState}消息`;
    const first = send(store, session.id, firstPrompt);
    store.transitionNativeRun(first.id, ['queued'], { delivery }, { state: firstState });
    const second = send(store, session.id, '第二条成功消息');
    complete(store, second.id);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.message).toBe(firstPrompt);
  });

  it('cancels a preview independently and allows another preview without changing the conversation', async () => {
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    const request = vi.fn<(value: TitleRequest) => Promise<string>>()
      .mockImplementationOnce(value => new Promise((_resolve, reject) => {
        value.signal?.addEventListener('abort', () => reject(new Error('preview cancelled')), { once: true });
        started();
      }))
      .mockResolvedValueOnce('新的试用结果');
    const { store, session, service } = setup({ request });
    const before = store.getSession(session.id);
    const controller = new AbortController();
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(service.preview(REF, '尚未开始的试用', alreadyAborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();
    const pending = service.preview(REF, '取消这次试用', controller.signal);
    await requested;
    controller.abort();
    await expect(pending).rejects.toThrow('preview cancelled');
    await expect(service.preview(REF, '重新试用')).resolves.toBe('新的试用结果');
    expect(store.getSession(session.id)).toEqual(before);
  });

  it('aborts a title request on close, does not write it back, and rejects new requests', async () => {
    let request: TitleRequest | undefined;
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    const { store, session, service } = setup({
      request: value => new Promise((_resolve, reject) => {
        request = value;
        value.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
        started();
      }),
    });
    send(store, session.id, '帮我优化统计页面');
    const pending = service.name(session.id, '帮我优化统计页面');
    await requested;

    service.close();

    expect(request?.signal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow('request aborted');
    expect(store.getSession(session.id)).toMatchObject({ titleSource: 'prompt' });
    await expect(service.preview(REF, '尝试模型')).rejects.toThrow('title service is closed');
  });

  it('does not read the Store after an in-flight title request settles after close', async () => {
    let resolveRequest!: (title: string) => void;
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    const { store, session, service } = setup({
      request: () => new Promise(resolve => {
        resolveRequest = resolve;
        started();
      }),
    });
    send(store, session.id, '帮我优化统计页面');
    const pending = service.name(session.id, '帮我优化统计页面');
    await requested;

    service.close();
    stores.splice(stores.indexOf(store), 1);
    store.close();
    resolveRequest('优化统计页面');

    await expect(pending).resolves.toBeUndefined();
  });

  it('lists each gateway profile\'s models by the id the gateway serves', async () => {
    expect(await listAuxiliaryModels(backendId => backendId === 'dsh' ? [PROFILE] : [])).toEqual([
      { backendId: 'dsh', profileId: 'gateway', profileName: 'Gateway', model: 'deepseek-v4.1-flash' },
      { backendId: 'dsh', profileId: 'gateway', profileName: 'Gateway', model: 'glm-5.3-flash' },
    ]);
  });
});

/**
 * `onRunChanged` only fires for a turn completing right now, and the store's listeners are an
 * in-memory set with no replay — so every conversation whose first turn finished before the title
 * model was configured, or before the server last restarted, kept its first-message stand-in
 * forever. One pass at startup is what makes choosing a model apply to the list the reader is
 * already looking at.
 */
describe('the startup backfill', () => {
  function world(options: { ref?: AuxiliaryModelRef; backfillDelayMs?: number } = {}) {
    const store = new Store(':memory:');
    stores.push(store);
    const project = store.createProject('/tmp/backfill', 'backfill');
    const requests: TitleRequest[] = [];
    /** A conversation whose first turn finished long before the service existed. */
    const past = (text: string, patch?: Partial<Session>) => {
      const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'dsh' });
      const run = send(store, session.id, text);
      complete(store, run.id);
      return patch ? store.updateSession(session.id, patch) : store.getSession(session.id);
    };
    const build = () => {
      const service = new TitleService({
        store,
        titleModel: () => 'ref' in options ? options.ref : REF,
        gatewayProfiles: backendId => backendId === 'dsh' ? [PROFILE] : [],
        delayMs: 0,
        ...(options.backfillDelayMs === undefined ? {} : { backfillDelayMs: options.backfillDelayMs }),
        request: async request => { requests.push(request); return `名字:${request.message}`; },
      });
      services.push(service);
      return service;
    };
    return { store, requests, past, build };
  }

  it('names the conversations that finished their first turn before the service existed', async () => {
    const { store, requests, past, build } = world();
    const earlier = past('帮我优化统计页面', { lastActivityAt: '2026-01-01T00:00:00.000Z' });
    const later = past('看一下这个报错', { lastActivityAt: '2026-02-02T00:00:00.000Z' });

    expect(await build().backfill()).toBe(2);
    // Newest first: the end of the list is the part anyone reads.
    expect(requests.map(request => request.message)).toEqual(['看一下这个报错', '帮我优化统计页面']);
    expect(store.getSession(later.id)).toMatchObject({ title: '名字:看一下这个报错', titleSource: 'generated' });
    expect(store.getSession(earlier.id)).toMatchObject({ title: '名字:帮我优化统计页面', titleSource: 'generated' });
  });

  it('waits for the original journal before recovering an imported title, ignoring a tail index and a later local run', async () => {
    const { store, requests, past, build } = world();
    const prompt = '话说，riffet 对 cursor 的支持是不是存在比较大的问题，比如这个subagent没能识别出来';
    const session = past('继续排查', { backendId: 'traex', nativeSessionId: 'original-thread', title: prompt.slice(0, 36), titleSource: 'generated' });
    store.indexMessages([{ sessionId: session.id, messageId: 'tail', kind: 'user', text: '继续排查', at: '2026-01-01T00:00:00.000Z' }]);
    store.journal.append(scratchKeyOf(session.id), [{
      kind: 'user_message_chunk', nativeId: 'tail', at: '2026-01-01T00:00:00.000Z',
      payload: { type: 'user_message_chunk', data: { content: { text: '继续排查' } } },
    }]);
    const service = build();

    expect(await service.backfill()).toBe(0);
    expect(requests).toHaveLength(0);
    store.journal.setIdentity(session.id, 'original-thread');
    store.journal.append(session.id, [{
      kind: 'user_message_chunk', nativeId: 'original', at: '2025-12-01T00:00:00.000Z',
      payload: { type: 'user_message_chunk', data: { content: { text: prompt } } },
    }]);

    expect(await service.backfill()).toBe(1);
    expect(requests.map(request => request.message)).toEqual([prompt]);
    expect(store.getSession(session.id)).toMatchObject({ title: `名字:${prompt}`, titleSource: 'generated' });
    expect(await service.backfill()).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it('leaves alone every name it has no business replacing', async () => {
    const { store, requests, past, build } = world();
    const mine = past('第一条', { title: '我自己起的名字', titleSource: 'user' });
    const already = past('第二条', { title: '已经生成过的名字', titleSource: 'generated' });
    const gone = past('第三条', { archivedAt: new Date().toISOString() });
    const waiting = store.createSession({ projectId: store.listProjects()[0]!.id, kind: 'native', backendId: 'dsh' });
    send(store, waiting.id, '还在等第一个回答');

    expect(await build().backfill()).toBe(0);
    expect(requests).toHaveLength(0);
    expect(store.getSession(mine.id).title).toBe('我自己起的名字');
    expect(store.getSession(already.id).title).toBe('已经生成过的名字');
    expect(store.getSession(gone.id).title).toBe('第三条');
    expect(store.getSession(waiting.id).title).toBe('还在等第一个回答');
  });

  it('does nothing at all until a title model is configured', async () => {
    const { requests, past, build } = world({ ref: undefined });
    past('帮我优化统计页面');
    expect(await build().backfill()).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it('runs on its own after startup, and never twice for one conversation', async () => {
    vi.useFakeTimers();
    const { store, requests, past, build } = world({ backfillDelayMs: 20_000 });
    const session = past('帮我优化统计页面');
    const service = build();

    service.start();
    expect(requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(store.getSession(session.id)).toMatchObject({ titleSource: 'generated' });
    expect(requests).toHaveLength(1);

    // A second pass — a manual one, or the one that follows a settings change — adds no requests.
    expect(await service.backfill()).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it('is off when its delay is zero, and stops when the server closes', async () => {
    vi.useFakeTimers();
    const { requests, past, build } = world({ backfillDelayMs: 0 });
    past('帮我优化统计页面');
    const off = build();
    off.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests).toHaveLength(0);

    const { requests: closedRequests, past: pastClosed, build: buildClosed } = world({ backfillDelayMs: 20_000 });
    pastClosed('帮我优化统计页面');
    const closing = buildClosed();
    closing.start();
    closing.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closedRequests).toHaveLength(0);
  });
});
