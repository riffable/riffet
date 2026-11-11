import { createContext, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { interpolateNumber } from 'd3-interpolate';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconArrowDown, IconArrowUp } from '@/components/icons';
import { Tip } from '@/components/ui/tooltip';
import { useMediaQuery } from '@/lib/use-media-query';
import { formatRatio, metricDelta } from '@/lib/stats-format';
import { seriesOpacity, type SeriesRef } from '@/lib/stats-series';
import { cn } from '@/lib/utils';

const HighlightContext = createContext<{ highlight: SeriesRef | null; setHighlight: (value: SeriesRef | null) => void }>({
  highlight: null,
  setHighlight: () => {},
});

export function HighlightProvider({ children }: { children: ReactNode }) {
  const [highlight, setHighlight] = useState<SeriesRef | null>(null);
  const value = useMemo(() => ({ highlight, setHighlight }), [highlight]);
  return <HighlightContext.Provider value={value}>{children}</HighlightContext.Provider>;
}

export function useHighlight() {
  return useContext(HighlightContext);
}

export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const apply = (width: number, height: number) => {
      setSize((current) => current.width === width && current.height === height ? current : { width, height });
    };
    apply(element.clientWidth, element.clientHeight);
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) apply(box.width, box.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width: size.width, height: size.height };
}

/** Count up between two measured numbers. A missing value snaps to "—" and is never tweened from zero. */
export function useAnimatedNumber(value: number | null, reduced: boolean): number | null {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  useEffect(() => {
    const from = shownRef.current;
    if (value == null || from == null || reduced || from === value) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    const lerp = interpolateNumber(from, value);
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / 640);
      const next = lerp(1 - (1 - t) ** 3);
      shownRef.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, reduced]);
  return shown;
}

export function useRovingIndex(length: number) {
  const [index, setIndex] = useState(-1);
  const safe = index < 0 || length <= 0 ? -1 : Math.min(index, length - 1);
  const onKeyDown = (event: KeyboardEvent) => {
    if (!length) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      setIndex((current) => Math.min(length - 1, (current < 0 ? -1 : current) + 1));
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((current) => Math.max(-1, (current < 0 ? 0 : current) - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setIndex(length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setIndex(-1);
    }
  };
  return { index: safe, setIndex, onKeyDown };
}

export function ChartCard({ title, actions, children, className }: { title: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-elevated p-4 max-md:p-3.5', className)}>
      <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="text-sm font-medium leading-5 text-fg">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** One legend at the page level: a dot per series, the same shape every chart uses. */
export function LegendSwatch({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', className)} style={{ background: color }} />;
}

export function LegendItem({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-2xs text-fg-3">
      <LegendSwatch color={color} />
      {children}
    </span>
  );
}

/** Keeps a pointer-anchored tooltip inside its card, whatever the card's width happens to be. */
export function useClampedLeft(): [React.RefObject<HTMLDivElement | null>, number, (left: number) => void] {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(0);
  const setFrom = (raw: number) => {
    const parent = ref.current?.offsetParent as HTMLElement | null;
    const width = ref.current?.offsetWidth ?? 0;
    if (!parent || !width) {
      setLeft(Math.max(0, raw));
      return;
    }
    setLeft(Math.min(Math.max(0, raw), Math.max(0, parent.clientWidth - width)));
  };
  return [ref, left, setFrom];
}

export function ChartTooltip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute z-10 max-w-64 rounded-lg bg-popover px-2.5 py-2 text-xs text-fg shadow-pop" style={{ left: x, top: y }}>
      {children}
    </div>
  );
}

/** A missing measurement is never a zero. The tip says why in three words, not a sentence. */
export function Unavailable({ label }: { label?: string }) {
  const { t } = useLingui();
  return <Tip label={label ?? t`该数据源不提供`}><span className="cursor-help tabular-nums text-fg-4">—</span></Tip>;
}

export function EstimatedMark() {
  const { t } = useLingui();
  return <Tip label={t`部分数字由文本长度估算，不是提供商上报`}><span aria-label={t`含估算`} className="cursor-help text-2xs leading-none text-warning">*</span></Tip>;
}

export function DeltaView({ current, previous, lowerIsBetter, title }: { current: number | null; previous: number | null; lowerIsBetter: boolean; title?: string }) {
  const { t } = useLingui();
  const delta = metricDelta(current, previous, lowerIsBetter);
  if (delta.kind === 'none') return null;
  const label = title ?? t`对比上一等长周期`;
  if (delta.kind === 'flat') return <span className="text-2xs text-fg-4"><Trans>持平</Trans></span>;
  // "New against an empty period" is what a first run always looks like; saying so on every card is noise.
  if (delta.kind === 'new') return null;
  const up = (delta.ratio ?? 0) > 0;
  const tone = delta.improved ? 'text-success' : 'text-danger';
  return (
    <Tip label={label}>
      <span className={cn('inline-flex cursor-help items-center gap-0.5 text-2xs tabular-nums', tone)}>
        {up ? <IconArrowUp className="size-3" /> : <IconArrowDown className="size-3" />}
        {formatRatio(delta.ratio ?? 0)}
      </span>
    </Tip>
  );
}

export function SeriesLegend({ items }: { items: Array<SeriesRef & { label: string; color: string; detail?: string }> }) {
  const { highlight, setHighlight } = useHighlight();
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className="inline-flex max-w-full items-center gap-1.5 rounded-md text-2xs text-fg-2 outline-none transition-opacity duration-[var(--duration-fast)] hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
          style={{ opacity: seriesOpacity(item, highlight) }}
          onMouseEnter={() => setHighlight(item)}
          onMouseLeave={() => setHighlight(null)}
          onFocus={() => setHighlight(item)}
          onBlur={() => setHighlight(null)}
        >
          <LegendSwatch color={item.color} />
          <span className="truncate">{item.label}</span>
          {item.detail && <span className="tabular-nums text-fg-4">{item.detail}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * Model ids differ at the end (`…[effort=high]` / `…[effort=low]`), where end truncation cuts them
 * to the same text; keep both ends instead. The full name goes in the row's title.
 */
export function ellipsizeMiddle(text: string, max = 26): string {
  if (text.length <= max) return text;
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, max - 1 - tail)}…${text.slice(-tail)}`;
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="px-2 py-8 text-center text-sm text-fg-3">{children}</p>;
}
