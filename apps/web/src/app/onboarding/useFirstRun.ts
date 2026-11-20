import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { readStored, writeStored } from '@/lib/utils';

/** This browser went through the guide, or was found not to need it: kept here only (patterns §1.5). */
const ONBOARDED_KEY = 'riffet.onboarded.v1';

/**
 * Whether the first-run guide covers the workbench. It is decided once, on the server's first answer:
 * the guide shows only to a browser that has not been through it, on a server with no conversation
 * yet that the Mac App does not run (the App guided its owner already). Any other answer is recorded
 * as done, so the guide never turns up later in this browser.
 */
export function useFirstRun({ fresh, hasSessions }: { fresh: boolean; hasSessions: boolean }) {
  const [state, setState] = useState<'unknown' | 'open' | 'done'>(() => readStored(ONBOARDED_KEY) ? 'done' : 'unknown');
  const finish = useCallback(() => { writeStored(ONBOARDED_KEY, '1'); setState('done'); }, []);
  useEffect(() => {
    if (state !== 'unknown' || !fresh) return;
    if (hasSessions) { finish(); return; }
    let active = true;
    void api.health()
      .then((health) => { if (active) { if (health.managedBy === 'app') finish(); else setState('open'); } })
      .catch(() => { if (active) setState('open'); });
    return () => { active = false; };
  }, [state, fresh, hasSessions, finish]);
  return { open: state === 'open', finish };
}
