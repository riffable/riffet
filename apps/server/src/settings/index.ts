import { mkdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ASSISTANT_BUDGET, AUXILIARY_MODEL_PURPOSES, MODEL_PICKER_BUDGET, rememberProfileModel, isAssistantBackend, DEFAULT_QUICK_CHAT_PRESETS, NATIVE_MODEL_API_PROTOCOLS, SIDEBAR_PINNED_MAX, type NativeModelApiProtocol, type QuickChatSettings, type AssistantSettings, type RemoteSpeechSettings, type VoiceInputSettings, type WorkItemSettings, type AppSettings, type AppSettingsUpdate, type AuxiliaryModelPurpose, type AuxiliaryModelRef, type AuxiliaryModels, type ModelContextWindows, type ModelInputModalities, type ModelInputModality, type NativeBackendDefaults, type NativeBackendId, type NativeBackendProfileSettings, type NativeBackendProfileSettingsUpdate, type NativeBackendProfilesResponse, type NativeModelSource } from '../../../../packages/contracts/src/index.js';
import type { AgentProfile } from '@riffet/plugin-api/experimental/agent';
import { isContributionOf, PLUGIN_ID } from '../../../../packages/contracts/src/plugins.js';
import { AppError } from '../errors.js';
import { isNativeBackendId } from '../backends/registry.js';
import { AUXILIARY_MODEL_BACKENDS } from '../auxiliary/gateway.js';
import { CursorSettingsCompat, type StoredCursorCli } from './cursor-compat.js';
import { atomicWritePrivateFile, readPrivateSettingsFile, validateApiKey } from './private-file.js';
import { validateTitleRules } from './title-rules.js';

const MAX_NATIVE_PROFILE_BYTES = 512 * 1024;

interface StoredNativeProfile extends Omit<NativeBackendProfileSettings, 'hasApiKey' | 'isDefault'> { apiKey?: string; }
type StoredNativeProfiles = Partial<Record<NativeBackendId, StoredNativeProfile[]>>;

/** A curated model allowlist. An empty array is a meaningful choice and is preserved. */
function validateEnabledModels(value:unknown,code:string,key:string):string[] {
  if(!Array.isArray(value)||value.length>1000)throw new AppError(code,`${key} must be an array of model ids`);
  const result:string[]=[];
  for(const item of value){
    if(typeof item!=='string'||!item.trim()||item.length>512||/[\0\r\n]/.test(item))throw new AppError(code,`${key} contains an invalid model id`);
    if(!result.includes(item))result.push(item);
  }
  return result;
}

/**
 * Declared input types per model id. At least one type per entry, because an empty list would mean
 * "accepts nothing"; an entry the user never answered for is simply absent and the backend's own
 * answer stands.
 */
/** A declared window must be a whole token count a model could plausibly have. */
const MIN_CONTEXT_WINDOW=1_000;
const MAX_CONTEXT_WINDOW=100_000_000;

/** Declared context windows per model id; an id the user left alone is absent and the gateway's answer stands. */
function validateModelContextWindows(value:unknown,code:string,key:string):ModelContextWindows {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError(code,`${key} must be an object keyed by model id`);
  const entries=Object.entries(value as Record<string,unknown>);
  if(entries.length>1000)throw new AppError(code,`${key} declares too many models`);
  const result:ModelContextWindows={};
  for(const [id,raw] of entries){
    if(!id.trim()||id.length>512||/[\0\r\n]/.test(id))throw new AppError(code,`${key} contains an invalid model id`);
    if(typeof raw!=='number'||!Number.isSafeInteger(raw)||raw<MIN_CONTEXT_WINDOW||raw>MAX_CONTEXT_WINDOW)throw new AppError(code,`${key}[${id}] must be a whole number of tokens between ${MIN_CONTEXT_WINDOW} and ${MAX_CONTEXT_WINDOW}`);
    result[id]=raw;
  }
  return result;
}

function validateModelInputModalities(value:unknown,code:string,key:string):ModelInputModalities {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError(code,`${key} must be an object keyed by model id`);
  const entries=Object.entries(value as Record<string,unknown>);
  if(entries.length>1000)throw new AppError(code,`${key} declares too many models`);
  const result:ModelInputModalities={};
  for(const [id,raw] of entries){
    if(!id.trim()||id.length>512||/[\0\r\n]/.test(id))throw new AppError(code,`${key} contains an invalid model id`);
    if(!Array.isArray(raw)||raw.length===0||raw.length>2)throw new AppError(code,`${key}[${id}] must list one or two input types`);
    const modalities:ModelInputModality[]=[];
    for(const item of raw){
      if(item!=='text'&&item!=='image')throw new AppError(code,`${key}[${id}] contains an unknown input type`);
      if(!modalities.includes(item))modalities.push(item);
    }
    result[id]=modalities;
  }
  return result;
}

function validateNativeProfilePath(value:unknown,key:string):string {
  if(typeof value!=='string'||!value.trim()||value.length>8192||/[\0\r\n]/.test(value.trim()))throw new AppError('INVALID_BACKEND_PROFILE',`${key} is invalid`);
  let candidate=value.trim();
  if(candidate==='~'||candidate.startsWith('~/'))candidate=path.join(os.homedir(),candidate.slice(candidate==='~'?1:2));
  if(!path.isAbsolute(candidate))throw new AppError('INVALID_BACKEND_PROFILE',`${key} must be an absolute path`);
  return path.resolve(candidate);
}

export const MODEL_SOURCE_ID=/^[a-z0-9][a-z0-9.-]{0,63}$/;

/**
 * Only the spelling is checked: sources come from plugins, and one that is off or not built
 * into this server must not make the profile file unreadable. Such a name is kept and resolves to nothing.
 */
export function validateNativeModelSource(value:unknown,code='INVALID_BACKEND_PROFILE'):NativeModelSource {
  if(typeof value!=='string'||!MODEL_SOURCE_ID.test(value))throw new AppError(code,'modelSource must be a lowercase source id');
  return value;
}

export function validateNativeModelApiProtocol(value: unknown, code = 'INVALID_BACKEND_PROFILE'): NativeModelApiProtocol {
  if (typeof value !== 'string' || !NATIVE_MODEL_API_PROTOCOLS.includes(value as NativeModelApiProtocol)) {
    throw new AppError(code, 'Choose a supported model API protocol');
  }
  return value as NativeModelApiProtocol;
}

