import { resolve } from 'node:path';
import type { NativeActivity, NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import type { LaneWriter, SubagentInfo, TranscriptSource, TurnEndStatus } from '../../journal/ingest.js';
import { DshJobFeed, JOB_GRACE_MS, jobActivity, type JobWire } from './activities.js';
import { dshSubagentLink, projectDshEvent } from './events.js';
import type { DshLog, DshLogReader } from './log-store.js';
import type { DshObserver } from './runtime.js';
import { asRecord, nonEmpty } from './util.js';

/*
 * A DSH conversation as the session journal reads it (sync v3, journal/ingest.ts). DSH's own
 * persistence is an append-only log of records numbered by `seq` from 0, which is also the index:
 * committed records are never rewritten. So the cursor is the next `seq` to read (with the log's
 * `createdAt`, which tells a recreated session from the one that was read), every entity's id is the
 * one `projectDshEvent` derives from the record's `seq` plus its message id, call id or kind and part
 * (G2), turns are the log's own `turn/start` … `turn/end` brackets, whoever started them (G3), a
 * child session started by a `subagent` call is read into the lane of that call (G9), and DSH's
 * background jobs — the `job/registered` / `job/settled` records, and the bridge's `job/event`
 * notifications for jobs it never records — are activity states of the lane's ledger (G10).
 */

/** A first import of more records than this serves a tail window while the rest is imported (G4). */
const TAIL_OVER = 2_000;
/** Records the tail window holds at least; it starts where their turn starts, if that is in reach. */
const TAIL_RECORDS = 400;
/** Records of the main log imported per pull. */
const PULL_RECORDS = 1_000;
/** Events per commit; turn marks, activity states and child lanes are written between commits. */
const COMMIT_EVENTS = 200;
/** DSH puts live records on disk in batches of up to 200 ms, so a wake waits that out. */
const WAKE_DELAY_MS = 250;
/** Wakes spent waiting for records a notification announced before the disk shows them. */
const WAKE_RETRIES = 20;
/** `delegationDepth` DSH allows is far below this; it only bounds a malformed chain. */
const CHILD_DEPTH = 16;
/** A read gives the event loop back after about this long, between commits. */
const SLICE_MS = 20;
/** Records walked before a range between two chances to give the event loop back. */
const TICK_RECORDS = 1_000;
const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_fork']);

export interface DshTranscriptOptions {
  /** The workbench session the lanes belong to. */
  sessionId: string;
  /** The DSH session the conversation follows now. */
  nativeSessionId(): string;
  /** The workspace the conversation runs in; a stored log of another one is refused, as the bridge refuses it. */
  cwd(): string;
  logs: DshLogReader;
  /** The run a Riffet command id (a user message's `rpcId`) belongs to. */
  runOf(commandId: string): string | undefined;
  /** Bridge notifications of a DSH session, and reads the runtime makes anyway; see `DshProfileRuntime.observe`. */
  observe?(nativeSessionId: string, listener: DshObserver): () => void;
  /** What a failed turn says went wrong, as clients may see it. */
  failureMessage?(data: Record<string, unknown>): string | undefined;
}

/**
 * A turn the journal ended because DSH could not (its process went away inside it), kept in the cursor of
 * each lane that reads the log until DSH's own closing record of it is read; see `endOpenTurn`.
 */
interface EndedTurn { turn: string; time: string; error?: string }

interface Cursor { next: number; createdAt?: number; ended?: EndedTurn }

const encodeCursor = (next: number, createdAt: number | undefined, ended?: EndedTurn): string =>
  JSON.stringify({ next, ...(createdAt === undefined ? {} : { createdAt }), ...(ended ? { ended } : {}) });

function decodeCursor(value: string | null): Cursor | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as Cursor;
    if (Number.isSafeInteger(parsed.next) && parsed.next >= 0) return parsed;
  } catch { /* not one of ours */ }
  // A cursor this reader cannot place continues nothing.
  return { next: Number.POSITIVE_INFINITY };
}

const nextOf = (cursor: string | null): number => decodeCursor(cursor)?.next ?? 0;

/** Whether a lane read up to `cursor` was read from this very log: the same session, which only ever grew. */
function continues(cursor: string | null, log: DshLog): boolean {
  const at = decodeCursor(cursor);
  return !at || (at.createdAt === log.createdAt && at.next <= log.events.length);
}

interface Link { at: number; toolCallId: string; childId: string }

