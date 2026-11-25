import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_MEMBER_ID, TEAM_BUDGET, type AgentMember } from '@contracts';
import { createApp } from '../app.js';
import { OwnerService } from '../owner/index.js';
import { classifyLinkRoute, linkPolicy } from '../links/policy.js';
import { assistantProject } from '../work-items/index.js';
import { AgentTeamService } from './team.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  // Run LIFO so app.close() completes before temporary directories are removed.
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function boot(stateDir: string) {
  const booted = await createApp({ stateDir, auth: false, cliPath: '/nonexistent/cursor-agent' });
  vi.spyOn(booted.dispatch, 'kick').mockImplementation(() => undefined);
  vi.spyOn(booted.nativeBackends, 'assertAvailable').mockImplementation(() => undefined);
  vi.spyOn(booted.nativeBackends.catalog, 'listBackends').mockResolvedValue([
    { backendId: 'claude', label: 'Claude Code', available: true, models: [], profiles: [], capabilities: {} },
    { backendId: 'codex', label: 'Codex', available: false, models: [], profiles: [], capabilities: {} },
  ] as never);
  cleanups.push(async () => {
    await booted.app.close();
  });
  const status = await booted.app.inject({ method: 'GET', url: '/api/auth/status', headers: { host: '127.0.0.1:4317' } });
  const cookie = String(status.headers['set-cookie']).split(';')[0]!;
  const csrf = (status.json() as { csrfToken: string }).csrfToken;
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => booted.app.inject({
    method,
    url,
    headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { ...booted, call };
}

async function mcpToolsOf(server: Awaited<ReturnType<typeof boot>>, sessionId: string): Promise<string[]> {
  const mcpServer = server.riffetMcp.server(sessionId);
  expect(mcpServer).toBeTruthy();
  const { credential } = JSON.parse(await readFile(mcpServer!.args.at(-1)!, 'utf8')) as { credential: string };
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/riffet-mcp',
    headers: { host: '127.0.0.1:4317', authorization: `Bearer ${credential}` },
    payload: { method: 'tools/list' },
  });
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json() as { result?: { tools?: Array<{ name: string }> } };
  return (body.result?.tools ?? []).map(tool => tool.name);
}

