import type { NativeInteraction } from '@contracts';

/** Under this much time left the countdown turns into a warning. */
export const EXPIRY_WARNING_MS = 2 * 60_000;

/** Refusals in the order Esc prefers them; a card without one of these ignores Esc. */
const DISMISS_ACTION_IDS = ['deny', 'decline', 'reject', 'cancel'];

export function dismissActionId(interaction: Pick<NativeInteraction, 'actions'>): string | undefined {
  return DISMISS_ACTION_IDS.find((id) => interaction.actions.some((action) => action.id === id));
}

/** `1`–`9` map to the zero-based position of an option; every other key maps to nothing. */
export function shortcutIndex(key: string): number | undefined {
  return /^[1-9]$/.test(key) ? Number(key) - 1 : undefined;
}

/** Milliseconds until `expiresAt`, or undefined when the interaction carries no usable deadline. */
export function remainingMs(expiresAt: string | undefined, now: number): number | undefined {
  if (!expiresAt) return undefined;
  const deadline = Date.parse(expiresAt);
  return Number.isFinite(deadline) ? deadline - now : undefined;
}

export function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
