import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { CouncilDiscussion, CouncilEdits, CouncilSummary, CouncilLedger, CouncilModeration, CouncilProbe, CouncilSeat, CouncilSpeech, CouncilSupplement } from '@contracts';
import { IconArrowRight } from '@/components/icons';
import { Badge } from '@/components/ui/controls';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { DiffView, UserMessage } from '../session/Timeline';
import { LEAD_ROLES, readableCouncilText, seatName, seatOf, useCouncilLabels, type SpeechRows } from './model';
import { Halo, SeatMark, Speech, SpeechCard, type SpeechProps } from './Speech';

const NO_ATTACHMENTS: never[] = [];

/**
 * How the stage lays a discussion out: the reader's notes where they were added, a jump target on each round's first speech,
 * a debate round as its two sides, speeches given at once as a row of cards, and a lead seat's speech (notes on the
 * round, the conclusion) across the page.
 */
type Block =
  | { kind: 'note'; note: CouncilSupplement }
  | ({ startsRound?: number } & (
    | { kind: 'sides'; round: number; speeches: CouncilSpeech[] }
    | { kind: 'cards'; speeches: CouncilSpeech[] }
    | { kind: 'lead'; speech: CouncilSpeech }
  ));

function blocksOf(d: CouncilDiscussion): Block[] {
  const blocks: Block[] = [];
  const lead = (speech: CouncilSpeech) => speech.phase === 'conclusion' || LEAD_ROLES.has(seatOf(d, speech.seatId)?.role ?? 'judge');
  const rounds = d.format === 'ld' || d.format === 'roundtable';
  let group: Extract<Block, { kind: 'sides' | 'cards' }> | undefined;
  const flush = () => { if (group) blocks.push(group); group = undefined; };
  d.speeches.forEach((speech, index) => {
    const notes = d.supplements.filter((note) => note.after === index);
    if (notes.length) { flush(); for (const note of notes) blocks.push({ kind: 'note', note }); }
    const previous = d.speeches[index - 1];
    const startsRound = rounds && speech.phase !== 'conclusion' && speech.round !== previous?.round ? speech.round : undefined;
    if (lead(speech)) { flush(); blocks.push({ kind: 'lead', speech, startsRound }); return; }
    if (d.format === 'ld') {
      if (group?.kind !== 'sides' || group.round !== speech.round) { flush(); group = { kind: 'sides', round: speech.round, speeches: [], startsRound }; }
      group.speeches.push(speech);
      return;
    }
    const first = group?.kind === 'cards' ? group.speeches[0] : undefined;
    if (!first || first.round !== speech.round || first.phase !== speech.phase) { flush(); group = { kind: 'cards', speeches: [], startsRound }; }
    group!.speeches.push(speech);
  });
  flush();
  for (const note of d.supplements.filter((item) => item.after >= d.speeches.length)) blocks.push({ kind: 'note', note });
  return blocks;
}

/** What the judge holds after a round: each side's claim, what it gained and what it lost. */
function Ledger({ ledger, discussion }: { ledger: CouncilLedger; discussion: CouncilDiscussion }) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  const sides = (['pro', 'con'] as const).filter((side) => ledger.sides[side]);
  if (!sides.length) return null;
  return (
    <div className="grid gap-y-4 @2xl:grid-cols-2">
      {sides.map((side, index) => {
        const item = ledger.sides[side]!;
        return (
          // The two sides as the debate sets them: side by side, split by one rule.
          <dl key={side} className={cn('flex min-w-0 flex-col gap-1.5 text-sm', index === 0 ? '@2xl:pr-5' : '@2xl:border-l @2xl:border-line @2xl:pl-5')}>
            <dt className="text-xs font-medium text-fg-3">{labels.roleOf(side)}</dt>
            <dd className="text-fg">{item.claim}</dd>
            {item.reinforced && <dd className="flex gap-1.5 text-fg-2"><span aria-hidden className="shrink-0 text-fg-3">+</span><span className="sr-only">{t`加强`}</span>{item.reinforced}</dd>}
            {item.broken && <dd className="flex gap-1.5 text-fg-2"><span aria-hidden className="shrink-0 text-fg-3">−</span><span className="sr-only">{t`被击破`}</span>{item.broken}</dd>}
          </dl>
        );
      })}
    </div>
  );
}