export function validateNativeProfileEndpoint(value:unknown,key:string):string {
  // A pasted address often brings its line break along; only a break inside it is malformed.
  if(typeof value!=='string'||value.length>8192||/[\0\r\n]/.test(value.trim()))throw new AppError('INVALID_BACKEND_PROFILE',`${key} is invalid`);
  try{
    const endpoint=new URL(value.trim());
    if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('invalid endpoint');
    return endpoint.toString().replace(/\/$/,'')||endpoint.origin;
  }catch{throw new AppError('INVALID_BACKEND_PROFILE',`${key} must be an HTTP(S) URL without credentials, query parameters, or fragments`);}
}

export class SettingsService {
  readonly stateDir: string;
  private readonly cursor: CursorSettingsCompat;
  private readonly consumesModelSources: (backendId: NativeBackendId) => boolean;
  /**
   * `cliPath` is the executable the server was started with, handed to the backend that had one first as
   * a fallback. `validateProfileConfig` asks that backend's driver whether a config can launch it, before it is saved.
   * `consumesModelSources` says whether a backend's profiles can name a model source (it consumes a gateway protocol); without it none can.
   */
  constructor(options: { cliPath?: string; stateDir: string; validateProfileConfig?(backendId: NativeBackendId, config: Record<string, unknown>): void; consumesModelSources?(backendId: NativeBackendId): boolean }) {
    if (!options?.stateDir || !path.isAbsolute(options.stateDir)) throw new AppError('INVALID_STATE_DIR', 'stateDir must be an absolute path');
    this.stateDir = path.resolve(options.stateDir);
    this.consumesModelSources = options.consumesModelSources ?? (() => false);
    this.cursor = new CursorSettingsCompat({ stateDir: this.stateDir, cliPath: options.cliPath, validateProfileConfig: options.validateProfileConfig });
    // Unreadable settings fail the start, not the first request.
    this.getSettings();
  }

  private nativeProfilesPath():string { return path.join(this.stateDir,'native-backend-profiles.json'); }

