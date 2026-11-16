import { AppError } from '../../errors.js';
import type { NativeStopRequest, NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { claudeAgentRows, claudeBackgroundScreen, claudeComposer, claudeComposerHoldsPrompt, claudeComposerText, claudeComposerVisible, claudeDialogClosable, claudeFooterFocused, claudeTasksEntryFocused, claudeTasksEntryShown, claudeViewsSubagent } from '../../adapters/cli/claude-code.js';
import type { TerminalInteractionControl } from '../../terminal/service.js';
import { waitFor } from '../shared/wait-for.js';
import type { NativeBackendHost } from '../types.js';
import { pause } from './launch.js';
import { parseClaudeScreenDialog, parseClaudeScreenQuestion } from './screen-dialog.js';

const MAX_WIPE_ROUNDS = 12;
const INTERACTION_RETRY_MS = 4_000;

/**
 * How long the composer is polled for the paste before Enter is pressed regardless. A multi-line
 * paste shows up as a placeholder within a few hundred milliseconds; single lines are immediate.
 */
const SUBMIT_VISIBLE_TIMEOUT_MS = 2_000;
/** Poll spacing while waiting for the paste to appear. */
const SUBMIT_POLL_MS = 60;
/** How many tasks one stop works through the CLI's "Background" list. */
const MAX_BACKGROUND_STOPS = 12;
/** Footer key presses allowed beyond one per agent row: the background tasks entry, entering and leaving the list. */
const MAX_FOOTER_STEPS = 4;
/** How long the TUI is given to redraw after one footer key. */
export const FOOTER_KEY_MS = 350;

export interface PendingSend {
  commandId: string;
  runId: string;
  /** What was typed into the CLI, which its prompt hook echoes back. */
  text: string;
  /** What its transcript shows for it: a skill-led rewrite is stored as the user's own text. */
  echo: string;
  /** The user sent a slash command, which the CLI answers in its own pane rather than as a turn. */
  command: boolean;
  promptId?: string;
  promptSeen: boolean;
  /** The transcript row matched to this send; a second row never is. */
  claimedRow?: string;
  /** The write fence is committed: any prompt the CLI submits from here on may be this one. */
  fenced: boolean;
  /** When Enter was last about to be pressed for it: from here the CLI may start the prompt at any moment. */
  submittedAt?: number;
  /** A stop was asked for while the outcome of this send was unknown; if it starts a turn, that turn is stopped. */
  stopRequested?: boolean;
  /** The CLI queued it (a `queue-operation` enqueue): it holds the text, and a prompt row follows when it takes it. */
  queued?: boolean;
  /** A `/compact`: since 2.1.322 it writes no row until its boundary, so its manual PreCompact hook is the receipt. */
  compact?: boolean;
  /** That hook was heard after the fence: the CLI took the command, and the boundary rows confirm the run later. */
  compactionStarted?: boolean;
  /** Ends the receipt wait early; set while `awaitReceipt` is waiting. */
  receiptWake?: () => void;
  /** A stop preempts waiting for delivery; it does not assert that the CLI stopped. */
  interruptRequested?: boolean;
  baselineUserIds: Set<string>;
  resolveReceipt: (event: NativeWorkbenchEvent) => void;
  rejectReceipt: (error: Error) => void;
  receipt: Promise<NativeWorkbenchEvent>;
  receiptSettled: boolean;
}

export interface ScreenAnswer { text: string; choice: number }

export function checkSendInterrupt(pending: PendingSend): void {
  if (!pending.interruptRequested) return;
  throw new AppError('NATIVE_SEND_UNCONFIRMED', 'Claude delivery confirmation was interrupted by a stop request', 409);
}

export class ComposerDriver {
  constructor(private readonly deps: {
    terminal: NativeBackendHost['terminal'];
    sessionId(): string;
    assertExpectedStop(stop: NativeStopRequest, terminalId: string, allowEnded?: boolean): Promise<void>;
  }) {}

  /**
   * Point the composer back at the main agent and give it the keyboard.
   *
   * Only the footer list's own navigation is used: Down walks from the composer
   * over the background tasks entry into the list, whose first row is `main`; Enter there leaves the
   * agent view; Up hands the keyboard back to the composer, since the footer would otherwise take the
   * Enter that submits the paste. Esc in an agent view stops that agent while it runs, and Ctrl-C also
   * interrupts the main turn, so neither is pressed. A screen that does not end up there is refused
   * before anything is written.
   */
  async focusMainComposer(control: TerminalInteractionControl, screen: string): Promise<string> {
    const refuse = () => new AppError('CLI_BUSY', 'Claude Code is showing a background agent and could not be switched back to the main agent', 409);
    const press = async (key: string) => {
      await control.keys([key]);
      await pause(FOOTER_KEY_MS);
      const next = await control.screen();
      if (next === undefined) throw refuse();
      return next;
    };
    const limit = claudeAgentRows(screen).length + MAX_FOOTER_STEPS;
    if (claudeViewsSubagent(screen)) {
      for (let step = 0; !claudeAgentRows(screen).some(row => row.name === 'main' && row.selected); step += 1) {
        if (step >= limit) throw refuse();
        // A list cursor below `main` climbs to it; from the composer or the tasks entry the list is further down.
        screen = await press(claudeAgentRows(screen).some(row => row.selected) ? 'Up' : 'Down');
      }
      screen = await press('Enter');
      if (claudeViewsSubagent(screen)) throw refuse();
    }
    for (let step = 0; claudeFooterFocused(screen); step += 1) {
      if (step >= limit) throw refuse();
      screen = await press('Up');
    }
    if (!claudeComposerVisible(screen)) throw refuse();
    return screen;
  }

  /**
   * Press Enter once the composer actually shows the write.
   *
   * `TerminalService.paste(text, true)` presses Enter 80 ms after the write, which is too early for
   * anything but a single line: Claude collapses a multi-line paste into `[Pasted text #N +M lines]`
   * *asynchronously* — measured at ~0.2–0.4 s on 2.1.252 — and the box is still empty when that
   * Enter arrives, so it lands nowhere and the message simply stays in the composer. Every message
   * with an attachment goes through that shape, because the rendered prompt carries the file paths on
   * lines of their own; the text-only messages that did arrive were all single-line.
   *
   * So the paste is written without submitting, the screen is polled until the box holds it, and the
   * Enter is pressed here. If the box never shows it, a version whose box was captured (`boxVerified`) had
   * the paste taken by some other surface, where Enter would act instead, so none is pressed; on any other
   * version the box may just be drawn differently, so Enter is pressed on the bound and `awaitReceipt`
   * judges what happened.
   */
  async submitPaste(control: TerminalInteractionControl, text: string, before: string | undefined, boxVerified: boolean, pending: PendingSend): Promise<boolean> {
    let changed = false;
    let stopped: unknown;
    const shown = !text || await waitFor(async () => {
      try { checkSendInterrupt(pending); } catch (error) { stopped = error; return true; }
      const screen = await control.screen().catch(() => undefined);
      if (screen === undefined) return undefined;
      // "Changed *and* holds it": a composer that still shows what it showed before the paste — an
      // earlier failed send's placeholder, a draft the reader left there — is not evidence that
      // this write has been read yet, and pressing Enter mid-paste is what loses the press.
      const box = claudeComposer(screen);
      changed = box !== undefined && box !== before && claudeComposerText(screen) !== '';
      return changed && claudeComposerHoldsPrompt(screen, text) ? true : undefined;
    }, { timeoutMs: SUBMIT_VISIBLE_TIMEOUT_MS, intervalMs: SUBMIT_POLL_MS });
    if (stopped) throw stopped;
    // A box that took something but does not read as the message (an image path the CLI turned into `[Image #1]`,
    // the start of a message taller than the pane) has it all the same; only an unchanged box was passed by. On a
    // verified version that is either a paste some other surface took, where Enter would act instead, or one the CLI
    // is slow to draw (several image paths): no Enter yet, and `awaitReceipt` keeps reading the box.
    if (!shown && !changed && boxVerified) {
      console.warn('[claude] paste not shown within the window; handing over to the receipt wait', { sessionId: this.deps.sessionId(), windowMs: SUBMIT_VISIBLE_TIMEOUT_MS });
      return false;
    }
    checkSendInterrupt(pending);
    pending.submittedAt = Date.now();
    await control.keys(['Enter']);
    return true;
  }

  /**
   * Works the "Background" list: opens each task's details and stops it, until the list is empty. A key is pressed
   * only on a screen read as the box, the list or a task's page (`claudeBackgroundScreen`); anything else is left alone.
   */
  async stopBackgroundTasks(terminalId: string, expectedStop?: NativeStopRequest): Promise<void> {
    await this.interact(terminalId, async control => {
      const keys = async (value: string[]) => {
        if (expectedStop) await this.deps.assertExpectedStop(expectedStop, terminalId);
        await control.keys(value);
      };
      const refuse = (message: string) => new AppError('NATIVE_INTERRUPT_UNCONFIRMED', message, 409);
      let screen = await control.screen();
      const box = claudeComposerText(screen);
      if (box === undefined) throw refuse('Claude Code input box is not visible, so its background tasks cannot be stopped from here');
      // A panel stacked over the box has the keyboard: Down and Enter would work it instead.
      if (parseClaudeScreenDialog(screen ?? '')) throw refuse('Claude Code has a panel open over its input box; close it in the terminal first');
      if (!claudeTasksEntryShown(screen ?? '')) throw refuse('Claude Code does not show its background tasks entry');
      // Down and Enter would walk the agent list instead.
      if (claudeFooterFocused(screen ?? '') || claudeViewsSubagent(screen ?? '')) throw refuse('Claude Code is showing its agent list; switch its terminal back to the main agent');
      // Enter would submit whatever the box holds if the list did not take the key. The box may show the CLI's greyed
      // suggestion, which looks like text: a typed character replaces a suggestion and joins a draft, and is taken back either way.
      if (box !== '') {
        await keys(['x']);
        await pause(250);
        const typed = claudeComposerText(await control.screen());
        await keys(['BSpace']);
        await pause(250);
        if (typed !== 'x') throw refuse('The Claude Code input box is not empty; clear it in the terminal before stopping background tasks');
      }
      // Down reaches the tasks entry, unless a reader left the keyboard there already (where Down would open it);
      // with a single task, Enter there opens that task's page instead of the list.
      if (!claudeTasksEntryFocused(await control.screen({ styled: true }) ?? '')) {
        await keys(['Down']);
        await pause(350);
      }
      await keys(['Enter']);
      await pause(700);
      let view = claudeBackgroundScreen(screen = await control.screen());
      if (!view) throw refuse('Claude Code did not open its background task list');
      for (let round = 0, unread = 0; round < MAX_BACKGROUND_STOPS * 3 && view?.kind !== 'empty'; round += 1) {
        if (view?.kind === 'list') {
          // The list stops the task it has selected; when that does not shrink it, the task's own page does.
          const count = view.active;
          await keys(['x']);
          await pause(1000);
          const after = claudeBackgroundScreen(await control.screen());
          if (after?.kind === 'list' && after.active === count) {
            await keys(['Enter']);
            await pause(600);
          }
        } else if (view?.kind === 'task') {
          await keys(['x']);
          await pause(900);
        } else {
          // Back at the box: the last task's page closed with it. Anything else is given a moment to redraw, then left.
          if (claudeComposerText(screen) !== undefined) return;
          if ((unread += 1) >= 3) {
            // Left open, the dialog would keep every later message out of the box.
            if (claudeDialogClosable(screen)) await keys(['Escape']);
            throw refuse('Claude Code showed a screen other than its background task list');
          }
          await pause(300);
        }
        view = claudeBackgroundScreen(screen = await control.screen());
        if (view) unread = 0;
      }
      if (view?.closable) { await keys(['Escape']); await pause(300); }
    });
  }

  /** A terminal transaction that waits out another operation's turn at the terminal, as a stop must not give up on one. */
  async interact<T>(terminalId: string, task: (control: TerminalInteractionControl) => Promise<T>): Promise<T> {
    const deadline = Date.now() + INTERACTION_RETRY_MS;
    for (;;) {
      try { return await this.deps.terminal.withInteraction(terminalId, task); }
      catch (error) {
        const retryable = error instanceof AppError && ['TERMINAL_INTERACTION_BUSY', 'TERMINAL_INTERACTION_STALE', 'TERMINAL_CONTROL_STALE', 'TERMINAL_DETACHED'].includes(error.code);
        if (!retryable || Date.now() >= deadline) throw error;
        await pause(80);
      }
    }
  }

  /**
   * Empty the input box of text for which `stillHolds` is true. Ctrl+U erases the visual line before the
   * cursor and Backspace joins the line above onto it, so a multi-line message takes a few rounds; each is
   * a separate write, as the TUI may consume only the first control character of a coalesced one.
   */
  async wipeComposer(control: TerminalInteractionControl, stillHolds: (screen: string) => boolean, beforeWrite?: () => Promise<void>): Promise<string | undefined> {
    for (let round = 0; round < MAX_WIPE_ROUNDS; round += 1) {
      const screen = await control.screen();
      if (screen === undefined || !stillHolds(screen)) return screen;
      await beforeWrite?.();
      await control.keys(['C-u']);
      await pause(50);
      await beforeWrite?.();
      await control.keys(['C-k']);
      await pause(50);
      await beforeWrite?.();
      await control.keys(['BSpace']);
      await pause(80);
    }
    return await control.screen();
  }

  /**
   * Drives the cursor of Claude Code's own question dialog and presses Enter. Every step is read back
   * from the screen: Enter is only sent once the cursor (and any typed text) is where the answer says,
   * so a dialog that moved on or a key that was lost never submits a different answer. Returns why
   * nothing was submitted, or nothing once Enter went out.
   */
  async answerScreenQuestion(control: { screen(): Promise<string | undefined>; keys(keys: string[]): Promise<void>; paste(text: string, submit: boolean): Promise<void> }, { text, choice }: ScreenAnswer): Promise<string | undefined> {
    const read = async () => parseClaudeScreenQuestion(await control.screen() ?? '');
    const question = await read();
    if (!question) return 'Claude Code’s question is no longer on screen. Nothing was submitted; sync the state.';
    const target = text ? question.options.length : choice;
    const move = async (from: number): Promise<number | undefined> => {
      if (from === target) return from;
      await control.keys(Array.from({ length: Math.abs(target - from) }, () => target > from ? 'Down' : 'Up'));
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolvePause => setTimeout(resolvePause, 60));
        const next = await read();
        if (next?.focus === target) return target;
      }
      return undefined;
    };
    if (await move(question.focus) === undefined) return 'Claude Code’s question cursor did not move as expected. Nothing was submitted; open the terminal or try again.';
    if (text) {
      if (question.typed !== text) await control.paste(text, false);
      let typed = false;
      for (let attempt = 0; attempt < 20 && !typed; attempt++) {
        await new Promise(resolvePause => setTimeout(resolvePause, 60));
        const shown = (await read())?.typed;
        typed = shown !== undefined && text.startsWith(shown);
      }
      if (!typed) return 'Claude Code did not show the typed answer. Nothing was submitted; open the terminal or try again.';
    }
    await control.keys(['Enter']);
    return undefined;
  }
}
