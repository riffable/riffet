import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Tip, useMessages } from '@riffet/plugin-web';
import { cn } from './cn';
import { formatClock, formatCount, formatMs } from './format';
import { IconMaximize, IconMinus, IconPlus } from './icons';
import { catalogs, type TraceMessages } from './messages';
import type { Folded, Item, Turn } from './model';
import { CATEGORY_COLOR, resolveColors } from './palette';

/*
 * The whole lane as a timeline on a canvas: a ruler, the turns, the model requests, the messages, and the tool
 * calls packed into rows where they overlap, with an overview strip of the whole lane under them. Time between
 * turns is cut to a short gap, so a conversation that sat idle for a day still shows its work.
 *
 * Wheel zooms about the pointer, a horizontal wheel or Shift pans, dragging the strip moves the window,
 * dragging the tracks selects a time range, double-click zooms to a mark (or back out). A range has a grip on
 * each edge to move that edge and a bar on the ruler to slide it whole; the grips take arrow keys too. Hovering a mark lights
 * its row in the list and the reverse. Marks take their kind's hue (palette.ts); the turns are bands of gray.
 */

const GUTTER = 64;
const HEIGHT_KEY = 'riffet.trace.timeline.v1';
const MIN_HEIGHT = 140;
const MAX_HEIGHT = 440;
const DEFAULT_HEIGHT = 200;
const MIN_SPAN = 0.0004;
const INTRO_MS = 700;
/** The narrowest range a grip can leave, in pixels. */
const MIN_RANGE_PX = 6;
/** Width of a grip's hit area (`w-4`), centred on its edge. */
const GRIP = 16;

interface Segment { start: number; end: number; u0: number; u1: number }
/** A point on the axis that is not a span: where the prompt changed. */
interface Mark { type: 'mark'; id: string; start: number; end: number }
interface Hit { x: number; w: number; y: number; h: number; id: string; item: Item | Turn | Mark }
interface View { v0: number; v1: number }

/** Layout of the tracks for a canvas `height` pixels tall. */
function tracksOf(height: number) {
  const ruler = { y: 0, h: 20 };
  const turn = { y: 26, h: 18 };
  const model = { y: 50, h: 14 };
  const text = { y: 70, h: 10 };
  const mini = { y: height - 16, h: 12 };
  const toolsTop = 88;
  // Tool rows grow with the height: a taller timeline separates overlapping calls instead of thickening one row.
  const gap = 3;
  const space = Math.max(0, mini.y - 10 - toolsTop);
  const rowH = Math.max(6, Math.min(12, Math.floor(space / 4) - gap));
  const rows = Math.max(2, Math.floor(space / (rowH + gap)));
  return { ruler, turn, model, text, mini, tools: { y: toolsTop, rowH, gap, rows } };
}

/** Time onto `u` in [0, 1] over the merged turn intervals; each gap between them takes a small fixed share. */
function axisOf(turns: readonly Turn[]) {
  const spans = turns.filter((turn) => turn.start > 0).map((turn) => [turn.start, Math.max(turn.end, turn.start + 1)] as [number, number]).sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1] + 1000) last[1] = Math.max(last[1], span[1]); else merged.push([...span]);
  }
  const gaps = Math.max(0, merged.length - 1);
  const gapU = gaps ? Math.min(0.01, 0.2 / gaps) : 0;
  const usable = 1 - gapU * gaps;
  const total = merged.reduce((sum, [a, b]) => sum + (b - a), 0) || 1;
  const segments: Segment[] = [];
  let u = 0;
  for (const [start, end] of merged) {
    const w = ((end - start) / total) * usable;
    segments.push({ start, end, u0: u, u1: u + w });
    u += w + gapU;
  }
  const toU = (t: number): number => {
    for (const segment of segments) {
      if (t < segment.start) return segment.u0;
      if (t <= segment.end) return segment.u0 + ((t - segment.start) / (segment.end - segment.start || 1)) * (segment.u1 - segment.u0);
    }
    return segments.at(-1)?.u1 ?? 0;
  };
  const toT = (value: number): number => {
    for (const segment of segments) {
      if (value < segment.u0) return segment.start;
      if (value <= segment.u1) return segment.start + ((value - segment.u0) / (segment.u1 - segment.u0 || 1)) * (segment.end - segment.start);
    }
    return segments.at(-1)?.end ?? 0;
  };
  return { segments, toU, toT };
}