  private readNativeProfiles():StoredNativeProfiles {
    const text=readPrivateSettingsFile(this.nativeProfilesPath(),MAX_NATIVE_PROFILE_BYTES);
    if(text===undefined)return {};
    let parsed:unknown;
    try{parsed=JSON.parse(text);}catch{throw new AppError('NATIVE_PROFILE_SETTINGS_CORRUPT','Native backend profiles are unavailable or invalid',500);}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new AppError('NATIVE_PROFILE_SETTINGS_CORRUPT','Native backend profiles are unavailable or invalid',500);
    const result:StoredNativeProfiles={};
    for(const [backend,rawProfiles] of Object.entries(parsed as Record<string,unknown>)){
      if(!isNativeBackendId(backend)||!Array.isArray(rawProfiles)||rawProfiles.length>100)throw new AppError('NATIVE_PROFILE_SETTINGS_CORRUPT','Native backend profiles are unavailable or invalid',500);
      const seen=new Set<string>();
      result[backend as NativeBackendId]=rawProfiles.map(raw=>{
        if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new AppError('NATIVE_PROFILE_SETTINGS_CORRUPT','Native backend profile is invalid',500);
        const item=raw as Record<string,unknown>;
        if(Object.keys(item).some(key=>!['id','backendId','name','description','executable','configDir','sourceDir','apiEndpoint','agentEndpoint','apiProtocol','disableAutoUpdate','defaultModel','enabledModels','modelInputModalities','modelContextWindows','modelSource','apiKey'].includes(key)))throw new AppError('NATIVE_PROFILE_SETTINGS_CORRUPT','Native backend profile has an unknown field',500);
        const id=String(item.id??'');
        if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id)||seen.has(id))throw new AppError('NATIVE_PROFILE_SETTINGS_CORRUPT','Native backend profile id is invalid',500);
        seen.add(id);
        if(item.backendId!==backend||typeof item.name!=='string'||!item.name||item.name.length>80)throw new AppError('NATIVE_PROFILE_SETTINGS_CORRUPT','Native backend profile metadata is invalid',500);
        const value={id,backendId:backend as NativeBackendId,name:item.name} as StoredNativeProfile;
        if(item.description!==undefined){if(typeof item.description!=='string'||item.description.length>200)throw new AppError('NATIVE_PROFILE_SETTINGS_CORRUPT','Native backend profile description is invalid',500);value.description=item.description;}
        for(const key of ['executable','configDir','sourceDir','apiEndpoint','agentEndpoint','defaultModel'] as const){const field=item[key];if(field!==undefined){if(typeof field!=='string'||field.length>8192||/[\0\r\n]/.test(field))throw new AppError('NATIVE_PROFILE_SETTINGS_CORRUPT','Native backend profile option is invalid',500);value[key]=field;}}
        if(item.apiProtocol!==undefined)value.apiProtocol=validateNativeModelApiProtocol(item.apiProtocol,'NATIVE_PROFILE_SETTINGS_CORRUPT');
        if(item.modelSource!==undefined)value.modelSource=validateNativeModelSource(item.modelSource,'NATIVE_PROFILE_SETTINGS_CORRUPT');
        if(item.disableAutoUpdate!==undefined){if(typeof item.disableAutoUpdate!=='boolean')throw new AppError('NATIVE_PROFILE_SETTINGS_CORRUPT','Native backend profile option is invalid',500);value.disableAutoUpdate=item.disableAutoUpdate;}
        if(item.enabledModels!==undefined)value.enabledModels=validateEnabledModels(item.enabledModels,'NATIVE_PROFILE_SETTINGS_CORRUPT','Native backend profile enabledModels');
        if(item.modelInputModalities!==undefined)value.modelInputModalities=validateModelInputModalities(item.modelInputModalities,'NATIVE_PROFILE_SETTINGS_CORRUPT','Native backend profile modelInputModalities');
        if(item.modelContextWindows!==undefined)value.modelContextWindows=validateModelContextWindows(item.modelContextWindows,'NATIVE_PROFILE_SETTINGS_CORRUPT','Native backend profile modelContextWindows');
        if(item.apiKey!==undefined)value.apiKey=validateApiKey(item.apiKey);
        return value;
      });
    }
    return result;
  }

  getNativeBackendProfiles(backendId:NativeBackendId):NativeBackendProfilesResponse {
    const profiles=this.readNativeProfiles()[backendId]??[];
    const saved=this.getSettings();
    const defaultProfileId=saved.nativeBackendDefaults?.[backendId]?.profileId??this.cursor.defaultProfileId(backendId);
    const mapped=profiles.map(({apiKey,...profile})=>({...profile,...(apiKey?{hasApiKey:true}:{hasApiKey:false}),...(profile.id===defaultProfileId?{isDefault:true}:{})}));
    this.cursor.addDefaultProfile(backendId,mapped,saved,defaultProfileId);
    return {profiles:mapped,...(defaultProfileId?{defaultProfileId}:{})};
  }

  /** The profiles of a backend as a plugin's Agent sees them, `config` included: what a check that runs without a session reads (`PluginHost.agentProfiles`). */
  agentProfiles(backendId:NativeBackendId):AgentProfile[] {
    return this.getNativeBackendProfiles(backendId).profiles.map(profile=>({id:profile.id,name:profile.name,...(profile.description!==undefined?{description:profile.description}:{}),...(profile.isDefault?{isDefault:true}:{}),config:this.getNativeBackendProfileConfig(backendId,profile.id)??{}}));
  }

  /** Model sources saved profiles name, whether or not anything provides them. An unreadable file names none. */
  savedModelSources():string[] {
    let profiles:StoredNativeProfiles;
    try{profiles=this.readNativeProfiles();}catch{return [];}
    return Object.values(profiles).flatMap(items=>(items??[]).flatMap(item=>item.modelSource?[item.modelSource]:[]));
  }

  getNativeBackendProfileConfig(backendId:NativeBackendId,profileId:string):Record<string,unknown>|undefined {
    const profile=this.readNativeProfiles()[backendId]?.find(item=>item.id===profileId);
    if(!profile)return this.cursor.profileConfig(backendId,profileId,()=>this.readSettings().cursorCli);
    const {id:_id,backendId:_backendId,name:_name,description:_description,apiKey,...config}=profile;
    return {...config,...(apiKey?{apiKey}:{})};
  }

  deleteNativeBackendProfile(backendId:NativeBackendId,profileId:string):NativeBackendProfilesResponse {
    this.cursor.refuseDelete(backendId);
    const profiles=this.readNativeProfiles();
    const items=profiles[backendId]??[];
    if(!items.some(item=>item.id===profileId))throw new AppError('NATIVE_PROFILE_NOT_FOUND','Native backend profile does not exist',404);
    profiles[backendId]=items.filter(item=>item.id!==profileId);
    atomicWritePrivateFile(this.nativeProfilesPath(),JSON.stringify(profiles,null,2)+'\n');
    const defaults=this.getSettings().nativeBackendDefaults;
    // A default pointing at a deleted profile would silently fall back to a different one, so the
    // pointer is dropped with it.
    if(defaults?.[backendId]?.profileId===profileId){
      const {profileId:_dropped,...rest}=defaults[backendId]!;
      this.setSettings({nativeBackendDefaults:{...defaults,[backendId]:rest}});
    }
    return this.getNativeBackendProfiles(backendId);
  }

  saveNativeBackendProfile(backendId:NativeBackendId,profileId:string,input:NativeBackendProfileSettingsUpdate,create=false,materializeBuiltin=false,resolvedDefaultProfileId?:string):NativeBackendProfilesResponse {
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(profileId))throw new AppError('INVALID_BACKEND_PROFILE','Profile id is invalid');
    if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError('INVALID_BACKEND_PROFILE','Profile settings must be an object');
    const values=input as Record<string,unknown>;
    const allowed=new Set(['name','description','executable','configDir','sourceDir','apiEndpoint','agentEndpoint','apiProtocol','disableAutoUpdate','defaultModel','enabledModels','modelInputModalities','modelContextWindows','modelSource','apiKey']);
    for(const key of Object.keys(values))if(!allowed.has(key))throw new AppError('INVALID_BACKEND_PROFILE',`Unknown native profile setting: ${key}`);
    this.cursor.refuseCuratedModels(backendId,values);
    // Only backends that pass this metadata to the native model may store it.
    if(backendId!=='dsh'&&backendId!=='pi'&&values.modelInputModalities!==undefined)throw new AppError('INVALID_BACKEND_PROFILE','This backend does not consume declared model input types');
    if(backendId!=='claude'&&backendId!=='pi'&&values.modelContextWindows!==undefined)throw new AppError('INVALID_BACKEND_PROFILE','This backend does not consume declared model context windows');
    // Same rule for sources: only a backend that consumes a gateway protocol can be pointed at one, and storing it
    // anywhere else would look saved while changing nothing.
    if(values.modelSource!==undefined&&values.modelSource!==null&&!this.consumesModelSources(backendId))
      throw new AppError('INVALID_BACKEND_PROFILE','This backend does not support a model source');
    if(backendId==='antigravity'){
      if(values.apiProtocol!==undefined&&values.apiProtocol!==null&&values.apiProtocol!=='google-generative-ai')throw new AppError('INVALID_BACKEND_PROFILE','Antigravity requires the Google Gemini model API protocol');
      if(typeof values.configDir==='string'&&values.configDir.trim())throw new AppError('INVALID_BACKEND_PROFILE','Antigravity uses a managed configuration directory');
    }else if(backendId!=='pi'&&values.apiProtocol!==undefined)throw new AppError('INVALID_BACKEND_PROFILE','This backend does not support selecting the model API protocol');
    const cursorUpdate=this.cursor.profileUpdate(backendId,profileId,create,values,()=>this.getSettings().cursorCli);
    if(cursorUpdate){
      this.setSettings({cursorCli:cursorUpdate.cursorCli});
      if(cursorUpdate.defaultModel!==undefined)this.setSettings({defaultModel:cursorUpdate.defaultModel});
      return this.getNativeBackendProfiles(backendId);
    }
    const profiles=this.readNativeProfiles();
    const items=profiles[backendId]??[];
    const index=items.findIndex(item=>item.id===profileId);
    if(create&&index>=0)throw new AppError('NATIVE_PROFILE_EXISTS','A profile with this id already exists',409);
    if(!create&&index<0&&!materializeBuiltin)throw new AppError('NATIVE_PROFILE_NOT_FOUND','Native backend profile does not exist',404);
    const previous=index>=0?items[index]!:undefined;
    const next:StoredNativeProfile={...(previous??{}),id:profileId,backendId,name:(values.name??previous?.name??profileId) as string};
    if(typeof next.name!=='string'||!next.name||next.name.length>80||/[\0\r\n]/.test(next.name))throw new AppError('INVALID_BACKEND_PROFILE','Profile name is invalid');
    if(values.description!==undefined){if(typeof values.description!=='string'||values.description.length>200)throw new AppError('INVALID_BACKEND_PROFILE','Profile description is invalid');next.description=values.description as string;}
    for(const key of ['executable','configDir','sourceDir','apiEndpoint','agentEndpoint','defaultModel'] as const){
      if(values[key]===undefined)continue;
      if(values[key]===null){delete next[key];continue;}
      // Surrounding whitespace, a pasted trailing line break included, is not part of a value.
      if(typeof values[key]!=='string'||values[key].length>8192||/[\0\r\n]/.test((values[key] as string).trim()))throw new AppError('INVALID_BACKEND_PROFILE',`Profile ${key} is invalid`);
      if(!(values[key] as string).trim()){delete next[key];continue;}
      if(key==='configDir'||key==='sourceDir')next[key]=validateNativeProfilePath(values[key],`profile.${key}`);
      else if(key==='apiEndpoint'||key==='agentEndpoint')next[key]=validateNativeProfileEndpoint(values[key],`profile.${key}`);
      else next[key]=(values[key] as string).trim();
    }
    if(Object.prototype.hasOwnProperty.call(values,'apiProtocol')){
      if(values.apiProtocol===null)delete next.apiProtocol;
      else next.apiProtocol=validateNativeModelApiProtocol(values.apiProtocol);
    }
    if(values.disableAutoUpdate!==undefined){if(typeof values.disableAutoUpdate!=='boolean')throw new AppError('INVALID_BACKEND_PROFILE','disableAutoUpdate must be a boolean');next.disableAutoUpdate=values.disableAutoUpdate as boolean;}
    if(Object.prototype.hasOwnProperty.call(values,'modelSource')){
      if(values.modelSource===null)delete next.modelSource;
      else next.modelSource=validateNativeModelSource(values.modelSource);
    }
    // `null` drops the curation and restores the full catalog; `[]` stores an empty selection.
    if(Object.prototype.hasOwnProperty.call(values,'enabledModels')){
      if(values.enabledModels===null)delete next.enabledModels;
      else next.enabledModels=validateEnabledModels(values.enabledModels,'INVALID_BACKEND_PROFILE','enabledModels');
    }
    if(Object.prototype.hasOwnProperty.call(values,'modelInputModalities')){
      if(values.modelInputModalities===null)delete next.modelInputModalities;
      else next.modelInputModalities=validateModelInputModalities(values.modelInputModalities,'INVALID_BACKEND_PROFILE','modelInputModalities');
    }
    if(Object.prototype.hasOwnProperty.call(values,'modelContextWindows')){
      if(values.modelContextWindows===null)delete next.modelContextWindows;
      else next.modelContextWindows=validateModelContextWindows(values.modelContextWindows,'INVALID_BACKEND_PROFILE','modelContextWindows');
    }
    if(Object.prototype.hasOwnProperty.call(values,'apiKey')){
      if(values.apiKey===null)delete next.apiKey;
      else next.apiKey=validateApiKey(values.apiKey,'apiKey');
    }
    const updated=[...items];
    if(index>=0)updated[index]=next;else updated.push(next);
    if(updated.length>100)throw new AppError('NATIVE_PROFILE_LIMIT','A native backend can store at most 100 profiles',413);
    profiles[backendId]=updated;
    const contents=JSON.stringify(profiles,null,2)+'\n';
    if(Buffer.byteLength(contents,'utf8')>MAX_NATIVE_PROFILE_BYTES)throw new AppError('NATIVE_PROFILE_LIMIT','Native backend profile settings exceed the storage limit',413);
    atomicWritePrivateFile(this.nativeProfilesPath(),contents);
    if(values.defaultModel!==undefined){
      const defaults=this.getSettings().nativeBackendDefaults??{};
      const current=defaults[backendId];
      // Only the backend layer knows which built-in profile is the implicit default.
      if(current?.model!==undefined&&(current.profileId??resolvedDefaultProfileId)===profileId){
        const {model:_dropped,...rest}=current;
        this.setSettings({nativeBackendDefaults:{...defaults,[backendId]:next.defaultModel?{...rest,model:next.defaultModel}:rest}});
      }
    }
    return this.getNativeBackendProfiles(backendId);
  }

  private settingsPath(): string { return path.join(this.stateDir, 'settings.json'); }

  private readSettings(): AppSettings {
    try {
      const data = JSON.parse(readFileSync(this.settingsPath(), 'utf8')) as unknown;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid settings');
      // Retired persisted keys must be removed before strict validation, including on startup.
      // `titleModel` became `auxiliaryModels.title`; the next save writes the new shape. `riffetTools` (per-client
      // tool groups) gave way to the composer's per-conversation pick. `workItemCards`: a composer conversation no longer opens a task.
      const {defaultBackend:_retiredBackend,riffetTools:_retiredTools,workItemCards:_retiredWorkItemCards,titleModel,...settings}=data as Record<string,unknown>;
      if(titleModel&&settings.auxiliaryModels===undefined)settings.auxiliaryModels={title:titleModel};
      return this.validateSettings(settings);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      if (error instanceof AppError) throw error;
      throw new AppError('SETTINGS_CORRUPT', 'Workbench settings file is invalid', 500);
    }
  }

  /** Which version of a settings file is on disk; every write replaces the file, so the inode moves too. */
  private fileStamp(filePath:string):string {
    try{const info=statSync(filePath);return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;}
    catch{return 'absent';}
  }

  private cachedSettings?:{stamp:string;value:AppSettings};

  /** Read on most requests; the files change on a save, so a read is reused until they do. */
  getSettings(): AppSettings {
    const stamp=`${this.fileStamp(this.settingsPath())}|${this.fileStamp(this.cursor.path)}`;
    if(this.cachedSettings?.stamp!==stamp)this.cachedSettings={stamp,value:this.loadSettings()};
    return structuredClone(this.cachedSettings.value);
  }

  private loadSettings(): AppSettings {
    const general=this.readSettings();
    const {cursorCli:legacyCursorCli,...rest}=general;
    // Readers always see the presets in effect; only a list someone saved is stored.
    const settings:AppSettings={...rest,quickChat:{...rest.quickChat,presets:rest.quickChat?.presets??DEFAULT_QUICK_CHAT_PRESETS.map(preset=>({...preset}))}};
    // The transcription key never leaves the server: clients see whether one is saved.
    if(settings.voiceInput?.remote){const {apiKey,...remote}=settings.voiceInput.remote as StoredRemoteSpeech;settings.voiceInput={...settings.voiceInput,remote:{...remote,hasApiKey:Boolean(apiKey)}};}
    return this.cursor.expose(settings,legacyCursorCli);
  }

  private validateSettings(values: Record<string, unknown>): AppSettings {
    const known = new Set(['editorCommand', 'defaultModel', 'defaultMode', 'defaultBackendId', 'nativeBackendDefaults', 'notifications', 'allowOutsideRead', 'composerEnterBehavior', 'composerRunningBehavior', 'composerSendLater', 'auxiliaryModels', 'pluginModels', 'idleReclaimMinutes', 'maxAgentMemoryMb', 'maxLiveAgents', 'quickChat', 'assistant', 'workItems', 'cursorCli', 'taskWorkspaceRoot', 'sidebarPinned', 'voiceInput', 'titleRules']);
    for (const key of Object.keys(values)) if (!known.has(key)) throw new AppError('INVALID_SETTINGS', `Unknown setting: ${key}`);
    const result: AppSettings = {};
    if (values.taskWorkspaceRoot !== undefined && values.taskWorkspaceRoot !== null && values.taskWorkspaceRoot !== '') {
      const root = values.taskWorkspaceRoot;
      if (typeof root !== 'string' || root.length > 8192 || !root.startsWith('/') || /[\0\r\n]/.test(root)) throw new AppError('INVALID_TASK_WORKSPACE_ROOT', 'Choose an absolute task workspace directory');
      result.taskWorkspaceRoot = root;
    }
    for (const key of ['editorCommand', 'defaultModel', 'defaultMode'] as const) {
      const value = values[key];
      if (value === undefined) continue;
      const max = key === 'editorCommand' ? 2048 : 200;
      if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new AppError('INVALID_SETTINGS', `${key} is invalid`);
      result[key] = value;
    }
    if (values.defaultBackendId !== undefined) {
      if (typeof values.defaultBackendId !== 'string' || !isNativeBackendId(values.defaultBackendId) || values.defaultBackendId === 'chat') throw new AppError('INVALID_SETTINGS', 'defaultBackendId is invalid');
      result.defaultBackendId = values.defaultBackendId as NativeBackendId;
    }
    if (values.nativeBackendDefaults !== undefined) {
      if (!values.nativeBackendDefaults || typeof values.nativeBackendDefaults !== 'object' || Array.isArray(values.nativeBackendDefaults)) throw new AppError('INVALID_SETTINGS', 'nativeBackendDefaults must be an object');
      const defaults: Partial<Record<NativeBackendId, NativeBackendDefaults>> = {};
      for (const [backend, raw] of Object.entries(values.nativeBackendDefaults as Record<string, unknown>)) {
        if (!isNativeBackendId(backend) || backend === 'chat' || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('INVALID_SETTINGS', 'nativeBackendDefaults contains an invalid backend profile');
        const config = raw as Record<string, unknown>, normalized: NativeBackendDefaults = {};
        for (const key of Object.keys(config)) if (!['profileId', 'model', 'mode', 'approval', 'profileModels'].includes(key)) throw new AppError('INVALID_SETTINGS', 'nativeBackendDefaults contains an unknown field');
        for (const key of ['profileId', 'model', 'mode', 'approval'] as const) {
          const value = config[key];
          if (value === undefined) continue;
          if (typeof value !== 'string' || value.length > 200 || /[\0\r\n]/.test(value)) throw new AppError('INVALID_SETTINGS', 'nativeBackendDefaults value is invalid');
          normalized[key] = value;
        }
        if (config.profileModels !== undefined) normalized.profileModels = validateProfileModels(config.profileModels);
        defaults[backend as NativeBackendId] = normalized;
      }
      result.nativeBackendDefaults = defaults;
    }
    if (values.notifications !== undefined) {
      if (typeof values.notifications !== 'boolean') throw new AppError('INVALID_SETTINGS', 'notifications must be a boolean');
      result.notifications = values.notifications;
    }
    if (values.allowOutsideRead !== undefined) {
      if (typeof values.allowOutsideRead !== 'boolean') throw new AppError('INVALID_SETTINGS', 'allowOutsideRead must be a boolean');
      result.allowOutsideRead = values.allowOutsideRead;
    }
    if (values.composerEnterBehavior !== undefined) {
      if (values.composerEnterBehavior !== 'newline' && values.composerEnterBehavior !== 'send') throw new AppError('INVALID_SETTINGS', 'composerEnterBehavior must be newline or send');
      result.composerEnterBehavior = values.composerEnterBehavior;
    }
    if (values.composerRunningBehavior !== undefined) {
      if (values.composerRunningBehavior !== 'queue' && values.composerRunningBehavior !== 'steer') throw new AppError('INVALID_SETTINGS', 'composerRunningBehavior must be queue or steer');
      result.composerRunningBehavior = values.composerRunningBehavior;
    }
    if (values.sidebarPinned !== undefined) {
      const pinned = values.sidebarPinned;
      // Ids this server does not know are kept: a newer client may offer destinations this one does not,
      // and main plugin views use `<pluginId>/<name>` contribution ids.
      const validDestination = (id: unknown): boolean => {
        if (typeof id !== 'string') return false;
        if (/^[a-z][\w.-]{0,63}$/i.test(id)) return true;
        const pluginId = id.split('/', 1)[0]!;
        return pluginId.length <= 64 && PLUGIN_ID.test(pluginId) && isContributionOf(pluginId, id);
      };
      if (!Array.isArray(pinned) || pinned.length > SIDEBAR_PINNED_MAX || !pinned.every(validDestination)) throw new AppError('INVALID_SETTINGS', 'sidebarPinned must be a list of destination ids');
      result.sidebarPinned = [...new Set(pinned as string[])];
    }
    if (values.composerSendLater !== undefined) {
      if (typeof values.composerSendLater !== 'boolean') throw new AppError('INVALID_SETTINGS', 'composerSendLater must be a boolean');
      result.composerSendLater = values.composerSendLater;
    }
    // `maxLiveAgents` is what clients before the memory budget send; it is accepted and dropped.
    for (const [key, max] of [['idleReclaimMinutes', 7 * 24 * 60], ['maxAgentMemoryMb', 1024 * 1024]] as const) {
      const value = values[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) throw new AppError('INVALID_SETTINGS', `${key} must be an integer from 0 to ${max}`);
      result[key] = value;
    }
    if (values.auxiliaryModels !== undefined) {
      const models = values.auxiliaryModels;
      if (!models || typeof models !== 'object' || Array.isArray(models)) throw new AppError('INVALID_SETTINGS', 'auxiliaryModels must be an object');
      const chosen: AuxiliaryModels = {};
      for (const [purpose, raw] of Object.entries(models as Record<string, unknown>)) {
        if (!(AUXILIARY_MODEL_PURPOSES as readonly string[]).includes(purpose)) throw new AppError('INVALID_SETTINGS', `Unknown auxiliary model purpose: ${purpose}`);
        // `null` clears the choice; the merge in `setSettings` carries it here.
        if (raw === null) continue;
        chosen[purpose as AuxiliaryModelPurpose] = modelRef(raw, `auxiliaryModels.${purpose}`);
      }
      if (Object.keys(chosen).length) result.auxiliaryModels = chosen;
    }
    if (values.pluginModels !== undefined) {
      const models = values.pluginModels;
      if (!models || typeof models !== 'object' || Array.isArray(models)) throw new AppError('INVALID_SETTINGS', 'pluginModels must be an object');
      const entries = Object.entries(models as Record<string, unknown>);
      if (entries.length > MAX_PLUGIN_MODELS) throw new AppError('INVALID_SETTINGS', `pluginModels may hold at most ${MAX_PLUGIN_MODELS} uses`);
      const chosen: Record<string, AuxiliaryModelRef> = {};
      // Kept for a plugin that is off or gone: the id is checked for its shape, not against what is installed.
      for (const [use, raw] of entries) {
        if (!MODEL_USE_ID.test(use)) throw new AppError('INVALID_SETTINGS', `pluginModels: ${use} is not a model use id`);
        if (raw === null) continue;
        chosen[use] = modelRef(raw, `pluginModels.${use}`);
      }
      if (Object.keys(chosen).length) result.pluginModels = chosen;
    }
    if (values.quickChat !== undefined) result.quickChat = validateQuickChat(values.quickChat);
    if (values.assistant !== undefined) {
      const assistant = validateAssistant(values.assistant);
      if (Object.keys(assistant).length) result.assistant = assistant;
    }
    if (values.workItems !== undefined) {
      const workItems = validateWorkItems(values.workItems);
      if (Object.keys(workItems).length) result.workItems = workItems;
    }
    if (values.voiceInput !== undefined) {
      const voiceInput = validateVoiceInput(values.voiceInput);
      if (Object.keys(voiceInput).length) result.voiceInput = voiceInput;
    }
    if (values.titleRules !== undefined && values.titleRules !== null) {
      const rules = validateTitleRules(values.titleRules);
      if (rules.length) result.titleRules = rules;
    }
    if (values.cursorCli !== undefined) result.cursorCli = this.cursor.validate(values.cursorCli);
    return result;
  }

  private persistSettings(next:AppSettings,nextCli?:StoredCursorCli):void {
    mkdirSync(this.stateDir,{recursive:true,mode:0o700});
    if(nextCli){
      this.cursor.write(nextCli);
      return;
    }
    atomicWritePrivateFile(this.settingsPath(),JSON.stringify(next,null,2)+'\n');
  }

  /** The 语音输入 remote service with its key, for the server's own requests (docs/VOICE.md §6). */
  remoteSpeech(): { baseUrl?: string; model?: string; apiKey?: string } {
    return { ...this.readSettings().voiceInput?.remote as StoredRemoteSpeech | undefined };
  }

  setSettings(values: unknown): AppSettings {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new AppError('INVALID_SETTINGS', 'Settings must be an object');
    // An older client's tool-groups page still sends the retired `riffetTools`; it is dropped, not refused.
    const {riffetTools:_retiredTools,...input}=values as Record<string,unknown>;
    this.cursor.assertAlone(input);
    const current=this.readSettings();
    const {cursorCli:legacyCli,...generalCurrent}=current;
    const storedCli=this.cursor.read(legacyCli);
    const nextStoredCli:StoredCursorCli|undefined=input.cursorCli!==undefined?this.cursor.update(input.cursorCli,storedCli):undefined;
    delete input.cursorCli;
    // One purpose at a time: a request naming only `handoff` keeps the title model as it was.
    if(input.auxiliaryModels&&typeof input.auxiliaryModels==='object'&&!Array.isArray(input.auxiliaryModels))input.auxiliaryModels={...generalCurrent.auxiliaryModels,...input.auxiliaryModels};
    if(input.pluginModels&&typeof input.pluginModels==='object'&&!Array.isArray(input.pluginModels))input.pluginModels={...generalCurrent.pluginModels,...input.pluginModels};
    // Likewise per quick-chat field; `presets: null` goes back to the defaults by storing none.
    if(input.quickChat&&typeof input.quickChat==='object'&&!Array.isArray(input.quickChat)){
      const merged:Record<string,unknown>={...generalCurrent.quickChat,...input.quickChat};
      for(const key of Object.keys(merged))if(merged[key]===null)delete merged[key];
      input.quickChat=merged;
    }
    if(input.assistant&&typeof input.assistant==='object'&&!Array.isArray(input.assistant)){
      const merged:Record<string,unknown>={...generalCurrent.assistant,...input.assistant};
      for(const key of Object.keys(merged))if(merged[key]===null)delete merged[key];
      input.assistant=merged;
    }
    if(input.workItems&&typeof input.workItems==='object'&&!Array.isArray(input.workItems)){
      const given=input.workItems as Record<string,unknown>;
      const merged:Record<string,unknown>={...generalCurrent.workItems,...given};
      // Another agent does not inherit the previous one's provider and model.
      if('backendId' in given&&given.backendId!==generalCurrent.workItems?.backendId){if(!('profileId' in given))delete merged.profileId;if(!('model' in given))delete merged.model;}
      for(const key of Object.keys(merged))if(merged[key]===null)delete merged[key];
      input.workItems=merged;
    }
    if(input.voiceInput!==undefined)input.voiceInput=mergeVoiceInput(generalCurrent.voiceInput,input.voiceInput);
    // The provider→model record is the server's: rebuilt from what is stored and the pair in this save.
    if(input.nativeBackendDefaults&&typeof input.nativeBackendDefaults==='object'&&!Array.isArray(input.nativeBackendDefaults)){
      input.nativeBackendDefaults=Object.fromEntries(Object.entries(input.nativeBackendDefaults as Record<string,unknown>).map(([backendId,raw])=>[backendId,raw&&typeof raw==='object'&&!Array.isArray(raw)
        ?rememberProfileModel(generalCurrent.nativeBackendDefaults?.[backendId as NativeBackendId],raw as NativeBackendDefaults,MODEL_PICKER_BUDGET.rememberedProviders):raw]));
    }
    const next=this.validateSettings({...generalCurrent,...input});
    this.cursor.mirrorDefaults(input,next);
    this.persistSettings(!nextStoredCli&&legacyCli?{...next,cursorCli:legacyCli}:next,nextStoredCli);
    const saved=this.getSettings();
    for(const listener of this.savedListeners){try{listener(saved);}catch{/* a follower must not fail the save */}}
    return saved;
  }

  private readonly savedListeners=new Set<(settings:AppSettings)=>void>();
  /** Called after every save, with what readers now see. */
  onSaved(listener:(settings:AppSettings)=>void):()=>void{this.savedListeners.add(listener);return()=>{this.savedListeners.delete(listener);};}
}

