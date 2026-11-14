import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { API, type Mark, type MarkListQuery } from '@contracts';
import { IconBookmark, IconCheck, IconCircleAlert, IconCopy, IconFileText, IconImage, IconImageDown, IconPencilLine, IconRefreshCw, IconSearch, IconSquareCheck, IconTrash2, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Input, Select, Spinner, Textarea, UnderlineTabs } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { api, type ProjectRecord } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { copyWithToast } from '@/lib/files';
import { formatDate } from '@/lib/i18n/format';
import { useLocale } from '@/lib/i18n';
import { dismissToast, toast, useToasts, type ToastAction } from '@/lib/toast';
import { cn, errorMessage, formatDateTime, newId, readSession, timeAgo, writeSession } from '@/lib/utils';
import { ImageViewer } from '../session/ImageViewer';
import { Markdown } from '../session/Markdown';
import { markSwatch } from '../session/marks';
import { useMarks, useStores } from '../state/stores';
import { WAIT_GRACE_MS, useLingering } from '../session/sessionLayout';
import { ShareImageDialog, type ShareSource } from './ShareImage';
import { isComposingKey } from '../session/composerKeyboard';
import { PageScaffold } from '../PageScaffold';

const PAGE = 30;
/** The server's largest page; a re-read of a longer list starts over from its first this many. */
const MAX_PAGE = 200;
const SEARCH_DEBOUNCE_MS = 250;

/** One row of the filter: a kind of mark, or only those whose message can no longer be found. */
type Tab = 'all' | 'message' | 'span' | 'asset' | 'orphaned';
interface Loaded { key: string; marks: Mark[]; nextCursor?: string; total: number }

/** The filters and scroll position, kept for this tab so coming back finds the list as it was left. */
const VIEW_KEY = 'riffet.marks.view';
const TABS: readonly Tab[] = ['all', 'message', 'span', 'asset', 'orphaned'];
interface View { text: string; projectId: string; tab: Tab; scrollTop: number }
function readView(): View {
  const value = readSession(VIEW_KEY) as Partial<View> | null | undefined;
  return {
    text: typeof value?.text === 'string' ? value.text : '',
    projectId: typeof value?.projectId === 'string' ? value.projectId : '',
    tab: TABS.includes(value?.tab as Tab) ? value!.tab! : 'all',
    scrollTop: typeof value?.scrollTop === 'number' ? value.scrollTop : 0,
  };
}

/** How much of a saved answer a card renders before it fades out. */
const EXCERPT_CHARS = 1200;
const quoteClass = { yellow: 'mark-quote-yellow', green: 'mark-quote-green', blue: 'mark-quote-blue', red: 'mark-quote-red' } as const;

/**
 * The start of a saved answer, cut at a paragraph so the Markdown still parses as written; a code
 * fence the cut leaves open is closed. `cut` says whether there was more.
 */
