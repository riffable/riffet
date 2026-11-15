import { memo, useMemo } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { StatsRunRow } from '@contracts';
import { IconCircleAlert, IconRefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/controls';
import { FeedbackNotice } from '@/components/ui/feedback-notice';
import { Skeleton } from '@/components/ui/skeleton';
import { exportStats } from '@/lib/api';
import { formatTimestamp } from '@/lib/stats-format';
import { clientTimeZone, previousWindowLabel, resolveWindow, statsFilterKey, statsFilterParams, windowLabel, type StatsUiState } from '@/lib/stats-query';
import { toast } from '@/lib/toast';
import { errorMessage } from '@/lib/utils';
import { AreaChart } from './AreaChart';
import { HighlightProvider } from './chart-shared';
import { DonutChart } from './DonutChart';
import { FilterBar } from './FilterBar';
import { CalendarHeatmap, WeekHeatmap } from './Heatmaps';
import { KpiCards } from './KpiCards';
import { LatencyChart } from './LatencyChart';
import { NorthStar } from './NorthStar';
import { RankChart } from './RankChart';
import { RunsTable } from './RunsTable';
import { ReliabilityChart, ToolChart } from './SplitBars';
import { useStatsData } from './use-stats-data';
import { PageScaffold } from '../PageScaffold';

/** Mirrors the real grid, including card heights, so the page does not jump when data lands. */
function StatsSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <Skeleton className="h-[228px] rounded-2xl sm:h-[132px]" />
      <Skeleton className="h-[72px] rounded-lg sm:h-[48px]" />
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(260px,0.8fr)]">
        <Skeleton className="h-[392px] rounded-xl" />
        <Skeleton className="h-[392px] rounded-xl" />
      </div>
      <div className="grid gap-3 lg:grid-cols-2"><Skeleton className="h-[268px] rounded-xl" /><Skeleton className="h-[268px] rounded-xl" /></div>
    </div>
  );
}

/** Memoised: the workbench re-renders with every session-list change, which says nothing new here. */
export const StatsPage = memo(function StatsPage({ state, sidebarCollapsed, onStateChange, onClose, onOpenSidebar, onExpandSidebar, onOpenSession }: {
  state: StatsUiState;
  sidebarCollapsed: boolean;
  onStateChange: (state: StatsUiState) => void;
  onClose: () => void;
  onOpenSidebar: () => void;
  onExpandSidebar: () => void;
  onOpenSession: (row: StatsRunRow) => void;
}) {
  const { t } = useLingui();
  const data = useStatsData(state);
  const dashboard = data.dashboard;
  const series = data.series && data.series.metric === state.metric && data.series.split === state.split
    ? data.series
    : dashboard && dashboard.series.metric === state.metric && dashboard.series.split === state.split
      ? dashboard.series
      : data.series ?? dashboard?.series;
  const exportFile = (format: 'csv' | 'json') => {
    void exportStats(statsFilterParams(state, new Date(), clientTimeZone()).toString(), format).catch((reason: unknown) => {
      toast.error(errorMessage(reason, t`导出失败`));
    });
  };
  const empty = dashboard && dashboard.summary.current.runs === 0 && dashboard.summary.current.sessions === 0 && dashboard.series.points.length === 0;
  const period = windowLabel(state, new Date());
  // Read again whenever the dashboard is: the same window, and fresh when it refreshes.
  const filterKey = statsFilterKey(state);
  const northWindow = useMemo(() => resolveWindow(state, new Date()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey, dashboard?.generatedAt]);
  const compare = previousWindowLabel(state, new Date());

  return (
    <PageScaffold
      title={<Trans>统计</Trans>}
      actions={dashboard && (
        <p className="min-w-0 truncate text-xs text-fg-4" role="status">
          <span className="max-md:hidden">{period} · </span>
          {data.refreshing ? t`更新中` : formatTimestamp(dashboard.generatedAt)}
        </p>
      )}
      column="board"
      /* The filter bar sticks to the scroller's top edge and brings its own top padding. */
      columnClassName="flex flex-col gap-4 pt-0 md:pt-0"
      sidebarCollapsed={sidebarCollapsed}
      onClose={onClose}
      onOpenSidebar={onOpenSidebar}
      onExpandSidebar={onExpandSidebar}
    >
      <FilterBar state={state} options={dashboard?.options} onChange={onStateChange} onExport={exportFile} />
      {data.loading && <StatsSkeleton />}
      {!dashboard && data.error && (
        <EmptyState className="py-16" icon={<IconCircleAlert />} title={t`无法加载统计`} description={data.error}>
          <Button size="sm" onClick={data.reload}><IconRefreshCw /><Trans>重试</Trans></Button>
        </EmptyState>
      )}
      <FeedbackNotice scope={`stats:${statsFilterKey(state)}`} message={dashboard && series && data.error}
        action={() => <Button size="xs" onClick={data.reload}><Trans>重试</Trans></Button>}
        renderMessage={(message, current) => current ? <Trans>{message.text}，仍显示上次的数据。</Trans> : message.text} />
      {dashboard && series && (
        <HighlightProvider>
          {empty && <p className="rounded-xl border border-line bg-subtle px-4 py-3 text-sm text-fg-3"><Trans>还没有可统计的会话。缺失的指标显示为「—」，不是 0。</Trans></p>}
          <NorthStar window={northWindow} timeZone={clientTimeZone()} />
          <KpiCards summary={dashboard.summary} series={series} compareLabel={compare} />
          <div className="grid items-stretch gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(260px,0.8fr)]">
            <AreaChart
              series={series}
              metric={state.metric}
              split={state.split}
              stale={series.metric !== state.metric || series.split !== state.split}
              onMetric={(metric) => onStateChange({ ...state, metric })}
              onSplit={(split) => onStateChange({ ...state, split })}
              onBrush={(from, to) => onStateChange({ ...state, preset: 'custom', from, to })}
            />
            <DonutChart breakdown={dashboard.backends} />
          </div>
          <CalendarHeatmap heatmap={dashboard.heatmap} />
          <div className="grid items-start gap-3 lg:grid-cols-2">
            <RankChart breakdown={dashboard.models} rank={state.rank} onRank={(rank) => onStateChange({ ...state, rank })} />
            <LatencyChart latency={data.latency} kind={state.latency} onKind={(latency) => onStateChange({ ...state, latency })} />
          </div>
          <div className="grid items-start gap-3 lg:grid-cols-2">
            <WeekHeatmap heatmap={dashboard.heatmap} />
            <ReliabilityChart breakdown={dashboard.backends} />
          </div>
          <ToolChart breakdown={dashboard.tools} />
          <RunsTable
            rows={data.runs}
            page={data.runsPage}
            pageSize={data.runsPageSize}
            hasNext={data.runsHasNext}
            loading={data.runsLoading}
            error={data.runsError}
            onPageChange={data.goToRunsPage}
            onPageSizeChange={data.setRunsPageSize}
            onRetry={data.retryRuns}
            onOpen={onOpenSession}
          />
        </HighlightProvider>
      )}
    </PageScaffold>
  );
});
