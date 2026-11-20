import { useId } from 'react';
import { area, curveMonotoneX, line } from 'd3-shape';
import { useLingui } from '@lingui/react/macro';
import { WORK_ITEM_STATUSES } from '@contracts';
import { ChartCard, useRovingIndex } from '@/components/ui/chart';
import { formatDate, formatNumber } from '@/lib/i18n/format';
import { linearTicks, niceUpper } from '@/lib/stats-series';
import type { summarizeWorkItems } from './model';
import { STATUS_TONE, StatusIcon, useStatusLabel } from './parts';

type Overview = ReturnType<typeof summarizeWorkItems>;
type ActivityDay = Overview['days'][number];

export function WorkItemOverview({ data }: { data: Overview }) {
  const { t } = useLingui();
  const facts = [[t`收件箱`, data.inbox], [t`运行中`, data.running], [t`关联会话`, data.conversations]] as const;
  return (
    <ChartCard title={t`任务概览`} className="mb-5 h-auto gap-4 p-5 max-md:p-4 @container" actions={
      <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs max-md:gap-x-3">
        {facts.map(([label, count]) => (
          <div key={label} className="flex items-baseline gap-1.5">
            <dt className="text-fg-3">{label}</dt>
            <dd className="font-medium tabular-nums text-fg">{formatNumber(count)}</dd>
          </div>
        ))}
      </dl>
    }>
      <div className="grid gap-5 @3xl:grid-cols-[minmax(0,1fr)_13rem] @5xl:grid-cols-[minmax(0,1fr)_15rem]">
        <ActivityChart days={data.days} />
        <StatusBreakdown total={data.total} statuses={data.statuses} />
      </div>
    </ChartCard>
  );
}

