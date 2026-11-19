import type { NativeRunConfig, Run } from '../../../../../packages/contracts/src/index.js';
import type { RpcItem, RpcTurn, TurnRun } from './types.js';
import { turnStatus, userItemText } from './transcript.js';
import { asArray } from './util.js';

/** What `CodexTurns` needs from the runtime that owns it. */
export interface CodexTurnsContext {
  /** The thread this runtime drives, when it has one. */
  threadId(): string | undefined;
  /** The runs the session already recorded for a provider turn. */
  runsOfTurn(threadId: string, turnId: string): Run[];
  runIdOfCommand(commandId: string): string | undefined;
  /** The command a user message item carries, in whichever form the provider echoes it. */
  commandIdOf(item: RpcItem, turnId: string): string | undefined;
  /** Parent ids stay wire-compatible; a child thread's ids are scoped to it. */
  scopedRequestId(threadId: string | undefined, id: string): string;
}

/** How a settled turn ended, as a run event type. */
export type TurnOutcomeType = 'run_completed' | 'run_failed' | 'run_cancelled';

/** What the runtime needs to write the run events of a turn that has just settled. */
export interface SettledOutcome {
  type: TurnOutcomeType;
  status: ReturnType<typeof turnStatus>;
  /** The commands of this turn that belong to a known run. */
  known: string[];
  /** The run that owns the turn, when one is mapped. */
  mapped: TurnRun | undefined;
}

/**
 * The turn bookkeeping of one session: which provider turn is in the foreground, which Riffet
 * command and run each turn belongs to, and how each turn ended.
 *
 * It owns the current turn (`activeTurnId`, `dispatchCommandId`, `foregroundEndedTurnId`): they
 * change only through its methods, and everything else reads them. It also owns the maps that tie
 * turns to commands and runs, the outcomes waiting for their run to be known, and the waiters an
 * interruption blocks on.
 *
 * It does not talk to the app-server, the terminal or the journal, and it does not decide the
 * session's status. Sending, steering and interrupting, reading history and routing notifications
 * stay in the runtime, which calls these methods where it used to assign the fields.
 */
export class CodexTurns {
  private active: string | undefined;
  /** The newest foreground turn observed ended, including native TUI turns with no command mapping. */
  private foregroundEnded: string | undefined;
  private dispatching: string | undefined;
  private readonly runs = new Map<string, TurnRun>();
  /** Every confirmed input belongs to one execution; the owner remains its first input. */
  private readonly commands = new Map<string, Set<string>>();
  private readonly configs = new Map<string, NativeRunConfig>();
  private readonly outcomes = new Map<string, RpcTurn>();
  private readonly waiters = new Map<string, Set<{ resolve(): void; reject(error: Error): void }>>();
  private readonly commandRuns = new Map<string, TurnRun>();
  /**
   * Messages steered into a running turn when the provider takes no tag for them (TRAE CLI). Each
   * waits to claim the next user item of its turn with the same text; `claimedItems` remembers the
   * claim so later reads of the same item resolve to the same command.
   */
  private readonly pendingSteers: Array<{ turnId: string; commandId: string; text: string }> = [];
  private readonly claimedItems = new Map<string, string>();
  /** The outcome each turn was first settled with; a later, different one is stale. */
  private readonly settled = new Map<string, string>();

  constructor(private readonly host: CodexTurnsContext) {}

  get activeTurnId(): string | undefined { return this.active; }
  get foregroundEndedTurnId(): string | undefined { return this.foregroundEnded; }
  get dispatchCommandId(): string | undefined { return this.dispatching; }

  /** The active turn, unless its outcome is already settled. */
  get unsettledActiveTurnId(): string | undefined {
    return this.active && !this.settled.has(this.active) ? this.active : undefined;
  }

  // The foreground turn. Each method is one transition; the callers say why it happens.

  /** The foreground as it is now, for a read that must not publish over a change made while it ran. */
  snapshot(): { active: string | undefined; ended: string | undefined } {
    return { active: this.active, ended: this.foregroundEnded };
  }

  /** Whether the foreground is as `snapshot` saw it and no message is being dispatched. */
  unchangedSince(before: { active: string | undefined; ended: string | undefined }): boolean {
    return this.active === before.active && this.foregroundEnded === before.ended && !this.dispatching;
  }

  /** A turn is now in the foreground; the end recorded for an earlier one no longer applies. */
  startForeground(turnId: string): void {
    this.active = turnId;
    this.foregroundEnded = undefined;
  }

