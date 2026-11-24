import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { CouncilDiscussion, CouncilLedger, CouncilPhase, CouncilSeat } from '@contracts';
import { StatusDot } from '@/components/ui/controls';
import { Button } from '@/components/ui/button';
import { ListRow } from '@/components/ui/list-row';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { IconPanelRight } from '@/components/icons';
import { cn, scrollBehavior } from '@/lib/utils';
import { agentTint } from '@/lib/backends';
import { Section } from '../session/SessionAside';
import { alike, debateRoundPhase, readableCouncilText, seatName, seatOf, useCouncilLabels } from './model';
import { SeatMark } from './Speech';

const row = 'flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-sm';

/**
 * Which side the judge's notes favour so far: a side gains for each point it reinforced and each question the other
 * dodged, and loses for each point broken. A question carried from round to round counts once, as last noted.
 */
function momentum(d: CouncilDiscussion): number | undefined {
  const ledgers = d.speeches.flatMap((s) => (s.status === 'done' && s.directive?.kind === 'ledger' ? [s.directive as CouncilLedger] : []));
  if (!ledgers.length) return undefined;
  let score = 0;
  // The last verdict on each question, matched as the badges match them, so a reworded question is still one.
  const questions: Array<CouncilLedger['crossExam'][number]> = [];
  for (const ledger of ledgers) {
    for (const side of ['pro', 'con'] as const) {
      const sign = side === 'pro' ? 1 : -1;
      if (ledger.sides[side]?.reinforced) score += sign;
      if (ledger.sides[side]?.broken) score -= sign;
    }
    for (const item of ledger.crossExam) {
      const at = questions.findIndex((seen) => seen.asker === item.asker && alike(seen.question, item.question));
      if (at < 0) questions.push(item); else questions[at] = item;
    }
  }
  for (const item of questions) if (item.answered === 'dodged') score += item.asker === 'pro' ? 1 : -1;
  return score;
}

/** The tug between the sides, the knob drawn toward the side ahead; light from its mark fills the way it moved. */
function Momentum({ score, pro, con }: { score: number; pro: CouncilSeat; con: CouncilSeat }) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  const at = 50 - 40 * Math.tanh(score / 3);
  const ahead = score > 0 ? pro : con;
  const side = labels.roleOf(ahead.role);
  const said = score === 0 ? t`势均力敌` : Math.abs(score) === 1 ? t`${side}略占上风` : t`${side}占上风`;
  const tint = agentTint(ahead.model.backendId);
  return (
    <Tip label={t`按裁判各轮的记录：论点加强、被击破，对方回避质询`}>
      <div className="flex w-full flex-col items-center gap-1.5" role="img" aria-label={said}>
        <span className="relative block h-1.5 w-full rounded-full bg-muted">
          {score !== 0 && (
            <span
              className="absolute inset-y-0 rounded-full"
              style={score > 0
                ? { left: `${at}%`, right: '50%', background: `linear-gradient(to left, transparent, color-mix(in srgb, ${tint} 60%, transparent))` }
                : { left: '50%', right: `${100 - at}%`, background: `linear-gradient(to right, transparent, color-mix(in srgb, ${tint} 60%, transparent))` }}
            />
          )}
          <span className="absolute inset-y-[-4px] left-1/2 w-px bg-line-strong" />
          <span className="absolute top-1/2 size-3.5 -translate-1/2 rounded-full bg-bg ring-[1.5px] ring-fg-2 transition-[left] duration-[var(--duration-slow)] ease-[var(--ease-standard)] motion-reduce:transition-none" style={{ left: `${at}%` }} />
        </span>
        <span className="text-xs text-fg-3">{t`势头`} · {said}</span>
      </div>
    </Tip>
  );
}

const phasesByFormat: Partial<Record<CouncilDiscussion['format'], CouncilPhase[]>> = {
  prism: ['explore', 'probe', 'deepen', 'conclusion'],
  review: ['review', 'conclusion'],
};