/** Tick steps, in ms, the ruler picks from: the first that leaves room for a label. */
const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 108e5, 216e5, 432e5, 864e5];

function tickLabel(t: number, step: number): string {
  const clock = formatClock(t);
  return step >= 6e4 ? clock.slice(0, 5) : step >= 1e3 ? clock.slice(0, 8) : clock.slice(3);
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

function readHeight(): number {
  const stored = Number(window.localStorage.getItem(HEIGHT_KEY));
  return Number.isFinite(stored) && stored >= MIN_HEIGHT && stored <= MAX_HEIGHT ? stored : DEFAULT_HEIGHT;
}

export function Timeline({ folded, resetKey, selectedId, hoverId, range, marks, onRange, onSelect, onHover }: {
  folded: Folded;
  /** A new value (another lane) fits the whole lane again. */
  resetKey: string;
  selectedId: string | undefined;
  hoverId: string | undefined;
  range: readonly [number, number] | undefined;
  /** Points to flag on the ruler (prompt changes), selected by their id. */
  marks?: ReadonlyArray<{ id: string; at: number }>;
  onRange(range: readonly [number, number] | undefined): void;
  onSelect(id: string): void;
  onHover(id: string | undefined): void;
}) {
  const m = useMessages(catalogs);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(readHeight);
  const [tip, setTip] = useState<{ x: number; y: number; hit: Hit } | undefined>();
  const [zoomed, setZoomed] = useState(false);

  const view = useRef<View>({ v0: 0, v1: 1 });
  const target = useRef<View>({ v0: 0, v1: 1 });
  const frame = useRef(0);
  const intro = useRef<{ start: number } | undefined>(undefined);
  const pointer = useRef<number | undefined>(undefined);
  const brush = useRef<[number, number] | undefined>(undefined);
  /** The range while a grip or the bar is dragged, in time; committed on release so the list filters once. */
  const draft = useRef<readonly [number, number] | undefined>(undefined);
  const gripStart = useRef<HTMLDivElement>(null);
  const gripEnd = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const hits = useRef<Hit[]>([]);
  const colors = useRef<Record<string, string> | undefined>(undefined);

  useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(0, Math.round(entry!.contentRect.width) - GUTTER)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const axis = useMemo(() => axisOf(folded.turns), [folded.turns]);
  const layout = tracksOf(height);

  // Tool calls packed greedily into rows by start; past the last row they share it.
  const packed = useMemo(() => {
    const ends: number[] = [];
    const placed: Array<{ item: Item; row: number }> = [];
    const tools = folded.turns.flatMap((turn) => turn.children.filter((child) => child.type === 'span' && child.category === 'tool'));
    tools.sort((a, b) => a.start - b.start);
    for (const item of tools) {
      let row = ends.findIndex((end) => end <= item.start);
      if (row < 0) row = ends.length;
      ends[row] = Math.max(ends[row] ?? 0, item.end);
      placed.push({ item, row });
    }
    return placed;
  }, [folded.turns]);

  const props = useRef({ folded, selectedId, hoverId, range, marks, axis, packed, layout, width, height });
  props.current = { folded, selectedId, hoverId, range, marks, axis, packed, layout, width, height };

  const draw = useCallback(() => {
    const element = canvas.current;
    const { folded, selectedId, hoverId, range, marks, axis, packed, layout, width, height } = props.current;
    if (!element || width <= 0) return;
    const ratio = window.devicePixelRatio || 1;
    if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
    }
    const context = element.getContext('2d');
    if (!context) return;
    colors.current ??= resolveColors({
      ...CATEGORY_COLOR, fg2: 'var(--fg-2)', fg3: 'var(--fg-3)', fg4: 'var(--fg-4)', line: 'var(--line)', lineStrong: 'var(--line-strong)',
      accent: 'var(--accent)', rangeFill: 'color-mix(in oklab, var(--accent) 9%, transparent)', danger: 'var(--danger)', bg: 'var(--bg)', band: 'color-mix(in oklab, var(--fg) 4%, transparent)', bandAlt: 'color-mix(in oklab, var(--fg) 2%, transparent)',
      turn: 'color-mix(in oklab, var(--fg-3) 30%, transparent)', mini: 'color-mix(in oklab, var(--fg) 6%, transparent)',
    });
    const c = colors.current;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const { v0, v1 } = view.current;
    const span = v1 - v0;
    const x = (t: number) => ((axis.toU(t) - v0) / span) * width;
    const visible = (a: number, b: number) => b >= -2 && a <= width + 2;
    const next: Hit[] = [];
    const tracksBottom = layout.mini.y - 6;

    // Intro: the marks are uncovered left to right once, decelerating.
    let reveal = width;
    if (intro.current) {
      const p = Math.min(1, (performance.now() - intro.current.start) / INTRO_MS);
      reveal = width * (1 - (1 - p) ** 3);
      if (p >= 1) intro.current = undefined;
    }

    const rect = (x0: number, y: number, w: number, h: number, color: string, alpha = 1, radius = 0) => {
      context.globalAlpha = alpha;
      context.fillStyle = color;
      const width = Math.max(1, w);
      if (radius > 0 && width > radius * 2) { context.beginPath(); context.roundRect(x0, y, width, h, radius); context.fill(); } else context.fillRect(x0, y, width, h);
      context.globalAlpha = 1;
    };

    // Turn columns: alternating faint bands down the tracks, so where one turn ends reads at any zoom.
    folded.turns.forEach((turn, index) => {
      const a = x(turn.start), b = x(turn.end);
      if (!visible(a, b)) return;
      rect(a, layout.turn.y - 2, b - a, tracksBottom - layout.turn.y + 2, index % 2 ? c.bandAlt! : c.band!);
    });

    // Ruler: ticks inside each visible stretch of time, with the cut between stretches as a dashed stroke.
    context.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.textBaseline = 'middle';
    for (const segment of axis.segments) {
      const a = ((segment.u0 - v0) / span) * width, b = ((segment.u1 - v0) / span) * width;
      if (!visible(a, b)) continue;
      const pxPerMs = (b - a) / Math.max(1, segment.end - segment.start);
      const step = STEPS.find((candidate) => candidate * pxPerMs >= 92) ?? STEPS.at(-1)!;
      for (let t = Math.ceil(segment.start / step) * step; t <= segment.end; t += step) {
        const tx = a + (t - segment.start) * pxPerMs;
        if (tx < 0 || tx > width) continue;
        rect(tx, 15, 1, 5, c.lineStrong!);
        if (tx + 60 < width && tx - a > 4) { context.fillStyle = c.fg4!; context.fillText(tickLabel(t, step), tx + 3, 9); }
      }
    }
    // Each cut between stretches of time: a dashed stroke in the middle of its gap.
    context.strokeStyle = c.lineStrong!;
    context.setLineDash([2, 3]);
    for (let index = 1; index < axis.segments.length; index += 1) {
      const gx = (((axis.segments[index - 1]!.u1 + axis.segments[index]!.u0) / 2 - v0) / span) * width;
      if (gx < 0 || gx > width) continue;
      context.beginPath(); context.moveTo(Math.round(gx) + 0.5, 4); context.lineTo(Math.round(gx) + 0.5, tracksBottom); context.stroke();
    }
    context.setLineDash([]);
    rect(0, 20, width, 1, c.line!);

    context.save();
    context.beginPath(); context.rect(0, 21, reveal, height); context.clip();

    for (const turn of folded.turns) {
      const a = x(turn.start), b = x(turn.end);
      if (!visible(a, b)) continue;
      const failed = Boolean(turn.error || turn.status === 'failed');
      rect(a, layout.turn.y, b - a, layout.turn.h, c.turn!, 1, 3);
      // A failed turn keeps the neutral block and is underlined in danger: the red marks it without outweighing the data.
      if (failed) rect(a, layout.turn.y + layout.turn.h - 3, b - a, 3, c.danger!, 0.9, 1.5);
      if (b - a > 26) {
        context.fillStyle = c.fg2!;
        context.fillText(`${turn.index}`, Math.max(a, 0) + 5, layout.turn.y + layout.turn.h / 2 + 0.5);
      }
      next.push({ x: a, w: Math.max(3, b - a), y: layout.turn.y, h: layout.turn.h, id: turn.id, item: turn });
      for (const child of turn.children) {
        const ca = x(child.start), cb = x(child.end);
        if (!visible(ca, cb)) continue;
        if (child.type === 'step') {
          rect(ca, layout.model.y, cb - ca, layout.model.h, c.model!, 0.9, 2);
          next.push({ x: ca, w: Math.max(3, cb - ca), y: layout.model.y, h: layout.model.h, id: child.id, item: child });
        } else if (child.category === 'message' || child.category === 'thinking') {
          rect(ca - 1, layout.text.y, 2, layout.text.h, child.category === 'message' ? c.message! : c.thinking!, 0.95);
          next.push({ x: ca - 2, w: 4, y: layout.text.y, h: layout.text.h, id: child.id, item: child });
        }
      }
    }
    const rows = layout.tools.rows;
    for (const { item, row } of packed) {
      const a = x(item.start), b = x(item.end);
      if (!visible(a, b)) continue;
      const y = layout.tools.y + Math.min(row, rows - 1) * (layout.tools.rowH + layout.tools.gap);
      rect(a, y, b - a, layout.tools.rowH, item.error ? c.danger! : c.tool!, item.error ? 0.9 : 0.85, 2);
      next.push({ x: a, w: Math.max(2, b - a), y, h: layout.tools.rowH, id: item.id, item });
    }
    context.restore();

    // Prompt changes: a diamond under the ruler and a dashed hairline down the tracks.
    for (const mark of marks ?? []) {
      const mx = x(mark.at);
      if (!visible(mx, mx) || mx > reveal) continue;
      context.globalAlpha = 0.5;
      context.strokeStyle = c.accent!;
      context.setLineDash([2, 3]);
      context.beginPath(); context.moveTo(Math.round(mx) + 0.5, 24); context.lineTo(Math.round(mx) + 0.5, tracksBottom); context.stroke();
      context.setLineDash([]);
      context.globalAlpha = 1;
      context.fillStyle = c.accent!;
      context.beginPath(); context.moveTo(mx, 16); context.lineTo(mx + 4, 20); context.lineTo(mx, 24); context.lineTo(mx - 4, 20); context.closePath(); context.fill();
      next.push({ x: mx - 5, w: 10, y: 14, h: 12, id: mark.id, item: { type: 'mark', id: mark.id, start: mark.at, end: mark.at } });
    }

    // Hovered and selected marks: an outline, and a hairline down the tracks at the selection.
    const outline = (id: string | undefined, color: string, line: boolean) => {
      const hit = id ? next.find((candidate) => candidate.id === id) : undefined;
      if (!hit) return;
      context.strokeStyle = color;
      context.lineWidth = 1.5;
      context.strokeRect(hit.x - 1.5, hit.y - 1.5, hit.w + 3, hit.h + 3);
      context.lineWidth = 1;
      if (line) { context.globalAlpha = 0.5; rect(hit.x, 21, 1, tracksBottom - 21, color); context.globalAlpha = 1; }
    };
    if (hoverId !== selectedId) outline(hoverId, c.fg2!, false);
    outline(selectedId, c.accent!, true);

    // The chosen range, or the one being drawn or dragged: tinted inside, the rest veiled, the edges in accent.
    const chosen = draft.current ?? range;
    const brushed = brush.current ?? (chosen ? [x(chosen[0]), x(chosen[1])] as [number, number] : undefined);
    if (brushed) {
      const [a, b] = brushed[0] <= brushed[1] ? brushed : [brushed[1], brushed[0]];
      context.globalAlpha = 0.66;
      context.fillStyle = c.bg!;
      context.fillRect(0, 21, Math.max(0, a), tracksBottom - 21);
      context.fillRect(b, 21, Math.max(0, width - b), tracksBottom - 21);
      context.globalAlpha = 1;
      rect(a, 21, b - a, tracksBottom - 21, c.rangeFill!);
      rect(a - 0.75, 21, 1.5, tracksBottom - 21, c.accent!);
      rect(b - 0.75, 21, 1.5, tracksBottom - 21, c.accent!);
    }
    // The grips and the bar are elements, for the pointer and the keyboard; they follow the view from here.
    const place = (element: HTMLDivElement | null, left: number, w?: number) => {
      if (!element) return;
      element.style.display = brushed ? '' : 'none';
      element.style.transform = `translateX(${left}px)`;
      if (w !== undefined) element.style.width = `${Math.max(0, w)}px`;
    };
    if (brushed) {
      const [a, b] = brushed[0] <= brushed[1] ? brushed : [brushed[1], brushed[0]];
      place(gripStart.current, a - GRIP / 2); place(gripEnd.current, b - GRIP / 2); place(bar.current, a, b - a);
      const label = bar.current?.firstElementChild;
      if (label) label.textContent = b - a > 56 && chosen && !brush.current ? formatMs(chosen[1] - chosen[0]) : '';
    } else { place(gripStart.current, 0); place(gripEnd.current, 0); place(bar.current, 0, 0); }

    // The pointer's time, on the ruler.
    if (pointer.current !== undefined && !brush.current) {
      const px = pointer.current;
      rect(px, 21, 1, tracksBottom - 21, c.lineStrong!);
      const label = formatClock(axis.toT(v0 + (px / width) * span));
      const w = context.measureText(label).width + 8;
      const lx = Math.min(Math.max(px - w / 2, 0), width - w);
      rect(lx, 2, w, 15, c.fg2!, 1, 3);
      context.fillStyle = c.bg!;
      context.fillText(label, lx + 4, 9.5);
    }

    // Overview strip: the whole lane, and the window when zoomed in.
    const mini = layout.mini;
    rect(0, mini.y, width, mini.h, c.mini!, 1, 3);
    for (const turn of folded.turns) {
      const a = axis.toU(turn.start) * width, b = axis.toU(turn.end) * width;
      rect(a, mini.y + 3, b - a, mini.h - 6, turn.error || turn.status === 'failed' ? c.danger! : c.fg4!, 0.7, 1);
    }
    if (span < 0.999) {
      context.strokeStyle = c.accent!;
      context.lineWidth = 1.5;
      context.strokeRect(v0 * width, mini.y - 1, Math.max(4, span * width), mini.h + 2);
      context.lineWidth = 1;
    }
    hits.current = next;
  }, []);

  // One loop for the zoom easing and the intro; idle otherwise.
  const schedule = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(function step() {
      frame.current = 0;
      const current = view.current, goal = target.current;
      const settle = reducedMotion();
      const k = settle ? 1 : 0.28;
      current.v0 += (goal.v0 - current.v0) * k;
      current.v1 += (goal.v1 - current.v1) * k;
      const done = Math.abs(goal.v0 - current.v0) < 1e-6 && Math.abs(goal.v1 - current.v1) < 1e-6;
      if (done) { current.v0 = goal.v0; current.v1 = goal.v1; }
      draw();
      // The intro needs a width to play into; without one the loop rests until a resize schedules it again.
      if (!done || (intro.current && props.current.width > 0)) frame.current = requestAnimationFrame(step);
    });
  }, [draw]);
  useEffect(() => () => { cancelAnimationFrame(frame.current); frame.current = 0; }, []);

  const setView = useCallback((v0: number, v1: number) => {
    let span = Math.min(1, Math.max(MIN_SPAN, v1 - v0));
    let start = Math.min(Math.max(0, v0), 1 - span);
    if (span >= 1) { span = 1; start = 0; }
    target.current = { v0: start, v1: start + span };
    setZoomed(span < 0.999);
    schedule();
  }, [schedule]);

  // Fit and play the intro once per lane.
  useEffect(() => {
    view.current = { v0: 0, v1: 1 };
    target.current = { v0: 0, v1: 1 };
    setZoomed(false);
    intro.current = reducedMotion() ? undefined : { start: performance.now() };
  }, [resetKey]);

  // Theme changes resolve the colours again.
  useEffect(() => {
    const observer = new MutationObserver(() => { colors.current = undefined; schedule(); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    return () => observer.disconnect();
  }, [schedule]);

  useLayoutEffect(() => { schedule(); }, [schedule, folded, selectedId, hoverId, range, marks, width, height, packed]);

  // A selection made in the list is brought into the window when it lies outside it.
  useEffect(() => {
    if (!selectedId) return;
    const node = folded.byId.get(selectedId);
    if (!node) return;
    const a = axis.toU(node.start), b = axis.toU(node.end);
    const { v0, v1 } = target.current;
    if (a >= v0 && b <= v1) return;
    const span = Math.max(v1 - v0, b - a);
    setView((a + b) / 2 - span / 2, (a + b) / 2 + span / 2);
  }, [selectedId, folded.byId, axis, setView]);

  // Wheel: zoom about the pointer; horizontal or Shift pans. Not passive, so the page does not scroll with it.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { v0, v1 } = target.current;
      const span = v1 - v0;
      const rect = element.getBoundingClientRect();
      const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (horizontal && !event.ctrlKey) {
        const delta = (event.shiftKey ? event.deltaY : event.deltaX) / rect.width * span;
        setView(v0 + delta, v1 + delta);
        return;
      }
      const factor = Math.exp(event.deltaY * (event.ctrlKey ? 0.01 : 0.0022));
      const next = Math.min(1, Math.max(MIN_SPAN, span * factor));
      const anchor = v0 + fraction * span;
      setView(anchor - fraction * next, anchor - fraction * next + next);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [setView]);

  const local = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const hitAt = (px: number, py: number): Hit | undefined => {
    let best: Hit | undefined;
    for (const hit of hits.current) {
      if (py < hit.y - 2 || py > hit.y + hit.h + 2 || px < hit.x - 2 || px > hit.x + hit.w + 2) continue;
      if (!best || hit.w < best.w) best = hit;
    }
    return best;
  };
  const uAt = (px: number) => { const { v0, v1 } = view.current; return v0 + (px / Math.max(1, width)) * (v1 - v0); };

  const drag = useRef<{ kind: 'brush' | 'pan'; x: number; moved: boolean } | undefined>(undefined);
  const zoomBy = (factor: number) => {
    const { v0, v1 } = target.current;
    const mid = (v0 + v1) / 2, span = Math.min(1, Math.max(MIN_SPAN, (v1 - v0) * factor));
    setView(mid - span / 2, mid + span / 2);
  };
  const panTo = (px: number) => { const { v0, v1 } = target.current; const span = v1 - v0, center = px / Math.max(1, width); setView(center - span / 2, center + span / 2); };

  const xAt = (t: number) => { const { v0, v1 } = view.current; return ((axis.toU(t) - v0) / (v1 - v0)) * width; };
  const tAt = (px: number) => axis.toT(Math.min(1, Math.max(0, uAt(px))));

  /** Drags one edge of the range, or the whole of it, from a grip or the bar. */
  const dragRange = (edge: 'start' | 'end' | 'both') => (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !range) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const x0 = event.clientX;
    const [a0, b0] = [xAt(range[0]), xAt(range[1])];
    const lo = xAt(axis.toT(0)), hi = xAt(axis.toT(1));
    const move = (moveEvent: PointerEvent) => {
      let dx = moveEvent.clientX - x0;
      let a = a0, b = b0;
      if (edge === 'both') { dx = Math.min(Math.max(dx, lo - a0), hi - b0); a += dx; b += dx; }
      else if (edge === 'start') a = Math.min(Math.max(lo, a0 + dx), b0 - MIN_RANGE_PX);
      else b = Math.max(Math.min(hi, b0 + dx), a0 + MIN_RANGE_PX);
      draft.current = [tAt(a), tAt(b)];
      schedule();
    };
    const up = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      const next = draft.current;
      draft.current = undefined;
      if (next) onRange(next); else schedule();
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
  };

  /** Arrow keys move a grip a few pixels, Shift a screen's tenth; Escape clears the range. */
  const keyRange = (edge: 'start' | 'end' | 'both') => (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!range) return;
    if (event.key === 'Escape') { onRange(undefined); event.preventDefault(); return; }
    const sign = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (!sign) return;
    event.preventDefault();
    const dx = sign * (event.shiftKey ? Math.max(8, width / 10) : 4);
    const a = xAt(range[0]), b = xAt(range[1]);
    if (edge === 'start') onRange([tAt(Math.min(a + dx, b - MIN_RANGE_PX)), range[1]]);
    else if (edge === 'end') onRange([range[0], tAt(Math.max(b + dx, a + MIN_RANGE_PX))]);
    else onRange([tAt(a + dx), tAt(b + dx)]);
  };

  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY, startHeight = height;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    let last = startHeight;
    const move = (moveEvent: PointerEvent) => { last = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight + moveEvent.clientY - startY)); setHeight(last); };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      window.localStorage.setItem(HEIGHT_KEY, String(Math.round(last)));
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const labels: Array<[string, number, number]> = [
    [m.turns, layout.turn.y, layout.turn.h], [m.categories.model, layout.model.y, layout.model.h], [m.textTrack, layout.text.y, layout.text.h],
    [m.categories.tool, layout.tools.y, layout.tools.rowH],
  ];

  return (
    <div ref={wrap} className="group/timeline relative select-none" style={{ height }}>
      <div className="pointer-events-none absolute inset-y-0 left-0" style={{ width: GUTTER }} aria-hidden>
        {labels.map(([label, y, h]) => (
          <span key={label} className="absolute left-3 truncate text-2xs leading-none text-fg-4" style={{ top: y + h / 2 - 5, width: GUTTER - 16 }}>{label}</span>
        ))}
      </div>
      <canvas
        ref={canvas}
        className="absolute top-0 block cursor-crosshair touch-none"
        style={{ left: GUTTER, width, height }}
        aria-label={m.timeline}
        role="img"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const point = local(event);
          event.currentTarget.setPointerCapture(event.pointerId);
          const onStrip = point.y >= layout.mini.y - 4;
          drag.current = { kind: onStrip ? 'pan' : 'brush', x: point.x, moved: false };
          if (onStrip) panTo(point.x);
        }}
        onPointerMove={(event) => {
          const point = local(event);
          const active = drag.current;
          if (active) {
            if (Math.abs(point.x - active.x) > 3) active.moved = true;
            if (active.kind === 'pan') { panTo(point.x); return; }
            if (active.moved) { brush.current = [active.x, point.x]; pointer.current = undefined; setTip(undefined); schedule(); return; }
          }
          pointer.current = point.y < layout.mini.y - 4 ? point.x : undefined;
          const hit = hitAt(point.x, point.y);
          setTip(hit ? { x: point.x, y: point.y, hit } : undefined);
          onHover(hit?.id);
          schedule();
        }}
        onPointerLeave={() => { pointer.current = undefined; setTip(undefined); onHover(undefined); schedule(); }}
        onPointerCancel={() => { drag.current = undefined; brush.current = undefined; schedule(); }}
        onPointerUp={(event) => {
          const active = drag.current;
          drag.current = undefined;
          if (!active || active.kind === 'pan') return;
          const point = local(event);
          if (active.moved) {
            const [a, b] = active.x <= point.x ? [active.x, point.x] : [point.x, active.x];
            brush.current = undefined;
            onRange([axis.toT(uAt(a)), axis.toT(uAt(b))]);
            return;
          }
          const hit = hitAt(point.x, point.y);
          if (hit) onSelect(hit.id);
        }}
        onDoubleClick={(event) => {
          const point = local(event);
          const hit = hitAt(point.x, point.y);
          if (!hit) { setView(0, 1); return; }
          const a = axis.toU(hit.item.start), b = axis.toU(hit.item.end);
          const span = Math.max(MIN_SPAN * 4, (b - a) * 1.25);
          setView((a + b) / 2 - span / 2, (a + b) / 2 + span / 2);
        }}
      />
      <div className={cn('absolute right-2 top-6 z-10 flex items-center gap-0.5 rounded-lg bg-elevated/90 p-0.5 shadow-soft transition-opacity duration-[var(--duration-fast)] focus-within:opacity-100 group-hover/timeline:opacity-100', range ? 'opacity-100' : 'opacity-0')}>
        <Tip label={m.zoomOut}><Button size="icon-xs" variant="quiet" aria-label={m.zoomOut} onClick={() => zoomBy(1.6)}><IconMinus className="size-3.5" /></Button></Tip>
        <Tip label={m.zoomIn}><Button size="icon-xs" variant="quiet" aria-label={m.zoomIn} onClick={() => zoomBy(1 / 1.6)}><IconPlus className="size-3.5" /></Button></Tip>
        <Tip label={m.fit}><Button size="icon-xs" variant="quiet" aria-label={m.fit} disabled={!zoomed} onClick={() => setView(0, 1)}><IconMaximize className="size-3.5" /></Button></Tip>
        {range && <Button size="xs" variant="quiet" onClick={() => onRange(undefined)}>{m.clearRange}</Button>}
      </div>
      <div className="pointer-events-none absolute top-0 overflow-hidden" style={{ left: GUTTER, width, height: layout.mini.y - 6 }}>
        <div
          ref={bar}
          role="slider"
          tabIndex={range ? 0 : -1}
          aria-label={m.moveRange}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={range ? Math.round(axis.toU(range[0]) * 100) : 0}
          aria-valuetext={range ? `${formatClock(range[0])} – ${formatClock(range[1])}` : undefined}
          onPointerDown={dragRange('both')}
          onKeyDown={keyRange('both')}
          className="pointer-events-auto absolute left-0 top-1 flex h-4 cursor-grab items-center justify-center overflow-hidden rounded-sm text-2xs font-medium tabular-nums text-accent outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-focus"
          // Opaque, so the ticks under it do not run into its duration.
          style={{ display: 'none', background: 'color-mix(in oklab, var(--accent) 16%, var(--bg))' }}
        ><span /></div>
        {([['start', gripStart, m.rangeStart, 0], ['end', gripEnd, m.rangeEnd, 1]] as const).map(([edge, ref, label, index]) => (
          <div
            key={edge}
            ref={ref}
            role="slider"
            tabIndex={range ? 0 : -1}
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={range ? Math.round(axis.toU(range[index]) * 100) : 0}
            aria-valuetext={range ? formatClock(range[index]) : undefined}
            onPointerDown={dragRange(edge)}
            onKeyDown={keyRange(edge)}
            className="group/grip pointer-events-auto absolute left-0 flex w-4 cursor-ew-resize items-center justify-center outline-none"
            style={{ display: 'none', top: layout.turn.y, height: layout.mini.y - 12 - layout.turn.y }}
          >
            {/* A pill on the edge line with two ridges: the thing to take hold of. */}
            <span className="flex h-7 w-2.5 items-center justify-center gap-px rounded-full bg-elevated shadow-soft ring-1 ring-accent transition-transform duration-[var(--duration-fast)] group-hover/grip:scale-110 group-focus-visible/grip:ring-2 group-focus-visible/grip:ring-focus group-active/grip:scale-110">
              <span className="h-3 w-px rounded-full bg-accent" />
              <span className="h-3 w-px rounded-full bg-accent" />
            </span>
          </div>
        ))}
      </div>
      {tip && <Tooltip tip={tip} width={width} m={m} />}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={m.resizeTimeline}
        className="absolute inset-x-0 bottom-0 h-1.5 cursor-row-resize hover:bg-accent-soft"
        onPointerDown={resize}
        onDoubleClick={() => { setHeight(DEFAULT_HEIGHT); window.localStorage.removeItem(HEIGHT_KEY); }}
      />
    </div>
  );
}

