import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { StatsHeatmap } from '@contracts';
import { formatCount, formatTokens } from '@/lib/stats-format';
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

/** One day per horizontal cell, following the selected window rather than padding to a year. */
export function CalendarHeatmap({ heatmap }: { heatmap: StatsHeatmap }) {
  const { t } = useLingui();
  const days = useMemo(() => [...heatmap.calendar].sort((a, b) => a.date.localeCompare(b.date)), [heatmap.calendar]);
  const max = heatMax(days.map((day) => day.runs));
  const [picked, setPicked] = useState<string | null>(null);
  const index = days.findIndex((day) => day.date === picked);
  const active = days[index];
  return (
    <ChartCard title={t`每日活跃`}>
      {days.length === 0 ? <EmptyNote><Trans>这段时间没有每日记录</Trans></EmptyNote> : (
        <>
          <div className="flex items-center justify-between gap-3 text-xs text-fg-4 tabular-nums">
            <span>{days[0]!.date}</span>
            {days.length > 1 && <span>{days[days.length - 1]!.date}</span>}
          </div>
          <div className="overflow-x-auto pb-1" role="group" aria-label={t`每日活跃，左右方向键查看日期`} onKeyDown={(event) => {
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? days.length - 1
              : event.key === 'ArrowRight' ? Math.min(days.length - 1, index + 1)
                : event.key === 'ArrowLeft' ? Math.max(0, index - 1) : null;
            if (next == null) return;
            event.preventDefault();
            event.currentTarget.querySelectorAll('button')[next]?.focus();
          }}>
            <div className="grid gap-[3px] p-0.5" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(8px, 1fr))`, minWidth: days.length * 11 - 3 }}>
              {days.map((day, i) => {
                const level = heatLevel(day.runs, max);
                const description = t`${day.date} · ${formatCount(day.runs)} 轮 · ${formatTokens(day.totalTokens)}`;
                return (
                  <button key={day.date} type="button" tabIndex={i === (index < 0 ? 0 : index) ? 0 : -1}
                    title={description} aria-label={description}
                    onFocus={() => setPicked(day.date)} onMouseEnter={() => setPicked(day.date)} onClick={() => setPicked(day.date)}
                    className="h-[18px] min-w-0 rounded-xs outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-elevated"
                    style={{ background: heatColor(level) }}
                  />
                );
              })}
            </div>
          </div>
          <p className="min-h-4 text-xs text-fg-3 tabular-nums" aria-live="polite">
            {active ? t`${active.date} · ${formatCount(active.runs)} 轮 · ${formatTokens(active.totalTokens)}` : t`悬停或选中日期查看用量`}
          </p>
        </>
      )}
    </ChartCard>
  );
}
