import type { UsageObservation, UsageObservationTokens } from './types.js';

const counters = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const;
const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Keep only the public fact fields; callers cannot persist arbitrary provider response bodies. */
export function observationValue(value: UsageObservation): UsageObservation | undefined {
  if (!value || ![value.nativeSessionId, value.nativeTurnId, value.requestId].every(id => typeof id === 'string' && id.trim())
    || value.scope !== 'agent-turn' || !['main', 'subagent'].includes(value.agentKind)
    || !['completed', 'failed', 'interrupted'].includes(value.status)
    || !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.endedAt)
    || value.startedAt < 0 || value.endedAt < value.startedAt || !value.usage || typeof value.usage !== 'object') return undefined;
  const counts = (source: UsageObservationTokens): UsageObservationTokens => Object.fromEntries(counters
    .filter(key => typeof source[key] === 'number' && Number.isFinite(source[key])).map(key => [key, source[key]]));
  return {
    nativeSessionId: value.nativeSessionId, nativeTurnId: value.nativeTurnId, requestId: value.requestId,
    scope: value.scope, agentKind: value.agentKind,
    ...(typeof value.parentNativeSessionId === 'string' ? { parentNativeSessionId: value.parentNativeSessionId } : {}),
    ...(typeof value.subagentType === 'string' ? { subagentType: value.subagentType } : {}),
    startedAt: value.startedAt, endedAt: value.endedAt,
    ...(typeof value.requestedModel === 'string' ? { requestedModel: value.requestedModel } : {}),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    status: value.status, usage: counts(value.usage),
    ...(value.rawUsage && typeof value.rawUsage === 'object' ? { rawUsage: counts(value.rawUsage) } : {}),
  };
}

export function observationComplete(value: UsageObservation): boolean {
  return counters.slice(0, 4).every(key => validCount(value.usage[key]))
    && (value.usage.reasoningTokens === undefined || validCount(value.usage.reasoningTokens)
      && value.usage.reasoningTokens <= value.usage.outputTokens!);
}

/** Missing fields may be enriched; contradictory facts are retained as conflicts, never added. */
export function mergeObservation(previous: UsageObservation, next: UsageObservation): UsageObservation | undefined {
  const merged = { ...previous };
  for (const key of Object.keys(next) as Array<keyof UsageObservation>) {
    if (key === 'usage' || key === 'rawUsage') continue;
    if (previous[key] !== undefined && previous[key] !== next[key]) return undefined;
    Object.assign(merged, { [key]: next[key] });
  }
  for (const field of ['usage', 'rawUsage'] as const) {
    if (!previous[field] && !next[field]) continue;
    const result = { ...previous[field] };
    for (const key of counters) {
      const before = previous[field]?.[key], after = next[field]?.[key];
      if (before !== undefined && after !== undefined && before !== after) return undefined;
      if (after !== undefined) result[key] = after;
    }
    merged[field] = result;
  }
  return observationValue(merged);
}