function markdownExcerpt(text: string): { source: string; cut: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= EXCERPT_CHARS) return { source: trimmed, cut: false };
  const head = trimmed.slice(0, EXCERPT_CHARS);
  const paragraph = head.lastIndexOf('\n\n');
  let source = head.slice(0, paragraph > EXCERPT_CHARS / 3 ? paragraph : Math.max(head.lastIndexOf('\n'), EXCERPT_CHARS / 2));
  if ((source.match(/^\s*```/gm)?.length ?? 0) % 2 === 1) source += '\n```';
  return { source, cut: true };
}

/** 今天, 昨天, or the date: what the list is grouped under. */
function dayLabel(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return i18n._(msg`更早`);
  const today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / 86_400_000);
  if (days === 0) return i18n._(msg`今天`);
  if (days === 1) return i18n._(msg`昨天`);
  const date = formatDate(at, { month: 'long', day: 'numeric', weekday: days < 7 ? 'long' : undefined, ...(at.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
  return date;
}

/** Whether the element [ref] is attached to is clipped: its content is taller than its box. */
function useOverflow<T extends HTMLElement>() {
  const [element, ref] = useState<T | null>(null);
  const [value, setValue] = useState(false);
  useEffect(() => {
    if (!element) return;
    const check = () => setValue(element.scrollHeight > element.clientHeight + 1);
    const observer = new ResizeObserver(check);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    check();
    return () => observer.disconnect();
  }, [element]);
  return { ref, value };
}

/** A note being written in place. Saved on blur or ⌘↵; Escape keeps the old one. */
function NoteEditor({ mark, onSave, onDone }: { mark: Mark; onSave: (note: string | null) => void; onDone: () => void }) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(mark.note ?? '');
  const save = () => { const next = draft.trim(); onDone(); if (next !== (mark.note ?? '')) onSave(next || null); };
  return (
    <Textarea
      autoFocus
      value={draft}
      rows={2}
      placeholder={t`写点什么，方便以后找到它…`}
      aria-label={t`备注`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={save}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (isComposingKey(event.nativeEvent)) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDone(); }
        else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(); }
      }}
      className="min-h-16 resize-none rounded-lg bg-subtle py-2 text-sm leading-6"
    />
  );
}

/**
 * One saved reply as a card: where it came from, the words themselves (a highlight in its own
 * colour, an answer as rendered Markdown that fades out), and the note. Its actions take the
 * timestamp's place on hover, so nothing moves under the pointer.
 */
/** A saved picture: the server's copy, which opens in the lightbox; the card around it leads back to where it was shown. */
function SavedImage({ mark }: { mark: Mark }) {
  const { t } = useLingui();
  const src = `${API.marks}/${encodeURIComponent(mark.id)}/asset`;
  const name = mark.asset?.name ?? t({ message: '图片', context: 'marks-image-name' });
  return (
    <div className="flex flex-col gap-1.5" onClick={(event) => event.stopPropagation()}>
      <ImageViewer src={src} name={name}>
        <button type="button" aria-label={t`查看大图`} className="block w-fit max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-line bg-subtle">
          <img src={src} alt={name} loading="lazy" className="max-h-72 max-w-full object-contain" />
        </button>
      </ImageViewer>
      {mark.asset?.path && <span className="truncate text-xs text-fg-4" title={mark.asset.path}>{mark.asset.path}</span>}
    </div>
  );
}

/** A saved file: what it is, where it lives, and what the agent did to it. */
function SavedFile({ mark }: { mark: Mark }) {
  const asset = mark.asset;
  const directory = asset?.path?.slice(0, Math.max(0, asset.path.length - asset.name.length)).replace(/\/$/, '');
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg bg-subtle px-3 py-2.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-elevated text-fg-3"><IconFileText className="size-4" /></span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-sm text-fg">{asset?.name}</span>
        {directory && <span className="truncate text-xs text-fg-4" title={asset?.path}>{directory}</span>}
      </span>
      {asset?.detail && (
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums text-fg-4">
          {asset.detail.split(' ').map((part) => <span key={part} className={part.startsWith('+') ? 'text-success' : part.startsWith('−') ? 'text-danger' : undefined}>{part}</span>)}
        </span>
      )}
    </div>
  );
}

