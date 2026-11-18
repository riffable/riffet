import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { StatsHeatmap } from '@contracts';
import { formatCount } from '@/lib/stats-format';
import { HEAT_ALPHA, WEEKDAY_NAMES, heatLevel, heatMax, weekGrid } from '@/lib/stats-series';
import { ChartCard, ChartTooltip, EmptyNote, useClampedLeft, useRovingIndex } from './chart-shared';

function heatColor(level: 0 | 1 | 2 | 3 | 4): string {
  return `color-mix(in srgb, var(--accent) ${HEAT_ALPHA[level] * 100}%, var(--bg-muted))`;
}

function Cell({ level, label, onHover }: { level: 0 | 1 | 2 | 3 | 4; label: string; onHover: (on: boolean) => void }) {
  return (
    <span
      aria-label={label}
      className="block aspect-square w-full rounded-xs"
      style={{ background: heatColor(level) }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    />
  );
}

export function WeekHeatmap({ heatmap }: { heatmap: StatsHeatmap }) {
  const { t } = useLingui();
  const grid = weekGrid(heatmap.weekHour);
  const max = heatMax((grid ?? []).flat());
  const { index, setIndex, onKeyDown } = useRovingIndex(grid ? 7 * 24 : 0);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [tipRef, tipLeft, placeTip] = useClampedLeft();
  if (!grid) return <ChartCard title={t`活跃时段`}><EmptyNote><Trans>没有时段分布</Trans></EmptyNote></ChartCard>;
  const row = Math.floor(Math.max(index, 0) / 24);
  const col = Math.max(index, 0) % 24;
  return (
    <ChartCard title={t`活跃时段`}>
      <div className="relative">
        <div
          role="grid"
          tabIndex={0}
          aria-label={t`一周中每个小时的轮次。方向键移动。`}
          className="stats-chart grid grid-cols-[1.25rem_repeat(24,minmax(0,1fr))] gap-0.5 outline-none"
          onKeyDown={onKeyDown}
        >
          <span />
          {Array.from({ length: 24 }, (_, hour) => (
            <span key={hour} className="text-center text-2xs text-fg-4 tabular-nums">{hour % 6 === 0 ? hour : ''}</span>
          ))}
          {grid.map((hours, weekday) => {
            const weekdayName = t(WEEKDAY_NAMES[weekday]);
            return (
            <div key={weekday} className="contents">
              <span className="text-2xs leading-none text-fg-4">{weekdayName}</span>
              {hours.map((value, hour) => {
                const selected = index === weekday * 24 + hour;
                return (
                  <span key={hour} className={selected ? 'ring-1 ring-fg' : undefined} onMouseEnter={(event) => {
                    setIndex(weekday * 24 + hour);
                    const parent = event.currentTarget.closest('.relative')?.getBoundingClientRect();
                    const box = event.currentTarget.getBoundingClientRect();
                    if (parent) placeTip(box.left - parent.left);
                    setTip({ x: 0, y: box.bottom - (parent?.top ?? 0) + 4, text: t`${weekdayName} ${hour}:00 · ${formatCount(value)} 轮` });
                  }} onMouseLeave={() => setTip(null)}>
                    <Cell level={heatLevel(value, max)} label={t`${weekdayName} ${hour} 点，${value} 轮`} onHover={() => {}} />
                  </span>
                );
              })}
            </div>
            );
          })}
        </div>
        {tip && <div ref={tipRef}><ChartTooltip x={tipLeft} y={tip.y}>{tip.text}</ChartTooltip></div>}
        {index >= 0 && <p className="mt-2 text-xs text-fg-3 tabular-nums">{t`${t(WEEKDAY_NAMES[row])} ${col}:00 · ${formatCount(grid[row]?.[col] ?? 0)} 轮`}</p>}
      </div>
    </ChartCard>
  );
}
