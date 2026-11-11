export const STATS_RUN_PAGE_SIZES = [20, 50, 100] as const;
export type StatsRunsPageSize = (typeof STATS_RUN_PAGE_SIZES)[number];
export const DEFAULT_STATS_RUN_PAGE_SIZE: StatsRunsPageSize = 20;

/** Stores only the cursor needed to request each page; run rows stay in the current-page state. */
export interface StatsRunsCursorChain {
  byPage: Map<number, string | undefined>;
}

export function createStatsRunsCursorChain(): StatsRunsCursorChain {
  return { byPage: new Map([[1, undefined]]) };
}

export function cursorForStatsRunsPage(chain: StatsRunsCursorChain, page: number): string | undefined {
  return chain.byPage.get(page);
}

export function hasStatsRunsPageCursor(chain: StatsRunsCursorChain, page: number): boolean {
  return chain.byPage.has(page);
}

/** Record the next cursor and discard any now-stale cursors after this response. */
export function recordStatsRunsPageCursor(
  chain: StatsRunsCursorChain,
  page: number,
  nextCursor: string | undefined,
): void {
  for (const knownPage of chain.byPage.keys()) {
    if (knownPage > page + 1) chain.byPage.delete(knownPage);
  }
  if (nextCursor) chain.byPage.set(page + 1, nextCursor);
  else chain.byPage.delete(page + 1);
}

export interface StatsRunsRequestStamp {
  id: number;
  filterKey: string;
}

export interface StatsRunsEffectState {
  filterKey: string;
  query: string;
  reloadToken: number;
}

export type StatsRunsEffectAction = 'reset' | 'refresh' | 'skip' | 'none';

/** Decide which page effect replay should run while avoiding SSE churn during an active request. */
export function statsRunsEffectAction(
  previous: StatsRunsEffectState | undefined,
  current: StatsRunsEffectState,
  requestLoading: boolean,
): StatsRunsEffectAction {
  if (!previous || previous.filterKey !== current.filterKey || previous.query !== current.query) return 'reset';
  if (previous.reloadToken !== current.reloadToken) return requestLoading ? 'skip' : 'refresh';
  return 'none';
}

export interface StatsRunsPendingRefresh {
  pending: boolean;
}

export function createStatsRunsPendingRefresh(): StatsRunsPendingRefresh {
  return { pending: false };
}

/** Coalesce any number of refresh events received while a page request is active. */
export function queueStatsRunsRefresh(state: StatsRunsPendingRefresh): StatsRunsPendingRefresh {
  return state.pending ? state : { pending: true };
}

export interface StatsRunsPendingRefreshDrain {
  state: StatsRunsPendingRefresh;
  refreshPage: boolean;
}

/** Consume a queued refresh once a request settles; failed first loads are not retried implicitly. */
export function drainStatsRunsRefresh(
  state: StatsRunsPendingRefresh,
  requestLoading: boolean,
  hasSuccessfulPage: boolean,
): StatsRunsPendingRefreshDrain {
  if (!state.pending || requestLoading) return { state, refreshPage: false };
  return { state: { pending: false }, refreshPage: hasSuccessfulPage };
}

/** Background revalidation must leave a failed page-turn target available for an explicit retry. */
export function failedStatsRunsPageAfterRequest(
  previousFailedPage: number | undefined,
  requestedPage: number,
  succeeded: boolean,
  preserveFailedPage: boolean,
): number | undefined {
  if (preserveFailedPage) return previousFailedPage;
  return succeeded ? undefined : requestedPage;
}

/** A response is usable only for the latest request under the currently selected filters. */
export function isCurrentStatsRunsRequest(
  stamp: StatsRunsRequestStamp,
  activeId: number,
  activeFilterKey: string,
): boolean {
  return stamp.id === activeId && stamp.filterKey === activeFilterKey;
}
