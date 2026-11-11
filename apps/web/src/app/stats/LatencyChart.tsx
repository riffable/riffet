import type { StatsLatency } from '@contracts';
import { scaleLinear } from 'd3-scale';
import { useEffect, useRef } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Segmented } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { formatDuration, formatSpeed } from '@/lib/stats-format';
import type { LatencyMetric } from '@/lib/stats-query';
import { latencyOf, linearTicks, niceUpper } from '@/lib/stats-series';
import { ChartCard, EmptyNote, ellipsizeMiddle, useHighlight, useRovingIndex } from './chart-shared';

/**
 * One row per model with its own name and median, laid out like `模型排行` beside it. The rows do
 * not follow that chart's order or count, so a row must never rely on its neighbour for its name.
 * Past eight rows the list scrolls, keeping the card level with the ranking.
 */
export function LatencyChart({ latency, kind, onKind }: { latency: StatsLatency | undefined; kind: LatencyMetric; onKind: (kind: LatencyMetric) => void }) {
  const { t } = useLingui();
  const options: Array<{ value: LatencyMetric; label: string }> = [
    { value: 'ttft', label: t`首字延迟` },
    { value: 'duration', label: t`整轮耗时` },
    { value: 'speed', label: t`输出速度` },
  ];
  const { setHighlight } = useHighlight();
  const rows = (latency?.rows ?? []).filter((row) => latencyOf(row, kind));
  const { index, setIndex, onKeyDown } = useRovingIndex(rows.length);
  const format = kind === 'speed' ? formatSpeed : formatDuration;
  const max = niceUpper(rows.reduce((best, row) => Math.max(best, latencyOf(row, kind)?.p99 ?? 0), 0));
  const ticks = linearTicks(0, max, 3);
  const windows = [...new Set(rows.flatMap((row) => row.windows ?? []))];
  const active = index >= 0 ? rows[index] : undefined;
  const activeSample = active ? latencyOf(active, kind) : null;
  const unmeasured = latency ? latency.rows.length - rows.length : 0;
  const listRef = useRef<HTMLDivElement>(null);
  // Keyboard focus can move past the visible rows of the scrolling list.
  useEffect(() => {
    if (index >= 0) listRef.current?.children[index]?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  return (
    <ChartCard
      title={t`延迟与速度`}
      actions={<Segmented size="xs" ariaLabel={t`延迟指标`} value={kind} options={options} onChange={onKind} />}
    >
      {!latency ? <EmptyNote><Trans>延迟还在加载</Trans></EmptyNote> : rows.length === 0 ? <EmptyNote><Trans>这些模型没有这项测量</Trans></EmptyNote> : (
        <>
          <div ref={listRef} role="listbox" aria-label={t`按模型的分位数`} tabIndex={0} className="stats-chart flex max-h-[208px] flex-col overflow-y-auto outline-none" onKeyDown={onKeyDown}>
            {rows.map((row, rowIndex) => {
              const sample = latencyOf(row, kind);
              if (!sample) return null;
              const scale = scaleLinear().domain([0, max]).range([0, 100]);
              const start = scale(Math.min(sample.p50, sample.p90));
              const end = scale(Math.max(sample.p50, sample.p90));
              return (
                <div
                  key={row.key}
                  role="option"
                  aria-label={t`${row.label}，p50 ${format(sample.p50)}，p90 ${format(sample.p90)}，p99 ${format(sample.p99)}`}
                  aria-selected={index === rowIndex}
                  className="grid h-[26px] shrink-0 grid-cols-[minmax(0,10rem)_1fr_5.5rem] items-center gap-2"
                  onMouseEnter={() => { setIndex(rowIndex); setHighlight(row); }}
                  onMouseLeave={() => setHighlight(null)}
                >
                  <span className="truncate text-xs text-fg-2" title={row.label}>{ellipsizeMiddle(row.label)}</span>
                  <span className="relative h-full">
                    {/* The scale sits behind the bars, the way the trend chart draws its own grid; rows
                        have no gap between them so the lines read as continuous. */}
                    <span aria-hidden className="pointer-events-none absolute inset-0 flex justify-between">
                      {ticks.map((tick) => <span key={tick} className="w-px bg-line-soft" />)}
                    </span>
                    <span
                      className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full transition-[left,width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]"
                      style={{ left: `${start}%`, width: `${Math.max(end - start, 1.2)}%`, background: 'var(--accent)' }}
                    />
                    <span className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-fg-3" style={{ left: `${scale(sample.p99)}%` }} />
                  </span>
                  <span className="text-right text-xs tabular-nums text-fg">{format(sample.p50)}</span>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-2xs text-fg-4">
            <span className="inline-flex items-center gap-3">
              <span className="inline-flex items-center gap-1"><span aria-hidden className="inline-block h-1.5 w-4 rounded-full bg-fg-4" />p50–p90</span>
              <span className="inline-flex items-center gap-1"><span aria-hidden className="inline-block h-3 w-px bg-fg-3" />p99</span>
            </span>
            <span className="tabular-nums">{format(0)} – {format(max)}</span>
          </div>
          {kind === 'speed' && windows.length > 0 && (
            <Tip label={t`速度窗口：${windows.join(' · ')}`}>
              <p className="w-fit cursor-help text-2xs text-fg-4"><Trans>速度窗口 {windows.length} 种</Trans></p>
            </Tip>
          )}
          {active && activeSample && (
            <p className="truncate text-xs tabular-nums text-fg-3">
              <Trans>{active.label} · p50 {format(activeSample.p50)} · p90 {format(activeSample.p90)} · p99 {format(activeSample.p99)} · {activeSample.samples} 个样本</Trans>
            </p>
          )}
        </>
      )}
      {latency && latency.rows.length > rows.length && (
        <Tip label={t`这些模型没有这项测量。缺失不按 0 计入。`}>
          <p className="w-fit cursor-help text-2xs text-fg-4"><Trans>另有 {unmeasured} 个模型未测量</Trans></p>
        </Tip>
      )}
    </ChartCard>
  );
}
