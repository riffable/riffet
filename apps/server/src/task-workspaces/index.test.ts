import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, NativeRunInput, NativeSessionInput, Project } from '../../../../packages/contracts/src/index.js';
import { Store } from '../store.js';
import type { SettingsService } from '../settings/index.js';
import { assertTaskWorkspaceAvailable, TASK_WORKSPACE_MARKER, TaskWorkspaceService, taskWorkspaceRequestDigest } from './index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup() {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'riffet-projectless-')));
  const stateDir = join(scratch, 'state');
  await mkdir(stateDir);
  const store = new Store(join(stateDir, 'workbench.db'));
  const saved: AppSettings = { taskWorkspaceRoot: join(scratch, 'tasks') };
  const settings = { getSettings: () => saved } as SettingsService;
  let now = new Date('2026-11-03T12:00:00Z');
  const service = () => new TaskWorkspaceService({ store, settings, stateDir, now: () => now });
  const workspaces = service();
  cleanups.push(async () => { store.close(); await rm(scratch, { recursive: true, force: true }); });
  const input: NativeRunInput = { text: '整理 中文资料\n输出报告', attachmentIds: [], context: [] };
  const request = { clientSessionId: 'creation-1', commandId: 'message-1', text: input.text, requestDigest: taskWorkspaceRequestDigest({ text: input.text, model: 'model-1' }) };
  const resolveInput = vi.fn(async (project: Project): Promise<NativeSessionInput> => ({ projectId: project.id, backendId: 'codex', backendProfileId: 'default', mode: 'agent', model: 'model-1' }));
  const readInput = vi.fn(async () => input);
  return { scratch, stateDir, store, saved, workspaces, service, request, input, resolveInput, readInput, setNow: (value: Date) => { now = value; } };
}

