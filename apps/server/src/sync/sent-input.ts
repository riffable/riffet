import type { Run } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';
import type { TranscriptIngest } from './ingest.js';

/**
 * T1 (docs/TURN-LIFECYCLE.md): every message sent through Riffet goes into its session's journal where
 * its write fence was committed, and the run keeps that place (`NativeRunDetails.inputEntry`).
 *
 * Every send path commits its fence as the run's move to `dispatching`, and the store reports a run
 * change synchronously after the commit, so this runs before the CLI is written to. A failed record
 * only loses the place: the timeline then files the message the way it files runs from before.
 */
export function journalSentInputs(store: Store, ingest: TranscriptIngest): () => void {
  return store.onRunChanged(run => {
    const native = run.native;
    if (!native || native.delivery !== 'dispatching' || native.inputEntry) return;
    try {
      const entry = ingest.writer(run.sessionId).inputSent(run.id, run.commandId, fencedAt(run));
      store.transitionNativeRun(run.id, ['dispatching'], { inputEntry: entry });
    } catch (error) {
      console.warn(`[riffet] recording the sent input of ${run.sessionId}/${run.id} failed`, error);
    }
  });
}

const fencedAt = (run: Run): string => {
  const at = run.native?.timings?.dispatchAt;
  return new Date(typeof at === 'number' && Number.isFinite(at) ? at : Date.now()).toISOString();
};
