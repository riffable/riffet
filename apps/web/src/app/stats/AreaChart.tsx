import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { interpolateNumber } from 'd3-interpolate';
import { Trans, useLingui } from '@lingui/react/macro';
import type { StatsSeries, StatsSeriesMetric, StatsSplit } from '@contracts';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { formatBucket, formatCount, formatDuration, formatTokens } from '@/lib/stats-format';
import { useTheme } from '@/lib/theme';
import { brushRange, flatDashPath, gapPath, linearTicks, nearestIndex, niceUpper, resampleTime, seriesColors, seriesOpacity, stackAreaPath, stackLinePath, stackSeries, tweenLayers, type TweenLayer } from '@/lib/stats-series';
import { ChartCard, ChartTooltip, EmptyNote, SeriesLegend, useElementSize, useHighlight, useReducedMotion, useRovingIndex } from './chart-shared';

/** Long enough to read as a morph between two shapes; short enough not to lag a filter change. */
const MORPH_MS = 460;

function formatPoint(metric: StatsSeriesMetric, value: number | null): string {
  if (value == null) return '—';
  if (metric === 'runs' || metric === 'sessions') return formatCount(value);
  if (metric === 'durationMs') return formatDuration(value);
  return formatTokens(value);
}

interface Frame { starts: number[]; layers: TweenLayer[]; yMax: number }
interface VisibleFrame { frame: Frame; opacity: number }

/** Missing buckets remain gaps. When the missing-data pattern changes, use a cross-fade so the
 * chart never invents intermediate measurements to make a point-by-point morph appear continuous. */
function frameOf(series: StatsSeries): Frame {
  const stacked = stackSeries(series);
  return { starts: stacked.starts, layers: tweenLayers(series), yMax: niceUpper(stacked.max) };
}

function sameGeometry(a: Frame, b: Frame): boolean {
  if (a.starts.length !== b.starts.length || a.layers.length !== b.layers.length) return false;
  if (!a.starts.every((start, index) => start === b.starts[index])) return false;
  return a.layers.every((layer, index) => {
    const next = b.layers[index];
    if (!next || layer.key !== next.key || layer.y0.length !== next.y0.length || layer.y1.length !== next.y1.length) return false;
    return layer.y0.every((value, point) => (value == null) === (next.y0[point] == null))
      && layer.y1.every((value, point) => (value == null) === (next.y1[point] == null));
  });
}

function useMorph(series: StatsSeries, reduced: boolean): { frame: Frame; visible: VisibleFrame[] } {
  const next = useMemo(() => frameOf(series), [series]);
  const [visible, setVisible] = useState<VisibleFrame[]>(() => [{ frame: next, opacity: 1 }]);
  const visibleRef = useRef(visible);
  const [frame, setFrame] = useState(next);
  const previousTargetRef = useRef(next);

  useEffect(() => {
    const changed = previousTargetRef.current !== next;
    previousTargetRef.current = next;
    if (reduced) {
      const settled = [{ frame: next, opacity: 1 }];
      visibleRef.current = settled;
      setVisible(settled);
      setFrame(next);
      return;
    }
    if (!changed) return;

    const fromVisible = visibleRef.current;
    const stable = fromVisible.length === 1 && fromVisible[0]!.opacity >= 0.999;
    const from = stable ? fromVisible[0]!.frame : null;
    if (from && sameGeometry(from, next)) {
      const lerpMax = interpolateNumber(from.yMax, next.yMax);
      const started = performance.now();
      let handle = 0;
      const tick = (now: number) => {
        const t = Math.min(1, (now - started) / MORPH_MS);
        const eased = 1 - (1 - t) ** 3;
        const current: Frame = {
          starts: next.starts,
          yMax: lerpMax(eased),
          layers: next.layers.map((layer, index) => {
            const before = from.layers[index]!;
            return { ...layer, y0: mix(before.y0, layer.y0, eased), y1: mix(before.y1, layer.y1, eased) };
          }),
        };
        const showing = [{ frame: current, opacity: 1 }];
        visibleRef.current = showing;
        setVisible(showing);
        setFrame(current);
        if (t < 1) handle = requestAnimationFrame(tick);
        else {
          const settled = [{ frame: next, opacity: 1 }];
          visibleRef.current = settled;
          setVisible(settled);
          setFrame(next);
        }
      };
      handle = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(handle);
    }
    // Different series, timestamps, or gaps have no honest point-by-point morph. Keep the exact
    // currently visible composition as the outgoing side so an interrupted fade does not jump back
    // to its previous target.
    const outgoing = fromVisible;
    setFrame(next);
    const started = performance.now();
    let handle = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / 280);
      const eased = 1 - (1 - t) ** 3;
      const showing = [
        ...outgoing.map((entry) => ({ ...entry, opacity: entry.opacity * (1 - eased) })).filter((entry) => entry.opacity > 0.001),
        ...(eased > 0.001 ? [{ frame: next, opacity: eased }] : []),
      ];
      visibleRef.current = showing;
      setVisible(showing);
      if (t < 1) handle = requestAnimationFrame(tick);
      else {
        const settled = [{ frame: next, opacity: 1 }];
        visibleRef.current = settled;
        setVisible(settled);
      }
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [next, reduced]);
  return { frame, visible };
}

