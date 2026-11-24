import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import type { NativeDeliveryState, NativeRunInput, NativeStatus, NativeStopRequest, Run, Session } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';
import type { WorkspaceService } from '../workspace/index.js';
import type { NativeBackendTraits, NativeDispatchBinding } from '../backends/types.js';
import { AppError } from '../errors.js';
import { launchArgAccepted } from '../terminal/launch-args.js';
import type { DispatchSnapshot, NativeDispatcherBackend } from './dispatch.js';

const now = () => Date.now();

/** Whether the CLI answers this run in its own pane: the provider's verdict when it gave one, else a leading `/`. */
function isSlashCommand(native: NonNullable<Run['native']>): boolean {
  return native.slashCommand ?? native.input.text.trimStart().startsWith('/');
}

/** What the actor hands `startTurn` once a run is `preparing` and the archive checks have passed. */
export interface TurnDeliveryParams {
  session: Session;
  run: Run;
  initial: NonNullable<Run['native']>;
  /** The actor's view before the write. Settlement re-reads the run: the fence may set `slashCommand`. */
  isSlash: boolean;
  now?: boolean;
  expectedStop?: NativeStopRequest;
  isClosed: () => boolean;
  isInterrupting: () => boolean;
  readStatus: (sessionId: string) => NativeStatus | undefined;
}

export interface TurnDeliveryResult {
  settled: boolean;
  snapshot?: DispatchSnapshot;
}

/** The follow-up a replacement may send. Absent when the actor keeps the stop-then-queue order (a slash command). */
export interface ReplacementClaim {
  run: Run;
  initial: NonNullable<Run['native']>;
  isSlash: boolean;
}

/**
 * How a message is written into a native conversation: a launch argument, a driver `sendRun`,
 * or a PTY paste. The session actor decides when a turn may start and what a failure means for
 * the queue; this is the only place that branches on those transports, and the only place that
 * commits the at-most-once fence around the write.
 */
export class ExecutionAdapter {
  constructor(private readonly deps: {
    store: Store;
    native: NativeDispatcherBackend;
    runtime: {
      ensure(session: Session, options?: { initialPrompt?: string; beforeSpawn?: () => void | Promise<void> }): Promise<unknown>;
    };
    workspace: Pick<WorkspaceService, 'readAttachment'>;
    traits: (backendId: string | undefined) => NativeBackendTraits;
  }) {}

  private get store() { return this.deps.store; }
  private get native() { return this.deps.native; }
  private get runtime() { return this.deps.runtime; }
  private get workspace() { return this.deps.workspace; }

  private traits(backendId: string | undefined): NativeBackendTraits {
    return this.deps.traits(backendId);
  }

  /** What messages call a backend's CLI: "<name> CLI" when it has a name (`terminalName`), else "CLI". */
  private cliName(backendId: string | undefined): string {
    const name = this.traits(backendId).terminalName;
    return name ? `${name} CLI ` : 'CLI ';
  }

