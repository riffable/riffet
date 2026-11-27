import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconChevronRight, IconSparkles } from '@/components/icons';
import { Collapse } from '@/components/ui/collapse';
import { ShimmerText } from '@/components/ui/controls';
import { formatDuration } from '@/lib/format-duration';
import { cn, formatDateTime } from '@/lib/utils';
import { canReleaseDeferredProcessFold, decideProcessFold, TRANSCRIPT_ATTR, type ProcessFoldMetrics } from './readingAnchor';
import { ASSEMBLY_MS, revealOnOwnHover, useLingering, useRestReveal } from './sessionLayout';
import { useTranscriptResources } from './transcriptResources';

/**
 * The transcript is still receiving what was written while nobody watched (a conversation opened from
 * its saved copy, a stream redialed): `catchingUp`. Meanwhile and just after, `quiet`: a block that
 * changes then does so without animating, because nothing happened; it only was not known yet.
 */
export const TranscriptCatchUp = createContext({ catchingUp: false, quiet: false });

interface Props {
  running: boolean;
  issueCount: number;
  /** Stopped work and output preceding steering remain expanded unless folded by hand. */
  interrupted: boolean;
  /** The turn was stopped while this block was its end: the header says so, once, for the turn. */
  stopped?: boolean;
  startedAt?: number;
  endedAt?: number;
  footerTime?: string;
  /** The newest transcript row keeps its time and actions visible, matching the Mac client. */
  footerPinned?: boolean;
  /** Shown beside `footerTime`, never without it: the answer's actions and the timestamp appear together. */
  footerActions?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** An item or tool run inside this process block was opened by the reader. */
  detailOpen?: boolean;
  /** The reader's remembered choice, including an explicit false. */
  choice?: boolean;
  /** The reader opened or folded the block by hand. */
  onOpenChange?: (open: boolean) => void;
  /** Opens the block, as for a 收藏 jump to something inside it, which then stays open to read. */
  reveal?: number;
  /** The turn runs and ends on this block for now: the footer's place is held, showing this (the working line, or nothing). */
  progress?: ReactNode;
  /**
   * The block may fold itself: the turn finished normally, with a final answer and no unfinished
   * tool call. Omitted, a block folds once it is not running, interrupted, or reporting issues,
   * which is what the design specimens and council speeches pass by leaving this out.
   */
  canAutoFold?: boolean;
}

/**
 * Pi-desktop style "turn process" disclosure: collapses the thoughts and tool calls
 * inside one turn into a single header row. Stays open while the turn is running, stopped,
 * failing, or otherwise not allowed to fold, and folds only when `canAutoFold` becomes true.
 * A flicker of `running` alone never folds the block. Mirrors one lightweight row, not a card.
 */
