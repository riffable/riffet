import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import type { NativeStatus, NativeWorkbenchEvent, Run, Session } from '../../../../packages/contracts/src/index.js';
import { SessionLock } from '../agent-host/session-lock.js';
import { CODEX_TRAITS } from '../backends/codex/index.js';
import type { NativeBackendTraits, NativeDispatchBinding } from '../backends/types.js';
import { AppError } from '../errors.js';
import { Store } from '../store.js';
import { NativeDispatcher, type DispatchObservation } from './dispatch.js';

/*
 * The delivery contract (docs/DELIVERY.md §2) under arbitrary interleavings. A simulated CLI takes the
 * place of a backend: every asynchronous step of a write, a steer or a stop is a gate the generated
 * schedule opens, fails or leaves closed, between user commands, CLI events, status pushes (which may
 * be late or never come), the clock and service restarts. Store, dispatcher, session actors and the
 * session lock are the real ones.
 *
 * CI runs a fixed seed. To look for new interleavings: RIFFET_PROPERTY_RUNS=5000 RIFFET_PROPERTY_SEED=<n>.
 * A failure prints the shrunk schedule and where every message ended up.
 */

const config = { model: 'sim', mode: 'agent' };
const IN_FLIGHT = ['dispatching', 'input_sent', 'observed', 'uncertain'];

interface Gate { label: string; resolve(): void; reject(error: Error): void }
type Fence = (info: { terminalId: string; epoch: number; chatId?: string; baselineSequence?: number }) => void;

/**
 * One conversation's CLI: at its prompt or running one turn. It writes its transcript and reports its status
 * only when the schedule says so; a read of `status()` or `snapshot()` always tells where it stands.
 */
abstract class SimCli {
  /** What reached the CLI, by command id. */
  readonly writes: string[] = [];
  readonly violations: string[] = [];
  gates: Gate[] = [];
  /** Fails the next write between its fence and the CLI: fenced, never written. */
  loseNextWrite = false;
  /** The running turn's screen shows no busy hint (Cursor after a stop and a send, docs/TURN-LIFECYCLE.md §1); cleared when it ends. */
  hidesTurn = false;
  /** Command ids whose turn the CLI actually ended. */
  readonly endedTurns: Set<string> = new Set();
  /** Command ids whose own turn the CLI showed busy, and whose own turn wrote output. */
  readonly shownBusy: Set<string> = new Set();
  readonly answered: Set<string> = new Set();
  /** The turn that ended last, which may still flush output or be named by a status that lags. */
  protected lastEnded: { id: string; ownerRunId: string; ownerCommandId: string } | undefined;
  protected readonly unechoed: Array<{ commandId: string; text: string; turnId: string }> = [];
  protected events: NativeWorkbenchEvent[] = [];
  protected sequence = 0;
  protected turn: { id: string; ownerRunId: string; ownerCommandId: string } | undefined;
  private turns = 0;
  private listener: ((message: DispatchObservation) => void) | undefined;

  constructor(protected readonly store: Store, protected readonly sessionId: string, readonly chatId: string) {}

  abstract traits(): NativeBackendTraits;
  async supportsInitialPromptArgs(): Promise<boolean> { return false; }
  async supportsSendNow(): Promise<boolean> { return false; }
  /** Status reads since the schedule last moved; a dispatcher that never comes to rest shows up here. */
  reads = 0;
  status(): NativeStatus {
    this.spinning();
    const busy = this.turn !== undefined && !this.hidesTurn;
    if (busy) this.shownBusy.add(this.turn!.ownerCommandId);
    return { phase: busy ? 'busy' : 'idle' };
  }
  /** What a status that lags says: the turn that just ended is still the one running. */
  protected staleStatus(): NativeStatus | undefined { return undefined; }
  protected spinning(): void { if (++this.reads > 20_000) throw new Error('The dispatcher keeps reading the status without coming to rest'); }
  async snapshot() { return { events: [...this.events], status: this.status(), nativeSessionId: this.chatId }; }
  /** Like the journal feed: the log so far and the status, once the subscriber is in place. */
  subscribe(_sessionId: string, listener: (message: DispatchObservation) => void) {
    this.listener = listener;
    queueMicrotask(() => {
      if (this.listener !== listener) return;
      listener({ type: 'events', events: [...this.events] });
      listener({ type: 'status', status: this.status() });
    });
    return () => { if (this.listener === listener) this.listener = undefined; };
  }
  /** Only the CLI knows whether the input reached it. */
  async canReleaseInput(_session: Session, run: Run): Promise<boolean> { return !this.writes.includes(run.commandId); }

