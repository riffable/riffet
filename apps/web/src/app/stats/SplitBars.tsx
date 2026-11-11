import type { StatsBreakdown } from '@contracts';
import { Trans, useLingui } from '@lingui/react/macro';
import { formatCount } from '@/lib/stats-format';
import { seriesOpacity } from '@/lib/stats-series';
import { ChartCard, EmptyNote, LegendItem, useHighlight, useRovingIndex } from './chart-shared';

const STATE_COLOR = {
  completed: 'var(--success)',
  failed: 'var(--danger)',
  cancelled: 'var(--fg-4)',
  interrupted: 'var(--warning)',
} as const;

const STATES = ['completed', 'failed', 'cancelled', 'interrupted'] as const;

export function ToolChart({ breakdown }: { breakdown: StatsBreakdown }) {
  const { t } = useLingui();
  const { highlight, setHighlight } = useHighlight();
  const rows = [...breakdown.rows].sort((a, b) => b.count - a.count).slice(0, 8);
  const max = rows.reduce((best, row) => Math.max(best, row.count), 0);
  const { index, setIndex, onKeyDown } = useRovingIndex(rows.length);
  return (
    <ChartCard title={t`工具`}>
      {rows.length === 0 ? <EmptyNote><Trans>还没有工具调用</Trans></EmptyNote> : (
        <div role="listbox" aria-label={t`工具分布`} tabIndex={0} className="stats-chart flex flex-col gap-2.5 outline-none" onKeyDown={onKeyDown}>
          {rows.map((row, rowIndex) => {
            const failed = row.failed ?? 0;
            const width = max > 0 ? (row.count / max) * 100 : 0;
            const failedWidth = row.count > 0 ? (failed / row.count) * 100 : 0;
            return (
              <div
                key={row.key}
                role="option"
                aria-selected={index === rowIndex}
                className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-2"
                style={{ opacity: seriesOpacity(row, highlight) }}
                onMouseEnter={() => { setIndex(rowIndex); setHighlight(row); }}
                onMouseLeave={() => setHighlight(null)}
              >
                <span className="truncate text-xs text-fg-2">{row.label}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <span className="flex h-full transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]" style={{ width: `${Math.max(width, 0.8)}%` }}>
                    {failed > 0 && <span className="h-full" style={{ width: `${failedWidth}%`, background: 'var(--danger)' }} />}
                    <span className="h-full flex-1" style={{ background: 'var(--accent)' }} />
                  </span>
                </span>
                <span className="text-right text-xs tabular-nums text-fg">
                  {formatCount(row.count)}
                  {failed > 0 && <span className="text-danger"> · {formatCount(failed)}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {rows.some((row) => (row.failed ?? 0) > 0) && (
        <span className="flex gap-3">
          <LegendItem color="var(--danger)"><Trans>失败调用</Trans></LegendItem>
        </span>
      )}
    </ChartCard>
  );
}

export function ReliabilityChart({ breakdown }: { breakdown: StatsBreakdown }) {
  const { t } = useLingui();
  const stateLabel: Record<(typeof STATES)[number], string> = {
    completed: t({ message: '完成', context: 'stats-status-completed' }),
    failed: t`失败`,
    cancelled: t({ message: '取消', context: 'stats-status-cancelled' }),
    interrupted: t({ message: '中断', context: 'stats-status-interrupted' }),
  };
  const { setHighlight } = useHighlight();
  const rows = breakdown.rows.filter((row) => STATES.reduce((sum, state) => sum + row.states[state], 0) > 0);
  const { index, setIndex, onKeyDown } = useRovingIndex(rows.length);
  return (
    <ChartCard title={t`结束状态`}>
      {rows.length === 0 ? <EmptyNote><Trans>还没有已结束的轮次</Trans></EmptyNote> : (
        <>
          <div role="listbox" aria-label={t`各 Agent 的结束状态`} tabIndex={0} className="stats-chart flex flex-col gap-2.5 outline-none" onKeyDown={onKeyDown}>
            {rows.map((row, rowIndex) => {
              const total = STATES.reduce((sum, state) => sum + row.states[state], 0);
              return (
                <div
                  key={row.key}
                  role="option"
                  aria-selected={index === rowIndex}
                  className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-2"
                  onMouseEnter={() => { setIndex(rowIndex); setHighlight(row); }}
                  onMouseLeave={() => setHighlight(null)}
                >
                  <span className="truncate text-xs text-fg-2">{row.label}</span>
                  <span className="flex h-1.5 overflow-hidden rounded-full">
                    {STATES.map((state) => (
                      <span
                        key={state}
                        className="h-full transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]"
                        style={{ width: `${(row.states[state] / total) * 100}%`, background: STATE_COLOR[state] }}
                      />
                    ))}
                  </span>
                  <span className="text-right text-xs tabular-nums text-fg-2">{formatCount(total)}</span>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {STATES.map((state) => <LegendItem key={state} color={STATE_COLOR[state]}>{stateLabel[state]}</LegendItem>)}
          </div>
        </>
      )}
    </ChartCard>
  );
}
