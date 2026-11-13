import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { cp, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PluginManifest } from '@riffet/plugin-api';
import { PLUGIN_ID } from '../../../../packages/contracts/src/index.js';
import { AppearanceService } from '../appearance/index.js';
import { AppError } from '../errors.js';
import { migratePluginStorage } from '../compat.js';
import { apiVersionProblem, checkManifest } from '../plugins/declarations.js';
import { MANIFEST_FILE, confined, readPackage } from '../plugins/development.js';
import { MAX_ARCHIVE_BYTES, integrityOf, readArchive, readDirectory, reroot, writeFiles, type PackageFile } from './archive.js';
import { installedModelSourceProblem, referencedFiles, requestedCapabilities, serverIncompatibility } from './compat.js';

// Installed packages (docs/PLUGIN_ARCHITECTURE.md "独立包"): `<stateDir>/plugins/<id>/<version>/` holds the
// files, `installed.json` records which versions exist and which one is selected, and a plugin's data
// lives apart in `<stateDir>/plugin-data/<id>/` so that neither a new version nor an uninstall can
// touch it. Nothing in a package is executed here; the registry chooses its loader from the install record.

export interface VersionRecord { version: string; source: string; integrity: string; installedAt: string; capabilities: string[]; trusted?: boolean }
export interface PluginRecord { id: string; versions: VersionRecord[]; selected: string; lastActivated?: string }
interface Document { version: 1; plugins: PluginRecord[] }

export interface StagedPackage {
  directory: string;
  manifest: PluginManifest;
  entries: { server?: string; web?: string };
  integrity: string;
  capabilities: string[];
  /** Chosen by the operator, never read from the package manifest. */
  trusted?: boolean;
}
export type PackageInput = { archive: Buffer } | { path: string };

export const DATA_VERSION_FILE = '.riffet-data-version';

/** A download from the plugin index is the release the index lists, with the content it vouches for, or nothing is installed. */
export function checkExpected(staged: StagedPackage, expected: { id: string; version: string; integrity: string }): void {
  if (String(staged.manifest.id) !== expected.id || staged.manifest.version !== expected.version) {
    throw new AppError('PLUGIN_MARKET_MISMATCH', `the download is ${String(staged.manifest.id)} ${staged.manifest.version}, not ${expected.id} ${expected.version}`, 422);
  }
  if (staged.integrity !== expected.integrity) throw new AppError('PLUGIN_MARKET_MISMATCH', `the content of ${expected.id} ${expected.version} differs from what the plugin index lists`, 422);
}
const MAX_BACKUPS = 2;
/** The data directory is the package's to write: the marker in it is never followed through a link it made. */
const MARKER_WRITE = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const corrupt = () => new AppError('PLUGINS_STATE_CORRUPT', 'plugins/installed.json is unreadable; fix or remove it', 500);
const invalid = (message: string, code = 'PLUGIN_PACKAGE_INVALID', status = 422) => new AppError(code, message, status);

/**
 * Everything about a package directory that can be checked without running it: the manifest, its entries, the
 * declarations and the files they name. What an install checks and what `scripts/pack-plugin.ts` checks.
 * Packaging can inspect trusted contributions without granting execution trust; only the operator install option does that.
 */
export async function inspectPackage(directory: string, options: { agents?: 'allow'; trusted?: boolean } = {}): Promise<{ manifest: PluginManifest; entries: { server?: string; web?: string }; capabilities: string[] }> {
  const read = await readPackage(directory);
  if ('reason' in read) throw invalid(read.reason);
  const { root, manifest, entries } = read;
  const id = String(manifest.id);
  if (!PLUGIN_ID.test(id) || id.length > 64) throw invalid(`"${id.slice(0, 80)}" is not a valid plugin id`);
  const versionProblem = apiVersionProblem(manifest.apiVersion);
  if (versionProblem) throw invalid(versionProblem, 'PLUGIN_INCOMPATIBLE', 409);
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) throw invalid('version must be a semantic version');
  const problem = checkManifest(manifest, 'load');
  if (problem) throw invalid(problem);
  const incompatible = serverIncompatibility(manifest);
  if (incompatible) throw invalid(incompatible, 'PLUGIN_INCOMPATIBLE', 409);
  for (const path of [...referencedFiles(manifest), ...Object.values(entries)]) if (!await confined(root, path)) throw invalid(`${path} is declared but is not a file in the package`);
  // The catalog quietly leaves out an asset it refuses; a package whose assets it would refuse does not get in.
  if (manifest.contributes?.appearance) {
    const problems = await new AppearanceService({ appearanceSources: () => [] }).problems({ id, appearance: manifest.contributes.appearance, root });
    if (problems.length) throw invalid(`appearance asset ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`);
  }
  const capabilities = requestedCapabilities(manifest);
  if (!options.trusted) {
    const required = manifest.requiresTrustedHost || id.startsWith('riffet.') || manifest.contributes?.sharePublisher
      || (options.agents !== 'allow' && manifest.contributes?.agentBackends?.length)
      || manifest.contributes?.modelSources?.some(source => installedModelSourceProblem(id, source.id));
    if (required) throw new AppError('PLUGIN_TRUST_REQUIRED', `${id} requires Riffet's in-process host permissions; explicitly trust it on the service machine (CLI: --trusted)`, 409, { id, version: manifest.version!, capabilities, trustedRequired: true });
  }
  return { manifest, entries, capabilities };
}