export type { AppSettings, CapabilityReport, CommandResult, ConfigFile } from '../../../../packages/contracts/src/index.js';

/** A plugin's model use, `<pluginId>/<name>` (`PluginDeclarations.modelUses`). */
const MODEL_USE_ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9.-]{0,63}$/;
/** Choices kept for plugin model uses, including those of plugins since removed. */
const MAX_PLUGIN_MODELS = 64;

/** A model choice as `auxiliaryModels` and `pluginModels` store it: a gateway model of one backend profile. */
function modelRef(raw: unknown, path: string): AuxiliaryModelRef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('INVALID_SETTINGS', `${path} must be an object`);
  const item = raw as Record<string, unknown>;
  if (Object.keys(item).some(key => !['backendId', 'profileId', 'model'].includes(key))) throw new AppError('INVALID_SETTINGS', `${path} contains an unknown field`);
  if (typeof item.backendId !== 'string' || !AUXILIARY_MODEL_BACKENDS.includes(item.backendId as NativeBackendId)) throw new AppError('INVALID_SETTINGS', `${path}.backendId is invalid`);
  for (const key of ['profileId', 'model'] as const) {
    const value = item[key];
    if (typeof value !== 'string' || !value || value.length > 200 || /[\0\r\n]/.test(value)) throw new AppError('INVALID_SETTINGS', `${path}.${key} is invalid`);
  }
  return { backendId: item.backendId as NativeBackendId, profileId: item.profileId as string, model: item.model as string };
}

