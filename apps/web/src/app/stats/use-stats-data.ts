import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { StatsDashboard, StatsLatency, StatsRunRow, StatsSeries } from '@contracts';
import { api, statsStreamUrl } from '@/lib/api';
import { loadStatsCache, saveStatsCache } from '@/lib/stats-cache';
import { clientTimeZone, createRefreshThrottle, granularityFor, statsFilterKey, statsFilterParams, type StatsUiState } from '@/lib/stats-query';
import { errorMessage } from '@/lib/utils';
import {
  cursorForStatsRunsPage,
  createStatsRunsPendingRefresh,
  createStatsRunsCursorChain,
  drainStatsRunsRefresh,
  failedStatsRunsPageAfterRequest,
  hasStatsRunsPageCursor,
  isCurrentStatsRunsRequest,
  queueStatsRunsRefresh,
  recordStatsRunsPageCursor,
  statsRunsEffectAction,
  DEFAULT_STATS_RUN_PAGE_SIZE,
  STATS_RUN_PAGE_SIZES,
  type StatsRunsCursorChain,
  type StatsRunsEffectState,
  type StatsRunsPageSize,
} from './runs-pagination';

export { DEFAULT_STATS_RUN_PAGE_SIZE, STATS_RUN_PAGE_SIZES } from './runs-pagination';

export interface StatsData {
  dashboard?: StatsDashboard;
  series?: StatsSeries;
  latency?: StatsLatency;
  runs: StatsRunRow[];
  runsPage: number;
  runsPageSize: StatsRunsPageSize;
  runsHasNext: boolean;
  loading: boolean;
  refreshing: boolean;
  runsLoading: boolean;
  runsError: string;
  error: string;
  reload: () => void;
  goToRunsPage: (page: number) => void;
  setRunsPageSize: (size: number) => void;
  retryRuns: () => void;
}

interface RunsContext {
  filterKey: string;
  query: string;
  pageSize: StatsRunsPageSize;
}

interface RunsPager {
  filterKey: string;
  pageSize: StatsRunsPageSize;
  page: number;
  cursors: StatsRunsCursorChain;
  hasNext: boolean;
  failedPage?: number;
  loading: boolean;
  hasSuccessfulPage: boolean;
}

interface RunsView {
  filterKey: string;
  page: number;
  pageSize: StatsRunsPageSize;
  rows: StatsRunRow[];
  hasNext: boolean;
  loading: boolean;
  error: string;
}

function queryOf(state: StatsUiState): string {
  return statsFilterParams(state, new Date(), clientTimeZone()).toString();
}

function createRunsPager(filterKey: string, pageSize: StatsRunsPageSize): RunsPager {
  return {
    filterKey,
    pageSize,
    page: 1,
    cursors: createStatsRunsCursorChain(),
    hasNext: false,
    loading: false,
    hasSuccessfulPage: false,
  };
}

