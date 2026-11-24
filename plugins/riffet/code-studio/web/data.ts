import type {
  CodeDefinitions, CodeIndexStatus, CodeModules, CodeOutline, CodeReferences, CodeSymbolResults, FileEntry, FilePreview, GitBlame, GitCommitDetail, GitFileAtRev, GitHead, GitRefs, SearchHit, SearchResults,
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
    /** The file as it is on disk, as the reader sees it (text cut at the preview limit). */
    file: (path: string, signal?: AbortSignal) => get<FilePreview>('/file', { path }, signal),
    fileAtHead: (path: string, signal?: AbortSignal) => get<GitFileAtRev>('/git/file', { path, rev: 'HEAD' }, signal),
    /** The file as it is in a commit (`rev` a hash). */
    fileAt: (path: string, rev: string, signal?: AbortSignal) => get<GitFileAtRev>('/git/file', { path, rev }, signal),
    commit: (hash: string, signal?: AbortSignal) => get<GitCommitDetail>(`/git/commits/${encodeURIComponent(hash)}`, {}, signal),
    refs: (signal?: AbortSignal) => get<GitRefs>('/git/refs', {}, signal),
    /** Checks out a local branch; the server refuses while a turn is editing the project, or when changes would be overwritten. */
    switchBranch: (branch: string) => request().post<GitRefs>(`${base}/git/switch`, { branch }),
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

/**
 * Find in files: what to match, and where. `mask` is file masks (`*.kt, *.java`); `module` is the open
 * file's module, `folder` the folder last searched from the tree (`folder`).
 */
export interface TextOptions { matchCase: boolean; word: boolean; regex: boolean; mask: string; scope: 'project' | 'module' | 'folder'; folder?: string }
export const TEXT_OPTIONS: TextOptions = { matchCase: false, word: false, regex: false, mask: '', scope: 'project' };

/**
 * What the page remembers in this browser, per server and project: C class (docs/guide/multi-server.md), not synced.
 * `preview` is the tab a single click in the tree or the find results opened: the next such click reuses it, as
 * the IDE's preview tab does, until it is kept (double click, or a jump from inside it). `side` is what the right pane
 * shows: `structure`, or another plugin's view of the project (a build, Logcat) by its id.
 */
export interface Saved { tabs: string[]; active?: string; preview?: string; mode?: 'modules' | 'project'; outline?: boolean; recent?: string[]; find?: TextOptions; side?: string }
/** Files the search lists as recently opened. */
export const MAX_RECENT = 30;
const KEY = 'riffet.code-studio.v1';
const LAYOUT_KEY = 'riffet.code-studio.layout.v1';

/** Carries what the page kept under the plugin's first name (`riffet.studio`, until 2026-11-24) over to the new keys, once. */
(function moveOldKeys() {
  try {
    for (const [from, to] of [['riffet.studio.v1', KEY], ['riffet.studio.layout.v1', LAYOUT_KEY]] as const) {
      const old = window.localStorage.getItem(from);
      if (old === null) continue;
      if (window.localStorage.getItem(to) === null) window.localStorage.setItem(to, old);
      window.localStorage.removeItem(from);
    }
  } catch { /* As below. */ }
})();
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

/** Pane sizes and which side panes show, for every project: they follow the screen, not the code. */
export interface Layout { tree: number; outline: number; results: number; treeHidden?: boolean }
export const LAYOUT: Layout = { tree: 300, outline: 260, results: 260 };

export function loadLayout(): Layout {
  try {
    const value = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) ?? '{}') as Partial<Layout>;
    return { ...LAYOUT, ...value };
  } catch { return LAYOUT; }
}

export function storeLayout(layout: Layout): void {
  try { window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* As above. */ }
}

/** A path a tool reports (a build error's file) as one of the project's, or `undefined` when it is outside the project. */
export function projectPath(root: string, path: string): string | undefined {
  const base = root.replace(/\/+$/, '');
  if (path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  if (path.startsWith('/') || path.startsWith('~')) return undefined;
  return path.replace(/^\.\//, '');
}
