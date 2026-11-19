import { memo, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { CouncilDiscussion, CouncilSeat, CouncilSpeech, NativeBackendId, TimelineRow } from '@contracts';
import type { TimelineItem } from '../../../../../packages/timeline/src/model';
import { AgentLogo } from '@/components/AgentLogo';
import { IconArrowLeft, IconArrowRight, IconMaximize, IconMessageSquareText, IconMinimize } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/controls';
import { agentMarkStyle, agentTint } from '@/lib/backends';
import { cn } from '@/lib/utils';
import { timelineItem } from '@/sync/rows';
import { AssistantMessage, MessageFooter, PlanBlock, StatusRow, ThoughtRow, ToolRow, WorkingIndicator } from '../session/Timeline';
import { TurnProcess } from '../session/TurnProcess';
import { questionStates, seatName, splitQuestions, useCouncilLabels, type QuestionState } from './model';

/** The mark of what a seat runs on; quick chat has none of its own and is drawn as the tab bar draws it. */
export function SeatMark({ seat, backend = seat?.model.backendId ?? 'chat', size = 14 }: { seat?: CouncilSeat; backend?: NativeBackendId; size?: number }) {
  return backend === 'chat'
    ? <IconMessageSquareText className="shrink-0 text-fg-3" style={{ width: size, height: size }} aria-hidden />
    : <AgentLogo backend={backend} size={size} className="shrink-0" style={agentMarkStyle(backend)} />;
}

const TILE = {
  sm: { box: 'size-7 rounded-lg shadow-soft', mark: 16 },
  md: { box: 'size-11 rounded-xl shadow-soft', mark: 24 },
  lg: { box: 'size-16 rounded-2xl shadow-pop', mark: 32 },
} as const;

/** A seat's mark set on a raised tile, the way the stage presents who takes part. */
export function MarkTile({ backend, size = 'md', className }: { backend: NativeBackendId; size?: keyof typeof TILE; className?: string }) {
  return (
    <span className={cn('grid shrink-0 place-items-center bg-bg', TILE[size].box, className)}>
      <SeatMark backend={backend} size={TILE[size].mark} />
    </span>
  );
}

/**
 * The light a seat's mark casts on the panel it heads, in the mark's own colour. The panel is `relative isolate
 * overflow-hidden`, so the glow sits behind what it holds and stops at its edge.
 */
export function Halo({ backend, className }: { backend: NativeBackendId; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('pointer-events-none absolute -z-10', className ?? '-inset-x-[10%] -top-[40%] h-[120%]')}
      style={{ background: `radial-gradient(closest-side, color-mix(in srgb, ${agentTint(backend)} 18%, transparent), transparent)` }}
    />
  );
}

/**
 * Who speaks: the seat's Agent and model, then its seat and what this speech is. A lead seat speaks as its seat (the
 * judge, the moderator), so its role comes first and its model after.
 */
export function SpeakerLine({ seat, phaseLabel, lead = false, className, children }: { seat: CouncilSeat; phaseLabel?: string; lead?: boolean; className?: string; children?: ReactNode }) {
  const labels = useCouncilLabels();
  return (
    <div className={cn('flex min-w-0 items-center gap-2 text-xs text-fg-3', className)}>
      <SeatMark seat={seat} />
      {lead ? (
        <>
          <span className="shrink-0 text-sm font-semibold text-fg">{labels.role(seat)}</span>
          {phaseLabel && <span className="shrink-0">{phaseLabel}</span>}
          <span className="min-w-0 truncate text-fg-4">{seatName(seat)}</span>
        </>
      ) : (
        <>
          <span className="truncate text-sm font-semibold text-fg">{seatName(seat)}</span>
          <span className="shrink-0">{labels.role(seat)}</span>
          {phaseLabel && <span className="shrink-0 text-fg-4">· {phaseLabel}</span>}
        </>
      )}
      {children && <span className="ml-auto flex shrink-0 items-center gap-1 pl-2">{children}</span>}
    </div>
  );
}

/** One item of a turn's process, drawn as the session draws it. */
function ProcessItem({ item }: { item: TimelineItem }) {
  if (item.kind === 'thought') return <ThoughtRow text={item.text} channel={item.channel} />;
  if (item.kind === 'tool') return <ToolRow item={item} />;
  if (item.kind === 'assistant') return <AssistantMessage text={item.text} showActions={false} />;
  if (item.kind === 'plan') return <PlanBlock entries={item.entries} />;
  if (item.kind === 'status') return <StatusRow tone={item.tone} text={item.text} {...(item.detail ? { detail: item.detail } : {})} />;
  return null;
}

/**
 * The questions a debate speech ends on, set apart from what it argues: aimed at the other side, each with how the
 * judge counted its answer once a round's notes name it.
 */
