// The conversations' browsers (docs/BROWSER.md §3, §5): one persistent context per project, a set of tabs per
// conversation, what the agent waits on the user for, and the viewers of the live panel. The user and the agent share
// the page: either may act at any time, and the agent is told when the user did.

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import type { PluginChannelSocket, PluginHost } from '@riffet/plugin-api';
import { browserChoice, Engine } from './engine.js';
import type { BrowserLiveState, BrowserPending, BrowserTab } from './protocol.js';
import { hostMatches, sitePatterns } from './risk.js';

const IDLE_MS = 15 * 60_000;

/** A project's profile directory under `profiles/`. */
const profileName = (projectId: string) => projectId.replace(/[^A-Za-z0-9_-]/g, '_');

/** Bytes under `path`, symbolic links not followed; 0 when it is not there. */
async function sizeOf(path: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
    await Promise.all(items.map(async item => {
      const full = join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else if (item.isFile()) total += (await stat(full).catch(() => undefined))?.size ?? 0;
    }));
  };
  await walk(path);
  return total;
}
const RING = 200;
const VIEWER_BUFFER_LIMIT = 2 * 1024 * 1024;
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export interface LogEntry { at: string; [key: string]: unknown }

class Ring {
  readonly items: LogEntry[] = [];
  push(item: Omit<LogEntry, 'at'>): void { this.items.push({ at: new Date().toISOString(), ...item }); if (this.items.length > RING) this.items.shift(); }
}

export interface Tab { id: string; page: Page; console: Ring; network: Ring; errors: Ring }

interface Waiter { resolve: (value: boolean) => void }

export interface SessionBrowser {
  id: string;
  projectId: string;
  tabs: Map<string, Tab>;
  active?: string;
  nextTab: number;
  pending?: BrowserPending;
  waiter?: Waiter;
  /** Set when a handoff outlived its tool call: the user's 完成 wakes the conversation. */
  wakeOnDone: boolean;
  /** The user operated the page since the agent last looked; the next result says so. */
  touched: boolean;
  /** Hides the action labels while the user's own input arrives: they show what the agent does. */
  quietUntil?: NodeJS.Timeout;
  downloads: Array<{ path: string; url: string }>;
  viewers: Set<PluginChannelSocket>;
  stream?: { page: Page; dispose: () => Promise<void>; actions: (on: boolean) => Promise<void> };
  lastFrame?: Buffer;
  lastUsed: number;
}

interface ProjectBrowser { context: Promise<BrowserContext>; blocked: string }

