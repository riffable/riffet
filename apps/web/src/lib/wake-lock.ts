import { useEffect } from 'react';

/** Everything the wake lock decision depends on; the caller resolves feature support once. */
export interface WakeLockConditions {
  /** The conversation on screen is busy or waiting for an answer. */
  working: boolean;
  /** A wake lock only exists while its page is visible; the browser revokes it on hide. */
  visible: boolean;
  supported: boolean;
}

/**
 * Whether the screen should stay on right now.
 *
 * Both bounds are deliberate. The platform drops a lock the moment its page is hidden and refuses a
 * new request off-screen, so a hidden page must not pretend to hold one; and an unsupported browser
 * (iOS Safari is partial) has to stay a silent no-op rather than become an error path. The decision
 * is a pure function so this rule is testable without a browser; only {@link useWakeLock} touches
 * `navigator` and `document`.
 */
export function shouldHoldWakeLock({ working, visible, supported }: WakeLockConditions): boolean {
  return working && visible && supported;
}

/**
 * Keeps a screen wake lock while `working` holds and this page is visible.
 *
 * Hiding the page makes the platform release the sentinel itself, so becoming visible again has to
 * issue a fresh `request` — which is why the visibility listener re-runs the same decision instead
 * of resurrecting the old sentinel. Every failure path (no API, denied request, battery saver) is
 * swallowed: a phone that still sleeps is a missing nicety, not a broken conversation, and a page
 * that logs about it is just noise.
 */
export function useWakeLock(working: boolean): void {
  useEffect(() => {
    if (typeof document === 'undefined' || typeof navigator === 'undefined') return;
    const supported = 'wakeLock' in navigator && typeof navigator.wakeLock?.request === 'function';
    let sentinel: WakeLockSentinel | undefined;
    let requesting = false;

    const conditions = () => shouldHoldWakeLock({ working, visible: document.visibilityState === 'visible', supported });

    const release = () => {
      const held = sentinel;
      sentinel = undefined;
      if (held && !held.released) void held.release().catch(() => {});
    };

    const sync = () => {
      if (!conditions()) { release(); return; }
      if (sentinel && !sentinel.released) return;
      sentinel = undefined;
      if (requesting) return;
      requesting = true;
      void navigator.wakeLock.request('screen').then((held) => {
        requesting = false;
        sentinel = held;
        // The turn can finish, or the page can hide, while the request is in flight; the later
        // visibility change is not guaranteed to fire again, so release on this side of the await.
        if (!conditions()) release();
      }).catch(() => { requesting = false; });
    };

    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      release();
    };
  }, [working]);
}