function StatusBreakdown({ total, statuses }: Pick<Overview, 'total' | 'statuses'>) {
  const { t } = useLingui();
  const statusLabel = useStatusLabel();
  let offset = 0;
  const segments = WORK_ITEM_STATUSES.map((status) => {
    const fraction = statuses[status] / (total || 1);
    const start = offset;
    offset += fraction;
    return { status, start, fraction };
  });
  return (
    <div className="flex min-w-0 flex-col gap-3 border-t border-line-soft pt-4 @3xl:border-l @3xl:border-t-0 @3xl:pl-5 @3xl:pt-0">
      <dl className="flex items-baseline justify-between gap-2">
        <dt className="text-xs text-fg-3">{t`任务总数`}</dt>
        <dd className="text-3xl font-semibold leading-none tabular-nums tracking-tight text-fg">{formatNumber(total)}</dd>
      </dl>
      <div aria-hidden className="relative h-2 overflow-hidden rounded-full bg-muted">
        {segments.map(({ status, start, fraction }) => (
          <span
            key={status}
            className="absolute inset-0 origin-left transition-transform duration-[var(--duration-base)] ease-[var(--ease-standard)] motion-reduce:transition-none"
            style={{
              transform: `translateX(${start * 100}%) scaleX(${fraction})`,
              backgroundColor: status === 'cancelled' ? 'color-mix(in oklab, var(--fg-3), var(--fg-4))' : STATUS_TONE[status],
            }}
          />
        ))}
      </div>
      <dl className="grid grid-cols-2 gap-x-5 gap-y-2 @sm:grid-cols-3 @3xl:grid-cols-1">
        {WORK_ITEM_STATUSES.map((status) => (
          <div key={status} className="flex items-baseline justify-between gap-1.5 text-xs">
            <dt className="relative pl-5 text-fg-3">
              <span aria-hidden className="absolute left-0 top-1/2 flex -translate-y-1/2"><StatusIcon status={status} /></span>
              {statusLabel(status)}
            </dt>
            <dd className="font-medium tabular-nums text-fg">{formatNumber(statuses[status])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ActivityChart({ days }: { days: Overview['days'] }) {
  const { t } = useLingui();
  const statusLabel = useStatusLabel();
  const id = useId();
  const { index, setIndex, onKeyDown } = useRovingIndex(days.length);
  const selected = days[index];
  const dayCount = days.length;
  const heading = t`近 ${dayCount} 天`;
  const createdLabel = t({ message: '新建', context: 'work-item-overview-series' });
  const doneLabel = statusLabel('done');
  const upper = niceUpper(Math.max(2, ...days.map(({ created, done }) => Math.max(created, done))));
  const ticks = linearTicks(0, upper).filter(Number.isInteger);
  const last = dayCount - 1;
  const x = (i: number) => 100 * i / last;
  const y = (value: number) => 100 * (1 - value / upper);
  const dates = [0, Math.round(last / 3), Math.round(last * 2 / 3), last];
  const totals = days.reduce((sum, day) => ({ created: sum.created + day.created, done: sum.done + day.done }), { created: 0, done: 0 });
  const values = selected ?? totals;
  const trendLine = line<ActivityDay>().x((_, i) => x(i)).curve(curveMonotoneX);
  const createdPath = totals.created > 0 ? trendLine.y((day) => y(day.created))(days) : null;
  const donePath = totals.done > 0 ? trendLine.y((day) => y(day.done))(days) : null;
  const doneArea = donePath && area<ActivityDay>().x((_, i) => x(i)).y0(100).y1((day) => y(day.done)).curve(curveMonotoneX)(days);
  const dayLabel = (date: number) => formatDate(date, { month: 'short', day: 'numeric' });
  const detail = ({ date, created, done }: ActivityDay) => (
    `${dayLabel(date)} · ${createdLabel} ${formatNumber(created)} · ${doneLabel} ${formatNumber(done)}`
  );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-h-6 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id={`${id}-label`} className="sr-only">{heading}</h3>
        <span aria-hidden className="shrink-0 text-sm font-medium tabular-nums text-fg-2">{selected ? dayLabel(selected.date) : heading}</span>
        <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-fg-3">
          <div className="flex items-baseline gap-1.5">
            <dt className="relative pl-5">
              <span aria-hidden className="absolute left-0 top-1/2 w-4 -translate-y-1/2 border-t-2 border-dashed border-fg-3" />
              {createdLabel}
            </dt>
            <dd className="font-medium tabular-nums text-fg">{formatNumber(values.created)}</dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="relative pl-5">
              <span aria-hidden className="absolute left-0 top-1/2 h-0.5 w-4 -translate-y-1/2 rounded-full bg-success" />
              {doneLabel}
            </dt>
            <dd className="font-medium tabular-nums text-fg">{formatNumber(values.done)}</dd>
          </div>
        </dl>
      </div>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-2">
        <div aria-hidden className="relative min-w-4 text-right text-2xs tabular-nums text-fg-3">
          <span className="invisible">{formatNumber(upper)}</span>
          {ticks.map((tick) => (
            <span key={tick} className="absolute right-0 -translate-y-1/2" style={{ top: `${y(tick)}%` }}>{formatNumber(tick)}</span>
          ))}
        </div>
        <div
          role="listbox"
          aria-labelledby={`${id}-label`}
          aria-orientation="horizontal"
          aria-activedescendant={selected ? `${id}-${index}` : undefined}
          tabIndex={0}
          onKeyDown={(event) => { if (event.key !== 'Escape' || selected) onKeyDown(event); }}
          onPointerLeave={(event) => { if (event.pointerType === 'mouse' && document.activeElement !== event.currentTarget) setIndex(-1); }}
          onBlur={() => setIndex(-1)}
          className="relative h-40 cursor-crosshair rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus @3xl:h-48 @5xl:h-52"
        >
          <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
            {ticks.map((tick) => (
              <line key={tick} x1={0} x2={100} y1={y(tick)} y2={y(tick)} vectorEffect="non-scaling-stroke" className={tick === 0 ? 'stroke-line' : 'stroke-line-soft'} />
            ))}
            {doneArea && <path d={doneArea} className="fill-success-soft" />}
            {createdPath && <path d={createdPath} fill="none" vectorEffect="non-scaling-stroke" strokeWidth={1.5} strokeDasharray="4 4" strokeLinecap="round" className="stroke-fg-3" />}
            {donePath && <path d={donePath} fill="none" vectorEffect="non-scaling-stroke" strokeWidth={2.5} strokeLinecap="round" className="stroke-success" />}
          </svg>
          {selected && (
            <div aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-line-strong" style={{ left: `${x(index)}%` }}>
              <span className="absolute left-0 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg-3 ring-2 ring-elevated" style={{ top: `${y(selected.created)}%` }} />
              <span className="absolute left-0 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-success ring-2 ring-elevated" style={{ top: `${y(selected.done)}%` }} />
            </div>
          )}
          <div role="presentation" className="absolute inset-0 flex">
            {days.map((day, i) => (
              <div
                key={day.date}
                id={`${id}-${i}`}
                role="option"
                aria-label={detail(day)}
                aria-selected={index === i}
                onPointerEnter={(event) => { if (event.pointerType === 'mouse') setIndex(i); }}
                onClick={() => setIndex(i)}
                className="min-w-0 flex-2 first:flex-1 last:flex-1"
              />
            ))}
          </div>
        </div>
        <div aria-hidden className="relative col-start-2 h-4 whitespace-nowrap text-2xs tabular-nums text-fg-3">
          {dates.map((i) => (
            <span key={i} className={`absolute ${i === 0 ? '' : i === last ? '-translate-x-full' : '-translate-x-1/2'}`} style={{ left: `${x(i)}%` }}>
              {dayLabel(days[i]!.date)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
