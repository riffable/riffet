import { createHash } from 'node:crypto';
import { eventLoopBusy, startLoopHealth } from './loop-health.js';
import { LAUNCHED_BY, SERVER_BUILD, SERVER_VERSION } from './version.js';
import Fastify, { type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { mkdir, rm, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { encodingFor, registerWebAssets, WorkbenchDocumentProofs } from './static-assets.js';
import { registerMathAssets } from './math-assets.js';
import { registerDiagramAssets } from './diagram-assets.js';
import { registerContentPreview } from './previews/content.js';
import { registerPluginViewFrame } from './plugins/view-frame.js';
import { applyProcessEnvironment, expandHome } from './environment.js';
import { Store } from './store.js';
import { startWalCheckpoints } from './wal-checkpoint.js';
import { configureExecWorker, execWorkerStats, trimExecWorker } from './exec.js';
import { ServerCacheRegistry } from './memory/cache-registry.js';
import { serverProfileBudget, type ServerProfile } from './memory/profile.js';
import { startIntegrityCheck } from './storage/integrity.js';
import { Auth, type AuthContext, FILE_SITE_ROUTE, apiRoutePath, isApiRequest, proxiedRequest } from './auth.js';
import { AppError, requireString } from './errors.js';
import { clearAuxiliaryAuthCache, completeForPlugin, resolveAuxiliaryModel, streamForPlugin, type GatewayProfiles } from './auxiliary/models.js';
import { AuxiliaryStats } from './stats/auxiliary.js';
import { PlanFileWriter } from './native/plan-files.js';
import { TerminalService } from './terminal/index.js';
import { TitleService } from './titles/service.js';
import { WorkspaceService } from './workspace/index.js';
import { GitService } from './git/index.js';
import { instanceSettingsRead, instanceSettingCommand } from './settings/assistant.js';
import { agentDefaultsRead, agentDefaultsCommand } from './settings/assistant-agent-defaults.js';
import { sharedThemeRead, sharedThemeCommand, webThemeRead } from './themes/assistant.js';
import { SettingsService } from './settings/index.js';
import { ThemeService } from './themes/index.js';
import { codexGeneratedImageHomes, migratePluginStorage } from './compat.js';
import { SessionLock } from './agent-host/session-lock.js';
import { NativeDispatcher } from './native/dispatch.js';
import { buildSessionControlSnapshot } from './native/control.js';
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
import { registerTeamRoutes } from './routes/team.js';
import { registerPluginApprovalRoutes } from './routes/plugin-approvals.js';
import { PluginApprovals } from './plugins/approvals.js';
import { AssistantBoard, Supervision, Verification, WorkItemService, assistantInstructionsFile, assistantProject, isSystemCommand, type AssistantWork } from './work-items/index.js';
import { ensureAssistantHome, globalUserProfilePath, type AssistantHome } from './assistant/home.js';
import { AssistantStanding } from './assistant/standing.js';
import { AgentTeamService } from './assistant/team.js';
import { AssistantRuns } from './assistant/runs.js';
import { AssistantDelegations } from './assistant/delegations.js';
import { createAssistantWorkbenchQueries, workbenchReads } from './assistant/workbench-queries.js';
import { assistantEventsRead } from './assistant/plugin-events.js';
import { syncPluginPacks } from './assistant/plugin-packs.js';
import { Consolidation } from './assistant/consolidation.js';
import { nextCronTime, parseCron } from './orchestration/cron.js';
import { assistantSearch } from './search/assistant-search.js';
import { registerShareRoutes } from './routes/shares.js';
import { ShareService } from './shares/service.js';
import { SessionDeletion } from './session-deletion.js';
import { registerSessionDeletionRoutes } from './routes/session-deletion.js';
import { registerNativeRoutes } from './routes/native.js';
import { registerTerminalRoutes } from './routes/terminals.js';
import { registerDictationRoutes } from './routes/dictation.js';
import { registerWorkspaceRoutes } from './routes/workspace.js';
import { registerGitRoutes } from './routes/git.js';
import { registerOrchestrationRoutes } from './routes/orchestration.js';
import { OrchestrationService } from './orchestration/service.js';
import { CONTEXT_LIMITS, sessionReferenceInputs } from './context-references/input.js';
import { agentMentionInputs } from './native/agent-mentions.js';
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
import { registerQueryRoutes } from './plugins/queries.js';
import { AppearanceService } from './appearance/index.js';
import { attentionRead } from './work-items/assistant-tools.js';
import { CapabilityCatalog } from './riffet-mcp/capability-catalog.js';
import { WorkbenchAppearance } from './riffet-mcp/workbench-appearance.js';
import { registerWorkbenchAppearanceRoutes } from './routes/workbench-appearance.js';
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
import { registerTraceRoutes } from './routes/trace.js';
import type { NativeMessageBody, RouteDeps } from './routes/deps.js';
import { AGENT_PROCESS_BUDGET, ASSISTANT_BUDGET, CODE_INDEX_BUDGET, DEFAULT_AGENT_MEMBER_ID, DEFAULT_QUICK_CHAT_PRESETS, PROTOCOL_INFO, SERVER_BUDGET, SETTING_DEFAULTS, STORAGE_BUDGET, assistantChoice, memberChoice, titleTemplateKeepsTitle, workItemAgentChoice, type NativeRunInput, type SecurityActor, type SecurityEventKind } from '../../../packages/contracts/src/index.js';
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
import { LinkService } from './links/service.js';
import { linkPolicy } from './links/policy.js';
import { RoutePatterns, routeAccess, type Capability } from './access/capabilities.js';
import { grantsFor } from './access/grants.js';
import { secureTransport, trustedNetworks } from './access/transport.js';
import { SecurityAudit } from './access/audit.js';
import { acceptTlsOnSamePort, loadServerTlsIdentity } from './access/tls.js';
import { peerPath } from './links/forward.js';
import { linkOfRequest } from './links/socket.js';
import { LINK_TUNNEL_ROUTE, SERVER_FORWARD_ROUTE, registerLinkRoutes } from './routes/links.js';
import { ChannelService, channelProvider } from './channels/service.js';
import type { ChannelProvider } from './channels/types.js';
import type { StartupPhase } from './server-log.js';
import { registerChannelRoutes } from './channels/routes.js';
import { RIFFET_MCP_HTTP_ROUTE, RIFFET_MCP_ROUTE, registerRiffetMcpRoutes } from './routes/riffet-mcp.js';
import { CouncilService } from './council/service.js';
import { AgentCallService } from './agent-calls/service.js';
import { registerAgentCallRoutes } from './routes/agent-calls.js';
import { AgentSeats, councilProject } from './council/seats.js';
import { registerCouncilRoutes } from './routes/council.js';

export interface AppOptions { stateDir?:string; cliPath?:string; host?:string; token?:string; auth?:boolean; allowedHosts?:string[]; webRoot?:string; logger?:boolean; instanceId?:string;
  /** Networks whose traffic is already encrypted (a WireGuard or corporate VPN subnet); browsers there count as on an encrypted connection (docs/TRANSPORT-SECURITY.md §4). */
  trustedNetworks?:string[];
  /** Runtime memory profile: `full` (default hub) or `lite` (low-footprint peer node). */
  profile?:ServerProfile;
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
  channelProviders?:ChannelProvider[];
  /** Told as start-up enters each phase, so the served daemon can log where a slow start is. */
  onStartupPhase?:(phase:StartupPhase)=>void; }
export async function createApp(options: AppOptions = {}) {
  const profile:ServerProfile=options.profile??'full';
  const profileBudget=serverProfileBudget(profile);
  const lite=profile==='lite';
  const stateDir=resolve(options.stateDir??join(homedir(),'.local/share/riffet'));
  await mkdir(stateDir,{recursive:true,mode:0o700});
  migratePluginStorage(stateDir);
  setAppServerOwner(createHash('sha256').update(stateDir).digest('hex').slice(0,12));
  // Resolve the daemon's environment before anything reads it: settings fall back to process.env,
  // and a backend CLI is resolved against PATH.
  options.onStartupPhase?.('environment');
  await applyProcessEnvironment({stateDir});
  configureExecWorker({idleMs:profileBudget.execWorkerIdleMs});
  const legacyCliPath=options.cliPath??process.env.RIFFET_CLI??'cursor-agent';
  // A config that is about to be saved is checked by the driver of the backend it belongs to.
  const settings:SettingsService=new SettingsService({cliPath:legacyCliPath,stateDir,validateProfileConfig:(backendId,config)=>nativeBackends.catalog.validateProfileConfig(backendId,config),consumesModelSources:backendId=>nativeBackends.catalog.consumesProtocols(backendId).length>0});
  const themes=new ThemeService({stateDir});
  const owner=new OwnerService({stateDir,avatarStyles:()=>plugins});
  options.onStartupPhase?.('databases');
  const store=new Store(join(stateDir,'workbench.db'),{profile}); store.recoverInterruptedRuns();
  // 会话标题规则 (docs/SESSION-TITLES.md): read on every session write, so kept as of the last save rather than read from disk.
  const titleRuleConfig=(value:import('../../../packages/contracts/src/index.js').AppSettings)=>({rules:value.titleRules,timeZone:value.assistant?.timeZone});
  let titleRules=titleRuleConfig(settings.getSettings());
  store.configureTitleRules(()=>titleRules);
  store.refreshDisplayTitles();
  // Checkpoints of all three write-ahead logs run on one worker thread (full) or inline when idle (lite).
  const stopWalCheckpoints=startWalCheckpoints(
    store.layout
      ? [{ db: store.db, path: store.layout.control }, { db: store.journalDb, path: store.layout.journal }, { db: store.derivedDb, path: store.layout.derived }]
      : [{ db: store.db, path: store.path }],
    undefined,
    { mode: lite ? 'inline' : 'worker', idleMs: profileBudget.walWorkerIdleMs },
  );
  // The two databases that cannot be rebuilt are scanned once in a worker after start; skipped in lite mode.
  const cancelIntegrityCheck=startIntegrityCheck(stateDir,{enabled:store.layout!==undefined && !lite});
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
  const auxiliaryStats=new AuxiliaryStats(store.db,{onChanged:()=>stats.notifyChanged()});
  const recordAuxiliaryCall=(entry:import('./auxiliary/telemetry.js').AuxiliaryCallRecord)=>auxiliaryStats.record(entry);
  const auth=new Auth(stateDir,options);
  const securityAudit=new SecurityAudit(stateDir);
  // This server's TLS identity (docs/TRANSPORT-SECURITY.md §2); apps pin its fingerprint from the pairing code.
  const serverTls=loadServerTlsIdentity(stateDir,hostname().replace(/\.local$/i,'').slice(0,64)||'Riffet');
  // Each conversation's Riffet MCP server (docs/DEVICES.md §2): built before the backends, whose launches carry it.
  const riffetMcpCredentials=new RiffetMcpCredentials(store,stateDir);
  const notices=new NoticeLog(store);
  riffetMcpCredentials.prune(id=>{try{return !store.getSession(id).archivedAt;}catch{return false;}});
  let orchestrationRef:OrchestrationService|undefined;
  // A save from the workbench is the user's edit: a command running meanwhile does not claim the file.
  const workspace=new WorkspaceService({stateDir,noteWrite:file=>workspaceObserver(stateDir).noteEdit(file)});
  void workspace.writes.prune().catch(()=>undefined);
  // Paired devices' calls and leases (docs/DEVICES.md §3); leases follow the scheduler's wake-ups.
  const devices=new DeviceChannel({store,auth,workspace,pendingWakeups:()=>orchestrationRef?.pendingWakeups()??[],tlsFingerprint:serverTls.fingerprint});
  const adb=new DeviceAdb(options.adbRunner?{runner:options.adbRunner,locate:()=>'adb'}:{});
  let workItemsRef:WorkItemService|undefined;
  let assistantRef:AssistantBoard|undefined;
  let assistantWork:AssistantWork|undefined;
  let assistantDelegationsRef:AssistantDelegations|undefined;
  // Made below the routes' dependencies, which reach them through these.
  let reclaimerRef:AgentReclaimer|undefined;
  let assistantMainRef:(()=>string|undefined)|undefined;
  const workbenchAppearance=new WorkbenchAppearance(auth);
  const documentProofs=new WorkbenchDocumentProofs(store);
  const stopWatchingAppearance=store.onRunChanged(run=>{
    // A steer introduces another message into an existing turn. Its origin cannot inherit the owner's target.
    if(run.native?.intent==='steer' && run.native.ownerRunId) workbenchAppearance.release(run.native.ownerRunId);
    if(run.state!=='running' && run.state!=='queued') workbenchAppearance.release(run.id);
  });
  // Agent calls (docs/AGENT-CALLS.md) need the orchestration and the timeline made further down; the MCP tools and delivery reach them through this.
  let agentCallsRef:AgentCallService|undefined;
  let teamRef:AgentTeamService|undefined;
  const riffetMcp=new RiffetMcpService({agentCalls:()=>agentCallsRef,team:()=>teamRef,links:()=>linksRef,boundWorkItem:id=>assistantWork?.boundWorkItem?.(id),workbenchAppearance,activeWorkbenchRun:(sessionId):string|undefined=>{
    const session=store.getSession(sessionId);
    if(session.archivedAt || session.state==='archived') return undefined;
    const project=store.getProject(session.projectId);
    if(project.system!=='assistant' || project.archivedAt || project.mainSessionId!==sessionId || session.origin?.kind==='assistant') return undefined;
    const member=teamRef?.resolveFor(project,session);
    if(member && !member.capabilities.workbenchAdmin) return undefined;
    const turn=nativeBackends.ownedForegroundTurn(sessionId);
    if(!turn) return undefined;
    const run=store.getRun(turn.ownerRunId);
    if(run.sessionId!==sessionId || run.state!=='running' || !run.native || run.native.intent
      || run.native.nativeSessionId!==turn.nativeSessionId || (run.native.nativeTurnId && run.native.nativeTurnId!==turn.turnId)) return undefined;
    return run.id;
  },workItems:()=>workItemsRef,assistant:()=>assistantRef,store,auth,contextReferences,credentials:riffetMcpCredentials,notices,devices,workspace,orchestration:()=>{if(!orchestrationRef)throw new AppError('SERVICE_STARTING','The workbench is starting',503);return orchestrationRef;},plugins:()=>plugins,composerTasks:()=>settings.getSettings().workItems?.composerSessions===true});
  // A state directory in the system temp directory is a test's, a probe's or a demo's: its tmux server goes with it.
  const terminal:TerminalService=new TerminalService(store,{stateDir,ephemeral:isTempStateDir(stateDir),shellSettings:()=>settings.getSettings().terminal,behaviour:{resolve:target=>nativeBackends.terminalBehaviour(target),launchEnv:()=>nativeBackends.catalog.terminalLaunchEnv()}});
  // Warm CLIs a previous process reserved have no page left to renew them.
  void terminal.endPreviousWarmupsOnce().catch(error=>console.warn('[riffet] warm terminals of an earlier process were not ended',error));
  const git=new GitService({stateDir});
  const sessionLock=new SessionLock();
  let listening:(()=>unknown)|undefined;
  // docs/TASK-BOARD.md §7: what in-process plugins ask the owner to approve (`host.approvals`); the inbox's 要你回答 lists it.
  const pluginApprovals=new PluginApprovals({db:store.db,pluginName:id=>plugins.pluginName(id),
    decide:async(pluginId,id,actionId)=>{const {handler,signal}=await plugins.approvalHandler(pluginId);return handler.decide(id,actionId,{signal});},
    opened:approval=>{void push.approval(approval).catch(()=>undefined);}});
  const plugins=new PluginRegistry({stateDir,serverPorts:()=>{const address=listening?.();return [...(options.port?[options.port]:[]),...(address&&typeof address==='object'&&'port' in address&&typeof address.port==='number'?[address.port]:[])];},...(options.plugins?{plugins:options.plugins}:{}),invalidateModelCatalogs:()=>{clearAuxiliaryAuthCache();nativeBackends.catalog.invalidateModelCatalogs();},savedModelSources:()=>settings.savedModelSources(),agentProfiles:backendId=>isNativeBackendId(backendId)?settings.agentProfiles(backendId):[],agentBackendProvided:(id:string):boolean=>isNativeBackendId(id)&&backendRegistry.isCore(id),versionInUse:(pluginId:string,version:string):boolean=>{try{return tasks.usesPluginVersion(pluginId,version);}catch{return true;}},runningTasks:(pluginId:string):number=>{try{return tasks.runningCount(pluginId);}catch{return 0;}},startTask:(input):ReturnType<TaskService['start']>=>tasks.start(input),
    // docs/PLUGIN_ARCHITECTURE.md「模型用途」: a completion on the model chosen for the use, else its fallback (`default` or `chat`).
    completeModel:(request,uses):Promise<string>=>completeForPlugin(request,uses,{default:()=>settings.getSettings().auxiliaryModels?.default,chat:()=>settings.getSettings().auxiliaryModels?.chat,use:id=>settings.getSettings().pluginModels?.[id]},(backendId):ReturnType<GatewayProfiles>=>nativeBackends.catalog.gatewayProfiles(backendId),{error:(code,message,status,details)=>new AppError(code,message,status,details),record:recordAuxiliaryCall}),
    streamModel:(request,uses):Promise<string>=>streamForPlugin(request,uses,{default:()=>settings.getSettings().auxiliaryModels?.default,chat:()=>settings.getSettings().auxiliaryModels?.chat,use:id=>settings.getSettings().pluginModels?.[id]},(backendId):ReturnType<GatewayProfiles>=>nativeBackends.catalog.gatewayProfiles(backendId),{error:(code,message,status,details)=>new AppError(code,message,status,details),record:recordAuxiliaryCall}),
    // docs/ASSISTANT.md §7.3: an event of an in-process plugin starts the runs of the delegations subscribed to its topic.
    emitAssistantEvent:(topic,payload,key)=>{if(!assistantDelegationsRef)throw new AppError('SERVICE_STARTING','The assistant is starting; emit again after activation',503);if(!plugins.assistantEventDeclared(topic))throw new AppError('PLUGIN_ASSISTANT_EVENT_UNAVAILABLE','The plugin is off; its events go nowhere',409);assistantDelegationsRef.pluginEvent(topic,payload,key);},
    approvals:{request:(pluginId,request)=>pluginApprovals.request(pluginId,request),withdraw:(pluginId,id)=>pluginApprovals.withdraw(pluginId,id)},
    // docs/PLUGINS.md「代码导航」: read-only, through the same scoped paths the project routes use.
    code:{
      status:id=>workspace.codeIndexStatus(store.getProject(id)),
      search:(id,q,options)=>workspace.symbolSearch(store.getProject(id),q,{types:options?.types===true,limit:Math.min(CODE_INDEX_BUDGET.maxSearchResults,Math.max(1,Math.floor(options?.limit??CODE_INDEX_BUDGET.searchResults)))}),
      definition:(id,query,signal)=>workspace.definition(store.getProject(id),query,signal),
      references:(id,query,signal)=>workspace.references(store.getProject(id),query,signal),
      outline:(id,filePath)=>workspace.outline(store.getProject(id),filePath),
    },
    // docs/BROWSER.md §2: what a plugin with agent tools or channels may read and do in a conversation.
    sessions:{
      get:id=>{let session;try{session=store.getSession(id);}catch{return undefined;}let projectPath:string|undefined;try{projectPath=store.getProject(session.projectId).cwd;}catch{/* removed project */}return {id:session.id,title:session.title,projectId:session.projectId,...(projectPath?{projectPath}:{}),archived:Boolean(session.archivedAt)};},
      wake:(id,note)=>{if(!orchestrationRef)throw new AppError('SERVICE_STARTING','The workbench is starting',503);orchestrationRef.scheduleWakeup(id,{dueAt:new Date(),note});},
      notify:(id,notice)=>{notices.add({sessionId:id,...(notice.title?{title:notice.title}:{}),body:notice.body,source:'agent'});},
      saveImage:async(id,image)=>{const attachment=await workspace.upload(store.getProject(store.getSession(id).projectId),{name:image.name,mimeType:image.mimeType,dataBase64:image.data.toString('base64')});return {id:attachment.id,path:attachment.path};},
      assistantMainSessionId:()=>assistantMainRef?.(),
    }});
  // A plugin turned off or uninstalled takes its approvals with it.
  const stopApprovalSweep=plugins.onChange(()=>{const ids=pluginApprovals.pluginIds();if(ids.length)void plugins.offPlugins(ids).then(off=>{for(const id of off)pluginApprovals.withdrawAll(id);}).catch(()=>undefined);});
  const appearance=new AppearanceService(plugins);
  provideModelSources(()=>plugins.modelSources(),source=>plugins.ensureContribution('model-source',source),source=>plugins.modelSourceRole(source));
  const claudeAdapter=new ClaudeBackendAdapter({stateDir});
  const backendRegistry=new NativeBackendRegistry()
    .register(new CodexBackendAdapter(undefined, undefined, plugins, {stateDir}))
    .register(claudeAdapter)
    .register(new DshBackendAdapter())
    .register(new DroidBackendAdapter())
    .register(new PiBackendAdapter({stateDir}))
    .register(new CodexBackendAdapter(undefined, traexFlavor, plugins))
    .register(new ChatBackendAdapter({stateDir,get catalog(){return nativeBackends.catalog;},gatewayProfiles:backendId=>nativeBackends.catalog.gatewayProfiles(backendId),defaultModel:()=>settings.getSettings().auxiliaryModels?.chat,latestModel:except=>store.listSessions().find(session=>session.backendId==='chat'&&session.origin?.kind!=='discussion'&&session.id!==except&&session.model)?.model,presets:()=>settings.getSettings().quickChat?.presets??DEFAULT_QUICK_CHAT_PRESETS,recordAuxiliaryCall}));
  // The 助理's directory is made on first use, like its project; its files are checked once per server.
  let assistantHome:AssistantHome|undefined;
  // The 助理's background work (docs/ASSISTANT.md §7) is made further down; the standing conversation reaches it through these.
  let assistantRuns:AssistantRuns|undefined;
  let consolidation:Consolidation|undefined;
  const team=new AgentTeamService({
    store,
    stateDir,
    defaultProject:()=>assistantProject(store,stateDir),
    defaultInstructions:text=>assistantInstructionsFile(store,stateDir,text),
    assistantSettings:()=>settings.getSettings().assistant,
    syncDefaultSettings:(target,extra)=>{
      settings.setSettings({assistant:{
        backendId:target?.backendId??null,
        profileId:target?.profileId??null,
        model:target?.model??null,
        ...(extra?.consolidation!==undefined?{consolidation:extra.consolidation}:{}),
        ...(extra?.dailyRuns!==undefined?{dailyRuns:extra.dailyRuns}:{}),
      }});
    },
    onMemberDeleted:id=>{
      assistantDelegationsRef?.endForMember(id,'owner');
      assistantRuns?.clearPending(id);
    },
    renderAvatar:(request,name)=>owner.renderGeneratedAvatar(request,name),
  });
  teamRef=team;
  const assistantStanding=new AssistantStanding({store,home:()=>assistantHome??=ensureAssistantHome(stateDir,assistantProject(store,stateDir).cwd),team:()=>team,
    compacting:sessionId=>consolidation?.compacting(sessionId)});
  const nativeBackends:NativeBackendService=new NativeBackendService({store,terminal,workspace,runtime:sessionLock,registry:backendRegistry,stats,
    defaultProfileId:backendId=>settings.getSettings().nativeBackendDefaults?.[backendId]?.profileId,
    profiles:{get:backendId=>settings.getNativeBackendProfiles(backendId),getConfig:(backendId,profileId)=>settings.getNativeBackendProfileConfig(backendId,profileId)},
    riffetMcp, standing:assistantStanding, prepareContextInput:async run=>{const input=await contextReferences.render(run);return agentCallsRef?await agentCallsRef.render(run,input):input;},
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
  options.onStartupPhase?.('plugins');
  await plugins.refreshWithin(1_500);
  // After the integrations: a task that ended while the server was down gets its diagnostics from the provider that started it.
  const tasks=new TaskService({stateDir,db:store.db,project:id=>store.getProject(id),providers:plugins});
  options.onStartupPhase?.('tasks');
  await tasks.recover();
  options.onStartupPhase?.('services');
  // A plugin turned off, or switched to another version, while it had running tasks goes ahead once the last one ends.
  tasks.subscribe((event:{state:Parameters<typeof isOpen>[0]})=>{if(!isOpen(event.state))plugins.tasksChanged();});
  // A Claude CLI that outlived the previous server posts hooks before any client opens its conversation: bring the conversation up for them.
  claudeAdapter.setHookWake(nativeSessionId=>nativeBackends.wakeNativeSession('claude',nativeSessionId));
  const dispatchRuntime={withSession:<T>(id:string,operation:()=>Promise<T>,options?:{detached?:boolean})=>options?.detached?sessionLock.withDetachedSession(id,operation):sessionLock.withSession(id,operation),ensure:(session:import('../../../packages/contracts/src/index.js').Session,options?:{initialPrompt?:string;beforeSpawn?:()=>void|Promise<void>})=>nativeBackends.ensure(session,options)};
  // Every turn starts from a checkpoint of the project's uncommitted files, so it can be undone.
  // A project outside Git simply has none; checkpoint failure never fails the turn.
  const beforeTurn=async(session:import('../../../packages/contracts/src/index.js').Session,run:import('../../../packages/contracts/src/index.js').Run,since:number)=>
    session.backendId==='chat'?undefined:git.createTurnCheckpoint(store.getProject(session.projectId),{sessionId:session.id,runId:run.id,title:run.prompt.trim().split('\n')[0]!.slice(0,120)||'Turn',since});
  const dispatch=new NativeDispatcher(store,new DispatchFeed({service:nativeBackends,feed:journalFeed,store}).backend(),dispatchRuntime,workspace,{beforeTurn,log:entry=>console.log(`[dispatch] ${JSON.stringify(entry)}`)});
  terminal.onSessionInputAvailable=sessionId=>{dispatch.kick(sessionId);};
  // A provider that keeps names of its own (Codex) is told whenever the workbench or the reader names a conversation.
  const renameNative=(session:import('../../../packages/contracts/src/index.js').Session)=>{void nativeBackends.rename(session).catch(()=>undefined);};
  const titles=new TitleService({store,titleModel:()=>resolveAuxiliaryModel(settings.getSettings(),'title'),replacedByRule:session=>{const rule=store.titleRuleFor(session);return Boolean(rule&&!titleTemplateKeepsTitle(rule.template));},gatewayProfiles:backendId=>nativeBackends.catalog.gatewayProfiles(backendId),onTitled:renameNative,record:recordAuxiliaryCall});
  settings.onSaved(saved=>{
    const next=titleRuleConfig(saved);
    if(JSON.stringify(next)===JSON.stringify(titleRules))return;
    titleRules=next;
    store.refreshDisplayTitles();
    // A rule that replaced titles outright may be gone: those conversations can have a model's title again.
    void titles.backfill().catch(()=>undefined);
  });
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
  const orchestration=new OrchestrationService({store,settings,nativeBackends,git,dispatch,sessionCommands,team:()=>team,notices,recordAuxiliaryCall,onWakeup:wakeup=>devices.wakeupChanged(wakeup)});
  orchestrationRef=orchestration;
  const app=Fastify({logger:options.logger??false,bodyLimit:36*1024*1024,requestTimeout:60_000});
  // Apps reach this port over TLS with the certificate pinned from the pairing code; browsers keep plain HTTP (docs/TRANSPORT-SECURITY.md §3).
  acceptTlsOnSamePort(app.server,serverTls);
  // Every route as registered, so `links/links.test.ts` can check that the link policy classifies each one.
  const registeredRoutes:Array<{method:string;url:string}>=[];
  // The same routes by pattern, so a request forwarded to a linked server is judged by the route it reaches there.
  const routePatterns=new RoutePatterns();
  app.addHook('onRoute',route=>{for(const method of [route.method].flat()){registeredRoutes.push({method:String(method),url:route.url});routePatterns.add(String(method),route.url);}});
  let linksRef:LinkService|undefined;
  listening=()=>app.server.address();
  await app.register(websocket,{options:{maxPayload:256*1024}});
  const streams=new Set<import('node:http').ServerResponse>();
  // Exact matches on the matched route pattern, so a shaped or encoded path stays guarded.
  const PUBLIC_API=new Set(['/api/auth/status','/api/auth/login','/api/devices/pair','/api/devices/prove','/api/client-reports',LINK_TUNNEL_ROUTE]);
  // Read-only access to an explicit path outside the project (e.g. a /tmp screenshot the agent just
  // produced). Unset, it follows the binding: on for loopback, off once other machines can connect —
  // including through `tailscale serve` or a reverse proxy, which reach a loopback binding too.
  const loopbackBinding=['127.0.0.1','localhost','::1'].includes((options.host??'127.0.0.1').replace(/^\[|\]$/g,'').toLowerCase());
  const allowOutsideRead=(headers?:import('node:http').IncomingHttpHeaders)=>settings.getSettings().allowOutsideRead??(loopbackBinding&&!proxiedRequest(headers));
  const effectiveSettings=async(headers?:import('node:http').IncomingHttpHeaders)=>({...await effectiveSettingsForClient(headers,settings.getSettings(),nativeBackends),allowOutsideRead:allowOutsideRead(headers)});
  const trusted=trustedNetworks(options.trustedNetworks);
  /** What the caller may do over the connection it came on (docs/TRANSPORT-SECURITY.md §4, §6). */
  const accessOf=(request:FastifyRequest)=>{
    const context=auth.authenticate(request);
    // A linked server's tunnel is TLS with pinned certificates (docs/SERVER-LINKS.md §6).
    const secure=context.kind==='link'||secureTransport(request,trusted);
    return {secure,granted:grantsFor(context,secure,{allowInsecureChat:settings.getSettings().allowInsecureChat})};
  };
  /** Who a request is, for the security record: the signed-in kind and name, and the address it came from. */
  const securityActor=(request:FastifyRequest):SecurityActor=>{
    let context:AuthContext|undefined;
    try{context=auth.authenticate(request);}catch{/* not signed in */}
    const loopback=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.ip);
    const relayed=loopback?String(request.headers['x-forwarded-for']??'').split(',').at(-1)?.trim():undefined;
    const address=relayed||request.ip;
    const id=context?.linkServerId??context?.deviceId;
    const name=context?.linkServerId?linksRef?.list().find(link=>link.serverId===context.linkServerId)?.name:context?.deviceId?auth.device(context.deviceId)?.name:undefined;
    return {...(context?{kind:context.kind}:{}),...(id?{id}:{}),...(name?{name}:{}),...(address?{address}:{}),secure:context?.kind==='link'||secureTransport(request,trusted)};
  };
  /** [once] keys an event that repeats (a reconnecting terminal): it is recorded once per `SECURITY_AUDIT_BUDGET.repeatWindowMs`. */
  const recordSecurity=(request:FastifyRequest,kind:SecurityEventKind,{once,...fields}:{subject?:string;subjectId?:string;detail?:string;once?:string}={})=>{
    const actor=securityActor(request);
    if(once)securityAudit.recordOnce(`${kind}|${actor.id??actor.address??''}|${once}`,kind,actor,fields);
    else securityAudit.record(kind,actor,fields);
  };
  /** A forwarded request needs what its target route needs on the linked server, which runs the same table. */
  const requiredAccess=(request:FastifyRequest,route:string|undefined):Capability|'public'=>{
    if(request.method==='OPTIONS')return 'read';
    if(route!==SERVER_FORWARD_ROUTE)return routeAccess(request.method,route);
    const serverId=(request.params as {serverId?:string}|undefined)?.serverId;
    const path=serverId?peerPath(request.raw.url??'',serverId):undefined;
    return routeAccess(request.method,path?routePatterns.match(request.method,path):undefined);
  };
  const requireAccess=(request:FastifyRequest,route:string|undefined)=>{
    const required=requiredAccess(request,route);
    if(required==='public')return;
    const {secure,granted}=accessOf(request);
    if(granted.has(required))return;
    const actor=securityActor(request);
    securityAudit.recordOnce(`${actor.address}|${actor.id??''}|${request.method} ${route}`,'access-denied',actor,{subject:`${request.method} ${route??request.url}`,detail:required});
    if(!secure)throw new AppError('INSECURE_CONNECTION_READ_ONLY','This connection is not encrypted; on it this browser can only read',403,undefined,{capability:required});
    throw new AppError('CAPABILITY_REQUIRED','This device is not allowed to do this',403,undefined,{capability:required});
  };
  const cacheRegistry=new ServerCacheRegistry();
  const monitor=new ServiceMonitor({store,terminal,streams,profile,agentProcesses:()=>reclaimerRef?.report(),caches:()=>cacheRegistry.report()});
  monitor.observe(app);
  app.addHook('onRequest',async(request,reply)=>{
    // A connection that came through a server link (docs/SERVER-LINKS.md §4): the tunnel authenticated it, so only
    // this server's inbound switch and the link policy decide; no Host, Origin, cookie or token applies.
    const linkedFrom=linkOfRequest(request.raw);
    if (linkedFrom) {
      request.headers['x-riffet-link']=linkedFrom;
      reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('Cache-Control','no-store');
      if (!linksRef?.admits(linkedFrom)) throw new AppError('LINK_INBOUND_DISABLED','This server does not allow yours to operate it',403);
      if (linkPolicy(request.method,request.routeOptions?.url)==='deny') throw new AppError('LINK_FORBIDDEN','This is not available through a server link',403);
      if (request.headers.upgrade) linksRef.record(linkedFrom,{at:new Date().toISOString(),method:request.method,path:(request.raw.url??'').split('?')[0]!.slice(0,300),status:101,...linkOrigin(request.headers)});
      return;
    }
    delete request.headers['x-riffet-link'];
    auth.checkOrigin(request);
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
    if (isApiRequest(request)) {
      reply.header('Cache-Control','no-store');
      const route=request.routeOptions?.url ?? apiRoutePath(request.url);
      // The Riffet MCP shim or direct HTTP client presents its conversation-bound credential to its own route only.
      if (route===RIFFET_MCP_ROUTE||route===RIFFET_MCP_HTTP_ROUTE) return;
      if (auth.sharePreview(request)) return;
      // The token in the path is the credential; the route refuses a missing or stale one itself.
      if (route===FILE_SITE_ROUTE) return;
      if (!route || !PUBLIC_API.has(route)) {
        auth.require(request,!['GET','HEAD','OPTIONS'].includes(request.method));
        requireAccess(request,route);
      }
    }
  });
  // What a linked server changed here, for this server's record of it (reads and streams it opened are not kept).
  app.addHook('onResponse',async(request,reply)=>{
    const from=linkOfRequest(request.raw);
    if(!from||['GET','HEAD','OPTIONS'].includes(request.method))return;
    linksRef?.record(from,{at:new Date().toISOString(),method:request.method,path:(request.raw.url??'').split('?')[0]!.slice(0,300),status:reply.statusCode,...linkOrigin(request.headers)});
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
    const agents=agentMentionInputs(body.agents);
    return {text,attachmentIds,context,...(references?{references}:{}),...(agents?{agents}:{})};
  };
  const nativeRuns=(id:string)=>[...new Map([...store.listRecentNativeRuns(id).reverse(),...store.listUnfinishedNativeRuns(id)].map(run=>[run.id,run])).values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  // Sync v3 (docs/SYNC-V3.md): the journal folded into timeline rows in L2 `derived.db`, and each backend's transcript read into L1 `journal.db`.
  const timeline=new TimelineService({db:store.derivedDb,journal:store.journal,listRuns:id=>store.listRuns(id),onRunChanged:listener=>store.onRunChanged(listener),
    hotLanes:profileBudget.timelineHotLanes,summaryEntries:profileBudget.timelineSummaryEntries,
    expandedRowCacheEntries:profileBudget.expandedRowCacheEntries,expandedRowCacheBytes:profileBudget.expandedRowCacheBytes,
    listJobs:id=>nativeBackends.listJobs(id),onJobChanged:listener=>nativeBackends.onJobChanged(listener),
    activity:id=>store.sessionActivity(id),
    nativeChatId:id=>{try{const session=store.getSession(id);return session.nativeSessionId;}catch{return undefined;}},deleted:id=>store.isSessionDeleted(id)});
  cacheRegistry.register({name:'store',stats:()=>store.cacheStats(),trim:()=>store.trimCaches()});
  cacheRegistry.register({name:'timeline',stats:()=>timeline.cacheStats(),trim:()=>timeline.trimCaches()});
  cacheRegistry.register({name:'exec-worker',stats:()=>execWorkerStats(),trim:()=>trimExecWorker()});
  // Canvas summaries are written on request, one turn at a time (docs/PLUGIN_ARCHITECTURE.md, canvas).
  const turnSummaries=new TurnSummaryService({db:store.db,deleted:id=>store.isSessionDeleted(id),summaryModel:()=>resolveAuxiliaryModel(settings.getSettings(),'summary'),gatewayProfiles:backendId=>nativeBackends.catalog.gatewayProfiles(backendId),source:async(sessionId,turn)=>{await timeline.ready(sessionId,'main');return timeline.turnText(sessionId,turn);},record:recordAuxiliaryCall});
  const sessionMedia=new SessionMedia(sessionId=>timeline.namedPaths(sessionId),sessionId=>timeline.revision(sessionId),sessionId=>timeline.ready(sessionId,'main'),
    (sessionId,path,allowOutside)=>workspace.readPreviewImage(store.getProject(store.getSession(sessionId).projectId),path,{allowOutside,generatedImageHomes:codexGeneratedImageHomes(nativeBackends.catalog.profileSettings('codex')?.profiles??[])}));
  // Read on the sync tick, which cannot await. A known backend defaults to interrupt and targeted stop until `capabilitiesFor` fills this cache; when it resolves, active sync streams refresh `control`.
  const controlCapabilityCache=new Map<string,{supportsInterrupt:boolean;supportsTargetedStop:boolean;supportsSteer?:boolean}>();
  const controlCapabilityPending=new Set<string>();
  const controlRefreshListeners=new Set<()=>void>();
  const notifyControlRefresh=()=>{for(const listener of controlRefreshListeners){try{listener();}catch{/* each stream is independent */}}};
  const controlCapabilities=(session:{backendId?:string;backendProfileId?:string})=>{
    const backendId=session.backendId;
    if(!backendId||!isNativeBackendId(backendId))return undefined;
    const driver=backendRegistry.get(backendId);
    if(!driver)return undefined;
    const key=`${backendId}\n${session.backendProfileId??''}`;
    const cached=controlCapabilityCache.get(key);
    if(!cached&&!controlCapabilityPending.has(key)){
      controlCapabilityPending.add(key);
      // A profile that no longer resolves (deleted, renamed) falls back to the backend's default one, so steering is not lost with it.
      void nativeBackends.catalog.capabilitiesFor(backendId,session.backendProfileId).catch(()=>nativeBackends.catalog.capabilitiesFor(backendId)).then(caps=>{
        controlCapabilityCache.set(key,{supportsInterrupt:caps.supportsInterrupt,supportsTargetedStop:caps.supportsTargetedStop!==false,supportsSteer:caps.supportsSteer===true});
        notifyControlRefresh();
      }).catch(()=>undefined).finally(()=>{controlCapabilityPending.delete(key);});
    }
    return cached??{supportsInterrupt:true,supportsTargetedStop:true};
  };
  const sync=new SyncService({timeline,ingest,getSession:id=>store.getSession(id),getRun:id=>store.getRun(id),runs:nativeRuns,subscribe:(id,listener)=>store.subscribe(id,listener),control:(id,listener)=>nativeBackends.watchControl(id,listener),queue:(id,status)=>dispatch.queue(id,status),metrics:id=>stats.sessionMetrics(id),controlSnapshot:(sessionId,status,revision)=>{
    try{
      const session=store.getSession(sessionId);
      return buildSessionControlSnapshot({revision,session,status,queue:dispatch.queue(sessionId,status),taken:dispatch.taken(sessionId),runs:store.listUnfinishedNativeRuns(sessionId),capabilities:controlCapabilities(session)});
    }catch{return undefined;}
  },subscribeControlRefresh:listener=>{controlRefreshListeners.add(listener);return ()=>{controlRefreshListeners.delete(listener);};}});
  // Needs the timeline, so it is built here rather than beside orchestration. Unfinished turn cards are taken over once connected.
  const channels=new ChannelService({store,settings,nativeBackends,dispatch,sessionCommands,sessionLock,timeline,ingest,workspace,owner,stateDir,...(options.channelProviders?{providers:()=>options.channelProviders!}:{providers:()=>plugins.imChannels().map(({id,title,provider})=>channelProvider(id,provider,title)),onProvidersChanged:listener=>plugins.onChange(listener)})});
  if(!lite)void channels.start().catch(error=>console.warn('[riffet] channels failed to start',error));
  const externalSessions=new ExternalSessions({store,settings,nativeBackends,auth});
  const terminalHolds=new TerminalHolds({store,nativeBackends,runtime:sessionLock,log:(message,fields)=>console.info(`[riffet] ${message}`,fields)});
  terminalHolds.start();
  const workItems=new WorkItemService(store,()=>({
    send:(sessionId,text,commandId)=>{orchestration.message(sessionId,text,commandId);},
    open:async(target,text,attach)=>{
      // A provider removed since the task was planned: the agent's default, and its model with it.
      const kept=!target.backendProfileId||(await nativeBackends.catalog.listBackends()).find(entry=>entry.backendId===target.backendId)?.profiles.some(profile=>profile.id===target.backendProfileId);
      const {backendProfileId:_profile,model:_model,...rest}=target;
      return (await orchestration.open(kept?target:rest,text,attach)).id;
    },
  }));
  workItemsRef=workItems;
  assistantRef=new AssistantBoard({store,workItems,workItemChoice:async named=>{const saved=settings.getSettings();if(named&&named!==saved.workItems?.backendId)return undefined;return workItemAgentChoice({...saved,defaultBackendId:await defaultBackendForClient(undefined,saved.defaultBackendId,nativeBackends)},await nativeBackends.catalog.listBackends());},defaultBackend:()=>defaultBackendForClient(undefined,settings.getSettings().defaultBackendId,nativeBackends),
    search:assistantSearch,transcript:id=>nativeBackends.contextTranscript(id,CONTEXT_LIMITS.bytes,AbortSignal.timeout(CONTEXT_LIMITS.timeoutMs)),
    runtimeSessionIds:()=>nativeBackends.runtimeSessionIds(),runtimeStatus:id=>nativeBackends.hasRuntime(id)?nativeBackends.status(id):undefined,backends:onAvailability=>nativeBackends.catalog.listBackends({onAvailability}),automations:()=>{
      if(!orchestrationRef)throw new AppError('SERVICE_STARTING','The workbench is starting',503);
      return orchestrationRef.automations();
    },work:()=>assistantWork,dispatch:()=>settings.getSettings().assistant?.dispatch??SETTING_DEFAULTS.assistant.dispatch});
  const workbenchQueries=createAssistantWorkbenchQueries({
    store,ownerName:()=>owner.get().name,timeZone:()=>settings.getSettings().assistant?.timeZone,
    nativeStatus:id=>nativeBackends.status(id),pluginSettings:(id,offset,limit)=>plugins.workbenchSettingFields(id,offset,limit),pluginInventory:()=>plugins.workbenchInventory(),
    pluginToolGroups:session=>riffetMcp.pluginToolGroups(session),restartability:()=>dispatch.restartability(),
  });
  riffetMcp.registerCapabilities(new CapabilityCatalog(
    [...workbenchReads(workbenchQueries), attentionRead(assistantRef), assistantEventsRead(()=>plugins.assistantEvents()), instanceSettingsRead(settings), webThemeRead(themes,()=>appearance.catalog()), sharedThemeRead(themes),
      agentDefaultsRead(settings,nativeBackends.catalog,nativeBackends)],
    [instanceSettingCommand(settings), sharedThemeCommand(themes), agentDefaultsCommand(settings,nativeBackends.catalog,nativeBackends)],
  ));
  // Seats are Agent conversations; deleting one goes through the same path as a reader's delete, set up below.
  let deletionRef:SessionDeletion|undefined;
  const council=new CouncilService({
    db:store.db,
    seats:new AgentSeats({
      store,orchestration,timeline,
      // A quick chat runs only in its own project; every other seat in the empty council one.
      project:backendId=>backendId==='chat'?quickChatProject(store,stateDir):councilProject(store,stateDir),
      // A seat speaks with nobody to answer it: what would need asking is refused, and it starts in the backend's
      // plain mode, never the owner's saved one (a plan mode stops for approval, a quick-chat preset rewrites the brief).
      launch:async(backendId,profileId)=>{
        const capabilities=await nativeBackends.catalog.capabilitiesFor(backendId,profileId).catch(()=>undefined);
        if(!capabilities)return {};
        const approval=capabilities.supportsPermissionSelection&&capabilities.permissions.some(item=>item.id==='dontAsk')?'dontAsk':undefined;
        const mode=capabilities.supportsModeSelection?capabilities.modes.find(item=>item.id==='agent')?.id??capabilities.modes[0]?.id:undefined;
        return {...(approval?{approval}:{}),...(mode?{mode}:{})};
      },
      cancel:(sessionId,runId)=>{dispatch.cancel(sessionId,runId);},
      delete:async sessionId=>{
        if(!deletionRef)throw new AppError('SERVICE_STARTING','The workbench is starting',503);
        return await deletionRef.delete(sessionId,[sessionId]);
      },
    }),
    profileName:(backendId,profileId)=>{
      try{return nativeBackends.catalog.validateProfile(backendId,profileId).name;}catch{return undefined;}
    },
    log:(message,fields)=>app.log.warn(fields,message),
    exports:{
      createWorkItem:input=>{
        const item=workItems.create({title:input.title,description:input.body,...(input.projectId?{projectId:input.projectId}:{})});
        return item.id;
      },
      openSession:async input=>{
        const fallbackProject=input.projectId??store.listProjects().find(p=>!p.archivedAt&&!p.system)?.id??assistantProject(store,stateDir).id;
        const created=await orchestration.open({projectId:fallbackProject,...(input.backendId?{backendId:input.backendId}:{}),...(input.model?{model:input.model}:{}),title:input.title},input.prompt,()=>{});
        return created.id;
      },
    },
  });
  const deps:RouteDeps={profile,team:()=>team,links:()=>linksRef,bindWorkbench:(request,session,run)=>{
    if((!request.headers['x-riffet-workbench'] && !request.headers.authorization) || session.origin?.kind==='assistant') return;
    const project=store.getProject(session.projectId);
    const member=team.resolveFor(project,session);
    const allowed=member
      ? (member.capabilities.workbenchAdmin && member.sessionMode==='continuous' && (member.mainSessionId===session.id || (project.system==='assistant' && project.mainSessionId===session.id)))
      : (project.system==='assistant' && project.mainSessionId===session.id);
    if(allowed) workbenchAppearance.bind(request,run);
  },assistantDelegations:()=>assistantDelegationsRef,assistantRuns:()=>assistantRuns,restartAssistant:()=>{const id=assistantMainRef?.();if(id)reclaimerRef?.restartWhenRested(id);},workItems,pluginApprovals,council,channels,stateDir,contextReferences,store,auth,settings,taskWorkspaces,themes,owner,terminal,workspace,git,sessionLock,nativeBackends,plugins,tasks,dispatch,orchestration,titles,riffetMcp,devices,adb,notices,streams,monitor,sessionCommands,allowOutsideRead,effectiveSettings,clientAccess:(request:FastifyRequest)=>{const {secure,granted}=accessOf(request);return {secure,capabilities:[...granted]};},recordSecurity,securityAudit,tlsFingerprint:serverTls.fingerprint,renameNative,readNativeInput,nativeRuns,externalSessions,terminalHolds,sweepColdTimeline:()=>timeline.sweepCold(),recordAuxiliaryCall};
  registerAuthRoutes(app,deps);
  registerBackendRoutes(app,deps);
  // `serverId` stays across restarts (pushes name it as `server`); `instanceId` is this process.
  // Unauthenticated on purpose: iOS reads it here to match a push to its server before it signs in; it is an id, not a credential.
  const serverId=readServerId(stateDir);
  app.get('/health',async()=>({ok:true,version:SERVER_VERSION,build:SERVER_BUILD,instanceId:options.instanceId,serverId,managedBy:LAUNCHED_BY,profile,protocol:PROTOCOL_INFO}));
  registerUpdateRoutes(app,stateDir);
  registerServiceRoutes(app,deps);
  registerProjectRoutes(app,deps);
  registerSessionRoutes(app,deps);
  registerExternalSessionRoutes(app,deps);
  registerMarkRoutes(app,deps);
  registerWorkItemRoutes(app,deps);
  registerTeamRoutes(app,deps);
  registerPluginApprovalRoutes(app,deps);
  registerCouncilRoutes(app,deps);
  const shares=new ShareService(deps);
  registerShareRoutes(app,deps,shares);
  const agentCalls=new AgentCallService({store,timeline,orchestration,
    team:()=>team,
    assistantDefaults:()=>settings.getSettings().assistant,
    agents:()=>nativeBackends.catalog.listBackends(),
    capabilities:(backendId,profileId)=>nativeBackends.catalog.capabilitiesFor(backendId,profileId),
    // What the composer's model menu reads for the same project and provider: its models, and the account's quota.
    catalog:(backendId,profileId,projectId)=>nativeBackends.catalog.entry(backendId,store.getProject(projectId),profileId),
    usage:(backendId,profileId,projectId)=>nativeBackends.catalog.usage(backendId,store.getProject(projectId),profileId),
    worktree:projectId=>orchestration.callWorktree(projectId),
    cancel:(sessionId,runId)=>{dispatch.cancel(sessionId,runId);},
    notify:input=>{notices.add({...input,source:'agent'});},
    label:backendId=>backendRegistry.get(backendId)?.label??backendId,
    systemCommand:isSystemCommand,
    log:(message,fields)=>app.log.warn(fields,message)});
  agentCallsRef=agentCalls;
  app.addHook('onClose',async()=>agentCalls.close());
  registerAgentCallRoutes(app,{store,agentCalls});
  const deletion=new SessionDeletion({store,stateDir,sessionCommands,sessionLock,dispatch,nativeBackends,terminal,ingest,liveIndex,timeline,turnSummaries,shares,orchestration,notices,agentCalls,riffetMcp,planFiles,
    onCleanupError:(sessionId,error)=>app.log.warn({err:error,sessionId},'deleted conversation file cleanup failed; retrying on next start')});
  deletionRef=deletion;
  // Seat conversations outlive a restart with their discussion; one no seat holds (its discussion is gone, or it was
  // created as the server stopped, before its seat recorded it) is removed.
  for(const orphan of store.listSessions().filter(item=>item.origin?.kind==='council'&&!(item.origin.groupId&&council.holds(item.origin.groupId,item.id))))void deletion.delete(orphan.id,[orphan.id]).catch(()=>undefined);
  registerSessionDeletionRoutes(app,deletion);
  void deletion.resumeCleanup();
  const clientLogs=new ClientLogs(join(stateDir,'client-logs'));
  app.post<{Body:{name?:unknown;content?:unknown}}>('/api/client-logs',async(request)=>clientLogs.save(request.body?.name,request.body?.content));
  registerBrowserDiagnosticsRoutes(app,join(stateDir,'diagnostics','browser'));
  registerNativeRoutes(app,deps);
  registerSyncRoutes(app,{...deps,sync,timeline,turnSummaries,sessionMedia});
  registerTraceRoutes(app,deps);
  registerTerminalRoutes(app,deps);
  registerWorkspaceRoutes(app,deps);
  registerGitRoutes(app,deps);
  registerOrchestrationRoutes(app,deps);
  registerSettingsRoutes(app,deps);
  registerThemeRoutes(app,deps);
  registerExtensionRoutes(app,deps);
  registerPluginRoutes(app,deps);
  registerDictationRoutes(app,deps);
  registerTaskRoutes(app,deps);
  registerCommandRoutes(app,deps);
  registerQueryRoutes(app,deps);
  registerAppearanceRoutes(app,{appearance});
  registerOwnerRoutes(app,deps);
  registerRiffetMcpRoutes(app,deps);
  registerWorkbenchAppearanceRoutes(app,{auth,workbenchAppearance,documentProofs});
  registerDeviceRoutes(app,deps);
  registerChannelRoutes(app,deps);
  // Links to other servers (docs/SERVER-LINKS.md). Dialing starts once the server can take forwarded connections.
  const links=new LinkService({stateDir,serverId,name:()=>hostname().replace(/\.local$/i,'').slice(0,64)||'Riffet',version:SERVER_VERSION,protocol:PROTOCOL_INFO,httpServer:()=>app.server,log:message=>console.warn(message),
    onSecurityEvent:event=>{
      const actor:SecurityActor={kind:'link',id:event.serverId,name:event.name};
      // A pinned certificate that does not match is retried with backoff; once a minute in the record is enough.
      if(event.kind==='link-mismatch')securityAudit.recordOnce(`mismatch|${event.serverId}`,event.kind,actor,{subject:event.name,subjectId:event.serverId});
      else securityAudit.record(event.kind,actor,{subject:event.name,subjectId:event.serverId,...(event.detail?{detail:event.detail}:{})});
    }});
  linksRef=links;
  links.onRevoke(id=>auth.revokeLink(id));
  registerLinkRoutes(app,{links,auth,deviceName:id=>auth.device(id)?.name,secure:request=>accessOf(request).secure,recordSecurity});
  app.addHook('onReady',async()=>{links.start();});
  // Background pushes to iOS devices, straight to APNs with the owner's key (docs/DEVICES.md §3「后台推送」).
  const apns=new ApnsClient({stateDir,...(options.push?.transport?{transport:options.push.transport}:{}),...(options.push?.retryDelaysMs?{retryDelaysMs:options.push.retryDelaysMs}:{})});
  const push=new PushService({serverId,store,auth,devices,apns,timing:options.push?.timing,
    interaction:session=>nativeBackends.interaction(session),
    latestReply:async sessionId=>{await timeline.ready(sessionId,'main');const turn=timeline.outline(sessionId,'main',1).turns.at(-1);return turn?timeline.turnText(sessionId,turn.turn)?.answer:undefined;}});
  devices.pushRoute=(deviceId,platform)=>push.route(deviceId,platform);
  // Every other device hears of a new device or linked server, so one the owner did not add is noticed (docs/TRANSPORT-SECURITY.md §7).
  const stopSecurityPush=securityAudit.subscribe(event=>{
    if(event.kind==='device-paired'||event.kind==='link-added')void push.security({kind:event.kind,name:event.subject??'',...(event.subjectId?{except:event.subjectId}:{})}).catch(()=>undefined);
  });
  app.addHook('onClose',async()=>{stopSecurityPush();});
  registerPushRoutes(app,{apns,push});
  // The shim reads the server's address from its credential file; it moves on every start.
  app.addHook('onListen',async()=>{
    const address=app.server.address();
    if(!address||typeof address==='string')return;
    const host=['0.0.0.0','::',''].includes(address.address)?'127.0.0.1':address.family==='IPv6'?`[${address.address}]`:address.address;
    try{riffetMcpCredentials.setUrl(`http://${host}:${address.port}`);}catch(error){app.log.warn({err:error},'Riffet MCP credential refresh failed');}
  });

  if(!lite){
    registerWebAssets(app, options.webRoot, documentProofs);
    // The math page and its KaTeX assets: the same engine the web bundle uses, for clients that have
    // no TeX renderer of their own (see `math-assets.ts`).
    registerMathAssets(app);
    registerDiagramAssets(app);
  }
  registerContentPreview(app);
  registerPluginViewFrame(app);
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
  try{assistantHome=ensureAssistantHome(stateDir,assistantProject(store,stateDir).cwd);team.ensureDefaultMember();}catch(error){console.warn('[riffet] assistant project unavailable',error);}
  const stopAssistantWatch=assistantStanding.watch();
  // ---- Team members' background runs (docs/ASSISTANT.md §7, docs/TEAM.md) ----
  const ownerZone=()=>settings.getSettings().assistant?.timeZone??Intl.DateTimeFormat().resolvedOptions().timeZone;
  const memberMain=(memberId:string):string|undefined=>{
    try{
      const member=team.find(memberId);
      if(!member||member.archivedAt||member.sessionMode!=='continuous')return undefined;
      const id=member.mainSessionId??(member.scope.kind!=='project'?store.getProject(member.projectId).mainSessionId:undefined);
      if(!id)return undefined;
      return store.getSession(id).archivedAt?undefined:id;
    }catch{return undefined;}
  };
  const assistantMain=()=>memberMain(DEFAULT_AGENT_MEMBER_ID);
  const memberConsolidationEnabled=(memberId:string):boolean=>{
    const member=team.find(memberId);
    if(!member||member.archivedAt)return false;
    if(member.id===DEFAULT_AGENT_MEMBER_ID){
      return member.memory.consolidation&&(settings.getSettings().assistant?.consolidation??SETTING_DEFAULTS.assistant.consolidation);
    }
    return member.memory.consolidation;
  };
  const memberDailyLimit=(memberId:string):number=>{
    const member=team.find(memberId);
    if(member&&member.id!==DEFAULT_AGENT_MEMBER_ID)return member.budget.dailyRuns;
    return settings.getSettings().assistant?.dailyRuns??member?.budget.dailyRuns??ASSISTANT_BUDGET.dailyRuns;
  };
  // Set while a background run adds its notice: its push is the run's own.
  let addingForRun=false;
  // Made below: a queued run asks it whether it is still wanted.
  let supervision:Supervision|undefined;
  const runs=new AssistantRuns({store,settings:()=>settings.getSettings(),backends:()=>nativeBackends.catalog.listBackends(),project:()=>assistantProject(store,stateDir),
    resolveMember:(memberId,backends)=>{
      const member=team.find(memberId);
      if(!member||member.archivedAt)return undefined;
      let project;
      try{project=store.getProject(member.projectId);}catch{return undefined;}
      if(project.archivedAt)return undefined;
      const choice=member.id===DEFAULT_AGENT_MEMBER_ID
        ?(member.target?memberChoice(member.target,backends):assistantChoice(settings.getSettings().assistant,backends))
        :memberChoice(member.target,backends);
      return {memberId:member.id,project,choice,mainSessionId:memberMain(member.id),dailyRuns:memberDailyLimit(member.id)};
    },
    mainSessionOf:memberMain,
    dailyLimit:memberDailyLimit,
    start:(body,text,origin,ids)=>orchestration.start(body,text,origin,ids),
    archive:async sessionId=>{await patchSession(deps,sessionId,{archived:true});},
    remove:async sessionId=>{await deletion.delete(sessionId,[sessionId]);},
    markStuck:(workItemId,note)=>workItems.markStuck(workItemId,note),
    notice:(sessionId,body)=>{addingForRun=true;try{notices.add({sessionId,body,source:'agent'});}finally{addingForRun=false;}},
    push:(sessionId,body,key)=>push.notice(sessionId,body,key),
    wanted:run=>{
      const owner=run.memberId??DEFAULT_AGENT_MEMBER_ID;
      const member=team.find(owner);
      if(!member||member.archivedAt)return false;
      if(run.job==='supervise')return Boolean(run.subject&&supervision?.wanted(run.subject,run.key));
      if(run.job==='consolidate')return memberConsolidationEnabled(owner);
      if(!member.capabilities.delegations)return false;
      try{return Boolean(run.subject&&assistantDelegationsRef?.wantsRun(run.subject,run.key));}catch{return false;}
    }});
  runs.mainSession=assistantMain;
  assistantMainRef=assistantMain;
  for(const member of team.list()){
    const mainId=memberMain(member.id);
    if(mainId&&riffetMcp.mainNeedsToolRefresh(mainId,member.id))reclaimer.restartWhenRested(mainId);
  }
  // What an agent tells the owner with notify_user, or a wake-up's notice, reaches their phone too; a background run
  // pushes its own, and records whether it went out (docs/ASSISTANT.md §7.1).
  const stopNoticePush=notices.subscribe(notice=>{
    if(addingForRun)return;
    void push.notice(notice.sessionId,[notice.title,notice.body].filter(Boolean).join(' · '),`notice-${notice.id}`).catch(()=>undefined);
  });
  assistantRuns=runs;
  const queue=(job:'supervise'|'consolidate'|'delegation',key:string,brief:Record<string,string|number>,subject?:string,memberId:string=DEFAULT_AGENT_MEMBER_ID)=>{const before=runs.has(key);return runs.enqueue(job,key,brief,subject,memberId).state==='queued'&&!before;};
  const memberDelegationState=(memberId:string):'active'|'paused'|'deleted'=>{
    const member=team.find(memberId);
    if(!member)return 'deleted';
    if(member.archivedAt||!member.capabilities.delegations)return 'paused';
    return 'active';
  };
  const delegations=new AssistantDelegations({store,timeZone:ownerZone,nextCron:(cron,after,zone)=>nextCronTime(parseCron(cron),after,zone),
    taskStatuses:{
      baseline:reference=>workItems.taskStatusBaseline(reference),
      events:(id,cursor,limit)=>workItems.taskStatusEvents(id,cursor,limit),
      subscribe:listener=>workItems.onStatusChange(listener)},
    fire:({delegation,reason,payload,key})=>{queue('delegation',key,{goal:delegation.goal,attention:delegation.attention,trigger:JSON.stringify(delegation.trigger),until:delegation.until,cursor:delegation.cursor??'（还没有）',reason,payload:payload||'（没有附带内容）'},delegation.id,delegation.memberId);},
    pluginEvents:{declared:topic=>plugins.assistantEventDeclared(topic),backlog:id=>runs.pendingCount('delegation',id)},
    memberState:memberDelegationState,
    expired:delegation=>{if(memberDelegationState(delegation.memberId??DEFAULT_AGENT_MEMBER_ID)!=='deleted')runs.addPending(undefined,`委托「${delegation.goal.slice(0,80)}」已到期结束。`,delegation.memberId);},
    changed:()=>store.workItemsChanged()});
  assistantDelegationsRef=delegations;
  consolidation=new Consolidation({store,
    targets:()=>team.list().flatMap(member=>{
      const mainSessionId=memberMain(member.id);
      if(!mainSessionId)return [];
      return [{memberId:member.id,cwd:team.memberDir(member.id),userFile:globalUserProfilePath(stateDir),mainSessionId,enabled:memberConsolidationEnabled(member.id)}];
    }),
    timeZone:ownerZone,
    enqueue:(key,brief,memberId)=>queue('consolidate',key,brief,undefined,memberId),has:key=>runs.has(key),
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
  // 核验 (docs/TASK-BOARD.md §6.1): a submission is checked read-only by the Agent set for it; 跟进 waits for the check.
  const verification=new Verification({store,workItems,
    verifier:()=>settings.getSettings().workItems?.verifier,
    consult:(caller,target,prompt,text)=>agentCalls.consultFor(caller,target,prompt,text),
    answer:(sessionId,runId)=>agentCalls.answerOf(sessionId,runId),
    checked:workItemId=>supervision?.checked(workItemId),
    log:(message,fields)=>console.warn(`[riffet] ${message}`,fields)});
  supervision=new Supervision({store,workItems,enabled:()=>settings.getSettings().assistant?.supervision??SETTING_DEFAULTS.assistant.supervision,
    verifying:workItemId=>verification.verifying(workItemId),
    enqueue:(key,brief,workItemId)=>{queue('supervise',key,brief,workItemId);},pending:workItemId=>runs.pending('supervise',workItemId),
    agentLabel:backendId=>(backendId&&isNativeBackendId(backendId)?backendRegistry.get(backendId)?.label:undefined)??backendId??'Agent'});
  assistantWork={
    report:(sessionId,outcome,text)=>runs.report(sessionId,outcome,text) as {outcome:string},
    boundWorkItem:sessionId=>{
      const run=runs.bySession(sessionId);
      if(run?.job==='supervise') return run.subject;
      if(run?.job!=='delegation' || typeof run.brief.trigger!=='string') return undefined;
      try { const trigger=JSON.parse(run.brief.trigger); return trigger?.kind==='task-status' && typeof trigger.workItemId==='string' ? trigger.workItemId : undefined; }
      catch { return undefined; }
    },
    supervised:sessionId=>{const run=runs.bySession(sessionId);return run?.job==='supervise'&&run.subject?{workItemId:run.subject,runId:run.id}:undefined;},
    delegations:{list:memberId=>delegations.list(memberId),create:(input,memberId)=>delegations.create(input,memberId),update:(id,input,memberId)=>delegations.update(id,input,memberId),end:(id,by,memberId)=>delegations.end(id,by,memberId)},
  };
  const stopAssistantWork:Array<()=>void>=lite?[]:[runs.watch(),delegations.start(),consolidation.start(),supervision.start(),verification.start()];
  // Tasks whose last prerequisite was done while the server was stopping (docs/TASK-BOARD.md §4.4).
  if(!lite){
    const resumeWaiting=setTimeout(()=>{try{workItems.resumeWaiting();}catch(error){console.warn('[riffet] waiting tasks were not started',error instanceof Error?error.message:error);}},15_000);
    resumeWaiting.unref?.();
    stopAssistantWork.push(()=>clearTimeout(resumeWaiting));
  }
  // docs/ASSISTANT.md §8.2: the capability packs of the enabled plugins are kept in `packs/`; the main conversation's CLI restarts when they change.
  let packProblemIds=new Set<string>();
  let packSync:Promise<unknown>=Promise.resolve();
  const syncPacks=()=>{packSync=packSync.then(async()=>{
    const sources=plugins.assistantPackSources();
    if(!sources.length&&!packProblemIds.size&&!existsSync(join(stateDir,'assistant','packs')))return;
    const result=await syncPluginPacks(assistantProject(store,stateDir).cwd,sources);
    for(const id of packProblemIds)plugins.setAssistantPackProblem(id,undefined);
    packProblemIds=new Set(result.problems.keys());
    for(const [id,problem] of result.problems)plugins.setAssistantPackProblem(id,problem);
    if(result.changed){const id=assistantMain();if(id)reclaimer.restartWhenRested(id);}
  }).catch(error=>console.warn('[riffet] plugin capability packs were not synced',error));};
  if(!lite){
    stopAssistantWork.push(plugins.onChange(syncPacks));
    syncPacks();
    workItems.retitleBriefConversations();
    workItems.dropComposerItems();
  }
  const quickChats=new QuickChatSweeper({store,settings:()=>settings.getSettings(),
    archive:sessionId=>patchSession(deps,sessionId,{archived:true}),
    log:(message,fields)=>console.info(`[riffet] ${message}`,fields)});
  if(!lite){
    quickChats.start();
    statsBackfill.start();
    titles.start();
  }
  const stopCacheTrim=cacheRegistry.startAutoTrim({
    isBusy:()=>{
      if(streams.size>0||terminal.viewerCount()>0||monitor.inFlightRequests>0)return true;
      const sessions=store.stateCounts().sessions;
      return ['starting','running','waiting','cancelling'].some(state=>(sessions[state]??0)>0);
    },
    idleMs:profileBudget.idleTrimMs,
    managedSoftLimitBytes:profileBudget.managedSoftLimitBytes,
    pressure:()=>reclaimer.report()?.pressure??'normal',
  });
  const pruneOldExitedTerminals=()=>{
    const terminalCutoff=new Date(Date.now()-SERVER_BUDGET.exitedTerminalRetentionDays*86_400_000).toISOString();
    try{store.pruneExitedTerminals(terminalCutoff);}catch(error){app.log.warn({err:error},'terminal pruning failed');}
  };
  // Low-priority housekeeping, once the server is up: old attachments nothing recent refers to,
  // and exited terminal records nothing points at. Failures wait for the next start.
  const maintenance=setTimeout(()=>{
    pruneOldExitedTerminals();
    const cutoff=new Date(Date.now()-RETENTION_MS).toISOString();
    let keep:Set<string>;
    try{keep=store.referencedAttachmentIds(cutoff);}catch(error){app.log.warn({err:error},'attachment pruning failed');return;}
    void workspace.pruneAttachments({olderThan:Date.now()-RETENTION_MS,keep}).catch(error=>app.log.warn({err:error},'attachment pruning failed'));
  },MAINTENANCE_DELAY_MS);
  maintenance.unref();
  // The log's own housekeeping (superseded revisions, unreferenced blobs, cold archived trimming & incremental vacuum): once after start-up, then now and then.
  const sweepJournal=()=>{
    pruneOldExitedTerminals();
    void deletion.resumeCleanup();
    void contextReferences.sweep().catch(error=>app.log.warn({err:error},'context file pruning failed'));
    try{
      if(STORAGE_BUDGET.archivedTrimDays>0){
        const archivedBefore=new Date(Date.now()-STORAGE_BUDGET.archivedTrimDays*86_400_000).toISOString();
        const archivedIds=store.archivedSessionsBefore(archivedBefore);
        if(archivedIds.length)store.journal.trimArchivedToolBlobs(archivedIds);
      }
      const assistantCold=store.assistantMainForTrimming();
      if(assistantCold)store.journal.trimArchivedToolBlobs([assistantCold.sessionId],{beforeAt:assistantCold.beforeAt});
      store.journal.maintainAll();
      store.reclaimSpace();
    }catch(error){app.log.warn({err:error},'journal maintenance failed');}
  };
  const journalSweep=setTimeout(sweepJournal,MAINTENANCE_DELAY_MS*2);journalSweep.unref();
  const journalSweepEvery=setInterval(sweepJournal,JOURNAL_SWEEP_MS);journalSweepEvery.unref();
  app.addHook('onClose',async()=>{
    // Each step runs even when an earlier one throws: a failed backend shutdown must not leave the database open.
    const steps:Array<[string,()=>unknown]>=[['cache-trim',()=>stopCacheTrim()],['links',()=>links.close()],['assistant',()=>{stopWatchingAppearance();stopAssistantWatch();stopNoticePush();for(const stop of stopAssistantWork)stop();}],['council',()=>council.close()],['titles',()=>titles.close()],['turn-summaries',()=>turnSummaries.close()],['stats-backfill',()=>statsBackfill.close()],['orchestration',()=>orchestration.close()],['channels',()=>channels.close()],['approvals',()=>{stopApprovalSweep();pluginApprovals.close();}],['push',()=>{push.close();apns.close();}],['devices',()=>devices.close()],['dispatch',()=>dispatch.close()],['reclaim',()=>reclaimer.stop()],['terminal-holds',()=>terminalHolds.stop()],['quick-chat',()=>quickChats.stop()],['sync-ingest',()=>ingest.close()],['plugin-backends',()=>pluginBackends.close()],['native-backends',()=>nativeBackends.closeAll()],['tasks',()=>tasks.close()],['integrations',()=>plugins.close()],['terminal',()=>terminal.closeAll()],['stats',()=>stats.close()],['work-items',()=>workItems.close()],['search-index',()=>{offIndexFeed();offServiceFeed();liveIndex.close();}],['loop-health',()=>loopHealthMonitor.stop()],['monitor',()=>monitor.stop()],['maintenance',()=>{clearTimeout(maintenance);clearTimeout(journalSweep);clearInterval(journalSweepEvery);}],['timeline',()=>timeline.close()],['journal-feed',()=>journalFeed.close()],['git',()=>git.close()],['code-index',()=>workspace.close()],['integrity-check',()=>cancelIntegrityCheck()],['wal-checkpoints',()=>stopWalCheckpoints()],['store',()=>store.close()]];
    for(const [name,step] of steps){
      try{await step();}catch(error){console.error(`[riffet] shutdown step ${name} failed:`,error);}
    }
  });
  return {app,profile,cacheRegistry,links,registeredRoutes,workItems,pluginApprovals,team,assistant:assistantRef,assistantRuns:runs,assistantDelegations:delegations,channels,contextReferences,store,auth,riffetMcp,devices,push,notices,terminal,nativeBackends,plugins,tasks,dispatch,orchestration,workspace,git,settings,taskWorkspaces,themes,stateDir,timeline,ingest,quickChats};
}
const gzipAsync=promisify(gzip);
/** How often the journal drops superseded draft chunks and unreferenced blobs. */
const JOURNAL_SWEEP_MS = 6 * 60 * 60_000;
/** Attachments and exited terminals older than this, and unreferenced, are removed. */
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAINTENANCE_DELAY_MS = 60_000;
/** The client of the other server that sent a linked request, as that server reported it (`links/forward.ts`). */
function linkOrigin(headers:import('node:http').IncomingHttpHeaders):{origin?:string}{
  const value=headers['x-riffet-link-origin'];
  return typeof value==='string'&&value?{origin:value.slice(0,120)}:{};
}
