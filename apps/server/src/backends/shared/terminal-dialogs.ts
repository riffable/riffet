import type {
  NativeInteraction, NativeInteractionResponse, NativeInteractionResult, NativeStatus, Session,
} from '../../../../../packages/contracts/src/index.js';
import { NativeInteractions, type NativeInteractionGuard } from '../../agent-host/interactions.js';
import type { TerminalService } from '../../terminal/service.js';

/**
 * Terminal dialogs for sessions whose driver owns the conversation.
 *
 * Cursor's driver parses its own screen. Claude Code and Codex are protocol-first, yet each still
 * draws blocking screens that no protocol request describes — startup trust, hook review, plan
 * approval — and the workbench runs their real TUI. This observer reads those terminals, lifts a
 * recognized dialog into the same interaction shape the web already renders, and answers it by
 * driving the CLI's own keys.
 *
 * A protocol interaction always wins: this only fills the gap where the driver reports none.
 */

/**
 * Reading a screen is one `tmux capture-pane`, and a dialog can appear while the driver is quiet,
 * so the pump is steady rather than event-driven. It only runs while a browser is subscribed.
 */
const POLL_MS = 1500;

export class TerminalDialogObserver {
  private readonly interactions: NativeInteractions;
  private readonly dialogs = new Map<string, NativeInteraction>();
  private readonly pumps = new Map<string, NodeJS.Timeout>();

  /**
   * `endorses` lets a driver refuse a dialog it has no reason to believe is blocking its CLI: a menu
   * recognized by shape alone is also what a suggestion or a quoted option list looks like, and a card
   * for one that is not waiting can never be answered.
   */
  constructor(private readonly terminal: TerminalService, private readonly endorses?: (session: Session, dialog: NativeInteraction) => boolean) {
    this.interactions = new NativeInteractions(terminal);
  }

  /** A remembered dialog is only current while its driver still endorses it. */
  current(session: Session): NativeInteraction | undefined {
    return this.cachedDialog(session);
  }

  ownsInteraction(id: string): boolean { return this.interactions.ownsInteraction(id); }

  replay(session: Session, response: NativeInteractionResponse): Promise<NativeInteractionResult> | undefined {
    return this.interactions.replay(session, response);
  }

  /**
   * Read the session's terminal once and remember what it shows. An unreadable screen keeps the
   * previous answer: a capture that failed is not evidence that the dialog went away.
   */
  async refresh(session: Session): Promise<NativeInteraction | undefined> {
    if (!session.terminalId || session.archivedAt) { this.dialogs.delete(session.id); return undefined; }
    const info = await this.terminal.get(session.terminalId).catch(() => undefined);
    // A failed lookup is not evidence either: only a terminal that is known to be gone drops the
    // dialog, so a transient error cannot flicker a live card away mid-answer.
    if (!info) return this.cachedDialog(session);
    if (info.state !== 'running') { this.dialogs.delete(session.id); return undefined; }
    const screen = await this.terminal.screen(info.id).catch(() => undefined);
    if (screen === undefined) return this.cachedDialog(session);
    const observed = this.interactions.observe(screen, info)?.interaction;
    const dialog = observed && (this.endorses?.(session, observed) ?? true) ? observed : undefined;
    if (dialog) this.dialogs.set(session.id, dialog);
    else this.dialogs.delete(session.id);
    return dialog;
  }

  /** Put the remembered dialog into a driver status, unless the driver has one of its own. */
  merge(session: Session, status: NativeStatus): NativeStatus {
    if (status.interaction) return status;
    const dialog = this.cachedDialog(session);
    return dialog ? { ...status, phase: 'attention', interaction: dialog } : status;
  }

  /**
   * The cached dialog, if the driver still endorses it. A card can outlive the policy that endorsed
   * it: a driver may connect the app-server after the screen was read. Re-check before serving it,
   * so neither a status nor an unreadable-screen fallback can revive a card the driver no longer
   * wants.
   */
  private cachedDialog(session: Session): NativeInteraction | undefined {
    const dialog = this.dialogs.get(session.id);
    if (!dialog) return undefined;
    if (!session.terminalId || session.archivedAt || dialog.terminalId !== session.terminalId || !(this.endorses?.(session, dialog) ?? true)) {
      this.dialogs.delete(session.id);
      return undefined;
    }
    return dialog;
  }

  respond(session: Session, response: NativeInteractionResponse, guard?: NativeInteractionGuard): Promise<NativeInteractionResult> {
    return this.interactions.respond(session, response, guard);
  }

  /**
   * Keep reading one session while anyone is watching, and report every identity change so the
   * caller can republish its status. `read` is called per tick: a session's terminal binding can
   * be replaced while the pump runs.
   */
  watch(sessionId: string, read: () => Session, onChange: () => void): void {
    if (this.pumps.has(sessionId)) return;
    let reading = false;
    const tick = () => {
      // A slow capture must not stack up behind the interval.
      if (reading) return;
      reading = true;
      const previous = this.dialogs.get(sessionId)?.id;
      void this.refresh(read())
        .then(dialog => { if (previous !== dialog?.id) onChange(); })
        .catch(() => undefined)
        .finally(() => { reading = false; });
    };
    // Read once now: a page that opens onto an already-blocked CLI should not wait a full interval.
    tick();
    const timer = setInterval(tick, POLL_MS);
    // An idle workbench must still be able to exit while a pump is alive.
    timer.unref();
    this.pumps.set(sessionId, timer);
  }

  release(sessionId: string): void {
    const timer = this.pumps.get(sessionId);
    if (timer) { clearInterval(timer); this.pumps.delete(sessionId); }
    this.dialogs.delete(sessionId);
  }

  releaseAll(): void {
    for (const sessionId of [...this.pumps.keys()]) this.release(sessionId);
    this.dialogs.clear();
  }
}