/** Where each `subagent` call of a log started its child session. */
function linksOf(records: readonly unknown[]): Link[] {
  const links: Link[] = [];
  records.forEach((record, at) => { const link = dshSubagentLink(record); if (link) links.push({ at, ...link }); });
  return links;
}

/** The turn a log ends inside, as {@link dshSteps} names it; undefined when its last turn has ended. */
function openTurnOf(records: readonly unknown[]): string | undefined {
  for (let at = records.length - 1; at >= 0; at -= 1) {
    const record = asRecord(records[at]);
    if (record?.type === 'turn/end') return undefined;
    if (record?.type === 'turn/start') return turnIdOf(asRecord(record.data)?.turn, at);
  }
  return undefined;
}

/** What the arguments of a `subagent` call say about the child it starts. */
function subagentInfo(call: Record<string, unknown> | undefined): SubagentInfo {
  let input: Record<string, unknown> | undefined;
  try { input = asRecord(JSON.parse(String(call?.arguments))); } catch { return {}; }
  const title = nonEmpty(input?.description), subagentType = nonEmpty(input?.agent_preset), model = nonEmpty(input?.model);
  return { ...(title ? { title } : {}), ...(subagentType ? { subagentType } : {}), ...(model ? { model } : {}) };
}

/** The first record of the tail window: the start of the turn its first records belong to, when that is in reach. */
function tailStart(records: readonly unknown[]): number {
  const floor = records.length - TAIL_RECORDS;
  for (let at = floor; at >= Math.max(0, records.length - TAIL_OVER); at -= 1) if (asRecord(records[at])?.type === 'turn/start') return at;
  return floor;
}

type DshStep =
  | { kind: 'event'; at: number; event: NativeWorkbenchEvent }
  | { kind: 'turn-start'; at: number; turnId: string; time: string; runId?: string }
  /** `closes`: DSH's own closing record of a turn the journal ended, which the cursor need not keep any longer. */
  | { kind: 'turn-end'; at: number; turnId: string; status: TurnEndStatus; time: string; error?: string; closes?: true }
  | { kind: 'activity'; at: number; activity: NativeActivity; time: Date }
  | { kind: 'child'; at: number; toolCallId: string; childId: string; info: SubagentInfo }
  /** Records before the range are walked for their context only; this lets the reader give the event loop back meanwhile. */
  | { kind: 'tick'; at: number };

interface StepContext {
  sessionId: string;
  runOf(commandId: string): string | undefined;
  failureMessage(data: Record<string, unknown>): string | undefined;
}

const turnIdOf = (turn: unknown, at: number): string => Number.isSafeInteger(turn) ? `turn-${String(turn)}` : `turn@${at}`;

function endStatus(data: Record<string, unknown>): TurnEndStatus {
  const kind = asRecord(data.reason)?.kind;
  if (kind === 'completed' || kind === 'max-tokens') return 'completed';
  if (kind === 'error' || kind === 'blocked') return 'failed';
  if (kind === 'aborted') return 'cancelled';
  return 'interrupted';
}

/** The Riffet command of the turn opening at `at`, when its first user message is already on disk. */
function openingCommand(records: readonly unknown[], at: number): string | undefined {
  for (let index = at + 1; index < Math.min(records.length, at + 64); index += 1) {
    const record = asRecord(records[index]);
    if (record?.type === 'turn/start' || record?.type === 'turn/end') return undefined;
    const source = asRecord(asRecord(record?.data)?.source);
    if (record?.type === 'user/message' && source?.kind === 'user') return nonEmpty(source.rpcId);
  }
  return undefined;
}

function jobOf(id: string, data: Record<string, unknown>, status: string): JobWire {
  return {
    id, kind: nonEmpty(data.kind) ?? 'job', label: typeof data.label === 'string' ? data.label.slice(0, 4096) : '', status,
    ...(typeof data.detail === 'string' ? { detail: data.detail.slice(0, 2048) } : {}),
    ...(typeof data.startedAt === 'number' ? { startedAt: data.startedAt } : {}),
    ...(typeof data.finishedAt === 'number' ? { finishedAt: data.finishedAt } : {}),
  };
}

/**
 * What records `from` … `to` of a log write, in transcript order. Turn and job state is followed from
 * the first record whatever `from` is, so the steps of a record never depend on where a read began:
 * a lane read in many pulls equals one read at once (G2, G7).
 *
 * A job is shown once it has lived {@link JOB_GRACE_MS} by the log's own clock — at the first record
 * that late, or at its settlement — so a command DSH waited for does not flash through the list.
 *
 * A turn the journal has `ended` ends as the journal ended it, at DSH's own closing record (written when
 * the session is resumed) or, while that is not on disk, at the end of the log.
 */
