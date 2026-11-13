import { geometryAnimating, installLayoutShiftMonitor } from '@/lib/layout-shift-monitor';
import { animationsOf } from '@/lib/motion';

/*
 * Watches the transcript every frame while a recording plays and reports what moved for no reason a
 * reader would accept. The rows are read from the DOM (`data-row-key` for rows, `data-item-key` for
 * the items inside a process block), positioned by layout rather than by paint, so an entrance's
 * slide does not count as movement. The browser's own layout-shift entries add the shifts no
 * animation carried (`installLayoutShiftMonitor`).
 */

/** Frames that carry transcript content; anything else (status, runs, metrics…) should not move rows. */
const CONTENT_FRAMES = new Set(['hello', 'snapshot', 'rows', 'reset']);
/** How many animation frames a frame's effect may take to reach the DOM: the sync engine publishes on a timer. */
const SETTLE_SAMPLES = 4;
const MOVE_PX = 1;
const BOTTOM_PX = 2;

export type IncidentKind =
  /** Rows moved while only non-content frames had arrived: chrome appearing or going away. */
  | 'state-shift'
  /** Following the end, rows moved down: something below them shrank or went away. */
  | 'drop'
  /** The view stopped being at the end without any reader input. */
  | 'left-bottom'
  /** The same key got a new element in the same kind of container: React remounted it. */
  | 'remount'
  /** A key moved between a standalone row and an item inside a process block (a remount too). */
  | 'move'
  /** A key's entrance animation played again on a later element. */
  | 'replay'
  /** A row the reader could see left the DOM. */
  | 'vanish'
  /** A key that had vanished came back. */
  | 'return'
  /** The browser reported a layout shift while no animation or transition of a layout property ran. */
  | 'unanimated-shift';

export interface Incident {
  kind: IncidentKind;
  /** Milliseconds since the replay started. */
  at: number;
  /** Index of the last frame handed to the transcript, and the frame types since the last quiet sample. */
  frame: number;
  frames: string[];
  key?: string;
  /** Largest vertical move in CSS pixels (positive is down), and how many rows moved. */
  dy?: number;
  rows?: number;
  /** For `unanimated-shift`: the shift's score and the nodes that moved. */
  value?: number;
  nodes?: string[];
}

export interface ReplayReport {
  frames: number;
  samples: number;
  durationMs: number;
  counts: Partial<Record<IncidentKind, number>>;
  incidents: Incident[];
  /** The sync engine closed the stream at this frame (it saw a gap or a reset it redials over); the rest did not play. */
  closedAt?: number;
}

interface Seen { element: Element; container: 'row' | 'item'; top: number; visible: boolean }

/** The element's top in the scroller's content, from layout (offsetTop) so transforms and animations do not count. */
function layoutTop(element: HTMLElement, scroller: HTMLElement): number {
  let top = 0;
  let node: HTMLElement | null = element;
  while (node && node !== scroller) {
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return top;
}

export function watchTranscript(scroller: HTMLElement) {
  const started = performance.now();
  const incidents: Incident[] = [];
  let samples = 0;
  let lastFrame = -1;
  let pending: { type: string; samples: number }[] = [];
  let previous = new Map<string, Seen>();
  let wasAtBottom: boolean | undefined;
  const everSeen = new Set<string>();
  const vanished = new Set<string>();
  const animated = new Set<string>();
  let raf = 0;

  const report = (incident: Omit<Incident, 'at' | 'frame' | 'frames'>) => {
    incidents.push({ ...incident, at: Math.round(performance.now() - started), frame: lastFrame, frames: pending.map((entry) => entry.type) });
  };
  const stopShifts = installLayoutShiftMonitor({
    log: false,
    onShift(record) {
      // The observer is buffered, so it also hands over the page's load: not part of the replay.
      if (record.unanimated && record.at >= Math.floor(started)) report({ kind: 'unanimated-shift', value: Number(record.value.toFixed(4)), nodes: record.sources.map((source) => `${source.node} ${source.previous.y}→${source.current.y}`) });
    },
  });

  const sample = () => {
    raf = requestAnimationFrame(sample);
    samples += 1;
    const viewTop = scroller.scrollTop;
    const viewBottom = viewTop + scroller.clientHeight;
    const current = new Map<string, Seen>();
    for (const element of scroller.querySelectorAll<HTMLElement>('[data-row-key],[data-item-key]')) {
      const container = element.dataset.itemKey !== undefined ? 'item' : 'row';
      const key = element.dataset.itemKey ?? element.dataset.rowKey!;
      if (current.has(key) && container === 'row') continue;
      const top = layoutTop(element, scroller);
      const visible = element.offsetHeight > 0 && top + element.offsetHeight > viewTop && top < viewBottom;
      current.set(key, { element, container, top: top - viewTop, visible });
    }

    let moved = 0;
    let largest = 0;
    let down = 0;
    for (const [key, now] of current) {
      const before = previous.get(key);
      if (!before) {
        if (vanished.delete(key)) report({ kind: 'return', key });
        if (now.visible && everSeen.has(key) && !animated.has(key) && animationsOf(now.element, { all: true }).some((animation) => (animation as CSSAnimation).animationName === 'enter')) {
          animated.add(key);
          report({ kind: 'replay', key });
        }
        everSeen.add(key);
        continue;
      }
      if (before.element !== now.element) {
        if (before.visible || now.visible) report({ kind: before.container === now.container ? 'remount' : 'move', key });
        if (now.visible && animationsOf(now.element, { all: true }).some((animation) => (animation as CSSAnimation).animationName === 'enter')) report({ kind: 'replay', key });
        continue;
      }
      if (!before.visible && !now.visible) continue;
      const dy = now.top - before.top;
      if (Math.abs(dy) > MOVE_PX) {
        moved += 1;
        if (Math.abs(dy) > Math.abs(largest)) largest = dy;
        if (dy > MOVE_PX) down = Math.max(down, dy);
      }
    }
    for (const [key, before] of previous) {
      if (!current.has(key) && before.visible) { vanished.add(key); report({ kind: 'vanish', key }); }
    }

    const atBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= BOTTOM_PX;
    if (moved) {
      const contentArrived = pending.some((entry) => CONTENT_FRAMES.has(entry.type));
      if (pending.length && !contentArrived) report({ kind: 'state-shift', dy: Math.round(largest), rows: moved });
      // An animated fold at the end moves the rows down a little every frame; that is the transition, not a drop.
      else if (wasAtBottom && atBottom && down && !geometryAnimating(performance.now() - 50)) report({ kind: 'drop', dy: Math.round(down), rows: moved });
    }
    if (wasAtBottom && !atBottom) report({ kind: 'left-bottom', dy: Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) });
    wasAtBottom = atBottom;
    previous = current;
    // A frame stays attributed for a few samples, since its effect may land a frame or two after it.
    pending = moved ? [] : pending.map((entry) => ({ ...entry, samples: entry.samples + 1 })).filter((entry) => entry.samples < SETTLE_SAMPLES);
  };
  raf = requestAnimationFrame(sample);

  return {
    frame(index: number, type: string) {
      lastFrame = index;
      if (type !== 'ping') pending.push({ type, samples: 0 });
    },
    stop(frames: number): ReplayReport {
      cancelAnimationFrame(raf);
      stopShifts();
      const counts: ReplayReport['counts'] = {};
      for (const incident of incidents) counts[incident.kind] = (counts[incident.kind] ?? 0) + 1;
      return { frames, samples, durationMs: Math.round(performance.now() - started), counts, incidents };
    },
  };
}
