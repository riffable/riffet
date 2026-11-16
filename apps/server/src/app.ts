import { createHash } from 'node:crypto';
import { eventLoopBusy, startLoopHealth } from './loop-health.js';
import { LAUNCHED_BY, SERVER_BUILD, SERVER_VERSION } from './version.js';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { mkdir, rm, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { encodingFor, registerWebAssets } from './static-assets.js';
import { registerMathAssets } from './math-assets.js';
import { registerDiagramAssets } from './diagram-assets.js';
import { registerContentPreview } from './previews/content.js';
import { applyProcessEnvironment, expandHome } from './environment.js';
import { Store } from './store.js';
import { startWalCheckpoints } from './wal-checkpoint.js';
import { Auth, apiRoutePath, isApiRequest, proxiedRequest } from './auth.js';
import { AppError, requireString } from './errors.js';
import { PlanFileWriter } from './native/plan-files.js';
import { TerminalService } from './terminal/index.js';
import { TitleService } from './titles/service.js';
import { WorkspaceService } from './workspace/index.js';
import { GitService } from './git/index.js';
import { SettingsService } from './settings/index.js';
import { ThemeService } from './themes/index.js';
import { migratePluginStorage } from './compat.js';
import { SessionLock } from './agent-host/session-lock.js';
import { NativeDispatcher } from './native/dispatch.js';
import { defaultBackendForClient, effectiveSettingsForClient, registerProjectVisibilityHook, registerSessionVisibilityHook } from './native/client-features.js';
import { ClientLogs } from './clientLogs.js';
import { ServiceMonitor } from './monitor.js';
import { AgentReclaimer } from './native/reclaim.js';
import { TerminalHolds } from './native/terminal-hold.js';
import { isTempStateDir, sweepOrphanTmuxServers } from './terminal/orphans.js';
import { ExternalSessions } from './native/external-sessions.js';
import { registerExternalSessionRoutes } from './routes/external-sessions.js';
import { setAppServerOwner } from './backends/shared/codex-app-server.js';
import { CodexBackendAdapter } from './backends/codex/index.js';
import { workspaceObserver } from './backends/shared/workspace-observer.js';
import { traexFlavor } from './backends/codex/flavors.js';
import { ClaudeBackendAdapter } from './backends/claude/index.js';
import { configDirOf } from './backends/claude/launch.js';
import { findClaudeTranscript } from './backends/claude/history.js';
import { DshBackendAdapter } from './backends/dsh/index.js';
import { DroidBackendAdapter } from './backends/droid/index.js';
import { PiBackendAdapter } from './backends/pi/index.js';
import { ChatBackendAdapter } from './backends/chat/index.js';
import { QuickChatSweeper, quickChatProject } from './chat/quick-chat.js';
import { NativeBackendRegistry } from './backends/registry.js';
import { PluginBackends } from './backends/plugin-backends.js';
import { NativeBackendService } from './backends/service.js';
import { LiveTranscriptIndex } from './search/live-index.js';
import { isNativeBackendId } from './backends/registry.js';
import { StatsBackfill } from './stats/backfill.js';
import { StatsLedger } from './stats/ledger.js';
import { registerStatsRoutes } from './stats/routes.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBackendRoutes } from './routes/backends.js';
import { registerProjectRoutes } from './routes/projects.js';
import { patchSession, registerSessionRoutes } from './routes/sessions.js';
import { registerBrowserDiagnosticsRoutes } from './routes/browser-diagnostics.js';
import { registerMarkRoutes } from './routes/marks.js';
import { registerWorkItemRoutes } from './routes/work-items.js';
import { AssistantBoard, Supervision, WorkItemService, assistantProject, type AssistantWork } from './work-items/index.js';
import { ensureAssistantHome, type AssistantHome } from './assistant/home.js';
import { AssistantStanding } from './assistant/standing.js';
import { AssistantRuns } from './assistant/runs.js';
import { AssistantDelegations } from './assistant/delegations.js';
import { Consolidation } from './assistant/consolidation.js';
import { nextCronTime, parseCron } from './orchestration/cron.js';
import { assistantSearch } from './search/assistant-search.js';
import { savedDefaultBackendId } from './session-identity.js';
import { registerShareRoutes } from './routes/shares.js';
import { ShareService } from './shares/service.js';
import { SessionDeletion } from './session-deletion.js';
import { registerSessionDeletionRoutes } from './routes/session-deletion.js';
import { registerNativeRoutes } from './routes/native.js';
import { registerTerminalRoutes } from './routes/terminals.js';
import { registerWorkspaceRoutes } from './routes/workspace.js';
import { registerGitRoutes } from './routes/git.js';
import { registerOrchestrationRoutes } from './routes/orchestration.js';
import { OrchestrationService } from './orchestration/service.js';
import { sessionReferenceInputs } from './context-references/input.js';
import { SessionReferenceService } from './context-references/service.js';
import { SessionCommands } from './orchestration/session-commands.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerThemeRoutes } from './routes/themes.js';
import { registerExtensionRoutes } from './routes/extensions.js';
import type { Plugin } from '@riffet/plugin-api';
import { PluginRegistry } from './plugins/registry.js';
import { provideModelSources } from './backends/shared/model-source.js';
import { registerPluginRoutes } from './plugins/routes.js';
import { TaskService } from './tasks/service.js';
import { registerTaskRoutes } from './tasks/routes.js';
import { isOpen } from './tasks/store.js';
import { registerCommandRoutes } from './plugins/commands.js';
import { AppearanceService } from './appearance/index.js';
import { registerAppearanceRoutes } from './appearance/routes.js';
import { OwnerService } from './owner/index.js';
import { registerOwnerRoutes } from './owner/routes.js';
import { registerUpdateRoutes } from './routes/update.js';
import { registerServiceRoutes } from './routes/service.js';
import { TimelineService } from './timeline/service.js';
import { SessionMedia } from './timeline/media.js';
import { TurnSummaryService } from './turn-summary/service.js';
import { TranscriptIngest } from './sync/ingest.js';
import { JournalFeed, latestEvents } from './journal/feed.js';
import { DispatchFeed } from './backends/dispatch-feed.js';
import { SyncService } from './sync/service.js';
import { registerSyncRoutes } from './routes/sync.js';
import type { NativeMessageBody, RouteDeps } from './routes/deps.js';
import { AGENT_PROCESS_BUDGET, DEFAULT_QUICK_CHAT_PRESETS, PROTOCOL_INFO, type NativeRunInput } from '../../../packages/contracts/src/index.js';
import { TaskWorkspaceService } from './task-workspaces/index.js';
import { RiffetMcpCredentials } from './riffet-mcp/credentials.js';
import { NoticeLog } from './riffet-mcp/notices.js';
import { RiffetMcpService } from './riffet-mcp/service.js';
import { DeviceChannel } from './riffet-mcp/devices.js';
import { DeviceAdb, type AdbRunner } from './riffet-mcp/adb.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { ApnsClient, type ApnsTransport } from './push/apns.js';
import { PushService, type PushTiming } from './push/service.js';
import { registerPushRoutes } from './push/routes.js';
import { readServerId } from './server-id.js';
import { ChannelService } from './channels/service.js';
import type { ChannelProvider } from './channels/types.js';
import { feishuProvider } from './channels/feishu/index.js';
import { registerChannelRoutes } from './channels/routes.js';
import { RIFFET_MCP_ROUTE, registerRiffetMcpRoutes } from './routes/riffet-mcp.js';

export interface AppOptions { stateDir?:string; cliPath?:string; host?:string; token?:string; auth?:boolean; allowedHosts?:string[]; webRoot?:string; logger?:boolean; instanceId?:string;
  /** The trusted launcher may provide the system Documents directory; saved settings win. */
  taskWorkspaceDefaultRoot?:string;
  /** CPU-profile severe event-loop stalls into `<stateDir>/diagnostics`; only the served daemon does. */
  profileStalls?:boolean;
  /** Defaults to the built-in list (docs/PLUGIN_ARCHITECTURE.md). */
  plugins?:readonly Plugin[];
  /** The port the server will listen on, known before it does: an installed package's process may not connect to it (docs/PLUGIN_ARCHITECTURE.md "执行位置"). */
  port?:number;
  /** Replaces the process runner behind the device adb shortcut; tests only. */
  adbRunner?:AdbRunner;
  /** Replaces the APNs connection and the push delays; tests only. */
  push?:{transport?:ApnsTransport;retryDelaysMs?:number[];timing?:PushTiming};
  /** Replaces the built-in IM providers (docs/design/channels.md); tests only. */
  channelProviders?:ChannelProvider[]; }
export async function createApp(options: AppOptions = {}) {
  const stateDir=resolve(options.stateDir??join(homedir(),'.local/share/riffet'));
  await mkdir(stateDir,{recursive:true,mode:0o700});
  migratePluginStorage(stateDir);
  setAppServerOwner(createHash('sha256').update(stateDir).digest('hex').slice(0,12));
  // Resolve the daemon's environment before anything reads it: settings fall back to process.env,
  // and a backend CLI is resolved against PATH.
  await applyProcessEnvironment({stateDir});
  const legacyCliPath=options.cliPath??process.env.RIFFET_CLI??'cursor-agent';
  // A config that is about to be saved is checked by the driver of the backend it belongs to.
  const settings:SettingsService=new SettingsService({cliPath:legacyCliPath,stateDir,validateProfileConfig:(backendId,config)=>nativeBackends.catalog.validateProfileConfig(backendId,config),consumesModelSources:backendId=>nativeBackends.catalog.consumesProtocols(backendId).length>0});
  const themes=new ThemeService({stateDir});
  const owner=new OwnerService({stateDir,avatarStyles:()=>plugins});
  const store=new Store(join(stateDir,'workbench.db')); store.recoverInterruptedRuns();
  // Checkpoints of the write-ahead log run on a thread of their own, not inside whichever commit crosses the limit.
  const stopWalCheckpoints=startWalCheckpoints(store.db,store.path);
  const contextReferences:SessionReferenceService=new SessionReferenceService(store,stateDir,(id,maxBytes,signal):Promise<import('../../../packages/contracts/src/index.js').NativeWorkbenchEvent[]|undefined>=>nativeBackends.contextTranscript(id,maxBytes,signal));
  const taskWorkspaces=new TaskWorkspaceService({store,settings,stateDir,defaultRoot:options.taskWorkspaceDefaultRoot??process.env.RIFFET_TASK_WORKSPACE_ROOT,
    deniedRoots:()=>[
      ...backendRegistry.list().flatMap(driver=>nativeBackends.catalog.profileSettings(driver.id).profiles.flatMap(profile=>profile.configDir?[resolve(expandHome(profile.configDir))]:[])),
      ...['CODEX_HOME','TRAE_HOME','TRAECLI_HOME','CURSOR_CONFIG_DIR','RIFFET_CONFIG_DIR'].flatMap(key=>process.env[key]?.trim()?[resolve(expandHome(process.env[key]!.trim()))]:[]),
    ]});
  // Spaces were removed in 0.6.0; the database migration drops their tables, and these files have no reader left.
  await Promise.all([
    rm(join(stateDir,'space-assets'),{recursive:true,force:true}).catch(()=>undefined),
    rm(join(stateDir,'space-credentials'),{recursive:true,force:true}).catch(()=>undefined),
  ]);
  // What the journal's logs gain, read back as native events for the dispatcher, the index and statistics (sync v3).
  const journalFeed=new JournalFeed(store.journal);
  const stats=new StatsLedger(store);
  const auth=new Auth(stateDir,options);
  // Each conversation's Riffet MCP server (docs/DEVICES.md §2): built before the backends, whose launches carry it.
  const riffetMcpCredentials=new RiffetMcpCredentials(store,stateDir);
  const notices=new NoticeLog(store);
  riffetMcpCredentials.prune(id=>{try{return !store.getSession(id).archivedAt;}catch{return false;}});
  let orchestrationRef:OrchestrationService|undefined;
  const workspace=new WorkspaceService({stateDir});
  // Paired devices' calls and leases (docs/DEVICES.md §3); leases follow the scheduler's wake-ups.
  const devices=new DeviceChannel({store,auth,workspace,pendingWakeups:()=>orchestrationRef?.pendingWakeups()??[]});
  const adb=new DeviceAdb(options.adbRunner?{runner:options.adbRunner,locate:()=>'adb'}:{});
  let workItemsRef:WorkItemService|undefined;
  let assistantRef:AssistantBoard|undefined;
  let assistantWork:AssistantWork|undefined;
  let assistantDelegationsRef:AssistantDelegations|undefined;
  // Made below the routes' dependencies, which reach them through these.
  let reclaimerRef:AgentReclaimer|undefined;
  let assistantMainRef:(()=>string|undefined)|undefined;
  const riffetMcp=new RiffetMcpService({workItems:()=>workItemsRef,assistant:()=>assistantRef,store,auth,contextReferences,credentials:riffetMcpCredentials,notices,devices,workspace,orchestration:()=>{if(!orchestrationRef)throw new AppError('SERVICE_STARTING','The workbench is starting',503);return orchestrationRef;},plugins:()=>plugins});
  // A state directory in the system temp directory is a test's, a probe's or a demo's: its tmux server goes with it.
  const terminal:TerminalService=new TerminalService(store,{stateDir,ephemeral:isTempStateDir(stateDir),behaviour:{resolve:target=>nativeBackends.terminalBehaviour(target),launchEnv:()=>nativeBackends.catalog.terminalLaunchEnv()}});
  const git=new GitService({stateDir});
  const sessionLock=new SessionLock();
  let listening:(()=>unknown)|undefined;
  const plugins=new PluginRegistry({stateDir,serverPorts:()=>{const address=listening?.();return [...(options.port?[options.port]:[]),...(address&&typeof address==='object'&&'port' in address&&typeof address.port==='number'?[address.port]:[])];},...(options.plugins?{plugins:options.plugins}:{}),invalidateModelCatalogs:()=>nativeBackends.catalog.invalidateModelCatalogs(),savedModelSources:()=>settings.savedModelSources(),agentProfiles:backendId=>isNativeBackendId(backendId)?settings.agentProfiles(backendId):[],agentBackendProvided:(id:string):boolean=>isNativeBackendId(id)&&backendRegistry.isCore(id),versionInUse:(pluginId:string,version:string):boolean=>{try{return tasks.usesPluginVersion(pluginId,version);}catch{return true;}},runningTasks:(pluginId:string):number=>{try{return tasks.runningCount(pluginId);}catch{return 0;}},startTask:(input):ReturnType<TaskService['start']>=>tasks.start(input),
    // docs/BROWSER.md §2: what a plugin with agent tools or channels may read and do in a conversation.
    sessions:{
      get:id=>{let session;try{session=store.getSession(id);}catch{return undefined;}let projectPath:string|undefined;try{projectPath=store.getProject(session.projectId).cwd;}catch{/* removed project */}return {id:session.id,title:session.title,projectId:session.projectId,...(projectPath?{projectPath}:{}),archived:Boolean(session.archivedAt)};},
      wake:(id,note)=>{if(!orchestrationRef)throw new AppError('SERVICE_STARTING','The workbench is starting',503);orchestrationRef.scheduleWakeup(id,{dueAt:new Date(),note});},
      notify:(id,notice)=>{notices.add({sessionId:id,...(notice.title?{title:notice.title}:{}),body:notice.body,source:'agent'});},
      saveImage:async(id,image)=>{const attachment=await workspace.upload(store.getProject(store.getSession(id).projectId),{name:image.name,mimeType:image.mimeType,dataBase64:image.data.toString('base64')});return {id:attachment.id,path:attachment.path};},
    }});
  provideModelSources(()=>plugins.modelSources(),source=>plugins.ensureContribution('model-source',source),source=>plugins.modelSourceRole(source));
  const claudeAdapter=new ClaudeBackendAdapter({stateDir});
  const backendRegistry=new NativeBackendRegistry()
    .register(new CodexBackendAdapter(undefined, undefined, plugins, {stateDir}))
    .register(claudeAdapter)
    .register(new DshBackendAdapter())
    .register(new DroidBackendAdapter())
    .register(new PiBackendAdapter({stateDir}))
    .register(new CodexBackendAdapter(undefined, traexFlavor, plugins))
    .register(new ChatBackendAdapter({stateDir,modelProfile:(backendId,profileId)=>nativeBackends.catalog.validateProfile(backendId,profileId),gatewayProfiles:backendId=>nativeBackends.catalog.gatewayProfiles(backendId),defaultModel:()=>settings.getSettings().auxiliaryModels?.chat,latestModel:except=>store.listSessions().find(session=>session.backendId==='chat'&&session.origin?.kind!=='discussion'&&session.id!==except&&session.model)?.model,presets:()=>settings.getSettings().quickChat?.presets??DEFAULT_QUICK_CHAT_PRESETS}));
  // The 助理's directory is made on first use, like its project; its files are checked once per server.
  let assistantHome:AssistantHome|undefined;
  // The 助理's background work (docs/ASSISTANT.md §7) is made further down; the standing conversation reaches it through these.
  let assistantRuns:AssistantRuns|undefined;
  let consolidation:Consolidation|undefined;
  const assistantStanding=new AssistantStanding({store,home:()=>assistantHome??=ensureAssistantHome(stateDir,assistantProject(store,stateDir).cwd),timeZone:()=>settings.getSettings().assistant?.timeZone,
    pending:{offer:()=>assistantRuns?.offerPending()??[],settle:delivered=>assistantRuns?.settlePending(delivered)},
    compacting:sessionId=>consolidation?.compacting(sessionId)});
  const nativeBackends=new NativeBackendService({store,terminal,workspace,runtime:sessionLock,registry:backendRegistry,stats,
    defaultProfileId:backendId=>settings.getSettings().nativeBackendDefaults?.[backendId]?.profileId,
    profiles:{get:backendId=>settings.getNativeBackendProfiles(backendId),getConfig:(backendId,profileId)=>settings.getNativeBackendProfileConfig(backendId,profileId)},
    riffetMcp, standing:assistantStanding, prepareContextInput:run=>contextReferences.render(run),
  });
  // A plugin's Agent backends are registered while it is enabled and withdrawn when it is not; evaluated by `refreshWithin` below.
  const pluginBackends=new PluginBackends({plugins,registry:backendRegistry,service:nativeBackends,workspaceObserver:workspaceObserver(stateDir)});
  pluginBackends.start();
  // Sync v3's ingest is attached before anything can open a conversation (the dispatcher resumes unfinished
  // runs at the first await below): a runtime built without it believes it writes the journal itself, and a
  // Codex one then logs its own draft chunks over the ones the transcript reads.
  const ingest=new TranscriptIngest({journal:store.journal,source:id=>nativeBackends.transcriptSource(id)});
  nativeBackends.attachIngest(ingest);
  // Evaluated only once the backends exist, since turning a plugin on refreshes their catalogs.
  await plugins.refreshWithin(1_500);
  // After the integrations: a task that ended while the server was down gets its diagnostics from the provider that started it.
  const tasks=new TaskService({stateDir,db:store.db,project:id=>store.getProject(id),providers:plugins});
  await tasks.recover();
  // A plugin turned off, or switched to another version, while it had running tasks goes ahead once the last one ends.
  tasks.subscribe((event:{state:Parameters<typeof isOpen>[0]})=>{if(!isOpen(event.state))plugins.tasksChanged();});
  // A Claude CLI that outlived the previous server posts hooks before any client opens its conversation: bring the conversation up for them.
  claudeAdapter.setHookWake(nativeSessionId=>nativeBackends.wakeNativeSession('claude',nativeSessionId));
  const dispatchRuntime={withSession:<T>(id:string,operation:()=>Promise<T>)=>sessionLock.withSession(id,operation),ensure:(session:import('../../../packages/contracts/src/index.js').Session,options?:{initialPrompt?:string;beforeSpawn?:()=>void|Promise<void>})=>nativeBackends.ensure(session,options)};
  // Every turn starts from a checkpoint of the project's uncommitted files, so it can be undone.
  // A project outside Git simply has none; checkpoint failure never fails the turn.
  const beforeTurn=async(session:import('../../../packages/contracts/src/index.js').Session,run:import('../../../packages/contracts/src/index.js').Run,late:()=>boolean)=>
    session.backendId==='chat'?undefined:git.createTurnCheckpoint(store.getProject(session.projectId),{sessionId:session.id,runId:run.id,title:run.prompt.trim().split('\n')[0]!.slice(0,120)||'Turn',late});
  const dispatch=new NativeDispatcher(store,new DispatchFeed({service:nativeBackends,feed:journalFeed,store}).backend(),dispatchRuntime,workspace,{beforeTurn});
  // A provider that keeps names of its own (Codex) is told whenever the workbench or the reader names a conversation.
  const renameNative=(session:import('../../../packages/contracts/src/index.js').Session)=>{void nativeBackends.rename(session).catch(()=>undefined);};
  const titles=new TitleService({store,titleModel:()=>settings.getSettings().auxiliaryModels?.title,gatewayProfiles:backendId=>nativeBackends.catalog.gatewayProfiles(backendId),onTitled:renameNative});
  /**
   * A plan is mirrored to Markdown beside Claude Code's own plans, so it can be read and grepped
   * without the workbench running. The transcript stays the authority; this copy is a cache that
   * nothing reads back, which is why every failure here is silent.
   */
  const planFiles=new PlanFileWriter({title:sessionId=>{try{return store.getSession(sessionId).title;}catch{return undefined;}},deleted:sessionId=>store.isSessionDeleted(sessionId)});
  /** See `LiveTranscriptIndex`. A plan mirrored late arrives with a later write; `record` writes a body only once. */
  const liveIndex=new LiveTranscriptIndex({store,onIndexed:(sessionId,events)=>{void planFiles.record(sessionId,events).catch(()=>undefined);}});
  // Every transcript the server reads is indexed as it is written, whether or not a stream relays it.
  const offIndexFeed=journalFeed.subscribe((_sessionId,lane)=>lane==='main',batch=>liveIndex.observeEntities(batch.sessionId,latestEvents(batch.items)));
  const offServiceFeed=nativeBackends.readJournal(journalFeed);
  const sessionCommands=new SessionCommands();
  const orchestration=new OrchestrationService({store,settings,nativeBackends,git,dispatch,sessionCommands,notices,onWakeup:wakeup=>devices.wakeupChanged(wakeup)});
  orchestrationRef=orchestration;
  const app=Fastify({logger:options.logger??false,bodyLimit:36*1024*1024,requestTimeout:60_000});
  listening=()=>app.server.address();
  await app.register(websocket,{options:{maxPayload:256*1024}});
  const streams=new Set<import('node:http').ServerResponse>();
  // Exact matches on the matched route pattern, so a shaped or encoded path stays guarded.
  const PUBLIC_API=new Set(['/api/auth/status','/api/auth/login','/api/devices/pair','/api/devices/prove','/api/client-reports']);
  // Read-only access to an explicit path outside the project (e.g. a /tmp screenshot the agent just
  // produced). Unset, it follows the binding: on for loopback, off once other machines can connect —
  // including through `tailscale serve` or a reverse proxy, which reach a loopback binding too.
  const loopbackBinding=['127.0.0.1','localhost','::1'].includes((options.host??'127.0.0.1').replace(/^\[|\]$/g,'').toLowerCase());
  const allowOutsideRead=(headers?:import('node:http').IncomingHttpHeaders)=>settings.getSettings().allowOutsideRead??(loopbackBinding&&!proxiedRequest(headers));
  const effectiveSettings=(headers?:import('node:http').IncomingHttpHeaders)=>({...effectiveSettingsForClient(headers,settings.getSettings(),backendRegistry.list().map(driver=>driver.id)),allowOutsideRead:allowOutsideRead(headers)});
  const monitor=new ServiceMonitor({store,terminal,streams,agentProcesses:()=>reclaimerRef?.report()});
  monitor.observe(app);
  app.addHook('onRequest',async(request,reply)=>{
    auth.checkOrigin(request);
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
    if (isApiRequest(request)) {
      reply.header('Cache-Control','no-store');
      const route=request.routeOptions?.url ?? apiRoutePath(request.url);
      // The Riffet MCP shim presents its conversation-bound credential to its own route only.
      if (route===RIFFET_MCP_ROUTE) return;
      if (auth.sharePreview(request)) return;
      if (!route || !PUBLIC_API.has(route)) auth.require(request,!['GET','HEAD','OPTIONS'].includes(request.method));
    }
  });
  registerProjectVisibilityHook(app,store);
  registerSessionVisibilityHook(app,id=>store.getSession(id));
  // Static assets negotiate their own encoding; this covers the JSON a phone fetches on every visit.
  app.addHook('onSend',async(request,reply,payload)=>{
    if(typeof payload!=='string'||payload.length<1024||reply.hasHeader('content-encoding')||!String(reply.getHeader('content-type')??'').startsWith('application/json'))return payload;
    if(encodingFor(request.headers['accept-encoding'],['gzip','identity'])!=='gzip')return payload;
    reply.header('Content-Encoding','gzip').header('Vary',[reply.getHeader('Vary'),'Accept-Encoding'].filter(Boolean).join(', ')).removeHeader('content-length');
    return await gzipAsync(payload);
  });
  app.setErrorHandler((error,_request,reply)=>{
    const typed=error as AppError;
    const status=typed.statusCode??500;
    reply.code(status).send({error:{code:typed.code??'INTERNAL_ERROR',message:status<500||(error instanceof AppError&&typed.code==='MODEL_CATALOG_UNAVAILABLE')?typed.message:'The local service could not complete this operation',...(error instanceof AppError&&typed.params?{params:typed.params}:{}),...(typed.details?{details:typed.details}:{})}});
    if (status>=500) app.log.error(error);
  });
  const readNativeInput=async(body:NativeMessageBody,options:{validateAttachments?:boolean}={}):Promise<NativeRunInput>=>{
    const text=requireString(body?.text,'text',100_000).trim();
    if(!text)throw new AppError('INVALID_PROMPT','Enter a message');
    if(body.attachments!==undefined&&(!Array.isArray(body.attachments)||body.attachments.length>20))throw new AppError('INVALID_ATTACHMENTS','Use at most 20 attachments');
    const attachmentIds=(body.attachments??[]).map(item=>requireString(item?.id,'attachment.id',100));
    // Metadata and a stat prove the file is there and intact; the bytes are read at delivery.
    if(options.validateAttachments!==false)for(const id of attachmentIds)await workspace.readAttachmentMetadata(id);
    if(body.context!==undefined&&(!Array.isArray(body.context)||body.context.length>20))throw new AppError('INVALID_CONTEXT','Use at most 20 file references');
    const context=(body.context??[]).map(item=>{
      const path=requireString(item?.path,'context.path',8192);
      if(item.line!==undefined&&(!Number.isSafeInteger(item.line)||item.line<1))throw new AppError('INVALID_LINE','Reference line must be a positive integer');
      return {path,...(item.line!==undefined?{line:item.line}:{})};
    });
    if(body.expectedConfigRevision!==undefined&&(!Number.isSafeInteger(body.expectedConfigRevision)||body.expectedConfigRevision<0))throw new AppError('INVALID_CONFIG_REVISION','Configuration revision must be a non-negative integer');
    const references=sessionReferenceInputs(body.references);
    return {text,attachmentIds,context,...(references?{references}:{})};
  };
  const nativeRuns=(id:string)=>[...new Map([...store.listRecentNativeRuns(id).reverse(),...store.listUnfinishedNativeRuns(id)].map(run=>[run.id,run])).values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  // Sync v3 (docs/SYNC-V3.md): the journal folded into timeline rows, and each backend's transcript read into the journal while a stream needs it.
  const timeline=new TimelineService({db:store.db,journal:store.journal,listRuns:id=>store.listRuns(id),onRunChanged:listener=>store.onRunChanged(listener),
    listJobs:id=>nativeBackends.listJobs(id),onJobChanged:listener=>nativeBackends.onJobChanged(listener),
    nativeChatId:id=>{try{const session=store.getSession(id);return session.nativeSessionId;}catch{return undefined;}},deleted:id=>store.isSessionDeleted(id)});
  // Canvas summaries are written on request, one turn at a time (docs/PLUGIN_ARCHITECTURE.md, canvas).
  const turnSummaries=new TurnSummaryService({db:store.db,deleted:id=>store.isSessionDeleted(id),summaryModel:()=>settings.getSettings().auxiliaryModels?.summary,gatewayProfiles:backendId=>nativeBackends.catalog.gatewayProfiles(backendId),source:async(sessionId,turn)=>{await timeline.ready(sessionId,'main');return timeline.turnText(sessionId,turn);}});
  const sessionMedia=new SessionMedia(sessionId=>timeline.namedPaths(sessionId),sessionId=>timeline.revision(sessionId),sessionId=>timeline.ready(sessionId,'main'),
    (sessionId,path,allowOutside)=>workspace.readPreviewImage(store.getProject(store.getSession(sessionId).projectId),path,{allowOutside}));
  const sync=new SyncService({timeline,ingest,getSession:id=>store.getSession(id),getRun:id=>store.getRun(id),runs:nativeRuns,subscribe:(id,listener)=>store.subscribe(id,listener),control:(id,listener)=>nativeBackends.watchControl(id,listener),queue:(id,status)=>dispatch.queue(id,status),metrics:id=>stats.sessionMetrics(id)});
  // Needs the timeline, so it is built here rather than beside orchestration. Unfinished turn cards are taken over once connected.
  const channels=new ChannelService({store,settings,nativeBackends,dispatch,sessionCommands,sessionLock,timeline,ingest,workspace,owner,stateDir,providers:options.channelProviders??[feishuProvider]});
  void channels.start().catch(error=>console.warn('[riffet] channels failed to start',error));
  const externalSessions=new ExternalSessions({store,settings,nativeBackends,auth});
  const terminalHolds=new TerminalHolds({store,nativeBackends,runtime:sessionLock,log:(message,fields)=>console.info(`[riffet] ${message}`,fields)});
  terminalHolds.start();
  const workItems=new WorkItemService(store,()=>({
    send:(sessionId,text,commandId)=>{orchestration.message(sessionId,text,commandId);},
    open:async(target,text,attach)=>(await orchestration.open(target,text,attach)).id,
  }));
  workItemsRef=workItems;
  assistantRef=new AssistantBoard({store,workItems,defaultBackend:()=>defaultBackendForClient(undefined,savedDefaultBackendId(settings.getSettings()),nativeBackends.offeredBackendIds()),
    search:assistantSearch,transcript:id=>nativeBackends.indexableTranscript(id),backends:()=>nativeBackends.catalog.listBackends(),automations:()=>orchestrationRef?.automations()??[],work:()=>assistantWork,dispatch:()=>settings.getSettings().assistant?.dispatch??'edits'});
  const deps:RouteDeps={assistantDelegations:()=>assistantDelegationsRef,assistantRuns:()=>assistantRuns,restartAssistant:()=>{const id=assistantMainRef?.();if(id)reclaimerRef?.restartWhenRested(id);},workItems,channels,stateDir,contextReferences,store,auth,settings,taskWorkspaces,themes,owner,terminal,workspace,git,sessionLock,nativeBackends,plugins,tasks,dispatch,orchestration,titles,riffetMcp,devices,adb,notices,streams,monitor,sessionCommands,allowOutsideRead,effectiveSettings,renameNative,readNativeInput,nativeRuns,externalSessions,terminalHolds};
  registerAuthRoutes(app,deps);
  registerBackendRoutes(app,deps);
  // `serverId` stays across restarts (pushes name it as `server`); `instanceId` is this process.
  // Unauthenticated on purpose: iOS reads it here to match a push to its server before it signs in; it is an id, not a credential.
  const serverId=readServerId(stateDir);
  app.get('/health',async()=>({ok:true,version:SERVER_VERSION,build:SERVER_BUILD,instanceId:options.instanceId,serverId,managedBy:LAUNCHED_BY,protocol:PROTOCOL_INFO}));
  registerUpdateRoutes(app);
  registerServiceRoutes(app,deps);
  registerProjectRoutes(app,deps);
  registerSessionRoutes(app,deps);
  registerExternalSessionRoutes(app,deps);
  registerMarkRoutes(app,deps);
  registerWorkItemRoutes(app,deps);
  const shares=new ShareService(deps);
  registerShareRoutes(app,deps,shares);
  const deletion=new SessionDeletion({store,stateDir,sessionCommands,sessionLock,dispatch,nativeBackends,terminal,ingest,liveIndex,timeline,turnSummaries,shares,orchestration,notices,riffetMcp,planFiles,
    onCleanupError:(sessionId,error)=>app.log.warn({err:error,sessionId},'deleted conversation file cleanup failed; retrying on next start')});
  registerSessionDeletionRoutes(app,deletion);
  void deletion.resumeCleanup();
  const clientLogs=new ClientLogs(join(stateDir,'client-logs'));
  app.post<{Body:{name?:unknown;content?:unknown}}>('/api/client-logs',async(request)=>clientLogs.save(request.body?.name,request.body?.content));
  registerBrowserDiagnosticsRoutes(app,join(stateDir,'diagnostics','browser'));
  registerNativeRoutes(app,deps);
  registerSyncRoutes(app,{...deps,sync,timeline,turnSummaries,sessionMedia});
  registerTerminalRoutes(app,deps);
  registerWorkspaceRoutes(app,deps);
  registerGitRoutes(app,deps);
  registerOrchestrationRoutes(app,deps);
  registerSettingsRoutes(app,deps);
  registerThemeRoutes(app,deps);
  registerExtensionRoutes(app,deps);
  registerPluginRoutes(app,deps);
  registerTaskRoutes(app,deps);
  registerCommandRoutes(app,deps);
  registerAppearanceRoutes(app,{appearance:new AppearanceService(plugins)});
  registerOwnerRoutes(app,deps);
  registerRiffetMcpRoutes(app,deps);
  registerDeviceRoutes(app,deps);
  registerChannelRoutes(app,deps);
  // Background pushes to iOS devices, straight to APNs with the owner's key (docs/DEVICES.md §3「后台推送」).
  const apns=new ApnsClient({stateDir,...(options.push?.transport?{transport:options.push.transport}:{}),...(options.push?.retryDelaysMs?{retryDelaysMs:options.push.retryDelaysMs}:{})});
  const push=new PushService({serverId,store,auth,devices,apns,timing:options.push?.timing,
    interaction:session=>nativeBackends.interaction(session),
    latestReply:async sessionId=>{await timeline.ready(sessionId,'main');const turn=timeline.outline(sessionId,'main',1).turns.at(-1);return turn?timeline.turnText(sessionId,turn.turn)?.answer:undefined;}});
  devices.pushRoute=(deviceId,platform)=>push.route(deviceId,platform);
  registerPushRoutes(app,{apns,push});
  // The shim reads the server's address from its credential file; it moves on every start.
  app.addHook('onListen',async()=>{
    const address=app.server.address();
    if(!address||typeof address==='string')return;
    const host=['0.0.0.0','::',''].includes(address.address)?'127.0.0.1':address.family==='IPv6'?`[${address.address}]`:address.address;
    try{riffetMcpCredentials.setUrl(`http://${host}:${address.port}`);}catch(error){app.log.warn({err:error},'Riffet MCP credential refresh failed');}
  });

  registerWebAssets(app, options.webRoot);
  // The math page and its KaTeX assets: the same engine the web bundle uses, for clients that have
  // no TeX renderer of their own (see `math-assets.ts`).
  registerMathAssets(app);
  registerDiagramAssets(app);
  registerContentPreview(app);
  app.addHook('preClose',async()=>{for(const stream of streams)stream.end();});
  registerStatsRoutes(app,{store,auth,subscribe:listener=>stats.subscribe(listener),streams,
    profileLabel:(backendId,profileId)=>isNativeBackendId(backendId)?settings.getNativeBackendProfiles(backendId).profiles.find(profile=>profile.id===profileId)?.name:undefined,
    backendLabel:backendId=>isNativeBackendId(backendId)?backendRegistry.get(backendId)?.label:undefined});
  const statsBackfill=new StatsBackfill({store,ledger:stats,backendIds:()=>nativeBackends.usageTranscriptBackendIds(),read:(sessionId,known)=>nativeBackends.usageTranscript(sessionId,known),busy:()=>eventLoopBusy()});
  // Not app.log: the daemon runs without a Fastify logger, and a stall nobody sees is the problem this reports.
  const loopHealthMonitor=startLoopHealth({warn:(fields,message)=>console.warn(`[riffet] ${message}`,fields)},options.profileStalls?join(stateDir,'diagnostics'):undefined);
  monitor.start();
  const reclaimer=new AgentReclaimer({store,terminal,nativeBackends,runtime:sessionLock,settings:()=>settings.getSettings(),log:(message,fields)=>console.info(`[riffet] ${message}`,fields),usageFile:join(stateDir,'agent-usage.json'),sweepOrphans:()=>sweepOrphanTmuxServers({ownSocket:terminal.socket,graceMs:AGENT_PROCESS_BUDGET.orphanGraceMinutes*60_000})});
  reclaimer.start();
  reclaimerRef=reclaimer;
  // Made before anyone can ask for it, so a phone opening the list sees it at once. A failure costs quick chat, not the server.
  try{quickChatProject(store,stateDir);}catch(error){console.warn('[riffet] quick chat project unavailable',error);}
  try{assistantHome=ensureAssistantHome(stateDir,assistantProject(store,stateDir).cwd);}catch(error){console.warn('[riffet] assistant project unavailable',error);}
  const stopAssistantWatch=assistantStanding.watch();
  // ---- The 助理's background runs (docs/ASSISTANT.md §7) ----
  const ownerZone=()=>settings.getSettings().assistant?.timeZone??Intl.DateTimeFormat().resolvedOptions().timeZone;
  const assistantMain=()=>{try{const id=assistantProject(store,stateDir).mainSessionId;if(!id)return undefined;return store.getSession(id).archivedAt?undefined:id;}catch{return undefined;}};
  // Set while a background run adds its notice: its push is the run's own.
  let addingForRun=false;
  // Made below: a queued run asks it whether it is still wanted.
  let supervision:Supervision|undefined;
  const runs=new AssistantRuns({store,settings:()=>settings.getSettings(),backends:()=>nativeBackends.catalog.listBackends(),project:()=>assistantProject(store,stateDir),
    start:(body,text,origin,ids)=>orchestration.start(body,text,origin,ids),
    archive:async sessionId=>{await patchSession(deps,sessionId,{archived:true});},
    remove:async sessionId=>{await deletion.delete(sessionId,[sessionId]);},
    markStuck:(workItemId,note)=>workItems.markStuck(workItemId,note),
    notice:(sessionId,body)=>{addingForRun=true;try{notices.add({sessionId,body,source:'agent'});}finally{addingForRun=false;}},
    push:(sessionId,body,key)=>push.notice(sessionId,body,key),
    wanted:run=>{
      const assistant=settings.getSettings().assistant;
      if(run.job==='supervise')return Boolean(run.subject&&supervision?.wanted(run.subject,run.key));
      if(run.job==='consolidate')return assistant?.consolidation!==false;
      try{return Boolean(run.subject&&assistantDelegationsRef?.get(run.subject).state==='active');}catch{return false;}
    }});
  runs.mainSession=assistantMain;
  assistantMainRef=assistantMain;
  // What an agent tells the owner with notify_user, or a wake-up's notice, reaches their phone too; a background run
  // pushes its own, and records whether it went out (docs/ASSISTANT.md §7.1).
  const stopNoticePush=notices.subscribe(notice=>{
    if(addingForRun)return;
    void push.notice(notice.sessionId,[notice.title,notice.body].filter(Boolean).join(' · '),`notice-${notice.id}`).catch(()=>undefined);
  });
  assistantRuns=runs;
  const queue=(job:'supervise'|'consolidate'|'delegation',key:string,brief:Record<string,string|number>,subject?:string)=>{const before=runs.has(key);return runs.enqueue(job,key,brief,subject).state==='queued'&&!before;};
  const delegations=new AssistantDelegations({store,timeZone:ownerZone,nextCron:(cron,after,zone)=>nextCronTime(parseCron(cron),after,zone),
    fire:({delegation,reason,payload,key})=>{queue('delegation',key,{goal:delegation.goal,attention:delegation.attention,trigger:JSON.stringify(delegation.trigger),until:delegation.until,cursor:delegation.cursor??'（还没有）',reason,payload:payload||'（没有附带内容）'},delegation.id);},
    expired:delegation=>runs.addPending(undefined,`委托「${delegation.goal.slice(0,80)}」已到期结束。`),
    changed:()=>store.workItemsChanged()});
  assistantDelegationsRef=delegations;
  consolidation=new Consolidation({store,cwd:()=>assistantProject(store,stateDir).cwd,mainSessionId:assistantMain,timeZone:ownerZone,
    enabled:()=>settings.getSettings().assistant?.consolidation!==false,
    enqueue:(key,brief)=>queue('consolidate',key,brief),has:key=>runs.has(key),
    keepAlive:async sessionId=>{
      const session=store.getSession(sessionId);
      if(session.backendId!=='claude'||!session.backendProfileId)return;
      const configDir=configDirOf({config:settings.getNativeBackendProfileConfig('claude',session.backendProfileId)??{}} as Parameters<typeof configDirOf>[0]);
      const at=new Date();
      for(const id of new Set([session.nativeSessionId,...session.previousNativeSessionIds??[]].filter((value):value is string=>Boolean(value)))){
        const path=await findClaudeTranscript(configDir,id);
        if(path)await utimes(path,at,at);
      }
    }});
  supervision=new Supervision({store,workItems,enabled:()=>settings.getSettings().assistant?.supervision===true,
    enqueue:(key,brief,workItemId)=>{queue('supervise',key,brief,workItemId);},pending:workItemId=>runs.pending('supervise',workItemId),
    agentLabel:backendId=>(backendId&&isNativeBackendId(backendId)?backendRegistry.get(backendId)?.label:undefined)??backendId??'Agent'});
  assistantWork={
    report:(sessionId,outcome,text)=>runs.report(sessionId,outcome,text,assistantMain()) as {outcome:string},
    supervised:sessionId=>{const run=runs.bySession(sessionId);return run?.job==='supervise'&&run.subject?{workItemId:run.subject,runId:run.id}:undefined;},
    delegations:{list:()=>delegations.list(),create:input=>delegations.create(input),update:(id,input)=>delegations.update(id,input),end:(id,by)=>delegations.end(id,by)},
  };
  const stopAssistantWork=[runs.watch(),delegations.start(),consolidation.start(),supervision.start()];
  workItems.retitleBriefConversations();
  workItems.dropComposerItems();
  const quickChats=new QuickChatSweeper({store,settings:()=>settings.getSettings(),
    archive:sessionId=>patchSession(deps,sessionId,{archived:true}),
    log:(message,fields)=>console.info(`[riffet] ${message}`,fields)});
  quickChats.start();
  statsBackfill.start();
  titles.start();
  // Low-priority housekeeping, once the server is up: old attachments nothing recent refers to,
  // and exited terminal records nothing points at. Failures wait for the next start.
  const maintenance=setTimeout(()=>{
    const cutoff=new Date(Date.now()-RETENTION_MS).toISOString();
    try{store.pruneExitedTerminals(cutoff);}catch(error){app.log.warn({err:error},'terminal pruning failed');}
    let keep:Set<string>;
    try{keep=store.referencedAttachmentIds(cutoff);}catch(error){app.log.warn({err:error},'attachment pruning failed');return;}
    void workspace.pruneAttachments({olderThan:Date.now()-RETENTION_MS,keep}).catch(error=>app.log.warn({err:error},'attachment pruning failed'));
  },MAINTENANCE_DELAY_MS);
  maintenance.unref();
  // The log's own housekeeping (superseded draft chunks, unreferenced blobs): once after start-up, then now and then.
  const sweepJournal=()=>{void deletion.resumeCleanup();void contextReferences.sweep().catch(error=>app.log.warn({err:error},'context file pruning failed'));try{store.journal.maintain();}catch(error){app.log.warn({err:error},'journal maintenance failed');}};
  const journalSweep=setTimeout(sweepJournal,MAINTENANCE_DELAY_MS*2);journalSweep.unref();
  const journalSweepEvery=setInterval(sweepJournal,JOURNAL_SWEEP_MS);journalSweepEvery.unref();
  app.addHook('onClose',async()=>{
    // Each step runs even when an earlier one throws: a failed backend shutdown must not leave the database open.
    const steps:Array<[string,()=>unknown]>=[['assistant',()=>{stopAssistantWatch();stopNoticePush();for(const stop of stopAssistantWork)stop();}],['titles',()=>titles.close()],['turn-summaries',()=>turnSummaries.close()],['stats-backfill',()=>statsBackfill.close()],['orchestration',()=>orchestration.close()],['channels',()=>channels.close()],['push',()=>{push.close();apns.close();}],['devices',()=>devices.close()],['dispatch',()=>dispatch.close()],['reclaim',()=>reclaimer.stop()],['terminal-holds',()=>terminalHolds.stop()],['quick-chat',()=>quickChats.stop()],['sync-ingest',()=>ingest.close()],['plugin-backends',()=>pluginBackends.close()],['native-backends',()=>nativeBackends.closeAll()],['tasks',()=>tasks.close()],['integrations',()=>plugins.close()],['terminal',()=>terminal.closeAll()],['stats',()=>stats.close()],['work-items',()=>workItems.close()],['search-index',()=>{offIndexFeed();offServiceFeed();liveIndex.close();}],['loop-health',()=>loopHealthMonitor.stop()],['monitor',()=>monitor.stop()],['maintenance',()=>{clearTimeout(maintenance);clearTimeout(journalSweep);clearInterval(journalSweepEvery);}],['timeline',()=>timeline.close()],['journal-feed',()=>journalFeed.close()],['git',()=>git.close()],['wal-checkpoints',()=>stopWalCheckpoints()],['store',()=>store.close()]];
    for(const [name,step] of steps){
      try{await step();}catch(error){console.error(`[riffet] shutdown step ${name} failed:`,error);}
    }
  });
  return {app,workItems,assistant:assistantRef,assistantRuns:runs,assistantDelegations:delegations,channels,contextReferences,store,auth,riffetMcp,devices,push,notices,terminal,nativeBackends,plugins,tasks,dispatch,orchestration,workspace,git,settings,taskWorkspaces,themes,stateDir,timeline,ingest,quickChats};
}
const gzipAsync=promisify(gzip);
/** How often the journal drops superseded draft chunks and unreferenced blobs. */
const JOURNAL_SWEEP_MS = 6 * 60 * 60_000;
/** Attachments and exited terminals older than this, and unreferenced, are removed. */
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAINTENANCE_DELAY_MS = 60_000;
