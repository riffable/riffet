import type { NativeInteraction, NativeInteractionResponse, NativeInteractionResult, NativeStatus, NativeTurnTarget, Run, Session } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { isLiveActivity } from '../../journal/activity.js';
import { DORMANT_POLL_MS, DormancyClock } from '../shared/dormancy.js';
import type { NativeBackendHost, NativeControlMessage } from '../types.js';
import { CLAUDE_CODE_BUSY_PATTERN, claudeAgentRows, claudeComposerText, claudeComposerVisible, claudeFooterFocused, claudeTasksEntryShown, claudeViewsSubagent } from '../../adapters/cli/claude-code.js';
import { ClaudeTranscript } from './history.js';
import { ClaudeTranscriptSource } from './transcript-source.js';
import { claudeScreenInteraction, isClaudeScreenInteraction, parseClaudeScreenDialog } from './screen-dialog.js';
import { parseDialog } from '../../agent-host/interaction-screen.js';
import { type ClaudeSessionState, type ClaudeSignal, type Transition } from './session-state.js';
import { pause, screenDialogEndorsed } from './launch.js';
import { ComposerDriver, FOOTER_KEY_MS, type ScreenAnswer } from './composer.js';
import { ClaudeInteractions } from './interactions.js';
import { ClaudeSends } from './sends.js';
import { ClaudeStops } from './stops.js';
import { ClaudeTerminalBinding } from './binding.js';
import { ClaudeTranscriptReads } from './transcript-reads.js';

/** Rows a notice form's cursor may cross to reach its Continue row; the auto-mode setup form has four. */
const CONFIRM_ROW_STEPS = 12;

/** Transcript and screen polls while somebody watches the session or a turn is open. */
const TRANSCRIPT_POLL_MS = 300;

const SCREEN_POLL_MS = 750;

/**
 * Claude Code draws its own dialog beside a held hook and closes it once the hook answers. A dialog still
 * (or again) on screen this long after an answer was delivered is the CLI asking again (see `refreshScreenState`).
 */
const REPROMPT_SETTLE_MS = 2_000;

/**
 * How long after a question's PreToolUse its screen dialog waits for the PermissionRequest hook (2.1.302: 1–1.7 s
 * apart) before it is taken as a question no hook will bring, and lifted from the screen.
 */
const QUESTION_HOOK_GRACE_MS = 5_000;

/**
 * How long the screen has to keep showing no background work (no footer tasks entry, no agent rows, no spinner)
 * before the background work the records still count is dropped, and the fewest reads that make that span.
 */
const BACKGROUND_SCREEN_SETTLE_MS = 5_000;

const BACKGROUND_SCREEN_MIN_READS = 2;

