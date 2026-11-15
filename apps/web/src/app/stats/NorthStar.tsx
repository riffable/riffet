import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { NorthStarDay, NorthStarReport } from '@contracts';
import { Tip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { formatCount, formatDuration } from '@/lib/stats-format';
import { Spark } from './KpiCards';
import { Unavailable } from './chart-shared';

const interruptions = (day: NorthStarDay) => day.decisions + day.questions + day.reviews;

/**
 * The task board's north star (docs/TASK-BOARD.md §1) over the page's window: how often a day
 * something reached the owner, and how long conversations stood waiting on them. Days before the
 * server began recording are left out, not counted as zero.
 */
export function NorthStar({ window, timeZone }: { window: { from: string; to: string }; timeZone: string }) {
  const { t } = useLingui();
  const [report, setReport] = useState<NorthStarReport>();
  useEffect(() => {
    const controller = new AbortController();
    api.northStar({ ...window, tz: timeZone }, controller.signal).then(setReport, () => setReport(undefined));
    return () => controller.abort();
  }, [window.from, window.to, timeZone]);
  // An older server has no such report: nothing to show.
  if (!report) return null;
  const since = report.since?.slice(0, 10);
  const days = since ? report.days.filter((day) => day.date >= since) : [];
  const average = (value: (day: NorthStarDay) => number) => days.length ? days.reduce((sum, day) => sum + value(day), 0) / days.length : null;
  const total = (value: (day: NorthStarDay) => number) => days.reduce((sum, day) => sum + value(day), 0);
  const perDay = average(interruptions);
  const waitPerDay = average((day) => day.waitMs);
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-2xl bg-subtle px-5 py-4">
      <article className="flex min-w-0 flex-col gap-1.5">
        <Tip label={t`审批与确认 ${total((day) => day.decisions)} · 提问 ${total((day) => day.questions)} · 待验收 ${total((day) => day.reviews)}`}>
          <h2 className="w-fit text-xs leading-4 text-fg-3"><Trans>每天打扰你</Trans></h2>
        </Tip>
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xl font-semibold tracking-tight text-fg tabular-nums">{perDay == null ? <Unavailable /> : formatCount(Math.round(perDay * 10) / 10)}</p>
          <Spark values={days.map(interruptions)} />
        </div>
      </article>
      <article className="flex min-w-0 flex-col gap-1.5">
        <h2 className="text-xs leading-4 text-fg-3"><Trans>每天 Agent 等你</Trans></h2>
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xl font-semibold tracking-tight text-fg tabular-nums">{waitPerDay == null ? <Unavailable /> : formatDuration(waitPerDay)}</p>
          <Spark values={days.map((day) => day.waitMs)} />
        </div>
      </article>
    </div>
  );
}