describe('team members (docs/TEAM.md)', () => {
  it('migrates the legacy singleton personal assistant losslessly and preserves custom rules across restart', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'riffet-team-migrate-'));
    cleanups.push(() => rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

    // Seed legacy assistant USER.md before first boot.
    const legacyDir = join(stateDir, 'assistant');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, 'USER.md'), '# 关于你\n\n偏好简洁中文回复。\n', 'utf8');

    const server = await boot(stateDir);
    const bootstrapRes = await server.call('GET', '/api/bootstrap');
    expect(bootstrapRes.statusCode, bootstrapRes.body).toBe(200);
    const bootstrap = bootstrapRes.json() as { teamMembers?: AgentMember[] };
    expect(bootstrap.teamMembers?.length).toBe(1);

    const def = bootstrap.teamMembers![0]!;
    expect(def.id).toBe(DEFAULT_AGENT_MEMBER_ID);
    expect(def.scope.kind).toBe('global');
    expect(def.sessionMode).toBe('continuous');
    expect(def.projectId).toBe(assistantProject(server.store, stateDir).id);

    // Legacy USER.md was migrated to shared global profile.
    const profileRes = await server.call('GET', '/api/team/user-profile');
    expect(profileRes.statusCode).toBe(200);
    expect((profileRes.json() as { text: string }).text).toContain('偏好简洁中文回复');

    // Editing default instructions through legacy or team route persists cleanly.
    const saveInst = await server.call('PUT', `/api/team/members/${DEFAULT_AGENT_MEMBER_ID}/instructions`, {
      text: '# Custom Legacy Assistant\n\nAlways reply concisely.\n',
    });
    expect(saveInst.statusCode).toBe(200);

    const instRes = await server.call('GET', `/api/team/members/${DEFAULT_AGENT_MEMBER_ID}/instructions`);
    expect(instRes.statusCode).toBe(200);
    expect((instRes.json() as { text: string }).text).toContain('Always reply concisely.');
  });

  it('isolates personal and project-scoped members, enforces shared USER.md budget, and filters MCP tools by capability', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'riffet-team-scope-'));
    const repoDir = await mkdtemp(join(tmpdir(), 'riffet-team-repo-'));
    cleanups.push(() => rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    cleanups.push(() => rm(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

    const server = await boot(stateDir);
    const repoProject = server.store.createProject(repoDir, 'riffet-repo');

    // Create a personal continuous member (investing) with emoji avatar and restricted capabilities.
    const personalRes = await server.call('POST', '/api/team/members', {
      name: '理财分析',
      avatar: { kind: 'emoji', value: '📈' },
      scope: { kind: 'personal' },
      sessionMode: 'continuous',
      instructions: '# 理财分析\n\n只看公开财报与资产配置。\n',
      initialMemory: '# 持仓基线\n\n偏好指数基金定投。\n',
      capabilities: {
        workspace: false,
        taskBoard: false,
        delegations: false,
        memberCalls: false,
        externalTools: false,
        workbenchAdmin: false,
      },
    });
    expect(personalRes.statusCode, personalRes.body).toBe(201);
    const personal = personalRes.json() as AgentMember;
    expect(personal.scope.kind).toBe('personal');
    expect(personal.avatar).toEqual({ kind: 'emoji', value: '📈' });
    expect(personal.projectId).not.toBe(repoProject.id);

    // Updating to an uploaded PNG image serves it from /api/team/members/:id/avatar and clearing removes it.
    const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const uploadAvatar = await server.call('PATCH', `/api/team/members/${personal.id}`, {
      avatar: { kind: 'image', type: 'image/png', data: png1x1 },
    });
    expect(uploadAvatar.statusCode, uploadAvatar.body).toBe(200);
    const withImage = uploadAvatar.json() as AgentMember;
    expect(withImage.avatar?.kind).toBe('image');
    const avatarUrl = withImage.avatar?.kind === 'image' ? withImage.avatar.url : '';
    const avatarFetch = await server.call('GET', avatarUrl);
    expect(avatarFetch.statusCode).toBe(200);
    expect(avatarFetch.headers['content-type']).toBe('image/png');
    expect(avatarFetch.rawPayload.length).toBeGreaterThan(0);

    const clearAvatar = await server.call('PATCH', `/api/team/members/${personal.id}`, { avatar: null });
    expect(clearAvatar.statusCode).toBe(200);
    expect((clearAvatar.json() as AgentMember).avatar).toBeUndefined();
    const avatarGone = await server.call('GET', `/api/team/members/${personal.id}/avatar`);
    expect(avatarGone.statusCode).toBe(404);

    // Generated avatars render through the same AvatarStyles engine as Settings -> Profile.
    const generatedState = await mkdtemp(join(tmpdir(), 'riffet-team-avatar-'));
    cleanups.push(() => rm(generatedState, { recursive: true, force: true }));
    const draw = ({ size, ink, paper, name }: { seed: string; size: number; ink: string; paper: string; name?: string }) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}"><rect width="100" height="100" fill="${paper}"/><circle cx="50" cy="50" r="24" fill="${ink}"/>${name ? `<text x="10" y="60" font-size="24">${name}</text>` : ''}</svg>`;
    const ownerWithStyle = new OwnerService({
      stateDir: generatedState,
      avatarStyles: () => ({
        avatarStyles: () => [{
          owner: 'test.avatars',
          declaration: { id: 'test.avatars/badge', title: { en: 'Badge' }, needsName: true },
          provider: { generate: draw },
        }],
      }),
    });
    const styledTeam = new AgentTeamService({
      store: server.store,
      stateDir: generatedState,
      defaultProject: () => assistantProject(server.store, generatedState),
      defaultInstructions: () => ({ text: '', custom: false }),
      renderAvatar: (request, name) => ownerWithStyle.renderGeneratedAvatar(request, name),
    });
    const generatedMember = await styledTeam.create({
      name: '发版助手',
      avatar: { kind: 'generated', request: { style: 'test.avatars/badge', seed: 'seed-1' } },
      scope: { kind: 'personal' },
      sessionMode: 'fresh',
    });
    expect(generatedMember.avatar?.kind).toBe('image');
    const generatedFile = styledTeam.avatarFile(generatedMember.id);
    expect(generatedFile?.type).toBe('image/png');
    const generatedBytes = await readFile(generatedFile!.path);
    expect([...generatedBytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    styledTeam.delete(generatedMember.id);

    // Create a project-scoped fresh member (Riffet QA) with taskBoard enabled but workbenchAdmin disabled.
    const qaRes = await server.call('POST', '/api/team/members', {
      name: 'Riffet 验收',
      scope: { kind: 'project', projectIds: [repoProject.id] },
      sessionMode: 'fresh',
      instructions: '# Riffet 验收\n\n验收通过前必须跑完回归检查。\n',
      capabilities: {
        workspace: true,
        taskBoard: true,
        delegations: false,
        memberCalls: false,
        externalTools: true,
        workbenchAdmin: false,
      },
    });
    expect(qaRes.statusCode, qaRes.body).toBe(201);
    const qa = qaRes.json() as AgentMember;
    expect(qa.projectId).toBe(repoProject.id);
    expect(qa.sessionMode).toBe('fresh');

    // Shared USER.md enforces character limit and is readable from every member's memory view.
    const overLimit = 'a'.repeat(TEAM_BUDGET.globalUserProfileChars + 50);
    const saveProfileRes = await server.call('PUT', '/api/team/user-profile', { text: overLimit });
    expect(saveProfileRes.statusCode).toBe(400);

    const validProfileRes = await server.call('PUT', '/api/team/user-profile', {
      text: '# 关于你\n\n在北京工作，习惯先看结论。\n',
    });
    expect(validProfileRes.statusCode).toBe(200);

    const qaMemoryRes = await server.call('GET', `/api/team/members/${qa.id}/memory`);
    expect(qaMemoryRes.statusCode).toBe(200);
    expect((qaMemoryRes.json() as { profile: string }).profile).toContain('习惯先看结论');

    // Create sessions for both members and verify MCP tool filtering.
    const personalSession = server.store.createSession({
      projectId: personal.projectId,
      agentMemberId: personal.id,
      kind: 'native',
      backendId: 'claude',
      title: '理财分析',
    });
    const qaSession = server.store.createSession({
      projectId: repoProject.id,
      agentMemberId: qa.id,
      kind: 'native',
      backendId: 'claude',
      title: '验收构建 #12',
    });

    const personalTools = await mcpToolsOf(server, personalSession.id);
    expect(personalTools).not.toContain('task_create');
    expect(personalTools).not.toContain('delegation_create');
    expect(personalTools).not.toContain('schedule_wakeup');
    // agent_call stays exposed so explicit user @mentions work mid-conversation; AgentCallService enforces memberCalls at call time.
    expect(personalTools).toContain('agent_call');
    expect(personalTools).not.toContain('capability_read');
    expect(personalTools).not.toContain('server_status');

    const qaTools = await mcpToolsOf(server, qaSession.id);
    expect(qaTools).toContain('task_create');
    expect(qaTools).toContain('task_list');
    expect(qaTools).not.toContain('delegation_create');
    expect(qaTools).not.toContain('schedule_wakeup');
    expect(qaTools).toContain('agent_call');
    expect(qaTools).not.toContain('capability_read');
    expect(qaTools).not.toContain('server_status');

    // A called member conversation (depth 1) never receives agent_call.
    const calledQaSession = server.store.createSession({
      projectId: repoProject.id,
      agentMemberId: qa.id,
      origin: { kind: 'call', sessionId: personalSession.id },
      kind: 'native',
      backendId: 'claude',
      title: '来自理财分析的咨询',
    });
    expect(await mcpToolsOf(server, calledQaSession.id)).not.toContain('agent_call');

    // Default member cannot be deleted, while custom members can.
    const delDefault = await server.call('DELETE', `/api/team/members/${DEFAULT_AGENT_MEMBER_ID}`);
    expect(delDefault.statusCode).toBe(409);
    const delPersonal = await server.call('DELETE', `/api/team/members/${personal.id}`);
    expect(delPersonal.statusCode).toBe(204);
  });

  it('exposes agent_member (list/get/create/update) in interactive sessions and blocks it in called/background sessions', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'riffet-team-mcp-create-'));
    cleanups.push(() => rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    const server = await boot(stateDir);
    const repoDir = join(stateDir, 'mcp-repo');
    await mkdir(repoDir, { recursive: true });
    const repoProject = server.store.createProject(repoDir, 'mcp-repo');
    const regularSession = server.store.createSession({
      projectId: repoProject.id,
      kind: 'native',
      backendId: 'claude',
      title: '日常开发',
    });

    // Helper to invoke Riffet MCP directly for a session.
    const rpc = async (sessionId: string, method: string, params?: unknown) => {
      const spec = server.riffetMcp.server(sessionId)!;
      const saved = JSON.parse(await readFile(spec.args.at(-1)!, 'utf8')) as { credential: string };
      return server.app.inject({
        method: 'POST',
        url: '/api/riffet-mcp',
        headers: { host: '127.0.0.1:4317', authorization: `Bearer ${saved.credential}` },
        payload: { method, params },
      });
    };

    expect(await mcpToolsOf(server, regularSession.id)).toContain('agent_member');

    // Creating a member from a project conversation defaults scope to 'project' bound to that project.
    const createdRes = await rpc(regularSession.id, 'tools/call', {
      name: 'agent_member',
      arguments: {
        action: 'create',
        name: '构建助手',
        description: '负责前端打包与产物检查',
        instructions: '# 构建助手\n\n只负责构建与检查，不直接修改业务逻辑。',
        initialMemory: '使用 pnpm exec vite build 验证产物。',
        emoji: '📦',
        capabilities: { workspace: true, memberCalls: true, workbenchAdmin: true },
        pinned: true,
      },
    });
    expect(createdRes.statusCode).toBe(200);
    const createdBody = createdRes.json() as {
      result: {
        isError?: boolean;
        structuredContent: {
          created: {
            id: string;
            name: string;
            description?: string;
            scope: { kind: string; projectIds?: string[] };
            sessionMode: string;
            projectId: string;
            capabilities: { workspace: boolean; memberCalls: boolean; workbenchAdmin: boolean };
            avatar?: { kind: string; value: string };
            pinned?: boolean;
            mention: string;
            agentCallTarget: string;
          };
        };
      };
    };
    expect(createdBody.result.isError).toBeUndefined();
    const created = createdBody.result.structuredContent.created;
    expect(created.name).toBe('构建助手');
    expect(created.scope).toEqual({ kind: 'project', projectIds: [repoProject.id] });
    expect(created.sessionMode).toBe('fresh');
    expect(created.projectId).toBe(repoProject.id);
    // workbenchAdmin is ignored for project members (no privilege escalation).
    expect(created.capabilities.workspace).toBe(true);
    expect(created.capabilities.memberCalls).toBe(true);
    expect(created.capabilities.workbenchAdmin).toBe(false);
    expect(created.avatar).toEqual({ kind: 'emoji', value: '📦' });
    expect(created.pinned).toBe(true);
    expect(created.mention).toBe('@构建助手');
    expect(created.agentCallTarget).toBe(`member/${created.id}`);

    // list and get return the member and its AGENTS.md instructions (accepting both id and member/<id>).
    const mcpList = (await rpc(regularSession.id, 'tools/call', {
      name: 'agent_member',
      arguments: { action: 'list' },
    })).json() as { result: { isError?: boolean; structuredContent: { members: Array<{ id: string; name: string }> } } };
    expect(mcpList.result.isError).toBeUndefined();
    expect(mcpList.result.structuredContent.members.some(m => m.id === created.id && m.name === '构建助手')).toBe(true);

    const mcpGet = (await rpc(regularSession.id, 'tools/call', {
      name: 'agent_member',
      arguments: { action: 'get', memberId: `member/${created.id}` },
    })).json() as { result: { isError?: boolean; structuredContent: { member: { id: string }; instructions: string } } };
    expect(mcpGet.result.isError).toBeUndefined();
    expect(mcpGet.result.structuredContent.member.id).toBe(created.id);
    expect(mcpGet.result.structuredContent.instructions).toContain('只负责构建与检查');

    // update edits metadata, clears emoji, updates AGENTS.md, and refuses workbenchAdmin escalation.
    const updatedRes = (await rpc(regularSession.id, 'tools/call', {
      name: 'agent_member',
      arguments: {
        action: 'update',
        memberId: created.id,
        name: '前端构建官',
        description: '负责 Web 构建与类型检查',
        emoji: '',
        capabilities: { externalTools: true, workbenchAdmin: true },
        instructions: '# 前端构建官\n\n构建前必须先跑 typecheck。',
        pinned: false,
      },
    })).json() as {
      result: {
        isError?: boolean;
        structuredContent: {
          updated: {
            id: string;
            name: string;
            description?: string;
            avatar?: unknown;
            pinned?: boolean;
            capabilities: { externalTools: boolean; workbenchAdmin: boolean };
          };
          instructionsUpdated?: boolean;
        };
      };
    };
    expect(updatedRes.result.isError).toBeUndefined();
    expect(updatedRes.result.structuredContent.updated.name).toBe('前端构建官');
    expect(updatedRes.result.structuredContent.updated.description).toBe('负责 Web 构建与类型检查');
    expect(updatedRes.result.structuredContent.updated.avatar).toBeUndefined();
    expect(updatedRes.result.structuredContent.updated.pinned).toBeUndefined();
    expect(updatedRes.result.structuredContent.updated.capabilities.externalTools).toBe(true);
    expect(updatedRes.result.structuredContent.updated.capabilities.workbenchAdmin).toBe(false);
    expect(updatedRes.result.structuredContent.instructionsUpdated).toBe(true);

    // Persisted instructions and member list reflect the updated member.
    const listRes = await server.call('GET', '/api/team/members');
    expect((listRes.json() as { members: AgentMember[] }).members.some(m => m.id === created.id && m.name === '前端构建官')).toBe(true);
    const instRes = await server.call('GET', `/api/team/members/${created.id}/instructions`);
    expect((instRes.json() as { text: string }).text).toContain('构建前必须先跑 typecheck');

    // System project (default assistant) rejects scope='project' without projectIds, and accepts scope='personal'.
    const defaultMember = (listRes.json() as { members: AgentMember[] }).members.find(m => m.id === DEFAULT_AGENT_MEMBER_ID)!;
    const assistantSession = server.store.createSession({
      projectId: defaultMember.projectId,
      agentMemberId: defaultMember.id,
      kind: 'native',
      backendId: 'claude',
      title: '个人助理对话',
    });
    const missingProj = await rpc(assistantSession.id, 'tools/call', {
      name: 'agent_member',
      arguments: { action: 'create', name: '缺项目成员', scope: 'project' },
    });
    expect((missingProj.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result.isError).toBe(true);
    expect((missingProj.json() as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).toContain('INVALID_ARGUMENT');

    const personalRes = await rpc(assistantSession.id, 'tools/call', {
      name: 'agent_member',
      arguments: { action: 'create', name: '阅读笔记', description: '整理每日文章摘要' },
    });
    const personalCreated = (personalRes.json() as { result: { isError?: boolean; structuredContent: { created: { id: string; scope: { kind: string }; sessionMode: string } } } }).result;
    expect(personalCreated.isError).toBeUndefined();
    expect(personalCreated.structuredContent.created.scope).toEqual({ kind: 'personal' });
    expect(personalCreated.structuredContent.created.sessionMode).toBe('continuous');

    // scope='global' created via MCP never escalates to workbenchAdmin, and includeArchived lists archived members.
    const globalRes = (await rpc(assistantSession.id, 'tools/call', {
      name: 'agent_member',
      arguments: { action: 'create', name: '协调官', scope: 'global', capabilities: { workbenchAdmin: true } },
    })).json() as { result: { isError?: boolean; structuredContent: { created: { id: string; capabilities: { workbenchAdmin: boolean } } } } };
    expect(globalRes.result.isError).toBeUndefined();
    expect(globalRes.result.structuredContent.created.capabilities.workbenchAdmin).toBe(false);
    const archivedGlobalId = globalRes.result.structuredContent.created.id;
    await rpc(assistantSession.id, 'tools/call', {
      name: 'agent_member',
      arguments: { action: 'update', memberId: archivedGlobalId, archived: true },
    });
    const activeOnly = (await rpc(assistantSession.id, 'tools/call', {
      name: 'agent_member',
      arguments: { action: 'list' },
    })).json() as { result: { structuredContent: { members: Array<{ id: string }> } } };
    expect(activeOnly.result.structuredContent.members.some(m => m.id === archivedGlobalId)).toBe(false);
    const withArchived = (await rpc(assistantSession.id, 'tools/call', {
      name: 'agent_member',
      arguments: { action: 'list', includeArchived: true },
    })).json() as { result: { structuredContent: { members: Array<{ id: string }> } } };
    expect(withArchived.result.structuredContent.members.some(m => m.id === archivedGlobalId)).toBe(true);

    // Default member's scope and sessionMode cannot be changed.
    const badDefaultScope = await rpc(assistantSession.id, 'tools/call', {
      name: 'agent_member',
      arguments: { action: 'update', memberId: DEFAULT_AGENT_MEMBER_ID, scope: 'personal' },
    });
    expect((badDefaultScope.json() as { result: { isError?: boolean } }).result.isError).toBe(true);

    // Linked-server sessions cannot list or invoke agent_member.
    const linkedSession = server.store.createSession({
      projectId: repoProject.id,
      origin: { kind: 'link', serverId: 'peer-1' },
      kind: 'native',
      backendId: 'claude',
      title: '跨服会话',
    });
    expect(await mcpToolsOf(server, linkedSession.id)).not.toContain('agent_member');
    const linkedTry = await rpc(linkedSession.id, 'tools/call', {
      name: 'agent_member',
      arguments: { action: 'list' },
    });
    expect((linkedTry.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result.isError).toBe(true);
    expect((linkedTry.json() as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).toContain('TOOL_NOT_AVAILABLE');

    // Called sub-sessions and background assistant runs neither list nor execute agent_member.
    const calledSession = server.store.createSession({
      projectId: repoProject.id,
      origin: { kind: 'call', sessionId: regularSession.id },
      kind: 'native',
      backendId: 'claude',
      title: '子调用',
    });
    expect(await mcpToolsOf(server, calledSession.id)).not.toContain('agent_member');
    const calledTry = await rpc(calledSession.id, 'tools/call', {
      name: 'agent_member',
      arguments: { action: 'create', name: '越权成员', scope: 'personal' },
    });
    expect((calledTry.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result.isError).toBe(true);
    expect((calledTry.json() as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).toContain('TOOL_NOT_AVAILABLE');

    const bgSession = server.store.createSession({
      projectId: defaultMember.projectId,
      origin: { kind: 'assistant', job: 'consolidate' },
      kind: 'native',
      backendId: 'claude',
      title: '后台整理',
    });
    expect(await mcpToolsOf(server, bgSession.id)).not.toContain('agent_member');
  });

  it('routes cross-member agent_call from legacy default assistant session and persists target agentMemberId', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'riffet-team-call-e2e-'));
    cleanups.push(() => rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    const server = await boot(stateDir);
    const repoDir = join(stateDir, 'release-repo');
    await mkdir(repoDir, { recursive: true });
    const repoProject = server.store.createProject(repoDir, 'release-repo');

    // Mock backend catalog & capabilities so OrchestrationService.start() runs end-to-end.
    vi.spyOn(server.nativeBackends.catalog, 'listBackends').mockResolvedValue([
      {
        backendId: 'claude',
        label: 'Claude Code',
        available: true,
        models: [],
        profiles: [{ id: 'default', name: 'Default', isDefault: true, available: true }],
        capabilities: { supportsPermissionSelection: true, permissions: [{ id: 'plan', label: 'Plan' }], consultPermission: 'plan' },
      },
    ] as never);
    vi.spyOn(server.nativeBackends.catalog, 'capabilitiesFor').mockResolvedValue({
      supportsPermissionSelection: true,
      supportsModeSelection: false,
      modes: [],
      permissions: [{ id: 'plan', label: 'Plan' }],
      consultPermission: 'plan',
      extensionToggles: { mcp: false, skills: false },
    } as never);
    vi.spyOn(server.nativeBackends.catalog, 'validateProfile').mockReturnValue({ id: 'default', backendId: 'claude', name: 'Default', isDefault: true, config: {} } as never);

    // Create a project-scoped target member.
    const createRes = await server.call('POST', '/api/team/members', {
      name: 'ArchAgent 发版助手',
      scope: { kind: 'project', projectIds: [repoProject.id] },
      sessionMode: 'continuous',
      target: { backendId: 'claude' },
    });
    expect(createRes.statusCode, createRes.body).toBe(201);
    const release = createRes.json() as AgentMember;

    // Legacy personal assistant main session has NO `agentMemberId` stamped on the session row, only `project.system === 'assistant'`.
    const listMembers = (await server.call('GET', '/api/team/members')).json() as { members: AgentMember[] };
    const defaultMember = listMembers.members.find(m => m.id === DEFAULT_AGENT_MEMBER_ID)!;
    const legacyAssistantSession = server.store.createSession({
      projectId: defaultMember.projectId,
      kind: 'native',
      backendId: 'claude',
      title: '个人助理',
    });
    expect(legacyAssistantSession.agentMemberId).toBeUndefined();

    const spec = server.riffetMcp.server(legacyAssistantSession.id)!;
    const saved = JSON.parse(await readFile(spec.args.at(-1)!, 'utf8')) as { credential: string };
    const mcp = (method: string, params?: unknown) => server.app.inject({
      method: 'POST',
      url: '/api/riffet-mcp',
      headers: { host: '127.0.0.1:4317', authorization: `Bearer ${saved.credential}` },
      payload: { method, params },
    });

    // Legacy default assistant is recognized as `default` member (memberCalls: true) and sees the release member in agent_list.
    const listed = (await mcp('tools/call', { name: 'agent_list', arguments: {} })).json() as {
      result: { isError?: boolean; structuredContent: { agents: Array<{ agent: string; name?: string }> } };
    };
    expect(listed.result.isError).toBeUndefined();
    expect(listed.result.structuredContent.agents.some(item => item.agent === `member/${release.id}`)).toBe(true);

    // Calling the release member creates a session with `agentMemberId: release.id` that appears in the target member's sessions!
    const called = (await mcp('tools/call', {
      name: 'agent_call',
      arguments: { agent: `member/${release.id}`, prompt: '当前 BOE 版本是多少？', wait: 0 },
    })).json() as {
      result: { isError?: boolean; structuredContent: { call: string } };
    };
    expect(called.result.isError).toBeUndefined();
    const callSessionId = called.result.structuredContent.call;
    const callSession = server.store.getSession(callSessionId);
    expect(callSession.agentMemberId).toBe(release.id);
    expect(callSession.origin).toMatchObject({ kind: 'call', sessionId: legacyAssistantSession.id });

    const memberSessionsRes = await server.call('GET', `/api/team/members/${release.id}/sessions`);
    expect(memberSessionsRes.statusCode).toBe(200);
    expect((memberSessionsRes.json() as { sessions: Array<{ id: string }> }).sessions.map(s => s.id)).toContain(callSessionId);
  });

  it('classifies and denies /api/team routes over server links', () => {
    expect(classifyLinkRoute('GET', '/api/team/members')).toBe('deny');
    expect(linkPolicy('GET', '/api/team/members')).toBe('deny');
    expect(linkPolicy('PUT', '/api/team/user-profile')).toBe('deny');
    expect(linkPolicy('GET', '/api/team/members/:id/memory')).toBe('deny');
  });
});