function* dshSteps(records: readonly unknown[], from: number, to: number, context: StepContext, ended?: EndedTurn): Generator<DshStep> {
  let turn: { id: string; time: string; commandId?: string; runRecorded: boolean } | undefined;
  const jobs = new Map<string, { job: JobWire; shown: boolean }>();
  const calls = new Map<string, Record<string, unknown>>();
  const endedAs = (at: number, turnId: string, closes: boolean): DshStep =>
    ({ kind: 'turn-end', at, turnId, status: 'interrupted', time: ended!.time, ...(ended!.error ? { error: ended!.error } : {}), ...(closes ? { closes: true as const } : {}) });
  for (let at = 0; at < to; at += 1) {
    if (at < from && at % TICK_RECORDS === TICK_RECORDS - 1) yield { kind: 'tick', at };
    const record = asRecord(records[at]);
    if (!record) continue;
    const data = asRecord(record.data) ?? {};
    const emit = at >= from;
    const ms = typeof record.time === 'number' && Number.isFinite(record.time) ? record.time : undefined;
    const time = new Date(ms ?? Date.now()).toISOString();
    const runOfTurn = () => turn?.commandId ? context.runOf(turn.commandId) : undefined;
    const project = (turnId: string, options: { runId?: string; commandId?: string; failureMessage?: string } = {}) =>
      projectDshEvent(record, { sessionId: context.sessionId, unbounded: true, ...options })
        .map(event => ({ ...event, sequence: 0, nativeTurnId: turnId }));
    switch (record.type) {
      case 'turn/start': {
        const commandId = emit ? openingCommand(records, at) : undefined;
        const runId = commandId ? context.runOf(commandId) : undefined;
        turn = { id: turnIdOf(data.turn, at), time, runRecorded: runId !== undefined };
        if (emit) yield { kind: 'turn-start', at, turnId: turn.id, time, ...(runId ? { runId } : {}) };
        break;
      }
      case 'turn/end': {
        const turnId = turn?.id ?? turnIdOf(data.turn, at);
        if (emit) {
          const runId = runOfTurn(), failureMessage = context.failureMessage(data);
          const options = { ...(runId ? { runId } : {}), ...(turn?.commandId ? { commandId: turn.commandId } : {}), ...(failureMessage ? { failureMessage } : {}) };
          for (const event of project(turnId, options)) yield { kind: 'event', at, event };
          yield turnId === ended?.turn ? endedAs(at, turnId, true) : { kind: 'turn-end', at, turnId, status: endStatus(data), time };
        }
        turn = undefined;
        break;
      }
      case 'job/registered': {
        const id = nonEmpty(data.jobId);
        if (id) jobs.set(id, { job: jobOf(id, data, 'running'), shown: false });
        break;
      }
      case 'job/settled': {
        const id = nonEmpty(data.jobId);
        if (!id) break;
        const known = jobs.get(id);
        jobs.delete(id);
        const job = jobOf(id, { ...data, startedAt: data.startedAt ?? known?.job.startedAt }, nonEmpty(data.status) ?? 'unknown');
        const lived = (job.finishedAt ?? Number.NaN) - (job.startedAt ?? Number.NaN);
        if (emit && (known?.shown || !(lived < JOB_GRACE_MS))) yield { kind: 'activity', at, activity: jobActivity(job), time: new Date(job.finishedAt ?? ms ?? Date.now()) };
        break;
      }
      case 'user/message':
      case 'assistant/message':
      case 'tool/call':
      case 'tool/result':
      case 'todo/write': {
        const source = asRecord(data.source);
        const human = record.type === 'user/message' && source?.kind === 'user';
        if (record.type === 'user/message' && !human) break;
        const first = human && turn !== undefined && turn.commandId === undefined;
        if (human && turn) turn.commandId = nonEmpty(source?.rpcId) ?? turn.commandId;
        if (record.type === 'tool/call' && SUBAGENT_TOOLS.has(String(data.name))) calls.set(String(data.callId), data);
        if (!emit) break;
        // Nothing DSH records lies outside a turn, but a record that did would still need one.
        const orphan = turn === undefined;
        const turnId = turn?.id ?? `turn@${at}`;
        const runId = runOfTurn();
        const events = project(turnId, runId ? { runId } : {});
        if (!events.length) break;
        if (orphan) yield { kind: 'turn-start', at, turnId, time };
        else if (first && runId && !turn!.runRecorded) {
          // The opening was read before its prompt reached the disk; the turn's run is known now.
          turn!.runRecorded = true;
          yield { kind: 'turn-start', at, turnId, time: turn!.time, runId };
        }
        for (const event of events) yield { kind: 'event', at, event };
        const link = dshSubagentLink(record);
        if (link) yield { kind: 'child', at, ...link, info: subagentInfo(calls.get(link.toolCallId)) };
        if (orphan) yield { kind: 'turn-end', at, turnId, status: 'completed', time };
        break;
      }
      default: break;
    }
    if (ms === undefined) continue;
    for (const item of jobs.values()) {
      if (item.shown || item.job.startedAt === undefined || ms - item.job.startedAt < JOB_GRACE_MS) continue;
      item.shown = true;
      if (emit) yield { kind: 'activity', at, activity: jobActivity(item.job), time: new Date(ms) };
    }
  }
  if (turn && turn.id === ended?.turn && to >= records.length) yield endedAs(to, turn.id, false);
}

