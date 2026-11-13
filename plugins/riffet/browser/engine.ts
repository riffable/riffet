// Chromium through playwright-core (docs/BROWSER.md §3): which browser, where it is installed, and one persistent
// context per project. Playwright is loaded on first use, so turning the plugin on costs nothing until a browser is
// needed.

import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright-core';

type Playwright = typeof import('playwright-core');

const require = createRequire(import.meta.url);

/** The `browser` setting: empty or `bundled` for the Chromium this plugin downloads, `chrome` / `msedge` for an installed channel, or `custom` for `executablePath`. */
export type BrowserChoice = { kind: 'bundled' } | { kind: 'channel'; channel: 'chrome' | 'msedge' } | { kind: 'path'; path: string };

export function browserChoice(settings: Readonly<Record<string, string>>): BrowserChoice {
  const value = (settings.browser ?? '').trim();
  if (value === 'chrome' || value === 'msedge') return { kind: 'channel', channel: value };
  if (value === 'custom') return { kind: 'path', path: (settings.executablePath ?? '').trim() };
  return { kind: 'bundled' };
}

export function describeChoice(choice: BrowserChoice): string {
  return choice.kind === 'bundled' ? 'Chromium (downloaded by Riffet)' : choice.kind === 'channel' ? (choice.channel === 'chrome' ? 'Google Chrome' : 'Microsoft Edge') : choice.path || 'A browser at a path';
}

/** The headless shell revision this playwright-core drives. */
function headlessRevision(): string | undefined {
  try {
    const browsers = require('playwright-core/browsers.json') as { browsers: Array<{ name: string; revision: string }> };
    return browsers.browsers.find(item => item.name === 'chromium-headless-shell')?.revision;
  } catch { return undefined; }
}

/** Default install locations of the channels; Playwright knows them too, this only answers "is it there". */
const CHANNEL_PATHS: Record<string, Partial<Record<NodeJS.Platform, string[]>>> = {
  chrome: {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/opt/google/chrome/chrome'],
    win32: [`${process.env.PROGRAMFILES ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`],
  },
  msedge: {
    darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    linux: ['/opt/microsoft/msedge/msedge'],
    win32: [`${process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`],
  },
};

export class Engine {
  private playwright?: Promise<Playwright>;

  constructor(readonly browsersDir: string) {}

  /** Whether the chosen browser is on this machine. */
  installed(choice: BrowserChoice): boolean {
    if (choice.kind === 'path') return Boolean(choice.path) && existsSync(choice.path);
    if (choice.kind === 'channel') return (CHANNEL_PATHS[choice.channel]?.[process.platform] ?? []).some(path => existsSync(path));
    const revision = headlessRevision();
    if (!revision) return false;
    try {
      return readdirSync(this.browsersDir).some(name => name === `chromium_headless_shell-${revision}` && existsSync(join(this.browsersDir, name, 'INSTALLATION_COMPLETE')));
    } catch { return false; }
  }

  /** `node <playwright-core>/cli.js install chromium-headless-shell`, into this plugin's own directory. */
  installCommand(): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
    return { file: process.execPath, args: [require.resolve('playwright-core/cli.js'), 'install', 'chromium-headless-shell'], env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: this.browsersDir } };
  }

  /**
   * Playwright reads `PLAYWRIGHT_BROWSERS_PATH` once, when its registry first initialises. It is set for that moment only
   * and removed again, so the agents and terminals the server starts later do not inherit Riffet's browser directory.
   */
  private load(): Promise<Playwright> {
    this.playwright ??= (async () => {
      const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
      process.env.PLAYWRIGHT_BROWSERS_PATH = this.browsersDir;
      try {
        const module = await import('playwright-core');
        try { module.chromium.executablePath(); } catch { /* only to initialise the registry */ }
        return module;
      } finally {
        if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH; else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
      }
    })();
    return this.playwright;
  }

  /** The browser's own user agent with `HeadlessChrome` read as `Chrome`, by executable; learnt on its first launch. */
  private readonly userAgents = new Map<string, string>();

  /**
   * A persistent, headless context on `profileDir`. CDP runs over a pipe (Playwright's default): no debugging port is opened.
   *
   * Sign-in pages (Google's among them) refuse a browser that announces automation, so it does not: no
   * `--enable-automation`, `navigator.webdriver` stays false, and the user agent is the one a windowed Chrome of the same
   * version sends.
   * The user agent is only known once the browser runs, so the first launch of each browser in the server's life is
   * done twice.
   */
  async launch(choice: BrowserChoice, profileDir: string): Promise<BrowserContext> {
    const { chromium } = await this.load();
    const key = choice.kind === 'bundled' ? 'bundled' : choice.kind === 'channel' ? choice.channel : choice.path;
    const open = (userAgent?: string) => chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled', ...(userAgent ? [`--user-agent=${userAgent}`] : [])],
      ...(choice.kind === 'channel' ? { channel: choice.channel } : choice.kind === 'path' ? { executablePath: choice.path } : {}),
    });
    const known = this.userAgents.get(key);
    const context = await open(known);
    let userAgent: string | undefined;
    if (known) {
      // The browser may have updated itself since: the major version follows it.
      const major = context.browser()?.version().split('.')[0];
      if (!major || known.includes(`Chrome/${major}.`)) return context;
      userAgent = known.replace(/Chrome\/\d+/, `Chrome/${major}`);
    } else {
      const own = await context.pages()[0]?.evaluate(() => navigator.userAgent).catch(() => undefined);
      if (!own || !own.includes('HeadlessChrome/')) return context;
      userAgent = own.replace('HeadlessChrome/', 'Chrome/');
    }
    this.userAgents.set(key, userAgent);
    await context.close().catch(() => undefined);
    return open(userAgent);
  }
}
