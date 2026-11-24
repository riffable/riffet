import { councilAwaitsReader, type CouncilSummary } from '@contracts';
import { api } from '@/lib/api';
import { HttpError } from '@/lib/errors';
import { createStore } from '@/lib/store';
import type { ListsStore } from './listsStore';

/** A burst of pushes costs one read. */
const PUSH_DEBOUNCE_MS = 250;

export interface CouncilState {
  /** The entry server's model collaborations, newest first; undefined until first read. */
  items: CouncilSummary[] | undefined;
}

/**
 * The model collaborations the page lists and the sidebar marks (docs/design/system/surfaces.md §4). Read when the
 * workbench opens and on every `council` push; an older server answers 404 and leaves the list empty.
 */
export function createCouncilStore(lists: Pick<ListsStore, 'onCouncil'>) {
  const store = createStore<CouncilState>({ items: undefined });
  let timer: number | undefined;
  let ticket = 0;
  // Deleted here before the server's answer to a read already under way could leave them out.
  const gone = new Set<string>();

  const read = async () => {
    const begun = ++ticket;
    try {
      const { items } = await api.councilList();
      if (begun !== ticket) return;
      store.set({ items: items.filter(({ id }) => !gone.has(id)) });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) store.set({ items: [] });
      /* otherwise keep what is shown; the next push reads again */
    }
  };
  const later = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void read(), PUSH_DEBOUNCE_MS); };

  lists.onCouncil(later);
  void read();

  return {
    ...store,
    reload: read,
    /** The page's own copy of one discussion is newer than the list's: it replaces the row, or adds it first. */
    upsert(summary: CouncilSummary) {
      store.set(({ items }) => {
        const current = items ?? [];
        return { items: current.some(({ id }) => id === summary.id) ? current.map((item) => (item.id === summary.id ? summary : item)) : [summary, ...current] };
      });
    },
    forget(id: string) {
      gone.add(id);
      store.set(({ items }) => ({ items: items?.filter((item) => item.id !== id) }));
    },
  };
}

export type CouncilStore = ReturnType<typeof createCouncilStore>;

/** What the sidebar marks for the collaborations as a whole, most pressing first. */
export type CouncilAttention = 'running' | 'waiting' | 'failed' | 'unread';

export function councilAttention(items: readonly CouncilSummary[] | undefined): CouncilAttention | undefined {
  if (!items?.length) return undefined;
  if (items.some((item) => item.status === 'running')) return 'running';
  const settled = items.filter(councilAwaitsReader);
  if (settled.some((item) => item.status === 'paused')) return 'waiting';
  if (settled.some((item) => item.status === 'failed')) return 'failed';
  return settled.length ? 'unread' : undefined;
}