function validateProfileModels(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('INVALID_SETTINGS', 'nativeBackendDefaults.profileModels must be an object');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MODEL_PICKER_BUDGET.rememberedProviders) throw new AppError('INVALID_SETTINGS', 'nativeBackendDefaults.profileModels has too many entries');
  for (const [profileId, model] of entries) {
    if (!profileId || profileId.length > 200 || typeof model !== 'string' || !model || model.length > 200 || /[\0\r\n]/.test(model)) throw new AppError('INVALID_SETTINGS', 'nativeBackendDefaults.profileModels is invalid');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

const QUICK_CHAT_PRESET_ID=/^[a-z0-9-]{1,32}$/;

function validateAssistant(raw: unknown): AssistantSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('INVALID_SETTINGS', 'assistant must be an object');
  const values = raw as Record<string, unknown>;
  if (Object.keys(values).some(key => !['backendId', 'profileId', 'model', 'timeZone', 'supervision', 'consolidation', 'dailyRuns', 'dispatch'].includes(key))) throw new AppError('INVALID_SETTINGS', 'assistant contains an unknown field');
  const result: AssistantSettings = {};
  // An agent the 助理 no longer runs on (docs/ASSISTANT.md §4), saved before that, is dropped with its provider and
  // model rather than failing the settings: the 助理 goes back to its default agent (`assistantChoice`).
  const retired = typeof values.backendId === 'string' && isNativeBackendId(values.backendId) && !isAssistantBackend(values.backendId);
  if (values.backendId !== undefined && !retired) {
    if (typeof values.backendId !== 'string' || !isNativeBackendId(values.backendId)) throw new AppError('INVALID_SETTINGS', 'assistant.backendId is invalid');
    result.backendId = values.backendId as NativeBackendId;
  }
  for (const key of ['profileId', 'model'] as const) {
    const value = values[key];
    if (value === undefined || retired) continue;
    if (typeof value !== 'string' || !value || value.length > 200 || /[\0\r\n]/.test(value)) throw new AppError('INVALID_SETTINGS', `assistant.${key} is invalid`);
    result[key] = value;
  }
  if (values.timeZone !== undefined) {
    if (typeof values.timeZone !== 'string' || values.timeZone.length > 64) throw new AppError('INVALID_SETTINGS', 'assistant.timeZone is invalid');
    // A client reports its zone with whatever else it saves; one this server's ICU does not know is left out rather than failing the save.
    if (isTimeZone(values.timeZone)) result.timeZone = values.timeZone;
  }
  for (const key of ['supervision', 'consolidation'] as const) {
    if (values[key] === undefined) continue;
    if (typeof values[key] !== 'boolean') throw new AppError('INVALID_SETTINGS', `assistant.${key} is invalid`);
    result[key] = values[key];
  }
  if (values.dailyRuns !== undefined) {
    if (!Number.isInteger(values.dailyRuns) || (values.dailyRuns as number) < 1 || (values.dailyRuns as number) > ASSISTANT_BUDGET.dailyRunsMax) throw new AppError('INVALID_SETTINGS', 'assistant.dailyRuns is invalid');
    result.dailyRuns = values.dailyRuns as number;
  }
  if (values.dispatch !== undefined) {
    if (values.dispatch !== 'edits' && values.dispatch !== 'all') throw new AppError('INVALID_SETTINGS', 'assistant.dispatch is invalid');
    result.dispatch = values.dispatch;
  }
  return result;
}

