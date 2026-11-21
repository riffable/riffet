import { useMemo } from 'react';
import { createStore, useStore } from '@/lib/store';
import { readStored, writeStored } from '@/lib/utils';
import { matches, migrateViewId, type ViewEntry, type ViewFacts } from '@/plugins/catalog';
import { useViewCatalog } from '@/plugins/registry';

/** Where the 对话 / 终端 / 画布 switch sits: dots under the conversation, or icons in the header's actions. */
export type ViewSwitchPlacement = 'dots' | 'header';

/** What a wide session shows on its right: the overview column, or only the message rail a narrow one has. */
export type SessionSide = 'overview' | 'rail';

/** How the message rail marks each prompt. */
export type RailMark = 'line' | 'dot';

/** When a finished turn's process block folds automatically: right as the turn finishes, or once a later turn begins. */
export type ProcessFoldTiming = 'turn-end' | 'next-input';

export interface ViewPrefs {
  placement: ViewSwitchPlacement;
  side: SessionSide;
  mark: RailMark;
  chapterNavigation: boolean;
  processFoldTiming: ProcessFoldTiming;
  /**
   * The reader's order, by view id. It keeps ids this client does not offer now (a plugin that is
   * off, or one this build does not know), so the view returns to its place when it comes back.
   */
  order: string[];
  /** Views the reader turned off, kept the same way; never contains 'chat'. */
  hidden: string[];
  /** The same two lists for the side panel's views; ids are kept apart because a plugin view can sit in both places. */
  sidebarOrder: string[];
  sidebarHidden: string[];
}

const KEY = 'riffet.sessionViews.v1';
const DEFAULTS: ViewPrefs = { placement: 'dots', side: 'overview', mark: 'line', chapterNavigation: true, processFoldTiming: 'turn-end', order: [], hidden: [], sidebarOrder: [], sidebarHidden: [] };

/** A stored list of view ids: strings only, legacy ids migrated (`canvas` is `riffet.canvas/canvas`), duplicates dropped, unknown ids kept. */
const ids = (list: unknown): string[] => Array.isArray(list)
  ? [...new Set(list.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 200).map(migrateViewId))]
  : [];

/** A stored value is trusted as far as its shape; view ids are not checked against what is offered now. */
export function readViewPrefs(raw: string): ViewPrefs {
  try {
    const value = JSON.parse(raw || 'null') as Partial<ViewPrefs> | null;
    if (!value || typeof value !== 'object') return DEFAULTS;
    return {
      placement: value.placement === 'header' ? 'header' : 'dots',
      side: value.side === 'rail' ? 'rail' : 'overview',
      mark: value.mark === 'dot' ? 'dot' : 'line',
      chapterNavigation: value.chapterNavigation !== false,
      processFoldTiming: value.processFoldTiming === 'next-input' ? 'next-input' : 'turn-end',
      order: ids(value.order),
      hidden: ids(value.hidden).filter((view) => view !== 'chat'),
      sidebarOrder: ids(value.sidebarOrder),
      sidebarHidden: ids(value.sidebarHidden),
    };
  } catch { return DEFAULTS; }
}

/** Device-local, like the tab style: one browser's layout says nothing about another's. */
export const viewPrefs = createStore<ViewPrefs>(readViewPrefs(readStored(KEY)));
viewPrefs.subscribe(() => writeStored(KEY, JSON.stringify(viewPrefs.get())));

export const useViewPrefs = <S,>(selector: (state: ViewPrefs) => S, isEqual?: (a: S, b: S) => boolean) => useStore(viewPrefs, selector, isEqual);

export function setViewPlacement(placement: ViewSwitchPlacement) { viewPrefs.set({ placement }); }

export function setSessionSide(side: SessionSide) { viewPrefs.set({ side }); }

export function setRailMark(mark: RailMark) { viewPrefs.set({ mark }); }

export function setChapterNavigation(chapterNavigation: boolean) { viewPrefs.set({ chapterNavigation }); }

export function setProcessFoldTiming(processFoldTiming: ProcessFoldTiming) { viewPrefs.set({ processFoldTiming }); }

/**
 * `order` with the views on offer in `shown`'s order. Ids that are not on offer keep their places and
 * the offered ones fill the rest, so a view that comes back finds its old slot.
 */
function reorderViews(order: readonly string[], shown: readonly string[]): string[] {
  const offered = new Set(shown);
  const queue = [...new Set(shown)];
  const kept = order.map((view) => offered.has(view) ? queue.shift()! : view);
  return [...kept, ...queue];
}

/** Which of the two view lists a change is for: the conversation's switch, or the side panel's tabs. */
export type ViewList = 'session' | 'sidebar';

/** Reorders the views on offer in `list`; the rest keep their slots (`reorderViews`). */
export function setViewOrder(shown: string[], list: ViewList = 'session') {
  const prefs = viewPrefs.get();
  viewPrefs.set(list === 'sidebar' ? { sidebarOrder: reorderViews(prefs.sidebarOrder, shown) } : { order: reorderViews(prefs.order, shown) });
}

export function setViewVisible(view: string, visible: boolean, list: ViewList = 'session') {
  if (list === 'session' && view === 'chat') return;
  const prefs = viewPrefs.get();
  const change = (current: string[]) => visible ? current.filter((item) => item !== view) : [...new Set([...current, view])];
  viewPrefs.set(list === 'sidebar' ? { sidebarHidden: change(prefs.sidebarHidden) } : { hidden: change(prefs.hidden) });
}

/** `entries` in the reader's order; views they have not placed follow, in catalog order. */
export function orderViews(entries: readonly ViewEntry[], order: readonly string[]): ViewEntry[] {
  const rank = (id: string) => { const index = order.indexOf(id); return index < 0 ? order.length : index; };
  return [...entries].sort((a, b) => rank(a.id) - rank(b.id));
}

/** Session views this client offers for a conversation with `facts`, in the reader's order, hidden ones included. */
export function useSessionViews(facts: ViewFacts): ViewEntry[] {
  const catalog = useViewCatalog();
  const order = useViewPrefs((state) => state.order);
  const { hasProject, hasSession, projectType, projectSystem, projectTypes, capabilities } = facts;
  return useMemo(
    () => orderViews(catalog.filter((view) => view.location === 'session-view' && matches(view.when, { hasProject, hasSession, projectSystem, projectType, projectTypes, capabilities })), order),
    [catalog, order, hasProject, hasSession, projectSystem, projectType, projectTypes, capabilities],
  );
}

/** Every side-panel view this client offers, in the reader's order, hidden ones included. Conditions are not applied: the order is the reader's for views a project may not show now. */
export function useSidebarOrder(): ViewEntry[] {
  const catalog = useViewCatalog();
  const order = useViewPrefs((state) => state.sidebarOrder);
  return useMemo(() => orderViews(catalog.filter((view) => view.location === 'sidebar'), order), [catalog, order]);
}

/** The views the switch shows, in order: not the ones the reader turned off, and only what this session supports. 对话 always stays. */
export function visibleViews(prefs: ViewPrefs, offered: readonly ViewEntry[], supported: (view: string) => boolean): string[] {
  return offered.map((view) => view.id).filter((view) => view === 'chat' || (!prefs.hidden.includes(view) && supported(view)));
}
