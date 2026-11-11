import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { FileEntry } from '@contracts';
import { IconChevronRight } from '@/components/icons';
import { Spinner } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { cn, errorMessage } from '@/lib/utils';

const PAGE = 100;
/** How deep a chain of single-folder directories is opened at once (`com/example/app`). */
const MAX_CHAIN = 24;
const INDENT = 10;

interface Listing { entries: FileEntry[]; hasMore: boolean }
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const ancestors = (path: string) => path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));

/**
 * A project's folders as an IDE's explorer tree, read a folder at a time as it opens. A folder
 * whose only entry is another folder shows as one row (`src/main/java/com/example`), as VS Code's
 * compact folders and Studio's package view do, so deep package paths don't eat the width.
 */
export function FileTree({ projectId, active, reveal, refreshToken, icon, actions, onOpen, onContextMenu, onError }: {
  projectId: string;
  /** The open file, marked in the tree. */
  active?: string | undefined;
  /** A file or folder to open the tree down to and scroll to, a folder opened too with `expand`; `token` repeats a request. */
  reveal?: { path: string; token: number; expand?: boolean } | undefined;
  refreshToken: number;
  icon: (entry: FileEntry) => ReactNode;
  actions: (entry: FileEntry, path: string) => ReactNode;
  onOpen: (path: string) => void;
  onContextMenu: (path: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const [listings, setListings] = useState<ReadonlyMap<string, Listing>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(['']));
  const known = useRef(new Map<string, Listing>());
  const pending = useRef(new Map<string, Promise<Listing | undefined>>());
  const generation = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const [scrollTo, setScrollTo] = useState<string>();
  const fail = useRef(onError);
  fail.current = onError;

  const store = (dir: string, listing: Listing) => {
    known.current.set(dir, listing);
    setListings(new Map(known.current));
  };

  const load = useCallback((dir: string): Promise<Listing | undefined> => {
    const cached = known.current.get(dir);
    if (cached) return Promise.resolve(cached);
    let request = pending.current.get(dir);
    if (!request) {
      const at = generation.current;
      const loading: Promise<Listing | undefined> = api.files(projectId, dir, PAGE, 0).then((entries) => {
        if (at !== generation.current) return undefined;
        const listing = { entries, hasMore: entries.length === PAGE };
        store(dir, listing);
        return listing;
      }).catch((error) => {
        if (at !== generation.current) return undefined;
        fail.current(errorMessage(error, t`无法读取目录`));
        // A folder that cannot be read shows empty rather than loading forever; a refresh reads it again.
        store(dir, { entries: [], hasMore: false });
        return undefined;
      }).finally(() => { if (pending.current.get(dir) === loading) pending.current.delete(dir); });
      request = loading;
      pending.current.set(dir, request);
    }
    return request;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` only words the error.
  }, [projectId]);

  /** Opens `dir`, and the folders below it while each holds only one folder. */
  const open = useCallback(async (dir: string) => {
    const opened: string[] = [];
    let current = dir;
    for (let depth = 0; depth < MAX_CHAIN; depth++) {
      opened.push(current);
      const listing = await load(current);
      const only = listing && !listing.hasMore && listing.entries.length === 1 ? listing.entries[0] : undefined;
      if (only?.kind !== 'directory') break;
      current = join(current, only.name);
    }
    setExpanded((previous) => new Set([...previous, ...opened]));
  }, [load]);

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const listedProject = useRef(projectId);
  useEffect(() => {
    generation.current += 1;
    known.current.clear(); pending.current.clear();
    setListings(new Map());
    // A refresh keeps what was open; another project starts closed.
    const keep = listedProject.current === projectId ? expandedRef.current : new Set(['']);
    listedProject.current = projectId;
    if (keep !== expandedRef.current) setExpanded(keep);
    void Promise.all([...keep].map((dir) => load(dir)));
  }, [projectId, refreshToken, load]);

  useEffect(() => {
    if (!reveal) return;
    let current = true;
    void (async () => {
      const dirs = ancestors(reveal.path);
      for (const dir of ['', ...dirs]) await load(dir);
      if (!current) return;
      setExpanded((previous) => new Set([...previous, '', ...dirs]));
      if (reveal.expand) await open(reveal.path);
      if (!current) return;
      setScrollTo(reveal.path);
    })();
    return () => { current = false; };
  }, [reveal?.path, reveal?.token, load, open]);

  useLayoutEffect(() => {
    if (!scrollTo || !list.current) return;
    const row = [...list.current.querySelectorAll<HTMLElement>('[data-path]')].find((element) => element.dataset.path === scrollTo);
    if (!row) return;
    // Into the middle, with the folders that lead to it above, and sideways to a deep row's name.
    (row.querySelector('.whitespace-nowrap') ?? row).scrollIntoView({ block: 'center', inline: 'nearest' });
    setScrollTo(undefined);
  }, [scrollTo, listings, expanded]);

  const loadMore = (dir: string) => {
    const listing = known.current.get(dir);
    if (!listing) return;
    void api.files(projectId, dir, PAGE, listing.entries.length).then((next) => {
      const names = new Set(listing.entries.map((entry) => entry.name));
      store(dir, { entries: [...listing.entries, ...next.filter((entry) => !names.has(entry.name))], hasMore: next.length === PAGE });
    }).catch((error) => onError(errorMessage(error, t`无法加载更多`)));
  };

  const rows: ReactNode[] = [];
  const walk = (dir: string, depth: number) => {
    const listing = listings.get(dir);
    const indent = { paddingLeft: 6 + depth * INDENT };
    if (!listing) { rows.push(<div key={`${dir}\0loading`} style={indent} className="flex h-6 items-center pl-6"><Spinner className="size-3" /></div>); return; }
    for (const entry of listing.entries) {
      const path = join(dir, entry.name);
      if (entry.kind === 'directory') {
        // The chain of single-folder folders below this one that are open, drawn as one row.
        const label = [entry.name];
        let deepest = path;
        for (let next = listings.get(deepest); expanded.has(deepest) && next && !next.hasMore && next.entries.length === 1 && next.entries[0]!.kind === 'directory'; next = listings.get(deepest)) {
          deepest = join(deepest, next.entries[0]!.name);
          label.push(next.entries[0]!.name);
        }
        const isOpen = expanded.has(path);
        rows.push(
          <div key={path} data-path={path} onContextMenu={(event) => { event.preventDefault(); onContextMenu(path); }} className="group/file flex h-6 items-center gap-1 rounded pr-1 hover:bg-hover" style={indent}>
            <button type="button" aria-expanded={isOpen} onClick={() => { if (isOpen) setExpanded((previous) => { const next = new Set(previous); next.delete(path); return next; }); else void open(path); }} className="flex h-full flex-1 items-center gap-1 text-left text-sm text-fg">
              <IconChevronRight className={cn('size-3.5 shrink-0 text-fg-4 transition-transform', isOpen && 'rotate-90')} />
              {icon(entry)}
              <span className="whitespace-nowrap">{label.join('/')}</span>
            </button>
            {/* Room for the actions only while they show, so deep rows keep their names. */}
            <span className="hidden shrink-0 items-center group-hover/file:flex group-focus-within/file:flex has-[[data-state=open]]:flex">{actions(entry, path)}</span>
          </div>,
        );
        if (isOpen) walk(deepest, depth + 1);
      } else {
        rows.push(
          <div key={path} data-path={path} onContextMenu={(event) => { event.preventDefault(); onContextMenu(path); }} className={cn('group/file flex h-6 items-center gap-1 rounded pr-1 hover:bg-hover', active === path && 'bg-active hover:bg-active')} style={indent}>
            <button type="button" onClick={() => onOpen(path)} className="flex h-full flex-1 items-center gap-1 pl-[18px] text-left text-sm text-fg">
              {icon(entry)}
              <span className="whitespace-nowrap">{entry.name}</span>
            </button>
            {/* Room for the actions only while they show, so deep rows keep their names. */}
            <span className="hidden shrink-0 items-center group-hover/file:flex group-focus-within/file:flex has-[[data-state=open]]:flex">{actions(entry, path)}</span>
          </div>,
        );
      }
    }
    if (listing.hasMore) rows.push(<button key={`${dir}\0more`} type="button" style={{ paddingLeft: 24 + depth * INDENT }} onClick={() => loadMore(dir)} className="flex h-6 w-full items-center text-xs text-fg-3 hover:text-fg"><Trans>加载更多</Trans></button>);
  };
  walk('', 0);

  // Rows are as wide as the longest name, and the tree scrolls sideways to it, as Studio's project
  // view does: deep package paths keep whole names instead of cutting each one short.
  return (
    <div ref={list} role="tree" aria-label={t`文件`} className="min-h-0 flex-1 overflow-auto px-1.5 py-1">
      <div className="w-max min-w-full">{rows}</div>
    </div>
  );
}
