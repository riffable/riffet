import { flushSync } from 'react-dom';

/** A settings level is either a section id or the mobile list that owns every section. */
export type SettingsLevel = string;

/** The mobile list is a level of its own: list → section is a push, section → list is a pop. */
export const SETTINGS_LIST_LEVEL = 'list';

export type SettingsTransitionKind = 'none' | 'fade' | 'push' | 'pop';

export interface SettingsTransitionInput {
  from: SettingsLevel;
  to: SettingsLevel;
  mobile: boolean;
  reducedMotion: boolean;
  supported: boolean;
}

export interface SettingsTransitionRequest {
  from: SettingsLevel;
  to: SettingsLevel;
  mobile: boolean;
}

/**
 * Decide how a settings navigation should read. A sibling section change is not a spatial move, so
 * it gets a light non-directional fade; only the mobile list ↔ section change is directional.
 * Reduced motion keeps the level change but drops the movement, leaving opacity alone.
 */
export function settingsTransition({ from, to, mobile, reducedMotion, supported }: SettingsTransitionInput): SettingsTransitionKind {
  if (!supported || from === to) return 'none';
  if (!mobile || (from !== SETTINGS_LIST_LEVEL && to !== SETTINGS_LIST_LEVEL)) return 'fade';
  if (reducedMotion) return 'fade';
  return from === SETTINGS_LIST_LEVEL ? 'push' : 'pop';
}

export function viewTransitionsSupported(): boolean {
  return typeof document !== 'undefined' && typeof document.startViewTransition === 'function';
}

let transitionSequence = 0;
let activeSettingsTransition: ViewTransition | undefined;

/** Closing the dialog must remove its section snapshots before the dialog itself animates out. */
export function cancelSettingsTransition(): void {
  if (!activeSettingsTransition) return;
  activeSettingsTransition.skipTransition();
  activeSettingsTransition = undefined;
  transitionSequence += 1;
  delete document.documentElement.dataset.settingsTransition;
}

export async function runSettingsTransition({ from, to, mobile }: SettingsTransitionRequest, update: () => void): Promise<void> {
  cancelSettingsTransition();
  const kind = settingsTransition({
    from,
    to,
    mobile,
    reducedMotion: typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    supported: viewTransitionsSupported(),
  });
  if (kind === 'none') { update(); return; }

  const root = document.documentElement;
  root.dataset.settingsTransition = kind;
  const sequence = ++transitionSequence;
  const transition = document.startViewTransition(() => {
    // This callback runs outside React's scheduler and the browser snapshots the DOM right after it
    // returns, so the state update must be committed synchronously rather than on a later flush.
    flushSync(update);
  });
  activeSettingsTransition = transition;
  const release = () => {
    // A newer navigation owns the attribute by now; only the latest transition may clear it.
    if (sequence === transitionSequence) {
      activeSettingsTransition = undefined;
      delete root.dataset.settingsTransition;
    }
  };
  // Skipping before snapshots are ready rejects `ready`, without canceling the state update.
  transition.ready.catch(() => {});
  // `finished` rejects when a transition is skipped; either outcome ends this attribute's lifetime.
  transition.finished.then(release, release);
  // Navigation can accept the next Back only after the new level has actually committed.
  // Waiting for the entire animation would unnecessarily block input after that commit.
  await transition.updateCallbackDone;
}