  async interrupt(): Promise<void> {
    await this.gate('interrupt');
    this.ended('run_cancelled');
    this.over();
  }

  private over(): void {
    if (this.turn) this.endedTurns.add(this.turn.ownerCommandId);
    this.lastEnded = this.turn ?? this.lastEnded;
    this.turn = undefined;
    this.hidesTurn = false;
  }

  /** The CLI persists the oldest input it has not written to its transcript yet, however late. */
  echo(): void {
    const input = this.unechoed.shift();
    if (input) this.push(this.receipt(input));
  }

  /** The running turn answers and the CLI returns to its prompt. */
  finish(): void {
    if (this.turn === undefined) return;
    this.answered.add(this.turn.ownerCommandId);
    this.push([this.event('agent_message_chunk', { content: { text: 'done' } }, this.turn.id)]);
    this.ended('run_completed');
    this.over();
  }

  /** The provider notices where the CLI stands and says so. */
  publish(): void { this.emit({ type: 'status', status: this.status() }); }

  /**
   * Right after a stop (docs/TURN-LIFECYCLE.md T5): the stopped turn still flushes a line of output, and a status
   * that lags still names it as the running one, while the next message is already on its way.
   */
  straggle(): void {
    const ended = this.lastEnded;
    if (!ended) return;
    this.answered.add(ended.ownerCommandId);
    this.push([this.event('agent_message_chunk', { content: { text: 'late' } }, ended.id)]);
    const stale = this.staleStatus();
    if (stale) this.emit({ type: 'status', status: stale });
  }

  /** A restart: the service's side of every operation in flight is gone, the CLI is not. */
  detach(): void { this.gates = []; this.listener = undefined; }

  /** The fenced write itself. S1 and S3 are judged here, where the CLI takes the input. */
  protected write(run: { commandId: string; text: string }, startsTurn: Run | undefined): void {
    if (startsTurn) {
      const others = this.store.listUnfinishedNativeRuns(this.sessionId)
        .filter(other => other.commandId !== run.commandId && other.native!.intent !== 'steer' && !other.native!.queueReleasedAt && IN_FLIGHT.includes(other.native!.delivery));
      if (others.length) this.violations.push(`wrote ${run.commandId} while ${others.map(other => `${other.commandId} was ${other.native!.delivery}`).join(', ')}`);
    }
    if (this.loseNextWrite) { this.loseNextWrite = false; throw new Error('The connection went away'); }
    if (this.writes.includes(run.commandId)) this.violations.push(`wrote ${run.commandId} twice`);
    this.writes.push(run.commandId);
    if (startsTurn) this.turn = { id: `turn-${++this.turns}`, ownerRunId: startsTurn.id, ownerCommandId: run.commandId };
    this.unechoed.push({ ...run, turnId: this.turn!.id });
  }

  protected abstract receipt(input: { commandId: string; text: string; turnId: string }): NativeWorkbenchEvent[];
  /** What the provider records when a turn ends. */
  protected abstract ended(type: 'run_completed' | 'run_cancelled'): void;

  protected event(type: string, data: Record<string, unknown>, turnId?: string, nativeId?: string): NativeWorkbenchEvent {
    const sequence = ++this.sequence;
    return { sequence, nativeId: nativeId ?? `native-${sequence}`, sessionId: this.sessionId, type, ...(turnId ? { nativeTurnId: turnId } : {}), data, createdAt: new Date().toISOString() };
  }

  protected push(events: NativeWorkbenchEvent[]): void {
    this.events.push(...events);
    this.emit({ type: 'events', events });
  }

  protected gate(label: string): Promise<void> {
    return new Promise<void>((resolve, reject) => { this.gates.push({ label, resolve, reject }); });
  }

  private emit(message: DispatchObservation): void { this.listener?.(message); }
}

/**
 * A CLI driven through its terminal: the prompt is pasted and its echo carries no command id. Its driver reads each
 * turn's end from the CLI's own records (Cursor's store, a hook) and reports it by the turn, never by the screen.
 */
class TerminalCli extends SimCli {
  traits(): NativeBackendTraits { return { untaggedEcho: true }; }

