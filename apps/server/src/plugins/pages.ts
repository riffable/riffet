import type { PluginPageProvider } from '@riffet/plugin-api';
import type { PluginPage, PluginPageResponse, PluginReadmeResponse } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { bounded, describeError, type Entry } from './entry.js';
import { builtinPackageRoot } from './package-root.js';
import { checkedPage, packageReadme, settingValue } from './page.js';

/** What a plugin's page and README need of the registry. */
export interface PagesPort {
  loading(): Promise<void>;
  require(id: string): Entry;
  events(entry: Entry): readonly string[];
  ensureEntry(entry: Entry, trigger: string): Promise<void>;
  guarded<T>(entry: Entry, run: () => Promise<T>, failureCode?: string): Promise<T>;
  update(id: string, input: unknown): Promise<unknown>;
  redact(id: string, text: string): string;
  item(id: string): { secrets: Record<string, string> };
}

export class Pages {
  constructor(private readonly port: PagesPort) {}

  /** The page as the plugin builds it now. Reading it activates a plugin that waits for a command or a view, as opening a view does. */
  async page(id: string, locale: string | undefined): Promise<PluginPageResponse> {
    await this.port.loading();
    const entry = this.port.require(id);
    return { page: await this.readPage(entry, await this.pageProvider(entry), locale) };
  }

  /** One change from the page: a setting saved as `update` saves it, or a button. Answers with the page read again. */
  async changePage(id: string, input: unknown): Promise<PluginPageResponse> {
    await this.port.loading();
    const entry = this.port.require(id);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('INVALID_INPUT', 'Expected a page change');
    const { locale, set, run, ...rest } = input as Record<string, unknown>;
    if (Object.keys(rest).length || (set === undefined) === (run === undefined)) throw new AppError('INVALID_INPUT', 'Expected one of set or run');
    if (locale !== undefined && typeof locale !== 'string') throw new AppError('INVALID_INPUT', 'locale must be text');
    const provider = await this.pageProvider(entry);
    const context = { locale: (locale as string | undefined) ?? '' };
    let message: string | undefined;
    if (set !== undefined) {
      if (!set || typeof set !== 'object' || typeof (set as { key?: unknown }).key !== 'string') throw new AppError('INVALID_INPUT', 'set needs a key and a value');
      const { key, value } = set as { key: string; value: unknown };
      let saved: string | null;
      try { saved = settingValue(value); } catch (error) { throw new AppError('INVALID_INPUT', describeError(error)); }
      await this.port.update(id, { settings: { [key]: saved } });
    } else {
      if (!run || typeof run !== 'object') throw new AppError('INVALID_INPUT', 'run needs an action');
      const { action, item } = run as { action?: unknown; item?: unknown };
      if (typeof action !== 'string' || !action || action.length > 64 || (item !== undefined && (typeof item !== 'string' || item.length > 512))) throw new AppError('INVALID_INPUT', 'run needs an action');
      if (!provider.run) throw new AppError('INTEGRATION_ACTION_NOT_FOUND', 'This page has no buttons', 404);
      const outcome = await this.port.guarded(entry, async () => provider.run!(context, action, item as string | undefined));
      if (outcome && typeof outcome.message === 'string' && outcome.message.trim()) message = this.port.redact(id, outcome.message.slice(0, 400));
    }
    // A change may have turned the plugin off (a setting its detection reads): the page is then not there to read.
    const now = entry.active?.contributions?.page;
    if (!now) throw new AppError('INTEGRATION_DISABLED', 'This plugin is off', 409);
    return { page: await this.readPage(entry, now, context.locale), ...(message ? { message } : {}) };
  }

  /** The README for `locale`: `README.<tag>.md`, else `README.md`, in the package's directory. Never runs the plugin. */
  async readme(id: string, locale: string | undefined): Promise<PluginReadmeResponse> {
    await this.port.loading();
    const entry = this.port.require(id);
    const root = entry.root ?? (entry.source === 'builtin' ? builtinPackageRoot(id) : undefined);
    const text = root ? await packageReadme(root, locale) : undefined;
    // The details already show the name: a first heading that only repeats it is left out.
    const { manifest } = entry.plugin;
    const names = new Set([manifest.name, manifest.id, ...Object.values(manifest.title ?? {})].map(name => name.trim().toLowerCase()));
    const heading = text?.match(/^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/);
    const readme = heading && names.has(heading[1]!.toLowerCase()) ? text!.slice(heading[0].length).trimStart() : text?.trimStart();
    return readme ? { readme } : {};
  }

  private async pageProvider(entry: Entry): Promise<PluginPageProvider> {
    const { manifest } = entry.plugin;
    if (!manifest.contributes?.page) throw new AppError('INTEGRATION_PAGE_NOT_FOUND', 'This plugin has no page', 404);
    if (!entry.active && (this.port.events(entry).includes('view') || this.port.events(entry).includes('command'))) await this.port.ensureEntry(entry, 'view:page');
    const provider = entry.active?.contributions?.page;
    if (!provider) throw new AppError('INTEGRATION_DISABLED', 'This plugin is off', 409);
    return provider;
  }

  private async readPage(entry: Entry, provider: PluginPageProvider, locale: string | undefined): Promise<PluginPage> {
    const { manifest } = entry.plugin;
    const settings = new Map((manifest.settings ?? []).map(field => [field.key, field.kind] as const));
    const secrets = (() => { try { return this.port.item(manifest.id).secrets; } catch { return {}; } })();
    return this.port.guarded(entry, async () => {
      let raw: unknown;
      await bounded(async () => { raw = await provider.read({ locale: locale ?? '' }); }, 10_000);
      return checkedPage(raw, settings, key => Boolean(secrets[key]));
    }, 'INTEGRATION_PAGE_FAILED');
  }
}