  /** The turn in the foreground is named without touching the recorded end (a native `turn/started`). */
  markActive(turnId: string): void {
    this.active = turnId;
  }

  /** The foreground turn ended. */
  endForeground(turnId: string): void {
    this.active = undefined;
    this.foregroundEnded = turnId;
  }

  /** A turn ended while nothing was recorded in the foreground. */
  noteForegroundEnded(turnId: string): void {
    this.foregroundEnded = turnId;
  }

  clearForegroundEnded(): void {
    this.foregroundEnded = undefined;
  }

  /** A live `turn/completed`: it ends the foreground turn, or the first end observed while there is none. */
  completeForeground(turnId: string): void {
    if (this.active === turnId) this.endForeground(turnId);
    else if (!this.active && !this.foregroundEnded) this.foregroundEnded = turnId;
  }

  /**
   * The provider answered a submitted message with its turn. A fast completion can precede that
   * answer, and so can a newer native turn: neither may be replaced by the acknowledgement.
   */
  settleAcknowledged(turnId: string, endedBeforeSend: string | undefined, completedBeforeAck: boolean): void {
    if ((!this.active || this.active === turnId) &&
      (!this.foregroundEnded || this.foregroundEnded === turnId || this.foregroundEnded === endedBeforeSend)) {
      if (completedBeforeAck || this.foregroundEnded === turnId) this.endForeground(turnId);
      else this.startForeground(turnId);
    }
  }

  /** A native command's turn is confirmed. Returns whether it took the foreground. */
  adoptCommandTurn(turnId: string, endedBeforeSend: string | undefined): boolean {
    if (this.outcomes.has(turnId) || this.settled.has(turnId)
      || (this.active && this.active !== turnId)
      || (this.foregroundEnded && this.foregroundEnded !== endedBeforeSend)) return false;
    this.startForeground(turnId);
    return true;
  }

  /** A message is being written to the provider. */
  beginDispatch(commandId: string): void {
    this.dispatching = commandId;
  }

  endDispatch(commandId: string): void {
    if (this.dispatching === commandId) this.dispatching = undefined;
  }

  /**
   * Whether this client is driving the turn right now: it is the active turn, or it carries the
   * message being dispatched. Only an `interrupted` read of such a turn is ignored: a history read
   * taken while it starts can call it that — TRAE CLI derives the status from a rollout that does not
   * have the turn's `task_started` yet — whereas `completed` and `failed` only appear once it ended.
   * A real interruption still arrives live as `turn/completed`.
   */
  drives(turn: RpcTurn): boolean {
    if (turn.id === this.active) return true;
    const dispatching = this.dispatching;
    return Boolean(dispatching && asArray<RpcItem>(turn.items).some(item => this.host.commandIdOf(item, turn.id) === dispatching));
  }

  // Turns, commands and runs.

  turnRun(turnId: string): TurnRun | undefined { return this.runs.get(turnId); }
  commandRun(commandId: string): TurnRun | undefined { return this.commandRuns.get(commandId); }
  turnConfig(turnId: string): NativeRunConfig | undefined { return this.configs.get(turnId); }
  setTurnConfig(turnId: string, config: NativeRunConfig): void { this.configs.set(turnId, config); }

  /** Every turn this runtime has bookkeeping for, including the foreground end. */
  knownTurnIds(): string[] {
    return [...this.runs.keys(), ...this.settled.keys(), ...this.outcomes.keys(), ...(this.foregroundEnded ? [this.foregroundEnded] : [])];
  }

  /** A turn started in the native TUI may have no Riffet owner; give it an empty record to attach inputs to. */
  ensureTurnRun(turnId: string): void {
    if (!this.runs.has(turnId)) this.runs.set(turnId, { createdAt: new Date().toISOString() });
  }

  /** A command was submitted for a run. */
  submitCommand(commandId: string, runId: string, createdAt = new Date().toISOString()): void {
    this.commandRuns.set(commandId, { runId, commandId, createdAt });
  }

  /** A command was confirmed submitted for a run, keeping what is already known about it. */
  confirmCommand(commandId: string, runId: string): void {
    const previous = this.commandRuns.get(commandId);
    this.commandRuns.set(commandId, { ...(previous ?? {}), commandId, runId, createdAt: previous?.createdAt ?? new Date().toISOString() });
  }