  async deliver(session: Session, text: string, beforeWrite: Fence): Promise<void> {
    await this.gate('deliver:before');
    if (this.turn !== undefined) throw new AppError('CLI_BUSY', 'The CLI is running a turn', 409);
    beforeWrite({ terminalId: session.terminalId!, epoch: 1, chatId: this.chatId, baselineSequence: this.sequence });
    const run = this.store.listUnfinishedNativeRuns(this.sessionId).find(item => item.native!.delivery === 'dispatching' && item.native!.renderedText === text)!;
    this.write({ commandId: run.commandId, text }, run);
    await this.gate('deliver:after');
  }

  protected receipt(input: { text: string; turnId: string }): NativeWorkbenchEvent[] {
    return [this.event('user_message_chunk', { content: { text: input.text } }, input.turnId)];
  }

  protected ended(type: 'run_completed' | 'run_cancelled'): void {
    if (this.turn) this.push([this.event(type, { nativeSessionId: this.chatId, outcomeRevision: 1 }, this.turn.id, `end:${this.turn.id}`)]);
  }
}

/** A CLI driven through its protocol: sends and steers name their turn, echoes carry the command id, and the turn's end is an event. */
class ProtocolCli extends SimCli {
  traits(): NativeBackendTraits { return CODEX_TRAITS; }
  override status(): NativeStatus {
    this.spinning();
    if (this.turn) this.shownBusy.add(this.turn.ownerCommandId);
    return this.turn ? { phase: 'busy', activeTurn: { nativeSessionId: this.chatId, turnId: this.turn.id, ownerRunId: this.turn.ownerRunId } } : { phase: 'idle' };
  }
  protected override staleStatus(): NativeStatus | undefined {
    const ended = this.lastEnded;
    return ended ? { phase: 'busy', activeTurn: { nativeSessionId: this.chatId, turnId: ended.id, ownerRunId: ended.ownerRunId } } : undefined;
  }
  /** Whose turn is running now. */
  running(): string | undefined { return this.turn?.ownerCommandId; }
  async supportsSteer(): Promise<boolean> { return true; }

  async sendRun(_session: Session, run: Run, fence: (binding?: NativeDispatchBinding) => Run): Promise<void> {
    await this.gate('send:before');
    if (this.turn !== undefined) throw new AppError('CLI_BUSY', 'A turn is running', 409);
    fence({ backendId: 'codex', nativeSessionId: this.chatId, baselineSequence: this.sequence, renderedText: run.native!.input.text, resolvedConfig: config });
    this.write({ commandId: run.commandId, text: run.native!.input.text }, run);
    await this.gate('send:after');
  }

  async steerRun(_session: Session, run: Run, fence: (binding?: NativeDispatchBinding) => Run): Promise<void> {
    await this.gate('steer:before');
    if (!this.turn || this.turn.id !== run.native!.nativeTurnId) throw new AppError('STEER_TARGET_CHANGED', 'The turn ended', 409);
    fence({ backendId: 'codex', nativeSessionId: this.chatId, nativeTurnId: this.turn.id, ownerRunId: this.turn.ownerRunId, baselineSequence: this.sequence, renderedText: run.native!.input.text, resolvedConfig: config });
    this.write({ commandId: run.commandId, text: run.native!.input.text }, undefined);
    await this.gate('steer:after');
  }

  protected receipt(input: { commandId: string; text: string; turnId: string }): NativeWorkbenchEvent[] {
    return [this.event('user_message_chunk', { commandId: input.commandId, content: { text: input.text } }, input.turnId, `user:${input.commandId}`)];
  }

  /** As the journal feed reports a turn's end: once for the run that started it, once for the turn itself. */
  protected override ended(type: 'run_completed' | 'run_cancelled'): void {
    if (!this.turn) return;
    const owned = this.event(type, { commandId: this.turn.ownerCommandId, nativeSessionId: this.chatId, outcomeRevision: 1 }, this.turn.id, `end:${this.turn.id}`);
    this.push([{ ...owned, runId: this.turn.ownerRunId }, { ...owned, data: { nativeSessionId: this.chatId, outcomeRevision: 1 } }]);
  }
}

type Command =
  | { kind: 'send' | 'steer' | 'echo' | 'finish' | 'publish' | 'stop' | 'restart' | 'loseWrite' | 'hide' | 'straggle' }
  | { kind: 'open' | 'break' | 'cancel' | 'sendNow' | 'recover'; pick: number }
  | { kind: 'advance'; ms: number };

