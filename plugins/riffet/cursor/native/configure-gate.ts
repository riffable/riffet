import type { ApprovalMode, NativeStatus } from '@contracts';
import { AppError } from '@riffet/plugin-api/kit';

/**
 * The approval mode the CLI's footer names. It prints nothing for its default allowlist, so a
 * painted footer without a permission leaves that as the answer; an unknown label means the CLI
 * grew a mode we do not know, which is reported as "not recognised" rather than as allowlist.
 */
export function approvalFromFooter(permission: string | undefined): ApprovalMode | undefined {
  if (!permission) return 'allowlist';
  if (/auto.?review/i.test(permission)) return 'auto-review';
  if (/run everything|unrestricted|yolo/i.test(permission)) return 'unrestricted';
  return undefined;
}

/**
 * The approval mode this tick is allowed to write back into the session record.
 *
 * A footer painted by *this* screen is an observation of the CLI; anything else is a cache.
 * `updateStatus` falls back to the previous status while the CLI boots or a dialog covers the
 * footer so the browser does not blink — but that cached value also survives a restart (which
 * drops chat, transcript and booted state, not status), and persisting it would resurrect the
 * pre-switch intent on top of the mode the restart just launched with. An unknown footer label is
 * no observation either, so it stays "unrecognised" instead of being adopted.
 */
export function adoptableApproval(footer: boolean, permission: string | undefined): ApprovalMode | undefined {
  return footer ? approvalFromFooter(permission) : undefined;
}

/**
 * Why a configure request may not restart the CLI, or `proceed` when it may.
 * `unreadable` is its own verdict because no screen answered at all, which is ignorance rather
 * than an observation of a dialog.
 */
export type ConfigureVerdict = 'proceed' | 'busy' | 'attention' | 'starting' | 'unreadable';

/**
 * Whether switching model/mode/approval may restart the CLI right now.
 *
 * The in-memory phase is what a watch last read off the pane, so it is believed whenever it knows
 * something. `offline` is ignorance — no watch was ever created, or its first tick has not finished
 * — and reading it as "idle" is what let a switch stop the CLI mid-turn and relaunch it without the
 * permission the user had set in the TUI. Only the screen can break that tie, and a screen nobody
 * could read counts as busy: a refused switch is retryable, a killed turn is not.
 *
 * `screenPhase` is a parsed footer phase, with `starting` standing for a pane that has not painted
 * its footer yet (booting, or the resume picker); it is ignored unless the memory is blank.
 */
export function configureGate(input: { phase: NativeStatus['phase']; screenPhase?: NativeStatus['phase'] }): ConfigureVerdict {
  const { phase, screenPhase } = input;
  if (phase === 'busy' || phase === 'attention' || phase === 'starting') return phase;
  if (phase !== 'offline') return 'proceed';
  if (screenPhase === 'idle') return 'proceed';
  if (screenPhase === 'busy') return 'busy';
  if (screenPhase === 'starting') return 'starting';
  // An `attention` footer (a dialog owns the pane) and an unreadable screen both mean "hands off".
  return screenPhase === 'attention' ? 'attention' : 'unreadable';
}

/** The refusal a `configureGate` verdict stands for. Kept apart so the gate stays a pure predicate. */
export function configureRefusal(verdict: Exclude<ConfigureVerdict, 'proceed'>): AppError {
  if (verdict === 'busy') return new AppError('CLI_BUSY', 'Cursor is still processing the current turn; switch after it finishes', 409);
  if (verdict === 'attention') return new AppError('CLI_NEEDS_ATTENTION', 'Cursor is waiting for you in the terminal; handle that before switching', 409);
  if (verdict === 'starting') return new AppError('CLI_BUSY', 'Cursor has not shown its prompt yet; switch once it is ready', 409);
  return new AppError('CLI_NEEDS_ATTENTION', 'Could not read the Cursor terminal, so it may not be idle; the switch was skipped to avoid interrupting', 409);
}
