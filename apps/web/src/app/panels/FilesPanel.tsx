import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconArrowLeft, IconChevronRight, IconCopy, IconCornerUpRight, IconDownload, IconEllipsis, IconExternalLink, IconEye, IconFile, IconFileCode2, IconFolder, IconImage, IconPlus, IconRefreshCw, IconSearch, IconSquareArrowOutUpRight, IconStar, IconTarget, IconX } from '@/components/icons';
import type { CodeLocation, FileEntry, FilePreview, SearchHit } from '@contracts';
import { Button } from '@/components/ui/button';
import { ContentPreview } from '@/components/ContentPreview';
import { EmptyState, Segmented, Spinner } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ResizeHandle } from '@/components/ui/resize-handle';
import { Tip } from '@/components/ui/tooltip';
import { api, HttpError, withClientFeatures, type ProjectRecord, type PromptContextReference } from '@/lib/api';
import { textOf } from '@/lib/errors';
import { hostInfo, isApplePlatform, shortcutLabel } from '@/lib/platform';
import { absolutePath, copyWithToast, downloadProjectFile, downloadProjectFolder, openProjectFile, projectFileUrl } from '@/lib/files';
import { toast } from '@/lib/toast';
import { usePreviewTheme } from '@/lib/content-preview';
import { cn, errorMessage, formatBytes } from '@/lib/utils';
import { OverlayScopeContext, useOverlayState } from '@/lib/overlay-navigation';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { ZoomPanImage } from '../session/ZoomPanImage';
import { FavoriteMenu, FavoriteStar, favoriteName, useFolderFavorites } from '../FolderFavorites';
import { useUi } from '../state/stores';
import type { SidebarBodyProps } from './sidebarViews';
import type { CodeTarget, SymbolAt } from './CodeView';
import { FileTree } from './FileTree';
import { DirectoryHint, FileIcon, Matched, splitPath } from './fileVisuals';
import { QuickOpen, type QuickOpenMode } from './QuickOpen';
import { useRecentFiles } from './recentFiles';
const CodeView = lazy(() => import('./CodeView').then((module) => ({ default: module.CodeView })));
const previewFallback = <div className="flex flex-1 justify-center py-10"><Spinner /></div>;

const PAGE = 100;
/** Documents the browser should lay out rather than show as text. */
const isHtmlPath = (path: string) => /\.html?$/i.test(path);

const rowAction = 'grid size-5 shrink-0 place-items-center rounded text-fg-3 opacity-0 transition-opacity pointer-events-none hover:bg-active hover:text-fg group-hover/file:opacity-100 group-hover/file:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto data-[state=open]:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:bg-active no-hover:size-11 no-hover:opacity-100 no-hover:pointer-events-auto';

