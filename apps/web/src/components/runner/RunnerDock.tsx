import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RunnerGame } from './RunnerGame';
import { closeRunner, useRunnerOpen } from './store';

/** Space from the composer card to the run, and from the run to the pane's edge. */
const GAP_LEFT = 24;
const GAP_RIGHT = 16;
/** Narrower than this, an obstacle is on the horse before it can be seen: the run closes instead. */
const MIN_WIDTH = 240;
const MAX_WIDTH = 520;
const HEIGHT = 150;

interface Place { left: number; bottom: number; width: number }

/**
 * Where the run fits: right of the composer card, ground level with the card's bottom, up to the
 * pane's right edge. A panel beside the conversation (the side discussion) ends the room where it
 * starts; the session's aside only does when its content reaches down to where the run would be.
 */
function measure(pane: Element, self: Element): Place | 'no-room' | undefined {
  const card = pane.querySelector('[data-composer-card]');
  if (!card) return undefined;
  const paneBox = pane.getBoundingClientRect(), cardBox = card.getBoundingClientRect();
  // A pane not on screen (a tab kept behind another) neither has room nor lacks it.
  if (!paneBox.width || !cardBox.width) return undefined;
  const top = cardBox.bottom - HEIGHT;
  if (top < paneBox.top) return 'no-room';
  let right = paneBox.right;
  for (const child of pane.children) {
    if (child === self || child.contains(card)) continue;
    const box = child.getBoundingClientRect();
    if (!box.width || box.left < cardBox.right) continue;
    const reachesDown = child.tagName === 'ASIDE'
      ? [...child.children].some((item) => item.getBoundingClientRect().bottom > top - 8)
      : true;
    if (reachesDown) right = Math.min(right, box.left);
  }
  const width = Math.min(MAX_WIDTH, right - cardBox.right - GAP_LEFT - GAP_RIGHT);
  if (width < MIN_WIDTH) return 'no-room';
  return { left: cardBox.right - paneBox.left + GAP_LEFT, bottom: paneBox.bottom - cardBox.bottom, width };
}

/**
 * Whether the page on screen has a place for the run: the new conversation page always does, under
 * the page; a session only when there is room beside its composer. The palette offers it only then.
 */
export function runnerFits(): boolean {
  if (document.querySelector('[data-runner-bottom]')) return true;
  return [...document.querySelectorAll('[data-runner-dock]')].some((self) => {
    const place = self.parentElement && measure(self.parentElement, self);
    return Boolean(place && place !== 'no-room');
  });
}

/**
 * 黑马跑酷 in the empty space to the right of the composer. The conversation and the composer keep
 * their place; when that space gets too narrow (a panel opens, the window shrinks, a phone) the run
 * closes. In a session it stops while the agent waits for an answer and puts up a finish post when
 * the agent's turn ends; it never shows unless asked for. Mounted as a positioned pane's child.
 */
export function RunnerDock({ working = false, needsYou = false }: { working?: boolean; needsYou?: boolean }) {
  const open = useRunnerOpen();
  const selfRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Place>();
  const [finished, setFinished] = useState(0);
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working) setFinished((count) => count + 1);
    wasWorking.current = working;
  }, [working]);

  useLayoutEffect(() => {
    const self = selfRef.current, pane = self?.parentElement;
    if (!open || !self || !pane) { setPlace(undefined); return; }
    const update = () => {
      const next = measure(pane, self);
      if (next === 'no-room') { closeRunner(); return; }
      setPlace((current) => current && next && current.left === next.left && current.bottom === next.bottom && current.width === next.width ? current : next);
    };
    update();
    // The pane's size, the card's height, scrolling (the new conversation page scrolls its composer)
    // and what the aside lists all move the room.
    const resize = new ResizeObserver(update);
    resize.observe(pane);
    const card = pane.querySelector('[data-composer-card]');
    if (card) resize.observe(card);
    const watched = new Set<Element>();
    const watchAside = () => {
      for (const child of pane.querySelectorAll(':scope > aside > *')) if (!watched.has(child)) { watched.add(child); resize.observe(child); }
    };
    watchAside();
    const children = new MutationObserver(() => { watchAside(); update(); });
    children.observe(pane, { childList: true });
    for (const aside of pane.querySelectorAll(':scope > aside')) children.observe(aside, { childList: true });
    pane.addEventListener('scroll', update, { capture: true, passive: true });
    return () => { resize.disconnect(); children.disconnect(); pane.removeEventListener('scroll', update, { capture: true }); };
  }, [open]);

  return (
    <div ref={selfRef} data-runner-dock className={place ? 'absolute' : 'hidden'} style={place ? { left: place.left, bottom: place.bottom, width: place.width } : undefined}>
      {open && place && <RunnerGame height={HEIGHT} hold={needsYou} finished={finished} onClose={closeRunner} />}
    </div>
  );
}
