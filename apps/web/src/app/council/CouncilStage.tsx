import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { CouncilDiscussion, CouncilEdits, CouncilLedger, CouncilModeration, CouncilPhase, CouncilProbe, CouncilSeat, CouncilSpeech, CouncilSupplement } from '@contracts';
import { IconArrowRight } from '@/components/icons';
import { Badge } from '@/components/ui/controls';
import { Checkbox } from '@/components/ui/checkbox';
import { Tip } from '@/components/ui/tooltip';
import { agentTint } from '@/lib/backends';
import { cn } from '@/lib/utils';
import { DiffView, UserMessage } from '../session/Timeline';
import { LEAD_ROLES, alike, seatName, seatOf, useCouncilLabels, type SpeechRows } from './model';
import { Halo, MarkTile, SeatMark, Speech, SpeechCard } from './Speech';

const NO_ATTACHMENTS: never[] = [];

/**
 * How the stage lays a discussion out: the reader's notes where they were added, a round's heading where it starts,
 * a debate round as its two sides, speeches given at once as a row of cards, and a lead seat's speech (notes on the
 * round, the conclusion) across the page.
 */
type Block =
  | { kind: 'note'; note: CouncilSupplement }
  | { kind: 'round'; round: number }
  | { kind: 'sides'; round: number; speeches: CouncilSpeech[] }
  | { kind: 'cards'; speeches: CouncilSpeech[] }
  | { kind: 'lead'; speech: CouncilSpeech };

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
    if (rounds && speech.phase !== 'conclusion' && speech.round !== previous?.round) { flush(); blocks.push({ kind: 'round', round: speech.round }); }
    if (lead(speech)) { flush(); blocks.push({ kind: 'lead', speech }); return; }
    if (d.format === 'ld') {
      if (group?.kind !== 'sides' || group.round !== speech.round) { flush(); group = { kind: 'sides', round: speech.round, speeches: [] }; }
      group.speeches.push(speech);
      return;
    }
    const first = group?.kind === 'cards' ? group.speeches[0] : undefined;
    if (!first || first.round !== speech.round || first.phase !== speech.phase) { flush(); group = { kind: 'cards', speeches: [] }; }
    group!.speeches.push(speech);
  });
  flush();
  for (const note of d.supplements.filter((item) => item.after >= d.speeches.length)) blocks.push({ kind: 'note', note });
  return blocks;
}

type Stage = { key: string; label: string; state: 'done' | 'on' | 'todo' };

const PHASES: Partial<Record<CouncilDiscussion['format'], CouncilPhase[]>> = {
  prism: ['explore', 'probe', 'deepen', 'conclusion'],
  review: ['review', 'conclusion'],
};

/** Where the discussion is: its rounds, or for a format without rounds its phases, each done, under way or to come. */
function useStages(d: CouncilDiscussion): Stage[] {
  const labels = useCouncilLabels();
  const phases = PHASES[d.format];
  const over = d.status === 'done';
  if (phases) {
    const reached = Math.max(0, ...d.speeches.filter((s) => s.status !== 'failed').map((s) => phases.indexOf(s.phase)));
    return phases.map((phase, index) => ({
      key: phase, label: labels.phase(d.format, phase),
      state: over || index < reached ? 'done' : index === reached ? 'on' : 'todo',
    }));
  }
  // A discussion that ended early shows the rounds it held, not the ones it could have.
  const last = d.closingRound ?? (over ? Math.min(Math.max(1, d.round), d.maxRounds) : d.maxRounds);
  return Array.from({ length: last }, (_, index) => index + 1).map((round) => ({
    key: String(round),
    label: d.format === 'ld' ? labels.phase('ld', round === 1 ? 'opening' : round >= last ? 'closing' : 'rebuttal') : labels.round(round),
    state: over || round < d.round ? 'done' : round === d.round ? 'on' : 'todo',
  }));
}

