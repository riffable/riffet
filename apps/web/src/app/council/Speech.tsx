import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react';
import { flushSync } from 'react-dom';
import { useLingui } from '@lingui/react/macro';
import { MOTION_DURATION, MOTION_EASING, type CouncilDiscussion, type CouncilSeat, type CouncilSpeech, type NativeBackendId, type TimelineRow } from '@contracts';
import type { TimelineItem } from '../../../../../packages/timeline/src/model';
import { AgentLogo } from '@/components/AgentLogo';
import { IconArrowLeft, IconArrowRight, IconMaximize, IconMessageSquareText, IconMinimize } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Badge, Spinner } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { agentMarkStyle, agentTint } from '@/lib/backends';
import { cancelAnimations } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { timelineItem } from '@/sync/rows';
import { AssistantMessage, MessageFooter, PlanBlock, StatusRow, ThoughtRow, ToolRow, WorkingIndicator } from '../session/Timeline';
import { TurnProcess } from '../session/TurnProcess';
import { questionStates, readableCouncilText, seatName, splitQuestions, useCouncilLabels, type QuestionState } from './model';
import type { SpeechRowsLoadState } from './useCouncilDiscussion';

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
function SpeakerLine({ seat, name, phaseLabel, lead = false, className, children }: { seat: CouncilSeat; name: string; phaseLabel?: string; lead?: boolean; className?: string; children?: ReactNode }) {
  const labels = useCouncilLabels();
  return (
    <div className={cn('flex min-w-0 items-center gap-2 text-xs text-fg-3', className)}>
      <SeatMark seat={seat} />
      {lead ? (
        <>
          <span className="shrink-0 text-sm font-semibold text-fg">{labels.role(seat)}</span>
          {phaseLabel && <span className="shrink-0">{phaseLabel}</span>}
          <span className="min-w-0 truncate text-fg-4">{name}</span>
        </>
      ) : (
        <>
          <span className="truncate text-sm font-semibold text-fg">{name}</span>
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
  /** History read state, separate from rows already received in the stream. */
  rowsLoad?: SpeechRowsLoadState;
  onLoadRows: (speechId: string) => void;
  /** Runs again the notes turn that failed after this speech (`recordError`); resolves undefined if it could not start. */
  onRetryRecord?: (speechId: string) => Promise<CouncilDiscussion | undefined>;
  /** Where the other side sits, for a debate speech's questions. */
  opponent?: { name: string; side: 'left' | 'right' };
  /** Speaks for the format (a judge's notes, a conclusion): named by its seat, with `aside` at the line's end. */
  lead?: boolean;
  /** What the speaker line ends on: how the round stands (a record's badge). */
  aside?: ReactNode;
  /** What the format adds under the answer (proposed edits). */
  children?: ReactNode;
  /** The surrounding card provides the anchor, speaker header and compact scroll region. */
  card?: 'compact' | 'expanded';
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
  const finalText = speech.text.trim();
  const process = items.filter((item) => {
    if (item.kind === 'assistant') return item !== live && Boolean(item.text.trim()) && (streaming || item.text.trim() !== finalText);
    if (item.kind === 'thought') return Boolean(item.text.trim());
    if (item.kind === 'plan') return item.entries.length > 0;
    return item.kind === 'tool';
  });
  const answer = streaming ? live?.text ?? '' : speech.text;
  const failedTools = items.filter((item) => item.kind === 'tool' && item.event.data.status === 'failed').length;
  return { process, answer, live, streaming, failedTools };
}

/**
 * One speech: a turn of the seat's conversation, drawn with the session's rows — the thinking and tool calls folded
 * into its process, the answer below, and a debate speech's questions set apart under it. A finished speech's
 * process is read when the reader opens it.
 */
export const Speech = memo(function Speech({ speech, seat, discussion, rows, rowsLoad, onLoadRows, onRetryRecord, opponent, lead, aside, children, card }: SpeechProps) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  const { process, answer, live, streaming, failedTools } = useSpeechParts(speech, seat, rows);
  const name = seatName(seat, discussion.seats);
  const speaker = `${name} · ${labels.role(seat)}`;
  const startedAt = speech.startedAt ? Date.parse(speech.startedAt) : undefined;
  const endedAt = speech.endedAt ? Date.parse(speech.endedAt) : undefined;
  const revision = discussion.format === 'review' && speech.phase === 'conclusion';
  const visibleAnswer = useMemo(() => streaming || revision ? answer : readableCouncilText(answer, discussion.seats), [answer, discussion.seats, revision, streaming]);
  const split = useMemo(() => opponent ? splitQuestions(visibleAnswer) : { body: visibleAnswer, questions: [] }, [visibleAnswer, opponent]);
  const states = questionStates(discussion, speech, opponent && answer !== visibleAnswer ? splitQuestions(answer).questions : split.questions);
  const [inspecting, setInspecting] = useState(false);
  // The notes turn asks about the speech just given, so only the seat's latest one can be recorded again.
  const latest = discussion.speeches.findLast((s) => s.seatId === speech.seatId && s.status === 'done')?.id === speech.id;
  // A notes turn runs without the discussion running. It started with the discussion as the request returned it, and
  // is over once the discussion is saved again (notes recorded, failed anew, or stopped).
  const [recordingSince, setRecordingSince] = useState<string>();
  const recording = recordingSince !== undefined && discussion.updatedAt <= recordingSince;
  const compact = card === 'compact';
  const { box, content, scrollable, onScroll } = useSpeechScroll(compact, streaming);
  const canReadRows = !streaming && Boolean(speech.runId);
  const readRequested = canReadRows && (card === 'expanded' || inspecting);
  useEffect(() => {
    if (readRequested && rowsLoad === undefined) onLoadRows(speech.id);
  }, [readRequested, rowsLoad, onLoadRows, speech.id]);
  const showProcess = !compact && (process.length > 0 || (!card && canReadRows && (rowsLoad !== 'ready' || inspecting)));
  const historyFeedback = readRequested && (
    rowsLoad === 'failed' ? (
      <div className="flex items-center gap-2">
        <p role="alert" className="text-sm text-danger">{t`无法读取过程`}</p>
        <Button size="xs" variant="secondary" onClick={() => onLoadRows(speech.id)}>{t`重试`}</Button>
      </div>
    ) : inspecting && rowsLoad !== 'ready' ? (
      <p role="status" className="flex items-center gap-1.5 text-sm text-fg-3"><Spinner />{t`正在读取过程…`}</p>
    ) : inspecting && process.length === 0 && (
      <p role="status" className="text-sm text-fg-3">{t`没有记录到执行过程`}</p>
    )
  );
  const history = showProcess ? (
    <TurnProcess
      running={streaming && !live}
      issueCount={failedTools}
      interrupted={speech.status === 'stopped' && process.length > 0}
      stopped={speech.status === 'stopped'}
      {...(startedAt !== undefined ? { startedAt } : {})}
      {...(endedAt !== undefined ? { endedAt } : {})}
      onOpenChange={card ? undefined : setInspecting}
    >
      <div className="flex flex-col gap-2">
        {process.map((item) => <ProcessItem key={item.key} item={item} />)}
        {historyFeedback}
      </div>
    </TurnProcess>
  ) : historyFeedback;
  const reading = (
    <>
      {(split.body || (!compact && streaming)) && (
        <AssistantMessage
          text={split.body}
          streaming={streaming}
          showActions={false}
          {...(!compact && streaming && !split.questions.length ? { progress: <WorkingIndicator {...(startedAt !== undefined ? { startedAt } : {})} /> } : {})}
        />
      )}
      {compact && !answer && streaming && <WorkingIndicator {...(startedAt !== undefined ? { startedAt } : {})} />}
      {opponent && split.questions.length > 0 && (
        <QuestionCard questions={split.questions} states={states} toward={opponent.name} arrow={opponent.side} />
      )}
      {speech.status === 'failed' && <StatusRow tone="danger" text={t`发言失败，已跳过`} {...(speech.error ? { detail: speech.error } : {})} />}
      {speech.status === 'stopped' && <StatusRow tone="muted" text={t`已停止`} />}
      {speech.status === 'done' && speech.recordError && (
        // The speech stands; what later rounds, the badges and the overview read from its notes is missing.
        <StatusRow
          tone="muted"
          text={t`这次发言的记录没有生成`}
          detail={speech.recordError}
          {...(onRetryRecord && latest ? { footer: <div>
            <Button size="xs" variant="secondary" busy={recording} disabled={recording || discussion.status === 'running'} onClick={() => {
              setRecordingSince('\uffff');
              void onRetryRecord(speech.id).then((started) => setRecordingSince(started?.updatedAt));
            }}>{t`重新生成记录`}</Button>
          </div> } : {})}
        />
      )}
    </>
  );
  return (
    <section id={card ? undefined : `council-speech-${speech.id}`} aria-label={card ? undefined : speaker} className={cn('flex min-w-0 flex-col', compact ? 'gap-3' : 'scroll-mt-6 gap-2')}>
      {!card && <SpeakerLine seat={seat} name={name} lead={lead} phaseLabel={labels.phase(discussion.format, speech.phase)}>{aside}</SpeakerLine>}
      {!card && history}
      {card ? (
        <div
          ref={box}
          role={compact && scrollable ? 'region' : undefined}
          aria-label={compact && scrollable ? speaker : undefined}
          tabIndex={compact && scrollable ? 0 : undefined}
          className={compact ? 'max-h-72 min-h-12 overflow-x-hidden overflow-y-auto outline-none [scrollbar-gutter:stable] focus-visible:ring-2 focus-visible:ring-focus' : undefined}
          onScroll={compact ? onScroll : undefined}
        >
          <div ref={content} className="flex min-w-0 flex-col gap-2">{reading}</div>
        </div>
      ) : reading}
      {compact && streaming && answer && <WorkingIndicator {...(startedAt !== undefined ? { startedAt } : {})} />}
      {/* History can arrive midway through an expansion. Keep it below the answer so it never shifts the prose. */}
      {card === 'expanded' && history}
      {speech.status === 'done' && !compact && children}
      {/* The time and actions close the whole speech, under what it set apart. */}
      {speech.status === 'done' && !compact && (
        <MessageFooter text={visibleAnswer} showActions {...(speech.endedAt ? { time: speech.endedAt } : {})} {...(speech.metrics ? { metrics: speech.metrics } : {})} />
      )}
      {streaming && split.questions.length > 0 && <WorkingIndicator {...(startedAt !== undefined ? { startedAt } : {})} />}
    </section>
  );
});

/** Keep each compact card at its last reading position and follow live text only while at the bottom. */
function useSpeechScroll(compact: boolean, streaming: boolean) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const position = useRef(0);
  const [scrollable, setScrollable] = useState(false);

  useLayoutEffect(() => {
    if (compact && box.current) box.current.scrollTop = position.current;
  }, [compact]);

  useLayoutEffect(() => {
    const scroller = box.current;
    const body = content.current;
    if (!compact || !scroller || !body) return;
    const measure = () => {
      const bottom = scroller.scrollHeight - scroller.clientHeight;
      setScrollable(bottom > 1);
      if (!streaming || !following.current || bottom <= scroller.scrollTop) return;
      const selection = scroller.ownerDocument.getSelection();
      if (selection && !selection.isCollapsed && (scroller.contains(selection.anchorNode) || scroller.contains(selection.focusNode))) return;
      scroller.scrollTop = bottom;
      position.current = scroller.scrollTop;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(body);
    measure();
    return () => observer.disconnect();
  }, [compact, streaming]);

  const onScroll = ({ currentTarget }: UIEvent<HTMLDivElement>) => {
    position.current = currentTarget.scrollTop;
    following.current = currentTarget.scrollHeight - currentTarget.clientHeight - position.current <= 2;
  };
  return { box, content, scrollable, onScroll };
}

const CARD_MOTION = 'council-card-layout';

/** Measure the painted positions before committing the grid change, including a transition still in progress. */
function useSpeechExpansion(onExpand: (open: boolean) => void) {
  const card = useRef<HTMLElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  const changeExpanded = (open: boolean) => {
    const item = card.current;
    const background = surface.current;
    const answer = body.current;
    const button = toggle.current;
    if (!item?.parentElement || !background || !answer || !button || typeof item.animate !== 'function') {
      onExpand(open);
      return;
    }
    const peers = Array.from(item.parentElement.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName === 'ARTICLE');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const element of [...peers, background, answer, button]) cancelAnimations(element, CARD_MOTION);
      onExpand(open);
      return;
    }

    const positions = peers.map((peer) => ({ peer, before: (peer === item ? background : peer).getBoundingClientRect() }));
    const buttonBefore = button.getBoundingClientRect();
    flushSync(() => onExpand(open));
    if (!item.isConnected) return;
    for (const element of [...peers, background, answer, button]) cancelAnimations(element, CARD_MOTION);
    const moves = positions.map(({ peer, before }) => ({ peer, before, after: peer.getBoundingClientRect() }));
    const buttonAfter = button.getBoundingClientRect();
    const easing = getComputedStyle(item).getPropertyValue('--default-transition-timing-function').trim();
    const options = { id: CARD_MOTION, duration: MOTION_DURATION.slow, easing: easing || `cubic-bezier(${MOTION_EASING.standard.join(', ')})` };

    for (const { peer, before, after } of moves) {
      if (!before.width || !after.width || !before.height || !after.height) continue;
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (dx || dy) {
        peer.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], options);
      }
      if (peer !== item) continue;
      const resized = before.width !== after.width || before.height !== after.height;
      if (dx || dy || resized) {
        item.animate([{ zIndex: 'var(--z-rail)' }, { zIndex: 'var(--z-rail)' }], options);
      }
      if (resized) {
        // Only this out-of-flow surface resizes. Its radius and the tint behind the mark
        // stay in CSS pixels, even when reversing halfway through the expansion.
        background.animate([
          { width: `${before.width}px`, height: `${before.height}px` },
          { width: '100%', height: '100%' },
        ], options);
      }
      const buttonX = buttonBefore.right - buttonAfter.right - dx;
      const buttonY = buttonBefore.top - buttonAfter.top - dy;
      if (buttonX || buttonY) {
        button.animate([
          { transform: `translate(${buttonX}px, ${buttonY}px)` },
          { transform: 'none' },
        ], options);
      }
      const clipRight = Math.max(0, after.width - before.width);
      const clipBottom = Math.max(0, after.height - before.height);
      if (clipRight || clipBottom) {
        answer.animate([
          { clipPath: `inset(0 ${clipRight}px ${clipBottom}px 0)` },
          { clipPath: 'inset(0)' },
        ], options);
      }
    }
  };
  return { card, surface, body, toggle, changeExpanded };
}

