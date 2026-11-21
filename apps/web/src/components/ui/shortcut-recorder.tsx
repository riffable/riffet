import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Kbd } from './controls';

/**
 * A shortcut shown as key caps that records the next key combination when activated. It owns the
 * recording state and the keyboard handling (Esc cancels, Tab leaves, a press of only modifiers waits);
 * what a combination means is the caller's: `onCapture` gets the key press and returns true once the
 * recording is over, false to keep listening. `onActiveChange` lets the caller hold other shortcuts back.
 */
export function ShortcutRecorder({ caps, off, prompt, label, onCapture, onActiveChange, initialActive = false, className }: {
  caps: readonly string[];
  /** Shown instead of the caps while there are none: the shortcut is off. */
  off: string;
  /** Shown while recording. */
  prompt: string;
  label: string;
  onCapture: (event: KeyboardEvent) => boolean;
  onActiveChange?: (active: boolean) => void;
  /** Starts out recording; for the design page's sample of that state. */
  initialActive?: boolean;
  className?: string;
}) {
  const [active, setActive] = useState(initialActive);
  const notify = useRef(onActiveChange);
  notify.current = onActiveChange;
  useEffect(() => {
    if (!active) return;
    notify.current?.(true);
    return () => notify.current?.(false);
  }, [active]);
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={() => setActive(true)}
      onBlur={() => setActive(false)}
      onKeyDown={(event) => {
        if (!active) return;
        if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') setActive(false);
        else if (onCapture(event.nativeEvent)) setActive(false);
      }}
      className={cn(
        'flex h-7 min-w-24 items-center justify-end gap-1 rounded-md border border-transparent px-1.5 text-xs hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus no-hover:min-h-11',
        active && 'border-accent bg-bg ring-3 ring-accent/15 hover:bg-bg',
        className,
      )}
    >
      {active ? <span className="text-fg-3">{prompt}</span>
        : caps.length ? caps.map((cap, index) => <Kbd key={index}>{cap}</Kbd>)
          : <span className="text-fg-4">{off}</span>}
    </button>
  );
}
