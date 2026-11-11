import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Button, useMessages, type ComposerSlotProps } from '@riffet/plugin-web';
import { IconArrowUp } from './icons';
import { catalogs } from './messages';
import { useCameraSelect, type Bounds, type CameraApi } from './Viewport';

/*
 * Where the reader writes on the canvas: the conversation's own composer at the next question, and a
 * small field under an answer to continue from it as a fork. Both live in screen space, at one scale
 * at any zoom, pinned to a place in the world so they move with the camera.
 */

/** What a menu or picker the composer opens outside its own box looks like, so a press on it is not a press away. */
const FLOATING = '.ui-floating-content, [data-radix-popper-content-wrapper], [role="dialog"], [role="menu"], [role="listbox"]';

/**
 * A panel at a world box's screen position: over it, or [below] it. Its width is the box's on screen
 * within [min] and [max]; it stays inside the plane (less the [inset] the inspector takes on the right).
 * A press outside, or Escape that nothing inside took, closes it.
 */
function Anchored({ camera, box, below = false, min, max = Infinity, inset, onClose, children }: {
  camera: CameraApi;
  box: Bounds;
  below?: boolean;
  min: number;
  max?: number;
  inset: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const left = useCameraSelect(camera, (view) => box.x * view.k + view.x);
  const top = useCameraSelect(camera, (view) => (box.y + (below ? box.h : 0)) * view.k + view.y);
  const wide = useCameraSelect(camera, (view) => box.w * view.k);
  const { w: viewW, h: viewH } = camera.size;
  const open = viewW - inset;
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => entry && setHeight(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || ref.current?.contains(target) || target.closest(FLOATING)) return;
      close.current();
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, []);
  const width = Math.max(120, Math.min(Math.max(wide, min), max, open - 24));
  const x = Math.min(Math.max(left, 12), Math.max(12, open - width - 12));
  const y = Math.min(Math.max(top + (below ? 8 : 0), 12), Math.max(12, viewH - height - 12));
  return (
    <div
      ref={ref}
      data-canvas-scroll
      className="canvas-pop absolute z-20 cursor-auto select-text"
      style={{ left: x, top: y, width }}
      onKeyDown={(event) => {
        // Escape that cancels an IME candidate is not a request to close.
        if (event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.stopPropagation(); onClose(); }
      }}
    >
      {children}
    </div>
  );
}

/** The conversation's composer over the next question's slot, as wide as the slot or 520 pixels. */
export function NextComposer({ composer: Composer, camera, box, inset, onSent, onClose }: {
  composer: ComponentType<ComposerSlotProps>;
  camera: CameraApi;
  box: Bounds;
  inset: number;
  onSent: (text: string) => void;
  onClose: () => void;
}) {
  return (
    <Anchored camera={camera} box={box} min={520} inset={inset} onClose={onClose}>
      <Composer autoFocus className="shadow-pop" onSent={onSent} />
    </Anchored>
  );
}

/** Up to six lines of the field show before it scrolls. */
const FIELD_MAX = 6 * 20 + 8;

/** A line of text under an answer to continue from it in a fork of its own; sent empty it is a plain fork. */
export function ForkDraft({ camera, box, inset, initial, onChange, onSend, onClose }: {
  camera: CameraApi;
  box: Bounds;
  inset: number;
  initial: string;
  onChange: (text: string) => void;
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const m = useMessages(catalogs);
  const [text, setText] = useState(initial);
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, FIELD_MAX)}px`;
  }, [text]);
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  const send = () => onSend(text.trim());
  return (
    <Anchored camera={camera} box={box} below min={280} max={440} inset={inset} onClose={onClose}>
      <div className="flex items-end gap-1 rounded-xl bg-popover py-1.5 pl-3 pr-1.5 shadow-pop">
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={m.continueFromHere}
          aria-label={m.continueFromHere}
          className="min-w-0 flex-1 resize-none bg-transparent py-1 text-[13px] leading-5 text-fg outline-none placeholder:text-fg-4"
          onChange={(event) => { setText(event.target.value); onChange(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            send();
          }}
        />
        <Button size="icon-sm" variant="primary" aria-label={m.forkFromHere} onClick={send}><IconArrowUp className="size-3.5" /></Button>
      </div>
    </Anchored>
  );
}