function screenAnswer(question: NativeInteraction, response: NativeInteractionResponse): ScreenAnswer {
  const text = (response.otherText ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  const choice = response.selectedIds?.length === 1 ? question.options.findIndex(option => option.id === response.selectedIds![0]) : -1;
  if (!text && choice < 0) throw new AppError('INVALID_NATIVE_INTERACTION', 'Choose one option or enter an answer for this Claude Code question');
  return { text, choice };
}

/** What the group takes from `ClaudeSessionRuntime`: values read on demand and callbacks, never the runtime itself. */
export interface ClaudeScreenWatchDeps {
  binding: ClaudeTerminalBinding;
  composer: ComposerDriver;
  host: NativeBackendHost;
  interactions: ClaudeInteractions;
  listeners: Set<(message: NativeControlMessage) => void>;
  nativeSessionId: string;
  reads: ClaudeTranscriptReads;
  sends: ClaudeSends;
  stops: ClaudeStops;
  transcript: ClaudeTranscript;
  disposed(): boolean;
  monitorStarted(): boolean;
  nativeTurn(): NativeTurnTarget & { ownerRunId?: string } | undefined;
  screenAttention(): boolean;
  session(): Session;
  state(): ClaudeSessionState;
  status(): NativeStatus;
  checkSilence(): void;
  dispatchSignal(signal: ClaudeSignal, status?: Omit<NativeStatus, 'phase'>): Transition;
  idleForRelaunch(): boolean;
  screenConvergenceSupported(): Promise<boolean>;
  setScreenAttention(shown: boolean): void;
  setStatus(requested: Omit<NativeStatus, 'phase'>): void;
}

/** Polling and the screen: how often to look, the dialogs the CLI draws itself, and holding the records against an idle screen. */
export class ClaudeScreenWatch {
  private pollTimer?: NodeJS.Timeout;
  private terminalPollTimer?: NodeJS.Timeout;
  private pollDormant?: boolean;
  /** Both polls slow to `DORMANT_POLL_MS` once idle and unwatched; a new subscriber or a hook brings them back at once. */
  private readonly dormancy = new DormancyClock();
  screenDialogTask?: Promise<void>;
  /** AskUserQuestion calls announced by PreToolUse whose PermissionRequest has not arrived yet, with when they were announced. */
  private readonly questionHooksDue = new Map<string, number>();
  /** Since when consecutive screen reads show no background work while the records still count some. */
  private backgroundScreen?: { since: number; reads: number };

  constructor(private readonly deps: ClaudeScreenWatchDeps) {}

  /**
   * Poll at full rate only while it can matter to somebody: a listener is attached, or a turn,
   * submission or dialog is open, or was within the last half minute. Past that an idle session is
   * polled every few seconds — enough to pick up a turn Claude starts on its own — and back at full
   * rate as soon as either changes.
   */
  schedulePolling(): void {
    if (this.deps.disposed() || !this.deps.monitorStarted()) return;
    const quiet = this.deps.state().mainTurn.kind === 'idle' && this.deps.state().background.length === 0 && this.deps.state().cliQueue.length === 0;
    const dormant = this.dormancy.dormant(this.deps.listeners.size > 0 || !quiet || !!this.deps.sends.activeWebTurn || !!this.deps.nativeTurn() || !!this.deps.sends.pendingSend || this.deps.sends.queuedSends.length > 0 || this.deps.interactions.hasPending());
    const changed = dormant !== this.pollDormant;
    const waking = this.pollDormant === true && !dormant;
    this.pollDormant = dormant;
    if (!changed && this.pollTimer) return;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.terminalPollTimer) clearInterval(this.terminalPollTimer);
    this.pollTimer = setInterval(() => { void this.deps.reads.refreshTranscript(false).catch(() => undefined); }, dormant ? DORMANT_POLL_MS : TRANSCRIPT_POLL_MS);
    this.pollTimer.unref?.();
    // A tick that fails (the conversation deleted while its runtime is being closed) is the next tick's to retry.
    this.terminalPollTimer = setInterval(() => {
      void this.deps.binding.refreshTerminalStatus().catch(() => undefined);
      // An idle conversation nobody watches shows nothing new on its screen; a turn, a hook or a client wakes it.
      if (!this.pollDormant) void this.refreshScreenState().catch(() => undefined);
      // A pick recorded through another route (tools, extensions) shows or drops its waiting notice from here
      // (`runtime.ts#relaunchControl`); only a conversation with background work can have one.
      void this.deps.binding.applyPendingConfig().catch(() => undefined).finally(() => {
        if (!this.deps.disposed() && (this.deps.state().background.length || this.deps.status().runtimeControl)) this.deps.setStatus({ ...this.deps.status() });
      });
      this.deps.checkSilence();
      this.schedulePolling();
    }, dormant ? DORMANT_POLL_MS : SCREEN_POLL_MS);
    this.terminalPollTimer.unref?.();
    // Whatever happened while polls were sparse is read now rather than at the next tick.
    if (waking) { void this.deps.reads.refreshTranscript().catch(() => undefined); void this.refreshScreenState(); }
  }

  /** Whether a dialog the screen shows is one this CLI is known to wait on (see `screenDialogEndorsed`). */
  endorsesDialog(dialog: NativeInteraction): boolean {
    const now = Date.now();
    for (const [toolUseId, at] of this.questionHooksDue) if (now - at >= QUESTION_HOOK_GRACE_MS) this.questionHooksDue.delete(toolUseId);
    return screenDialogEndorsed(dialog, {
      held: this.deps.interactions.hasPending(), turnOpen: this.deps.state().mainTurn.kind !== 'idle', open: this.deps.transcript.openToolUses(), questionHookDue: this.questionHooksDue.size > 0,
    });
  }

  /**
   * A hook held open for a person owns the screen, over the dialog the CLI draws for the same request.
   * One whose answer was delivered no longer does: the CLI may ask again in its own dialog.
   */
  private screenHeld(): boolean {
    const shown = this.deps.status().interaction;
    return this.deps.interactions.hasUndelivered()
      || (shown?.transport === 'protocol' && !this.deps.interactions.hasDelivered(shown.id));
  }

  /** Passive safety check: neither acquiring an observer nor reading the composer submits input. */
  async canReleaseInput(run: Run): Promise<boolean> {
    await this.deps.binding.refreshTerminalStatus(true);
    await this.deps.reads.refreshTranscript();
    if (!this.deps.host.transcript) return false;
    await this.deps.host.transcript.drain(this.deps.session().id);
    const open = await this.deps.host.transcript.withSource(this.deps.session().id, (source, writer) =>
      source instanceof ClaudeTranscriptSource && (writer.scratch ?? writer).cursor !== null ? source.activeTurn(writer) !== undefined : true);
    if (open !== false) return false;
    const current = this.deps.host.getSession(this.deps.session().id);
    const terminalId = this.deps.binding.terminalId;
    const binding = run.native;
    if (this.deps.disposed() || this.deps.binding.terminalExited || !terminalId || !binding
      || current.nativeSessionId !== this.deps.nativeSessionId || binding.nativeSessionId !== this.deps.nativeSessionId
      || current.terminalId !== terminalId || binding.terminalId !== terminalId
      || this.deps.transcript.state !== 'ok' || !this.deps.idleForRelaunch() || this.deps.interactions.hasPending() || this.deps.sends.pendingSend || this.deps.stops.interrupting || this.deps.stops.stopping
      || this.deps.transcript.activities().some(isLiveActivity)) return false;
    // The epoch the send was bound to is not asked for: every reader who opens the terminal to look moves it, which is
    // what an unconfirmed send asks them to do. What is proven here is the terminal now, so it only has to hold still.
    const terminal = await this.deps.host.terminal.get(terminalId).catch(() => undefined);
    if (!terminal || terminal.kind !== 'native' || terminal.sessionId !== current.id || terminal.projectId !== current.projectId
      || terminal.state === 'exited') return false;
    const screen = await this.deps.host.terminal.screen(terminalId).catch(() => undefined);
    if (!screen || CLAUDE_CODE_BUSY_PATTERN.test(screen) || claudeViewsSubagent(screen) || claudeFooterFocused(screen) || claudeTasksEntryShown(screen)
      || !claudeComposerVisible(screen) || claudeComposerText(screen) !== '') return false;
    const checked = await this.deps.host.terminal.get(terminalId).catch(() => undefined);
    if (!checked || checked.epoch !== terminal.epoch || checked.state === 'exited' || checked.kind !== 'native'
      || checked.sessionId !== current.id || checked.projectId !== current.projectId) return false;
    const latest = this.deps.host.getSession(this.deps.session().id);
    return !this.deps.disposed() && !this.deps.binding.terminalExited && this.deps.idleForRelaunch() && !this.deps.sends.pendingSend && !this.deps.interactions.hasPending()
      && latest.terminalId === terminalId && latest.nativeSessionId === this.deps.nativeSessionId;
  }

  /**
   * The screen speaks only for what no record or hook can: a dialog the CLI drew itself (a notice, a
   * question it asks in the terminal), and whether a launch has drawn its input box yet. It never
   * decides whether a turn is running — that is the transcript's and the hooks'.
   */
  async refreshScreenState(): Promise<void> {
    if (this.deps.disposed() || !this.deps.binding.terminalId || this.screenDialogTask || this.deps.state().process === 'exited') return;
    if (this.screenHeld()) return;
    const terminalId = this.deps.binding.terminalId;
    const sessionId = this.deps.nativeSessionId;
    const current = () => !this.deps.disposed() && !this.deps.binding.terminalExited && terminalId === this.deps.binding.terminalId
      && sessionId === this.deps.nativeSessionId && !this.screenHeld();
    const task = (async () => {
      const terminal = await this.deps.host.terminal.get(terminalId).catch(() => undefined);
      if (!terminal || terminal.state === 'exited' || !current()) return;
      const screen = await this.deps.host.terminal.screen(terminalId).catch(() => undefined);
      if (!current() || screen === undefined) return;
      void this.convergeBackground(screen).catch(() => undefined);
      const drawn = claudeScreenInteraction(screen, terminal);
      // A dialog the shared terminal observer lifts and answers (see `claudeScreenInteraction`): the
      // session waits on it, and the card comes from the observer alone.
      const shape = drawn ? undefined : parseDialog(screen, terminal);
      const delivered = this.deps.interactions.delivered();
      if ((drawn || shape) && delivered.length) {
        // The dialog drawn while the hook was held may take a moment to close; past that it is the CLI asking
        // again, which the delivered answer can no longer settle and only the screen can answer.
        if (delivered.some(item => Date.now() - item.candidate!.deliveredAt < REPROMPT_SETTLE_MS)) return;
        for (const item of delivered) this.deps.interactions.confirmProviderInteraction(item, 'Claude Code asked again in its terminal dialog.', 'uncertain');
      }
      const interaction = drawn && this.endorsesDialog(drawn) ? drawn : undefined;
      const observed = shape !== undefined && this.endorsesDialog(shape.interaction);
      if (interaction || observed) {
        this.deps.setScreenAttention(true);
        this.deps.setStatus({ ...this.deps.status(), interaction: interaction ?? (isClaudeScreenInteraction(this.deps.status().interaction) ? undefined : this.deps.status().interaction) });
        return;
      }
      const cleared = this.deps.screenAttention();
      this.deps.setScreenAttention(false);
      // A launched Claude whose SessionStart hook never came (it is lost, late, or of a source we did
      // not expect) would sit on `starting` for good: `send()` refuses it, and the cold-terminal
      // refresh stops once the launch is done. A drawn input box ends the wait.
      if (this.deps.state().process === 'starting' && this.deps.binding.started && claudeComposerVisible(screen)) {
        this.deps.dispatchSignal({ type: 'process', process: 'alive' }, { ...this.deps.status(), notice: undefined, noticeLevel: undefined, interaction: undefined });
        return;
      }
      if (cleared) this.deps.setStatus({ ...this.deps.status(), interaction: isClaudeScreenInteraction(this.deps.status().interaction) ? undefined : this.deps.status().interaction });
    })();
    this.screenDialogTask = task;
    try { await task; }
    finally { if (this.screenDialogTask === task) this.screenDialogTask = undefined; }
  }

  /**
   * State convergence with the screen (docs/DELIVERY.md, 状态收敛): what the records imply is held against what an idle
   * CLI draws, and a claim of pending work the screen has contradicted for `BACKGROUND_SCREEN_SETTLE_MS` of consecutive
   * reads is dropped. Only claims that hold the conversation busy are converged; the screen never makes it busy.
   *
   *   background  derived from the records alone, so one whose end they never show would hold the conversation for
   *               good. The footer draws a tasks entry for shells and monitors and a list of rows for agents
   *               (captured on 2.1.302 and 2.1.322); with neither drawn, those entries are over. Workflows are not
   *               drawn there by any capture, so they are left to the records.
   *   cliQueue    the CLI's own queue, kept from `queue-operation` rows. A `dequeue` row does not name what it took,
   *               and the CLI does not take strictly in order, so one wrong guess leaves an entry that is never
   *               removed. An idle CLI runs whatever it holds at once, so an idle main turn with a queue is not a state.
   */
  async convergeBackground(screen: string): Promise<void> {
    const entries = this.deps.state().background.filter(task => task.kind !== 'workflow');
    const queued = this.deps.state().cliQueue.length;
    // A screen showing an agent's view or with the footer focused draws the footer differently; it proves nothing.
    const idleScreen = claudeComposerVisible(screen) && !CLAUDE_CODE_BUSY_PATTERN.test(screen) && !claudeViewsSubagent(screen) && !claudeFooterFocused(screen);
    const showsBackground = claudeTasksEntryShown(screen) || claudeAgentRows(screen).length > 0;
    const background = !showsBackground ? entries : [];
    // Nothing of the conversation is in motion: what the screen showed can be held against the records.
    const settled = () => this.deps.state().process === 'alive' && this.deps.state().mainTurn.kind === 'idle' && !this.deps.sends.pendingSend
      && this.deps.sends.queuedSends.length === 0 && !this.deps.interactions.hasPending() && this.deps.status().interaction === undefined && !this.deps.screenAttention() && !this.deps.stops.interrupting && !this.deps.stops.stopping;
    if ((!background.length && !queued) || !idleScreen || !settled()) {
      this.backgroundScreen = undefined;
      return;
    }
    const now = Date.now();
    const seen = this.backgroundScreen ??= { since: now, reads: 0 };
    seen.reads += 1;
    if (seen.reads < BACKGROUND_SCREEN_MIN_READS || now - seen.since < BACKGROUND_SCREEN_SETTLE_MS) return;
    this.backgroundScreen = undefined;
    if (!await this.deps.screenConvergenceSupported()) return;
    // The version probe can take a while: a stop, a dialog or a send that began meanwhile makes the screen read stale.
    if (!settled() || this.deps.binding.terminalExited) return;
    if (this.deps.state().cliQueue.length) {
      console.warn('[claude] cli queue converged from screen', { sessionId: this.deps.session().id, entries: this.deps.state().cliQueue.map(entry => entry.kind) });
      this.deps.dispatchSignal({ type: 'queue', operation: 'clear' });
    }
    const current = this.deps.state().background.filter(task => background.some(entry => entry.toolUseId === task.toolUseId));
    if (!current.length) return;
    console.warn('[claude] background converged from screen', { sessionId: this.deps.session().id, tasks: current.map(task => `${task.kind ?? 'agent'}:${task.toolUseId}`) });
    for (const task of current) {
      this.deps.dispatchSignal({ type: 'background_done', toolUseId: task.toolUseId });
      for (const activity of this.deps.transcript.activities()) {
        if (isLiveActivity(activity) && (activity.toolCallId === task.toolUseId || activity.id === `claude:${task.agentId ?? task.taskId}`)) this.deps.reads.publishActivity({ ...activity, status: 'unknown' });
      }
    }
  }

  /** Any sign of life (a hook, a transcript row) ends dormancy now rather than at the next slow tick. */
  wakePolling(at: number): void {
    if (this.pollDormant) { this.dormancy.watched(at); this.schedulePolling(); }
  }

  /**
   * Answers a dialog Claude Code drew itself: a notice is passed with the key its footer names; its own
   * question is answered by moving the cursor to the chosen row (or the free-text row, which is typed
   * into) and pressing Enter.
   */
  async respondScreenDialog(response: NativeInteractionResponse, fingerprint: string): Promise<NativeInteractionResult> {
    const answering = response.action === 'answer';
    const terminalId = this.deps.binding.terminalId;
    if (!terminalId || this.deps.binding.terminalExited) throw new AppError('TERMINAL_NOT_RUNNING', 'Claude Code is not running', 409);
    const result = await this.deps.host.terminal.withInteraction(terminalId, async control => {
      const terminal = await this.deps.host.terminal.get(terminalId);
      const initialScreen = await control.screen() ?? '';
      const current = claudeScreenInteraction(initialScreen, terminal);
      if (current?.id !== response.interactionId || current.revision !== response.revision) {
        throw new AppError('NATIVE_INTERACTION_STALE', 'Claude Code’s notice changed. Sync the current request before answering.', 409);
      }
      if (this.deps.interactions.hasPending() || this.deps.status().interaction?.transport === 'protocol') {
        throw new AppError('NATIVE_INTERACTION_STALE', 'Claude is waiting on a protocol interaction. Sync the current request.', 409);
      }
      if (!current.actions.some(action => action.id === response.action)) {
        throw new AppError('INVALID_NATIVE_INTERACTION', 'This Claude Code dialog must be answered in the terminal');
      }
      const answer = answering ? screenAnswer(current, response) : undefined;
      const key = answering ? undefined : parseClaudeScreenDialog(initialScreen)?.actions.find(action => action.id === response.action)?.key;
      if (!answering && !key) throw new AppError('INVALID_NATIVE_INTERACTION', 'This Claude Code dialog must be answered in the terminal');
      const previous = this.deps.host.getInteractionReceipt(this.deps.session().id, response.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.interactionId !== response.interactionId || previous.revision !== response.revision) {
          throw new AppError('NATIVE_INTERACTION_REQUEST_CONFLICT', 'This interaction retry id was already used for a different answer', 409);
        }
        return previous.result;
      }
      // A form's Enter acts on its focused row (a toggle flips), so Continue is pressed on its own row. Moving
      // the cursor answers nothing; the fence below is still written before the one key that does.
      let pressed = current;
      if (!answer && response.action === 'continue') {
        let screen = await control.screen() ?? '';
        for (let step = 0; step < CONFIRM_ROW_STEPS; step++) {
          const row = parseClaudeScreenDialog(screen)?.confirmRow;
          if (row === undefined || row === 'focused') break;
          await control.keys([row === 'below' ? 'Down' : 'Up']);
          await pause(FOOTER_KEY_MS);
          screen = await control.screen() ?? '';
        }
        const row = parseClaudeScreenDialog(screen)?.confirmRow;
        const moved = claudeScreenInteraction(screen, terminal);
        if ((row !== undefined && row !== 'focused') || !moved) {
          throw new AppError('NATIVE_INTERACTION_STALE', 'Claude Code’s Continue row could not be focused. Sync the current request or open the terminal.', 409);
        }
        pressed = moved;
      }
      // The terminal write can succeed before its acknowledgement or the following read fails.
      // Persist the fence first so retrying this request can never press the key twice.
      this.deps.interactions.saveResponse(response, fingerprint, { status: 'uncertain', message: 'Claude Code has not yet confirmed the notice response.' });
      try {
        if (answer) {
          const failure = await this.deps.composer.answerScreenQuestion(control, answer);
          if (failure) return { status: 'uncertain', message: failure } satisfies NativeInteractionResult;
        } else await control.keys([key!]);
        for (let attempt = 0; attempt < 50; attempt++) {
          await new Promise(resolvePause => setTimeout(resolvePause, 60));
          const screen = await control.screen();
          if (screen === undefined) continue;
          const next = claudeScreenInteraction(screen, terminal);
          if (next?.id === pressed.id) continue;
          if (next) {
            this.deps.setScreenAttention(true);
            this.deps.setStatus({ ...this.deps.status(), interaction: next });
            return { status: 'advanced', interaction: next } satisfies NativeInteractionResult;
          }
          this.deps.setScreenAttention(false);
          if (isClaudeScreenInteraction(this.deps.status().interaction)) this.deps.setStatus({ ...this.deps.status(), interaction: undefined });
          return { status: 'completed' } satisfies NativeInteractionResult;
        }
        return { status: 'uncertain', message: 'Claude Code has not closed the notice yet. Sync the state or open the terminal.' } satisfies NativeInteractionResult;
      } catch {
        return { status: 'uncertain', message: 'Claude Code’s notice response could not be confirmed. Sync the state or open the terminal; it will not be sent again.' } satisfies NativeInteractionResult;
      }
    });
    this.deps.interactions.saveResponse(response, fingerprint, result);
    return result;
  }

  /** Stops both polls. */
  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.terminalPollTimer) clearInterval(this.terminalPollTimer);
  }

  /** PreToolUse announced an AskUserQuestion call; its PermissionRequest is due. */
  questionAnnounced(toolUseId: string): void { this.questionHooksDue.set(toolUseId, Date.now()); }

  /** The PermissionRequest of an announced question arrived. */
  questionAsked(toolUseId: string): void { this.questionHooksDue.delete(toolUseId); }
}
