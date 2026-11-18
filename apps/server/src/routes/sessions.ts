import { submissionFingerprint } from '../orchestration/session-commands.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, requireString } from '../errors.js';
import type { SessionKind, SessionListDelta, WorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import { SYNC_BUDGET } from '../../../../packages/contracts/src/sync.js';
import { recordTerminalAppearance } from '../terminal/appearance.js';
import { resolveNativeSessionInput } from '../native/session-input.js';
import { requestedNativeSessionId, startsWithBareTerminal, type IdentifiedSession, type RequestedNativeSession } from '../session-identity.js';
import { revisionedList, sequence, tags } from './params.js';
import type { RouteDeps, NativeMessageBody } from './deps.js';
import { withoutQuickChats } from '../chat/quick-chat.js';
import { clientSupportsFeature, requireBackendVisibleToClient, projectVisibleToClient, requireSessionVisibleToClient, sessionVisibleToClient, visibleSessionsForClient } from '../native/client-features.js';
import { assertTaskWorkspaceAvailable, taskWorkspaceRequestDigest } from '../task-workspaces/index.js';
import { requirePairedDevices, toolGroupList } from '../riffet-mcp/groups.js';
import { applicableExtensionsOff, extensionsOffList } from '../extensions/toggles.js';
import type { PreparedSessionReference } from '../context-references/service.js';
import { registerDiscussionRoutes } from '../chat/discussions.js';
import { assertNoOtherConversation, claimMainConversation } from '../assistant/standing.js';

/** `toolGroups` overrides the conversation's snapshot; a running CLI keeps the tools it was launched with until its next launch. */
export interface SessionPatch { title?: string; tags?: string[]; archived?: boolean; pinned?: boolean; toolGroups?: unknown; extensionsOff?: unknown }

/** A durable creation receipt is the only authority for releasing a pending submission. */
function creationRejection(error: unknown, store: RouteDeps['store'], clientSessionId: unknown): unknown {
  if(!(error instanceof AppError)||error.statusCode>=500||['SESSION_ID_CONFLICT','TASK_WORKSPACE_CONFLICT','COMMAND_ID_CONFLICT'].includes(error.code))return error;
  if(typeof clientSessionId==='string') {
    try { store.getSession(clientSessionId); return error; }
    catch(lookup) { if(!(lookup instanceof AppError)||lookup.code!=='SESSION_NOT_FOUND')return lookup; }
  }
  return new AppError(error.code,error.message,error.statusCode,{...(error.details&&typeof error.details==='object'?error.details:{}),accepted:false},error.params);
}

function requestedWorkItemId(value: unknown): string|undefined {
  if(value===undefined)return undefined;
  if(typeof value!=='string'||!value||value.length>100)throw new AppError('INVALID_WORK_ITEM','workItemId must be a string of 1 to 100 characters');
  return value;
}

export function registerSessionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  registerDiscussionRoutes(app, deps);
  const {store,workItems,auth,settings,terminal,sessionLock,nativeBackends,dispatch,streams,sessionCommands,renameNative,readNativeInput,nativeRuns,contextReferences}=deps;
  /**
   * The 任务 a new conversation starts (docs/TASK-BOARD.md §4.3): only one the request names. A conversation
   * opened from a composer is not a task by itself. Called inside the creation's transaction.
   */
  const startedWorkItem=(requested:unknown,session?:{clientSessionId:string;text:string;backendId?:string;profileId?:string;model?:string;projectId?:string})=>{
    const named=requestedWorkItemId(requested);
    if(named)return workItems.get(named).id;
    if(!session||settings.getSettings().workItems?.composerSessions!==true)return undefined;
    const {clientSessionId,...rest}=session;
    return workItems.ensureForComposerSession(clientSessionId,rest).id;
  };
  /** With `since`, only what changed after that revision (docs/LIST-SYNC.md). */
  app.get<{Querystring:{since?:string}}>('/api/sessions',async(request,reply)=>{
    const listed=(items:readonly IdentifiedSession[])=>visibleSessionsForClient(request.headers,withoutQuickChats(items,request),id=>store.getProject(id));
    if(request.query.since===undefined)return revisionedList(request,reply,store.listRevision,()=>listed(store.listSessions()));
    return revisionedList(request,reply,store.listRevision,():SessionListDelta=>{
      const changed=store.sessionsChangedSince(Number(request.query.since));
      if(!changed)return {revision:store.listRevision,full:true,sessions:listed(store.listSessions())};
      const found=changed.flatMap(id=>{const session=store.findSession(id);return session?[session]:[];});
      const sessions=listed(found),shown=new Set(sessions.map(session=>session.id));
      const removed=changed.filter(id=>!shown.has(id));
      return {revision:store.listRevision,sessions,...(removed.length?{removed}:{})};
    });
  });
  app.post<{Body:{projectId?:string;projectless?:boolean;kind:SessionKind;title?:string;backendId?:string;backendProfileId?:string;model?:string;mode?:string;approval?:string;resumePicker?:boolean;clientSessionId?:string;workItemId?:string;initialMessage?:NativeMessageBody}&RequestedNativeSession}>('/api/sessions',async(request,reply)=>{
    const create=async()=>{
    const body=request.body;
    try {
    if (!body||body.kind!=='native') throw new AppError('INVALID_SESSION_KIND','Choose a native conversation');
    if(body.projectless!==undefined&&typeof body.projectless!=='boolean')throw new AppError('INVALID_SUBMISSION','projectless must be a boolean');
    if(body.projectless===true){
      if(!clientSupportsFeature(request.headers,'projectless-tasks'))throw new AppError('FEATURE_REQUIRED','Update the client to create a task without a project',409);
      if(body.projectId!==undefined||body.backendId==='chat'||requestedNativeSessionId(body)!==undefined||body.resumePicker)throw new AppError('INVALID_SUBMISSION','A projectless task must start a new agent conversation without a project');
      const clientSessionId=requireString(body.clientSessionId,'clientSessionId',100),commandId=requireString(body.initialMessage?.commandId,'commandId',100);
      const input=await readNativeInput(body.initialMessage!,{validateAttachments:false});
      contextReferences.requireFeature(request.headers,input);
      let prepared:PreparedSessionReference[]=[];
      if(input.context.length)throw new AppError('INVALID_CONTEXT','A projectless draft has no project file references');
      const result=await deps.taskWorkspaces.create({clientSessionId,commandId,text:input.text,requestDigest:taskWorkspaceRequestDigest(body)},async project=>{const sessionInput=await resolveNativeSessionInput(deps,body,request.headers,project);if(input.references?.length)await nativeBackends.assertSessionReferences(sessionInput);return sessionInput;},async()=>{const message=await readNativeInput(body.initialMessage!);prepared=await contextReferences.prepare(clientSessionId,message,request.headers);return message;},async sessionInput=>{
        if(input.references?.length)await nativeBackends.assertSessionReferences(sessionInput);
        // Validate the saved provider while keeping every resolved option pinned to the receipt.
        const backendId=sessionInput.backendId!;
        requireBackendVisibleToClient(request.headers,backendId);
        const profile=nativeBackends.catalog.validateProfile(backendId,sessionInput.backendProfileId);
        const capabilities=await nativeBackends.catalog.capabilitiesFor(backendId,profile.id);
        if(capabilities.supportsModeSelection?!capabilities.modes.some(item=>item.id===sessionInput.mode):sessionInput.mode!=='agent')throw new AppError('INVALID_MODE','The saved task mode is no longer available');
        if(sessionInput.approval!==undefined&&(!capabilities.supportsPermissionSelection||!capabilities.permissions.some(item=>item.id===sessionInput.approval)))throw new AppError('INVALID_APPROVAL_MODE','The saved task permission is no longer available');
      },(project,sessionInput,message)=>contextReferences.commit(clientSessionId,prepared,snapshots=>{contextReferences.validateSources(clientSessionId,message,request.headers);
        const workItemId=startedWorkItem(body.workItemId,{clientSessionId,text:message.text,backendId:sessionInput.backendId,profileId:sessionInput.backendProfileId,...(sessionInput.model?{model:sessionInput.model}:{})});
        const accepted=store.createTaskWorkspaceSubmission(project,clientSessionId,sessionInput,commandId,message,snapshots);
        if(workItemId)workItems.attachSession(clientSessionId,workItemId);return accepted;}));
      requireSessionVisibleToClient(request.headers,result.session,id=>store.getProject(id));
      reply.code(202);dispatch.kick();return result;
    }
    if(body.initialMessage!==undefined){
      if(body.resumePicker)throw new AppError('INVALID_SUBMISSION','Only a new Native conversation accepts an initial message');
      const clientSessionId=requireString(body.clientSessionId,'clientSessionId',100),commandId=requireString(body.initialMessage?.commandId,'commandId',100);
      const existing=store.findRunByCommand(clientSessionId,commandId);
      const message=await readNativeInput(body.initialMessage,{validateAttachments:!existing});
      contextReferences.requireFeature(request.headers,message);
      if(existing&&!message.references?.length){const resolved=await resolveNativeSessionInput(deps,body,request.headers);reply.code(202);return store.createNativeSubmission(clientSessionId,resolved,commandId,message);}
      if(existing){
        const receipt=store.getSession(clientSessionId);
        requireSessionVisibleToClient(request.headers,receipt,id=>store.getProject(id));
        const fingerprint=submissionFingerprint(body);
        const identity=store.getSetting<string|undefined>(`session-reference-creation:${clientSessionId}`,undefined);
        if(message.references?.length&&identity!==fingerprint)throw new AppError('SESSION_ID_CONFLICT','This creation ID belongs to another request',409);
        const run=store.acceptNativeRun(clientSessionId,commandId,message,existing.native!.config);
        reply.code(202);return {session:receipt,run};
      }
      const input=await resolveNativeSessionInput(deps,body,request.headers);
      if(message.references?.length)await nativeBackends.assertSessionReferences(input);
      const prepared=await contextReferences.prepare(clientSessionId,message,request.headers);
      const result=contextReferences.commit(clientSessionId,prepared,snapshots=>{contextReferences.validateSources(clientSessionId,message,request.headers);
        const project=store.getProject(input.projectId);
        // Quick chats and the 助理's own conversations are not work on the board.
        const workItemId=project.system==='quick-chat'||project.system==='assistant'?undefined:startedWorkItem(body.workItemId,{clientSessionId,text:message.text,...(input.backendId?{backendId:input.backendId}:{}),...(input.backendProfileId?{profileId:input.backendProfileId}:{}),...(input.model?{model:input.model}:{}),...(project.system?{}:{projectId:project.id})});
        assertNoOtherConversation(store,project,clientSessionId);
        const accepted=store.createNativeSubmission(clientSessionId,input,commandId,message,snapshots);
        const main=claimMainConversation(store,project,clientSessionId);
        if(workItemId)workItems.attachSession(clientSessionId,workItemId);if(message.references?.length)store.setSetting(`session-reference-creation:${clientSessionId}`,submissionFingerprint(body));
        // With the project, so the client knows this is the main conversation before it selects it.
        return main?{...accepted,session:main,project:store.getProject(project.id)}:accepted;});
      deps.bindWorkbench?.(request,result.session,result.run);
      reply.code(202);dispatch.kick();return result;
    }
    const input=await resolveNativeSessionInput(deps,body,request.headers);
    return store.createSession({...input,kind:body.kind});
    } catch(error) { throw creationRejection(error,store,body?.clientSessionId); }
    };
    const pending=request.body;
    if(pending?.initialMessage!==undefined){
      reply.code(202);
      try {
        return await sessionCommands.submit(store,requireString(pending.clientSessionId,'clientSessionId',100),requireString(pending.initialMessage?.commandId,'commandId',100),{operation:'create',body:pending},create);
      } catch(error) { throw creationRejection(error,store,pending.clientSessionId); }
    }
    return create();
  });
  app.patch<{Params:{id:string};Body:SessionPatch}>('/api/sessions/:id',async(request)=>patchSession(deps,request.params.id,request.body??{}));
  app.put<{Body:{sessionIds?:unknown}}>('/api/sessions/pin-order',async(request)=>setPinOrder(deps,request.body?.sessionIds));
  /** The conversation was shown in the foreground up to `activityAt` on some device; see `Store.markSessionSeen`. */
  app.post<{Params:{id:string};Body:{activityAt?:unknown}}>('/api/sessions/:id/seen',async(request)=>{
    const session=store.getSession(request.params.id);
    requireSessionVisibleToClient(request.headers,session,id=>store.getProject(id));
    const activityAt=request.body?.activityAt;
    if(activityAt!==undefined&&(typeof activityAt!=='string'||!Number.isFinite(Date.parse(activityAt))))throw new AppError('INVALID_SEEN','activityAt must be a timestamp');
    return store.markSessionSeen(session.id,activityAt)??store.getSession(session.id);
  });
  /** Mark all as seen: `{all:true}` for every conversation this client lists, or `{sessionIds}`. Answers with the ids that changed. */
  app.post<{Body:{all?:unknown;sessionIds?:unknown}}>('/api/sessions/seen',async(request)=>{
    const {all,sessionIds}=request.body??{};
    if(all!==true&&(!Array.isArray(sessionIds)||sessionIds.length>5000||sessionIds.some(id=>typeof id!=='string')))throw new AppError('INVALID_SEEN','Send all: true or a list of sessionIds');
    const listed=visibleSessionsForClient(request.headers,withoutQuickChats(store.listSessions(),request),id=>store.getProject(id));
    const wanted=all===true?undefined:new Set(sessionIds as string[]);
    return {sessionIds:store.transaction(()=>listed.filter(session=>(!wanted||wanted.has(session.id))&&store.markSessionSeen(session.id)).map(session=>session.id))};
  });
  app.get<{Params:{id:string};Querystring:{after?:string}}>('/api/sessions/:id/events',async(request)=>{store.getSession(request.params.id);return store.getEvents(request.params.id,sequence(request.query.after));});
  app.get<{Params:{id:string};Querystring:{after?:string}}>('/api/sessions/:id/stream',async(request,reply)=>{
    const id=request.params.id;store.getSession(id);
    let last=Math.max(sequence(request.query.after),sequence(request.headers['last-event-id']));
    const unwatch=auth.onRevoke(request,()=>reply.raw.destroy());
    reply.raw.once('close',unwatch);
    // A deleted conversation's stream ends; reconnecting answers 410.
    reply.raw.once('close',store.onSessionDeleted(id,()=>reply.raw.destroy()));
    reply.hijack(); streams.add(reply.raw);
    reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
    reply.raw.write(': connected\n\n');
    const write=(event:WorkbenchEvent)=>{
      if(event.sequence<=last||reply.raw.destroyed||reply.raw.writableEnded)return;
      if(reply.raw.writableLength>4*1024*1024){reply.raw.end();return;}
      last=event.sequence;reply.raw.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // Subscribe before replay. SQLite reads are synchronous; sequence dedup handles overlap.
    const unsubscribe=store.subscribe(id,write);
    while(!reply.raw.destroyed&&!reply.raw.writableEnded){const page=store.getEvents(id,last);for(const event of page)write(event);if(page.length<5000)break;}
    const heartbeat=setInterval(()=>{if(!reply.raw.destroyed&&!reply.raw.writableEnded)reply.raw.write(': heartbeat\n\n');},15_000);
    reply.raw.on('close',()=>{clearInterval(heartbeat);unsubscribe();streams.delete(reply.raw);});
  });
  /**
   * Tells open workbenches the session, terminal or project lists moved so they re-read them. Carries
   * separate project, marks and folder-favorites revisions; a client re-reads only the data that moved.
   */
  app.route({
    method: 'GET',
    url: '/api/lists/stream',
    handler: async (request, reply) => {
      const response = reply.raw;
      const unwatch = auth.onRevoke(request, () => response.destroy());
      const write = (frame: string) => {
        if (response.destroyed || response.writableEnded) return;
        if (response.writableLength + Buffer.byteLength(frame) > SYNC_BUDGET.frameBytes) { response.destroy(); return; }
        response.write(frame);
      };
      reply.hijack();
      streams.add(response);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      write(': connected\n\n');
      const unsubscribe = subscribeLists(deps, request, unwatch, (event, json) => write(`event: ${event}\ndata: ${json}\n\n`));
      const heartbeat = setInterval(() => write(': heartbeat\n\n'), SYNC_BUDGET.pingMs);
      response.once('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        streams.delete(response);
      });
    },
    wsHandler: (socket, request) => {
      const unwatch = auth.onRevoke(request, () => socket.terminate());
      const unsubscribe = subscribeLists(deps, request, unwatch, (event, json) => {
        if (socket.readyState !== socket.OPEN) return;
        const frame = `{"event":"${event}","data":${json}}`;
        if (socket.bufferedAmount + Buffer.byteLength(frame) > SYNC_BUDGET.frameBytes) { socket.terminate(); return; }
        socket.send(frame);
      });
      let awaitingPong = false;
      const heartbeat = setInterval(() => {
        if (socket.readyState !== socket.OPEN) return;
        if (awaitingPong) { socket.terminate(); return; }
        awaitingPong = true;
        socket.ping();
      }, SYNC_BUDGET.pingMs);
      socket.on('pong', () => { awaitingPong = false; });
      socket.on('error', () => socket.terminate());
      socket.once('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    },
  });
  app.get<{Params:{id:string};Querystring:{commandId?:string}}>('/api/sessions/:id/runs',async(request)=>{
    const session=store.getSession(request.params.id);
    if(session.kind!=='native')throw new AppError('NOT_NATIVE','Only native conversations have runs',409);
    if(request.query.commandId!==undefined){
      const run=store.findRunByCommand(session.id,requireString(request.query.commandId,'commandId',100));
      return run?[run]:[];
    }
    return nativeRuns(request.params.id);
  });
  app.post<{Params:{id:string};Body:{restartFingerprint?:string;restartAddress?:string}}>('/api/sessions/:id/start',async(request)=>{
    const id=request.params.id;
    const restartFingerprint=request.body?.restartFingerprint;
    const restartAddress=request.body?.restartAddress;
    if(restartFingerprint!==undefined||restartAddress!==undefined){
      if(typeof restartFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(restartFingerprint)||typeof restartAddress!=='string'||!restartAddress||restartAddress.length>8192)throw new AppError('INVALID_SUBMISSION','Invalid backend launch binding');
    }
    const releaseSessionStart=dispatch.reserveSessionStart(id);
    try{return await sessionLock.withSession(id,async()=>{
      const session=recordTerminalAppearance(store,id,request.headers),project=store.getProject(session.projectId);
      await assertTaskWorkspaceAvailable(project);
      if(session.archivedAt)throw new AppError('ARCHIVED_SESSION','Restore this conversation before running it',409);
      if(restartFingerprint&&(session.backendId!=='codex'&&session.backendId!=='traex'))throw new AppError('NATIVE_LAUNCH_ABORTED','This backend does not support applying launch settings',409);
      const opened=await nativeBackends.ensure(session,{restartFingerprint,restartAddress});
      if(startsWithBareTerminal(session.backendId)&&opened.terminal)return opened.terminal;
      return {session:opened.session,status:opened.status,...(opened.nativeSessionId?{nativeSessionId:opened.nativeSessionId}:{}),...(opened.terminal?{terminal:opened.terminal}:{})};
    });}finally{releaseSessionStart();}
  });
}

const LIST_CHANGE_DEBOUNCE_MS = 250;
type ListEvent = 'changed' | 'notice' | 'task' | 'integrations' | 'owner' | 'devices' | 'channels';

/** Both transports notify clients of the same revisions and changes. */
function subscribeLists({ store, notices, tasks, plugins, owner, devices, channels }: RouteDeps, request: FastifyRequest, unwatch: () => void, write: (event: ListEvent, json: string) => void): () => void {
  const emit = (event: ListEvent, data: unknown) => write(event, JSON.stringify(data));
  // A connected client compares these revisions with its own and reads only what moved.
  const changed = () => emit('changed', {
    revision: store.listRevision, terminals: store.terminalsRevision, projects: store.projectRevision,
    marks: store.marksRevision, workItems: store.workItemsRevision, favorites: store.favoritesRevision,
  });
  changed();
  let pending: NodeJS.Timeout | undefined;
  const unsubscribe = [
    unwatch,
    store.onListsChanged(() => {
      if (pending) return;
      pending = setTimeout(() => { pending = undefined; changed(); }, LIST_CHANGE_DEBOUNCE_MS);
    }),
    notices.subscribe(notice => {
      try {
        if (!sessionVisibleToClient(request.headers, store.getSession(notice.sessionId), id => store.getProject(id))) return;
      } catch { return; }
      emit('notice', notice);
    }),
    tasks.subscribe(task => {
      try {
        if (!projectVisibleToClient(request.headers, store.getProject(task.projectId))) return;
      } catch { return; }
      emit('task', task);
    }),
    plugins.onChange(() => emit('integrations', {})),
    owner.subscribe(record => emit('owner', record)),
    devices.onChange(() => emit('devices', {})),
    channels.onChange(() => emit('channels', {})),
  ];
  return () => {
    clearTimeout(pending);
    for (const stop of unsubscribe) stop();
  };
}

type PinStore = Pick<RouteDeps['store'], 'listSessions'>;

/** Pinned, unarchived conversations in display order: ranked ones by rank, an unranked one before them, equal ranks by newest pin. */
function pinnedSessions(store: PinStore) {
  return store.listSessions().filter(item=>item.pinnedAt&&!item.archivedAt).sort((a,b)=>{
    if((a.pinRank===undefined)!==(b.pinRank===undefined))return a.pinRank===undefined?-1:1;
    if(a.pinRank!==undefined&&b.pinRank!==undefined&&a.pinRank!==b.pinRank)return a.pinRank-b.pinRank;
    return (b.pinnedAt??'').localeCompare(a.pinnedAt??'');
  });
}

/** `PUT /api/sessions/pin-order`: ranks the listed pinned conversations 0..n-1 in the given order; a rank that does not change writes nothing. */
export function setPinOrder(deps: RouteDeps, sessionIds: unknown): { sessions: ReturnType<typeof pinnedSessions> } {
  const {store}=deps;
  if(!Array.isArray(sessionIds)||sessionIds.some(id=>typeof id!=='string'))throw new AppError('INVALID_PIN_ORDER','sessionIds must be an array of session ids');
  const ids=sessionIds as string[];
  if(new Set(ids).size!==ids.length)throw new AppError('INVALID_PIN_ORDER','sessionIds must not repeat a conversation');
  const pinned=new Map(pinnedSessions(store).map(item=>[item.id,item]));
  const stray=ids.find(id=>!pinned.has(id));
  if(stray!==undefined)throw new AppError('INVALID_PIN_ORDER','Only pinned conversations can be ordered',400,{sessionId:stray});
  ids.forEach((id,rank)=>{
    if(pinned.get(id)!.pinRank===rank)return;
    const session=store.updateSession(id,{pinRank:rank});store.appendEvent(id,'session',{session});
  });
  return {sessions:pinnedSessions(store)};
}

/** `PATCH /api/sessions/:id`; also how the workbench archives a quick chat nobody kept. */
export async function patchSession(deps: RouteDeps, id: string, body: SessionPatch) {
  const {store,terminal,sessionLock,nativeBackends,dispatch,sessionCommands,renameNative}=deps;
  const patch:Record<string,unknown>={};
  store.getSession(id);
  if(body.archived!==undefined&&typeof body.archived!=='boolean')throw new AppError('INVALID_ARCHIVED','archived must be a boolean');
  if(body.pinned!==undefined&&typeof body.pinned!=='boolean')throw new AppError('INVALID_PINNED','pinned must be a boolean');
  if(body.title!==undefined){patch.title=requireString(body.title,'title',200);patch.titleSource='user';}
  if(body.tags!==undefined)patch.tags=tags(body.tags);
  if(body.toolGroups!==undefined){
    const groups=toolGroupList(body.toolGroups);
    requirePairedDevices(groups,deviceId=>Boolean(deps.auth.device(deviceId)));
    if(groups.length&&store.getSession(id).backendId==='chat')throw new AppError('INVALID_TOOL_GROUPS','A quick chat has no Riffet tools');
    patch.toolGroups=groups.length?groups:undefined;
  }
  if(body.extensionsOff!==undefined){
    const off=extensionsOffList(body.extensionsOff);
    const target=store.getSession(id);
    if(off.length&&target.backendId==='chat')throw new AppError('INVALID_EXTENSIONS_OFF','A quick chat has no extensions to switch off');
    // Kinds the backend cannot switch off are dropped, so the stored list is what a launch applies.
    const applicable=off.length?applicableExtensionsOff(off,(await nativeBackends.catalog.capabilitiesFor(target.backendId??'cursor',target.backendProfileId)).extensionToggles):[];
    patch.extensionsOff=applicable.length?applicable:undefined;
  }
  // The tools and extensions of a conversation are read when its CLI launches. A backend that relaunches an idle CLI for a
  // pending launch change (as for a model switch) is told there is one; a running turn is never interrupted.
  const launched=store.getSession(id) as unknown as Record<string,unknown>;
  const launchChanged=['toolGroups','extensionsOff'].some(key=>key in patch&&JSON.stringify(patch[key]??[])!==JSON.stringify(launched[key]??[]));
  if(launchChanged&&launched.terminalId&&nativeBackends.registry.require(store.getSession(id).backendId??'cursor').traits?.relaunchesForPendingConfig)patch.configPending=true;
  // Fence new submissions and cancel uncommitted inputs before waiting for a startup worker.
  const archived=body.archived?sessionCommands.beginArchive(id):undefined;
  try{
  if(body.archived){
    for(const run of store.listUnfinishedNativeRuns(id))if(['queued','preparing'].includes(run.native!.delivery))dispatch.cancel(id,run.id);
  }
  return await sessionLock.withSession(id,async()=>{
    if(body.pinned!==undefined){
      const current=store.getSession(id);
      if(body.pinned&&!current.pinnedAt){
        patch.pinnedAt=new Date().toISOString();
        // The new pin lands before every ranked one; with none ranked it stays unranked and sorts by pin time.
        const ranks=pinnedSessions(store).flatMap(item=>item.pinRank===undefined?[]:[item.pinRank]);
        patch.pinRank=ranks.length?Math.min(...ranks)-1:undefined;
      }else if(!body.pinned&&current.pinnedAt){patch.pinnedAt=undefined;patch.pinRank=undefined;}
    }
    if(body.archived!==undefined){
      if(body.archived){
        const session=store.getSession(id);
        const activeRuns=store.listUnfinishedNativeRuns(id).some(run=>!['queued','preparing'].includes(run.native!.delivery));
        if(activeRuns)await dispatch.interrupt(id);
        await nativeBackends.dispose(id);
        if(session.terminalId)await terminal.stop(session.terminalId);
        patch.archivedAt=new Date().toISOString();patch.state='archived';
        // A restored pin is unranked, so it sorts first rather than into a slot that has since been taken.
        patch.pinRank=undefined;
      }else{patch.archivedAt=undefined;patch.state='idle';}
    }
    const session=store.updateSession(id,patch);store.appendEvent(id,'session',{session});
    // An archived conversation keeps no Riffet MCP credential.
    if(session.archivedAt)deps.riffetMcp.revoke(id);
    if(body.title!==undefined&&!session.archivedAt)renameNative(session);
    return session;
  });}finally{archived?.();}
}
