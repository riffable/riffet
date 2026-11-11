import type { NativeStatus } from '@contracts';

export type NativeHistoryLoadState = NonNullable<NativeStatus['history']>;
export type TranscriptLoadView = 'loading' | 'content' | 'error';
export type NativeConnectionNoticeState = NonNullable<NativeStatus['connection']>['state'];

/** Provider ownership and the browser's stream are separate signals. */
export function connectionNoticeState(provider: NativeConnectionNoticeState | undefined, transportConnected: boolean, statusKnown: boolean): NativeConnectionNoticeState | undefined {
  if (provider === 'conflict' || provider === 'failed' || provider === 'reconnecting') return provider;
  if (statusKnown && !transportConnected) return 'reconnecting';
  return undefined;
}

/** A failed refresh can end the loading state without hiding a cached or already-read transcript. */
export function transcriptLoadView(loaded: boolean, history: NativeHistoryLoadState): TranscriptLoadView {
  if (loaded) return 'content';
  return history.state === 'error' ? 'error' : 'loading';
}
