import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  COUNCIL_BUDGET,
  type CouncilCreateRequest,
  type CouncilDiscussion,
  type CouncilExportRequest,
  type CouncilExportResult,
  type CouncilFormat,
  type CouncilContinueRequest,
  type CouncilPatchRequest,
  type CouncilPrompts,
  type CouncilRole,
  type CouncilSeat,
  type CouncilSpeech,
  type CouncilSpeechRows,
  type CouncilStreamEvent,
  type CouncilSummary,
  type NativeBackendId,
} from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { directiveFor, parseJsonObject } from './directive.js';
import { compose, FORMATS, recordTurn, REVIEW_TASKS, type SpeechSpec } from './formats/index.js';
import type { SeatDriver } from './seats.js';
import { CouncilStore } from './store.js';

export interface CouncilExportHandlers {
  createWorkItem(input: { title: string; body: string; projectId?: string }): string;
  openSession(input: { title: string; prompt: string; projectId?: string; backendId?: NativeBackendId; model?: string }): Promise<string>;
}

export interface CouncilServiceDeps {
  db: DatabaseSync;
  seats: SeatDriver;
  /** The name of an Agent profile a seat may run on; undefined when there is no such profile. */
  profileName(backendId: NativeBackendId, profileId: string): string | undefined;
  exports?: CouncilExportHandlers;
  log?(message: string, fields: Record<string, unknown>): void;
}

type Listener = (event: CouncilStreamEvent) => void;

/** A discussion being run: the one object every change goes through until the run ends. */
interface Live {
  discussion: CouncilDiscussion;
  controller: AbortController;
  /** Seat turns in flight, speeches and their notes alike: run id to conversation. */
  turns: Map<string, string>;
  /** Only a notes turn runs again: the discussion keeps its status, and a stop leaves it as it was. */
  recordOnly?: boolean;
}

/** Seat roles each format takes, with how many of each and the ids they get. */
const SEATS: Record<CouncilFormat, Array<{ role: CouncilRole; min: number; max: number; id: string | ((index: number) => string) }>> = {
  ld: [{ role: 'pro', min: 1, max: 1, id: 'pro' }, { role: 'con', min: 1, max: 1, id: 'con' }, { role: 'judge', min: 1, max: 1, id: 'judge' }],
  roundtable: [{ role: 'debater', min: 2, max: 6, id: i => `s${i + 1}` }, { role: 'moderator', min: 1, max: 1, id: 'mod' }],
  prism: [{ role: 'participant', min: 2, max: 4, id: i => `p${i + 1}` }, { role: 'observer', min: 1, max: 1, id: 'obs' }],
  review: [{ role: 'reviewer', min: 1, max: 4, id: i => `r${i + 1}` }, { role: 'editor', min: 1, max: 1, id: 'ed' }],
};
const DEFAULT_ROUNDS: Record<CouncilFormat, number> = { ld: 4, roundtable: 3, prism: 2, review: 2 };

const now = () => new Date().toISOString();
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

function splitParagraphs(text: string): Array<{ id: string; text: string }> {
  let blocks = text.split(/\n\s*\n/).map(chunk => chunk.trim()).filter(Boolean);
  if (blocks.length <= 1) blocks = text.split('\n').map(line => line.trim()).filter(Boolean);
  const kept = blocks.slice(0, COUNCIL_BUDGET.documentParagraphs - 1);
  const rest = blocks.slice(COUNCIL_BUDGET.documentParagraphs - 1).join('\n\n');
  return [...kept, ...(rest ? [rest] : [])].map((block, i) => ({ id: `P${i + 1}`, text: block }));
}

function titleOf(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return line.length <= 80 ? line : `${line.slice(0, 80)}…`;
}

