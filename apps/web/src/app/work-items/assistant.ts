import { DEFAULT_AGENT_MEMBER_ID, TEAM_MEMBER_ORDER_MAX, type AgentMember, type AppSettings, type AssistantChoice } from '@contracts';

export { assistantChoice, DEFAULT_AGENT_MEMBER_ID, isAssistantBackend, memberChoice, type AssistantChoice } from '@contracts';

export const isDefaultMember = (member?: Pick<AgentMember, 'id'>): boolean => member?.id === DEFAULT_AGENT_MEMBER_ID;

/** The settings a composer reads its opening model from, with the 助理's or member's target in place of the agent's own. */
export function withAssistantDefaults(settings: AppSettings, choice: AssistantChoice, approval?: string): AppSettings {
  const { profileId: _profile, model: _model, approval: _approval, ...rest } = settings.nativeBackendDefaults?.[choice.backendId] ?? {};
  return {
    ...settings,
    nativeBackendDefaults: {
      ...settings.nativeBackendDefaults,
      [choice.backendId]: {
        ...rest,
        ...(choice.profileId ? { profileId: choice.profileId } : {}),
        ...(choice.model ? { model: choice.model } : {}),
        ...(approval ? { approval } : _approval ? { approval: _approval } : {}),
      },
    },
  };
}

function defaultMemberCompare(left: AgentMember, right: AgentMember): number {
  if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
  const leftDefault = isDefaultMember(left);
  const rightDefault = isDefaultMember(right);
  if (leftDefault !== rightDefault) return leftDefault ? -1 : 1;
  return left.createdAt.localeCompare(right.createdAt);
}

/**
 * Sort active team members by saved `teamMemberOrder` (every device sees the same order).
 * Members not yet in `order` follow at the end in the default order (`pinned → default → createdAt`).
 */
export function sortTeamMembers(members: readonly AgentMember[], order?: readonly string[]): AgentMember[] {
  const active = members.filter((member) => !member.archivedAt);
  if (!order?.length) return active.sort(defaultMemberCompare);
  const rank = new Map<string, number>();
  order.forEach((id, index) => { if (!rank.has(id)) rank.set(id, index); });
  return active.sort((left, right) => {
    const leftRank = rank.get(left.id);
    const rightRank = rank.get(right.id);
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
    if (leftRank !== undefined) return -1;
    if (rightRank !== undefined) return 1;
    return defaultMemberCompare(left, right);
  });
}

/**
 * Replaces the relative order of the visible members while keeping hidden/archived ids in place
 * (capped at `TEAM_MEMBER_ORDER_MAX` so stale ids never block future saves).
 */
export function reorderTeamMembers(currentOrder: readonly string[], nextVisibleIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of nextVisibleIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  for (const id of currentOrder) {
    if (result.length >= TEAM_MEMBER_ORDER_MAX) break;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result.slice(0, TEAM_MEMBER_ORDER_MAX);
}

/** Moves a single member id to the top of the visible order. */
export function moveTeamMemberToTop(currentOrder: readonly string[], visibleIds: readonly string[], id: string): string[] {
  if (!visibleIds.includes(id)) return [...currentOrder];
  return reorderTeamMembers(currentOrder, [id, ...visibleIds.filter((item) => item !== id)]);
}