const pick = (kind: 'open' | 'break' | 'cancel' | 'sendNow' | 'recover') => fc.nat(3).map(index => ({ kind, pick: index }) as Command);
const commandsWith = (...extra: Array<{ weight: number; arbitrary: fc.Arbitrary<Command> }>): fc.Arbitrary<Command> => fc.oneof(
  { weight: 6, arbitrary: fc.constant<Command>({ kind: 'send' }) },
  { weight: 3, arbitrary: fc.constant<Command>({ kind: 'steer' }) },
  { weight: 8, arbitrary: pick('open') },
  { weight: 1, arbitrary: pick('break') },
  { weight: 4, arbitrary: fc.constant<Command>({ kind: 'echo' }) },
  { weight: 4, arbitrary: fc.constant<Command>({ kind: 'finish' }) },
  { weight: 5, arbitrary: fc.constant<Command>({ kind: 'publish' }) },
  // Either side of the retry delay, the idle windows, the receipt window and the busy limit.
  { weight: 3, arbitrary: fc.constantFrom(1, 600, 2_000, 16_000, 31_000, 61_000, 181_000).map(ms => ({ kind: 'advance', ms }) as Command) },
  { weight: 2, arbitrary: fc.constant<Command>({ kind: 'stop' }) },
  { weight: 1, arbitrary: pick('cancel') },
  { weight: 1, arbitrary: pick('sendNow') },
  { weight: 1, arbitrary: pick('recover') },
  { weight: 1, arbitrary: fc.constant<Command>({ kind: 'restart' }) },
  { weight: 1, arbitrary: fc.constant<Command>({ kind: 'loseWrite' }) },
  { weight: 2, arbitrary: fc.constant<Command>({ kind: 'straggle' }) },
  ...extra,
);
const command = commandsWith();
const hidingCommand = commandsWith({ weight: 3, arbitrary: fc.constant<Command>({ kind: 'hide' }) });