function MarkCard({ mark, projectName, selecting, chosen, onChoose, onOpen, onOpenFile, onNote, onDelete }: {
  mark: Mark; projectName: string; selecting: boolean; chosen: boolean;
  onChoose: (chosen: boolean) => void; onOpen: () => void; onOpenFile: () => void; onNote: (note: string | null) => void; onDelete: () => void;
}) {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const color = mark.color ?? 'yellow';
  const orphaned = mark.state === 'orphaned';
  const span = mark.kind === 'span';
  const share = useMemo<ShareSource | undefined>(() => mark.kind === 'message' || mark.kind === 'span' ? {
    kind: mark.kind,
    text: mark.kind === 'span' ? mark.quote?.exact ?? '' : mark.snapshot.text,
    ...(mark.kind === 'span' ? { color: mark.color ?? 'yellow' } : {}),
    ...(mark.note ? { note: mark.note } : {}),
    title: mark.snapshot.sessionTitle || t`未命名会话`,
    ...(mark.backendId ? { backendId: mark.backendId } : {}),
    projectName,
    at: mark.snapshot.at,
    ...(mark.kind === 'message' ? { prompt: () => api.markPrompt(mark.id).then((result) => result.text) } : {}),
  } : undefined, [mark, projectName, t]);
  const excerpt = useMemo(() => mark.kind === 'message' ? markdownExcerpt(mark.snapshot.text) : undefined, [mark.kind, mark.snapshot.text]);
  const overflows = useOverflow<HTMLDivElement>();
  const activate = () => { if (selecting) onChoose(!chosen); else onOpen(); };
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    <li>
      <article
        role="button"
        tabIndex={0}
        aria-label={selecting ? t`选择这条收藏` : t`打开原会话`}
        aria-pressed={selecting ? chosen : undefined}
        onClick={activate}
        onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); activate(); } }}
        className={cn(
          'group relative flex cursor-pointer flex-col gap-3 rounded-xl border bg-elevated px-5 py-4 outline-none transition-[border-color,box-shadow] duration-150 ease-out max-md:px-4',
          'hover:border-line-strong hover:shadow-soft focus-visible:ring-2 focus-visible:ring-accent/40',
          chosen ? 'border-accent ring-1 ring-accent' : 'border-line',
        )}
      >
        <header className="flex h-6 min-w-0 items-center gap-2 text-xs">
          {selecting && (
            <span aria-hidden className={cn('grid size-4 shrink-0 place-items-center rounded-full border transition-colors', chosen ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong')}>
              {chosen && <IconCheck className="size-3" />}
            </span>
          )}
          {span ? <span aria-hidden className={cn('size-2 shrink-0 rounded-full', markSwatch[color])} />
            : mark.kind === 'image' ? <IconImage aria-hidden className="size-3.5 shrink-0 text-fg-3" />
            : mark.kind === 'file' ? <IconFileText aria-hidden className="size-3.5 shrink-0 text-fg-3" />
            : <IconBookmark aria-hidden className="size-3.5 shrink-0 text-fg-3" />}
          <span className="min-w-0 truncate font-medium text-fg-2">{mark.snapshot.sessionTitle || t`未命名会话`}</span>
          <span className="shrink-0 truncate text-fg-4 max-sm:hidden">{projectName}</span>
          {orphaned && <Badge tone="warning" className="shrink-0"><Trans>原文已找不到</Trans></Badge>}
          <span className="relative ml-auto flex h-6 shrink-0 items-center justify-end">
            <time dateTime={mark.createdAt} title={formatDateTime(mark.createdAt)} className={cn('tabular-nums text-fg-4 transition-opacity duration-150', !selecting && 'group-hover:opacity-0 group-focus-within:opacity-0')}>{timeAgo(mark.createdAt)}</time>
            {!selecting && (
              <span className="absolute right-0 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100" onClick={stop}>
                <Tip label={mark.note ? t`编辑备注` : t`添加备注`}><Button size="icon-sm" variant="quiet" className="size-6" aria-label={mark.note ? t`编辑备注` : t`添加备注`} onClick={() => setEditing(true)}><IconPencilLine className="size-3.5" /></Button></Tip>
                {mark.kind === 'file' && mark.asset?.path && <Tip label={t`打开文件`}><Button size="icon-sm" variant="quiet" className="size-6" aria-label={t`打开文件`} onClick={onOpenFile}><IconFileText className="size-3.5" /></Button></Tip>}
                {share && <Tip label={t`导出图片`}><Button size="icon-sm" variant="quiet" className="size-6" aria-label={t`导出图片`} onClick={() => setSharing(true)}><IconImageDown className="size-3.5" /></Button></Tip>}
                {mark.kind !== 'image' && <Tip label={mark.kind === 'file' ? t`复制路径` : t`复制内容`}><Button size="icon-sm" variant="quiet" className="size-6" aria-label={mark.kind === 'file' ? t`复制路径` : t`复制内容`} onClick={() => void copyWithToast(mark.quote?.exact ?? mark.asset?.path ?? mark.snapshot.text)}><IconCopy className="size-3.5" /></Button></Tip>}
                <Tip label={t({ message: '删除', context: 'marks-delete-action' })}><Button size="icon-sm" variant="quiet" className="size-6 hover:text-danger" aria-label={t`删除收藏`} onClick={onDelete}><IconTrash2 className="size-3.5" /></Button></Tip>
              </span>
            )}
          </span>
        </header>

        {mark.kind === 'image' ? <SavedImage mark={mark} />
        : mark.kind === 'file' ? <SavedFile mark={mark} />
        : span ? (
          <p className={cn('line-clamp-6 text-(length:--text-h3) leading-7 text-fg', orphaned && 'text-fg-2')}>
            <span className={cn('rounded-xs px-0.5 py-px box-decoration-clone', quoteClass[color])}>{mark.quote?.exact.trim()}</span>
          </p>
        ) : (
          <div ref={overflows.ref} className={cn('relative max-h-60 overflow-hidden', (excerpt?.cut || overflows.value) && 'mark-fade', orphaned && 'opacity-80')}>
            <Markdown text={excerpt?.source ?? ''} className="mark-preview pointer-events-none select-none" />
          </div>
        )}

        {editing
          ? <NoteEditor mark={mark} onSave={onNote} onDone={() => setEditing(false)} />
          : mark.note && (
            <button type="button" onClick={(event) => { stop(event); if (!selecting) setEditing(true); }} className="flex w-full items-start gap-2 rounded-lg bg-subtle px-3 py-2 text-left text-sm leading-6 text-fg-2 transition-colors hover:bg-hover" title={t`编辑备注`}>
              <IconPencilLine aria-hidden className="mt-1 size-3.5 shrink-0 text-fg-4" />
              <span className="min-w-0 whitespace-pre-wrap break-words">{mark.note}</span>
            </button>
          )}
      </article>
      {/* Beside the card, not in it: the dialog's clicks would bubble to the card and open the conversation. */}
      {share && <ShareImageDialog source={share} open={sharing} onOpenChange={setSharing} />}
    </li>
  );
}

