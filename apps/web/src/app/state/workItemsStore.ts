import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { WorkItem, WorkItemCreate, WorkItemPatch } from '@contracts';
import { api, etagRevision } from '@/lib/api';
import { HttpError } from '@/lib/errors';
import { createStore } from '@/lib/store';
import { toast } from '@/lib/toast';
import { errorMessage, newId } from '@/lib/utils';
import type { ListsStore } from './listsStore';

/** A burst of list pushes (a running turn sends several) costs one conditional re-read. */
const PUSH_DEBOUNCE_MS = 250;

export interface WorkItemsState {
  /** Every work item the server shows this client; undefined until the first read answers. */
  items: WorkItem[] | undefined;
  /** False when the server predates work items (the list answers 404); the page and its entry hide. */
  supported: boolean;
  /** An item to open when the board next shows, asked for from elsewhere (a conversation's task mark). */
  revealId?: string;
}

/**
 * 任务 (docs/TASK-BOARD.md): the whole list, kept current from the lists stream's `workItems`
 * revision. Writes patch the list at once and the next read starts over, as 收藏 do.
 */
export function createWorkItemsStore(lists: Pick<ListsStore, 'onChanged'>) {
  const store = createStore<WorkItemsState>({ items: undefined, supported: true });
  let etag: string | undefined;
  /** Bumped by every read and local write; an answer that straddles one is dropped. */
  let ticket = 0;
  let timer: number | undefined;
  let started = false;

  const read = async () => {
    const begun = ++ticket;
    try {
      const result = await api.workItems(etag);
      if (begun !== ticket || result.unchanged) return;
      etag = result.etag;
      store.set({ items: result.data.items, supported: true });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) store.set({ items: [], supported: false });
      /* otherwise keep what is shown; the next push reads again */
    }
  };
  const patch = (update: (items: WorkItem[]) => WorkItem[]) => {
    ticket += 1;
    etag = undefined;
    store.set((current) => current.items ? { items: update(current.items) } : {});
  };
  const replace = (item: WorkItem) => patch((items) => items.some((entry) => entry.id === item.id) ? items.map((entry) => entry.id === item.id ? item : entry) : [...items, item]);

  lists.onChanged(({ workItems }) => {
    if (!started || (workItems !== undefined && workItems === etagRevision(etag))) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void read(), PUSH_DEBOUNCE_MS);
  });

  const actions = {
    /** The first read; later ones follow the lists stream. */
    start() {
      if (started) return;
      started = true;
      void read();
    },
    async create(body: Omit<WorkItemCreate, 'id'>): Promise<WorkItem | undefined> {
      try {
        const item = await api.createWorkItem({ ...body, id: newId() });
        replace(item);
        return item;
      } catch (error) { toast.error(errorMessage(error, i18n._(msg`无法创建任务`))); return undefined; }
    },
    async update(id: string, body: WorkItemPatch): Promise<WorkItem | undefined> {
      const before = store.get().items?.find((item) => item.id === id);
      // The board moves the card now; a refusal puts it back.
      if (before) replace({ ...before, ...withoutNulls(body), ...(body.status && body.status !== before.status ? { statusAt: new Date().toISOString() } : {}) } as WorkItem);
      try {
        const item = await api.updateWorkItem(id, body);
        replace(item);
        return item;
      } catch (error) {
        if (before) replace(before);
        toast.error(errorMessage(error, i18n._(msg`无法修改任务`)));
        return undefined;
      }
    },
    async remove(id: string): Promise<boolean> {
      try {
        await api.deleteWorkItem(id);
        patch((items) => items.filter((item) => item.id !== id).map((item) => item.parentId === id ? { ...item, parentId: undefined } : item));
        return true;
      } catch (error) { toast.error(errorMessage(error, i18n._(msg`无法删除任务`))); return false; }
    },
    /** Asks the board to open `id`; the board takes it with `takeReveal`. */
    reveal(id: string) { store.set({ revealId: id }); },
    takeReveal(): string | undefined {
      const id = store.get().revealId;
      if (id) store.set({ revealId: undefined });
      return id;
    },
    /** A write made elsewhere (attaching a conversation) whose answer carries the item. */
    accept(item: WorkItem) { replace(item); },
  };
  return { ...store, ...actions };
}

/** A patch's `null` clears a field: on the local copy that is the field's absence. */
function withoutNulls(body: WorkItemPatch): Partial<WorkItem> {
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, value === null ? undefined : value])) as Partial<WorkItem>;
}

export type WorkItemsStore = ReturnType<typeof createWorkItemsStore>;
