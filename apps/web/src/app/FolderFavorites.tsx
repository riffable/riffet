import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { FolderFavorite } from '@contracts';
import { IconArrowDown, IconArrowUp, IconEllipsis, IconPencilLine, IconStar, IconStarFilled, IconTrash2 } from '@/components/icons';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { promptDialog } from '@/lib/dialogs';
import { toast } from '@/lib/toast';
import { compareText } from '@/lib/i18n/format';
import { cn, errorMessage } from '@/lib/utils';
import { useStores } from './state/stores';

/** The last list read per scope ('' is the host), so a menu or dialog reopening paints at once. */
const cache = new Map<string, FolderFavorite[]>();
/** A burst of pushes naming a new favorites revision costs one read. */
const PUSH_DEBOUNCE_MS = 250;
/** An older server names no favorites revision, so any push may be one; it is read at most this often. */
const UNVERSIONED_READ_MS = 2_000;

/** What a favorite is shown as: its label, else the folder's own name. */
export function favoriteName(favorite: FolderFavorite): string {
  return favorite.label || favorite.path.split('/').filter(Boolean).pop() || favorite.path;
}

/** Quick picks lead with what was opened most recently; never-used ones keep their manual order. */
export function byRecentUse(favorites: FolderFavorite[]): FolderFavorite[] {
  return [...favorites].sort((a, b) => compareText(b.lastUsedAt ?? '', a.lastUsedAt ?? '') || a.sort - b.sort);
}

export type FolderFavoritesApi = ReturnType<typeof useFolderFavorites>;

/**
 * One scope's folder favorites: the host's (no `projectId`, absolute paths) or a project's files
 * panel (relative paths). Read when it becomes `enabled`, and while it stays so, again whenever the
 * lists stream names a new favorites revision, which is how a favorite made on another device shows
 * up here. A hidden page reads once it is shown again.
 */
export function useFolderFavorites(projectId?: string, enabled = true) {
  const { t } = useLingui();
  const { lists } = useStores();
  const key = projectId ?? '';
  const [state, setState] = useState(() => ({ key, favorites: cache.get(key) ?? [] }));
  const favorites = state.key === key ? state.favorites : cache.get(key) ?? [];

  const apply = useCallback((update: (current: FolderFavorite[]) => FolderFavorite[]) => {
    const next = update(cache.get(key) ?? []);
    cache.set(key, next);
    setState({ key, favorites: next });
  }, [key]);

  useEffect(() => {
    if (!enabled) return;
    let active = true, request = 0, timer: number | undefined, missed = false;
    /** The revision the last push named; every push repeats it, and only a different one is news. */
    let seen: number | undefined;
    const load = () => {
      timer = undefined;
      if (document.visibilityState === 'hidden') { missed = true; return; }
      missed = false;
      const current = ++request;
      // A server without favorites (or a failed read) leaves the list as it was: they are a shortcut.
      // A failed read forgets the revision, so the next push asks again instead of matching it.
      void api.folderFavorites(projectId).then(({ favorites: next }) => {
        if (active && current === request) apply(() => next);
      }).catch(() => { if (current === request) seen = undefined; });
    };
    load();
    const unsubscribe = lists.onChanged(({ favorites }) => {
      if (favorites === undefined) {
        // A reconnect, or an older server: read, but not on every push of a running turn.
        if (timer === undefined) timer = window.setTimeout(load, UNVERSIONED_READ_MS);
        return;
      }
      if (favorites === seen) return;
      seen = favorites;
      window.clearTimeout(timer);
      timer = window.setTimeout(load, PUSH_DEBOUNCE_MS);
    });
    const onVisibility = () => { if (missed && document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { active = false; window.clearTimeout(timer); unsubscribe(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [enabled, projectId, lists, apply]);

  const add = useCallback(async (path: string) => {
    try {
      const created = await api.createFolderFavorite({ path, ...(projectId ? { projectId } : {}) });
      apply((current) => current.some((item) => item.id === created.id) ? current.map((item) => item.id === created.id ? created : item) : [...current, created]);
      return created;
    } catch (error) { toast.error(errorMessage(error, t`无法收藏该目录`)); return undefined; }
  }, [projectId, apply, t]);

  const remove = useCallback(async (id: string) => {
    try {
      await api.deleteFolderFavorite(id);
      apply((current) => current.filter((item) => item.id !== id));
      return true;
    } catch (error) { toast.error(errorMessage(error, t`无法取消收藏`)); return false; }
  }, [apply, t]);

  const rename = useCallback(async (favorite: FolderFavorite) => {
    const folder = favorite.path.split('/').filter(Boolean).pop() || favorite.path;
    const value = await promptDialog({ title: t`重命名收藏`, description: t`留空则显示目录名`, initial: favorite.label ?? folder, placeholder: folder, confirmLabel: t`保存` });
    if (value === null) return;
    const label = value.trim() && value.trim() !== folder ? value.trim() : null;
    if (label === (favorite.label ?? null)) return;
    try {
      const updated = await api.updateFolderFavorite(favorite.id, { label });
      apply((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (error) { toast.error(errorMessage(error, t`无法重命名收藏`)); }
  }, [apply, t]);

  /** Moves one favorite a step up (-1) or down (1); painted before the server confirms. */
  const move = useCallback(async (id: string, delta: -1 | 1) => {
    const before = cache.get(key) ?? [];
    const from = before.findIndex((item) => item.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= before.length) return;
    const next = [...before];
    [next[from], next[to]] = [next[to]!, next[from]!];
    apply(() => next);
    try {
      const { favorites: saved } = await api.reorderFolderFavorites(next.map((item) => item.id), projectId);
      apply(() => saved);
    } catch (error) {
      apply(() => before);
      toast.error(errorMessage(error, t`无法调整收藏顺序`));
    }
  }, [key, projectId, apply, t]);

  return { favorites, add, remove, rename, move };
}

/** The filled star a favorited folder carries. */
export function FavoriteStar({ className }: { className?: string }) {
  return <IconStarFilled className={cn('size-3.5 shrink-0 text-warning', className)} />;
}

/** 重命名 / 上移 / 下移 / 取消收藏 for one favorite; the caller styles the trigger. */
export function FavoriteMenu({ favorite, store, triggerClassName }: { favorite: FolderFavorite; store: FolderFavoritesApi; triggerClassName: string }) {
  const { t } = useLingui();
  const index = store.favorites.findIndex((item) => item.id === favorite.id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={t`管理收藏 ${favoriteName(favorite)}`} className={triggerClassName}><IconEllipsis className="size-3.5" /></button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuItem onSelect={() => void store.rename(favorite)}><IconPencilLine /><Trans>重命名…</Trans></DropdownMenuItem>
        <DropdownMenuItem disabled={index <= 0} onSelect={() => void store.move(favorite.id, -1)}><IconArrowUp /><Trans>上移</Trans></DropdownMenuItem>
        <DropdownMenuItem disabled={index < 0 || index >= store.favorites.length - 1} onSelect={() => void store.move(favorite.id, 1)}><IconArrowDown /><Trans>下移</Trans></DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="danger" onSelect={() => void store.remove(favorite.id)}><IconTrash2 /><Trans>取消收藏</Trans></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