interface Seen {
  revision: string;
  total: number;
  links: Link[];
  /** The turn the log ends inside, if any. */
  open?: string;
  /** Why this revision could not be read (a format the installed DSH refuses, another workspace); it is not tried again. */
  failure?: unknown;
}

/**
 * {@link TranscriptSource} over DSH's stored sessions, read in place through the DSH install's own
 * persistence reader: nothing is written to DSH's data and nothing starts DSH. `watch` follows the
 * bridge notifications and polls the runtime already makes; it adds no poller of its own.
 */
export class DshTranscriptSource implements TranscriptSource {
  /** Per DSH session: the revision last read in full, how many records it held, and its children. */
  private readonly seen = new Map<string, Seen>();
  private readonly runs = new Map<string, string | null>();
  private readonly context: StepContext;
  /** Live job states the bridge reports and DSH may never record, into the ledger of the log that serves. */
  private readonly jobs: DshJobFeed;
  private serving?: LaneWriter;
  private wake?: () => void;
  private timer?: NodeJS.Timeout;
  /** Records a notification said DSH committed; its disk may not show them yet. */
  private expected = { id: '', total: 0, retries: 0 };
  /** How long the last full read of the main log took; wakes are spaced so reading stays a small share. */
  private readMs = 0;
  /** The main log as last read, kept while an import reads it a step per pull rather than read whole for each. */
  private held?: { id: string; revision: string; log: DshLog; seen: Seen };

  constructor(private readonly options: DshTranscriptOptions) {
    this.context = {
      sessionId: options.sessionId,
      runOf: commandId => {
        if (!this.runs.has(commandId)) this.runs.set(commandId, options.runOf(commandId) ?? null);
        return this.runs.get(commandId) ?? undefined;
      },
      failureMessage: data => options.failureMessage?.(data),
    };
    this.jobs = new DshJobFeed(() => { const w = this.serving!; return (w.scratch ?? w).activities; });
  }

  identity(): string { return this.options.nativeSessionId(); }

  async pull(w: LaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }> {
    const id = this.identity();
    const main = await this.load(id, total => nextOf(w.cursor) < total || (w.scratch !== undefined && nextOf(w.scratch.cursor) < total));
    if (signal.aborted) return { caughtUp: false };
    if (!main) return { caughtUp: true };
    const { log, seen } = main;
    if (log) {
      const total = log.events.length;
      // The same id now names a session DSH created anew.
      if (!continues(w.cursor, log) || (w.scratch && !continues(w.scratch.cursor, log))) w.rebuild('identity-changed');
      if (w.cursor === null && !w.scratch && total > TAIL_OVER) await this.readRange(w.openScratch(), log, tailStart(log.events), total, signal);
      else if (w.scratch) await this.readRange(w.scratch, log, nextOf(w.scratch.cursor), total, signal);
      const from = nextOf(w.cursor);
      if (!signal.aborted) await this.readRange(w, log, from, Math.min(total, from + PULL_RECORDS), signal);
    }
    await this.pullChildren(w, seen, signal);
    if (this.expected.id === id && seen.total < this.expected.total && this.expected.retries++ < WAKE_RETRIES) this.schedule();
    const caughtUp = !signal.aborted && nextOf(w.cursor) >= seen.total;
    // Read to its end, the log is read again only once it changes: nothing of it need stay in memory.
    if (caughtUp) this.held = undefined;
    return { caughtUp };
  }

