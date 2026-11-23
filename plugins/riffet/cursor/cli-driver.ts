import { spawn,type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { ApprovalMode, CursorCliSettings } from '@contracts';
import { AppError, mergePath, resolveCliExecutable, runProcess, shellFunctionInvocation, type ProcessOptions } from '@riffet/plugin-api/kit';
import { homedir } from 'node:os';
import { isAbsolute,resolve,join } from 'node:path';

export const APPROVAL_MODES: ApprovalMode[] = ['allowlist','auto-review','unrestricted'];

/**
 * The CLI's launch flags for an approval mode. `allowlist` is the CLI's own default and needs none;
 * `--auto-review` and `--force` are different autorun modes, so they are never passed together.
 */
export function approvalArgs(approval: ApprovalMode|string|undefined): string[] {
  if(approval==='unrestricted'||approval==='dontAsk')return ['--force'];
  if(approval==='auto-review')return ['--auto-review'];
  if(approval!==undefined&&approval!=='allowlist')throw new AppError('INVALID_APPROVAL_MODE','Choose a supported Cursor approval mode');
  return [];
}

/**
 * Kept for callers that only want the historical behaviour: a bare PATH still gets the official
 * installer's directory. New code should call `applyProcessEnvironment`, which resolves the whole
 * environment (node prefix included) instead of appending one directory to a possibly empty PATH.
 */
export function withCliInstallDir(path:string|undefined,home=homedir()):string {
  return mergePath([path,join(home,'.local/bin')]);
}

export interface CursorLaunchProfile {
  readonly executable:string;
  readonly configDir:string;
  readonly apiEndpoint?:string;
  readonly agentEndpoint?:string;
  readonly disableAutoUpdate:boolean;
  /** Stable hash of non-secret launch settings; safe for runtime cache keys. */
  readonly identityKey:string;
}
const profileSecrets=new WeakMap<CursorLaunchProfile,string>();

export interface CursorCommand {command:string;args:string[];env:NodeJS.ProcessEnv;custom:boolean;tmuxEnv?:Record<string,string>;}
export interface CursorCommandOptions { includeApiKey?:boolean; terminal?:boolean; }

function checkedString(value:unknown,key:string,max=4096):string|undefined {
  if(value===undefined)return undefined;
  if(typeof value!=='string'||value.length>max||/[\0\r\n]/.test(value))throw new AppError('INVALID_SETTINGS',`${key} is invalid`);
  const trimmed=value.trim();
  return trimmed||undefined;
}

function checkedPath(value:unknown,key:string):string|undefined {
  let text=checkedString(value,key,8192);
  if(!text)return undefined;
  if(text==='~'||text.startsWith('~/'))text=join(homedir(),text.slice(2));
  if(!isAbsolute(text))throw new AppError('INVALID_SETTINGS',`${key} must be an absolute path`);
  return resolve(text);
}

function checkedEndpoint(value:unknown,key:string):string|undefined {
  const text=checkedString(value,key);
  if(!text)return undefined;
  try {
    const url=new URL(text);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('unsafe endpoint');
    return url.toString().replace(/\/$/,'')||url.origin;
  } catch { throw new AppError('INVALID_SETTINGS',`${key} must be an HTTP(S) URL without credentials, query parameters, or fragments`); }
}

/** The single process-wide Cursor launch snapshot. API key contents are deliberately never held here. */
export function resolveCursorLaunchProfile(settings:CursorCliSettings|undefined,legacyCliPath?:string,apiKeySnapshot?:string):CursorLaunchProfile {
  if(settings!==undefined&&(!settings||typeof settings!=='object'||Array.isArray(settings)))throw new AppError('INVALID_SETTINGS','cursorCli must be an object');
  const executable=checkedString(settings?.executable,'cursorCli.executable',2048)??checkedString(legacyCliPath,'cliPath',2048)??process.env.RIFFET_CLI??'cursor-agent';
  if(executable.startsWith('shell:')&&!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(executable.slice(6)))throw new AppError('INVALID_SETTINGS','cursorCli.executable shell launcher is invalid');
  const configDir=checkedPath(settings?.configDir,'cursorCli.configDir')??checkedPath(process.env.RIFFET_CONFIG_DIR,'RIFFET_CONFIG_DIR')??checkedPath(process.env.CURSOR_CONFIG_DIR,'CURSOR_CONFIG_DIR')??resolve(join(homedir(),'.cursor'));
  const apiEndpoint=checkedEndpoint(settings?.apiEndpoint,'cursorCli.apiEndpoint');
  const agentEndpoint=checkedEndpoint(settings?.agentEndpoint,'cursorCli.agentEndpoint');
  if(settings?.disableAutoUpdate!==undefined&&typeof settings.disableAutoUpdate!=='boolean')throw new AppError('INVALID_SETTINGS','cursorCli.disableAutoUpdate must be a boolean');
  const disableAutoUpdate=settings?.disableAutoUpdate??false;
  const identityKey=createHash('sha256').update(JSON.stringify({executable,configDir,apiEndpoint,agentEndpoint,disableAutoUpdate})).digest('hex');
  const profile=Object.freeze({executable,configDir,...(apiEndpoint?{apiEndpoint}:{}),...(agentEndpoint?{agentEndpoint}:{}),disableAutoUpdate,identityKey});
  if(apiKeySnapshot!==undefined){
    if(!apiKeySnapshot||/[\r\n\0]|\s/.test(apiKeySnapshot)||apiKeySnapshot.length>64*1024)throw new AppError('CURSOR_API_KEY_UNAVAILABLE','The configured Cursor API key is unavailable or invalid');
    profileSecrets.set(profile,apiKeySnapshot);
  }
  return profile;
}

/**
 * The launch profile a profile config of the Cursor backend resolves to: the stored CLI settings, the
 * key, and `cliPath`, the executable the server was started with, which the settings' own executable overrides.
 * Throws `INVALID_SETTINGS` for a config the CLI could not be launched with.
 */
export function cursorLaunchProfileOf(config:Record<string,unknown>):CursorLaunchProfile {
  return resolveCursorLaunchProfile(config as CursorCliSettings,typeof config.cliPath==='string'?config.cliPath:undefined,typeof config.apiKey==='string'?config.apiKey:undefined);
}

function profileOf(value:string|CursorLaunchProfile):CursorLaunchProfile {
  return typeof value==='string'?resolveCursorLaunchProfile(undefined,value):value;
}

export function cursorConfigDirectory(cli:string|CursorLaunchProfile):string {
  return typeof cli==='string'?resolveCursorLaunchProfile(undefined,cli).configDir:cli.configDir;
}

/**
 * Derives a launch profile pointed at another configuration directory (the personal assistant's
 * isolated directory) while keeping the same executable, endpoints, secret key and startup-cache front.
 */
export function withCursorConfigDir(profile:CursorLaunchProfile,configDir:string):CursorLaunchProfile {
  const resolved=resolve(configDir);
  if(resolved===profile.configDir)return profile;
  const identityKey=createHash('sha256').update(JSON.stringify({executable:profile.executable,configDir:resolved,apiEndpoint:profile.apiEndpoint,agentEndpoint:profile.agentEndpoint,disableAutoUpdate:profile.disableAutoUpdate})).digest('hex');
  const derived=Object.freeze({...profile,configDir:resolved,identityKey});
  const secret=profileSecrets.get(profile);
  if(secret!==undefined)profileSecrets.set(derived,secret);
  const front=apiFronts.get(profile);
  if(front)apiFronts.set(derived,front);
  let set=derivedProfiles.get(profile);
  if(!set){set=new Set();derivedProfiles.set(profile,set);}
  set.add(derived);
  return derived;
}

/** A running startup-query front (backend/api-cache.ts) per launch profile; launches go through it while it is set. */
const apiFronts=new WeakMap<CursorLaunchProfile,string>();
const derivedProfiles=new WeakMap<CursorLaunchProfile,Set<CursorLaunchProfile>>();

export function setCursorApiFront(profile:CursorLaunchProfile,url:string|undefined):void {
  if(url)apiFronts.set(profile,url);else apiFronts.delete(profile);
  for(const derived of derivedProfiles.get(profile)??[]){
    if(url)apiFronts.set(derived,url);else apiFronts.delete(derived);
  }
}

/**
 * Whether a profile's API endpoint may be fronted: a custom gateway whose agent stream has its own
 * explicit endpoint. Without one the CLI would derive the agent URL from the front, and Cursor's own
 * hosts are left as they are.
 */
export function cursorApiFrontable(profile:CursorLaunchProfile,relayGateway=false):boolean {
  if(!profile.apiEndpoint||!(relayGateway||profile.agentEndpoint))return false;
  return !new URL(profile.apiEndpoint).hostname.endsWith('.cursor.sh');
}

function launchArgs(profile:CursorLaunchProfile,relayGateway=false):{args:string[];front?:string} {
  const agentEndpoint=relayGateway?profile.apiEndpoint:profile.agentEndpoint;
  const front=cursorApiFrontable(profile,relayGateway)?apiFronts.get(profile):undefined;
  const endpoint=front??profile.apiEndpoint;
  return {args:[...(endpoint?['--endpoint',endpoint]:[]),...(agentEndpoint?['--agent-endpoint',agentEndpoint]:[]),...(profile.disableAutoUpdate?['--disable-auto-update']:[])],...(front?{front}:{})};
}

/** Byte Relay speaks HTTP/1. Preserve the user's other native CLI settings. */
function prepareRelayTransport(configDir:string):void {
  let path=join(configDir,'cli-config.json');
  let temporary:string|undefined;
  try {
    let present=false;
    try {lstatSync(path);present=true;}
    catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    // Replace the managed file atomically while preserving any configuration link.
    // A dangling link is an error, rather than permission to replace the link.
    if(present)path=realpathSync(path);
    let settings:Record<string,unknown>={};
    try {
      const value:unknown=JSON.parse(readFileSync(path,'utf8'));
      if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid CLI settings');
      settings=value as Record<string,unknown>;
    } catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    }
    const network=settings.network;
    if(network!==undefined&&(!network||typeof network!=='object'||Array.isArray(network)))throw new Error('invalid CLI network settings');
    if((network as Record<string,unknown>|undefined)?.useHttp1ForAgent===true)return;
    settings.network={...(network as Record<string,unknown>|undefined),useHttp1ForAgent:true};
    mkdirSync(configDir,{recursive:true,mode:0o700});
    temporary=path+'.'+randomBytes(8).toString('hex')+'.tmp';
    writeFileSync(temporary,JSON.stringify(settings,null,2)+'\n',{mode:0o600,flag:'wx'});
    renameSync(temporary,path);
    temporary=undefined;
  } catch {
    throw new AppError('CURSOR_CONFIG_UNAVAILABLE','Cannot prepare Byte Relay transport. Check that the Cursor configuration directory is writable and cli-config.json is valid JSON.');
  } finally {
    if(temporary)try{unlinkSync(temporary);}catch{}
  }
}

