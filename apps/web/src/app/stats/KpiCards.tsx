import type { StatsSeries, StatsSummary } from '@contracts';
import { useLingui } from '@lingui/react/macro';
import { Tip } from '@/components/ui/tooltip';
import { formatMetric, type KpiFormat } from '@/lib/stats-format';
import { buildKpis, sparkPath } from '@/lib/stats-series';
import { DeltaView, EstimatedMark, Unavailable, useAnimatedNumber, useReducedMotion } from './chart-shared';

export function Spark({ values, width = 64, height = 24, className = 'text-accent max-md:hidden' }: { values: Array<number | null>; width?: number; height?: number; className?: string }) {
  const d = sparkPath(values, width, height);
  if (!d) return null;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className={`shrink-0 ${className}`}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function KpiCards({ summary, series, compareLabel }: { summary: StatsSummary; series: StatsSeries; compareLabel: string }) {
  const reduced = useReducedMotion();
  const cards = buildKpis(summary, series);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-x-4 gap-y-5 rounded-2xl bg-subtle p-5 sm:grid-cols-[1.4fr_repeat(3,minmax(0,1fr))] sm:items-center sm:gap-6">
        {cards.slice(0, 4).map((card, index) => <Kpi key={card.id} card={card} reduced={reduced} compareLabel={compareLabel} prominent={index === 0} />)}
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 px-1 py-1 sm:grid-cols-4">
        {cards.slice(4).map((card) => <Kpi key={card.id} card={card} reduced={reduced} compareLabel={compareLabel} compact />)}
      </div>
    </div>
  );
}

/** The unit rides with the label so the number itself stays a bare, tabular figure. */
function Label({ label, format }: { label: string; format: KpiFormat }) {
  const unit = format === 'speed' ? 'token/s' : format === 'duration' ? 'ms' : null;
  return (
    <>
      {label}
      {unit && <span className="text-fg-4"> · {unit}</span>}
    </>
  );
}

function Kpi({ card, reduced, compareLabel, prominent = false, compact = false }: { card: ReturnType<typeof buildKpis>[number]; reduced: boolean; compareLabel: string; prominent?: boolean; compact?: boolean }) {
  const { t } = useLingui();
  const shown = useAnimatedNumber(card.value, reduced || compact);
  const head = (
    // Wraps rather than truncates: at in-between widths the longest label would otherwise lose its
    // unit to an ellipsis, and a unit the reader cannot see is worse than a second line.
    <h2 className="text-balance text-xs leading-4 text-fg-3">
      <Label label={card.label} format={card.format} />
    </h2>
  );
  if (compact) return (
    <article className="flex min-w-0 flex-col gap-1.5">
      {head}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <p className="text-sm font-medium text-fg tabular-nums">{card.value == null ? <Unavailable /> : formatMetric(card.value, card.format)}</p>
        {compareLabel && card.previous != null && <DeltaView current={card.value} previous={card.previous} lowerIsBetter={card.lowerIsBetter} title={t`对比 ${compareLabel}`} />}
      </div>
    </article>
  );
  return (
    <article className="flex min-w-0 flex-col gap-1.5">
      {card.note ? <Tip label={card.note}>{head}</Tip> : head}
      <div className="flex items-baseline gap-1">
        <p className={`${prominent ? 'text-3xl sm:text-4xl' : 'text-xl'} truncate font-semibold tracking-tight text-fg tabular-nums`}>
          {card.value == null ? <Unavailable /> : formatMetric(shown, card.format)}
        </p>
        {card.estimated && <EstimatedMark />}
      </div>
      {/* A row with nothing to say does not take a line: the grid rows stay even either way. */}
      {card.previous != null && (
        <div className="flex min-h-6 items-center justify-between gap-2">
          {compareLabel && <DeltaView current={card.value} previous={card.previous} lowerIsBetter={card.lowerIsBetter} title={t`对比 ${compareLabel}`} />}
          {prominent && card.spark ? <Spark values={card.spark} /> : null}
        </div>
      )}
    </article>
  );
}
