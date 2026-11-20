import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { API, type Mark, type MarkColor, type MarkFacets, type MarkListQuery, type NativeBackendCatalogEntry, type NativeBackendId } from '@contracts';
import {
  IconBookmark,
  IconCheck,
  IconCircleAlert,
  IconCopy,
  IconCornerUpRight,
  IconFileText,
  IconImage,
  IconRefreshCw,
  IconSearch,
  IconSquareCheck,
  IconTrash2,
} from '@/components/icons';
import { AgentLogo } from '@/components/AgentLogo';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Segmented, Spinner } from '@/components/ui/controls';
import { RowActions } from '@/components/ui/list-row';
import { SearchField } from '@/components/ui/search-field';
import { TileGrid } from '@/components/ui/tile';
import { Tip } from '@/components/ui/tooltip';
import { api, type ProjectRecord } from '@/lib/api';
import { agentMarkStyle, useBackendLabel } from '@/lib/backends';
import { confirmDialog } from '@/lib/dialogs';
import { copyWithToast } from '@/lib/files';
import { dismissToast, toast, useToasts, type ToastAction } from '@/lib/toast';
import { cn, errorMessage, formatDateTime, newId, readSession, timeAgo, writeSession } from '@/lib/utils';
import { PageScaffold } from '../PageScaffold';
import { markSwatch } from '../session/marks';
import { WAIT_GRACE_MS, useLingering } from '../session/sessionLayout';
import { useMarks, useStores } from '../state/stores';
import { MarkDetailDialog } from './MarkDetailDialog';
import { MarksAside, MarksScopeMenu } from './MarksNav';
import { ShareImageDialog, shareModelName, type ShareSource } from './ShareImage';
import {
  HighlightedText,
  markBorderClass,
  markCopyText,
  markPreviewText,
  type MarkTab,
  type MarkViewMode,
} from './marksHelpers';

const PAGE = 30;
/** The server's largest page; a re-read of a longer list starts over from its first this many. */
const MAX_PAGE = 200;
const SEARCH_DEBOUNCE_MS = 250;

interface Loaded { key: string; marks: Mark[]; nextCursor?: string; total: number }

const VIEW_KEY = 'riffet.marks.view';
const TABS: readonly MarkTab[] = ['all', 'message', 'span', 'image', 'file', 'orphaned'];
const VIEW_MODES: readonly MarkViewMode[] = ['grid', 'list'];

interface View {
  text: string;
  projectId: string;
  backendId: NativeBackendId | '';
  tab: MarkTab;
  viewMode: MarkViewMode;
  scrollTop: number;
}

function readView(): View {
  const value = readSession(VIEW_KEY) as Partial<View> | null | undefined;
  return {
    text: typeof value?.text === 'string' ? value.text : '',
    projectId: typeof value?.projectId === 'string' ? value.projectId : '',
    backendId: typeof value?.backendId === 'string' ? (value.backendId as NativeBackendId) : '',
    tab: TABS.includes(value?.tab as MarkTab) ? value!.tab! : 'all',
    viewMode: VIEW_MODES.includes(value?.viewMode as MarkViewMode) ? value!.viewMode! : 'grid',
    scrollTop: typeof value?.scrollTop === 'number' ? value.scrollTop : 0,
  };
}

function MarkKindGlyph({ mark }: { mark: Mark }) {
  const color = mark.color ?? 'yellow';
  if (mark.kind === 'span') return <span aria-hidden className={cn('size-2 shrink-0 rounded-full', markSwatch[color])} />;
  if (mark.kind === 'image') return <IconImage aria-hidden className="size-3.5 shrink-0 text-fg-3" />;
  if (mark.kind === 'file') return <IconFileText aria-hidden className="size-3.5 shrink-0 text-fg-3" />;
  return <IconBookmark aria-hidden className="size-3.5 shrink-0 text-fg-3" />;
}

function SelectCircle({ chosen }: { chosen: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-full border transition-colors',
        chosen ? 'border-primary bg-primary text-primary-fg' : 'border-line-strong bg-bg',
      )}
    >
      {chosen && <IconCheck className="size-3" />}
    </span>
  );
}

