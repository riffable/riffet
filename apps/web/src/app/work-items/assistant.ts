import { DEFAULT_AGENT_MEMBER_ID, type AgentMember, type AppSettings, type AssistantChoice } from '@contracts';

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

/** Sort active team members: pinned first, then default member, then by creation time. */
export function sortTeamMembers(members: readonly AgentMember[]): AgentMember[] {
  return members
    .filter((member) => !member.archivedAt)
    .sort((left, right) => {
      if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
      const leftDefault = isDefaultMember(left);
      const rightDefault = isDefaultMember(right);
      if (leftDefault !== rightDefault) return leftDefault ? -1 : 1;
      return left.createdAt.localeCompare(right.createdAt);
    });
}