function Stages({ stages }: { stages: Stage[] }) {
  const { t } = useLingui();
  const wide = stages.length <= 5;
  return (
    <ol className="flex flex-wrap justify-center gap-1.5" aria-label={t`进度`}>
      {stages.map((stage) => (
        <li key={stage.key} aria-current={stage.state === 'on' ? 'step' : undefined} className={cn('flex flex-col items-center gap-1 text-2xs', stage.state === 'on' ? 'font-medium text-fg' : stage.state === 'done' ? 'text-fg-3' : 'text-fg-4')}>
          <span className={cn('block h-1 rounded-full', wide ? 'w-11' : 'w-8', stage.state === 'on' ? 'bg-fg' : stage.state === 'done' ? 'bg-fg-3' : 'bg-muted')} />
          <span className="whitespace-nowrap">{stage.label}</span>
        </li>
      ))}
    </ol>
  );
}

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
      <div className="flex flex-col items-center gap-1.5" role="img" aria-label={said}>
        <span className="relative block h-1.5 w-60 rounded-full bg-muted max-sm:w-48">
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

/** LD: the two sides facing each other, what each still owes, and how far the debate has come. */
function Scoreboard({ discussion }: { discussion: CouncilDiscussion }) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  const stages = useStages(discussion);
  const pro = discussion.seats.find((item) => item.role === 'pro');
  const con = discussion.seats.find((item) => item.role === 'con');
  const latest = discussion.speeches.findLast((s) => s.status === 'done' && s.directive?.kind === 'ledger')?.directive as CouncilLedger | undefined;
  const score = momentum(discussion);
  const side = (item: CouncilSeat | undefined, end: boolean) => {
    if (!item) return <span />;
    const owed = latest?.crossExam.filter((q) => q.asker !== item.role && q.answered === 'pending').length ?? 0;
    return (
      <div className={cn('flex min-w-0 items-center gap-3', end && 'flex-row-reverse text-right')}>
        <MarkTile backend={item.model.backendId} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold text-fg">{seatName(item)}</span>
          <span className="truncate text-xs text-fg-3">{labels.role(item)}{owed > 0 && <> · {t`${owed} 问待回应`}</>}</span>
        </div>
      </div>
    );
  };
  return (
    <div className="relative isolate grid grid-cols-2 items-center gap-x-6 gap-y-4 overflow-hidden rounded-3xl bg-subtle px-6 py-5 @2xl:grid-cols-[1fr_auto_1fr]">
      {pro && <Halo backend={pro.model.backendId} className="-left-[12%] -top-[90%] h-[280%] w-[45%]" />}
      {con && <Halo backend={con.model.backendId} className="-right-[12%] -top-[90%] h-[280%] w-[45%]" />}
      {side(pro, false)}
      <div className="col-span-2 row-start-2 flex flex-col items-center gap-3 @2xl:col-span-1 @2xl:col-start-2 @2xl:row-start-1">
        {score !== undefined && pro && con && <Momentum score={score} pro={pro} con={con} />}
        <Stages stages={stages} />
      </div>
      {side(con, true)}
    </div>
  );
}

