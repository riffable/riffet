import { useEffect, useRef, useState } from 'react';

/**
 * Whether an element has ever entered the viewport, latched: once a code block has been read,
 * highlighting it stays worth the work even after it scrolls away again.
 *
 * The observer is shared by every caller — code fences are the only users and a long transcript can
 * hold hundreds of them, each of which would otherwise own an `IntersectionObserver` and a
 * document-wide target registration. `rootMargin` reaches a little past the fold so a block is
 * already highlighted by the time it is scrolled to.
 */
type Listener = () => void;

const listeners = new Map<Element, Listener>();
let observer: IntersectionObserver | undefined;

function stopObserving(element: Element): void {
  listeners.delete(element);
  observer?.unobserve(element);
}

function sharedObserver(): IntersectionObserver | undefined {
  if (typeof IntersectionObserver === 'undefined') return undefined;
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const listener = listeners.get(entry.target);
      stopObserving(entry.target);
      listener?.();
    }
  }, { rootMargin: '240px 0px' });
  return observer;
}

export function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    // Latched: a re-render never re-arms the observer for an element already seen.
    if (inView) return;
    const element = ref.current;
    if (!element) return;
    const shared = sharedObserver();
    // Without `IntersectionObserver` the ability to see the code matters more than the cost of
    // highlighting it, so it is highlighted — just later, in the next task.
    if (!shared) { setInView(true); return; }
    listeners.set(element, () => setInView(true));
    shared.observe(element);
    return () => { stopObserving(element); };
  }, [inView]);

  return [ref, inView];
}
