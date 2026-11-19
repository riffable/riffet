import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { WAIT_GRACE_MS } from './sessionLayout';

/**
 * The session page's frame and the conversation inside it.
 *
 * Switching conversations keeps the page looking as it was (header, reading column, side column,
 * composer, view dots) while what the conversation holds changes. The conversation, its chrome
 * included, still mounts afresh under `sessionId`, so none of its state (a draft, a dialog, a pending
 * switch, an open side discussion) can carry over to the next one: that guarantee comes from the key,
 * not from each piece of state remembering to reset itself.
 *
 * The rule for what lives above the key: presentation facts about the page only, never conversation
 * data. Today that is whether the page has already assembled. A conversation that replaces another one
 * paints in place: what it shows within `SWITCH_WINDOW_MS` (a copy held in memory or read from disk,
 * its status, the side column) plays no entrance and no transition of its own. The one motion a switch
 * has is the transcript fading in once, briefly, as on the Mac, after its copy has caught up. Content
 * that arrives after a longer wait still fades in, and opening the page from elsewhere assembles it as
 * before.
 * See docs/design/system/surfaces.md §1.1.
 */
interface Frame { shown: boolean }
interface Arrival { replacing: boolean; at: number }

/** How long after a switch what appears still counts as the switch: anything that arrives before a spinner would have shown. */
export const SWITCH_WINDOW_MS = WAIT_GRACE_MS;
/**
 * How long a switched-in transcript may stay unseen while its copy catches up with the server. A
 * local server answers well within it; past it, the copy shows and what catching up changes lands
 * where the reader can see it.
 */
export const SWITCH_HOLD_MS = 200;

const FrameContext = createContext<Frame | null>(null);
const ArrivalContext = createContext<Arrival | null>(null);
const SettlingContext = createContext(false);

export function SessionFrame({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const [frame] = useState<Frame>(() => ({ shown: false }));
  return (
    <FrameContext.Provider value={frame}>
      <SessionScope key={sessionId}>{children}</SessionScope>
    </FrameContext.Provider>
  );
}

function SessionScope({ children }: { children: ReactNode }) {
  const frame = useContext(FrameContext);
  const [arrival] = useState<Arrival>(() => ({ replacing: Boolean(frame?.shown), at: performance.now() }));
  // What changes right after mount (the composer taking focus, `:hover` under a pointer that has not
  // moved, measured geometry) would otherwise transition as if the page had just appeared. A held
  // transition starts nothing when it is released.
  const [settling, setSettling] = useState(arrival.replacing);
  useEffect(() => { if (frame) frame.shown = true; }, [frame]);
  useEffect(() => {
    if (!settling) return;
    const timer = window.setTimeout(() => setSettling(false), Math.max(0, SWITCH_WINDOW_MS - (performance.now() - arrival.at)));
    return () => window.clearTimeout(timer);
  }, [settling, arrival]);
  return (
    <ArrivalContext.Provider value={arrival}>
      <SettlingContext.Provider value={settling}>
        <div className={cn('contents', settling && '**:transition-none!')}>{children}</div>
      </SettlingContext.Provider>
    </ArrivalContext.Provider>
  );
}

const switching = (arrival: Arrival | null) => Boolean(arrival?.replacing && performance.now() - arrival.at < SWITCH_WINDOW_MS);

/**
 * Whether [ready] became true as part of a switch to this conversation: what it describes then takes
 * the place of what was there instead of playing its own entrance. Decided each time [ready] turns
 * true and held while it stays true, so a class it gates is never added to an element already on
 * screen (which would start the animation then). Call it where the gated element mounts, one call per
 * element: a decision shared by elements that come and go separately is wrong for the later ones.
 * Outside a session frame it is false.
 */
export function useSwitchedIn(ready = true): boolean {
  const arrival = useContext(ArrivalContext);
  const decided = useRef<boolean | undefined>(undefined);
  if (!ready) decided.current = undefined;
  else if (decided.current === undefined) decided.current = switching(arrival);
  return decided.current ?? false;
}

/**
 * True during a switch's window. For an entrance that keeps its class because it replays later (an
 * element shown again after `hidden`): give it no duration while this holds. One that ran at mount
 * has finished by the end of the window, which is longer than any entrance, so restoring the
 * duration replays nothing.
 */
export function useSwitchSettling(): boolean {
  return useContext(SettlingContext);
}
