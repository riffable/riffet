import type { NativeActivity, NativeWorkbenchEvent, WorkbenchEvent } from '../../contracts/src/index.js';

export interface ProjectedEvent extends WorkbenchEvent {
  projectionKey: string;
  sourceEvents: WorkbenchEvent[];
}

const compactSystemUpdates = new Set(['current_mode_update', 'available_commands_update', 'session_ready']);
const textChunkTypes = new Set(['agent_message_chunk', 'user_message_chunk', 'agent_thought_chunk']);
const toolCallTypes = new Set(['tool_call', 'tool_call_update']);

function chunkText(event: WorkbenchEvent): string | undefined {
  const content = event.data.content;
  if (content && typeof content === 'object') {
    const text = (content as Record<string, unknown>).text;
    if (typeof text === 'string') return text;
  }
  return typeof event.data.text === 'string' ? event.data.text : undefined;
}

function toolCallId(event: WorkbenchEvent): string | undefined {
  return typeof event.data.toolCallId === 'string' && event.data.toolCallId ? event.data.toolCallId : undefined;
}

function toolIndexKey(event: WorkbenchEvent, id: string): string {
  return event.runId ? `${event.runId}\u0000${id}` : id;
}

/**
 * The card an update belongs to. A card opened before its turn was bound to a run has no runId, so
 * a later run-scoped update misses its precise key; it still belongs to that card, and the precise
 * key is filed so the rest of the updates resolve directly.
 */
function toolCardIndex(tools: Map<string, number>, cards: readonly WorkbenchEvent[], event: WorkbenchEvent, id: string): number | undefined {
  const key = toolIndexKey(event, id);
  const exact = tools.get(key);
  if (exact !== undefined || !event.runId) return exact;
  const unbound = tools.get(id);
  if (unbound === undefined || cards[unbound]?.runId) return undefined;
  tools.set(key, unbound);
  return unbound;
}

function toolProjectionKey(event: WorkbenchEvent, id: string): string {
  const run = event.runId ? `${encodeURIComponent(event.runId)}:` : '';
  return `tool:${run}${encodeURIComponent(id)}`;
}

function diffItems(content: unknown): unknown[] {
  return Array.isArray(content)
    ? content.filter(item => item !== null && typeof item === 'object' && (item as Record<string, unknown>).type === 'diff')
    : [];
}

/**
 * An update's fields replace the card's, except that an update whose `content` has no diff keeps
 * the diffs already on the card: a result's acknowledgement text must not erase the edit it made.
 * A failed result drops them, so the card never shows a rejected edit as if it had been applied.
 */
function mergeToolData(previous: WorkbenchEvent['data'], update: WorkbenchEvent['data']): WorkbenchEvent['data'] {
  const merged = { ...previous, ...update };
  const kept = diffItems(previous.content);
  if (kept.length && update.status !== 'failed' && Array.isArray(update.content) && !diffItems(update.content).length) merged.content = [...kept, ...update.content];
  return merged;
}

function projected(event: WorkbenchEvent, projectionKey: string): ProjectedEvent {
  return { ...event, projectionKey, sourceEvents: [event] };
}

const activityKinds = new Set<NativeActivity['kind']>(['compaction', 'background_task', 'local_command']);
const activityStatuses = new Set<NativeActivity['status']>(['running', 'stopping', 'completed', 'failed', 'stopped', 'unknown']);

/**
 * The CLI activity an event carries: `session/update` with `sessionUpdate: 'activity'`. Servers that
 * name the event by its update kind send `type: 'activity'`; both read the same. An unknown status
 * degrades to `unknown` so a newer server's state still shows a row; an unknown kind has no rendering.
 */
export function activityOf(event: WorkbenchEvent): NativeActivity | undefined {
  if (event.type !== 'activity' && event.data.sessionUpdate !== 'activity') return undefined;
  const value = event.data.activity;
  if (!value || typeof value !== 'object') return undefined;
  const activity = value as Partial<NativeActivity>;
  if (typeof activity.id !== 'string' || !activity.id || !activityKinds.has(activity.kind!)) return undefined;
  return {
    ...activity,
    id: activity.id,
    kind: activity.kind!,
    status: activityStatuses.has(activity.status!) ? activity.status! : 'unknown',
    title: typeof activity.title === 'string' ? activity.title : '',
  };
}

function activityIndexKey(id: string): string {
  return `activity:${id}`;
}

const activityEnded = new Set<NativeActivity['status']>(['completed', 'failed', 'stopped']);

/**
 * Whether `next` is the later state of an activity than `current`: an end state beats one still in
 * progress within one execution, between end states the later `endedAt` wins, and otherwise the
 * larger sequence. A reused agent id needs a different launching call and a later start.
 */
