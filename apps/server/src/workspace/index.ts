import { TASK_WORKSPACE_MARKER } from '../task-workspaces/identity.js';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { lstat, mkdir, open, opendir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Attachment, CodeDefinitions, CodeIndexStatus, CodeModules, CodeOutline, CodeReferences, CodeSymbolResults, FileEntry, FilePreview, SearchHit, SearchResults } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { collectArchiveEntries, gitArchiveEntries, rawFileType, readSample, siteFileType, zipStream, type RawFileType } from './download.js';
import { expandHomePath, projectRoot, isSecretPath, isWithin, resolveReadablePath, resolveScopedPath, toProjectRelative, type ProjectRef } from './scope.js';
import { FileIndex, rankPaths, ripgrepSearch, SEARCH_TIMEOUT_MS } from './file-index.js';
import { lineMatcher, maskMatcher, parseMasks, type SearchOptions } from './search-options.js';
import { CodeNav, findDefinitions, findReferences, type DefinitionQuery, type ReferenceQuery } from './code-nav.js';
import { decodePreviewText, MAX_PREVIEW_FILE_BYTES, previewKind } from '../previews/formats.js';
import { CODE_INDEX_BUDGET, FILE_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import { editableText, FileWrites } from './write.js';
import { modulesOf } from './modules.js';
import { SymbolIndexes } from './symbols/indexes.js';

const MAX_LIST_PAGE = 200;
const MAX_WALK_ENTRIES = 20_000;
const MAX_WALK_DEPTH = 24;
const MAX_DIRECTORY_SCAN = 20_000;
const MAX_SEARCH_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PREVIEW_BYTES = FILE_BUDGET.previewTextBytes;
const MAX_FILE_READ_BYTES = MAX_PREVIEW_FILE_BYTES;
const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage']);
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** MIME is inferred from file bytes so a misleading extension cannot turn arbitrary content into an image. */
export function previewImageMimeType(data: Buffer): string | undefined {
  if (data.length >= 24
    && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && data.readUInt32BE(8) === 13
    && data.subarray(12, 16).toString('ascii') === 'IHDR'
    && data.readUInt32BE(16) > 0
    && data.readUInt32BE(20) > 0) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (data.length >= 16 && data.subarray(4, 8).toString('ascii') === 'ftyp') {
    const boxSize = data.readUInt32BE(0);
    if (boxSize >= 16 && boxSize <= data.length) {
      const majorBrand = data.subarray(8, 12).toString('ascii');
      if (majorBrand === 'avif' || majorBrand === 'avis') return 'image/avif';
      for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
        const brand = data.subarray(offset, offset + 4).toString('ascii');
        if (brand === 'avif' || brand === 'avis') return 'image/avif';
      }
    }
  }
  if (data.length >= 26 && data.subarray(0, 2).toString('ascii') === 'BM') {
    const declaredSize = data.readUInt32LE(2);
    if (declaredSize >= 26 && declaredSize <= data.length) return 'image/bmp';
  }
  return undefined;
}

