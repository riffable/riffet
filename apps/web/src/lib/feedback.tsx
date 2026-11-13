import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { animationsOf, settled } from './motion';

export const MIN_FEEDBACK_VISIBLE_MS = 1500;

/** Counts painted, foreground time; a source disappearing never changes the source's own state. */
export class FeedbackTiming {
  private elapsed = 0;
  private since: number | undefined;

  constructor(private readonly minimum = MIN_FEEDBACK_VISIBLE_MS) {}

  get remainingMillis(): number { return Math.max(0, this.minimum - this.elapsed); }
  get complete(): boolean { return this.remainingMillis === 0; }

  update(now: number, visible: boolean): number {
    if (this.since !== undefined) this.elapsed += Math.max(0, now - this.since);
    this.since = visible ? now : undefined;
    return this.remainingMillis;
  }

  restart(now: number): void {
    this.elapsed = 0;
    if (this.since !== undefined) this.since = now;
  }
}

/** The host stays mounted; only serializable presentation data survives a source update. */
export function useRetainedFeedback<T extends { id: string }>(values: readonly T[], scope: string) {
  const signature = JSON.stringify(values);
  type Item = { value: T; current: boolean; revision: number };
  const [state, setState] = useState<{ scope: string; signature: string; items: Item[] }>(() => ({
    scope, signature, items: values.map(value => ({ value, current: true, revision: 0 })),
  }));
  if (scope !== state.scope || signature !== state.signature) {
    const previous = scope === state.scope ? state.items : [];
    const incoming = new Map(values.map(value => [value.id, value]));
    const items = previous.map(item => {
      const next = incoming.get(item.value.id);
      incoming.delete(item.value.id);
      return next ? { value: next, current: true, revision: item.revision + (item.current ? 0 : 1) } : { ...item, current: false };
    });
    items.push(...[...incoming.values()].map(value => ({ value, current: true, revision: 0 })));
    setState({ scope, signature, items });
  }
  const finish = useCallback((id: string) => {
    setState(current => current.scope !== scope ? current : {
      ...current, items: current.items.filter(item => item.value.id !== id || item.current),
    });
  }, [scope]);
  return { items: state.scope === scope ? state.items : [], finish };
}

/** Visible time starts after ancestor entrances, and pauses under dialogs, inert pages and clipping. */
export function useFeedbackTimer<T extends HTMLElement>(current: boolean, onFinished: () => void, revision = 0, enabled = true, paused = false) {
  const [element, ref] = useState<T | null>(null);
  const clock = useRef(new FeedbackTiming());
  const latest = useRef({ current, onFinished });
  latest.current = { current, onFinished };
  const generation = useRef(revision);

  useLayoutEffect(() => {
    if (!enabled) { clock.current = new FeedbackTiming(); generation.current = revision; return; }
    if (!element) return;
    if (generation.current !== revision) {
      generation.current = revision;
      clock.current.restart(performance.now());
    }
    let timer: number | undefined;
    let frame: number | undefined;
    let disposed = false;
    let inside = false;
    const viewport = window.visualViewport;
    const animationWaits = new Set<Animation>();
    const sync = () => {
      if (disposed) return;
      window.clearTimeout(timer);
      const rect = element.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      const fullscreen = document.fullscreenElement;
      let visible = !paused && inside && document.visibilityState === 'visible' && rect.width > 0 && rect.height > 0
        && (!fullscreen || fullscreen.contains(element))
        && rect.top >= top - 1 && rect.left >= left - 1
        && rect.bottom <= top + (viewport?.height ?? window.innerHeight) + 1
        && rect.right <= left + (viewport?.width ?? window.innerWidth) + 1;
      for (let node: HTMLElement | null = element; visible && node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.inert || node.hidden || node.getAttribute('aria-hidden') === 'true' || style.visibility === 'hidden' || Number(style.opacity) < 0.999) visible = false;
        for (const animation of animationsOf(node)) {
          if (animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity) continue;
          visible = false;
          if (!animationWaits.has(animation)) {
            animationWaits.add(animation);
            void settled([animation]).then(sync);
          }
        }
      }
      const dialogs = document.querySelectorAll('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');
      if ([...dialogs].some(dialog => !dialog.contains(element))) visible = false;
      const remaining = clock.current.update(performance.now(), visible);
      if (!paused && !latest.current.current && remaining === 0) { latest.current.onFinished(); return; }
      if (visible && !latest.current.current) timer = window.setTimeout(sync, remaining + 1);
    };
    const intersection = new IntersectionObserver(entries => {
      inside = (entries[0]?.intersectionRatio ?? 0) >= 0.999;
      sync();
    }, { threshold: [0, 1] });
    intersection.observe(element);
    const mutation = new MutationObserver(sync);
    mutation.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden', 'data-state'] });
    document.addEventListener('visibilitychange', sync);
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('transitionend', sync, true);
    document.addEventListener('transitionrun', sync, true);
    document.addEventListener('animationstart', sync, true);
    document.addEventListener('animationend', sync, true);
    window.addEventListener('resize', sync);
    viewport?.addEventListener('resize', sync);
    viewport?.addEventListener('scroll', sync);
    frame = requestAnimationFrame(sync);
    return () => {
      disposed = true;
      clock.current.update(performance.now(), false);
      window.clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      intersection.disconnect(); mutation.disconnect();
      document.removeEventListener('visibilitychange', sync);
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('transitionend', sync, true);
      document.removeEventListener('transitionrun', sync, true);
      document.removeEventListener('animationstart', sync, true);
      document.removeEventListener('animationend', sync, true);
      window.removeEventListener('resize', sync);
      viewport?.removeEventListener('resize', sync);
      viewport?.removeEventListener('scroll', sync);
    };
  }, [element, current, enabled, revision, paused]);
  return ref;
}

/** A repeat renews the same feedback; cleanup and scope changes invalidate every earlier timeout. */
export function useFeedbackPulse<T extends HTMLElement>(scope: string) {
  const [state, setState] = useState({ scope, shown: false, revision: 0 });
  const liveScope = useRef(scope);
  liveScope.current = scope;
  if (state.scope !== scope) setState({ scope, shown: false, revision: 0 });
  const shown = state.scope === scope && state.shown;
  const finish = useCallback(() => setState(value => value.scope === scope ? { ...value, shown: false } : value), [scope]);
  const ref = useFeedbackTimer<T>(false, finish, state.revision, shown);
  const show = useCallback(() => {
    if (liveScope.current !== scope) return;
    setState(value => ({ scope, shown: true, revision: value.revision + 1 }));
  }, [scope]);
  return { shown, show, ref };
}