function mix(from: Array<number | null>, to: Array<number | null>, t: number): Array<number | null> {
  return to.map((value, index) => {
    const before = from[index] ?? null;
    if (value == null || before == null) return value;
    return before + (value - before) * t;
  });
}

/** Miniature of the same stack, sized for the brush strip so the reader sees the year at a glance. */
function stripBars(series: StatsSeries, width: number, bars: number): Array<{ x: number; w: number; h: number }> {
  const totals: Array<number | null> = series.points.map((point) => {
    const numbers = Object.values(point.values).filter((value) => typeof value === 'number' && Number.isFinite(value));
    return numbers.length ? numbers.reduce((sum, value) => sum + Math.max(0, value), 0) : null;
  });
  if (!totals.some((value) => value != null && value > 0)) return [];
  const values = resampleTime(series.points.map((point) => Date.parse(point.start)), totals, bars);
  const max = values.reduce<number>((best, value) => (value != null && value > best ? value : best), 0);
  if (max <= 0) return [];
  const step = width / bars;
  return values.flatMap((value, index) => (value == null || value <= 0 ? [] : [{ x: index * step, w: Math.max(step - 0.5, 0.5), h: Math.max((value / max) * 100, 4) }]));
}

/** Memoised: moving the crosshair re-renders the chart, and a settled frame's paths do not change with it. */
const Paths = memo(function Paths({ frame, width, height, highlight, fillOpacity, dashed }: { frame: Frame; width: number; height: number; highlight: ReturnType<typeof useHighlight>['highlight']; fillOpacity: number; dashed?: boolean }) {
  const palette = seriesColors(frame.layers);
  return (
    <g>
      {frame.layers.map((layer) => {
        const color = palette.get(layer.key);
        const opacity = seriesOpacity(layer, highlight);
        return (
          <g key={layer.key} style={{ opacity, transition: 'opacity 160ms linear' }}>
            <path d={stackAreaPath(layer.y0, layer.y1, width, height, frame.yMax, frame.starts)} fill={color} fillOpacity={fillOpacity} />
          </g>
        );
      })}
      {/* Draw boundaries after every fill so thin stacked layers keep their own readable edge. */}
      {frame.layers.map((layer) => {
        const color = palette.get(layer.key);
        const opacity = seriesOpacity(layer, highlight);
        return (
          <g key={`${layer.key}-edge`} style={{ opacity, transition: 'opacity 160ms linear' }}>
            <path d={stackLinePath(layer.y1, width, height, frame.yMax, frame.starts)} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
            <path d={gapPath(layer.y0, layer.y1, width, height, frame.yMax, frame.starts)} fill="none" stroke={color} strokeWidth={1} strokeDasharray="2 3" opacity={highlight ? 0.8 : 0.5} />
            {/* A group measured once is a dash at its own level, never a slope between two guesses. */}
            {!dashed && <path d={flatDashPath(layer.y1, width, height, frame.yMax, 3, frame.starts)} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" />}
          </g>
        );
      })}
    </g>
  );
});

function ChartPicker<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  const { t } = useLingui();
  const selected = options.find((option) => option.value === value)?.label ?? value;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t`${label}：${selected}`}
        className="inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-2 text-xs text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus data-[state=open]:bg-hover data-[state=open]:text-fg"
      >
        <span className="shrink-0 text-fg-4">{label}</span>
        <span className="max-w-24 truncate">{selected}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
          {options.map((option) => <DropdownMenuRadioItem key={option.value} value={option.value}>{option.label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AreaChart({ series, metric, split, stale, onMetric, onSplit, onBrush }: {
  series: StatsSeries;
  metric: StatsSeriesMetric;
  split: StatsSplit;
  stale: boolean;
  onMetric: (metric: StatsSeriesMetric) => void;
  onSplit: (split: StatsSplit) => void;
  onBrush: (from: string, to: string) => void;
}) {
  const { t } = useLingui();
  const metrics: Array<{ value: StatsSeriesMetric; label: string }> = [
    { value: 'totalTokens', label: t`总 token` },
    { value: 'inputTokens', label: t`输入` },
    { value: 'outputTokens', label: t`输出` },
    { value: 'cacheReadTokens', label: t`缓存读` },
    { value: 'runs', label: t`轮次` },
  ];
  const splits: Array<{ value: StatsSplit; label: string }> = [
    { value: 'backend', label: 'Agent' },
    { value: 'model', label: t`模型` },
    { value: 'project', label: t`项目` },
  ];
  const reduced = useReducedMotion();
  const { resolved } = useTheme();
  const { highlight } = useHighlight();
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ start: number; end: number } | null>(null);
  const { frame, visible } = useMorph(series, reduced);
  const stacked = useMemo(() => stackSeries(series), [series]);
  const { index, setIndex, onKeyDown } = useRovingIndex(series.points.length);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const margin = { top: 10, right: 10, bottom: 44, left: 52 };
  const plotW = Math.max(0, width - margin.left - margin.right);
  const plotH = Math.max(0, height - margin.top - margin.bottom);
  const brushH = 18;
  const areaH = Math.max(0, plotH - brushH - 12);
  const yMax = frame.yMax;
  const ticks = linearTicks(0, yMax, 4);
  const start = stacked.starts[0] ?? 0;
  const end = stacked.starts[stacked.starts.length - 1] ?? start;
  // Only the two ends: a tick in the middle lands on a bucket nobody asked about, and its label
  // would be clamped against the edge on a narrow card anyway.
  const xTicks = start === end ? [new Date(start)] : [new Date(start), new Date(end)];
  const xAt = (time: number) => end > start ? ((time - start) / (end - start)) * plotW : plotW / 2;
  const yAt = (value: number) => areaH - (value / yMax) * areaH;
  const active = index >= 0 ? series.points[index] : undefined;
  const activeX = active ? xAt(stacked.starts[index] ?? start) : 0;
  const palette = useMemo(() => seriesColors(series.keys), [series.keys]);
  const legend = series.keys.map((key) => ({ ...key, color: palette.get(key.key)! }));
  const empty = series.points.length === 0 || stacked.totals.every((total) => total == null);
  const bars = plotW > 0 ? Math.max(12, Math.min(90, Math.round(plotW / 6))) : 0;
  const strip = useMemo(() => bars ? stripBars(series, plotW, bars) : [], [series, plotW, bars]);

  const localX = (clientX: number) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || plotW <= 0) return 0;
    return clientX - box.left - margin.left;
  };

  const moveCursor = (clientX: number, bounds: DOMRect) => {
    if (end <= start || !series.points.length) return;
    const x = clientX - bounds.left - margin.left;
    const time = start + (Math.min(plotW, Math.max(0, x)) / plotW) * (end - start);
    setIndex(nearestIndex(stacked.starts, time));
  };

  return (
    <ChartCard
      title={t`趋势`}
      actions={(
        <div className="flex min-w-0 items-center gap-0.5">
          <ChartPicker label={t`拆分`} value={split} options={splits} onChange={onSplit} />
          <ChartPicker label={t`指标`} value={metric} options={metrics} onChange={onMetric} />
        </div>
      )}
    >
      <SeriesLegend items={legend} />
      <div ref={ref} className="relative h-[280px] sm:h-[320px]" style={{ opacity: stale ? 0.72 : 1 }}>
        {width > 0 && (
          <svg
            ref={svgRef}
            className="stats-chart h-full w-full outline-none"
            role="img"
            tabIndex={0}
            aria-label={t`用量趋势。方向键移动十字线，在底部条带上拖动可缩小时间范围。`}
            onKeyDown={onKeyDown}
            onMouseMove={(event) => moveCursor(event.clientX, event.currentTarget.getBoundingClientRect())}
            onMouseLeave={() => setIndex(-1)}
          >
            <g transform={`translate(${margin.left} ${margin.top})`}>
              {ticks.map((tick, tickIndex) => (
                <g key={tick}>
                  <line x1={0} x2={plotW} y1={yAt(tick)} y2={yAt(tick)} stroke="var(--line-soft)" strokeDasharray={tickIndex === 0 ? undefined : '3 4'} />
                  <text x={-10} y={yAt(tick)} textAnchor="end" dominantBaseline="middle" className="fill-fg-4 text-2xs tabular-nums">{formatPoint(series.metric, tick)}</text>
                </g>
              ))}
              {visible.map((entry, visibleIndex) => (
                <g key={`${entry.frame.layers.map((layer) => layer.key).join('-')}-${visibleIndex}`} opacity={entry.opacity}>
                  <Paths frame={entry.frame} width={plotW} height={areaH} highlight={highlight} fillOpacity={resolved === 'dark' ? 0.28 : 0.22} dashed={visibleIndex < visible.length - 1} />
                </g>
              ))}
              {active && (
                <g>
                  <line x1={activeX} x2={activeX} y1={0} y2={areaH} stroke="var(--fg-4)" strokeDasharray="3 3" />
                  {stacked.layers.map((layer) => {
                    const band = layer.bands[index];
                    if (!band) return null;
                    return <circle key={layer.key} cx={activeX} cy={yAt(band.y1)} r={3} fill={palette.get(layer.key)} stroke="var(--bg-elevated)" strokeWidth={1.5} />;
                  })}
                </g>
              )}
              <line x1={0} x2={plotW} y1={areaH} y2={areaH} stroke="var(--line)" />
              {xTicks.map((tick, tickIndex) => (
                <g key={tick.toISOString()}>
                  <line x1={xAt(tick.getTime())} x2={xAt(tick.getTime())} y1={0} y2={areaH} stroke="var(--line-soft)" strokeDasharray="3 4" />
                  {/* Anchored inward at the ends: a centred label at x=0 or x=plotW loses half itself. */}
                  <text
                    x={xAt(tick.getTime())}
                    y={areaH + 16}
                    textAnchor={xTicks.length === 1 ? 'middle' : tickIndex === 0 ? 'start' : 'end'}
                    className="fill-fg-4 text-2xs tabular-nums"
                  >
                    {formatBucket(tick.toISOString(), series.granularity)}
                  </text>
                </g>
              ))}
              <g transform={`translate(0 ${areaH + 26})`}>
                {strip.map((bar) => (
                  <rect key={bar.x} x={bar.x} y={brushH - (bar.h / 100) * brushH} width={bar.w} height={(bar.h / 100) * brushH} rx={0.5} fill="var(--fg-4)" fillOpacity={0.38} />
                ))}
                <rect
                  x={0}
                  y={0}
                  width={plotW}
                  height={brushH}
                  fill="transparent"
                  className="cursor-ew-resize"
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    const x = localX(event.clientX);
                    dragRef.current = { start: x, end: x };
                    setDrag(dragRef.current);
                  }}
                  onPointerMove={(event) => {
                    const current = dragRef.current;
                    if (!current) return;
                    const next = { start: current.start, end: localX(event.clientX) };
                    dragRef.current = next;
                    setDrag(next);
                  }}
                  onPointerUp={(event) => {
                    const current = dragRef.current;
                    dragRef.current = null;
                    setDrag(null);
                    if (!current || end <= start) return;
                    const range = brushRange([start, end], [0, plotW], current.start, localX(event.clientX));
                    if (range) onBrush(range.from, range.to);
                  }}
                />
                {!drag && <line x1={0} x2={plotW} y1={0.5} y2={0.5} stroke="var(--line-soft)" />}
                {drag && <rect x={Math.min(drag.start, drag.end)} y={0} width={Math.abs(drag.end - drag.start)} height={brushH} fill="var(--accent)" fillOpacity={0.16} stroke="var(--accent)" />}
              </g>
            </g>
          </svg>
        )}
        {active && (
          <ChartTooltip x={Math.min(width - 168, Math.max(8, margin.left + activeX + 12))} y={12}>
            <p className="mb-1 text-fg-3">{formatBucket(active.start, series.granularity)}</p>
            {series.keys.map((key) => {
              const raw = active.values[key.key];
              const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
              return (
                <p key={key.key} className="flex items-center justify-between gap-3 tabular-nums">
                  <span className="inline-flex items-center gap-1.5 text-fg-2"><span className="size-1.5 rounded-full" style={{ background: palette.get(key.key) }} />{key.label}</span>
                  <span>{formatPoint(series.metric, value)}</span>
                </p>
              );
            })}
            <p className="mt-1 flex justify-between gap-3 border-t border-line pt-1 font-medium tabular-nums">
              <span><Trans>合计</Trans></span>
              <span>{formatPoint(series.metric, stacked.totals[index] ?? null)}</span>
            </p>
          </ChartTooltip>
        )}
        {empty && <div className="absolute inset-0 grid place-items-center"><EmptyNote><Trans>这段时间没有可绘制的用量</Trans></EmptyNote></div>}
      </div>
    </ChartCard>
  );
}