/** All Cursor subprocesses share global flags and environment from the same immutable profile. */
export function cursorCommand(input:string|CursorLaunchProfile,args:string[],env:NodeJS.ProcessEnv={},options:CursorCommandOptions={}):CursorCommand {
  const profile=profileOf(input);
  if(!profile.executable||profile.executable.includes('\0')||args.some(arg=>typeof arg!=='string'||arg.includes('\0')))throw new AppError('INVALID_CLI_COMMAND','Cursor launch command is invalid');
  const functionName=profile.executable.startsWith('shell:')?profile.executable.slice(6):undefined;
  // A bare `cursor-agent` is resolved here rather than by PATH at spawn time: the daemon may run
  // without the npm prefix the CLI was installed under, and an absolute path removes the question.
  let command=functionName?profile.executable:resolveCliExecutable({command:profile.executable}).executable;
  let childEnv:NodeJS.ProcessEnv={...process.env,CURSOR_CONFIG_DIR:profile.configDir,...env};
  let apiKey=profileSecrets.get(profile)??childEnv.CURSOR_API_KEY;
  if(options.includeApiKey===false){delete childEnv.CURSOR_API_KEY;apiKey=undefined;}
  else if(apiKey!==undefined)childEnv.CURSOR_API_KEY=apiKey;
  const relayGateway=Boolean(profile.apiEndpoint&&apiKey&&/^br-[a-f0-9]{32}$/.test(apiKey));
  if(relayGateway){
    childEnv.CURSOR_CONFIG_DIR=profile.configDir;
    prepareRelayTransport(profile.configDir);
  }
  const launch=launchArgs(profile,relayGateway);
  // The CLI names its website after the API origin; behind the front that would be the loopback address.
  const website=launch.front&&!childEnv.CURSOR_WEBSITE_URL?new URL(profile.apiEndpoint!).origin:undefined;
  if(website)childEnv.CURSOR_WEBSITE_URL=website;
  let commandArgs=[...launch.args,...args];
  if(functionName){
    if(!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(functionName))throw new AppError('INVALID_CLI_COMMAND','Shell launcher must name one function or command');
    // The function lives in the user's own startup file, so run it in the user's own shell.
    const invocation=shellFunctionInvocation(functionName,commandArgs);
    command=invocation.command;
    commandArgs=invocation.args;
  }
  // An explicit server-side key must work without an interactive OS credential store.
  if(apiKey!==undefined)childEnv.AGENT_CLI_CREDENTIAL_STORE='memory';
  let tmuxEnv:Record<string,string>|undefined;
  if(options.terminal){
    tmuxEnv={CURSOR_CONFIG_DIR:profile.configDir,...(env.CURSOR_DATA_DIR?{CURSOR_DATA_DIR:env.CURSOR_DATA_DIR}:{}),...(apiKey!==undefined?{AGENT_CLI_CREDENTIAL_STORE:'memory'}:{}),...(website?{CURSOR_WEBSITE_URL:website}:{}),...(env.NO_OPEN_BROWSER?{NO_OPEN_BROWSER:env.NO_OPEN_BROWSER}:{})};
  }
  return {command,args:commandArgs,env:childEnv,custom:Boolean(functionName||profileSecrets.has(profile)||profile.apiEndpoint||profile.agentEndpoint||apiKey||process.env.CURSOR_API_KEY),...(tmuxEnv?{tmuxEnv}:{})};
}

