import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useLingui } from '@lingui/react/macro';
import { IconCircleAlert, IconMic } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/controls';
import { needsSpace } from '@/lib/dictation/stream';
import { cn } from '@/lib/utils';
import { clock, levelHeight, useFailureText } from './DictationBar';
import { DICTATION_WARN_MS, HOLD_CANCEL_PX, HOLD_TAP_MS, type DictationView } from './useDictation';

/** How a hold ended: a quick tap leaves the recording to the dictation bar, a release finishes it, the cancel zone drops it. */
export type HoldEnd = 'tap' | 'finish' | 'cancel';

/**
 * One hold: the composer it began on, whether the draft was empty then, and where the finger is. `docked`: the composer sits at
 * the bottom of the screen, and the dome covers it whole for the hold.
 */
export interface HoldSession { anchor: DOMRect; emptyDraft: boolean; docked: boolean; cancelling: boolean; released: boolean }

/** A composer whose top is in the lowest part of the window is docked there (a session); higher up it is part of the page. */
export const holdDocked = (anchor: DOMRect) => window.innerHeight - anchor.top <= window.innerHeight * 0.4;

const BUBBLE_BARS = 16;
const DOME_HEIGHT = 136;
/** Covers `--duration-fast`: the overlay leaves the tree once its exit has played. */
const EXIT_MS = 200;
/** How far the dome's middle rises above its sides. */
const DOME_BOW = 24;

/**
 * The「按住 说话」bar (docs/design/system/surfaces.md「语音输入（触屏）」). The pointer is captured on press, so the finger
 * keeps reporting to it while the overlay is up; a keyboard or switch activation records hands-free, as a tap does.
 */
export function HoldToTalkBar({ pressed, disabled, busy, tall, onPress, onZone, onEnd, className }: {
  pressed: boolean; disabled?: boolean; /** The dictation is finishing: a spinner for the label. */ busy?: boolean; tall?: boolean; className?: string;
  onPress: () => void; onZone: (cancelling: boolean) => void; onEnd: (end: HoldEnd) => void;
}) {
  const { t } = useLingui();
  const press = useRef<{ id: number; y: number; at: number; cancelling: boolean } | null>(null);
  const end = (event: ReactPointerEvent, how: (held: NonNullable<typeof press.current>) => HoldEnd) => {
    const held = press.current;
    if (!held || held.id !== event.pointerId) return;
    press.current = null;
    onEnd(how(held));
  };
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        'flex w-full min-w-0 select-none items-center justify-center rounded-xl text-base font-medium text-fg-2 outline-none transition-colors touch-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50',
        tall ? 'min-h-11' : 'h-9',
        busy && 'disabled:opacity-100',
        pressed ? 'bg-active' : 'bg-subtle',
        className,
      )}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (disabled || press.current || (event.pointerType === 'mouse' && event.button !== 0)) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        press.current = { id: event.pointerId, y: event.clientY, at: performance.now(), cancelling: false };
        onPress();
      }}
      onPointerMove={(event) => {
        const held = press.current;
        if (!held || held.id !== event.pointerId) return;
        const cancelling = held.y - event.clientY > HOLD_CANCEL_PX;
        if (cancelling === held.cancelling) return;
        held.cancelling = cancelling;
        onZone(cancelling);
      }}
      onPointerUp={(event) => end(event, (held) => performance.now() - held.at < HOLD_TAP_MS ? 'tap' : held.cancelling ? 'cancel' : 'finish')}
      // The system took the touch (a call, a permission prompt): what was said is kept.
      onPointerCancel={(event) => end(event, (held) => held.cancelling ? 'cancel' : 'finish')}
      onLostPointerCapture={(event) => end(event, (held) => held.cancelling ? 'cancel' : 'finish')}
      // A click with no pointer behind it (keyboard, switch access) records hands-free, as a tap does.
      onClick={(event) => { if (event.detail === 0 && !disabled) { onPress(); onEnd('tap'); } }}
    >
      {busy ? <Spinner className="size-4 text-fg-3" /> : t`按住 说话`}
    </button>
  );
}

/**
 * The page while a hold is on: dimmed, the bubble above the composer with what is being said, and the dome at the bottom
 * whose edge is the line to cross to cancel. It takes no touches, so the finger stays with the bar, except to answer a failure.
 */
