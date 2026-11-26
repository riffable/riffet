import type { NativeActivity, NativeStatus, NativeStopRequest, NativeTurnTarget, Session } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { isLiveActivity, type ActivityLedger } from '../../journal/activity.js';
import { stoppable } from './activity.js';
import { DeferredSteerInputs } from '../shared/deferred-steer.js';
import type { NativeBackendHost } from '../types.js';
import { claudeComposer, claudeScreenBusy } from '../../adapters/cli/claude-code.js';
import { waitFor } from '../shared/wait-for.js';
import { ClaudeTranscript } from './history.js';
import { ClaudeTranscriptSource } from './transcript-source.js';
import type { TurnEndStatus } from '../../journal/ingest.js';
import { claudeScreenInteraction } from './screen-dialog.js';
import { parseDialog } from '../../agent-host/interaction-screen.js';
import { activeTurnOf, type ClaudeSessionState, type ClaudeSignal, type Transition } from './session-state.js';
import { ComposerDriver } from './composer.js';
import { ClaudeInteractions } from './interactions.js';
import { ClaudeSends } from './sends.js';

/** How long a stop waits for the CLI to write the record that confirms it (turn end, agents killed, input removed). */
const STOP_CONFIRM_MS = 20_000;

/** Give Ctrl-C a chance to redraw before confirming a recordless stop against two native idle frames. */
const INTERRUPT_RESTORE_AFTER_MS = 750;

/** How long a stop waits for a freshly pasted message to show whether it was submitted, queued or left in the box. */
const SEND_OUTCOME_WAIT_MS = 2_500;

/** A send whose Enter is older than this and still has no outcome is no longer waited for by a stop (it stays under `stopRequested`). */
const SEND_OUTCOME_FRESH_MS = 30_000;

/** How long a prompt that started after a stop is given to show it runs before that stop is reported as not done. */
const LATE_STOP_WAIT_MS = 15_000;

/** The published turn a stop took down, and the tool calls guidance was waiting on. */
export interface WithdrawnTurn { target: NativeTurnTarget & { ownerRunId?: string }; tools: string[] }

/** What the group takes from `ClaudeSessionRuntime`: values read on demand and callbacks, never the runtime itself. */
export interface ClaudeStopsDeps {
  composer: ComposerDriver;
  host: NativeBackendHost;
  interactions: ClaudeInteractions;
  nativeSessionId: string;
  sends: ClaudeSends;
  statusWaiters: Set<() => void>;
  steering: DeferredSteerInputs;
  transcript: ClaudeTranscript;
  lastActivityAt(): number;
  nativeTurn(): NativeTurnTarget & { ownerRunId?: string } | undefined;
  outputPromptId(): string | undefined;
  replayedTurn(): boolean;
  screenAttention(): boolean;
  session(): Session;
  state(): ClaudeSessionState;
  status(): NativeStatus;
  terminalExited(): boolean;
  terminalId(): string | undefined;
  turnSeq(): number;
  dispatchSignal(signal: ClaudeSignal, status?: Omit<NativeStatus, 'phase'>): Transition;
  publishActivity(activity: NativeActivity, options?: { restored?: boolean }): void;
  refreshTerminalStatus(force?: boolean): Promise<void>;
  refreshTranscript(follow?: boolean): Promise<void>;
  restorePublishedTurn(withdrawn: WithdrawnTurn): void;
  setStatus(requested: Omit<NativeStatus, 'phase'>): void;
  untestedVersion(): Promise<string | undefined>;
  waitUntil(done: () => boolean, timeoutMs: number, probe?: () => Promise<boolean>): Promise<boolean>;
  withdrawPublishedTurn(): WithdrawnTurn | undefined;
}

/** Stopping what the CLI is doing: the main turn, background work, one activity, and a turn that started after its stop was asked for. */
export class ClaudeStops {
  /** This process pressed Ctrl-C on the main turn: whatever ends it is the interruption. */
  interrupting = false;
  /** A request to stop the conversation's background tasks that is still waiting for the CLI to report. */
  stopping?: Promise<void>;

  constructor(private readonly deps: ClaudeStopsDeps) {}

  /** A turn the CLI ends without writing so: persist its end after reading what is on disk (G6). */
  async endJournalTurn(status: TurnEndStatus, promptId: string): Promise<void> {
    const at = new Date().toISOString();
    if (!this.deps.host.transcript) return;
    const closed = await this.deps.host.transcript.withSource(this.deps.session().id, async (source, w) => {
      if (!(source instanceof ClaudeTranscriptSource)) return false;
      await source.endTurn(w, status, at, promptId);
      return source.closedPrompt(w, promptId);
    });
    if (!closed) throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude stopped, but its turn end could not be persisted', 409);
  }