function supersedesActivity(next: WorkbenchEvent, current: WorkbenchEvent): boolean {
  const a = activityOf(next);
  const b = activityOf(current);
  if (!a || !b) return true;
  if (a.kind === 'background_task' && b.kind === 'background_task' && a.task?.kind === 'agent' && b.task?.kind === 'agent'
    && a.toolCallId && b.toolCallId && a.toolCallId !== b.toolCallId) {
    const nextStart = Date.parse(a.startedAt ?? ''), currentStart = Date.parse(b.startedAt ?? '');
    return Number.isFinite(nextStart) && Number.isFinite(currentStart) && nextStart > currentStart;
  }
  const nextEnded = activityEnded.has(a.status);
  if (nextEnded !== activityEnded.has(b.status)) return nextEnded;
  if (nextEnded) {
    const nextAt = Date.parse(a.endedAt ?? '');
    const currentAt = Date.parse(b.endedAt ?? '');
    if (Number.isFinite(nextAt) && Number.isFinite(currentAt) && nextAt !== currentAt) return nextAt > currentAt;
  }
  return next.sequence >= current.sequence;
}

/**
 * Files an activity state: the first one takes a row, every later state of the same id replaces that
 * row's content where it stands. Returns the row's index and whether it is new.
 */
function fileActivity(result: ProjectedEvent[], indexes: Map<string, number>, event: WorkbenchEvent, id: string): { index: number; created: boolean } {
  const key = activityIndexKey(id);
  const index = indexes.get(key);
  const previous = index === undefined ? undefined : result[index];
  if (index === undefined || !previous) {
    indexes.set(key, result.length);
    result.push({ ...projected(event, key), type: 'activity' });
    return { index: result.length - 1, created: true };
  }
  const current = previous.sourceEvents.findLast((source) => source.data === previous.data) ?? previous;
  // A state seen after a newer one (a reconnect restating an old sequence) must not roll it back.
  result[index] = supersedesActivity(event, current)
    ? { ...previous, data: event.data, raw: event.raw ?? previous.raw, sourceEvents: [...previous.sourceEvents, event] }
    : { ...previous, sourceEvents: [...previous.sourceEvents, event] };
  return { index, created: false };
}

function eventIdentity(event: WorkbenchEvent): string {
  const nativeId = (event as WorkbenchEvent & { nativeId?: unknown }).nativeId;
  return typeof nativeId === 'string' && nativeId ? nativeId : String(event.sequence);
}

function nativeMessageIdentity(event: WorkbenchEvent): string | undefined {
  const nativeId = (event as WorkbenchEvent & { nativeId?: unknown }).nativeId;
  if (typeof nativeId !== 'string' || !nativeId) return undefined;
  const parts = /^(\d+):(.+):(\d+)$/.exec(nativeId);
  return parts ? `${parts[1]}:${parts[2]}` : nativeId;
}

export function messagePhase(event: WorkbenchEvent): 'commentary' | 'final_answer' | undefined {
  const phase = event.type === 'agent_message_chunk' ? event.data.phase : undefined;
  return phase === 'commentary' || phase === 'final_answer' ? phase : undefined;
}

function mergeTextData(previous: WorkbenchEvent, event: WorkbenchEvent, text: string): WorkbenchEvent['data'] {
  const phase = messagePhase(event) ?? messagePhase(previous);
  return {
    ...previous.data,
    ...(phase ? { phase } : {}),
    content: { ...(previous.data.content && typeof previous.data.content === 'object' ? previous.data.content as Record<string, unknown> : {}), type: 'text', text },
  };
}

function canJoinTextChunk(previous: WorkbenchEvent, event: WorkbenchEvent): boolean {
  if (previous.type !== event.type || (previous as Partial<NativeWorkbenchEvent>).nativeTurnId !== (event as Partial<NativeWorkbenchEvent>).nativeTurnId) return false;
  const previousMessageId = nativeMessageIdentity(previous);
  const messageId = nativeMessageIdentity(event);
  if (previousMessageId || messageId) return Boolean(previousMessageId && messageId && previousMessageId === messageId);
  // Without a message identity, a phase boundary must not be swallowed by same-run adjacency.
  return previous.runId === event.runId && messagePhase(previous) === messagePhase(event);
}

function phaseUpdateIndex(events: ProjectedEvent[], event: WorkbenchEvent): number | undefined {
  const messageId = nativeMessageIdentity(event);
  if (!messageId || !messagePhase(event) || chunkText(event) !== '') return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const previous = events[index]!;
    if (previous.sessionId === event.sessionId && previous.runId === event.runId &&
      canJoinTextChunk(previous, event) && chunkText(previous) !== undefined) return index;
  }
  return undefined;
}