/** Lets every promise chain already able to run do so, and fires timers that are due. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

class World {
  readonly store = new Store(':memory:');
  readonly session: Session;
  readonly cli: TerminalCli | ProtocolCli;
  readonly problems: string[] = [];
  private dispatcher: NativeDispatcher;
  private sent = 0;

  constructor(transport: 'terminal' | 'protocol') {
    const project = this.store.createProject(`/tmp/dispatch-property-${randomUUID()}`, 'Dispatch property');
    const chatId = `chat-${randomUUID()}`;
    const created = this.store.createSession({ projectId: project.id, kind: 'native', backendId: transport === 'protocol' ? 'codex' : 'cursor', model: config.model, mode: config.mode, nativeSessionId: chatId });
    this.session = this.store.updateSession(created.id, { terminalId: `terminal-${created.id}` });
    this.store.saveTerminal({ id: this.session.terminalId!, projectId: project.id, sessionId: this.session.id, title: 'Sim', kind: 'cursor', state: 'running', persistent: true, epoch: 1, cols: 80, rows: 24, createdAt: new Date(0).toISOString() });
    this.cli = new (transport === 'protocol' ? ProtocolCli : TerminalCli)(this.store, this.session.id, chatId);
    this.dispatcher = this.start();
  }

  private start(): NativeDispatcher {
    const lock = new SessionLock();
    const runtime = { withSession: <T>(id: string, operation: () => Promise<T>) => lock.withSession(id, operation), ensure: async () => undefined };
    const workspace = { readAttachment: async () => { throw new Error('No attachments here'); } };
    return new NativeDispatcher(this.store, this.cli as never, runtime as never, workspace as never);
  }

  /** Deliberately one character apart: a receipt must still be bound to its own message (`samePromptText`). */
  private input() { return { text: `message ${this.sent}`, attachmentIds: [], context: [] }; }
  private runs(): Run[] { return this.store.listRuns(this.session.id).filter(run => run.native); }
  private unfinished(): Run[] { return this.store.listUnfinishedNativeRuns(this.session.id); }
  private queued(): Run[] { return this.unfinished().filter(run => run.native!.delivery === 'queued'); }

  async apply(step: Command): Promise<void> {
    const id = this.session.id, ignore = () => undefined;
    this.cli.reads = 0;
    if (step.kind === 'send') {
      this.store.acceptNativeRun(id, `command-${++this.sent}`, this.input(), config, 0);
      this.dispatcher.kick(id);
    } else if (step.kind === 'steer') {
      // As the steer route does: only a turn the provider reports can be steered.
      const active = this.cli.status().activeTurn;
      if (active && this.cli instanceof ProtocolCli) {
        const run = this.store.acceptNativeRun(id, `command-${++this.sent}`, this.input(), config, undefined, { target: { nativeSessionId: active.nativeSessionId, turnId: active.turnId }, ...(active.ownerRunId ? { ownerRunId: active.ownerRunId } : {}) });
        try { void this.dispatcher.steer(id, run.id).catch(ignore); } catch { /* refused before it started */ }
      }
    } else if (step.kind === 'open') this.cli.gates.splice(step.pick % Math.max(1, this.cli.gates.length), 1)[0]?.resolve();
    else if (step.kind === 'break') this.cli.gates.splice(step.pick % Math.max(1, this.cli.gates.length), 1)[0]?.reject(new Error('The backend call failed'));
    else if (step.kind === 'echo') this.cli.echo();
    else if (step.kind === 'finish') this.cli.finish();
    else if (step.kind === 'publish') this.cli.publish();
    else if (step.kind === 'loseWrite') this.cli.loseNextWrite = true;
    else if (step.kind === 'hide') this.cli.hidesTurn = true;
    else if (step.kind === 'straggle') this.cli.straggle();
    else if (step.kind === 'advance') await vi.advanceTimersByTimeAsync(step.ms);
    else if (step.kind === 'stop') {
      // A3: a stop that reports success has settled everything that was running.
      void this.dispatcher.interrupt(id).then(() => {
        const running = this.unfinished().filter(run => run.state === 'running');
        if (running.length) this.problems.push(`stop resolved with ${running.map(run => run.commandId).join(', ')} still running`);
      }, ignore);
    } else if (step.kind === 'cancel') {
      const run = this.queued()[step.pick];
      if (run) { try { this.dispatcher.cancel(id, run.id); } catch { /* already on its way */ } }
    } else if (step.kind === 'sendNow') {
      const run = this.queued()[step.pick];
      if (run) void this.dispatcher.sendQueuedNow(id, run.id).catch(ignore);
    } else if (step.kind === 'recover') this.recover(step.pick);
    else if (step.kind === 'restart') {
      void this.dispatcher.close();
      this.cli.detach();
      this.store.recoverInterruptedRuns();
      this.dispatcher = this.start();
      this.dispatcher.kick();
    }
    await settle();
    this.check(step);
  }

  /** What the user does with a message whose delivery is unknown: check it, and let the queue go on when the CLI never got it. */
  private recover(index: number): void {
    const run = this.unfinished().filter(item => item.native!.delivery === 'uncertain' && !item.native!.queueReleasedAt)[index];
    if (!run) return;
    const dispatcher = this.dispatcher, ignore = () => undefined;
    // Not awaited: the release takes the session lock, which an operation still behind a gate may hold.
    void dispatcher.check(this.session.id, run.id).then(checked => checked.canContinue ? dispatcher.continue(this.session.id, run.id, checked.queuedRunIds) : undefined).catch(ignore);
  }

  private check(after: Command): void {
    const found = [...this.cli.violations, ...this.problems];
    // T3/T4 (docs/TURN-LIFECYCLE.md §3): a message completes only once the CLI has ended the turn it started.
    for (const run of this.runs()) {
      if (run.state === 'completed' && !run.native!.intent && !this.cli.endedTurns.has(run.commandId)) found.push(`${run.commandId} completed while its turn was still running`);
      // T5: what a message records of its turn comes from that turn, not from the one stopped before it.
      const timings = run.native!.timings ?? {};
      if (!run.native!.intent && timings.firstOutputAt !== undefined && !this.cli.answered.has(run.commandId)) found.push(`${run.commandId} took output from another turn`);
      if (!run.native!.intent && timings.busyAt !== undefined && !this.cli.shownBusy.has(run.commandId)) found.push(`${run.commandId} took a busy status from another turn`);
      // A status that lags behind a stop names a turn that is over: it does not close the next one as superseded.
      if (this.cli instanceof ProtocolCli && run.native!.stage === 'turn_outcome_unknown' && this.cli.running() === run.commandId) found.push(`${run.commandId} closed as unconfirmed while its turn was still running`);
    }
    if (found.length) throw new Error(`after ${JSON.stringify(after)}: ${found.join('; ')}`);
  }

  /** The schedule is over: every operation completes, the CLI finishes what it has, the user settles what is unknown. */
  async quiesce(): Promise<void> {
    let before = '';
    // One turn ends per round, so the rounds follow the number of messages.
    for (let round = 0, steady = 0; round < 12 + 2 * this.sent && steady < 2; round++) {
      const opened: string[] = [];
      while (this.cli.gates.length) {
        const gate = this.cli.gates.shift()!;
        opened.push(gate.label);
        // An operation that is retried the moment it returns never lets the conversation come to rest.
        if (opened.length > 200) throw new Error(`operations keep starting without the clock moving: ${opened.slice(-6).join(', ')}\n${this.outcome().join('\n')}`);
        gate.resolve();
        await settle();
      }
      for (let echoes = 0; echoes < 50; echoes++) this.cli.echo();
      this.cli.finish();
      await settle();
      for (let index = 0; index < 4; index++) { this.recover(index); await settle(); }
      this.cli.reads = 0;
      // Past the busy limit, the receipt window and both idle windows.
      await vi.advanceTimersByTimeAsync(200_000);
      await settle();
      const now = this.outcome().join('\n');
      steady = now === before && !this.cli.gates.length ? steady + 1 : 0;
      before = now;
    }
    this.check({ kind: 'advance', ms: 0 });
  }

  /** Where every message ended up, as lines a failure can show. */
  outcome(): string[] {
    return this.runs().map(run => `${run.commandId}${run.native!.intent ? ` (${run.native!.intent})` : ''}: ${run.state} ${run.native!.delivery}${run.native!.stage ? `/${run.native!.stage}` : ''}${run.native!.queueReleasedAt ? ' released' : ''}${this.cli.writes.includes(run.commandId) ? ' written' : ''}`);
  }

  async close(): Promise<void> {
    void this.dispatcher.close();
    this.cli.detach();
    await settle();
    this.store.close();
  }
}

