import type { StatsBreakdown } from '@contracts';
import { Trans, useLingui } from '@lingui/react/macro';
import { Segmented } from '@/components/ui/controls';
import { formatCount, formatSpeed, formatTokens } from '@/lib/stats-format';
import type { RankMetric } from '@/lib/stats-query';
import { seriesOpacity, sortBreakdown } from '@/lib/stats-series';
import { ChartCard, EmptyNote, ellipsizeMiddle, Unavailable, useHighlight, useRovingIndex } from './chart-shared';

export function RankChart({ breakdown, rank, onRank }: { breakdown: StatsBreakdown; rank: RankMetric; onRank: (rank: RankMetric) => void }) {
  const { t } = useLingui();
  const options: Array<{ value: RankMetric; label: string }> = [
    { value: 'tokens', label: 'Token' },
    { value: 'runs', label: t`轮次` },
    { value: 'speed', label: t`输出速度` },
  ];
  const { highlight, setHighlight } = useHighlight();
  const rows = sortBreakdown(breakdown.rows, rank).slice(0, 8);
  const { index, setIndex, onKeyDown } = useRovingIndex(rows.length);
  const amount = (row: (typeof rows)[number]) => rank === 'runs' ? row.count : rank === 'speed' ? row.outputTokensPerSecond?.p50 ?? null : row.totalTokens;
  const max = rows.reduce((best, row) => {
    const value = amount(row);
    return value != null && value > best ? value : best;
  }, 0);

  return (
    <ChartCard title={t`模型排行`} actions={<Segmented size="xs" ariaLabel={t({ message: '排序', context: 'stats-sort-control' })} value={rank} options={options} onChange={onRank} />}>
      {rows.length === 0 ? <EmptyNote><Trans>还没有模型数据</Trans></EmptyNote> : (
        <div role="listbox" aria-label={t`模型排行`} tabIndex={0} className="stats-chart flex flex-col gap-2.5 outline-none" onKeyDown={onKeyDown}>
          {rows.map((row, rowIndex) => {
            const value = amount(row);
            const width = value != null && max > 0 ? Math.max((value / max) * 100, 0.8) : 0;
            const label = value == null ? null : rank === 'runs' ? formatCount(value) : rank === 'speed' ? formatSpeed(value) : formatTokens(value);
            return (
              <div
                key={row.key}
                role="option"
                aria-selected={index === rowIndex}
                className="grid grid-cols-[minmax(0,10rem)_1fr_5.5rem] items-center gap-2"
                style={{ opacity: seriesOpacity(row, highlight) }}
                onMouseEnter={() => { setIndex(rowIndex); setHighlight(row); }}
                onMouseLeave={() => setHighlight(null)}
              >
                <span className="truncate text-xs text-fg-2" title={row.label}>{ellipsizeMiddle(row.label)}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]"
                    style={{ width: `${width}%`, background: 'var(--accent)' }}
                  />
                </span>
                <span className="text-right text-xs tabular-nums text-fg">{label ?? <Unavailable />}</span>
              </div>
            );
          })}
        </div>
      )}
    </ChartCard>
  );
}
