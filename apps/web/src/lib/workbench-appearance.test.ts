import { afterEach, expect, it, vi } from 'vitest';
import { APPEARANCE_DEFAULT, THEME_ANSI_KEYS, THEME_ROLES } from '@contracts';

vi.mock('./api', () => ({
  api: {
    themes: () => Promise.reject(new Error('Offline')),
    appearance: () => Promise.reject(new Error('Offline')),
  },
}));
vi.mock('./theme-palette', () => ({ applyThemeAppearance: vi.fn(), customThemeCss: () => '' }));

class WorkbenchSocket extends EventTarget {
  static readonly sockets: WorkbenchSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  messages: unknown[] = [];

  constructor() {
    super();
    WorkbenchSocket.sockets.push(this);
  }

  open() {
    this.readyState = WorkbenchSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }

  receive(message: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  send(message: string) { this.messages.push(JSON.parse(message)); }
}

afterEach(() => {
  WorkbenchSocket.sockets.length = 0;
  vi.unstubAllGlobals();
});

it('waits for an assistant send, then acknowledges only supported and persisted appearance changes', async () => {
  const selectionKey = 'riffet.appearance.selection';
  const pluginId = 'example.palette/dusk';
  const sha256 = 'a'.repeat(64);
  const ansi = THEME_ANSI_KEYS.map(() => '#242424');
  const palette = Object.fromEntries(THEME_ROLES.map(role => [role, '#242424']));
  const values = new Map([
    ['riffet.theme', 'dark'],
    [selectionKey, JSON.stringify({ palette: pluginId })],
    ['riffet.appearance.cache.v1', JSON.stringify({
      catalog: {
        version: 1, revision: 'v1',
        palettes: [{ id: pluginId, asset: { sha256 } }],
        fonts: [], backgrounds: [], presets: [],
      },
      palettes: { [sha256]: { id: 'custom-test-fixture', name: 'Dusk', palette: { light: palette, dark: palette }, ansi: { light: ansi, dark: ansi } } },
    })],
  ]);
  let deniedKey: string | undefined;
  const client = Object.assign(new EventTarget(), {
    location: { href: 'https://riffet.example/' },
    matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === deniedKey) throw new Error('Storage denied');
        values.set(key, value);
      },
      removeItem: (key: string) => values.delete(key),
    },
    setTimeout, clearTimeout, get self() { return this; }, get top() { return this; },
  });
  const meta = { content: 'document-proof', remove: vi.fn() };
  vi.stubGlobal('window', client);
  vi.stubGlobal('document', {
    querySelector: () => meta,
    documentElement: { dataset: {}, style: { setProperty: vi.fn(), removeProperty: vi.fn() } },
  });
  vi.stubGlobal('WebSocket', WorkbenchSocket);
  const { connectWorkbenchAppearance, needsWorkbenchDocumentReload, workbenchAppearanceConnection } = await import('./workbench-appearance');
  const dispose = connectWorkbenchAppearance();
  try {
    await Promise.resolve();
    expect(meta.remove).toHaveBeenCalledOnce();
    expect(WorkbenchSocket.sockets).toHaveLength(0);
    const interrupted = workbenchAppearanceConnection();
    expect(WorkbenchSocket.sockets).toHaveLength(1);
    const first = WorkbenchSocket.sockets[0]!;
    first.open();
    first.close();
    await expect(interrupted).resolves.toBeUndefined();
    const pending = workbenchAppearanceConnection();
    const socket = WorkbenchSocket.sockets[1]!;
    socket.open();
    expect(socket.messages[0]).toEqual({ documentProof: 'document-proof' });
    socket.receive({ connectionId: 'workbench', nextDocumentProof: 'next-proof' });
    await expect(pending).resolves.toBe('workbench');
    const call = (callId: string, change: object) => {
      socket.receive({ callId, deadline: new Date(Date.now() + 60_000).toISOString(), change });
      return socket.messages.at(-1);
    };
    expect(call('read', {})).toMatchObject({
      callId: 'read', result: { themeId: 'riffet', mode: 'dark', activePaletteId: `plugin-${sha256.slice(0, 16)}` },
    });
    expect(call('invalid', { themeId: 'unlisted', mode: 'light' })).toEqual({ callId: 'invalid', error: 'unsupported' });
    expect(values.get('riffet.theme')).toBe('dark');
    deniedKey = selectionKey;
    expect(call('rollback', { themeId: 'solarized', mode: 'light' })).toEqual({ callId: 'rollback', error: 'unavailable' });
    expect(values.get('riffet.theme')).toBe('dark');
    expect(values.has('riffet.theme.id')).toBe(false);
    expect(values.get(selectionKey)).toBe(JSON.stringify({ palette: pluginId }));
    deniedKey = undefined;
    values.set(selectionKey, JSON.stringify({ palette: pluginId, background: 'example.background/plain' }));
    expect(call('change', { themeId: 'solarized' })).toMatchObject({ callId: 'change', result: { themeId: 'solarized', mode: 'dark' } });
    expect(values.get('riffet.theme.id')).toBe('solarized');
    expect(values.get('riffet.theme')).toBe('dark');
    expect(values.get(selectionKey)).toBe(JSON.stringify({ palette: APPEARANCE_DEFAULT, background: 'example.background/plain' }));
    expect(call('unsafe-undo', { undo: true })).toEqual({ callId: 'unsafe-undo', error: 'unsupported' });
    const finalReceipt = call('read-again', {});
    expect(finalReceipt).toMatchObject({ callId: 'read-again', result: { themeId: 'solarized', mode: 'dark' } });
    expect(finalReceipt).not.toHaveProperty('result.activePaletteId');
    expect(finalReceipt).toMatchObject({ result: {
      display: { textSize: 'standard', density: 'standard', terminalFontSize: 12.5 },
      displayOptions: {
        textSize: ['small', 'standard', 'large', 'extra-large'],
        terminalPaddingHorizontal: { min: 0, max: 48 },
        codeThemes: expect.arrayContaining([{ id: 'auto', name: 'auto' }]),
      },
      settingsPages: expect.arrayContaining([expect.objectContaining({ id: 'terminal' })]),
    } });

    expect(call('mixed', { textSize: 'large', mode: 'system' })).toEqual({ callId: 'mixed', error: 'unsupported' });
    expect(call('bad-padding', { terminalPaddingVertical: 33 })).toEqual({ callId: 'bad-padding', error: 'unsupported' });
    expect(call('bad-font-size', { terminalFontSize: 13 })).toEqual({ callId: 'bad-font-size', error: 'unsupported' });
    expect(call('missing-custom', { codeTheme: 'custom-unavailable' })).toEqual({ callId: 'missing-custom', error: 'unsupported' });
    expect(values.has('riffet.display')).toBe(false);
    deniedKey = 'riffet.display';
    expect(call('blocked-display', { textSize: 'large', density: 'compact' })).toEqual({ callId: 'blocked-display', error: 'unavailable' });
    expect(values.has('riffet.display')).toBe(false);
    deniedKey = undefined;
    expect(call('display', { textSize: 'large', terminalFontSize: 14, terminalPaddingVertical: 4, codeTheme: 'monochrome' })).toMatchObject({
      callId: 'display', result: { themeId: 'solarized', mode: 'dark', display: {
        textSize: 'large', terminalFontSize: 14, terminalPaddingVertical: 4, codeTheme: 'monochrome', density: 'standard',
      } },
    });
    expect(JSON.parse(values.get('riffet.display')!)).toMatchObject({ textSize: 'large', terminalFontSize: 14 });
    expect(values.get('riffet.theme')).toBe('dark');
    const currentDisplay = JSON.parse(values.get('riffet.display')!);
    values.set('riffet.display', JSON.stringify({ ...currentDisplay, density: 'relaxed' }));
    expect(call('undo', { undo: true })).toMatchObject({
      callId: 'undo', result: { undone: true, display: { textSize: 'standard', terminalFontSize: 12.5, density: 'relaxed', codeTheme: 'auto' } },
    });
    expect(call('again', { undo: true })).toEqual({ callId: 'again', error: 'unsupported' });
    call('mode', { mode: 'system' });
    expect(call('mode-undo', { undo: true })).toMatchObject({ result: { undone: true, mode: 'dark', themeId: 'solarized' } });
    call('theme', { themeId: 'riffet' });
    values.set('riffet.theme.id', 'catppuccin');
    expect(call('conflicting-undo', { undo: true })).toEqual({ callId: 'conflicting-undo', error: 'conflict' });
    expect(values.get('riffet.theme.id')).toBe('catppuccin');
    dispose();
    expect(needsWorkbenchDocumentReload()).toBe(false);
    const reconnect = connectWorkbenchAppearance();
    try {
      await Promise.resolve();
      const afterAuth = workbenchAppearanceConnection();
      const newSocket = WorkbenchSocket.sockets.at(-1)!;
      expect(newSocket).not.toBe(socket);
      newSocket.open();
      expect(newSocket.messages[0]).toEqual({ documentProof: 'next-proof' });
      newSocket.receive({ connectionId: 'workbench-after-auth', nextDocumentProof: 'last-proof' });
      await expect(afterAuth).resolves.toBe('workbench-after-auth');
    } finally {
      reconnect();
    }
  } finally {
    dispose();
  }
});
