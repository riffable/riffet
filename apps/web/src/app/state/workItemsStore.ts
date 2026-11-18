import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { summarizeWorkItem, type WorkItem, type WorkItemCreate, type WorkItemPatch, type WorkItemSummary } from '@contracts';
import { api, etagRevision } from '@/lib/api';
import { HttpError } from '@/lib/errors';
import { reconcileById } from '@/lib/reconcile';
import { createStore } from '@/lib/store';
import { toast } from '@/lib/toast';
import { errorMessage, newId } from '@/lib/utils';
import type { ListsStore } from './listsStore';

/** A burst of list pushes (a running turn sends several) costs one conditional re-read. */
const PUSH_DEBOUNCE_MS = 250;

export interface WorkItemsState {
  /**
   * Lightweight shell projection (from local cache, bootstrap, or a full read); undefined only
   * before any source has answered (e.g. an uncached legacy server).
   */
  summaries: WorkItemSummary[] | undefined;
  /** Every work item the server shows this client; undefined until the first full read answers. */
  items: WorkItem[] | undefined;
  /** False when the server predates work items (the list answers 404); the page and its entry hide. */
  supported: boolean;
  /** An item to open when the board next shows, asked for from elsewhere (a conversation's task mark). */
  revealId?: string;
}

function reconcileSummaries(previous: WorkItemSummary[] | undefined, incoming: WorkItemSummary[]): WorkItemSummary[] {
  return previous ? reconcileById(previous, incoming) : incoming;
}

function upsertSummary(summaries: WorkItemSummary[] | undefined, item: WorkItemSummary): WorkItemSummary[] {
  if (!summaries) return [item];
  return summaries.some((entry) => entry.id === item.id)
    ? summaries.map((entry) => entry.id === item.id ? item : entry)
    : [item, ...summaries];
}

/**
 * 任务 (docs/TASK-BOARD.md): shell summaries ride `/api/bootstrap` and `list-cache` for first-paint
 * rendering; full items are fetched on demand (or when `workItems` changes over the lists stream).
 */
