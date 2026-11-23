import type {
  CodeDefinitions, CodeIndexStatus, CodeModules, CodeOutline, CodeReferences, CodeSymbolResults, FileEntry, GitBlame, GitFileAtRev, GitHead, SearchHit, SearchResults,
} from '@contracts';
import type { RequestService } from '@riffet/plugin-web';

/** The core's project routes the page reads; every path is under the prefixes `index.ts` declares. */
export function codeApi(request: () => RequestService, projectId: string) {
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const get = <T>(path: string, query: Record<string, string>, signal?: AbortSignal) =>
    request().get<T>(`${base}${path}?${new URLSearchParams(query).toString()}`, signal ? { signal } : {});
  return {
    /** One directory, every page of it up to `max` entries. */
    async list(path: string, max = LIST_MAX, signal?: AbortSignal): Promise<{ entries: FileEntry[]; more: boolean }> {
      const entries: FileEntry[] = [];
      for (;;) {
        const page = await get<FileEntry[]>('/files', { path, limit: String(LIST_PAGE), offset: String(entries.length) }, signal);
        entries.push(...page);
        if (page.length < LIST_PAGE) return { entries, more: false };
        if (entries.length >= max) return { entries, more: true };
      }
    },
    files: (q: string, signal?: AbortSignal) => get<FileEntry[] | { entries?: FileEntry[] }>('/find', { q, limit: '50' }, signal)
      .then((found) => (Array.isArray(found) ? found : found.entries ?? []).filter((entry) => entry.kind === 'file')),
    text: (q: string, signal?: AbortSignal) => get<SearchHit[]>('/search', { q, limit: '200' }, signal),
    /** Find in files with its options; `more` and `incomplete` say what the hits leave out. */
    find: (q: string, options: TextOptions, within: string | undefined, limit: number, signal?: AbortSignal, exclude?: string) => get<SearchResults>('/search', {
      q, detail: '1', limit: String(limit), ...(exclude ? { exclude } : {}),
      ...(options.matchCase ? { case: '1' } : {}), ...(options.word ? { word: '1' } : {}), ...(options.regex ? { regex: '1' } : {}),
      ...(options.mask.trim() ? { include: options.mask.trim() } : {}), ...(within ? { path: within } : {}),
    }, signal),
    symbols: (q: string, types: boolean, signal?: AbortSignal) => get<CodeSymbolResults>('/code/symbols', { ...(q ? { q } : {}), limit: '50', ...(types ? { types: '1' } : {}) }, signal),
    outline: (path: string, signal?: AbortSignal) => get<CodeOutline>('/code/outline', { path }, signal),
    modules: (signal?: AbortSignal) => get<CodeModules>('/code/modules', {}, signal),
    /** Keeps the index building while this page is in sight, under `lease` (one per page); `false` drops it, and the build stops once no page holds one (or the renewals lapse). */
    watch: (lease: string, watching: boolean, signal?: AbortSignal) => request().post<CodeIndexStatus>(`${base}/code/index/watch`, { lease, watching }, signal ? { signal } : {}),
    rebuild: () => request().post<CodeIndexStatus>(`${base}/code/index`),
    definition: (at: { path: string; line: number; column: number; word: string }, signal?: AbortSignal) =>
      get<CodeDefinitions>('/code/definition', { path: at.path, line: String(at.line), column: String(at.column), word: at.word }, signal),
    references: (at: { path: string; word: string; scope: 'module' | 'project' }, signal?: AbortSignal) => get<CodeReferences>('/code/references', at, signal),
    head: (signal?: AbortSignal) => get<GitHead>('/git/head', {}, signal),
    fileAtHead: (path: string, signal?: AbortSignal) => get<GitFileAtRev>('/git/file', { path, rev: 'HEAD' }, signal),
    blame: (path: string, start: number, end: number, signal?: AbortSignal) => get<GitBlame>('/git/blame', { path, start: String(start), end: String(end) }, signal),
  };
}
export type CodeApi = ReturnType<typeof codeApi>;

