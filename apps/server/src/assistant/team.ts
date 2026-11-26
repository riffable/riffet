import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_AGENT_MEMBER_ID,
  OWNER_AVATAR_MAX_BYTES,
  OWNER_AVATAR_TYPES,
  TEAM_BUDGET,
  defaultMemberCapabilities,
  isAssistantBackend,
  type AgentMember,
  type AgentMemberAvatar,
  type AgentMemberAvatarInput,
  type AgentMemberCapabilities,
  type AgentMemberCreate,
  type AgentMemberScope,
  type AgentMemberSessionMode,
  type AgentMemberTarget,
  type AgentMemberUpdate,
  type AgentMemberUserProfile,
  type AssistantFile,
  type AssistantInstructions,
  type AssistantMemory,
  type AssistantSettings,
  type OwnerAvatarGenerateRequest,
  type OwnerAvatarType,
  type Project,
  type Session,
} from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import type { Store } from '../store.js';
import {
  assistantFilePath,
  commitAssistantHome,
  ensureGlobalUserProfile,
  ensureMemberHome,
  forgetAssistantMemory,
  listAssistantFiles,
  readAssistantMemory,
  readGlobalUserProfile,
  writeGlobalUserProfile,
  type AssistantHome,
} from './home.js';

const MEMBERS_SETTING_KEY = 'team:members';
const INSTRUCTIONS_FILE = 'AGENTS.md';
const CLAUDE_FILE = 'CLAUDE.md';
const CLAUDE_IMPORT = '@AGENTS.md\n@USER.md\n'; // privacy: allow Claude Code file imports, not an address
const INSTRUCTIONS_LIMIT = 64_000;
const INITIAL_MEMORY_LIMIT = 32_000;
const NAME_LIMIT = 48;
const DESCRIPTION_LIMIT = 300;
const EMOJI_LIMIT = 16;
const DEFAULT_MEMBER_NAME = '个人助理';
const AVATAR_EXT_BY_TYPE: Record<OwnerAvatarType, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};
const AVATAR_TYPE_BY_EXT: Record<string, OwnerAvatarType> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
};

export interface AgentTeamDeps {
  store: Store;
  stateDir: string;
  /** Returns or creates the legacy personal assistant system project (`system: 'assistant'`). */
  defaultProject: () => Project;
  /** Reads or writes the default member's AGENTS.md (keeps legacy `assistantInstructionsFile` behavior). */
  defaultInstructions: (text?: string | null) => AssistantInstructions;
  /** Reads saved legacy `AppSettings.assistant` defaults for initial migration. */
  assistantSettings?: () => AssistantSettings | undefined;
  /** Syncs default member backend/model/consolidation/budget changes back to `AppSettings.assistant` for older clients. */
  syncDefaultSettings?: (target: AgentMemberTarget | undefined, extra?: { consolidation?: boolean; dailyRuns?: number }) => void;
  /** Called right after a team member is deleted so runtime state (delegations, pending notes) can be cleaned up. */
  onMemberDeleted?: (memberId: string) => void;
  /** Renders a plugin-provided generated avatar PNG (same engine as Settings -> Profile). */
  renderAvatar?: (request: OwnerAvatarGenerateRequest, name?: string) => Promise<{ png: Buffer }>;
}

const nowIso = () => new Date().toISOString();

function readText(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); } catch { return undefined; }
}

/** The `AGENTS.md` a new member starts with; how every member works is in its system prompt, not here. */
function defaultMemberInstructions(name: string, description: string | undefined): string {
  const duty = description?.trim() || '<!-- 这个成员负责什么。 -->';
  return `# ${name}\n\n## 职责\n\n${duty}\n\n<!-- 可以补充：交付标准（做到什么程度算完成）；红线（哪些事不做，或要先问用户）；对默认权限的调整（例如允许直接发起工单、允许推送临时分支）。 -->\n`;
}