/** Every other format: who takes part, and how far the discussion has come. */
function Cast({ discussion }: { discussion: CouncilDiscussion }) {
  const labels = useCouncilLabels();
  const stages = useStages(discussion);
  const members = discussion.seats.filter((seat) => !LEAD_ROLES.has(seat.role));
  const moderation = discussion.speeches.findLast((s) => s.status === 'done' && s.directive?.kind === 'moderation')?.directive as CouncilModeration | undefined;
  return (
    <div className="flex flex-col gap-5 rounded-3xl bg-subtle px-6 py-5">
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-4 gap-y-3">
        {members.map((seat) => (
          <li key={seat.id} className="flex min-w-0 items-center gap-3">
            <MarkTile backend={seat.model.backendId} />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold text-fg">{seatName(seat)}</span>
              <span className="truncate text-xs text-fg-3">{labels.role(seat)}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line pt-4">
        <Stages stages={stages} />
        {moderation && <Convergence value={moderation.convergence} />}
      </div>
    </div>
  );
}

/** The question itself, under the stage, with the format and who leads it. */
function Headline({ discussion }: { discussion: CouncilDiscussion }) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  const lead = discussion.seats.find((seat) => LEAD_ROLES.has(seat.role));
  const title = discussion.format === 'review' ? discussion.document?.title || labels.format('review') : discussion.topic;
  const long = title.length > 80;
  const rounds = discussion.format === 'ld' || discussion.format === 'roundtable';
  const value = discussion.maxRounds;
  return (
    <header className="flex flex-col items-center gap-2 text-center">
      <h1 className={cn('max-w-2xl whitespace-pre-wrap text-balance text-fg', long ? 'text-base font-medium leading-7' : 'text-xl font-semibold')}>{title}</h1>
      <p className="flex flex-wrap items-center justify-center gap-x-1.5 text-xs text-fg-3">
        <span>{labels.format(discussion.format)}</span>
        {rounds && <span>· {t`最多 ${value} 轮`}</span>}
        {lead && (
          <span className="flex min-w-0 items-center gap-1.5">
            · <span>{labels.role(lead)}</span><SeatMark seat={lead} /><span className="max-w-48 truncate">{seatName(lead)}</span>
          </span>
        )}
      </p>
    </header>
  );
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
          <span className="min-w-0 leading-6 text-fg-2">{item.point}</span>
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
          <span className="text-fg-2">{item.question}</span>
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
export function CouncilStage({ discussion, rows, onLoadRows, onToggleEdit }: {
  discussion: CouncilDiscussion;
  rows: SpeechRows;
  onLoadRows: (speechId: string) => void;
  onToggleEdit: (id: string, accepted: boolean) => void;
}) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const blocks = useMemo(() => blocksOf(discussion), [discussion]);
  const stages = useStages(discussion);
  const editable = discussion.format === 'review' && discussion.status === 'paused' && discussion.round === 1;
  const prompt = (discussion.document?.paragraphs.map((p) => p.text) ?? []).join('\n\n');
  const expand = (id: string, next: boolean) => setOpen((current) => { const copy = new Set(current); if (next) copy.add(id); else copy.delete(id); return copy; });
  const props = (speech: CouncilSpeech) => ({ speech, discussion, rows: rows[speech.id], onLoadRows });

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
    if (item.kind === 'note') return <div key={item.note.id} className="timeline-gap-turn"><UserMessage text={item.note.text} attachments={NO_ATTACHMENTS} time={item.note.at} /></div>;
    if (item.kind === 'round') {
      const stage = discussion.format === 'ld' ? stages[item.round - 1]?.label : undefined;
      return (
        <h2 key={`round-${item.round}`} id={`council-round-${item.round}`} className="timeline-gap-turn flex scroll-mt-6 items-center gap-3 text-xs font-medium text-fg-3">
          <span aria-hidden className="h-px flex-1 bg-line" />
          <span>{labels.round(item.round)}{stage && ` · ${stage}`}</span>
          <span aria-hidden className="h-px flex-1 bg-line" />
        </h2>
      );
    }
    const gap = blocks[index - 1]?.kind === 'round' ? 'timeline-gap-block' : 'timeline-gap-turn';
    if (item.kind === 'lead') {
      const seat = seatOf(discussion, item.speech.seatId);
      if (!seat) return null;
      const conclusion = item.speech.phase === 'conclusion';
      return (
        <div key={item.speech.id} className={cn(gap, 'relative isolate overflow-hidden rounded-3xl px-6 pt-5 pb-3', conclusion ? 'border border-line-strong bg-elevated' : 'bg-subtle')}>
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
              <div className="flex items-center gap-2 text-xs text-fg-4"><SeatMark seat={seat} /><span>{seatName(seat)}</span><span>{t`等候发言`}</span></div>
            )}
          </div>
        );
      };
      return (
        <div key={`sides-${item.round}-${item.speeches[0]!.id}`} className={cn(gap, 'grid items-stretch gap-y-8 @2xl:grid-cols-2')}>
          {column(pro, 'left')}
          {column(con, 'right')}
        </div>
      );
    }
    const columns = item.speeches.length >= 3 ? '@2xl:grid-cols-2 @3xl:grid-cols-3' : item.speeches.length === 2 ? '@2xl:grid-cols-2' : '';
    return (
      <Fragment key={`cards-${item.speeches[0]!.id}`}>
        <div className={cn(gap, 'grid items-start gap-3', columns)}>
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
      {discussion.format === 'ld' ? <Scoreboard discussion={discussion} /> : <Cast discussion={discussion} />}
      <div className="mt-8"><Headline discussion={discussion} /></div>
      {/* A document under review is read in full; a question is the headline. */}
      {discussion.format === 'review' && <div className="timeline-gap-turn"><UserMessage text={prompt} attachments={NO_ATTACHMENTS} time={discussion.createdAt} /></div>}
      {blocks.map(block)}
    </div>
  );
}
