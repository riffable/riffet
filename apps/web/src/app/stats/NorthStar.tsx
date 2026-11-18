import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { NorthStarDay, NorthStarReport } from '@contracts';
import { Tip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { formatCount, formatDuration } from '@/lib/stats-format';
import { Spark } from './KpiCards';
import { Unavailable } from './chart-shared';

const interruptions = (day: NorthStarDay) => day.decisions + day.questions + day.reviews;

const NORTH_STAR_CACHE_KEY = 'riffet.stats.northStar';

function loadCachedNorthStar(): NorthStarReport | undefined {
  try {
    if (typeof sessionStorage === 'undefined') return undefined;
    const raw = sessionStorage.getItem(NORTH_STAR_CACHE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as NorthStarReport;
    return Array.isArray(parsed?.days) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function saveCachedNorthStar(report: NorthStarReport): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(NORTH_STAR_CACHE_KEY, JSON.stringify(report));
  } catch {
    // Ignore storage quota errors.
  }
}

/**
 * The task board's north star (docs/TASK-BOARD.md §1) over the page's window: how often a day
 * something reached the owner, and how long conversations stood waiting on them. Days before the
 * server began recording are left out, not counted as zero.
 */
export function NorthStar({ window, timeZone }: { window: { from: string; to: string }; timeZone: string }) {
  const { t } = useLingui();
  const [report, setReport] = useState<NorthStarReport | undefined>(() => loadCachedNorthStar());
  useEffect(() => {
    const controller = new AbortController();
    api.northStar({ ...window, tz: timeZone }, controller.signal).then((next) => {
      setReport(next);
      saveCachedNorthStar(next);
    }, () => {});
    return () => controller.abort();
  }, [window.from, window.to, timeZone]);
  const since = report?.since?.slice(0, 10);
  const days = report && since ? report.days.filter((day) => day.date >= since) : [];
  const average = (value: (day: NorthStarDay) => number) => days.length ? days.reduce((sum, day) => sum + value(day), 0) / days.length : null;
  const total = (value: (day: NorthStarDay) => number) => days.reduce((sum, day) => sum + value(day), 0);
  const perDay = average(interruptions);
  const waitPerDay = average((day) => day.waitMs);
  return (
    <div className="grid min-h-[76px] grid-cols-2 gap-x-6 gap-y-3 rounded-2xl bg-subtle px-5 py-4">
      <article className="flex min-w-0 flex-col gap-1.5">
        <Tip label={t`审批与确认 ${total((day) => day.decisions)} · 提问 ${total((day) => day.questions)} · 待验收 ${total((day) => day.reviews)}`}>
          <h2 className="w-fit text-xs leading-4 text-fg-3"><Trans>日均待处理</Trans></h2>
        </Tip>
        <div className="flex min-h-7 items-center justify-between gap-2">
          <p className="truncate text-xl font-semibold tracking-tight text-fg tabular-nums">{perDay == null ? <Unavailable /> : formatCount(Math.round(perDay * 10) / 10)}</p>
          <Spark values={days.map(interruptions)} />
        </div>
      </article>
      <article className="flex min-w-0 flex-col gap-1.5">
        <h2 className="text-xs leading-4 text-fg-3"><Trans>日均等待耗时</Trans></h2>
        <div className="flex min-h-7 items-center justify-between gap-2">
          <p className="truncate text-xl font-semibold tracking-tight text-fg tabular-nums">{waitPerDay == null ? <Unavailable /> : formatDuration(waitPerDay)}</p>
          <Spark values={days.map((day) => day.waitMs)} />
        </div>
      </article>
    </div>
  );
}