/**
 * 收藏: every saved reply and highlight across conversations, newest first. The server filters and
 * pages; the list re-reads (conditionally) whenever a mark changes anywhere, here or pushed.
 */
export function MarksPage({ projects, sidebarCollapsed, onClose, onOpenSidebar, onExpandSidebar, onOpenMark, onOpenMarkFile }: {
  projects: ProjectRecord[];
  sidebarCollapsed: boolean;
  onClose: () => void;
  onOpenSidebar: () => void;
  onExpandSidebar: () => void;
  onOpenMark: (id: string) => void;
  /** Opens a saved file's conversation with the file in its preview. */
  onOpenMarkFile: (mark: Mark) => void;
}) {
  const { t } = useLingui();
  // `dayLabel` reads the active catalog directly, so the groups must rebuild on a switch.
  const locale = useLocale();
  const { marks: store } = useStores();
  const revision = useMarks((state) => state.revision);
  const [saved] = useState(readView);
  const [text, setText] = useState(saved.text);
  const [q, setQ] = useState(() => saved.text.trim());
  const [projectId, setProjectId] = useState(() => projects.some((item) => item.id === saved.projectId && !item.archivedAt) ? saved.projectId : '');
  const [tab, setTab] = useState<Tab>(saved.tab);
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  /** The query, page size and ETag the list on screen was read with. */
  const held = useRef<{ key: string; limit: number; etag?: string }>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const view = useRef(saved);
  const restore = useRef(saved.scrollTop);
  useEffect(() => { view.current = { ...view.current, text, projectId, tab }; writeSession(VIEW_KEY, view.current); }, [text, projectId, tab]);
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
    ...(projectId ? { projectId } : {}), ...(tab === 'message' || tab === 'span' ? { kind: tab } : tab === 'asset' ? { kind: ['image' as const, 'file' as const] } : {}), ...(tab === 'orphaned' ? { state: 'orphaned' as const } : {}), ...(q ? { q } : {}),
  }), [projectId, tab, q]);
  const key = JSON.stringify(query);
  /** The last list stays up while a new query loads, rather than swapping for a spinner on every filter. */
  const stale = loaded?.key !== key;
  const current = stale && error ? undefined : loaded;

  // A new query starts from its first page; a change to the marks re-reads as many as are shown.
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
    }).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason, t`无法加载收藏`)); });
    return () => controller.abort();
    // `key` stands for `query`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, revision]);

  const loadMore = useCallback(async () => {
    const shown = loadedRef.current;
    if (!shown?.nextCursor || shown.key !== key || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await api.marks({ ...query, limit: PAGE, cursor: shown.nextCursor });
      if (result.unchanged || loadedRef.current !== shown) return;
      const seen = new Set(shown.marks.map((mark) => mark.id));
      const marks = [...shown.marks, ...result.data.marks.filter((mark) => !seen.has(mark.id))];
      // The held ETag was for the shorter list; the next re-read fetches the longer one in full.
      held.current = { key, limit: marks.length };
      setLoaded({ key, marks, total: result.data.total, ...(result.data.nextCursor ? { nextCursor: result.data.nextCursor } : {}) });
    } catch (reason) { toast.error(errorMessage(reason, t`无法加载更多收藏`)); }
    finally { setLoadingMore(false); }
  }, [key, query, loadingMore, t]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !current?.nextCursor) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void loadMore(); }, { root: scrollRef.current, rootMargin: '400px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [current?.nextCursor, loadMore]);

  const projectName = useCallback((id: string) => projects.find((item) => item.id === id)?.name ?? t`已移除的项目`, [projects, t]);
  const patchShown = (update: (marks: Mark[]) => Mark[]) => setLoaded((shown) => {
    if (!shown) return shown;
    const marks = update(shown.marks);
    return { ...shown, marks, total: shown.total - (shown.marks.length - marks.length) };
  });

  const saveNote = async (mark: Mark, note: string | null) => {
    const updated = await store.update(mark.id, { note });
    if (updated) setLoaded((shown) => shown && { ...shown, marks: shown.marks.map((item) => item.id === updated.id ? updated : item) });
  };
  /**
   * Image marks whose 撤销 is still on screen: only hidden, since deleting one deletes the server's
   * copy of the picture and nothing could re-create it. Each is deleted once its toast goes away.
   */
  const pending = useRef(new Map<string, ToastAction>());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const unhide = (id: string) => setHidden((set) => { const next = new Set(set); next.delete(id); return next; });
  const commit = useCallback((id: string) => {
    if (!pending.current.delete(id)) return;
    // A refused delete puts the card back; a done one is dropped by the next read.
    void store.remove([id]).then((removed) => { if (!removed) unhide(id); });
  }, [store]);
  const toasts = useToasts();
  const toastsRef = useRef(toasts);
  useEffect(() => {
    toastsRef.current = toasts;
    for (const [id, action] of pending.current) if (!toasts.some((item) => item.action === action && !item.leaving)) commit(id);
  }, [toasts, commit]);
  // Unloading runs no effect cleanup, so a reload or a closed tab sends what is waiting on its own.
  // A page kept for Back comes back with those deletes sent, so their 撤销 goes with them.
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
  // Leaving the page takes the 撤销 with it: what is waiting is deleted now.
  useEffect(() => () => {
    for (const [id, action] of pending.current) {
      const item = toastsRef.current.find((entry) => entry.action === action);
      if (item) dismissToast(item.id);
      commit(id);
    }
  }, [commit]);
  /** One mark goes at once, with 撤销 re-creating it from what the list still holds; an image waits for its toast instead. */
  const removeOne = async (mark: Mark) => {
    if (mark.kind === 'image') {
      const action: ToastAction = { label: t`撤销`, onClick: () => { if (pending.current.delete(mark.id)) unhide(mark.id); } };
      pending.current.set(mark.id, action);
      setHidden((set) => new Set(set).add(mark.id));
      toast.success(t`已删除收藏`, { action });
      return;
    }
    patchShown((marks) => marks.filter((item) => item.id !== mark.id));
    if (!await store.remove([mark.id])) return;
    const asset = mark.asset && { name: mark.asset.name, ...(mark.asset.path ? { path: mark.asset.path } : {}), ...(mark.asset.mimeType ? { mimeType: mark.asset.mimeType } : {}), ...(mark.asset.detail ? { detail: mark.asset.detail } : {}) };
    toast.success(t`已删除收藏`, { action: { label: t`撤销`, onClick: () => void store.create({
      id: newId(), sessionId: mark.sessionId, kind: mark.kind, anchor: mark.anchor,
      ...(mark.quote ? { quote: mark.quote } : {}), ...(asset ? { asset } : {}), snapshot: { text: mark.snapshot.text, at: mark.snapshot.at },
      ...(mark.note ? { note: mark.note } : {}), ...(mark.color ? { color: mark.color } : {}),
    }) } });
  };
  const removeChosen = async () => {
    const ids = [...chosen];
    if (!ids.length || !await confirmDialog({ title: t`删除 ${ids.length} 条收藏？`, description: t`删除后无法恢复。`, confirmLabel: t({ message: '删除', context: 'marks-delete-action' }), destructive: true })) return;
    patchShown((marks) => marks.filter((item) => !chosen.has(item.id)));
    setChosen(new Set());
    setSelecting(false);
    if (await store.remove(ids)) toast.success(t`已删除 ${ids.length} 条收藏`);
  };
  const filtered = Boolean(q || projectId || tab !== 'all');
  const shown = useMemo(() => current?.marks.filter((mark) => !hidden.has(mark.id)), [current?.marks, hidden]);
  const waiting = useLingering(stale && !current?.marks.length && !error, WAIT_GRACE_MS);
  const total = current && shown ? current.total - (current.marks.length - shown.length) : 0;
  /** Consecutive marks of one day under one heading; the list is newest first, so a day never splits. */
  const days = useMemo(() => {
    const groups: Array<{ label: string; marks: Mark[] }> = [];
    for (const mark of shown ?? []) {
      const label = dayLabel(mark.createdAt);
      if (groups.at(-1)?.label === label) groups.at(-1)!.marks.push(mark);
      else groups.push({ label, marks: [mark] });
    }
    return groups;
  }, [shown, locale]);
  useLayoutEffect(() => {
    if (!current || !restore.current) return;
    scrollRef.current?.scrollTo({ top: restore.current });
    restore.current = 0;
  }, [current]);
  const liveProjects = projects.filter((item) => !item.archivedAt && item.system !== 'quick-chat');
  return (
    <PageScaffold
      title={<Trans>收藏夹</Trans>}
      actions={selecting ? (
        <>
          <Button size="sm" variant="danger-ghost" className="max-md:size-11 max-md:px-0" aria-label={chosen.size ? t`删除 ${chosen.size} 条收藏` : t`删除收藏`} disabled={!chosen.size} onClick={() => void removeChosen()}><IconTrash2 /><span className="max-md:hidden">{chosen.size ? t`删除 ${chosen.size} 条` : t({ message: '删除', context: 'marks-delete-action' })}</span></Button>
          <Button size="sm" variant="quiet" onClick={() => { setSelecting(false); setChosen(new Set()); }}><Trans context="marks-done-action">完成</Trans></Button>
        </>
      ) : (
        <Button size="sm" variant="quiet" className="max-md:size-11 max-md:px-0" aria-label={t`选择收藏`} disabled={!shown?.length} onClick={() => setSelecting(true)}><IconSquareCheck /><span className="max-md:hidden"><Trans>选择</Trans></span></Button>
      )}
      columnClassName="flex flex-col"
      scrollRef={scrollRef}
      onScroll={(event) => { view.current = { ...view.current, scrollTop: event.currentTarget.scrollTop }; }}
      scrollerProps={{ 'aria-busy': stale && !error }}
      sidebarCollapsed={sidebarCollapsed}
      onClose={onClose}
      onOpenSidebar={onOpenSidebar}
      onExpandSidebar={onExpandSidebar}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-52 flex-1">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-4" />
            <Input value={text} onChange={(event) => setText(event.target.value)} placeholder={t`搜索收藏的内容、备注或会话`} aria-label={t`搜索收藏`} className="h-9 rounded-lg pl-9 pr-8" />
            {text && <button type="button" aria-label={t`清除搜索`} onClick={() => setText('')} className="absolute right-2 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-fg-4 hover:text-fg"><IconX className="size-3.5" /></button>}
          </label>
          <Select label={t`按项目筛选`} value={projectId} onChange={setProjectId} className="h-9 w-40 max-md:w-full"
            options={[{ value: '', label: t`全部项目` }, ...liveProjects.map((item) => ({ value: item.id, label: item.name }))]} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <UnderlineTabs<Tab> className="-ml-2 h-10 overflow-x-auto [scrollbar-width:none] max-md:-ml-3" value={tab} onChange={setTab} ariaLabel={t`筛选收藏`} options={[{ value: 'all', label: t`全部` }, { value: 'message', label: t({ message: '回复', context: 'marks-replies-tab' }) }, { value: 'span', label: t({ message: '高亮', context: 'marks-highlights-tab' }) }, { value: 'asset', label: t`图片与文件` }, { value: 'orphaned', label: t`找不到原文` }]} />
          {current && !stale && <span className="shrink-0 text-xs tabular-nums text-fg-4"><Trans>{total} 条</Trans></span>}
        </div>
      </div>

      {waiting && <div className="flex justify-center py-24"><Spinner className="size-5" /></div>}
      {!current && error && (
        <EmptyState className="py-16" icon={<IconCircleAlert />} title={t`无法加载收藏`} description={error}>
          <Button size="sm" onClick={() => store.set((state) => ({ revision: state.revision + 1 }))}><IconRefreshCw /><Trans>重试</Trans></Button>
        </EmptyState>
      )}
      {shown && !shown.length && !stale && (filtered
        ? <EmptyState className="py-24" icon={<IconSearch />} title={t`没有符合条件的收藏`} />
        : <EmptyState className="py-24" icon={<IconBookmark />} title={t`还没有收藏`} description={t`在回复菜单里收藏，或选中文字高亮。收藏会保留原文和图片。`} />)}
      {days.map((day) => (
        <section key={day.label} className="mt-8 first-of-type:mt-7">
          <h2 className="sticky top-0 z-10 -mx-1 mb-3 bg-bg/90 px-1 py-1.5 text-xs font-medium text-fg-3 backdrop-blur">{day.label}</h2>
          <ul className="flex flex-col gap-3">
            {day.marks.map((mark) => (
              <MarkCard
                key={mark.id}
                mark={mark}
                projectName={projectName(mark.projectId)}
                selecting={selecting}
                chosen={chosen.has(mark.id)}
                onChoose={(next) => setChosen((set) => { const copy = new Set(set); if (next) copy.add(mark.id); else copy.delete(mark.id); return copy; })}
                onOpen={() => onOpenMark(mark.id)}
                onOpenFile={() => onOpenMarkFile(mark)}
                onNote={(note) => void saveNote(mark, note)}
                onDelete={() => void removeOne(mark)}
              />
            ))}
          </ul>
        </section>
      ))}
      {current?.nextCursor && !stale && <div ref={sentinelRef} className="flex justify-center py-6">{loadingMore && <Spinner className="size-4" />}</div>}
    </PageScaffold>
  );
}