function Tooltip({ tip, width, m }: { tip: { x: number; y: number; hit: Hit }; width: number; m: TraceMessages }) {
  const item = tip.hit.item;
  const [title, meta] = describe(item, m);
  const left = GUTTER + Math.min(Math.max(tip.x + 12, 0), Math.max(0, width - 300));
  return (
    <div className="pointer-events-none absolute z-10 w-72 rounded-lg bg-popover px-3 py-2 text-xs shadow-pop animate-in fade-in-0 duration-[var(--duration-fast)]" style={{ left, top: tip.y + 14 }}>
      <p className="truncate font-mono text-fg">{title}</p>
      <p className="mt-0.5 truncate text-fg-3">{meta}</p>
    </div>
  );
}

function describe(item: Item | Turn | Mark, m: TraceMessages): [string, string] {
  const when = formatClock(item.start);
  if (item.type === 'mark') return [m.promptChanged, when];
  if (item.type === 'turn') return [`${m.turn(item.index)}${item.prompt ? ` · ${item.prompt}` : ''}`, `${when} · ${formatMs(item.end - item.start)} · ${m.toolCallsCount(item.tools)}${item.tokens.measured ? ` · ${formatCount(item.tokens.output)} out` : ''}`];
  if (item.type === 'step') {
    const step = item.step;
    return [step.model ?? m.categories.model, `${when} · ${formatMs(item.end - item.start)} · ${formatCount((step.inputTokens ?? 0) + (step.cacheReadTokens ?? 0) + (step.cacheWriteTokens ?? 0))} in · ${formatCount(step.outputTokens ?? 0)} out`];
  }
  return [`${item.name ?? item.kind} · ${item.title}`, `${when}${item.timed ? ` · ${formatMs(item.end - item.start)}` : ''}${item.status ? ` · ${item.status}` : ''}`];
}