function normalizeScope(store: Store, raw: AgentMemberScope): AgentMemberScope {
  if (!raw || typeof raw !== 'object') throw new AppError('INVALID_ARGUMENT', 'scope is required');
  if (raw.kind === 'global' || raw.kind === 'personal') return { kind: raw.kind };
  if (raw.kind !== 'project') throw new AppError('INVALID_ARGUMENT', 'scope.kind must be global, personal, or project');
  const ids = Array.isArray(raw.projectIds) ? [...new Set(raw.projectIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())))] : [];
  if (!ids.length) throw new AppError('INVALID_ARGUMENT', 'A project-scoped member requires at least one project');
  for (const id of ids) {
    const project = store.getProject(id);
    if (project.system) throw new AppError('INVALID_ARGUMENT', 'A member cannot bind to a system project');
    if (project.archivedAt) throw new AppError('ARCHIVED_PROJECT', 'Restore the project before binding a member to it', 409);
  }
  return { kind: 'project', projectIds: ids };
}

function normalizeTarget(raw: AgentMemberTarget | undefined): AgentMemberTarget | undefined {
  if (!raw) return undefined;
  const target: AgentMemberTarget = {};
  if (raw.backendId !== undefined) {
    if (!isAssistantBackend(raw.backendId)) {
      throw new AppError('ASSISTANT_BACKEND_UNSUPPORTED', 'Team members run on Claude Code, Codex, or Cursor');
    }
    target.backendId = raw.backendId;
  }
  if (typeof raw.profileId === 'string' && raw.profileId.trim()) target.profileId = raw.profileId.trim().slice(0, 120);
  if (typeof raw.model === 'string' && raw.model.trim()) target.model = raw.model.trim().slice(0, 200);
  if (typeof raw.permissionMode === 'string' && raw.permissionMode.trim()) target.permissionMode = raw.permissionMode.trim().slice(0, 64);
  return Object.keys(target).length ? target : undefined;
}

function normalizeCapabilities(scope: AgentMemberScope['kind'], raw?: Partial<AgentMemberCapabilities>): AgentMemberCapabilities {
  const base = defaultMemberCapabilities(scope);
  if (!raw) return base;
  return {
    workspace: typeof raw.workspace === 'boolean' ? raw.workspace : base.workspace,
    taskBoard: typeof raw.taskBoard === 'boolean' ? raw.taskBoard : base.taskBoard,
    delegations: typeof raw.delegations === 'boolean' ? raw.delegations : base.delegations,
    memberCalls: typeof raw.memberCalls === 'boolean' ? raw.memberCalls : base.memberCalls,
    externalTools: typeof raw.externalTools === 'boolean' ? raw.externalTools : base.externalTools,
    workbenchAdmin: typeof raw.workbenchAdmin === 'boolean' ? raw.workbenchAdmin : base.workbenchAdmin,
  };
}

function normalizeDailyRuns(value: unknown, fallback: number = TEAM_BUDGET.defaultDailyRuns): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(TEAM_BUDGET.maxDailyRuns, Math.floor(value)));
}

/**
 * Manages Team members (`AgentMember`, docs/TEAM.md): migrates the legacy singleton personal assistant
 * into the `default` member, owns per-member isolated directories and shared `USER.md`, and resolves
 * which member owns any given project or session.
 */
export class AgentTeamService {
  private readonly listeners = new Set<() => void>();
  private readonly homes = new Map<string, AssistantHome>();
  private migrated = false;

