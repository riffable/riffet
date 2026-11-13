/*
 * Development aid for docs/WEB.md 布局稳定性: every layout shift not caused by input is reported with
 * the nodes that moved, and marked unanimated when no geometric animation or transition was running
 * to carry it. A shift that is neither animated nor compensated is the defect the contract names.
 */

import { animationsOf } from './motion';

interface Rect { x: number; y: number; width: number; height: number }
export interface LayoutShiftSource { node: string; previous: Rect; current: Rect }
export interface LayoutShiftRecord {
  /** `performance.now()` time of the frame that shifted. */
  at: number;
  value: number;
  /** No animation or transition of a layout property was running (or had just ended) at the time. */
  unanimated: boolean;
  sources: LayoutShiftSource[];
}

/** The Layout Instability API's entry; not in the DOM typings. */
interface LayoutShift extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
  sources: readonly { node: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[];
}

declare global {
  interface Window { __layoutShifts?: LayoutShiftRecord[] }
}

/** Properties whose animation repaints without moving anything; a shift alongside them is unexplained. */
const PAINT_ONLY = new Set([
  'opacity', 'color', 'background-color', 'border-color', 'outline-color', 'text-decoration-color', 'fill', 'stroke',
  'box-shadow', 'filter', 'backdrop-filter', 'transform', 'translate', 'rotate', 'scale', 'visibility',
]);
/** Keyframe members that are not animated properties. */
const FRAME_KEYS = new Set(['offset', 'computedOffset', 'easing', 'composite']);
/**
 * When geometric animations ran, sampled every frame while a monitor is installed plus CSS transition
 * ends. Shifts arrive in the observer's callback, which can lag their frame by many frames; they are
 * judged against these times, not against what happens to be running when the callback fires.
 */
let spans: { from: number; to: number }[] = [];
/** How far apart a shift and an animation's sampled run may be: a frame each way, as the sample lands before style. */
const SLACK_MS = 34;
/** How long spans are kept for late observer callbacks. */
const KEEP_MS = 10_000;
let installs = 0;
let sampler = 0;
/** The previous frame's sample saw one running: a long frame in between does not split its span. */
let sampledRunning = false;

function note(at: number, continues = false) {
  const last = spans.at(-1);
  if (last && (continues || (at >= last.from - SLACK_MS && at <= last.to + SLACK_MS))) {
    last.from = Math.min(last.from, at);
    last.to = Math.max(last.to, at);
  } else spans.push({ from: at, to: at });
  if (spans[0]!.to < at - KEEP_MS) spans = spans.filter((span) => span.to >= at - KEEP_MS);
}
const runningGeometry = () => typeof document !== 'undefined' && animationsOf(document).some((animation) => animation.playState === 'running' && geometric(animation));
function sample(now: number) {
  sampler = requestAnimationFrame(sample);
  const running = runningGeometry();
  if (running) note(now, sampledRunning);
  sampledRunning = running;
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
function geometric(animation: Animation): boolean {
  if ('transitionProperty' in animation) return !PAINT_ONLY.has(String(animation.transitionProperty));
  // Decorative loops (spinners, shimmer) carry no layout change.
  const effect = animation.effect;
  if (!(effect instanceof KeyframeEffect) || !Number.isFinite(effect.getComputedTiming().endTime as number)) return false;
  return effect.getKeyframes().some((frame) => Object.keys(frame).some((key) => !FRAME_KEYS.has(key) && !key.startsWith('--') && !PAINT_ONLY.has(kebab(key))));
}

/** Whether an animation or transition of a layout property runs now, or one ran at or after [since]. */
export function geometryAnimating(since = Infinity): boolean {
  return spans.some((span) => span.to >= since) || runningGeometry();
}

/** Whether an animation or transition of a layout property ran around [at], a shift's frame time. */
function geometryAround(at: number): boolean {
  return spans.some((span) => span.to >= at - SLACK_MS && span.from <= at + SLACK_MS);
}

/** A short selector-like name for [node]: tag, row or item key, id, a few classes. */
export function describeNode(node: Node | null): string {
  if (!node) return '(gone)';
  if (!(node instanceof Element)) return node.nodeName.toLowerCase();
  const element = node as HTMLElement;
  let name = element.tagName.toLowerCase();
  if (element.id) name += `#${element.id}`;
  const key = element.dataset?.rowKey ?? element.dataset?.itemKey;
  if (key) name += `[${element.dataset.rowKey ? 'row' : 'item'}=${key}]`;
  const classes = typeof element.className === 'string' ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
  if (classes.length) name += `.${classes.join('.')}`;
  const owner = !key ? element.closest<HTMLElement>('[data-row-key]') : null;
  return owner ? `${name} in [row=${owner.dataset.rowKey}]` : name;
}

/** `window.__layoutShifts` keeps the latest this many. */
const MAX_KEPT = 1000;
const rect = (value: DOMRectReadOnly): Rect => ({ x: Math.round(value.x), y: Math.round(value.y), width: Math.round(value.width), height: Math.round(value.height) });

/**
 * Starts reporting layout shifts in development: each one to the console (unless [log] is false)
 * and to `window.__layoutShifts`, and to [onShift]. Returns the function that stops it.
 */
export function installLayoutShiftMonitor({ log = true, onShift }: { log?: boolean; onShift?: (record: LayoutShiftRecord) => void } = {}): () => void {
  if (!import.meta.env.DEV || typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('layout-shift')) return () => {};
  const shifts = (window.__layoutShifts ??= []);
  const onTransitionDone = (event: TransitionEvent) => {
    if (!PAINT_ONLY.has(event.propertyName)) note(event.timeStamp);
  };
  document.addEventListener('transitionend', onTransitionDone, true);
  document.addEventListener('transitioncancel', onTransitionDone, true);
  if (installs++ === 0) sampler = requestAnimationFrame(sample);
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as LayoutShift[]) {
      if (entry.hadRecentInput) continue;
      const record: LayoutShiftRecord = {
        at: Math.round(entry.startTime),
        value: entry.value,
        unanimated: !geometryAround(entry.startTime),
        sources: entry.sources.map((source) => ({ node: describeNode(source.node), previous: rect(source.previousRect), current: rect(source.currentRect) })),
      };
      shifts.push(record);
      if (shifts.length > MAX_KEPT) shifts.splice(0, shifts.length - MAX_KEPT);
      onShift?.(record);
      if (log) console.warn(`[layout-shift] ${record.value.toFixed(4)}${record.unanimated ? ' unanimated' : ''}`, ...entry.sources.map((source, index) => ({ ...record.sources[index], element: source.node })));
    }
  });
  observer.observe({ type: 'layout-shift', buffered: true });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--installs === 0) { cancelAnimationFrame(sampler); spans = []; sampledRunning = false; }
    observer.disconnect();
    document.removeEventListener('transitionend', onTransitionDone, true);
    document.removeEventListener('transitioncancel', onTransitionDone, true);
  };
}

