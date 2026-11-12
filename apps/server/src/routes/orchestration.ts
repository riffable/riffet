import type { FastifyInstance } from 'fastify';
import { AppError, requireString } from '../errors.js';
import { launchTarget, reviewComments } from '../orchestration/service.js';
import { backendVisibleToClient, defaultBackendForClient, projectVisibleToClient, requireProjectVisibleToClient, requireSessionVisibleToClient, sessionVisibleToClient, visibleLaunchTargetForClient } from '../native/client-features.js';
import type { Automation } from '../../../../packages/contracts/src/index.js';
import { savedDefaultBackendId } from '../session-identity.js';
import type { RouteDeps } from './deps.js';

type Body = Record<string, unknown>;
/** The idempotency keys of a launch: a retried request with the same pair returns what the first created. */
const ids=(body:Body)=>({sessionId:requireString(body.clientSessionId,'clientSessionId',100),commandId:requireString(body.commandId,'commandId',100)});
const optionalText=(value:unknown,name:string,max:number)=>value===undefined||value===null||value===''?undefined:requireString(value,name,max);
const mergeOptions=(body:Body)=>{
  if(body.strategy!==undefined&&body.strategy!=='merge'&&body.strategy!=='squash')throw new AppError('INVALID_MERGE_STRATEGY','Choose merge or squash');
  return {...(body.strategy?{strategy:body.strategy as 'merge'|'squash'}:{}),...(optionalText(body.message,'message',5_000)?{message:body.message as string}:{}),
    ...(optionalText(body.commitPending,'commitPending',5_000)?{commitPending:body.commitPending as string}:{}),removeWorktree:body.removeWorktree===true};
};

