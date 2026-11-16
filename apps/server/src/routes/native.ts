import { readTerminalAppearance, recordTerminalAppearance } from '../terminal/appearance.js';
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { assertTaskWorkspaceAvailable } from '../task-workspaces/identity.js';
import type { FastifyInstance } from 'fastify';
import { AppError, parseInput, requireString } from '../errors.js';
import { NativeStopRequestSchema } from '../../../../packages/contracts/src/schema/run.js';
import { NativeRuntimeActionRequestSchema } from '../../../../packages/contracts/src/schema/sync.js';
import { isNativeBackendId } from '../backends/registry.js';
import type { NativeStopRequest, NativeTurnTarget, WorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import { defaultBackendForClient, requireBackendVisibleToClient } from '../native/client-features.js';
import { savedDefaultBackendId } from '../session-identity.js';
import { configureNative as configureNativeSession, type NativeConfigurePatch } from '../native/configure.js';
import type { RouteDeps, NativeMessageBody } from './deps.js';

/** Largest blob served in one response; bigger ones were never meant for a client to fetch whole. */
const BLOB_RESPONSE_LIMIT=16*1024*1024;
function steerTarget(value: unknown): NativeTurnTarget {
  const target = value as Partial<NativeTurnTarget> | undefined;
  return { nativeSessionId: requireString(target?.nativeSessionId, 'target.nativeSessionId', 500), turnId: requireString(target?.turnId, 'target.turnId', 500) };
}

export function registerNativeRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const {store,settings,terminal,sessionLock,nativeBackends,dispatch,sessionCommands,readNativeInput,contextReferences}=deps;
  app.post<{Params:{id:string};Body:NativeStopRequest}>('/api/sessions/:id/cancel',async(request)=>{
    const session=store.getSession(request.params.id);
    const stop=parseInput(NativeStopRequestSchema,request.body,'NATIVE_STOP_TARGET_REQUIRED');
    const run=await dispatch.interrupt(session.id,stop);
    return {interrupted:true,...(run?{run}:{})};
  });
  app.post<{Params:{id:string};Body:unknown}>('/api/sessions/:id/native/runtime-control',async(request)=>{
    await nativeBackends.runtimeAction(request.params.id,parseInput(NativeRuntimeActionRequestSchema,request.body,'INVALID_RUNTIME_CONTROL'));
    return {ok:true};
  });
  app.post<{Params:{id:string};Body:NativeMessageBody}>('/api/sessions/:id/native/send',async(request,reply)=>{
    reply.code(202);
    return sessionCommands.submit(store,request.params.id,requireString(request.body?.commandId,'commandId',100),{operation:'send',params:request.params,body:request.body},async()=>{
    const session=recordTerminalAppearance(store,request.params.id,request.headers);
    if(session.kind!=='native')throw new AppError('NOT_NATIVE','Only native conversations accept text input',409);
    const commandId=requireString(request.body?.commandId,'commandId',100);
    const existing=store.findRunByCommand(session.id,commandId);
    const input=await readNativeInput(request.body,{validateAttachments:!existing});
    contextReferences.requireFeature(request.headers,input);
    // Return a lost acceptance receipt even if the conversation changed after the first send.
    if(existing){reply.code(202);return store.acceptNativeRun(session.id,commandId,input,existing.native!.config,request.body.expectedConfigRevision);}
    await assertTaskWorkspaceAvailable(store.getProject(session.projectId));
    sessionCommands.admit(session);nativeBackends.assertAvailable(session);
    if(input.references?.length)await nativeBackends.assertSessionReferences(session);
    const prepared=await contextReferences.prepare(session.id,input,request.headers);
    const current=store.getSession(session.id);
    const result=contextReferences.commit(session.id,prepared,snapshots=>{
      contextReferences.validateSources(session.id,input,request.headers);
      return store.acceptNativeRun(session.id,commandId,input,{model:current.model,mode:current.mode,approval:current.approval},request.body.expectedConfigRevision,undefined,snapshots);
    });
    reply.code(202);dispatch.kick();return store.getRun(result.id);
    });
  });
  app.post<{Params:{id:string};Body:NativeMessageBody & {target?:unknown}}>('/api/sessions/:id/native/steer',async(request,reply)=>{
    reply.code(202);
    return sessionCommands.submit(store,request.params.id,requireString(request.body?.commandId,'commandId',100),{operation:'steer',params:request.params,body:request.body},async()=>{
    const session=store.getSession(request.params.id);
    if(session.kind!=='native')throw new AppError('NOT_NATIVE','Only native conversations support steering',409);
    const commandId=requireString(request.body?.commandId,'commandId',100);
    const target=steerTarget(request.body?.target);
    if(['expectedConfigRevision','model','mode','approval','cwd'].some(key=>Object.prototype.hasOwnProperty.call(request.body,key)))throw new AppError('STEER_CONFIG_UNSUPPORTED','A steer message keeps the current turn settings; do not set next-turn settings');
    const existing=store.findRunByCommand(session.id,commandId);
    const input=await readNativeInput(request.body,{validateAttachments:!existing});
    contextReferences.requireFeature(request.headers,input);
    if(existing){
      const receipt=store.acceptNativeRun(session.id,commandId,input,existing.native?.config??{mode:session.mode},undefined,{target,ownerRunId:existing.native?.ownerRunId});
      reply.code(202);return receipt;
    }
    await assertTaskWorkspaceAvailable(store.getProject(session.projectId));
    sessionCommands.admit(session,'steer');nativeBackends.assertAvailable(session);
    if(!await nativeBackends.supportsSteer(session))throw new AppError('STEER_UNSUPPORTED','This backend does not support steering',409);
    const active=nativeBackends.status(session.id).activeTurn;
    if(!active||active.nativeSessionId!==target.nativeSessionId||active.turnId!==target.turnId)throw new AppError('STEER_TARGET_CHANGED','The target turn ended or changed; the steer message was not sent',409);
    const owner=active.ownerRunId?store.listRuns(session.id).find(run=>run.id===active.ownerRunId&&run.native?.intent!=='steer'):undefined;
    if(input.references?.length)await nativeBackends.assertSessionReferences(session);
    const prepared=await contextReferences.prepare(session.id,input,request.headers);
    const current=store.getSession(session.id);
    const run=contextReferences.commit(session.id,prepared,snapshots=>{
      contextReferences.validateSources(session.id,input,request.headers);
      return store.acceptNativeRun(session.id,commandId,input,owner?.native?.resolvedConfig??owner?.native?.config??{model:current.model,mode:current.mode,approval:current.approval},undefined,{target,ownerRunId:owner?.id},snapshots);
    });
    const result=await dispatch.steer(session.id,run.id);
    reply.code(202);return result;
    });
  });
  app.post<{Params:{id:string};Body:NativeMessageBody & {stop?:NativeStopRequest}}>('/api/sessions/:id/native/interrupt-and-send',async(request,reply)=>{
    reply.code(202);
    return sessionCommands.submit(store,request.params.id,requireString(request.body?.commandId,'commandId',100),{operation:'interrupt-and-send',params:request.params,body:request.body},async()=>{
    const session=store.getSession(request.params.id);
    if(session.kind!=='native')throw new AppError('NOT_NATIVE','Only Native conversations support this operation',409);
    const commandId=requireString(request.body?.commandId,'commandId',100);
    const existing=store.findRunByCommand(session.id,commandId);
    const input=await readNativeInput(request.body,{validateAttachments:!existing});
    contextReferences.requireFeature(request.headers,input);
    // A lost HTTP receipt must never interrupt the replacement turn on retry.
    if(existing){reply.code(202);return store.acceptNativeRun(session.id,commandId,input,existing.native!.config,request.body.expectedConfigRevision);}
    const stop=parseInput(NativeStopRequestSchema,request.body.stop,'NATIVE_STOP_TARGET_REQUIRED');
    await assertTaskWorkspaceAvailable(store.getProject(session.projectId));
    sessionCommands.admit(session);nativeBackends.assertAvailable(session);
    const current=store.getSession(session.id);
    if(request.body.expectedConfigRevision!==undefined&&request.body.expectedConfigRevision!==(current.configRevision??0))throw new AppError('NATIVE_CONFIG_CHANGED','The conversation settings changed; submit again',409);
    const prepared=input.references?.length?(await nativeBackends.assertSessionReferences(session),await contextReferences.prepareInterrupt(session.id,commandId,input,request.headers)):[];
    const replacementFingerprint=createHash('sha256').update(JSON.stringify({input:{text:input.text,attachmentIds:input.attachmentIds,context:input.context.map(({path,line})=>({path,...(line!==undefined?{line}:{})})),...(input.references?.length?{references:input.references}:{})},expectedConfigRevision:request.body.expectedConfigRevision??current.configRevision??0})).digest('hex');
    const result=await dispatch.interruptAndSend(session.id,commandId,()=>{
      if(sessionCommands.isArchiving(session.id))throw new AppError('ARCHIVED_SESSION','This conversation is archived',409);
      const latest=store.getSession(session.id);
      return contextReferences.commit(session.id,prepared,snapshots=>store.acceptNativeRun(session.id,commandId,input,{model:latest.model,mode:latest.mode,approval:latest.approval},request.body.expectedConfigRevision,undefined,snapshots));
    },stop,replacementFingerprint);
    contextReferences.finishInterrupt(session.id,commandId);
    // Concurrent retries can share the stop operation; still validate each caller's payload.
    const receipt=store.acceptNativeRun(session.id,commandId,input,result.native!.config,request.body.expectedConfigRevision);
    reply.code(202);return receipt;
    });
  });
  app.post<{Params:{id:string;runId:string}}>('/api/sessions/:id/native/runs/:runId/cancel',async(request)=>dispatch.cancel(request.params.id,request.params.runId));
  app.post<{Params:{id:string;runId:string};Body:{commandId?:string;target?:unknown}}>('/api/sessions/:id/native/runs/:runId/steer',async(request,reply)=>{
    reply.code(202);
    return sessionCommands.submit(store,request.params.id,requireString(request.body?.commandId,'commandId',100),{operation:'runs/:runId/steer',params:request.params,body:request.body},async()=>{
    const session=store.getSession(request.params.id);
    if(session.kind!=='native')throw new AppError('NOT_NATIVE','Only native conversations support steering',409);
    const commandId=requireString(request.body?.commandId,'commandId',100),target=steerTarget(request.body?.target);
    if(Object.keys(request.body).some(key=>key!=='commandId'&&key!=='target'))throw new AppError('STEER_CONFIG_UNSUPPORTED','A steer message reuses the queued message text and the current turn settings');
    const existing=store.findRunByCommand(session.id,commandId);
    if(existing){
      const receipt=store.steerQueuedNativeRun(session.id,request.params.runId,commandId,target,existing.native?.config??{mode:session.mode});
      reply.code(202);return receipt;
    }
    await assertTaskWorkspaceAvailable(store.getProject(session.projectId));
    sessionCommands.admit(session,'steer');nativeBackends.assertAvailable(session);
    const source=store.getRun(request.params.runId);
    if(source.sessionId!==session.id||!source.native)throw new AppError('RUN_NOT_FOUND','The queued message does not exist',404);
    if(source.native.intent||source.state!=='queued'||source.native.delivery!=='queued')throw new AppError('RUN_NOT_QUEUED','This message is no longer queued; refresh and try again',409);
    if(!await nativeBackends.supportsSteer(session))throw new AppError('STEER_UNSUPPORTED','This backend does not support steering',409);
    const status=nativeBackends.status(session.id),active=status.activeTurn;
    if(status.interaction)throw new AppError('CLI_INTERACTION_REQUIRED','Handle the pending confirmation first',409);
    if(!active||active.nativeSessionId!==target.nativeSessionId||active.turnId!==target.turnId)throw new AppError('STEER_TARGET_CHANGED','The target turn ended or changed; the steer message was not sent',409);
    // Validate files before consuming the queued row. The transaction below rechecks that it is
    // still queued after any asynchronous attachment work; a failed acceptance leaves it intact.
    await readNativeInput({text:source.native.input.text,attachments:source.native.input.attachmentIds.map(id=>({id})),context:source.native.input.context,references:source.native.input.references});
    if(source.native.input.references?.length){contextReferences.requireFeature(request.headers,source.native.input);await nativeBackends.assertSessionReferences(session);}
    const owner=active.ownerRunId?store.listRuns(session.id).find(run=>run.id===active.ownerRunId&&run.native?.intent!=='steer'):undefined;
    const current=store.getSession(session.id);
    const run=store.steerQueuedNativeRun(session.id,source.id,commandId,target,owner?.native?.resolvedConfig??owner?.native?.config??{model:current.model,mode:current.mode,approval:current.approval},owner?.id);
    const result=await dispatch.steer(session.id,run.id);
    reply.code(202);return result;
    });
  });
  app.post<{Params:{id:string;runId:string};Body:{stop?:NativeStopRequest}}>('/api/sessions/:id/native/runs/:runId/send-now',async(request,reply)=>{
    const session=recordTerminalAppearance(store,request.params.id,request.headers);
    if(session.kind!=='native')throw new AppError('NOT_NATIVE','Only Native conversations support this operation',409);
    await assertTaskWorkspaceAvailable(store.getProject(session.projectId));
    sessionCommands.admit(session);nativeBackends.assertAvailable(session);
    const stop=parseInput(NativeStopRequestSchema,request.body?.stop,'NATIVE_STOP_TARGET_REQUIRED');
    const run=await dispatch.sendQueuedNow(session.id,request.params.runId,stop);
    reply.code(202);return run;
  });
  app.post<{Params:{id:string;runId:string}}>('/api/sessions/:id/native/runs/:runId/check',async(request)=>{
    return dispatch.check(request.params.id,request.params.runId);
  });
  app.post<{Params:{id:string;runId:string};Body:{outcome?:string;queuedRunIds?:unknown}}>('/api/sessions/:id/native/runs/:runId/resolve',async(request)=>{
    if(request.body?.outcome!=='continue')throw new AppError('NATIVE_RECOVERY_REQUIRED','Check the message status before continuing',409);
    const ids=request.body.queuedRunIds;
    if(!Array.isArray(ids)||ids.length>1000||ids.some(id=>typeof id!=='string'||!id||id.length>200)||new Set(ids).size!==ids.length)throw new AppError('INVALID_INPUT','queuedRunIds must identify the reviewed queue');
    return dispatch.continue(request.params.id,request.params.runId,ids as string[]);
  });
  app.post<{Body:{projectId:string;backendId?:string;backendProfileId?:string;model?:string;mode?:string;approval?:string;claimId?:string}}>('/api/native/prewarm',async(request)=>{
    const body=request.body;
    const project=store.getProject(requireString(body?.projectId,'projectId',100));
    if(body.backendId!==undefined)requireBackendVisibleToClient(request.headers,body.backendId);
    const backendId=body.backendId===undefined?defaultBackendForClient(request.headers,savedDefaultBackendId(settings.getSettings()),nativeBackends.offeredBackendIds()):isNativeBackendId(body.backendId)?body.backendId:(()=>{throw new AppError('INVALID_BACKEND','Choose a supported native backend');})();
    // A backend that is off, keeps no warm process or has no such profile answers before the workspace is looked at.
    const skipped=nativeBackends.catalog.prewarmSkip(backendId,body.backendProfileId);
    if(skipped)return skipped;
    await assertTaskWorkspaceAvailable(project);
    const claimId=body.claimId===undefined?undefined:requireString(body.claimId,'claimId',100);
    const prewarm=(renewOnly:boolean)=>nativeBackends.catalog.prewarm(backendId,{project,...(body.backendProfileId?{backendProfileId:body.backendProfileId}:{}),appearance:readTerminalAppearance(request.headers),model:body.model,mode:body.mode??'agent',...(body.approval!==undefined?{approval:requireString(body.approval,'approval',100)}:{}),...(claimId?{claimId}:{}),...(renewOnly?{renewOnly:true}:{})});
    // A workspace a restore or merge holds gets no new warm CLI; the page holding one keeps it renewed.
    // Conversations at work in it do not hold one back: a warm CLI changes no file, and it starts beside them as a new conversation would.
    let release:()=>void;
    try{release=dispatch.holdWorkspaceForPrewarm(project.id);}
    catch(error){if(error instanceof AppError&&error.code==='PROJECT_BUSY')return claimId?prewarm(true):{state:'skipped',reason:'workspace_busy'};throw error;}
    // The backend answers for itself: `skipped` with why when it keeps no warm CLI or not for this profile.
    try{return await prewarm(false);}
    finally{release();}
  });
  // The page that asked for a warm CLI closed or chose another Agent; one a new session has claimed is kept.
  app.post<{Body:{backendId?:string;claimId:string}}>('/api/native/prewarm/release',async(request,reply)=>{
    const body=request.body;
    const claimId=requireString(body?.claimId,'claimId',100);
    if(body.backendId!==undefined)requireBackendVisibleToClient(request.headers,body.backendId);
    const backendId=body.backendId===undefined?defaultBackendForClient(request.headers,savedDefaultBackendId(settings.getSettings()),nativeBackends.offeredBackendIds()):isNativeBackendId(body.backendId)?body.backendId:(()=>{throw new AppError('INVALID_BACKEND','Choose a supported native backend');})();
    await nativeBackends.catalog.releasePrewarm(backendId,claimId);
    reply.code(204);
  });
  const nativeKeys=new Set(['Escape','Enter','Up','Down','Left','Right','Tab','BTab','Space','C-c']);
  app.get<{Params:{id:string}}>('/api/sessions/:id/native/interaction',async(request)=>{
    const session=store.getSession(request.params.id);
    if(session.kind!=='native')throw new AppError('NOT_NATIVE','Only native conversations have terminal interactions',409);
    return (await nativeBackends.interaction(session))??null;
  });
  app.get<{Params:{id:string}}>('/api/sessions/:id/native/catalog',async(request)=>{
    const session=store.getSession(request.params.id);
    if(session.kind!=='native')throw new AppError('NOT_NATIVE','Only native conversations have a backend catalog',409);
    return nativeBackends.catalog.entry(session.backendId,store.getProject(session.projectId),session.backendProfileId,session);
  });
  app.post<{Params:{id:string};Body:import('../../../../packages/contracts/src/index.js').NativeInteractionResponse}>('/api/sessions/:id/native/interaction',async(request)=>{
    return sessionLock.withSession(request.params.id,()=>nativeBackends.respondInteraction(store.getSession(request.params.id),request.body));
  });
  app.post<{Params:{id:string};Body:{interactionId:unknown}}>('/api/sessions/:id/native/interaction/extend',async(request)=>{
    const interactionId=request.body?.interactionId;
    if(typeof interactionId!=='string'||!interactionId||interactionId.length>300)throw new AppError('INVALID_NATIVE_INTERACTION','interactionId is required');
    return sessionLock.withSession(request.params.id,()=>nativeBackends.extendInteraction(store.getSession(request.params.id),interactionId));
  });
  // A stop is a request: the activity turns `stopping` at once and `stopped` only when the provider's own evidence arrives (on the stream).
  app.post<{Params:{id:string;activityId:string}}>('/api/sessions/:id/native/activities/:activityId/stop',async(request)=>{
    const session=store.getSession(request.params.id);
    if(session.kind!=='native')throw new AppError('NOT_NATIVE','Only native conversations have system activities',409);
    const activityId=requireString(request.params.activityId,'activityId',300);
    return {activity:await nativeBackends.stopActivity(session,activityId)};
  });
  app.get<{Params:{id:string;hash:string}}>('/api/sessions/:id/context-references/:hash',async(request,reply)=>{
    store.getSession(request.params.id);
    if(!/^[0-9a-f]{64}$/.test(request.params.hash))throw new AppError('INVALID_BLOB_HASH','Invalid snapshot hash');
    const snapshot=contextReferences.snapshot(request.params.id,request.params.hash);
    reply.type('text/markdown; charset=utf-8').header('Cache-Control','private, max-age=31536000, immutable');
    return contextReferences.markdown(snapshot);
  });
  // Full text of an oversized payload or an activity, by content hash. Immutable, so it caches forever.
  app.get<{Params:{id:string;hash:string}}>('/api/sessions/:id/blobs/:hash',async(request,reply)=>{
    const session=store.getSession(request.params.id);
    const hash=request.params.hash;
    if(!/^[0-9a-f]{64}$/.test(hash))throw new AppError('INVALID_BLOB_HASH','A blob hash is 64 lowercase hex characters');
    const blob=store.journal.sessionBlob(session.id,hash);
    if(!blob)throw new AppError('BLOB_NOT_FOUND','This conversation has no such blob',404);
    if(blob.size>BLOB_RESPONSE_LIMIT)throw new AppError('BLOB_TOO_LARGE',`This blob is larger than ${BLOB_RESPONSE_LIMIT} bytes`,413);
    reply.header('ETag',`"${hash}"`).header('Cache-Control','private, max-age=31536000, immutable').header('X-Content-Type-Options','nosniff');
    if(request.headers['if-none-match']===`"${hash}"`){reply.code(304);return reply.send();}
    return reply.type(blob.type).send(blob.bytes());
  });
  app.post<{Params:{id:string};Body:{keys:unknown}}>('/api/sessions/:id/native/keys',async(request)=>{
    return sessionLock.withSession(request.params.id,async()=>{
    const session=store.getSession(request.params.id);
    const keys=request.body?.keys;
    if(!Array.isArray(keys)||!keys.length||keys.length>20||keys.some(key=>typeof key!=='string'||!nativeKeys.has(key)))throw new AppError('INVALID_KEYS',`Keys must be among ${[...nativeKeys].join(', ')}`);
    const capabilities=await nativeBackends.capabilities(session);
    if(!capabilities.supportsTerminal||!session.terminalId)throw new AppError('TERMINAL_NOT_RUNNING','This native backend does not use a terminal',409);
    await terminal.sendKeys(session.terminalId,keys as string[]);
    return {ok:true};
    });
  });
  app.get<{Params:{id:string}}>('/api/sessions/:id/native/models',async(request)=>{
    const session=store.getSession(request.params.id);
    if(session.kind!=='native')throw new AppError('NOT_NATIVE','Only native conversations use the CLI model list',409);
    return nativeBackends.models(session);
  });
  const configureNative=(id:string,patch:NativeConfigurePatch,headers?:IncomingHttpHeaders)=>configureNativeSession({store,dispatch,sessionLock,sessionCommands,nativeBackends},id,patch,headers);
  app.post<{Params:{id:string};Body:{model?:string;mode?:string;approval?:string;backendProfileId?:string}}>('/api/sessions/:id/native/configure',async(request)=>{
    const body=request.body??{},patch:{model?:string;mode?:string;approval?:string;backendProfileId?:string}={};
    if(body.backendProfileId!==undefined)patch.backendProfileId=requireString(body.backendProfileId,'backendProfileId',200);
    if(body.model!==undefined)patch.model=requireString(body.model,'model',200);
    if(body.mode!==undefined)patch.mode=requireString(body.mode,'mode',100);
    if(body.approval!==undefined)patch.approval=requireString(body.approval,'approval',100);
    if(!Object.keys(patch).length)throw new AppError('INVALID_NATIVE_CONFIG','Choose at least one native setting to update');
    return configureNative(request.params.id,patch,request.headers);
  });
  app.post<{Params:{id:string};Body:{model:string}}>('/api/sessions/:id/native/model',async(request)=>{
    return configureNative(request.params.id,{model:requireString(request.body?.model,'model',200)},request.headers);
  });
  app.post<{Params:{id:string};Body:{mode:string}}>('/api/sessions/:id/native/mode',async(request)=>configureNative(request.params.id,{mode:requireString(request.body?.mode,'mode',100)},request.headers));
  app.post<{Params:{id:string};Body:{approval?:unknown}}>('/api/sessions/:id/native/approval',async(request)=>{
    return configureNative(request.params.id,{approval:requireString(request.body?.approval,'approval',100)},request.headers);
  });
  app.delete<{Params:{id:string;runId:string}}>('/api/sessions/:id/runs/:runId',async(request)=>{
    const run=store.getRun(request.params.runId);if(run.native)return dispatch.cancel(request.params.id,run.id);if(run.sessionId!==request.params.id||run.state!=='queued')throw new AppError('RUN_NOT_QUEUED','Only a queued run can be removed',409);
    const result=store.updateRun(run.id,{state:'cancelled'});store.appendEvent(run.sessionId,'run',{run:result},{runId:run.id});return result;
  });
  app.get<{Params:{id:string}}>('/api/sessions/:id/export',async(request,reply)=>{
    const session=store.getSession(request.params.id),events:WorkbenchEvent[]=[];let after=0;
    while(true){const page=store.getEvents(session.id,after);events.push(...page);if(page.length<5000)break;after=page.at(-1)!.sequence;}
    reply.header('Content-Disposition',`attachment; filename="riffet-${session.id}.json"`);
    return {format:'riffet-export-v1',session,events,runs:store.listRuns(session.id),note:'Native history is owned by the CLI; this export contains workbench records.'};
  });
}
