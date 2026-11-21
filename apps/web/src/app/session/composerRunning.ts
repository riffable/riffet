import { SETTING_DEFAULTS, type NativeTurnTarget } from '@contracts';

export type ComposerRunningBehavior = 'queue' | 'steer';

export const readComposerRunningBehavior = (value: unknown): ComposerRunningBehavior => value === 'steer' || value === 'queue' ? value : SETTING_DEFAULTS.composerRunningBehavior;

/** Choose once before submission. A rejected or unknown steer must never become a queued send. */
export function composerRunningIntent(preference: unknown, state: {
  running: boolean;
  supportsSteer?: boolean;
  activeTurn?: NativeTurnTarget;
  writable: boolean;
  blocked: boolean;
  uncertain: boolean;
}): ComposerRunningBehavior {
  return readComposerRunningBehavior(preference) === 'steer' && state.running ? 'steer' : 'queue';
}
