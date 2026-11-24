import { useEffect, useState, type RefObject } from 'react';
import { findAnimation } from '@/lib/motion';

/**
 * How deep the current file drag is inside the window, counted across every mounted composer.
 *
 * `dragenter`/`dragleave` fire for each element the pointer crosses, so a per-component boolean
 * flickers off whenever the pointer moves onto a child of the very element that armed it.
 */
let windowDragDepth = 0;

const FOLLOW_ID = 'composer-feedback-resize';
/** `--duration-base`. */
const FOLLOW_MS = 200;

/**
 * Ref for the box around the notices above the card. `Collapse` moves only as the area opens and
 * closes; a swap while it stays open (the catalog's loading line turning into an error) slides this
 * box from the old height to the new one instead of moving the card in a single frame. A width
 * change reflows at once, like the text it holds.
 */
export function followContentHeight(frame: HTMLDivElement | null) {
  const content = frame?.firstElementChild;
  if (!frame || !(content instanceof HTMLElement)) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let last: { width: number; height: number } | undefined;
  const observer = new ResizeObserver(([entry]) => {
    const size = entry?.borderBoxSize[0];
    if (!size) return;
    const next = { width: size.inlineSize, height: size.blockSize };
    const previous = last;
    last = next;
    // `Collapse` clips its box while closed or moving: opening and closing are its move, and sliding
    // this box too would run two animations on one edge.
    const moving = frame.parentElement && getComputedStyle(frame.parentElement).overflow !== 'visible';
    if (!previous || moving || previous.width !== next.width || Math.abs(previous.height - next.height) < 1 || reducedMotion.matches) return;
    // A swap mid-slide starts from where the box is now, not from where the last one began.
    const running = findAnimation(frame, FOLLOW_ID);
    const from = running ? frame.getBoundingClientRect().height : previous.height;
    running?.cancel();
    frame.animate([{ height: `${from}px`, overflow: 'hidden' }, { height: `${next.height}px`, overflow: 'hidden' }], { id: FOLLOW_ID, duration: FOLLOW_MS, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
  });
  observer.observe(content);
  return () => observer.disconnect();
}

export function useComposerWindowDrop(options: {
  cardRef: RefObject<HTMLDivElement | null>;
  disabled?: boolean;
  windowDrop?: boolean;
  attachmentsAllowed?: boolean;
  projectId: string;
  storageKey: string;
  ingestFiles: (files: FileList | File[] | null, replaceKey?: string) => Promise<void>;
}) {
  const [windowDragging, setWindowDragging] = useState(false);

  /*
   * The window is a drop target, not just the card.
   *
   * Two things have to be true at once: the browser must not navigate to the dropped file (its own
   * default for a drop anywhere on the page), and the drop that lands on the transcript — where the
   * user is actually looking — must reach this composer. `cardRef.contains(target)` is what keeps
   * the card's own handler authoritative: it already cancelled the event, and ingesting here too
   * would upload every file twice or race itself.
   *
   * The depth counter is shared by every mounted composer so one `dragenter` on a child does not
   * read as "left the window"; it is reset on drop and on dragend, because a drag can end outside
   * the window without ever firing the matching `dragleave`.
   */
  useEffect(() => {
    if (options.disabled || options.windowDrop === false || options.attachmentsAllowed === false) return;
    const draggingFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const onDragEnter = (event: DragEvent) => {
      if (!draggingFiles(event)) return;
      windowDragDepth += 1;
      setWindowDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      // Without this the browser refuses the drop and opens the file instead.
      if (draggingFiles(event)) event.preventDefault();
    };
    const onDragLeave = (event: DragEvent) => {
      if (!draggingFiles(event)) return;
      windowDragDepth = Math.max(0, windowDragDepth - 1);
      if (!windowDragDepth) setWindowDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      windowDragDepth = 0;
      setWindowDragging(false);
      const target = event.target instanceof Node ? event.target : null;
      if (target instanceof Element && target.closest('[data-composer-drop="none"]')) { event.preventDefault(); return; }
      if (target && options.cardRef.current?.contains(target)) return;
      const dropped = Array.from(event.dataTransfer?.files ?? []);
      if (!dropped.length || event.defaultPrevented) return;
      event.preventDefault();
      void options.ingestFiles(dropped);
    };
    const onDragEnd = () => {
      windowDragDepth = 0;
      setWindowDragging(false);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', onDragEnd);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', onDragEnd);
      windowDragDepth = 0;
    };
  }, [options.disabled, options.projectId, options.storageKey, options.windowDrop, options.attachmentsAllowed]);

  return windowDragging;
}
