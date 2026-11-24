import { createHash } from 'node:crypto';
import type { NativeActivity, NativeWorkbenchEvent, SyncLane } from '@contracts';
import { ActivityLedger, activityEvent, activityOfEvent, isLiveActivity } from '@riffet/plugin-api/kit';
import {
  type AgentLaneBatch, type AgentLaneWriter, type AgentSubagentBinding, type AgentSubagentInfo, type AgentTranscriptSource, type AgentTurnStatus,
} from '@riffet/plugin-api/experimental/agent';

/*
 * A recording, in-memory `AgentLaneWriter`: the lane logs of one session as the core's journal keeps them
 * (one log per lane, a scratch window beside a lane under import), reduced to what a transcript source can
 * observe of them. A row is one version of an entity; writing the content an entity already has writes
 * nothing; a lane's cursor, generation and identity live with its log. Not here: numbering guarantees,
 * payload blobs and storage, which belong to the journal and are the core's to test.
 */

export const DRAFT_KIND = 'draft';
export const TOMBSTONE_KIND = 'tombstone';
export const isHiddenKind = (kind: string): boolean => kind === DRAFT_KIND || kind === TOMBSTONE_KIND || kind.startsWith('meta.');

export interface FakeRow { seq: number; kind: string; nativeId: string; rev: number; turnId?: string; at: string; digest: string; payload: unknown }
/** What a caller appends: `contentKey` stands in for the payload when deciding whether it is a new version. */
export interface FakeInput { kind: string; nativeId: string; turnId?: string; at?: string; payload: unknown; contentKey?: unknown }
export interface FakeEntity extends FakeRow { /** Seq of the entity's first row. */ identity: number }
interface FakeLog { generation: string; cursor: string | null; identity?: string; rows: FakeRow[]; latest: Map<string, FakeRow>; first: Map<string, number> }

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');
const SCRATCH = '#tail';
export const scratchKeyOf = (key: string): string => `${key}${SCRATCH}`;

/** Every log of one session, by lane key: `main`, `sub:<toolCallId>`, and `<key>#tail` for a scratch window. */
export class FakeLanes {
  readonly logs = new Map<string, FakeLog>();
  private generations = 0;
  private readonly listeners = new Set<(key: string) => void>();

