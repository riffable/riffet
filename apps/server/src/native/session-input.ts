import type { IncomingHttpHeaders } from 'node:http';
import { isAssistantBackend, type AgentMember, type NativeBackendId, type NativeSessionInput, type Project } from '../../../../packages/contracts/src/index.js';
import { isNativeBackendId } from '../backends/registry.js';
import type { NativeBackendService } from '../backends/service.js';
import { AppError, requireString } from '../errors.js';
import { defaultBackendForClient, requireBackendVisibleToClient } from './client-features.js';
import { legacyDefaults, requestedNativeSessionId, sessionModelLimit, type RequestedNativeSession } from '../session-identity.js';
import type { SettingsService } from '../settings/index.js';
import type { Store } from '../store.js';
import { readTerminalAppearance, resolveTerminalAppearance } from '../terminal/appearance.js';
import { applicableExtensionsOff, extensionsOffList } from '../extensions/toggles.js';
import { toolGroupList } from '../riffet-mcp/groups.js';

export function requireSessionModel(value: unknown, discussion = false): string {
  return requireString(value, 'model', sessionModelLimit(value, discussion));
}

/** What a caller may ask of a new native conversation; anything left out falls back to the backend's saved defaults. */
export interface NativeSessionRequest extends RequestedNativeSession {
  projectId?: string; projectless?: boolean; title?: string; backendId?: string; backendProfileId?: string;
  model?: string; mode?: string; approval?: string; resumePicker?: boolean;
  /** Team member id launching this conversation (docs/TEAM.md). `null` opts out of project-level member fallback. */
  agentMemberId?: string | null;
  /** The composer's pick; absent or empty means none. */
  toolGroups?: unknown;
  /** `mcp:<name>` / `skill:<name>` switched off for this conversation (docs/EXTENSIONS.md). */
  extensionsOff?: unknown;
}

/**
 * Turns a request into the session input `Store` records, applying saved backend defaults and
 * refusing a mode or permission the backend does not offer. Shared by the composer and by every
 * path that opens a conversation on someone's behalf — an attempt, a handoff, a schedule — so all of
 * them start a backend the way a person picking it in the composer would.
 */