export function HoldToTalkOverlay({ session, view, onRetry, onDiscard }: {
  session: HoldSession | null; view: DictationView; onRetry: () => void; onDiscard: () => void;
}) {
  const { t } = useLingui();
  // The overlay outlives its hold by its exit: the last hold and what it showed stay drawn while they fade, rather than the
  // bubble emptying the moment the text lands in the draft.
  const last = useRef<{ session: HoldSession; view: DictationView } | null>(null);
  if (session) last.current = { session, view };
  const active = session !== null;
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  // Mounted before the press paints: the dome is over a docked composer in that same frame.
  useLayoutEffect(() => {
    if (active) {
      setMounted(true);
      // Two frames: the first paints the overlay at rest, the second starts its entrance.
      let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setShown(true)); });
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = window.setTimeout(() => { setMounted(false); last.current = null; }, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [active]);
  const frame = last.current;
  if (!mounted || !frame) return null;
  const hold = frame.session;
  const current = session ? view : frame.view;
  const failed = current.phase === 'failed';
  const cancelling = hold.cancelling && !failed;
  // Docked, the dome covers the composer whole, its sides level with the composer's top edge, so the composer can stay where it
  // is underneath. In the page, the dome is its own strip at the bottom.
  const domeHeight = hold.docked ? Math.max(DOME_HEIGHT, window.innerHeight - hold.anchor.top + DOME_BOW) : DOME_HEIGHT;
  // In fast and landing softly; out on the standard curve, so it starts fading the moment the finger lifts (an accelerating curve
  // holds still for its first half, and the fade reads as a pause and then a cut). Nothing moves on the way in: a phone that drops
  // the first frames of a rise shows it as a jump.
  const fade = cn('transition-opacity', shown ? 'opacity-100 duration-[var(--duration-fast)] ease-[var(--ease-decelerate)]' : 'opacity-0 duration-[var(--duration-fast)] ease-[var(--ease-standard)]');
  const bubble = (
    <div className={cn('flex flex-col gap-3', fade)}
      style={{ marginLeft: hold.anchor.left, marginRight: Math.max(0, window.innerWidth - hold.anchor.right) }}>
      <HoldBubble view={current} cancelling={cancelling} />
      {failed && <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDiscard}>{t`放弃`}</Button>
        {current.failure?.kind === 'server' && current.failure.problem.retryable && <Button variant="primary" onClick={onRetry}>{t`重试`}</Button>}
      </div>}
    </div>
  );
  return createPortal(
    <div className={cn('fixed inset-0 z-(--z-dialog)', !(failed && active) && 'pointer-events-none')}>
      <div className={cn('absolute inset-0 bg-black/25 dark:bg-black/50', fade)} />
      {/* The bubble always stands on the dome: above a composer in the page it would cover whatever sits there. */}
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-3">
        {bubble}
        {/* Docked it is opaque over the composer from the first frame, so the composer never shows through it; in the page it
            fades in with the scrim. Either way it fades out with it. A failure hides it, keeping its room so the bubble with the
            retry does not move. */}
        <div className={cn('relative flex flex-col items-center gap-3',
          hold.docked && active && !failed ? 'opacity-100' : cn(fade, failed && 'opacity-0'))}
          style={{ height: domeHeight, paddingTop: DOME_BOW + 16 }} aria-hidden>
          {/* A shallow dome of the floating surface, its edge the line a finger crosses to slide away. */}
          <span className="absolute inset-0 border-t border-line bg-popover shadow-pop" style={{ borderTopLeftRadius: `50% ${DOME_BOW}px`, borderTopRightRadius: `50% ${DOME_BOW}px` }} />
          <p className={cn('relative text-center text-sm', cancelling ? 'text-danger' : 'text-fg-2')}>
            {cancelling ? t`松开取消` : t`松开转文字，上滑取消`}
          </p>
          <IconMic className={cn('relative size-7', cancelling ? 'text-fg-3' : 'text-fg')} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** What is being said: written text, the pending sentence dimmer, then the loudness and the time. */
export function HoldBubble({ view, cancelling }: { view: DictationView; cancelling: boolean }) {
  const failure = useFailureText(view.failure);
  const levels = Array.from({ length: BUBBLE_BARS }, (_, index) => view.levels[index - (BUBBLE_BARS - view.levels.length)] ?? 0);
  const space = view.written && view.live && needsSpace(view.written, view.live) ? ' ' : '';
  return (
    // The cancel tint lies over the elevated surface: on its own it is translucent, and the page would show through.
    <div className={cn('relative flex flex-col gap-3 rounded-2xl bg-popover p-4 shadow-pop before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:bg-danger-soft before:transition-opacity *:relative', cancelling ? 'before:opacity-100' : 'before:opacity-0')}>
      {view.phase === 'failed'
        ? <p role="alert" className="flex items-start gap-1.5 text-base text-danger"><IconCircleAlert className="mt-1 size-4 shrink-0" />{failure}</p>
        : (view.written || view.live) && <p className={cn('line-clamp-8 text-base', cancelling ? 'text-danger' : 'text-fg')} aria-live="polite">
          {view.written}{space}<span className={cancelling ? undefined : 'text-fg-3'}>{view.live}</span>
        </p>}
      {view.phase !== 'failed' && <div className="flex items-center justify-end gap-2">
        {view.phase === 'finishing'
          ? <Spinner className="size-4 text-fg-3" />
          : <span className="flex h-5 items-center gap-0.5" aria-hidden>
            {levels.map((level, index) => <span key={index} className={cn('w-0.5 rounded-full', cancelling ? 'bg-danger' : 'bg-fg-3')} style={{ height: `${levelHeight(level)}px` }} />)}
          </span>}
        <span className={cn('text-xs tabular-nums', view.elapsedMs >= DICTATION_WARN_MS ? 'text-warning' : 'text-fg-3')}>{clock(view.elapsedMs)}</span>
      </div>}
    </div>
  );
}
