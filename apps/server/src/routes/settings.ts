import type { FastifyInstance } from 'fastify';
import { AppError, requireString } from '../errors.js';
import { AUXILIARY_MODEL_BACKENDS } from '../auxiliary/gateway.js';
import { auxiliaryEndpoint, listAuxiliaryModels } from '../auxiliary/models.js';
import { probeAuxiliaryModel } from '../auxiliary/probe.js';
import { handoffSummaryPrompt, titlePrompt, turnSummaryPrompt } from '../prompts/index.js';
import { AuxiliaryStats } from '../stats/auxiliary.js';
import { requestHandoffSummary } from '../orchestration/handoff-summary.js';
import { createBackup } from '../system.js';
import { scheduleCompaction } from '../storage/compaction.js';
import { StorageInspector } from '../storage/inspector.js';
import { machineReport } from '../doctor.js';
import { isNativeBackendId } from '../backends/registry.js';
import { LEGACY_DEFAULT_BACKEND_ID } from '../session-identity.js';
import { validateBackendDefaults } from '../settings/backend-defaults.js';
import { backendVisibleToClient, hiddenBackendIds, hidesPluginAgents, preserveInvisibleSettingsForClient, requireBackendVisibleToClient, visibleBackendsForClient } from '../native/client-features.js';
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
        const {capabilities}=await validateBackendDefaults(nativeBackends.catalog,backendId,requestedProfile,values.model);
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
    const pluginModels=body.pluginModels&&typeof body.pluginModels==='object'&&!Array.isArray(body.pluginModels)?body.pluginModels as Record<string,unknown>:{};
    for(const [field,choices] of [['auxiliaryModels',auxiliary],['pluginModels',pluginModels]] as const)for(const [purpose,raw] of Object.entries(choices)){
      const ref=raw as Record<string,unknown>|null;
      if(ref&&typeof ref==='object'&&!Array.isArray(ref)&&AUXILIARY_MODEL_BACKENDS.includes(ref.backendId as NativeBackendId)&&!nativeBackends.catalog.gatewayProfiles(ref.backendId as NativeBackendId).some(profile=>profile.id===ref.profileId))
        throw new AppError('INVALID_SETTINGS',`${field}.${purpose}.profileId must name a provider with a gateway address`);
    }
    settings.setSettings(body);
    if(auxiliary.title||auxiliary.default)void titles.backfill().catch(()=>undefined);
    return effectiveSettings(request.headers);
  });
  app.get('/api/auxiliary-models',async(request)=>({models:visibleBackendsForClient(request.headers,await listAuxiliaryModels(backendId=>nativeBackends.catalog.gatewayProfiles(backendId)))}));
  app.get('/api/auxiliary-models/inspect',async(request)=>{
    const currentSettings=effectiveSettings(request.headers);
    const aux=currentSettings.auxiliaryModels;
    const formatRef=(ref:import('../../../../packages/contracts/src/index.js').AuxiliaryModelRef|undefined)=>{
      if(!ref)return undefined;
      try{
        const profile=nativeBackends.catalog.gatewayProfiles(ref.backendId).find(item=>item.id===ref.profileId);
        return `${profile?.name||ref.profileId} · ${ref.model}`;
      }catch{return `${ref.profileId} · ${ref.model}`;}
    };
    const resolvePurpose=(purpose:'title'|'handoff'|'summary')=>{
      const direct=aux?.[purpose];
      if(direct)return {effectiveModel:formatRef(direct),fallbackFrom:'direct' as const};
      if(aux?.default)return {effectiveModel:formatRef(aux.default),fallbackFrom:'default' as const};
      return {fallbackFrom:'none' as const};
    };
    const translateDirect=currentSettings.pluginModels?.['riffet.translate/translation'];
    const translateResolved=translateDirect
      ? {effectiveModel:formatRef(translateDirect),fallbackFrom:'direct' as const}
      : aux?.default ? {effectiveModel:formatRef(aux.default),fallbackFrom:'default' as const} : {fallbackFrom:'none' as const};
    const hidden=hiddenBackendIds(request.headers);
    const auxiliaryStats=new AuxiliaryStats(store.db);
    return {
      jobs:[
        {
          id:'title',
          title:'会话标题',
          trigger:'首条消息开始运行（running）或首次完成时触发一次，不等待 Agent 回复完成。',
          rules:'用户手动重命名或已生成过标题时跳过；若中文对话返回了纯英文标题会被语言校验拦截（日志记为 SKIPPED_RULE）。',
          prompt:titlePrompt(),
          ...resolvePurpose('title'),
        },
        {
          id:'handoff',
          title:'交接摘要',
          trigger:'发起会话交接并生成交接草稿时触发，支持在设置页流式试用。',
          rules:'未配置模型或调用失败时退回本地规则简报，不阻塞交接。',
          prompt:handoffSummaryPrompt(),
          ...resolvePurpose('handoff'),
        },
        {
          id:'summary',
          title:'画布摘要',
          trigger:'在画布打开某轮回答节点时按轮触发一次，结果按回答内容哈希持久化缓存。',
          rules:'仅总结已结束轮次，输出限制在一句话内（≤ 40 汉字 / 80 英文字符）。',
          prompt:turnSummaryPrompt(),
          ...resolvePurpose('summary'),
        },
        {
          id:'translate',
          title:'翻译（插件）',
          trigger:'在回答更多菜单或选中文字工具条点击「翻译」时按需流式触发。',
          rules:'按 6,000 字符在代码块外切分，多片并发预译并按序 SSE 流式吐出；相同译文在内存缓存中直接返回。',
          prompt:[
            'You translate a message from a conversation between a person and a coding agent into <target language>.',
            'If the message is already in <target language>, translate it into <fallback language> instead.',
            'Keep the Markdown as it is: headings, lists, tables, links, emphasis and line breaks.',
            'Leave code blocks, inline code, file paths, commands, URLs, identifiers and product names unchanged.',
            'The message may be one part of a longer one; translate only what you are given.',
            'Answer with the translation alone: no preface, no notes, no quotation marks around it.',
          ].join('\n'),
          ...translateResolved,
        },
      ],
      recent:auxiliaryStats.recentCalls({
        limit:30,
        labels:{
          projectName:()=>undefined,
          profileLabel:(backendId,profileId)=>{try{return isNativeBackendId(backendId)?nativeBackends.catalog.validateProfile(backendId,profileId).name:undefined;}catch{return undefined;}},
        },
        ...(hidden.length?{hiddenBackends:hidden}:{}),
        ...(hidesPluginAgents(request.headers)?{hidePluginAgents:true}:{}),
      }),
    };
  });
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
    let hijacked=false;
    let closed=false;
    const close=()=>{closed=true;controller.abort();};
    reply.raw.once('close',close);
    const wantsStream=purpose==='handoff'&&typeof request.headers.accept==='string'&&request.headers.accept.includes('text/event-stream');
    const writeEvent=(event:string,data:unknown)=>{if(!closed&&!reply.raw.writableEnded)reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);};
    try{
      if(purpose==='title')return {text:await titles.preview(ref,message,controller.signal)};
      const {profileName:_name,...endpoint}=await auxiliaryEndpoint(ref,id=>nativeBackends.catalog.gatewayProfiles(id),controller.signal);
      if(!wantsStream)return {text:await requestHandoffSummary(endpoint,message,{signal:controller.signal})};
      const text=await requestHandoffSummary(endpoint,message,{
        signal:controller.signal,
        onDelta:delta=>{
          if(closed)return;
          if(!hijacked){
            hijacked=true;
            request.raw.socket?.setTimeout?.(0);
            reply.hijack();
            reply.raw.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'});
          }
          writeEvent('delta',{delta});
        },
      });
      if(!hijacked)return {text};
      writeEvent('result',{text});
      reply.raw.end();
      return;
    }catch(error){
      const msg=error instanceof Error?error.message:'The auxiliary model returned no result';
      if(!hijacked)throw new AppError('AUXILIARY_MODEL_FAILED',msg,400,undefined,{message:msg});
      writeEvent('error',{status:400,error:{code:'AUXILIARY_MODEL_FAILED',message:msg,params:{message:msg}}});
      reply.raw.end();
      return;
    }finally{reply.raw.off('close',close);}
  });
  app.post<{Body:{backendId?:unknown;profileId?:unknown;model?:unknown;preset?:unknown}}>('/api/auxiliary-models/probe',async(request,reply)=>{
    const body=request.body??{};
    const preset=body.preset===undefined?'short':requireString(body.preset,'preset',20);
    if(preset!=='short'&&preset!=='stream'&&preset!=='long')throw new AppError('INVALID_INPUT','preset must be short, stream or long');
    const backendId=requireString(body.backendId,'backendId',20);
    requireBackendVisibleToClient(request.headers,backendId);
    if(!isNativeBackendId(backendId)||!AUXILIARY_MODEL_BACKENDS.includes(backendId))throw new AppError('INVALID_BACKEND','This backend cannot run auxiliary models');
    const ref={backendId,profileId:requireString(body.profileId,'profileId',200),model:requireString(body.model,'model',200)};
    const controller=new AbortController();
    const close=()=>controller.abort();
    reply.raw.once('close',close);
    try{
      return await probeAuxiliaryModel(ref,preset,id=>nativeBackends.catalog.gatewayProfiles(id),{
        signal:controller.signal,
        ...(deps.recordAuxiliaryCall?{record:deps.recordAuxiliaryCall}:{}),
      });
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
  // The storage page: a breakdown that comes from a background scan, online maintenance, and a full rebuild at next start.
  const storage=new StorageInspector({stateDir,store,sweepColdTimeline:deps.sweepColdTimeline});
  app.addHook('onClose',async()=>storage.close());
  app.get('/api/system/storage',async()=>storage.report());
  app.post('/api/system/storage/scan',async()=>{storage.scan();return storage.report();});
  app.post('/api/system/storage/maintain',async()=>storage.maintain());
  app.put<{Body:{scheduled?:unknown}}>('/api/system/storage/compaction',async(request)=>{
    const scheduled=request.body?.scheduled;
    if(typeof scheduled!=='boolean')throw new AppError('INVALID_REQUEST','scheduled must be true or false');
    scheduleCompaction(stateDir,scheduled);
    return storage.report();
  });
  // A pane of a conversation the client cannot decode (a plugin Agent for a client without `plugin-agents`) is listed without it.
  app.get('/api/system/monitor',async(request)=>{
    const snapshot=await monitor.snapshot();
    return {...snapshot,processes:snapshot.processes.map(item=>{
      if(backendVisibleToClient(request.headers,item.backendId))return item;
      const {sessionId:_session,sessionTitle:_title,backendId:_backend,...rest}=item;
      return rest;
    })};
  });
  // Numbers and cache names only (docs/guide/performance.md §4); a client posts one sample every few minutes.
  app.post<{Body:unknown}>('/api/system/client-metrics',{bodyLimit:16*1024},async(request,reply)=>{
    const context=deps.auth.authenticate(request,true);
    const device=context.deviceId?deps.auth.device(context.deviceId):undefined;
    monitor.clients.record(context.deviceId?`device:${context.deviceId}`:'cookie',request.body,device?.name);
    return reply.code(204).send();
  });
  // tmux and Tailscale are the machine's, not an Agent's: this answers while any Agent plugin is off.
  app.get('/api/system/machine',async()=>machineReport());
  app.post<{Params:{pid:string}}>('/api/system/processes/:pid/terminate',async(request)=>{await monitor.terminate(request.params.pid);return {ok:true};});
}