/** Validate uploaded and project images by their bytes before embedding them in an isolated preview. */
export function previewImageData(data: Buffer): { mimeType: string; data: Buffer } {
  if (data.length > MAX_ATTACHMENT_BYTES) throw new AppError('FILE_TOO_LARGE', 'Image exceeds the preview size limit', 413);
  const svg = data.subarray(0, 8192).toString('utf8');
  const svgImage = !/<!DOCTYPE/i.test(svg) && /^\uFEFF?\s*(?:<\?xml[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(svg);
  const mimeType = previewImageMimeType(data) ?? (svgImage ? 'image/svg+xml' : undefined);
  if (!mimeType) throw new AppError('UNSUPPORTED_IMAGE_PREVIEW', 'File is not a supported image', 415);
  return { mimeType, data };
}

interface ListQuery { path?: string; limit?: number; cursor?: string; offset?: number; }
interface FindQuery extends ListQuery { q?: string; }
type Query = string | ListQuery;

function pageArgs(query: ListQuery): { limit: number; offset: number } {
  const limit = Math.min(MAX_LIST_PAGE, Math.max(1, Number.isFinite(query.limit) ? Math.floor(query.limit!) : 100));
  let offset = Number.isFinite(query.offset) ? Math.max(0, Math.floor(query.offset!)) : 0;
  if (query.cursor) {
    try {
      const decoded = Buffer.from(query.cursor, 'base64url').toString('utf8');
      if (!/^\d+$/.test(decoded)) throw new Error('bad cursor');
      offset = Number(decoded);
    } catch { throw new AppError('INVALID_CURSOR', 'Pagination cursor is invalid'); }
  }
  if (!Number.isSafeInteger(offset) || offset < 0) throw new AppError('INVALID_CURSOR', 'Pagination cursor is invalid');
  return { limit, offset };
}

function asQuery(query?: Query): ListQuery {
  return typeof query === 'string' ? { path: query } : query ?? {};
}

async function readNamesBounded(directory: string, max: number, directoriesFirst = false): Promise<string[]> {
  const handle = await opendir(directory);
  const entries: { name: string; directory: boolean }[] = [];
  for await (const entry of handle) {
    if (entry.name === TASK_WORKSPACE_MARKER) continue;
    entries.push({ name: entry.name, directory: entry.isDirectory() });
    if (entries.length >= max) break;
  }
  entries.sort((a, b) => (directoriesFirst ? Number(b.directory) - Number(a.directory) : 0) || a.name.localeCompare(b.name, 'en'));
  return entries.map(entry => entry.name);
}

/** Up to `bytes` from the start of a file, however large it is. */
async function readFileHead(filePath: string, bytes: number): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function readFileBounded(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const initial = await handle.stat();
    if (!initial.isFile()) throw new AppError('NOT_A_FILE', 'Path is not a regular file');
    if (initial.size > maxBytes) throw new AppError('FILE_TOO_LARGE', `File exceeds the ${maxBytes} byte read limit`, 413);
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, Math.max(1, initial.size + 1)));
    let read = 0;
    while (read < buffer.length) {
      const result = await handle.read(buffer, read, buffer.length - read, read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    const final = await handle.stat();
    if (read > maxBytes || final.size > maxBytes) throw new AppError('FILE_TOO_LARGE', `File exceeds the ${maxBytes} byte read limit`, 413);
    if (read !== final.size) throw new AppError('FILE_CHANGED', 'File changed while it was being read; retry the request', 409);
    return buffer.subarray(0, read);
  } finally { await handle.close(); }
}

function parseCommand(command: string): string[] {
  if (!command.trim() || command.length > 2048 || /[\0\r\n;]/.test(command)) throw new AppError('INVALID_EDITOR_COMMAND', 'Editor command is invalid');
  const args: string[] = [];
  let word = '';
  let quote: 'single' | 'double' | undefined;
  let escaped = false;
  for (const char of command) {
    if (escaped) { word += char; escaped = false; continue; }
    if (char === '\\' && quote !== 'single') { escaped = true; continue; }
    if (quote === 'single') { if (char === "'") quote = undefined; else word += char; continue; }
    if (quote === 'double') { if (char === '"') quote = undefined; else word += char; continue; }
    if (char === "'") { quote = 'single'; continue; }
    if (char === '"') { quote = 'double'; continue; }
    if (/\s/.test(char)) { if (word) { args.push(word); word = ''; } continue; }
    word += char;
  }
  if (escaped || quote) throw new AppError('INVALID_EDITOR_COMMAND', 'Editor command has an unfinished quote or escape');
  if (word) args.push(word);
  if (!args.length) throw new AppError('INVALID_EDITOR_COMMAND', 'Editor command is invalid');
  return args;
}

function validId(id: string): boolean { return /^[a-f0-9-]{36}$/i.test(id); }

/** Largest pixel edge we accept for a declared image size; beyond this the value is junk. */
const MAX_ATTACHMENT_EDGE = 100_000;

/**
 * Normalize a client-declared image size into the stored metadata.
 * Both edges must be positive integers within range; anything else resolves to "unknown" so the
 * transcript falls back to measuring the decoded image instead of trusting a bogus box.
 */
function imageDimensions(width: unknown, height: unknown): { width: number; height: number } | Record<string, never> {
  const valid = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_ATTACHMENT_EDGE;
  return valid(width) && valid(height) ? { width: width as number, height: height as number } : {};
}

/** How long a native folder chooser may stay open before we give up on it. */
const DIRECTORY_PICKER_TIMEOUT_MS = 5 * 60 * 1000;

export interface DirectoryPickerCommand { command: string; args: string[]; }
export interface DirectoryPickResult { supported: boolean; cancelled: boolean; path?: string; }

/** Escape a value so it can be embedded inside an AppleScript string literal. */
function appleScriptLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * A dismissed chooser prints the sentinel on stdout and exits 0.
 *
 * Cancelling used to be recognised by reading osascript's stderr, which does not survive
 * translation: the message is localized, so a Chinese macOS cancelled just like a failure and
 * every dismissal fell through to the in-app browser. Catching AppleScript's own
 * userCanceledErr (-128) inside the script instead reports the dismissal in a way that is
 * locale-independent, and leaves real failures on the non-zero-exit path where they belong.
 */
export const PICKER_CANCEL_SENTINEL = '__riffet_picker_cancelled__';

/**
 * The native folder-chooser invocation for a platform, or undefined when the platform
 * has no chooser we can drive. Pure so the escaping and argument shape are testable
 * without opening a real dialog.
 */
export function directoryPickerCommand(platform: NodeJS.Platform, options: { prompt?: string; defaultPath?: string } = {}): DirectoryPickerCommand | undefined {
  const prompt = (options.prompt ?? '选择项目目录').replace(/[\0\r\n]/g, ' ').slice(0, 120);
  const start = options.defaultPath?.replace(/[\0\r\n]/g, '').slice(0, 4096);
  if (platform === 'darwin') {
    const script = [
      'try',
      `\t${start
        ? `set target to choose folder with prompt ${appleScriptLiteral(prompt)} default location (POSIX file ${appleScriptLiteral(start)})`
        : `set target to choose folder with prompt ${appleScriptLiteral(prompt)}`}`,
      '\ton error number -128',
      `\t\treturn ${appleScriptLiteral(PICKER_CANCEL_SENTINEL)}`,
      'end try',
      'POSIX path of target',
    ].join('\n');
    return { command: 'osascript', args: ['-e', script] };
  }
  if (platform === 'linux') {
    // zenity wants a trailing slash to open the dialog inside the default directory.
    const filename = start ? (start.endsWith('/') ? start : `${start}/`) : undefined;
    return { command: 'zenity', args: ['--file-selection', '--directory', '--title', prompt, ...(filename ? ['--filename', filename] : [])] };
  }
  return undefined;
}

/** `POSIX path of` and zenity both return a trailing slash; the root case would become empty. */
export function normalizePickedPath(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Distinguish "the user dismissed the chooser" from "the chooser failed". Cancelling
 * must not be reported as an error, and a failure must not be reported as a cancel so
 * the caller can fall back to the in-app browser.
 *
 * This is the fallback for the exit-code path: on macOS the sentinel written by
 * `directoryPickerCommand` is the primary signal, so stderr wording (which is localized and
 * has moved between "canceled" and "cancelled") only matters if that handler never ran.
 */
export function pickerCancelled(platform: NodeJS.Platform, exit: { code: number; stderr: string }): boolean {
  if (platform === 'darwin') return /user cance?ll?ed|\(-128\)/i.test(exit.stderr);
  if (platform === 'linux') return exit.code === 1 && exit.stderr.trim() === '';
  return false;
}

export class WorkspaceService {
  readonly stateDir: string;
  private readonly fileIndex = new FileIndex();
  /** Per-project declaration indexes (`symbols/`), opened on first use and closed by `close()`. */
  private readonly symbols: SymbolIndexes;

  /** Saves, creations, moves and deletions (`write.ts`). */
  readonly writes: FileWrites;

  constructor(options: { stateDir: string; noteWrite?: (absolutePath: string) => void }) {
    if (!options?.stateDir || !path.isAbsolute(options.stateDir)) throw new AppError('INVALID_STATE_DIR', 'stateDir must be an absolute path');
    this.stateDir = path.resolve(options.stateDir);
    this.writes = new FileWrites({ stateDir: this.stateDir, noteWrite: options.noteWrite });
    this.symbols = new SymbolIndexes({ stateDir: this.stateDir, paths: root => this.fileIndex.paths(root), untracked: root => this.fileIndex.untracked(root) });
  }

  /** Stops index builds and parser workers and closes the index files; the server calls it on shutdown. */
  close(): Promise<void> { return this.symbols.close(); }

  async scopedPath(project: ProjectRef, filePath: string): Promise<string> {
    return resolveScopedPath(await projectRoot(project), filePath);
  }

  async list(project: ProjectRef, directory: string | ListQuery = '.'): Promise<FileEntry[]> {
    return this.files(project, typeof directory === 'string' ? { path: directory } : directory);
  }

  async files(project: ProjectRef, query?: Query): Promise<FileEntry[]> {
    const root = await projectRoot(project);
    const options = asQuery(query);
    const dirPath = await resolveScopedPath(root, options.path ?? '.', true);
    let info;
    try { info = await stat(dirPath); } catch { throw new AppError('PATH_NOT_FOUND', 'Directory does not exist', 404); }
    if (!info.isDirectory()) throw new AppError('NOT_A_DIRECTORY', 'Path is not a directory');
    const { limit, offset } = pageArgs(options);
    let names: string[];
    try { names = await readNamesBounded(dirPath, MAX_DIRECTORY_SCAN, true); } catch { throw new AppError('DIRECTORY_UNREADABLE', 'Directory cannot be read', 403); }
    const page = names.slice(offset, offset + limit);
    const entries: FileEntry[] = [];
    for (const name of page) {
      const target = path.join(dirPath, name);
      const relative = toProjectRelative(root, target);
      try {
        await resolveScopedPath(root, relative);
        const item = await lstat(target);
        const modifiedAt = item.mtime.toISOString();
        if (item.isDirectory()) entries.push({ path: relative, name, kind: 'directory', modifiedAt });
        else entries.push({ path: relative, name, kind: 'file', size: item.size, modifiedAt });
      } catch (error) {
        if (error instanceof AppError && error.code === 'PATH_OUTSIDE_PROJECT') continue;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
    return entries;
  }

  async find(project: ProjectRef, query: string | FindQuery): Promise<FileEntry[]> {
    const options: FindQuery = typeof query === 'string' ? { q: query } : query;
    const needle = (options.q ?? '').trim().toLocaleLowerCase();
    if (!needle) throw new AppError('INVALID_QUERY', 'Find query is required');
    if (needle.length > 512) throw new AppError('INVALID_QUERY', 'Find query is too long');
    const root = await projectRoot(project);
    const base = await resolveScopedPath(root, options.path ?? '.', true);
    const { limit, offset } = pageArgs(options);
    const ranked = await this.rankedFind(root, base, options.q ?? '', limit, offset);
    if (ranked) return ranked;
    const found: FileEntry[] = [];
    let skipped = 0;
    let visited = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_WALK_DEPTH || visited >= MAX_WALK_ENTRIES || found.length >= limit) return;
      const names = await readNamesBounded(dir, Math.max(1, MAX_WALK_ENTRIES - visited)).catch(() => [] as string[]);
      for (const name of names) {
        if (visited++ >= MAX_WALK_ENTRIES || found.length >= limit) break;
        const target = path.join(dir, name);
        let info;
        try { info = await lstat(target); } catch { continue; }
        if (info.isSymbolicLink()) continue;
        const relative = toProjectRelative(root, target);
        if (name.toLocaleLowerCase().includes(needle) || relative.toLocaleLowerCase().includes(needle)) {
          if (skipped < offset) skipped++;
          else found.push({ path: relative, name, kind: info.isDirectory() ? 'directory' : 'file', ...(info.isFile() ? { size: info.size } : {}), modifiedAt: info.mtime.toISOString() });
        }
        if (info.isDirectory() && !IGNORED_DIRS.has(name)) await walk(target, depth + 1);
      }
    };
    await walk(base, 0);
    return found;
  }

  async search(project: ProjectRef, query: string | (FindQuery & SearchOptions), signal?: AbortSignal): Promise<SearchResults> {
    const options: FindQuery & SearchOptions = typeof query === 'string' ? { q: query } : query;
    const needle = (options.q ?? '').trim();
    if (!needle) throw new AppError('INVALID_QUERY', 'Search query is required');
    if (needle.length > 512) throw new AppError('INVALID_QUERY', 'Search query is too long');
    const root = await projectRoot(project);
    const base = await resolveScopedPath(root, options.path ?? '.', true);
    const { limit, offset } = pageArgs(options);
    const narrowed = await this.narrowedSearch(root, base, needle, limit, offset, signal, options);
    if (narrowed) return narrowed;
    const searched = await ripgrepSearch(root, base, needle, limit, offset, signal, options);
    if (searched) return searched;
    const matches = lineMatcher(needle, options);
    const include = parseMasks(options.include);
    const exclude = parseMasks(options.exclude);
    const included = include.length ? maskMatcher(include, false) : undefined;
    const excluded = exclude.length ? maskMatcher(exclude, true) : undefined;
    const hits: SearchHit[] = [];
    let more = false;
    let incomplete: SearchResults['incomplete'];
    let skipped = 0;
    let visited = 0;
    let scannedBytes = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (more || signal?.aborted) return;
      if (depth > MAX_WALK_DEPTH || visited >= MAX_WALK_ENTRIES || scannedBytes >= MAX_SEARCH_TOTAL_BYTES) { incomplete = 'budget'; return; }
      const names = await readNamesBounded(dir, Math.max(1, MAX_WALK_ENTRIES - visited)).catch(() => [] as string[]);
      for (const name of names) {
        if (more) break;
        if (visited++ >= MAX_WALK_ENTRIES) { incomplete = 'budget'; break; }
        const target = path.join(dir, name);
        let info;
        try { info = await lstat(target); } catch { continue; }
        if (info.isSymbolicLink()) continue;
        const relative = toProjectRelative(root, target);
        if (excluded?.(relative)) continue;
        if (info.isDirectory()) {
          if (!IGNORED_DIRS.has(name)) await walk(target, depth + 1);
          continue;
        }
        if (!info.isFile() || info.size > 2 * 1024 * 1024 || (included && !included(relative))) continue;
        if (scannedBytes + info.size > MAX_SEARCH_TOTAL_BYTES) { scannedBytes = MAX_SEARCH_TOTAL_BYTES; incomplete = 'budget'; return; }
        scannedBytes += info.size;
        let content: Buffer;
        try { content = await readFileBounded(target, 2 * 1024 * 1024); } catch { continue; }
        if (content.includes(0)) continue;
        const lines = content.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!matches(lines[i]!.slice(0, 1000))) continue;
          if (skipped < offset) skipped++;
          else if (hits.length >= limit) { more = true; break; }
          else hits.push({ path: relative, line: i + 1, text: lines[i]!.slice(0, 1000) });
        }
      }
    };
    await walk(base, 0);
    return { hits, more, ...(incomplete && !more ? { incomplete } : {}) };
  }

  /**
   * A whole-word search for an identifier, answered from the code index's word postings: only the Kotlin / Java
   * files that can contain it (plus those changed since the index was checked) are searched, so a word in two files
   * of a 380k-file monorepo costs milliseconds instead of a full scan. The postings cover `.kt`, `.kts` and `.java`
   * only, so it applies when `include` names only those. `undefined` when it does not apply (not a whole-word
   * identifier search, index not complete, changed files unknown, too many candidates, no ripgrep): the caller scans.
   */
  private async narrowedSearch(root: string, base: string, needle: string, limit: number, offset: number, signal: AbortSignal | undefined, options: SearchOptions): Promise<SearchResults | undefined> {
    const include = parseMasks(options.include);
    if (!options.word || options.regex || !/^[A-Za-z_$][\w$]*$/.test(needle) || !include.length || !include.every(mask => /^\*\.(?:kt|kts|java)$/i.test(mask))) return undefined;
    // Postings are keyed by the lower-cased word; a word that is a keyword in any case is not in them.
    const word = needle.toLowerCase();
    const within = toProjectRelative(root, base);
    const changed = await this.symbols.changedSince(root);
    const indexed = changed && this.symbols.wordFiles(root, word, within);
    if (!changed || !indexed) return undefined;
    const names = new Set(indexed);
    for (const item of changed) if (/\.(?:kt|kts|java)$/.test(item) && (!within || item.startsWith(`${within}/`))) names.add(item);
    if (names.size > CODE_INDEX_BUDGET.referenceFiles) return undefined;
    const included = maskMatcher(include, false);
    const exclude = parseMasks(options.exclude);
    const excluded = exclude.length ? maskMatcher(exclude, true) : undefined;
    // Files that no longer exist (deleted since the check) and links are left out: a missing file would fail the whole ripgrep run.
    const files: string[] = [];
    const candidates = [...names].filter(item => included(item) && !excluded?.(item)).sort();
    for (let at = 0; at < candidates.length; at += 64) {
      const batch = candidates.slice(at, at + 64);
      const regular = await Promise.all(batch.map(item => lstat(path.join(root, item)).then(info => info.isFile(), () => false)));
      batch.forEach((item, index) => { if (regular[index]) files.push(item); });
    }
    const want = limit + offset;
    const deadline = Date.now() + SEARCH_TIMEOUT_MS;
    const hits: SearchHit[] = [];
    let incomplete: SearchResults['incomplete'];
    for (let at = 0; at < files.length && hits.length <= want; at += 500) {
      if (signal?.aborted) break;
      if (Date.now() > deadline) { incomplete = 'time'; break; }
      const part = await ripgrepSearch(root, base, needle, want + 1 - hits.length, 0, signal, options, files.slice(at, at + 500));
      if (!part) return undefined;
      hits.push(...part.hits);
      if (part.incomplete) incomplete = part.incomplete;
    }
    const more = hits.length > want;
    return { hits: hits.slice(offset, want), more, ...(incomplete && !more ? { incomplete } : {}) };
  }

  /** Where the symbol under the cursor is declared, by search: its file, what that imports, its directory, then the project. */
  async definition(project: ProjectRef, query: DefinitionQuery, signal?: AbortSignal): Promise<CodeDefinitions> {
    const root = await projectRoot(project);
    return findDefinitions(new CodeNav(root, () => this.fileIndex.paths(root), signal, this.symbols), query);
  }

  /** Whole-word uses of a symbol in the files of the same language, within the file's module or the whole project. */
  async references(project: ProjectRef, query: ReferenceQuery, signal?: AbortSignal): Promise<CodeReferences> {
    const root = await projectRoot(project);
    return findReferences(new CodeNav(root, () => this.fileIndex.paths(root), signal, this.symbols), query);
  }

  /** Declarations matching `q`, best first; empty with the index's state until it is ready. Asking starts no build: `watchCodeIndex` does. */
  async symbolSearch(project: ProjectRef, q: string, options: { types: boolean; limit: number }): Promise<CodeSymbolResults> {
    return this.symbols.search(await projectRoot(project), q, options);
  }

  /** The declarations of one file, parsed directly: no index needed. */
  async outline(project: ProjectRef, filePath: string): Promise<CodeOutline> {
    const root = await projectRoot(project);
    const target = await resolveReadablePath(root, filePath, false, [this.stateDir]);
    return this.symbols.outline(target, toProjectRelative(root, target));
  }

  async codeIndexStatus(project: ProjectRef): Promise<CodeIndexStatus> { return this.symbols.status(await projectRoot(project)); }

  async rebuildCodeIndex(project: ProjectRef): Promise<CodeIndexStatus> { return this.symbols.rebuild(await projectRoot(project)); }

  /** Builds and checks the index only while a page renews its `lease`; once every page dropped or let its lease lapse, a build in progress stops (`SymbolIndexes.watch`). */
  async watchCodeIndex(project: ProjectRef, lease: string, watching: boolean): Promise<CodeIndexStatus> { return this.symbols.watch(await projectRoot(project), lease, watching); }

  /** The build-system modules of a project, from its file list. */
  async codeModules(project: ProjectRef): Promise<CodeModules> {
    const root = await projectRoot(project);
    const list = await this.fileIndex.paths(root);
    return list ? modulesOf(list, path.basename(root)) : { modules: [] };
  }

  /**
   * The file a read names. Agents name a file they handled by its name or the end of its path
   * (`TranscriptCell.swift`), often after reaching it through a shell the conversation records no
   * path for; a project path that does not exist then means the project's only listed file ending
   * with it. None or several such files leave it missing.
   */
  private async readablePath(root: string, filePath: string, allowOutside: boolean, harnessImageHomes?: readonly string[]): Promise<string> {
    const target = await resolveReadablePath(root, filePath, allowOutside, [this.stateDir], harnessImageHomes, this.stateDir);
    if (await stat(target).then(() => true, () => false)) return target;
    const mention = filePath.replace(/^\.\//, '');
    if (!mention || path.isAbsolute(mention) || mention.startsWith('~') || mention.split('/').includes('..')) return target;
    const listing = await this.fileIndex.paths(root);
    if (!listing) return target;
    let named: string | undefined;
    for (let index = 0; index < listing.dirStart; index++) {
      const file = listing.paths[index]!;
      if (file !== mention && !file.endsWith(`/${mention}`)) continue;
      if (named !== undefined) return target;
      named = file;
    }
    return named === undefined ? target : resolveReadablePath(root, named, false, [this.stateDir], harnessImageHomes, this.stateDir);
  }

  /**
   * Find from the repository's file list, ranked as an IDE's "Go to File"; `undefined` when the project
   * cannot be listed that way (no git, no ripgrep) and the tree is walked instead.
   */
  private async rankedFind(root: string, base: string, query: string, limit: number, offset: number): Promise<FileEntry[] | undefined> {
    const listing = await this.fileIndex.paths(root);
    if (!listing) return undefined;
    const prefix = base === root ? '' : `${toProjectRelative(root, base)}/`;
    const best = (await rankPaths(listing, query, limit + offset, prefix)).slice(offset);
    const entries: FileEntry[] = [];
    for (const { path: relative, directory } of best) {
      // Listed paths are git's or ripgrep's: each is checked against the project before it is shown.
      try {
        await resolveScopedPath(root, relative);
        const info = await lstat(path.join(root, relative));
        const name = relative.slice(relative.lastIndexOf('/') + 1);
        if (directory || info.isDirectory()) entries.push({ path: relative, name, kind: 'directory', modifiedAt: info.mtime.toISOString() });
        else entries.push({ path: relative, name, kind: 'file', size: info.size, modifiedAt: info.mtime.toISOString() });
      } catch { /* deleted since it was listed, or outside the project */ }
    }
    return entries;
  }

  async preview(project: ProjectRef, filePath: string, options: { allowOutside?: boolean } = {}): Promise<FilePreview> {
    const root = await projectRoot(project);
    const target = await this.readablePath(root, filePath, options.allowOutside === true);
    let info;
    try { info = await stat(target); } catch { throw new AppError('FILE_NOT_FOUND', 'File does not exist', 404); }
    if (!info.isFile()) throw new AppError('NOT_A_FILE', 'Path is not a regular file');
    const path = isWithin(root, target) ? toProjectRelative(root, target) : target;
    // A player streams the file by range (`routes/workspace.ts#sendFile`): nothing here needs its bytes,
    // and its size does not decide whether it can be shown.
    if (previewKind(path) === 'media') {
      return { path, content: '', hash: hash(`${info.size}:${info.mtimeMs}`), size: info.size, binary: true, truncated: info.size > MAX_FILE_READ_BYTES, render: { kind: 'media' } };
    }
    if (info.size > MAX_FILE_READ_BYTES) {
      // An app package or archive this large is still a file to name and download: its first bytes tell
      // binary from text without reading the rest. Text this large has nothing it could show.
      const head = await readFileHead(target, 8192);
      // The size lets a client read the end instead (a log), by range.
      if (!head.includes(0)) throw new AppError('FILE_TOO_LARGE', `File exceeds the ${MAX_FILE_READ_BYTES} byte preview limit`, 413, undefined, { size: String(info.size) });
      return { path, content: '', hash: hash(Buffer.concat([head, Buffer.from(`:${info.size}:${info.mtimeMs}`)])), size: info.size, binary: true, truncated: true };
    }
    const data = await readFileBounded(target, MAX_FILE_READ_BYTES);
    const sample = data.subarray(0, 8192);
    const imageMimeType = data.byteLength <= MAX_ATTACHMENT_BYTES ? previewImageMimeType(data) : undefined;
    const text = imageMimeType ? undefined : decodePreviewText(data.subarray(0, MAX_PREVIEW_BYTES));
    const binary = Boolean(imageMimeType) || text === undefined;
    const kind = previewKind(path, sample);
    const inside = isWithin(root, target);
    // What `write.ts#FileWrites.save` accepts: the whole file, UTF-8, inside the project, outside `.git` and writable under state/secret policy.
    const editable = inside && !binary && data.byteLength <= MAX_PREVIEW_BYTES && !path.split('/').includes('.git') && editableText(data) !== undefined
      && !(await isSecretPath(await realpath(target).catch(() => target), [this.stateDir], false));
    return {
      // Outside files keep their absolute path: there is no project-relative form for them,
      // and the UI echoes this value back when referencing a line or opening the editor.
      path,
      content: binary ? '' : text!,
      hash: hash(data),
      size: data.byteLength,
      binary,
      truncated: data.byteLength > MAX_PREVIEW_BYTES,
      ...(imageMimeType ? { image: { mimeType: imageMimeType } } : {}),
      ...(kind ? { render: { kind } } : {}),
      ...(editable ? { editable } : {}),
    };
  }

  /**
   * Read bounded image bytes for rendering in an <img> element. SVG also gets an inert-document
   * policy on the route so opening its URL directly cannot execute source scripts. A harness
   * attachment object may be read from a configured harness home. Riffet's own registered
   * attachments use the attachment reader; all other state and credential files remain denied.
   */
  async readPreviewImage(project: ProjectRef, filePath: string, options: { allowOutside?: boolean; harnessImageHomes?: readonly string[] } = {}): Promise<{ mimeType: string; data: Buffer }> {
    const root = await projectRoot(project);
    const requested = path.resolve(root, expandHomePath(filePath));
    const attachmentId = path.basename(requested, '.bin');
    let data: Buffer;
    if (validId(attachmentId) && requested === path.join(this.stateDir, 'attachments', `${attachmentId}.bin`)) {
      // Tools can return an uploaded attachment's local path rather than its id. Resolve only
      // registered objects through the same metadata, size and symlink checks as /attachments/:id.
      ({ data } = await this.readAttachment(attachmentId));
    } else {
      const target = await this.readablePath(root, filePath, options.allowOutside === true, options.harnessImageHomes);
      let info;
      try { info = await stat(target); } catch { throw new AppError('FILE_NOT_FOUND', 'File does not exist', 404); }
      if (!info.isFile()) throw new AppError('NOT_A_FILE', 'Path is not a regular file');
      data = await readFileBounded(target, MAX_ATTACHMENT_BYTES);
    }
    return previewImageData(data);
  }

  /** A file to stream as-is, for downloading or opening in a browser tab. No size limit: it is never buffered. */
  async rawFile(project: ProjectRef, filePath: string, options: { allowOutside?: boolean } = {}): Promise<{ path: string; name: string; size: number; mtime: Date } & RawFileType> {
    const root = await projectRoot(project);
    const target = await this.readablePath(root, filePath, options.allowOutside === true);
    let info;
    try { info = await stat(target); } catch { throw new AppError('FILE_NOT_FOUND', 'File does not exist', 404); }
    if (!info.isFile()) throw new AppError('NOT_A_FILE', 'Path is not a regular file');
    const name = path.basename(target);
    return { path: target, name, size: info.size, mtime: info.mtime, ...rawFileType(name, await readSample(target)) };
  }

  /**
   * What a previewed page may read: its folder inside the project. Outside the project only the
   * file itself, as the single-file read there allows (`scope.ts#resolveExternalFile`).
   */
  async siteScope(project: ProjectRef, filePath: string): Promise<{ root: string; only?: string }> {
    const root = path.dirname(filePath);
    return isWithin(await projectRoot(project), filePath) ? { root } : { root, only: path.basename(filePath) };
  }

  /**
   * A file of a previewed page's folder, addressed the way the page's own links address it. Dot
   * paths and key files are refused even inside the project: the page's scripts can read whatever
   * this serves.
   */
  async siteFile(project: ProjectRef, root: string, relative: string, options: { allowOutside?: boolean; only?: string } = {}): Promise<{ path: string; name: string; size: number; mtime: Date } & RawFileType> {
    const missing = () => new AppError('FILE_NOT_FOUND', 'File does not exist', 404);
    const wanted = !relative || relative.endsWith('/') ? `${relative}index.html` : relative;
    if (options.only !== undefined && wanted !== options.only) throw missing();
    // An address for one file (a media preview) reaches nothing else, so that file may be a dot file.
    if (wanted.includes('\0') || wanted.split('/').some(part => !part || (part.startsWith('.') && options.only === undefined) || part === '.' || part === '..')) throw missing();
    const target = path.resolve(root, wanted);
    if (!isWithin(root, target)) throw missing();
    const file = await this.rawFile(project, target, options);
    const real = await realpath(file.path);
    if (!isWithin(await realpath(root), real)) throw missing();
    if (await isSecretPath(real, [this.stateDir], true, [], this.stateDir)) throw new AppError('PATH_DENIED', 'This file holds credentials and cannot be read through the workbench', 403);
    return { ...file, ...siteFileType(file.name, file) };
  }

  /**
   * A project folder as a streamed ZIP. Entries are collected first, so a folder over the limits
   * fails with an error response instead of a truncated download.
   */
  async archive(project: ProjectRef, directory: string): Promise<{ name: string; files: number; bytes: number; stream: () => Readable }> {
    const root = await projectRoot(project);
    const base = await resolveScopedPath(root, directory || '.', true);
    let info;
    try { info = await stat(base); } catch { throw new AppError('PATH_NOT_FOUND', 'Directory does not exist', 404); }
    if (!info.isDirectory()) throw new AppError('NOT_A_DIRECTORY', 'Path is not a directory');
    const top = path.basename(base) || 'project';
    const entries = await gitArchiveEntries(base, top) ?? await collectArchiveEntries(base, top, IGNORED_DIRS);
    const files = entries.filter(entry => !entry.directory);
    return { name: `${top}.zip`, files: files.length, bytes: files.reduce((sum, entry) => sum + entry.size, 0), stream: () => zipStream(entries) };
  }

  async openInEditor(project: ProjectRef, filePath: string, line?: number, command?: string, options: { allowOutside?: boolean } = {}): Promise<{ path: string; line?: number; opened: boolean; pid?: number }> {
    const root = await projectRoot(project);
    const target = await this.readablePath(root, filePath, options.allowOutside === true);
    try { await stat(target); } catch { throw new AppError('FILE_NOT_FOUND', 'File does not exist', 404); }
    if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) throw new AppError('INVALID_LINE', 'Line must be a positive integer');
    let executable: string;
    let args: string[];
    if (command) {
      const parsed = parseCommand(command);
      executable = parsed.shift()!;
      let substituted = false;
      args = parsed.map(value => {
        if (value.includes('{file}') || value.includes('%file%') || value.includes('{fileLine}') || value.includes('%fileLine%')) substituted = true;
        return value.replace(/\{file\}|%file%/g, target).replace(/\{line\}|%line%/g, line === undefined ? '' : String(line)).replace(/\{fileLine\}|%fileLine%/g, line === undefined ? target : `${target}:${line}`);
      }).filter(value => value !== '');
      if (!substituted) args.push(...(line === undefined ? [] : ['--goto']), line === undefined ? target : `${target}:${line}`);
    } else {
      executable = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
      args = [target];
    }
    const child = spawn(executable, args, { cwd: root, detached: true, stdio: 'ignore', shell: false, windowsHide: true });
    const pid = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => resolve(child.pid ?? 0));
    }).catch(() => { throw new AppError('EDITOR_OPEN_FAILED', 'Could not start the external editor', 500); });
    child.unref();
    return { path: isWithin(root, target) ? toProjectRelative(root, target) : target, ...(line === undefined ? {} : { line }), opened: true, ...(pid ? { pid } : {}) };
  }

  /** Selects a file or directory in Finder on the Mac running this server. */
  async revealInFinder(project: ProjectRef, filePath: string, options: { allowOutside?: boolean } = {}): Promise<{ opened: true }> {
    if (process.platform !== 'darwin') throw new AppError('FINDER_OPEN_FAILED', 'Finder is only available on a macOS server', 501);
    const root = await projectRoot(project);
    const target = await this.readablePath(root, filePath, options.allowOutside === true);
    try { await stat(target); } catch { throw new AppError('FILE_NOT_FOUND', 'File does not exist', 404); }
    await new Promise<void>((resolve, reject) => {
      execFile('/usr/bin/open', ['-R', target], { cwd: root, timeout: 10_000 }, (error) => {
        if (error) reject(new AppError('FINDER_OPEN_FAILED', 'Could not reveal the file in Finder', 500));
        else resolve();
      });
    });
    return { opened: true };
  }

  /**
   * Present the operating system's own folder chooser on the machine running the
   * server, so the user can navigate with Finder/Explorer instead of the in-app
   * browser. The browser can never learn an absolute local path on its own, which is
   * why this has to happen server-side (mirroring `openInEditor`).
   *
   * `supported: false` means this platform has no chooser we can drive, or the chooser
   * could not be started; callers should fall back to the in-app directory browser.
   * `cancelled: true` means the user dismissed the chooser and nothing should happen.
   */
  async pickDirectory(options: { prompt?: string; defaultPath?: string; platform?: NodeJS.Platform } = {}): Promise<DirectoryPickResult> {
    const platform = options.platform ?? process.platform;
    const spec = directoryPickerCommand(platform, options);
    if (!spec) return { supported: false, cancelled: false };
    const exit = await new Promise<{ code: number; stderr: string; stdout: string } | 'missing'>((resolve) => {
      execFile(spec.command, spec.args, { encoding: 'utf8', timeout: DIRECTORY_PICKER_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') { resolve('missing'); return; }
        const code = error ? (typeof (error as unknown as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : 1) : 0;
        resolve({ code, stderr: stderr ?? '', stdout: stdout ?? '' });
      });
    });
    // No chooser binary on this host: degrade to the in-app browser rather than failing.
    if (exit === 'missing') return { supported: false, cancelled: false };
    // A dismissal the script handled itself: exit 0 carrying only the sentinel.
    if (exit.code === 0 && exit.stdout.trim() === PICKER_CANCEL_SENTINEL) return { supported: true, cancelled: true };
    if (exit.code !== 0) {
      if (pickerCancelled(platform, exit)) return { supported: true, cancelled: true };
      return { supported: false, cancelled: false };
    }
    let real: string;
    try { real = await realpath(normalizePickedPath(exit.stdout)); } catch { return { supported: true, cancelled: true }; }
    const info = await stat(real).catch(() => undefined);
    if (!info?.isDirectory()) return { supported: true, cancelled: true };
    return { supported: true, cancelled: false, path: real };
  }

  async upload(project: ProjectRef | undefined, input: { name: string; mimeType: string; dataBase64: string; width?: number; height?: number }): Promise<Attachment> {
    if (project !== undefined) await projectRoot(project);
    if (!input || typeof input.name !== 'string' || typeof input.mimeType !== 'string' || typeof input.dataBase64 !== 'string') {
      throw new AppError('INVALID_ATTACHMENT', 'Attachment name, MIME type, and base64 data are required');
    }
    const name = path.basename(input.name.replace(/\\/g, '/')).replace(/[\0\r\n]/g, '').slice(0, 240);
    const mimeType = input.mimeType.trim().slice(0, 255);
    // A client that measured the decoded image may declare its pixel size; anything else is dropped
    // rather than rejected, so an older or sloppier client can still upload its bytes.
    const dimensions = imageDimensions(input.width, input.height);
    const encoded = input.dataBase64.replace(/\s/g, '');
    const invalid = () => new AppError('INVALID_ATTACHMENT', 'Attachment metadata or base64 data is invalid');
    // A per-quad pattern over megabytes of base64 overflows the regexp stack; the round trip below
    // checks padding and canonical form instead.
    if (!name || name === '.' || name === '..' || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType) || encoded.length > Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 8 || encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) {
      throw invalid();
    }
    const data = Buffer.from(encoded, 'base64');
    if (data.length > MAX_ATTACHMENT_BYTES) throw new AppError('ATTACHMENT_TOO_LARGE', `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`, 413);
    if (data.toString('base64') !== encoded) throw invalid();
    const id = randomUUID();
    const folder = path.join(this.stateDir, 'attachments');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const [realStateDir, realFolder] = await Promise.all([realpath(this.stateDir), realpath(folder)]);
    if (realFolder !== path.join(realStateDir, 'attachments')) throw new AppError('ATTACHMENT_STORAGE_UNSAFE', 'Attachment storage path must stay inside stateDir', 500);
    const bytesPath = path.join(folder, `${id}.bin`);
    const metadataPath = path.join(folder, `${id}.json`);
    const temporaryPath = `${bytesPath}.${randomUUID()}.tmp`;
    const attachment: Attachment = { id, name, mimeType, size: data.length, path: bytesPath, ...dimensions };
    try {
      const handle = await open(temporaryPath, 'wx', 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await rename(temporaryPath, bytesPath);
      await writeFile(metadataPath, JSON.stringify(attachment), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      await Promise.all([rm(temporaryPath, { force: true }), rm(bytesPath, { force: true }), rm(metadataPath, { force: true })]);
      throw error;
    }
    return attachment;
  }

  async readAttachmentMetadata(id: string): Promise<Attachment> {
    if (!validId(id)) throw new AppError('ATTACHMENT_NOT_FOUND', 'Attachment does not exist', 404);
    const folder = path.join(this.stateDir, 'attachments');
    const metadataPath = path.join(folder, `${id}.json`);
    const bytesPath = path.join(folder, `${id}.bin`);
    try {
      const [metadataInfo, bytesInfo, realFolder, realBytes] = await Promise.all([lstat(metadataPath), lstat(bytesPath), realpath(folder), realpath(bytesPath)]);
      const realStateDir = await realpath(this.stateDir);
      if (metadataInfo.isSymbolicLink() || !metadataInfo.isFile() || metadataInfo.size > 16 * 1024 || bytesInfo.isSymbolicLink() || !bytesInfo.isFile() || bytesInfo.size > MAX_ATTACHMENT_BYTES || realFolder !== path.join(realStateDir, 'attachments') || realBytes !== path.join(realFolder, path.basename(bytesPath))) throw new Error('invalid attachment');
      const metadataText = (await readFileBounded(metadataPath, 16 * 1024)).toString('utf8');
      const metadata = JSON.parse(metadataText) as Attachment;
      if (!metadata || metadata.id !== id || metadata.path !== bytesPath || typeof metadata.name !== 'string' || metadata.name.length > 240 || typeof metadata.mimeType !== 'string' || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(metadata.mimeType) || !Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size !== bytesInfo.size) throw new Error('invalid attachment');
      // A declared size is optional, but a tampered one must not survive: strip whatever is on disk
      // and re-add only what the normalizer accepts.
      const { width, height, ...rest } = metadata;
      return { ...rest, ...imageDimensions(width, height) };
    } catch { throw new AppError('ATTACHMENT_NOT_FOUND', 'Attachment does not exist', 404); }
  }

  /**
   * Removes attachments last written before `olderThan` (ms) unless their id is in `keep`, and
   * upload leftovers of the same age. Slow on purpose: one file at a time, yielding between them,
   * so it never competes with a request. Returns how many attachments went.
   */
  async pruneAttachments(options: { olderThan: number; keep: ReadonlySet<string> }): Promise<number> {
    const folder = path.join(this.stateDir, 'attachments');
    let directory;
    try { directory = await opendir(folder); } catch { return 0; }
    let removed = 0;
    for await (const entry of directory) {
      if (!entry.isFile()) continue;
      const temporary = /\.bin\.[0-9a-f-]+\.tmp$/i.test(entry.name);
      const id = /^(.+)\.bin$/.exec(entry.name)?.[1];
      if (!temporary && (!id || !validId(id) || options.keep.has(id))) continue;
      const target = path.join(folder, entry.name);
      const info = await lstat(target).catch(() => undefined);
      if (!info?.isFile() || info.mtimeMs >= options.olderThan) continue;
      if (temporary) { await rm(target, { force: true }); continue; }
      // Metadata first: an attachment without it already reads as missing, never half-present.
      await rm(path.join(folder, `${id}.json`), { force: true });
      await rm(target, { force: true });
      await rm(path.join(folder, 'materialized', id!), { recursive: true, force: true });
      removed += 1;
      await new Promise(resolve => setImmediate(resolve));
    }
    return removed;
  }

  async readAttachment(id: string): Promise<{ attachment: Attachment; data: Buffer }> {
    const attachment = await this.readAttachmentMetadata(id);
    try {
      const data = await readFileBounded(attachment.path, MAX_ATTACHMENT_BYTES);
      if (data.length !== attachment.size) throw new Error('invalid attachment');
      return { attachment, data };
    } catch { throw new AppError('ATTACHMENT_NOT_FOUND', 'Attachment does not exist', 404); }
  }
}

export { type ProjectRef } from './scope.js';
