import type { FastifyInstance } from 'fastify';
import { AppError, requireString } from '../errors.js';
import { launchTarget, reviewComments } from '../orchestration/service.js';
import { backendVisibleToClient, defaultBackendForClient, projectVisibleToClient, requireProjectVisibleToClient, requireSessionVisibleToClient, sessionVisibleToClient, visibleLaunchTargetForClient } from '../native/client-features.js';
import type { NativeBackendId } from '../../../../packages/contracts/src/index.js';
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

/** Review feedback, turn checkpoints, forks, handoffs, parallel attempts, templates and schedules (docs/ORCHESTRATION.md). */
export function registerOrchestrationRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const {store,git,settings,orchestration,readNativeInput}=deps;
  const visibleTarget = (request: { headers: import('node:http').IncomingHttpHeaders }, target: { backendId?: string }) => backendVisibleToClient(request.headers, target.backendId);
  const visibleGroup = <T extends { attempts: Array<{ target: { backendId?: string } }> }>(request: { headers: import('node:http').IncomingHttpHeaders }, group: T): T =>
    ({ ...group, attempts: group.attempts.filter(attempt => visibleTarget(request, attempt.target)) });
  const fallbackTarget = (request: { headers: import('node:http').IncomingHttpHeaders }) => defaultBackendForClient(request.headers, savedDefaultBackendId(settings.getSettings()), deps.nativeBackends.offeredBackendIds());
  const templateForClient = (request: { headers: import('node:http').IncomingHttpHeaders }, id: string) => {
    const template = orchestration.templates().find(item => item.id === id);
    if (template && !visibleTarget(request, template)) throw new AppError('INVALID_BACKEND', 'Choose a supported native backend');
    return template;
  };
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

  app.get('/api/templates',async(request)=>orchestration.templates().filter(template=>visibleTarget(request,template)));
  app.post<{Body:Body}>('/api/templates',async(request)=>{
    const body=request.body??{};
    if(body.target!==undefined)visibleLaunchTargetForClient(request.headers,launchTarget(body.target));
    return orchestration.saveTemplate(undefined,body);
  });
  app.patch<{Params:{id:string};Body:Body}>('/api/templates/:id',async(request)=>{
    const body=request.body??{};
    templateForClient(request,request.params.id);
    if(body.target!==undefined)visibleLaunchTargetForClient(request.headers,launchTarget(body.target));
    return orchestration.saveTemplate(request.params.id,body);
  });
  app.delete<{Params:{id:string}}>('/api/templates/:id',async(request,reply)=>{templateForClient(request,request.params.id);orchestration.deleteTemplate(request.params.id);reply.code(204);});
  app.post<{Params:{id:string};Body:Body}>('/api/templates/:id/run',async(request,reply)=>{
    const body=request.body??{};
    const template=templateForClient(request,request.params.id);
    // An unset template target would resolve the saved default inside the service; an old client
    // gets the compatible default instead of a conversation it cannot decode.
    const target=template&&template.backendId===undefined?{backendId:fallbackTarget(request)}:undefined;
    reply.code(202);return orchestration.runTemplate(request.params.id,requireString(body.projectId,'projectId',100),ids(body),undefined,target);
  });

  const scheduleForClient=(request:{headers:import('node:http').IncomingHttpHeaders},id:string)=>{
    const schedule=orchestration.schedules().find(item=>item.id===id);
    if(schedule){requireProjectVisibleToClient(request.headers,store.getProject(schedule.projectId));templateForClient(request,schedule.templateId);}
    return schedule;
  };
  /** A schedule keeps its visible template and history; a hidden conversation id is dropped. */
  const withoutHiddenScheduleSession=<T extends {lastSessionId?:string}>(request:{headers:import('node:http').IncomingHttpHeaders},schedule:T):T=>{
    if(!schedule.lastSessionId)return schedule;
    try{if(sessionVisibleToClient(request.headers,store.getSession(schedule.lastSessionId),id=>store.getProject(id)))return schedule;}catch{return schedule;}
    const {lastSessionId:_hidden,...rest}=schedule;
    return rest as T;
  };
  app.get('/api/schedules',async(request)=>orchestration.schedules()
    .filter(schedule=>projectVisibleToClient(request.headers,store.getProject(schedule.projectId)))
    .filter(schedule=>visibleTarget(request,orchestration.templates().find(template=>template.id===schedule.templateId)??{}))
    .map(schedule=>withoutHiddenScheduleSession(request,schedule)));
  app.post<{Body:Body}>('/api/schedules',async(request)=>{
    const body=request.body??{};
    templateForClient(request,requireString(body.templateId,'templateId',100));
    return orchestration.saveSchedule(undefined,body);
  });
  app.patch<{Params:{id:string};Body:Body}>('/api/schedules/:id',async(request)=>{
    scheduleForClient(request,request.params.id);
    const body=request.body??{};
    if(body.templateId!==undefined)templateForClient(request,requireString(body.templateId,'templateId',100));
    return withoutHiddenScheduleSession(request,orchestration.saveSchedule(request.params.id,body));
  });
  app.delete<{Params:{id:string}}>('/api/schedules/:id',async(request,reply)=>{scheduleForClient(request,request.params.id);orchestration.deleteSchedule(request.params.id);reply.code(204);});
  /** Runs a schedule now, under the same skip-while-busy rule as its timer; the next timed run is unchanged. */
  app.post<{Params:{id:string}}>('/api/schedules/:id/run',async(request)=>{
    const schedule=scheduleForClient(request,request.params.id);
    // A new conversation from an unset template target must not resolve a hidden saved default.
    const template=schedule?orchestration.templates().find(item=>item.id===schedule.templateId):undefined;
    const target=template&&template.backendId===undefined?{backendId:fallbackTarget(request)}:undefined;
    return withoutHiddenScheduleSession(request,await orchestration.fire(request.params.id,target));
  });
}