export function TurnProcess({ running, issueCount, interrupted, stopped = false, startedAt, endedAt, footerTime, footerPinned, footerActions, children, defaultOpen, detailOpen = false, choice, onOpenChange, reveal, progress, canAutoFold }: Props) {
  const { t } = useLingui();
  const resources = useTranscriptResources();
  const { quiet } = useContext(TranscriptCatchUp);
  /** Explicit reader choices survive completion; automatic expansion never records a choice. */
  const [manualChoice, setManualChoice] = useState<boolean | undefined>(() => (reveal !== undefined ? true : choice));
  const [prevChoice, setPrevChoice] = useState(choice);
  const [prevReveal, setPrevReveal] = useState(reveal);
  /**
   * An automatic fold put off while the reader is off-bottom reading prose below this block, so
   * turn completion changes 0px above the viewport. Does not record a manual choice, so once the
   * reader returns to following or scrolls above the block (moving it off-screen below) it folds
   * cleanly without disturbing reading.
   */
  const [deferredFold, setDeferredFold] = useState(false);
  /** Folding is allowed only for a normal completion. Callers that omit it keep the historical rule. */
  const autoFold = canAutoFold ?? (!running && !interrupted && issueCount === 0);
  const previousAutoFold = useRef(autoFold);
  const previousRunning = useRef(running);
  const previousDeferred = useRef(false);
  const section = useRef<HTMLElement>(null);
  const contentsId = useId();
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  if (choice !== prevChoice) {
    setPrevChoice(choice);
    setManualChoice(choice);
  }
  if (reveal !== prevReveal) {
    setPrevReveal(reveal);
    if (reveal !== undefined) setManualChoice(true);
  }

  // Derive disclosure state synchronously during render so completion lands in the same React
  // commit as the transcript update (and its scroll reconciliation), with no multi-commit lag.
  // `running` falling on its own is not a completion: the block stays open until auto-fold is allowed.
  const automaticOpen = Boolean(defaultOpen || detailOpen || running || interrupted || issueCount > 0 || !autoFold);
  const folding = (!previousAutoFold.current && autoFold)
    || (autoFold && !running && previousRunning.current)
    || (previousDeferred.current && !deferredFold && autoFold && manualChoice === undefined);
  const keepForReader = folding && manualChoice === undefined && !automaticOpen && beingRead(section.current);
  const foldMetrics = folding && manualChoice === undefined && !automaticOpen && !keepForReader
    ? measureProcessFold(section.current)
    : undefined;
  const foldAction = foldMetrics ? decideProcessFold(foldMetrics) : undefined;
  const deferFold = !deferredFold && foldAction === 'defer';
  const open = manualChoice ?? (keepForReader || deferredFold || deferFold || automaticOpen);
  const instantFold = folding && !open && foldAction === 'instant';

  /**
   * Contents that have been shown once stay mounted when folded (`Collapse keep`, hidden with
   * `until-found`): a tool row keeps whether it was expanded, a row coming back does not replay its
   * entrance, and the browser's find-in-page still reaches the text and unfolds the block. Blocks
   * never opened are not mounted at all, so a long history costs no more than it did.
   */
  const kept = useRef(open);
  if (open) kept.current = true;
  /**
   * Just mounted (a conversation opening, a row scrolling back into the window), the block's state
   * is still settling as the session's status arrives: a turn found running opens in place rather
   * than growing in as if it had just started.
   */
  const onScreen = useLingering(true, ASSEMBLY_MS);

  const chooseOpen = (next: boolean) => {
    setManualChoice(next);
    onOpenChangeRef.current?.(next);
  };

  useEffect(() => {
    if (reveal === undefined) return;
    onOpenChangeRef.current?.(true);
  }, [reveal]);

  useLayoutEffect(() => {
    if (keepForReader) chooseOpen(true);
    if (deferFold) setDeferredFold(true);
    else if (deferredFold && (!autoFold || manualChoice !== undefined)) setDeferredFold(false);
    previousAutoFold.current = autoFold;
    previousRunning.current = running;
    previousDeferred.current = (!autoFold || manualChoice !== undefined) ? false : (deferredFold || deferFold);
  }, [autoFold, running, keepForReader, deferFold, deferredFold, manualChoice]);

  useEffect(() => {
    if (!deferredFold) return;
    const element = section.current;
    const scroller = element?.closest<HTMLElement>(`[${TRANSCRIPT_ATTR.scroll}]`);
    if (!element || !scroller) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const canRelease = () => {
      const metrics = measureProcessFold(section.current);
      return Boolean(metrics && canReleaseDeferredProcessFold(metrics));
    };
    const tryRelease = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!canRelease()) return;
      setDeferredFold(false);
    };
    // Wait until scrolling settles so releasing the fold never interrupts momentum.
    const scheduleRelease = () => {
      clearTimeout(timer);
      if (!canRelease()) return;
      timer = setTimeout(tryRelease, 180);
    };
    const observer = new MutationObserver(scheduleRelease);
    observer.observe(scroller, { attributes: true, attributeFilter: [TRANSCRIPT_ATTR.following] });
    scroller.addEventListener('scroll', scheduleRelease, { passive: true });
    scroller.addEventListener('scrollend', tryRelease);
    // Cover the case where following already flipped true before this effect attached.
    scheduleRelease();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      scroller.removeEventListener('scroll', scheduleRelease);
      scroller.removeEventListener('scrollend', tryRelease);
    };
  }, [deferredFold]);

  const elapsedMs = !running && startedAt !== undefined && endedAt !== undefined ? Math.max(0, endedAt - startedAt) : 0;
  const rest = useRestReveal();
  const done = stopped ? t`已停止` : t`已处理`;
  const label = running ? t`处理中` : elapsedMs >= 1000 ? `${done} · ${formatDuration(elapsedMs)}` : done;
  // A held footer keeps its gap whether or not the working line shows in it, so the line coming and
  // going moves nothing.
  const hasFooter = Boolean(footerTime || progress !== undefined);

  return (
    <section ref={section} data-process-open={open} className={cn('group/process flex min-w-0 flex-col', open && 'is-open')}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={kept.current ? contentsId : undefined}
        onClick={() => chooseOpen(!open)}
        className={cn(
          // The row hugs its content instead of spanning the column: a full-width band under the
          // answer reads as a stray divider. The pill keeps 8px of padding on both sides, and the
          // enclosing row is widened by that same 8px (see `TranscriptView`) so the icon inside the
          // padding still lands on the text column.
          'group/tp flex min-h-7 w-fit max-w-full min-w-0 items-center gap-2 self-start rounded-md px-2 text-left text-sm text-fg-3 transition-colors hover:bg-hover hover:text-fg-2 no-hover:min-h-11',
        )}
      >
        <span className="grid size-4 shrink-0 place-items-center [&_svg]:size-[15px]"><IconSparkles className={cn(running && 'text-accent')} /></span>
        <ShimmerText active={running} className="min-w-0 truncate">{label}</ShimmerText>
        <IconChevronRight className={cn('size-3.5 shrink-0 text-fg-4 opacity-70 transition-transform duration-[var(--duration-base)] ease-out-soft', open && 'rotate-90')} />
      </button>
      {/* Opening and on-screen folding animate height; folds whose lost height `scrollTop` can
          absorb land in a single synchronous commit so visible prose below never moves. */}
      <Collapse open={open} keep still={!onScreen || quiet || instantFold} id={contentsId} onReveal={() => chooseOpen(true)}>
        {/* No left rail or indent: a turn's contents line up with its own header. Indentation
            is reserved for genuinely nested detail (a tool row expanding its own payload).
            `mx-2` cancels the row's own widening, so the contents stay on the text column. The
            spacing folds away with the region. */}
        <div data-process-body className={cn('mx-2 mt-1 flex min-w-0 flex-col pt-0.5', !hasFooter && 'pb-1')}>
          {children}
        </div>
      </Collapse>
      {hasFooter && (
        // `ml-0.5` undoes most of the row's 8px widening, so this row hangs 6px outward exactly
        // like the footer under an answer and the two line up. Keep the normal block gap above
        // both the working line and the settled footer, so changing between them moves nothing.
        <div {...rest} className={cn('turn-footer timeline-gap-block ml-0.5 flex min-h-7 cursor-default select-none flex-wrap items-center gap-1 transition-opacity can-hover:-ml-3.5 no-hover:min-h-11', footerTime && !footerPinned && !resources && revealOnOwnHover)}>
          {footerTime ? <>
            {footerActions}
            <time dateTime={footerTime} className="shrink-0 px-1 text-2xs tabular-nums text-fg-3">{formatDateTime(footerTime)}</time>
          </> : progress && <div className="ml-1.5 min-w-0">{progress}</div>}
        </div>
      )}
    </section>
  );
}

