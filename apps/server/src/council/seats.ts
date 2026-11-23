import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  COUNCIL_BUDGET, type CouncilDiscussion, type CouncilSeat, type NativeBackendId, type Project, type Run, type RunMetrics, type TimelineRow, type TurnOutlineV3,
} from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import type { NativeSessionRequest } from '../native/session-input.js';
import type { Store } from '../store.js';
import type { TimelineService } from '../timeline/service.js';

/** How a speech's turn ended: its answer, or why there is none. */
export interface SeatTurn { status: 'done' | 'failed'; text: string; error?: string; metrics?: RunMetrics }

/**
 * The seats' Agent conversations, as the discussion uses them. One per seat, opened by its first turn and kept
 * for the discussion's life; the service holds no other handle on an Agent.
 */
export interface SeatDriver {
  /**
   * Sends `text` as the seat's next turn, opening its conversation on the first; resolves once the turn is queued,
   * with the model the conversation runs on where it names one.
   */
  send(d: CouncilDiscussion, seat: CouncilSeat, text: string): Promise<{ sessionId: string; runId: string; model?: string }>;
  /** Waits for the turn to end. Aborting stops the waiting, not the turn. */
  settle(sessionId: string, runId: string, signal: AbortSignal): Promise<SeatTurn>;
  stop(sessionId: string, runId: string): void;
  /** Follows the rows of the turn as they change; returns how to stop. */
  watch(sessionId: string, runId: string, onRows: (upserts: TimelineRow[], deletes: string[]) => void): () => void;
  /** Original council input for a run belonging to this discussion. */
  prompt(discussionId: string, runId: string): string | undefined;
  /** The visible rows of a run belonging to this discussion. */
  rows(discussionId: string, runId: string): Promise<TimelineRow[]>;
  /** Whether the conversation is still there to speak in. */
  alive(sessionId: string): boolean;
  /** Stops the conversation's turn and deletes it. */
  remove(sessionId: string): Promise<void>;
}

const ENDED = new Set<Run['state']>(['completed', 'failed', 'cancelled', 'interrupted']);

/** Where the seats of discussions without a project of the owner's run: an empty directory, never listed. */
export function councilProject(store: Store, stateDir: string): Project {
  const existing = store.listProjects().find(project => project.system === 'council');
  if (existing) return existing;
  const cwd = join(stateDir, 'council');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const project = store.createProject(cwd, 'Council');
  return project.system === 'council' ? project : store.updateProject(project.id, { system: 'council' });
}

export interface AgentSeatsDeps {
  store: Store;
  /** Where a seat on the backend runs. */
  project(backendId: NativeBackendId): Project;
  orchestration: {
    start(body: NativeSessionRequest, text: string, origin: { kind: 'council'; groupId: string }, ids: { sessionId: string; commandId: string }): Promise<{ id: string }>;
    message(sessionId: string, text: string, commandId: string): Run;
  };
  /** The permission and mode a seat starts with: ones that never stop to ask, where the Agent has them. */
  launch(backendId: NativeBackendId, profileId: string): Promise<{ approval?: string; mode?: string }>;
  cancel(sessionId: string, runId: string): void;
  delete(sessionId: string): Promise<unknown>;
  timeline: Pick<TimelineService, 'ready' | 'outline' | 'page' | 'subscribe' | 'turnText'>;
}

export class AgentSeats implements SeatDriver {
  constructor(private readonly deps: AgentSeatsDeps) {}

  prompt(discussionId: string, runId: string): string | undefined {
    return this.discussionRun(discussionId, runId)?.prompt;
  }

