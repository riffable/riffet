/**
 * Team and members (docs/TEAM.md): evolves the single personal assistant into a set of configurable
 * standing roles (`AgentMember`) with isolated directories, memory, models, and capabilities.
 */
import type { NativeBackendId } from './agent-ids.js';
import type { AssistantChoice } from './assistant-choice.js';
import { ASSISTANT_BACKENDS, isAssistantBackend } from './assistant-choice.js';
import type { NativeBackendCatalogEntry } from './backends.js';
import type { OwnerAvatarGenerateRequest, OwnerAvatarType } from './owner.js';

/** The default member migrated from the legacy singleton personal assistant. */
export const DEFAULT_AGENT_MEMBER_ID = 'default';

export type AgentMemberAvatar =
  | { kind: 'emoji'; value: string }
  | { kind: 'image'; url: string };

export type AgentMemberAvatarInput =
  | { kind: 'emoji'; value: string }
  | { kind: 'image'; type: OwnerAvatarType; data: string }
  | { kind: 'generated'; request: OwnerAvatarGenerateRequest };

export type AgentMemberScopeKind = 'global' | 'personal' | 'project';

export interface AgentMemberScope {
  kind: AgentMemberScopeKind;
  /** Bound code project ids when `kind === 'project'`. */
  projectIds?: string[];
}

/**
 * - `continuous`: keeps one standing conversation (with `/new` topic resets), e.g. general assistant or investing.
 * - `fresh`: opens a clean isolated conversation per invocation while retaining shared memory, e.g. QA or packager.
 */
export type AgentMemberSessionMode = 'continuous' | 'fresh';

export interface AgentMemberCapabilities {
  /** Read/run commands in the bound workspace (or member directory when personal). */
  workspace: boolean;
  /** Read/create tasks and inspect sessions (automatically narrowed to `scope.projectIds` for project members). */
  taskBoard: boolean;
  /** Manage timed or event-driven delegations. */
  delegations: boolean;
  /** Call other allowed agents/members (`agent_call`). */
  memberCalls: boolean;
  /** Use Riffet browser, paired devices, and member-scoped MCP/skills. */
  externalTools: boolean;
  /** Read server status and modify workbench/instance settings (owner turn only). */
  workbenchAdmin: boolean;
}

export interface AgentMemberTarget {
  backendId?: NativeBackendId;
  profileId?: string;
  model?: string;
  permissionMode?: string;
}

export interface AgentMember {
  id: string;
  name: string;
  avatar?: AgentMemberAvatar;
  description?: string;
  scope: AgentMemberScope;
  sessionMode: AgentMemberSessionMode;
  target?: AgentMemberTarget;
  capabilities: AgentMemberCapabilities;
  memory: { consolidation: boolean };
  budget: { dailyRuns: number };
  /**
   * Dedicated system project id (`system: 'assistant'`) for `personal`/`global` members;
   * primary bound code project id for `project` members.
   */
  projectId: string;
  /** Current standing conversation id when `sessionMode === 'continuous'`. */
  mainSessionId?: string;
  pinned?: boolean;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMemberCreate {
  name: string;
  avatar?: AgentMemberAvatarInput | null;
  description?: string;
  instructions?: string;
  initialMemory?: string;
  scope: AgentMemberScope;
  sessionMode?: AgentMemberSessionMode;
  target?: AgentMemberTarget;
  capabilities?: Partial<AgentMemberCapabilities>;
  memory?: { consolidation?: boolean };
  budget?: { dailyRuns?: number };
  pinned?: boolean;
}

export interface AgentMemberUpdate {
  name?: string;
  avatar?: AgentMemberAvatarInput | null;
  description?: string | null;
  scope?: AgentMemberScope;
  sessionMode?: AgentMemberSessionMode;
  target?: {
    backendId?: NativeBackendId | null;
    profileId?: string | null;
    model?: string | null;
    permissionMode?: string | null;
  } | null;
  capabilities?: Partial<AgentMemberCapabilities>;
  memory?: { consolidation?: boolean };
  budget?: { dailyRuns?: number };
  pinned?: boolean;
  archived?: boolean;
}

export interface AgentMemberList {
  members: AgentMember[];
}

export interface AgentMemberUserProfile {
  text: string;
  maxChars: number;
  updatedAt?: string;
}

export interface AgentMemberExtractDraft {
  name: string;
  description: string;
  instructions: string;
  initialMemory: string;
  scope: AgentMemberScope;
  sessionMode: AgentMemberSessionMode;
  target?: AgentMemberTarget;
  capabilities: AgentMemberCapabilities;
  generatedBy?: string;
  fallbackReason?: string;
}

export function defaultMemberCapabilities(scope: AgentMemberScopeKind): AgentMemberCapabilities {
  if (scope === 'global') {
    return { workspace: false, taskBoard: true, delegations: true, memberCalls: true, externalTools: true, workbenchAdmin: true };
  }
  if (scope === 'project') {
    return { workspace: true, taskBoard: true, delegations: false, memberCalls: false, externalTools: true, workbenchAdmin: false };
  }
  return { workspace: false, taskBoard: false, delegations: true, memberCalls: false, externalTools: true, workbenchAdmin: false };
}

/** Resolves a member's effective isolated backend, provider and model against the available backend catalog. */
export function memberChoice(target: AgentMemberTarget | undefined, backends: readonly NativeBackendCatalogEntry[]): AssistantChoice | undefined {
  const backend = (isAssistantBackend(target?.backendId) ? backends.find((entry) => entry.backendId === target!.backendId) : undefined)
    ?? ASSISTANT_BACKENDS.map((id) => backends.find((entry) => entry.backendId === id && entry.available)).find(Boolean);
  if (!backend) return undefined;
  const own = backend.backendId === target?.backendId;
  const profileKept = own && (!target?.profileId || backend.profiles.some((profile) => profile.id === target.profileId));
  return {
    backendId: backend.backendId,
    ...(profileKept && target?.profileId ? { profileId: target.profileId } : {}),
    ...(profileKept && target?.model ? { model: target.model } : {}),
  };
}