function Progress({ discussion, convergence, onJump }: { discussion: CouncilDiscussion; convergence?: string; onJump: (id: string) => void }) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  const phases = phasesByFormat[discussion.format];
  const finished = discussion.status === 'done';
  const steps: { label: string; detail?: string; target?: string }[] = [];
  let current = discussion.round - 1;
  if (phases) {
    current = 0;
    for (const phase of phases) {
      const first = discussion.speeches.find((s) => s.phase === phase);
      if (first) current = steps.length;
      steps.push({ label: labels.phase(discussion.format, phase), target: first && `council-speech-${first.id}` });
    }
  } else {
    const conclusion = discussion.speeches.find((s) => s.phase === 'conclusion');
    const startedRounds = new Set(discussion.speeches.filter((s) => s.phase !== 'conclusion').map((s) => s.round));
    const last = discussion.format === 'roundtable' && (discussion.concluding || conclusion || finished)
      ? Math.max(0, ...startedRounds)
      : discussion.closingRound ?? (finished ? Math.min(discussion.round, discussion.maxRounds) : discussion.maxRounds);
    for (let round = 1; round <= last; round += 1) {
      steps.push({
        label: labels.round(round),
        detail: discussion.format === 'ld' ? labels.phase('ld', debateRoundPhase(discussion, round)) : undefined,
        target: startedRounds.has(round) ? `council-${discussion.id}-round-${round}` : undefined,
      });
    }
    if (conclusion) {
      current = steps.length;
      steps.push({ label: labels.phase(discussion.format, 'conclusion'), target: `council-speech-${conclusion.id}` });
    }
  }
  return (
    <Section title={t`进度`} meta={convergence}>
      <ol>
        {steps.map(({ label, detail, target }, index) => {
          const active = !finished && index === current;
          const reached = finished || index <= current;
          return (
            <li key={label}>
              <ListRow
                aria-current={active ? 'step' : undefined}
                selected={active}
                disabled={!target}
                leading={<span aria-hidden className={cn('h-1 w-4 rounded-full', active ? 'bg-fg' : reached ? 'bg-fg-3' : 'bg-muted')} />}
                meta={detail}
                onClick={() => { if (target) onJump(target); }}
              >
                {label}
              </ListRow>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

function Overview({ discussion, afterJump }: { discussion: CouncilDiscussion; afterJump?: () => void }) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  const latest = (seatId: string) => discussion.speeches.findLast((s) => s.seatId === seatId);
  const ledger = discussion.speeches.findLast((s) => s.directive?.kind === 'ledger')?.directive;
  const moderation = discussion.speeches.findLast((s) => s.directive?.kind === 'moderation')?.directive;
  const pro = discussion.seats.find((s) => s.role === 'pro');
  const con = discussion.seats.find((s) => s.role === 'con');
  const score = discussion.format === 'ld' ? momentum(discussion) : undefined;
  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    afterJump?.();
  };
  const convergence = { divergent: t`分歧`, partial: t`部分一致`, converging: t`趋于一致`, consensus: t`已一致` };

  return (
    <>
      <Progress discussion={discussion} convergence={moderation?.kind === 'moderation' ? convergence[moderation.convergence] : undefined} onJump={jump} />
      <Section title={t`席位`}>
        <ul>
          {discussion.seats.map((seat) => {
            const status = latest(seat.id)?.status;
            const name = seatName(seat, discussion.seats);
            const owed = ledger?.kind === 'ledger' && (seat.role === 'pro' || seat.role === 'con')
              ? ledger.crossExam.filter((q) => q.asker !== seat.role && q.answered === 'pending').length : 0;
            return (
              <li key={seat.id} className={row}>
                <SeatMark seat={seat} />
                <span className="min-w-0 flex-1 truncate text-fg-2" title={`${name} · ${seat.profileName}`}>{name}</span>
                <span className="shrink-0 text-xs text-fg-3">{labels.role(seat)}{owed > 0 && <> · {t`${owed} 问待回应`}</>}</span>
                {status === 'streaming' && <StatusDot tone="accent" pulse label={t`发言中`} />}
                {status === 'failed' && <StatusDot tone="danger" label={t`失败`} />}
              </li>
            );
          })}
        </ul>
      </Section>

      {ledger?.kind === 'ledger' && (
        <Section title={t`双方立场`}>
          {score !== undefined && pro && con && <div className="mx-2 mb-3"><Momentum score={score} pro={pro} con={con} /></div>}
          <ul className="flex flex-col gap-2">
            {(['pro', 'con'] as const).map((side) => {
              const entry = ledger.sides[side];
              if (!entry) return null;
              return (
                <li key={side} className="flex min-w-0 flex-col gap-0.5 px-2 text-sm">
                  <span className="text-xs text-fg-3">{labels.roleOf(side)}</span>
                  <span className="text-fg-2">{entry.claim}</span>
                  {entry.broken && <span className="flex gap-1.5 text-xs text-fg-3"><span aria-hidden className="shrink-0">−</span><span className="sr-only">{t`被击破`}</span>{entry.broken}</span>}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {moderation?.kind === 'moderation' && moderation.positions.length > 0 && (
        <Section title={t`各方立场`}>
          <ul className="flex flex-col gap-2">
            {moderation.positions.map((position) => {
              const seat = seatOf(discussion, position.seatId);
              if (!seat) return null;
              return (
                <li key={position.seatId} className="flex min-w-0 flex-col gap-0.5 px-2 text-sm">
                  <span className="truncate text-xs text-fg-3">{seatName(seat, discussion.seats)}</span>
                  <span className="text-fg-2">{readableCouncilText(position.stance, discussion.seats, false)}</span>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
    </>
  );
}

export function CouncilAside({ discussion }: { discussion: CouncilDiscussion }) {
  const { t } = useLingui();
  return (
    <aside aria-label={t`协作概览`} className="flex max-h-[calc(100dvh-6rem)] w-[248px] shrink-0 flex-col gap-7 overflow-y-auto pt-3.5 pr-4 pb-6 pl-1 max-xl:hidden">
      <Overview discussion={discussion} />
    </aside>
  );
}

/** The same overview stays within reach when there is no room for the right rail. */
export function CouncilOverviewMenu({ discussion }: { discussion: CouncilDiscussion }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="icon-sm" variant="quiet" className="xl:hidden" aria-label={t`协作概览`}><IconPanelRight /></Button>
      </PopoverTrigger>
      <PopoverContent align="end" mobileSheet aria-label={t`协作概览`} className="flex max-h-[70dvh] w-64 flex-col gap-5 overflow-y-auto p-3">
        <Overview discussion={discussion} afterJump={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
