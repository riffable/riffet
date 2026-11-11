import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { StatsBreakdown } from '@contracts';
import { formatCount, formatPercent, formatTokens } from '@/lib/stats-format';
import { donutBasis, donutPath, donutSlices, seriesColors, seriesOpacity, type DonutSlice } from '@/lib/stats-series';
import { ChartCard, ChartTooltip, EmptyNote, SeriesLegend, useHighlight, useReducedMotion, useRovingIndex } from './chart-shared';

interface Ramp { start: number; end: number }
type Ramps = Record<string, Ramp>;

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Where a slice enters from when it was not on screen before: collapsed at its own leading edge. */
function entryRamp(first: Ramp | undefined, slice: DonutSlice): Ramp {
  const anchor = first?.start ?? slice.startAngle;
  return { start: anchor, end: anchor };
}

/**
 * Angle ramps keyed by slice: a change of window or of split slides every arc into its new share
 * instead of snapping, and a slice that disappears shrinks to nothing from where it was.
 */
function useRampedSlices(slices: DonutSlice[], reduced: boolean): DonutSlice[] {
  const initial: Ramps = {};
  for (const slice of slices) initial[slice.key] = { start: slice.startAngle, end: slice.endAngle };
  // The first frame is not an entrance: the chart is already in its place when the page paints.
  const current = useRef<Ramps>(initial);
  const mounted = useRef(false);
  const signature = slices.map((slice) => `${slice.key}:${slice.startAngle.toFixed(4)}:${slice.endAngle.toFixed(4)}`).join('|');
  const [shown, setShown] = useState<DonutSlice[]>(slices);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const from = current.current;
    const target: Ramps = {};
    for (const slice of slices) target[slice.key] = { start: slice.startAngle, end: slice.endAngle };
    const first = Object.values(from)[0];
    const plan = [...new Set([...Object.keys(from), ...Object.keys(target)])].map((key) => {
      const before = from[key] ?? entryRamp(first, slices.find((slice) => slice.key === key) ?? slices[0]!);
      const to = target[key] ?? { start: before.end, end: before.end };
      return { key, before, to };
    });
    const duration = reduced ? 0 : 380;
    const startedAt = performance.now();
    let handle = 0;
    const tick = (at: number) => {
      const eased = easeOut(duration <= 0 ? 1 : Math.min(1, (at - startedAt) / duration));
      const ramps: Ramps = {};
      for (const item of plan) {
        ramps[item.key] = {
          start: item.before.start + (item.to.start - item.before.start) * eased,
          end: item.before.end + (item.to.end - item.before.end) * eased,
        };
      }
      current.current = ramps;
      setShown(slices.flatMap((slice) => {
        const ramp = ramps[slice.key];
        if (!ramp || ramp.end - ramp.start <= 0.0005) return [];
        return [{ ...slice, startAngle: ramp.start, endAngle: ramp.end }];
      }));
      if (eased < 1) handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
    // The signature is the data; the array identity changes on every render by construction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, reduced]);

  return shown;
}

export function DonutChart({ breakdown }: { breakdown: StatsBreakdown }) {
  const { t } = useLingui();
  const reduced = useReducedMotion();
  const { highlight, setHighlight } = useHighlight();
  const basis = donutBasis(breakdown.rows);
  const slices = donutSlices(breakdown.rows.map((row) => ({ ...row, value: basis === 'tokens' ? row.totalTokens : row.count })));
  const ramped = useRampedSlices(slices, reduced);
  const { index, setIndex, onKeyDown } = useRovingIndex(slices.length);
  const [hover, setHover] = useState<string | null>(null);
  const active = hover ?? (index >= 0 ? slices[index]?.key : null);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const palette = seriesColors([...slices, ...ramped]);
  const legend = slices.map((slice) => ({ ...slice, color: palette.get(slice.key)!, detail: formatPercent(slice.share) }));
  const size = 220;
  const center = size / 2;

  return (
    <ChartCard title={t`Agent 占比`} className="justify-between">
      {slices.length === 0 ? <EmptyNote><Trans>还没有可分配的用量</Trans></EmptyNote> : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <div className="relative">
            <svg
              width={size}
              height={size}
              viewBox={`0 0 ${size} ${size}`}
              className="stats-chart max-w-full outline-none"
              role="img"
              tabIndex={0}
              aria-label={t`各 Agent 占比。方向键切换扇区。`}
              onKeyDown={onKeyDown}
            >
              <g transform={`translate(${center} ${center})`}>
                {ramped.map((slice) => {
                  const source = slices.findIndex((item) => item.key === slice.key);
                  const expanded = !reduced && active === slice.key;
                  return (
                    <path
                      key={slice.key}
                      d={donutPath(slice, 62, expanded ? 98 : 88)}
                      fill={palette.get(slice.key)}
                      opacity={seriesOpacity(slice, highlight)}
                      stroke="var(--bg-elevated)"
                      strokeWidth={1}
                      onMouseEnter={() => { setHover(slice.key); setIndex(source); setHighlight(slice); }}
                      onMouseLeave={() => { setHover(null); setHighlight(null); }}
                    />
                  );
                })}
              </g>
              <text x={center} y={center - 4} textAnchor="middle" className="fill-fg text-lg font-semibold tabular-nums" style={{ pointerEvents: 'none' }}>
                {basis === 'tokens' ? formatTokens(total) : formatCount(total)}
              </text>
              <text x={center} y={center + 16} textAnchor="middle" className="fill-fg-3 text-2xs" style={{ pointerEvents: 'none' }}>
                {basis === 'tokens' ? 'token' : t`轮次`}
              </text>
            </svg>
            {active && (() => {
              const slice = slices.find((item) => item.key === active);
              if (!slice) return null;
              return (
                <ChartTooltip x={center + 24} y={16}>
                  <p className="font-medium">{slice.label}</p>
                  <p className="tabular-nums text-fg-2">{basis === 'tokens' ? formatTokens(slice.value) : formatCount(slice.value)} · {formatPercent(slice.share)}</p>
                </ChartTooltip>
              );
            })()}
          </div>
          <SeriesLegend items={legend} />
        </div>
      )}
    </ChartCard>
  );
}