  /** Materialise attachments and render `@path` context onto the text the CLI actually receives. */
  async render(input: NativeRunInput): Promise<string> {
    const extras = input.context.map(item => `@${item.path}${item.line ? `:${item.line}` : ''}`);
    for (const id of input.attachmentIds) {
      const { attachment, data } = await this.workspace.readAttachment(id);
      const directory = join(tmpdir(), 'riffet-attachments', attachment.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = join(directory, basename(attachment.name) || 'attachment');
      await writeFile(target, data, { mode: 0o600 });
      extras.push(target);
    }
    return [input.text, ...(extras.length ? ['', ...extras] : [])].join('\n');
  }

  /** Whether the session's terminal is running; a backend without one never has a CLI to wait for. */
  hasLiveTerminal(session: Session): boolean {
    if (!session.terminalId) return false;
    try { return this.store.getTerminal(session.terminalId).state !== 'exited'; }
    catch { return false; }
  }

  /**
   * Phase-1 gate for routing a run's text to a brand-new agent CLI as a positional launch argument
   * rather than through the TUI composer. Only safe for a brand-new session's first user message with no
   * attachments/context — in that case there is no existing composer draft to collide with, no
   * live TUI to coordinate against, and no slash command. Everything else keeps the legacy
   * paste-into-composer path intact.
   */
  canUseArgvInitialPrompt(session: Session, initial: NonNullable<Run['native']>): boolean {
    if (initial.stage === 'interrupt_followup') return false;
    if (!initial.input.text || initial.input.text.trimStart().startsWith('/')) return false;
    if (initial.input.attachmentIds.length > 0) return false;
    if (initial.input.context.length > 0 || initial.input.references?.length || initial.input.agents?.length) return false;
    if (session.resumePicker) return false;
    // The terminal accepts the same argument it is given here; a longer draft goes through the
    // paste path, which streams through a tmux paste-buffer and has no comparable limit.
    if (!launchArgAccepted(initial.input.text)) return false;
    // A live terminal cannot absorb a positional argv prompt retroactively — fall back to paste.
    return !this.hasLiveTerminal(session);
  }

  /** A driver owns its send path (`sendRun`); receipt matching then uses the fenced provider session, not a PTY. */
  hasDriverSend(): boolean {
    return Boolean(this.native.sendRun);
  }

  /**
   * Write one preparing run. Three transports, one fence:
   * a launch-argv prompt (fence in `beforeSpawn`, then `input_sent` unless the CLI has already exited),
   * a driver `sendRun` (including `now` / `expectedStop` when this replaces a turn),
   * or a legacy `deliver` / `deliverNow`.
   * Slash commands and driver-settled sends are completed here. Otherwise the post-send snapshot is
   * returned for the actor to observe — this method does not apply it.
   */
  async startTurn(params: TurnDeliveryParams): Promise<TurnDeliveryResult> {
    const { run, initial } = params;
    const runId = run.id;
    let session = params.session;
    // Decide BEFORE spawning. Only when (a) no live terminal yet, (b) the composer owns the message
    // (not a slash command), (c) no attachments or context (`render` would append file paths), and
    // (d) the text fits one launch argument. `supportsInitialPromptArgs` is asked only after that
    // gate: a backend that never takes argv is not even queried when the gate already failed.
    const argvEligible = this.canUseArgvInitialPrompt(session, initial) && await this.native.supportsInitialPromptArgs?.(session) === true;
    // Neither a cancel nor a shutdown while the backend was asked may let the message out after all.
    if (params.isClosed()) throw new AppError('DISPATCH_STOPPED', 'The service is restarting; the message was not sent', 409);
    if (this.store.getRun(runId).native?.delivery !== 'preparing') return { settled: false };
    session = this.store.getSession(run.sessionId);
    if (session.archivedAt) throw new AppError('ARCHIVED_SESSION', 'This conversation is archived', 409);
    if (!params.now && params.isInterrupting()) throw new AppError('NATIVE_INTERRUPT_IN_PROGRESS', 'The current turn is stopping; the message was not sent', 409);
    // A queued input is delivered under the settings in effect when it actually starts, the way
    // DSH resolves a selection at step assembly. `initial.config` remains the record of what was
    // accepted — `sendRun` reads the live session, and what it really used lands in the fence's
    // `resolvedConfig` — so a switch made while the message waited neither silently runs the old
    // settings nor fails the message. A switch asked for while this run is in flight is deferred
    // by its backend (terminal-based ones relaunch a CLI only when it is idle; DSH applies one
    // without disturbing the turn), so nothing here has to refuse it.
    // `render` has no side effects on the argv path: the gate above already rejected attachments and context.
    const argvPrompt = argvEligible ? await this.render(initial.input) : undefined;
    let settled = false;
    // A resumed chat already has rows; only an echo after them can be this prompt's receipt.
    const argvBaseline = argvPrompt !== undefined && session.nativeSessionId
      ? (await this.native.snapshot(session.id)).events.at(-1)?.sequence ?? 0
      : 0;
    let argvFenced = false;
    // The argv prompt is delivered by the spawn itself, so the write fence has to be committed
    // before the process exists: recovery then sees an uncertain delivery and never replays it,
    // and a cancel is refused because the CLI may already be running it.
    const beforeSpawn = async () => {
      if (params.isClosed()) throw new AppError('DISPATCH_STOPPED', 'The service is restarting; the message was not sent', 409);
      if (params.isInterrupting()) throw new AppError('NATIVE_INTERRUPT_IN_PROGRESS', 'The current turn is stopping; the message was not sent', 409);
      const latest = this.store.getSession(session.id);
      const nativeSessionId = latest.nativeSessionId;
      const changed = this.store.transitionNativeRun(runId, ['preparing'], {
        delivery: 'dispatching', stage: 'input', backendId: latest.backendId,
        ...(nativeSessionId ? { nativeSessionId } : {}),
        baselineSequence: argvBaseline, renderedText: argvPrompt,
        resolvedConfig: { model: latest.model, mode: latest.mode, approval: latest.approval },
        timings: { ...this.store.getRun(runId).native?.timings, dispatchAt: now() },
      });
      if (!changed) throw new AppError('RUN_CANCELLED', 'The message was cancelled', 409);
      argvFenced = true;
    };
    const resuming = Boolean(session.nativeSessionId && params.readStatus(session.id)?.phase === 'offline');
    if (resuming && !this.store.transitionNativeRun(runId, ['preparing'], { stage: 'resuming' })) return { settled: false };
    await this.runtime.ensure(session, argvPrompt !== undefined ? { initialPrompt: argvPrompt, beforeSpawn } : {});
    // A launch-time prompt may already have committed its input fence while ensure was running.
    if (resuming) this.store.transitionNativeRun(runId, ['preparing'], { stage: 'runtime' });
    if (params.isClosed()) throw new AppError('DISPATCH_STOPPED', 'The service is restarting', 409);
    if (argvPrompt === undefined && this.store.getRun(runId).native?.delivery !== 'preparing') return { settled: false };
    session = this.store.getSession(run.sessionId);
    if (!params.now && argvPrompt === undefined) {
      // Reconnecting an offline backend can reveal a turn or prompt already running on the CLI;
      // re-apply the live status gates from `lane.ts` before writing so a fresh message never
      // steers an active turn.
      const liveStatus = params.readStatus(session.id);
      if (liveStatus?.phase === 'attention' || liveStatus?.interaction) {
        throw new AppError('CLI_INTERACTION_REQUIRED', 'Handle the pending confirmation first', 409);
      }
      if (liveStatus?.phase === 'busy') {
        throw new AppError('CLI_BUSY', 'A turn is already running', 409);
      }
      if (liveStatus && (liveStatus.activeTurn || liveStatus.activity?.background || liveStatus.activity?.compacting)
        && this.store.listUnfinishedNativeRuns(session.id).some(item => item.native?.queueReleasedAt)) {
        throw new AppError('CLI_BUSY', 'Finish active or background work first', 409);
      }
    }
    // The launch returned without passing through the fence hook, so whether a CLI got the prompt
    // on its argv is unknown; pasting it as well could run it twice.
    if (argvPrompt !== undefined && !argvFenced) {
      this.store.transitionNativeRun(runId, ['preparing'], { delivery: 'uncertain', stage: 'confirmation',
        diagnostic: { code: 'NATIVE_INPUT_FENCE_MISSING', message: 'The initial prompt launch returned without committing its input fence', stage: 'runtime', at: new Date().toISOString() },
      }, { state: 'interrupted', error: '暂时无法确认是否已发送' });
      return { settled: false };
    }
    if (argvPrompt !== undefined) {
      const latest = this.store.getSession(session.id);
      if (!latest.terminalId) throw new AppError('TERMINAL_NOT_RUNNING', 'The CLI did not start', 503);
      const info = this.store.getTerminal(latest.terminalId);
      const fence = this.store.getRun(runId).native!;
      // The CLI could have exited immediately on bad args (unsupported model/context, denied
      // trust in a nested dir, OOM, …). Fail fast with a clear state instead of parking the
      // run on `input_sent` waiting for a transcript echo that will never arrive.
      if (info.state === 'exited') {
        this.store.transitionNativeRun(runId, ['dispatching'], { delivery: 'failed', stage: 'prepare' }, { state: 'failed', error: latest.error ?? `${this.cliName(latest.backendId)}启动后立即退出，请检查模型/上下文配置` });
        return { settled: false };
      }
      // The transcript echo may already have bound the run to `observed`; it still gets its terminal.
      if (fence.delivery === 'dispatching' || fence.delivery === 'observed') {
        this.store.transitionNativeRun(runId, [fence.delivery], {
          ...(fence.delivery === 'dispatching' ? { delivery: 'input_sent', stage: 'confirmation' } : {}),
          terminalId: info.id, terminalEpoch: info.epoch,
          timings: { ...fence.timings, inputSentAt: now() },
        });
      }
    } else if (this.native.sendRun) {
      settled = (await this.native.sendRun(session, run, binding => {
        if (params.isClosed()) throw new AppError('DISPATCH_STOPPED', 'The service is restarting; the message was not sent', 409);
        if (!params.now && params.isInterrupting()) throw new AppError('NATIVE_INTERRUPT_IN_PROGRESS', 'The current turn is stopping; the message was not sent', 409);
        const latest = this.store.getSession(session.id);
        // No configuration comparison here: `runtime.ensure` re-reads the store and `sendRun`
        // delivers under the live settings, so a switch made while the message waited is meant to
        // govern it rather than fail it.
        if (this.native.commitDispatchFence) return this.native.commitDispatchFence(runId, binding);
        const changed = this.store.transitionNativeRun(runId, ['preparing'], {
          delivery: 'dispatching', stage: 'input', backendId: latest.backendId,
          ...(binding?.nativeSessionId ? { nativeSessionId: binding.nativeSessionId } : {}),
          ...(binding?.terminalId ? { terminalId: binding.terminalId } : latest.terminalId ? { terminalId: latest.terminalId } : {}),
          ...(binding?.terminalEpoch !== undefined ? { terminalEpoch: binding.terminalEpoch } : {}),
          ...(binding?.baselineSequence !== undefined ? { baselineSequence: binding.baselineSequence } : {}),
          ...(binding?.renderedText !== undefined ? { renderedText: binding.renderedText } : {}),
          ...(binding?.slashCommand !== undefined ? { slashCommand: binding.slashCommand } : {}),
          ...(binding?.resolvedConfig ? { resolvedConfig: binding.resolvedConfig } : {}),
          timings: { ...this.store.getRun(runId).native?.timings, dispatchAt: now() },
        });
        if (!changed) throw new AppError('RUN_CANCELLED', 'The message was cancelled', 409);
        return changed;
      }, params.now ? { now: true, ...(params.expectedStop ? { expectedStop: params.expectedStop } : {}) } : undefined))?.settled === true;
    } else {
      const text = await this.render(initial.input);
      const deliver = params.now ? this.native.deliverNow : this.native.deliver;
      if (!deliver) throw new AppError('NATIVE_BACKEND_SEND_UNAVAILABLE', 'Backend cannot send native messages', 503);
      await deliver.call(this.native, session, text, ({ terminalId, epoch, chatId, baselineSequence = 0 }: { terminalId: string; epoch: number; chatId?: string; baselineSequence?: number }) => {
        if (params.isClosed()) throw new AppError('DISPATCH_STOPPED', 'The service is restarting; the message was not sent', 409);
        if (!params.now && params.isInterrupting()) throw new AppError('NATIVE_INTERRUPT_IN_PROGRESS', 'The current turn is stopping; the message was not sent', 409);
        const latest = this.store.getSession(session.id);
        // The pane is the one thing that must not move under a delivery in progress: pasting into a
        // replaced terminal would type the message into a dead or unrelated session. The settings
        // are deliberately not compared — the message is delivered under the live ones.
        if (latest.terminalId !== terminalId) throw new AppError('TERMINAL_REBOUND', 'The conversation moved to another terminal; send the message again', 409);
        const nativeSessionId = chatId ?? latest.nativeSessionId;
        const changed = this.store.transitionNativeRun(runId, ['preparing'], {
          delivery: 'dispatching', stage: 'input', terminalId, terminalEpoch: epoch,
          backendId: latest.backendId,
          ...(nativeSessionId ? { nativeSessionId } : {}),
          baselineSequence, renderedText: text,
          resolvedConfig: { model: latest.model, mode: latest.mode, approval: latest.approval },
          timings: { ...this.store.getRun(runId).native?.timings, dispatchAt: now() },
        });
        if (!changed) throw new AppError('RUN_CANCELLED', 'The message was cancelled', 409);
      });
    }
    // The argv path committed `input_sent` itself; both send paths stop at `dispatching`.
    if (argvPrompt === undefined) {
      const current = this.store.getRun(runId);
      this.store.transitionNativeRun(runId, ['dispatching'], { delivery: 'input_sent', stage: 'confirmation', timings: { ...current.native?.timings, inputSentAt: now() } });
    }
    // A slash command the CLI answers in its own pane uses a successful PTY submission as its delivery boundary;
    // a message the backend carried out itself (a new Codex thread) has no turn to wait for.
    // `params.isSlash` is only the actor's pre-write hint. The fence may have recorded `slashCommand`
    // since (a `/skill` the provider says is an ordinary turn), so settlement reads the run back.
    const persisted = this.store.getRun(runId).native ?? initial;
    if (settled || this.traits(session.backendId).settlesSlashOnSubmit && isSlashCommand(persisted)) {
      this.store.transitionNativeRun(runId, ['input_sent'], { stage: 'command_sent' }, { state: 'completed' });
      return { settled: true };
    }
    // Only a head start on the receipt the stream brings anyway. A provider that cannot list a
    // thread whose first turn it is still writing (Codex) fails this read, and that says nothing
    // about a message the send already handed over.
    const snapshot = await this.native.snapshot(session.id).catch(() => undefined);
    return snapshot ? { settled: false, snapshot } : { settled: false };
  }

  /**
   * Replace the running turn with one follow-up when the backend can do that in its own step
   * (`supportsSendNow`: a guarded `deliverNow`, or `sendRun` with `now`). Returns `unsupported`
   * without touching the queue when it cannot — the actor then stops first and sends after.
   * `claim` runs only after that capability check, so a backend without send-now never accepts
   * the follow-up early. `arm` is the queued → preparing transition and stays outside recovery;
   * `open` / `startTurn` failures go through `recover`.
   */
  async replaceTurn<TArm>(params: {
    session: Session;
    expectedStop?: NativeStopRequest;
    isClosed: () => boolean;
    isInterrupting: () => boolean;
    readStatus: (sessionId: string) => NativeStatus | undefined;
    claim: () => ReplacementClaim | undefined;
    arm: (claimed: ReplacementClaim) => TArm | undefined;
    open: (claimed: ReplacementClaim, armed: TArm) => Session;
    recover: (claimed: ReplacementClaim, error: unknown) => void;
    observe: (sessionId: string, result: TurnDeliveryResult) => void;
  }): Promise<{ status: 'unsupported' } | { status: 'skipped' } | { status: 'delivered'; run: Run }> {
    if (!params.session.terminalId || await this.native.supportsSendNow?.(params.session) !== true) return { status: 'unsupported' };
    const claimed = params.claim();
    if (!claimed) return { status: 'skipped' };
    const armed = params.arm(claimed);
    if (!armed) throw new AppError('RUN_CANCELLED', 'The replacement is no longer queued', 409);
    try {
      const session = params.open(claimed, armed);
      const result = await this.startTurn({
        session,
        run: claimed.run,
        initial: claimed.initial,
        isSlash: claimed.isSlash,
        now: true,
        ...(params.expectedStop ? { expectedStop: params.expectedStop } : {}),
        isClosed: params.isClosed,
        isInterrupting: params.isInterrupting,
        readStatus: params.readStatus,
      });
      params.observe(claimed.run.sessionId, result);
      return { status: 'delivered', run: claimed.run };
    } catch (error) {
      params.recover(claimed, error);
      if (this.store.getRun(claimed.run.id).native?.delivery === 'queued') return { status: 'skipped' };
      throw error;
    }
  }

  /**
   * Stop the foreground turn. A driver is interrupted by session id; a PTY backend by the session
   * record. With neither a live terminal nor a driver, a stop that still has targets cannot be confirmed.
   */
  async stopTurn(session: Session, options: { clearPrompt: boolean; expectedStop?: NativeStopRequest; hasTargets: boolean }): Promise<void> {
    const driver = this.hasDriverSend();
    if (!session.terminalId && options.hasTargets && !driver) {
      throw new AppError('TERMINAL_NOT_RUNNING', 'Could not confirm whether the current turn stopped', 409);
    }
    const interruptOptions = {
      clearPrompt: options.clearPrompt,
      ...(options.expectedStop ? { expectedStop: options.expectedStop } : {}),
    };
    await this.native.interrupt(driver ? session.id : session, interruptOptions);
  }

  /** Release an in-flight send's receipt wait before Stop needs the same session lock. */
  requestInterrupt(sessionId: string): void {
    this.native.requestInterrupt?.(sessionId);
  }

  /**
   * Inject one steer into the live turn. `beforeSend` runs only after the backend has accepted
   * the capability, so a refused steer does not subscribe and launch a cold runtime.
   */
  async steerTurn(session: Session, run: Run, commitDispatchFence: (binding?: NativeDispatchBinding) => Run, beforeSend?: () => void): Promise<{ deferred: true } | void> {
    if (!this.native.steerRun || !await this.native.supportsSteer?.(session)) throw new AppError('STEER_UNSUPPORTED', 'This backend does not support steering', 409);
    beforeSend?.();
    return this.native.steerRun(session, run, commitDispatchFence);
  }

  /** Journal ends for the turns a confirmed stop just settled. A missing hook must not keep the queue waiting. */
  async endInterruptedTurns(sessionId: string, targets: Map<string, NativeDeliveryState>, stop?: NativeStopRequest, fallbackTurnId?: string): Promise<void> {
    const endTurn = this.native.endTurn;
    if (!endTurn) return;
    const turnIds = new Set<string>();
    if (stop?.turnId) turnIds.add(stop.turnId);
    for (const [runId, initialDelivery] of targets) {
      if (initialDelivery === 'preparing') continue;
      const native = this.store.getRun(runId).native;
      if (!native?.nativeTurnId) continue;
      if (native.stage !== 'interrupted' && native.stage !== 'steer_stopped') continue;
      turnIds.add(native.nativeTurnId);
    }
    if (!turnIds.size && fallbackTurnId) turnIds.add(fallbackTurnId);
    const at = new Date().toISOString();
    const nativeSessionId = stop?.nativeSessionId ?? this.store.getSession(sessionId).nativeSessionId;
    for (const turnId of turnIds) {
      // An original that finished naturally while Stop waited keeps the provider's outcome.
      if (nativeSessionId && this.store.findRunsByNativeTurn(sessionId, nativeSessionId, turnId)
        .some(run => !run.native?.intent && (run.state === 'completed' || run.state === 'failed'))) continue;
      await endTurn(sessionId, turnId, 'interrupted', at).catch(() => undefined);
    }
  }
}