/** Review feedback, turn checkpoints, forks, handoffs, parallel attempts and automations (docs/ORCHESTRATION.md). */
export function registerOrchestrationRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const {store,git,settings,orchestration,readNativeInput,contextReferences,nativeBackends}=deps;
  const visibleTarget = (request: { headers: import('node:http').IncomingHttpHeaders }, target: { backendId?: string }) => backendVisibleToClient(request.headers, target.backendId);
  const visibleGroup = <T extends { attempts: Array<{ target: { backendId?: string } }> }>(request: { headers: import('node:http').IncomingHttpHeaders }, group: T): T =>
    ({ ...group, attempts: group.attempts.filter(attempt => visibleTarget(request, attempt.target)) });
  const fallbackTarget = (request: { headers: import('node:http').IncomingHttpHeaders }) => defaultBackendForClient(request.headers, savedDefaultBackendId(settings.getSettings()), deps.nativeBackends.offeredBackendIds());
  app.post<{Params:{id:string};Body:Body}>('/api/sessions/:id/review',async(request,reply)=>{
    const body=request.body??{};
    reply.code(202);return orchestration.review(request.params.id,requireString(body.commandId,'commandId',100),reviewComments(body.comments),optionalText(body.note,'note',5_000));
  });
  /** The checkpoints taken before each of this conversation's turns, newest first; restore one through the project checkpoint routes. */
  app.get<{Params:{id:string}}>('/api/sessions/:id/checkpoints',async(request)=>{
    const session=store.getSession(request.params.id);
    return (await git.checkpoints(store.getProject(session.projectId))).filter(item=>item.sessionId===session.id&&item.runId);
  });
  app.post<{Params:{id:string};Body:Body}>('/api/sessions/:id/fork',async(request,reply)=>{
    const body=request.body??{};
    reply.code(202);
    // A target that names no backend falls back here, before the service reads the saved default.
    const requested=body.target===undefined?undefined:visibleLaunchTargetForClient(request.headers,launchTarget(body.target));
    const target=requested?{...requested,backendId:requested.backendId??fallbackTarget(request)}:undefined;
    return orchestration.fork(request.params.id,{...ids(body),...(optionalText(body.runId,'runId',100)?{runId:body.runId as string}:{}),
      ...(target?{target}:{}),isolate:body.isolate===true,...(optionalText(body.note,'note',20_000)?{note:body.note as string}:{})});
  });
  /** Can take a model's full answer; a reader who closes the dialog stops it. */
  app.post<{Params:{id:string};Body:Body}>('/api/sessions/:id/handoff/draft',async(request,reply)=>{
    const body=request.body??{};
    const target=visibleLaunchTargetForClient(request.headers,launchTarget(body.target)),goal=optionalText(body.goal,'goal',20_000);
    const controller=new AbortController();
    const close=()=>controller.abort();
    reply.raw.once('close',close);
    try{return await orchestration.handoffDraft(request.params.id,{target,...(goal?{goal}:{}),signal:controller.signal});}
    finally{reply.raw.off('close',close);}
  });
  app.post<{Params:{id:string};Body:Body}>('/api/sessions/:id/handoff',async(request,reply)=>{
    const body=request.body??{};
    reply.code(202);
    return orchestration.handoff(request.params.id,{...ids(body),target:visibleLaunchTargetForClient(request.headers,launchTarget(body.target)),...(optionalText(body.note,'note',20_000)?{note:body.note as string}:{}),
      ...(optionalText(body.text,'text',200_000)?{text:body.text as string}:{})});
  });

  app.get<{Params:{id:string}}>('/api/projects/:id/attempts',async(request)=>{
    store.getProject(request.params.id);
    return orchestration.attemptGroups(request.params.id).map(group=>visibleGroup(request,group)).filter(group=>group.attempts.length);
  });
  app.post<{Params:{id:string};Body:Body}>('/api/projects/:id/attempts',async(request,reply)=>{
    const body=request.body??{};
    if(!Array.isArray(body.targets))throw new AppError('INVALID_ATTEMPTS','Choose the backends to run');
    reply.code(202);
    // An old client reads an unset target through its own enum, so the saved default falls back here
    // before the orchestration service resolves it without request headers.
    const targets=body.targets.map(launchTarget).map(target=>visibleLaunchTargetForClient(request.headers,target)).map(target=>({...target,backendId:target.backendId??fallbackTarget(request)}));
    // The prompt arrives as a full composer input, so attachments and file references ride along.
    const runInput=await readNativeInput({text:body.prompt as string,attachments:body.attachments as Array<{id:string}>|undefined,context:body.context as Array<{path:string;line?:number}>|undefined});
    const created=await orchestration.createAttempts(request.params.id,{prompt:runInput.text,targets,runInput,
      ...(optionalText(body.base,'base',255)?{base:body.base as string}:{}),...(optionalText(body.requestId,'requestId',100)?{requestId:body.requestId as string}:{})});
    return {...created,group:visibleGroup(request,created.group)};
  });
  app.get<{Params:{id:string}}>('/api/attempts/:id',async(request)=>{
    const compared=await orchestration.compareAttempts(request.params.id);
    const group=visibleGroup(request,compared.group);
    if(!group.attempts.length)throw new AppError('ATTEMPT_GROUP_NOT_FOUND','Attempt group does not exist',404);
    return {...compared,group,attempts:compared.attempts.filter(attempt=>visibleTarget(request,attempt.target))};
  });
  app.post<{Params:{id:string};Body:Body}>('/api/attempts/:id/attempts',async(request,reply)=>{
    const body=request.body??{};
    reply.code(202);
    const target=visibleLaunchTargetForClient(request.headers,launchTarget(body.target));
    const created=await orchestration.addAttempt(request.params.id,{...target,backendId:target.backendId??fallbackTarget(request)});
    return {...created,group:visibleGroup(request,created.group)};
  });
  app.post<{Params:{id:string};Body:Body}>('/api/attempts/:id/discard',async(request)=>{
    const body=request.body??{};
    requireSessionVisibleToClient(request.headers,store.getSession(requireString(body.sessionId,'sessionId',100)));
    return orchestration.discardAttempt(request.params.id,requireString(body.sessionId,'sessionId',100),{removeWorktree:body.removeWorktree===true});
  });
  app.post<{Params:{id:string};Body:Body}>('/api/attempts/:id/adopt',async(request)=>{
    const body=request.body??{};
    if(body.cleanup!==undefined&&body.cleanup!=='keep'&&body.cleanup!=='archive'&&body.cleanup!=='remove')throw new AppError('INVALID_CLEANUP','Choose what happens to the other attempts');
    requireSessionVisibleToClient(request.headers,store.getSession(requireString(body.sessionId,'sessionId',100)));
    return orchestration.adoptAttempt(request.params.id,requireString(body.sessionId,'sessionId',100),{...mergeOptions(body),...(body.cleanup?{cleanup:body.cleanup as 'keep'|'archive'|'remove'}:{})});
  });

  /*
   * Automations. An old client cannot decode a hidden backend, a hidden project or the conversation
   * of a hidden backend: those are filtered or replaced here, the way the template and schedule
   * routes did.
   */
  type Headers = { headers: import('node:http').IncomingHttpHeaders };
  const projectOf = (id: string | undefined) => { if (!id) return undefined; try { return store.getProject(id); } catch { return undefined; } };
  /** A project that no longer exists is not a reason to hide the automation or fail the list. */
  const automationVisible = (request: Headers, item: Automation): boolean => {
    if (!visibleTarget(request, item)) return false;
    const project = projectOf(item.projectId);
    if (project && !projectVisibleToClient(request.headers, project)) return false;
    if (item.followUp) { try { return sessionVisibleToClient(request.headers, store.getSession(item.followUp.sessionId), id => store.getProject(id)); } catch { return false; } }
    return true;
  };
  /** A hidden conversation id is dropped; the automation and its history stay. */
  const withoutHiddenSession = <T extends { lastSessionId?: string; sessionId?: string }>(request: Headers, item: T): T => {
    const id = item.lastSessionId ?? item.sessionId;
    if (!id) return item;
    try { if (sessionVisibleToClient(request.headers, store.getSession(id), project => store.getProject(project))) return item; } catch { return item; }
    const { lastSessionId: _last, sessionId: _session, ...rest } = item;
    return rest as T;
  };
  const visibleAutomation = (request: Headers, id: string): Automation => {
    const item = orchestration.automation(id);
    if (!visibleTarget(request, item)) throw new AppError('INVALID_BACKEND', 'Choose a supported native backend');
    if (!automationVisible(request, item)) throw new AppError('AUTOMATION_NOT_FOUND', 'Automation does not exist', 404);
    return item;
  };
  const checkBody = (request: Headers, body: Body) => {
    if (body.target !== undefined) visibleLaunchTargetForClient(request.headers, launchTarget(body.target));
    if (typeof body.projectId === 'string' && body.projectId) requireProjectVisibleToClient(request.headers, store.getProject(body.projectId));
    if (body.followUp !== undefined) {
      const followUp = (body.followUp && typeof body.followUp === 'object' ? body.followUp : {}) as Body;
      requireSessionVisibleToClient(request.headers, store.getSession(requireString(followUp.sessionId, 'sessionId', 100)), id => store.getProject(id));
    }
  };
  app.get('/api/automations', async request => orchestration.automations().filter(item => !item.followUp || (item.enabled && item.nextRunAt)).filter(item => automationVisible(request, item)).map(item => withoutHiddenSession(request, item)));
  // The REST caller is the user: a follow-up made here is `by: 'user'` whatever the body says.
  app.post<{ Body: Body }>('/api/automations', async request => {
    const body = request.body ?? {};
    checkBody(request, body);
    if (body.followUp === undefined || (body.id === undefined && body.attachments === undefined && body.context === undefined && body.references === undefined)) return withoutHiddenSession(request, orchestration.saveAutomation(undefined, body));
    // A user's follow-up carries the composer's whole input; its session references are captured now, as a queued message's are.
    const sessionId = requireString((body.followUp as Body).sessionId, 'sessionId', 100);
    const input = await readNativeInput({ text: body.prompt as string, attachments: body.attachments as Array<{ id: string }> | undefined, context: body.context as Array<{ path: string; line?: number }> | undefined, references: body.references as never });
    if (body.id !== undefined && !(typeof body.id === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(body.id))) throw new AppError('INVALID_INPUT', 'id must be a client-made UUID');
    // A retry of a request that was accepted returns that follow-up without capturing the references again.
    const replay = typeof body.id === 'string' ? orchestration.existingFollowUp(body.id, body, input) : undefined;
    if (replay) return withoutHiddenSession(request, replay);
    contextReferences.requireFeature(request.headers, input);
    if (input.references?.length) await nativeBackends.assertSessionReferences(store.getSession(sessionId));
    const prepared = await contextReferences.prepare(sessionId, input, request.headers);
    const created = contextReferences.commit(sessionId, prepared, snapshots => {
      contextReferences.validateSources(sessionId, input, request.headers);
      return orchestration.saveAutomation(undefined, body, {}, { input, snapshots });
    });
    return withoutHiddenSession(request, created);
  });
  app.patch<{ Params: { id: string }; Body: Body }>('/api/automations/:id', async request => {
    const body = request.body ?? {};
    visibleAutomation(request, request.params.id);
    checkBody(request, body);
    return withoutHiddenSession(request, orchestration.saveAutomation(request.params.id, body));
  });
  app.delete<{ Params: { id: string } }>('/api/automations/:id', async (request, reply) => { visibleAutomation(request, request.params.id); orchestration.deleteAutomation(request.params.id); reply.code(204); });
  /** Runs one now, under the same skip-while-busy rule as its timer; the next timed run is unchanged. */
  app.post<{ Params: { id: string }; Body: Body }>('/api/automations/:id/run', async (request, reply) => {
    const body = request.body ?? {};
    const item = visibleAutomation(request, request.params.id);
    const projectId = optionalText(body.projectId, 'projectId', 100);
    if (projectId) requireProjectVisibleToClient(request.headers, store.getProject(projectId));
    // An unset backend would resolve the saved default inside the service; an old client gets the compatible default instead of a conversation it cannot decode.
    const target = !item.followUp && item.backendId === undefined ? { backendId: fallbackTarget(request) } : undefined;
    const sessionId = optionalText(body.clientSessionId, 'clientSessionId', 100), commandId = optionalText(body.commandId, 'commandId', 100);
    reply.code(202);
    return withoutHiddenSession(request, await orchestration.fire(item.id, {
      cause: 'manual', ...(projectId ? { projectId } : {}), ...(target ? { target } : {}),
      ids: { ...(sessionId ? { sessionId } : {}), ...(commandId ? { commandId } : {}) },
    }));
  });
  app.get<{ Params: { id: string } }>('/api/automations/:id/runs', async request => {
    visibleAutomation(request, request.params.id);
    return orchestration.runs(request.params.id).map(run => withoutHiddenSession(request, run));
  });
  app.get<{ Querystring: { limit?: string } }>('/api/automation-runs', async request => {
    const visible = orchestration.automations().filter(item => automationVisible(request, item)).map(item => item.id);
    return orchestration.runs(undefined, Number(request.query.limit) || 100, visible).map(run => withoutHiddenSession(request, run));
  });
}
