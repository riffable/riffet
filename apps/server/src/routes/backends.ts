import type { FastifyInstance } from 'fastify';
import { applyProcessEnvironment, currentEnvironmentReport, terminalEnvironment } from '../environment.js';
import { AppError, requireString } from '../errors.js';
import { isNativeBackendId } from '../backends/registry.js';
import type { NativeBackendProfileSettingsUpdate, NativeModelApiProtocol, NativeModelSource } from '../../../../packages/contracts/src/index.js';
import { loopHealth } from '../loop-health.js';
import { clientSupportsFeature, requireBackendVisibleToClient, requireProjectVisibleToClient, requireSessionVisibleToClient, visibleBackendsForClient } from '../native/client-features.js';
import type { RouteDeps } from './deps.js';

export function registerBackendRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const {stateDir,store,settings,nativeBackends}=deps;
  const queryContext = (request: { headers: import('node:http').IncomingHttpHeaders; params: { id: string }; query: { scope?: string; projectId?: string; sessionId?: string } }) => {
    const {scope, projectId, sessionId} = request.query;
    if (scope !== undefined && (scope !== 'global' || projectId !== undefined || sessionId !== undefined)) throw new AppError('INVALID_QUERY_SCOPE', 'Global queries cannot include a project or conversation');
    if (scope === 'global') {
      if (!clientSupportsFeature(request.headers, 'projectless-tasks')) throw new AppError('FEATURE_REQUIRED', 'Update the client to query global agent capabilities', 409);
      return { project: undefined, session: undefined };
    }
    const session=sessionId?store.getSession(requireString(sessionId,'sessionId',100)):undefined;
    requireSessionVisibleToClient(request.headers,session,id=>store.getProject(id));
    if(session&&session.backendId!==request.params.id)throw new AppError('NATIVE_BACKEND_MISMATCH','The conversation uses a different native backend',409);
    const project=store.getProject(session?.projectId??requireString(projectId,'projectId',100));
    requireProjectVisibleToClient(request.headers,project);
    return { project, session };
  };
  // Quick chat is not an agent to pick or configure; a client reaches it through its own project.
  app.get('/api/backends',async(request)=>visibleBackendsForClient(request.headers,(await nativeBackends.catalog.listBackends()).filter(entry=>entry.backendId!=='chat')));
  /**
   * Why a machine behaves the way it does: which PATH the daemon resolved and from where, which
   * variables were scrubbed, and the toolchain a terminal would inherit. `riffet doctor` prints the
   * same report locally, so a remote restart that cannot find a CLI is diagnosable from one URL.
   */
  app.get('/api/doctor',async(request)=>{
    const environment=currentEnvironmentReport()??await applyProcessEnvironment({stateDir});
    return {environment:{...environment,terminal:terminalEnvironment(environment)},backends:visibleBackendsForClient(request.headers,(await nativeBackends.catalog.listBackends()).filter(entry=>entry.backendId!=='chat')),eventLoop:loopHealth()};
  });
  app.get<{Params:{id:string};Querystring:{scope?:string;projectId?:string;profileId?:string;sessionId?:string;allModels?:string}}>('/api/backends/:id/catalog',async(request)=>{
    requireBackendVisibleToClient(request.headers,request.params.id);
    const {project,session}=queryContext(request);
    // The settings page curates the list and so needs every model the backend reports; pickers
    // get the curated subset.
    return nativeBackends.catalog.entry(request.params.id,project,session?.backendProfileId??request.query.profileId,session,{allModels:request.query.allModels==='1'});
  });
  app.get<{Params:{id:string};Querystring:{scope?:string;projectId?:string;profileId?:string;sessionId?:string}}>('/api/backends/:id/usage',async(request)=>{
    requireBackendVisibleToClient(request.headers,request.params.id);
    const {project,session}=queryContext(request);
    const usage=await nativeBackends.catalog.usage(request.params.id,project,session?.backendProfileId??request.query.profileId,session);
    return usage??{models:{},fetchedAt:new Date().toISOString()};
  });
  app.get<{Params:{id:string};Querystring:{scope?:string;projectId?:string;profileId?:string;sessionId?:string;refresh?:string}}>('/api/backends/:id/slash',async(request)=>{
    requireBackendVisibleToClient(request.headers,request.params.id);
    const {project,session}=queryContext(request);
    return nativeBackends.catalog.slashCatalog(request.params.id,project,session?.backendProfileId??request.query.profileId,session,{refresh:request.query.refresh==='1'});
  });
  app.get<{Params:{id:string}}>('/api/backends/:id/command-observation',async(request)=>{
    requireBackendVisibleToClient(request.headers,request.params.id);
    if(!isNativeBackendId(request.params.id))throw new AppError('INVALID_BACKEND','Choose a supported native backend');
    return nativeBackends.admin.commandObservation(request.params.id);
  });
  app.post<{Params:{id:string}}>('/api/backends/:id/command-observation/trust',async(request)=>{
    requireBackendVisibleToClient(request.headers,request.params.id);
    if(!isNativeBackendId(request.params.id))throw new AppError('INVALID_BACKEND','Choose a supported native backend');
    return nativeBackends.admin.trustCommandObservation(request.params.id);
  });
  app.get<{Params:{id:string}}>('/api/backends/:id/profiles',async(request)=>{
    requireBackendVisibleToClient(request.headers,request.params.id);
    if(!isNativeBackendId(request.params.id)||request.params.id==='chat')throw new AppError('INVALID_BACKEND','Choose a supported native backend');
    return nativeBackends.catalog.profileSettings(request.params.id);
  });
  app.post<{Params:{id:string};Body:NativeBackendProfileSettingsUpdate & {id?:string}}>('/api/backends/:id/profiles',async(request)=>{
    requireBackendVisibleToClient(request.headers,request.params.id);
    if(!isNativeBackendId(request.params.id)||request.params.id==='chat')throw new AppError('INVALID_BACKEND','Choose a supported native backend');
    const id=requireString(request.body?.id,'id',100);
    const {id:_id,...profile}=request.body;
    const defaultProfileId=nativeBackends.catalog.validateProfile(request.params.id).id;
    return settings.saveNativeBackendProfile(request.params.id,id,profile,true,false,defaultProfileId);
  });
  app.patch<{Params:{id:string;profileId:string};Body:NativeBackendProfileSettingsUpdate}>('/api/backends/:id/profiles/:profileId',async(request)=>{
    requireBackendVisibleToClient(request.headers,request.params.id);
    if(!isNativeBackendId(request.params.id)||request.params.id==='chat')throw new AppError('INVALID_BACKEND','Choose a supported native backend');
    const known=nativeBackends.catalog.profileSettings(request.params.id).profiles.some(profile=>profile.id===request.params.profileId);
    if(!known)throw new AppError('NATIVE_PROFILE_NOT_FOUND','Native backend profile does not exist',404);
    const defaultProfileId=nativeBackends.catalog.validateProfile(request.params.id).id;
    const result=settings.saveNativeBackendProfile(request.params.id,request.params.profileId,request.body,false,true,defaultProfileId);
    nativeBackends.refreshProfile(request.params.id,request.params.profileId);
    return result;
  });
  app.delete<{Params:{id:string;profileId:string}}>('/api/backends/:id/profiles/:profileId',async(request)=>{
    requireBackendVisibleToClient(request.headers,request.params.id);
    if(!isNativeBackendId(request.params.id)||request.params.id==='chat')throw new AppError('INVALID_BACKEND','Choose a supported native backend');
    // Deleting a provider never touches its sessions: they keep their history and stay readable
    // and handable-off, just no longer runnable (their backendProfileId dangles). Blocking the
    // delete until every session was archived only hid that state instead of preventing it.
    const result=settings.deleteNativeBackendProfile(request.params.id,request.params.profileId);
    nativeBackends.forgetProfile(request.params.id,request.params.profileId);
    return result;
  });
  /**
   * A named source carries its own address, so `apiEndpoint` is required only for a manual gateway.
   * The source is validated downstream, where the backend is known.
   */
  app.post<{Params:{id:string};Body:{apiEndpoint?:string;apiKey?:string;profileId?:string;modelSource?:string;apiProtocol?:NativeModelApiProtocol}}>('/api/backends/:id/model-probe',async(request)=>{
    requireBackendVisibleToClient(request.headers,request.params.id);
    const source=request.body?.modelSource;
    return {models:await nativeBackends.catalog.probeModels(request.params.id,{
      ...(request.body?.apiProtocol!==undefined?{apiProtocol:request.body.apiProtocol}:{}),
      ...(source!==undefined?{modelSource:requireString(source,'modelSource',64) as NativeModelSource}:{}),
      // Without a source the address is the whole question, so it stays required; with one it is
      // only an override.
      ...(source===undefined
        ?{apiEndpoint:requireString(request.body?.apiEndpoint,'apiEndpoint',8192)}
        :request.body?.apiEndpoint?{apiEndpoint:requireString(request.body.apiEndpoint,'apiEndpoint',8192)}:{}),
      ...(typeof request.body?.apiKey==='string'?{apiKey:request.body.apiKey}:{}),
      ...(request.body?.profileId?{profileId:requireString(request.body.profileId,'profileId',100)}:{}),
    })};
  });
}
