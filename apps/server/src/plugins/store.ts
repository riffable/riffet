import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { PluginEnablement } from '../../../../packages/contracts/src/index.js';
import { PLUGIN_ID } from '../../../../packages/contracts/src/plugins.js';
import { AppError } from '../errors.js';
import { migratePluginStorage } from '../compat.js';
import type { StoredSource } from '../plugins-host/market.js';

export interface PluginItem { enablement: PluginEnablement; settings: Record<string, string>; secrets: Record<string, string> }
export interface PluginItemPatch { enablement?: PluginEnablement; settings?: Record<string, string | null>; secrets?: Record<string, string | null> }
interface Document { version: 1; items: Record<string, Record<string, unknown>>; defaultSharePublisher?: string; recovery?: boolean; development?: Record<string, string>; excludedDevelopment?: string[]; sources?: StoredSource[] }

const ENABLEMENTS: readonly PluginEnablement[] = ['auto', 'on', 'off'];

function strings(value: unknown): value is Record<string, string> {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string');
}

function corrupt(): AppError {
  return new AppError('INTEGRATIONS_STATE_CORRUPT', 'plugins.json is unreadable; fix or remove it', 500);
}

/**
 * `<stateDir>/plugins.json`: per-plugin enablement, settings and secrets.
 *
 * Separate from settings.json, whose validator rejects unknown keys, and keyed by plugin id so a
 * build without some plugin keeps their entries untouched. `defaultSharePublisher` is the one
 * choice that belongs to no single integration: where new shares go when several can publish. A file
 * this version cannot read is never overwritten: every read and write fails instead, so the user's
 * secrets survive to be fixed.
 */
export class PluginStore {
  readonly path: string;
  private document?: Document;
  // Also used by doctor and tests without createApp; adopt old storage before the first read.
  constructor(private readonly stateDir: string) { migratePluginStorage(stateDir); this.path = join(stateDir, 'plugins.json'); }

  enablement(id: string): PluginEnablement {
    return (this.read().items[id]?.enablement as PluginEnablement | undefined) ?? 'auto';
  }

  item(id: string): PluginItem {
    const raw = this.read().items[id];
    return {
      enablement: (raw?.enablement as PluginEnablement | undefined) ?? 'auto',
      settings: { ...(raw?.settings as Record<string, string> | undefined) },
      secrets: { ...(raw?.secrets as Record<string, string> | undefined) },
    };
  }

  recovery(): boolean { try { return this.read().recovery === true; } catch { return false; } }
  setRecovery(enabled: boolean): void { const document = { ...this.read(), recovery: enabled }; this.write(document); this.document = document; }

  /** Explicit local development links, kept across a server restart. */
  developmentPackages(): Record<string, string> { return { ...this.read().development }; }

  /** Canonical source directories removed from automatic discovery on this service. */
  excludedDevelopmentDirectories(): string[] { return [...this.read().excludedDevelopment ?? []]; }

  setDevelopmentPackage(id: string, path: string | null): void {
    if (!PLUGIN_ID.test(id) || id.length > 64 || (path !== null && (!isAbsolute(path) || path.includes('\0')))) throw new AppError('INVALID_INPUT', 'Expected a plugin id and an absolute development package path');
    const current = this.read();
    const development = { ...current.development };
    if (path === null) delete development[id];
    else development[id] = path;
    const document: Document = { ...current, development, ...(path !== null && current.excludedDevelopment ? { excludedDevelopment: current.excludedDevelopment.filter(directory => directory !== path) } : {}) };
    this.write(document);
    this.document = document;
  }

  /** Remove a saved link and suppress environment discovery together, preserving its configuration. */
  removeDevelopmentPackage(id: string, path: string): void {
    if (!isAbsolute(path) || path.includes('\0')) throw new AppError('INVALID_INPUT', 'Expected an absolute development package path');
    const current = this.read();
    const development = { ...current.development };
    if (development[id] === path) delete development[id];
    const document: Document = { ...current, development, excludedDevelopment: [...new Set([...current.excludedDevelopment ?? [], path])] };
    this.write(document);
    this.document = document;
  }

