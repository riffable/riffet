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
    let entry: NonNullable<NonNullable<Run['native']>['inputEntry']>;
    try {
      // The record itself is written now, before the CLI is: the place is taken here.
      entry = ingest.writer(run.sessionId).inputSent(run.id, run.commandId, fencedAt(run));
    } catch (error) {
      console.warn(`[riffet] recording the sent input of ${run.sessionId}/${run.id} failed`, error);
      return;
    }
    // The run is told its place once the store has told every listener of the fence: a write from inside
    // a listener would reach the listeners after this one ahead of the change they are still to be told.
    queueMicrotask(() => {
      try {
        const current = store.getRun(run.id).native;
        if (current && !current.inputEntry) store.transitionNativeRun(run.id, [current.delivery], { inputEntry: entry });
      } catch { /* the run is gone */ }
    });
  });
}

const fencedAt = (run: Run): string => {
  const at = run.native?.timings?.dispatchAt;
  return new Date(typeof at === 'number' && Number.isFinite(at) ? at : Date.now()).toISOString();
};
