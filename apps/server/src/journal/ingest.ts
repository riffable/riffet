import type { NativeActivity, NativeWorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import type { SyncLane } from '../../../../packages/contracts/src/sync.js';
import { ActivityLedger, activityEvent, activityOfEvent, isLiveActivity } from './activity.js';
import { DRAFT_KIND, Journal, TOMBSTONE_KIND, laneKey, scratchKeyOf, type JournalEventInput } from './journal.js';
import { draftInput, eventInput } from './native-log.js';

/**
 * The write side of sync v3 (docs/SYNC-V3.md, 写入契约): how a backend's transcript gets into the session
 * journal. A backend provides a {@link TranscriptSource}; the service drives it with {@link pullLane} into
 * the session's {@link JournalLaneWriter}. Numbering belongs to the journal alone (G1): each lane's log
 * assigns its own contiguous `seq`, and an event's `sequence` is ignored.
 */

export type TurnEndStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** What a subagent's tool row shows of it besides its lane: the task it was given, its kind and model. */
export interface SubagentInfo { title?: string; subagentType?: string; model?: string }

/** A child binding survives its completed turns and can be followed again after a restart. */
export interface SubagentBinding extends SubagentInfo { toolCallId: string; agentId: string }

/** One step of a read: rows and how far the source has read, committed in one transaction (G7). */
export interface LaneBatch {
  /** In transcript order. An event identical to its entity's latest version writes nothing; a changed one is a new version (G2). */
  events: NativeWorkbenchEvent[];
  /** Streamed chunks, each under the id its committed event will have. A chunk of an entity already committed writes nothing. */
  drafts?: { finalId: string; event: NativeWorkbenchEvent }[];
  /** Entities that leave the transcript (a provisional row its settled copy replaced). */
  retire?: string[];
  /** Where the next read starts, stored with the rows. */
  cursor: string | null;
  /** Reproject existing committed entities after an adapter upgrade, preserving their identity, timing and turn ownership. */
  reproject?: true;
  /** The events belong to turns already over (a failed turn's kept draft): the lane's current turn stays where it is. */
  ended?: true;
}

/**
 * The one way into a lane's log. Every write lands at once (joining an open transaction); only `commit`
 * moves the cursor. Turn marks, activity states and `child` land where they are made, so a source commits
 * what precedes them in the transcript first. A write the control path makes on its own (a turn ended by
 * a hook) goes to the log that serves: `w.scratch ?? w`.
 */
export interface LaneWriter {
  readonly lane: SyncLane;
  /** The generation of this writer's log. */
  readonly generation: string;
  /** What the last commit stored. A read starts here, never where the source's memory says it got to (G7). */
  readonly cursor: string | null;
  /** Whether an upgrade still refers to the same live message occurrence, rather than a retired or replaced entity. */
  canReproject(event: NativeWorkbenchEvent): boolean;
  commit(batch: LaneBatch): void;
  /** G3: every turn, also one typed into the CLI directly. Writing it again writes nothing; a `runId` once recorded is kept. */
  turnStarted(turnId: string, at: string, runId?: string): void;
  /**
   * G3: after the source has read what is on disk (G6). Writes the turn's start too if it never was. `error`
   * is what the provider said of a failed turn, for whoever settles its run.
   */
  turnEnded(turnId: string, status: TurnEndStatus, at: string, error?: string): void;
  /** The current valid end, if the transcript has not retracted it. */
  turnEndStatus(turnId: string): TurnEndStatus | undefined;
  turnEnd(turnId: string): { status: TurnEndStatus; at: string; error?: string } | undefined;
  /** The committed event being corrected, including its original position and payload. */
  event(nativeId: string): NativeWorkbenchEvent | undefined;
  /** The journal sort key (`identity`) of a live event or active draft, or `undefined` if absent or retired. */
  eventOrder?(nativeId: string): number | undefined;
  /** Whether a failed end is the exact diagnostic being reclassified, not a later real failure. */
  turnFailedAt(turnId: string, at: string, error: string): boolean;
  /** Keep a cursor upgrade and its corrective writes atomic, including nested writer calls. */
  transaction(task: () => void): void;
  /** Retracts an end when authoritative transcript state resumes or corrects it; optionally checkpoints the reread. */
  turnReopened(turnId: string, at: string, cursor?: string): void;
  /**
   * G10: the only way an activity state reaches the log; each new state is a new version of the activity's row.
   * It starts out holding what the log has still running, so an activity outlives a restart of the service.
   */
  readonly activities: ActivityLedger;
  /**
   * G9: the writer of lane `sub:<toolCallId>`; this lane's log records (`meta.subagent`) which lane holds the
   * subagent, and what is known of it. Naming it again with more known writes a new version of that record.
   */
  child(toolCallId: string, agentId: string, info?: SubagentInfo): LaneWriter;
  /** All current bindings in this lane, including completed children. */
  readonly subagents: readonly SubagentBinding[];
  /** Retracts a duplicate binding and its tool rows; the child's stored transcript is retained. */
  retireSubagent(toolCallId: string, replacementToolCallId?: string): void;
  /** G8: the lane, for `main` the whole session, starts over under a new generation. Only for an identity change. */
  rebuild(reason: 'identity-changed'): void;
  /**
   * G4: the scratch log serving this lane's tail while its history is imported into this one, oldest
   * first. It serves from its first commit until {@link promote}; a lane that has been read already
   * cannot open one, because it would change the generation twice.
   */
  readonly scratch: LaneWriter | undefined;
  openScratch(): LaneWriter;
  /** The import has caught up: the scratch log goes and this one serves, the lane's one generation change. */
  promote(): void;
}

/**
 * A backend's transcript as the journal reads it. `pull` reads from `w.cursor` on and commits in steps;
 * it resolves `caughtUp: true` once everything on disk is in the log. A first import of a long
 * transcript commits a tail window to `w.openScratch()` and then imports from the start into `w`, a
 * bounded step per pull, keeping the window current meanwhile.
 */
export interface TranscriptSource {
  /** The native conversation being read (a thread or transcript id); a change starts the lane over (G8). */
  identity(): string | undefined;
  pull(w: LaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }>;
  /** Calls `wake` when the native data may have changed; returns how to stop. */
  watch?(w: LaneWriter, wake: () => void): () => void;
  /** Reads everything already on disk into the log that serves; called before a turn is ended from outside the transcript (G6). */
  drain(w: LaneWriter): Promise<void>;
}

const TURN_STARTED = 'meta.turn_started';
const TURN_ENDED = 'meta.turn_ended';
const SUBAGENT = 'meta.subagent';

export const turnMetaId = (turnId: string, edge: 'started' | 'ended'): string => `meta:turn:${turnId}:${edge}`;
export const subagentMetaId = (toolCallId: string): string => `meta:subagent:${toolCallId}`;

function readTurnEnd(journal: Journal, key: string, turnId: string): ReturnType<LaneWriter['turnEnd']> {
  const ended = journal.entity(key, turnMetaId(turnId, 'ended'));
  if (ended?.kind !== TURN_ENDED) return undefined;
  const payload = ended.payload as { status?: unknown; error?: unknown } | undefined;
  const status = payload?.status;
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'interrupted') return undefined;
  return { status, at: ended.at, ...(typeof payload?.error === 'string' ? { error: payload.error } : {}) };
}