export class CouncilService {
  private readonly store: CouncilStore;
  private readonly live = new Map<string, Live>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly changeListeners = new Set<() => void>();
  /** The status last announced per discussion, so only a change of it notifies. */
  private readonly announced = new Map<string, CouncilDiscussion['status']>();
  private changeTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: CouncilServiceDeps) {
    this.store = new CouncilStore(deps.db);
    // A server stop ends every run; the discussion waits to be continued, the cut speech reruns then. Turns the seats
    // still have unfinished are cancelled so they do not go on consuming quota.
    for (const d of this.store.running()) {
      for (const s of d.speeches) if (s.status === 'streaming' || s.status === 'waiting') s.status = 'stopped';
      d.status = 'paused';
      d.settledAt = now();
      this.store.save(d);
      for (const seat of d.seats) {
        if (!seat.sessionId) continue;
        try { deps.seats.stopAll(seat.sessionId); } catch (error) { deps.log?.('council: a seat turn was left running', { sessionId: seat.sessionId, error: messageOf(error) }); }
      }
    }
  }

  close(): void {
    for (const live of this.live.values()) live.controller.abort(new Error('Service closed'));
    this.live.clear();
    this.listeners.clear();
    this.changeListeners.clear();
    clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
  }

  /**
   * Fires, debounced, when a discussion is created or deleted, changes status, or its `seenAt` changes: what the
   * sidebar list shows. Returns how to stop listening.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  private changed(): void {
    if (this.changeTimer || !this.changeListeners.size) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      for (const listener of this.changeListeners) {
        try { listener(); } catch { /* the subscriber went away */ }
      }
    }, 100);
    this.changeTimer.unref?.();
  }

  /** The discussion stopped running: from now it waits for the reader. */
  private settle(d: CouncilDiscussion): void {
    d.settledAt = now();
  }

  /** Removes the seats' conversations of a discussion that went; one that cannot be removed now is an orphan the next start removes. */
  private removeSeats(d: CouncilDiscussion): void {
    for (const sessionId of this.sessionsOf(d)) {
      void this.deps.seats.remove(sessionId).catch(error => this.deps.log?.('council: a seat conversation was left', { sessionId, error: messageOf(error) }));
    }
  }

  /**
   * Every conversation the discussion spoke in: the seats' current ones, and earlier ones a speech's turn still points
   * to (a seat whose model was swapped, or whose conversation was archived and opened anew). Their speeches' process
   * and input are read from them, so they go only with the discussion.
   */
  private sessionsOf(d: CouncilDiscussion): Set<string> {
    const sessions = new Set(d.seats.flatMap(seat => (seat.sessionId ? [seat.sessionId] : [])));
    for (const speech of d.speeches) {
      for (const runId of [speech.runId, speech.recordRunId]) {
        const sessionId = runId ? this.deps.seats.sessionOf(d.id, runId) : undefined;
        if (sessionId) sessions.add(sessionId);
      }
    }
    return sessions;
  }

  subscribe(id: string, listener: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, set = new Set());
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(id);
    };
  }

  private emit(id: string, event: CouncilStreamEvent): void {
    for (const listener of this.listeners.get(id) ?? []) {
      try { listener(event); } catch { /* the stream closed */ }
    }
  }

  list(): CouncilSummary[] {
    return this.store.list();
  }

  get(id: string): CouncilDiscussion {
    const found = this.live.get(id)?.discussion ?? this.store.get(id);
    if (!found) throw new AppError('COUNCIL_NOT_FOUND', 'Discussion not found', 404);
    return found;
  }

  /** Whether a seat conversation's discussion still exists: one whose discussion is gone is an orphan. */
  has(id: string): boolean {
    return this.live.has(id) || Boolean(this.store.get(id));
  }

  /** Whether a seat of discussion `id` holds conversation `sessionId`; one created as the server stopped is held by none. */
  holds(id: string, sessionId: string): boolean {
    const d = this.store.get(id);
    return Boolean(d && this.sessionsOf(d).has(sessionId));
  }

  /** Generate a current brief, or retrieve historical inputs by their persisted run identities. */
  prompts(id: string, seatId: string, speechId?: string): CouncilPrompts {
    const discussion = this.get(id);
    const seat = discussion.seats.find((item) => item.id === seatId);
    if (!seat) throw new AppError('INVALID_COUNCIL_SEATS', 'Unknown seat', 404);
    if (speechId === undefined) return { prompt: FORMATS[discussion.format].brief(discussion, seat) };
    const speech = discussion.speeches.find((item) => item.id === speechId && item.seatId === seatId);
    if (!speech) throw new AppError('COUNCIL_SPEECH_NOT_FOUND', 'Speech not found', 404);
    return {
      prompt: speech.runId && this.deps.seats.prompt(id, speech.runId),
      record: speech.recordRunId && this.deps.seats.prompt(id, speech.recordRunId),
    };
  }

  /** The rows of a speech's turn, for a reader who opens it. */
  async speechRows(id: string, speechId: string): Promise<CouncilSpeechRows> {
    const d = this.get(id);
    const speech = d.speeches.find(item => item.id === speechId);
    if (!speech) throw new AppError('COUNCIL_SPEECH_NOT_FOUND', 'Speech not found', 404);
    return { rows: speech.runId ? await this.deps.seats.rows(id, speech.runId) : [] };
  }

  create(req: CouncilCreateRequest): CouncilDiscussion {
    const format = req?.format;
    if (!format || !(format in FORMATS)) throw new AppError('INVALID_COUNCIL_FORMAT', 'Unknown discussion format');
    const topic = typeof req.topic === 'string' ? req.topic.trim() : '';
    const document = format === 'review' && typeof req.document === 'string' ? req.document.trim() : '';
    if (format === 'review' ? !document : !topic) throw new AppError('INVALID_COUNCIL_TOPIC', format === 'review' ? 'Paste a document to review' : 'Enter a topic');
    if (topic.length > COUNCIL_BUDGET.topicChars) throw new AppError('INVALID_COUNCIL_TOPIC', 'The topic is too long');
    if (document.length > COUNCIL_BUDGET.documentChars) throw new AppError('INVALID_COUNCIL_DOCUMENT', 'The document is too long');

    const requested = Array.isArray(req.seats) ? req.seats : [];
    if (requested.length > COUNCIL_BUDGET.seats) throw new AppError('INVALID_COUNCIL_SEATS', 'Too many models');
    const seats: CouncilSeat[] = [];
    for (const rule of SEATS[format]) {
      const picked = requested.filter(s => s?.role === rule.role);
      if (picked.length < rule.min || picked.length > rule.max) throw new AppError('INVALID_COUNCIL_SEATS', `Choose ${rule.min === rule.max ? rule.min : `${rule.min}–${rule.max}`} ${rule.role} model(s)`);
      picked.forEach((s, index) => {
        const agent = s.model;
        const profileName = agent && typeof agent.backendId === 'string' && typeof agent.profileId === 'string'
          ? this.deps.profileName(agent.backendId, agent.profileId)
          : undefined;
        if (!profileName) throw new AppError('COUNCIL_AGENT_UNAVAILABLE', 'A chosen Agent is not available', 409);
        const model = typeof agent.model === 'string' && agent.model.trim() ? agent.model.trim().slice(0, 200) : undefined;
        seats.push({
          id: typeof rule.id === 'string' ? rule.id : rule.id(index),
          role: rule.role,
          model: { backendId: agent.backendId, profileId: agent.profileId, ...(model ? { model } : {}) },
          profileName,
          ...(rule.role === 'reviewer' ? { task: REVIEW_TASKS.includes(s.task!) ? s.task! : REVIEW_TASKS[index % REVIEW_TASKS.length]! } : {}),
        });
      });
    }

    const rounds = format === 'ld' || format === 'roundtable'
      ? Math.min(COUNCIL_BUDGET.maxRounds, Math.max(COUNCIL_BUDGET.minRounds, Math.trunc(req.maxRounds ?? DEFAULT_ROUNDS[format])))
      : DEFAULT_ROUNDS[format];
    const createdAt = now();
    const d: CouncilDiscussion = {
      id: `council_${randomUUID().slice(0, 12)}`,
      format,
      title: format === 'review' ? (req.documentTitle?.trim() || titleOf(document)) : titleOf(topic),
      topic: format === 'review' ? (req.documentTitle?.trim() ?? '') : topic,
      ...(format === 'review' ? { document: { ...(req.documentTitle?.trim() ? { title: req.documentTitle.trim() } : {}), paragraphs: splitParagraphs(document) } } : {}),
      seats,
      maxRounds: rounds,
      rhythm: req.rhythm === 'auto' ? 'auto' : 'pause',
      status: 'running',
      round: 1,
      speeches: [],
      supplements: [],
      version: 0,
      createdAt,
      updatedAt: createdAt,
    };
    this.store.save(d);
    for (const pruned of this.store.pruneOldest()) {
      const held = this.halt(pruned.id)?.discussion ?? pruned;
      this.announced.delete(pruned.id);
      this.removeSeats(held);
    }
    this.start(d);
    this.changed();
    return d;
  }

  delete(id: string): void {
    const d = this.get(id);
    this.halt(id);
    if (!this.store.delete(id)) throw new AppError('COUNCIL_NOT_FOUND', 'Discussion not found', 404);
    this.announced.delete(id);
    this.removeSeats(d);
    this.changed();
  }

  /** Stops the run; speeches cut off are marked and rerun when the discussion continues. */
  stop(id: string): CouncilDiscussion {
    const live = this.halt(id);
    if (!live) return this.get(id);
    const d = live.discussion;
    if (live.recordOnly) return this.commit(d);
    for (const s of d.speeches) {
      if (s.status === 'streaming' || s.status === 'waiting') {
        s.status = 'stopped';
        s.endedAt = now();
      }
    }
    d.status = 'paused';
    this.settle(d);
    return this.commit(d);
  }

  continue(id: string, action: NonNullable<CouncilContinueRequest['action']> = 'next', speechId?: string): CouncilDiscussion {
    if (this.live.has(id)) throw new AppError('COUNCIL_BUSY', 'The discussion is already running', 409);
    if (action === 'record') return this.rerunRecord(id, speechId);
    const d = this.get(id);
    if (d.status === 'done') throw new AppError('COUNCIL_DONE', 'The discussion has ended', 409);
    d.speeches = d.speeches.filter(s => s.status !== 'stopped');
    if (d.status === 'failed') {
      // Retry the step that failed as a whole.
      const last = d.speeches.at(-1);
      if (last) d.speeches = d.speeches.filter(s => !(s.status === 'failed' && s.round === last.round && s.phase === last.phase));
    }
    const format = FORMATS[d.format];
    if (format.plan(d).kind === 'round-end') {
      if (action === 'conclude') format.conclude(d);
      // As the run loop would have at this round's end (a review on `auto` accepts every edit).
      if (d.rhythm === 'auto') format.autoAdvance?.(d);
      this.advanceRound(d);
    }
    this.start(d);
    return d;
  }

  /** A roundtable that concludes writes its conclusion in the round it ends, not in one that never ran. */
  private advanceRound(d: CouncilDiscussion): void {
    if (!(d.format === 'roundtable' && d.concluding)) d.round += 1;
  }

  /** Runs again only the notes turn of a speech whose notes are missing, in the seat's own conversation. */
  private rerunRecord(id: string, speechId: string | undefined): CouncilDiscussion {
    const d = this.get(id);
    const speech = d.speeches.find(item => item.id === speechId);
    if (!speech) throw new AppError('COUNCIL_SPEECH_NOT_FOUND', 'Speech not found', 404);
    if (speech.status !== 'done' || !speech.recordError) throw new AppError('COUNCIL_RECORD_NOT_NEEDED', 'This speech has no missing notes', 409);
    const seat = d.seats.find(item => item.id === speech.seatId)!;
    // The notes request asks about the speech just given, so only the seat's latest speech can be asked again.
    if (d.speeches.findLast(item => item.seatId === seat.id && item.status === 'done') !== speech) {
      throw new AppError('COUNCIL_RECORD_STALE', 'The seat has spoken since; its notes for this speech cannot be asked again', 409);
    }
    if (!seat.sessionId || !this.deps.seats.alive(seat.sessionId)) throw new AppError('COUNCIL_SEAT_GONE', 'The seat\'s conversation is gone', 409);
    const recordPrompt = this.recordPromptOf(d, speech);
    if (!recordPrompt) throw new AppError('COUNCIL_RECORD_UNAVAILABLE', 'The notes of this speech cannot be requested again', 409);

    // The status stays: a stop or a restart midway leaves the discussion as it was (a finished one stays finished).
    d.version += 1;
    const live: Live = { discussion: d, controller: new AbortController(), turns: new Map(), recordOnly: true };
    this.live.set(id, live);
    this.commit(d);
    void (async () => {
      let directive: CouncilSpeech['directive'];
      try { directive = await this.record(live, seat, speech.phase, recordPrompt, speech); } catch { /* recorded on the speech */ }
      if (!this.current(live)) return;
      this.live.delete(id);
      if (directive) speech.directive = directive;
      // A review that ended without edits because their notes were missing can go on to accept them.
      if (d.status === 'done' && d.format === 'review' && directive && !d.speeches.some(s => s.phase === 'conclusion')) {
        d.round = 1;
        d.status = 'paused';
        this.settle(d);
      }
      this.commit(d);
    })();
    return d;
  }

  /** The notes request of a finished speech, read off the plan as it stood before the speech. */
  private recordPromptOf(d: CouncilDiscussion, speech: CouncilSpeech): string | undefined {
    const index = d.speeches.indexOf(speech);
    const before: CouncilDiscussion = { ...d, round: speech.round, concluding: false, speeches: d.speeches.slice(0, index) };
    const step = FORMATS[d.format].plan(before);
    return step.kind === 'speak' ? step.speeches.find(spec => spec.seatId === speech.seatId && spec.phase === speech.phase)?.prompt.record : undefined;
  }

  /** A note from the reader every later speech reads; at a pause it also lets the next round run. */
  supplement(id: string, raw: string): CouncilDiscussion {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) throw new AppError('INVALID_COUNCIL_SUPPLEMENT', 'Enter a note');
    if (text.length > COUNCIL_BUDGET.supplementChars) throw new AppError('INVALID_COUNCIL_SUPPLEMENT', 'The note is too long');
    const d = this.get(id);
    if (d.status === 'done') throw new AppError('COUNCIL_DONE', 'The discussion has ended', 409);
    if (d.format === 'review') throw new AppError('COUNCIL_SUPPLEMENT_UNSUPPORTED', 'Reviews take no notes', 400);
    if (d.supplements.length >= COUNCIL_BUDGET.supplements) throw new AppError('INVALID_COUNCIL_SUPPLEMENT', 'This discussion has too many notes');
    d.supplements.push({ id: randomUUID().slice(0, 8), text, at: now(), after: d.speeches.length });
    if (this.live.has(id)) return this.commit(d);
    this.store.save(d);
    return this.continue(id, 'next');
  }

  patch(id: string, req: CouncilPatchRequest): CouncilDiscussion {
    const d = this.get(id);
    if (req?.seat) this.swapSeat(d, req.seat);
    if (req?.seen) {
      d.seenAt = now();
      this.store.save(d);
      this.emit(d.id, { type: 'snapshot', discussion: d });
      this.changed();
    }
    const edit = req?.edit;
    if (edit && d.format === 'review' && typeof edit.id === 'string') {
      if (d.status === 'running' || d.status === 'done' || this.live.has(d.id)) throw new AppError('COUNCIL_EDIT_LOCKED', 'The revision is being written or done', 409);
      const accepted = new Set(d.accepted ?? []);
      if (edit.accepted) accepted.add(edit.id); else accepted.delete(edit.id);
      d.accepted = [...accepted];
      return this.commit(d);
    }
    if (!req?.seat) return d;
    // The list carries the seats a new discussion of this format starts from.
    this.changed();
    return this.commit(d);
  }

  /**
   * Another model takes the seat: the next speech opens a new conversation and is told the discussion again, its own
   * earlier speeches included (`compose` does that for a seat speaking in a new conversation).
   */
  private swapSeat(d: CouncilDiscussion, req: NonNullable<CouncilPatchRequest['seat']>): void {
    if (d.status === 'running' || this.live.has(d.id)) throw new AppError('COUNCIL_BUSY', 'Stop the discussion before changing a model', 409);
    const seat = d.seats.find(item => item.id === req?.id);
    if (!seat) throw new AppError('INVALID_COUNCIL_SEATS', 'Unknown seat', 404);
    const agent = req.model;
    const profileName = agent && typeof agent.backendId === 'string' && typeof agent.profileId === 'string'
      ? this.deps.profileName(agent.backendId, agent.profileId)
      : undefined;
    if (!profileName) throw new AppError('COUNCIL_AGENT_UNAVAILABLE', 'A chosen Agent is not available', 409);
    const model = typeof agent.model === 'string' && agent.model.trim() ? agent.model.trim().slice(0, 200) : undefined;
    seat.model = { backendId: agent.backendId, profileId: agent.profileId, ...(model ? { model } : {}) };
    seat.profileName = profileName;
    delete seat.sessionId;
    seat.heard = [];
    // Its failed speeches of this round ran on the old model: the next run speaks them again.
    d.speeches = d.speeches.filter(s => !(s.seatId === seat.id && s.round === d.round && (s.status === 'failed' || s.status === 'stopped')));
    // The old conversation stays with the discussion (`sessionsOf`): its speeches' process and input are read from it.
  }

  async exportDiscussion(id: string, req: CouncilExportRequest): Promise<CouncilExportResult> {
    const d = this.get(id);
    if (!this.deps.exports) throw new AppError('SERVICE_STARTING', 'Export handlers unavailable', 503);
    const body = (req?.body || '').trim();
    if (!body) throw new AppError('INVALID_EXPORT', 'Export content cannot be empty');
    if (req.kind === 'task') {
      return { kind: 'task', id: this.deps.exports.createWorkItem({ title: d.title, body, ...(req.projectId ? { projectId: req.projectId } : {}) }) };
    }
    const sessionId = await this.deps.exports.openSession({
      title: d.title,
      prompt: body,
      ...(req.projectId ? { projectId: req.projectId } : {}),
      ...(req.backendId ? { backendId: req.backendId } : {}),
      ...(req.model ? { model: req.model } : {}),
    });
    return { kind: 'session', id: sessionId };
  }

  private commit(d: CouncilDiscussion): CouncilDiscussion {
    d.updatedAt = now();
    this.store.save(d);
    this.emit(d.id, { type: 'snapshot', discussion: d });
    if (this.announced.get(d.id) !== d.status) {
      this.announced.set(d.id, d.status);
      this.changed();
    }
    return d;
  }

  /** Ends the run of `id`, if any, and the seat turns it has in flight; its late results are dropped because it is no longer current. */
  private halt(id: string): Live | undefined {
    const live = this.live.get(id);
    if (!live) return undefined;
    this.live.delete(id);
    live.controller.abort(new Error('Stopped'));
    for (const [runId, sessionId] of live.turns) this.deps.seats.stop(sessionId, runId);
    live.turns.clear();
    return live;
  }

  private current(live: Live): boolean {
    return this.live.get(live.discussion.id) === live;
  }

  private start(d: CouncilDiscussion): void {
    this.halt(d.id);
    d.version += 1;
    d.status = 'running';
    delete d.error;
    const live: Live = { discussion: d, controller: new AbortController(), turns: new Map() };
    this.live.set(d.id, live);
    this.commit(d);
    void this.loop(live);
  }

  private async loop(live: Live): Promise<void> {
    const d = live.discussion;
    const format = FORMATS[d.format];
    let failure: string | undefined;
    try {
      for (;;) {
        const step = format.plan(d);
        if (step.kind === 'speak') {
          const spoken = await Promise.all(step.speeches.map(spec => this.speak(live, spec)));
          if (!this.current(live)) return;
          if (spoken.every(s => s.status === 'failed')) {
            failure = spoken[0]?.error ?? 'Every speech of this step failed';
            break;
          }
          continue;
        }
        if (step.kind === 'round-end' && d.rhythm === 'auto') {
          format.autoAdvance?.(d);
          this.advanceRound(d);
          continue;
        }
        d.status = step.kind === 'done' ? 'done' : 'paused';
        break;
      }
    } catch (error) {
      if (!this.current(live)) return;
      failure = messageOf(error);
    }
    if (!this.current(live)) return;
    this.live.delete(d.id);
    if (failure) {
      d.status = 'failed';
      d.error = failure;
    }
    this.settle(d);
    this.commit(d);
  }

  private async speak(live: Live, spec: SpeechSpec): Promise<CouncilSpeech> {
    const d = live.discussion;
    const { seats } = this.deps;
    const speech: CouncilSpeech = {
      id: `${spec.phase}-${spec.round}-${spec.seatId}-${randomUUID().slice(0, 6)}`,
      seatId: spec.seatId,
      round: spec.round,
      phase: spec.phase,
      text: '',
      status: 'streaming',
      startedAt: now(),
    };
    d.speeches.push(speech);
    // Saved before the seat is sent, so a restart while its conversation opens leaves a cut speech to rerun.
    this.store.save(d);
    this.emitSpeech(live, speech);

    const seat = d.seats.find(s => s.id === spec.seatId)!;
    const timeout = AbortSignal.timeout(COUNCIL_BUDGET.speechTimeoutMs);
    const signal = AbortSignal.any([live.controller.signal, timeout]);
    let unwatch = () => {};
    let turn: { sessionId: string; runId: string; model?: string } | undefined;
    try {
      // A conversation that went (deleted, archived) is opened anew, and told everything again.
      if (seat.sessionId && !seats.alive(seat.sessionId)) { delete seat.sessionId; seat.heard = []; }
      const opened = seat.sessionId;
      const message = compose(FORMATS[d.format], d, seat, spec);
      turn = await seats.send(d, seat, message.text, signal);
      if (!this.current(live)) {
        seats.stop(turn.sessionId, turn.runId);
        // A conversation this send opened would be left behind by the run that no longer owns it.
        if (turn.sessionId !== opened) void seats.remove(turn.sessionId).catch(() => {});
        return speech;
      }
      live.turns.set(turn.runId, turn.sessionId);
      seat.sessionId = turn.sessionId;
      seat.heard = message.heard;
      if (!seat.model.model && turn.model) seat.model = { ...seat.model, model: turn.model };
      speech.runId = turn.runId;
      const sessionId = turn.sessionId;
      unwatch = seats.watch(sessionId, turn.runId, (upserts, deletes) => this.emit(d.id, { type: 'rows', discussionId: d.id, speechId: speech.id, upserts, deletes }));
      // The seat now has a conversation to open, and the speech a turn to follow.
      this.commit(d);
      const result = await seats.settle(sessionId, turn.runId, signal);
      live.turns.delete(turn.runId);
      if (!this.current(live)) return speech;
      speech.text = result.text;
      if (result.error) speech.error = result.error;
      if (result.metrics) speech.metrics = result.metrics;
      if (result.status === 'done' && spec.prompt.record) {
        // A stop or restart must still recognize this speech as unfinished while its record is in flight.
        const directive = await this.record(live, seat, spec.phase, spec.prompt.record, speech);
        if (!this.current(live)) return speech;
        if (directive) speech.directive = directive;
      }
      speech.status = result.status;
    } catch (error) {
      if (!this.current(live)) return speech;
      if (turn) { seats.stop(turn.sessionId, turn.runId); live.turns.delete(turn.runId); }
      speech.status = 'failed';
      speech.error = timeout.aborted ? `The speech ran past ${Math.round(COUNCIL_BUDGET.speechTimeoutMs / 60_000)} minutes` : messageOf(error);
    } finally {
      unwatch();
    }
    if (!this.current(live)) return speech;
    speech.endedAt = now();
    d.updatedAt = speech.endedAt;
    this.store.save(d);
    this.emitSpeech(live, speech);
    return speech;
  }

  /**
   * The notes a speech's seat records in a turn of its own. Without them (the seat does not give them in time or in
   * shape) the speech stands and `recordError` says why; they are recorded again from the reader's call.
   */
  private async record(live: Live, seat: CouncilSeat, phase: CouncilSpeech['phase'], recordPrompt: string, speech: CouncilSpeech) {
    const d = live.discussion;
    const { seats } = this.deps;
    const timeout = AbortSignal.timeout(COUNCIL_BUDGET.recordTimeoutMs);
    let turn: { sessionId: string; runId: string } | undefined;
    let directive: CouncilSpeech['directive'];
    let reason: string | undefined;
    try {
      turn = await seats.send(d, seat, recordTurn(recordPrompt));
      if (!this.current(live)) { seats.stop(turn.sessionId, turn.runId); return undefined; }
      speech.recordRunId = turn.runId;
      this.store.save(d);
      live.turns.set(turn.runId, turn.sessionId);
      const result = await seats.settle(turn.sessionId, turn.runId, AbortSignal.any([live.controller.signal, timeout]));
      directive = directiveFor(phase, parseJsonObject(result.text), d, seat.id);
      if (!directive) reason = result.error ?? (result.text.trim() ? 'The notes were not in a readable shape' : 'The Agent gave no notes');
    } catch (error) {
      if (turn && this.current(live)) seats.stop(turn.sessionId, turn.runId);
      reason = timeout.aborted ? `The notes took longer than ${Math.round(COUNCIL_BUDGET.recordTimeoutMs / 60_000)} minutes` : messageOf(error);
    } finally {
      if (turn) live.turns.delete(turn.runId);
    }
    if (!this.current(live)) return undefined;
    if (directive) delete speech.recordError;
    else speech.recordError = (reason ?? 'The notes are missing').slice(0, 200);
    return directive;
  }

  private emitSpeech(live: Live, speech: CouncilSpeech): void {
    const d = live.discussion;
    this.emit(d.id, { type: 'speech', discussionId: d.id, version: d.version, speech });
  }
}