/** Who challenged whom in a roundtable round, and where each now stands. */
function Moderation({ moderation, discussion }: { moderation: CouncilModeration; discussion: CouncilDiscussion }) {
  const avatar = (id: string) => {
    const seat = seatOf(discussion, id);
    return seat ? <SeatMark seat={seat} /> : null;
  };
  if (!moderation.challenges.length) return null;
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {moderation.challenges.map((item, index) => (
        <li key={index} className="flex min-w-0 items-start gap-2">
          <span className="flex shrink-0 items-center gap-1">{avatar(item.from)}<IconArrowRight className="size-3.5 text-fg-4" aria-hidden />{avatar(item.to)}</span>
          <span className="min-w-0 leading-6 text-fg-2">{readableCouncilText(item.point, discussion.seats, false)}</span>
        </li>
      ))}
    </ul>
  );
}

const CONVERGENCE = ['divergent', 'partial', 'converging', 'consensus'] as const;

/** How close a roundtable has come, as four steps. */
function Convergence({ value }: { value: CouncilModeration['convergence'] }) {
  const { t } = useLingui();
  const said = { divergent: t`分歧明显`, partial: t`部分共识`, converging: t`趋于一致`, consensus: t`已达成共识` };
  const at = CONVERGENCE.indexOf(value);
  return (
    <span className="flex items-center gap-1.5 text-xs text-fg-3">
      <span className="flex gap-0.5" aria-hidden>{CONVERGENCE.map((step, index) => <span key={step} className={cn('h-1 w-3 rounded-full', index <= at ? 'bg-fg-3' : 'bg-line')} />)}</span>
      {said[value]}
    </span>
  );
}

/** The disagreements an observer found between the answers, each with the seats it is between. */
function Contradictions({ probe, discussion }: { probe: CouncilProbe; discussion: CouncilDiscussion }) {
  if (!probe.contradictions.length) return null;
  return (
    <ol className="grid gap-2 @xl:grid-cols-2">
      {probe.contradictions.map((item, index) => (
        <li key={index} className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-bg px-4 py-3 text-sm">
          <span className="flex items-center gap-1">
            {item.seats.map((id) => { const seat = seatOf(discussion, id); return seat ? <SeatMark key={id} seat={seat} /> : null; })}
            <span className="ml-1 min-w-0 truncate font-medium text-fg">{item.title}</span>
          </span>
          <span className="text-fg-2">{readableCouncilText(item.question, discussion.seats, false)}</span>
        </li>
      ))}
    </ol>
  );
}

/** The edits a row of reviewers proposed, to accept one by one before the revision is written. */
function Edits({ speeches, discussion, editable, onToggle }: { speeches: CouncilSpeech[]; discussion: CouncilDiscussion; editable: boolean; onToggle: (id: string, accepted: boolean) => void }) {
  const { t } = useLingui();
  const accepted = new Set(discussion.accepted ?? []);
  const all = speeches.flatMap((speech) => (speech.directive?.kind === 'edits' ? (speech.directive as CouncilEdits).edits.map((edit) => ({ edit, seat: seatOf(discussion, speech.seatId) })) : []));
  if (!all.length) return null;
  return (
    <section aria-label={t`修改建议`} className="timeline-gap-block flex flex-col gap-3">
      {all.map(({ edit, seat }) => (
        <div key={edit.id} className="flex min-w-0 flex-col gap-1.5">
          <label className="flex min-w-0 items-center gap-2 text-sm">
            <Checkbox checked={accepted.has(edit.id)} disabled={!editable} onCheckedChange={(next) => onToggle(edit.id, next === true)} />
            {seat && <SeatMark seat={seat} />}
            <span className="shrink-0 text-xs tabular-nums text-fg-3">{edit.para}</span>
            <span className="min-w-0 truncate font-medium text-fg">{edit.title}</span>
          </label>
          <DiffView before={edit.before} after={edit.after} remember={`council-edit:${edit.id}`} />
        </div>
      ))}
    </section>
  );
}