/**
 * The reader is inspecting something inside [element] — an expanded tool run, tool call or thought,
 * or an active text selection within it — so folding the block on completion would close what they
 * opened. Merely scrolling past a tall process block does not keep it open.
 */
function beingRead(element: HTMLElement | null): boolean {
  if (!element) return false;
  if (element.querySelector('[data-tool-run-choice="true"]')) return true;
  for (const node of element.querySelectorAll('[data-slot="disclosure"][aria-expanded="true"]')) {
    if (!node.closest('[data-tool-run-open="false"]')) return true;
  }
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return selection.getRangeAt(0).intersectsNode(element);
}

/** Exact height that disappears when [element]'s `Collapse` folds, including body margins. */
function collapsibleHeight(element: HTMLElement): number {
  const region = element.querySelector<HTMLElement>(`:scope > [${TRANSCRIPT_ATTR.collapseState}]`);
  if (region) return region.getBoundingClientRect().height;
  const body = element.querySelector<HTMLElement>(`[${TRANSCRIPT_ATTR.processBody}]`);
  if (body) {
    const style = getComputedStyle(body);
    return body.getBoundingClientRect().height + (Number.parseFloat(style.marginTop) || 0) + (Number.parseFloat(style.marginBottom) || 0);
  }
  const header = element.firstElementChild?.getBoundingClientRect().height ?? 0;
  return Math.max(0, element.getBoundingClientRect().height - header);
}

function measureProcessFold(element: HTMLElement | null): ProcessFoldMetrics | undefined {
  if (!element) return undefined;
  const scroller = element.closest<HTMLElement>(`[${TRANSCRIPT_ATTR.scroll}]`);
  if (!scroller) return undefined;
  const view = scroller.getBoundingClientRect();
  const row = element.closest<HTMLElement>(`[${TRANSCRIPT_ATTR.rowKey}]`) ?? element;
  const box = row.getBoundingClientRect();
  return {
    following: scroller.getAttribute(TRANSCRIPT_ATTR.following) === 'true',
    scrollTop: scroller.scrollTop,
    collapsible: collapsibleHeight(element),
    boxTop: box.top,
    boxBottom: box.bottom,
    viewTop: view.top,
    viewBottom: view.bottom,
  };
}