  /** A command seen in provider history, whose run the session may already know. */
  observeCommand(turnId: string, commandId: string, startedAt: string | undefined): void {
    const previous = this.commandRuns.get(commandId);
    const runId = previous?.runId ?? this.host.runIdOfCommand(commandId);
    this.commandRuns.set(commandId, {
      ...(runId ? { runId } : {}), commandId,
      createdAt: previous?.createdAt ?? startedAt ?? new Date().toISOString(),
    });
    this.rememberCommand(turnId, commandId, true);
  }

  /** A command seen in a live item, when nothing is known about it yet. */
  noteLiveCommand(commandId: string, startedAt: string | undefined): void {
    if (this.commandRuns.has(commandId)) return;
    this.commandRuns.set(commandId, { commandId, runId: this.host.runIdOfCommand(commandId), createdAt: startedAt ?? new Date().toISOString() });
  }

  /** The turn a message being dispatched started or asked about belongs to that message's run. */
  bindDispatchedTurn(turnId: string): void {
    const commandId = this.dispatching;
    const submitted = commandId ? this.commandRuns.get(commandId) : undefined;
    if (submitted) this.runs.set(turnId, { ...submitted, commandId });
  }

  rememberCommand(turnId: string, commandId: string, confirmed: boolean): void {
    const command = this.commandRuns.get(commandId);
    if (!command) return;
    const owner = this.runs.get(turnId);
    if (!owner || owner.commandId === commandId && !owner.runId && command.runId) this.runs.set(turnId, { ...command, commandId });
    if (confirmed) {
      const commands = this.commands.get(turnId) ?? new Set<string>();
      commands.add(commandId);
      this.commands.set(turnId, commands);
    }
  }

  restoreCommands(turnId: string): void {
    const threadId = this.host.threadId();
    if (!threadId) return;
    const runs = this.host.runsOfTurn(threadId, turnId);
    // The first ordinary input owns the execution even if a steer was restored before it.
    const owner = runs.find(run => run.native?.intent !== 'steer');
    if (owner) {
      this.commandRuns.set(owner.commandId, { runId: owner.id, commandId: owner.commandId, createdAt: owner.createdAt });
      this.runs.set(turnId, this.commandRuns.get(owner.commandId)!);
      if (owner.native?.resolvedConfig) this.configs.set(turnId, owner.native.resolvedConfig);
    }
    if (!owner && runs.length && !this.runs.has(turnId)) {
      this.runs.set(turnId, { ...(runs[0]!.native?.ownerRunId ? { runId: runs[0]!.native.ownerRunId } : {}), createdAt: runs[0]!.createdAt });
    }
    for (const run of runs) {
      if (run.native?.delivery === 'failed' || run.native?.delivery === 'cancelled') continue;
      this.commandRuns.set(run.commandId, { runId: run.id, commandId: run.commandId, createdAt: run.createdAt });
      // An acceptance alone does not prove the model's original turn received this input.
      if (run.native?.delivery === 'observed' || Boolean(run.native?.nativeMessageId)) this.rememberCommand(turnId, run.commandId, true);
    }
  }

  /** The provider refused a steer: nothing of it may stay attached to the turn. */
  forgetCommand(turnId: string, commandId: string): void {
    this.commandRuns.delete(commandId);
    this.commands.get(turnId)?.delete(commandId);
    for (const [id, claimed] of this.claimedItems) if (claimed === commandId) this.claimedItems.delete(id);
  }

  // Steers the provider does not tag.

  /** Registers a steer that will claim the next matching user item. */
  addSteerClaim(claim: { turnId: string; commandId: string; text: string }): void {
    this.pendingSteers.push(claim);
    if (this.pendingSteers.length > 32) this.pendingSteers.shift();
  }

  /** A message the provider never took must not claim a TUI message with the same text later. */
  dropSteerClaim(claim: { turnId: string; commandId: string; text: string }): void {
    const index = this.pendingSteers.indexOf(claim);
    if (index >= 0) this.pendingSteers.splice(index, 1);
  }

  /** The command a user item belongs to by a steer's claim, claiming it on first sight. */
  claimSteeredItem(id: string, turnId: string | undefined, item: RpcItem): string | undefined {
    const claimed = this.claimedItems.get(id);
    if (claimed) return claimed;
    const text = userItemText(item).trim();
    const index = this.pendingSteers.findIndex(steer => (!turnId || steer.turnId === turnId) && steer.text.trim() === text);
    if (index < 0) return undefined;
    const [steer] = this.pendingSteers.splice(index, 1);
    this.claimedItems.set(id, steer!.commandId);
    if (this.claimedItems.size > 256) this.claimedItems.delete(this.claimedItems.keys().next().value!);
    return steer!.commandId;
  }