/**
 * The discussion laid out by its format, in the session's reading column: the reader's prompt and notes as user
 * messages, every speech drawn with the session's answer, set out as the format seats its speakers.
 */
export function CouncilStage({ discussion, rows, rowLoads, onLoadRows, onToggleEdit, expandedSpeeches, onExpandSpeech }: {
  discussion: CouncilDiscussion;
  rows: SpeechRows;
  rowLoads?: Partial<Record<string, SpeechProps['rowsLoad']>>;
  onLoadRows: (speechId: string) => void;
  onToggleEdit: (id: string, accepted: boolean) => void;
  expandedSpeeches?: ReadonlySet<string>;
  onExpandSpeech?: (id: string, expanded: boolean) => void;
}) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  const [localOpen, setLocalOpen] = useState<ReadonlySet<string>>(() => new Set());
  const open = expandedSpeeches ?? localOpen;
  const blocks = useMemo(() => blocksOf(discussion), [discussion]);
  const editable = discussion.format === 'review' && discussion.status === 'paused' && discussion.round === 1;
  const prompt = (discussion.document?.paragraphs.map((p) => p.text) ?? []).join('\n\n');
  const expand = onExpandSpeech ?? ((id: string, next: boolean) => setLocalOpen((current) => {
    const copy = new Set(current);
    if (next) copy.add(id); else copy.delete(id);
    return copy;
  }));
  const props = (speech: CouncilSpeech) => ({ speech, discussion, rows: rows[speech.id], rowsLoad: rowLoads?.[speech.id], onLoadRows });

  const leadExtra = (speech: CouncilSpeech): ReactNode => {
    const d = speech.directive;
    if (d?.kind === 'ledger') return <Ledger ledger={d} discussion={discussion} />;
    if (d?.kind === 'moderation') return <Moderation moderation={d} discussion={discussion} />;
    if (d?.kind === 'probe') return <Contradictions probe={d} discussion={discussion} />;
    return null;
  };
  const leadBadge = (speech: CouncilSpeech): ReactNode => {
    const d = speech.directive;
    if (d?.kind === 'ledger') return <Badge tone={d.intensity === 'clashing' ? 'warning' : 'neutral'}>{d.intensity === 'clashing' ? t`交锋激烈` : t`原地打转`}</Badge>;
    if (d?.kind === 'moderation') return <Convergence value={d.convergence} />;
    return null;
  };

  const block = (item: Block, index: number): ReactNode => {
    const gap = index > 0 || discussion.format === 'review' ? 'timeline-gap-turn' : undefined;
    if (item.kind === 'note') return <div key={item.note.id} className={gap}><UserMessage text={item.note.text} attachments={NO_ATTACHMENTS} time={item.note.at} /></div>;
    const roundId = item.startsRound === undefined ? undefined : `council-${discussion.id}-round-${item.startsRound}`;
    if (item.kind === 'lead') {
      const seat = seatOf(discussion, item.speech.seatId);
      if (!seat) return null;
      const conclusion = item.speech.phase === 'conclusion';
      return (
        <div key={item.speech.id} id={roundId} className={cn(gap, 'relative isolate scroll-mt-6 overflow-hidden rounded-3xl px-6 pt-5 pb-3', conclusion ? 'border border-line-strong bg-elevated' : 'bg-subtle')}>
          {conclusion && <Halo backend={seat.model.backendId} className="inset-x-0 -top-32 h-64" />}
          <Speech {...props(item.speech)} seat={seat} lead aside={leadBadge(item.speech)}>
            {leadExtra(item.speech) && <div className="mt-2">{leadExtra(item.speech)}</div>}
          </Speech>
        </div>
      );
    }
    if (item.kind === 'sides') {
      const pro = discussion.seats.find((seat) => seat.role === 'pro');
      const con = discussion.seats.find((seat) => seat.role === 'con');
      const column = (seat: CouncilSeat | undefined, side: 'left' | 'right') => {
        if (!seat) return null;
        const own = item.speeches.filter((speech) => speech.seatId === seat.id);
        const other = side === 'left' ? con : pro;
        return (
          // Side by side the two columns are split by one rule; stacked, the speaker lines tell them apart.
          <div className={cn('flex min-w-0 flex-col gap-6', side === 'left' ? '@2xl:pr-6' : '@2xl:border-l @2xl:border-line @2xl:pl-6')}>
            {own.map((speech) => (
              <Speech key={speech.id} {...props(speech)} seat={seat} {...(other ? { opponent: { name: labels.role(other), side: side === 'left' ? 'right' as const : 'left' as const } } : {})} />
            ))}
            {!own.length && discussion.status === 'running' && (
              <div className="flex items-center gap-2 text-xs text-fg-4"><SeatMark seat={seat} /><span>{seatName(seat, discussion.seats)}</span><span>{t`等候发言`}</span></div>
            )}
          </div>
        );
      };
      return (
        <div key={`sides-${item.round}-${item.speeches[0]!.id}`} id={roundId} className={cn(gap, 'grid scroll-mt-6 items-stretch gap-y-8 @2xl:grid-cols-2')}>
          {column(pro, 'left')}
          {column(con, 'right')}
        </div>
      );
    }
    const columns = item.speeches.length >= 3 ? '@2xl:grid-cols-2 @3xl:grid-cols-3' : item.speeches.length === 2 ? '@2xl:grid-cols-2' : '';
    return (
      <Fragment key={`cards-${item.speeches[0]!.id}`}>
        <div id={roundId} className={cn(gap, 'grid scroll-mt-6 items-start gap-3 overflow-x-clip', columns)}>
          {item.speeches.map((speech) => {
            const seat = seatOf(discussion, speech.seatId);
            return seat ? <SpeechCard key={speech.id} {...props(speech)} seat={seat} expanded={open.has(speech.id)} onExpand={(next) => expand(speech.id, next)} /> : null;
          })}
        </div>
        {discussion.format === 'review' && <Edits speeches={item.speeches} discussion={discussion} editable={editable} onToggle={onToggleEdit} />}
      </Fragment>
    );
  };

  return (
    <div className="@container flex flex-col">
      {discussion.format === 'review' && <UserMessage text={prompt} attachments={NO_ATTACHMENTS} time={discussion.createdAt} />}
      {blocks.map(block)}
    </div>
  );
}

