import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconChevronRight, IconFolder, IconFolderOpen, IconHome, IconRefreshCw, IconStar, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tip } from '@/components/ui/tooltip';
import { api, type BrowseResult } from '@/lib/api';
import { cn, errorMessage } from '@/lib/utils';
import { FavoriteMenu, FavoriteStar, favoriteName, useFolderFavorites } from './FolderFavorites';

/** Reads better than an absolute path when the folder lives under the host's home. */
export function displayPath(path: string, home: string): string {
  if (!path) return '';
  if (path === home) return '~';
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

/**
 * In-app directory browser. It is the fallback for hosts whose native folder chooser cannot be
 * driven (or where it fails), and the fallback is why it lives apart from any one caller: both
 * "add project" and "start a session in another directory" need the same browser.
 */
export function DirectoryPicker({ open, onOpenChange, initialPath, onPick, onError }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPath?: string;
  onPick: (path: string) => void;
  onError: (message: string) => void;
}) {
  const [result, setResult] = useState<BrowseResult>();
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const { t } = useLingui();
  const listRef = useRef<HTMLDivElement>(null);
  const favorites = useFolderFavorites(undefined, open);
  // Callers pass an inline handler; reading it through a ref keeps `load` (and the effect that
  // opens on `initialPath`) from re-running, which used to throw the reader back to the start.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  /** Only the latest listing lands: a slow answer for a folder already left must not replace it. */
  const request = useRef(0);

  const load = useCallback(async (target?: string) => {
    const id = ++request.current;
    setLoading(true);
    try {
      const next = await api.browse(target);
      if (id !== request.current) return;
      setResult(next);
      listRef.current?.scrollTo({ top: 0 });
    } catch (error) {
      if (id === request.current) onErrorRef.current(errorMessage(error, t`无法打开这个目录`));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => { if (open) void load(initialPath); }, [open, initialPath, load]);

  const shortcuts: Array<{ label: string; path: string; icon: typeof IconHome }> = result
    ? [
        { label: t`主目录`, path: result.home, icon: IconHome },
        { label: 'workspace', path: `${result.home}/workspace`, icon: IconFolder },
        { label: 'Documents', path: `${result.home}/Documents`, icon: IconFolder },
        { label: 'Desktop', path: `${result.home}/Desktop`, icon: IconFolder },
      ]
    : [];

  const crumbs = result
    ? (() => {
        const parts = result.path === '/' ? [] : result.path.split('/').filter(Boolean);
        const items: Array<{ label: string; path: string }> = [{ label: '/', path: '/' }];
        let cursor = '';
        for (const part of parts) { cursor = `${cursor}/${part}`; items.push({ label: part, path: cursor }); }
        return items;
      })()
    : [];

  const entries = result?.entries.filter((entry) => showHidden || !entry.hidden) ?? [];
  const childPath = (name: string) => `${result!.path === '/' ? '' : result!.path}/${name}`;

  /** The listing says which folders are favorites; keep it in step with what was just changed. */
  const markListed = (matches: (path: string, favoriteId: string | undefined) => boolean, favoriteId?: string) => setResult((current) => {
    if (!current) return current;
    const prefix = current.path === '/' ? '' : current.path;
    const mark = <T extends { favoriteId?: string }>(item: T, path: string): T => matches(path, item.favoriteId) ? { ...item, favoriteId } : item;
    return { ...mark(current, current.path), entries: current.entries.map((entry) => mark(entry, `${prefix}/${entry.name}`)) };
  });
  const removeFavorite = async (id: string) => {
    const removed = await favorites.remove(id);
    if (removed) markListed((_, favoriteId) => favoriteId === id);
    return removed;
  };
  const toggleFavorite = async (path: string, favoriteId: string | undefined) => {
    if (favoriteId) { await removeFavorite(favoriteId); return; }
    const created = await favorites.add(path);
    if (created) markListed((itemPath) => itemPath === path, created.id);
  };
  const favoriteStore = { ...favorites, remove: removeFavorite };
  const favoriteAction = 'grid size-6 shrink-0 place-items-center rounded text-fg-3 opacity-0 transition-opacity hover:bg-active hover:text-fg focus-visible:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-active no-hover:size-10 no-hover:opacity-100';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent mobileFullscreen className="flex max-h-[min(78dvh,600px)] w-[min(720px,94vw)] flex-col overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="edge-b px-5 py-3 pr-14">
          <DialogTitle className="text-base"><Trans>选择目录</Trans></DialogTitle>
          <DialogDescription className="text-xs"><Trans>目录位于运行 Riffet 服务器的电脑上。</Trans></DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 max-md:flex-col">
          <aside className="flex w-40 shrink-0 flex-col gap-0.5 bg-subtle/40 p-2 md:edge-r max-md:w-full max-md:flex-row max-md:overflow-x-auto max-md:edge-b">
            {shortcuts.map((item) => (
              <button key={item.path} type="button" onClick={() => void load(item.path)} className="flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-left text-sm text-fg-2 hover:bg-hover hover:text-fg max-md:h-11 max-md:px-3">
                <item.icon className="size-3.5 shrink-0 text-fg-3" />
                <span className="min-w-0 truncate">{item.label}</span>
              </button>
            ))}
            {favorites.favorites.length > 0 && <div className="mt-2 px-2 pb-1 text-2xs font-medium text-fg-3 max-md:hidden"><Trans>收藏</Trans></div>}
            {favorites.favorites.map((favorite) => (
              <div key={favorite.id} className="group/fav flex h-8 shrink-0 items-center gap-0.5 rounded-md pr-0.5 hover:bg-hover max-md:h-11 max-md:max-w-52">
                <button type="button" disabled={!favorite.exists} title={favorite.path} onClick={() => void load(favorite.path)} className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left text-sm text-fg-2 hover:text-fg disabled:text-fg-4 max-md:px-3">
                  <FavoriteStar className={cn(!favorite.exists && 'text-fg-4')} />
                  <span className="min-w-0 truncate">{favoriteName(favorite)}</span>
                  {!favorite.exists && <span className="shrink-0 text-2xs"><Trans>不存在</Trans></span>}
                </button>
                {favorite.exists
                  ? <FavoriteMenu favorite={favorite} store={favoriteStore} triggerClassName={cn(favoriteAction, 'group-hover/fav:opacity-100')} />
                  : <Tip label={t`移除收藏`}><button type="button" aria-label={t`移除收藏`} onClick={() => void favoriteStore.remove(favorite.id)} className={cn(favoriteAction, 'opacity-100')}><IconX className="size-3.5" /></button></Tip>}
              </div>
            ))}
          </aside>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex h-9 shrink-0 items-center gap-1 edge-b px-3 max-md:h-11 no-hover:h-11">
              <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-none">
                {crumbs.map((crumb, index) => (
                  <span key={crumb.path} className="flex shrink-0 items-center gap-0.5 text-xs">
                    {index > 0 && <IconChevronRight className="size-3 text-fg-4" />}
                    <button type="button" onClick={() => void load(crumb.path)} className={cn('rounded px-1.5 py-0.5 font-mono text-fg-2 hover:bg-hover hover:text-fg max-md:min-h-11 max-md:px-2', index === crumbs.length - 1 && 'text-fg')}>{crumb.label}</button>
                  </span>
                ))}
              </div>
              {result && (
                <Tip label={result.favoriteId ? t`取消收藏此目录` : t`收藏此目录`}>
                  <Button size="icon-xs" variant="quiet" className="max-md:size-10" aria-label={result.favoriteId ? t`取消收藏此目录` : t`收藏此目录`} aria-pressed={Boolean(result.favoriteId)} onClick={() => void toggleFavorite(result.path, result.favoriteId)}>
                    {result.favoriteId ? <FavoriteStar /> : <IconStar />}
                  </Button>
                </Tip>
              )}
              <Tip label={t`刷新`}><Button size="icon-xs" variant="quiet" className="max-md:size-10" aria-label={t`刷新`} onClick={() => void load(result?.path)}>{loading ? <Spinner /> : <IconRefreshCw />}</Button></Tip>
            </div>
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
              {result?.parent && (
                <button type="button" onClick={() => void load(result.parent)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-fg-2 hover:bg-hover hover:text-fg max-md:h-11 max-md:px-3">
                  <IconFolderOpen className="size-3.5 shrink-0 text-fg-3" />
                  <span>..</span>
                </button>
              )}
              {entries.map((entry) => (
                <div key={entry.name} className="group/entry flex h-8 items-center rounded-md pr-1 hover:bg-hover max-md:h-11">
                  <button
                    type="button"
                    onClick={() => void load(childPath(entry.name))}
                    className={cn('flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left text-sm text-fg-2 hover:text-fg max-md:px-3', entry.hidden && 'text-fg-3')}
                  >
                    <IconFolder className="size-3.5 shrink-0 text-fg-3" />
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={entry.favoriteId ? t`取消收藏 ${entry.name}` : t`收藏 ${entry.name}`}
                    aria-pressed={Boolean(entry.favoriteId)}
                    title={entry.favoriteId ? t`取消收藏` : t`收藏`}
                    onClick={() => void toggleFavorite(childPath(entry.name), entry.favoriteId)}
                    className={cn(favoriteAction, 'group-hover/entry:opacity-100', entry.favoriteId && 'opacity-100')}
                  >
                    {entry.favoriteId ? <FavoriteStar /> : <IconStar className="size-3.5" />}
                  </button>
                </div>
              ))}
              {!loading && !entries.length && <div className="px-3 py-6 text-center text-xs text-fg-3"><Trans>空目录</Trans></div>}
            </div>
          </div>
        </div>
        <DialogFooter className="edge-t px-5 py-3 max-md:flex-col max-md:items-stretch max-md:px-4 max-md:pb-3 max-md:pt-3">
          <label className="mr-auto flex items-center gap-2 text-xs text-fg-3 max-md:mr-0 max-md:min-h-11">
            <input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} className="size-3.5 accent-accent" />
            <Trans>显示隐藏文件</Trans>
          </label>
          <span className="mr-auto min-w-0 truncate font-mono text-xs text-fg-3 max-md:mr-0 max-md:w-full" title={result?.path}>{result ? displayPath(result.path, result.home) : ''}</span>
          <div className="flex items-center gap-2 max-md:w-full">
            <Button variant="ghost" className="max-md:h-11 max-md:flex-1" onClick={() => onOpenChange(false)}><Trans context="workbench-cancel-action">取消</Trans></Button>
            <Button variant="primary" className="max-md:h-11 max-md:flex-1" disabled={!result} onClick={() => { if (result) { onPick(result.path); onOpenChange(false); } }}><Trans>使用此目录</Trans></Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
