import type { NativeBackendHost } from '../types.js';
import type { PiEntry } from './history.js';
import { isPiPrompt } from './projection.js';
import {
  messageOf,
  promptText,
  record,
  samePrompt,
  str,
  wake,
  type PiConversation,
  type PiDelivery,
  type RecordValue,
} from './runtime-shared.js';

/**
 * Matches the entries pi appended to the prompt the workbench sent. Only a unique user entry after
 * that prompt's fence claims the run; a rewrite or a second candidate leaves it unclaimed rather
 * than guessing, and nothing is replayed.
 */
export function restorePiDeliveries(host: NativeBackendHost, state: PiConversation): void {
  for (const run of host.listRuns?.(state.workbenchSessionId) ?? []) {
    const native = run.native;
    if (!native || native.nativeSessionId !== state.nativeSessionId) continue;
    if (native.nativeMessageId?.startsWith('msg:')) {
      state.turns.set(native.nativeMessageId.slice(4), { runId: run.id, commandId: run.commandId });
      continue;
    }
    if (!['dispatching', 'input_sent', 'uncertain'].includes(native.delivery) || !native.nativeInputBoundary || state.deliveries.has(run.commandId)) continue;
    try {
      const boundary = record(JSON.parse(native.nativeInputBoundary));
      if (boundary?.v !== 1 || !(boundary.lastEntryId === null || typeof boundary.lastEntryId === 'string') || !(boundary.leafId === null || typeof boundary.leafId === 'string')) continue;
      state.deliveries.set(run.commandId, {
        runId: run.id, commandId: run.commandId, text: native.renderedText ?? native.input.text,
        at: new Date(native.timings?.dispatchAt ?? Date.parse(run.createdAt)).toISOString(),
        lastEntryId: boundary.lastEntryId as string | null, leafId: boundary.leafId as string | null,
        recovered: true,
      });
    } catch { /* An invalid fence cannot establish receipt ownership. */ }
  }
}

export function reconcilePiEntries(host: NativeBackendHost, state: PiConversation, entries: PiEntry[]): void {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  // A native user entry must be after the complete append boundary and descend from the leaf
  // captured at dispatch. Count the whole candidate set before claiming either side.
  const candidates = new Map<PiDelivery, PiEntry[]>();
  for (const delivery of state.deliveries.values()) {
    if (delivery.entryId) continue;
    if (!delivery.recovered && delivery.disposition !== 'started' && delivery.expectedText === undefined) continue;
    const index = delivery.lastEntryId === null ? -1 : entries.findIndex(entry => entry.id === delivery.lastEntryId);
    if (delivery.lastEntryId !== null && index < 0) continue;
    const users = entries.slice(index + 1).filter(entry => {
      if (!isPiPrompt(entry) || !samePrompt(delivery.expectedText ?? delivery.text, promptText(entry))) return false;
      if (!Number.isFinite(Date.parse(entry.timestamp)) || Date.parse(entry.timestamp) < Date.parse(delivery.at)) return false;
      let parent = entry.parentId ?? null;
      const seen = new Set<string>();
      while (parent !== delivery.leafId) {
        if (parent === null || seen.has(parent)) return false;
        seen.add(parent);
        const ancestor = byId.get(parent);
        if (!ancestor || isPiPrompt(ancestor)) return false;
        parent = ancestor.parentId ?? null;
      }
      return true;
    });
    candidates.set(delivery, users);
  }
  for (const [delivery, users] of candidates) {
    if (users.length !== 1) continue;
    const entry = users[0]!;
    if ([...candidates.values()].filter(values => values.some(value => value.id === entry.id)).length !== 1) continue;
    if ([...state.turns.keys()].includes(entry.id)) continue;
    delivery.entryId = entry.id;
    state.turns.set(entry.id, { commandId: delivery.commandId, runId: delivery.runId });
    // The JSONL reader may have consumed the user entry before the get_entries response arrived.
    // A tagged receipt publishes the now-proven association without replaying provider input.
    host.emitEvent(state.workbenchSessionId, {
      sequence: 0, sessionId: state.workbenchSessionId, runId: delivery.runId,
      type: 'native_input_receipt', nativeId: `msg:${entry.id}`, nativeTurnId: entry.id,
      createdAt: entry.timestamp,
      data: { commandId: delivery.commandId, nativeSessionId: state.nativeSessionId },
    });
    if (!delivery.recovered) {
      state.activeTurn = entry.id;
      state.activeRunId = delivery.runId;
      for (const draft of state.drafts.values()) if (draft.turnId === delivery.commandId) draft.turnId = entry.id;
      state.streamTurn = entry.id;
    } else {
      state.deliveries.delete(delivery.commandId);
    }
  }
  for (const entry of entries) {
    const message = messageOf(entry);
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : undefined;
    if (timestamp === undefined) continue;
    for (const draft of state.drafts.values()) {
      if (draft.entryId || draft.messageTimestamp !== timestamp) continue;
      draft.entryId = entry.id;
    }
    state.metering.recordEntry(state.workbenchSessionId, entry, message, timestamp, byId, state.turns);
  }
  state.boundary = entries.at(-1)?.id ?? state.boundary;
  wake(state);
}

export function handlePiUpdate(state: PiConversation, frame: RecordValue): void {
  const update = record(frame.assistantMessageEvent);
  const kind = str(update?.type);
  if (!update || !kind) return;
  const partial = record(frame.message);
  const messageTimestamp = typeof partial?.timestamp === 'number' ? partial.timestamp : undefined;
  state.metering.update(state.assistantStep, kind, str(update.delta), messageTimestamp, state.activeTurn ?? state.streamTurn, state.activeRunId);
  const contentIndex = typeof update.contentIndex === 'number' && Number.isSafeInteger(update.contentIndex) && update.contentIndex >= 0 ? update.contentIndex : 0;
  const thought = kind.startsWith('thinking');
  if (!thought && !kind.startsWith('text')) return;
  if (!kind.endsWith('_start') && !kind.endsWith('_delta') && !kind.endsWith('_end')) return;
  const turn = state.activeTurn ?? state.streamTurn ?? 'live';
  const key = `${state.workbenchSessionId}:${state.activeRunId ?? turn}:${state.assistantStep}:${contentIndex}:${thought ? 'thinking' : 'text'}`;
  const draft = state.drafts.get(key) ?? {
    key,
    contentIndex,
    thought,
    text: '',
    at: new Date().toISOString(),
    ...(state.activeTurn ? { entryId: undefined, turnId: state.activeTurn } : { turnId: state.streamTurn }),
    ...(state.activeRunId ? { runId: state.activeRunId } : {}),
  };
  if (kind.endsWith('_delta')) draft.text += str(update.delta) ?? '';
  if (kind.endsWith('_end')) {
    const content = str(update.content);
    if (content) draft.text = content;
  }
  if (messageTimestamp !== undefined) draft.messageTimestamp = messageTimestamp;
  state.drafts.set(key, draft);
  wake(state);
}