describe('durable projectless task allocation', () => {
  it('reuses the persisted candidate when independent service instances allocate concurrently', async () => {
    const { service, store, request, resolveInput, readInput } = await setup();
    const results = await Promise.all(Array.from({ length: 8 }, () => service().create(request, resolveInput, readInput)));
    expect(new Set(results.map(item => item.project.cwd)).size).toBe(1);
    expect(new Set(results.map(item => item.run.id)).size).toBe(1);
    expect(store.listProjects()).toHaveLength(1);
    expect(store.listSessions()).toHaveLength(1);
    await assertTaskWorkspaceAvailable(results[0]!.project);
  });

  it('replays an accepted and promoted task when another service finishes during provider validation', async () => {
    const { workspaces, service, store, request, resolveInput, readInput } = await setup();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = service().create(request, async project => {
      entered();
      await waiting;
      return resolveInput(project);
    }, readInput);
    await started;
    const accepted = await workspaces.create(request, resolveInput, readInput);
    const promoted = store.promoteTaskWorkspace(accepted.project.id, 'Saved concurrently');
    release();
    const replay = await pending;
    expect(replay.project).toEqual(promoted);
    expect(replay.run.id).toBe(accepted.run.id);
    expect(store.listProjects()).toHaveLength(1);
    expect(store.listRuns(accepted.session.id)).toHaveLength(1);
  });

  it('accepts one task under concurrent identical submissions and replays after defaults, root and files change', async () => {
    const { workspaces, store, saved, scratch, request, resolveInput, readInput, setNow } = await setup();
    const results = await Promise.all(Array.from({ length: 8 }, () => workspaces.create(request, resolveInput, readInput)));
    const accepted = results[0]!;
    expect(new Set(results.map(item => item.session.id))).toEqual(new Set([request.clientSessionId]));
    expect(new Set(results.map(item => item.run.id)).size).toBe(1);
    expect(store.listProjects()).toHaveLength(1);
    expect(store.listSessions()).toHaveLength(1);
    expect(store.listRuns(accepted.session.id)).toHaveLength(1);
    expect(accepted.project.system).toBe('task-workspace');
    expect(basename(accepted.project.cwd)).toMatch(/^整理-中文资料-[a-f0-9]{8}$/);
    expect(resolveInput).toHaveBeenCalledTimes(1);
    await writeFile(join(accepted.project.cwd, 'report.md'), 'user files');
    saved.taskWorkspaceRoot = join(scratch, 'other-root');
    setNow(new Date('2026-11-04T12:00:00Z'));
    await rm(accepted.project.cwd, { recursive: true });
    resolveInput.mockRejectedValue(new Error('provider removed'));
    readInput.mockRejectedValue(new Error('attachment removed'));
    const validateSaved=vi.fn(async()=>{throw new Error('provider removed');});
    const replay = await workspaces.create(request, resolveInput, readInput, validateSaved);
    expect(replay.project.cwd).toBe(accepted.project.cwd);
    expect(replay.run.id).toBe(accepted.run.id);
    expect(resolveInput).toHaveBeenCalledTimes(1);
    expect(validateSaved).not.toHaveBeenCalled();
    await expect(assertTaskWorkspaceAvailable(replay.project)).rejects.toMatchObject({ code: 'TASK_WORKSPACE_UNAVAILABLE' });
    expect(await readdir(scratch)).not.toContain('other-root');
  });

  it('pins the ready directory and resolved configuration after database failure and restart', async () => {
    const { workspaces, service, store, saved, scratch, request, resolveInput, readInput } = await setup();
    const failed = vi.spyOn(store, 'createNativeSubmission').mockImplementationOnce(() => { throw new Error('database unavailable'); });
    await expect(workspaces.create(request, resolveInput, readInput)).rejects.toThrow('database unavailable');
    expect(store.listProjects()).toHaveLength(0);
    expect(store.listSessions()).toHaveLength(0);
    const reserved = store.getSetting<{ state: string; project: Project }>(`task-workspace-creation:${request.clientSessionId}`, undefined!);
    expect(reserved.state).toBe('ready');
    expect(await readFile(join(reserved.project.cwd, TASK_WORKSPACE_MARKER), 'utf8')).toContain(reserved.project.id);
    failed.mockRestore();
    saved.taskWorkspaceRoot = join(scratch, 'changed');
    resolveInput.mockRejectedValue(new Error('should use saved config'));
    const validateSaved=vi.fn(async()=>{throw new Error('saved provider removed');});
    await expect(service().create(request,resolveInput,readInput,validateSaved)).rejects.toThrow('saved provider removed');
    expect(store.listSessions()).toHaveLength(0);
    const accepted = await service().create(request, resolveInput, readInput);
    expect(accepted.project.cwd).toBe(reserved.project.cwd);
    expect(accepted.session.model).toBe('model-1');
    expect(store.listProjects()).toHaveLength(1);
    expect(store.listRuns(accepted.session.id)).toHaveLength(1);
  });

  it('rejects changed input under a reserved creation ID and leaves existing task files alone', async () => {
    const { workspaces, store, request, resolveInput, readInput } = await setup();
    const accepted = await workspaces.create(request, resolveInput, readInput);
    await writeFile(join(accepted.project.cwd, 'important.txt'), 'keep');
    await expect(workspaces.create({ ...request, requestDigest: 'changed' }, resolveInput, readInput)).rejects.toMatchObject({ code: 'SESSION_ID_CONFLICT' });
    expect(await readFile(join(accepted.project.cwd, 'important.txt'), 'utf8')).toBe('keep');
    expect(store.listRuns(accepted.session.id)).toHaveLength(1);
  });

  it('recovers a marker written before the ready receipt without allocating another directory', async () => {
    const {workspaces,service,store,request,resolveInput,readInput}=await setup();
    const setSetting=store.setSetting.bind(store);
    const failed=vi.spyOn(store,'setSetting').mockImplementation((key,value)=>{
      if(key===`task-workspace-creation:${request.clientSessionId}`&&(value as {state?:string}).state==='ready')throw new Error('interrupted ready receipt');
      return setSetting(key,value);
    });
    await expect(workspaces.create(request,resolveInput,readInput)).rejects.toMatchObject({code:'TASK_WORKSPACE_UNAVAILABLE'});
    const reserved=store.getSetting<{state:string;project:Project}>(`task-workspace-creation:${request.clientSessionId}`,undefined!);
    expect(reserved.state).toBe('reserved');
    expect(await readdir(reserved.project.cwd)).toEqual([TASK_WORKSPACE_MARKER]);
    expect(store.listProjects()).toHaveLength(0);
    failed.mockRestore();
    const accepted=await service().create(request,resolveInput,readInput);
    expect(accepted.project.cwd).toBe(reserved.project.cwd);
    expect(resolveInput).toHaveBeenCalledTimes(1);
    expect(store.listRuns(accepted.session.id)).toHaveLength(1);
  });

  it('does not allocate before validation and gives independent tasks different directories', async () => {
    const { workspaces, store, saved, request, resolveInput, readInput } = await setup();
    expect((await workspaces.location()).available).toBe(true);
    await expect(readdir(saved.taskWorkspaceRoot!)).rejects.toMatchObject({ code: 'ENOENT' });
    readInput.mockRejectedValueOnce(new Error('missing attachment'));
    await expect(workspaces.create(request, resolveInput, readInput)).rejects.toThrow('missing attachment');
    expect(store.listProjects()).toHaveLength(0);
    await expect(readdir(saved.taskWorkspaceRoot!)).rejects.toMatchObject({ code: 'ENOENT' });
    const first = await workspaces.create(request, resolveInput, readInput);
    const second = await workspaces.create({ ...request, clientSessionId: 'creation-2', commandId: 'message-2' }, resolveInput, readInput);
    expect(first.project.cwd).not.toBe(second.project.cwd);
    await writeFile(join(first.project.cwd, 'only-first.txt'), 'first');
    expect(await readdir(second.project.cwd)).toEqual([TASK_WORKSPACE_MARKER]);
  });

  it('extends a collided candidate and refuses a ready directory with a replaced identity', async () => {
    const { workspaces, store, saved, request, resolveInput, readInput } = await setup();
    const date = (() => { const now = new Date('2026-11-03T12:00:00Z'); return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; })();
    const suffix = createHash('sha256').update(request.clientSessionId).digest('hex');
    const collision = join(saved.taskWorkspaceRoot!, date, `整理-中文资料-${suffix.slice(0, 8)}`);
    await mkdir(collision, { recursive: true });
    await writeFile(join(collision, 'owned.txt'), 'existing');
    vi.spyOn(store, 'createNativeSubmission').mockImplementationOnce(() => { throw new Error('crash before commit'); });
    await expect(workspaces.create(request, resolveInput, readInput)).rejects.toThrow('crash before commit');
    const reserved = store.getSetting<{ project: Project }>(`task-workspace-creation:${request.clientSessionId}`, undefined!);
    expect(reserved.project.cwd).toBe(join(saved.taskWorkspaceRoot!, date, `整理-中文资料-${suffix.slice(0, 12)}`));
    expect(await readFile(join(collision, 'owned.txt'), 'utf8')).toBe('existing');
    await writeFile(join(reserved.project.cwd, TASK_WORKSPACE_MARKER), JSON.stringify({ version: 1, projectId: 'another-project', creationId: request.clientSessionId }));
    await expect(workspaces.create(request, resolveInput, readInput)).rejects.toMatchObject({ code: 'TASK_WORKSPACE_CONFLICT' });
    expect(store.listSessions()).toHaveLength(0);
  });

  it('rejects private roots and symlink replacement without recreating a missing task', async () => {
    const { workspaces, scratch, stateDir, request, resolveInput, readInput } = await setup();
    await expect(workspaces.validateRoot(join(stateDir, 'tasks'))).rejects.toMatchObject({ code: 'INVALID_TASK_WORKSPACE_ROOT' });
    const link = join(scratch, 'state-link');
    await symlink(stateDir, link);
    await expect(workspaces.validateRoot(join(link, 'tasks'))).rejects.toMatchObject({ code: 'INVALID_TASK_WORKSPACE_ROOT' });
    await expect(workspaces.validateRoot('relative/tasks')).rejects.toMatchObject({ code: 'INVALID_TASK_WORKSPACE_ROOT' });
    const accepted = await workspaces.create(request, resolveInput, readInput);
    const elsewhere = join(scratch, 'replacement');
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, TASK_WORKSPACE_MARKER), await readFile(join(accepted.project.cwd, TASK_WORKSPACE_MARKER)));
    await rm(accepted.project.cwd, { recursive: true });
    await symlink(elsewhere, accepted.project.cwd);
    await expect(assertTaskWorkspaceAvailable(accepted.project)).rejects.toMatchObject({ code: 'TASK_WORKSPACE_UNAVAILABLE' });
    await rm(accepted.project.cwd);
    await expect(assertTaskWorkspaceAvailable(accepted.project)).rejects.toMatchObject({ code: 'TASK_WORKSPACE_UNAVAILABLE' });
    await expect(readdir(accepted.project.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects configured provider credentials and aliases before creating a task root', async () => {
    const { scratch, stateDir, store, saved } = await setup();
    const credentials = join(scratch, 'custom-agent');
    await mkdir(credentials);
    const alias = join(scratch, 'agent-alias');
    await symlink(credentials, alias);
    const workspaces = new TaskWorkspaceService({ store, settings: { getSettings: () => saved } as SettingsService, stateDir, deniedRoots: () => [credentials] });
    await expect(workspaces.validateRoot(join(credentials, 'tasks'))).rejects.toMatchObject({ code: 'INVALID_TASK_WORKSPACE_ROOT' });
    await expect(workspaces.validateRoot(join(alias, 'tasks'))).rejects.toMatchObject({ code: 'INVALID_TASK_WORKSPACE_ROOT' });
    await expect(readdir(join(credentials, 'tasks'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a special identity file without waiting for a FIFO writer', async () => {
    const { workspaces, request, resolveInput, readInput } = await setup();
    const accepted = await workspaces.create(request, resolveInput, readInput);
    const marker = join(accepted.project.cwd, TASK_WORKSPACE_MARKER);
    await rm(marker);
    execFileSync('mkfifo', [marker]);
    await expect(assertTaskWorkspaceAvailable(accepted.project)).rejects.toMatchObject({ code: 'TASK_WORKSPACE_UNAVAILABLE' });
  });

  it('saves as a project without changing identities or files and replays old creation receipts', async () => {
    const { workspaces, store, request, resolveInput, readInput } = await setup();
    const accepted = await workspaces.create(request, resolveInput, readInput);
    const session = store.updateSession(accepted.session.id, { nativeSessionId: 'native-1' });
    await writeFile(join(accepted.project.cwd, 'result.md'), 'result');
    const promoted = store.promoteTaskWorkspace(accepted.project.id, 'Long-term project');
    expect(promoted.id).toBe(accepted.project.id);
    expect(promoted.cwd).toBe(accepted.project.cwd);
    expect(promoted.system).toBeUndefined();
    expect(store.getSession(session.id).nativeSessionId).toBe('native-1');
    expect(await readFile(join(promoted.cwd, 'result.md'), 'utf8')).toBe('result');
    expect(store.promoteTaskWorkspace(promoted.id, 'Long-term project')).toEqual(promoted);
    expect(() => store.promoteTaskWorkspace(promoted.id, 'Competing name')).toThrow(expect.objectContaining({ code: 'PROJECT_PROMOTION_CONFLICT' }));
    const renamed = store.updateProject(promoted.id, { name: 'Renamed later' });
    expect(store.promoteTaskWorkspace(promoted.id, 'Long-term project')).toEqual(renamed);
    const replay = await workspaces.create(request, resolveInput, readInput);
    expect(replay.project).toEqual(renamed);
    expect(replay.session.id).toBe(session.id);
    expect(replay.run.id).toBe(accepted.run.id);
    const ordinary = store.createProject('/ordinary', 'ordinary');
    expect(() => store.promoteTaskWorkspace(ordinary.id, 'name')).toThrow(expect.objectContaining({ code: 'INVALID_PROJECT_PROMOTION' }));
  });

  it('filters managed tasks before search limits and pending counts, then exposes them after promotion', async () => {
    const { workspaces, store, request, resolveInput, readInput }=await setup();
    const ordinary=store.createProject('/ordinary-search','ordinary');
    const visible=store.createNativeSubmission('visible-search',{projectId:ordinary.id,backendId:'codex',mode:'agent'},'visible-message',{text:'shared searchable text',attachmentIds:[],context:[]});
    const managed=await workspaces.create(request,resolveInput,async()=>({text:'shared searchable text',attachmentIds:[],context:[]}));
    expect(store.searchPrompts('%searchable%',1,undefined,undefined,true).map(hit=>hit.sessionId)).toEqual([visible.session.id]);
    expect(store.searchPrompts('%searchable%',1).map(hit=>hit.sessionId)).toEqual([managed.session.id]);
    expect(store.countSessionsMissingMessages(['codex'],undefined,true)).toBe(1);
    expect(store.sessionsMissingMessages(['codex'],1,undefined,true).map(session=>session.id)).toEqual([visible.session.id]);
    store.indexMessages([
      {sessionId:visible.session.id,messageId:'visible-answer',kind:'assistant',text:'searchable answer',at:'2026-11-03T12:00:00Z'},
      {sessionId:managed.session.id,messageId:'hidden-answer',kind:'assistant',text:'searchable answer',at:'2026-11-04T12:00:00Z'},
    ]);
    expect(store.searchIndexedMessages('%searchable%',1,undefined,undefined,true).map(hit=>hit.sessionId)).toEqual([visible.session.id]);
    store.promoteTaskWorkspace(managed.project.id,'searchable project');
    expect(store.searchPrompts('%searchable%',1,undefined,undefined,true).map(hit=>hit.sessionId)).toEqual([managed.session.id]);
    expect(store.searchIndexedMessages('%searchable%',1,undefined,undefined,true).map(hit=>hit.sessionId)).toEqual([managed.session.id]);
  });
});