/** An end-marker tombstone still has an identity, but no longer ends its turn. */
export function hasTurnEnded(journal: Journal, key: string, turnId: string): boolean {
  return readTurnEnd(journal, key, turnId) !== undefined;
}

/** The log a reader serves for a lane: its scratch window while one is open, else the lane's own. */
export function servingKey(journal: Journal, sessionId: string, lane: SyncLane): { key: string; scratch: boolean } {
  const key = laneKey(sessionId, lane);
  const scratch = scratchKeyOf(key);
  return journal.peek(scratch) ? { key: scratch, scratch: true } : { key, scratch: false };
}

function turnStartInput(turnId: string, at: string, runId?: string): JournalEventInput {
  return { kind: TURN_STARTED, nativeId: turnMetaId(turnId, 'started'), turnId, at, payload: { turnId, ...(runId ? { runId } : {}) } };
}

/** The writers of one session, shared so that every writer of it hands out the same child. */
interface SessionLanes { readonly journal: Journal; readonly sessionId: string; readonly children: Map<string, JournalLaneWriter> }

/**
 * {@link LaneWriter} over a {@link Journal}: one log per lane (`laneKey`), and the scratch window of a
 * lane under import beside it (`scratchKeyOf`), both rows of the one table. Keep one per session: its
 * ledger is the lane's live activity state.
 */
export class JournalLaneWriter implements LaneWriter {
  private ledger: ActivityLedger | undefined;
  private scratchWriter: JournalLaneWriter | undefined;
  /** The turn of the newest write, read from the log on first use; an activity first seen outside a commit belongs to it. */
  private turn: string | null | undefined;

  static open(journal: Journal, sessionId: string): JournalLaneWriter {
    return new JournalLaneWriter({ journal, sessionId, children: new Map() }, 'main', laneKey(sessionId, 'main'));
  }

