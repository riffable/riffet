// The live channel (docs/BROWSER.md §5): frames out, the user's input and answers in. The user's input goes to the
// page at any time, alongside the agent's; `done` answers a `browser_handoff`.

import type { PluginChannelHandler, PluginHost } from '@riffet/plugin-api';
import type { Browsers, SessionBrowser } from './browsers.js';
import type { BrowserLiveClientMessage, BrowserModifiers } from './protocol.js';
import { withScheme } from './risk.js';

const KEYS: Array<[keyof BrowserModifiers, string]> = [['alt', 'Alt'], ['ctrl', 'Control'], ['meta', 'Meta'], ['shift', 'Shift']];
const finite = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

function parse(data: string | Uint8Array): BrowserLiveClientMessage | undefined {
  if (typeof data !== 'string' || data.length > 64 * 1024) return undefined;
  try { const value = JSON.parse(data) as BrowserLiveClientMessage; return value && typeof value === 'object' && typeof value.type === 'string' ? value : undefined; } catch { return undefined; }
}

export function liveChannel(browsers: Browsers, host: PluginHost): PluginChannelHandler {
  /** Input runs in order per conversation; a slow navigation does not let a later click overtake it. */
  const chains = new Map<string, Promise<void>>();

  async function withModifiers(session: SessionBrowser, modifiers: BrowserModifiers | undefined, run: () => Promise<void>): Promise<void> {
    const page = session.tabs.get(session.active ?? '')?.page;
    const held = page ? KEYS.filter(([key]) => modifiers?.[key]).map(([, name]) => name) : [];
    for (const name of held) await page!.keyboard.down(name);
    try { await run(); } finally { for (const name of held.reverse()) await page!.keyboard.up(name).catch(() => undefined); }
  }

  async function handle(session: SessionBrowser, message: BrowserLiveClientMessage): Promise<void> {
    if (message.type === 'answer') { if (typeof message.id === 'string' && typeof message.allow === 'boolean') browsers.answer(session, message.id, message.allow); return; }
    if (message.type === 'done') { browsers.done(session); return; }
    browsers.userInput(session, !(message.type === 'mouse' && message.action === 'move') && message.type !== 'select');
    if (message.type === 'navigate') {
      if (typeof message.url !== 'string' || message.url.length > 8000) return;
      const url = withScheme(message.url);
      if (!/^https?:/i.test(url) && url !== 'about:blank') return;
      if (browsers.isBlocked(url)) throw host.error('BROWSER_BLOCKED_SITE', 'This site is blocked in the Browser plugin settings', 403);
      const tab = session.active ? browsers.tab(session) : await browsers.newTab(session);
      await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return;
    }
    if (message.type === 'select') { if (typeof message.tab === 'string' && session.tabs.has(message.tab)) browsers.select(session, message.tab); return; }
    const tab = session.active ? session.tabs.get(session.active) : undefined;
    if (!tab) return;
    const { page } = tab;
    switch (message.type) {
      case 'back': await page.goBack({ timeout: 15_000 }).catch(() => undefined); return;
      case 'forward': await page.goForward({ timeout: 15_000 }).catch(() => undefined); return;
      case 'reload': await page.reload({ timeout: 15_000 }).catch(() => undefined); return;
      case 'mouse': {
        if (!finite(message.x, -10, 10_000) || !finite(message.y, -10, 10_000)) return;
        const button = message.button === 'right' || message.button === 'middle' ? message.button : 'left';
        await withModifiers(session, message.modifiers, async () => {
          await page.mouse.move(message.x, message.y);
          if (message.action === 'down') await page.mouse.down({ button, clickCount: finite(message.clickCount, 1, 3) ? message.clickCount : 1 });
          else if (message.action === 'up') await page.mouse.up({ button, clickCount: finite(message.clickCount, 1, 3) ? message.clickCount : 1 });
        });
        return;
      }
      case 'wheel':
        if (!finite(message.x, -10, 10_000) || !finite(message.y, -10, 10_000) || !finite(message.deltaX, -10_000, 10_000) || !finite(message.deltaY, -10_000, 10_000)) return;
        await page.mouse.move(message.x, message.y);
        await page.mouse.wheel(message.deltaX, message.deltaY);
        return;
      case 'key':
        if (typeof message.key !== 'string' || !message.key || message.key.length > 40) return;
        await withModifiers(session, message.modifiers, async () => {
          if (message.action === 'down') await page.keyboard.down(message.key); else await page.keyboard.up(message.key);
        });
        return;
      case 'text':
        if (typeof message.text === 'string' && message.text.length <= 32_000) await page.keyboard.insertText(message.text);
        return;
    }
  }

  return {
    open(context, socket) {
      if (!context.projectId) { socket.close(4400, 'No project'); return; }
      const session = browsers.session(context.sessionId, context.projectId);
      void browsers.addViewer(session, socket);
      context.signal.addEventListener('abort', () => void browsers.removeViewer(session, socket), { once: true });
      return {
        message(data) {
          const message = parse(data);
          if (!message) return;
          const previous = chains.get(session.id) ?? Promise.resolve();
          const next = previous.then(() => handle(session, message)).catch(error => {
            socket.send(JSON.stringify({ type: 'error', code: (error as { code?: string }).code ?? 'BROWSER_FAILED', message: String((error as Error).message ?? error).split('\n')[0] }));
          });
          chains.set(session.id, next);
        },
      };
    },
  };
}