export class Browsers {
  readonly engine: Engine;
  private readonly projects = new Map<string, ProjectBrowser>();
  private readonly sessions = new Map<string, SessionBrowser>();
  private readonly owners = new WeakMap<Page, SessionBrowser>();
  private readonly timer: NodeJS.Timeout;
  private broadcastTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly host: PluginHost, readonly stateDir: string) {
    this.engine = new Engine(join(stateDir, 'browsers'));
    this.timer = setInterval(() => void this.closeIdle(), 60_000);
    this.timer.unref();
  }

  get choice() { return browserChoice(this.host.settings()); }
  installed(): boolean { return this.engine.installed(this.choice); }

  session(id: string, projectId: string): SessionBrowser {
    let session = this.sessions.get(id);
    if (!session) {
      session = { id, projectId, tabs: new Map(), nextTab: 1, wakeOnDone: false, touched: false, downloads: [], viewers: new Set(), lastUsed: Date.now() };
      this.sessions.set(id, session);
    }
    return session;
  }

  existing(id: string): SessionBrowser | undefined { return this.sessions.get(id); }

  // ── Contexts ───────────────────────────────────────────────────────────────

  private context(projectId: string): Promise<BrowserContext> {
    const found = this.projects.get(projectId);
    if (found) return found.context;
    const entry: ProjectBrowser = { blocked: '', context: (async () => {
      if (!this.installed()) throw this.host.error('BROWSER_NOT_INSTALLED', 'No browser is installed for Riffet. In Riffet, open Plugins › Browser › Settings and download it, or choose Chrome there.', 409);
      const profile = join(this.stateDir, 'profiles', profileName(projectId));
      await mkdir(profile, { recursive: true, mode: 0o700 });
      const path = [...this.sessions.values()].filter(item => item.projectId === projectId).map(item => this.host.sessions?.get(item.id)?.projectPath).find(Boolean);
      if (path) await this.rememberProject(projectId, path).catch(() => undefined);
      const context = await this.engine.launch(this.choice, profile);
      // Persistent contexts start with a blank page nobody owns.
      for (const page of context.pages()) void page.close().catch(() => undefined);
      context.on('page', page => void this.adoptPopup(page));
      context.on('close', () => this.dropProject(projectId));
      return context;
    })() };
    this.projects.set(projectId, entry);
    entry.context.catch(() => { if (this.projects.get(projectId) === entry) this.projects.delete(projectId); });
    return entry.context;
  }

  /** Blocked sites are refused at the network layer, redirects included. Routing disables the HTTP cache, so it is set only when there is a list. */
  private async applySitePolicy(projectId: string, context: BrowserContext): Promise<void> {
    const entry = this.projects.get(projectId);
    const blocked = this.host.settings().blockSites ?? '';
    if (!entry || entry.blocked === blocked) return;
    entry.blocked = blocked;
    await context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined);
    const patterns = sitePatterns(blocked);
    if (patterns.length) await context.route('**/*', route => {
      let host = '';
      try { host = new URL(route.request().url()).hostname; } catch { /* data:, about: */ }
      return host && hostMatches(host, patterns) ? route.abort('blockedbyclient') : route.fallback();
    });
  }

  isBlocked(url: string): boolean {
    try { return hostMatches(new URL(url).hostname, sitePatterns(this.host.settings().blockSites)); } catch { return false; }
  }

  private dropProject(projectId: string): void {
    this.projects.delete(projectId);
    for (const session of this.sessions.values()) {
      if (session.projectId !== projectId) continue;
      session.tabs.clear(); session.active = undefined; session.stream = undefined; session.lastFrame = undefined;
      this.changed(session);
    }
  }

  private async closeIdle(): Promise<void> {
    const now = Date.now();
    for (const projectId of [...this.projects.keys()]) {
      const sessions = [...this.sessions.values()].filter(item => item.projectId === projectId);
      if (sessions.some(item => item.viewers.size || item.waiter || now - item.lastUsed < IDLE_MS)) continue;
      await this.closeProject(projectId);
    }
  }

  private async closeProject(projectId: string): Promise<void> {
    const entry = this.projects.get(projectId);
    if (!entry) return;
    this.projects.delete(projectId);
    try { await (await entry.context).close(); } catch { /* already gone */ }
    this.dropProject(projectId);
  }

  async dispose(): Promise<void> {
    clearInterval(this.timer);
    for (const timer of this.broadcastTimers.values()) clearTimeout(timer);
    for (const session of this.sessions.values()) { session.waiter?.resolve(false); for (const viewer of session.viewers) viewer.close(4503, 'Browser plugin turned off'); }
    await Promise.all([...this.projects.keys()].map(id => this.closeProject(id)));
  }

  // ── Data (the plugin's page) ───────────────────────────────────────────────

  private projectPaths?: Promise<Record<string, string>>;

  /** Which project each profile belongs to, by profile name, kept beside the profiles so the page can name them. */
  private paths(): Promise<Record<string, string>> {
    this.projectPaths ??= readFile(join(this.stateDir, 'projects.json'), 'utf8').then(text => {
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string')) as Record<string, string> : {};
    }).catch(() => ({}));
    return this.projectPaths;
  }

  private async rememberProject(projectId: string, path: string): Promise<void> {
    const paths = await this.paths();
    if (paths[profileName(projectId)] === path) return;
    paths[profileName(projectId)] = path;
    await writeFile(join(this.stateDir, 'projects.json'), JSON.stringify(paths), { mode: 0o600 });
  }

  /** Each project's profile: its name on disk, the project's directory when known, and its size. */
  async profiles(): Promise<Array<{ name: string; path?: string; bytes: number; open: boolean }>> {
    const paths = await this.paths();
    const names = await readdir(join(this.stateDir, 'profiles'), { withFileTypes: true }).then(items => items.filter(item => item.isDirectory()).map(item => item.name)).catch(() => [] as string[]);
    const open = new Set([...this.projects.keys()].map(profileName));
    return Promise.all(names.map(async name => ({ name, ...(paths[name] ? { path: paths[name] } : {}), bytes: await sizeOf(join(this.stateDir, 'profiles', name)), open: open.has(name) })));
  }

  downloadsSize(): Promise<number> { return sizeOf(join(this.stateDir, 'downloads')); }

  /** Closes the project's browser, then removes its profile: cookies, logins, history and cache. */
  async clearProfile(name: string): Promise<void> {
    await Promise.all([...this.projects.keys()].filter(id => profileName(id) === name).map(id => this.closeProject(id)));
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return;
    await rm(join(this.stateDir, 'profiles', name), { recursive: true, force: true });
    const paths = await this.paths();
    if (paths[name]) { delete paths[name]; await writeFile(join(this.stateDir, 'projects.json'), JSON.stringify(paths), { mode: 0o600 }).catch(() => undefined); }
  }

  async clearDownloads(): Promise<void> {
    for (const session of this.sessions.values()) session.downloads.length = 0;
    await rm(join(this.stateDir, 'downloads'), { recursive: true, force: true });
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────

  private adopt(session: SessionBrowser, page: Page): Tab {
    const tab: Tab = { id: `t${session.nextTab++}`, page, console: new Ring(), network: new Ring(), errors: new Ring() };
    session.tabs.set(tab.id, tab);
    this.owners.set(page, session);
    page.on('console', message => tab.console.push({ type: message.type(), text: message.text().slice(0, 4000), location: message.location().url || undefined }));
    page.on('pageerror', error => tab.errors.push({ message: error.message.slice(0, 4000), stack: error.stack?.slice(0, 4000) }));
    page.on('requestfailed', request => tab.network.push({ method: request.method(), url: request.url(), failure: request.failure()?.errorText }));
    page.on('response', response => { if (response.status() >= 400) tab.network.push({ method: response.request().method(), url: response.url(), status: response.status() }); });
    page.on('download', download => void (async () => {
      const dir = join(this.stateDir, 'downloads', session.id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, basename(download.suggestedFilename()) || 'download');
      await download.saveAs(path);
      session.downloads.push({ path, url: download.url() });
    })().catch(() => undefined));
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) this.changed(session); });
    page.on('load', () => this.changed(session));
    page.on('close', () => {
      session.tabs.delete(tab.id);
      if (session.active === tab.id) session.active = [...session.tabs.keys()].pop();
      void this.syncStream(session);
      this.changed(session);
    });
    session.active = tab.id;
    void this.syncStream(session);
    this.changed(session);
    return tab;
  }

  /** A page opened by a conversation's page (a popup, `target=_blank`) belongs to that conversation. */
  private async adoptPopup(page: Page): Promise<void> {
    const opener = await page.opener().catch(() => null);
    const session = opener ? this.owners.get(opener) : undefined;
    if (session && !this.owners.has(page)) this.adopt(session, page);
  }

  async newTab(session: SessionBrowser, viewport = DEFAULT_VIEWPORT): Promise<Tab> {
    const context = await this.context(session.projectId);
    await this.applySitePolicy(session.projectId, context);
    const page = await context.newPage();
    await page.setViewportSize(viewport);
    return this.adopt(session, page);
  }

  /** The named tab, or the active one; `BROWSER_NO_TAB` when there is none. */
  tab(session: SessionBrowser, id?: string): Tab {
    const tab = session.tabs.get(id ?? session.active ?? '');
    if (!tab) throw this.host.error('BROWSER_NO_TAB', id ? `No tab ${id} in this conversation (open: ${[...session.tabs.keys()].join(', ') || 'none'})` : 'No tab is open; call browser_open first', 404);
    return tab;
  }

  async prepare(session: SessionBrowser): Promise<void> {
    session.lastUsed = Date.now();
    if (this.projects.has(session.projectId)) await this.applySitePolicy(session.projectId, await this.context(session.projectId));
  }

  select(session: SessionBrowser, id: string): void {
    this.tab(session, id);
    session.active = id;
    void this.syncStream(session);
    this.changed(session);
  }

  // ── The user ───────────────────────────────────────────────────────────────

  /**
   * The user's input. It never stops the agent; the agent's next result notes it (`touch`, not for a mere pointer move).
   * The action labels, which show what the agent does, are hidden while the input lasts.
   */
  userInput(session: SessionBrowser, touch: boolean): void {
    if (touch) session.touched = true;
    session.lastUsed = Date.now();
    if (session.quietUntil) clearTimeout(session.quietUntil);
    else void session.stream?.actions(false);
    session.quietUntil = setTimeout(() => { session.quietUntil = undefined; void session.stream?.actions(true); }, 1500);
    session.quietUntil.unref();
  }

  /** 完成: the user has done what `browser_handoff` asked. The waiting call returns, or the conversation is woken. */
  done(session: SessionBrowser): void {
    if (session.pending?.kind !== 'handoff') return;
    session.pending = undefined;
    const waiter = session.waiter;
    session.waiter = undefined;
    if (waiter) waiter.resolve(true);
    else if (session.wakeOnDone) {
      session.wakeOnDone = false;
      try { this.host.sessions?.wake(session.id, 'The user has done what you asked in the Riffet browser. Take a new browser_snapshot before acting.'); } catch (error) { this.host.logger?.warn(`wake failed: ${String(error)}`); }
    }
    this.changed(session);
  }

  /** Waits for the user: `true` when allowed (or done), `false` when denied, the signal ended or the time ran out (`timedOut`). */
  async waitForUser(session: SessionBrowser, pending: BrowserPending, notice: { title: string; body: string }, ms: number, signal: AbortSignal): Promise<{ ok: boolean; timedOut: boolean }> {
    session.waiter?.resolve(false);
    session.pending = pending;
    this.changed(session);
    try { this.host.sessions?.notify(session.id, notice); } catch { /* a notice is best effort */ }
    let timedOut = false;
    const ok = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { timedOut = true; done(false); }, ms);
      const onAbort = () => done(false);
      const done = (value: boolean) => {
        clearTimeout(timer); signal.removeEventListener('abort', onAbort);
        if (session.waiter === waiter) session.waiter = undefined;
        resolve(value);
      };
      const waiter: Waiter = { resolve: done };
      session.waiter = waiter;
      signal.addEventListener('abort', onAbort, { once: true });
    });
    if (session.pending?.id === pending.id && (pending.kind === 'confirm' || ok)) session.pending = undefined;
    this.changed(session);
    return { ok, timedOut };
  }

  answer(session: SessionBrowser, id: string, allow: boolean): void {
    if (session.pending?.kind !== 'confirm' || session.pending.id !== id) return;
    session.waiter?.resolve(allow);
  }

  // ── Live ───────────────────────────────────────────────────────────────────

  /** Titles are async in Playwright; the state carries the last ones read. */
  private readonly titles = new WeakMap<Page, string>();

  state(session: SessionBrowser): BrowserLiveState {
    const tabs: BrowserTab[] = [...session.tabs.values()].map(tab => ({ id: tab.id, title: this.titles.get(tab.page) ?? '', url: tab.page.url(), active: tab.id === session.active }));
    const active = session.active ? session.tabs.get(session.active) : undefined;
    return {
      type: 'state', installed: this.installed(), running: this.projects.has(session.projectId), tabs,
      viewport: active?.page.viewportSize() ?? DEFAULT_VIEWPORT,
      ...(session.pending ? { pending: session.pending } : {}),
    };
  }

  private async refreshTitles(session: SessionBrowser): Promise<void> {
    await Promise.all([...session.tabs.values()].map(async tab => { try { this.titles.set(tab.page, await tab.page.title()); } catch { /* closing */ } }));
  }

  /** Sends the state to the conversation's viewers, coalescing bursts (navigation fires several events). */
  changed(session: SessionBrowser): void {
    if (!session.viewers.size || this.broadcastTimers.has(session.id)) return;
    this.broadcastTimers.set(session.id, setTimeout(() => {
      this.broadcastTimers.delete(session.id);
      void this.refreshTitles(session).then(() => {
        const text = JSON.stringify(this.state(session));
        for (const viewer of session.viewers) viewer.send(text);
      });
    }, 50));
  }

  async addViewer(session: SessionBrowser, socket: PluginChannelSocket): Promise<void> {
    session.viewers.add(socket);
    await this.refreshTitles(session);
    socket.send(JSON.stringify(this.state(session)));
    if (session.lastFrame) socket.send(session.lastFrame);
    await this.syncStream(session);
  }

  async removeViewer(session: SessionBrowser, socket: PluginChannelSocket): Promise<void> {
    session.viewers.delete(socket);
    await this.syncStream(session);
  }

  /** Frames of the active tab while someone watches; one screencast per conversation. */
  async syncStream(session: SessionBrowser): Promise<void> {
    const page = session.viewers.size && session.active ? session.tabs.get(session.active)?.page : undefined;
    if (session.stream?.page === page) return;
    const previous = session.stream;
    session.stream = undefined;
    if (previous) await previous.dispose().catch(() => undefined);
    if (!page || page.isClosed()) return;
    const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
    try {
      const recording = await page.screencast.start({
        quality: 70, size: viewport,
        onFrame: ({ data }) => {
          if (session.stream?.page !== page) return;
          session.lastFrame = data;
          for (const viewer of session.viewers) if (viewer.bufferedAmount < VIEWER_BUFFER_LIMIT) viewer.send(data);
        },
      });
      const actions = async (on: boolean) => { await (on ? page.screencast.showActions({ cursor: 'pointer' }) : page.screencast.hideActions()).catch(() => undefined); };
      if (!session.quietUntil) await actions(true);
      session.stream = { page, actions, dispose: async () => { await page.screencast.hideActions().catch(() => undefined); await recording.dispose().catch(() => undefined); } };
    } catch (error) { this.host.logger?.warn(`screencast failed: ${String(error)}`); }
  }
}
