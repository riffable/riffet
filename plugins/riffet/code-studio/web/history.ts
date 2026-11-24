import { useCallback, useRef, useState } from 'react';

/** A place in a file, as the reader was at it. */
export interface Spot { path: string; line: number; column?: number }

/** Places kept each way. */
const KEPT = 50;
/** A move within this many lines of the last place in the same file replaces it rather than adding one. */
const NEAR_LINES = 10;

const near = (a: Spot | undefined, b: Spot) => a !== undefined && a.path === b.path && Math.abs(a.line - b.line) <= NEAR_LINES;

/**
 * Back and forward through the places the reader went, as the IDE's ⌘[ and ⌘] do: each jump (a
 * declaration, a search result, a tab, a tree click) records where the reader was. Small moves in one
 * file do not pile up.
 */
export function useNavHistory() {
  const back = useRef<Spot[]>([]);
  const forward = useRef<Spot[]>([]);
  const [, setVersion] = useState(0);
  const changed = () => setVersion((value) => value + 1);

  /** Leaving `from` for somewhere else: it becomes the place Back returns to. */
  const leave = useCallback((from: Spot | undefined) => {
    if (!from) return;
    if (!near(back.current.at(-1), from)) back.current.push(from); else back.current[back.current.length - 1] = from;
    if (back.current.length > KEPT) back.current.shift();
    forward.current = [];
    changed();
  }, []);

  /** Where Back goes from `here`, recording `here` for Forward; `undefined` with nowhere to go. */
  const goBack = useCallback((here: Spot | undefined): Spot | undefined => {
    let to = back.current.pop();
    // The top place is often where the reader still is.
    while (to && here && near(to, here) && back.current.length) to = back.current.pop();
    if (!to || (here && near(to, here))) { if (to) back.current.push(to); return undefined; }
    if (here) forward.current.push(here);
    changed();
    return to;
  }, []);

  const goForward = useCallback((here: Spot | undefined): Spot | undefined => {
    const to = forward.current.pop();
    if (!to) return undefined;
    if (here) back.current.push(here);
    changed();
    return to;
  }, []);

  /** Starts over, for another project. */
  const clear = useCallback(() => { back.current = []; forward.current = []; changed(); }, []);

  return { leave, goBack, goForward, clear, canBack: back.current.length > 0, canForward: forward.current.length > 0 };
}