  private discussionRun(discussionId: string, runId: string): Run | undefined {
    const { store } = this.deps;
    try {
      const run = store.getRun(runId);
      const origin = store.findSession(run.sessionId)?.origin;
      if (origin?.kind === 'council' && origin.groupId === discussionId) return run;
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'RUN_NOT_FOUND')) throw error;
    }
    return undefined;
  }

  async send(d: CouncilDiscussion, seat: CouncilSeat, text: string): Promise<{ sessionId: string; runId: string; model?: string }> {
    const { store, orchestration } = this.deps;
    if (seat.sessionId && this.alive(seat.sessionId)) {
      // A turn left running by a stop the server did not see through is cut now, so this one is not queued behind it.
      for (const run of store.listUnfinishedNativeRuns(seat.sessionId)) this.stop(seat.sessionId, run.id);
      return { sessionId: seat.sessionId, runId: orchestration.message(seat.sessionId, text, randomUUID()).id };
    }
    const launch = await this.deps.launch(seat.model.backendId, seat.model.profileId);
    const request: NativeSessionRequest = {
      projectId: this.deps.project(seat.model.backendId).id,
      title: `${d.title} · ${seat.id}`,
      backendId: seat.model.backendId,
      backendProfileId: seat.model.profileId,
      ...(seat.model.model ? { model: seat.model.model } : {}),
      ...launch,
    };
    const session = await orchestration.start(request, text, { kind: 'council', groupId: d.id }, { sessionId: randomUUID(), commandId: randomUUID() });
    const run = store.listRuns(session.id)[0];
    if (!run) throw new AppError('COUNCIL_SEAT_FAILED', 'The seat\'s conversation did not take its first message', 500);
    // A seat that named no model runs on the one its conversation was opened with (the owner's saved default).
    const model = store.getSession(session.id).model;
    return { sessionId: session.id, runId: run.id, ...(model ? { model } : {}) };
  }

  settle(sessionId: string, runId: string, signal: AbortSignal): Promise<SeatTurn> {
    const { store } = this.deps;
    return new Promise<Run>((resolve, reject) => {
      let done = false;
      const finish = (outcome: () => void) => { if (done) return; done = true; offRun(); offState(); signal.removeEventListener('abort', onAbort); outcome(); };
      const check = () => {
        if (done) return;
        let run: Run;
        try { run = store.getRun(runId); } catch { finish(() => reject(new Error('The seat\'s conversation is gone'))); return; }
        if (ENDED.has(run.state)) { finish(() => resolve(run)); return; }
        if (!this.alive(sessionId)) { finish(() => reject(new Error('The seat\'s conversation is gone'))); return; }
        // Nobody answers a seat's question or approval: the turn is cut and the speech fails.
        if (store.getSession(sessionId).state === 'waiting') {
          this.stop(sessionId, runId);
          finish(() => reject(new Error('The Agent stopped to ask for input')));
        }
      };
      const onAbort = () => finish(() => reject(signal.reason));
      const offRun = store.onRunChanged(run => { if (run.id === runId) setImmediate(check); });
      const offState = store.onSessionState(session => { if (session.id === sessionId) setImmediate(check); });
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      check();
    }).then(async run => {
      const text = await this.answer(sessionId, runId);
      const metrics = run.native?.metrics ? { metrics: run.native.metrics } : {};
      if (run.state !== 'completed') return { status: 'failed', text, error: run.error ?? `The turn ended ${run.state}`, ...metrics };
      return text ? { status: 'done', text, ...metrics } : { status: 'failed', text, error: 'The Agent gave no answer', ...metrics };
    });
  }

  stop(sessionId: string, runId: string): void {
    try { this.deps.cancel(sessionId, runId); } catch { /* it already ended */ }
  }

  watch(sessionId: string, runId: string, onRows: (upserts: TimelineRow[], deletes: string[]) => void): () => void {
    // Rows name their turn, not always their run: the run's turn is looked up until the outline has it.
    let turn: string | undefined;
    const keys = new Set<string>();
    return this.deps.timeline.subscribe(sessionId, 'main', change => {
      if (change.type !== 'rows') return;
      turn ??= this.deps.timeline.outline(sessionId, 'main').turns.findLast(item => item.runId === runId)?.turn;
      if (!turn) return;
      const upserts = change.upserts.filter(row => row.turn === turn && row.kind !== 'user');
      for (const row of upserts) keys.add(row.key);
      const deletes = change.deletes.filter(key => keys.delete(key));
      if (upserts.length || deletes.length) onRows(upserts, deletes);
    });
  }

  async rows(discussionId: string, runId: string): Promise<TimelineRow[]> {
    // A reopened seat can have a different sessionId. The run still points to its original lane.
    const run = this.discussionRun(discussionId, runId);
    if (!run) return [];
    const turn = await this.turnOf(run.sessionId, run.id);
    return turn ? this.rowsForTurn(run.sessionId, turn) : [];
  }

  alive(sessionId: string): boolean {
    try { return !this.deps.store.getSession(sessionId).archivedAt; } catch { return false; }
  }

  async remove(sessionId: string): Promise<void> {
    const { store } = this.deps;
    if (!this.alive(sessionId)) return;
    for (const run of store.listUnfinishedNativeRuns(sessionId)) this.stop(sessionId, run.id);
    const until = Date.now() + COUNCIL_BUDGET.removeWaitMs;
    for (;;) {
      try { await this.deps.delete(sessionId); return; } catch (error) {
        // A turn still stopping keeps the conversation; anything else will not pass by waiting.
        if (!(error instanceof AppError && error.code === 'SESSION_DELETE_BLOCKED') || Date.now() > until) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
      if (!this.alive(sessionId)) return;
    }
  }

  /** The turn of the run, once the timeline has folded what the journal holds. */
  private async turnOf(sessionId: string, runId: string) {
    await this.deps.timeline.ready(sessionId, 'main');
    return this.deps.timeline.outline(sessionId, 'main').turns.findLast(turn => turn.runId === runId);
  }

  private rowsForTurn(sessionId: string, turn: TurnOutlineV3): TimelineRow[] {
    const page = this.deps.timeline.page(sessionId, 'main', { from: turn.startPos, rows: COUNCIL_BUDGET.speechRows });
    return page.rows.filter(row => row.turn === turn.turn && row.kind !== 'user');
  }

  private async answer(sessionId: string, runId: string): Promise<string> {
    const turn = await this.turnOf(sessionId, runId);
    if (!turn) return '';
    const answer = this.deps.timeline.turnText(sessionId, turn.turn)?.answer;
    if (answer) return answer.trim();
    // A turn that did not complete still said something; its last words are what there is.
    const rows = this.rowsForTurn(sessionId, turn);
    return rows.findLast((row): row is Extract<TimelineRow, { kind: 'assistant' }> => row.kind === 'assistant' && Boolean(row.text.trim()))?.text.trim() ?? '';
  }
}