  /** Plugin indexes added to this server, and whether the built-in one is off (an entry with id `riffet`); docs/PLUGINS.md「插件市场」. */
  sources(): StoredSource[] { return (this.read().sources ?? []).map(item => ({ ...item })); }

  setSources(sources: StoredSource[]): void {
    const { sources: _previous, ...rest } = this.read();
    const document: Document = { ...rest, ...(sources.length ? { sources } : {}) };
    this.write(document);
    this.document = document;
  }

  revision(id: string): string { const value = this.read().items[id]?.revision; return typeof value === 'string' ? value : '0'; }

  /** The plugin the user chose for new shares, if any; it may not be enabled now. */
  defaultSharePublisher(): string | undefined { return this.read().defaultSharePublisher; }

  setDefaultSharePublisher(id: string | null): void {
    const { defaultSharePublisher: _previous, ...rest } = this.read();
    const document: Document = { ...rest, ...(id ? { defaultSharePublisher: id } : {}) };
    this.write(document);
    this.document = document;
  }

  update(id: string, patch: PluginItemPatch): PluginItem {
    const current = this.read();
    const raw = { ...current.items[id] };
    if (patch.enablement) raw.enablement = patch.enablement;
    for (const key of ['settings', 'secrets'] as const) {
      const changes = patch[key];
      if (!changes) continue;
      const next = { ...(raw[key] as Record<string, string> | undefined) };
      for (const [name, value] of Object.entries(changes)) {
        if (value === null) delete next[name];
        else next[name] = value;
      }
      raw[key] = next;
    }
    raw.revision = randomUUID();
    const document: Document = { ...current, items: { ...current.items, [id]: raw } };
    this.write(document);
    this.document = document;
    return this.item(id);
  }

  private read(): Document {
    if (this.document) return this.document;
    let text: string;
    try { text = readFileSync(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw corrupt();
      return (this.document = { version: 1, items: {} });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw corrupt(); }
    const document = parsed as Partial<Document> | null;
    if (!document || typeof document !== 'object' || document.version !== 1 || !document.items || typeof document.items !== 'object' || Array.isArray(document.items)) throw corrupt();
    if (document.recovery !== undefined && typeof document.recovery !== 'boolean') throw corrupt();
    if (document.defaultSharePublisher !== undefined && typeof document.defaultSharePublisher !== 'string') throw corrupt();
    if (document.development !== undefined && (!strings(document.development) || Object.entries(document.development).some(([id, path]) => !PLUGIN_ID.test(id) || id.length > 64 || !isAbsolute(path) || path.includes('\0')))) throw corrupt();
    if (document.excludedDevelopment !== undefined && (!Array.isArray(document.excludedDevelopment) || document.excludedDevelopment.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')))) throw corrupt();
    if (document.sources !== undefined) {
      const ids = new Set<string>();
      for (const item of Array.isArray(document.sources) ? document.sources : [undefined]) {
        const source = item as Record<string, unknown> | undefined;
        if (!source || typeof source !== 'object' || Array.isArray(source) || typeof source.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(source.id) || ids.has(source.id)) throw corrupt();
        ids.add(source.id);
        if ((source.url !== undefined && typeof source.url !== 'string') || (source.id !== 'riffet' && !source.url) || (source.enabled !== undefined && typeof source.enabled !== 'boolean') || (source.addedAt !== undefined && typeof source.addedAt !== 'string')) throw corrupt();
      }
    }
    for (const raw of Object.values(document.items)) {
      // Unknown keys inside an item are kept: a newer Riffet may have added them.
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw corrupt();
      if (raw.enablement !== undefined && !ENABLEMENTS.includes(raw.enablement as PluginEnablement)) throw corrupt();
      if ((raw.settings !== undefined && !strings(raw.settings)) || (raw.secrets !== undefined && !strings(raw.secrets))) throw corrupt();
    }
    return (this.document = document as Document);
  }

  private write(document: Document): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`);
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      chmodSync(temp, 0o600);
      renameSync(temp, this.path);
    } catch {
      if (fd !== undefined) try { closeSync(fd); } catch { /* already failing */ }
      try { unlinkSync(temp); } catch { /* may not exist */ }
      throw new AppError('INTEGRATIONS_WRITE_FAILED', 'Plugin settings could not be saved', 500);
    }
  }
}
