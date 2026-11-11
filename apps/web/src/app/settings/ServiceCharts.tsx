import type { ReactNode } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ServiceMonitorSample, ServiceMonitorSnapshot, ServiceRouteStat } from '@contracts';
import { area, curveMonotoneX, line } from 'd3-shape';
import { formatCount, formatDuration, formatPercent } from '@/lib/stats-format';
import { donutPath, donutSlices, linearTicks, nearestIndex, niceUpper } from '@/lib/stats-series';
import { formatClock } from '@/lib/utils';
import { ChartCard, ChartTooltip, EmptyNote, LegendItem, useElementSize, useRovingIndex } from '../stats/chart-shared';

/** The server keeps 30 minutes of 10-second buckets; the axis always spans the whole window. */
const WINDOW_MS = 30 * 60_000;
const BUCKET_MS = 10_000;

export interface TimeTrack {
  label: string;
  color: string;
  values: number[];
  format: (value: number) => string;
}

/**
 * The service's recent load against a fixed 30-minute axis: a primary measure drawn as bars or an
 * area on the left scale, an optional slice of it highlighted inside the bars (errors), and a
 * secondary line on its own right-hand scale. A pause longer than a few buckets is a gap, not a slope.
 */
export function TimeSeriesChart({ title, samples, primary, primaryKind, overlay, secondary, summary }: {
  title: string;
  samples: ServiceMonitorSample[];
  primary: TimeTrack;
  primaryKind: 'bar' | 'area';
  overlay?: TimeTrack;
  secondary?: TimeTrack;
  summary?: ReactNode;
}) {
  const { t } = useLingui();
  const { ref, width } = useElementSize<HTMLDivElement>();
  const { index, setIndex, onKeyDown } = useRovingIndex(samples.length);
  const height = 184;
  const margin = { top: 10, right: secondary ? 52 : 12, bottom: 24, left: 48 };
  const plotW = Math.max(0, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;
  const times = samples.map((sample) => sample.at);
  const end = times[times.length - 1] ?? Date.now();
  const start = end - WINDOW_MS;
  const xAt = (time: number) => ((time - start) / (end - start)) * plotW;
  const leftMax = niceUpper(Math.max(0, ...primary.values));
  const rightMax = secondary ? niceUpper(Math.max(0, ...secondary.values)) : 1;
  const yLeft = (value: number) => plotH - (Math.min(value, leftMax) / leftMax) * plotH;
  const yRight = (value: number) => plotH - (Math.min(value, rightMax) / rightMax) * plotH;
  const leftTicks = linearTicks(0, leftMax, 3);
  const rightTicks = secondary ? linearTicks(0, rightMax, 3) : [];
  // A restart or a sleeping laptop leaves a hole in the ring; draw it as one.
  const points = samples.flatMap((sample, sampleIndex) => {
    const previous = samples[sampleIndex - 1];
    const gap = previous && sample.at - previous.at > BUCKET_MS * 3;
    return gap ? [null, sampleIndex] : [sampleIndex];
  });
  const areaPath = area<number | null>().defined((point) => point != null).x((point) => xAt(times[point!]!)).y0(plotH).y1((point) => yLeft(primary.values[point!]!)).curve(curveMonotoneX)(points) ?? '';
  const edgePath = line<number | null>().defined((point) => point != null).x((point) => xAt(times[point!]!)).y((point) => yLeft(primary.values[point!]!)).curve(curveMonotoneX)(points) ?? '';
  const secondaryPath = secondary ? line<number | null>().defined((point) => point != null).x((point) => xAt(times[point!]!)).y((point) => yRight(secondary.values[point!]!)).curve(curveMonotoneX)(points) ?? '' : '';
  const barW = Math.max(1, (BUCKET_MS / WINDOW_MS) * plotW - 1);
  const active = index >= 0 ? samples[index] : undefined;
  const activeX = active ? xAt(active.at) : 0;
  const xLabels = [30, 20, 10, 0].map((minutes) => ({ minutes, x: xAt(end - minutes * 60_000) }));
  const tracks = [primary, overlay, secondary].filter((track): track is TimeTrack => Boolean(track));

  return (
    <ChartCard title={title} actions={summary}>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {tracks.map((track) => <LegendItem key={track.label} color={track.color}>{track.label}</LegendItem>)}
      </div>
      <div ref={ref} className="relative" style={{ height }}>
        {width > 0 && (
          <svg
            className="stats-chart h-full w-full outline-none"
            role="img"
            tabIndex={0}
            aria-label={t`${title}，最近 30 分钟。方向键逐个查看 10 秒区间。`}
            onKeyDown={onKeyDown}
            onMouseMove={(event) => {
              if (!samples.length || plotW <= 0) return;
              const x = event.clientX - event.currentTarget.getBoundingClientRect().left - margin.left;
              setIndex(nearestIndex(times, start + (Math.min(plotW, Math.max(0, x)) / plotW) * (end - start)));
            }}
            onMouseLeave={() => setIndex(-1)}
          >
            <g transform={`translate(${margin.left} ${margin.top})`}>
              {leftTicks.map((tick, tickIndex) => (
                <g key={tick}>
                  <line x1={0} x2={plotW} y1={yLeft(tick)} y2={yLeft(tick)} stroke="var(--line-soft)" strokeDasharray={tickIndex === 0 ? undefined : '3 4'} />
                  <text x={-8} y={yLeft(tick)} textAnchor="end" dominantBaseline="middle" className="fill-fg-4 text-2xs tabular-nums">{primary.format(tick)}</text>
                </g>
              ))}
              {secondary && rightTicks.map((tick) => (
                <text key={tick} x={plotW + 8} y={yRight(tick)} dominantBaseline="middle" className="fill-fg-4 text-2xs tabular-nums">{secondary.format(tick)}</text>
              ))}
              {primaryKind === 'bar' && samples.map((sample, sampleIndex) => {
                const value = primary.values[sampleIndex] ?? 0;
                if (value <= 0) return null;
                const x = xAt(sample.at) - barW;
                const top = yLeft(value);
                const slice = overlay ? Math.min(value, overlay.values[sampleIndex] ?? 0) : 0;
                return (
                  <g key={sample.at} opacity={active && active !== sample ? 0.55 : 1}>
                    <rect x={x} y={top} width={barW} height={plotH - top} rx={Math.min(1.5, barW / 2)} fill={primary.color} fillOpacity={0.75} />
                    {slice > 0 && <rect x={x} y={yLeft(slice)} width={barW} height={plotH - yLeft(slice)} fill={overlay!.color} />}
                  </g>
                );
              })}
              {primaryKind === 'area' && (
                <>
                  <path d={areaPath} fill={primary.color} fillOpacity={0.18} />
                  <path d={edgePath} fill="none" stroke={primary.color} strokeWidth={1.5} strokeLinejoin="round" />
                </>
              )}
              {secondary && <path d={secondaryPath} fill="none" stroke={secondary.color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />}
              <line x1={0} x2={plotW} y1={plotH} y2={plotH} stroke="var(--line)" />
              {xLabels.map((label, labelIndex) => (
                <text
                  key={label.minutes}
                  x={label.x}
                  y={plotH + 16}
                  textAnchor={labelIndex === 0 ? 'start' : labelIndex === xLabels.length - 1 ? 'end' : 'middle'}
                  className="fill-fg-4 text-2xs tabular-nums"
                >
                  {label.minutes === 0 ? <Trans>现在</Trans> : <Trans>{label.minutes} 分钟前</Trans>}
                </text>
              ))}
              {active && (
                <g pointerEvents="none">
                  <line x1={activeX} x2={activeX} y1={0} y2={plotH} stroke="var(--fg-4)" strokeDasharray="3 3" />
                  {primaryKind === 'area' && <circle cx={activeX} cy={yLeft(primary.values[index] ?? 0)} r={3} fill={primary.color} stroke="var(--bg-elevated)" strokeWidth={1.5} />}
                  {secondary && <circle cx={activeX} cy={yRight(secondary.values[index] ?? 0)} r={3} fill={secondary.color} stroke="var(--bg-elevated)" strokeWidth={1.5} />}
                </g>
              )}
            </g>
          </svg>
        )}
        {active && (
          <ChartTooltip x={Math.min(Math.max(8, width - 176), Math.max(8, margin.left + activeX + 12))} y={8}>
            <p className="mb-1 text-fg-3 tabular-nums">{formatClock(new Date(active.at).toISOString())}</p>
            {tracks.map((track) => (
              <p key={track.label} className="flex items-center justify-between gap-3 tabular-nums">
                <span className="inline-flex items-center gap-1.5 text-fg-2"><span className="size-1.5 rounded-full" style={{ background: track.color }} />{track.label}</span>
                <span>{track.format(track.values[index] ?? 0)}</span>
              </p>
            ))}
          </ChartTooltip>
        )}
        {samples.length === 0 && <div className="absolute inset-0 grid place-items-center"><EmptyNote><Trans>服务器刚启动，第一个 10 秒区间还没结束</Trans></EmptyNote></div>}
      </div>
    </ChartCard>
  );
}

const STATUS_CLASSES: ReadonlyArray<{ key: '2xx' | '3xx' | '4xx' | '5xx'; label: MessageDescriptor; color: string }> = [
  { key: '2xx', label: msg`2xx 成功`, color: 'var(--success)' },
  { key: '3xx', label: msg`3xx 重定向`, color: 'var(--chart-1)' },
  { key: '4xx', label: msg`4xx 客户端`, color: 'var(--warning)' },
  { key: '5xx', label: msg`5xx 服务器`, color: 'var(--danger)' },
];

/** Every finished request since the service started, by status class. */
export function StatusDonut({ byStatus }: { byStatus: ServiceMonitorSnapshot['requests']['byStatus'] }) {
  const { t } = useLingui();
  const classes = STATUS_CLASSES.map((item) => ({ ...item, label: i18n._(item.label) }));
  const slices = donutSlices(classes.map((item) => ({ key: item.key, label: item.label, value: byStatus[item.key] })));
  const total = classes.reduce((sum, item) => sum + byStatus[item.key], 0);
  const color = (key: string) => STATUS_CLASSES.find((item) => item.key === key)!.color;
  const size = 132;
  // An aria-label lists the slices aloud; the separator belongs to the language.
  const listSeparator = t`，`;
  return (
    <ChartCard title={t`状态码分布`}>
      {total === 0 ? <EmptyNote><Trans>还没有完成的请求</Trans></EmptyNote> : (
        <div className="flex flex-1 flex-wrap items-center justify-center gap-x-6 gap-y-4">
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={classes.map((item) => `${item.label} ${formatCount(byStatus[item.key])}`).join(listSeparator)} className="shrink-0">
            <g transform={`translate(${size / 2} ${size / 2})`}>
              {slices.map((slice) => <path key={slice.key} d={donutPath(slice, 42, 62)} fill={color(slice.key)} stroke="var(--bg-elevated)" strokeWidth={1}><title>{`${slice.label} ${formatCount(slice.value)}`}</title></path>)}
            </g>
            <text x={size / 2} y={size / 2 - 2} textAnchor="middle" className="fill-fg text-base font-semibold tabular-nums">{formatCount(total)}</text>
            <text x={size / 2} y={size / 2 + 15} textAnchor="middle" className="fill-fg-3 text-2xs"><Trans>请求</Trans></text>
          </svg>
          <ul className="flex min-w-36 flex-col gap-1.5">
            {classes.map((item) => (
              <li key={item.key} className="flex items-center justify-between gap-4 text-xs">
                <LegendItem color={item.color}>{item.label}</LegendItem>
                <span className="tabular-nums text-fg-2">{formatCount(byStatus[item.key])}<span className="ml-1.5 text-fg-4">{formatPercent(byStatus[item.key] / total)}</span></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ChartCard>
  );
}

/** The busiest routes, as a ranked bar each with its 5xx share and latency underneath. */
export function RouteRank({ routes }: { routes: ServiceRouteStat[] }) {
  const { t } = useLingui();
  const rows = [...routes].sort((a, b) => b.count - a.count).slice(0, 8);
  const max = rows[0]?.count ?? 0;
  return (
    <ChartCard title={t`热门接口`}>
      {rows.length === 0 ? <EmptyNote><Trans>还没有完成的请求</Trans></EmptyNote> : (
        <ol className="flex flex-col gap-2.5">
          {rows.map((row) => {
            const width = max > 0 ? Math.max((row.count / max) * 100, 0.8) : 0;
            const failed = row.count > 0 ? (row.errors / row.count) * 100 : 0;
            return (
              <li key={`${row.method} ${row.route}`} className="flex min-w-0 flex-col gap-1">
                <div className="flex min-w-0 items-baseline gap-2 text-xs">
                  <span className="w-12 shrink-0 font-mono text-2xs text-fg-4">{row.method}</span>
                  <span className="min-w-0 truncate font-mono text-fg-2" title={`${row.method} ${row.route}`}>{row.route}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-fg">{formatCount(row.count)}</span>
                </div>
                <div className="flex min-w-0 items-center gap-2 pl-14">
                  <span className="h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-muted">
                    <span className="flex h-full transition-[width] duration-[var(--duration-medium)] ease-[var(--ease-out-soft)]" style={{ width: `${width}%` }}>
                      {row.errors > 0 && <span className="h-full" style={{ width: `${failed}%`, background: 'var(--danger)' }} />}
                      <span className="h-full flex-1 rounded-r-full" style={{ background: 'var(--accent)' }} />
                    </span>
                  </span>
                  <span className="shrink-0 text-2xs tabular-nums text-fg-4">
                    <Trans>均 {formatDuration(row.avgMs)} · p95 {formatDuration(row.p95Ms)}</Trans>
                    {row.errors > 0 && <span className="text-danger"><Trans> · 5xx {formatCount(row.errors)}</Trans></span>}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </ChartCard>
  );
}