export function QuestionCard({ questions, states, toward, arrow }: {
  questions: readonly string[];
  states: ReadonlyArray<QuestionState | undefined>;
  /** The side they are put to. */
  toward: string;
  /** Which way the other side sits. */
  arrow: 'left' | 'right';
}) {
  const { t } = useLingui();
  const said = { direct: t`已正面回答`, dodged: t`回避`, pending: t`待回应` };
  const badge = { direct: 'success', dodged: 'danger', pending: 'neutral' } as const;
  const Arrow = arrow === 'left' ? IconArrowLeft : IconArrowRight;
  return (
    <section aria-label={t`质询`} className="flex flex-col gap-2 rounded-xl bg-subtle px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-fg-3">
        <span>{t`质询`}</span>
        <Arrow className="size-3.5" aria-hidden />
        <span>{toward}</span>
      </div>
      <ol className="flex flex-col gap-2">
        {questions.map((question, index) => {
          const state = states[index];
          return (
            <li key={index} className="flex min-w-0 items-start gap-2 text-sm text-fg">
              <span className="w-4 shrink-0 text-right text-xs leading-6 tabular-nums text-fg-3">{index + 1}</span>
              <span className="min-w-0 flex-1 leading-6">{question}</span>
              {state && <Badge tone={badge[state]} className="mt-0.5 shrink-0">{said[state]}</Badge>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export interface SpeechProps {
  speech: CouncilSpeech;
  seat: CouncilSeat;
  discussion: CouncilDiscussion;
  /** The turn's rows held so far; undefined until they came with the stream or were read. */
  rows: readonly TimelineRow[] | undefined;
  onLoadRows: (speechId: string) => void;
  /** Where the other side sits, for a debate speech's questions. */
  opponent?: { name: string; side: 'left' | 'right' };
  /** Speaks for the format (a judge's notes, a conclusion): named by its seat, with `aside` at the line's end. */
  lead?: boolean;
  /** What the speaker line ends on: how the round stands (a record's badge). */
  aside?: ReactNode;
  /** What the format adds under the answer (proposed edits). */
  children?: ReactNode;
}

/** The speech's process and answer, as its turn's rows and the speech's own text have them. */
function useSpeechParts(speech: CouncilSpeech, seat: CouncilSeat, rows: readonly TimelineRow[] | undefined) {
  const items = useMemo(
    () => (rows ?? []).flatMap((row) => row.kind === 'user' ? [] : [timelineItem(row, seat.sessionId ?? '')].filter((item): item is TimelineItem => Boolean(item))),
    [rows, seat.sessionId],
  );
  const streaming = speech.status === 'streaming';
  // While the turn runs its last words may be the answer; once it ended the answer is the speech's text.
  const last = items.at(-1);
  const live = streaming && last?.kind === 'assistant' && last.phase !== 'commentary' ? last : undefined;
  const process = live ? items.slice(0, -1) : streaming ? items : items.filter((item) => !(item.kind === 'assistant' && item.text.trim() === speech.text.trim()));
  const answer = streaming ? live?.text ?? '' : speech.text;
  const failedTools = items.filter((item) => item.kind === 'tool' && item.event.data.status === 'failed').length;
  return { process, answer, live, streaming, failedTools };
}

/**
 * One speech: a turn of the seat's conversation, drawn with the session's rows — the thinking and tool calls folded
 * into its process, the answer below, and a debate speech's questions set apart under it. A finished speech's
 * process is read when the reader opens it.
 */
export const Speech = memo(function Speech({ speech, seat, discussion, rows, onLoadRows, opponent, lead, aside, children }: SpeechProps) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  const { process, answer, live, streaming, failedTools } = useSpeechParts(speech, seat, rows);
  const startedAt = speech.startedAt ? Date.parse(speech.startedAt) : undefined;
  const endedAt = speech.endedAt ? Date.parse(speech.endedAt) : undefined;
  const split = useMemo(() => (opponent ? splitQuestions(answer) : { body: answer, questions: [] }), [answer, opponent]);
  const states = questionStates(discussion, speech, split.questions);
  // A finished speech whose rows are not here yet may still have a process: offered folded, read on opening.
  const offerProcess = process.length > 0 || (!streaming && rows === undefined && Boolean(speech.runId && seat.sessionId));
  return (
    <section id={`council-speech-${speech.id}`} aria-label={`${seatName(seat)} · ${labels.role(seat)}`} className="flex min-w-0 scroll-mt-6 flex-col gap-2">
      <SpeakerLine seat={seat} lead={lead} phaseLabel={labels.phase(discussion.format, speech.phase)}>{aside}</SpeakerLine>
      {offerProcess && (
        <TurnProcess
          running={streaming && !live}
          issueCount={failedTools}
          interrupted={speech.status === 'stopped'}
          stopped={speech.status === 'stopped'}
          {...(startedAt !== undefined ? { startedAt } : {})}
          {...(endedAt !== undefined ? { endedAt } : {})}
          onOpenChange={(open) => { if (open && rows === undefined) onLoadRows(speech.id); }}
        >
          <div className="flex flex-col gap-2">{process.map((item) => <ProcessItem key={item.key} item={item} />)}</div>
        </TurnProcess>
      )}
      {(split.body || streaming) && (
        <AssistantMessage
          text={split.body}
          streaming={streaming}
          showActions={false}
          {...(streaming && !split.questions.length ? { progress: <WorkingIndicator {...(startedAt !== undefined ? { startedAt } : {})} /> } : {})}
        />
      )}
      {opponent && split.questions.length > 0 && (
        <QuestionCard questions={split.questions} states={states} toward={opponent.name} arrow={opponent.side} />
      )}
      {speech.status === 'failed' && <StatusRow tone="danger" text={t`发言失败，已跳过`} {...(speech.error ? { detail: speech.error } : {})} />}
      {speech.status === 'stopped' && <StatusRow tone="muted" text={t`已停止`} />}
      {speech.status === 'done' && children}
      {/* The time and actions close the whole speech, under what it set apart. */}
      {speech.status === 'done' && (
        <MessageFooter text={speech.text} showActions {...(speech.endedAt ? { time: speech.endedAt } : {})} {...(speech.metrics ? { metrics: speech.metrics } : {})} />
      )}
      {streaming && split.questions.length > 0 && <WorkingIndicator {...(startedAt !== undefined ? { startedAt } : {})} />}
    </section>
  );
});

/**
 * Whether the box cuts what it holds, kept current as either changes size. The box is followed wherever it is mounted
 * (a card collapsed again mounts a new one), and so is what it holds as that is replaced (the working line by the text).
 */
function useClipped<T extends HTMLElement>() {
  const [box, setBox] = useState<T | null>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    if (!box) return;
    const measure = () => setClipped(box.scrollHeight > box.clientHeight + 1);
    const sizes = new ResizeObserver(measure);
    const follow = () => { sizes.disconnect(); sizes.observe(box); for (const child of box.children) sizes.observe(child); measure(); };
    const children = new MutationObserver(follow);
    children.observe(box, { childList: true });
    follow();
    return () => { sizes.disconnect(); children.disconnect(); };
  }, [box]);
  return [setBox, clipped] as const;
}

/**
 * A speech among others given at the same time, as a card in their row: its newest lines while it is written, its
 * opening once it is done, and the whole speech when the reader opens it, across the row.
 */
export const SpeechCard = memo(function SpeechCard({ expanded, onExpand, ...props }: SpeechProps & { expanded: boolean; onExpand: (open: boolean) => void }) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  const { speech, seat, discussion } = props;
  const { answer, streaming } = useSpeechParts(speech, seat, props.rows);
  const startedAt = speech.startedAt ? Date.parse(speech.startedAt) : undefined;
  const [box, clipped] = useClipped<HTMLDivElement>();
  if (expanded) {
    return (
      <article className="relative isolate col-span-full flex min-w-0 flex-col gap-2 overflow-hidden rounded-3xl bg-subtle px-6 pt-4 pb-3">
        <Halo backend={seat.model.backendId} className="inset-x-0 -top-24 h-48" />
        <div className="flex justify-end">
          <Button size="xs" variant="quiet" onClick={() => onExpand(false)}><IconMinimize /><span>{t`收起`}</span></Button>
        </div>
        <Speech {...props} />
      </article>
    );
  }
  return (
    <article aria-label={`${seatName(seat)} · ${labels.role(seat)}`} className="relative isolate flex min-w-0 flex-col gap-3 overflow-hidden rounded-3xl bg-subtle px-5 pt-4 pb-3">
      {speech.status !== 'failed' && <Halo backend={seat.model.backendId} className="-inset-x-[30%] -top-[60%] h-full" />}
      {/* The row shares one phase, so a card names only who speaks: the seat's mark on its tile, its model and seat. */}
      <div className="flex min-w-0 items-center gap-3">
        <MarkTile backend={seat.model.backendId} size="sm" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold text-fg">{seatName(seat)}</span>
          <span className="truncate text-xs text-fg-3">{labels.role(seat)}</span>
        </div>
        {(speech.status === 'done' || speech.status === 'streaming') && (
          <Button size="icon-sm" variant="quiet" aria-label={t`展开`} onClick={() => onExpand(true)}><IconMaximize /></Button>
        )}
      </div>
      <div
        ref={box}
        className={cn('relative flex max-h-72 min-h-12 flex-col overflow-hidden', streaming ? 'justify-end' : clipped && 'cursor-pointer')}
        onClick={streaming || !clipped ? undefined : () => onExpand(true)}
      >
        {answer && <AssistantMessage text={answer} streaming={streaming} showActions={false} />}
        {!answer && streaming && <WorkingIndicator {...(startedAt !== undefined ? { startedAt } : {})} />}
        {speech.status === 'failed' && <StatusRow tone="danger" text={t`发言失败，已跳过`} {...(speech.error ? { detail: speech.error } : {})} />}
        {speech.status === 'stopped' && <StatusRow tone="muted" text={t`已停止`} />}
        {clipped && <div aria-hidden className={cn('pointer-events-none absolute inset-x-0 h-10 from-subtle to-transparent', streaming ? 'top-0 bg-linear-to-b' : 'bottom-0 bg-linear-to-t')} />}
      </div>
      {streaming && answer && <WorkingIndicator {...(startedAt !== undefined ? { startedAt } : {})} />}
    </article>
  );
});