export interface FlashRecord { at: number; kind: 'spinner' | 'disabled'; ms: number; node: string }
declare global {
  interface Window { __uiFlashes?: FlashRecord[] }
}
/** Shorter than the wait grace (`WAIT_GRACE_MS`): a state that came and went this fast told the reader nothing. */
const FLASH_MS = 500;

/**
 * The flashes the layout-shift API cannot see because nothing moved: a spinner shown, or a control
 * disabled (dimmed), for less than [FLASH_MS]. They come from a wait that was over before it could
 * mean anything, or from a key that changed one render before its data was applied (docs/WEB.md,
 * 数据就绪). Each is logged and kept in `window.__uiFlashes`. Returns the function that stops it.
 */
export function installFlashMonitor({ log = true }: { log?: boolean } = {}): () => void {
  if (!import.meta.env.DEV || typeof MutationObserver === 'undefined') return () => {};
  const flashes = (window.__uiFlashes ??= []);
  const since = new WeakMap<Element, number>();
  const report = (kind: FlashRecord['kind'], element: Element, now: number) => {
    const start = since.get(element);
    since.delete(element);
    if (start === undefined || now - start >= FLASH_MS) return;
    const record: FlashRecord = { at: Math.round(now), kind, ms: Math.round(now - start), node: describeNode(kind === 'spinner' ? element.parentElement : element) };
    flashes.push(record);
    if (flashes.length > MAX_KEPT) flashes.splice(0, flashes.length - MAX_KEPT);
    if (log) console.warn(`[ui-flash] ${kind} ${record.ms}ms`, record.node, element);
  };
  const spinners = (node: Node): Element[] => node instanceof Element ? [...(node.matches('.ui-spinner') ? [node] : []), ...node.querySelectorAll('.ui-spinner')] : [];
  const observer = new MutationObserver((mutations) => {
    const now = performance.now();
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        const element = mutation.target as Element;
        if (element.hasAttribute('disabled')) since.set(element, now);
        else report('disabled', element, now);
        continue;
      }
      for (const node of mutation.addedNodes) for (const spinner of spinners(node)) since.set(spinner, now);
      for (const node of mutation.removedNodes) for (const spinner of spinners(node)) report('spinner', spinner, now);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
  return () => observer.disconnect();
}