  private constructor(private readonly lanes: SessionLanes, readonly lane: SyncLane, readonly key: string, private readonly owner?: JournalLaneWriter) {}

  get activities(): ActivityLedger {
    if (this.ledger) return this.ledger;
    this.ledger = new ActivityLedger(activity => this.writeActivity(activity), id => {
      const activity = activityOfEvent(this.journal.entity(this.key, id)?.payload);
      return activity?.kind === 'compaction' ? activity : undefined;
    });
    // Restore live executions and durable compaction evidence, so a restarted reader can
    // reconcile provisional history without losing a confirmed completion or its details.
    this.ledger.restore(this.journal.activityEntities(this.key).flatMap(entity => {
      const activity = activityOfEvent(entity.payload);
      return activity && (isLiveActivity(activity) || activity.kind === 'compaction') ? [activity] : [];
    }));
    return this.ledger;
  }

  private get journal(): Journal { return this.lanes.journal; }
  get sessionId(): string { return this.lanes.sessionId; }
  get generation(): string { return this.journal.head(this.key).generation; }
  get cursor(): string | null { return this.journal.peek(this.key)?.ingestCursor ?? null; }
  /** The native conversation the lane was written from (`TranscriptSource.identity`, or the agent id of a subagent lane). */
  get identity(): string | undefined { return this.journal.peek(this.key)?.identity; }

  get scratch(): LaneWriter | undefined {
    if (this.owner) return undefined;
    // One left by an import that a restart interrupted still serves, and is carried on.
    if (!this.scratchWriter && this.journal.peek(scratchKeyOf(this.key))) this.scratchWriter = new JournalLaneWriter(this.lanes, this.lane, scratchKeyOf(this.key), this);
    return this.scratchWriter;
  }

  openScratch(): LaneWriter {
    if (this.owner) throw new Error('A scratch log has no scratch log of its own');
    const open = this.scratch;
    if (open) return open;
    if (this.cursor !== null) throw new Error(`Lane ${this.lane} has been read already and continues from its cursor`);
    return this.scratchWriter = new JournalLaneWriter(this.lanes, this.lane, scratchKeyOf(this.key), this);
  }

  promote(): void {
    if (this.owner) return;
    const key = scratchKeyOf(this.key);
    if (this.journal.peek(key)) this.journal.drop(key);
    this.scratchWriter?.ledger?.clear();
    this.scratchWriter = undefined;
  }

  commit(batch: LaneBatch): void {
    this.journal.tx(() => {
      const inputs: JournalEventInput[] = [];
      const started = new Set<string>();
      const committed = new Set<string>();
      // A turn's start precedes its first row whether or not the source marked it (G3).
      const start = (turnId: string | undefined, at: string) => {
        if (!turnId || started.has(turnId)) return;
        started.add(turnId);
        if (!this.journal.locate(this.key, turnMetaId(turnId, 'started'))) inputs.push(turnStartInput(turnId, at));
      };
      for (const event of batch.events) {
        if (batch.reproject) {
          if (!this.canReproject(event)) continue;
          const known = this.journal.entity(this.key, event.nativeId)!;
          const saved = known.payload as NativeWorkbenchEvent;
          // Positions can have been reused by a rewind. Only the same stored message occurrence
          // qualifies; retired rows and drafts must never be resurrected by an adapter upgrade.
          const repaired = { ...saved, sequence: 0, sessionId: event.sessionId, data: { ...saved.data, ...event.data } };
          inputs.push(eventInput(repaired));
          continue;
        }
        start(event.nativeTurnId, event.createdAt);
        inputs.push(eventInput(event));
        committed.add(event.nativeId);
      }
      for (const { finalId, event } of batch.drafts ?? []) {
        if (committed.has(finalId)) continue;
        // A committed entity never goes back to being a draft: a chunk read again after its message settled writes nothing.
        const known = this.journal.locate(this.key, finalId);
        if (batch.reproject && known?.kind !== DRAFT_KIND) continue;
        if (known && known.kind !== DRAFT_KIND && known.kind !== TOMBSTONE_KIND) continue;
        start(event.nativeTurnId, event.createdAt);
        inputs.push(draftInput(finalId, event));
      }
      for (const nativeId of batch.retire ?? []) {
        const known = this.journal.locate(this.key, nativeId);
        if (batch.reproject && known?.kind !== DRAFT_KIND) continue;
        if (known && known.kind !== TOMBSTONE_KIND) inputs.push({ kind: TOMBSTONE_KIND, nativeId, payload: {} });
      }
      this.journal.append(this.key, inputs, { cursor: batch.cursor });
    });
    const last = [...batch.events, ...(batch.drafts ?? []).map(draft => draft.event)].findLast(event => event.nativeTurnId)?.nativeTurnId;
    if (last && !batch.reproject && !batch.ended) this.turn = last;
  }