function validateWorkItems(raw: unknown): WorkItemSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('INVALID_SETTINGS', 'workItems must be an object');
  const values = raw as Record<string, unknown>;
  if (Object.keys(values).some(key => !['composerSessions', 'backendId', 'profileId', 'model', 'verifier'].includes(key))) throw new AppError('INVALID_SETTINGS', 'workItems contains an unknown field');
  const result: WorkItemSettings = {};
  if (values.composerSessions !== undefined) {
    if (typeof values.composerSessions !== 'boolean') throw new AppError('INVALID_SETTINGS', 'workItems.composerSessions is invalid');
    result.composerSessions = values.composerSessions;
  }
  if (values.backendId !== undefined) {
    if (typeof values.backendId !== 'string' || !isNativeBackendId(values.backendId) || values.backendId === 'chat') throw new AppError('INVALID_SETTINGS', 'workItems.backendId is invalid');
    result.backendId = values.backendId as NativeBackendId;
  }
  for (const key of ['profileId', 'model'] as const) {
    const value = values[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value || value.length > 200 || /[\0\r\n]/.test(value)) throw new AppError('INVALID_SETTINGS', `workItems.${key} is invalid`);
    result[key] = value;
  }
  if (values.verifier !== undefined) {
    const verifier = values.verifier as Record<string, unknown> | null;
    if (!verifier || typeof verifier !== 'object' || Array.isArray(verifier) || Object.keys(verifier).some(key => !['backendId', 'profileId', 'model'].includes(key))) throw new AppError('INVALID_SETTINGS', 'workItems.verifier is invalid');
    if (typeof verifier.backendId !== 'string' || !isNativeBackendId(verifier.backendId) || verifier.backendId === 'chat') throw new AppError('INVALID_SETTINGS', 'workItems.verifier.backendId is invalid');
    const choice: NonNullable<WorkItemSettings['verifier']> = { backendId: verifier.backendId as NativeBackendId };
    for (const key of ['profileId', 'model'] as const) {
      const value = verifier[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !value || value.length > 200 || /[\0\r\n]/.test(value)) throw new AppError('INVALID_SETTINGS', `workItems.verifier.${key} is invalid`);
      choice[key] = value;
    }
    result.verifier = choice;
  }
  return result;
}

function isTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}

function validateQuickChat(raw: unknown): QuickChatSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('INVALID_SETTINGS', 'quickChat must be an object');
  const values = raw as Record<string, unknown>;
  if (Object.keys(values).some(key => !['retentionDays', 'openMode', 'presets'].includes(key))) throw new AppError('INVALID_SETTINGS', 'quickChat contains an unknown field');
  const result: QuickChatSettings = {};
  const days = values.retentionDays;
  if (days !== undefined) {
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > 365) throw new AppError('INVALID_SETTINGS', 'quickChat.retentionDays must be an integer from 0 to 365');
    result.retentionDays = days;
  }
  if (values.openMode !== undefined) {
    if (values.openMode !== 'sheet' && values.openMode !== 'page') throw new AppError('INVALID_SETTINGS', 'quickChat.openMode must be sheet or page');
    result.openMode = values.openMode;
  }
  if (values.presets !== undefined) {
    if (!Array.isArray(values.presets) || values.presets.length > 12) throw new AppError('INVALID_SETTINGS', 'quickChat.presets must list at most 12 presets');
    const seen = new Set<string>();
    result.presets = values.presets.map(item => {
      const preset = item as Record<string, unknown> | null;
      if (!preset || typeof preset !== 'object' || Object.keys(preset).some(key => !['id', 'name', 'prompt'].includes(key))) throw new AppError('INVALID_SETTINGS', 'A quick chat preset has an id, a name and a prompt');
      const { id, name, prompt } = preset;
      if (typeof id !== 'string' || !QUICK_CHAT_PRESET_ID.test(id) || seen.has(id)) throw new AppError('INVALID_SETTINGS', 'A quick chat preset id must be unique: lowercase letters, digits and dashes');
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 20) throw new AppError('INVALID_SETTINGS', 'A quick chat preset name must be 1 to 20 characters');
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) throw new AppError('INVALID_SETTINGS', 'A quick chat preset prompt must be 1 to 4000 characters');
      seen.add(id);
      return { id, name: name.trim(), prompt: prompt.trim() };
    });
  }
  return result;
}

