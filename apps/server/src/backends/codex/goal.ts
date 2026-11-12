import type { SessionGoal, SessionGoalStatus } from '../../../../../packages/contracts/src/index.js';
import { asRecord, finiteToken, str } from './util.js';

const STATUS: Record<string, SessionGoalStatus> = {
  active: 'active', paused: 'paused', blocked: 'blocked', complete: 'complete',
  usageLimited: 'usage_limited', usage_limited: 'usage_limited', budgetLimited: 'budget_limited', budget_limited: 'budget_limited',
};

/** The goal an app-server `ThreadGoal` (or a rollout's `thread_goal_updated.goal`) describes; `undefined` for none. */
export function codexGoal(raw: unknown): SessionGoal | undefined {
  const goal = asRecord(raw);
  const objective = str(goal?.objective);
  const status = STATUS[str(goal?.status) ?? ''];
  if (!goal || !objective || !status) return undefined;
  const stamp = finiteToken(goal.updatedAt);
  const tokenBudget = finiteToken(goal.tokenBudget);
  const tokensUsed = finiteToken(goal.tokensUsed);
  const seconds = finiteToken(goal.timeUsedSeconds);
  return {
    objective, status,
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    ...(seconds !== undefined ? { seconds } : {}),
    // Seconds since the epoch; a millisecond value passes through.
    updatedAt: new Date(stamp === undefined ? Date.now() : stamp < 1e12 ? stamp * 1000 : stamp).toISOString(),
  };
}

/**
 * Whether two goals say the same thing. `updatedAt` is left out: without the provider's stamp it is the read
 * time, so every read would differ and rewrite the session; an unchanged goal keeps the stamp it has.
 */
export function sameGoal(a: SessionGoal | undefined, b: SessionGoal | undefined): boolean {
  const { updatedAt: _a, ...left } = a ?? ({} as Partial<SessionGoal>);
  const { updatedAt: _b, ...right } = b ?? ({} as Partial<SessionGoal>);
  return Boolean(a) === Boolean(b) && JSON.stringify(left) === JSON.stringify(right);
}