/** The environment names a Cursor terminal launch hands over through the terminal host's process environment; the key is the only credential. */
export const CURSOR_LAUNCH_ENV={managed:['CURSOR_API_KEY','AGENT_CLI_CREDENTIAL_STORE'],secrets:['CURSOR_API_KEY']} as const;

/**
 * A Cursor CLI invocation as the generic terminal launch: the pane's environment as `env`, and the key
 * with the credential-store mode as `secretEnv`, which reaches the pane through the terminal host's own
 * process environment instead of any command line. `paneEnv` is what the pane adds besides (the live tap).
 */
export function cursorLaunchSpec(input:string|CursorLaunchProfile,args:string[],env:NodeJS.ProcessEnv,cwd:string,options:{title?:string;paneEnv?:Record<string,string>}={}):{command:string;args:string[];env?:Record<string,string>;secretEnv?:Record<string,string>;cwd:string;title?:string} {
  const spec=cursorCommand(input,args,env,{terminal:true});
  const secretEnv:Record<string,string>={};
  for(const name of CURSOR_LAUNCH_ENV.managed){const value=spec.env[name];if(value!==undefined)secretEnv[name]=value;}
  const paneEnv={...spec.tmuxEnv,...options.paneEnv};
  return {command:spec.command,args:spec.args,...(Object.keys(paneEnv).length?{env:paneEnv}:{}),...(Object.keys(secretEnv).length?{secretEnv}:{}),cwd,...(options.title?{title:options.title}:{})};
}

