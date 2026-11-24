import type { ModelInfo, NativeStatus, NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { AGENT_PROCESS_BUDGET } from '../../../../../packages/contracts/src/index.js';
import { firstMessageTitlePatch } from '../../session-title.js';
import type { NativeBackendProfileConfig, NativeControlMessage } from '../types.js';
import { dshNativeContext, foldDshContext, type DshContextBreakdown } from './context.js';
import { projectDshEvent } from './events.js';
import { modelValue, parseModelSelection, displayedPermission } from './selection.js';
import { DEFAULT_PROVIDER, type DshRuntimeSettings } from './settings.js';
import { dshTurns, sameBreakdown } from './transcript.js';
import type { DshConversation, DshSessionReadResult } from './types.js';
import { asRecord, nonEmpty } from './util.js';

/** Records of a conversation kept for what later ones need of them (a prompt's echo, a subagent's result). */
export const REMEMBERED_EVENTS = 8_000;
export const TRANSCRIPT_PAGE_SIZE = 200;
export const IDLE_STOP_MS = AGENT_PROCESS_BUDGET.bridgeIdleSeconds * 1000;
export const STARTUP_TIMEOUT_MS = 25_000;
export const PUMP_INTERVAL_MS = 1_000;
/** Every transcript read replays the whole DSH log, so an idle session is checked less often. */
export const IDLE_PUMP_INTERVAL_MS = 5_000;
/** Child records read when a subagent panel first loads; older ones page through its own cursor. */
export const SUBAGENT_INITIAL_RECORDS = 1_000;
/** Projected events kept in memory per subagent. */
export const SUBAGENT_LIMIT = 64;
/** A finished continuable child can be woken by `send_message`, so it is still rechecked, slowly. */
export const SUBAGENT_IDLE_POLL_MS = 30_000;

/** A follower of one DSH session's changes; see {@link DshProfileRuntime.observe}. */
export type DshObserver = (method: string, params: Record<string, unknown>) => void;

export function notifyListeners(state: DshConversation, message: NativeControlMessage): void {
  for (const listener of state.listeners) {
    try { listener(message); } catch { /* one subscriber must not stop the others */ }
  }
}

/** Remembers an event, forgetting the oldest beyond the limit; false when it was known. */
export function rememberDshEvent(state: DshConversation, event: NativeWorkbenchEvent): boolean {
  if (state.events.has(event.nativeId)) return false;
  state.events.set(event.nativeId, event);
  for (const id of state.events.keys()) {
    if (state.events.size <= REMEMBERED_EVENTS) break;
    state.events.delete(id);
  }
  return true;
}

export function rememberDshTurnCommand(state: DshConversation, turn: number, commandId: string): void {
  state.turnCommands.set(turn, commandId);
  while (state.turnCommands.size > REMEMBERED_EVENTS) {
    state.turnCommands.delete(state.turnCommands.keys().next().value!);
  }
}

/** What a failed `turn/end` record says went wrong, without the profile's secrets. */
export function dshTurnFailureMessage(settings: DshRuntimeSettings, data: Record<string, unknown>, profile: NativeBackendProfileConfig): string | undefined {
  const reason = asRecord(data.reason);
  const nativeError = asRecord(reason?.error);
  let message = nonEmpty(nativeError?.message) ?? nonEmpty(nativeError?.code);
  if (!message) return undefined;
  if (settings.apiKey) message = message.split(settings.apiKey).join('[REDACTED]');
  for (const [key, value] of Object.entries(profile.config)) {
    if (/(?:secret|token|password|credential|api[_-]?key)/i.test(key) && typeof value === 'string' && value) message = message.split(value).join('[REDACTED]');
  }
  return message.replace(/\bBearer\s+[^\s,;}]+/gi, 'Bearer [REDACTED]').slice(0, 300);
}

/** The delegated prompt and runtime context in a child's records come from its parent. */
export function projectDshChild(state: DshConversation, rawEvents: readonly unknown[]): NativeWorkbenchEvent[] {
  return rawEvents.flatMap(raw => projectDshEvent(raw, { sessionId: state.workbenchSessionId }));
}

export function dshStatusFromResponse(
  state: DshConversation,
  response: DshSessionReadResult['status'] | { status?: 'busy' | 'idle'; model?: string; provider?: string; reasoningEffort?: string; approval?: string; permission?: string } | undefined,
): NativeStatus {
  const phase = response?.status === 'busy' ? 'busy' : 'idle';
  const model = response?.provider && response.model ? modelValue(response.provider, response.model, response.reasoningEffort) : state.session.model;
  const approval = displayedPermission(response?.permission ?? state.session.approval);
  return {
    phase: dshTurns.report(state, state.interaction ? 'attention' : phase),
    ...(model ? { model } : {}),
    ...(approval ? { approval, permission: approval } : {}),
    ...(state.interaction ? { interaction: state.interaction } : {}),
  };
}

export function configuredDshModelFallback(defaultModel: string): ModelInfo[] {
  const parsed = parseModelSelection(defaultModel, DEFAULT_PROVIDER);
  const value = modelValue(parsed.provider, parsed.model, parsed.reasoningEffort);
  return [{ value, name: `${parsed.provider}: ${parsed.model}`, configOptions: [] }];
}

/**
 * Publish the context facts carried by committed DSH records. `assistant/message.usage` is the
 * provider's own prompt accounting and `request/context` names the route's window, so the meter
 * shows what the CLI measured; a record without either contributes nothing, and a replayed page
 * (or an older history load) can never replace newer facts because each is guarded by its
 * sequence.
 */
export function noteDshContext(state: DshConversation, rawEvents: unknown[]): void {
  if (!foldDshContext(state.contextFacts, rawEvents)) return;
  refreshDshContext(state);
}

/**
 * Adopt the composition the bridge projected off the live session — or drop it when the session
 * has none (no live projection, an older DSH without the registry, a projection that refuses to
 * fold). The three parts describe the surface *now*, so a value from an earlier read is not a
 * fallback: without a fresh one the popover draws the measured ratio as a single bar, which is
 * what it did before this existed.
 */
export function noteDshContextBreakdown(state: DshConversation, breakdown: DshContextBreakdown | undefined): void {
  if (sameBreakdown(state.contextBreakdown, breakdown)) return;
  state.contextBreakdown = breakdown;
  refreshDshContext(state);
}

/** Rebuild the published frame from the facts and the composition, notifying only on a change. */
export function refreshDshContext(state: DshConversation): void {
  const next = dshNativeContext(state.contextFacts, state.contextBreakdown);
  if ((next ? JSON.stringify(next) : '') === (state.context ? JSON.stringify(state.context) : '')) return;
  state.context = next;
  notifyListeners(state, { type: 'context', ...(next ? { context: next } : {}) });
}

/**
 * Name the conversation after its first human message. Idempotent: once the title carries
 * `titleSource: 'prompt'` the patch is empty, so replaying history cannot rename it twice.
 */
export function nameDshFromMessage(state: DshConversation, text: string): void {
  const patch = firstMessageTitlePatch(state.host.getSession(state.workbenchSessionId), text);
  if (!patch) return;
  const session = state.host.updateSession(state.workbenchSessionId, patch);
  notifyListeners(state, { type: 'session', session });
}