  // Outcomes.

  pendingOutcome(turnId: string): RpcTurn | undefined { return this.outcomes.get(turnId); }
  hasPendingOutcome(turnId: string): boolean { return this.outcomes.has(turnId); }
  isSettled(turnId: string): boolean { return this.settled.has(turnId); }
  settledType(turnId: string): string | undefined { return this.settled.get(turnId); }

  /** Takes the outcome that arrived before its turn was acknowledged. */
  takePendingOutcome(turnId: string): RpcTurn | undefined {
    const outcome = this.outcomes.get(turnId);
    if (outcome) this.outcomes.delete(turnId);
    return outcome;
  }

  /**
   * An unmapped provisional interrupted history copy is not a completion receipt. A native start
   * now names its active turn; committed workbench outcomes still keep their first end.
   */
  dropProvisionalInterrupt(turnId: string): void {
    if (turnStatus(this.outcomes.get(turnId)?.status) === 'interrupted' && !this.settled.has(turnId)) this.outcomes.delete(turnId);
  }

  private rememberOutcome(turnId: string, turn: RpcTurn): void {
    this.outcomes.set(turnId, turn);
    if (this.outcomes.size > 64) this.outcomes.delete(this.outcomes.keys().next().value!);
  }

  /**
   * Records that a turn ended and finds the commands whose runs it settles. Returns undefined when
   * there is nothing to write: the status is not an end, the turn already ended otherwise, or no
   * command of it is known yet (the outcome then waits in `pendingOutcome`).
   */
  settleOutcome(turn: RpcTurn, turnId: string): SettledOutcome | undefined {
    const status = turnStatus(turn.status);
    const type = status === 'completed' ? 'run_completed' : status === 'failed' ? 'run_failed' : status === 'interrupted' ? 'run_cancelled' : undefined;
    if (!type) return undefined;
    // A turn ends once. A history read that started before `turn/completed` can return after it with
    // an older status; settling on that would flip a completed run to cancelled.
    const settled = this.settled.get(turnId);
    if (settled && settled !== type) return undefined;
    this.completeWaiters(turnId);
    this.rememberOutcome(turnId, turn);
    this.restoreCommands(turnId);
    const ids = new Set([...(this.commands.get(turnId) ?? []), ...asArray<RpcItem>(turn.items)
      .filter(item => item.type === 'userMessage')
      .map(item => this.host.commandIdOf(item, turnId))
      .filter((id): id is string => Boolean(id))]);
    const mapped = this.runs.get(turnId);
    if (mapped?.commandId) ids.add(mapped.commandId);
    const known = [...ids].filter(commandId => this.commandRuns.has(commandId));
    if (!known.length) {
      if (this.dispatching) this.rememberOutcome(turnId, turn);
      return undefined;
    }
    this.settled.set(turnId, type);
    if (this.settled.size > 256) this.settled.delete(this.settled.keys().next().value!);
    return { type, status, known, mapped };
  }

  // Interruption waiters.

  /** Only a reliable turn terminal (live or recovered history), never an offline/unknown state. */
  completeWaiters(turnId: string, threadId = this.host.threadId()): void {
    const waiterId = this.host.scopedRequestId(threadId, turnId);
    for (const waiter of this.waiters.get(waiterId) ?? []) waiter.resolve();
    this.waiters.delete(waiterId);
  }

  /** Waits for the turn's terminal. `release` must run once the wait is over, however it ended. */
  waitForCompletion(waiterId: string): { completed: Promise<void>; release(): void } {
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => { resolveCompleted = resolve; rejectCompleted = reject; });
    const waiter = { resolve: resolveCompleted, reject: rejectCompleted };
    let waiters = this.waiters.get(waiterId);
    if (!waiters) this.waiters.set(waiterId, waiters = new Set());
    waiters.add(waiter);
    return {
      completed,
      release: () => {
        this.waiters.get(waiterId)?.delete(waiter);
        if (this.waiters.get(waiterId)?.size === 0) this.waiters.delete(waiterId);
      },
    };
  }

  /** The app-server went away: no waiter will see its turn end. */
  rejectWaiters(error: (turnId: string) => Error): void {
    for (const [turnId, waiters] of this.waiters) {
      for (const waiter of waiters) waiter.reject(error(turnId));
    }
    this.waiters.clear();
  }
}