export function spawnCursor(cliPath:string|CursorLaunchProfile,args:string[],options:{cwd?:string;env?:NodeJS.ProcessEnv;detached?:boolean;includeApiKey?:boolean}={}):ChildProcessWithoutNullStreams {
  const spec=cursorCommand(cliPath,args,options.env,{includeApiKey:options.includeApiKey});
  return spawn(spec.command,spec.args,{cwd:options.cwd,env:spec.env,detached:options.detached??process.platform!=='win32',stdio:['pipe','pipe','pipe'],windowsHide:true});
}
export function killCursor(child:ChildProcessWithoutNullStreams,signal:NodeJS.Signals='SIGTERM') {
  if(child.pid&&process.platform!=='win32'){try{process.kill(-child.pid,signal);return;}catch{}}
  try{child.kill(signal);}catch{}
}

function redactOutput(output:string,secret:string|undefined):string {
  return secret?output.split(secret).join('[REDACTED]'):output;
}

/** Terminal failures use the same private launch snapshot as non-interactive CLI output. */
export function redactCursorOutput(input:string|CursorLaunchProfile,output:string):string {
  return redactOutput(output,profileSecrets.get(profileOf(input))??process.env.CURSOR_API_KEY);
}

export function runCursor(cliPath:string|CursorLaunchProfile,args:string[],options:ProcessOptions&{env?:NodeJS.ProcessEnv;includeApiKey?:boolean}) {
  const spec=cursorCommand(cliPath,args,options.env,{includeApiKey:options.includeApiKey});
  const secret=spec.env.CURSOR_API_KEY;
  return runProcess(spec.command,spec.args,{...options,env:spec.env}).then(result=>{
    if(!secret)return result;
    const stdout=redactOutput(result.stdout,secret),stderr=redactOutput(result.stderr,secret);
    return {...result,stdout,stderr,stdoutData:Buffer.from(stdout),stderrData:Buffer.from(stderr)};
  });
}