function FileSummary({ mark }: { mark: Mark }) {
  const asset = mark.asset;
  const directory = asset?.path?.slice(0, Math.max(0, asset.path.length - asset.name.length)).replace(/\/$/, '');
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-lg bg-subtle px-3 py-2">
      <IconFileText aria-hidden className="size-4 shrink-0 text-fg-3" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-xs font-medium text-fg">{asset?.name}</span>
        {directory && <span className="truncate font-mono text-2xs text-fg-3">{directory}</span>}
      </div>
      {asset?.detail && (
        <span className="flex shrink-0 items-center gap-1 font-mono text-2xs tabular-nums text-fg-3">
          {asset.detail.split(' ').map((part, index) => (
            <span key={index} className={part.startsWith('+') ? 'text-success' : part.startsWith('−') ? 'text-danger' : undefined}>
              {part}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function MarkTile({
  mark,
  query,
  projectName,
  backendLabel,
  selecting,
  chosen,
  onActivate,
  onOpenSession,
  onOpenFile,
}: {
  mark: Mark;
  query: string;
  projectName: string;
  backendLabel?: string;
  selecting: boolean;
  chosen: boolean;
  onActivate: () => void;
  onOpenSession: () => void;
  onOpenFile: () => void;
}) {
  const { t } = useLingui();
  const color = mark.color ?? 'yellow';
  const orphaned = mark.state === 'orphaned';
  const preview = useMemo(() => markPreviewText(mark, query), [mark, query]);
  const title = mark.snapshot.sessionTitle || t`未命名会话`;

  return (
    <article
      className={cn(
        'group/row relative flex min-h-44 min-w-0 flex-col gap-2.5 rounded-xl border bg-elevated p-4 transition-colors',
        'hover:border-line-strong has-[[data-mark-open]:focus-visible]:ring-2 has-[[data-mark-open]:focus-visible]:ring-focus',
        chosen ? 'border-primary bg-subtle' : 'border-line',
      )}
    >
      <header className="flex min-w-0 items-center gap-2 text-xs">
        {selecting ? <SelectCircle chosen={chosen} /> : <MarkKindGlyph mark={mark} />}
        <button
          type="button"
          data-mark-open
          aria-haspopup={selecting ? undefined : 'dialog'}
          aria-pressed={selecting ? chosen : undefined}
          onClick={onActivate}
          className="min-w-0 flex-1 truncate text-left font-medium text-fg-2 outline-none after:absolute after:inset-0 after:rounded-xl"
        >
          <HighlightedText text={title} query={query} />
        </button>
        {orphaned && <Badge tone="warning" className="shrink-0"><Trans>失联</Trans></Badge>}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {mark.kind === 'image' ? (
          <div className="h-28 w-full overflow-hidden rounded-lg border border-line bg-subtle">
            <img
              src={`${API.marks}/${encodeURIComponent(mark.id)}/asset`}
              alt={mark.asset?.name ?? t({ message: '图片', context: 'marks-image-name' })}
              loading="lazy"
              className="h-full w-full object-contain"
            />
          </div>
        ) : mark.kind === 'file' ? (
          <FileSummary mark={mark} />
        ) : mark.kind === 'span' ? (
          <p className={cn('line-clamp-4 border-l-2 pl-3 text-sm leading-relaxed text-fg', markBorderClass[color], orphaned && 'text-fg-2')}>
            <HighlightedText text={preview} query={query} />
          </p>
        ) : (
          <p className={cn('line-clamp-4 text-sm leading-relaxed text-fg-2', orphaned && 'opacity-80')}>
            <HighlightedText text={preview} query={query} />
          </p>
        )}

        {mark.note && (
          <p className="mt-auto truncate border-l-2 border-line-strong pl-2 text-xs text-fg-3">
            <HighlightedText text={mark.note} query={query} />
          </p>
        )}
      </div>

      <footer className="mt-auto flex min-h-6 items-center gap-2 text-xs text-fg-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
          <span className="truncate">{projectName}</span>
          {mark.backendId && (
            <span className="inline-flex shrink-0 items-center" aria-label={backendLabel}>
              <AgentLogo backend={mark.backendId} size={12} style={agentMarkStyle(mark.backendId)} />
            </span>
          )}
          <span aria-hidden className="text-fg-4">·</span>
          <time dateTime={mark.createdAt} title={formatDateTime(mark.createdAt)} className="shrink-0 tabular-nums text-fg-4">
            {timeAgo(mark.createdAt)}
          </time>
        </div>

        {!selecting && (
          <RowActions className="relative gap-0.5" onClick={(event) => event.stopPropagation()}>
            {mark.kind === 'file' && mark.asset?.path && (
              <Tip label={t`打开文件`}>
                <Button size="icon-xs" variant="quiet" aria-label={t`打开文件`} onClick={onOpenFile}>
                  <IconFileText />
                </Button>
              </Tip>
            )}
            {mark.kind !== 'image' && (
              <Tip label={mark.kind === 'file' ? t`复制路径` : t`复制内容`}>
                <Button
                  size="icon-xs"
                  variant="quiet"
                  aria-label={mark.kind === 'file' ? t`复制路径` : t`复制内容`}
                  onClick={() => void copyWithToast(markCopyText(mark))}
                >
                  <IconCopy />
                </Button>
              </Tip>
            )}
            <Tip label={t`前往原会话`}>
              <Button size="icon-xs" variant="quiet" aria-label={t`前往原会话`} onClick={onOpenSession}>
                <IconCornerUpRight />
              </Button>
            </Tip>
          </RowActions>
        )}
      </footer>
    </article>
  );
}

function MarkListRow({
  mark,
  query,
  projectName,
  backendLabel,
  selecting,
  chosen,
  onActivate,
  onOpenSession,
  onOpenFile,
}: {
  mark: Mark;
  query: string;
  projectName: string;
  backendLabel?: string;
  selecting: boolean;
  chosen: boolean;
  onActivate: () => void;
  onOpenSession: () => void;
  onOpenFile: () => void;
}) {
  const { t } = useLingui();
  const color = mark.color ?? 'yellow';
  const orphaned = mark.state === 'orphaned';
  const preview = useMemo(() => markPreviewText(mark, query), [mark, query]);
  const title = mark.snapshot.sessionTitle || t`未命名会话`;

  return (
    <li
      className={cn(
        'group/row relative flex min-w-0 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover max-md:px-3',
        'has-[[data-mark-open]:focus-visible]:ring-2 has-[[data-mark-open]:focus-visible]:ring-inset has-[[data-mark-open]:focus-visible]:ring-focus',
        chosen && 'bg-subtle',
      )}
    >
      {selecting ? (
        <SelectCircle chosen={chosen} />
      ) : mark.kind === 'span' ? (
        <span aria-hidden className={cn('w-0.5 self-stretch rounded-full', markSwatch[color])} />
      ) : (
        <span className="grid size-4 shrink-0 place-items-center">
          <MarkKindGlyph mark={mark} />
        </span>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            data-mark-open
            aria-haspopup={selecting ? undefined : 'dialog'}
            aria-pressed={selecting ? chosen : undefined}
            onClick={onActivate}
            className="min-w-0 flex-1 truncate text-left text-sm text-fg outline-none after:absolute after:inset-0"
          >
            <HighlightedText text={preview || title} query={query} />
          </button>
          {orphaned && <Badge tone="warning" className="shrink-0"><Trans>失联</Trans></Badge>}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-fg-3">
          <span className="truncate"><HighlightedText text={title} query={query} /></span>
          {mark.note && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate text-fg-3"><HighlightedText text={mark.note} query={query} /></span>
            </>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 text-xs text-fg-3">
        <span className="hidden max-w-28 truncate sm:inline">{projectName}</span>
        {mark.backendId && (
          <span className="hidden items-center sm:inline-flex" aria-label={backendLabel}>
            <AgentLogo backend={mark.backendId} size={13} style={agentMarkStyle(mark.backendId)} />
          </span>
        )}
        <time dateTime={mark.createdAt} title={formatDateTime(mark.createdAt)} className="w-14 text-right tabular-nums text-fg-4 max-sm:w-auto">
          {timeAgo(mark.createdAt)}
        </time>

        {!selecting && (
          <RowActions className="relative gap-0.5" onClick={(event) => event.stopPropagation()}>
            {mark.kind === 'file' && mark.asset?.path && (
              <Tip label={t`打开文件`}>
                <Button size="icon-xs" variant="quiet" aria-label={t`打开文件`} onClick={onOpenFile}>
                  <IconFileText />
                </Button>
              </Tip>
            )}
            {mark.kind !== 'image' && (
              <Tip label={mark.kind === 'file' ? t`复制路径` : t`复制内容`}>
                <Button
                  size="icon-xs"
                  variant="quiet"
                  aria-label={mark.kind === 'file' ? t`复制路径` : t`复制内容`}
                  onClick={() => void copyWithToast(markCopyText(mark))}
                >
                  <IconCopy />
                </Button>
              </Tip>
            )}
            <Tip label={t`前往原会话`}>
              <Button size="icon-xs" variant="quiet" aria-label={t`前往原会话`} onClick={onOpenSession}>
                <IconCornerUpRight />
              </Button>
            </Tip>
          </RowActions>
        )}
      </div>
    </li>
  );
}

/**
 * 收藏夹: cross-conversation saved replies, highlights, images and files.
 * Scope navigation sits in the left `aside` (collapsing to a title-bar menu below `lg`),
 * the board shows dense cards or compact rows, and clicking any item opens its full reader dialog.
 */
export function MarksPage({
  projects,
  backends = [],
  sidebarCollapsed,
  onClose,
  onOpenSidebar,
  onExpandSidebar,
  onOpenMark,
  onOpenMarkFile,
}: {
  projects: ProjectRecord[];
  backends?: NativeBackendCatalogEntry[];
  sidebarCollapsed: boolean;
  onClose: () => void;
  onOpenSidebar: () => void;
  onExpandSidebar: () => void;
  onOpenMark: (id: string) => void;
  onOpenMarkFile: (mark: Mark) => void;
}) {
  const { t } = useLingui();
  const labelOf = useBackendLabel();
  const { marks: store } = useStores();
  const revision = useMarks((state) => state.revision);
  const [saved] = useState(readView);
  const [text, setText] = useState(saved.text);
  const [q, setQ] = useState(() => saved.text.trim());
  const [projectId, setProjectId] = useState(() =>
    projects.some((item) => item.id === saved.projectId && !item.archivedAt) ? saved.projectId : '',
  );
  const [backendId, setBackendId] = useState<NativeBackendId | ''>(() =>
    backends.some((item) => item.backendId === saved.backendId) ? saved.backendId : '',
  );
  const [tab, setTab] = useState<MarkTab>(saved.tab);
  const [viewMode, setViewMode] = useState<MarkViewMode>(saved.viewMode);
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string>();
  const [shareMark, setShareMark] = useState<Mark>();
  const [locating, setLocating] = useState(false);
  const [facets, setFacets] = useState<MarkFacets>();

  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const held = useRef<{ key: string; limit: number; etag?: string }>(undefined);
  const facetsEtag = useRef<string>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const view = useRef(saved);
  const restore = useRef(saved.scrollTop);

  useEffect(() => {
    view.current = { ...view.current, text, projectId, backendId, tab, viewMode };
    writeSession(VIEW_KEY, view.current);
  }, [text, projectId, backendId, tab, viewMode]);

  useEffect(() => {
    const save = () => writeSession(VIEW_KEY, view.current);
    window.addEventListener('pagehide', save);
    return () => { window.removeEventListener('pagehide', save); save(); };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  const query = useMemo<MarkListQuery>(() => ({
    ...(projectId ? { projectId } : {}),
    ...(backendId ? { backendId } : {}),
    ...(tab === 'message' || tab === 'span' || tab === 'image' || tab === 'file' ? { kind: tab } : {}),
    ...(tab === 'orphaned' ? { state: 'orphaned' as const } : {}),
    ...(q ? { q } : {}),
  }), [projectId, backendId, tab, q]);
  const key = JSON.stringify(query);
  const stale = loaded?.key !== key;
  const current = stale && error ? undefined : loaded;

  useEffect(() => {
    const controller = new AbortController();
    const same = held.current?.key === key;
    const limit = same ? Math.min(MAX_PAGE, Math.max(PAGE, loadedRef.current?.marks.length ?? 0)) : PAGE;
    const etag = same && held.current?.limit === limit ? held.current.etag : undefined;
    void api.marks({ ...query, limit }, etag, controller.signal).then((result) => {
      if (controller.signal.aborted || result.unchanged) return;
      held.current = { key, limit, ...(result.etag ? { etag: result.etag } : {}) };
      setLoaded({ key, ...result.data });
      setError('');
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(errorMessage(reason, t`无法加载收藏`));
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, revision]);

  useEffect(() => {
    const controller = new AbortController();
    void api.markFacets(facetsEtag.current, controller.signal).then((result) => {
      if (controller.signal.aborted || result.unchanged) return;
      facetsEtag.current = result.etag;
      setFacets(result.data);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [revision]);

  const loadMore = useCallback(async () => {
    const shown = loadedRef.current;
    if (!shown?.nextCursor || shown.key !== key || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await api.marks({ ...query, limit: PAGE, cursor: shown.nextCursor });
      if (result.unchanged || loadedRef.current !== shown) return;
      const seen = new Set(shown.marks.map((mark) => mark.id));
      const marks = [...shown.marks, ...result.data.marks.filter((mark) => !seen.has(mark.id))];
      held.current = { key, limit: marks.length };
      setLoaded({ key, marks, total: result.data.total, ...(result.data.nextCursor ? { nextCursor: result.data.nextCursor } : {}) });
    } catch (reason) {
      toast.error(errorMessage(reason, t`无法加载更多收藏`));
    } finally {
      setLoadingMore(false);
    }
  }, [key, query, loadingMore, t]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !current?.nextCursor) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some((entry) => entry.isIntersecting)) void loadMore(); },
      { root: scrollRef.current, rootMargin: '400px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [current?.nextCursor, loadMore]);

  const projectName = useCallback(
    (id: string) => projects.find((item) => item.id === id)?.name ?? t`已移除的项目`,
    [projects, t],
  );

  const patchShown = (update: (marks: Mark[]) => Mark[]) => setLoaded((shown) => {
    if (!shown) return shown;
    const marks = update(shown.marks);
    return { ...shown, marks, total: shown.total - (shown.marks.length - marks.length) };
  });

  const patchMark = (updated: Mark) => setLoaded((shown) =>
    shown && { ...shown, marks: shown.marks.map((item) => item.id === updated.id ? updated : item) },
  );

  const saveNote = async (mark: Mark, note: string | null) => {
    const updated = await store.update(mark.id, { note });
    if (updated) patchMark(updated);
  };

  const saveColor = async (mark: Mark, color: MarkColor) => {
    if (mark.color === color) return;
    const updated = await store.update(mark.id, { color });
    if (updated) patchMark(updated);
  };

  const locateMark = async (mark: Mark) => {
    if (locating) return;
    setLocating(true);
    try {
      const result = await api.locateMark(mark.id);
      patchMark(result.mark);
      if (result.found) {
        store.set((state) => ({ revision: state.revision + 1 }));
        toast.success(t`已重新定位到原会话`);
      } else {
        toast.info(t`仍未找到原文`);
      }
    } catch (reason) {
      toast.error(errorMessage(reason, t`无法定位这条收藏`));
    } finally {
      setLocating(false);
    }
  };

  const pending = useRef(new Map<string, ToastAction>());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const unhide = (id: string) => setHidden((set) => { const next = new Set(set); next.delete(id); return next; });
  const commit = useCallback((id: string) => {
    if (!pending.current.delete(id)) return;
    void store.remove([id]).then((removed) => { if (!removed) unhide(id); });
  }, [store]);
  const toasts = useToasts();
  const toastsRef = useRef(toasts);
  useEffect(() => {
    toastsRef.current = toasts;
    for (const [id, action] of pending.current) if (!toasts.some((item) => item.action === action && !item.leaving)) commit(id);
  }, [toasts, commit]);

  useEffect(() => {
    const unloading = () => {
      if (!pending.current.size) return;
      void api.deleteMarks([...pending.current.keys()], { keepalive: true }).catch(() => undefined);
      for (const action of pending.current.values()) {
        const item = toastsRef.current.find((entry) => entry.action === action);
        if (item) dismissToast(item.id);
      }
      pending.current.clear();
    };
    window.addEventListener('pagehide', unloading);
    return () => window.removeEventListener('pagehide', unloading);
  }, []);

  useEffect(() => () => {
    for (const [id, action] of pending.current) {
      const item = toastsRef.current.find((entry) => entry.action === action);
      if (item) dismissToast(item.id);
      commit(id);
    }
  }, [commit]);

  const removeOne = async (mark: Mark) => {
    if (activeId === mark.id) setActiveId(undefined);
    if (mark.kind === 'image') {
      const action: ToastAction = { label: t`撤销`, onClick: () => { if (pending.current.delete(mark.id)) unhide(mark.id); } };
      pending.current.set(mark.id, action);
      setHidden((set) => new Set(set).add(mark.id));
      toast.success(t`已删除收藏`, { action });
      return;
    }
    const snapshot = loadedRef.current;
    patchShown((marks) => marks.filter((item) => item.id !== mark.id));
    if (!await store.remove([mark.id])) {
      if (snapshot) setLoaded(snapshot);
      return;
    }
    const asset = mark.asset && {
      name: mark.asset.name,
      ...(mark.asset.path ? { path: mark.asset.path } : {}),
      ...(mark.asset.mimeType ? { mimeType: mark.asset.mimeType } : {}),
      ...(mark.asset.detail ? { detail: mark.asset.detail } : {}),
    };
    toast.success(t`已删除收藏`, {
      action: {
        label: t`撤销`,
        onClick: () => void store.create({
          id: newId(),
          sessionId: mark.sessionId,
          kind: mark.kind,
          anchor: mark.anchor,
          ...(mark.quote ? { quote: mark.quote } : {}),
          ...(asset ? { asset } : {}),
          snapshot: { text: mark.snapshot.text, at: mark.snapshot.at },
          ...(mark.note ? { note: mark.note } : {}),
          ...(mark.color ? { color: mark.color } : {}),
        }),
      },
    });
  };

  const removeChosen = async () => {
    const ids = [...chosen];
    if (!ids.length || !await confirmDialog({
      title: t`删除 ${ids.length} 条收藏？`,
      description: t`删除后无法恢复。`,
      confirmLabel: t({ message: '删除', context: 'marks-delete-action' }),
      destructive: true,
    })) return;
    const snapshot = loadedRef.current;
    patchShown((marks) => marks.filter((item) => !chosen.has(item.id)));
    setChosen(new Set());
    setSelecting(false);
    if (await store.remove(ids)) toast.success(t`已删除 ${ids.length} 条收藏`);
    else if (snapshot) setLoaded(snapshot);
  };

  const filtered = Boolean(q || projectId || backendId || tab !== 'all');
  const shown = useMemo(() => current?.marks.filter((mark) => !hidden.has(mark.id)), [current?.marks, hidden]);
  const waiting = useLingering(stale && !current?.marks.length && !error, WAIT_GRACE_MS);
  const total = current && shown ? current.total - (current.marks.length - shown.length) : 0;
  const activeMark = useMemo(() => shown?.find((mark) => mark.id === activeId), [shown, activeId]);
  const shareSource = useMemo<ShareSource | undefined>(() => {
    if (!shareMark || (shareMark.kind !== 'message' && shareMark.kind !== 'span')) return undefined;
    return {
      kind: shareMark.kind,
      text: shareMark.kind === 'span' ? shareMark.quote?.exact ?? '' : shareMark.snapshot.text,
      ...(shareMark.kind === 'span' ? { color: shareMark.color ?? 'yellow' } : {}),
      ...(shareMark.kind === 'span' && shareMark.quote ? { answer: { markdown: shareMark.snapshot.text, quote: shareMark.quote } } : {}),
      ...(shareMark.note ? { note: shareMark.note } : {}),
      title: shareMark.snapshot.sessionTitle || t`未命名会话`,
      ...(shareMark.backendId ? { backendId: shareMark.backendId } : {}),
      projectName: projectName(shareMark.projectId),
      at: shareMark.snapshot.at,
      turn: () => api.markPrompt(shareMark.id).then((result) => {
        const model = shareModelName(result.model);
        return { ...(result.text ? { prompt: result.text } : {}), ...(model ? { model } : {}) };
      }),
    };
  }, [shareMark, projectName, t]);

  useLayoutEffect(() => {
    if (!current || !restore.current) return;
    scrollRef.current?.scrollTo({ top: restore.current });
    restore.current = 0;
  }, [current]);

  const liveProjects = useMemo(
    () => projects.filter((item) => !item.archivedAt && item.system !== 'quick-chat'),
    [projects],
  );

  const visibleProjects = useMemo(() => {
    const ids = new Set(facets ? facets.projectIds : (loaded?.marks ?? []).map((mark) => mark.projectId));
    return liveProjects.filter((item) => ids.has(item.id) || item.id === projectId);
  }, [facets, loaded?.marks, liveProjects, projectId]);

  const visibleBackends = useMemo(() => {
    const ids = new Set(facets ? facets.backendIds : (loaded?.marks ?? []).map((mark) => mark.backendId).filter((id): id is NativeBackendId => Boolean(id)));
    return backends.filter((item) => ids.has(item.backendId) || item.backendId === backendId);
  }, [facets, loaded?.marks, backends, backendId]);

  const navProps = {
    tab,
    projectId,
    backendId,
    projects: visibleProjects,
    backends: visibleBackends,
    onTab: setTab,
    onProject: setProjectId,
    onBackend: setBackendId,
  };

  const tabLabels: Record<MarkTab, string> = {
    all: t`全部收藏`,
    message: t({ message: '回复', context: 'marks-replies-tab' }),
    span: t({ message: '高亮', context: 'marks-highlights-tab' }),
    image: t({ message: '图片', context: 'marks-images-tab' }),
    file: t({ message: '文件', context: 'marks-files-tab' }),
    orphaned: t`找不到原文`,
  };
  const scopeTitle = [
    projectId ? projectName(projectId) : undefined,
    tabLabels[tab],
    backendId ? labelOf(backendId) : undefined,
  ].filter(Boolean).join(' · ');

  const toggleChoice = (id: string) => setChosen((set) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const clearFilters = () => {
    setText('');
    setQ('');
    setProjectId('');
    setBackendId('');
    setTab('all');
  };

  return (
    <PageScaffold
      title={<Trans>收藏夹</Trans>}
      meta={<MarksScopeMenu {...navProps} />}
      actions={selecting ? (
        <>
          <Button
            size="sm"
            variant="danger-ghost"
            className="max-md:size-11 max-md:px-0"
            aria-label={chosen.size ? t`删除 ${chosen.size} 条收藏` : t`删除收藏`}
            disabled={!chosen.size}
            onClick={() => void removeChosen()}
          >
            <IconTrash2 />
            <span className="max-md:hidden">
              {chosen.size ? t`删除 ${chosen.size} 条` : t({ message: '删除', context: 'marks-delete-action' })}
            </span>
          </Button>
          <Button size="sm" variant="quiet" onClick={() => { setSelecting(false); setChosen(new Set()); }}>
            <Trans context="marks-done-action">完成</Trans>
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant="quiet"
          className="max-md:size-11 max-md:px-0"
          aria-label={t`选择收藏`}
          disabled={!shown?.length}
          onClick={() => setSelecting(true)}
        >
          <IconSquareCheck />
          <span className="max-md:hidden"><Trans>选择</Trans></span>
        </Button>
      )}
      column="board"
      columnClassName="flex flex-col gap-5"
      aside={<MarksAside {...navProps} />}
      scrollRef={scrollRef}
      onScroll={(event) => { view.current = { ...view.current, scrollTop: event.currentTarget.scrollTop }; }}
      scrollerProps={{ 'aria-busy': stale && !error }}
      sidebarCollapsed={sidebarCollapsed}
      onClose={onClose}
      onOpenSidebar={onOpenSidebar}
      onExpandSidebar={onExpandSidebar}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="truncate text-base font-medium text-fg">{scopeTitle}</h2>
          {current && !stale && (
            <span className="shrink-0 text-xs tabular-nums text-fg-4">
              <Trans>{total} 条</Trans>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 max-md:w-full">
          <SearchField
            size="md"
            value={text}
            onChange={setText}
            placeholder={t`搜索收藏的内容、备注或会话`}
            aria-label={t`搜索收藏`}
            className="w-60 max-md:min-w-0 max-md:flex-1"
          />
          <Segmented<MarkViewMode>
            size="sm"
            ariaLabel={t`视图方式`}
            value={viewMode}
            onChange={setViewMode}
            options={[
              { value: 'grid', label: t({ message: '网格', context: 'marks-view-mode' }) },
              { value: 'list', label: t({ message: '清单', context: 'marks-view-mode' }) },
            ]}
          />
        </div>
      </div>

      {waiting && <div className="flex justify-center py-24"><Spinner className="size-5" /></div>}

      {!current && error && (
        <EmptyState className="py-16" icon={<IconCircleAlert />} title={t`无法加载收藏`} description={error}>
          <Button size="sm" onClick={() => store.set((state) => ({ revision: state.revision + 1 }))}>
            <IconRefreshCw />
            <Trans>重试</Trans>
          </Button>
        </EmptyState>
      )}

      {shown && !shown.length && !stale && (filtered ? (
        <EmptyState className="py-24" icon={<IconSearch />} title={t`没有符合条件的收藏`}>
          <Button size="sm" variant="secondary" onClick={clearFilters}><Trans>清空筛选</Trans></Button>
        </EmptyState>
      ) : (
        <EmptyState
          className="py-24"
          icon={<IconBookmark />}
          title={t`还没有收藏`}
          description={t`在回复菜单里收藏，或选中文字高亮。收藏会保留原文和图片。`}
        />
      ))}

      {shown && shown.length > 0 && (viewMode === 'grid' ? (
        <TileGrid>
          {shown.map((mark) => (
            <MarkTile
              key={mark.id}
              mark={mark}
              query={q}
              projectName={projectName(mark.projectId)}
              backendLabel={mark.backendId ? labelOf(mark.backendId) : undefined}
              selecting={selecting}
              chosen={chosen.has(mark.id)}
              onActivate={() => selecting ? toggleChoice(mark.id) : setActiveId(mark.id)}
              onOpenSession={() => onOpenMark(mark.id)}
              onOpenFile={() => onOpenMarkFile(mark)}
            />
          ))}
        </TileGrid>
      ) : (
        <ul className="flex flex-col overflow-hidden rounded-xl border border-line bg-elevated [&>*+*]:edge-t">
          {shown.map((mark) => (
            <MarkListRow
              key={mark.id}
              mark={mark}
              query={q}
              projectName={projectName(mark.projectId)}
              backendLabel={mark.backendId ? labelOf(mark.backendId) : undefined}
              selecting={selecting}
              chosen={chosen.has(mark.id)}
              onActivate={() => selecting ? toggleChoice(mark.id) : setActiveId(mark.id)}
              onOpenSession={() => onOpenMark(mark.id)}
              onOpenFile={() => onOpenMarkFile(mark)}
            />
          ))}
        </ul>
      ))}

      {current?.nextCursor && !stale && (
        <div ref={sentinelRef} className="flex justify-center py-6">
          {loadingMore && <Spinner className="size-4" />}
        </div>
      )}

      <MarkDetailDialog
        mark={activeMark}
        projectName={activeMark ? projectName(activeMark.projectId) : ''}
        locating={locating}
        onOpenChange={(open) => { if (!open) setActiveId(undefined); }}
        onOpen={() => { if (activeMark) onOpenMark(activeMark.id); }}
        onOpenFile={() => { if (activeMark) onOpenMarkFile(activeMark); }}
        onShare={() => { if (activeMark) { setActiveId(undefined); setShareMark(activeMark); } }}
        onLocate={() => { if (activeMark) void locateMark(activeMark); }}
        onNote={(note) => { if (activeMark) void saveNote(activeMark, note); }}
        onColor={(color) => { if (activeMark) void saveColor(activeMark, color); }}
        onDelete={() => { if (activeMark) void removeOne(activeMark); }}
      />

      {shareSource && (
        <ShareImageDialog
          source={shareSource}
          open={Boolean(shareSource)}
          onOpenChange={(open) => { if (!open) setShareMark(undefined); }}
        />
      )}
    </PageScaffold>
  );
}