function replayId(event: WorkbenchEvent): string | undefined {
  return typeof event.data.replayId === 'string' && event.data.replayId ? event.data.replayId : undefined;
}

function isReplayProtocolEvent(event: WorkbenchEvent): boolean {
  return event.type === 'history_replay_start' || event.type === 'history_replay' || event.type === 'history_replay_end';
}

function conversationSourceEvents(events: WorkbenchEvent[]): WorkbenchEvent[] {
  const sorted = [...events].sort((left, right) => left.sequence - right.sequence);
  const starts = new Map<string, number>();
  let selected: { id: string; start: number; end: number } | undefined;

  for (const event of sorted) {
    const id = replayId(event);
    if (!id) continue;
    if (event.type === 'history_replay_start') starts.set(id, event.sequence);
    if (event.type === 'history_replay_end') {
      const start = starts.get(id);
      if (start !== undefined && start < event.sequence && (!selected || event.sequence > selected.end)) {
        selected = { id, start, end: event.sequence };
      }
    }
  }

  const isReplayRow = (event: WorkbenchEvent) => event.type === 'history_replay';
  if (!selected) return sorted.filter((event) => !isReplayProtocolEvent(event));

  const replayRows = sorted
    .filter((event) => isReplayRow(event) && replayId(event) === selected!.id && event.sequence > selected!.start && event.sequence < selected!.end)
    .map((event) => ({
      ...event,
      type: typeof event.data.sessionUpdate === 'string' ? event.data.sessionUpdate : 'extension_update',
    }));
  const liveEvents = sorted.filter((event) => event.sequence > selected!.end && !isReplayProtocolEvent(event));
  return [...replayRows, ...liveEvents].sort((left, right) => left.sequence - right.sequence);
}

/**
 * Builds a readable conversation timeline while leaving the persisted event list untouched.
 * Only adjacent message chunks of the same type/run are joined. Tool updates are keyed by
 * run and toolCallId, so an id reused by a later run cannot move or overwrite an earlier card.
 */
export function projectEvents(events: WorkbenchEvent[]): ProjectedEvent[] {
  const result: ProjectedEvent[] = [];
  const toolIndexes = new Map<string, number>();
  let lastTextChunkIndex: number | undefined;

  for (const event of conversationSourceEvents(events)) {
    if (compactSystemUpdates.has(event.type)) {
      lastTextChunkIndex = undefined;
      continue;
    }

    const activity = activityOf(event);
    if (activity) {
      if (fileActivity(result, toolIndexes, event, activity.id).created) lastTextChunkIndex = undefined;
      continue;
    }

    const id = toolCallTypes.has(event.type) ? toolCallId(event) : undefined;
    if (id) {
      const indexKey = toolIndexKey(event, id);
      const index = toolCardIndex(toolIndexes, result, event, id);
      if (index === undefined) {
        toolIndexes.set(indexKey, result.length);
        // Older transports can omit runId on a tool update. Keep the first id-only alias
        // for those updates; run-scoped events still resolve through their precise key.
        if (!toolIndexes.has(id)) toolIndexes.set(id, result.length);
        result.push(projected(event, toolProjectionKey(event, id)));
      } else {
        const previous = result[index];
        if (!previous) continue;
        result[index] = {
          ...previous,
          type: 'tool_call',
          data: mergeToolData(previous.data, event.data),
          raw: event.raw ?? previous.raw,
          sourceEvents: [...previous.sourceEvents, event],
        };
      }
      lastTextChunkIndex = undefined;
      continue;
    }

    const phaseIndex = phaseUpdateIndex(result, event);
    if (phaseIndex !== undefined) {
      const previous = result[phaseIndex]!;
      result[phaseIndex] = {
        ...previous,
        data: mergeTextData(previous, event, chunkText(previous)!),
        sourceEvents: [...previous.sourceEvents, event],
      };
      if (phaseIndex !== lastTextChunkIndex) lastTextChunkIndex = undefined;
      continue;
    }

    const text = textChunkTypes.has(event.type) ? chunkText(event) : undefined;
    const previous = lastTextChunkIndex === undefined ? undefined : result[lastTextChunkIndex];
    if (text !== undefined && previous && canJoinTextChunk(previous, event)) {
      const priorText = chunkText(previous);
      if (priorText !== undefined) {
        result[lastTextChunkIndex!] = {
          ...previous,
          data: mergeTextData(previous, event, priorText + text),
          sourceEvents: [...previous.sourceEvents, event],
        };
        continue;
      }
    }

    result.push(projected(event, 'event:' + eventIdentity(event)));
    lastTextChunkIndex = text === undefined ? undefined : result.length - 1;
  }

  return result;
}