  canReproject(event: NativeWorkbenchEvent): boolean {
    const known = this.journal.entity(this.key, event.nativeId);
    if (!known || known.kind !== event.type) return false;
    const saved = known.payload as NativeWorkbenchEvent;
    if (!event.nativeAliases?.some(alias => saved.nativeAliases?.includes(alias))) return false;
    const toolCallId = event.data.toolCallId;
    return !(event.data.subagentResult && typeof toolCallId === 'string'
      && this.journal.locate(this.key, subagentMetaId(toolCallId))?.kind === TOMBSTONE_KIND);
  }

  turnStarted(turnId: string, at: string, runId?: string): void {
    this.journal.tx(() => {
      const known = runId ? undefined : this.journal.entity(this.key, turnMetaId(turnId, 'started'));
      const kept = (known?.payload as { runId?: unknown } | undefined)?.runId;
      this.journal.append(this.key, [turnStartInput(turnId, at, runId ?? (typeof kept === 'string' ? kept : undefined))]);
    });
    this.turn = turnId;
  }

  turnEnded(turnId: string, status: TurnEndStatus, at: string, error?: string): void {
    this.journal.tx(() => {
      const inputs: JournalEventInput[] = [];
      if (!this.journal.locate(this.key, turnMetaId(turnId, 'started'))) inputs.push(turnStartInput(turnId, at));
      inputs.push({ kind: TURN_ENDED, nativeId: turnMetaId(turnId, 'ended'), turnId, at, payload: { turnId, status, ...(error ? { error: error.slice(0, 1000) } : {}) } });
      this.journal.append(this.key, inputs);
    });
    this.turn = turnId;
  }

  turnEndStatus(turnId: string): TurnEndStatus | undefined {
    return this.turnEnd(turnId)?.status;
  }

  turnEnd(turnId: string) {
    return readTurnEnd(this.journal, this.key, turnId);
  }

  event(nativeId: string): NativeWorkbenchEvent | undefined {
    const row = this.journal.entity(this.key, nativeId);
    return row && !row.kind.startsWith('meta.') && row.kind !== TOMBSTONE_KIND && row.kind !== DRAFT_KIND
      ? row.payload as NativeWorkbenchEvent : undefined;
  }

  eventOrder(nativeId: string): number | undefined {
    const row = this.journal.locate(this.key, nativeId);
    return row && !row.kind.startsWith('meta.') && row.kind !== TOMBSTONE_KIND
      ? row.identity : undefined;
  }

  turnFailedAt(turnId: string, at: string, error: string): boolean {
    const end = this.turnEnd(turnId);
    return end?.status === 'failed' && end.at === at && end.error === error;
  }

  transaction(task: () => void): void {
    this.journal.tx(() => {
      // The ledger and issuing turn change before SQL commits. After a rollback the next access
      // must read committed state again, including when this transaction joined the store's.
      this.journal.whenSettled(committed => {
        if (!committed) { this.ledger = undefined; this.turn = undefined; }
      });
      task();
    });
  }

  turnReopened(turnId: string, at: string, cursor?: string): void {
    this.journal.tx(() => {
      const ended = this.journal.locate(this.key, turnMetaId(turnId, 'ended'));
      const inputs: JournalEventInput[] = ended?.kind === TURN_ENDED
        ? [{ kind: TOMBSTONE_KIND, nativeId: turnMetaId(turnId, 'ended'), turnId, at, payload: { turnId } }]
        : [];
      if (inputs.length || (cursor !== undefined && cursor !== this.cursor)) this.journal.append(this.key, inputs, { cursor });
    });
    this.turn = turnId;
  }

