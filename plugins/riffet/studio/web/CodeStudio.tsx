import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CODE_INDEX_BUDGET, type CodeIndexStatus, type CodeModule, type CodeOutline, type GitHead, type SearchResults } from '@contracts';
import { EmptyState, useMessages, usePluginHost, useProjects, useServers, type CodeBlameView, type CodeFileTarget, type CodeSymbolAt, type ViewProps } from '@riffet/plugin-web';
import { cn } from './cn';
import { codeApi, dirName, type CodeApi, fileName, findInFiles, loadSaved, MAX_RECENT, rememberProject, savedProject, storeSaved, TEXT_OPTIONS, type Saved, type TextOptions } from './data';
import { catalogs } from './messages';
import { Outline } from './Outline';
import { ResultsPanel, type Results } from './ResultsPanel';
import { SearchDialog, type Place, type SearchTab, type StudioAction } from './SearchDialog';
import { moduleTree, useTree, type TreeMode, type TreeNode } from './tree';
import { TreePane } from './TreePane';

const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const TREE_WIDTH = { min: 200, max: 640, initial: 300 };
const RESULTS_HEIGHT = 260;
/** Renewed well within the server's `watchMs`, so a slow request does not let a build in sight lapse. */
const INDEX_WATCH_MS = CODE_INDEX_BUDGET.watchMs / 3;
/** The longest gap between the two presses of a double Shift. */
const DOUBLE_SHIFT_MS = 350;
/** Lines of blame read at a time, around what is in view. */
const BLAME_BLOCK = 200;
/** Committed versions of files kept for the change marks. */
const BASELINES_KEPT = 20;

/**
 * Code Studio: a project's modules or folders on the left, the open files as tabs with the one shown
 * in the middle, its structure on the right and find results along the bottom, the way Android Studio lays
 * out a project, for reading a repository too large to open there comfortably. Files, definitions, usages
 * and searches come from the core's project routes; the page keeps only what is open and where.
 */