  async drain(w: LaneWriter): Promise<void> {
    const target = w.scratch ?? w;
    const loaded = await this.load(this.identity(), total => nextOf(target.cursor) < total);
    if (!loaded) return;
    if (loaded.log && continues(target.cursor, loaded.log)) await this.readRange(target, loaded.log, nextOf(target.cursor), loaded.log.events.length);
    await this.pullChildren(w, loaded.seen, new AbortController().signal);
  }

  /**
   * Ends the turn the log ends inside, which DSH itself only closes when the session is next resumed: its
   * process went away in it. What is on disk is read first (G6) and the end goes to the log that serves.
   * The cursors keep it, so DSH's closing record writes nothing new when it comes, and a lane still being
   * imported under a tail window ends the turn as well once it has read to the end. Resolves the turn ended.
   */
  async endOpenTurn(w: LaneWriter, at: string, error?: string): Promise<string | undefined> {
    await this.drain(w);
    const target = w.scratch ?? w;
    const seen = this.seen.get(this.identity());
    const read = decodeCursor(target.cursor);
    if (!seen?.open || !read || !Number.isFinite(read.next) || read.next < seen.total || read.ended?.turn === seen.open) return undefined;
    const ended: EndedTurn = { turn: seen.open, time: at, ...(error ? { error: error.slice(0, 1000) } : {}) };
    target.transaction(() => {
      for (const lane of target === w ? [w] : [target, w]) {
        const cursor = decodeCursor(lane.cursor);
        if (cursor && !Number.isFinite(cursor.next)) continue;
        lane.commit({ events: [], cursor: encodeCursor(cursor?.next ?? 0, cursor?.createdAt ?? read.createdAt, ended) });
      }
      target.turnEnded(ended.turn, 'interrupted', at, ended.error);
    });
    return ended.turn;
  }

  /** External turn-end settlement (G6 / D2): drains disk and records the ended turn on lane cursor(s) atomically. */
  async settleTurnEnd(w: LaneWriter, end: { turnId: string; status: TurnEndStatus; at: string; error?: string }): Promise<boolean> {
    await this.drain(w);
    const target = w.scratch ?? w;
    const seen = this.seen.get(this.identity());
    const read = decodeCursor(target.cursor);
    if (seen?.open !== end.turnId || !read || !Number.isFinite(read.next) || read.next < seen.total || read.ended?.turn === end.turnId) return false;
    const ended: EndedTurn = { turn: end.turnId, time: end.at, ...(end.error ? { error: end.error.slice(0, 1000) } : {}) };
    target.transaction(() => {
      for (const lane of target === w ? [w] : [target, w]) {
        const cursor = decodeCursor(lane.cursor);
        if (cursor && !Number.isFinite(cursor.next)) continue;
        lane.commit({ events: [], cursor: encodeCursor(cursor?.next ?? 0, cursor?.createdAt ?? read.createdAt, ended) });
      }
      target.turnEnded(end.turnId, end.status, end.at, end.error);
    });
    return true;
  }

  watch(w: LaneWriter, wake: () => void): () => void {
    this.serving = w;
    this.wake = wake;
    const id = this.identity();
    const stop = this.options.observe?.(id, (method, params) => this.noted(id, method, params));
    // DSH's own UI writes the log without any bridge seeing it; so does a child no bridge follows.
    const unwatch = this.options.logs.watch?.(changed => { if (changed === undefined || changed === id || this.seen.has(changed)) this.schedule(); });
    return () => {
      stop?.();
      unwatch?.();
      if (this.wake !== wake) return;
      this.wake = undefined;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.jobs.dispose();
    };
  }