export class PackageStore {
  readonly root: string;
  readonly file: string;
  private readonly dataRoot: string;
  private document?: Document;
  /** Versions that were uninstalled while something still used them: their files go once nothing does. */
  private readonly deferred = new Map<string, { id: string; version: string; directory: string }>();

  constructor(private readonly stateDir: string) {
    migratePluginStorage(stateDir);
    this.root = join(stateDir, 'plugins');
    this.file = join(this.root, 'installed.json');
    this.dataRoot = join(stateDir, 'plugin-data');
  }

  records(): readonly PluginRecord[] { return this.read().plugins; }
  record(id: string): PluginRecord | undefined { return this.read().plugins.find(item => item.id === id); }
  versionDirectory(id: string, version: string): string { return join(this.root, id, version); }

  // ── Staging ────────────────────────────────────────────────────────────────

  /** Brings a package into a temporary directory and checks everything about it that can be checked without running it. */
  async stage(input: PackageInput, options: { trusted?: boolean } = {}): Promise<StagedPackage> {
    let files: PackageFile[];
    if ('archive' in input) files = readArchive(input.archive);
    else {
      const info = await stat(input.path).catch(() => undefined);
      if (!info) throw invalid('the path does not exist', 'PLUGIN_PACKAGE_INVALID', 404);
      if (info.isDirectory()) files = await readDirectory(input.path);
      else if (info.isFile() && info.size <= MAX_ARCHIVE_BYTES) files = readArchive(await readFile(input.path));
      else throw invalid('the path must be a directory or a .tgz, .tar.gz, .tar or .zip file');
    }
    files = reroot(files, MANIFEST_FILE);
    const directory = join(this.root, '.staging', randomUUID());
    try {
      await writeFiles(directory, files);
      return await this.inspect(directory, files, options.trusted === true);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private async inspect(directory: string, files: readonly PackageFile[], trusted: boolean): Promise<StagedPackage> {
    return { directory, ...await inspectPackage(directory, { trusted }), integrity: integrityOf(files), ...(trusted ? { trusted: true } : {}) };
  }

  async discard(staged: StagedPackage): Promise<void> { await rm(staged.directory, { recursive: true, force: true }); }

  // ── Records ────────────────────────────────────────────────────────────────

  /**
   * Moves a staged package into place and records it. The same version with the same content is
   * already installed (`present`); the same version with other content is a conflict and changes nothing.
   */
  async commit(staged: StagedPackage, source: string, select: boolean): Promise<{ status: 'added' | 'present'; record: PluginRecord }> {
    const id = String(staged.manifest.id);
    const version = staged.manifest.version!;
    const current = this.read();
    const existing = current.plugins.find(item => item.id === id);
    const same = existing?.versions.find(item => item.version === version);
    if (same) {
      await this.discard(staged);
      if (same.integrity !== staged.integrity) throw new AppError('PLUGIN_VERSION_CONFLICT', `${id} ${version} is already installed with different content; a changed package needs a new version`, 409);
      if (Boolean(same.trusted) !== Boolean(staged.trusted)) throw new AppError('PLUGIN_TRUST_CONFLICT', `${id} ${version} is already installed with a different execution trust; uninstall that version before changing its trust`, 409);
      return { status: 'present', record: existing! };
    }
    const destination = this.versionDirectory(id, version);
    // A directory nobody records is what an interrupted install or uninstall left behind.
    await rm(destination, { recursive: true, force: true });
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await rename(staged.directory, destination);
    const added: VersionRecord = { version, source, integrity: staged.integrity, installedAt: new Date().toISOString(), capabilities: staged.capabilities, ...(staged.trusted ? { trusted: true } : {}) };
    const record: PluginRecord = existing
      ? { ...existing, versions: [...existing.versions, added], selected: select ? version : existing.selected }
      : { id, versions: [added], selected: version };
    try { this.write({ ...current, plugins: [...current.plugins.filter(item => item.id !== id), record] }); }
    catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
    return { status: 'added', record };
  }

  /**
   * One recorded version read back from disk: the manifest, the files and their content must still be
   * what was installed, since nothing else vouches for them between installs.
   */
  async load(id: string, version: string): Promise<{ manifest: PluginManifest; entries: StagedPackage['entries']; root: string; record: VersionRecord } | { reason: string }> {
    const record = this.record(id)?.versions.find(item => item.version === version);
    if (!record) return { reason: 'that version is not installed' };
    let read: Awaited<ReturnType<typeof readPackage>>;
    let files: PackageFile[];
    try { read = await readPackage(this.versionDirectory(id, version)); files = await readDirectory(this.versionDirectory(id, version)); }
    catch (error) { return { reason: `the package could not be read (${error instanceof Error ? error.message : String(error)})` }; }
    if ('reason' in read) return { reason: read.reason };
    const { manifest, entries, root } = read;
    if (integrityOf(reroot(files, MANIFEST_FILE)) !== record.integrity) return { reason: 'the files changed since they were installed' };
    if (manifest.id !== id || manifest.version !== version) return { reason: 'the manifest names a different id or version than the record' };
    if (!record.trusted && (manifest.requiresTrustedHost || manifest.contributes?.sharePublisher)) return { reason: 'this package requires an explicitly trusted installation' };
    if (!record.trusted && id.startsWith('riffet.')) return { reason: 'the riffet. namespace requires an explicitly trusted installation' };
    if (!record.trusted && manifest.contributes?.agentBackends?.length) return { reason: 'agent backends require an explicitly trusted installation' };
    if (!record.trusted) for (const source of manifest.contributes?.modelSources ?? []) {
      const problem = installedModelSourceProblem(id, source.id);
      if (problem) return { reason: problem };
    }
    const requested = requestedCapabilities(manifest);
    const granted = [...record.capabilities].sort();
    if (requested.length !== granted.length || requested.some((item, index) => item !== granted[index])) return { reason: 'its capabilities differ from what was granted' };
    return { manifest, entries, root, record };
  }

  /** Puts a staged copy in place of a recorded version's damaged files, when it is the same content the record vouches for. */
  async restore(staged: StagedPackage): Promise<boolean> {
    const id = String(staged.manifest.id);
    const version = staged.manifest.version!;
    const recorded = this.record(id)?.versions.find(item => item.version === version);
    if (recorded?.integrity !== staged.integrity || Boolean(recorded.trusted) !== Boolean(staged.trusted)) return false;
    const destination = this.versionDirectory(id, version);
    await rm(destination, { recursive: true, force: true });
    await rename(staged.directory, destination);
    return true;
  }

  select(id: string, version: string): void {
    const current = this.read();
    const record = current.plugins.find(item => item.id === id);
    if (!record?.versions.some(item => item.version === version)) throw new AppError('PLUGIN_VERSION_NOT_FOUND', 'That version is not installed', 404);
    this.write({ ...current, plugins: current.plugins.map(item => item.id === id ? { ...item, selected: version } : item) });
  }

  /** The most recent version whose activation committed, for deferred upgrade recovery after restart. */
  markActivated(id: string, version: string): void {
    const current = this.read();
    const record = current.plugins.find(item => item.id === id);
    if (!record || record.lastActivated === version) return;
    if (!record.versions.some(item => item.version === version)) throw new AppError('PLUGIN_VERSION_NOT_FOUND', 'That version is not installed', 404);
    this.write({ ...current, plugins: current.plugins.map(item => item.id === id ? { ...item, lastActivated: version } : item) });
  }

  /** Forgets one version or all versions; files are `retire`d separately and data is retained. */
  forget(id: string, version?: string): void {
    const current = this.read();
    const record = current.plugins.find(item => item.id === id);
    if (!record) throw new AppError(version === undefined ? 'PLUGIN_NOT_INSTALLED' : 'PLUGIN_VERSION_NOT_FOUND', 'This plugin is not installed', 404);
    if (version === undefined) { this.write({ ...current, plugins: current.plugins.filter(item => item.id !== id) }); return; }
    if (!record.versions.some(item => item.version === version)) throw new AppError('PLUGIN_VERSION_NOT_FOUND', 'That version is not installed', 404);
    const versions = record.versions.filter(item => item.version !== version);
    const plugins = current.plugins.filter(item => item.id !== id);
    const newest = [...versions].sort((a, b) => (a.installedAt < b.installedAt ? 1 : -1))[0];
    this.write({ ...current, plugins: versions.length ? [...plugins, { ...record, versions, lastActivated: record.lastActivated === version ? undefined : record.lastActivated, selected: record.selected === version ? newest!.version : record.selected }] : plugins });
  }

  get hasDeferred(): boolean { return this.deferred.size > 0; }

  /** Deletes a forgotten version's files, or leaves them until `prune` finds nothing using them. */
  async retire(id: string, version: string, busy: (id: string, version: string) => boolean): Promise<boolean> {
    const directory = this.versionDirectory(id, version);
    if (busy(id, version)) { this.deferred.set(directory, { id, version, directory }); return false; }
    await this.remove(id, directory);
    return true;
  }

  /** Removes what `retire` deferred, and anything in `plugins/` that no record names. */
  async prune(busy: (id: string, version: string) => boolean): Promise<void> {
    for (const item of [...this.deferred.values()]) {
      // Installed again meanwhile: the files are in use as a version again.
      if (this.record(item.id)?.versions.some(entry => entry.version === item.version)) { this.deferred.delete(item.directory); continue; }
      if (busy(item.id, item.version)) continue;
      this.deferred.delete(item.directory);
      await this.remove(item.id, item.directory);
    }
    const recorded = this.records();
    await rm(join(this.root, '.staging'), { recursive: true, force: true });
    for (const plugin of await readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (!plugin.isDirectory() || plugin.name.startsWith('.')) continue;
      const record = recorded.find(item => item.id === plugin.name);
      for (const version of await readdir(join(this.root, plugin.name), { withFileTypes: true }).catch(() => [])) {
        if (record?.versions.some(item => item.version === version.name) || busy(plugin.name, version.name)) continue;
        await this.remove(plugin.name, join(this.root, plugin.name, version.name));
      }
    }
  }

  private async remove(id: string, directory: string): Promise<void> {
    await rm(directory, { recursive: true, force: true });
    const parent = join(this.root, id);
    if (!(await readdir(parent).catch(() => ['.'])).length) await rm(parent, { recursive: true, force: true });
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  dataDirectory(id: string): string { return join(this.dataRoot, id); }

  /** Backups of a plugin's data directory, newest data version first. */
  async backups(id: string): Promise<Array<{ name: string; version: number }>> {
    const pattern = new RegExp(`^${id.replace(/[.\\^$*+?()[\]{}|]/g, '\\$&')}\\.backup-v(\\d+)$`);
    const names = await readdir(this.dataRoot).catch(() => [] as string[]);
    return names.flatMap(name => { const match = pattern.exec(name); return match ? [{ name, version: Number(match[1]) }] : []; }).sort((a, b) => b.version - a.version);
  }

  async dataVersion(id: string): Promise<number | undefined> {
    const handle = await open(join(this.dataDirectory(id), DATA_VERSION_FILE), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
    let text: string | undefined;
    if (handle) {
      try { const buffer = Buffer.alloc(32); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); text = buffer.toString('utf8', 0, bytesRead); }
      catch { /* not a readable file */ } finally { await handle.close(); }
    }
    const value = text === undefined ? NaN : Number(text.trim());
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }

  /**
   * Called before a version that declares `dataVersion` starts. Data at a lower version is copied to
   * `<id>.backup-v<old>` first (two backups are kept) and then marked; data at a higher version means
   * this version is older than what wrote it, so it must not run on it, and the error names the backup to restore.
   */
  async prepareData(id: string, dataVersion: number): Promise<void> {
    const directory = this.dataDirectory(id);
    const exists = await stat(directory).then(info => info.isDirectory(), () => false);
    const marker = join(directory, DATA_VERSION_FILE);
    if (!exists) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(marker, `${dataVersion}\n`, { mode: 0o600, flag: MARKER_WRITE });
      return;
    }
    let recorded = await this.dataVersion(id);
    if (recorded === undefined) recorded = (await readdir(directory)).length ? 0 : dataVersion;
    if (recorded === dataVersion) { await writeFile(marker, `${dataVersion}\n`, { mode: 0o600, flag: MARKER_WRITE }); return; }
    if (recorded > dataVersion) {
      const usable = (await this.backups(id)).find(item => item.version <= dataVersion);
      throw new AppError('PLUGIN_DATA_NEWER', usable
        ? `its data was written by a newer version (data v${recorded}; this version uses v${dataVersion}); to go back, move ${join(this.dataRoot, usable.name)} to ${directory} and select this version again`
        : `its data was written by a newer version (data v${recorded}; this version uses v${dataVersion}) and no backup of an older format exists; select a newer version, or delete the plugin's data`, 409);
    }
    const backup = join(this.dataRoot, `${id}.backup-v${recorded}`);
    const pending = `${backup}.${randomUUID()}.tmp`;
    try {
      await cp(directory, pending, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      await rm(backup, { recursive: true, force: true });
      await rename(pending, backup);
    } catch (error) {
      await rm(pending, { recursive: true, force: true });
      throw new AppError('PLUGIN_DATA_BACKUP_FAILED', `the data could not be backed up before upgrading it (${error instanceof Error ? error.message : String(error)}); nothing was changed`, 500);
    }
    await writeFile(marker, `${dataVersion}\n`, { mode: 0o600, flag: MARKER_WRITE });
    for (const old of (await this.backups(id)).slice(MAX_BACKUPS)) await rm(join(this.dataRoot, old.name), { recursive: true, force: true });
  }

  /**
   * Undoes what a version that failed to start did to the data. When its `prepareData` moved the data past
   * `before` (the format the version that ran until then left), the backup that was made of format `before` goes back
   * in place of the migrated data, so that version can start again; the backup is used up (the next upgrade makes it
   * again). Does nothing, and says so, when the format did not move or no such backup exists: the previous version
   * then reports the newer format as it would have anyway.
   */
  async rollbackData(id: string, before: number | undefined): Promise<boolean> {
    if (before === undefined) return false;
    const now = await this.dataVersion(id);
    if (now === undefined || now <= before) return false;
    const backup = join(this.dataRoot, `${id}.backup-v${before}`);
    if (!await stat(backup).then(info => info.isDirectory(), () => false)) return false;
    const directory = this.dataDirectory(id);
    const aside = `${directory}.${randomUUID()}.failed`;
    try {
      await rename(directory, aside);
      try { await rename(backup, directory); }
      catch (error) { await rename(aside, directory); throw error; }
      await rm(aside, { recursive: true, force: true });
      return true;
    } catch (error) {
      console.warn(`[riffet] the data of ${id} could not be put back to format ${before}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async hasData(id: string): Promise<boolean> {
    return stat(this.dataDirectory(id)).then(info => info.isDirectory(), () => false);
  }

  /** The plugin's data directory and its backups. Settings and secrets are not data: they stay in plugins.json. */
  async deleteData(id: string): Promise<void> {
    await rm(this.dataDirectory(id), { recursive: true, force: true });
    for (const backup of await this.backups(id)) await rm(join(this.dataRoot, backup.name), { recursive: true, force: true });
  }

  // ── installed.json ─────────────────────────────────────────────────────────

  private read(): Document {
    if (this.document) return this.document;
    let text: string;
    try { text = readFileSync(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw corrupt();
      return (this.document = { version: 1, plugins: [] });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw corrupt(); }
    const document = parsed as Partial<Document> | null;
    if (!document || typeof document !== 'object' || document.version !== 1 || !Array.isArray(document.plugins)) throw corrupt();
    const text1 = (value: unknown) => typeof value === 'string' && value.length > 0;
    for (const plugin of document.plugins) {
      if (!plugin || !text1(plugin.id) || !text1(plugin.selected) || !Array.isArray(plugin.versions) || !plugin.versions.length) throw corrupt();
      for (const version of plugin.versions) {
        if (!version || !text1(version.version) || !text1(version.source) || !text1(version.integrity) || !text1(version.installedAt) || !Array.isArray(version.capabilities) || version.capabilities.some(item => typeof item !== 'string') || (version.trusted !== undefined && typeof version.trusted !== 'boolean')) throw corrupt();
      }
      if (!plugin.versions.some(version => version.version === plugin.selected)) throw corrupt();
      if (plugin.lastActivated !== undefined && !plugin.versions.some(version => version.version === plugin.lastActivated)) throw corrupt();
    }
    return (this.document = document as Document);
  }

  private write(document: Document): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`);
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      chmodSync(temp, 0o600);
      renameSync(temp, this.file);
      this.document = document;
    } catch {
      if (fd !== undefined) try { closeSync(fd); } catch { /* already failing */ }
      try { unlinkSync(temp); } catch { /* may not exist */ }
      throw new AppError('PLUGINS_WRITE_FAILED', 'The installed packages could not be recorded', 500);
    }
  }
}