/** `voiceInput.remote` as settings.json holds it: the key is stored, `hasApiKey` is only what clients read. */
type StoredRemoteSpeech = Omit<RemoteSpeechSettings, 'hasApiKey'> & { apiKey?: string };
/** `recognizer`: `remote` or a plugin id; a plugin that is off or gone is kept, and dictation says why it cannot start. */
const RECOGNIZER_ID = /^[a-z0-9][a-z0-9.-]{0,127}$/;

/** An update applied to what is stored: each field given replaces its own, `null` clears it, an absent key keeps the saved one. */
function mergeVoiceInput(current: VoiceInputSettings | undefined, raw: unknown): unknown {
  if (raw === null) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const given = raw as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...current, ...given };
  if (given.remote !== undefined) {
    if (given.remote === null) delete merged.remote;
    else if (given.remote && typeof given.remote === 'object' && !Array.isArray(given.remote)) {
      const remote: Record<string, unknown> = { ...current?.remote, ...given.remote as Record<string, unknown> };
      for (const key of Object.keys(remote)) if (remote[key] === null) delete remote[key];
      merged.remote = remote;
    }
  }
  for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
  return merged;
}

function validateVoiceInput(raw: unknown): VoiceInputSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('INVALID_SETTINGS', 'voiceInput must be an object');
  const values = raw as Record<string, unknown>;
  if (Object.keys(values).some(key => !['recognizer', 'language', 'remote'].includes(key))) throw new AppError('INVALID_SETTINGS', 'voiceInput contains an unknown field');
  const result: VoiceInputSettings = {};
  if (values.recognizer !== undefined) {
    if (typeof values.recognizer !== 'string' || !RECOGNIZER_ID.test(values.recognizer)) throw new AppError('INVALID_SETTINGS', 'voiceInput.recognizer is invalid');
    result.recognizer = values.recognizer;
  }
  if (values.language !== undefined) {
    if (typeof values.language !== 'string' || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(values.language)) throw new AppError('INVALID_SETTINGS', 'voiceInput.language must be a language tag such as zh or en');
    result.language = values.language;
  }
  if (values.remote !== undefined) {
    const remote = values.remote;
    if (!remote || typeof remote !== 'object' || Array.isArray(remote)) throw new AppError('INVALID_SETTINGS', 'voiceInput.remote must be an object');
    const fields = remote as Record<string, unknown>;
    // `hasApiKey` is what a client read back; sending it again changes nothing.
    if (Object.keys(fields).some(key => !['baseUrl', 'model', 'apiKey', 'hasApiKey'].includes(key))) throw new AppError('INVALID_SETTINGS', 'voiceInput.remote contains an unknown field');
    const stored: StoredRemoteSpeech = {};
    if (fields.baseUrl !== undefined) {
      let url: URL | undefined;
      try { url = typeof fields.baseUrl === 'string' && fields.baseUrl.length <= 2048 ? new URL(fields.baseUrl) : undefined; } catch { url = undefined; }
      if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) throw new AppError('INVALID_SETTINGS', 'voiceInput.remote.baseUrl must be an http or https address without credentials');
      stored.baseUrl = fields.baseUrl as string;
    }
    if (fields.model !== undefined) {
      if (typeof fields.model !== 'string' || !fields.model.trim() || fields.model.length > 200 || /[\0\r\n]/.test(fields.model)) throw new AppError('INVALID_SETTINGS', 'voiceInput.remote.model is invalid');
      stored.model = fields.model.trim();
    }
    if (fields.apiKey !== undefined) stored.apiKey = validateApiKey(fields.apiKey, 'voiceInput.remote.apiKey');
    if (Object.keys(stored).length) result.remote = stored;
  }
  return result;
}