  private noted(id: string, method: string, params: Record<string, unknown>): void {
    // Streamed text is not on disk until its record is, which arrives as a `session/event` of its own.
    if (method === 'agent/assistant-stream') return;
    if (method === 'job/event') this.jobs.onJobEvent(params);
    else if (method === 'bridge/closed') this.jobs.settle('unknown');
    const seq = asRecord(params.event)?.seq;
    if (method === 'session/event' && Number.isSafeInteger(seq)) {
      this.expected = { id, total: Math.max(this.expected.id === id ? this.expected.total : 0, (seq as number) + 1), retries: 0 };
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || !this.wake) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.wake?.(); }, Math.max(WAKE_DELAY_MS, Math.round(this.readMs * 4)));
    this.timer.unref?.();
  }

  /**
   * The log of DSH session `id` when it changed since it was last read, or when `needs` its records
   * (a lane has not read them all); otherwise only what is known of it. Undefined when DSH stores none.
   */
  private async load(id: string, needs: (total: number) => boolean): Promise<{ seen: Seen; log?: DshLog } | undefined> {
    const revision = await this.options.logs.revision(id);
    if (revision === undefined) return undefined;
    const known = this.seen.get(id);
    if (known?.revision === revision && known.failure !== undefined) throw known.failure;
    if (known?.revision === revision && !needs(known.total)) return { seen: known };
    if (this.held?.id === id && this.held.revision === revision && known === this.held.seen) return { seen: known, log: this.held.log };
    const started = performance.now();
    let log: DshLog | undefined;
    try {
      log = await this.options.logs.read(id);
      if (log && (log.cwd === undefined || resolve(log.cwd) !== resolve(this.options.cwd()))) {
        throw new AppError('NATIVE_SESSION_SCOPE_MISMATCH', 'DeepSeek Harness history is not bound to this workbench session and workspace.', 409);
      }
    } catch (failure) {
      this.seen.set(id, { revision, total: 0, links: [], failure });
      throw failure;
    }
    if (!log) return undefined;
    if (id === this.identity()) this.readMs = performance.now() - started;
    const open = openTurnOf(log.events);
    const seen: Seen = { revision, total: log.events.length, links: linksOf(log.events), ...(open ? { open } : {}) };
    this.seen.set(id, seen);
    if (id === this.identity()) this.held = { id, revision, log, seen };
    return { seen, log };
  }

  /** Every child a read of this lane (or of its tail window) has reached, read up to its end. */
  private async pullChildren(w: LaneWriter, seen: Seen, signal: AbortSignal, depth = 0): Promise<void> {
    if (depth >= CHILD_DEPTH) return;
    const read = nextOf(w.cursor), tail = w.scratch ? nextOf(w.scratch.cursor) : 0;
    for (const link of seen.links) {
      if (signal.aborted) return;
      const owner = link.at < read ? w : link.at < tail ? w.scratch : undefined;
      if (!owner) continue;
      const child = owner.child(link.toolCallId, link.childId);
      let loaded: Awaited<ReturnType<DshTranscriptSource['load']>>;
      // A child DSH cannot read is left out of the session, as a share leaves it out, until its log changes.
      try { loaded = await this.load(link.childId, total => nextOf(child.cursor) < total); } catch { continue; }
      if (!loaded || signal.aborted) continue;
      if (loaded.log) {
        if (!continues(child.cursor, loaded.log)) child.rebuild('identity-changed');
        await this.readRange(child, loaded.log, nextOf(child.cursor), loaded.log.events.length, signal);
      }
      await this.pullChildren(child, loaded.seen, signal, depth + 1);
    }
  }

  /**
   * Records `from` … `to` of `log` into `w`, committing as it goes; the cursor never passes what is in the
   * log. Between commits it gives the event loop back every {@link SLICE_MS}, and stops there once `signal` aborts.
   */
  private async readRange(w: LaneWriter, log: DshLog, from: number, to: number, signal?: AbortSignal): Promise<void> {
    let ended = decodeCursor(w.cursor)?.ended;
    let events: NativeWorkbenchEvent[] = [];
    let slice = performance.now();
    const flush = (at: number) => {
      const cursor = encodeCursor(at, log.createdAt, ended);
      if (events.length || cursor !== w.cursor) w.commit({ events, cursor });
      events = [];
    };
    const paused = async () => {
      if (performance.now() - slice < SLICE_MS) return false;
      await new Promise(resolve => setImmediate(resolve));
      slice = performance.now();
      return signal?.aborted === true;
    };
    for (const step of dshSteps(log.events, from, to, this.context, ended)) {
      if (step.kind === 'tick') {
        if (await paused()) return;
        continue;
      }
      if (step.kind === 'event') {
        events.push(step.event);
        if (events.length >= COMMIT_EVENTS) {
          flush(step.at);
          if (await paused()) return;
        }
        continue;
      }
      // What a mark follows is in the log first; a replay from the cursor redoes the mark, which then writes nothing.
      flush(step.at);
      if (step.kind === 'turn-start') w.turnStarted(step.turnId, step.time, step.runId);
      else if (step.kind === 'turn-end') {
        w.turnEnded(step.turnId, step.status, step.time, step.error);
        if (step.closes) ended = undefined;
      } else if (step.kind === 'activity') w.activities.apply(step.activity, step.time);
      else w.child(step.toolCallId, step.childId, step.info);
      if (await paused()) return;
    }
    flush(to);
  }
}
