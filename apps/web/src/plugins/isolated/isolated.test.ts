import Fastify from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerPluginViewFrame } from '../../../../server/src/plugins/view-frame';
import { connect, BridgeError } from '../../../../../packages/plugin-web/src/bridge-client';
import { BRIDGE_INIT, BRIDGE_LIMITS, BRIDGE_READY, BRIDGE_VERSION, type BridgeSession } from '@riffet/plugin-web';
import { serveBridge, type BridgeGrant, type BridgePort, type BridgeServices } from './bridgeHost';
import { bootstrapStyle, pluginPolicy } from './document';
import { verifyIntegrity } from './entry';
import { attachFrame } from './frameHost';

class FakePort implements BridgePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  postMessage(message: unknown) { this.sent.push(message as Record<string, unknown>); }
  close() { this.closed = true; }
  receive(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}

const session = (id: string, projectId: string): BridgeSession => ({ id, projectId, title: id, state: 'idle', mode: 'agent', tags: [], createdAt: 'a', updatedAt: 'b' });
const context = { serviceId: 'https://riffet.test', projectId: 'p1', sessionId: 's1', instanceId: 'x', visible: true, locale: 'en' };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function servicesOf(calls: string[], overrides: Partial<BridgeServices> = {}): BridgeServices {
  return {
    context: () => context,
    theme: () => ({ scheme: 'light', vars: { '--bg': '#fff' } }),
    session: (id) => ({ s1: session('s1', 'p1'), other: session('other', 'p2') } as Record<string, BridgeSession>)[id],
    outline: async (id) => { calls.push(`outline:${id}`); return []; },
    timeline: async (id) => { calls.push(`timeline:${id}`); return { generation: 'g', rows: [], hasBefore: false, hasAfter: false }; },
    active: () => true,
    openSession: (id) => { calls.push(`openSession:${id}`); },
    openPath: (path) => { calls.push(`openPath:${path}`); },
    notify: (tone, text) => { calls.push(`notify:${tone}:${text}`); },
    ...overrides,
  };
}

function setup(grant: Partial<{ capabilities: string[]; commands: string[]; queries: string[]; views: string[] }> = {}, overrides: Partial<BridgeServices> = {}, now?: () => number) {
  const port = new FakePort();
  const calls: string[] = [];
  const services = servicesOf(calls, overrides);
  const bridgeGrant: BridgeGrant = { capabilities: new Set(grant.capabilities), commands: new Set(grant.commands), queries: new Set(grant.queries), views: new Set(grant.views) };
  const bridge = serveBridge({ port, grant: bridgeGrant, services, ...(now ? { now } : {}) });
  let next = 100;
  const ask = async (method: string, params?: unknown) => {
    const id = next++;
    port.receive({ id, method, ...(params === undefined ? {} : { params }) });
    await flush();
    return port.sent.find((message) => message.id === id);
  };
  return { port, calls, bridge, ask };
}

const code = (reply: unknown) => (reply as { error?: { code: string } } | undefined)?.error?.code;

let shellScript: string;
let shellPolicies: (string | undefined)[];
beforeAll(async () => {
  const app = Fastify();
  registerPluginViewFrame(app);
  try {
    const pages = await Promise.all(['/plugin-view', '/plugin-view?network=1'].map(url => app.inject(url)));
    expect(pages.map(page => page.statusCode)).toEqual([200, 200]);
    shellScript = pages[0]!.body.match(/<script>([\s\S]+)<\/script>/)![1]!;
    shellPolicies = pages.map(page => page.headers['content-security-policy'] as string | undefined);
  } finally {
    await app.close();
  }
});

