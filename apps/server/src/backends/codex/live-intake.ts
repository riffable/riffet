import type { NativeActivity, NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { messagePhase } from './drafts.js';
import { notificationSpan } from './item-spans.js';
import { normalizePlanEntries } from './rollout-plan.js';
import { isFinalTurnStatus, turnStatus, type ItemSpan } from './transcript.js';
import type { RpcItem, RpcTurn } from './types.js';
import { asRecord, str, toIso } from './util.js';
import { turnTime } from './lane-state.js';

/*
 * What the app-server's notifications said since the last read of the thread, kept until the transcript
 * source writes it. It owns the queued operations, the streamed drafts, the answer phases streamed for
 * items, and the lifecycle state the live feed reported per turn.
 *
 * It does not decide when the thread is read (`repairSoon` and the wake-up it returns only say that one is
 * due), does not write to a lane, and does not know the questions or subagents: the source answers
 * `item/tool/requestUserInput` itself before handing a notification here.
 */

/** Streamed answer phases remembered for items whose settled copy does not state one. */
const PHASES_KEPT = 1_000;
/** Live notifications kept between reads; more than this and the next read takes them from the thread. */
const LIVE_LIMIT = 5_000;

export type LiveOp =
  | { kind: 'turn'; turnId: string; at?: string }
  | { kind: 'item'; turnId: string; item: RpcItem; committed: boolean; at?: string; span?: ItemSpan }
  | { kind: 'draft'; turnId: string; itemId: string }
  | { kind: 'plan'; turnId: string; entries: Array<Record<string, unknown>>; at: string }
  | { kind: 'activity'; activity: NativeActivity };

interface Draft { turnId: string; reasoning: boolean; text: string; phase?: 'commentary' | 'final_answer'; channel?: string; part?: number }

/** What `CodexLiveIntake` needs from the transcript source that owns it. */
export interface CodexLiveIntakeContext {
  sessionId: string;
  /** Whether the source wrote the end of `turnId` of the thread it follows. */
  turnEnded(turnId: string): boolean;
  /** The newest settled turn the main lane's cursor names. */
  settledTurn(): string | undefined;
  /** The thread has to be read: something the feed said is not final until its settled copy is in. */
  repairSoon(): void;
}

export class CodexLiveIntake {
  private ops: LiveOp[] = [];
  private readonly drafts = new Map<string, Draft>();
  private readonly phases = new Map<string, 'commentary' | 'final_answer'>();
  /** Ordered lifecycle notifications, independent of lagging history snapshots. Ephemeral. */
  private readonly liveTurns = new Map<string, string>();

  constructor(private readonly context: CodexLiveIntakeContext) {}

  /** Another thread is followed: nothing said about the previous one applies. */
  reset(): void {
    this.liveTurns.clear();
    this.ops = [];
    this.drafts.clear();
    this.phases.clear();
  }

  push(op: LiveOp): void {
    if (this.ops.length >= LIVE_LIMIT) {
      // More than a read can be bothered to replay: the thread has it all, and the next read takes it from there.
      this.ops = [];
      this.drafts.clear();
      this.context.repairSoon();
    }
    this.ops.push(op);
    if (op.kind !== 'activity' && (op.turnId === this.context.settledTurn() || this.context.turnEnded(op.turnId))) this.context.repairSoon();
  }

  /** Takes one notification in; says whether the reader should wake now, soon (streamed text), or not at all. */
  note(method: string, params: Record<string, unknown>): 'now' | 'soon' | undefined {
    const turnId = str(params.turnId);
    if (method === 'item/agentMessage/delta' || method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      const itemId = str(params.itemId);
      const delta = params.delta;
      if (!turnId || !itemId || typeof delta !== 'string') return undefined;
      const reasoning = method !== 'item/agentMessage/delta';
      const channel = method === 'item/reasoning/summaryTextDelta' ? 'summary' : method === 'item/reasoning/textDelta' ? 'raw' : undefined;
      let draft = this.drafts.get(itemId);
      if (!draft) this.drafts.set(itemId, draft = { turnId, reasoning, text: '', ...(channel ? { channel } : {}) });
      // Raw reasoning and its summary are one thought; the draft follows the channel that streamed first.
      if (draft.channel !== channel) return undefined;
      const index = reasoning ? (channel === 'summary' ? params.summaryIndex : params.contentIndex) : undefined;
      const part = typeof index === 'number' && Number.isSafeInteger(index) ? index : undefined;
      if (part !== undefined && draft.part !== undefined && part !== draft.part && draft.text) draft.text += '\n\n';
      if (part !== undefined) draft.part = part;
      draft.text += delta;
      const phase = messagePhase(params.phase);
      if (phase) { draft.phase = phase; this.notePhase(itemId, phase); }
      const last = this.ops.at(-1);
      if (!(last?.kind === 'draft' && last.itemId === itemId)) this.push({ kind: 'draft', turnId, itemId });
      return 'soon';
    }
    if (method === 'turn/started') {
      const turn = asRecord(params.turn);
      const id = str(turn?.id);
      if (!id) return undefined;
      // Duplicate starts delivered after a known live end do not restart an immutable turn id.
      if (!this.liveTurns.has(id)) this.liveTurns.set(id, 'inProgress');
      const at = turnTime(turn?.startedAt);
      this.push({ kind: 'turn', turnId: id, ...(at ? { at } : {}) });
      return 'now';
    }
    if (method === 'turn/completed') {
      const turn = asRecord(params.turn) as RpcTurn | undefined;
      if (turn?.id && isFinalTurnStatus(turn.status)) {
        this.liveTurns.set(turn.id, turnStatus(turn.status));
        if (this.liveTurns.size > PHASES_KEPT) this.liveTurns.delete(this.liveTurns.keys().next().value!);
      }
      // The settled copy of the turn is read before its end is written (G6).
      this.context.repairSoon();
      return 'now';
    }
    if (method === 'turn/plan/updated') {
      const entries = normalizePlanEntries(params.plan);
      if (!turnId || !entries) return undefined;
      this.push({ kind: 'plan', turnId, entries, at: new Date().toISOString() });
      return 'now';
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = asRecord(params.item) as RpcItem | undefined;
      if (!item || !turnId) return undefined;
      const phase = item.type === 'agentMessage' ? messagePhase(item.phase) : undefined;
      if (phase && item.id) this.notePhase(item.id, phase);
      // A compaction's states reach the ledger from the runtime's tracker (`activity`), which also knows its tokens and summary.
      if (item.type === 'contextCompaction') return undefined;
      const at = toIso(Number(params.startedAtMs));
      const span = notificationSpan(method, params, item);
      this.push({ kind: 'item', turnId, item, committed: method === 'item/completed', ...(at ? { at } : {}), ...(span ? { span } : {}) });
      if (method === 'item/completed' && item.id) this.drafts.delete(item.id);
      return 'now';
    }
    return undefined;
  }

  private notePhase(itemId: string, phase: 'commentary' | 'final_answer'): void {
    this.phases.set(itemId, phase);
    if (this.phases.size > PHASES_KEPT) this.phases.delete(this.phases.keys().next().value!);
  }

  /** A running turn of the feed stops counting as running when the connection that said so is lost: history alone decides it. */
  forgetRunning(): void {
    for (const [turnId, status] of this.liveTurns) if (status === 'inProgress') this.liveTurns.delete(turnId);
  }

  /** The status the feed gave `turnId`, when it did. */
  turnState(turnId: string): string | undefined { return this.liveTurns.get(turnId); }

  phaseOf(itemId: string): 'commentary' | 'final_answer' | undefined { return this.phases.get(itemId); }

  /** Whether notifications are queued for the next write. */
  get queued(): boolean { return this.ops.length > 0; }

  /** The queued notifications, which the caller writes now. */
  take(): LiveOp[] {
    const ops = this.ops;
    this.ops = [];
    return ops;
  }

  clearDrafts(): void { this.drafts.clear(); }

  /** The turn's settled copy is in: its streamed text is superseded. */
  dropDrafts(turnId: string): void {
    for (const [itemId, draft] of this.drafts) if (draft.turnId === turnId) this.drafts.delete(itemId);
  }

  /** The row of the text streamed so far for `itemId`, under the id its committed copy will have. */
  draftRow(threadId: string, itemId: string, runId: string | undefined): { finalId: string; event: NativeWorkbenchEvent } | undefined {
    const draft = this.drafts.get(itemId);
    if (!draft) return undefined;
    const kind = draft.reasoning ? 'thinking' : 'assistant';
    const type = draft.reasoning ? 'agent_thought_chunk' : 'agent_message_chunk';
    const finalId = `${threadId}:${draft.turnId}:${itemId}:${kind}`;
    // Deltas carry no phase; `item/started` named it, and the committed copy will say the same.
    const phase = draft.phase ?? this.phases.get(itemId);
    return {
      finalId,
      event: {
        sequence: 0, sessionId: this.context.sessionId, runId: runId ?? draft.turnId, type, nativeId: finalId, nativeTurnId: draft.turnId, createdAt: new Date().toISOString(),
        data: { sessionUpdate: type, ...(draft.reasoning ? { channel: draft.channel === 'summary' ? 'narration' : 'thinking' } : phase ? { phase } : {}), content: { type: 'text', text: draft.text } },
      },
    };
  }
}
