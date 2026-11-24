import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CODE_INDEX_BUDGET, type CodeIndexStatus, type CodeModule, type CodeOutline, type GitRefs, type SearchResults } from '@contracts';
import { EmptyState, useMessages, usePluginHost, useProjects, useProjectViews, useServers, type CodeFileTarget, type CodeMenuAt, type CodeSymbolAt, type MenuEntry, type ViewProps } from '@riffet/plugin-web';
import { ChangesPanel, type Changes } from './ChangesPanel';
import { CommitPanel } from './CommitPanel';
import { blameMenu, codeMenu, declarationMenu, type EditorCommand, fileMenu, folderMenu, lineMenu, type MenuActions, tidy } from './menus';
import { cn } from './cn';
import {
  codeApi, type CodeApi, findInFiles, LAYOUT, type Layout, loadLayout, loadSaved, MAX_RECENT, projectPath, rememberProject, savedProject, storeLayout, storeSaved,
  TEXT_OPTIONS, type Saved, type TextOptions,
} from './data';
import { EditorTabs } from './EditorTabs';
import { useNavHistory, type Spot } from './history';
import { IndexStatus } from './IndexStatus';
import { KindMark } from './Kind';
import { catalogs } from './messages';
import { Outline, scopeAt } from './Outline';
import { ResultsPanel, type Results } from './ResultsPanel';
import { scopeDir, SearchDialog, type Place, type SearchTab, type StudioAction } from './SearchDialog';
import { moduleTree, useTree, type TreeMode, type TreeNode } from './tree';
import { TreePane } from './TreePane';
import { useGit } from './useGit';

const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isApple ? '⌘' : 'Ctrl+';
const ALT = isApple ? '⌥' : 'Alt+';
const SHIFT = isApple ? '⇧' : 'Shift+';
const KEYS = {
  everywhere: '⇧⇧', classes: `${MOD}O`, files: `${MOD}${SHIFT}O`, symbols: `${MOD}${ALT}O`, text: `${MOD}${SHIFT}F`, find: `${MOD}F`, recent: `${MOD}E`, line: `${MOD}L`,
  back: isApple ? '⌘[' : 'Alt+←', forward: isApple ? '⌘]' : 'Alt+→', declaration: 'F12', usages: `${ALT}F7`, foldAll: `${MOD}${SHIFT}-`, unfoldAll: `${MOD}${SHIFT}=`,
};
const PANES = { tree: { min: 180, max: 640 }, outline: { min: 180, max: 720 }, results: { min: 120, max: 720 } };
/** The narrowest the right pane is drawn while it shows another plugin's view: those are made for the side panel's 320 and up. */
const TOOL_MIN = 340;
/** Renewed well within the server's `watchMs`, so a slow request does not let a build in sight lapse. */
const INDEX_WATCH_MS = CODE_INDEX_BUDGET.watchMs / 3;
/** How often the status is asked for while its details are open. */
const INDEX_DETAIL_MS = 1_000;
/** The longest gap between the two presses of a double Shift. */
const DOUBLE_SHIFT_MS = 350;
/** Closed tabs Reopen Closed Tab can bring back. */
const CLOSED_KEPT = 20;
const narrow = () => window.matchMedia('(max-width: 767px)').matches;

type Menu = { at: { x: number; y: number }; entries: MenuEntry[] };
/** How a file is opened: in the preview tab (a single click in the tree or the results), or in a tab that stays. */
type Opening = 'preview' | 'keep';

/**
 * Code Studio: a project's modules or folders on the left, the open files as tabs with the one shown
 * in the middle, its structure on the right and find results along the bottom, the way Android Studio lays
 * out a project, for reading a repository too large to open there comfortably. Files, definitions, usages
 * and searches come from the core's project routes; the page keeps only what is open and where.
 *
 * Reading works as in the IDE: the file has a caret (F12 declaration, ⌥F7 usages, folding), every jump
 * can be gone back from (⌘[ ⌘]), a single click previews a file in a tab the next click reuses, panes
 * resize and hide, and tabs, tree rows and the code have their own right-click menus.
 */
