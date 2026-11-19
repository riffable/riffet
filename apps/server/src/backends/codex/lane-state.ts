import { createHash } from 'node:crypto';
import type { NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import type { CodexIngestState } from './journal-space.js';
import { rowTextKey } from './project-item.js';
import { codexPlanNativeId, isProvisionalItemId, isSpawnAgentItem, isSubagentStart } from './transcript.js';
import type { RpcItem } from './types.js';
import { asArray, asRecord, str } from './util.js';

/*
 * The cursor a Codex lane stores and the pure functions over it: encoding, the TRAE positional-row
 * bookkeeping that is checkpointed with it, and the projections that need no transcript source.
 * It owns no state: every function works on what it is given, and `CodexTranscriptSource` decides when to call it.
 */

/** How far a lane has read its thread: the v2 ingest state, and the subagents still running. */
export interface LaneState extends Omit<CodexIngestState, 'v' | 'threadId'> {
  /** `[toolCallId, threadId]` of subagents spawned in this lane whose own lane has a running turn. */
  agents?: Array<[string, string]>;
  /** TRAE's positional rows and lasting text identities, checkpointed with the rows they describe. */
  copies?: TurnCopies[];
}

export interface TurnCopies {
  turnId: string;
  positional: Array<[nativeId: string, text?: string, lastingId?: string]>;
  shown: Array<[nativeId: string, text: string]>;
}

/** Keep text identities bounded even when the provider returns a large answer. */
function textDigest(event: NativeWorkbenchEvent): string | undefined {
  const text = rowTextKey(event);
  return text === undefined ? undefined : createHash('sha256').update(text).digest('base64');
}

export function decode(cursor: string | null): LaneState | undefined {
  if (cursor === null) return undefined;
  try {
    const parsed = JSON.parse(cursor) as CodexIngestState & LaneState;
    if (parsed?.v === 1 && (parsed.phase === 'ready' || parsed.phase === 'importing')) {
      const { v: _v, threadId: _thread, ...state } = parsed;
      return state;
    }
  } catch { /* not one of ours */ }
  // A cursor this reader cannot place is read again from the start; what the log holds already writes nothing.
  return { phase: 'importing' };
}

/** The thread a lane's cursor was written for. */
export function cursorThread(cursor: string | null): string | undefined {
  if (cursor === null) return undefined;
  try { return str((JSON.parse(cursor) as CodexIngestState).threadId); } catch { return undefined; }
}

const NEW_TOPIC_BOUNDARY = 'codex-new-topic';
/** The `nativeInputBoundary` of the message that ends `threadId` for a new topic. */
export function newTopicBoundary(threadId: string): string { return JSON.stringify({ type: NEW_TOPIC_BOUNDARY, after: threadId }); }
/** The thread a `nativeInputBoundary` says its message ended, when it is a new topic's. */
export function newTopicAfter(boundary: string | undefined): string | undefined {
  if (!boundary) return undefined;
  try {
    const parsed = asRecord(JSON.parse(boundary));
    return parsed?.type === NEW_TOPIC_BOUNDARY ? str(parsed.after) : undefined;
  } catch { return undefined; }
}

export function encode(threadId: string, state: LaneState): string {
  const { phase, settled, open, turns, agents, copies } = state;
  return JSON.stringify({
    v: 1, threadId, phase, ...(settled ? { settled } : {}), ...(open ? { open } : {}), turns: turns ?? 0, ...(agents?.length ? { agents } : {}), ...(copies?.length ? { copies } : {}),
  });
}

export const turnTime = (seconds: unknown): string | undefined => typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined;

/** The thread a spawning item created. */
export function spawnedThread(item: RpcItem): string | undefined {
  if (isSubagentStart(item)) return str(item.agentThreadId);
  if (item.type !== 'collabAgentToolCall' || !isSpawnAgentItem(item)) return undefined;
  return asArray<unknown>(item.receiverThreadIds).map(str).find(Boolean);
}

/** Threads a later collaboration call or child notice names: each may have run again. */
export function namedThreads(item: RpcItem): string[] {
  if (item.type === 'subAgentActivity') return [str(item.agentThreadId)].filter((id): id is string => Boolean(id));
  if (item.type !== 'collabAgentToolCall') return [];
  return asArray<unknown>(item.receiverThreadIds).map(str).filter((id): id is string => Boolean(id));
}

/** The positional-row record of `turnId`, created on first use. */
export function copiesOf(state: LaneState, turnId: string): TurnCopies {
  state.copies ??= [];
  let copies = state.copies.find(copy => copy.turnId === turnId);
  if (!copies) state.copies.push(copies = { turnId, positional: [], shown: [] });
  return copies;
}

/** Reconcile only positional aliases; two lasting messages may legitimately contain identical text. */
export function reconcile(copies: TurnCopies, itemId: string | undefined, rows: NativeWorkbenchEvent[]): { events: NativeWorkbenchEvent[]; retire: string[] } {
  const events: NativeWorkbenchEvent[] = [], retire: string[] = [];
  for (const event of rows) {
    const text = textDigest(event);
    if (isProvisionalItemId(itemId)) {
      // Tool text is not an identity: the same command can run twice in a turn. Wait for
      // its lasting id instead of showing an unmatchable copy beside live notifications.
      if (event.type === 'tool_call' || event.type === 'tool_call_update') { retire.push(event.nativeId); continue; }
      let entry = copies.positional.find(([id]) => id === event.nativeId);
      if (!entry) copies.positional.push(entry = [event.nativeId]);
      entry[1] = text;
      // Keep claimed aliases in the cursor: history and duplicate notifications must not claim
      // a second lasting row or spend the same lasting row on another identical message.
      if (!entry[2] && text) entry[2] = copies.shown.find(([id, shown]) => shown === text && !copies.positional.some(([, , lasting]) => lasting === id))?.[0];
      if (entry[2]) { retire.push(event.nativeId); continue; }
    } else if (text) {
      const shown = copies.shown.find(([id]) => id === event.nativeId);
      if (shown) shown[1] = text; else copies.shown.push([event.nativeId, text]);
      const positional = copies.positional.find(([, , lasting]) => lasting === event.nativeId)
        ?? copies.positional.find(([, previous, lasting]) => !lasting && previous === text);
      if (positional) { positional[2] = event.nativeId; retire.push(positional[0]); }
    }
    events.push(event);
  }
  return { events, retire };
}

export function planEvent(sessionId: string, threadId: string, turnId: string, entries: Array<Record<string, unknown>>, at: string, runId: string | undefined): NativeWorkbenchEvent {
  return {
    sequence: 0, sessionId, runId: runId ?? turnId, type: 'plan', nativeId: codexPlanNativeId(threadId, turnId), nativeTurnId: turnId,
    createdAt: at, data: { sessionUpdate: 'plan', entries },
  };
}
