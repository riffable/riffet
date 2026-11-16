import type { FastifyInstance } from 'fastify';
import { AppError, requireString } from '../errors.js';
import { AUXILIARY_MODEL_BACKENDS } from '../auxiliary/gateway.js';
import { auxiliaryEndpoint, listAuxiliaryModels } from '../auxiliary/models.js';
import { requestHandoffSummary } from '../orchestration/handoff-summary.js';
import { createBackup } from '../system.js';
import { machineReport } from '../doctor.js';
import { isNativeBackendId } from '../backends/registry.js';
import { LEGACY_DEFAULT_BACKEND_ID } from '../session-identity.js';
import { backendVisibleToClient, preserveInvisibleSettingsForClient, requireBackendVisibleToClient, visibleBackendsForClient } from '../native/client-features.js';
import type { NativeBackendId } from '../../../../packages/contracts/src/index.js';
import type { RouteDeps } from './deps.js';

export function registerSettingsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const {stateDir,store,settings,nativeBackends,titles,effectiveSettings,monitor}=deps;
  // These endpoints belong to the backend that had them first and keep their paths; each is a forward to its driver.
  const first=LEGACY_DEFAULT_BACKEND_ID;
  app.get('/api/cursor/capabilities',async()=>nativeBackends.admin.capabilityReport(first));
  app.get('/api/native/runtime/stats',async()=>nativeBackends.admin.runtimeStats(first));
  app.get('/api/cursor/models',async()=>{
    try{return await nativeBackends.catalog.driverModels(first,process.cwd());}
    catch(error){
      // Whatever the CLI said, this endpoint has always answered in two wordings: the cause known (`details.reason`) or not.
      if(error instanceof AppError&&error.code==='MODEL_CATALOG_UNAVAILABLE')throw new AppError('MODEL_CATALOG_UNAVAILABLE',error.details?'The CLI model catalog could not be read; check the CLI and try again shortly':'The CLI model catalog is unavailable; try again shortly',503);
      throw error;
    }
  });
  app.post<{Body:{operation:string;args?:string[];projectId?:string}}>('/api/cursor/command',async(request)=>{
    const cwd=request.body?.projectId?store.getProject(request.body.projectId).cwd:undefined;
    return nativeBackends.admin.runCommand(first,{operation:requireString(request.body?.operation,'operation',100),args:request.body.args??[],...(cwd?{cwd}:{})});
  });
  app.get<{Params:{id:string}}>('/api/projects/:id/configs',async(request)=>nativeBackends.admin.projectConfigs(store.getProject(request.params.id)));
  app.post<{Params:{id:string};Body:{kind:'rules'|'skills'|'commands';path:string;content:string}}>('/api/projects/:id/configs',async(request)=>nativeBackends.admin.createProjectConfig(store.getProject(request.params.id),request.body));
  app.get<{Params:{id:string;configId:string}}>('/api/projects/:id/configs/:configId',async(request)=>nativeBackends.admin.readProjectConfig(store.getProject(request.params.id),request.params.configId));
  app.put<{Params:{id:string;configId:string};Body:{content:string;expectedHash:string}}>('/api/projects/:id/configs/:configId',async(request)=>nativeBackends.admin.writeProjectConfig(store.getProject(request.params.id),request.params.configId,request.body.content,request.body.expectedHash));
  app.get('/api/settings',async(request)=>effectiveSettings(request.headers));
  app.get('/api/task-workspaces/location',async()=>deps.taskWorkspaces.location());
  app.patch<{Body:Record<string,unknown>}>('/api/settings',async(request)=>{
    // Validate what this client can see; hidden settings it did not send stay as they were and are
    // not re-validated against a backend the client cannot name.
    const stored=settings.getSettings();
    const patch=request.body??{};
    const body=preserveInvisibleSettingsForClient(request.headers,stored,patch,nativeBackends.offeredBackendIds());
    if(Object.prototype.hasOwnProperty.call(patch,'taskWorkspaceRoot'))body.taskWorkspaceRoot=(await deps.taskWorkspaces.validateRoot(patch.taskWorkspaceRoot))??null;
    const rawDefaults=patch.nativeBackendDefaults;
    // A backend that is off (its plugin) has no capabilities to check a value against. A client saves the whole
    // record, so its entry for that backend, when it is the stored one, passes as it is; changing it still fails.
    const offered=new Set<string>(nativeBackends.offeredBackendIds());
    const sameEntry=(left:unknown,right:unknown)=>JSON.stringify(Object.entries((left??{}) as object).sort())===JSON.stringify(Object.entries((right??{}) as object).sort());
    if(rawDefaults!==undefined&&rawDefaults&&typeof rawDefaults==='object'&&!Array.isArray(rawDefaults)){
      for(const [rawBackend,raw] of Object.entries(rawDefaults as Record<string,unknown>)){
        if(!isNativeBackendId(rawBackend)||rawBackend==='chat'||!raw||typeof raw!=='object'||Array.isArray(raw))continue;
        const backendId=rawBackend,values=raw as Record<string,unknown>;
        if(!offered.has(backendId)&&sameEntry(values,stored.nativeBackendDefaults?.[backendId]))continue;
        const requestedProfile=values.profileId===undefined?stored.nativeBackendDefaults?.[backendId]?.profileId:requireString(values.profileId,'profileId',200);
        const profile=nativeBackends.catalog.validateProfile(backendId,requestedProfile);
        const capabilities=await nativeBackends.catalog.capabilitiesFor(backendId,profile.id);
        if(values.model!==undefined){
          requireString(values.model,'model',200);
          if(!capabilities.supportsModelSelection)throw new AppError('NATIVE_MODEL_UNSUPPORTED',`${backendId} does not support model selection`);
        }
        if(values.mode!==undefined){
          const mode=requireString(values.mode,'mode',100);
          if(capabilities.supportsModeSelection?!capabilities.modes.some(item=>item.id===mode):mode!=='agent')throw new AppError('INVALID_MODE',`Choose a mode supported by ${backendId}`);
        }
        if(values.approval!==undefined){
          const approval=requireString(values.approval,'approval',100);
          if(!capabilities.supportsPermissionSelection||!capabilities.permissions.some(item=>item.id===approval))throw new AppError('INVALID_APPROVAL_MODE',`Choose a permission setting supported by ${backendId}`);
        }
      }
    }
    // The legacy top-level `defaultMode` is the legacy default backend's own default (`legacyDefaults`); a per-backend one sent with it wins and is validated above.
    const legacyBackend=LEGACY_DEFAULT_BACKEND_ID;
    if(body.defaultMode!==undefined&&!(rawDefaults&&typeof rawDefaults==='object'&&!Array.isArray(rawDefaults)&&(rawDefaults as Record<string,unknown>)[legacyBackend]&&typeof (rawDefaults as Record<string,Record<string,unknown>>)[legacyBackend]!.mode==='string')&&!(!offered.has(legacyBackend)&&body.defaultMode===stored.defaultMode)){
      const mode=requireString(body.defaultMode,'defaultMode',100),capabilities=await nativeBackends.catalog.capabilitiesFor(legacyBackend,settings.getSettings().nativeBackendDefaults?.[legacyBackend]?.profileId);
      if(!capabilities.supportsModeSelection||!capabilities.modes.some(item=>item.id===mode))throw new AppError('INVALID_MODE',`Choose a mode supported by ${legacyBackend}`);
    }
    const auxiliary=body.auxiliaryModels&&typeof body.auxiliaryModels==='object'&&!Array.isArray(body.auxiliaryModels)?body.auxiliaryModels as Record<string,unknown>:{};
    for(const [purpose,raw] of Object.entries(auxiliary)){
      const ref=raw as Record<string,unknown>|null;
      if(ref&&typeof ref==='object'&&!Array.isArray(ref)&&AUXILIARY_MODEL_BACKENDS.includes(ref.backendId as NativeBackendId)&&!nativeBackends.catalog.gatewayProfiles(ref.backendId as NativeBackendId).some(profile=>profile.id===ref.profileId))
        throw new AppError('INVALID_SETTINGS',`auxiliaryModels.${purpose}.profileId must name a provider with a gateway address`);
    }
    settings.setSettings(body);
    if(auxiliary.title)void titles.backfill().catch(()=>undefined);
    return effectiveSettings(request.headers);
  });
  app.get('/api/auxiliary-models',async(request)=>({models:visibleBackendsForClient(request.headers,await listAuxiliaryModels(backendId=>nativeBackends.catalog.gatewayProfiles(backendId)))}));
  /** Tries the same writing rules as the real job, without saving a setting or creating a session. */
  app.post<{Body:{purpose?:unknown;backendId?:unknown;profileId?:unknown;model?:unknown;message?:unknown}}>('/api/auxiliary-models/preview',async(request,reply)=>{
    const body=request.body??{};
    const purpose=requireString(body.purpose,'purpose',20);
    if(purpose!=='title'&&purpose!=='handoff')throw new AppError('INVALID_INPUT','purpose must be title or handoff');
    const backendId=requireString(body.backendId,'backendId',20);
    requireBackendVisibleToClient(request.headers,backendId);
    if(!isNativeBackendId(backendId)||!AUXILIARY_MODEL_BACKENDS.includes(backendId))throw new AppError('INVALID_BACKEND','This backend cannot run auxiliary models');
    const ref={backendId,profileId:requireString(body.profileId,'profileId',200),model:requireString(body.model,'model',200)};
    const message=requireString(body.message,'message',purpose==='title'?2_000:150_000).trim();
    const controller=new AbortController();
    const close=()=>controller.abort();
    reply.raw.once('close',close);
    try{
      if(purpose==='title')return {text:await titles.preview(ref,message,controller.signal)};
      const {profileName:_name,...endpoint}=await auxiliaryEndpoint(ref,id=>nativeBackends.catalog.gatewayProfiles(id),controller.signal);
      return {text:await requestHandoffSummary(endpoint,message,{signal:controller.signal})};
    }catch(error){
      const message=error instanceof Error?error.message:'The auxiliary model returned no result';
      throw new AppError('AUXILIARY_MODEL_FAILED',message,400,undefined,{message});
    }finally{reply.raw.off('close',close);}
  });
  app.post<{Body:{backendId?:unknown;profileId?:unknown;model?:unknown;message?:unknown}}>('/api/auxiliary-models/title-preview',async(request)=>{
    const body=request.body??{};
    const backendId=requireString(body.backendId,'backendId',20);
    requireBackendVisibleToClient(request.headers,backendId);
    if(!isNativeBackendId(backendId)||!AUXILIARY_MODEL_BACKENDS.includes(backendId))throw new AppError('INVALID_BACKEND','This backend cannot write titles');
    const ref={backendId,profileId:requireString(body.profileId,'profileId',200),model:requireString(body.model,'model',200)};
    const message=body.message===undefined?'帮我看一下统计页面，现在 web 的样式不够简洁，废话太多':requireString(body.message,'message',2000);
    try{return {title:await titles.preview(ref,message)};}
    catch(error){const message=error instanceof Error?error.message:'The title model returned no title';throw new AppError('TITLE_MODEL_FAILED',message,400,undefined,{message});}
  });
  app.post('/api/system/backup',async()=>createBackup(store,stateDir));
  // A pane of a conversation the client cannot decode (a plugin Agent for a client without `plugin-agents`) is listed without it.
  app.get('/api/system/monitor',async(request)=>{
    const snapshot=await monitor.snapshot();
    return {...snapshot,processes:snapshot.processes.map(item=>{
      if(backendVisibleToClient(request.headers,item.backendId))return item;
      const {sessionId:_session,sessionTitle:_title,backendId:_backend,...rest}=item;
      return rest;
    })};
  });
  // tmux and Tailscale are the machine's, not an Agent's: this answers while any Agent plugin is off.
  app.get('/api/system/machine',async()=>machineReport());
  app.post<{Params:{pid:string}}>('/api/system/processes/:pid/terminate',async(request)=>{await monitor.terminate(request.params.pid);return {ok:true};});
}
