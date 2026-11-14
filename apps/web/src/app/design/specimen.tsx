import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Slider } from 'radix-ui';
import { cn } from '@/lib/utils';

/**
 * The parts the design page is built from. It is set like a printed specimen: chapters on
 * alternating paper, a twelve-column grid, numbered plates with their caption in the first three
 * columns. Names are tokens and stay in English (`fg-3`, `Button`); values are read from the page
 * as painted, so a theme switch, a custom theme or a plugin palette shows its own numbers.
 */

/** Changes whenever the painted theme does; specimens that read computed values re-read on it. */
export const PaintRevision = createContext('');

/** Reads `read(element)` after each paint of a new theme. */
export function usePainted<T, E extends HTMLElement = HTMLDivElement>(read: (element: HTMLElement) => T): [RefObject<E | null>, T | undefined] {
  const ref = useRef<E | null>(null);
  const revision = useContext(PaintRevision);
  const [value, setValue] = useState<T>();
  useLayoutEffect(() => { if (ref.current) setValue(read(ref.current)); }, [revision]);
  return [ref, value];
}

/** A root custom property as painted, e.g. `--z-menu`. */
export function useRootValue(name: string): string {
  const revision = useContext(PaintRevision);
  const [value, setValue] = useState('');
  useLayoutEffect(() => { setValue(getComputedStyle(document.documentElement).getPropertyValue(name).trim()); }, [name, revision]);
  return value;
}

/**
 * Display sizes for titles and specimens, fluid between two bounds. They sit outside the
 * interface's text ladder on purpose: the page is set as a poster, the interface is not.
 */
export const display = (min: number, fluid: string, max: number): CSSProperties => ({ fontSize: `clamp(${min}px, ${fluid}, ${max}px)` });

/** Whether the reader asked for less motion; demonstrations then show their end state. */
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Whether the element is in view. With `once`, it stays true after the first time. */
export function useInView<E extends Element = HTMLDivElement>({ once = false, margin = '0px 0px -10% 0px' }: { once?: boolean; margin?: string } = {}): [RefObject<E | null>, boolean] {
  const ref = useRef<E | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      if (!once) setSeen(entry.isIntersecting);
      else if (entry.isIntersecting) { setSeen(true); observer.disconnect(); }
    }, { rootMargin: margin });
    observer.observe(element);
    return () => observer.disconnect();
  }, [once, margin]);
  return [ref, seen];
}