export default function CodeStudio({ context }: ViewProps) {
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
  // Servers with something to browse, chosen apart from the project: one list of every server's projects is slow to scan.
  const servers = useServers();
  const serverOf = host.sessions.serverOf;
  const selfId = servers.find((item) => item.self)?.id ?? '';
  const homeOf = useCallback((id: string) => serverOf?.(id) ?? selfId, [serverOf, selfId]);
  const serverId = project ? homeOf(project.id) : selfId;
  const serverChoices = useMemo(() => {
    const homes = new Set(projects.map((item) => homeOf(item.id)));
    return servers.filter((item) => homes.has(item.id));
  }, [servers, projects, homeOf]);
  const onServer = useMemo(() => projects.filter((item) => homeOf(item.id) === serverId), [projects, homeOf, serverId]);
  const chooseProject = (id: string) => { setProjectId(id); rememberProject(id, homeOf(id)); };
  const chooseServer = (id: string) => {
    const remembered = savedProject(id);
    const next = projects.find((item) => item.id === remembered && homeOf(item.id) === id) ?? projects.find((item) => homeOf(item.id) === id);
    if (next) chooseProject(next.id);
  };
  // One client per project: reads, the tree and the index status start over only when the project changes.
  const request = useRef(host.request);
  request.current = host.request;
  const projectKey = project?.id;
  const api = useMemo(() => (projectKey ? codeApi(() => request.current, projectKey) : undefined), [projectKey]);
  const scope = `${context.serviceId}:${project?.id ?? ''}`;

  const [saved, setSaved] = useState<Saved>(() => loadSaved(scope));
  useEffect(() => { setSaved(loadSaved(scope)); setTarget(undefined); setResults(undefined); }, [scope]);
  const update = useCallback((patch: Partial<Saved>) => setSaved((previous) => { const next = { ...previous, ...patch }; storeSaved(scope, next); return next; }), [scope]);
  const mode: TreeMode = saved.mode ?? 'modules';
  const active = saved.active && saved.tabs.includes(saved.active) ? saved.active : saved.tabs.at(-1);

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
    setTreeShown(true);
    void tree.reveal(path).then((found) => { if (found) setFocus({ path, token: Date.now() }); });
  }, [tree]);

  // ── Tabs and the shown place ──────────────────────────────────────────────
  const [target, setTarget] = useState<CodeFileTarget & { path: string }>();
  const [topLine, setTopLine] = useState(1);
  const token = useRef(0);
  const open = useCallback((place: Place) => {
    setSaved((previous) => {
      const tabs = previous.tabs.includes(place.path) ? previous.tabs : [...previous.tabs, place.path];
      const recent = [place.path, ...(previous.recent ?? []).filter((item) => item !== place.path)].slice(0, MAX_RECENT);
      const next = { ...previous, tabs, active: place.path, recent };
      storeSaved(scope, next);
      return next;
    });
    if (place.line !== undefined) setTarget({ path: place.path, line: place.line, ...(place.column !== undefined ? { column: place.column } : {}), token: ++token.current });
  }, [scope]);
  const close = (path: string) => {
    const at = saved.tabs.indexOf(path);
    const tabs = saved.tabs.filter((item) => item !== path);
    update({ tabs, active: active === path ? tabs[Math.min(at, tabs.length - 1)] : active });
  };

  // ── The index ─────────────────────────────────────────────────────────────
  const [index, setIndex] = useState<CodeIndexStatus>();
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
    const timer = window.setInterval(renew, INDEX_WATCH_MS);
    return () => { window.clearInterval(timer); controller.abort(); api.watch(lease, false).catch(() => undefined); };
  }, [api, shown, lease]);
  // A ready index rechecking changed files keeps answering; only the first build is shown as progress.
  const building = index?.state === 'building';

  // ── Outline ───────────────────────────────────────────────────────────────
  const [outline, setOutline] = useState<{ path: string; result?: CodeOutline }>();
  const showOutline = saved.outline ?? true;
  useEffect(() => {
    if (!api || !active || !showOutline) return;
    const controller = new AbortController();
    setOutline({ path: active });
    api.outline(active, controller.signal).then((result) => setOutline({ path: active, result }), () => { if (!controller.signal.aborted) setOutline({ path: active, result: { path: active, items: [] } }); });
    return () => controller.abort();
  }, [api, active, showOutline]);

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
    const base: Results = { title: m.usages(word), locations: [], loading: true, complete: false, scope: scopeOf };
    setResults(base);
    rerun.current = () => findUsages(path, word, scopeOf);
    api.references({ path, word, scope: scopeOf }, controller.signal).then(
      (found) => { rerun.current = undefined; setResults({ ...base, locations: found.locations, complete: found.complete, loading: false }); },
      (error: unknown) => { if (!controller.signal.aborted) { rerun.current = undefined; setResults({ ...base, loading: false, error: host.notify.errorText(error, m.loadFailed) }); } },
    );
    usageQuery.current = { path, word };
  }, [api, host.notify, m]);
  const onSymbol = useCallback((at: CodeSymbolAt, intent: 'definition' | 'menu') => {
    if (!api || !active) return;
    if (intent === 'menu') { findUsages(active, at.word, 'project'); return; }
    lookup.current?.abort();
    rerun.current = undefined;
    const controller = lookup.current = new AbortController();
    const path = active;
    api.definition({ path, ...at }, controller.signal).then(({ locations }) => {
      if (controller.signal.aborted) return;
      if (!locations.length) { setResults({ title: m.noDefinition(at.word), locations: [], loading: false, complete: true }); return; }
      // ⌘-click on a declaration itself lists its usages, as Studio does.
      if (locations.length === 1 && locations[0]!.path === path && locations[0]!.line === at.line) { findUsages(path, at.word, 'project'); return; }
      if (locations.length === 1) { open(locations[0]!); return; }
      setResults({ title: m.definitions(at.word), locations, loading: false, complete: true });
    }, (error: unknown) => { if (!controller.signal.aborted) host.notify.error(error, m.loadFailed); });
  }, [api, active, findUsages, open, host.notify, m]);

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
    const base: Results = { title: m.textResults(query), locations: [], loading: true, complete: false };
    setResults(base);
    rerun.current = () => textSearch(query);
    const within = findOptions.scope === 'module' ? moduleDir : undefined;
    const located = (found: SearchResults) => found.hits.map((hit) => ({ path: hit.path, line: hit.line, column: 1, text: hit.text }));
    findInFiles(api, query, findOptions, within, 1_000, controller.signal, (part) => { if (!controller.signal.aborted) setResults({ ...base, locations: located(part) }); }).then(
      (found) => { rerun.current = undefined; setResults({ ...base, loading: false, complete: !found.more && !found.incomplete, locations: located(found) }); },
      (error: unknown) => { if (!controller.signal.aborted) { rerun.current = undefined; setResults({ ...base, loading: false, error: host.notify.errorText(error, m.loadFailed) }); } },
    );
  }, [api, host.notify, m, findOptions, moduleDir]);

  // ── Git: HEAD, the open file as committed, and who changed its lines ─────
  // `null`: not a git checkout, or git could not answer; the page then shows no git at all.
  const [head, setHead] = useState<GitHead | null>();
  const headRequest = useRef<AbortController>(undefined);
  const shownNow = useRef(shown);
  shownNow.current = shown;
  const readHead = useCallback(() => {
    if (!api || !shownNow.current) return;
    headRequest.current?.abort();
    const controller = headRequest.current = new AbortController();
    api.head(controller.signal).then(setHead, () => { if (!controller.signal.aborted) setHead(null); });
  }, [api]);
  useEffect(() => {
    setHead(undefined);
    readHead();
    // A commit or a checkout elsewhere moves HEAD: look again when the window comes back.
    window.addEventListener('focus', readHead);
    return () => { headRequest.current?.abort(); window.removeEventListener('focus', readHead); };
  }, [readHead]);
  useEffect(() => { if (shown) readHead(); else headRequest.current?.abort(); }, [shown, readHead]);
  const headHash = head?.head;

  // The open file as committed, for the change marks beside the line numbers; a few kept, so switching tabs does not read them again.
  const baselines = useRef(new Map<string, string | null>());
  const [baselineKey, setBaselineKey] = useState<string>();
  const fileKey = active && headHash ? `${headHash}:${active}` : undefined;
  useEffect(() => {
    if (!api || !active || !fileKey || !shown) return;
    if (baselines.current.has(fileKey)) { setBaselineKey(fileKey); return; }
    const controller = new AbortController();
    api.fileAtHead(active, controller.signal).then((file) => {
      // A new file is all added lines; a binary or cut-off one gets no marks.
      const text = file.missing ? '' : file.binary || file.truncated || file.text === undefined ? null : file.text;
      baselines.current.set(fileKey, text);
      while (baselines.current.size > BASELINES_KEPT) baselines.current.delete(baselines.current.keys().next().value!);
      setBaselineKey(fileKey);
    }, () => undefined);
    return () => controller.abort();
  }, [api, active, fileKey, shown]);
  const baseline = fileKey && baselineKey === fileKey ? baselines.current.get(fileKey) ?? undefined : undefined;

  // Blame, read block by block as the reader scrolls: a whole file of a large repository takes minutes.
  const [annotate, setAnnotate] = useState(false);
  // Per file, as the IDE's annotations are: blame of a large repository is slow enough not to run on every tab opened.
  useEffect(() => setAnnotate(false), [active]);
  const [blocks, setBlocks] = useState<[number, number]>([0, 0]);
  const [blame, setBlame] = useState<{ key: string; view: CodeBlameView }>();
  const [blaming, setBlaming] = useState(false);
  const blameState = useRef<{ key: string; done: Set<number>; running?: AbortController; block?: number }>(undefined);
  const blameKey = annotate ? fileKey : undefined;
  useEffect(() => {
    if (!api || !active || !blameKey) { blameState.current?.running?.abort(); blameState.current = undefined; setBlaming(false); return; }
    if (blameState.current?.key !== blameKey) {
      blameState.current?.running?.abort();
      blameState.current = { key: blameKey, done: new Set() };
      setBlame({ key: blameKey, view: { ranges: [], commits: {} } });
    }
    const state = blameState.current;
    // Leaving the page stops the block being read (git is killed); it is read again on coming back.
    if (!shown) {
      if (state.running) { state.running.abort(); state.running = undefined; state.done.delete(state.block!); setBlaming(false); }
      return;
    }
    if (state.running) return;
    let block = blocks[0];
    while (block <= blocks[1] && state.done.has(block)) block++;
    if (block > blocks[1]) return;
    const controller = state.running = new AbortController();
    state.block = block;
    state.done.add(block);
    setBlaming(true);
    const read = () => api.blame(active, block * BLAME_BLOCK + 1, (block + 1) * BLAME_BLOCK, controller.signal);
    // Once more on failure: a first blame on a cold repository can run out of time, and the run that was stopped leaves git's caches warm.
    read().catch((error: unknown) => { if (controller.signal.aborted) throw error; return read(); }).then((part) => {
      if (blameState.current !== state) return;
      state.running = undefined;
      setBlaming(false);
      setBlame((previous) => previous?.key === blameKey ? { key: blameKey, view: { ranges: [...previous.view.ranges, ...part.ranges], commits: { ...previous.view.commits, ...part.commits } } } : previous);
      // The next block in view, if any.
      setBlocks((value) => [value[0], value[1]]);
    }, (error: unknown) => {
      if (controller.signal.aborted || blameState.current !== state) return;
      state.running = undefined;
      setBlaming(false);
      setAnnotate(false);
      host.notify.error(error, m.blameFailed);
    });
  }, [api, active, blameKey, blocks, shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const onViewport = useCallback((first: number, last: number) => {
    const from = Math.floor((first - 1) / BLAME_BLOCK), to = Math.floor((last - 1) / BLAME_BLOCK);
    setBlocks((value) => (value[0] === from && value[1] === to ? value : [from, to]));
  }, []);
  const shownBlame = blameKey && blame?.key === blameKey ? blame.view : undefined;

  // ── Search and keys ───────────────────────────────────────────────────────
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
  const page = useRef<HTMLDivElement>(null);
  const visible = useRef(context.visible);
  visible.current = context.visible;
  useEffect(() => {
    // Only while the page has focus or the pointer's last press was in it: the workbench keeps its own keys elsewhere.
    const here = () => visible.current && (page.current?.contains(document.activeElement) || document.activeElement === document.body);
    // Shift pressed twice with nothing between opens the All tab, as in the IDE.
    let shiftAt = 0;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Shift') shiftAt = 0;
      if (!here()) return;
      if (!(isApple ? event.metaKey : event.ctrlKey)) return;
      // By physical key, so ⌥ on a Mac (which changes `key`) still reads as O.
      const key = event.code;
      const pick: SearchTab | undefined = key === 'KeyO' ? (event.altKey ? 'symbols' : event.shiftKey ? 'files' : 'classes')
        : key === 'KeyF' && event.shiftKey && !event.altKey ? 'text' : undefined;
      if (!pick) return;
      event.preventDefault();
      openSearch(pick);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Shift' || event.metaKey || event.ctrlKey || event.altKey) { shiftAt = 0; return; }
      if (!here()) return;
      const now = event.timeStamp;
      if (shiftAt && now - shiftAt < DOUBLE_SHIFT_MS) { shiftAt = 0; openSearch('all'); return; }
      shiftAt = now;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); };
  }, [openSearch]);

  // ── Layout ────────────────────────────────────────────────────────────────
  // The path bar keeps its end in view: the file and its package, not the repository's top folders.
  const crumbs = useRef<HTMLElement>(null);
  useEffect(() => { const bar = crumbs.current; if (bar) bar.scrollLeft = bar.scrollWidth; }, [active]);
  const [treeWidth, setTreeWidth] = useState(TREE_WIDTH.initial);
  const [treeShown, setTreeShown] = useState(false);
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = event.clientX, from = treeWidth;
    const move = (next: PointerEvent) => setTreeWidth(Math.min(TREE_WIDTH.max, Math.max(TREE_WIDTH.min, from + next.clientX - start)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // The page's commands, for the search dialog's Actions tab.
  const quote = host.navigation.quote;
  const hasGit = Boolean(head);
  const actions = useMemo<StudioAction[]>(() => {
    if (!api || !project) return [];
    const icon = (name: Parameters<typeof ui.icon>[0]) => { const Icon = ui.icon(name); return <Icon />; };
    const list: StudioAction[] = [];
    if (active) {
      list.push({ id: 'locate', label: m.actions.locate, icon: icon('target'), run: () => locate(active) });
      if (quote) list.push({ id: 'quote', label: m.actions.quote, icon: icon('plus'), run: () => quote(project.id, { path: active }) });
      list.push({ id: 'outline', label: showOutline ? m.actions.hideOutline : m.actions.showOutline, icon: icon('panel-right'), run: () => update({ outline: !showOutline }) });
      if (hasGit) list.push({ id: 'annotate', label: annotate ? m.actions.closeAnnotate : m.actions.annotate, icon: icon('git-commit-horizontal'), run: () => setAnnotate((value) => !value) });
    }
    list.push(
      { id: 'modules', label: m.actions.modules, icon: icon('list-filter'), run: () => update({ mode: 'modules' }) },
      { id: 'files', label: m.actions.files, icon: icon('folder'), run: () => update({ mode: 'project' }) },
      { id: 'collapse', label: m.actions.collapse, icon: icon('chevrons-down-up'), run: tree.collapse },
      { id: 'rebuild', label: m.actions.rebuild, icon: icon('refresh-cw'), run: () => { api.rebuild().then(setIndex, (error: unknown) => host.notify.error(error, m.loadFailed)); } },
    );
    if (saved.tabs.length) list.push({ id: 'close-tabs', label: m.actions.closeTabs, icon: icon('x'), run: () => update({ tabs: [], active: undefined }) });
    return list;
  }, [api, project, active, quote, showOutline, hasGit, annotate, saved.tabs.length, locate, update, tree.collapse, host.notify, ui, m]);

  if (!project || !api) return <EmptyState className="flex-1" title={m.noProjects} />;
  const Folder = ui.icon('folder');
  const Panel = ui.icon('panel-right');
  const Refresh = ui.icon('refresh-cw');
  const X = ui.icon('x');
  const Chevron = ui.icon('chevron-right');
  const Target = ui.icon('target');
  const Plus = ui.icon('plus');
  const Search = ui.icon('search');
  const Commit = ui.icon('git-commit-horizontal');
  const Branch = ui.icon('git-branch');
  const Filter = ui.icon('list-filter');
  const Collapse = ui.icon('chevrons-down-up');
  const shownTarget = target && target.path === active ? target : undefined;
  const names = new Map<string, number>();
  for (const tab of saved.tabs) names.set(fileName(tab), (names.get(fileName(tab)) ?? 0) + 1);

  return (
    <div ref={page} className="flex h-full min-h-0 flex-col">
      <SearchDialog
        api={api} projectId={project.id} messages={m} open={searchOpen && shown} onOpenChange={setSearchOpen} tab={searchTab} onTabChange={setSearchTab} focusToken={searchFocus}
        query={searchQuery} onQueryChange={setSearchQuery} options={findOptions} onOptionsChange={(find) => update({ find })} module={moduleDir}
        recent={saved.recent ?? []} actions={actions} activeFile={active} onPick={open} onTextResults={textSearch}
      />

      <div className="relative flex min-h-0 flex-1">
        {/* Project tree. On a phone it covers the page until a file is chosen. */}
        <aside style={{ width: treeWidth }} className={cn('flex min-h-0 shrink-0 flex-col edge-r bg-bg max-md:absolute max-md:inset-0 max-md:z-(--z-panel) max-md:w-full!', !treeShown && 'max-md:hidden')}>
          {ui.Select && (serverChoices.length > 1 || onServer.length > 1) && (
            <div className="flex shrink-0 items-center gap-1.5 edge-b px-2 py-1.5">
              {serverChoices.length > 1 && <ui.Select className="min-w-0 flex-1" label={m.server} value={serverId} onChange={chooseServer} options={serverChoices.map((item) => ({ value: item.id, label: item.alias || item.name }))} />}
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
                  { kind: 'radio', label: m.views.modules, checked: mode === 'modules', onSelect: () => update({ mode: 'modules' }) },
                  { kind: 'radio', label: m.views.project, checked: mode === 'project', onSelect: () => update({ mode: 'project' }) },
                ]}
              />
            )}
          </div>
          {roots ? <TreePane rows={tree.rows} active={active} focus={focus} label={m.views[mode]} onToggle={tree.toggle} onOpen={(path) => { open({ path }); setTreeShown(false); }} />
            : <div className="flex justify-center py-6"><ui.Spinner /></div>}
        </aside>
        <div role="separator" aria-orientation="vertical" onPointerDown={drag} className="w-1 shrink-0 cursor-col-resize -ml-0.5 hover:bg-line max-md:hidden" />

        {/* Tabs, the file's place and the file. */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-1 edge-b pr-1.5">
            <ui.Button size="icon-sm" variant="quiet" className="ml-1 md:hidden" aria-label={m.views[mode]} aria-pressed={treeShown} onClick={() => setTreeShown((value) => !value)}><Folder /></ui.Button>
            <div role="tablist" className="flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1.5 scrollbar-none">
              {saved.tabs.map((tab) => {
                const selected = tab === active;
                const name = fileName(tab);
                return (
                  <div
                    key={tab} role="tab" aria-selected={selected} title={tab}
                    onMouseDown={(event) => { if (event.button === 1) { event.preventDefault(); close(tab); } }}
                    className={cn('group/tab flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-md pl-2 pr-1 text-xs', selected ? 'bg-active text-fg' : 'text-fg-3 hover:bg-hover hover:text-fg')}
                  >
                    <button type="button" onClick={() => update({ active: tab })} className="flex min-w-0 items-center gap-1.5 outline-none">
                      {ui.FileIcon && <ui.FileIcon name={name} className="size-3.5" />}
                      <span className="truncate">{name}</span>
                      {(names.get(name) ?? 0) > 1 && <span className="truncate text-fg-4">{fileName(dirName(tab))}</span>}
                    </button>
                    <button type="button" aria-label={m.closeTab} onClick={() => close(tab)} className={cn('grid size-4 shrink-0 place-items-center rounded text-fg-4 hover:bg-hover hover:text-fg', !selected && 'opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100')}>
                      <X className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
            <ui.Tip label={m.search} kbd="⇧⇧"><ui.Button size="icon-sm" variant="quiet" aria-label={m.search} onClick={() => openSearch('all')}><Search /></ui.Button></ui.Tip>
            <ui.Tip label={m.outline}><ui.Button size="icon-sm" variant="quiet" className="max-md:hidden" aria-label={m.outline} aria-pressed={showOutline} onClick={() => update({ outline: !showOutline })}><Panel /></ui.Button></ui.Tip>
          </div>
          {active && (
            <div className="flex h-7 shrink-0 items-center gap-1 pr-1">
              <nav ref={crumbs} aria-label={active} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap px-3 text-xs text-fg-3 scrollbar-none">
                {active.split('/').map((segment, at, all) => (
                  <span key={at} className="flex items-center gap-0.5">
                    {at > 0 && <Chevron className="size-3 text-fg-4" />}
                    <span className={cn(at === all.length - 1 && 'text-fg-2')}>{segment}</span>
                  </span>
                ))}
              </nav>
              {head && <ui.Tip label={annotate ? m.closeAnnotate : m.annotate}><ui.Button size="icon-xs" variant="quiet" aria-label={m.annotate} aria-pressed={annotate} busy={blaming} onClick={() => setAnnotate((value) => !value)}><Commit /></ui.Button></ui.Tip>}
              {host.navigation.quote && <ui.Tip label={m.quoteFile}><ui.Button size="icon-xs" variant="quiet" aria-label={m.quoteFile} onClick={() => host.navigation.quote?.(project.id, { path: active })}><Plus /></ui.Button></ui.Tip>}
            </div>
          )}
          {active && ui.CodeFile ? (
            <ui.CodeFile
              key={active} projectId={project.id} path={active} target={shownTarget} onSymbol={onSymbol} onTopLine={setTopLine} onViewport={onViewport}
              baseline={baseline} blame={shownBlame} onBlameCommit={(hash: string) => { void ui.copy(hash); }}
              {...(host.navigation.quote ? { onLine: (line: { path: string; line: number; text: string }) => host.navigation.quote?.(project.id, line) } : {})}
            />
          ) : <EmptyState className="flex-1" title={m.noFile} />}

          {results && (
            <div style={{ height: RESULTS_HEIGHT }} className="shrink-0 edge-t">
              <ResultsPanel
                results={results} messages={m} current={shownTarget ? { path: shownTarget.path, line: shownTarget.line } : undefined} onOpen={open} onClose={() => { lookup.current?.abort(); rerun.current = undefined; setResults(undefined); }}
                {...(results.scope && usageQuery.current ? { onScope: (next: 'module' | 'project') => findUsages(usageQuery.current!.path, usageQuery.current!.word, next) } : {})}
              />
            </div>
          )}
        </main>

        {showOutline && active && (
          <aside aria-label={m.outline} className="flex w-64 min-h-0 shrink-0 flex-col edge-l max-md:hidden">
            <div className="flex h-9 shrink-0 items-center edge-b px-3 text-xs font-medium text-fg-2">{m.outline}</div>
            <Outline
              items={outline?.path === active ? outline.result?.items : undefined} loading={outline?.path === active && !outline.result}
              topLine={topLine} messages={m} onJump={(line, column) => open({ path: active, line, column })}
            />
          </aside>
        )}
      </div>

      {/* Status: how far the index is, and where the reader is. */}
      <div className="flex h-6 shrink-0 items-center gap-3 edge-t px-3 text-2xs text-fg-3">
        {index && (
          <span className="flex items-center gap-1.5">
            {building && <ui.Spinner className="size-3" />}
            {index.state === 'ready' && !building ? m.index.ready(index.symbols) : index.state === 'failed' ? m.index.failed : index.state === 'idle' ? m.index.idle : m.index.building(index.done, index.files)}
            {(index.state === 'ready' || index.state === 'failed' || index.state === 'idle') && !building && (
              <ui.Tip label={m.index.rebuild}>
                <button type="button" aria-label={m.index.rebuild} onClick={() => { api.rebuild().then(setIndex, (error: unknown) => host.notify.error(error, m.loadFailed)); }} className="grid size-4 place-items-center rounded text-fg-4 hover:bg-hover hover:text-fg"><Refresh className="size-3" /></button>
              </ui.Tip>
            )}
          </span>
        )}
        <span className="flex-1" />
        {head && <span className="flex min-w-0 items-center gap-1" title={head.head}><Branch className="size-3 shrink-0" /><span className="truncate">{head.branch ?? head.short}</span></span>}
        {active && <span className="tabular-nums">{m.lineColumn(topLine)}</span>}
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