/** The actions a file manager offers on an entry; also opened by right-clicking the row. */
function FileMenu({ projectId, root, path, kind, open, onOpenChange, onReference, onOpenInEditor, onRevealInFinder, favorited, onToggleFavorite }: {
  projectId: string; root: string; path: string; kind: FileEntry['kind'];
  open: boolean; onOpenChange: (open: boolean) => void;
  onReference?: () => void; onOpenInEditor: () => void; onRevealInFinder?: () => void;
  /** Folders only: whether it is one of the project's favorites, and the switch. */
  favorited?: boolean; onToggleFavorite?: () => void;
}) {
  const { t } = useLingui();
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={t`更多操作`} className={rowAction}><IconEllipsis className="size-3.5" /></button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {kind === 'file' ? (
          <>
            {onReference && <DropdownMenuItem onSelect={onReference}><IconPlus /><Trans>引用到对话</Trans></DropdownMenuItem>}
            <DropdownMenuItem onSelect={() => downloadProjectFile(projectId, path)}><IconDownload /><Trans>下载</Trans></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openProjectFile(projectId, path)}><IconExternalLink /><Trans>在新标签页打开</Trans></DropdownMenuItem>
          </>
        ) : (
          <>
            {onToggleFavorite && <DropdownMenuItem onSelect={onToggleFavorite}><IconStar />{favorited ? <Trans>取消收藏</Trans> : <Trans>收藏文件夹</Trans>}</DropdownMenuItem>}
            <DropdownMenuItem onSelect={() => void downloadProjectFolder(projectId, path)}><IconDownload /><Trans>下载为 ZIP</Trans></DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem onSelect={onOpenInEditor}><IconSquareArrowOutUpRight /><Trans>在编辑器中打开</Trans></DropdownMenuItem>
        {onRevealInFinder && <DropdownMenuItem onSelect={onRevealInFinder}><IconFolder /><Trans>在 Finder 中显示</Trans></DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void copyWithToast(path, t`已复制相对路径`)}><IconCopy /><Trans>复制相对路径</Trans></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copyWithToast(absolutePath(root, path), t`已复制绝对路径`)}><IconCopy /><Trans>复制绝对路径</Trans></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface DirectoryVisit { entries: FileEntry[]; hasMore: boolean; scrollTop: number }
interface Place { path: string; line?: number | undefined }
/** A symbol's usages: the module's first, then the project's; `origin` is where it was asked for. */
interface Usages { word: string; origin: Place; locations: CodeLocation[]; complete: boolean; searching: boolean; history: Place[] }
const MAX_HISTORY = 50;
const TREE_WIDTH = { key: 'riffet.files.treeWidth.v1', default: 320, min: 200, max: 640 };
const savedTreeWidth = () => { const value = Number(localStorage.getItem(TREE_WIDTH.key)); return value >= TREE_WIDTH.min && value <= TREE_WIDTH.max ? value : TREE_WIDTH.default; };
const modifier = (event: { metaKey: boolean; ctrlKey: boolean }) => (isApplePlatform ? event.metaKey : event.ctrlKey);

/**
 * The files view of the side panel: a project's directory listing, search and file previews. The
 * panel keeps it mounted once shown, so where the reader was (directory, preview, search) survives
 * a visit to another view; while another view shows, it draws nothing.
 */
export function FilesPanel({ project, previewTarget, shown, wide = false, headerSlot, show, onReference, onError, onClose }: SidebarBodyProps) {
  const { t } = useLingui();
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const panelOpen = useUi((state) => state.panelOpen);
  const [searchOpen, setSearchOpen] = useState(false);
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  /** This project's favorite folders, relative to its root; read while the files view shows. */
  const favorites = useFolderFavorites(project.id, panelOpen && shown);
  const favoriteAt = (folder: string) => favorites.favorites.find((favorite) => favorite.path === folder);
  const toggleFavorite = (folder: string) => {
    const existing = favoriteAt(folder);
    void (existing ? favorites.remove(existing.id) : favorites.add(folder));
  };
  const [hasMore, setHasMore] = useState(false);
  /** The listing (project, path) that last settled; empty is only shown for the one on screen. */
  const [listedKey, setListedKey] = useState<string>();
  const listingKey = `${project.id}\0${path}`;
  const [fetching, setFetching] = useState(false);
  const loading = fetching || listedKey !== listingKey;
  const [loadingMore, setLoadingMore] = useState(false);
  // A preview is a navigation destination even before its request finishes.
  const [previewPath, setPreviewPath] = useState<string>();
  const [preview, setPreview] = useState<FilePreview>();
  // The server normalizes project-local absolute paths; use that result for file actions.
  const previewFilePath = preview?.path ?? previewPath;
  const [rendered, setRendered] = useState(true);
  const previewTheme = usePreviewTheme();
  const renderable = Boolean(preview?.render || (preview && isHtmlPath(preview.path)));
  const showingRendered = renderable && rendered && !preview?.image;
  const [imageLoadError, setImageLoadError] = useState(false);
  // A missing file says so in place; retrying it cannot help, and a toast would say it twice.
  const [previewMissing, setPreviewMissing] = useState(false);
  const previewRequest = useRef(0);
  /** The line (and column) the code view goes to, for the file it belongs to. */
  const [jump, setJump] = useState<CodeTarget & { path: string }>();
  /** Where ⌘-click jumps came from, newest last, for Back. */
  const [history, setHistory] = useState<Place[]>([]);
  /** The line last asked about in the open file, kept with it when a jump leaves it. */
  const here = useRef<Place | undefined>(undefined);
  const [usages, setUsages] = useState<Usages>();
  const usagesRequest = useRef(0);
  /** The searches in flight, aborted when a newer one replaces them so the server stops scanning. */
  const usagesAbort = useRef<AbortController | undefined>(undefined);
  const definitionAbort = useRef<AbortController | undefined>(undefined);
  const searchAbort = useRef<AbortController | undefined>(undefined);
  const renew = (holder: { current: AbortController | undefined }) => { holder.current?.abort(); holder.current = new AbortController(); return holder.current.signal; };
  const [symbolMenu, setSymbolMenu] = useState<{ at: SymbolAt; x: number; y: number; definitions?: CodeLocation[] }>();
  const [navigating, setNavigating] = useState(false);
  const definitionRequest = useRef(0);
  const [reveal, setReveal] = useState<{ path: string; token: number; expand?: boolean }>();
  const recent = useRecentFiles(project.id);
  /** Where each file was scrolled to when it was left, so coming back to it lands there. */
  const topLines = useRef(new Map<string, number>());
  const [quickOpen, setQuickOpen] = useState<QuickOpenMode>();
  /** The tree column's width in the wide layout, kept per browser; a drag paints it before it settles. */
  const [treeWidth, setTreeWidth] = useState(savedTreeWidth);
  const treeColumn = useRef<HTMLDivElement>(null);
  const settleTreeWidth = (width: number) => { setTreeWidth(width); try { localStorage.setItem(TREE_WIDTH.key, String(width)); } catch { /* the width holds for this page */ } };
  const [previewLoading, setPreviewLoading] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [searchMode, setSearchMode] = useState<'name' | 'content'>('name');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<FileEntry[]>();
  const [hits, setHits] = useState<SearchHit[]>();
  const [searching, setSearching] = useState(false);
  const [menuPath, setMenuPath] = useState<string>();
  const directoryVisits = useRef(new Map<string, DirectoryVisit>());
  const directoryListRef = useRef<HTMLDivElement>(null);
  const searchListRef = useRef<HTMLDivElement>(null);
  const searchScroll = useRef(0);
  const focusSearch = useRef(false);
  const handledPreviewToken = useRef<number | undefined>(undefined);

  /** Bumped whenever an in-flight search or listing page stops belonging to what is on screen. */
  const searchRequest = useRef(0);
  const listingRequest = useRef(0);
  const paginationRequest = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    previewRequest.current += 1; searchRequest.current += 1; listingRequest.current += 1; usagesRequest.current += 1; definitionRequest.current += 1;
    for (const holder of [usagesAbort, definitionAbort, searchAbort]) holder.current?.abort();
    paginationRequest.current = undefined; handledPreviewToken.current = undefined; here.current = undefined;
    setHistory([]); setUsages(undefined); setSymbolMenu(undefined); setNavigating(false); setJump(undefined); setQuickOpen(undefined);
    topLines.current.clear();
    directoryVisits.current.clear(); searchScroll.current = 0; focusSearch.current = false;
    setPreviewLoading(false); setSearching(false); setLoadingMore(false); setPath(''); setPreviewPath(undefined); setPreview(undefined);
    setEntries([]); setHasMore(false); setSearchOpen(false); setQuery(''); setFound(undefined); setHits(undefined); setMenuPath(undefined);
    return () => {
      previewRequest.current += 1; searchRequest.current += 1; listingRequest.current += 1; usagesRequest.current += 1; definitionRequest.current += 1;
      for (const holder of [usagesAbort, definitionAbort, searchAbort]) holder.current?.abort();
    };
  }, [project.id]);

  useEffect(() => {
    const request = ++listingRequest.current;
    paginationRequest.current = undefined;
    setLoadingMore(false);
    // A closed panel stays mounted on a wide screen; reopening it revalidates what it shows.
    if (!panelOpen || !shown || wide) return;
    const cached = directoryVisits.current.get(path);
    setEntries(cached?.entries ?? []);
    setHasMore(cached?.hasMore ?? false);
    setFetching(true);
    void (async () => {
      try {
        // Revalidate the whole visited range without collapsing a paginated list back to page one.
        const result: FileEntry[] = [];
        let more = false;
        do {
          const page = await api.files(project.id, path, PAGE, result.length);
          if (request !== listingRequest.current) return;
          result.push(...page);
          more = page.length === PAGE;
        } while (more && result.length < (cached?.entries.length ?? PAGE));
        directoryVisits.current.set(path, { entries: result, hasMore: more, scrollTop: directoryVisits.current.get(path)?.scrollTop ?? 0 });
        setEntries(result); setHasMore(more);
      } catch (error) { if (request === listingRequest.current) onError(errorMessage(error, t`无法读取目录`)); }
      finally { if (request === listingRequest.current) { setFetching(false); setListedKey(listingKey); } }
    })();
    return () => { if (request === listingRequest.current) listingRequest.current += 1; };
  }, [project.id, path, listingKey, shown, panelOpen, refreshToken, onError, wide]);

  const rememberScroll = useCallback(() => {
    const visit = directoryVisits.current.get(path);
    if (visit && directoryListRef.current) visit.scrollTop = directoryListRef.current.scrollTop;
    if (searchListRef.current) searchScroll.current = searchListRef.current.scrollTop;
  }, [path]);

  const openDirectory = (next: string) => {
    rememberScroll();
    previewRequest.current += 1; searchRequest.current += 1;
    setPreviewPath(undefined); setPreview(undefined); setPreviewLoading(false); setSearchOpen(false); setSearching(false); setMenuPath(undefined);
    setHistory([]);
    focusSearch.current = false;
    if (next === path) return;
    // Invalidate before the next render, including a pending "load more" response.
    listingRequest.current += 1; paginationRequest.current = undefined;
    const cached = directoryVisits.current.get(next);
    setEntries(cached?.entries ?? []); setHasMore(cached?.hasMore ?? false); setLoadingMore(false);
    setPath(next);
  };

  const goBack = () => {
    rememberScroll();
    setMenuPath(undefined);
    if (previewPath !== undefined && history.length) back();
    else if (previewPath !== undefined) {
      previewRequest.current += 1;
      setPreviewPath(undefined); setPreview(undefined); setPreviewLoading(false); setHistory([]);
    } else if (usages) closeUsages();
    else if (searchOpen) {
      searchRequest.current += 1;
      setSearchOpen(false); setSearching(false); focusSearch.current = false;
    } else if (path) openDirectory(path.split('/').slice(0, -1).join('/'));
    else onClose();
  };
  const overlay = useOverlayState({
    open: mobile && panelOpen && shown && (previewPath !== undefined || searchOpen || Boolean(usages) || Boolean(path)),
    onOpenChange: (next) => { if (!next) goBack(); },
  });

  useLayoutEffect(() => {
    if (directoryListRef.current) directoryListRef.current.scrollTop = directoryVisits.current.get(path)?.scrollTop ?? 0;
    if (searchListRef.current) searchListRef.current.scrollTop = searchScroll.current;
  }, [path, shown, previewPath, searchOpen, entries, found, hits, loading, searching]);

  const openPreview = useCallback(async (filePath: string, line?: number, column?: number) => {
    rememberScroll();
    focusSearch.current = false;
    const request = ++previewRequest.current;
    // A definition still being looked up belonged to the file being left.
    definitionRequest.current += 1; definitionAbort.current?.abort(); setNavigating(false);
    here.current = { path: filePath, line };
    const top = line ? undefined : topLines.current.get(filePath);
    setJump(line ? { path: filePath, line, column, token: request } : top ? { path: filePath, line: top, restore: true, token: request } : undefined);
    setPreviewPath(filePath);
    setPreview((current) => current?.path === filePath ? current : undefined);
    setMenuPath(undefined);
    setImageLoadError(false);
    setPreviewMissing(false);
    setRendered(!line);
    setPreviewLoading(true);
    show();
    try {
      const result = await api.preview(project.id, filePath);
      if (request === previewRequest.current) { setPreview(result); if (!result.binary || result.image) recent.touch(result.path); }
    }
    catch (error) {
      if (request !== previewRequest.current) return;
      if (error instanceof HttpError && error.code === 'FILE_NOT_FOUND') { setPreviewMissing(true); return; }
      // The server refuses out-of-project paths when the setting is off; say so in Chinese
      // instead of surfacing the raw "Path must stay inside the project directory".
      const blocked = error instanceof HttpError && (error.code === 'PATH_OUTSIDE_PROJECT' || error.code === 'INVALID_PATH');
      onError(blocked ? t`该文件在项目目录之外。可在「设置 → 文件与编辑器」中允许只读预览项目外文件。` : errorMessage(error, t`无法打开文件`));
    }
    finally { if (request === previewRequest.current) setPreviewLoading(false); }
  }, [project.id, onError, show, rememberScroll, recent.touch]);

  /** Opens `to`, remembering the place it was asked from for Back. */
  const jumpTo = (to: Place & { column?: number }) => {
    const from = here.current;
    if (from && !(from.path === to.path && from.line === to.line)) setHistory((previous) => [...previous, from].slice(-MAX_HISTORY));
    void openPreview(to.path, to.line, to.column);
  };
  const back = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory(history.slice(0, -1));
    void openPreview(previous.path, previous.line);
  };

  const findUsages = (at: SymbolAt) => {
    const file = preview?.path;
    if (!file) return;
    const request = ++usagesRequest.current;
    const signal = renew(usagesAbort);
    const origin = { path: file, line: at.line };
    // The narrow panel shows one page at a time: the usages replace the file, and Back reopens it
    // with the jumps that led to it.
    const kept = wide ? [] : history;
    setUsages({ word: at.word, origin, locations: [], complete: false, searching: true, history: kept });
    setSearchOpen(false);
    if (!wide) { previewRequest.current += 1; setPreviewPath(undefined); setPreview(undefined); setPreviewLoading(false); setHistory([]); }
    void (async () => {
      for (const scope of ['module', 'project'] as const) {
        try {
          const result = await api.references(project.id, { path: file, word: at.word, scope }, signal);
          if (request !== usagesRequest.current) return;
          setUsages({ word: at.word, origin, locations: result.locations, complete: result.complete, searching: scope === 'module', history: kept });
        } catch (error) {
          if (request !== usagesRequest.current) return;
          setUsages((current) => current && { ...current, searching: false });
          onError(errorMessage(error, t`查找用法失败`));
          return;
        }
      }
    })();
  };
  const closeUsages = () => {
    usagesRequest.current += 1;
    usagesAbort.current?.abort();
    if (!usages) return;
    setUsages(undefined);
    if (!wide) { setHistory(usages.history); void openPreview(usages.origin.path, usages.origin.line); }
  };
  const openUsage = (location: CodeLocation) => {
    if (wide && preview) jumpTo(location);
    else void openPreview(location.path, location.line, location.column);
  };

  /** ⌘-click: the definition, a choice among several, or the usages when it is the definition. */
  const goToDefinition = async (at: SymbolAt, point: { x: number; y: number }) => {
    const file = preview?.path;
    if (!file) return;
    here.current = { path: file, line: at.line };
    const request = ++definitionRequest.current;
    const signal = renew(definitionAbort);
    setNavigating(true);
    try {
      const { locations } = await api.definition(project.id, { path: file, ...at }, signal);
      if (request !== definitionRequest.current) return;
      if (!locations.length) toast.info(t`没有找到 ${at.word} 的定义`);
      else if (locations.some((location) => location.path === file && location.line === at.line)) findUsages(at);
      else if (locations.length === 1) jumpTo(locations[0]!);
      else setSymbolMenu({ at, ...point, definitions: locations });
    } catch (error) {
      if (request === definitionRequest.current) onError(errorMessage(error, t`无法跳转到定义`));
    } finally {
      if (request === definitionRequest.current) setNavigating(false);
    }
  };
  const onSymbol = (at: SymbolAt, intent: 'definition' | 'menu', point: { x: number; y: number }) => {
    if (preview) here.current = { path: preview.path, line: at.line };
    if (intent === 'definition') void goToDefinition(at, point);
    else setSymbolMenu({ at, ...point });
  };

  const openInEditor = (filePath: string, line?: number) => {
    void api.openInEditor(project.id, filePath, line).catch((error) => onError(errorMessage(error, t({ message: '无法在编辑器中打开', context: 'panels-open-in-editor-failed' }))));
  };

  const localMac = hostInfo().local && isApplePlatform;
  const [finder, setFinder] = useState<{ projectId: string; supported: boolean }>();
  useEffect(() => {
    if (!localMac) return;
    let current = true;
    void api.finderSupport(project.id).then(({ supported }) => {
      if (current) setFinder({ projectId: project.id, supported });
    }).catch(() => {
      if (current) setFinder({ projectId: project.id, supported: false });
    });
    return () => { current = false; };
  }, [project.id, localMac]);
  const canRevealInFinder = localMac && finder?.projectId === project.id && finder.supported;
  const revealInFinder = (filePath: string) => {
    void api.revealInFinder(project.id, filePath).catch((error) => {
      const translated = error instanceof HttpError && error.code
        ? textOf({ code: error.code, ...(error.params ? { params: error.params } : {}) }, error.message) : undefined;
      onError(translated ?? t`无法在 Finder 中显示`);
    });
  };

  const copyPreviewContent = async (file: FilePreview) => {
    let text = file.content;
    if (file.truncated) {
      try {
        const response = await fetch(projectFileUrl(project.id, file.path), { credentials: 'same-origin' });
        if (!response.ok) throw new Error(response.statusText);
        text = await response.text();
      } catch { toast.error(t`无法读取完整的文件内容`); return; }
    }
    await copyWithToast(text, t`已复制文件内容`);
  };

  // An external preview request opens the file here and jumps to the requested line.
  useEffect(() => {
    if (!previewTarget || handledPreviewToken.current === previewTarget.token) return;
    handledPreviewToken.current = previewTarget.token;
    void openPreview(previewTarget.path, previewTarget.line);
    // `token` is bumped on every request so clicking the same file twice still re-opens it.
  }, [previewTarget?.token, openPreview]);

  const runSearch = async () => {
    const value = query.trim();
    if (!value) return;
    const request = ++searchRequest.current;
    searchScroll.current = 0;
    setSearching(true);
    try {
      if (searchMode === 'name') {
        const result = await api.find(project.id, value);
        if (request === searchRequest.current) setFound(Array.isArray(result) ? result : result.entries ?? []);
      } else {
        const result = await api.search(project.id, value, renew(searchAbort));
        if (request === searchRequest.current) setHits(result);
      }
    } catch (error) { if (request === searchRequest.current) onError(errorMessage(error, t`搜索失败`)); }
    finally { if (request === searchRequest.current) setSearching(false); }
  };

  // By name the answer comes from the server's file list in a moment, so it follows the typing, as a
  // "Go to File" does; content search reads files and waits for Enter.
  useEffect(() => {
    if (!searchOpen || searchMode !== 'name' || !query.trim()) return;
    const timer = window.setTimeout(() => void runSearch(), 150);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runSearch reads the same query and mode.
  }, [query, searchMode, searchOpen]);

  // ⌘P (Ctrl+P) goes to a file while the wide layout shows, as in VS Code; the browser's print stays elsewhere.
  useEffect(() => {
    if (!wide || !shown || !panelOpen) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!modifier(event) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'p' || event.defaultPrevented || event.isComposing) return;
      // Another dialog keeps its keys; Quick Open over it would open behind its focus trap.
      if (document.activeElement?.closest('[role="dialog"]')) return;
      event.preventDefault();
      setQuickOpen('name');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wide, shown, panelOpen]);

  const loadMore = () => {
    if (loading || !hasMore || paginationRequest.current !== undefined) return;
    const request = listingRequest.current;
    paginationRequest.current = request;
    setLoadingMore(true);
    void api.files(project.id, path, PAGE, entries.length).then((next) => {
      if (request !== listingRequest.current) return;
      const combined = [...entries, ...next.filter((entry) => !entries.some((item) => item.name === entry.name))];
      const more = next.length === PAGE;
      directoryVisits.current.set(path, { entries: combined, hasMore: more, scrollTop: directoryVisits.current.get(path)?.scrollTop ?? 0 });
      setEntries(combined); setHasMore(more);
    }).catch((error) => { if (request === listingRequest.current) onError(errorMessage(error, t`无法加载更多`)); })
      .finally(() => { if (paginationRequest.current === request) { paginationRequest.current = undefined; setLoadingMore(false); } });
  };

  const refreshFiles = () => {
    if (wide) setRefreshToken((value) => value + 1);
    if (previewPath !== undefined) { void openPreview(previewPath); return; }
    rememberScroll();
    listingRequest.current += 1; paginationRequest.current = undefined;
    setFetching(true); setLoadingMore(false); setRefreshToken((value) => value + 1);
  };

  const crumbs = path ? path.split('/') : [];

  const favoritesRow = (current: string | undefined, pick: (folder: string) => void) => favorites.favorites.length > 0 && (
    // The project's favorite folders, a jump away from wherever the listing is.
    <div className="flex shrink-0 flex-wrap gap-1 px-3 pb-2" aria-label={t`收藏的文件夹`}>
      {favorites.favorites.map((favorite) => (
        <div key={favorite.id} className={cn('group/fav flex h-6 max-w-full items-center rounded-md bg-subtle text-xs max-md:h-11 no-hover:h-11', favorite.path === current && 'bg-active')}>
          <button type="button" disabled={!favorite.exists} title={favorite.exists ? favorite.path : t`${favorite.path}（不存在）`} onClick={() => pick(favorite.path)} className="flex h-full min-w-0 items-center gap-1 pl-1.5 pr-1 text-fg-2 hover:text-fg disabled:text-fg-4">
            <FavoriteStar className={cn('size-3', !favorite.exists && 'text-fg-4')} />
            <span className="min-w-0 max-w-32 truncate">{favoriteName(favorite)}</span>
            {!favorite.exists && <span className="shrink-0 text-2xs"><Trans>不存在</Trans></span>}
          </button>
          <FavoriteMenu favorite={favorite} store={favorites} triggerClassName="grid size-5 shrink-0 place-items-center rounded text-fg-3 opacity-0 hover:bg-hover hover:text-fg group-hover/fav:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 no-hover:size-11 no-hover:opacity-100" />
        </div>
      ))}
    </div>
  );

  /** A row's hover actions and its menu, for the listing and the tree alike. */
  const rowActions = (entry: FileEntry, full: string) => {
    const menuOpen = menuPath === full;
    return (
      <>
        {entry.kind === 'file' && (
          <>
            <span className={cn('shrink-0 text-2xs text-fg-3 transition-opacity group-hover/file:opacity-0 max-md:hidden', menuOpen && 'opacity-0', wide && 'hidden')}>{formatBytes(entry.size)}</span>
            <Tip label={t`引用到对话`}><button type="button" aria-label={t`引用到对话`} onClick={() => onReference({ path: full })} className={rowAction}><IconPlus className="size-3.5" /></button></Tip>
          </>
        )}
        <FileMenu
          projectId={project.id} root={project.cwd} path={full} kind={entry.kind}
          open={menuOpen} onOpenChange={(open) => setMenuPath(open ? full : undefined)}
          {...(entry.kind === 'file' ? { onReference: () => onReference({ path: full }) } : {})}
          onOpenInEditor={() => openInEditor(full)}
          {...(canRevealInFinder ? { onRevealInFinder: () => revealInFinder(full) } : {})}
          {...(entry.kind === 'directory' ? { favorited: Boolean(favoriteAt(full)), onToggleFavorite: () => toggleFavorite(full) } : {})}
        />
      </>
    );
  };

  const openSearch = () => { rememberScroll(); focusSearch.current = true; usagesRequest.current += 1; setUsages(undefined); setSearchOpen(true); setMenuPath(undefined); };
  const closeSearch = () => { searchRequest.current += 1; setSearchOpen(false); setSearching(false); focusSearch.current = false; };
  /** In the wide layout a folder opens in the tree; in the narrow one, as the listing. */
  const showFolder = (folder: string) => {
    if (!wide) { openDirectory(folder); return; }
    closeSearch();
    setReveal((current) => ({ path: folder, token: (current?.token ?? 0) + 1, expand: true }));
  };

  const listingPage = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto px-3 text-xs no-hover:h-11">
        {path && <Button size="icon-xs" variant="quiet" aria-label={t`返回上级目录`} onClick={goBack}><IconArrowLeft /></Button>}
        <button type="button" onClick={() => openDirectory('')} className={cn('shrink-0 rounded px-1 py-0.5 hover:bg-hover no-hover:min-h-11 no-hover:px-2', path ? 'text-fg-3' : 'font-medium text-fg')}>{project.name}</button>
        {crumbs.map((part, index) => (
          <span key={index} className="flex shrink-0 items-center gap-0.5">
            <IconChevronRight className="size-3 text-fg-4" />
            <button type="button" onClick={() => openDirectory(crumbs.slice(0, index + 1).join('/'))} className={cn('rounded px-1 py-0.5 hover:bg-hover no-hover:min-h-11 no-hover:px-2', index === crumbs.length - 1 ? 'font-medium text-fg' : 'text-fg-3')}>{part}</button>
          </span>
        ))}
        {path && (
          <Tip label={favoriteAt(path) ? t`取消收藏此文件夹` : t`收藏此文件夹`}>
            <button type="button" aria-label={favoriteAt(path) ? t`取消收藏此文件夹` : t`收藏此文件夹`} aria-pressed={Boolean(favoriteAt(path))} onClick={() => toggleFavorite(path)} className="ml-auto grid size-6 shrink-0 place-items-center rounded text-fg-3 hover:bg-hover hover:text-fg max-md:size-10">
              {favoriteAt(path) ? <FavoriteStar /> : <IconStar className="size-3.5" />}
            </button>
          </Tip>
        )}
      </div>
      {favoritesRow(path, openDirectory)}
      <div ref={directoryListRef} onScroll={(event) => { const visit = directoryVisits.current.get(path); if (visit) visit.scrollTop = event.currentTarget.scrollTop; }} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading && !entries.length && <div className="flex justify-center py-10"><Spinner /></div>}
        {entries.map((entry) => {
          const full = [path, entry.name].filter(Boolean).join('/');
          return (
            <div key={full} onContextMenu={(event) => { event.preventDefault(); setMenuPath(full); }} className={cn('group/file flex h-7 items-center gap-2 rounded-md px-2 hover:bg-hover max-md:h-11 max-md:px-1 no-hover:h-11', menuPath === full && 'bg-hover')}>
              <button type="button" onClick={() => entry.kind === 'directory' ? openDirectory(full) : void openPreview(full)} className="flex h-full min-w-0 flex-1 items-center gap-2 text-left text-sm text-fg">
                <FileIcon entry={entry} />
                <span className="truncate">{entry.name}</span>
                {entry.kind === 'directory' && favoriteAt(full) && <FavoriteStar className="size-3" />}
              </button>
              {rowActions(entry, full)}
            </div>
          );
        })}
        {hasMore && (
          <Button size="xs" variant="ghost" className="mx-2 mt-1" disabled={loading || loadingMore} onClick={loadMore}>{loadingMore ? <Trans>加载中…</Trans> : <Trans>加载更多</Trans>}</Button>
        )}
        {!loading && !entries.length && <EmptyState title={t`空目录`} />}
      </div>
    </div>
  );

  /** Closing the shown tab shows the one viewed before it. */
  const closeTab = (file: string) => {
    recent.remove(file);
    topLines.current.delete(file);
    if (file !== previewFilePath) return;
    const next = recent.byRecency.find((item) => item.path !== file);
    if (next) void openPreview(next.path);
    else { previewRequest.current += 1; setPreviewPath(undefined); setPreview(undefined); setPreviewLoading(false); }
  };
  const locate = () => { if (previewFilePath) setReveal((current) => ({ path: previewFilePath, token: (current?.token ?? 0) + 1 })); };
  // Kept mounted under the usages, so what was open in it stays open.
  const treePage = (
    <div className={cn('flex min-h-0 flex-1 flex-col', usages && 'hidden')}>
      <div className="flex h-9 shrink-0 items-center gap-1 pl-3 pr-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg-2">{project.name}</span>
        <Tip label={t`定位当前文件`}><Button size="icon-xs" variant="quiet" aria-label={t`定位当前文件`} disabled={!previewFilePath} onClick={locate}><IconTarget /></Button></Tip>
      </div>
      {favoritesRow(undefined, showFolder)}
      <FileTree
        projectId={project.id} active={previewFilePath} reveal={reveal} refreshToken={refreshToken}
        icon={(entry) => <FileIcon entry={entry} />} actions={rowActions}
        onOpen={(file) => void openPreview(file)} onContextMenu={setMenuPath} onError={onError}
      />
    </div>
  );

  const previewPage = previewFilePath !== undefined && (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => { if (modifier(event) && event.key === '[' && history.length) { event.preventDefault(); back(); } }}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 edge-b px-2 max-md:h-12 no-hover:h-12">
        {(!wide || history.length > 0) && <Button size="icon-xs" variant="quiet" className="max-md:size-10" aria-label={history.length || usages ? t`返回` : searchOpen ? t`返回搜索结果` : t`返回文件列表`} onClick={wide ? back : goBack}><IconArrowLeft /></Button>}
        {/* Cut at its start, so the file's name stays. */}
        <span className={cn('min-w-0 flex-1 truncate text-left font-mono text-xs text-fg-2 [direction:rtl]', wide && !history.length && 'pl-1')} title={previewFilePath}><bdi>{previewFilePath}</bdi></span>
        <div className="flex shrink-0 items-center">
          {navigating && <Spinner className="mx-1.5" />}
          {renderable && preview && !preview.image && !preview.binary && (
            <Tip label={rendered ? t`显示源码` : t({ message: '渲染预览', context: 'panels-render-preview-toggle' })}>
              <Button size="icon-xs" variant="quiet" className="max-md:size-10" aria-label={rendered ? t`显示源码` : t({ message: '渲染预览', context: 'panels-render-preview-toggle' })} aria-pressed={rendered} onClick={() => setRendered((value) => !value)}>
                {rendered ? <IconFileCode2 /> : <IconEye />}
              </Button>
            </Tip>
          )}
          <Tip label={t`引用整个文件`}><Button size="icon-xs" variant="quiet" className="max-md:size-10" aria-label={t`引用整个文件`} onClick={() => onReference({ path: previewFilePath })}><IconPlus /></Button></Tip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="icon-xs" variant="quiet" className="max-md:size-10" aria-label={t`更多操作`}><IconEllipsis /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem onSelect={() => openInEditor(previewFilePath)}><IconSquareArrowOutUpRight /><Trans>在编辑器中打开</Trans></DropdownMenuItem>
              {canRevealInFinder && <DropdownMenuItem onSelect={() => revealInFinder(previewFilePath)}><IconFolder /><Trans>在 Finder 中显示</Trans></DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => openProjectFile(project.id, previewFilePath)}><IconExternalLink /><Trans>在新标签页打开</Trans></DropdownMenuItem>
              <DropdownMenuItem onSelect={() => downloadProjectFile(project.id, previewFilePath)}><IconDownload /><Trans>下载</Trans></DropdownMenuItem>
              {preview && !preview.binary && <DropdownMenuItem onSelect={() => void copyPreviewContent(preview)}><IconCopy /><Trans>复制文件内容</Trans></DropdownMenuItem>}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void copyWithToast(previewFilePath, t`已复制路径`)}><IconCopy /><Trans>复制路径</Trans></DropdownMenuItem>
              {!previewFilePath.startsWith('/') && <DropdownMenuItem onSelect={() => void copyWithToast(absolutePath(project.cwd, previewFilePath), t`已复制绝对路径`)}><IconCopy /><Trans>复制绝对路径</Trans></DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {previewLoading && !preview ? <div className="flex justify-center py-10"><Spinner /></div> : !preview ? previewMissing ? (
        <EmptyState title={t`文件不存在`} />
      ) : (
        <EmptyState title={t`无法打开文件`}><Button variant="secondary" onClick={() => void openPreview(previewFilePath)}><IconRefreshCw /><Trans>重试</Trans></Button></EmptyState>
      ) : preview.image ? imageLoadError ? (
        <EmptyState icon={<IconImage />} title={t`图片无法加载`} description={t`文件可能已更改，或超过图片预览大小上限。`} />
      ) : (
        <ZoomPanImage
          src={withClientFeatures(`/api/projects/${encodeURIComponent(project.id)}/file/image?path=${encodeURIComponent(preview.path)}&version=${preview.hash}`)}
          alt={preview.path.split('/').at(-1) ?? preview.path}
          className="min-h-0 flex-1 bg-subtle/30"
          onError={() => setImageLoadError(true)}
        />
      ) : showingRendered ? (
        preview.render ? (
          <ContentPreview
            key={`${preview.path}:${preview.hash ?? ''}`}
            title={preview.path.split('/').at(-1) ?? t`文件预览`}
            url={`${projectFileUrl(project.id, preview.path)}&render=preview&${previewTheme}`}
            onDownload={() => downloadProjectFile(project.id, preview.path)}
          />
        ) : (
          <iframe title={preview.path.split('/').at(-1) ?? t`HTML 预览`} src={projectFileUrl(project.id, preview.path)} sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 border-0 bg-bg" />
        )
      ) : preview.binary ? (
        <EmptyState icon={<IconFile />} title={t`二进制文件`} description={t`${formatBytes(preview.size)} · 无法在这里预览`}>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => downloadProjectFile(project.id, preview.path)}><IconDownload /><Trans>下载</Trans></Button>
            <Button variant="secondary" onClick={() => openProjectFile(project.id, preview.path)}><IconExternalLink /><Trans>在新标签页打开</Trans></Button>
          </div>
        </EmptyState>
      ) : (
        <Suspense fallback={previewFallback}><CodeView preview={preview} target={jump?.path === preview.path ? jump : undefined} onReference={onReference} onSymbol={onSymbol} onTopLine={(line) => topLines.current.set(preview.path, line)} /></Suspense>
      )}
    </div>
  );

  const searchPage = (
    <div className="flex min-h-0 flex-1 flex-col">
      <form className="flex shrink-0 flex-col gap-2 p-3" onSubmit={(event) => { event.preventDefault(); void runSearch(); }}>
        <label className="relative flex items-center">
          <IconSearch className="pointer-events-none absolute left-2.5 size-3.5 text-fg-4" />
          <input autoFocus={focusSearch.current} value={query} onChange={(event) => { searchRequest.current += 1; searchScroll.current = 0; setSearching(false); setQuery(event.target.value); if (searchMode === 'content' || !event.target.value.trim()) setFound(undefined); setHits(undefined); }} placeholder={searchMode === 'name' ? t`按文件名查找` : t`搜索文件内容`} className="h-8 w-full rounded-lg border border-line-strong bg-elevated pl-8 pr-2.5 text-sm text-fg outline-none placeholder:text-fg-4 focus:border-accent focus:ring-3 focus:ring-accent/15" />
        </label>
        <Segmented size="xs" value={searchMode} onChange={(value) => { searchRequest.current += 1; searchScroll.current = 0; setSearching(false); setSearchMode(value); setFound(undefined); setHits(undefined); }} ariaLabel={t`搜索方式`} options={[{ value: 'name', label: t`文件名` }, { value: 'content', label: t`内容` }]} />
      </form>
      <div ref={searchListRef} onScroll={(event) => { searchScroll.current = event.currentTarget.scrollTop; }} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {searching && (searchMode === 'content' || !found) && <div className="flex justify-center py-8"><Spinner /></div>}
        {searchMode === 'name' && !query.trim() && recent.byRecency.length > 0 && (
          <>
            <div className="px-2 pb-1 pt-1 text-xs text-fg-4"><Trans>最近查看</Trans></div>
            {recent.byRecency.map(({ path: file }) => {
              const { name, dir } = splitPath(file);
              return (
                <button key={file} type="button" title={file} onClick={() => void openPreview(file)} className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover max-md:min-h-12 no-hover:min-h-12">
                  <FileIcon entry={{ kind: 'file', name }} />
                  <span className="shrink-0 truncate text-sm text-fg-2">{name}</span>
                  <DirectoryHint dir={dir} />
                </button>
              );
            })}
          </>
        )}
        {/* Typing keeps the last names until the next ones arrive. */}
        {searchMode === 'name' && found?.map((entry) => (
          <button key={entry.path} type="button" title={entry.path} onClick={() => entry.kind === 'directory' ? showFolder(entry.path) : void openPreview(entry.path)} className={cn('flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover max-md:min-h-12 max-md:py-1.5 no-hover:min-h-12', wide && entry.path === previewFilePath && 'bg-active hover:bg-active')}>
            <span className="shrink-0"><FileIcon entry={entry} /></span>
            <span className={cn('flex min-w-0 flex-1 items-center gap-2 max-md:flex-col max-md:items-stretch max-md:gap-0.5', wide && 'flex-col items-stretch gap-0')}>
              <span className="min-w-0 shrink-0 truncate text-sm text-fg-2 max-md:shrink"><Matched text={entry.name} query={query} /></span>
              {/* The directory, cut at its start: its last folders tell same-named files apart. */}
              <span className="min-w-0 truncate text-left font-mono text-2xs text-fg-3 [direction:rtl]"><bdi>{entry.path.slice(0, Math.max(0, entry.path.length - entry.name.length - 1))}</bdi></span>
            </span>
          </button>
        ))}
        {!searching && searchMode === 'content' && hits?.map((hit, index) => (
          <div key={`${hit.path}:${hit.line}:${index}`} className="group/hit flex flex-col gap-0.5 rounded-md px-2 py-1.5 hover:bg-hover">
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => void openPreview(hit.path, hit.line)} className="min-w-0 truncate text-left font-mono text-2xs text-fg-3 hover:text-accent">{hit.path}:{hit.line}</button>
              <span className="ml-auto flex shrink-0 items-center opacity-0 transition-opacity pointer-events-none group-hover/hit:opacity-100 group-hover/hit:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto no-hover:opacity-100 no-hover:pointer-events-auto">
                <Tip label={t`引用到对话`}><button type="button" aria-label={t`引用到对话`} onClick={() => onReference(hit)} className="grid size-5 place-items-center rounded text-fg-3 hover:bg-active hover:text-fg no-hover:size-11"><IconPlus className="size-3.5" /></button></Tip>
                <Tip label={t`在编辑器中打开`}><button type="button" aria-label={t`在编辑器中打开`} onClick={() => openInEditor(hit.path, hit.line)} className="grid size-5 place-items-center rounded text-fg-3 hover:bg-active hover:text-fg no-hover:size-11"><IconSquareArrowOutUpRight className="size-3" /></button></Tip>
              </span>
            </div>
            <code className="truncate font-mono text-xs text-fg">{hit.text.trim()}</code>
          </div>
        ))}
        {!searching && ((searchMode === 'name' && found && !found.length) || (searchMode === 'content' && hits && !hits.length)) && <EmptyState title={t`没有找到匹配项`} />}
      </div>
    </div>
  );

  const usagesPage = usages && (() => {
    const groups = new Map<string, CodeLocation[]>();
    for (const location of usages.locations) { const group = groups.get(location.path); if (group) group.push(location); else groups.set(location.path, [location]); }
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-1.5 edge-b px-2 max-md:h-12 no-hover:h-12">
          <Button size="icon-xs" variant="quiet" className="max-md:size-10" aria-label={t`关闭`} onClick={closeUsages}>{wide ? <IconX /> : <IconArrowLeft />}</Button>
          <span className="min-w-0 truncate font-mono text-xs font-medium text-fg">{usages.word}</span>
          {(usages.locations.length > 0 || !usages.searching) && <span className="shrink-0 text-2xs tabular-nums text-fg-3">{usages.locations.length}{usages.complete || usages.searching ? '' : '+'}</span>}
          {usages.searching && <Spinner className="ml-auto mr-1" />}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
          {[...groups].map(([file, locations]) => {
            const { name, dir } = splitPath(file);
            return (
              <div key={file} className="pt-2">
                <div className="flex h-6 min-w-0 items-center gap-1.5 px-1.5 text-xs" title={file}>
                  <span className="shrink-0 truncate font-medium text-fg-2">{name}</span>
                  <span className="min-w-0 truncate font-mono text-2xs text-fg-4 [direction:rtl]"><bdi>{dir}</bdi></span>
                </div>
                {locations.map((location) => (
                  <button key={`${location.line}:${location.column}`} type="button" onClick={() => openUsage(location)} className={cn('flex w-full min-w-0 items-baseline gap-2 rounded px-1.5 py-0.5 text-left hover:bg-hover max-md:py-2', wide && jump?.path === location.path && jump.line === location.line && 'bg-active hover:bg-active')}>
                    <span className="w-9 shrink-0 text-right font-mono text-2xs tabular-nums text-fg-4">{location.line}</span>
                    <Occurrence location={location} word={usages.word} />
                  </button>
                ))}
              </div>
            );
          })}
          {!usages.searching && !usages.locations.length && <EmptyState title={t`没有找到用法`} />}
        </div>
      </div>
    );
  })();

  const narrowPage = previewPath !== undefined ? previewPage : usagesPage || (searchOpen ? searchPage : listingPage);

  return (
    <OverlayScopeContext.Provider value={overlay.scope}>
      {headerSlot && shown && createPortal(
        <>
        {wide && <Tip label={t`搜索文件`} kbd={shortcutLabel('P')}><Button size="icon-xs" variant="quiet" aria-label={t`搜索文件`} onClick={() => setQuickOpen('name')}><IconSearch /></Button></Tip>}
        {!wide && previewPath === undefined && <Tip label={searchOpen ? t`返回文件列表` : t`搜索文件`}><Button size="icon-xs" variant="quiet" className={cn('max-md:size-10', searchOpen && 'bg-active text-fg')} aria-label={searchOpen ? t`返回文件列表` : t`搜索文件`} onClick={() => { if (searchOpen) goBack(); else openSearch(); }}>{searchOpen ? <IconArrowLeft /> : <IconSearch />}</Button></Tip>}
        {!wide && previewPath === undefined && !searchOpen && !usages && <Tip label={path ? t`下载此文件夹（ZIP）` : t`下载整个项目（ZIP）`}><Button size="icon-xs" variant="quiet" className="max-md:size-10" aria-label={t`下载文件夹`} onClick={() => void downloadProjectFolder(project.id, path)}><IconDownload /></Button></Tip>}
        {(wide || !searchOpen || previewPath !== undefined) && <Tip label={t`刷新`}><Button size="icon-xs" variant="quiet" className="max-md:size-10" aria-label={t`刷新`} onClick={refreshFiles}><IconRefreshCw /></Button></Tip>}
        </>,
        headerSlot,
      )}

      {shown && (wide ? (
        <div className="flex min-h-0 flex-1">
          <div ref={treeColumn} className="relative flex shrink-0 flex-col edge-r" style={{ width: treeWidth }}>
            {treePage}{usagesPage}
            <ResizeHandle
              axis="x" grow={1} value={treeWidth} min={TREE_WIDTH.min} max={TREE_WIDTH.max} label={t`调整文件树宽度`} className="absolute inset-y-0 -right-1 w-2"
              onPreview={(width) => { if (treeColumn.current) treeColumn.current.style.width = `${width}px`; }}
              onChange={settleTreeWidth} onReset={() => settleTreeWidth(TREE_WIDTH.default)}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            {recent.files.length > 0 && <EditorTabs files={recent.files.map((file) => file.path)} active={previewFilePath} onOpen={(file) => void openPreview(file)} onClose={closeTab} />}
            {previewPage || <div className="m-auto text-sm text-fg-4"><Trans>按 {shortcutLabel('P')} 搜索文件</Trans></div>}
          </div>
        </div>
      ) : narrowPage)}

      {wide && shown && (
        <QuickOpen
          open={quickOpen !== undefined} onOpenChange={(open) => { if (!open) setQuickOpen(undefined); }} mode={quickOpen ?? 'name'}
          projectId={project.id} recent={recent.byRecency.map((file) => file.path)} current={previewFilePath}
          onOpenFile={(file, line) => void openPreview(file, line)} onShowFolder={showFolder} onError={onError}
        />
      )}

      {/* The identifier menu and the choice among several definitions, at the pointer. */}
      <DropdownMenu open={Boolean(symbolMenu)} onOpenChange={(open) => { if (!open) setSymbolMenu(undefined); }}>
        {/* In the body: the panel is a containing block of its own, and the point is the window's. */}
        {createPortal(<DropdownMenuTrigger asChild><span aria-hidden className="pointer-events-none fixed size-0" style={{ left: symbolMenu?.x ?? 0, top: symbolMenu?.y ?? 0 }} /></DropdownMenuTrigger>, document.body)}
        <DropdownMenuContent align="start" className="min-w-52 max-w-[32rem]">
          {symbolMenu?.definitions ? symbolMenu.definitions.map((location) => {
            const { name, dir } = splitPath(location.path);
            return (
              <DropdownMenuItem key={`${location.path}:${location.line}`} onSelect={() => jumpTo(location)} title={`${location.path}:${location.line}`}>
                <IconFileCode2 />
                <span className="shrink-0">{name}</span>
                <span className="min-w-0 truncate font-mono text-2xs text-fg-3 [direction:rtl]"><bdi>{dir}</bdi></span>
                <span className="ml-auto shrink-0 pl-2 font-mono text-2xs tabular-nums text-fg-4">{location.line}</span>
              </DropdownMenuItem>
            );
          }) : symbolMenu && preview && (
            <>
              <DropdownMenuItem onSelect={() => void goToDefinition(symbolMenu.at, symbolMenu)}><IconCornerUpRight /><Trans>跳转到定义</Trans><span className="ml-auto pl-4 text-2xs text-fg-4">{isApplePlatform ? t`⌘ 点击` : t`Ctrl 点击`}</span></DropdownMenuItem>
              <DropdownMenuItem onSelect={() => findUsages(symbolMenu.at)}><IconSearch /><Trans>查找用法</Trans></DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => { const text = preview.content.split('\n')[symbolMenu.at.line - 1] ?? ''; onReference({ path: preview.path, line: symbolMenu.at.line, text }); }}><IconPlus /><Trans>引用这一行</Trans></DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void copyWithToast(symbolMenu.at.word, t`已复制`)}><IconCopy /><Trans>复制</Trans></DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </OverlayScopeContext.Provider>
  );
}