describe('bridge host', () => {
  it('takes identity from the channel, not from the request', async () => {
    const { ask, calls, port } = setup();
    expect(await ask('context.get')).toMatchObject({ result: { projectId: 'p1' } });
    // Fields that claim a plugin or a grant are not read.
    port.receive({ id: 7, method: 'sessions.get', params: { sessionId: 's1' }, pluginId: 'acme.other', capabilities: ['sessions.read'] });
    await flush();
    expect(code(port.sent.find((message) => message.id === 7))).toBe('denied');
    expect(calls).toEqual([]);
  });

  it('refuses a method the package holds no capability for before it reads the params', async () => {
    const { ask, calls } = setup();
    for (const method of ['sessions.get', 'sessions.outline', 'sessions.timeline']) expect(code(await ask(method, { nonsense: true }))).toBe('denied');
    expect(calls).toEqual([]);
    const granted = setup({ capabilities: ['sessions.read'] });
    expect(await granted.ask('sessions.outline', { sessionId: 's1' })).toMatchObject({ result: { turns: [] } });
  });

  it('negotiates UI capabilities, pages only the mounted project and cancels individual reads', async () => {
    let aborted = false;
    const scoped = setup({ capabilities: ['projects.read', 'sessions.read'] }, {
      projects: () => [{ id: 'p1', name: 'Here' }, { id: 'p2', name: 'Other' }],
      sessions: () => [session('s1', 'p1'), session('s2', 'p1'), session('other', 'p2')],
      runs: (_id, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Cancelled', 'AbortError')); })),
    });
    expect(await scoped.ask('host.info')).toMatchObject({ result: { platform: 'web', bridgeVersion: 1, execution: { server: context.serviceId, client: 'web' }, renderers: ['tasks', 'list', 'form', 'detail'] } });
    expect(await scoped.ask('projects.list', {})).toMatchObject({ result: { items: [{ id: 'p1', name: 'Here' }] } });
    expect(await scoped.ask('sessions.list', { limit: 1 })).toMatchObject({ result: { items: [{ id: 's1' }], next: 1 } });
    expect(await scoped.ask('sessions.list', { offset: 1, limit: 1 })).toMatchObject({ result: { items: [{ id: 's2' }] } });
    expect(code(await scoped.ask('sessions.runs', { sessionId: 'other' }))).toBe('not_found');
    scoped.port.receive({ id: 900, method: 'sessions.runs', params: { sessionId: 's1' } });
    scoped.port.receive({ cancel: 900 });
    await flush();
    expect(aborted).toBe(true);
    expect(code(scoped.port.sent.find(reply => reply.id === 900))).toBe('aborted');
    expect(code(await setup().ask('sessions.list', {}))).toBe('denied');
    scoped.bridge.close();
  });

  it('refuses malformed requests and params', async () => {
    const { ask, port, calls } = setup({ capabilities: ['sessions.read'] });
    expect(code(await ask('nope.method'))).toBe('unknown_method');
    expect(code(await ask('toString'))).toBe('unknown_method');
    for (const [method, params] of [
      ['sessions.get', undefined], ['sessions.get', { sessionId: 5 }], ['sessions.get', { sessionId: '' }], ['sessions.get', { sessionId: 's1', extra: 1 }],
      ['sessions.outline', { sessionId: 's1', lane: 'main2' }], ['sessions.timeline', { sessionId: 's1', from: -1 }], ['sessions.timeline', { sessionId: 's1', from: 0, rows: 5000 }],
      ['navigation.openPath', { path: '/etc/passwd' }], ['navigation.openPath', { path: 'a/../../b' }], ['navigation.openPath', { path: 'C:\\x' }],
      ['notify.info', { text: 'a'.repeat(BRIDGE_LIMITS.text + 1) }], ['notify.info', { text: 'line\nbreak' }],
    ] as Array<[string, unknown]>) {
      expect(code(await ask(method, params)), `${method} ${JSON.stringify(params)}`).toBe('invalid_params');
    }
    port.receive({ id: 'x', method: 'context.get' });
    port.receive({ method: 'context.get' });
    port.receive('context.get');
    await flush();
    expect(port.sent.filter((message) => message.id === 'x' || message.id === undefined)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('refuses the conversation of another project, for reads and for navigation', async () => {
    const { ask, calls } = setup({ capabilities: ['sessions.read'] });
    for (const [method, params] of [
      ['sessions.get', { sessionId: 'other' }], ['sessions.outline', { sessionId: 'other' }], ['sessions.timeline', { sessionId: 'other', from: 0 }],
      ['navigation.openSession', { sessionId: 'other' }], ['sessions.get', { sessionId: 'missing' }],
    ] as Array<[string, unknown]>) expect(code(await ask(method, params)), method).toBe('not_found');
    expect(calls).toEqual([]);
    expect(await ask('navigation.openSession', { sessionId: 's1' })).toMatchObject({ result: null });
    expect(calls).toEqual(['openSession:s1']);
  });

  it('reads the file a file view was opened for, and other project files only with projects.read', async () => {
    const reads: string[] = [];
    const readFile: BridgeServices['readFile'] = async (path, offset, length) => { reads.push(`${path}:${offset}:${length}`); return { path, size: 3, offset, data: 'YWJj' }; };
    const own = { ...context, path: 'models/a.glb' };
    const viewer = setup({}, { context: () => own, readFile });
    expect(await viewer.ask('files.read')).toMatchObject({ result: { path: 'models/a.glb', data: 'YWJj' } });
    expect(await viewer.ask('files.read', { path: 'models/a.glb', offset: 2, length: 1 })).toMatchObject({ result: { offset: 2 } });
    expect(code(await viewer.ask('files.read', { path: 'models/a.mtl' }))).toBe('denied');
    expect(code(await viewer.ask('files.read', { length: BRIDGE_LIMITS.fileBytes + 1 }))).toBe('invalid_params');
    const reader = setup({ capabilities: ['projects.read'] }, { context: () => own, readFile });
    expect(await reader.ask('files.read', { path: './models/a.mtl' })).toMatchObject({ result: { path: 'models/a.mtl' } });
    expect(code(await reader.ask('files.read', { path: '../secret' }))).toBe('invalid_params');
    // The server expands `~` to the home folder, which is not the project.
    expect(code(await reader.ask('files.read', { path: '~/.zsh_history' }))).toBe('invalid_params');
    // A view opened for no file names one; one with no project reads none.
    expect(code(await setup({}, { readFile }).ask('files.read'))).toBe('invalid_params');
    expect(code(await setup({ capabilities: ['projects.read'] }, { context: () => ({ ...own, projectId: undefined }), readFile }).ask('files.read'))).toBe('forbidden');
    expect(reads).toEqual([`models/a.glb:0:${BRIDGE_LIMITS.fileBytes}`, 'models/a.glb:2:1', `models/a.mtl:0:${BRIDGE_LIMITS.fileBytes}`]);
  });

  it('steers the app only while the user is working in the view', async () => {
    let active = false;
    const { ask, calls } = setup({ capabilities: ['sessions.read'] }, { active: () => active });
    expect(code(await ask('navigation.openSession', { sessionId: 's1' }))).toBe('denied');
    expect(code(await ask('navigation.openPath', { path: 'a.txt' }))).toBe('denied');
    // Params are still checked first, and reads are not navigation.
    expect(code(await ask('navigation.openPath', { path: '/etc/passwd' }))).toBe('invalid_params');
    expect(await ask('sessions.get', { sessionId: 's1' })).toMatchObject({ result: { id: 's1' } });
    expect(calls).toEqual([]);
    active = true;
    expect(await ask('navigation.openSession', { sessionId: 's1' })).toMatchObject({ result: null });
    expect(await ask('navigation.openPath', { path: 'a.txt' })).toMatchObject({ result: null });
    expect(calls).toEqual(['openSession:s1', 'openPath:a.txt']);
  });

  it('answers a view with no project nothing about conversations', async () => {
    const port = new FakePort();
    const calls: string[] = [];
    serveBridge({
      port, grant: { capabilities: new Set(['sessions.read']), commands: new Set() },
      services: servicesOf(calls, { context: () => ({ ...context, projectId: undefined as never }), session: () => session('s1', 'p1') }),
    });
    port.receive({ id: 1, method: 'sessions.get', params: { sessionId: 's1' } });
    port.receive({ id: 2, method: 'navigation.openPath', params: { path: 'a.txt' } });
    await flush();
    expect(port.sent.map(code)).toEqual(['not_found', 'forbidden']);
    expect(calls).toEqual([]);
  });

  it('runs only the commands the package declares, and says so when the host has no path for them', async () => {
    const { ask } = setup({ commands: ['acme.demo/run'] });
    expect(code(await ask('commands.execute', { id: 'acme.demo/other' }))).toBe('forbidden');
    expect(code(await ask('commands.execute', { id: 'acme.demo/run' }))).toBe('unsupported');
    const ran: unknown[] = [];
    const withPath = setup({ commands: ['acme.demo/run'] }, { execute: async (id, args) => { ran.push([id, args]); return { kind: 'done' }; } });
    expect(await withPath.ask('commands.execute', { id: 'acme.demo/run', args: { a: 1 } })).toMatchObject({ result: { kind: 'done' } });
    expect(ran).toEqual([['acme.demo/run', { a: 1 }]]);
    for (const args of [[1], 'x', { nested: { a: 1 } }, { a: null }]) expect(code(await withPath.ask('commands.execute', { id: 'acme.demo/run', args }))).toBe('invalid_params');
    expect(ran).toHaveLength(1);
  });

  it('keeps queries and view navigation within the package declarations and requires focus for navigation', async () => {
    let active = false;
    const query = vi.fn(async (_id: string, params: unknown) => params);
    const openView = vi.fn((id: string) => id === 'acme.demo/main');
    const { ask } = setup({ queries: ['acme.demo/count'], views: ['acme.demo/main', 'acme.demo/panel'] }, { query, openView, active: () => active });
    expect(code(await ask('plugin.query', { id: 'other.plugin/count' }))).toBe('forbidden');
    expect(await ask('plugin.query', { id: 'acme.demo/count', params: { page: 1 } })).toMatchObject({ result: { page: 1 } });
    expect(query).toHaveBeenCalledTimes(1);
    expect(code(await ask('navigation.openView', { viewId: 'acme.demo/main' }))).toBe('denied');
    active = true;
    expect(code(await ask('navigation.openView', { viewId: 'other.plugin/main' }))).toBe('forbidden');
    expect(code(await ask('navigation.openView', { viewId: 'acme.demo/panel' }))).toBe('not_found');
    expect(await ask('navigation.openView', { viewId: 'acme.demo/main' })).toMatchObject({ result: null });
    expect(openView.mock.calls).toEqual([['acme.demo/panel'], ['acme.demo/main']]);
  });

  it('aborts pending calls and sends nothing once closed', async () => {
    let seen: AbortSignal | undefined;
    let settled = false;
    const { port, bridge } = setup({ capabilities: ['sessions.read'] }, {
      outline: (_id, _lane, signal) => new Promise((_resolve, reject) => {
        seen = signal;
        signal.addEventListener('abort', () => { settled = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      }),
    });
    port.receive({ id: 1, method: 'sessions.outline', params: { sessionId: 's1' } });
    await flush();
    expect(seen?.aborted).toBe(false);
    bridge.close();
    await flush();
    expect(seen?.aborted).toBe(true);
    expect(settled).toBe(true);
    expect(port.closed).toBe(true);
    expect(port.sent).toEqual([]);
    bridge.push('theme', { scheme: 'dark', vars: {} });
    port.receive({ id: 2, method: 'context.get' });
    await flush();
    expect(port.sent).toEqual([]);
  });

  it('limits request size, request rate and concurrent calls', async () => {
    const { ask } = setup();
    expect(code(await ask('notify.info', { text: 'x', pad: 'y'.repeat(BRIDGE_LIMITS.requestBytes) }))).toBe('too_large');

    let at = 0;
    const fast = setup({}, {}, () => at);
    for (let i = 0; i < BRIDGE_LIMITS.burst + 5; i += 1) { fast.port.receive({ id: i, method: 'context.get' }); await flush(); }
    expect(fast.port.sent.filter((message) => code(message) === 'rate_limited')).toHaveLength(5);
    at += 1000;
    fast.port.receive({ id: 999, method: 'context.get' });
    await flush();
    expect(fast.port.sent.at(-1)).toMatchObject({ id: 999, result: { projectId: 'p1' } });

    const slow = setup({ capabilities: ['sessions.read'] }, { outline: () => new Promise(() => undefined) });
    for (let i = 0; i < BRIDGE_LIMITS.pending + 2; i += 1) slow.port.receive({ id: i, method: 'sessions.outline', params: { sessionId: 's1' } });
    await flush();
    expect(slow.port.sent.map(code)).toEqual(['rate_limited', 'rate_limited']);
  });
});

describe('frame host', () => {
  const frameWindow = () => {
    const posted: Array<{ message: unknown; origin: string; transfer: Transferable[] }> = [];
    return { posted, window: { postMessage: (message: unknown, origin: string, transfer: Transferable[]) => { posted.push({ message, origin, transfer }); } } };
  };
  const listen = () => {
    let handler: ((event: MessageEvent) => void) | undefined;
    return {
      source: { addEventListener: (_: 'message', fn: (event: MessageEvent) => void) => { handler = fn; }, removeEventListener: () => { handler = undefined; } },
      dispatch: (event: Partial<MessageEvent>) => handler?.(event as MessageEvent),
      attached: () => handler !== undefined,
    };
  };
  const grant: BridgeGrant = { capabilities: new Set(), commands: new Set() };
  const services = servicesOf([]);
  const ready = { type: BRIDGE_READY, version: BRIDGE_VERSION };

  it('hands a channel to the frame it embedded and to no other window', () => {
    const own = frameWindow(), stranger = frameWindow();
    const events = listen();
    const ports: FakePort[] = [];
    const bootstrap = () => ({ code: '// </script> stays in the message', locale: 'en', style: '' });
    const channel = attachFrame({ frame: () => own.window, grant, services, bootstrap, listenOn: events.source, createChannel: () => { const port = new FakePort(); ports.push(port); return { port1: port, port2: {} as MessagePort }; } });
    events.dispatch({ source: stranger.window as never, data: ready });
    events.dispatch({ source: null, data: ready });
    events.dispatch({ source: own.window as never, data: { type: BRIDGE_READY, version: 99 } });
    events.dispatch({ source: own.window as never, data: { type: 'riffet-plugin:other' } });
    expect(own.posted).toEqual([]);
    expect(stranger.posted).toEqual([]);
    events.dispatch({ source: own.window as never, data: ready });
    expect(own.posted).toHaveLength(1);
    expect(own.posted[0]).toMatchObject({ message: { type: BRIDGE_INIT, version: BRIDGE_VERSION, bootstrap: bootstrap() }, origin: '*' });
    expect(own.posted[0]!.transfer).toHaveLength(1);

    // Asking again (a page the frame navigated to, say) gets nothing: the first channel stays the only one.
    events.dispatch({ source: own.window as never, data: ready });
    expect(own.posted).toHaveLength(1);
    expect(ports.map((port) => port.closed)).toEqual([false]);
    channel.dispose();
    expect(ports[0]!.closed).toBe(true);
    expect(events.attached()).toBe(false);
  });

  it('answers nobody once the frame is gone or the host is disposed', () => {
    const own = frameWindow();
    const events = listen();
    let current: ReturnType<typeof frameWindow>['window'] | null = own.window;
    attachFrame({ frame: () => current, grant, services, listenOn: events.source, createChannel: () => ({ port1: new FakePort(), port2: {} as MessagePort }) });
    current = null;
    events.dispatch({ source: own.window as never, data: ready });
    expect(own.posted).toEqual([]);
  });
});

describe('isolated page', () => {
  it('closes the network unless the package holds network, and loads nothing from anywhere', () => {
    expect(pluginPolicy(false)).toContain("connect-src 'none'");
    expect(pluginPolicy(true)).toContain('connect-src https:');
    expect(pluginPolicy(false)).toMatch(/^default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;/);
    expect(pluginPolicy(false)).toContain("form-action 'none'");
    for (const [index, policy] of shellPolicies.entries()) {
      expect(policy).toContain(pluginPolicy(index === 1));
      expect(policy).toContain('sandbox allow-scripts');
      expect(policy).toContain("frame-ancestors 'self'");
    }
  });

  it('uses the palette roles and rejects values that break out of the style rule', () => {
    const style = bootstrapStyle({ scheme: 'dark', vars: { '--bg': '#000', '--evil': '#fff;}body{color:red' } });
    expect(style).toContain(':root{color-scheme:dark;--bg:#000}');
    expect(style).not.toContain('--evil');
  });
});

describe('entry integrity', () => {
  const bytes = new TextEncoder().encode('console.log(1)');
  const hex = async () => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');

  it('passes the recorded digest in either spelling and refuses anything else', async () => {
    const digest = await hex();
    const base64 = btoa(String.fromCharCode(...(digest.match(/../g) ?? []).map((pair) => parseInt(pair, 16))));
    await expect(verifyIntegrity(bytes.buffer as ArrayBuffer, undefined)).resolves.toBeUndefined();
    await expect(verifyIntegrity(bytes.buffer as ArrayBuffer, `sha256-${digest}`)).resolves.toBeUndefined();
    await expect(verifyIntegrity(bytes.buffer as ArrayBuffer, `sha256-${base64}`)).resolves.toBeUndefined();
    await expect(verifyIntegrity(bytes.buffer as ArrayBuffer, `sha256-${'0'.repeat(64)}`)).rejects.toThrow();
    await expect(verifyIntegrity(bytes.buffer as ArrayBuffer, 'sha512-abcd')).rejects.toThrow();
    await expect(verifyIntegrity(bytes.buffer as ArrayBuffer, '')).rejects.toThrow();
  });
});

describe('bridge client against the host', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  // A parent window and a frame window that deliver to each other as the browser does: `source` is the sender, a transferred port arrives in `ports`.
  function windows() {
    const listeners = { parent: new Set<(event: unknown) => void>(), frame: new Set<(event: unknown) => void>() };
    const style = { values: {} as Record<string, string>, colorScheme: '', setProperty(name: string, value: string) { this.values[name] = value; } };
    const parent = {
      addEventListener: (_: string, fn: (event: unknown) => void) => listeners.parent.add(fn),
      removeEventListener: (_: string, fn: (event: unknown) => void) => listeners.parent.delete(fn),
      postMessage: () => undefined,
    };
    const frame = {
      parent,
      addEventListener: (type: string, fn: (event: unknown) => void) => { if (type === 'message') listeners.frame.add(fn); },
      removeEventListener: (type: string, fn: (event: unknown) => void) => { if (type === 'message') listeners.frame.delete(fn); },
      // The host answering the frame.
      postMessage: (data: unknown, _origin: string, transfer: MessagePort[]) => queueMicrotask(() => listeners.frame.forEach((fn) => fn({ data, source: parent, ports: transfer }))),
    };
    // The frame asking its parent.
    parent.postMessage = ((data: unknown) => queueMicrotask(() => listeners.parent.forEach((fn) => fn({ data, source: frame })))) as never;
    return { parent, frame, style };
  }

  it('connects, reads through the capability it holds, is refused the rest, follows pushes, and ends with the host', async () => {
    const { parent, frame, style } = windows();
    vi.stubGlobal('window', frame);
    const document = { documentElement: { style, lang: '' }, createElement: (tag: string) => ({ tag, textContent: '' }), head: { appendChild: vi.fn() } };
    vi.stubGlobal('document', document);
    const calls: string[] = [];
    const channel = attachFrame({
      frame: () => frame as never, grant: { capabilities: new Set(['sessions.read']), commands: new Set() }, listenOn: parent as never,
      bootstrap: () => ({ code: '/* </script> */', locale: 'en', style: ':root{}' }),
      services: servicesOf(calls, { theme: () => ({ scheme: 'dark', vars: { '--bg': '#111' } }) }),
    });
    // The page's own script asks, as the bootstrap page does, before any view code runs.
    new Function('window', 'document', shellScript)(frame, document);
    const bridge = await connect({ timeoutMs: 1000 });
    expect(bridge.context).toMatchObject({ projectId: 'p1', sessionId: 's1' });
    expect(style.values['--bg']).toBe('#111');
    expect(style.colorScheme).toBe('dark');
    expect(document.documentElement.lang).toBe('en');
    expect(document.head.appendChild.mock.calls).toEqual([[{ tag: 'style', textContent: ':root{}' }], [{ tag: 'script', textContent: '/* </script> */' }]]);
    await expect(bridge.call('sessions.get', { sessionId: 's1' })).resolves.toMatchObject({ id: 's1', projectId: 'p1' });
    await expect(bridge.call('sessions.get', { sessionId: 'other' })).rejects.toMatchObject({ name: 'BridgeError', code: 'not_found' });
    await expect(bridge.call('commands.execute', { id: 'acme.demo/run' })).rejects.toBeInstanceOf(BridgeError);

    const seen: string[] = [];
    bridge.on('theme', (theme) => seen.push(theme.scheme));
    channel.push('theme', { scheme: 'light', vars: { '--bg': '#fff' } });
    await flush();
    expect(seen).toEqual(['light']);
    expect(style.values['--bg']).toBe('#fff');

    channel.dispose();
    bridge.close();
    await expect(bridge.call('context.get')).rejects.toMatchObject({ code: 'closed' });
  });

  it('does not connect to a window that did not embed the host', async () => {
    const { parent, frame } = windows();
    vi.stubGlobal('window', frame);
    vi.stubGlobal('document', { documentElement: { style: { setProperty: () => undefined } } });
    // The host embeds some other window, so the frame's request is not answered.
    const other = { postMessage: vi.fn() };
    const channel = attachFrame({ frame: () => other, grant: { capabilities: new Set(), commands: new Set() }, listenOn: parent as never, services: servicesOf([]) });
    // Without the page's own request there is nothing to connect to; with it, nobody answers.
    await expect(connect({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'unsupported' });
    new Function('window', shellScript)(frame);
    await expect(connect({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout' });
    expect(other.postMessage).not.toHaveBeenCalled();
    channel.dispose();
  });
});