/** Kotlin and Java: the files the code index can narrow a whole-word search to. */
const JVM_MASK = '*.kt,*.kts,*.java';
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Find in files, in two passes when the index can answer most of it: a whole word with no file mask looks
 * in Kotlin and Java first, which the index narrows to the files holding the word (well under a second on
 * a large repository), and in every other file after, which is a full scan. `onPart` gets the first pass,
 * so its hits show while the scan runs; the answer is both, with the scan's limits.
 */
export async function findInFiles(api: CodeApi, q: string, options: TextOptions, within: string | undefined, limit: number, signal?: AbortSignal, onPart?: (part: SearchResults) => void): Promise<SearchResults> {
  if (!options.word || options.regex || options.mask.trim() || !IDENTIFIER.test(q.trim())) return api.find(q, options, within, limit, signal);
  const rest = api.find(q, options, within, limit, signal, JVM_MASK);
  rest.catch(() => undefined); // Awaited below; this only keeps a failure that lands first from reading as unhandled.
  const first = await api.find(q, { ...options, mask: JVM_MASK }, within, limit, signal);
  onPart?.(first);
  const second = await rest;
  const hits = [...first.hits, ...second.hits];
  const incomplete = first.incomplete ?? second.incomplete;
  return { hits: hits.slice(0, limit), more: first.more || second.more || hits.length > limit, ...(incomplete ? { incomplete } : {}) };
}

/** The server's largest page of a directory. */
const LIST_PAGE = 200;
/** Entries of one directory the tree reads before it offers the rest as "more". */
export const LIST_MAX = 2_000;

/** The letter a declaration's kind is marked with in lists, as Studio's structure view marks them. */
export const KIND_MARK: Record<string, string> = { class: 'C', interface: 'I', object: 'O', enum: 'E', annotation: '@', typealias: 'T', function: 'f', property: 'p', constructor: 'c' };

export const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const dirName = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
export const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** Find in files: what to match, and where. `mask` is file masks (`*.kt, *.java`); `module` is the open file's module. */
export interface TextOptions { matchCase: boolean; word: boolean; regex: boolean; mask: string; scope: 'project' | 'module' }
export const TEXT_OPTIONS: TextOptions = { matchCase: false, word: false, regex: false, mask: '', scope: 'project' };

/** What the page remembers in this browser, per server and project: C class (docs/guide/multi-server.md), not synced. */
export interface Saved { tabs: string[]; active?: string; mode?: 'modules' | 'project'; outline?: boolean; recent?: string[]; find?: TextOptions }
/** Files the search lists as recently opened. */
export const MAX_RECENT = 30;
const KEY = 'riffet.studio.v1';
const MAX_TABS = 30;

export function loadSaved(scope: string): Saved {
  try {
    const all = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Record<string, Saved>;
    const saved = all[scope];
    return saved && Array.isArray(saved.tabs) ? saved : { tabs: [] };
  } catch { return { tabs: [] }; }
}

export function storeSaved(scope: string, saved: Saved): void {
  try {
    const all = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Record<string, Saved | string>;
    all[scope] = { ...saved, tabs: saved.tabs.slice(-MAX_TABS) };
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* Private mode or a full quota: the page works without remembering. */ }
}

/** The project last opened, on `server` when given (each server keeps its own). */
export function savedProject(server?: string): string | undefined {
  try {
    const all = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as { project?: unknown; projects?: Record<string, unknown> };
    const value = server === undefined ? all.project : all.projects?.[server];
    return typeof value === 'string' ? value : undefined;
  } catch { return undefined; }
}

export function rememberProject(project: string, server: string): void {
  try {
    const all = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    all.project = project;
    all.projects = { ...(all.projects as Record<string, string> | undefined), [server]: project };
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* As above. */ }
}