  child(toolCallId: string, agentId: string, info: SubagentInfo = {}): LaneWriter {
    const lane: SyncLane = `sub:${toolCallId}`;
    const writer = this.lanes.children.get(toolCallId) ?? new JournalLaneWriter(this.lanes, lane, laneKey(this.sessionId, lane));
    this.lanes.children.set(toolCallId, writer);
    this.journal.tx(() => {
      writer.bindIdentity(agentId);
      const nativeId = subagentMetaId(toolCallId);
      // What was recorded before stays when a later call knows less (a restarted reader that only has the ids).
      const known = this.journal.entity(this.key, nativeId)?.payload as Partial<Record<keyof SubagentInfo, unknown>> & { agentId?: unknown } | undefined;
      const kept = known?.agentId === agentId ? known : undefined;
      const field = (name: keyof SubagentInfo) => {
        const value = info[name] ?? kept?.[name];
        return typeof value === 'string' && value ? { [name]: value } : {};
      };
      const turnId = this.journal.locate(this.key, nativeId)?.turnId
        ?? this.journal.toolEntities(this.key, toolCallId).find(row => row.kind === 'tool_call')?.turnId
        ?? this.currentTurn();
      this.journal.append(this.key, [{
        kind: SUBAGENT, nativeId, ...(turnId ? { turnId } : {}),
        payload: { toolCallId, agentId, lane, ...field('title'), ...field('subagentType'), ...field('model') },
      }]);
    });
    return writer;
  }

  get subagents(): readonly SubagentBinding[] {
    return this.journal.subagentEntities(this.key).flatMap(row => {
      const value = row.payload as Partial<SubagentBinding>;
      if (typeof value.toolCallId !== 'string' || typeof value.agentId !== 'string') return [];
      return [{ toolCallId: value.toolCallId, agentId: value.agentId,
        ...(typeof value.title === 'string' ? { title: value.title } : {}),
        ...(typeof value.subagentType === 'string' ? { subagentType: value.subagentType } : {}),
        ...(typeof value.model === 'string' ? { model: value.model } : {}),
      }];
    });
  }

  retireSubagent(toolCallId: string, replacementToolCallId?: string): void {
    const binding = subagentMetaId(toolCallId);
    const kind = this.journal.locate(this.key, binding)?.kind;
    if (kind !== SUBAGENT && kind !== TOMBSTONE_KIND) return;
    this.journal.tx(() => {
      if (kind === SUBAGENT) this.commit({ events: [], retire: [binding, ...this.journal.toolEntities(this.key, toolCallId).map(row => row.nativeId)], cursor: this.cursor });
      this.lanes.children.delete(toolCallId);
      if (replacementToolCallId) this.journal.dropIfCopied(laneKey(this.sessionId, `sub:${toolCallId}`), laneKey(this.sessionId, `sub:${replacementToolCallId}`));
    });
  }

  rebuild(reason: 'identity-changed'): void {
    if (this.owner) { this.owner.rebuild(reason); return; }
    this.journal.tx(() => {
      const others = this.lane === 'main' ? this.journal.keysOf(this.sessionId).filter(key => key !== this.key) : [scratchKeyOf(this.key)];
      for (const key of others) this.journal.drop(key);
      this.journal.rebuild(this.key);
    });
    this.forget();
  }

  /**
   * Names the native conversation the lane is written from (G8). The first one is only recorded, so a
   * log written before identities were (Codex's) keeps its generation; a different one starts the lane over.
   */
  bindIdentity(identity: string | undefined): void {
    if (identity === undefined || this.owner) return;
    const known = this.identity;
    if (known === identity) return;
    this.journal.tx(() => {
      if (known !== undefined) this.rebuild('identity-changed');
      this.journal.setIdentity(this.key, identity);
    });
  }

  /** The source has read everything there is: every scratch window of the session gives way (G4). */
  caughtUp(): void {
    this.promote();
    for (const child of this.lanes.children.values()) child.promote();
  }

  /** What this writer knew about logs that are gone. */
  private forget(): void {
    this.ledger?.clear();
    this.scratchWriter?.ledger?.clear();
    this.scratchWriter = undefined;
    this.turn = undefined;
    if (this.lane !== 'main') return;
    for (const child of this.lanes.children.values()) child.forget();
    this.lanes.children.clear();
  }

  private currentTurn(): string | undefined {
    if (this.turn === undefined) this.turn = this.journal.lastTurn(this.key) ?? null;
    return this.turn ?? undefined;
  }

  private writeActivity(activity: NativeActivity): void {
    // Every state of an activity stays in the turn of its first.
    const turnId = this.journal.locate(this.key, activity.id)?.turnId ?? this.currentTurn();
    this.journal.append(this.key, [eventInput(activityEvent(this.sessionId, activity, turnId ? { nativeTurnId: turnId } : {}))]);
  }
}

/**
 * One read of `source` into its session: the lane starts over first if the source now reads another
 * conversation (G8), and once the source has caught up its scratch windows give way (G4). Reads of one
 * session must not overlap.
 */
export async function pullLane(source: TranscriptSource, writer: JournalLaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }> {
  writer.bindIdentity(source.identity());
  const result = await source.pull(writer, signal);
  if (result.caughtUp && !signal.aborted) writer.caughtUp();
  return result;
}