/** Reserve the first round's layout while reading the discussion detail. */
export function CouncilStageSkeleton({ summary }: { summary: CouncilSummary }) {
  const members = summary.seats.filter((seat) => !LEAD_ROLES.has(seat.role));
  const lines = (
    <div className="flex flex-col gap-2.5">
      <Skeleton className="h-4 w-full rounded-md" />
      <Skeleton className="h-4 w-11/12 rounded-md" />
      <Skeleton className="h-4 w-2/3 rounded-md" />
    </div>
  );
  const columns = members.length >= 3 ? '@2xl:grid-cols-2 @3xl:grid-cols-3' : members.length === 2 ? '@2xl:grid-cols-2' : '';
  return (
    <div className="@container flex flex-col" aria-busy>
      {summary.format === 'ld' ? (
        <div className="grid gap-y-8 @2xl:grid-cols-2">
          {[0, 1].map((side) => (
            <div key={side} className={cn('flex flex-col gap-3', side === 0 ? '@2xl:pr-6' : '@2xl:border-l @2xl:border-line @2xl:pl-6')}>
              <Skeleton className="h-5 w-40 rounded-md" />
              {lines}
            </div>
          ))}
        </div>
      ) : (
        <div className={cn('grid items-start gap-3', columns)}>
          {members.map((_, index) => <Skeleton key={index} className="h-40 rounded-3xl" />)}
        </div>
      )}
    </div>
  );
}
