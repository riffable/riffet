#!/usr/bin/env node
import { Command } from 'commander';
import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, renameSync, realpathSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { BuildInfo, ReleaseTag } from '../../../packages/contracts/src/index.js';
import { requestCliPairing, formatCliPairing, publicOrigin } from './cli-pairing.js';
import { drainForRestart } from './cli-drain.js';
import { resumeInTerminal } from './cli-resume.js';
import { developPlugin, unlinkDevelopmentPlugin, recoverPlugins, inspectPlugin, deletePluginData, installPlugin, listPlugins, readPluginLogs, selectPlugin, uninstallPlugin, type PluginCliContext } from './cli-plugins.js';
import { packSource, type ArchiveFormat } from '../../../packages/plugin-api/src/tooling.js';
import { createApp } from './app.js';
import { applyProcessEnvironment, currentEnvironmentReport, terminalEnvironment, type EnvironmentReport } from './environment.js';
import { buildLaunchAgentPlist, buildSystemdUnit, xmlEscape, systemdValue } from './service-files.js';
import { claimStateDirectory } from './compat.js';
import { SettingsService } from './settings/index.js';
import { doctorChecks, formatDoctorChecks, machineReport } from './doctor.js';
import { COMPACTION_WAIT_MS, compactDatabase, compactionRunning, recordCompaction, runRequestedCompaction } from './storage/compaction.js';
import { restoreBackup } from './system.js';
import { startDiscovery, type DiscoveryHandle } from './discovery.js';
import { SERVER_BUILD, SERVER_VERSION, SOURCE_ROOT } from './version.js';
import { checkForUpdates } from './update.js';
import { checkNpmUpdate, isNpmInstall, NPM_UPGRADE_COMMAND } from './update-npm.js';
import { assertSourceStartAllowed, readAppInstallation, runSourceUpdate, shellQuote } from './cli-update.js';
import { runProcess } from './git/exec.js';
import { rotateServerLog, stampServerOutput } from './server-log.js';

