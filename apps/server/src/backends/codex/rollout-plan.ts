import { rolloutRows } from './rollout-records.js';

/**
 * The latest successful `update_plan` call persisted in a Codex rollout — or, for TRAE CLI's
 * Claude-style harness, the task list its `TaskCreate` / `TaskUpdate` calls built up.
 * App-server turn history keeps plan prose, but not this structured todo state.
 */
export interface RolloutPlanSnapshot {
  entries: Array<Record<string, unknown>>;
  timestamp: string;
  ordinal?: number;
  /** Native call identity when history exposes the successful update as an item. */
  callId?: string;
  turnId?: string;
}

/** Normalize the structured plan shape used by both app-server and rollout records. */
export function normalizePlanEntries(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: Array<Record<string, unknown>> = [];
  for (const valueEntry of value) {
    const entry = record(valueEntry);
    const step = string(entry?.step);
    if (!entry || !step?.trim() || !isKnownPlanStatus(entry.status)) return undefined;
    entries.push({ content: step, status: planStatus(entry.status) });
  }
  return entries;
}

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate']);

interface PendingTaskCall { name: string; args: Record<string, unknown>; timestamp: string; turnId?: string }

/** Parse the latest completed plan update, keeping its source turn and position in the rollout. */
export function parseRolloutPlan(content: string): RolloutPlanSnapshot | undefined {
  let activeTurnId: string | undefined;
  let latest: RolloutPlanSnapshot | undefined;
  const pending = new Map<string, RolloutPlanSnapshot>();
  const tasks = new Map<string, { content: string; status: 'pending' | 'in_progress' | 'completed' }>();
  const pendingTasks = new Map<string, PendingTaskCall>();

  for (const row of rolloutRows(content)) {
    const payload = record(row.payload);
    if (!payload) continue;

    if (row.type === 'event_msg') {
      if (payload.type === 'task_started') activeTurnId = string(payload.turn_id);
      else if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
        const completedTurnId = string(payload.turn_id);
        if (!completedTurnId || completedTurnId === activeTurnId) activeTurnId = undefined;
      }
      continue;
    }

    if (row.type !== 'response_item') continue;
    if (payload.type === 'function_call' && payload.name === 'update_plan') {
      const callId = string(payload.call_id);
      const timestamp = string(row.timestamp);
      if (!callId || !timestamp || !Number.isFinite(Date.parse(timestamp))) continue;
      const args = typeof payload.arguments === 'string' ? parseJson(payload.arguments) : record(payload.arguments);
      const entries = normalizePlanEntries(record(args)?.plan);
      if (!entries) continue;
      pending.set(callId, {
        entries,
        timestamp,
        callId,
        ...(typeof row.ordinal === 'number' && Number.isFinite(row.ordinal) ? { ordinal: row.ordinal } : {}),
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
      });
      continue;
    }

    if (payload.type === 'function_call' && TASK_TOOLS.has(String(payload.name))) {
      const callId = string(payload.call_id);
      const timestamp = string(row.timestamp);
      const args = record(typeof payload.arguments === 'string' ? parseJson(payload.arguments) : payload.arguments);
      if (callId && timestamp && args) pendingTasks.set(callId, { name: String(payload.name), args, timestamp, ...(activeTurnId ? { turnId: activeTurnId } : {}) });
      continue;
    }

    if (payload.type === 'function_call_output') {
      const callId = string(payload.call_id);
      if (!callId) continue;
      const taskCall = pendingTasks.get(callId);
      if (taskCall) {
        pendingTasks.delete(callId);
        if (applyTaskCall(tasks, taskCall, payload.output)) {
          latest = { entries: taskEntries(tasks), timestamp: taskCall.timestamp, callId, ...(taskCall.turnId ? { turnId: taskCall.turnId } : {}) };
        }
        continue;
      }
      const candidate = pending.get(callId);
      pending.delete(callId);
      if (candidate && planOutputSucceeded(payload.output)) latest = candidate;
    }
  }
  return latest;
}

/** Folds one answered task call into the list; false when the call failed or changed nothing. */
function applyTaskCall(tasks: Map<string, { content: string; status: 'pending' | 'in_progress' | 'completed' }>, call: PendingTaskCall, output: unknown): boolean {
  const text = typeof output === 'string' ? output : safeStringify(output);
  if (call.name === 'TaskCreate') {
    const id = /\btask\s+#?([\w-]+)\s+created\b/i.exec(text)?.[1];
    const content = string(call.args.subject) ?? string(call.args.description);
    if (!id || !content?.trim()) return false;
    tasks.set(id, { content, status: 'pending' });
    return true;
  }
  if (!/\bupdated\b/i.test(text)) return false;
  const id = call.args.taskId === undefined ? undefined : String(call.args.taskId);
  if (!id) return false;
  if (call.args.status === 'deleted') return tasks.delete(id);
  const existing = tasks.get(id);
  const content = string(call.args.subject) ?? existing?.content;
  if (!content) return false;
  tasks.set(id, { content, status: isKnownPlanStatus(call.args.status) ? planStatus(call.args.status) : existing?.status ?? 'pending' });
  return true;
}

/** Tasks in their numeric order when every id is a number, which is how the CLI numbers them. */
function taskEntries(tasks: Map<string, { content: string; status: string }>): Array<Record<string, unknown>> {
  const entries = [...tasks];
  if (entries.every(([id]) => /^\d+$/.test(id))) entries.sort(([left], [right]) => Number(left) - Number(right));
  return entries.map(([, task]) => ({ content: task.content, status: task.status }));
}

function planStatus(value: unknown): 'pending' | 'in_progress' | 'completed' {
  if (value === 'completed') return 'completed';
  if (value === 'inProgress' || value === 'in_progress') return 'in_progress';
  return 'pending';
}

function isKnownPlanStatus(value: unknown): boolean {
  return value === 'pending' || value === 'inProgress' || value === 'in_progress'
    || value === 'completed';
}

function planOutputSucceeded(value: unknown): boolean {
  const output = typeof value === 'string' ? value : safeStringify(value);
  if (!output || /^\s*(error|failed|failure|rejected|invalid)\b/i.test(output)) return false;
  return /\bplan updated\b/i.test(output);
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value) ?? ''; } catch { return ''; }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}