/** Lifts its content into place the first time it comes into view. */
export function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const [ref, shown] = useInView({ once: true });
  return (
    <div
      ref={ref}
      className={cn('transition-[opacity,translate] duration-[calc(var(--duration-slow)*2.4)] ease-[var(--ease-out-soft)]', !shown && 'translate-y-8 opacity-0', className)}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

/**
 * Writes how far the page has scrolled through the element to its `--p`, 0–1: 0 while its top is
 * at or below the scroller's top, 1 once its bottom reaches the scroller's bottom. For pinned
 * figures whose drawing follows the scroll.
 */
export function useScrollProgress<E extends HTMLElement = HTMLDivElement>(shape: (p: number) => number = (p) => p): RefObject<E | null> {
  const ref = useRef<E | null>(null);
  const shaped = useRef(shape);
  shaped.current = shape;
  useEffect(() => {
    const element = ref.current;
    const scroller = element?.closest<HTMLElement>('[data-design-scroller]');
    if (!element || !scroller) return;
    if (reducedMotion()) { element.style.setProperty('--p', '1'); return; }
    let frame = 0;
    const read = () => {
      frame = 0;
      const box = element.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      const travel = box.height - view.height;
      const raw = travel > 0 ? Math.min(1, Math.max(0, (view.top - box.top) / travel)) : 1;
      element.style.setProperty('--p', shaped.current(raw).toFixed(4));
    };
    const schedule = () => { frame ||= requestAnimationFrame(read); };
    scroller.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    read();
    return () => { scroller.removeEventListener('scroll', schedule); observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  return ref;
}

/** Smoothstep between `from` and `to`: holds at 0 before, at 1 after. */
export const ease = (from: number, to: number) => (p: number) => {
  const x = Math.min(1, Math.max(0, (p - from) / (to - from)));
  return x * x * (3 - 2 * x);
};

/** A labelled slider for a demonstration's one free variable. */
export function Scrubber({ label, value, min, max, step = 1, onChange, unit = '', marks = [] }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void; unit?: string; marks?: number[] }) {
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-xs text-fg-3">{label}</span>
        <span className="font-mono text-xs tabular-nums text-fg">{value}{unit}</span>
      </div>
      <Slider.Root className="relative flex h-5 w-full touch-none select-none items-center" value={[value]} min={min} max={max} step={step} onValueChange={([next]) => onChange(next ?? value)}>
        <Slider.Track className="relative h-0.5 grow rounded-full bg-line-strong">
          <Slider.Range className="absolute h-full rounded-full bg-fg" />
          {marks.map((mark) => <span key={mark} aria-hidden className="absolute top-1/2 h-2 w-px -translate-y-1/2 bg-fg-3" style={{ left: `${((mark - min) / (max - min)) * 100}%` }} />)}
        </Slider.Track>
        <Slider.Thumb aria-label={label} className="block size-4 rounded-full bg-elevated shadow-[0_0_0_1px_var(--line-strong),var(--shadow-soft)] outline-none transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)] hover:scale-110 focus-visible:ring-2 focus-visible:ring-focus active:scale-95" />
      </Slider.Root>
    </div>
  );
}

/** Counts up to `to` the first time it comes into view. */
export function CountUp({ to, className, style }: { to: number; className?: string; style?: CSSProperties }) {
  const [ref, seen] = useInView<HTMLSpanElement>({ once: true });
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!seen) return;
    if (reducedMotion()) { setShown(to); return; }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const x = Math.min(1, (now - start) / 1100);
      setShown(Math.round(to * (1 - (1 - x) ** 3)));
      if (x < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [seen, to]);
  return <span ref={ref} className={className} style={style}>{shown}</span>;
}

/** The measure every chapter is set in. */
export const PAGE = 'mx-auto w-full max-w-[1200px] px-12 max-md:px-5';

type Tone = 'paper' | 'canvas';
const ChapterTone = createContext<Tone>('paper');

/** The element id a chapter is reached by; prefixed, so it cannot collide with the workbench's own. */
export const chapterAnchor = (id: string) => `design-${id}`;

/** One chapter: a band of its own paper, its number and source, its title and a one-line thesis. */
export function Chapter({ id, number, title, lede, source, tone = 'paper', children }: { id: string; number: string; title: string; lede: ReactNode; source?: string; tone?: Tone; children: ReactNode }) {
  return (
    <ChapterTone.Provider value={tone}>
      <section id={chapterAnchor(id)} data-design-chapter data-number={number} data-title={title} className={cn(tone === 'canvas' ? 'bg-sidebar' : 'bg-bg')}>
        <div className={cn(PAGE, 'flex flex-col gap-24 py-32 max-md:gap-16 max-md:py-20')}>
          <header className="flex max-w-[48rem] flex-col">
            <Reveal className="flex items-center gap-3 font-mono text-xs text-fg-4">
              <span className="tabular-nums text-fg-3">{number}</span>
              <span className="h-px w-6 bg-line-strong" />
              {source && <span className="min-w-0 truncate">{source}</span>}
            </Reveal>
            <Reveal delay={60}><h2 className="mt-5 font-semibold leading-[1.05] tracking-tight text-fg" style={display(36, '5vw', 64)}>{title}</h2></Reveal>
            <Reveal delay={120}><p className="mt-5 max-w-[36em] text-lg text-fg-2">{lede}</p></Reveal>
          </header>
          {children}
        </div>
      </section>
    </ChapterTone.Provider>
  );
}

/** A numbered figure: its caption in the first three columns, the figure in the other nine. */
export function Plate({ number, title, note, action, children }: { number: string; title: string; note?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-12 gap-x-6 gap-y-6">
      <Reveal className="col-span-12 flex flex-col gap-2 md:col-span-3">
        <span className="font-mono text-xs text-fg-4">{number}</span>
        <h3 className="text-base font-medium text-fg">{title}</h3>
        {note && <p className="text-sm text-fg-3">{note}</p>}
        {action && <div className="mt-3">{action}</div>}
      </Reveal>
      <Reveal delay={120} className="col-span-12 min-w-0 md:col-span-9">{children}</Reveal>
    </div>
  );
}

/** The ground a figure is drawn on: the other paper from the chapter's, so it always reads as a plate. */
export function Frame({ children, className }: { children: ReactNode; className?: string }) {
  const tone = useContext(ChapterTone);
  return <div className={cn('relative overflow-hidden rounded-2xl', tone === 'canvas' ? 'bg-bg shadow-[0_0_0_1px_var(--line)]' : 'bg-sidebar', className)}>{children}</div>;
}

export function Token({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn('font-mono text-xs text-fg', className)}>{children}</code>;
}

export function Value({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-2xs tabular-nums text-fg-3', className)}>{children}</span>;
}

/**
 * A component's variants by column, ruled like a table in a book. Without columns a row's cells
 * run on in one line, each cell a cluster.
 */
export function Matrix({ columns, rows }: { columns?: string[]; rows: Array<{ label: ReactNode; cells: ReactNode[] }> }) {
  return (
    <div className="overflow-x-auto">
      <table className={cn('w-full border-collapse', columns && 'min-w-[600px] table-fixed')}>
        {columns && (
          <thead>
            <tr>
              <th className="w-40 pb-3" />
              {columns.map((column) => <th key={column} className="pb-3 pr-4 text-left font-mono text-2xs font-normal text-fg-4">{column}</th>)}
            </tr>
          </thead>
        )}
        <tbody className="[&>tr]:edge-t [&>tr:last-child]:edge-b">
          {rows.map((row, index) => (
            <tr key={index}>
              <td className="w-40 whitespace-nowrap py-4 pr-4 align-middle">{typeof row.label === 'string' ? <Token className="text-fg-3">{row.label}</Token> : row.label}</td>
              {columns
                ? row.cells.map((cell, cellIndex) => <td key={cellIndex} className="py-4 pr-4 align-middle"><div className="flex flex-wrap items-center gap-3">{cell}</div></td>)
                : <td className="py-4 align-middle"><div className="flex flex-wrap items-center gap-x-10 gap-y-3">{row.cells.map((cell, cellIndex) => <div key={cellIndex} className="flex flex-wrap items-center gap-3">{cell}</div>)}</div></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A colour as it was painted, in sRGB: `[r, g, b, a]` with channels 0–255 and alpha 0–1. */
export type Rgba = [number, number, number, number];

let probe: CanvasRenderingContext2D | null | undefined;

/** Any CSS colour the browser paints, resolved by painting one pixel of it. */
export function toRgba(css: string): Rgba | undefined {
  probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!probe || !css) return undefined;
  probe.canvas.width = 1;
  probe.canvas.height = 1;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000';
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!, a! / 255];
}

export function hex([r, g, b, a]: Rgba): string {
  const value = `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  return a < 1 ? `${value} · ${Math.round(a * 100)}%` : value;
}

/** `top` laid over `bottom`, for a contrast that counts a translucent colour as it is seen. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((index) => Math.round(top[index]! * a + bottom[index]! * (1 - a))).concat(1) as Rgba;
}

function luminance([r, g, b]: Rgba): number {
  const linear = (channel: number) => { const value = channel / 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** The WCAG contrast ratio of two opaque colours. */
export function contrast(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** A colour role painted as this element's text colour: its value, and its contrast with `--bg`. */
export function readInk(element: HTMLElement): { value: Rgba; ratio: number } | undefined {
  const value = toRgba(getComputedStyle(element).color);
  const ground = toRgba(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  if (!value || !ground) return undefined;
  return { value, ratio: contrast(over(value, ground), ground) };
}

/** A colour role painted as this element's background, in hex. */
export function readFill(element: HTMLElement): string | undefined {
  const value = toRgba(getComputedStyle(element).backgroundColor);
  return value && hex(value);
}

/** One component on its own stage, named underneath with the prop that selects it. */
export function Specimen({ name, prop, note, wide, children }: { name: string; prop?: string; note?: string; wide?: boolean; children: ReactNode }) {
  const tone = useContext(ChapterTone);
  return (
    <Reveal className={cn('flex min-w-0 flex-col gap-3', wide && 'md:col-span-2')}>
      <div className={cn('flex min-h-52 flex-wrap items-center justify-center gap-3 rounded-2xl p-8 max-md:min-h-40 max-md:p-5', tone === 'canvas' ? 'bg-bg shadow-[0_0_0_1px_var(--line)]' : 'bg-sidebar')}>{children}</div>
      <div className="flex flex-col gap-0.5 px-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="shrink-0 text-sm font-medium text-fg">{name}</span>
          {prop && <span className="truncate font-mono text-2xs text-fg-4">{prop}</span>}
        </span>
        {note && <span className="text-sm text-fg-3">{note}</span>}
      </div>
    </Reveal>
  );
}

/** A family of components: a heading, then their stages. */
export function Family({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <Reveal><h3 className="text-xl font-semibold tracking-tight text-fg">{title}</h3></Reveal>
      <div className="grid gap-x-5 gap-y-10 md:grid-cols-2 lg:grid-cols-3">{children}</div>
    </div>
  );
}