describe('NativeDispatcher delivery under arbitrary interleavings', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(['terminal', 'protocol'] as const)('writes each message at most once, one turn at a time, and leaves nothing behind (%s CLI)', async transport => {
    await fc.assert(fc.asyncProperty(fc.array(command, { maxLength: 60, size: '+1' }), async schedule => {
      const world = new World(transport);
      try {
        for (const step of schedule) await world.apply(step);
        await world.quiesce();
        const outcome = world.outcome();
        // S1 across the whole run, restarts included.
        expect(new Set(world.cli.writes).size, outcome.join('\n')).toBe(world.cli.writes.length);
        for (const line of outcome) {
          // L1: nothing is left waiting, in flight or running once the CLI is idle and the user has settled every unknown.
          expect(line, outcome.join('\n')).not.toMatch(/: (queued|running) |(preparing|dispatching|input_sent)/);
          // A message that completed reached the CLI; one the user took back never did.
          if (line.includes(': completed ')) expect(line, outcome.join('\n')).toContain(' written');
          if (line.includes(': cancelled ')) expect(line, outcome.join('\n')).not.toContain(' written');
        }
        // An unknown delivery the user has not released is the only thing that may remain open.
        expect(outcome.filter(line => line.includes(' uncertain') && !line.includes(' released') && !line.includes(' written')), outcome.join('\n')).toEqual([]);
        expect(vi.getTimerCount(), outcome.join('\n')).toBe(0);
      } finally {
        await world.close();
      }
    }), { numRuns: Number(process.env.RIFFET_PROPERTY_RUNS ?? 300), seed: Number(process.env.RIFFET_PROPERTY_SEED ?? 20261120) });
  }, 60_000 + Number(process.env.RIFFET_PROPERTY_RUNS ?? 300) * 100);

  // The sample failure of docs/TURN-LIFECYCLE.md §1: an idle screen names no turn and completes nothing (T4).
  it('completes a message only after the CLI ended its turn, even when the screen shows no busy hint (terminal CLI)', async () => {
    await fc.assert(fc.asyncProperty(fc.array(hidingCommand, { maxLength: 60, size: '+1' }), async schedule => {
      const world = new World('terminal');
      try {
        for (const step of schedule) await world.apply(step);
        await world.quiesce();
      } finally {
        await world.close();
      }
    }), { numRuns: Number(process.env.RIFFET_PROPERTY_RUNS ?? 300), seed: Number(process.env.RIFFET_PROPERTY_SEED ?? 20261120) });
  }, 60_000 + Number(process.env.RIFFET_PROPERTY_RUNS ?? 300) * 100);
});