/**
 * Incrementally projects an ordered batch appended to an existing native transcript. The output
 * array is updated in place: unchanged historical entries retain both their position and object
 * identity, while a streaming text tail or an existing tool card replaces only its own entry.
 * Replay snapshots use the full projector because their boundaries can change the whole source.
 */
export function appendProjectedEvents(
  result: ProjectedEvent[],
  incoming: WorkbenchEvent[],
  indexes: { tools: Map<string, number>; lastTextChunkIndex?: number },
): { projected: ProjectedEvent[]; appended: number; updated: number; changedIndexes: number[] } {
  if (incoming.some(isReplayProtocolEvent)) return { projected: projectEvents(incoming), appended: -1, updated: 0, changedIndexes: [] };
  let appended = 0;
  let updated = 0;
  const changedIndexes: number[] = [];
  let lastTextChunkIndex = indexes.lastTextChunkIndex;

  for (const event of incoming) {
    if (compactSystemUpdates.has(event.type)) {
      lastTextChunkIndex = undefined;
      continue;
    }

    const activity = activityOf(event);
    if (activity) {
      const filed = fileActivity(result, indexes.tools, event, activity.id);
      if (filed.created) { appended += 1; lastTextChunkIndex = undefined; } else updated += 1;
      changedIndexes.push(filed.index);
      continue;
    }

    const id = toolCallTypes.has(event.type) ? toolCallId(event) : undefined;
    if (id) {
      const indexKey = toolIndexKey(event, id);
      const index = toolCardIndex(indexes.tools, result, event, id);
      if (index === undefined) {
        indexes.tools.set(indexKey, result.length);
        if (!indexes.tools.has(id)) indexes.tools.set(id, result.length);
        result.push(projected(event, toolProjectionKey(event, id)));
        appended += 1;
        changedIndexes.push(result.length - 1);
      } else {
        const previous = result[index];
        if (previous) {
          result[index] = {
            ...previous,
            type: 'tool_call',
            data: mergeToolData(previous.data, event.data),
            raw: event.raw ?? previous.raw,
            sourceEvents: [...previous.sourceEvents, event],
          };
          updated += 1;
          changedIndexes.push(index);
        }
      }
      lastTextChunkIndex = undefined;
      continue;
    }

    const phaseIndex = phaseUpdateIndex(result, event);
    if (phaseIndex !== undefined) {
      const previous = result[phaseIndex]!;
      result[phaseIndex] = {
        ...previous,
        data: mergeTextData(previous, event, chunkText(previous)!),
        sourceEvents: [...previous.sourceEvents, event],
      };
      updated += 1;
      changedIndexes.push(phaseIndex);
      if (phaseIndex !== lastTextChunkIndex) lastTextChunkIndex = undefined;
      continue;
    }

    const text = textChunkTypes.has(event.type) ? chunkText(event) : undefined;
    const previous = lastTextChunkIndex === undefined ? undefined : result[lastTextChunkIndex];
    if (text !== undefined && previous && canJoinTextChunk(previous, event)) {
      const priorText = chunkText(previous);
      if (priorText !== undefined) {
        result[lastTextChunkIndex!] = {
          ...previous,
          data: mergeTextData(previous, event, priorText + text),
          sourceEvents: [...previous.sourceEvents, event],
        };
        updated += 1;
        changedIndexes.push(lastTextChunkIndex!);
        continue;
      }
    }

    result.push(projected(event, 'event:' + eventIdentity(event)));
    appended += 1;
    changedIndexes.push(result.length - 1);
    lastTextChunkIndex = text === undefined ? undefined : result.length - 1;
  }

  indexes.lastTextChunkIndex = lastTextChunkIndex;
  return { projected: result, appended, updated, changedIndexes };
}

export function projectionIndexes(projectedEvents: ProjectedEvent[], lastRawEvent?: WorkbenchEvent): { tools: Map<string, number>; lastTextChunkIndex?: number } {
  const tools = new Map<string, number>();
  let lastTextChunkIndex: number | undefined;
  projectedEvents.forEach((event, index) => {
    if (event.projectionKey.startsWith('activity:')) tools.set(event.projectionKey, index);
    else if (event.projectionKey.startsWith('tool:')) {
      const id = toolCallId(event);
      if (id) {
        tools.set(toolIndexKey(event, id), index);
        if (!tools.has(id)) tools.set(id, index);
      }
    }
  });
  const last = projectedEvents.at(-1);
  if (last && lastRawEvent && textChunkTypes.has(lastRawEvent.type) && last.type === lastRawEvent.type && last.runId === lastRawEvent.runId && last.sourceEvents.at(-1) === lastRawEvent) {
    lastTextChunkIndex = projectedEvents.length - 1;
  }
  return { tools, lastTextChunkIndex };
}