/**
 * A speech among others given at the same time. The card scrolls independently and can open across the row.
 */
export const SpeechCard = memo(function SpeechCard({ expanded, onExpand, ...props }: SpeechProps & { expanded: boolean; onExpand: (open: boolean) => void }) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  const { speech, seat, discussion } = props;
  const { card, surface, body, toggle, changeExpanded } = useSpeechExpansion(onExpand);
  const name = seatName(seat, discussion.seats);
  const speaker = `${name} · ${labels.role(seat)}`;
  const toggleLabel = expanded ? t`收起` : t`展开`;
  return (
    <article ref={card} id={`council-speech-${speech.id}`} aria-label={speaker} className={cn('relative isolate flex min-w-0 scroll-mt-6 flex-col gap-3 px-5 pt-4 pb-3', expanded && 'col-span-full')}>
      <div ref={surface} aria-hidden className="pointer-events-none absolute top-0 left-0 -z-10 size-full overflow-hidden rounded-3xl bg-subtle [contain:strict]">
        {speech.status !== 'failed' && <Halo backend={seat.model.backendId} className="-top-24 -left-28 h-48 w-96" />}
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <MarkTile backend={seat.model.backendId} size="sm" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold text-fg">{name}</span>
          <span className="truncate text-xs text-fg-3">{labels.role(seat)}{discussion.format === 'prism' && ` · ${labels.phase(discussion.format, speech.phase)}`}</span>
        </div>
        {(expanded || speech.status === 'done' || speech.status === 'streaming') && (
          <Tip label={toggleLabel}>
            <Button ref={toggle} size="icon-sm" variant="quiet" className="no-hover:size-11" aria-expanded={expanded} aria-label={toggleLabel} onClick={() => changeExpanded(!expanded)}>
              {expanded ? <IconMinimize /> : <IconMaximize />}
            </Button>
          </Tip>
        )}
      </div>
      <div ref={body} className="flex min-w-0 flex-col gap-3">
        <Speech {...props} card={expanded ? 'expanded' : 'compact'} />
      </div>
    </article>
  );
});