interface CliOptions {stateDir:string;host:string;port:string;cli:string;allowHost:string[];workspace?:string;dev?:boolean;token?:boolean;auth?:boolean;mdns?:boolean;}
interface DaemonRecord {pid:number;port:number;host:string;instanceId:string;startedAt:string;args:string[];}
const entry=fileURLToPath(import.meta.url);
// The update command uses the user's Git agent; resumed daemons still scrub their own environment.
const updateSshAuthSocket=process.env.SSH_AUTH_SOCK;
const defaultState=join(homedir(),'.local/share/riffet');
export const configure=(command:Command)=>command.option('--state-dir <path>','Persistent workbench state',defaultState).option('--host <host>','Bind address','127.0.0.1').option('--port <port>','HTTP port','4317').option('--cli <path>','Cursor executable or shell:<function>',process.env.RIFFET_CLI??'cursor-agent').option('--allow-host <hostname>','Additional trusted hostname',(value:string,previous:string[])=>[...previous,value],[]).option('--workspace <path>','Add a project directory').option('--auth','Require token login',true).option('--no-auth','Skip token login for loopback connections').option('--mdns','Advertise the server on the local network').option('--no-mdns','Disable local network discovery').option('--dev','Serve APIs for the Vite development frontend',false);
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
/** `RIFFET_MDNS=0` mirrors `--no-mdns`; any other value keeps the default of advertising. */
const mdnsDisabled=(value:string|undefined)=>/^(?:0|false|off)$/i.test(value?.trim()??'');
function state(options:CliOptions) { const path=resolve(options.stateDir);mkdirSync(path,{recursive:true,mode:0o700});return path; }
function daemonPath(options:CliOptions) { return join(state(options),'daemon.json'); }
function readDaemon(options:CliOptions):DaemonRecord|undefined { try{return JSON.parse(readFileSync(daemonPath(options),'utf8'));}catch{return;} }
function pidExists(pid:number){if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch{return false;}}
function ownsPid(record:DaemonRecord){if(!pidExists(record.pid))return false;const p=spawnSync('ps',['-p',String(record.pid),'-o','command='],{encoding:'utf8'});return p.status===0&&p.stdout.includes(entry)&&p.stdout.includes('serve');}
function serverUrl(record:DaemonRecord){const host=['0.0.0.0','::'].includes(record.host)?'127.0.0.1':record.host;return `http://${host.includes(':')?'['+host+']':host}:${record.port}`;}
async function active(options:CliOptions){const record=readDaemon(options);if(!record||!pidExists(record.pid))return;try{const response=await fetch(serverUrl(record)+'/health',{signal:AbortSignal.timeout(1500)});const value=await response.json() as {instanceId?:string};if(value.instanceId===record.instanceId)return record;}catch{}if(ownsPid(record))return record;}
function argsFor(options:CliOptions){const args=['serve','--state-dir',state(options),'--host',options.host,'--port',options.port,'--cli',options.cli];for(const host of options.allowHost??[])args.push('--allow-host',host);if(options.workspace)args.push('--workspace',resolve(options.workspace));if(options.token===false)args.push('--no-token');if(options.auth===false)args.push('--no-auth');if(options.mdns===false)args.push('--no-mdns');return args;}
function token(options:CliOptions){return readFileSync(join(state(options),'access-token'),'utf8').trim();}
/** Persistent launch intent survives `stop`; daemon.json only describes the live process. */
function savedLaunchArgs(options:CliOptions):string[]|undefined {
  try {
    const value=JSON.parse(readFileSync(join(state(options),'server-config.json'),'utf8')) as {version?:unknown;args?:unknown};
    if(value.version!==1||!Array.isArray(value.args)||!value.args.every(arg=>typeof arg==='string')||value.args[0]!=='serve')throw new Error('Invalid server-config.json; inspect the saved server configuration.');
    return value.args as string[];
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
}
export function resolveLaunchOptions(options:CliOptions,command:Command,savedArgs?:string[]):CliOptions {
  if(!savedArgs)return options;
  const parser=configure(new Command()).option('--no-token','Hide login token').exitOverride();
  parser.parse(savedArgs.slice(1),{from:'user'});
  const saved=parser.opts() as CliOptions;
  const overrides=Object.fromEntries(Object.entries(options).filter(([name])=>command.getOptionValueSource(name)==='cli'));
  return {...saved,...overrides,stateDir:options.stateDir,token:options.token};
}
export function validateLaunchOptions(options:CliOptions):void {
  const port=Number(options.port);
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Port must be 0–65535');
  if(options.auth===false&&!['127.0.0.1','localhost','::1'].includes(options.host.replace(/^\[|\]$/g,'').toLowerCase()))throw new Error('Token-free access must bind to 127.0.0.1, localhost or ::1. Use --auth for LAN clients.');
  if(options.workspace&&!statSync(realpathSync(resolve(options.workspace))).isDirectory())throw new Error('Workspace must be a directory');
}
export function saveLaunchConfig(options:CliOptions,args:string[]):void {
  const path=join(state(options),'server-config.json'),temp=path+'.'+process.pid+'.tmp';
  writeFileSync(temp,JSON.stringify({version:1,args},null,2)+'\n',{mode:0o600});renameSync(temp,path);
}

/** What the running server reports about its launcher; undefined for servers that predate the field. */
async function managedBy(record:DaemonRecord):Promise<string|undefined>{try{const response=await fetch(serverUrl(record)+'/health',{signal:AbortSignal.timeout(1500)});return (await response.json() as {managedBy?:string}).managedBy;}catch{return;}}
const APP_MANAGED='This server is hosted by Riffet.app; stop or restart it in Riffet → 设置 → 服务管理';
const APP_AGENT_LABEL='io.github.riffable.mac.server';
function appAgentLoaded(){return process.platform==='darwin'&&spawnSync('launchctl',['print',`gui/${process.getuid!()}/${APP_AGENT_LABEL}`],{stdio:'ignore'}).status===0;}
function show(record:DaemonRecord,options:CliOptions,showToken=true){console.log(`Riffet running: ${serverUrl(record)}`);console.log(`PID: ${record.pid} · state: ${state(options)}`);if(record.args.includes('--no-auth'))console.log('Access: local, no token required');else if(showToken)console.log(`Sign in: ${serverUrl(record)}/?token=${encodeURIComponent(token(options))}`);}
function claimState(options:CliOptions){
  const release=claimStateDirectory(state(options));
  process.once('exit',release);return release;
}

function assertSourceStartable():void {
  const root=entry.endsWith('.ts')?resolve(dirname(entry),'../../..'):resolve(dirname(entry),'..');
  // Bundled standalone payloads do not share the clone's dependencies or build products.
  if(existsSync(join(root,'.git')))assertSourceStartAllowed(realpathSync(root));
}

export async function serve(options:CliOptions){
  stampServerOutput();
  assertSourceStartable();
  if(await active(options))throw new Error('This state directory already has a running Riffet service');
  validateLaunchOptions(options);
  const port=Number(options.port);
  const cwd=options.workspace?realpathSync(resolve(options.workspace)):undefined;
  if(cwd&&!statSync(cwd).isDirectory())throw new Error('Workspace must be a directory');
  const releaseState=claimState(options);
  rotateServerLog(join(state(options),'server.log'));
  // Asked for on the settings page; runs before anything opens the database, and delays the start by its length.
  runRequestedCompaction(state(options));
  const instanceId=randomUUID();
  const webRoot=options.dev?undefined:join(dirname(entry),'public');
  // Development reads the plugin index `pnpm build:site` wrote, when there is one and nothing else was asked for.
  const localIndex=fileURLToPath(new URL('../../../dist/site/plugins/index.json',import.meta.url));
  if(options.dev&&!process.env.RIFFET_PLUGIN_INDEX?.trim()&&existsSync(localIndex))process.env.RIFFET_PLUGIN_INDEX=pathToFileURL(localIndex).href;
  let services:Awaited<ReturnType<typeof createApp>>|undefined;
  let discovery:DiscoveryHandle|undefined;
  const path=daemonPath(options);
  try{
    services=await createApp({stateDir:state(options),cliPath:options.cli,host:options.host,port,auth:options.auth,allowedHosts:options.allowHost,webRoot,instanceId,profileStalls:true});
    if(cwd)services.store.createProject(cwd,dirname(cwd)===cwd?cwd:cwd.split('/').at(-1)!);
    await services.app.listen({host:options.host,port});
    const address=services.app.server.address();if(!address||typeof address==='string')throw new Error('Could not determine listening port');
    const record:DaemonRecord={pid:process.pid,port:address.port,host:options.host,instanceId,startedAt:new Date().toISOString(),args:argsFor({...options,port:String(address.port)})};
    const temp=path+'.'+process.pid+'.tmp';writeFileSync(temp,JSON.stringify(record,null,2),{mode:0o600});renameSync(temp,path);
    saveLaunchConfig(options,record.args);
    // Discovery is best-effort: it must never keep the HTTP server from starting or stop it.
    if(options.mdns!==false&&!mdnsDisabled(process.env.RIFFET_MDNS))discovery=await startDiscovery({port:address.port,host:options.host,name:'Riffet',version:SERVER_VERSION});
    show(record,options,options.token);
  }catch(error){await discovery?.stop();await services?.app.close();releaseState();throw error;}
  if(options.dev)console.log('Web development: run pnpm dev:web, then open http://localhost:5173');
  if(options.dev&&process.env.RIFFET_PLUGIN_INDEX)console.log(`Plugin index: ${process.env.RIFFET_PLUGIN_INDEX}`);
  let shuttingDown=false;
  const stop=async()=>{if(shuttingDown){process.exit(1);}shuttingDown=true;const timeout=setTimeout(()=>process.exit(1),8000);timeout.unref();try{await discovery?.stop();await services!.app.close();if(readDaemon(options)?.instanceId===instanceId)unlinkSync(path);}finally{releaseState();clearTimeout(timeout);process.exit(0);}};
  process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
  // Node exits on an unhandled rejection; one stray background promise must not take every session down with it.
  process.on('unhandledRejection',reason=>console.error('[riffet] unhandled rejection:',reason));
}
async function start(options:CliOptions){
  assertSourceStartable();
  const existing=await active(options);if(existing){show(existing,options,options.token);return;}
  validateLaunchOptions(options);
  const fd=openSync(join(state(options),'server.log'),'a',0o600);
  const child=spawn(process.execPath,[...process.execArgv,entry,...argsFor({...options,token:false})],{cwd:process.cwd(),env:{...process.env,RIFFET_MANAGED_BY:'cli'},detached:true,stdio:['ignore',fd,fd]});child.unref();
  closeSync(fd);
  // A compaction the settings page asked for runs before the service listens: wait for it, up to its own limit.
  const began=Date.now();let deadline=began+8000;let told=false;
  while(Date.now()<deadline){
    await sleep(100);const record=await active(options);if(record){show(record,options,options.token);return;}if(child.exitCode!==null)break;
    if(compactionRunning(state(options))){if(!told){console.log('Compacting the database before the service starts; this can take several minutes.');told=true;}deadline=Math.min(Math.max(deadline,Date.now()+8000),began+COMPACTION_WAIT_MS);}
  }
  const log=join(state(options),'server.log');
  let tail='';
  try{tail=readFileSync(log,'utf8').split('\n').slice(-15).join('\n').trim();}catch{/* the log itself may be missing */}
  throw new Error(`Server did not start. Inspect ${log}${tail?`\n--- last lines ---\n${redactToken(tail)}`:''}`);
}
function redactToken(text:string){return text.replace(/token=[^\s&]+/g,'token=[REDACTED]');}
async function stop(options:CliOptions){const record=await active(options);if(!record){console.log('Riffet is stopped');return;}if(await managedBy(record)==='app')throw new Error(APP_MANAGED);if(!ownsPid(record))throw new Error('Cannot verify daemon process ownership; refusing to signal this PID');process.kill(record.pid,'SIGTERM');for(let i=0;i<70;i++){await sleep(150);if(!pidExists(record.pid)){console.log('Riffet stopped; persistent terminals remain available');return;}}process.kill(record.pid,'SIGKILL');console.log('Riffet force-stopped; inspect session state on restart');}
/** `restart` and `update` alike: how long to wait for the turns a restart would end; 0 (`--force` or `--wait-idle 0`) does not wait. */
interface RestartWaitOptions { waitIdle?: string; force?: boolean }
function restartWaitSeconds(options:RestartWaitOptions):number{
  const waitSeconds=options.waitIdle===undefined?180:Number(options.waitIdle);
  if(!Number.isInteger(waitSeconds)||waitSeconds<0)throw new Error('--wait-idle must be a non-negative integer');
  return options.force?0:waitSeconds;
}
/** Restarts once it would end no turn, holding new deliveries back meanwhile (docs/DELIVERY.md, 重启); a service without those endpoints restarts as before. */
async function restart(options:CliOptions&RestartWaitOptions,command:Command){
  const previous=readDaemon(options);const next=resolveLaunchOptions(options,command,previous?.args??savedLaunchArgs(options));validateLaunchOptions(next);
  const waitSeconds=restartWaitSeconds(options);
  const record=await active(options);
  if(record&&await managedBy(record)==='app')throw new Error(APP_MANAGED);
  const release=record&&waitSeconds>0?await drainForRestart(record,token(options),{waitSeconds,log:console.log}):undefined;
  // The service is still up if stopping failed: let it deliver again.
  try{await stop(options);}catch(error){await release?.();throw error;}
  await start(next);
}
const LAUNCH_AGENT_PATH=join(homedir(),'Library/LaunchAgents/local.riffet.plist');
const SYSTEMD_UNIT_PATH=join(homedir(),'.config/systemd/user/riffet.service');
const SYSTEMD_UNIT='riffet.service';

/**
 * The environment a service manager has to hand the daemon. A background service gets none of the
 * user's shell startup — no PATH from nvm/asdf/mise, no pnpm or Android variables — so the snapshot
 * taken here is what keeps the daemon able to find node, the agent CLIs and the toolchains its
 * terminals promise. `install-service --refresh-environment` re-takes it after a new install.
 */
function serviceEnvironment():Record<string,string>{
  const report=currentEnvironmentReport();
  const environment=terminalEnvironment(report);
  if(report?.shell)environment.SHELL=report.shell;
  environment.RIFFET_MANAGED_BY='launchd';
  return environment;
}

/** `serve` in the foreground: a service manager owns the process lifecycle, not our daemonizer. */
function serviceArgs(options:CliOptions):string[]{
  const args=['serve','--state-dir',state(options),'--host',options.host,'--port',options.port,'--cli',options.cli];
  for(const host of options.allowHost??[])args.push('--allow-host',host);
  if(options.auth===false)args.push('--no-auth');else args.push('--auth');
  if(options.mdns===false)args.push('--no-mdns');
  args.push('--no-token');
  return args;
}

function writeLaunchAgent(options:CliOptions):string{
  const xml=buildLaunchAgentPlist({
    label:'local.riffet',
    programArguments:[process.execPath,entry,...serviceArgs(options)],
    environment:serviceEnvironment(),
    logPath:join(state(options),'server.log'),
  });
  mkdirSync(dirname(LAUNCH_AGENT_PATH),{recursive:true});
  writeFileSync(LAUNCH_AGENT_PATH,xml,{mode:0o600});
  const domain=`gui/${process.getuid!()}`;
  spawnSync('launchctl',['bootout',domain,LAUNCH_AGENT_PATH],{stdio:'ignore'});
  const result=spawnSync('launchctl',['bootstrap',domain,LAUNCH_AGENT_PATH],{encoding:'utf8'});
  if(result.status!==0)throw new Error(result.stderr||'launchctl bootstrap failed');
  return LAUNCH_AGENT_PATH;
}

function writeSystemdUnit(options:CliOptions):string{
  const unit=buildSystemdUnit({
    description:'Riffet — local agent workbench',
    programArguments:[process.execPath,entry,...serviceArgs(options)],
    environment:serviceEnvironment(),
    workingDirectory:process.cwd(),
    logPath:join(state(options),'server.log'),
  });
  mkdirSync(dirname(SYSTEMD_UNIT_PATH),{recursive:true});
  writeFileSync(SYSTEMD_UNIT_PATH,unit,{mode:0o600});
  const reloaded=spawnSync('systemctl',['--user','daemon-reload'],{encoding:'utf8'});
  if(reloaded.error)throw new Error(`systemctl is unavailable: ${reloaded.error.message}`);
  spawnSync('systemctl',['--user','enable',SYSTEMD_UNIT],{encoding:'utf8'});
  const started=spawnSync('systemctl',['--user','restart',SYSTEMD_UNIT],{encoding:'utf8'});
  if(started.status!==0)throw new Error(started.stderr||`systemctl --user restart ${SYSTEMD_UNIT} failed`);
  return SYSTEMD_UNIT_PATH;
}

async function installService(options:CliOptions,command:Command){
  if(entry.endsWith('.ts'))throw new Error('Build the production CLI before installing a login service');
  const refresh=command.getOptionValueSource('refreshEnvironment')==='cli';
  const existing=process.platform==='darwin'?existsSync(LAUNCH_AGENT_PATH):process.platform==='linux'?existsSync(SYSTEMD_UNIT_PATH):false;
  if(refresh&&!existing)throw new Error('No installed service to refresh; run install-service without --refresh-environment first');
  if(process.platform==='darwin'){
    if(appAgentLoaded())throw new Error(`${APP_MANAGED}; a second login service would fight it for the same state directory`);
    console.log(`Installed login service: ${writeLaunchAgent(options)}`);
    return;
  }
  if(process.platform==='linux'){
    console.log(`Installed user service: ${writeSystemdUnit(options)}`);
    console.log('It runs only while you are logged in; `loginctl enable-linger $USER` keeps it running after logout.');
    return;
  }
  throw new Error('Service installation is supported on macOS (launchd) and Linux (systemd --user)');
}
async function uninstallService(){
  let removed='';
  if(process.platform==='darwin'){
    if(existsSync(LAUNCH_AGENT_PATH)){spawnSync('launchctl',['bootout',`gui/${process.getuid!()}`,LAUNCH_AGENT_PATH],{stdio:'ignore'});unlinkSync(LAUNCH_AGENT_PATH);removed=LAUNCH_AGENT_PATH;}
  }else if(process.platform==='linux'&&existsSync(SYSTEMD_UNIT_PATH)){
    spawnSync('systemctl',['--user','disable','--now',SYSTEMD_UNIT],{stdio:'ignore'});
    unlinkSync(SYSTEMD_UNIT_PATH);
    spawnSync('systemctl',['--user','daemon-reload'],{stdio:'ignore'});
    removed=SYSTEMD_UNIT_PATH;
  }
  console.log(removed?`Login service removed: ${removed}`:'No login service was installed; user data was preserved');
}

/** One report that explains a machine, instead of only failing on it. */
async function doctor(options:CliOptions&{json?:boolean;compact?:boolean}){
  if(options.compact){const stateDir=state(options);const result=recordCompaction(stateDir,()=>compactDatabase(stateDir));if(result.error)throw new Error(result.error);return;}
  const environment=currentEnvironmentReport()??await applyProcessEnvironment({stateDir:state(options)});
  const settings=new SettingsService({stateDir:state(options),cliPath:options.cli});
  const machine=await machineReport();
  const checks=await doctorChecks({stateDir:state(options),host:options.host,port:options.port,settings,machine,daemon:await active(options)});
  if(checks.some(check=>check.status==='fail'))process.exitCode=1;
  if(!options.json){console.log(formatDoctorChecks(checks));return;}
  console.log(JSON.stringify({
    environment:{
      platform:environment.platform,
      shell:environment.shell,
      node:environment.node,
      pathSource:environment.path.source,
      path:environment.path.value,
      addedDirectories:environment.path.added,
      ...(environment.path.note?{pathNote:environment.path.note}:{}),
      droppedVariables:environment.dropped,
      serviceEnvironment:[...Object.keys(serviceEnvironment())],
    },
    capabilities:machine,
    checks,
  },null,2));
}

interface UpdateOptions extends CliOptions, RestartWaitOptions { check?: boolean; json?: boolean; app?: boolean; configuration?: string; }
interface UpdateHealth { ok?: boolean; version?: string; instanceId?: string; managedBy?: string; build?: BuildInfo; }

function updateRoot(): string {
  // Prefer the checkout containing this CLI: it remains correct if a clone was moved.
  for (const candidate of [entry.endsWith('.ts') ? resolve(dirname(entry), '../../..') : resolve(dirname(entry), '..'), SOURCE_ROOT]) {
    if (!candidate) continue;
    try { if (JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')).name === 'riffet') return realpathSync(candidate); } catch {}
  }
  throw new Error('无法关联 Riffet 源 clone，请从 clone 内构建并运行更新命令。');
}

async function updateHealth(record: DaemonRecord): Promise<UpdateHealth> {
  const response = await fetch(serverUrl(record) + '/health', { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('无法核对当前运行服务。');
  const health = await response.json() as UpdateHealth;
  if (!health.ok || health.instanceId !== record.instanceId) throw new Error('服务实例与 daemon.json 不一致，尚未执行更新。');
  return health;
}

/** Read-only SQLite access does not create stores, run migrations or start a backend. */
function assertUpdateIdle(options: CliOptions): void {
  const path = join(state(options), 'workbench.db');
  if (!existsSync(path)) throw new Error('无法核对服务任务状态，尚未停服。');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE json_extract(json,'$.state') IN ('starting','running','waiting','cancelling')").get() as { count: number };
    if (row.count > 0) throw new Error(`有 ${row.count} 个运行中或等待处理的会话，请处理完成后重试更新。`);
  } finally { db.close(); }
}

/** An npm install is replaced by npm itself; this only reports, and never touches the running service. */
async function updateNpm(options: UpdateOptions): Promise<void> {
  if (options.app || options.configuration) throw new Error('--app 仅用于源 clone 构建的 macOS App。');
  if (!options.check) {
    console.log(`这是 npm 安装。请运行 ${NPM_UPGRADE_COMMAND} 更新，再运行 riffet restart 使新版本生效。`);
    return;
  }
  const result = await checkNpmUpdate(SERVER_BUILD);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`当前版本：${SERVER_BUILD.version}`);
    console.log(result.message ?? result.status);
  }
  if (result.status === 'unavailable') process.exitCode = 1;
}

async function update(options: UpdateOptions): Promise<void> {
  if (options.json && !options.check) throw new Error('--json 仅用于 update --check。');
  if (options.configuration && !options.app) throw new Error('--configuration 仅用于 --app。');
  const waitSeconds = restartWaitSeconds(options);
  if (isNpmInstall()) return updateNpm(options);
  const root = updateRoot();
  const record = await active(options);
  let health: UpdateHealth | undefined;
  if (record) {
    try { health = await updateHealth(record); }
    catch (error) { if (!options.check) throw error; }
  }
  const app = options.app ? readAppInstallation(root, options.configuration) : undefined;
  const current = app?.build ?? (record ? health?.build ?? { version: health?.version ?? 'unknown', buildNumber: 0, tag: null, commit: null, dirty: true } : SERVER_BUILD);
  if (options.check) {
    const result = await checkForUpdates({ root, current });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`当前${options.app ? ' App' : ' Server'}：${current.tag ?? `${current.version}（开发构建）`} · ${current.commit?.slice(0, 12) ?? '未记录提交'}`);
      console.log(`最新发布：${result.latest?.tag ?? '未知'}`);
      if (result.source) console.log(`本地源码：${result.source.tag ?? result.source.commit?.slice(0, 12) ?? '未知'}${result.source.dirty ? ' · 有本地修改' : ''}`);
      console.log(result.message ?? result.status);
      if (result.latest && result.source?.commit === result.latest.commit && current.commit !== result.latest.commit) console.log('源码已更新，程序尚未生效；请构建并重启。');
    }
    if (result.status === 'unavailable' || result.status === 'conflict') process.exitCode = 1;
    return;
  }
  if (entry.endsWith('.ts') || realpathSync(entry) !== realpathSync(join(root, 'dist/cli.js'))) {
    throw new Error('请使用源 clone 的 riffet 快捷命令执行更新；内置 App CLI 和开发服务仅支持检查。');
  }
  if (record && options.app && ownsPid(record)) throw new Error('请先停止同一 clone 的 Server，并退出 App，再执行 riffet update --app。');
  if (record && !options.app) {
    if (health?.managedBy === 'app') throw new Error(`${APP_MANAGED}；其更新请使用 riffet update --app。`);
    if (!ownsPid(record)) throw new Error('当前状态目录的服务来自其他安装，不能从此 clone 更新它。');
    if (health?.managedBy !== 'cli' && health?.managedBy !== 'launchd') throw new Error('无法确认服务托管方式，请先手动停止服务再更新。');
  }
  const manager = record && !options.app ? health!.managedBy : undefined;
  const controller = async (args: string[]) => {
    const executable = process.platform === 'darwin' ? '/bin/launchctl' : 'systemctl';
    const result = await runProcess(executable, args, { cwd: root, timeoutMs: 30_000 });
    if (result.code !== 0 || result.timedOut || result.truncated) throw new Error(`${executable} 操作失败，请检查原服务管理器；更新尚未完成。`);
  };
  const domain = process.platform === 'darwin' ? `gui/${process.getuid!()}` : '';
  if (manager === 'launchd') {
    const serviceFile = process.platform === 'darwin' ? LAUNCH_AGENT_PATH : SYSTEMD_UNIT_PATH;
    const content = readFileSync(serviceFile, 'utf8');
    const expected = process.platform === 'darwin' ? xmlEscape(entry) : systemdValue(entry);
    const expectedState = process.platform === 'darwin' ? xmlEscape(state(options)) : systemdValue(state(options));
    if (!content.includes(expected) || !content.includes(expectedState)) throw new Error('登录服务未指向此 clone 和所选状态目录，尚未停服。');
  }
  if (manager !== 'launchd') {
    const serviceFile = process.platform === 'darwin' ? LAUNCH_AGENT_PATH : SYSTEMD_UNIT_PATH;
    if (existsSync(serviceFile)) {
      const content = readFileSync(serviceFile, 'utf8');
      const expected = process.platform === 'darwin' ? xmlEscape(entry) : systemdValue(entry);
      if (content.includes(expected)) {
        const running = await runProcess(process.platform === 'darwin' ? '/bin/launchctl' : 'systemctl', process.platform === 'darwin'
          ? ['print', `${domain}/local.riffet`] : ['--user', 'is-active', SYSTEMD_UNIT], { cwd: root });
        if (running.code === 0 || running.stdout.trim() === 'activating') throw new Error('登录服务仍已加载，但没有可核对的运行实例；请先通过原服务管理器停止，再执行更新。');
        if (running.timedOut || running.truncated || running.code === null) throw new Error('无法确认登录服务状态，请先手动停止服务。');
      }
    }
  }
  const recoveryCommand = options.app
    ? '请重新构建并打开 App，通过现有服务入口恢复 App 托管的服务。'
    : manager === 'launchd'
      ? process.platform === 'darwin' ? `launchctl bootstrap ${shellQuote(domain)} ${shellQuote(LAUNCH_AGENT_PATH)}` : 'systemctl --user start riffet.service'
      : `${shellQuote(process.execPath)} ${shellQuote(join(root, 'dist/cli.js'))} start --state-dir ${shellQuote(state(options))} --no-token`;
  await runSourceUpdate({
    root, current, app: options.app, configuration: options.configuration, runningPid: options.app ? undefined : record?.pid,
    lifecycle: {
      recoveryCommand,
      stop: async () => {
        if (appAgentLoaded()) throw new Error('App 托管服务仍已注册，请先在 App 服务设置中停止后重试。');
        if (options.app) {
          return;
        }
        if (!record) {
          return;
        }
        await updateHealth(record);
        // Turns of Claude, Cursor, Codex and Traex outlive the restart; only the ones it would end are waited for.
        // `--force` / `--wait-idle 0` stop without waiting, as `riffet restart` does; a service without the drain
        // endpoints falls back to refusing while any session is active.
        const release = waitSeconds > 0 ? await drainForRestart(record, token(options), { waitSeconds, log: console.log }) : undefined;
        try {
          if (waitSeconds > 0 && !release) assertUpdateIdle(options);
          if (manager === 'launchd') {
            await controller(process.platform === 'darwin' ? ['bootout', domain, LAUNCH_AGENT_PATH] : ['--user', 'stop', SYSTEMD_UNIT]);
          } else {
            process.kill(record.pid, 'SIGTERM');
          }
          for (let attempt = 0; attempt < 100 && pidExists(record.pid); attempt++) await sleep(100);
          if (pidExists(record.pid)) throw new Error('原服务未能正常停止，尚未修改源码；请检查任务与服务日志。');
        } catch (error) {
          // The service is still up: let it deliver again.
          await release?.();
          throw error;
        }
      },
      restore: async (release: ReleaseTag) => {
        if (!record) { console.log('构建已更新；服务原本停止，保持停止。'); return; }
        if (manager === 'launchd') {
          await controller(process.platform === 'darwin' ? ['bootstrap', domain, LAUNCH_AGENT_PATH] : ['--user', 'start', SYSTEMD_UNIT]);
        } else {
          // `start` bounds its own wait, which a compaction asked for on the settings page lengthens.
          const result = await runProcess(process.execPath, [join(root, 'dist/cli.js'), 'start', '--state-dir', state(options), '--no-token'], { cwd: root, timeoutMs: COMPACTION_WAIT_MS + 30_000 });
          if (result.code !== 0 || result.timedOut || result.truncated) throw new Error('新版本启动失败，请按更新日志中的命令恢复。');
        }
        const compactionLimit = Date.now() + COMPACTION_WAIT_MS;
        for (let attempt = 0; attempt < 100; attempt++) {
          // A compaction before the start does not use up the attempts, up to its own limit.
          if (attempt > 0 && Date.now() < compactionLimit && compactionRunning(state(options))) { attempt -= 1; await sleep(1000); continue; }
          const next = readDaemon(options);
          if (next && next.instanceId !== record.instanceId) {
            try {
              const ready = await updateHealth(next);
              if (ready.build?.tag === release.tag && ready.build.commit === release.commit && !ready.build.dirty) return;
            } catch { /* The replacement is still starting. */ }
          }
          await sleep(200);
        }
        throw new Error('新服务未报告目标 tag / commit，更新尚未确认生效。');
      },
    },
  });
}


