import { AGENT_CALL_BUDGET, type AgentMention } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MODEL_CHARS = 200;
const LABEL_CHARS = 80;

/**
 * The Agents (or team members) a message @-mentions (`NativeRunInput.agents`, docs/AGENT-CALLS.md §3, docs/TEAM.md §4.3),
 * parsed without asking whether they still exist: an accepted retry must still parse after a profile or member is removed.
 * Empty reads as missing, so an older message's fingerprint does not change.
 */
export function agentMentionInputs(value: unknown): AgentMention[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > AGENT_CALL_BUDGET.mentions) throw new AppError('INVALID_AGENT_MENTIONS', `Mention at most ${AGENT_CALL_BUDGET.mentions} Agents`);
  const seen = new Set<string>();
  const result = value.map((item: unknown): AgentMention => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AppError('INVALID_AGENT_MENTIONS', 'Invalid Agent mention');
    const mention = item as Record<string, unknown>;
    if (typeof mention.backendId !== 'string' || !ID.test(mention.backendId)
      || mention.backendProfileId !== undefined && (typeof mention.backendProfileId !== 'string' || !ID.test(mention.backendProfileId))
      || mention.model !== undefined && (typeof mention.model !== 'string' || !mention.model.trim() || mention.model.length > MODEL_CHARS)
      || mention.memberId !== undefined && (typeof mention.memberId !== 'string' || !ID.test(mention.memberId))
      || mention.label !== undefined && (typeof mention.label !== 'string' || !mention.label.trim() || mention.label.length > LABEL_CHARS)
      || Object.keys(mention).some(key => key !== 'backendId' && key !== 'backendProfileId' && key !== 'model' && key !== 'memberId' && key !== 'label')) {
      throw new AppError('INVALID_AGENT_MENTIONS', 'Invalid Agent mention');
    }
    const dedupeKey = typeof mention.memberId === 'string' ? `member:${mention.memberId}` : `backend:${mention.backendId}`;
    // One mention per Agent or team member: what the owner picked for it is one choice.
    if (seen.has(dedupeKey)) throw new AppError('INVALID_AGENT_MENTIONS', 'Duplicate Agent mention');
    seen.add(dedupeKey);
    return {
      backendId: mention.backendId as AgentMention['backendId'],
      ...(mention.backendProfileId ? { backendProfileId: mention.backendProfileId as string } : {}),
      ...(typeof mention.model === 'string' ? { model: mention.model.trim() } : {}),
      ...(typeof mention.memberId === 'string' ? { memberId: mention.memberId } : {}),
      ...(typeof mention.label === 'string' ? { label: mention.label.trim() } : {}),
    };
  });
  return result.length ? result : undefined;
}
