import type { NativeWorkbenchEvent, SessionGoal } from '../../../../../packages/contracts/src/index.js';

/** `undefined` leaves the goal as it is; `null` clears it. */
export type DshGoalChange = SessionGoal | null | undefined;

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

/**
 * What projected DSH events do to the conversation's goal.
 *
 * DSH keeps the goal on the harness side; `create_goal` / `update_goal` call arguments are the only place
 * it can be read. `objective` is on `create` and on an `edit`; `pause` / `resume` / `complete` /
 * `blocked` leave it out, so the stored objective carries over. A finished goal steps aside at the
 * first human message after it.
 */
export function dshGoalChange(current: SessionGoal | undefined, events: readonly NativeWorkbenchEvent[]): DshGoalChange {
  let goal = current;
  let changed = false;
  for (const event of events) {
    if (event.type === 'user_message_chunk' && goal?.status === 'complete') { goal = undefined; changed = true; continue; }
    if (event.type !== 'tool_call' || !/goal/.test(String(event.data.toolName ?? '').toLowerCase())) continue;
    const input = event.data.rawInput && typeof event.data.rawInput === 'object' && !Array.isArray(event.data.rawInput) ? event.data.rawInput as Record<string, unknown> : undefined;
    const objective = text(input?.objective);
    const action = text(input?.action);
    if (!objective && !action) continue;
    const next = objective ?? goal?.objective;
    if (!next) continue;
    const status = action === 'pause' ? 'paused' : action === 'blocked' ? 'blocked' : action === 'complete' ? 'complete' : 'active';
    const reason = status === 'blocked' ? text(input?.blocked_reason) ?? text(input?.blockedReason) : undefined;
    goal = { objective: next, status, ...(reason ? { reason } : {}), updatedAt: event.createdAt ?? new Date().toISOString() };
    changed = true;
  }
  return changed ? goal ?? null : undefined;
}
