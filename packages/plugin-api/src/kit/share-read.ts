import type { NativeWorkbenchEvent } from '@riffet/contracts';
import { AppError } from './errors.js';

/** The generic part of reading a conversation for a share: the cap on nested subagent reads, the "history is unavailable" error and the child references a transcript carries. */
export const SHARE_MAX_CHILDREN = 128;
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
export const shareUnavailable = (message: string) => new AppError('SHARE_HISTORY_UNAVAILABLE', message, 409);

export function shareChildReferences(events: readonly NativeWorkbenchEvent[]) {
  const calls = new Map(events.filter(event => event.type === 'tool_call').map(event => [text(event.data.toolCallId), record(event.data.subagent)]));
  return events.flatMap(event => {
    const toolCallId = text(event.data.toolCallId), agentId = text(record(event.data.subagentResult)?.agentId);
    if (!toolCallId || !agentId) return [];
    const call = calls.get(toolCallId);
    return [{ toolCallId, agentId, ...(text(call?.description) ? { title: text(call?.description) } : {}), ...(text(call?.prompt) ? { prompt: text(call?.prompt) } : {}), ...(text(call?.type) ? { subagentType: text(call?.type) } : {}), ...(text(call?.model) ? { model: text(call?.model) } : {}) }];
  });
}

