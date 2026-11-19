import { useLingui } from '@lingui/react/macro';
import type { CouncilDiscussion } from '@contracts';
import { StatusDot } from '@/components/ui/controls';
import { Section } from '../session/SessionAside';
import { seatName, useCouncilLabels } from './model';
import { SeatMark } from './Speech';

const row = 'flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-sm';
const link = `${row} w-full text-left text-fg-2 transition-colors hover:bg-hover hover:text-fg`;

function jump(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Who sits where and how each is doing, where the debate stands, and the rounds to jump between. */
export function CouncilAside({ discussion }: { discussion: CouncilDiscussion }) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  const latest = (seatId: string) => discussion.speeches.findLast((s) => s.seatId === seatId);
  const ledger = discussion.speeches.findLast((s) => s.directive?.kind === 'ledger')?.directive;
  const moderation = discussion.speeches.findLast((s) => s.directive?.kind === 'moderation')?.directive;
  const rounds = discussion.format === 'ld' || discussion.format === 'roundtable'
    ? [...new Set(discussion.speeches.filter((s) => s.phase !== 'conclusion').map((s) => s.round))]
    : [];
  const conclusion = discussion.speeches.findLast((s) => s.phase === 'conclusion');
  const convergence = { divergent: t`分歧`, partial: t`部分一致`, converging: t`趋于一致`, consensus: t`已一致` };

  return (
    <aside aria-label={t`协作概览`} className="flex w-[248px] shrink-0 flex-col gap-7 overflow-y-auto pt-3.5 pr-4 pb-6 pl-1 scrollbar-none max-xl:hidden">
      <Section title={t`席位`}>
        <ul>
          {discussion.seats.map((seat) => {
            const status = latest(seat.id)?.status;
            return (
              <li key={seat.id} className={row}>
                <SeatMark seat={seat} />
                <span className="min-w-0 flex-1 truncate text-fg-2" title={`${seatName(seat)} · ${seat.profileName}`}>{seatName(seat)}</span>
                <span className="shrink-0 text-xs text-fg-3">{labels.role(seat)}</span>
                {status === 'streaming' && <StatusDot tone="accent" pulse label={t`发言中`} />}
                {status === 'failed' && <StatusDot tone="danger" label={t`失败`} />}
              </li>
            );
          })}
        </ul>
      </Section>

      {ledger?.kind === 'ledger' && (
        <Section title={t`双方立场`}>
          <ul className="flex flex-col gap-2">
            {(['pro', 'con'] as const).map((side) => {
              const entry = ledger.sides[side];
              if (!entry) return null;
              return (
                <li key={side} className="flex min-w-0 flex-col gap-0.5 px-2 text-sm">
                  <span className="text-xs text-fg-3">{labels.roleOf(side)}</span>
                  <span className="text-fg-2">{entry.claim}</span>
                  {entry.broken && <span className="text-xs text-danger">{entry.broken}</span>}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {moderation?.kind === 'moderation' && moderation.positions.length > 0 && (
        <Section title={t`各方立场`} meta={convergence[moderation.convergence]}>
          <ul className="flex flex-col gap-2">
            {moderation.positions.map((position) => {
              const seat = discussion.seats.find((s) => s.id === position.seatId);
              return (
                <li key={position.seatId} className="flex min-w-0 flex-col gap-0.5 px-2 text-sm">
                  <span className="truncate text-xs text-fg-3">{seat ? seatName(seat) : position.seatId}</span>
                  <span className="text-fg-2">{position.stance}</span>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {(rounds.length > 1 || conclusion) && (
        <Section title={t`跳转`}>
          <ul>
            {rounds.map((round) => (
              <li key={round}><button type="button" className={link} onClick={() => jump(`council-round-${round}`)}>{labels.round(round)}</button></li>
            ))}
            {conclusion && (
              <li><button type="button" className={link} onClick={() => jump(`council-speech-${conclusion.id}`)}>{labels.phase(discussion.format, 'conclusion')}</button></li>
            )}
          </ul>
        </Section>
      )}
    </aside>
  );
}
