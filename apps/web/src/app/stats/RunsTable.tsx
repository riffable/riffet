import { useEffect, useRef } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { StatsRunRow } from '@contracts';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { useBackendLabel } from '@/lib/backends';
import { runStateLabel, formatDuration, formatExactTimestamp, formatRowTime, tokensDisplay } from '@/lib/stats-format';
import { seriesColor } from '@/lib/stats-series';
import { cn } from '@/lib/utils';
import { EmptyNote, EstimatedMark, Unavailable } from './chart-shared';
import { STATS_RUN_PAGE_SIZES } from './runs-pagination';

type ColumnKey = 'time' | 'session' | 'project' | 'agent' | 'model' | 'state' | 'tokens' | 'duration' | 'ttft';

/** The five measuring columns are right-aligned so their digits line up down the table. */
const NUMERIC = new Set<ColumnKey>(['tokens', 'duration', 'ttft']);

const HEAD_CLASS = 'sticky top-0 z-20 bg-subtle px-3 py-2 text-xs font-medium text-fg-3 first:pl-4 last:pr-4';
const CELL_CLASS = 'border-t border-line-soft px-3 py-2 align-middle first:pl-4 last:pr-4';

function AgentLabel({ backendId }: { backendId: StatsRunRow['backendId'] }) {
  const label = useBackendLabel();
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full max-md:hidden" style={{ background: seriesColor({ key: backendId, backendId }, 0) }} />
      <span className="truncate">{label(backendId)}</span>
    </span>
  );
}

/**
 * The drill-down table. It reads as one surface with the card it sits in: the header is tinted and
 * sticks inside the bounded table viewport, separators are hairlines inside the table rather than a border
 * per row, and the numeric columns share one right edge.
 */