export default function CodeStudio({ context, header: Header }: ViewProps) {
  const host = usePluginHost();
  const { ui } = host;
  const m = useMessages(catalogs);
  // Work on the server (the index build, searches, blame) runs only while the page is in sight: hidden in the app or in a background tab, it is stopped.
  const shown = useShown(context.visible);
  const all = useProjects();
  // The user's own projects: the app's quick chat, assistant and task folders are not code to browse.
  const projects = useMemo(() => all.filter((item) => !item.system && !item.archivedAt), [all]);
  const [projectId, setProjectId] = useState<string | undefined>(() => savedProject());
  const project = projects.find((item) => item.id === projectId) ?? projects[0];
  // The server and the project are chosen apart (one list of every server's projects is slow to scan), in the page header.
  const servers = useServers();
  const serverOf = host.sessions.serverOf;
  const selfId = servers.find((item) => item.self)?.id ?? '';
  const homeOf = useCallback((id: string) => serverOf?.(id) ?? selfId, [serverOf, selfId]);
  const serverId = project ? homeOf(project.id) : selfId;
  const onServer = useMemo(() => projects.filter((item) => homeOf(item.id) === serverId), [projects, homeOf, serverId]);
  const chooseProject = (id: string) => { setProjectId(id); rememberProject(id, homeOf(id)); };
  /** Any folder on a server, opened as a project (the app's chooser registers it if it is not one yet). */
  const openFolder = (server = serverId) => {
    const sameServer = project && homeOf(project.id) === server;
    void host.sessions.openDirectory?.({ ...(server && server !== selfId ? { server } : {}), ...(sameServer ? { initialPath: project.cwd } : {}) }).then((id) => { if (id) chooseProject(id); });
  };
  const chooseServer = (id: string) => {
    const remembered = savedProject(id);
    const next = projects.find((item) => item.id === remembered && homeOf(item.id) === id) ?? projects.find((item) => homeOf(item.id) === id);
    // A server with no project yet starts at its folders.
    if (next) chooseProject(next.id); else openFolder(id);
  };
  // A linked server by the name the user gave its link (the alias is its short code); this one by its own name.
  const serverName = (id: string) => servers.find((item) => item.id === id)?.name ?? id;
  const ServerIcon = ui.icon('server');
  const FolderIcon = ui.icon('folder');
  const FolderOpenIcon = ui.icon('folder-open');
  const ChevronDown = ui.icon('chevron-down');
  const ChevronRight = ui.icon('chevron-right');
  const scopeBar = Header && ui.Menu ? (
    <Header>
      {servers.length > 1 && (
        <>
          <ChevronRight className="size-3.5 shrink-0 text-fg-4" />
          <ui.Menu
            tip={m.server}
            trigger={<ui.Button size="xs" variant="quiet" className="min-w-0 max-w-56 text-fg-2"><ServerIcon /><span className="truncate">{serverName(serverId)}</span><ChevronDown className="text-fg-4" /></ui.Button>}
            entries={servers.map((item) => ({ kind: 'radio' as const, icon: <ServerIcon />, label: item.online || item.self ? item.name : `${item.name} · ${m.offline}`, checked: item.id === serverId, disabled: !item.online && !item.self, onSelect: () => chooseServer(item.id) }))}
          />
        </>
      )}
      <ChevronRight className="size-3.5 shrink-0 text-fg-4" />
      <ui.Menu
        tip={m.project}
        trigger={<ui.Button size="xs" variant="quiet" className="min-w-0 max-w-64 text-fg-2"><FolderIcon /><span className="truncate">{project?.name ?? m.noProjects}</span><ChevronDown className="text-fg-4" /></ui.Button>}
        entries={[
          ...(onServer.length ? onServer.map((item) => ({ kind: 'radio' as const, icon: <FolderIcon />, label: item.worktree ? `${item.name} · ${item.worktree.branch}` : item.name, checked: item.id === project?.id, onSelect: () => chooseProject(item.id) })) : [{ kind: 'label' as const, label: m.noProjectsOn }]),
          ...(host.sessions.openDirectory ? [{ kind: 'separator' as const }, { kind: 'item' as const, label: m.openFolder, icon: <FolderOpenIcon />, onSelect: () => openFolder() }] : []),
        ]}
      />
    </Header>
  ) : null;
  // One client per project: reads, the tree and the index status start over only when the project changes.
  const request = useRef(host.request);
  request.current = host.request;
  const projectKey = project?.id;
  const api = useMemo(() => (projectKey ? codeApi(() => request.current, projectKey) : undefined), [projectKey]);
  const scope = `${context.serviceId}:${project?.id ?? ''}`;

  const history = useNavHistory();
  const [saved, setSaved] = useState<Saved>(() => loadSaved(scope));
  useEffect(() => { setSaved(loadSaved(scope)); setTarget(undefined); setResults(undefined); history.clear(); }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = useCallback((patch: Partial<Saved>) => setSaved((previous) => { const next = { ...previous, ...patch }; storeSaved(scope, next); return next; }), [scope]);
  const mode: TreeMode = saved.mode ?? 'modules';
  const active = saved.active && saved.tabs.includes(saved.active) ? saved.active : saved.tabs.at(-1);
  const preview = saved.preview && saved.tabs.includes(saved.preview) ? saved.preview : undefined;

  // ── Layout ────────────────────────────────────────────────────────────────
  const [layout, setLayoutState] = useState<Layout>(loadLayout);
  const resize = (patch: Partial<Layout>) => setLayoutState((previous) => ({ ...previous, ...patch }));
  const keepLayout = (patch: Partial<Layout>) => setLayoutState((previous) => { const next = { ...previous, ...patch }; storeLayout(next); return next; });
  // On a phone the tree covers the page until a file is chosen; on a wider screen it is a pane that can be hidden.
  const [treeShown, setTreeShown] = useState(false);
  const toggleTree = () => { if (narrow()) setTreeShown((value) => !value); else keepLayout({ treeHidden: !layout.treeHidden }); };
  const showOutline = saved.outline ?? true;

  // ── Modules and the tree ──────────────────────────────────────────────────
  const [modules, setModules] = useState<{ api: CodeApi; list: CodeModule[] }>();
  const onError = useCallback((message: string) => host.notify.error(new Error(message), m.loadFailed), [host.notify, m.loadFailed]);
  const modulesRead = modules?.api === api;
  useEffect(() => {
    if (!api || !shown || modulesRead) return;
    const controller = new AbortController();
    api.modules(controller.signal).then((found) => setModules({ api, list: found.modules }), (error: unknown) => { if (!controller.signal.aborted) { setModules({ api, list: [] }); host.notify.error(error, m.loadFailed); } });
    return () => controller.abort();
  }, [api, shown, modulesRead]); // eslint-disable-line react-hooks/exhaustive-deps
  // By id and name: the project list is a new array whenever any conversation changes.
  const projectName = project?.name;
  const moduleList = modulesRead ? modules?.list : undefined;
  const roots = useMemo<TreeNode[] | undefined>(() => {
    if (projectName === undefined) return undefined;
    if (mode === 'project') return [{ id: 'd:', label: projectName, kind: 'dir', path: '' }];
    return moduleList ? moduleTree(moduleList, projectName) : undefined;
  }, [mode, moduleList, projectName]);
  const tree = useTree(api, roots, onError);
  const [focus, setFocus] = useState<{ path: string; token: number }>();
  const locate = useCallback((path: string) => {
    if (narrow()) setTreeShown(true); else keepLayout({ treeHidden: false });
    void tree.reveal(path).then((found) => { if (found) setFocus({ path, token: Date.now() }); });
  }, [tree]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Tabs, the caret and the shown place ───────────────────────────────────
  const [target, setTarget] = useState<CodeFileTarget & { path: string }>();
  const [topLine, setTopLine] = useState(1);
  const [caret, setCaret] = useState<{ path: string; line: number; column: number }>();
  /** Where each open file was left, so its tab comes back to it. */
  const tops = useRef(new Map<string, number>());
  /** Tabs closed lately, the last first, for Reopen Closed Tab. */
  const closedTabs = useRef<string[]>([]);
  const token = useRef(0);
  const shownCaret = caret && caret.path === active ? caret : undefined;
  const here = (): Spot | undefined => (active ? { path: active, line: shownCaret?.line ?? topLine, ...(shownCaret ? { column: shownCaret.column } : {}) } : undefined);
  const hereRef = useRef(here);
  hereRef.current = here;

  const show = useCallback((place: Place, how: Opening = 'keep') => {
    setSaved((previous) => {
      const at = previous.tabs.indexOf(place.path);
      let { tabs } = previous;
      let preview = previous.preview && tabs.includes(previous.preview) ? previous.preview : undefined;
      if (at >= 0) {
        if (how === 'keep' && preview === place.path) preview = undefined;
      } else if (how === 'preview' && preview !== undefined) {
        // The preview tab is reused in place.
        tabs = tabs.map((tab) => (tab === preview ? place.path : tab));
        preview = place.path;
      } else {
        // Next to the current tab, as the IDE opens one.
        const after = previous.active ? tabs.indexOf(previous.active) : -1;
        tabs = after >= 0 ? [...tabs.slice(0, after + 1), place.path, ...tabs.slice(after + 1)] : [...tabs, place.path];
        if (how === 'preview') preview = place.path;
      }
      const recent = [place.path, ...(previous.recent ?? []).filter((item) => item !== place.path)].slice(0, MAX_RECENT);
      const next: Saved = { ...previous, tabs, active: place.path, recent };
      if (preview === undefined) delete next.preview; else next.preview = preview;
      storeSaved(scope, next);
      return next;
    });
    const line = place.line ?? (place.path !== hereRef.current()?.path ? tops.current.get(place.path) : undefined);
    if (line !== undefined) setTarget({ path: place.path, line, ...(place.column !== undefined ? { column: place.column } : {}), ...(place.line === undefined ? { restore: true } : {}), token: ++token.current });
  }, [scope]);
  /** A jump: the place left is recorded for Back. */
  const go = useCallback((place: Place, how: Opening = 'keep') => {
    history.leave(hereRef.current());
    show(place, how);
  }, [history, show]);
  const keep = (path: string) => { if (preview === path) update({ preview: undefined }); };
  const closeTabs = (closing: readonly string[]) => {
    if (!closing.length) return;
    const gone = new Set(closing);
    const tabs = saved.tabs.filter((item) => !gone.has(item));
    const at = active ? saved.tabs.indexOf(active) : -1;
    // The tab to the left of the current one takes over when the current one closes, as in the IDE.
    const next = active && !gone.has(active) ? active : saved.tabs.slice(0, Math.max(0, at)).reverse().find((item) => !gone.has(item)) ?? tabs[0];
    for (const path of closing) tops.current.delete(path);
    closedTabs.current = [...[...closing].reverse(), ...closedTabs.current.filter((item) => !gone.has(item))].slice(0, CLOSED_KEPT);
    update({ tabs, active: next, ...(preview && gone.has(preview) ? { preview: undefined } : {}) });
  };
  const back = () => { const to = history.goBack(here()); if (to) show(to); };
  const forward = () => { const to = history.goForward(here()); if (to) show(to); };

  // ── The index ─────────────────────────────────────────────────────────────
  const [index, setIndex] = useState<CodeIndexStatus>();
  const [indexDetail, setIndexDetail] = useState(false);
  // Not `crypto.randomUUID`: a server reached over plain http on the LAN is not a secure context.
  const lease = useMemo(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, []);
  useEffect(() => setIndex(undefined), [api]);
  // The index is built and checked only while this page is in sight: the watch is renewed while shown and dropped on
  // leaving, which stops a build at once (it goes on from there next time). Each renewal answers with the status.
  useEffect(() => {
    if (!api || !shown) return;
    const controller = new AbortController();
    const renew = () => { api.watch(lease, true, controller.signal).then(setIndex, () => undefined); };
    renew();
    const timer = window.setInterval(renew, indexDetail ? INDEX_DETAIL_MS : INDEX_WATCH_MS);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [api, shown, lease, indexDetail]);
  // Dropped on leaving (not when the details open or close, which only changes how often it is renewed).
  useEffect(() => {
    if (!api || !shown) return;
    return () => { api.watch(lease, false).catch(() => undefined); };
  }, [api, shown, lease]);
  // A ready index rechecking changed files keeps answering; only the first build is shown as progress.
  const building = index?.state === 'building';
  const rebuild = () => { api?.rebuild().then(setIndex, (error: unknown) => host.notify.error(error, m.loadFailed)); };

  // ── Outline ───────────────────────────────────────────────────────────────
  const [outline, setOutline] = useState<{ path: string; result?: CodeOutline }>();
  /** Goes up when HEAD moves (a checkout, a commit): the open file, its outline and the tree are read again. */
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!api || !active) return;
    const controller = new AbortController();
    setOutline({ path: active });
    api.outline(active, controller.signal).then((result) => setOutline({ path: active, result }), () => { if (!controller.signal.aborted) setOutline({ path: active, result: { path: active, items: [] } }); });
    return () => controller.abort();
  }, [api, active, revision]);
  const outlineItems = outline && outline.path === active ? outline.result?.items : undefined;

  // ── The right pane: the structure, or another plugin's view of the project (Android build, Logcat) as a tool window ──
  const toolViews = useProjectViews(project?.id);
  const side = saved.side && toolViews.some((view) => view.id === saved.side) ? saved.side : 'structure';
  /**
   * Tool windows opened so far: they stay mounted (hidden) so their state survives switching back. Not reset with the
   * project: each view's instance is keyed by its project, and the ones another project does not offer are not drawn.
   */
  const [mountedTools, setMountedTools] = useState<string[]>([]);
  useEffect(() => { if (side !== 'structure') setMountedTools((previous) => (previous.includes(side) ? previous : [...previous, side])); }, [side]);
  const showSide = (id: string) => update({ side: id, outline: true });
  // A file a tool window opens (a build error's file and line) opens here, in a tab that stays. Stable, as the view keys its host on it.
  const toolFile = useRef<(path: string, line?: number) => void>(undefined);
  toolFile.current = (path, line) => {
    const inProject = project ? projectPath(project.cwd, path) : undefined;
    if (inProject === undefined) { host.notify.error(new Error(m.outsideProject(path)), m.loadFailed); return; }
    go({ path: inProject, ...(line !== undefined ? { line } : {}) });
  };
  const openToolFile = useCallback((path: string, line?: number) => toolFile.current?.(path, line), []);
  const readingLine = shownCaret?.line ?? topLine;
  const symbolChain = scopeAt(outlineItems, readingLine);

  // ── Definitions and usages ────────────────────────────────────────────────
  const [results, setResults] = useState<Results>();
  const lookup = useRef<AbortController>(undefined);
  /** The usages or text search in progress, run again if leaving the page stops it. */
  const rerun = useRef<() => void>(undefined);
  const stopped = useRef<() => void>(undefined);
  useEffect(() => {
    if (shown) { const run = stopped.current; stopped.current = undefined; run?.(); return; }
    stopped.current = rerun.current;
    rerun.current = undefined;
    lookup.current?.abort();
  }, [shown]);
  /** The usages listed, for widening or narrowing their scope. */
  const usageQuery = useRef<{ path: string; word: string }>(undefined);
  const findUsages = useCallback((path: string, word: string, scopeOf: 'module' | 'project') => {
    if (!api) return;
    lookup.current?.abort();
    const controller = lookup.current = new AbortController();
    const base: Results = { title: m.usages(word), locations: [], loading: true, complete: false, scope: scopeOf, match: { text: word, atColumn: true, matchCase: true } };
    setResults(base);
    rerun.current = () => findUsages(path, word, scopeOf);
    api.references({ path, word, scope: scopeOf }, controller.signal).then(
      (found) => { rerun.current = undefined; setResults({ ...base, locations: found.locations, complete: found.complete, loading: false }); },
      (error: unknown) => { if (!controller.signal.aborted) { rerun.current = undefined; setResults({ ...base, loading: false, error: host.notify.errorText(error, m.loadFailed) }); } },
    );
    usageQuery.current = { path, word };
  }, [api, host.notify, m]);
  const goToDeclaration = useCallback((path: string, at: CodeSymbolAt) => {
    if (!api) return;
    lookup.current?.abort();
    rerun.current = undefined;
    const controller = lookup.current = new AbortController();
    api.definition({ path, ...at }, controller.signal).then(({ locations }) => {
      if (controller.signal.aborted) return;
      if (!locations.length) { setResults({ title: m.noDefinition(at.word), locations: [], loading: false, complete: true }); return; }
      // F12 or ⌘-click on a declaration itself lists its usages, as Studio does.
      if (locations.length === 1 && locations[0]!.path === path && locations[0]!.line === at.line) { findUsages(path, at.word, 'project'); return; }
      if (locations.length === 1) { go(locations[0]!); return; }
      setResults({ title: m.definitions(at.word), locations, loading: false, complete: true, match: { text: at.word, atColumn: true, matchCase: true } });
    }, (error: unknown) => { if (!controller.signal.aborted) host.notify.error(error, m.loadFailed); });
  }, [api, findUsages, go, host.notify, m]);

  const findOptions: TextOptions = saved.find ?? TEXT_OPTIONS;
  // The open file's module: the deepest module directory that holds it.
  const moduleDir = useMemo(() => {
    if (!active || !moduleList) return undefined;
    let best: string | undefined;
    for (const item of moduleList) if (item.path && active.startsWith(`${item.path}/`) && (best === undefined || item.path.length > best.length)) best = item.path;
    return best;
  }, [active, moduleList]);
  const textSearch = useCallback((query: string) => {
    if (!api) return;
    lookup.current?.abort();
    const controller = lookup.current = new AbortController();
    const base: Results = { title: m.textResults(query), locations: [], loading: true, complete: false, match: { text: query, matchCase: findOptions.matchCase, regex: findOptions.regex } };
    setResults(base);
    rerun.current = () => textSearch(query);
    const located = (found: SearchResults) => found.hits.map((hit) => ({ path: hit.path, line: hit.line, column: 1, text: hit.text }));
    findInFiles(api, query, findOptions, scopeDir(findOptions, moduleDir), 1_000, controller.signal, (part) => { if (!controller.signal.aborted) setResults({ ...base, locations: located(part) }); }).then(
      (found) => { rerun.current = undefined; setResults({ ...base, loading: false, complete: !found.more && !found.incomplete, locations: located(found) }); },
      (error: unknown) => { if (!controller.signal.aborted) { rerun.current = undefined; setResults({ ...base, loading: false, error: host.notify.errorText(error, m.loadFailed) }); } },
    );
  }, [api, host.notify, m, findOptions, moduleDir]);

  // ── Git ───────────────────────────────────────────────────────────────────
  const git = useGit({ api, active, shown, onBlameError: (error) => host.notify.error(error, m.blameFailed) });
  const { head, annotate, setAnnotate } = git;
  const headHash = head?.head;
  const seenHead = useRef<string>(undefined);
  useEffect(() => {
    const before = seenHead.current;
    seenHead.current = headHash;
    if (!before || !headHash || before === headHash) return;
    // HEAD moved under the page: what is open is read again, where the reader was.
    setRevision((value) => value + 1);
    tree.refresh();
    const path = hereRef.current()?.path;
    if (path) setTarget({ path, line: tops.current.get(path) ?? 1, restore: true, token: ++token.current });
    if (api) api.modules().then((found) => setModules((previous) => (previous && JSON.stringify(previous.list) === JSON.stringify(found.modules) ? previous : { api, list: found.modules })), () => undefined);
  }, [headHash]); // eslint-disable-line react-hooks/exhaustive-deps
  // Local branches, read when the branch menu opens.
  const [refs, setRefs] = useState<{ list?: GitRefs; error?: string }>();
  const [switching, setSwitching] = useState(false);
  const readRefs = (open: boolean) => {
    if (!open || !api) return;
    api.refs().then((list) => setRefs({ list }), (error: unknown) => setRefs({ error: host.notify.errorText(error, m.loadFailed) }));
  };
  useEffect(() => setRefs(undefined), [api]);
  const switchBranch = (branch: string) => {
    if (!api || switching || branch === head?.branch) return;
    setSwitching(true);
    api.switchBranch(branch).then((list) => { setRefs({ list }); git.readHead(); }, (error: unknown) => host.notify.error(error, m.branches.switchFailed)).finally(() => setSwitching(false));
  };

  // ── Search ────────────────────────────────────────────────────────────────
  const [searchTab, setSearchTab] = useState<SearchTab>('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const openSearch = useCallback((tab: SearchTab, query?: string) => {
    setSearchTab(tab);
    if (query !== undefined) setSearchQuery(query);
    setSearchOpen(true);
    setSearchFocus((value) => value + 1);
  }, []);
  const findInFolder = (path: string) => {
    update({ find: path ? { ...findOptions, scope: 'folder', folder: path } : { ...findOptions, scope: 'project' } });
    openSearch('text');
  };

  // ── The bottom panel: find results, or a file against HEAD ───────────────
  const [changes, setChanges] = useState<Changes>();
  const [commit, setCommit] = useState<{ hash: string; from?: string }>();
  const showCommit = useCallback((hash: string, from?: string) => {
    lookup.current?.abort();
    rerun.current = undefined;
    setResults(undefined);
    setChanges(undefined);
    setCommit({ hash, ...(from ? { from } : {}) });
  }, []);
  const compare = useCallback((path: string) => {
    if (!api) return;
    lookup.current?.abort();
    rerun.current = undefined;
    setResults(undefined);
    setCommit(undefined);
    const controller = lookup.current = new AbortController();
    setChanges({ path, loading: true });
    Promise.all([api.fileAtHead(path, controller.signal), api.file(path, controller.signal)]).then(([before, after]) => {
      if (controller.signal.aborted) return;
      if (before.binary || after.binary || before.truncated || after.truncated) { setChanges({ path, loading: false, error: m.tooLargeToCompare }); return; }
      setChanges({ path, loading: false, before: before.missing ? undefined : before.text ?? '', after: after.content });
    }, (error: unknown) => { if (!controller.signal.aborted) setChanges({ path, loading: false, error: host.notify.errorText(error, m.loadFailed) }); });
  }, [api, host.notify, m]);
  // One of them shows; a new find takes the place of a comparison or a commit.
  useEffect(() => { if (results) { setChanges(undefined); setCommit(undefined); } }, [results]);

  // ── Menus ─────────────────────────────────────────────────────────────────
  const [menu, setMenu] = useState<Menu>();
  const openMenu = (point: { x: number; y: number }, entries: MenuEntry[]) => { if (entries.length) setMenu({ at: point, entries }); };
  const quote = host.navigation.quote;
  const icon = (name: Parameters<typeof ui.icon>[0]): ReactNode => { const Icon = ui.icon(name); return <Icon />; };
  const [command, setCommand] = useState<{ name: EditorCommand; token: number }>();
  /** Annotate asked for another file: switched on once that file is the open one. */
  const annotateNext = useRef<string>(undefined);
  useEffect(() => { if (active && annotateNext.current === active) { annotateNext.current = undefined; setAnnotate(true); } }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const menuActions: MenuActions = {
    m, icon, keys: KEYS, root: project?.cwd ?? '', hasGit: Boolean(head), canQuote: Boolean(quote && project), annotating: annotate,
    active, activePackage: outline && outline.path === active ? outline.result?.package : undefined,
    open: (path, line, column) => go({ path, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) }),
    locate: (path) => locate(path),
    declaration: (path, at) => goToDeclaration(path, at),
    usages: (path, word) => findUsages(path, word, 'project'),
    findText: (query) => openSearch('text', query),
    findInFolder: (path) => findInFolder(path),
    copy: (text) => { void ui.copy(text); },
    showCommit,
    closeAnnotations: () => setAnnotate(false),
    quote: (path, line) => { if (quote && project) quote(project.id, { path, ...(line !== undefined ? { line } : {}) }); },
    annotate: (path) => { if (path === active) setAnnotate(true); else { annotateNext.current = path; go({ path }); } },
    compare,
    editor: (name) => setCommand((previous) => ({ name, token: (previous?.token ?? 0) + 1 })),
  };
  const onSymbol = useCallback((at: CodeSymbolAt, intent: 'definition' | 'usages' | 'menu') => {
    if (!active) return;
    if (intent === 'definition') goToDeclaration(active, at);
    else if (intent === 'usages') findUsages(active, at.word, 'project');
  }, [active, goToDeclaration, findUsages]);
  // Maximizing the editor hides the side panes and the bottom panel until it is restored, as the IDE's double click on a tab does.
  const [maximized, setMaximized] = useState(false);
  // A new find or comparison is shown even in a maximized editor: it is what the reader just asked for.
  const bottomKey = changes ? `c:${changes.path}` : commit ? `g:${commit.hash}` : results ? `r:${results.title}` : '';
  useEffect(() => { if (bottomKey) setMaximized(false); }, [bottomKey]);
  const tabMenu = (path: string | undefined, point: { x: number; y: number }) => {
    const reopen = closedTabs.current.find((item) => !saved.tabs.includes(item));
    const layoutEntries: MenuEntry[] = [
      { kind: 'item', label: maximized ? m.menu.restore : m.menu.maximize, icon: icon(maximized ? 'minimize' : 'maximize'), onSelect: () => setMaximized((value) => !value) },
      { kind: 'item', label: m.menu.reopenClosed, icon: icon('rotate-ccw'), disabled: !reopen, onSelect: () => { if (reopen) go({ path: reopen }); } },
    ];
    if (!path) { openMenu(point, [{ kind: 'item', label: m.menu.closeAll, icon: icon('square-x'), disabled: !saved.tabs.length, onSelect: () => closeTabs(saved.tabs) }, { kind: 'separator' }, ...layoutEntries]); return; }
    const at = saved.tabs.indexOf(path);
    openMenu(point, tidy([
      { kind: 'item', label: m.menu.close, icon: icon('x'), onSelect: () => closeTabs([path]) },
      { kind: 'item', label: m.menu.closeOthers, icon: icon('copy-x'), disabled: saved.tabs.length < 2, onSelect: () => closeTabs(saved.tabs.filter((item) => item !== path)) },
      { kind: 'item', label: m.menu.closeRight, icon: icon('arrow-right-to-line'), disabled: at === saved.tabs.length - 1, onSelect: () => closeTabs(saved.tabs.slice(at + 1)) },
      { kind: 'item', label: m.menu.closeAll, icon: icon('square-x'), onSelect: () => closeTabs(saved.tabs) },
      ...(path === preview ? [{ kind: 'item' as const, label: m.menu.keep, icon: icon('pin'), onSelect: () => keep(path) }] : []),
      { kind: 'separator' },
      ...layoutEntries,
      { kind: 'separator' },
      ...fileMenu(menuActions, path),
    ]));
  };
  const treeMenu = (node: TreeNode | undefined, point: { x: number; y: number }) => {
    if (!node) {
      openMenu(point, tidy([
        ...(active ? [{ kind: 'item' as const, label: m.actions.locate, icon: icon('target'), onSelect: () => locate(active) }] : []),
        { kind: 'item', label: m.collapseAll, icon: icon('chevrons-down-up'), onSelect: tree.collapse },
        { kind: 'submenu', label: m.treeView, icon: icon('list-filter'), entries: [
          { kind: 'radio', label: m.views.modules, checked: mode === 'modules', onSelect: () => update({ mode: 'modules' }) },
          { kind: 'radio', label: m.views.project, checked: mode === 'project', onSelect: () => update({ mode: 'project' }) },
        ] },
        { kind: 'separator' },
        ...folderMenu(menuActions, ''),
      ]));
      return;
    }
    const { path } = node;
    if (path === undefined) return;
    if (node.kind === 'file') openMenu(point, tidy([{ kind: 'item', label: m.menu.openInTab, icon: icon('pin'), onSelect: () => go({ path }) }, ...fileMenu(menuActions, path)]));
    else openMenu(point, folderMenu(menuActions, path));
  };
  const codeMenuAt = (at: CodeMenuAt, point: { x: number; y: number }) => {
    if (!active) return;
    openMenu(point, at.blame ? blameMenu(menuActions, active, at.blame) : codeMenu(menuActions, active, at, scopeAt(outlineItems, at.line)));
  };

  // ── Keys ──────────────────────────────────────────────────────────────────
  const page = useRef<HTMLDivElement>(null);
  const visible = useRef(context.visible);
  visible.current = context.visible;
  const keyActions = useRef({ back, forward });
  keyActions.current = { back, forward };
  useEffect(() => {
    // Only while the page has focus or the pointer's last press was in it: the workbench keeps its own keys elsewhere.
    const inPage = () => visible.current && (page.current?.contains(document.activeElement) || document.activeElement === document.body);
    // Shift pressed twice with nothing between opens the All tab, as in the IDE.
    let shiftAt = 0;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Shift') shiftAt = 0;
      if (!inPage() || event.defaultPrevented) return;
      // Back and forward: ⌘[ ⌘] (and ⌃- ⌃⇧-) on a Mac, Alt+← Alt+→ elsewhere.
      const backKey = isApple ? (event.metaKey && !event.shiftKey && event.code === 'BracketLeft') || (event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === 'Minus') : event.altKey && !event.ctrlKey && event.key === 'ArrowLeft';
      const forwardKey = isApple ? (event.metaKey && !event.shiftKey && event.code === 'BracketRight') || (event.ctrlKey && !event.metaKey && event.shiftKey && event.code === 'Minus') : event.altKey && !event.ctrlKey && event.key === 'ArrowRight';
      if (backKey || forwardKey) { event.preventDefault(); keyActions.current[backKey ? 'back' : 'forward'](); return; }
      if (!(isApple ? event.metaKey : event.ctrlKey)) return;
      // By physical key, so ⌥ on a Mac (which changes `key`) still reads as O.
      const key = event.code;
      if (key === 'KeyE' && !event.shiftKey && !event.altKey) { event.preventDefault(); openSearch('files', ''); return; }
      if (key === 'KeyL' && !event.shiftKey && !event.altKey) { event.preventDefault(); openSearch('all', ':'); return; }
      const pick: SearchTab | undefined = key === 'KeyO' ? (event.altKey ? 'symbols' : event.shiftKey ? 'files' : 'classes')
        : key === 'KeyF' && event.shiftKey && !event.altKey ? 'text' : undefined;
      if (!pick) return;
      event.preventDefault();
      openSearch(pick);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Shift' || event.metaKey || event.ctrlKey || event.altKey) { shiftAt = 0; return; }
      if (!inPage()) return;
      const now = event.timeStamp;
      if (shiftAt && now - shiftAt < DOUBLE_SHIFT_MS) { shiftAt = 0; openSearch('all'); return; }
      shiftAt = now;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); };
  }, [openSearch]);

  // The path bar keeps its end in view: the file and its package, not the repository's top folders.
  const crumbs = useRef<HTMLElement>(null);
  useEffect(() => { const bar = crumbs.current; if (bar) bar.scrollLeft = bar.scrollWidth; }, [active, symbolChain.length]);

  // The page's commands, for the search dialog's Actions tab.
  const hasGit = Boolean(head);
  const actions: StudioAction[] = [];
  if (api && project) {
    if (active) {
      actions.push({ id: 'locate', label: m.actions.locate, icon: icon('target'), run: () => locate(active) });
      if (quote) actions.push({ id: 'quote', label: m.actions.quote, icon: icon('text-quote'), run: () => quote(project.id, { path: active }) });
      if (hasGit) actions.push({ id: 'annotate', label: annotate ? m.actions.closeAnnotate : m.actions.annotate, icon: icon('git-commit-horizontal'), run: () => setAnnotate((value) => !value) });
      if (hasGit) actions.push({ id: 'compare', label: m.git.compare, icon: icon('git-compare'), run: () => compare(active) });
      actions.push({ id: 'line', label: m.actions.goToLine, icon: icon('hash'), shortcut: KEYS.line, run: () => openSearch('all', ':') });
    }
    actions.push(
      { id: 'back', label: m.actions.back, icon: icon('arrow-left'), shortcut: KEYS.back, run: back },
      { id: 'forward', label: m.actions.forward, icon: icon('arrow-right'), shortcut: KEYS.forward, run: forward },
      { id: 'recent', label: m.actions.recent, icon: icon('history'), shortcut: KEYS.recent, run: () => openSearch('files', '') },
      { id: 'maximize', label: maximized ? m.menu.restore : m.menu.maximize, icon: icon(maximized ? 'minimize' : 'maximize'), run: () => setMaximized((value) => !value) },
      { id: 'tree', label: layout.treeHidden ? m.actions.showTree : m.actions.hideTree, icon: icon('panel-left'), run: toggleTree },
      { id: 'outline', label: showOutline ? m.actions.hideOutline : m.actions.showOutline, icon: icon('panel-right'), run: () => update({ outline: !showOutline }) },
      { id: 'modules', label: m.actions.modules, icon: icon('package'), run: () => update({ mode: 'modules' }) },
      { id: 'files', label: m.actions.files, icon: icon('folder'), run: () => update({ mode: 'project' }) },
      { id: 'collapse', label: m.actions.collapse, icon: icon('chevrons-down-up'), run: tree.collapse },
      { id: 'rebuild', label: m.actions.rebuild, icon: icon('refresh-cw'), run: rebuild },
    );
    for (const view of toolViews) { const Icon = view.icon; actions.push({ id: `tool:${view.id}`, label: m.showTool(view.title), icon: <Icon />, run: () => showSide(view.id) }); }
    if (host.sessions.openDirectory) actions.push({ id: 'open-folder', label: m.openFolder, icon: icon('folder-open'), run: () => openFolder() });
    if (saved.tabs.length) actions.push({ id: 'close-tabs', label: m.actions.closeTabs, icon: icon('square-x'), run: () => closeTabs(saved.tabs) });
  }

  if (!project || !api) {
    return (
      <>
        {scopeBar}
        <EmptyState className="flex-1" title={m.noProjects}>{host.sessions.openDirectory && <ui.Button variant="secondary" onClick={() => openFolder()}>{m.openFolder}</ui.Button>}</EmptyState>
      </>
    );
  }
  const PanelLeft = ui.icon('panel-left');
  const PanelRight = ui.icon('panel-right');
  const ArrowLeft = ui.icon('arrow-left');
  const ArrowRight = ui.icon('arrow-right');
  const Chevron = ui.icon('chevron-right');
  const Target = ui.icon('target');
  const Quote = ui.icon('text-quote');
  const Search = ui.icon('search');
  const Branch = ui.icon('git-branch');
  const Filter = ui.icon('list-filter');
  const Collapse = ui.icon('chevrons-down-up');
  const shownTarget = target && target.path === active ? target : undefined;
  const treeVisible = !layout.treeHidden && !maximized;
  const point = (event: { preventDefault(): void; clientX: number; clientY: number }) => { event.preventDefault(); return { x: event.clientX, y: event.clientY }; };
  const start: Array<{ label: string; keys: string; run(): void }> = [
    { label: m.start.everywhere, keys: KEYS.everywhere, run: () => openSearch('all') },
    { label: m.start.classes, keys: KEYS.classes, run: () => openSearch('classes') },
    { label: m.start.files, keys: KEYS.files, run: () => openSearch('files') },
    { label: m.start.recent, keys: KEYS.recent, run: () => openSearch('files', '') },
    { label: m.start.text, keys: KEYS.text, run: () => openSearch('text') },
  ];

  return (
    <div
      ref={page} className="flex h-full min-h-0 flex-col"
      // Escape belongs to the reader here, as in an IDE (close a find, leave a selection, restore a maximized editor): it never closes the page.
      onKeyDown={(event) => { if (event.key !== 'Escape' || event.defaultPrevented) return; event.preventDefault(); if (maximized) setMaximized(false); }}
    >
      {scopeBar}
      <SearchDialog
        api={api} projectId={project.id} messages={m} open={searchOpen && shown} onOpenChange={setSearchOpen} tab={searchTab} onTabChange={setSearchTab} focusToken={searchFocus}
        query={searchQuery} onQueryChange={setSearchQuery} options={findOptions} onOptionsChange={(find) => update({ find })} module={moduleDir}
        recent={saved.recent ?? []} actions={actions} activeFile={active} onPick={(place) => go(place)} onTextResults={textSearch}
      />
      {ui.ContextMenu && <ui.ContextMenu at={menu?.at} entries={menu?.entries ?? []} onClose={() => setMenu(undefined)} />}

      <div className="relative flex min-h-0 flex-1">
        {/* Project tree. On a phone it covers the page until a file is chosen. */}
        <aside
          style={{ width: layout.tree }}
          className={cn('relative flex min-h-0 shrink-0 flex-col edge-r bg-bg max-md:absolute max-md:inset-0 max-md:z-(--z-panel) max-md:w-full!', !treeVisible && 'md:hidden', !treeShown && 'max-md:hidden')}
        >
          {/* A host before 2026-11 has no header slot: the choosers sit atop the tree there. */}
          {!scopeBar && ui.Select && (servers.length > 1 || onServer.length > 1) && (
            <div className="flex shrink-0 items-center gap-1.5 edge-b px-2 py-1.5">
              {servers.length > 1 && <ui.Select className="min-w-0 flex-1" label={m.server} value={serverId} onChange={chooseServer} options={servers.map((item) => ({ value: item.id, label: item.name }))} />}
              {onServer.length > 1 && <ui.Select className="min-w-0 flex-[1.4]" label={m.project} value={project.id} onChange={chooseProject} options={onServer.map((item) => ({ value: item.id, label: item.name }))} />}
            </div>
          )}
          <div className="flex h-9 shrink-0 items-center gap-0.5 edge-b pl-3 pr-1">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg-2">{m.views[mode]}</span>
            {active && <ui.Tip label={m.locate}><ui.Button size="icon-xs" variant="quiet" aria-label={m.locate} onClick={() => locate(active)}><Target /></ui.Button></ui.Tip>}
            <ui.Tip label={m.collapseAll}><ui.Button size="icon-xs" variant="quiet" aria-label={m.collapseAll} onClick={tree.collapse}><Collapse /></ui.Button></ui.Tip>
            {ui.Menu && (
              <ui.Menu
                align="end" tip={m.treeView}
                trigger={<ui.Button size="icon-xs" variant="quiet" aria-label={m.treeView}><Filter /></ui.Button>}
                entries={[
                  { kind: 'radio', label: m.views.modules, icon: icon('package'), checked: mode === 'modules', onSelect: () => update({ mode: 'modules' }) },
                  { kind: 'radio', label: m.views.project, icon: icon('folder'), checked: mode === 'project', onSelect: () => update({ mode: 'project' }) },
                ]}
              />
            )}
          </div>
          {roots ? (
            <TreePane
              rows={tree.rows} active={active} focus={focus} label={m.views[mode]} onToggle={tree.toggle} onMenu={treeMenu}
              onOpen={(path) => { go({ path }, 'preview'); setTreeShown(false); }}
              onKeep={(path) => { go({ path }); setTreeShown(false); }}
            />
          ) : <div className="flex justify-center py-6"><ui.Spinner /></div>}
          {ui.ResizeHandle && (
            <ui.ResizeHandle
              axis="x" grow={1} value={layout.tree} min={PANES.tree.min} max={PANES.tree.max} label={m.resizeTree} className="absolute inset-y-0 -right-1 w-2 max-md:hidden"
              onPreview={(tree) => resize({ tree })} onChange={(tree) => keepLayout({ tree })} onReset={() => keepLayout({ tree: LAYOUT.tree })}
            />
          )}
        </aside>

        {/* Tabs, the file's place and the file. */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-stretch edge-b">
            <div className="flex shrink-0 items-center gap-0.5 px-1.5">
              <ui.Tip label={treeVisible ? m.actions.hideTree : m.actions.showTree}>
                <ui.Button size="icon-sm" variant="quiet" aria-label={m.views[mode]} aria-pressed={treeVisible} onClick={toggleTree}><PanelLeft /></ui.Button>
              </ui.Tip>
              <ui.Tip label={m.actions.back} kbd={KEYS.back}><ui.Button size="icon-sm" variant="quiet" aria-label={m.actions.back} disabled={!history.canBack} onClick={back}><ArrowLeft /></ui.Button></ui.Tip>
              <ui.Tip label={m.actions.forward} kbd={KEYS.forward}><ui.Button size="icon-sm" variant="quiet" aria-label={m.actions.forward} disabled={!history.canForward} onClick={forward}><ArrowRight /></ui.Button></ui.Tip>
            </div>
            <EditorTabs
              tabs={saved.tabs} active={active} preview={preview} messages={m} onMenu={tabMenu}
              // A preview tab is kept; any other maximizes the editor, or restores it, as the IDE's double click does.
              onDoubleClick={(path) => { if (path === preview) keep(path); else setMaximized((value) => !value); }}
              onSelect={(path) => { if (path !== active) go({ path }); }}
              onClose={(path) => closeTabs([path])}
            />
            <div className="flex shrink-0 items-center gap-0.5 px-1.5">
              <ui.Tip label={m.search} kbd={KEYS.everywhere}><ui.Button size="icon-sm" variant="quiet" aria-label={m.search} onClick={() => openSearch('all')}><Search /></ui.Button></ui.Tip>
              <ui.Tip label={m.outline}><ui.Button size="icon-sm" variant="quiet" className="max-md:hidden" aria-label={m.outline} aria-pressed={showOutline} onClick={() => update({ outline: !showOutline })}><PanelRight /></ui.Button></ui.Tip>
            </div>
          </div>
          {active && (
            <div className="flex h-7 shrink-0 items-center gap-1 edge-b pr-1">
              <nav ref={crumbs} aria-label={active} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap px-3 text-xs text-fg-3 scrollbar-none">
                {active.split('/').map((segment, at, parts) => {
                  const path = parts.slice(0, at + 1).join('/');
                  const last = at === parts.length - 1;
                  return (
                    <span key={at} className="flex items-center gap-0.5">
                      {at > 0 && <Chevron className="size-3 text-fg-4" />}
                      <span onContextMenu={(event) => openMenu(point(event), last ? fileMenu(menuActions, path) : folderMenu(menuActions, path))} className={cn('rounded px-0.5 hover:bg-hover', last && 'text-fg-2')}>{segment}</span>
                    </span>
                  );
                })}
                {/* Where the caret is in the file's declarations, as the IDE's breadcrumbs show it. */}
                {symbolChain.map((item, at) => (
                  <span key={`${item.line}:${item.name}`} className="flex items-center gap-0.5">
                    <Chevron className="size-3 text-fg-4" />
                    <button type="button" onClick={() => go({ path: active, line: item.line, column: item.column })} onContextMenu={(event) => openMenu(point(event), declarationMenu(menuActions, active, item, symbolChain.slice(0, at + 1)))} className="flex items-center gap-0.5 rounded px-1 text-fg-2 hover:bg-hover hover:text-fg">
                      <KindMark kind={item.kind} className="w-3" />{item.name}
                    </button>
                  </span>
                ))}
              </nav>
              {quote && <ui.Tip label={m.quoteFile}><ui.Button size="icon-xs" variant="quiet" aria-label={m.quoteFile} onClick={() => quote(project.id, { path: active })}><Quote /></ui.Button></ui.Tip>}
            </div>
          )}
          {active && ui.CodeFile ? (
            <ui.CodeFile
              key={`${active}:${revision}`} projectId={project.id} path={active} target={shownTarget} onSymbol={onSymbol} onViewport={git.onViewport} folding
              command={command} onMenu={codeMenuAt}
              onTopLine={(line: number) => { setTopLine(line); tops.current.set(active, line); }}
              onCaret={(line: number, column: number) => setCaret({ path: active, line, column })}
              baseline={git.baseline} blame={git.blame} onBlameCommit={(hash: string) => showCommit(hash, active)}
              {...(quote ? { onLine: (line: { path: string; line: number; text: string }) => quote(project.id, line) } : {})}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <div className="grid w-full max-w-72 gap-0.5">
                {start.map((item) => (
                  <button key={item.label} type="button" onClick={item.run} className="flex h-8 items-center justify-between gap-6 rounded-lg px-3 text-sm text-fg-2 hover:bg-hover hover:text-fg">
                    <span>{item.label}</span>
                    <kbd className="font-sans text-xs text-fg-4">{item.keys}</kbd>
                  </button>
                ))}
              </div>
            </div>
          )}

          {(results || changes || commit) && !maximized && (
            <>
              <div style={{ height: layout.results }} className="relative shrink-0 edge-t">
                {ui.ResizeHandle && (
                  <ui.ResizeHandle
                    axis="y" grow={-1} value={layout.results} min={PANES.results.min} max={PANES.results.max} label={m.resizeResults} className="absolute inset-x-0 -top-1 h-2"
                    onPreview={(value) => resize({ results: value })} onChange={(value) => keepLayout({ results: value })} onReset={() => keepLayout({ results: LAYOUT.results })}
                  />
                )}
                {changes ? (
                  <ChangesPanel changes={changes} messages={m} onOpen={(path) => go({ path })} onClose={() => { lookup.current?.abort(); setChanges(undefined); }} />
                ) : commit ? (
                  <CommitPanel api={api} hash={commit.hash} from={commit.from} messages={m} onOpen={(path) => go({ path })} onClose={() => setCommit(undefined)} />
                ) : results && (
                  <ResultsPanel
                    results={results} messages={m} current={shownTarget ? { path: shownTarget.path, line: shownTarget.line } : undefined}
                    onOpen={(place) => go(place, 'preview')} onKeep={(place) => go(place)}
                    onMenu={(target, at, groups) => {
                      const fold: MenuEntry[] = [{ kind: 'item', label: m.menu.expandResults, icon: icon('chevrons-up-down'), onSelect: groups.expand }, { kind: 'item', label: m.menu.collapseResults, icon: icon('chevrons-down-up'), onSelect: groups.collapse }];
                      if (!target) openMenu(at, [...fold, { kind: 'separator' }, { kind: 'item', label: m.closePanel, icon: icon('x'), onSelect: () => { lookup.current?.abort(); rerun.current = undefined; setResults(undefined); } }]);
                      else if (target.location) { const { location } = target; openMenu(at, lineMenu(menuActions, location.path, location.line, location.text, () => go({ path: location.path, line: location.line, column: location.column }))); }
                      else openMenu(at, tidy([{ kind: 'item', label: m.menu.open, icon: icon('file'), onSelect: () => go({ path: target.path }) }, ...fold, { kind: 'separator' }, ...fileMenu(menuActions, target.path)]));
                    }}
                    onClose={() => { lookup.current?.abort(); rerun.current = undefined; setResults(undefined); }}
                    {...(results.scope && usageQuery.current ? { onScope: (next: 'module' | 'project') => findUsages(usageQuery.current!.path, usageQuery.current!.word, next) } : {})}
                  />
                )}
              </div>
            </>
          )}
        </main>

        {showOutline && !maximized && (active || side !== 'structure') && (() => {
          const width = side === 'structure' ? layout.outline : Math.max(layout.outline, TOOL_MIN);
          const tabs = [{ id: 'structure', title: m.outline }, ...toolViews];
          const ToolView = ui.ProjectView;
          return (
            <aside aria-label={side === 'structure' ? m.outline : toolViews.find((view) => view.id === side)?.title ?? m.sidePane} style={{ width }} className="relative flex min-h-0 shrink-0 flex-col edge-l max-md:hidden">
              {ui.ResizeHandle && (
                <ui.ResizeHandle
                  axis="x" grow={-1} value={width} min={side === 'structure' ? PANES.outline.min : TOOL_MIN} max={PANES.outline.max} label={m.resizeOutline} className="absolute inset-y-0 -left-1 w-2"
                  onPreview={(value) => resize({ outline: value })} onChange={(value) => keepLayout({ outline: value })} onReset={() => keepLayout({ outline: LAYOUT.outline })}
                />
              )}
              {toolViews.length ? (
                // The structure and the project's tool windows share the pane, one at a time, as the IDE's right tool windows do.
                <div role="tablist" aria-label={m.sidePane} className="flex h-9 shrink-0 items-stretch overflow-x-auto edge-b px-1 scrollbar-none">
                  {tabs.map((tab) => (
                    <button
                      key={tab.id} type="button" role="tab" aria-selected={tab.id === side} onClick={() => showSide(tab.id)}
                      className={cn(
                        'relative flex shrink-0 items-center px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus',
                        'after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full',
                        tab.id === side ? 'font-medium text-fg after:bg-fg' : 'text-fg-3 hover:text-fg',
                      )}
                    >
                      {tab.title}
                    </button>
                  ))}
                </div>
              ) : <div className="flex h-9 shrink-0 items-center edge-b px-3 text-xs font-medium text-fg-2">{m.outline}</div>}
              {side === 'structure' && active && (
                <Outline
                  items={outlineItems} loading={outline?.path === active && !outline.result}
                  line={readingLine} messages={m} onJump={(line, column) => go({ path: active, line, column })}
                  onMenu={(item, chain, at) => openMenu(at, declarationMenu(menuActions, active, item, chain))}
                />
              )}
              {side === 'structure' && !active && <p className="px-3 py-2 text-xs text-fg-3">{m.noFile}</p>}
              {ToolView && mountedTools.filter((id) => toolViews.some((view) => view.id === id)).map((id) => (
                <div key={id} className={cn('flex min-h-0 flex-1 flex-col', id !== side && 'hidden')}>
                  <ToolView projectId={project.id} viewId={id} visible={id === side && shown} onOpenFile={openToolFile} />
                </div>
              ))}
            </aside>
          );
        })()}
      </div>

      {/* Status: how far the index is, and where the reader is. */}
      <div className="flex h-6 shrink-0 items-center gap-3 edge-t px-2 text-2xs text-fg-3">
        {index && <IndexStatus index={index} building={building} messages={m} onRebuild={rebuild} onOpenChange={setIndexDetail} />}
        <span className="flex-1" />
        {head && (() => {
          const trigger = (
            <button type="button" title={head.head} className="flex min-w-0 items-center gap-1 rounded px-1 hover:bg-hover hover:text-fg">
              {switching ? <ui.Spinner className="size-3" /> : <Branch className="size-3 shrink-0" />}<span className="truncate">{head.branch ?? head.short}</span>
            </button>
          );
          const copies: MenuEntry[] = [
            ...(head.branch ? [{ kind: 'item' as const, label: m.menu.copyBranch, icon: icon('copy'), onSelect: () => { void ui.copy(head.branch!); } }] : []),
            { kind: 'item', label: m.menu.copyRevision, icon: icon('copy'), onSelect: () => { void ui.copy(head.head); } },
          ];
          // The local branches, the checked out one ticked, as the IDE's branch widget lists them; choosing one checks it out.
          const branches: MenuEntry[] = !refs ? [{ kind: 'label', label: m.branches.loading }]
            : refs.error ? [{ kind: 'label', label: refs.error }]
              : refs.list?.branches.length ? refs.list.branches.map((branch) => ({
                kind: 'radio' as const, icon: icon('git-branch'), checked: branch.name === head.branch, disabled: switching || (branch.elsewhere && branch.name !== head.branch),
                label: branch.elsewhere ? `${branch.name} · ${m.branches.elsewhere}` : branch.name, onSelect: () => switchBranch(branch.name),
              })) : [{ kind: 'label', label: m.branches.none }];
          return ui.Menu
            ? <ui.Menu align="end" trigger={trigger} onOpenChange={readRefs} entries={[{ kind: 'label', label: m.branches.local }, ...branches, { kind: 'separator' }, ...copies]} />
            : trigger;
        })()}
        {active && (
          <ui.Tip label={m.actions.goToLine} kbd={KEYS.line}>
            <button
              type="button" onClick={() => openSearch('all', ':')} className="rounded px-1 tabular-nums hover:bg-hover hover:text-fg"
              onContextMenu={(event) => openMenu(point(event), [
                { kind: 'item', label: m.actions.goToLine, icon: icon('hash'), shortcut: KEYS.line, onSelect: () => openSearch('all', ':') },
                { kind: 'item', label: m.copy.withLine, icon: icon('link'), onSelect: () => { void ui.copy(`${active}:${shownCaret?.line ?? topLine}`); } },
              ])}
            >
              {shownCaret ? m.lineColumn(shownCaret.line, shownCaret.column) : m.lineColumn(topLine)}
            </button>
          </ui.Tip>
        )}
      </div>
    </div>
  );
}

/** Whether the view is in sight: shown by the host and its browser tab not in the background. */
function useShown(visible: boolean): boolean {
  const [foreground, setForeground] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const onChange = () => setForeground(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible && foreground;
}