  constructor(private readonly deps: AgentTeamDeps) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emitChanged(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* observer error */ }
    }
  }

  private readRaw(): AgentMember[] {
    const saved = this.deps.store.getSetting<AgentMember[] | undefined>(MEMBERS_SETTING_KEY, undefined);
    return Array.isArray(saved) ? saved.map(item => ({ ...item })) : [];
  }

  private writeRaw(members: AgentMember[]): void {
    this.deps.store.setSetting(MEMBERS_SETTING_KEY, members);
    this.emitChanged();
  }

  /** Ensures the legacy personal assistant is migrated into `default` and `<stateDir>/team/USER.md` exists. */
  ensureDefaultMember(): AgentMember {
    const existing = this.readRaw();
    const defaultProj = this.deps.defaultProject();
    ensureGlobalUserProfile(this.deps.stateDir, defaultProj.cwd);
    if (defaultProj.agentMemberId !== DEFAULT_AGENT_MEMBER_ID) {
      this.deps.store.updateProject(defaultProj.id, { agentMemberId: DEFAULT_AGENT_MEMBER_ID });
    }
    const found = existing.find(member => member.id === DEFAULT_AGENT_MEMBER_ID);
    if (found) {
      this.migrated = true;
      // Keep mainSessionId synchronized with the legacy assistant project.
      if (defaultProj.mainSessionId && found.mainSessionId !== defaultProj.mainSessionId) {
        const updated = { ...found, mainSessionId: defaultProj.mainSessionId };
        this.deps.store.setSetting(MEMBERS_SETTING_KEY, existing.map(item => item.id === found.id ? updated : item));
        return updated;
      }
      return found;
    }
    const savedAssistant = this.deps.assistantSettings?.();
    const target: AgentMemberTarget | undefined = savedAssistant && (savedAssistant.backendId || savedAssistant.profileId || savedAssistant.model)
      ? {
        ...(isAssistantBackend(savedAssistant.backendId) ? { backendId: savedAssistant.backendId } : {}),
        ...(savedAssistant.profileId ? { profileId: savedAssistant.profileId } : {}),
        ...(savedAssistant.model ? { model: savedAssistant.model } : {}),
      }
      : undefined;
    const stamp = nowIso();
    const member: AgentMember = {
      id: DEFAULT_AGENT_MEMBER_ID,
      name: DEFAULT_MEMBER_NAME,
      scope: { kind: 'global' },
      sessionMode: 'continuous',
      ...(target && Object.keys(target).length ? { target } : {}),
      capabilities: defaultMemberCapabilities('global'),
      memory: { consolidation: savedAssistant?.consolidation ?? true },
      budget: { dailyRuns: normalizeDailyRuns(savedAssistant?.dailyRuns) },
      projectId: defaultProj.id,
      ...(defaultProj.mainSessionId ? { mainSessionId: defaultProj.mainSessionId } : {}),
      createdAt: defaultProj.createdAt || stamp,
      updatedAt: stamp,
    };
    this.deps.store.setSetting(MEMBERS_SETTING_KEY, [member, ...existing]);
    this.migrated = true;
    return member;
  }

  private ensureReady(): AgentMember[] {
    if (!this.migrated) this.ensureDefaultMember();
    const members = this.readRaw();
    // Synchronize default member mainSessionId with legacy assistant project if updated externally.
    const defaultProj = this.deps.store.listProjects().find(p => p.system === 'assistant' && (!p.agentMemberId || p.agentMemberId === DEFAULT_AGENT_MEMBER_ID));
    if (defaultProj) {
      return members.map(member => {
        if (member.id === DEFAULT_AGENT_MEMBER_ID) {
          return { ...member, projectId: defaultProj.id, ...(defaultProj.mainSessionId ? { mainSessionId: defaultProj.mainSessionId } : {}) };
        }
        return member;
      });
    }
    return members;
  }

  /** Directory storing this member's `AGENTS.md`, `memory/`, `.claude/skills/`, `files/`, `.mcp.json`. */
  memberDir(memberId: string): string {
    if (memberId === DEFAULT_AGENT_MEMBER_ID) return this.deps.defaultProject().cwd;
    return join(this.deps.stateDir, 'team', memberId);
  }

  /** Returns the initialized `AssistantHome` launch configuration for a member. */
  memberHome(member: AgentMember): AssistantHome {
    const dir = this.memberDir(member.id);
    const globalUserFile = ensureGlobalUserProfile(this.deps.stateDir, this.deps.defaultProject().cwd);
    const cacheKey = `${member.id}:${member.scope.kind}:${member.sessionMode}:${member.capabilities.workbenchAdmin}`;
    const cached = this.homes.get(cacheKey);
    if (cached && existsSync(cached.memoryDir) && existsSync(cached.systemPromptFile)) return cached;
    const home = ensureMemberHome(this.deps.stateDir, dir, {
      globalUserFile,
      projectScoped: member.scope.kind === 'project',
      freshMode: member.sessionMode === 'fresh',
      memberId: member.id,
      workbenchAdmin: member.capabilities.workbenchAdmin,
    });
    this.homes.set(cacheKey, home);
    return home;
  }

  list(options: { includeArchived?: boolean } = {}): AgentMember[] {
    const all = this.ensureReady();
    const visible = options.includeArchived ? all : all.filter(member => !member.archivedAt);
    return visible.sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      if (a.id === DEFAULT_AGENT_MEMBER_ID) return -1;
      if (b.id === DEFAULT_AGENT_MEMBER_ID) return 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  find(id: string): AgentMember | undefined {
    return this.ensureReady().find(member => member.id === id);
  }

  get(id: string): AgentMember {
    const member = this.find(id);
    if (!member) throw new AppError('TEAM_MEMBER_NOT_FOUND', 'Team member does not exist', 404);
    return member;
  }

  /** Resolves which team member owns a project/session pair, or undefined for ordinary conversations. */
  resolveFor(project: Pick<Project, 'id' | 'system' | 'agentMemberId'>, session?: Pick<Session, 'agentMemberId'>): AgentMember | undefined {
    const members = this.ensureReady();
    if (session?.agentMemberId) {
      return members.find(member => member.id === session.agentMemberId);
    }
    if (project.agentMemberId) {
      return members.find(member => member.id === project.agentMemberId);
    }
    if (project.system === 'assistant') {
      return members.find(member => member.projectId === project.id) ?? members.find(member => member.id === DEFAULT_AGENT_MEMBER_ID);
    }
    return undefined;
  }

  async create(input: AgentMemberCreate): Promise<AgentMember> {
    const members = this.ensureReady();
    const activeCount = members.filter(member => !member.archivedAt).length;
    if (activeCount >= TEAM_BUDGET.maxMembers) {
      throw new AppError('TEAM_MEMBER_LIMIT', `At most ${TEAM_BUDGET.maxMembers} active team members are allowed`, 409);
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > NAME_LIMIT) {
      throw new AppError('INVALID_ARGUMENT', `name must be 1-${NAME_LIMIT} characters`);
    }
    const description = typeof input.description === 'string' && input.description.trim()
      ? input.description.trim().slice(0, DESCRIPTION_LIMIT)
      : undefined;
    const scope = normalizeScope(this.deps.store, input.scope);
    const sessionMode: AgentMemberSessionMode = input.sessionMode === 'fresh' || input.sessionMode === 'continuous'
      ? input.sessionMode
      : (scope.kind === 'project' ? 'fresh' : 'continuous');
    const target = normalizeTarget(input.target);
    const capabilities = normalizeCapabilities(scope.kind, input.capabilities);
    const dailyRuns = normalizeDailyRuns(input.budget?.dailyRuns);
    const id = randomUUID();
    const dir = this.memberDir(id);
    let createdProjectId: string | undefined;
    try {
      // Validate and persist avatar before writing project rows so invalid avatar input leaves no orphan state.
      const avatar = input.avatar !== undefined ? await this.applyAvatar(id, input.avatar, name) : undefined;
      mkdirSync(dir, { recursive: true, mode: 0o700 });

      const instructions = typeof input.instructions === 'string' && input.instructions.trim()
        ? `${input.instructions.trimEnd().slice(0, INSTRUCTIONS_LIMIT)}\n`
        : defaultMemberInstructions(name, description);
      writeFileSync(join(dir, INSTRUCTIONS_FILE), instructions, { mode: 0o600 });
      writeFileSync(join(dir, CLAUDE_FILE), CLAUDE_IMPORT, { mode: 0o600 });

      const globalUserFile = ensureGlobalUserProfile(this.deps.stateDir, this.deps.defaultProject().cwd);
      const home = ensureMemberHome(this.deps.stateDir, dir, {
        globalUserFile,
        projectScoped: scope.kind === 'project',
        freshMode: sessionMode === 'fresh',
        memberId: id,
        workbenchAdmin: capabilities.workbenchAdmin,
      });

      if (typeof input.initialMemory === 'string' && input.initialMemory.trim()) {
        const notes = `${input.initialMemory.trimEnd().slice(0, INITIAL_MEMORY_LIMIT)}\n`;
        writeFileSync(join(home.memoryDir, 'initial-notes.md'), `# Initial Notes\n\n${notes}`, { mode: 0o600 });
        const indexPath = join(home.memoryDir, 'MEMORY.md');
        const existingIndex = readText(indexPath) ?? '';
        const entryLine = '- [Initial Notes](./initial-notes.md) — distilled baseline facts and pitfalls\n';
        if (!existingIndex.includes('initial-notes.md')) {
          writeFileSync(indexPath, `${existingIndex.trimEnd()}\n${entryLine}`, { mode: 0o600 });
        }
      }

      let projectId: string;
      if (scope.kind === 'project') {
        projectId = scope.projectIds![0]!;
      } else {
        const createdProject = this.deps.store.createProject(dir, name);
        createdProjectId = createdProject.id;
        const updated = this.deps.store.updateProject(createdProject.id, { system: 'assistant', agentMemberId: id });
        projectId = updated.id;
      }

      const stamp = nowIso();
      const member: AgentMember = {
        id,
        name,
        ...(avatar ? { avatar } : {}),
        ...(description ? { description } : {}),
        scope,
        sessionMode,
        ...(target ? { target } : {}),
        capabilities,
        memory: { consolidation: input.memory?.consolidation ?? true },
        budget: { dailyRuns },
        projectId,
        ...(input.pinned ? { pinned: true } : {}),
        createdAt: stamp,
        updatedAt: stamp,
      };
      this.writeRaw([...members, member]);
      void commitAssistantHome(dir);
      return member;
    } catch (error) {
      if (createdProjectId) {
        try { this.deps.store.updateProject(createdProjectId, { archivedAt: nowIso() }); } catch { /* ignore */ }
      }
      this.clearAvatarFiles(id);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw error;
    }
  }

  async update(id: string, patch: AgentMemberUpdate): Promise<AgentMember> {
    const members = this.ensureReady();
    const index = members.findIndex(member => member.id === id);
    if (index < 0) throw new AppError('TEAM_MEMBER_NOT_FOUND', 'Team member does not exist', 404);
    const current = members[index]!;
    const next: AgentMember = { ...current };

    // Validate every pure field first so a later validation error never leaves partial SQLite or disk mutations.
    let renamed: string | undefined;
    if (patch.name !== undefined) {
      const name = typeof patch.name === 'string' ? patch.name.trim() : '';
      if (!name || name.length > NAME_LIMIT) throw new AppError('INVALID_ARGUMENT', `name must be 1-${NAME_LIMIT} characters`);
      next.name = name;
      renamed = name;
    }
    if (patch.description !== undefined) {
      if (patch.description === null || !patch.description.trim()) delete next.description;
      else next.description = patch.description.trim().slice(0, DESCRIPTION_LIMIT);
    }
    let validatedScope: AgentMemberScope | undefined;
    if (patch.scope !== undefined) {
      if (id === DEFAULT_AGENT_MEMBER_ID && patch.scope.kind !== current.scope.kind) {
        throw new AppError('INVALID_ARGUMENT', 'The default member scope cannot be changed', 409);
      }
      validatedScope = normalizeScope(this.deps.store, patch.scope);
      next.scope = validatedScope;
    }
    if (patch.sessionMode !== undefined) {
      if (patch.sessionMode !== 'continuous' && patch.sessionMode !== 'fresh') {
        throw new AppError('INVALID_ARGUMENT', 'sessionMode must be continuous or fresh');
      }
      if (id === DEFAULT_AGENT_MEMBER_ID && patch.sessionMode !== current.sessionMode) {
        throw new AppError('INVALID_ARGUMENT', 'The default member sessionMode cannot be changed', 409);
      }
      next.sessionMode = patch.sessionMode;
    }
    if (patch.target !== undefined) {
      if (patch.target === null) {
        delete next.target;
      } else {
        const merged: AgentMemberTarget = { ...current.target };
        if (patch.target.backendId === null) delete merged.backendId;
        else if (patch.target.backendId !== undefined) merged.backendId = patch.target.backendId;
        if (patch.target.profileId === null) delete merged.profileId;
        else if (patch.target.profileId !== undefined) merged.profileId = patch.target.profileId;
        if (patch.target.model === null) delete merged.model;
        else if (patch.target.model !== undefined) merged.model = patch.target.model;
        if (patch.target.permissionMode === null) delete merged.permissionMode;
        else if (patch.target.permissionMode !== undefined) merged.permissionMode = patch.target.permissionMode;
        const normalized = normalizeTarget(merged);
        if (normalized) next.target = normalized;
        else delete next.target;
      }
    }
    if (patch.capabilities !== undefined) {
      next.capabilities = normalizeCapabilities(next.scope.kind, { ...current.capabilities, ...patch.capabilities });
    }
    if (patch.memory?.consolidation !== undefined) {
      next.memory = { consolidation: Boolean(patch.memory.consolidation) };
    }
    if (patch.budget?.dailyRuns !== undefined) {
      next.budget = { dailyRuns: normalizeDailyRuns(patch.budget.dailyRuns, current.budget.dailyRuns) };
    }
    if (patch.pinned !== undefined) {
      if (patch.pinned) next.pinned = true;
      else delete next.pinned;
    }
    if (patch.archived !== undefined) {
      if (patch.archived) {
        if (id === DEFAULT_AGENT_MEMBER_ID) {
          throw new AppError('INVALID_ARGUMENT', 'The default member cannot be archived', 409);
        }
        next.archivedAt = nowIso();
      } else {
        delete next.archivedAt;
      }
    }

    // Apply side effects only after all synchronous validations have succeeded.
    if (patch.avatar !== undefined) {
      const nextAvatar = await this.applyAvatar(id, patch.avatar, next.name);
      if (nextAvatar) next.avatar = nextAvatar;
      else delete next.avatar;
    }
    if (validatedScope) {
      if (validatedScope.kind === 'project') {
        next.projectId = validatedScope.projectIds![0]!;
      } else {
        const existingStanding = this.deps.store.listProjects().find(p => p.system === 'assistant' && p.agentMemberId === id);
        if (existingStanding) {
          next.projectId = existingStanding.id;
        } else {
          const dir = this.memberDir(id);
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          const created = this.deps.store.createProject(dir, next.name);
          next.projectId = this.deps.store.updateProject(created.id, { system: 'assistant', agentMemberId: id }).id;
        }
      }
    }
    if (renamed && next.scope.kind !== 'project') {
      try { this.deps.store.updateProject(next.projectId, { name: renamed }); } catch { /* missing */ }
    }
    if (id === DEFAULT_AGENT_MEMBER_ID && (patch.target !== undefined || patch.memory !== undefined || patch.budget !== undefined)) {
      this.deps.syncDefaultSettings?.(next.target, {
        ...(patch.memory !== undefined ? { consolidation: next.memory.consolidation } : {}),
        ...(patch.budget !== undefined ? { dailyRuns: next.budget.dailyRuns } : {}),
      });
    }

    next.updatedAt = nowIso();
    const updated = members.map((item, idx) => idx === index ? next : item);
    this.homes.clear();
    this.writeRaw(updated);
    return next;
  }

  delete(id: string): void {
    if (id === DEFAULT_AGENT_MEMBER_ID) {
      throw new AppError('INVALID_ARGUMENT', 'The default member cannot be deleted', 409);
    }
    const members = this.ensureReady();
    const member = members.find(item => item.id === id);
    if (!member) throw new AppError('TEAM_MEMBER_NOT_FOUND', 'Team member does not exist', 404);
    if (member.scope.kind !== 'project') {
      try {
        const project = this.deps.store.getProject(member.projectId);
        if (project.system === 'assistant' && !project.archivedAt) {
          this.deps.store.updateProject(project.id, { archivedAt: nowIso() });
        }
      } catch { /* already gone */ }
    }
    this.clearAvatarFiles(id);
    this.homes.clear();
    this.writeRaw(members.filter(item => item.id !== id));
    this.deps.onMemberDeleted?.(id);
  }

  /** Records `sessionId` as a `continuous` member's active standing conversation. */
  claimMainSession(memberId: string, sessionId: string): AgentMember | undefined {
    const members = this.ensureReady();
    const index = members.findIndex(item => item.id === memberId);
    if (index < 0) return undefined;
    const member = members[index]!;
    if (member.sessionMode !== 'continuous') return undefined;
    if (member.mainSessionId && member.mainSessionId !== sessionId) {
      try {
        if (!this.deps.store.getSession(member.mainSessionId).archivedAt) return undefined;
      } catch { /* deleted */ }
    }
    if (member.mainSessionId === sessionId) return member;
    const next: AgentMember = { ...member, mainSessionId: sessionId, updatedAt: nowIso() };
    this.writeRaw(members.map((item, idx) => idx === index ? next : item));
    if (member.scope.kind !== 'project') {
      try {
        const project = this.deps.store.getProject(member.projectId);
        if (project.system === 'assistant' && project.mainSessionId !== sessionId) {
          this.deps.store.updateProject(project.id, { mainSessionId: sessionId });
        }
      } catch { /* ignore */ }
    }
    return next;
  }

  /** Asserts that a `continuous` member does not open a second active main conversation. */
  assertCanOpenConversation(member: AgentMember, sessionId: string): void {
    if (member.archivedAt) throw new AppError('TEAM_MEMBER_ARCHIVED', 'Restore this team member before starting a conversation', 409);
    if (member.sessionMode !== 'continuous' || !member.mainSessionId || member.mainSessionId === sessionId) return;
    try {
      if (this.deps.store.getSession(member.mainSessionId).archivedAt) return;
    } catch { return; }
    throw new AppError('ASSISTANT_CONVERSATION_EXISTS', `${member.name} already has an active conversation; continue that one`, 409);
  }

  /** Lists conversations belonging to a member (newest first, excluding background runs). */
  listSessions(memberId: string, options: { includeArchived?: boolean; limit?: number } = {}): Session[] {
    const member = this.get(memberId);
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    return this.deps.store.listSessions()
      .filter(session => {
        if (!options.includeArchived && session.archivedAt) return false;
        if (session.origin?.kind === 'assistant') return false;
        if (session.agentMemberId === member.id) return true;
        if (member.scope.kind !== 'project' && !session.agentMemberId && session.origin?.kind !== 'call' && session.projectId === member.projectId) return true;
        return false;
      })
      .sort((a, b) => (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt))
      .slice(0, limit);
  }

  instructions(memberId: string, text?: string | null): AssistantInstructions {
    if (memberId === DEFAULT_AGENT_MEMBER_ID) return this.deps.defaultInstructions(text);
    const member = this.get(memberId);
    const dir = this.memberDir(member.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, INSTRUCTIONS_FILE);
    if (text !== undefined) {
      if (text !== null && (typeof text !== 'string' || text.length > INSTRUCTIONS_LIMIT || text.includes('\0'))) {
        throw new AppError('INVALID_ARGUMENT', `Instructions are text of at most ${INSTRUCTIONS_LIMIT} characters`);
      }
      const next = text === null || !text.trim()
        ? defaultMemberInstructions(member.name, member.description)
        : `${text.trimEnd()}\n`;
      writeFileSync(path, next, { mode: 0o600 });
      void commitAssistantHome(dir);
    }
    return { text: readText(path) ?? '', custom: true };
  }

  memory(memberId: string): AssistantMemory {
    const member = this.get(memberId);
    const globalUserFile = ensureGlobalUserProfile(this.deps.stateDir, this.deps.defaultProject().cwd);
    return readAssistantMemory(this.memberDir(member.id), globalUserFile);
  }

  async forgetMemory(memberId: string, name: string): Promise<void> {
    const member = this.get(memberId);
    await forgetAssistantMemory(this.memberDir(member.id), name);
  }

  files(memberId: string): AssistantFile[] {
    const member = this.get(memberId);
    return listAssistantFiles(this.memberDir(member.id));
  }

  filePath(memberId: string, path: string): string | undefined {
    const member = this.get(memberId);
    return assistantFilePath(this.memberDir(member.id), path);
  }

  private avatarsDir(): string {
    return join(this.deps.stateDir, 'team-avatars');
  }

  private clearAvatarFiles(memberId: string): void {
    const dir = this.avatarsDir();
    for (const ext of Object.values(AVATAR_EXT_BY_TYPE)) {
      rmSync(join(dir, `${memberId}.${ext}`), { force: true });
    }
  }

  private storeAvatarBytes(memberId: string, bytes: Buffer, type: OwnerAvatarType): AgentMemberAvatar {
    if (!bytes.length || bytes.length > OWNER_AVATAR_MAX_BYTES) {
      throw new AppError('INVALID_ARGUMENT', `avatar image must be at most ${OWNER_AVATAR_MAX_BYTES} bytes`);
    }
    const dir = this.avatarsDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.clearAvatarFiles(memberId);
    const ext = AVATAR_EXT_BY_TYPE[type];
    writeFileSync(join(dir, `${memberId}.${ext}`), bytes, { mode: 0o600 });
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    return { kind: 'image', url: `/api/team/members/${encodeURIComponent(memberId)}/avatar?v=${hash}` };
  }

  private async applyAvatar(memberId: string, input: AgentMemberAvatarInput | null, memberName?: string): Promise<AgentMemberAvatar | undefined> {
    if (input === null) {
      this.clearAvatarFiles(memberId);
      return undefined;
    }
    if (!input || typeof input !== 'object') throw new AppError('INVALID_ARGUMENT', 'avatar is invalid');
    if (input.kind === 'emoji') {
      const value = typeof input.value === 'string' ? input.value.trim() : '';
      if (!value || value.length > EMOJI_LIMIT || /[\0\r\n]/.test(value)) {
        throw new AppError('INVALID_ARGUMENT', 'avatar emoji is invalid');
      }
      this.clearAvatarFiles(memberId);
      return { kind: 'emoji', value };
    }
    if (input.kind === 'image') {
      if (!(OWNER_AVATAR_TYPES as readonly string[]).includes(input.type)) {
        throw new AppError('INVALID_ARGUMENT', 'avatar image type is not supported');
      }
      if (typeof input.data !== 'string' || !input.data.trim()) {
        throw new AppError('INVALID_ARGUMENT', 'avatar image data is required');
      }
      return this.storeAvatarBytes(memberId, Buffer.from(input.data, 'base64'), input.type);
    }
    if (input.kind === 'generated') {
      if (!this.deps.renderAvatar) throw new AppError('OWNER_AVATAR_STYLE_NOT_FOUND', 'No avatar generator is available', 404);
      const { png } = await this.deps.renderAvatar(input.request, memberName);
      return this.storeAvatarBytes(memberId, png, 'image/png');
    }
    throw new AppError('INVALID_ARGUMENT', 'avatar kind must be image, generated, or emoji');
  }

  avatarFile(memberId: string): { path: string; type: OwnerAvatarType } | undefined {
    const member = this.get(memberId);
    const dir = this.avatarsDir();
    for (const [ext, type] of Object.entries(AVATAR_TYPE_BY_EXT)) {
      const file = join(dir, `${member.id}.${ext}`);
      if (existsSync(file)) return { path: file, type };
    }
    return undefined;
  }

  userProfile(): AgentMemberUserProfile {
    ensureGlobalUserProfile(this.deps.stateDir, this.deps.defaultProject().cwd);
    const { text, updatedAt } = readGlobalUserProfile(this.deps.stateDir);
    return { text, maxChars: TEAM_BUDGET.globalUserProfileChars, ...(updatedAt ? { updatedAt } : {}) };
  }

  updateUserProfile(text: string): AgentMemberUserProfile {
    if (typeof text !== 'string' || text.includes('\0')) {
      throw new AppError('INVALID_ARGUMENT', 'text must be a valid string');
    }
    if (text.trim().length > TEAM_BUDGET.globalUserProfileChars) {
      throw new AppError('INVALID_ARGUMENT', `Global owner profile cannot exceed ${TEAM_BUDGET.globalUserProfileChars} characters`);
    }
    const saved = writeGlobalUserProfile(this.deps.stateDir, text);
    return { text: saved.text, maxChars: TEAM_BUDGET.globalUserProfileChars, updatedAt: saved.updatedAt };
  }
}