export function RunsTable({ rows, page, pageSize, hasNext, loading, error, onPageChange, onPageSizeChange, onRetry, onOpen }: {
  rows: StatsRunRow[];
  page: number;
  pageSize: number;
  hasNext: boolean;
  loading: boolean;
  error: string;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onRetry: () => void;
  onOpen: (row: StatsRunRow) => void;
}) {
  const { t } = useLingui();
  const columns: Array<{ key: ColumnKey; label: string }> = [
    { key: 'time', label: t`时间` },
    { key: 'session', label: t({ message: '会话', context: 'stats-session-column' }) },
    { key: 'project', label: t`项目` },
    { key: 'agent', label: 'Agent' },
    { key: 'model', label: t`模型` },
    { key: 'state', label: t({ message: '状态', context: 'stats-state-column' }) },
    { key: 'tokens', label: 'Token' },
    { key: 'duration', label: t`耗时` },
    { key: 'ttft', label: t`首字延迟` },
  ];
  const viewport = useRef<HTMLDivElement>(null);
  const now = new Date();
  const firstRow = (page - 1) * pageSize + 1;
  const lastRow = firstRow + rows.length - 1;
  useEffect(() => {
    // Flipping a page resets just the table, without jumping past the dashboard above it.
    if (viewport.current) viewport.current.scrollTop = 0;
  }, [page, pageSize]);

  return (
    <section aria-busy={loading} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-elevated">
      <div className="flex min-h-8 items-center justify-between gap-3 px-4 pt-3 max-md:px-3">
        <h2 className="text-sm font-medium leading-5 text-fg"><Trans>明细</Trans></h2>
        <p className="text-xs tabular-nums text-fg-3" role="status">
          {loading ? t`正在读取…` : rows.length > 0 ? t`第 ${firstRow}–${lastRow} 轮` : error ? t`读取失败` : t`0 轮`}
        </p>
      </div>
      {rows.length === 0 ? <EmptyNote>{loading ? t`正在读取轮次` : error ? t`明细暂时无法读取` : page > 1 ? t`本页暂无记录，可以返回上一页` : t`这个范围里没有轮次`}</EmptyNote> : (
        <div ref={viewport} className="mt-2 max-h-[32rem] overflow-auto overscroll-contain" tabIndex={0} role="region" aria-label={t`当前页明细`}>
          <table className="w-full min-w-[780px] border-separate border-spacing-0 text-left text-sm">
            <thead className="[&_th]:border-b [&_th]:border-line">
              <tr>
                {columns.map(({ key, label }) => (
                  <th
                    key={key}
                    scope="col"
                    className={cn(
                      HEAD_CLASS,
                      NUMERIC.has(key) && 'text-right tabular-nums',
                      key === 'session' && 'border-r border-r-line-soft',
                    )}
                  >
                    <span className="whitespace-nowrap">{label}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const tokens = tokensDisplay(row.tokens, row.totalTokens);
                const sessionTitle = row.sessionTitle || t`未命名会话`;
                return (
                  <tr
                    key={row.runId}
                    tabIndex={0}
                    aria-label={t`${formatExactTimestamp(row.createdAt)} ${sessionTitle}`}
                    className="cursor-pointer outline-none hover:bg-hover focus-visible:bg-active"
                    onClick={() => onOpen(row)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      onOpen(row);
                    }}
                  >
                    <td className={cn(CELL_CLASS, 'text-xs tabular-nums text-fg-3')}>
                      <Tip label={formatExactTimestamp(row.createdAt)}><span className="cursor-default whitespace-nowrap">{formatRowTime(row.createdAt, now)}</span></Tip>
                    </td>
                    <td className={cn(CELL_CLASS, 'max-w-56 truncate')}>
                      {sessionTitle}
                    </td>
                    <td className={cn(CELL_CLASS, 'max-w-36 truncate text-fg-2')}>{row.projectName}</td>
                    <td className={CELL_CLASS}><AgentLabel backendId={row.backendId} /></td>
                    <td className={cn(CELL_CLASS, 'max-w-36 truncate text-fg-2')}>
                      {row.model ? (row.rawModel ? <Tip label={row.rawModel}><span className="cursor-default">{row.model}</span></Tip> : row.model) : <Unavailable />}
                    </td>
                    <td className={cn(CELL_CLASS, 'whitespace-nowrap text-fg-2')}>{runStateLabel(row.state)}</td>
                    <td className={cn(CELL_CLASS, 'text-right tabular-nums')}>{tokens.unavailable ? <Unavailable /> : <span className="inline-flex items-center gap-1">{tokens.text}{tokens.estimated && <EstimatedMark />}</span>}</td>
                    <td className={cn(CELL_CLASS, 'text-right tabular-nums')}>{formatDuration(row.durationMs)}</td>
                    <td className={cn(CELL_CLASS, 'text-right tabular-nums text-fg-2')}>{formatDuration(row.ttftMs)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {error && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line-soft px-4 py-2 text-xs text-danger" role="alert">
          <span>{error}</span>
          <Button size="xs" variant="ghost" disabled={loading} onClick={onRetry}><Trans>重试</Trans></Button>
        </div>
      )}
      <nav aria-label={t`明细分页`} className="flex flex-wrap items-center justify-between gap-3 border-t border-line-soft px-4 py-3 max-md:px-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="quiet" disabled={loading} aria-label={t`每页 ${pageSize} 条`}>
              <Trans>每页 {pageSize} 条</Trans>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-32">
            <DropdownMenuRadioGroup value={String(pageSize)} onValueChange={(value) => onPageSizeChange(Number(value))}>
              {STATS_RUN_PAGE_SIZES.map((size) => <DropdownMenuRadioItem key={size} value={String(size)}><Trans>{size} 条</Trans></DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="secondary" disabled={loading || page <= 1} onClick={() => onPageChange(page - 1)}><Trans context="stats-pagination-previous">上一页</Trans></Button>
          <span className="px-1 text-xs text-fg-3 tabular-nums" aria-current="page"><Trans>第 {page} 页</Trans></span>
          <Button size="sm" variant="secondary" disabled={loading || !hasNext} onClick={() => onPageChange(page + 1)}><Trans context="stats-pagination-next">下一页</Trans></Button>
        </div>
      </nav>
    </section>
  );
}