  /**
   * A stop that came while this prompt's outcome was unknown, and the prompt has since started (docs/DELIVERY.md §3,
   * rule 3). Only that exact turn is stopped, under the session lock like any other stop, so it neither races the
   * user's own stop nor reaches a later turn, background work or the input box. It waits for the turn to show it runs:
   * at the prompt hook the screen can still look idle, which a stop reads as a turn the CLI dropped.
   */
  async stopLateTurn(promptId: string): Promise<void> {
    const own = () => activeTurnOf(this.deps.state().mainTurn)?.promptId === promptId;
    const shown = await waitFor(async () => {
      if (!own()) return 'over';
      if (this.deps.outputPromptId() === promptId || this.deps.transcript.hasTurnOutput(promptId)) return 'running';
      const terminalId = this.deps.terminalId();
      const screen = terminalId ? await this.deps.host.terminal.screen(terminalId).catch(() => undefined) : undefined;
      return screen !== undefined && claudeScreenBusy(screen) ? 'running' : undefined;
    }, { timeoutMs: LATE_STOP_WAIT_MS, intervalMs: 250, wake: notify => { this.deps.statusWaiters.add(notify); return () => { this.deps.statusWaiters.delete(notify); }; } });
    if (shown === 'over') return;
    const failed = (reason: string) => {
      console.warn('[claude] stop of a prompt that started after the stop failed', { sessionId: this.deps.session().id, promptId, reason });
      this.deps.setStatus({ ...this.deps.status(), notice: 'A message started after Stop was pressed and could not be stopped; check the terminal.', noticeLevel: 'error' });
    };
    if (shown !== 'running') return failed('the turn showed no sign of running');
    try {
      await this.deps.host.withSessionLock(this.deps.session().id, async () => {
        const terminalId = this.deps.terminalId();
        if (!terminalId || !own()) return;
        await this.stopMainTurn(terminalId, { requestId: `late-stop:${promptId}`, nativeSessionId: this.deps.nativeSessionId, turnId: promptId, terminalId });
      });
    } catch (error) { failed(error instanceof Error ? error.message : String(error)); }
  }