export function useStatsData(state: StatsUiState): StatsData {
  const { t } = useLingui();
  const filterKey = statsFilterKey(state);
  const stateRef = useRef(state);
  stateRef.current = state;
  const cached = useRef(loadStatsCache());
  const [dashboard, setDashboard] = useState<StatsDashboard | undefined>(cached.current?.dashboard);
  const dashboardRef = useRef(dashboard);
  dashboardRef.current = dashboard;
  const [series, setSeries] = useState<StatsSeries | undefined>();
  const [latency, setLatency] = useState<StatsLatency | undefined>();
  const [phase, setPhase] = useState<'loading' | 'refreshing' | 'idle'>(cached.current ? 'refreshing' : 'loading');
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [runsRequestSettledToken, setRunsRequestSettledToken] = useState(0);
  const runsRequest = useRef(0);
  const runsController = useRef<AbortController | null>(null);

  const runsContext = useRef<RunsContext>({ filterKey, query: queryOf(state), pageSize: DEFAULT_STATS_RUN_PAGE_SIZE });
  const runsPager = useRef<RunsPager>(createRunsPager(filterKey, runsContext.current.pageSize));
  const pendingRunsRefresh = useRef(createStatsRunsPendingRefresh());
  const [runsView, setRunsView] = useState<RunsView>(() => ({
    filterKey,
    page: 1,
    pageSize: runsContext.current.pageSize,
    rows: [],
    hasNext: false,
    loading: true,
    error: '',
  }));
  const runsViewRef = useRef(runsView);
  runsViewRef.current = runsView;

  const publishRunsView = useCallback((next: RunsView) => {
    runsViewRef.current = next;
    setRunsView(next);
  }, []);

  const cancelRunsRequest = useCallback(() => {
    runsRequest.current += 1;
    runsController.current?.abort();
    runsController.current = null;
    runsPager.current.loading = false;
  }, []);

  // Refresh the cursor chain only after the filter render commits. This also invalidates old
  // responses before passive effects start the new page request.
  useLayoutEffect(() => {
    if (runsContext.current.filterKey === filterKey) return;
    cancelRunsRequest();
    const pageSize = runsPager.current.pageSize;
    runsContext.current = { filterKey, query: queryOf(state), pageSize };
    runsPager.current = createRunsPager(filterKey, pageSize);
    pendingRunsRefresh.current = createStatsRunsPendingRefresh();
  }, [filterKey, state, cancelRunsRequest]);

  const loadRunsPage = useCallback((pageNumber: number, options: { preserveFailedPage?: boolean } = {}) => {
    const context = runsContext.current;
    const pager = runsPager.current;
    if (pager.filterKey !== context.filterKey || pager.pageSize !== context.pageSize) return;
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || !hasStatsRunsPageCursor(pager.cursors, pageNumber)) return;

    const cursor = cursorForStatsRunsPage(pager.cursors, pageNumber);
    cancelRunsRequest();
    const controller = new AbortController();
    runsController.current = controller;
    const id = ++runsRequest.current;
    const stamp = { id, filterKey: context.filterKey };
    pager.loading = true;
    const currentView = runsViewRef.current;
    publishRunsView({
      filterKey: context.filterKey,
      page: currentView.filterKey === context.filterKey ? currentView.page : pager.page,
      pageSize: context.pageSize,
      rows: currentView.filterKey === context.filterKey ? currentView.rows : [],
      hasNext: currentView.filterKey === context.filterKey ? currentView.hasNext : pager.hasNext,
      loading: true,
      error: options.preserveFailedPage && currentView.filterKey === context.filterKey ? currentView.error : '',
    });

    api.statsRuns(context.query, cursor, context.pageSize, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || !isCurrentStatsRunsRequest(stamp, runsRequest.current, runsContext.current.filterKey)) return;
        recordStatsRunsPageCursor(pager.cursors, pageNumber, result.nextCursor);
        pager.page = pageNumber;
        pager.hasNext = Boolean(result.nextCursor);
        pager.hasSuccessfulPage = true;
        pager.failedPage = failedStatsRunsPageAfterRequest(
          pager.failedPage,
          pageNumber,
          true,
          Boolean(options.preserveFailedPage),
        );
        pager.loading = false;
        const previous = runsViewRef.current;
        publishRunsView({
          filterKey: context.filterKey,
          page: pageNumber,
          pageSize: context.pageSize,
          rows: result.rows,
          hasNext: pager.hasNext,
          loading: false,
          error: options.preserveFailedPage && previous.filterKey === context.filterKey ? previous.error : '',
        });
        setRunsRequestSettledToken((current) => current + 1);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || !isCurrentStatsRunsRequest(stamp, runsRequest.current, runsContext.current.filterKey)) return;
        pager.failedPage = failedStatsRunsPageAfterRequest(
          pager.failedPage,
          pageNumber,
          false,
          Boolean(options.preserveFailedPage),
        );
        pager.loading = false;
        const previous = runsViewRef.current;
        publishRunsView({
          filterKey: context.filterKey,
          page: previous.filterKey === context.filterKey ? previous.page : pager.page,
          pageSize: context.pageSize,
          rows: previous.filterKey === context.filterKey ? previous.rows : [],
          hasNext: previous.filterKey === context.filterKey ? previous.hasNext : pager.hasNext,
          loading: false,
          error: errorMessage(reason, t`无法加载明细`),
        });
        setRunsRequestSettledToken((current) => current + 1);
      })
      .finally(() => {
        if (runsController.current === controller) runsController.current = null;
      });
  }, [cancelRunsRequest, publishRunsView]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setPhase(dashboardRef.current ? 'refreshing' : 'loading');
    const key = queryOf(stateRef.current);
    api.statsDashboard(key, controller.signal).then((next) => {
      if (!active) return;
      setDashboard(next);
      setError('');
      saveStatsCache(key, next);
      setPhase('idle');
    }).catch((reason: unknown) => {
      if (!active || controller.signal.aborted) return;
      setError(errorMessage(reason, t`无法加载统计`));
      setPhase('idle');
    });
    return () => { active = false; controller.abort(); };
  }, [filterKey, reloadToken]);

  useEffect(() => {
    if (!dashboard) return;
    const metric = state.metric;
    const split = state.split;
    if (dashboard.series.metric === metric && dashboard.series.split === split) {
      setSeries(dashboard.series);
      return;
    }
    const controller = new AbortController();
    const current = stateRef.current;
    api.statsSeries(queryOf(current), metric, granularityFor(current, new Date()), split, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setSeries(next); })
      .catch(() => { /* keep the series already on screen */ });
    return () => controller.abort();
  }, [dashboard, state.metric, state.split, filterKey, reloadToken]);

  useEffect(() => {
    const controller = new AbortController();
    api.statsLatency(queryOf(stateRef.current), 'model', controller.signal)
      .then((next) => { if (!controller.signal.aborted) setLatency(next); })
      .catch(() => { /* a latency miss leaves the previous bars up */ });
    return () => controller.abort();
  }, [filterKey, reloadToken]);

  const runsEffect = useRef<StatsRunsEffectState | undefined>(undefined);
  useEffect(() => {
    const previous = runsEffect.current;
    // Re-resolve relative ranges on every dashboard refresh. A range such as "today" can
    // produce a different query after midnight even when the selected filter itself is unchanged.
    const query = queryOf(stateRef.current);
    const current = { filterKey, query, reloadToken };
    const action = statsRunsEffectAction(previous, current, runsPager.current.loading);
    runsEffect.current = current;
    if (action === 'reset') {
      cancelRunsRequest();
      const context = runsContext.current;
      runsContext.current = { ...context, filterKey, query };
      const pager = createRunsPager(filterKey, context.pageSize);
      runsPager.current = pager;
      pendingRunsRefresh.current = createStatsRunsPendingRefresh();
      publishRunsView({
        filterKey,
        page: 1,
        pageSize: context.pageSize,
        rows: [],
        hasNext: false,
        loading: true,
        error: '',
      });
      loadRunsPage(1);
      return;
    }
    if (action === 'refresh') {
      const pager = runsPager.current;
      // A burst of SSE events must not keep aborting an active page turn.
      if (!pager.loading) loadRunsPage(pager.page, { preserveFailedPage: true });
    } else if (action === 'skip') {
      pendingRunsRefresh.current = queueStatsRunsRefresh(pendingRunsRefresh.current);
    }
  }, [filterKey, reloadToken, cancelRunsRequest, loadRunsPage, publishRunsView]);

  useEffect(() => {
    const drained = drainStatsRunsRefresh(
      pendingRunsRefresh.current,
      runsPager.current.loading,
      runsPager.current.hasSuccessfulPage,
    );
    pendingRunsRefresh.current = drained.state;
    if (drained.refreshPage) {
      // Revalidate the last successful page while keeping a failed page-turn target available
      // for the explicit Retry action. The queued event is consumed before this request starts,
      // so a failed revalidation cannot cause an automatic retry loop.
      loadRunsPage(runsPager.current.page, { preserveFailedPage: true });
    }
  }, [runsRequestSettledToken, loadRunsPage]);

  useEffect(() => () => {
    pendingRunsRefresh.current = createStatsRunsPendingRefresh();
    cancelRunsRequest();
    // StrictMode replays effects after cleanup. Resetting this marker makes the setup replay
    // request page 1 again if cleanup aborted the first request.
    runsEffect.current = undefined;
  }, [cancelRunsRequest]);

  const goToRunsPage = useCallback((page: number) => {
    const pager = runsPager.current;
    if (pager.loading || page === pager.page || page < 1) return;
    if (page > pager.page + 1 && !hasStatsRunsPageCursor(pager.cursors, page)) return;
    loadRunsPage(page);
  }, [loadRunsPage]);

  const setRunsPageSize = useCallback((size: number) => {
    if (!STATS_RUN_PAGE_SIZES.some((option) => option === size)) return;
    const context = runsContext.current;
    if (context.pageSize === size) return;
    context.pageSize = size as StatsRunsPageSize;
    cancelRunsRequest();
    pendingRunsRefresh.current = createStatsRunsPendingRefresh();
    runsPager.current = createRunsPager(context.filterKey, context.pageSize);
    publishRunsView({
      filterKey: context.filterKey,
      page: 1,
      pageSize: context.pageSize,
      rows: [],
      hasNext: false,
      loading: true,
      error: '',
    });
    loadRunsPage(1);
  }, [cancelRunsRequest, loadRunsPage, publishRunsView]);

  const retryRuns = useCallback(() => {
    const pager = runsPager.current;
    if (pager.loading) return;
    loadRunsPage(pager.failedPage ?? pager.page);
  }, [loadRunsPage]);

  const reload = useCallback(() => setReloadToken((current) => current + 1), []);

  useEffect(() => {
    const source = new EventSource(statsStreamUrl());
    const throttle = createRefreshThrottle(2000);
    /** A change that arrived while the tab was hidden: one re-read when it is shown again. */
    let missed = false;
    const reload = () => {
      if (document.visibilityState === 'hidden') { missed = true; return; }
      setReloadToken((current) => current + 1);
    };
    const onFrame = (event: Event) => {
      const data = 'data' in event ? String((event as MessageEvent).data ?? '') : '';
      if (data) {
        try {
          const frame = JSON.parse(data) as { type?: string };
          if (frame.type !== 'stats_changed') return;
        } catch { return; }
      }
      if (document.visibilityState === 'hidden') missed = true;
      else throttle.push(reload);
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible' || !missed) return;
      missed = false;
      throttle.push(reload);
    };
    source.addEventListener('message', onFrame);
    source.addEventListener('stats_changed', onFrame);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { throttle.cancel(); source.close(); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  const visibleRuns = runsView.filterKey === filterKey ? runsView : {
    filterKey,
    page: 1,
    pageSize: runsContext.current.pageSize,
    rows: [],
    hasNext: false,
    loading: true,
    error: '',
  };

  return {
    ...(dashboard ? { dashboard } : {}),
    ...(series ? { series } : {}),
    ...(latency ? { latency } : {}),
    runs: visibleRuns.rows,
    runsPage: visibleRuns.page,
    runsPageSize: visibleRuns.pageSize,
    runsHasNext: visibleRuns.hasNext,
    loading: phase === 'loading' && !dashboard,
    refreshing: phase === 'refreshing',
    runsLoading: visibleRuns.loading,
    runsError: visibleRuns.error,
    error,
    reload,
    goToRunsPage,
    setRunsPageSize,
    retryRuns,
  };
}