/** A usage's line, trimmed, with the occurrence at its column set apart. */
function Occurrence({ location, word }: { location: CodeLocation; word: string }) {
  const at = location.column - 1;
  const found = location.text.slice(at, at + word.length) === word;
  const before = found ? location.text.slice(0, at).trimStart() : location.text.trim();
  return (
    <code className="min-w-0 truncate whitespace-pre font-mono text-xs text-fg-2">
      {before}{found && <><span className="rounded-sm bg-accent-soft text-fg">{word}</span>{location.text.slice(at + word.length)}</>}
    </code>
  );
}

/** The files viewed last, as an IDE's editor tabs: one click back to any of them. */
function EditorTabs({ files, active, onOpen, onClose }: { files: string[]; active?: string | undefined; onOpen: (path: string) => void; onClose: (path: string) => void }) {
  const { t } = useLingui();
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const tab = [...(row.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])].find((element) => element.dataset.path === active);
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, files.length]);
  // Same-named files carry their folder, as VS Code's tabs do.
  const names = new Map<string, number>();
  for (const file of files) { const { name } = splitPath(file); names.set(name, (names.get(name) ?? 0) + 1); }
  return (
    <div ref={row} role="tablist" aria-label={t`最近查看`} className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto edge-b px-1.5 scrollbar-none">
      {files.map((file) => {
        const { name, dir } = splitPath(file);
        const selected = file === active;
        return (
          <div
            key={file} data-path={file} role="tab" aria-selected={selected} title={file}
            onMouseDown={(event) => { if (event.button === 1) { event.preventDefault(); onClose(file); } }}
            className={cn('group/tab flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-md pl-2 pr-1 text-xs', selected ? 'bg-active text-fg' : 'text-fg-3 hover:bg-hover hover:text-fg')}
          >
            <button type="button" onClick={() => onOpen(file)} className="flex min-w-0 items-center gap-1.5 outline-none">
              <FileIcon entry={{ kind: 'file', name }} className="size-3.5" />
              <span className="truncate">{name}</span>
              {(names.get(name) ?? 0) > 1 && <span className="truncate text-fg-4">{splitPath(dir).name}</span>}
            </button>
            <button type="button" aria-label={t`关闭`} onClick={() => onClose(file)} className={cn('grid size-4 shrink-0 place-items-center rounded text-fg-4 hover:bg-hover hover:text-fg', !selected && 'opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100')}><IconX className="size-3" /></button>
          </div>
        );
      })}
    </div>
  );
}
