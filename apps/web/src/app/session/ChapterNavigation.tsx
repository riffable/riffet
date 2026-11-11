import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { markdownHeadings, type MarkdownHeading } from './Markdown';
import { useViewPrefs } from './viewPrefs';

interface ReadingChapters {
  scope: string;
  body: HTMLElement;
  row: string;
  source: readonly MarkdownHeading[];
  headings: readonly MarkdownHeading[];
  active: number;
  compact: boolean;
  left: number;
  width: number;
  top: number;
  height: number;
  clip: { left: number; top: number; width: number; height: number };
  hovered: boolean;
}

/** A single chapter level: skip a lone document title, keeping the first level with peers. */
function chaptersOf(headings: readonly MarkdownHeading[]): readonly MarkdownHeading[] {
  for (let depth = 1; depth <= 6; depth += 1) {
    const peers = headings.filter((heading) => heading.depth === depth);
    if (peers.length >= 2) return peers;
  }
  return [];
}

/**
 * The answer being read, inside the transcript's existing left margin. Its outline comes from the
 * Markdown parse cache; the mounted DOM only supplies geometry. Windowing may replace a body,
 * so navigation carries the row and local heading key rather than retaining a DOM target.
 */
export function ChapterNavigation({ scrollRef, columnRef, onNavigate, scope }: {
  scrollRef: RefObject<HTMLElement | null>;
  columnRef: RefObject<HTMLElement | null>;
  onNavigate: (row: string, heading: string) => void;
  scope: string;
}) {
  const { t } = useLingui();
  const enabled = useViewPrefs((state) => state.chapterNavigation);
  const [snapshot, setReading] = useState<ReadingChapters | null>(null);
  const reading = enabled && snapshot?.scope === scope ? snapshot : null;
  const current = useRef(reading);
  current.current = reading;
  const listRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const pointerInside = useRef(false);
  const remeasure = useRef<() => void>(() => {});
  const [exiting, setExiting] = useState(false);
  const [entered, setEntered] = useState(false);
  const [focused, setFocused] = useState(false);

  useLayoutEffect(() => {
    if (!enabled) {
      current.current = null;
      setReading(null);
      setExiting(false);
      return;
    }
    const scroller = scrollRef.current;
    const column = columnRef.current;
    const container = scroller?.parentElement;
    if (!scroller || !column || !container) return;
    let frame = 0;
    let exit: ReturnType<typeof setTimeout> | undefined;
    let desired: ReadingChapters | null = null;
    let leaving = false;
    let pointer: { x: number; y: number } | undefined;
    const publish = (next: ReadingChapters | null) => {
      desired = next;
      const previous = current.current;
      // The outgoing owner keeps its own titles until the short fade ends. It is inert during
      // that time, and its sibling marker keeps the width handle hidden until it unmounts.
      if (previous && previous.row !== next?.row) {
        if (!leaving) {
          leaving = true;
          setExiting(true);
          const duration = parseFloat(getComputedStyle(container).getPropertyValue('--duration-exit-fast')) || 100;
          exit = setTimeout(() => {
            leaving = false;
            exit = undefined;
            current.current = desired;
            setReading(desired);
            setExiting(false);
          }, duration);
        }
        return;
      }
      if (leaving) {
        clearTimeout(exit);
        exit = undefined;
        leaving = false;
        setExiting(false);
      }
      current.current = next;
      if (next !== previous) setReading(next);
    };
    const read = () => {
      frame = 0;
      // The reading column slides with Web Animations when a sidebar/panel changes. Its size
      // stays constant during that slide, so a ResizeObserver alone cannot follow its position.
      if (column.getAnimations().some((animation) => animation.playState === 'running' || animation.pending)) schedule();
      const bounds = scroller.getBoundingClientRect();
      const line = bounds.top + Math.min(96, bounds.height * 0.2);
      let body: HTMLElement | undefined;
      for (const candidate of scroller.querySelectorAll<HTMLElement>('[data-chapter-body] > .md')) {
        const box = candidate.getBoundingClientRect();
        // A nearby answer below the reading line does not own this position. User messages,
        // process rows and the gaps between answers must never borrow its outline early.
        if (box.top > line || box.bottom <= line) continue;
        body = candidate;
        break;
      }
      const row = body?.closest<HTMLElement>('[data-row-key]')?.dataset.rowKey;
      if (!body || !row || bounds.height <= 0) {
        publish(null);
        return;
      }
      const source = markdownHeadings(body);
      const previous = current.current;
      const headings = previous?.source === source ? previous.headings : chaptersOf(source);
      if (headings.length < 2) {
        publish(null);
        return;
      }
      let active = 0;
      for (let index = 0; index < headings.length; index += 1) {
        const target = body.querySelector<HTMLElement>(`[data-md-heading="${headings[index]!.key}"]`);
        if (target && target.getBoundingClientRect().top <= line) active = index;
      }
      const containerBounds = container.getBoundingClientRect();
      const bodyBounds = body.getBoundingClientRect();
      const bodyLeft = bodyBounds.left;
      const clipLeft = Math.max(bounds.left, containerBounds.left + container.clientLeft);
      const visibleLeft = clipLeft + 8;
      const visibleRight = Math.min(bounds.right, containerBounds.right) - 8;
      // Centre the outline in the owning answer's actual left gutter. While it is present,
      // the width handle is hidden and needs no additional room.
      const right = bodyLeft - 24;
      const room = right - visibleLeft;
      const compact = room < 144;
      const width = compact ? 24 : Math.min(160, room);
      const viewportLeft = clipLeft + (bodyLeft - clipLeft - width) / 2;
      if (viewportLeft < visibleLeft || viewportLeft + width > Math.min(bodyLeft - 8, visibleRight)) {
        publish(null);
        return;
      }
      const clipTop = Math.max(bounds.top, containerBounds.top + container.clientTop);
      const clipRight = Math.min(bounds.right, containerBounds.right);
      const clipBottom = Math.min(bounds.bottom, containerBounds.bottom);
      const clip = {
        left: clipLeft - containerBounds.left - container.clientLeft,
        top: clipTop - containerBounds.top - container.clientTop,
        width: Math.max(0, clipRight - clipLeft),
        height: Math.max(0, clipBottom - clipTop),
      };
      const maximumHeight = Math.min(bounds.height * 0.6, bodyBounds.height - 32, clip.height - 16);
      if (maximumHeight < 24 || clip.width <= 0) { publish(null); return; }
      const mounted = navRef.current?.dataset.owner === row && navRef.current.dataset.compact === String(compact);
      const naturalHeight = mounted && listRef.current ? listRef.current.scrollHeight + 16 : headings.length * (compact ? 11 : 28) + 16;
      const height = Math.min(naturalHeight, maximumHeight);
      // Bounded sticky placement: the answer introduces the rail, it pauses near the reading
      // line, then the answer's bottom pushes it out. The viewport clips the departing rail.
      const viewportTop = Math.max(bodyBounds.top + 16, Math.min(line, bodyBounds.bottom - 16 - height));
      const left = viewportLeft - clipLeft;
      const top = viewportTop - clipTop;
      const hovered = Boolean(pointer && pointer.x >= viewportLeft && pointer.x <= bodyBounds.right
        && pointer.y >= Math.max(bodyBounds.top, bounds.top) && pointer.y <= Math.min(bodyBounds.bottom, bounds.bottom));
      if (previous?.body === body && previous.source === source && previous.active === active && previous.compact === compact
        && previous.hovered === hovered && Math.abs(previous.left - left) < 0.5 && Math.abs(previous.width - width) < 0.5
        && Math.abs(previous.top - top) < 0.5 && Math.abs(previous.height - height) < 0.5
        && previous.clip.left === clip.left && previous.clip.top === clip.top && previous.clip.width === clip.width && previous.clip.height === clip.height) {
        publish(previous);
        return;
      }
      publish({ scope, body, row, source, headings, active, compact, left, width, top, height, clip, hovered });
    };
    const schedule = () => { frame ||= requestAnimationFrame(read); };
    remeasure.current = schedule;
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      pointer = { x: event.clientX, y: event.clientY };
      schedule();
    };
    const leave = () => { pointer = undefined; schedule(); };
    const resize = new ResizeObserver(schedule);
    resize.observe(container);
    resize.observe(scroller);
    resize.observe(column);
    const mutations = new MutationObserver(schedule);
    mutations.observe(column, { childList: true, subtree: true });
    container.addEventListener('pointermove', move, { passive: true });
    container.addEventListener('pointerleave', leave);
    scroller.addEventListener('scroll', schedule, { passive: true });
    scroller.addEventListener('markdown-headings', schedule);
    scroller.addEventListener('transitionrun', schedule);
    scroller.addEventListener('transitionend', schedule);
    scroller.addEventListener('animationstart', schedule);
    scroller.addEventListener('animationend', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(exit);
      remeasure.current = () => {};
      current.current = null;
      pointerInside.current = false;
      setExiting(false);
      resize.disconnect();
      mutations.disconnect();
      container.removeEventListener('pointermove', move);
      container.removeEventListener('pointerleave', leave);
      scroller.removeEventListener('scroll', schedule);
      scroller.removeEventListener('markdown-headings', schedule);
      scroller.removeEventListener('transitionrun', schedule);
      scroller.removeEventListener('transitionend', schedule);
      scroller.removeEventListener('animationstart', schedule);
      scroller.removeEventListener('animationend', schedule);
    };
  }, [scrollRef, columnRef, scope, enabled]);

  useLayoutEffect(() => {
    setEntered(false);
    setFocused(false);
    if (!reading) return;
    let next = 0;
    const first = requestAnimationFrame(() => { next = requestAnimationFrame(() => setEntered(true)); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(next); };
  }, [reading?.row, scope]);

  useLayoutEffect(() => { remeasure.current(); }, [reading?.row, reading?.source, reading?.compact]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const selected = reading ? list?.children[reading.active] as HTMLElement | undefined : undefined;
    if (!list || !selected || pointerInside.current || list.contains(document.activeElement)) return;
    const top = selected.offsetTop;
    if (top < list.scrollTop || top + selected.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - (list.clientHeight - selected.offsetHeight) / 2);
    }
  }, [reading?.active, reading?.source, reading?.compact]);

  if (!reading) return null;
  return (
    <div
      data-chapter-navigation
      className="pointer-events-none absolute z-(--z-rail) hidden overflow-hidden md:block"
      style={reading.clip}
    >
    <nav
      key={reading.row}
      ref={navRef}
      data-owner={reading.row}
      data-compact={reading.compact}
      aria-label={t`章节导航`}
      aria-hidden={exiting || !entered || undefined}
      inert={exiting || !entered || undefined}
      className={cn('absolute flex flex-col py-2 transition-opacity ease-[var(--ease-standard)]',
        exiting || !entered ? 'pointer-events-none opacity-0' : 'pointer-events-auto',
        !exiting && entered && (reading.hovered || focused ? 'opacity-100' : 'opacity-65'))}
      style={{ left: reading.left, top: reading.top, width: reading.width, height: reading.height, transitionDuration: exiting ? 'var(--duration-exit-fast)' : 'var(--duration-fast)' }}
      onFocus={() => setFocused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
      onPointerEnter={() => { pointerInside.current = true; }}
      onPointerLeave={() => { pointerInside.current = false; }}
      onKeyDown={(event) => {
        const buttons = [...event.currentTarget.querySelectorAll('button')];
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : undefined;
        if (next === undefined || index < 0) return;
        event.preventDefault();
        const target = buttons[Math.max(0, Math.min(buttons.length - 1, next))];
        target?.focus({ preventScroll: true });
        const list = listRef.current;
        if (list && target) {
          if (target.offsetTop < list.scrollTop) list.scrollTop = target.offsetTop;
          else if (target.offsetTop + target.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = target.offsetTop + target.offsetHeight - list.clientHeight;
        }
      }}
    >
      <div ref={listRef} className="relative flex min-h-0 flex-col overflow-y-auto overscroll-contain scrollbar-none">
        {reading.headings.map((heading, index) => {
          const selected = index === reading.active;
          return (
            <Tip key={heading.key} label={heading.text} side="right" disabled={exiting || !entered}>
              <button
                type="button"
                aria-label={heading.text}
                aria-current={selected ? 'location' : undefined}
                onClick={() => onNavigate(reading.row, heading.key)}
                className={cn('group/chapter flex shrink-0 items-center rounded-md text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus', reading.compact ? 'h-[11px] justify-center' : 'min-h-7 px-2 py-1 text-xs hover:bg-hover', selected ? 'text-fg' : 'text-fg-4 hover:text-fg-2')}
              >
                {reading.compact
                  ? <span className={cn('block rounded-full transition-[width,height,background-color] duration-[var(--duration-slow)] ease-[var(--ease-standard)]', selected ? 'size-1.5 bg-fg' : 'size-1 bg-fg-4/55 group-hover/chapter:size-[5px] group-hover/chapter:bg-fg-3')} />
                  : <span className={cn('min-w-0 truncate', selected && 'font-medium')}>{heading.text}</span>}
              </button>
            </Tip>
          );
        })}
      </div>
    </nav>
    </div>
  );
}
