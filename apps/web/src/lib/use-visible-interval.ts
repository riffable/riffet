import { useEffect, useRef } from 'react';

/**
 * Calls [callback] every [ms] while the page is visible. A hidden page does not tick; if a tick was
 * skipped, it runs once as the page becomes visible again.
 */
export function useVisibleInterval(callback: () => void, ms: number, enabled = true): void {
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    if (!enabled) return;
    let missed = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') missed = true;
      else latest.current();
    }, ms);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' || !missed) return;
      missed = false;
      latest.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [ms, enabled]);
}