export async function main(){
  const program=new Command().name('riffet').description('Local workbench for Cursor, Codex, Claude Code, DeepSeek Harness, Factory Droid and TRAE CLI sessions').version(SERVER_VERSION);
  // One environment for every entry point. Commander resolves the options first, so the state
  // directory — where the last good PATH is cached — is known before anything resolves a CLI.
  program.hook('preAction',async(_thisCommand,actionCommand)=>{
    const options=actionCommand.opts() as Partial<CliOptions>;
    const stateDir=options.stateDir?state({...options,stateDir:options.stateDir} as CliOptions):undefined;
    await applyProcessEnvironment({...stateDir?{stateDir}:{}});
    if(actionCommand.name()==='update'&&updateSshAuthSocket)process.env.SSH_AUTH_SOCK=updateSshAuthSocket;
  });
  configure(program.command('serve',{isDefault:true}).description('Run in the foreground')).option('--no-token','Hide login token').action(serve);
  configure(program.command('start').description('Start a background daemon')).option('--no-token','Hide login token').action(async(options:CliOptions,command:Command)=>start(resolveLaunchOptions(options,command,savedLaunchArgs(options))));
  configure(program.command('stop').description('Stop the daemon')).action(stop);
  configure(program.command('restart').description('Restart the daemon')).option('--no-token','Hide login token')
    .option('--wait-idle <seconds>','Seconds to wait for turns a restart would end (default 180; 0 restarts without waiting)')
    .option('--force','Restart without waiting, ending the turns a restart would end')
    .action(restart);
  configure(program.command('status').description('Show daemon status and login URL')).option('--no-token','Hide login token').action(async(options:CliOptions&{token:boolean})=>{const record=await active(options);if(record){show(record,options,options.token);const manager=await managedBy(record);if(manager)console.log(`Managed by: ${manager==='app'?'Riffet.app':manager==='launchd'?'login service (local.riffet)':'riffet start'}`);}else console.log(`Riffet is stopped · state: ${state(options)}`);});
  program.command('pair').description('Show LAN addresses, a one-use pairing code and a QR code').option('--state-dir <path>','Persistent workbench state',defaultState).option('--json','Print JSON containing a sensitive temporary pairing code').option('--url <url>','Address clients reach this server by (VPN name, SSH tunnel, HTTPS front door); a hostname must also be allowed with --allow-host').action(async(options:{stateDir:string;json?:boolean;url?:string})=>{const cliOptions=options as CliOptions;const url=options.url?publicOrigin(options.url):undefined;const record=await active(cliOptions);if(!record)throw new Error('Riffet is stopped. Run `riffet start --host 0.0.0.0 --auth`, then `riffet pair`.');const pairing=await requestCliPairing(record,token(cliOptions),fetch,{url});console.log(options.json?JSON.stringify(pairing,null,2):await formatCliPairing(pairing));});
  program.command('resume [conversation]').description('Continue a Riffet conversation in this terminal; Riffet follows it until the CLI exits').option('--state-dir <path>','Persistent workbench state',defaultState).option('--all','Choose among the conversations of every project').action(async(target:string|undefined,options:{stateDir:string;all?:boolean})=>{const cliOptions=options as CliOptions;const record=await active(cliOptions);if(!record)throw new Error('Riffet is stopped. Run `riffet start` first.');process.exitCode=await resumeInTerminal(record,token(cliOptions),{target,all:options.all});});
  configure(program.command('doctor').description('Check Node, tmux, every agent CLI, the port and the state directory')).option('--json','Print the full environment and capability report as JSON').option('--compact','Shrink workbench.db with VACUUM; the server must be stopped').action(doctor);
  configure(program.command('update').description('Check release versions, or update this source installation (an npm install reports the npm command)'))
    .option('--check','Only check published Git tags; do not change source or stop the server')
    .option('--json','Print the check result as JSON (requires --check)')
    .option('--app','Update the macOS App built in this clone instead of the standalone server')
    .option('--wait-idle <seconds>','Seconds to wait for turns a restart would end (default 180; 0 restarts without waiting)')
    .option('--force','Restart without waiting, ending the turns a restart would end')
    .option('--configuration <configuration>','Select Debug or Release when updating the App')
    .action(update);
  program.command('restore').description('Restore a verified backup into an empty state directory').requiredOption('--backup <path>','Backup directory').requiredOption('--state-dir <path>','Empty destination state directory').action(async(options:{backup:string;stateDir:string})=>{const result=await restoreBackup(options.backup,options.stateDir);console.log(`Restored ${result.files} files to ${result.path}`);});
  configure(program.command('install-service').description('Install the login service (launchd on macOS, systemd --user on Linux)')).option('--refresh-environment','Re-snapshot the resolved environment into an already installed service').action(installService);
  program.command('uninstall-service').description('Remove the login service').action(uninstallService);
  // Plugin packages: a running server does the work (a new version starts or is undone there); without one the files are changed directly.
  const plugin=program.command('plugin').description('Install and manage plugin packages');
  const pluginContext=async(options:{stateDir:string}):Promise<PluginCliContext>=>{const cliOptions=options as CliOptions;const daemon=await active(cliOptions);return {stateDir:state(cliOptions),...(daemon?{daemon}:{}),token:()=>token(cliOptions)};};
  const printLines=(lines:string[])=>{for(const line of lines)console.log(line);};
  const collectEntry=(value:string,previous:string[])=>[...previous,value];
  plugin.command('pack [directory]').description('Build, validate and archive a plugin from its source directory')
    .option('--format <format>','Archive format: tgz, tar.gz, zip or tar')
    .option('--out <path>','Archive output path')
    .option('--entry <name=source>','Additional server entry',collectEntry,[])
    .action(async(directory:string='.',options:{format?:string;out?:string;entry:string[]})=>{
      if(options.format&&!['tgz','tar.gz','zip','tar'].includes(options.format))throw new Error('Format must be tgz, tar.gz, zip or tar.');
      const packed=await packSource(directory,{format:(options.format==='tar.gz'?'tgz':options.format) as ArchiveFormat|undefined,out:options.out,entries:options.entry});
      console.log(packed.file);
      console.log(packed.integrity);
      for(const warning of packed.warnings)console.warn(warning);
    });
  plugin.command('dev [directory]').description('Build, link and watch a trusted local development plugin')
    .option('--state-dir <path>','Persistent workbench state',defaultState)
    .option('--entry <name=source>','Additional server entry',collectEntry,[])
    .action(async(directory:string='.',options:{stateDir:string;entry:string[]})=>{
      const watcher=await developPlugin(()=>pluginContext(options),directory,message=>console.log(message),{entries:options.entry});
      console.log('Watching for changes.');
      await new Promise<void>(done=>{
        const close=()=>{process.off('SIGINT',close);process.off('SIGTERM',close);watcher.close();done();};
        process.once('SIGINT',close);process.once('SIGTERM',close);
      });
    });
  plugin.command('unlink <id>').description('Stop a linked development plugin and remove its persistent link').option('--state-dir <path>','Persistent workbench state',defaultState).action(async(id:string,options:{stateDir:string})=>printLines(await unlinkDevelopmentPlugin(await pluginContext(options),id)));
  plugin.command('install <path|id>').description('Install a package directory or archive (.tgz, .tar.gz, .zip, .tar), or <id>[@version] from the plugin index').option('--state-dir <path>','Persistent workbench state',defaultState).option('--grant <capabilities>','Comma-separated capabilities to grant; must equal what the package asks for').option('--yes','Grant what the package asks for').option('--trusted','Run server code in Riffet with its full permissions; local operator only').action(async(path:string,options:{stateDir:string;grant?:string;yes?:boolean;trusted?:boolean})=>printLines(await installPlugin(await pluginContext(options),path,options)));
  plugin.command('list').description('List installed packages and their versions').option('--state-dir <path>','Persistent workbench state',defaultState).action(async(options:{stateDir:string})=>printLines(await listPlugins(await pluginContext(options))));
  plugin.command('logs <id>').description('Read recent plugin logs without activating it').option('--state-dir <path>','Persistent workbench state',defaultState).option('--limit <count>','Maximum entries (1–256)','100').action(async(id:string,options:{stateDir:string;limit:string})=>printLines(await readPluginLogs(await pluginContext(options),id,{limit:Number(options.limit)})));
  plugin.command('select <id> <version>').description('Run another installed version of a package').option('--state-dir <path>','Persistent workbench state',defaultState).action(async(id:string,version:string,options:{stateDir:string})=>printLines(await selectPlugin(await pluginContext(options),id,version)));
  plugin.command('uninstall <id> [version]').description('Remove a plugin or one installed version (settings and data are kept)').option('--state-dir <path>','Persistent workbench state',defaultState).option('--source <source>','Select installed or development when identities overlap').option('--path <path>','Select an exact development package directory').action(async(id:string,version:string|undefined,options:{stateDir:string;source?:'installed'|'development';path?:string})=>printLines(await uninstallPlugin(await pluginContext(options),id,version,options)));
  plugin.command('delete-data <id>').description('Delete a package\'s data directory and backups; this cannot be undone').option('--state-dir <path>','Persistent workbench state',defaultState).action(async(id:string,options:{stateDir:string})=>printLines(await deletePluginData(await pluginContext(options),id)));
  plugin.command('recovery <on|off>').description('Pause external plugins or restore their enablement policies').option('--state-dir <path>','Persistent workbench state',defaultState).action(async(mode:string,options:{stateDir:string})=>printLines(await recoverPlugins(await pluginContext(options),mode)));
  for (const action of ['reload', 'diagnostics'] as const) plugin.command(action + ' <id>').description(action === 'reload' ? 'Reload one plugin' : 'Run diagnostics for one plugin').option('--state-dir <path>','Persistent workbench state',defaultState).action(async(id:string,options:{stateDir:string})=>printLines(await inspectPlugin(await pluginContext(options),id,action)));
  await program.parseAsync(process.argv);
}
if(process.argv[1]&&existsSync(process.argv[1])&&realpathSync(process.argv[1])===realpathSync(entry))main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