export async function resolveNativeSessionInput(deps: { store: Store; settings: SettingsService; nativeBackends: NativeBackendService; auth?: { device(id: string): unknown }; team?: () => { get(id: string): AgentMember; resolveFor(project: Project): AgentMember | undefined } | undefined }, body: NativeSessionRequest, headers?: IncomingHttpHeaders, reservedProject?: Project, purpose?: 'discussion'): Promise<NativeSessionInput & { backendId: NativeBackendId; backendProfileId: string; mode: string }> {
  const {store,settings,nativeBackends}=deps;
  const savedSettings=settings.getSettings();
  const team=deps.team?.();
  const optOutMember=body.agentMemberId===null;
  const requestedMember=body.agentMemberId!==undefined&&body.agentMemberId!==null&&body.agentMemberId!==''?team?.get(requireString(body.agentMemberId,'agentMemberId',100)):undefined;
  if(requestedMember?.archivedAt)throw new AppError('TEAM_MEMBER_ARCHIVED','Restore this team member before opening a conversation',409);
  const project=reservedProject??store.getProject(
    requestedMember
      ?(requestedMember.scope.kind==='project'
        ?(body.projectId?(()=>{const pid=requireString(body.projectId,'projectId',100);const allowed=requestedMember.scope.projectIds?.includes(pid)||store.originChain(pid).some(id=>requestedMember.scope.projectIds?.includes(id));if(!allowed)throw new AppError('INVALID_PROJECT','Project is outside this team member\'s scope',409);return pid;})():requestedMember.projectId)
        :requestedMember.projectId)
      :requireString(body.projectId,'projectId',100),
  );
  if(project.archivedAt)throw new AppError('ARCHIVED_PROJECT','Restore this project before opening a conversation',409);
  const member=optOutMember?undefined:(requestedMember??team?.resolveFor(project));
  if(member?.archivedAt)throw new AppError('TEAM_MEMBER_ARCHIVED','Restore this team member before opening a conversation',409);
  // Quick chats and their project belong to each other: nothing else runs there, and they run nowhere else.
  const quickChat=project.system==='quick-chat';
  if(headers!==undefined&&body.backendId!==undefined)requireBackendVisibleToClient(headers,body.backendId);
  // An older client reads the saved default through its own enum. A default it cannot decode, or whose
  // plugin is off, falls back here, before the profile and defaults of that backend are read. No headers
  // means an internal caller, which sees every backend.
  const defaultBackendId=quickChat?'chat':await defaultBackendForClient(headers,member?.target?.backendId??savedSettings.defaultBackendId,nativeBackends);
  const backendId:NativeBackendId=body.backendId===undefined?defaultBackendId as NativeBackendId:isNativeBackendId(body.backendId)?body.backendId:(()=>{throw new AppError('INVALID_BACKEND','Choose a supported native backend');})();
  if(quickChat!==(backendId==='chat'))throw new AppError('INVALID_BACKEND',quickChat?'Only a quick chat runs here':'A quick chat has no project');
  // Standing members run only where isolated (docs/TEAM.md §4.2); on another agent they would inherit the owner's configuration.
  const driver=nativeBackends.registry?.get(backendId);
  const supportsMember=driver!==undefined
    ?(driver.traits!==undefined?Boolean(driver.traits.startsNewTopic):isAssistantBackend(backendId))
    :(nativeBackends.catalog?.traits?.(backendId)?.startsNewTopic??isAssistantBackend(backendId));
  if((member||(!optOutMember&&project.system==='assistant'))&&!supportsMember)throw new AppError('ASSISTANT_BACKEND_UNSUPPORTED','This Agent backend does not support team member isolation');
  const memberUsesBackend=Boolean(member?.target?.backendId&&member.target.backendId===backendId);
  const defaults=savedSettings.nativeBackendDefaults?.[backendId];
  const requestedProfileId=body.backendProfileId===undefined?(memberUsesBackend&&member?.target?.profileId?member.target.profileId:defaults?.profileId):requireString(body.backendProfileId,'backendProfileId',200);
  const selectedProfile=nativeBackends.catalog.validateProfile(backendId,requestedProfileId);
  const applyBackendDefaults=defaults?.profileId?defaults.profileId===selectedProfile.id:(!body.backendProfileId||selectedProfile.isDefault===true);
  const capabilities=await nativeBackends.catalog.capabilitiesFor(backendId,selectedProfile.id);
  const profileModel=typeof selectedProfile.config.defaultModel==='string'?selectedProfile.config.defaultModel:undefined;
  const nativeSessionIdValue=requestedNativeSessionId(body);
  const nativeSessionId=nativeSessionIdValue===undefined?undefined:requireString(nativeSessionIdValue,'nativeSessionId',200);
  if(nativeSessionId!==undefined&&/[\0\r\n]/.test(nativeSessionId))throw new AppError('INVALID_NATIVE_SESSION_ID','Native session id contains invalid characters');
  if(nativeSessionId!==undefined)nativeBackends.catalog.validateNativeSessionId(backendId,nativeSessionId);
  const requestedModel=body.model===undefined?((memberUsesBackend?member?.target?.model:undefined)||(applyBackendDefaults?defaults?.model:undefined)||profileModel||legacyDefaults(backendId,savedSettings).model||undefined):requireSessionModel(body.model,purpose==='discussion');
  const model=requestedModel===undefined?undefined:nativeBackends.catalog.normalizeModel(backendId,selectedProfile.id,requestedModel);
  // A backend whose modes do not include `agent` (TRAE CLI calls it `default`) starts in its first one.
  const fallbackMode=capabilities.supportsModeSelection&&!capabilities.modes.some(item=>item.id==='agent')?capabilities.modes[0]?.id??'agent':'agent';
  const mode=body.mode===undefined?(applyBackendDefaults?defaults?.mode:undefined)??legacyDefaults(backendId,savedSettings).mode??fallbackMode:requireString(body.mode,'mode',100);
  // The conversation's tool groups: only a client request's pick (docs/DEVICES.md §2). A device no longer paired is dropped,
  // since a pick remembered by the client or replayed from its outbox may name one revoked since.
  const picked=headers!==undefined&&body.toolGroups!==undefined?toolGroupList(body.toolGroups):[];
  if(quickChat&&picked.length)throw new AppError('INVALID_TOOL_GROUPS','A quick chat has no Riffet tools');
  const toolGroups=picked.filter(group=>!group.startsWith('device:')||Boolean(deps.auth?.device(group.slice('device:'.length))));
  const requestedOff=headers!==undefined&&body.extensionsOff!==undefined?extensionsOffList(body.extensionsOff):[];
  if(quickChat&&requestedOff.length)throw new AppError('INVALID_EXTENSIONS_OFF','A quick chat has no extensions to switch off');
  // Kinds this backend cannot switch off are dropped, so the stored list is what a launch applies.
  const extensionsOff=applicableExtensionsOff(requestedOff,capabilities.extensionToggles);
  if(capabilities.supportsModeSelection){
    if(!capabilities.modes.some(item=>item.id===mode))throw new AppError('INVALID_MODE','Choose a mode supported by this backend');
  }else if(mode!=='agent')throw new AppError('NATIVE_MODE_UNSUPPORTED','This backend does not support the requested mode');
  const memberApproval=member?.target?.permissionMode;
  const fallbackApproval=memberApproval&&capabilities.supportsPermissionSelection&&capabilities.permissions.some(item=>item.id===memberApproval)?memberApproval:undefined;
  const approval=body.approval===undefined?(fallbackApproval??(applyBackendDefaults?defaults?.approval:undefined)):requireString(body.approval,'approval',100);
  if(approval!==undefined&&(!capabilities.supportsPermissionSelection||!capabilities.permissions.some(item=>item.id===approval)))throw new AppError('INVALID_APPROVAL_MODE','Choose a permission setting supported by this backend');
  return {
    projectId:project.id,title:body.title?.slice(0,200),backendId,
    terminalAppearance:resolveTerminalAppearance(readTerminalAppearance(headers)),
    backendProfileId:selectedProfile.id,
    model,
    mode,
    ...(approval!==undefined?{approval}:{}),
    ...(nativeSessionId?{nativeSessionId}:{}),
    resumePicker:Boolean(body.resumePicker),
    ...(toolGroups.length&&!quickChat?{toolGroups}:{}),
    ...(extensionsOff.length?{extensionsOff}:{}),
    ...(member?{agentMemberId:member.id}:{}),
    // Opened from a linked server's workbench (docs/SERVER-LINKS.md §4): the lists mark it.
    ...(linkedFrom(headers)?{origin:{kind:'link' as const,serverId:linkedFrom(headers)!}}:{}),
  };
}

/** The linked server a request came through; the server sets this header itself (`app.ts`), so it cannot be forged. */
function linkedFrom(headers: IncomingHttpHeaders | undefined): string | undefined {
  const value=headers?.['x-riffet-link'];
  return typeof value==='string'&&value?value:undefined;
}
