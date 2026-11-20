import type { SessionGoal } from '../../../../../packages/contracts/src/index.js';
import type { ClaudeRow } from './rows.js';

/** `undefined` leaves the goal as it is; `null` clears it. */
export type ClaudeGoalChange = SessionGoal | null | undefined;

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * What one transcript row does to the conversation's `/goal`.
 *
 * Claude Code records the goal as `goal_status` attachments: a sentinel row sets it (`met: false`) or
 * clears it (`met: true`), a row with a reason is the Stop-hook check's verdict. Older versions only
 * wrote the command's own output, which is read as well. A finished goal steps aside at the first
 * human message after it, as a finished todo list does.
 */
export function claudeGoalChange(current: SessionGoal | undefined, row: ClaudeRow): ClaudeGoalChange {
  const at = text(row.timestamp) ?? new Date(0).toISOString();
  if (row.isSidechain === true || row.agentId !== undefined) return undefined;
  if (row.type === 'attachment') {
    const attachment = row.attachment as Record<string, unknown> | undefined;
    if (attachment?.type !== 'goal_status') return undefined;
    const objective = text(attachment.condition) ?? current?.objective;
    if (!objective) return undefined;
    const reason = text(attachment.reason);
    if (attachment.met === true) {
      if (attachment.sentinel === true) return null;
      const seconds = count(attachment.durationMs);
      const tokens = count(attachment.tokens);
      return { objective, status: 'complete', ...(reason ? { reason } : {}), ...(tokens !== undefined ? { tokensUsed: tokens } : {}), ...(seconds !== undefined ? { seconds: Math.round(seconds / 1000) } : {}), updatedAt: at };
    }
    if (attachment.failed) return { objective, status: 'blocked', ...(reason ? { reason } : {}), updatedAt: at };
    // A set row opens the goal; a failed check keeps it open with the verdict that explains why.
    return { objective, status: 'active', ...(reason ? { reason } : {}), updatedAt: at };
  }
  const output = commandOutput(row);
  if (output !== undefined) {
    const set = /^Goal set: ([\s\S]+)$/.exec(output)?.[1]?.trim();
    if (set) return current?.objective === set && current.status === 'active' ? undefined : { objective: set, status: 'active', updatedAt: at };
    if (/^Goal cleared(?::|$)/.test(output)) return current ? null : undefined;
    return undefined;
  }
  if (current?.status === 'complete' && isHumanRow(row)) return null;
  return undefined;
}

/** The text a local command printed: a `system` row in current versions, a user row in older ones. */
function commandOutput(row: ClaudeRow): string | undefined {
  const content = row.type === 'system' && row.subtype === 'local_command' ? row.content
    : row.type === 'user' && typeof row.message?.content === 'string' ? row.message.content : undefined;
  return typeof content === 'string' ? /^<local-command-stdout>([\s\S]*?)(?:<\/local-command-stdout>)?$/.exec(content.trim())?.[1]?.trim() : undefined;
}

function isHumanRow(row: ClaudeRow): boolean {
  if (row.type !== 'user' || row.isMeta === true || row.isCompactSummary === true) return false;
  const content = row.message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  return Array.isArray(content) && content.some(part => (part as { type?: unknown })?.type === 'text')
    && !content.some(part => (part as { type?: unknown })?.type === 'tool_result');
}