export function createWorkItemsStore(
  lists: Pick<ListsStore, 'onChanged'>,
  initialSummaries?: WorkItemSummary[],
  onSummariesChanged?: () => void,
) {
  const store = createStore<WorkItemsState>({ summaries: initialSummaries, items: undefined, supported: true });
  let etag: string | undefined;
  /** Latest `workItems` revision observed from `/api/bootstrap` or `/api/work-items`. */
  let knownRevision: number | undefined;
  /** Bumped by every read and local write; an answer that straddles one is dropped. */
  let ticket = 0;
  let timer: number | undefined;
  let inFlight = false;
  let readAgain = false;

  const read = async () => {
    if (inFlight) { readAgain = true; return; }
    inFlight = true;
    const begun = ++ticket;
    try {
      const result = await api.workItems(etag);
      if (begun !== ticket) return;
      if (result.unchanged) {
        knownRevision = etagRevision(etag);
        return;
      }
      etag = result.etag;
      knownRevision = etagRevision(result.etag);
      const current = store.get();
      const items = current.items ? reconcileById(current.items, result.data.items) : result.data.items;
      const summaries = reconcileSummaries(current.summaries, items.map(summarizeWorkItem));
      store.set({ items, summaries, supported: true });
      if (summaries !== current.summaries) onSummariesChanged?.();
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) store.set({ items: [], summaries: [], supported: false });
      /* otherwise keep what is shown; the next push reads again */
    } finally {
      inFlight = false;
      if (readAgain) { readAgain = false; void read(); }
    }
  };

  const replace = (item: WorkItem) => {
    ticket += 1;
    etag = undefined;
    knownRevision = undefined;
    const summary = summarizeWorkItem(item);
    let summariesMoved = false;
    store.set((current) => {
      const items = current.items
        ? (current.items.some((entry) => entry.id === item.id)
            ? current.items.map((entry) => entry.id === item.id ? item : entry)
            : [item, ...current.items])
        : undefined;
      const nextSummaries = reconcileSummaries(current.summaries, upsertSummary(current.summaries, summary));
      summariesMoved = nextSummaries !== current.summaries;
      return { ...(items ? { items } : {}), summaries: nextSummaries };
    });
    if (summariesMoved) onSummariesChanged?.();
  };

  lists.onChanged(({ workItems }) => {
    if (workItems !== undefined && (workItems === knownRevision || workItems === etagRevision(etag))) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void read(), PUSH_DEBOUNCE_MS);
  });

  const actions = {
    ticket: () => ticket,
    /** Applies the lightweight summaries and revision carried by `/api/bootstrap`, or falls back to a full read on legacy servers. */
    absorbBootstrap(summaries: WorkItemSummary[] | undefined, revision: number | undefined, requestedTicket: number) {
      if (summaries === undefined) {
        if (store.get().items === undefined && store.get().supported) void read();
        return;
      }
      if (requestedTicket !== ticket) return;
      const current = store.get();
      if (current.items !== undefined && revision !== undefined && revision === etagRevision(etag)) {
        knownRevision = revision;
        return;
      }
      knownRevision = revision;
      const nextSummaries = reconcileSummaries(current.summaries, summaries);
      store.set({ ...(nextSummaries !== current.summaries ? { summaries: nextSummaries } : {}), supported: true });
      if (current.items !== undefined && revision !== etagRevision(etag)) void read();
    },
    /** Loads the full list once if a board or plan view needs details beyond the shell summary. */
    ensureLoaded() {
      if (store.get().items === undefined && store.get().supported) void read();
    },
    async create(body: Omit<WorkItemCreate, 'id'>): Promise<WorkItem | undefined> {
      try {
        const item = await api.createWorkItem({ ...body, id: newId() });
        replace(item);
        return item;
      } catch (error) { toast.error(errorMessage(error, i18n._(msg`无法创建任务`))); return undefined; }
    },
    async update(id: string, body: WorkItemPatch): Promise<WorkItem | undefined> {
      const current = store.get();
      const before = current.items?.find((item) => item.id === id);
      const beforeSummary = current.summaries?.find((item) => item.id === id);
      ticket += 1;
      etag = undefined;
      knownRevision = undefined;
      // The board moves the card now; a refusal puts it back.
      if (before || beforeSummary) {
        store.set((state) => ({
          ...(before && state.items ? { items: state.items.map((entry) => entry.id === id ? { ...before, ...withoutNulls(body), ...(body.status && body.status !== before.status ? { statusAt: new Date().toISOString() } : {}) } as WorkItem : entry) } : {}),
          ...(beforeSummary && state.summaries && body.status ? { summaries: state.summaries.map((entry) => entry.id === id ? { ...beforeSummary, status: body.status! } : entry) } : {}),
        }));
      }
      try {
        const item = await api.updateWorkItem(id, body);
        replace(item);
        return item;
      } catch (error) {
        if (before || beforeSummary) {
          ticket += 1;
          store.set((state) => ({
            ...(before && state.items ? { items: state.items.map((entry) => entry.id === id ? before : entry) } : {}),
            ...(beforeSummary && state.summaries ? { summaries: state.summaries.map((entry) => entry.id === id ? beforeSummary : entry) } : {}),
          }));
        }
        toast.error(errorMessage(error, i18n._(msg`无法修改任务`)));
        return undefined;
      }
    },
    async remove(id: string): Promise<boolean> {
      try {
        await api.deleteWorkItem(id);
        ticket += 1;
        etag = undefined;
        knownRevision = undefined;
        let summariesMoved = false;
        store.set((current) => {
          const items = current.items
            ? current.items.filter((item) => item.id !== id).map((item) => item.parentId === id ? { ...item, parentId: undefined } : item)
            : undefined;
          const nextSummaries = current.summaries?.filter((item) => item.id !== id);
          summariesMoved = nextSummaries !== undefined && nextSummaries.length !== current.summaries?.length;
          return { ...(items ? { items } : {}), ...(nextSummaries ? { summaries: nextSummaries } : {}) };
        });
        if (summariesMoved) onSummariesChanged?.();
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
