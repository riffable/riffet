// The one place that reads or awaits Web Animations (`pnpm check:motion`). Call sites used to ask
// `getAnimations()` and `.finished` their own way, and one of them re-measured through an
// already-resolved `finished` in a microtask loop that never let the page run. Here "in progress"
// has one meaning, and everything that waits yields to a frame before it answers.

interface MotionScope {
  /** Include animations of descendants. */
  subtree?: boolean;
  /** Include finished and idle animations too: a `fill: 'forwards'` one stays listed after it ends. */
  all?: boolean;
}

/** Still moving, or about to: not finished (even when filling), not idle. */
const inProgress = (animation: Animation) => animation.playState === 'running' || animation.pending;

/** The element's animations (a Document for all of the page's); in progress only unless `all`. */
export function animationsOf(target: Element | Document, { subtree, all }: MotionScope = {}): Animation[] {
  const found = subtree && target instanceof Element ? target.getAnimations({ subtree: true }) : target.getAnimations();
  return all ? found : found.filter(inProgress);
}

/** The element's own animation with this id, if it is in progress. */
export function findAnimation(target: Element, id: string): Animation | undefined {
  return animationsOf(target).find((animation) => animation.id === id);
}

/** Cancels the element's animations, or only those with this id. Finished ones go too. */
export function cancelAnimations(target: Element, id?: string) {
  for (const animation of animationsOf(target, { all: true })) if (id === undefined || animation.id === id) animation.cancel();
}

/**
 * Resolves after the animations that are still in progress have finished or been cancelled, and then
 * after a frame: never within the caller's own microtask checkpoint, so a caller that re-checks in a
 * loop costs a frame per round instead of freezing the page. The timer covers a hidden tab, where
 * frames do not come.
 */
export function settled(animations: readonly Animation[]): Promise<void> {
  const waiting = animations.filter(inProgress).map((animation) => animation.finished);
  return Promise.allSettled(waiting).then(() => new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      resolve();
    };
    const frame = requestAnimationFrame(finish);
    const timer = window.setTimeout(finish, 100);
  }));
}

/** Parses a CSS time value (`300ms` or `.3s` after CSS minification) into milliseconds. */
export function cssDurationMs(raw: string, fallback: number): number {
  const value = raw.trim().toLowerCase();
  const num = parseFloat(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  if (value.endsWith('ms')) return num;
  if (value.endsWith('s')) return num * 1000;
  return num;
}

/** Longer than a frame or two of slack: the timer only matters when the animation never runs. */
const EXIT_MARGIN_MS = 100;

/**
 * Animates the element out and calls `done` once, when that animation finishes or is cancelled; the
 * element then holds its last frame (fill forwards) until the caller removes it. A timer past the
 * duration is the fallback for animations that do not run (a hidden tab, an element not rendered).
 * Returns a disposer: it cancels the animation and `done` does not fire.
 */
export function exit(element: HTMLElement, keyframes: Keyframe[], options: { duration: number; easing?: string }, done: () => void): () => void {
  let live = true;
  const finish = () => {
    if (!live) return;
    live = false;
    window.clearTimeout(timer);
    done();
  };
  const animation = element.animate(keyframes, { ...options, fill: 'forwards' });
  const timer = window.setTimeout(finish, options.duration + EXIT_MARGIN_MS);
  animation.finished.then(finish, finish);
  return () => {
    live = false;
    window.clearTimeout(timer);
    animation.cancel();
  };
}