  /** Called with the key of a log after rows were written to it, or it was started over or dropped. */
  onChange(listener: (key: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  peek(key: string): FakeLog | undefined { return this.logs.get(key); }
  head(key: string): FakeLog {
    let log = this.logs.get(key);
    if (!log) this.logs.set(key, log = { generation: `generation-${++this.generations}`, cursor: null, rows: [], latest: new Map(), first: new Map() });
    return log;
  }
  keys(): string[] { return [...this.logs.keys()].sort(); }

  append(key: string, inputs: readonly FakeInput[], options: { cursor?: string | null } = {}): void {
    const log = this.head(key);
    const before = log.rows.length;
    for (const input of inputs) {
      const digest = sha1(`${input.kind}\n${JSON.stringify(input.contentKey === undefined ? input.payload : input.contentKey)}`);
      const latest = log.latest.get(input.nativeId);
      if (latest?.digest === digest) continue;
      const row: FakeRow = { seq: log.rows.length + 1, kind: input.kind, nativeId: input.nativeId, rev: (latest?.rev ?? 0) + 1, ...(input.turnId ? { turnId: input.turnId } : {}), at: input.at ?? new Date().toISOString(), digest, payload: input.payload };
      log.rows.push(row);
      log.latest.set(input.nativeId, row);
      if (!latest) log.first.set(input.nativeId, row.seq);
    }
    const moved = options.cursor !== undefined && options.cursor !== log.cursor;
    if (options.cursor !== undefined) log.cursor = options.cursor;
    if (log.rows.length > before || moved) for (const listener of this.listeners) listener(key);
  }

  entity(key: string, nativeId: string): FakeEntity | undefined {
    const log = this.logs.get(key), row = log?.latest.get(nativeId);
    return row ? { ...row, identity: log!.first.get(nativeId)! } : undefined;
  }
  /** The latest version of every entity, by where its first row sits. */
  entities(key: string): FakeEntity[] {
    const log = this.logs.get(key);
    return log ? [...log.latest.values()].map(row => ({ ...row, identity: log.first.get(row.nativeId)! })).sort((a, b) => a.identity - b.identity) : [];
  }
  rebuild(key: string): void {
    this.logs.delete(key);
    this.head(key);
    for (const listener of this.listeners) listener(key);
  }
  drop(key: string): void { if (this.logs.delete(key)) for (const listener of this.listeners) listener(key); }

  /** A copy to go back to: a write that failed leaves nothing behind. */
  save(): Map<string, FakeLog> { return structuredClone(this.logs); }
  restore(saved: Map<string, FakeLog>): void { this.logs.clear(); for (const [key, log] of saved) this.logs.set(key, log); }
}

const TURN_STARTED = 'meta.turn_started', TURN_ENDED = 'meta.turn_ended', SUBAGENT = 'meta.subagent';
export const turnMetaId = (turnId: string, edge: 'started' | 'ended'): string => `meta:turn:${turnId}:${edge}`;
export const subagentMetaId = (toolCallId: string): string => `meta:subagent:${toolCallId}`;

function eventInput(event: NativeWorkbenchEvent): FakeInput {
  const { sequence: _sequence, sessionId: _sessionId, raw: _raw, ...stored } = event;
  return { kind: event.type, nativeId: event.nativeId, ...(event.nativeTurnId ? { turnId: event.nativeTurnId } : {}), at: event.createdAt, payload: stored, contentKey: { ...stored, createdAt: undefined } };
}
function draftInput(finalId: string, event: NativeWorkbenchEvent): FakeInput {
  const { sequence: _sequence, sessionId: _sessionId, raw: _raw, ...stored } = event;
  return { kind: DRAFT_KIND, nativeId: finalId, ...(event.nativeTurnId ? { turnId: event.nativeTurnId } : {}), at: event.createdAt, payload: stored };
}
const turnStartInput = (turnId: string, at: string, runId?: string): FakeInput => ({ kind: TURN_STARTED, nativeId: turnMetaId(turnId, 'started'), turnId, at, payload: { turnId, ...(runId ? { runId } : {}) } });

interface SessionLanes { readonly lanes: FakeLanes; readonly children: Map<string, FakeLaneWriter> }

/**
 * An `AgentLaneWriter` over {@link FakeLanes}. Like the core's, it holds no lane state of its own but its
 * ledger and the writers it handed out: opening a new one over the same lanes is a restarted service.
 */
export class FakeLaneWriter implements AgentLaneWriter {
  private ledger: ActivityLedger | undefined;
  private scratchWriter: FakeLaneWriter | undefined;
  private turn: string | null | undefined;

  static open(lanes: FakeLanes): FakeLaneWriter { return new FakeLaneWriter({ lanes, children: new Map() }, 'main', 'main'); }

  private constructor(private readonly shared: SessionLanes, readonly lane: SyncLane, readonly key: string, private readonly owner?: FakeLaneWriter) {}

  get lanes(): FakeLanes { return this.shared.lanes; }
  get generation(): string { return this.lanes.head(this.key).generation; }
  get cursor(): string | null { return this.lanes.peek(this.key)?.cursor ?? null; }
  get identity(): string | undefined { return this.lanes.peek(this.key)?.identity; }
  /** Every row of this log, oldest first. */
  get rows(): readonly FakeRow[] { return this.lanes.peek(this.key)?.rows ?? []; }
  entity(nativeId: string): FakeEntity | undefined { return this.lanes.entity(this.key, nativeId); }
  /** The current rows of one tool call. */
  toolEntities(toolCallId: string): FakeEntity[] {
    return this.lanes.entities(this.key).filter(row => (row.kind === 'tool_call' || row.kind === 'tool_call_update') && (row.payload as { data?: { toolCallId?: unknown } }).data?.toolCallId === toolCallId);
  }

  get activities(): ActivityLedger {
    if (this.ledger) return this.ledger;
    this.ledger = new ActivityLedger(activity => this.writeActivity(activity));
    this.ledger.restore(this.lanes.entities(this.key).flatMap(entity => {
      const activity = entity.kind === 'session/update' ? activityOfEvent(entity.payload) : undefined;
      return activity && isLiveActivity(activity) ? [activity] : [];
    }));
    return this.ledger;
  }

  get scratch(): FakeLaneWriter | undefined {
    if (this.owner) return undefined;
    if (!this.scratchWriter && this.lanes.peek(scratchKeyOf(this.key))) this.scratchWriter = new FakeLaneWriter(this.shared, this.lane, scratchKeyOf(this.key), this);
    return this.scratchWriter;
  }

  openScratch(): FakeLaneWriter {
    if (this.owner) throw new Error('A scratch log has no scratch log of its own');
    const open = this.scratch;
    if (open) return open;
    if (this.cursor !== null) throw new Error(`Lane ${this.lane} has been read already and continues from its cursor`);
    return this.scratchWriter = new FakeLaneWriter(this.shared, this.lane, scratchKeyOf(this.key), this);
  }

  promote(): void {
    if (this.owner) return;
    this.lanes.drop(scratchKeyOf(this.key));
    this.scratchWriter?.ledger?.clear();
    this.scratchWriter = undefined;
  }

  commit(batch: AgentLaneBatch): void {
    const inputs: FakeInput[] = [];
    const started = new Set<string>(), committed = new Set<string>();
    const start = (turnId: string | undefined, at: string) => {
      if (!turnId || started.has(turnId)) return;
      started.add(turnId);
      if (!this.entity(turnMetaId(turnId, 'started'))) inputs.push(turnStartInput(turnId, at));
    };
    for (const event of batch.events) {
      if (batch.reproject) {
        if (!this.canReproject(event)) continue;
        const saved = this.entity(event.nativeId)!.payload as NativeWorkbenchEvent;
        inputs.push(eventInput({ ...saved, sequence: 0, sessionId: event.sessionId, data: { ...saved.data, ...event.data } }));
        continue;
      }
      start(event.nativeTurnId, event.createdAt);
      inputs.push(eventInput(event));
      committed.add(event.nativeId);
    }
    for (const { finalId, event } of batch.drafts ?? []) {
      if (committed.has(finalId)) continue;
      const known = this.entity(finalId);
      if (batch.reproject && known?.kind !== DRAFT_KIND) continue;
      if (known && known.kind !== DRAFT_KIND && known.kind !== TOMBSTONE_KIND) continue;
      start(event.nativeTurnId, event.createdAt);
      inputs.push(draftInput(finalId, event));
    }
    for (const nativeId of batch.retire ?? []) {
      const known = this.entity(nativeId);
      if (batch.reproject && known?.kind !== DRAFT_KIND) continue;
      if (known && known.kind !== TOMBSTONE_KIND) inputs.push({ kind: TOMBSTONE_KIND, nativeId, payload: {} });
    }
    this.lanes.append(this.key, inputs, { cursor: batch.cursor });
    const last = [...batch.events, ...(batch.drafts ?? []).map(draft => draft.event)].findLast(event => event.nativeTurnId)?.nativeTurnId;
    if (last && !batch.reproject && !batch.ended) this.turn = last;
  }

  canReproject(event: NativeWorkbenchEvent): boolean {
    const known = this.entity(event.nativeId);
    if (!known || known.kind !== event.type) return false;
    const saved = known.payload as NativeWorkbenchEvent;
    if (!event.nativeAliases?.some(alias => saved.nativeAliases?.includes(alias))) return false;
    const toolCallId = event.data.toolCallId;
    return !(event.data.subagentResult && typeof toolCallId === 'string' && this.entity(subagentMetaId(toolCallId))?.kind === TOMBSTONE_KIND);
  }

  turnStarted(turnId: string, at: string, runId?: string): void {
    const kept = (this.entity(turnMetaId(turnId, 'started'))?.payload as { runId?: unknown } | undefined)?.runId;
    this.lanes.append(this.key, [turnStartInput(turnId, at, runId ?? (typeof kept === 'string' ? kept : undefined))]);
    this.turn = turnId;
  }

  turnEnded(turnId: string, status: AgentTurnStatus, at: string, error?: string): void {
    this.lanes.append(this.key, [
      ...(this.entity(turnMetaId(turnId, 'started')) ? [] : [turnStartInput(turnId, at)]),
      { kind: TURN_ENDED, nativeId: turnMetaId(turnId, 'ended'), turnId, at, payload: { turnId, status, ...(error ? { error: error.slice(0, 1000) } : {}) } },
    ]);
    this.turn = turnId;
  }

  turnEndStatus(turnId: string): AgentTurnStatus | undefined {
    return this.turnEnd(turnId)?.status;
  }

  turnEnd(turnId: string): { status: AgentTurnStatus; at: string; error?: string } | undefined {
    const ended = this.entity(turnMetaId(turnId, 'ended'));
    if (ended?.kind !== TURN_ENDED) return undefined;
    const { status, error } = ended.payload as { status?: unknown; error?: unknown };
    if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted') {
      return { status, at: ended.at, ...(typeof error === 'string' ? { error } : {}) };
    }
  }

  transaction(task: () => void): void {
    task();
  }

  turnReopened(turnId: string, at: string, cursor?: string): void {
    const ended = this.entity(turnMetaId(turnId, 'ended'));
    const inputs: FakeInput[] = ended?.kind === TURN_ENDED ? [{ kind: TOMBSTONE_KIND, nativeId: turnMetaId(turnId, 'ended'), turnId, at, payload: { turnId } }] : [];
    if (inputs.length || (cursor !== undefined && cursor !== this.cursor)) this.lanes.append(this.key, inputs, { cursor });
    this.turn = turnId;
  }

  child(toolCallId: string, agentId: string, info: AgentSubagentInfo = {}): FakeLaneWriter {
    const lane: SyncLane = `sub:${toolCallId}`;
    const writer = this.shared.children.get(toolCallId) ?? new FakeLaneWriter(this.shared, lane, lane);
    this.shared.children.set(toolCallId, writer);
    writer.bindIdentity(agentId);
    const nativeId = subagentMetaId(toolCallId);
    const known = this.entity(nativeId)?.payload as Partial<Record<keyof AgentSubagentInfo, unknown>> & { agentId?: unknown } | undefined;
    const kept = known?.agentId === agentId ? known : undefined;
    const field = (name: keyof AgentSubagentInfo) => {
      const value = info[name] ?? kept?.[name];
      return typeof value === 'string' && value ? { [name]: value } : {};
    };
    const turnId = this.entity(nativeId)?.turnId ?? this.toolEntities(toolCallId).find(row => row.kind === 'tool_call')?.turnId ?? this.currentTurn();
    this.lanes.append(this.key, [{ kind: SUBAGENT, nativeId, ...(turnId ? { turnId } : {}), payload: { toolCallId, agentId, lane, ...field('title'), ...field('subagentType'), ...field('model') } }]);
    return writer;
  }

  get subagents(): readonly AgentSubagentBinding[] {
    return this.lanes.entities(this.key).filter(row => row.kind === SUBAGENT && row.nativeId.startsWith('meta:subagent:')).flatMap(row => {
      const value = row.payload as Partial<AgentSubagentBinding>;
      if (typeof value.toolCallId !== 'string' || typeof value.agentId !== 'string') return [];
      return [{ toolCallId: value.toolCallId, agentId: value.agentId,
        ...(typeof value.title === 'string' ? { title: value.title } : {}),
        ...(typeof value.subagentType === 'string' ? { subagentType: value.subagentType } : {}),
        ...(typeof value.model === 'string' ? { model: value.model } : {}) }];
    });
  }

  /** The replacement's copy of a child log is not compared here: nothing in the Cursor source retires a binding. */
  retireSubagent(toolCallId: string): void {
    const binding = subagentMetaId(toolCallId);
    const kind = this.entity(binding)?.kind;
    if (kind !== SUBAGENT && kind !== TOMBSTONE_KIND) return;
    if (kind === SUBAGENT) this.commit({ events: [], retire: [binding, ...this.toolEntities(toolCallId).map(row => row.nativeId)], cursor: this.cursor });
    this.shared.children.delete(toolCallId);
  }

  rebuild(reason: 'identity-changed'): void {
    if (this.owner) { this.owner.rebuild(reason); return; }
    for (const key of this.lane === 'main' ? this.lanes.keys().filter(key => key !== this.key) : [scratchKeyOf(this.key)]) this.lanes.drop(key);
    this.lanes.rebuild(this.key);
    this.forget();
  }

  /** The first identity is only recorded; a different one starts the lane over. */
  bindIdentity(identity: string | undefined): void {
    if (identity === undefined || this.owner) return;
    const known = this.identity;
    if (known === identity) return;
    if (known !== undefined) this.rebuild('identity-changed');
    this.lanes.head(this.key).identity = identity;
  }

  /** The source has read everything there is: every scratch window of the session gives way. */
  caughtUp(): void {
    this.promote();
    for (const child of this.shared.children.values()) child.promote();
  }

  private forget(): void {
    this.ledger?.clear();
    this.scratchWriter?.ledger?.clear();
    this.scratchWriter = undefined;
    this.turn = undefined;
    if (this.lane !== 'main') return;
    for (const child of this.shared.children.values()) child.forget();
    this.shared.children.clear();
  }

  private currentTurn(): string | undefined {
    if (this.turn === undefined) this.turn = this.rows.findLast(row => row.turnId)?.turnId ?? null;
    return this.turn ?? undefined;
  }

  private writeActivity(activity: NativeActivity): void {
    const turnId = this.entity(activity.id)?.turnId ?? this.currentTurn();
    this.lanes.append(this.key, [eventInput(activityEvent('s', activity, turnId ? { nativeTurnId: turnId } : {}))]);
  }
}

/** One read of `source` as the core drives it: the lane is bound to the conversation the source reads, and once the source has caught up its scratch windows give way. */
export async function pullLane(source: AgentTranscriptSource, writer: FakeLaneWriter, signal: AbortSignal): Promise<{ caughtUp: boolean }> {
  writer.bindIdentity(source.identity());
  const result = await source.pull(writer, signal);
  if (result.caughtUp && !signal.aborted) writer.caughtUp();
  return result;
}