  /**
   * Stop what is running, and answer only when a record says it stopped.
   *
   *   main turn running   Ctrl-C; confirmed by the record that ends the turn (interruption marker, Stop).
   *   main idle, agents   Ctrl-C; confirmed by `agents_killed` (or every agent's metadata saying so).
   *   nothing running     nothing to press: a message this process left in the input box is cleared.
   *
   * A Ctrl-C is never sent to a CLI with nothing to stop — a second one quits it. Afterwards the input
   * box is cleared of any message of ours still in it, which also covers `clearPrompt` (a stop that a
   * replacement message follows): the replacement must not be submitted together with the old text.
   */
  async interrupt(options: { clearPrompt?: boolean; expectedStop?: NativeStopRequest } = {}): Promise<void> {
    await this.deps.refreshTerminalStatus(true);
    await this.deps.refreshTranscript();
    const terminalId = this.deps.terminalId();
    if (this.deps.terminalExited()) return;
    if (!terminalId) {
      if (this.deps.state().process === 'exited' && !this.deps.session().nativeSessionId) return;
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude Code terminal could not be located to confirm the interrupt', 409);
    }
    if (this.deps.state().process === 'exited') {
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude Code terminal state could not be confirmed', 409);
    }
    const current = this.deps.host.getSession(this.deps.session().id);
    const terminal = await this.deps.host.terminal.get(terminalId).catch(() => undefined);
    if (!terminal || current.terminalId !== terminalId || terminal.kind !== 'native'
      || terminal.sessionId !== current.id || terminal.projectId !== current.projectId) {
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude Code terminal binding could not be verified', 409);
    }
    if (terminal.state === 'exited') return;
    const expectedStop = options.expectedStop ? { ...options.expectedStop, terminalId: options.expectedStop.terminalId ?? terminalId,
      terminalEpoch: options.expectedStop.terminalEpoch ?? terminal.epoch } : undefined;
    if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId);
    // A message pasted a moment ago may not have shown its outcome yet (submitted, queued or still in the
    // box). Give that a short while to appear before deciding what there is to stop.
    // Only a send whose Enter was pressed can still turn into a prompt; one a stop preempted before that never will.
    const unsettled = () => this.deps.sends.claimables().filter(send => send.fenced && !send.promptSeen && !send.queued && !send.command
      && !this.deps.sends.closedCommands.has(send.commandId) && send.submittedAt !== undefined && Date.now() - send.submittedAt < SEND_OUTCOME_FRESH_MS);
    await this.deps.waitUntil(() => unsettled().length === 0, SEND_OUTCOME_WAIT_MS);
    // Still no outcome: the prompt may yet start, after this stop has returned. The intent stays with the send, and
    // `bindWebTurn` stops the turn it becomes.
    for (const send of unsettled()) send.stopRequested = true;
    if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId);
    if (activeTurnOf(this.deps.state().mainTurn)) {
      await this.stopMainTurn(terminalId, expectedStop);
    } else if (this.deps.state().background.length > 0) {
      await this.stopBackground(terminalId, expectedStop);
    }
    // Whatever of ours the stop left in the input box is cancelled with it, and taken out.
    if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId, true);
    await this.deps.sends.clearOwnInput(terminalId, false, expectedStop);
  }

  /** Recheck immediately before native writes; PTY input has no atomic turn-addressed protocol. */
  async assertExpectedStop(stop: NativeStopRequest, terminalId: string, allowEnded = false, stopping?: NativeTurnTarget): Promise<void> {
    const terminal = await this.deps.host.terminal.get(terminalId).catch(() => undefined);
    const current = this.deps.host.getSession(this.deps.session().id);
    const turn = activeTurnOf(this.deps.state().mainTurn);
    // The client names the turn the status published (`activeTurn`, none for a cold-attached or hook-without-prompt turn), not
    // the internal prompt id. A stop under way took it down already and passes it as `stopping`, valid while that prompt runs.
    const turnId = turn ? (this.deps.nativeTurn() ?? (stopping && turn.promptId === stopping.turnId ? stopping : undefined))?.turnId : undefined;
    if (!terminal || terminal.state !== 'running' || terminal.kind !== 'native' || terminal.sessionId !== current.id
      || terminal.projectId !== current.projectId || current.terminalId !== terminalId || this.deps.terminalId() !== terminalId
      || current.nativeSessionId !== stop.nativeSessionId || this.deps.nativeSessionId !== stop.nativeSessionId
      || (stop.terminalId !== undefined && stop.terminalId !== terminalId)
      || (stop.terminalEpoch !== undefined && stop.terminalEpoch !== terminal.epoch)
      || (turnId !== stop.turnId && !(allowEnded && !turn))) {
      throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'The original Claude task changed; no further stop keys were sent', 409);
    }
  }

  private async stopMainTurn(terminalId: string, expectedStop?: NativeStopRequest): Promise<void> {
    if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId);
    this.deps.interactions.cancelPending('Claude was interrupted before the web interaction completed.', 'deny');
    this.interrupting = true;
    const withdrawn = this.deps.withdrawPublishedTurn();
    const target = withdrawn?.target;
    this.deps.steering.reject('Claude was interrupted before receiving further guidance.');
    this.deps.setStatus(this.deps.status());
    let failure: unknown;
    let succeeded = false;
    try {
      // After a server restart a cold replay of the JSONL can still name a turn the CLI silently
      // dropped. Only for that replayed turn may an idle screen skip Ctrl-C (on Claude, pressing
      // Ctrl-C twice into an idle prompt quits it); a live turn observed by this runtime always
      // receives Ctrl-C so a screen-format change can never silently skip interrupting it.
      const promptId = activeTurnOf(this.deps.state().mainTurn)?.promptId;
      const hasOutput = () => Boolean(promptId && this.deps.outputPromptId() === promptId) || this.deps.transcript.hasTurnOutput(promptId);
      let alreadyIdle = !hasOutput() && this.deps.replayedTurn() && await this.stopIdleScreen(terminalId);
      if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId, false, target);
      if (!alreadyIdle) {
        if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId, false, target);
        await this.deps.host.terminal.sendKeys(terminalId, ['C-c']);
      }
      let pressedAt = Date.now();
      const pressedTurn = this.deps.turnSeq();
      let idleSince: number | undefined;
      let idleActivity: number | undefined;
      let journaled = false;
      let aborted = false;
      // The turn we stopped is over when nothing runs, or when the CLI has moved on to another turn.
      const over = () => aborted || this.deps.state().mainTurn.kind === 'idle' || this.deps.turnSeq() !== pressedTurn || this.deps.terminalExited();
      // A recordless stop is confirmed only by stable native idle frames, with no hook/transcript
      // progress between them. A composer alone is insufficient: it remains drawn while Claude works.
      const dropped = async () => {
        if (over() || hasOutput() || (!alreadyIdle && Date.now() - pressedAt < INTERRUPT_RESTORE_AFTER_MS)) return false;
        if (!await this.stopIdleScreen(terminalId)) {
          idleSince = undefined;
          if (alreadyIdle && !over()) {
            alreadyIdle = false;
            try {
              if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId, false, target);
              await this.deps.host.terminal.sendKeys(terminalId, ['C-c']);
              pressedAt = Date.now();
            } catch (error) {
              failure = error;
              if (error instanceof AppError && error.code === 'NATIVE_STOP_TARGET_CHANGED') aborted = true;
            }
          }
          return false;
        }
        if (idleSince === undefined || idleActivity !== this.deps.lastActivityAt()) {
          idleSince = Date.now();
          idleActivity = this.deps.lastActivityAt();
          return false;
        }
        if (Date.now() - idleSince < 200 || Date.now() - this.deps.lastActivityAt() < INTERRUPT_RESTORE_AFTER_MS) return false;
        try {
          if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId, true, target);
          await this.deps.sends.clearOwnInput(terminalId, true, expectedStop);
        } catch (error) {
          failure = error;
          if (error instanceof AppError && error.code === 'NATIVE_STOP_TARGET_CHANGED') aborted = true;
          return false;
        }
        if (idleActivity !== this.deps.lastActivityAt()) { idleSince = undefined; return false; }
        if (!over()) {
          try { if (promptId) await this.endJournalTurn('cancelled', promptId); }
          catch (error) { failure = error; return false; }
          journaled = true;
          if (!over()) this.deps.dispatchSignal({ type: 'turn_end', source: 'hook', reason: 'interrupted', ...(promptId ? { promptId } : {}) });
        }
        return true;
      };
      const stopped = await this.deps.waitUntil(over, STOP_CONFIRM_MS, dropped);
      if (!stopped || aborted) throw failure ?? new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude Code did not confirm that the current turn stopped', 409);
      // A Stop hook may have ended the in-memory turn without leaving an end row either.
      if (!journaled && promptId && !this.deps.terminalExited() && this.deps.turnSeq() === pressedTurn) await this.endJournalTurn('cancelled', promptId);
      if (target) this.deps.steering.finish(target, { type: 'run_cancelled', reason: 'Claude confirmed that the turn was interrupted.' });
      succeeded = true;
    } finally {
      this.interrupting = false;
      if (!succeeded && withdrawn && !this.deps.terminalExited() && activeTurnOf(this.deps.state().mainTurn)?.promptId === withdrawn.target.turnId) {
        this.deps.restorePublishedTurn(withdrawn);
        this.deps.setStatus(this.deps.status());
      }
    }
  }

  /** Used only for an explicitly stopped/persistently ended turn, never to infer ordinary live turn state. */
  async stopIdleScreen(terminalId: string): Promise<boolean> {
    if (this.deps.interactions.hasPending() || this.deps.screenAttention()) return false;
    const session = this.deps.host.getSession(this.deps.session().id);
    const terminal = await this.deps.host.terminal.get(terminalId).catch(() => undefined);
    if (!terminal || terminal.state !== 'running' || terminal.kind !== 'native' || terminal.sessionId !== session.id
      || terminal.projectId !== session.projectId || session.terminalId !== terminalId) return false;
    const screen = await this.deps.host.terminal.screen(terminalId).catch(() => undefined);
    return screen !== undefined && claudeComposer(screen) !== undefined && !claudeScreenBusy(screen)
      && !claudeScreenInteraction(screen, terminal) && !parseDialog(screen, terminal);
  }

  /**
   * Stops every background task of the conversation: agents with Ctrl-C (the CLI answers with
   * `agents_killed`), shells, monitors and workflows through its "Background" list, the only place
   * Claude Code 2.1.x stops those (Ctrl-C and its stop-all chord leave them running) — on a version
   * whose list was captured; on any other, those are left to the terminal. Each stop is proved by the
   * CLI's own report in the transcript; nothing here assumes one.
   */
  private async stopBackground(terminalId: string, expectedStop?: NativeStopRequest): Promise<void> {
    if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId);
    const isAgent = (task: ClaudeSessionState['background'][number]) => task.kind === undefined || task.kind === 'agent';
    const shells = this.deps.state().background.some(task => !isAgent(task));
    const untested = shells ? await this.deps.untestedVersion() : undefined;
    if (shells && !untested) {
      await this.deps.composer.stopBackgroundTasks(terminalId, expectedStop);
      await this.deps.refreshTranscript();
    }
    // Pressing Ctrl-C with no agent left would ask the CLI to quit, so it is pressed only for one that is still there.
    if (this.deps.state().background.some(isAgent)) {
      if (expectedStop) await this.assertExpectedStop(expectedStop, terminalId);
      await this.deps.host.terminal.sendKeys(terminalId, ['C-c']);
    }
    // On an untested version only the agents are stopped from here; the shells and monitors are left to the terminal.
    const stopped = await this.deps.waitUntil(() => this.deps.terminalExited() || !this.deps.state().background.some(task => !untested || isAgent(task)), STOP_CONFIRM_MS);
    if (!stopped) throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude Code did not confirm that the background tasks stopped', 409);
    if (untested && !this.deps.terminalExited() && this.deps.state().background.length) {
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', `Claude Code ${untested} background shells and monitors have to be stopped in its terminal`, 409);
    }
  }

  /**
   * A request to stop a background task. Claude Code can only stop all of them at once, so every task
   * of the conversation goes `stopping`; each becomes `stopped` when the CLI reports it, and one the CLI
   * did not report goes back to running.
   */
  async stopActivity(activityId: string): Promise<NativeActivity> {
    await this.deps.refreshTerminalStatus(true);
    await this.deps.refreshTranscript();
    const known = this.deps.transcript.activities();
    const target = known.find(activity => activity.id === activityId);
    if (!target) throw new AppError('ACTIVITY_NOT_FOUND', 'This activity is not known to the conversation', 404);
    if (!target.stop) throw new AppError('ACTIVITY_NOT_STOPPABLE', 'This activity cannot be stopped from here', 409);
    if (!isLiveActivity(target)) throw new AppError('ACTIVITY_ENDED', 'This activity has already ended', 409);
    if (this.stopping) { await this.stopping.catch(() => undefined); return this.deps.transcript.activities().find(activity => activity.id === activityId) ?? target; }
    const terminalId = this.deps.terminalId();
    if (!terminalId || this.deps.terminalExited() || this.deps.state().process === 'exited') {
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude Code terminal could not be located to confirm the stop', 409);
    }
    const current = this.deps.host.getSession(this.deps.session().id);
    const terminal = await this.deps.host.terminal.get(terminalId).catch(() => undefined);
    if (!terminal || current.terminalId !== terminalId || terminal.kind !== 'native' || terminal.sessionId !== current.id
      || terminal.projectId !== current.projectId || terminal.state === 'exited') {
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'Claude Code terminal binding could not be verified', 409);
    }
    const doomed = known.filter(stoppable);
    for (const activity of doomed) if (activity.status !== 'stopping') this.deps.publishActivity({ ...activity, status: 'stopping' });
    const journaled = await this.journalStops(doomed.map(activity => activity.id));
    const task = (async () => { await this.stopBackground(terminalId); })();
    this.stopping = task;
    let failure: unknown;
    try { await task; }
    catch (error) { failure = error; }
    finally { if (this.stopping === task) this.stopping = undefined; }
    await this.deps.refreshTranscript();
    // Whatever the CLI did not report as stopped is still running.
    const kept: string[] = [];
    for (const activity of this.deps.transcript.activities()) {
      if (doomed.some(item => item.id === activity.id) && activity.status === 'stopping') {
        this.deps.publishActivity({ ...activity, status: 'running' }, { restored: true });
        kept.push(activity.id);
      }
    }
    await journaled(kept);
    if (failure) throw failure;
    return this.deps.transcript.activities().find(activity => activity.id === activityId) ?? target;
  }

  /**
   * A stop as the journal's ledger of the conversation's activities records it (G10), which is where clients read them:
   * `stopping` now; each becomes `stopped` there once the transcript's report of it is read. Returns how to put back
   * to running the ones the CLI did not stop.
   */
  private async journalStops(ids: readonly string[]): Promise<(kept: readonly string[]) => Promise<void>> {
    const onLedger = <T>(task: (ledger: ActivityLedger) => T) => this.deps.host.transcript?.withSource(this.deps.session().id, (source, w) => source instanceof ClaudeTranscriptSource ? task((w.scratch ?? w).activities) : undefined).catch(() => undefined);
    const tokens = await onLedger(ledger => {
      const held = new Map<string, number>();
      for (const id of ids) {
        // One the journal has not read yet, or has seen end, has no `stopping` to show.
        try { const { token } = ledger.beginStop(id); if (token !== undefined) held.set(id, token); } catch { /* see above */ }
      }
      return held;
    });
    return async kept => {
      const undo = kept.filter(id => tokens?.has(id));
      if (undo.length) await onLedger(ledger => { for (const id of undo) ledger.stopFailed(id, tokens!.get(id)); });
    };
  }
}
