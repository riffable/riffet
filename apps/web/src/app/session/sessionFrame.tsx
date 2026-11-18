import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { WAIT_GRACE_MS } from './sessionLayout';

/**
 * The session page's frame and the conversation inside it.
 *
 * The frame (header, reading column, side column, composer, view dots) stays where it is when the
 * reader moves to another conversation; only what the conversation holds changes. The conversation
 * itself is still mounted afresh under `sessionId`, so none of its state (a draft, a dialog, a
 * pending switch, an open side discussion) can carry over to the next one: that guarantee comes from
 * the key, not from each piece of state remembering to reset itself.
 *
 * What the frame keeps is only the fact that the page has already assembled. A conversation that
 * replaces another one takes its place as it is: what it shows within the wait grace of the switch
 * (a copy held in memory or read from disk, its status, the side column) plays no entrance and no
 * transition, the way a wait that short shows no spinner. Content that arrives after a longer wait
 * still fades in, and opening the page from elsewhere assembles it as before.
 * See docs/design/system/surfaces.md §1.1.
 */
interface Frame { shown: boolean }
interface Arrival { replacing: boolean; at: number }

const FrameContext = createContext<Frame | null>(null);
const ArrivalContext = createContext<Arrival | null>(null);

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
  // Held transitions start nothing when released, so a focus ring or a highlight taken over from the
  // previous conversation stays put instead of fading back in.
  const [settling, setSettling] = useState(arrival.replacing);
  useEffect(() => { if (frame) frame.shown = true; }, [frame]);
  useEffect(() => {
    if (!settling) return;
    const timer = window.setTimeout(() => setSettling(false), Math.max(0, WAIT_GRACE_MS - (performance.now() - arrival.at)));
    return () => window.clearTimeout(timer);
  }, [settling, arrival]);
  return (
    <ArrivalContext.Provider value={arrival}>
      <div className={cn('contents', settling && '**:transition-none!')}>{children}</div>
    </ArrivalContext.Provider>
  );
}

const switching = (arrival: Arrival | null) => Boolean(arrival?.replacing && performance.now() - arrival.at < WAIT_GRACE_MS);

/**
 * Whether [ready] first held while this conversation was replacing another one: what it describes
 * then takes the place of what was there and plays no entrance. Decided once, so a class it gates is
 * never added later (which would start the animation then); outside a session frame it is false.
 */
export function useSwitchedIn(ready = true): boolean {
  const arrival = useContext(ArrivalContext);
  const decided = useRef<boolean | undefined>(undefined);
  if (ready && decided.current === undefined) decided.current = switching(arrival);
  return decided.current ?? false;
}
