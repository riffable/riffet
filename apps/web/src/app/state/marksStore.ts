import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { Mark, MarkCreateRequest, MarkUpdateRequest } from '@contracts';
import { api, etagRevision } from '@/lib/api';
import { toast } from '@/lib/toast';
import type { ListsStore } from './listsStore';
import { createStore } from '@/lib/store';
import { errorMessage } from '@/lib/utils';

/** One conversation's marks are read in one request, at the server's largest page. */
const SESSION_LIMIT = 200;
/** A burst of list pushes (a running turn sends several) costs one conditional re-read. */
const PUSH_DEBOUNCE_MS = 250;

export interface MarksState {
  /** The conversation on screen, whose marks are kept here. */
  sessionId: string;
  /** Its marks, newest first; undefined until the first read answers. */
  marks: Mark[] | undefined;
  /** Bumped by every change made here or pushed by the server, for views that hold their own query. */
  revision: number;
}

/**
 * 收藏 (see docs/MARKS.md): the marks of the conversation on screen, and the writes every view goes
 * through. Mark changes ride the lists stream's `changed` push, so they are re-read from there.
 */
export function createMarksStore(lists: Pick<ListsStore, 'onChanged'>) {
  const store = createStore<MarksState>({ sessionId: '', marks: undefined, revision: 0 });
  let etag: string | undefined;
  /** Bumped by every read and local write; an answer that straddles one is dropped. */
  let ticket = 0;
  let timer: number | undefined;
  /** The marks revision the last push named, so a push about something else re-reads nothing. */
  let pushed: number | undefined;

  const read = async () => {
    const { sessionId } = store.get();
    if (!sessionId) return;
    const started = ++ticket;
    try {
      const result = await api.marks({ sessionId, limit: SESSION_LIMIT }, etag);
      if (started !== ticket || store.get().sessionId !== sessionId || result.unchanged) return;
      etag = result.etag;
      store.set({ marks: result.data.marks });
    } catch { /* keep what is shown; the next push reads again */ }
  };
  const changed = () => store.set((current) => ({ revision: current.revision + 1 }));
  /** A local write: the list on screen is patched now and the next read starts over. */
  const patch = (update: (marks: Mark[]) => Mark[]) => {
    ticket += 1;
    etag = undefined;
    store.set((current) => current.marks ? { marks: update(current.marks) } : {});
    changed();
  };

  lists.onChanged(({ marks }) => {
    // Every list change pushes; only a different marks revision (or none, from a reconnect) is news here.
    if (marks !== undefined && marks === pushed) return;
    pushed = marks;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      changed();
      if (marks === undefined || marks !== etagRevision(etag)) void read();
    }, PUSH_DEBOUNCE_MS);
  });

  const actions = {
    /** Keeps [sessionId]'s marks current while it is on screen. Returns the teardown. */
    watch(sessionId: string): () => void {
      if (store.get().sessionId !== sessionId) {
        etag = undefined;
        ticket += 1;
        store.set({ sessionId, marks: undefined });
      }
      void read();
      return () => { if (store.get().sessionId === sessionId) { ticket += 1; store.set({ sessionId: '', marks: undefined }); } };
    },
    async create(body: MarkCreateRequest): Promise<Mark | undefined> {
      try {
        const mark = await api.createMark(body);
        if (mark.sessionId === store.get().sessionId) patch((marks) => [mark, ...marks.filter((item) => item.id !== mark.id)]);
        else changed();
        return mark;
      } catch (error) { toast.error(errorMessage(error, i18n._(msg`无法收藏`))); return undefined; }
    },
    async update(id: string, body: MarkUpdateRequest): Promise<Mark | undefined> {
      try {
        const mark = await api.updateMark(id, body);
        patch((marks) => marks.map((item) => item.id === id ? mark : item));
        return mark;
      } catch (error) { toast.error(errorMessage(error, i18n._(msg`无法修改收藏`))); return undefined; }
    },
    /** Removed from the list at once and put back if the server refuses. */
    async remove(ids: string[]): Promise<boolean> {
      const before = store.get().marks;
      patch((marks) => marks.filter((item) => !ids.includes(item.id)));
      try { await api.deleteMarks(ids); return true; }
      catch (error) {
        if (before && store.get().marks) patch(() => before);
        toast.error(errorMessage(error, i18n._(msg`无法删除收藏`)));
        return false;
      }
    },
  };
  return { ...store, ...actions };
}

export type MarksStore = ReturnType<typeof createMarksStore>;
