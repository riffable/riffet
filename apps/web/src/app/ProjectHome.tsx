import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconCheck, IconChevronRight, IconColumns2, IconFolderClosed, IconFolderPlus, IconHistory, IconLaptop, IconLink, IconServer, IconSettings2, IconSquareTerminal, IconTerminal } from '@/components/icons';
import { AGENT_CALL_TOOL_GROUP, MODEL_CHAT_DEFAULT_CONFIG, PREWARM_BUDGET, type AgentMember, type AppSettings, type Attachment, type AttemptGroup, type ModelChatConfig, type ModelChatConfigPatch, type ModelChatEffort, type ModelChatPinnedDoc, type ModelInfo, type NativeBackendCatalogEntry, type NativeBackendId, type NativeBackendProfile, type Session, type ToolGroupId } from '@contracts';
import { Button } from '@/components/ui/button';
import { LiveBrandMark } from '@/components/BrandMark';
import { RunnerGame } from '@/components/runner/RunnerGame';
import { closeRunner, useRunnerOpen } from '@/components/runner/store';
import { Spinner, StatusDot } from '@/components/ui/controls';
import { FeedbackNotices, type FeedbackMessage } from '@/components/ui/feedback-notice';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { api, apiFor, type NativeSessionCreateInput, type ProjectRecord, type PromptContextReference } from '@/lib/api';
import { serverOfObject } from '@/lib/server-routing';
import { catalogEntry, catalogParams, catalogSelection, parseSelection, pickedSelection } from '@/lib/models';
import { agentMarkStyle, backendSelection, launchSelection, sessionBackend, useBackendLabel } from '@/lib/backends';
import { LEGACY_DEFAULT_BACKEND_ID } from '@/lib/legacy-identity';
import { isAssistantProject } from '@/lib/project-family';
import { cleanLabel, cn, relativeTime } from '@/lib/utils';
import { sessionActivityAt, sortSessionsByActivity } from '@/lib/session-order';
import { ApprovalPicker, ApprovalSummary } from './session/ApprovalPicker';
import { ToolsPicker, lastToolGroups, offersExtensionToggles, offersRiffetTools, phoneGroup, rememberToolGroups, useControllablePhones, useExtensionsOffered, useLinkableServers, usePluginToolGroups } from './session/ToolsPicker';
import type { AgentMentionSource } from './session/agentMentions';
import { AgentLogo } from '@/components/AgentLogo';
import { BackendPicker } from './session/BackendPicker';
import { useAgentModels } from './session/agentModels';
import { DirectoryMenu } from './session/DirectoryMenu';
import { AttemptsDialog, AttemptsHistory } from './session/Attempts';
import { Composer, type ComposerProps } from './session/Composer';
import type { ModelProviderChoices } from './session/ModelPicker';
import { modelUsageAliases, type Choice } from './session/model';
import { useSlashCatalog } from './session/useSlashCatalog';
import { useLingering, WAIT_GRACE_MS } from './session/sessionLayout';
import { useGitStatus } from './state/gitStatusStore';
import { useLists, useStores } from './state/stores';
import { QuickChatHistory } from './QuickChatHistory';
import type { SessionAction } from './Sidebar';
import { QuickAction } from './QuickAction';
import { AssistantSetup } from './work-items/AssistantSetup';
import { isDefaultMember } from './work-items/assistant';
import { MemberAvatar } from './team/MemberAvatar';
import { MemberSessionsList } from './team/MemberSessionsList';
import { formatServerPlatform, type HomeServerOption } from './useServerLabel';
import { collectNonDefaultChips, inferModelProtocol } from './model-chat/tree';

export interface ProfileCatalog extends Pick<NativeBackendCatalogEntry, 'models' | 'available' | 'reason'> { profile: NativeBackendProfile }

/**
 * A model choice has to name its provider too, and two providers may well offer the same model id.
 * NUL cannot occur in either id, so it joins them without needing an escape.
 */
const CHOICE_SEPARATOR = '\u0000';
const composeChoice = (profileId: string, model: string) => `${profileId}${CHOICE_SEPARATOR}${model}`;

/** The picker's own list: online phones only, nothing remembered kept in it. */
const NO_TOOL_GROUPS: ToolGroupId[] = [];
const NO_EXTENSIONS_OFF: string[] = [];
/** Within the server's lease on a warm CLI, also when a hidden tab runs its timers once a minute. */
/** A send made before the page's first warm-up answered: the answer is the conversation's to claim. */
const PENDING_HANDOFF = '\u0000pending';

function splitChoice(id: string): { profileId?: string; model: string } {
  const at = id.indexOf(CHOICE_SEPARATOR);
  return at < 0 ? { model: id } : { profileId: id.slice(0, at), model: id.slice(at + 1) };
}

/**
 * Another agent's provider and its models in the model menu's agent column. SOH marks these ids,
 * so they never meet the active agent's own (`profileId\0model`, or a bare model id).
 */
const OTHER_AGENT = '\u0001';
const otherSource = (backendId: NativeBackendId, profileId?: string) => `${OTHER_AGENT}${backendId}${OTHER_AGENT}${profileId ?? ''}`;
const otherChoice = (backendId: NativeBackendId, profileId: string | undefined, model: string) => `${otherSource(backendId, profileId)}${OTHER_AGENT}${model}`;
function splitOther(id: string): { backendId: NativeBackendId; profileId?: string; model: string } | undefined {
  if (!id.startsWith(OTHER_AGENT)) return undefined;
  const [backendId = '', profileId = '', ...model] = id.slice(1).split(OTHER_AGENT);
  return { backendId: backendId as NativeBackendId, ...(profileId ? { profileId } : {}), model: model.join(OTHER_AGENT) };
}

/** What starting a new conversation takes: its directory, agent, model and first message. */
export interface NewSessionComposerProps {
  project?: ProjectRecord;
  /** Standing team member whose home composer is open (docs/TEAM.md). */
  member?: AgentMember;
  onOpenMemberConfig?: () => void;
  referenceProjectId?: string;
  recentModel?: string;
  /** Every project, so the composer can offer the others as new-session directories. */
  directories: ProjectRecord[];
  /** Selected server for new sessions (`''` is this server); shown as a pill before the directory when links exist. */
  serverId?: string;
  serverOptions?: HomeServerOption[];
  onSelectServer?: (serverId: string) => void;
  onOpenLinksSettings?: () => void;
  onSelectProject: (project: ProjectRecord) => void;
  onSelectNoProject?: () => void;
  onCreationPersisted?: (recover?: boolean) => void;
  creationRestore?: { projectId?: string; draft: NonNullable<ComposerProps['restoreDraft']> };
  pendingCreations?: NativeSessionCreateInput[];
  onRecoverCreation?: (body: NativeSessionCreateInput, retry?: boolean | 'restore') => void;
  /** Starts a session in a directory that is not registered yet, after asking for the path. */
  onChooseDirectory?: () => void;
  /** Starts a session in a known directory (a favorite), registering it as a project when needed. */
  onOpenDirectory?: (path: string) => void;
  /** Cuts a worktree off this project and switches to it, giving the next session its own checkout. */
  onCreateWorktree?: () => void;
  isolating?: boolean;
  settings: AppSettings;
  backends: NativeBackendCatalogEntry[];
  backendId: NativeBackendId;
  profileId?: string;
  backend?: NativeBackendCatalogEntry;
  /** Every provider's models, when the agent has more than one; absent means `catalog` is all of it. */
  profileCatalogs?: ProfileCatalog[];
  /** `model` is set when the agent was picked through one of its models in the model menu. */
  onBackendChange: (backendId: NativeBackendId, profileId?: string, model?: string) => void;
  /** Switches provider because a model of theirs was picked, carrying that model along. */
  onProfileChange: (profileId: string, model: string) => void;
  catalog: ModelInfo[];
  catalogLoading: boolean;
  catalogError: string;
  onRetryCatalog: () => void;
  onAgentPickerOpen: () => void;
  /** Re-reads the catalog(s) as the model list opens, without disturbing the current selection. */
  onRefreshCatalog?: () => Promise<void> | void;
  busy: boolean;
  references: PromptContextReference[];
  sessionReferences?: boolean;
  referenceSessions?: Session[];
  onOpenReferenceSession?: (id: string) => void;
  onReferencesChange: (references: PromptContextReference[]) => void;
  onCreate: (input: { projectId?: string; projectless?: boolean; prompt: string; attachments: Attachment[]; context: PromptContextReference[]; mode: string; model?: string; approval?: string; toolGroups?: ToolGroupId[]; extensionsOff?: string[]; backendId?: NativeBackendId; backendProfileId?: string | null; agentMemberId?: string; chatConfig?: ModelChatConfigPatch }) => Promise<boolean>;
  onError: (message: string) => void;
  /** Called when the user picks a model here, so the choice can be remembered globally. */
  onRememberModel?: (model: string) => void;
  /** Fullscreen editing; the host makes the rest of the page inert while it is open. */
  fullscreen?: boolean;
  onFullscreenChange?: (open: boolean) => void;
  /** Initial Model Chat parameters & pinned docs when composing a new Model Chat. */
  modelChatConfig?: ModelChatConfig;
  modelChatDocs?: readonly ModelChatPinnedDoc[];
  onUpdateModelChatConfig?: (patch: ModelChatConfigPatch) => Promise<void> | void;
  onOpenModelChatPanel?: (tab: 'params' | 'context') => void;
  onActiveModelChange?: (selection: string) => void;
}

interface Props extends NewSessionComposerProps {
  sessions: Session[];
  onChooseDirectory: () => void;
  onOpenDirectory: (path: string) => void;
  onOpenShell: () => void;
  onAttemptsStarted: (group: AttemptGroup) => void;
  onOpenAttemptGroup: (group: AttemptGroup) => void;
  onSelectSession: (session: Session) => void;
  onSessionAction: (session: Session, action: SessionAction) => void;
  header: ReactNode;
}

/**
 * The directory, agent, model and first message of a new conversation: the project page's hero.
 */
export function NewSessionComposer({ project, member, referenceProjectId, recentModel, directories, serverId, serverOptions, onSelectServer, onOpenLinksSettings, onSelectProject, onSelectNoProject, onCreationPersisted, creationRestore, pendingCreations, onRecoverCreation, onChooseDirectory, onOpenDirectory, onCreateWorktree, isolating, settings, backends, backendId, profileId, backend, profileCatalogs, onBackendChange, onProfileChange, catalog, catalogLoading, catalogError, onRetryCatalog, onAgentPickerOpen, onRefreshCatalog, busy, references, sessionReferences, referenceSessions, onOpenReferenceSession, onReferencesChange, onCreate, onError, onRememberModel, fullscreen, onFullscreenChange, modelChatConfig, modelChatDocs, onUpdateModelChatConfig, onOpenModelChatPanel, onActiveModelChange }: NewSessionComposerProps) {
  const { t } = useLingui();
  const quickChat = backendId === 'chat';
  // A standing member or 助理 has its directory fixed by its scope, and keeps its own model selection.
  const assistant = Boolean(member) || isAssistantProject(project);
  const memberScopePrefix = member ? `member:${member.id}${CHOICE_SEPARATOR}` : assistant ? `assistant${CHOICE_SEPARATOR}` : '';
  const label = useBackendLabel();
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const capabilities = backend?.capabilities;
  const savedDefaults = settings.nativeBackendDefaults?.[backendId];
  const defaultProfileId = backend?.profiles.find((entry) => entry.isDefault)?.id;
  const defaults = (profileId ?? defaultProfileId) === (savedDefaults?.profileId ?? defaultProfileId) ? savedDefaults : undefined;
  const rememberedProfileModel = !assistant && profileId ? savedDefaults?.profileModels?.[profileId] : undefined;
  // New sessions always start in agent mode. Plan and ask remain reachable from the session's own
  // mode picker, where the conversation they apply to is already on screen.
  const mode = capabilities?.modes.find((option) => option.id === 'agent')?.id ?? capabilities?.modes[0]?.id ?? 'agent';
  const preferredChat = settings.auxiliaryModels?.chat;
  const preferredChatModel = preferredChat ? `${preferredChat.backendId}:${preferredChat.profileId}:${preferredChat.model}` : '';
  const lastChat = parseSelection(recentModel);
  const chatModel = catalogEntry(catalog, preferredChatModel)?.value ?? catalogEntry(catalog, lastChat.model)?.value ?? catalog[0]?.value;
  // A configured chat model still inherits its latest effort/Fast choices; a different model gets its own defaults.
  const chatSelection = chatModel ? catalogSelection(catalog, chatModel, chatModel === lastChat.model ? lastChat.params : {}) : recentModel || preferredChatModel;
  const defaultModel = (quickChat ? chatSelection : rememberedProfileModel || defaults?.model || recentModel || (backendId === LEGACY_DEFAULT_BACKEND_ID && (!profileId || profileId === 'default') ? settings.defaultModel : undefined)) || backend?.defaultModel || '';
  const defaultApproval = capabilities?.permissions.find((option) => option.id === defaults?.approval)?.id ?? capabilities?.permissions[0]?.id ?? '';
  const [approval, setApproval] = useState(defaultApproval);
  const approvalBaseline = useRef(defaultApproval);
  // Starts from the last pick on this browser; the server drops a phone that has since gone.
  const [toolGroups, setToolGroups] = useState<ToolGroupId[]>(lastToolGroups);
  const changeToolGroups = useCallback((next: ToolGroupId[]) => { setToolGroups(next); rememberToolGroups(next); }, []);
  const activeServerId = serverId ?? (project && !project.system ? (serverOfObject(project.id) ?? '') : '');
  const activeServer = serverOptions?.find((item) => item.id === activeServerId) ?? serverOptions?.[0];
  const { phones } = useControllablePhones(NO_TOOL_GROUPS);
  const pluginTools = usePluginToolGroups(NO_TOOL_GROUPS);
  const linkedServerTools = useLinkableServers(toolGroups, !quickChat && !activeServerId);
  // A remembered phone that is offline now (or a plugin that is off) is left out of this conversation and kept for the next.
  // The new conversation's Agent may call other Agents (docs/AGENT-CALLS.md).
  const callsOffered = !quickChat && offersRiffetTools(capabilities);
  const pickedToolGroups = toolGroups.filter((id) => phones.some((device) => phoneGroup(device.id) === id) || pluginTools.available.includes(id) || linkedServerTools.available.includes(id) || (callsOffered && id === AGENT_CALL_TOOL_GROUP));
  const toolsOffered = callsOffered || (!quickChat && offersRiffetTools(capabilities) && (phones.length > 0 || pluginTools.available.length > 0 || linkedServerTools.offered));
  const teamMembers = useLists((state) => state.teamMembers);
  const agentMentions = useMemo<AgentMentionSource | undefined>(
    () => callsOffered ? { projectId: project?.id ?? '', backends, members: teamMembers, ...(member ? { currentMemberId: member.id } : {}) } : undefined,
    [callsOffered, project?.id, backends, teamMembers, member],
  );
  const [selection, setSelection] = useState(defaultModel);
  const [selectionEdited, setSelectionEdited] = useState(false);
  /*
   * The composer survives tab/provider switches. Each target keeps its own model and approval;
   * returning to it restores explicit picks while untouched controls follow their saved defaults.
   */
  // The 助理 or team member keeps a choice of its own, apart from the same agent's elsewhere.
  const choiceScope = `${activeServerId ? `${activeServerId}${CHOICE_SEPARATOR}` : ''}${memberScopePrefix}${backendId}${CHOICE_SEPARATOR}${profileId ?? ''}`;
  const [selectionScope, setSelectionScope] = useState(choiceScope);
  const choices = useRef(new Map<string, { selection: string; approval: string; edited: boolean }>());
  if (selectionScope !== choiceScope) {
    choices.current.set(selectionScope, { selection, approval, edited: selectionEdited });
    const previous = choices.current.get(choiceScope);
    setSelectionScope(choiceScope);
    setSelectionEdited(previous?.edited ?? false);
    setSelection(previous?.edited ? previous.selection : defaultModel);
    setApproval(previous?.approval ?? defaultApproval);
    approvalBaseline.current = defaultApproval;
  }
  // With several providers the model list spans all of them and each entry carries the provider
  // it came from; with one there is nothing to group and the plain catalog is the whole story.
  const grouped = profileCatalogs && profileCatalogs.length > 1 ? profileCatalogs : undefined;
  const activeProfileId = profileId ?? defaultProfileId ?? backend?.profiles[0]?.id;
  // MCP servers and skills are read per project, so they are offered once one is chosen. Switched-off items
  // belong to this conversation only: they are not remembered, and a different backend, provider or project starts clean.
  const extensionToggles = !quickChat && project ? offersExtensionToggles(capabilities) : undefined;
  const extensionScope = `${backendId}\u0000${activeProfileId ?? ''}\u0000${project?.id ?? ''}`;
  const [extensionsOffPick, setExtensionsOffPick] = useState<{ scope: string; off: string[] }>({ scope: extensionScope, off: NO_EXTENSIONS_OFF });
  if (extensionsOffPick.scope !== extensionScope) setExtensionsOffPick({ scope: extensionScope, off: NO_EXTENSIONS_OFF });
  const extensionsOff = extensionsOffPick.scope === extensionScope ? extensionsOffPick.off : NO_EXTENSIONS_OFF;
  const extensionPick = extensionToggles && project ? { backendId, ...(activeProfileId ? { profileId: activeProfileId } : {}), projectId: project.id, toggles: extensionToggles, off: extensionsOff, onChange: (next: string[]) => setExtensionsOffPick({ scope: extensionScope, off: next }) } : undefined;
  const extensionsOffered = useExtensionsOffered(extensionPick);
  // Prefer the grouped copy: right after a provider switch it already holds the new provider's
  // models, while the single-profile catalog is still a request behind.
  const activeCatalog = grouped?.find((entry) => entry.profile.id === activeProfileId)?.models ?? catalog;
  const models: Choice[] = useMemo(() => grouped
    ? grouped.flatMap(({ profile, models: list }) => list.map((item) => ({ id: composeChoice(profile.id, item.value), label: cleanLabel(item.name), group: profile.name, aliases: modelUsageAliases(item) })))
    : catalog.map((item) => ({ id: item.value, label: cleanLabel(item.name), aliases: modelUsageAliases(item) })), [grouped, catalog]);
  const rememberedModelName = (targetBackend: NativeBackendId, targetProfile: string | undefined, targetCatalog: ModelInfo[]): string => {
    const scope = `${activeServerId ? `${activeServerId}${CHOICE_SEPARATOR}` : ''}${assistant ? `assistant${CHOICE_SEPARATOR}` : ''}${targetBackend}${CHOICE_SEPARATOR}${targetProfile ?? ''}`;
    const previous = choices.current.get(scope);
    if (previous?.edited) return parseSelection(previous.selection).model;
    if (assistant) return '';
    const saved = settings.nativeBackendDefaults?.[targetBackend];
    const targetEntry = backends.find((entry) => entry.backendId === targetBackend);
    const targetDefault = targetEntry?.profiles.find((profile) => profile.isDefault)?.id;
    const isSavedDefault = (targetProfile ?? targetDefault) === (saved?.profileId ?? targetDefault);
    const raw = (targetProfile ? saved?.profileModels?.[targetProfile] : undefined)
      || (isSavedDefault ? saved?.model : undefined)
      || (targetBackend === LEGACY_DEFAULT_BACKEND_ID && (!targetProfile || targetProfile === 'default') ? settings.defaultModel : undefined)
      || targetEntry?.defaultModel
      || '';
    const parsed = parseSelection(raw).model;
    if (!parsed) return '';
    return catalogEntry(targetCatalog, parsed)?.value ?? parsed;
  };
  // The provider column, in configured order, with each provider's models as its read lands.
  // A missing entry is loading rather than empty, so previously loaded providers do not jump.
  const providerChoices = useMemo<ModelProviderChoices[] | undefined>(() => {
    if (!grouped || !backend?.profiles.length) return undefined;
    const saved = settings.nativeBackendDefaults?.[backendId]?.profileId ?? backend.profiles.find((profile) => profile.isDefault)?.id;
    return backend.profiles.map((profile) => {
      const entry = grouped.find((item) => item.profile.id === profile.id);
      const list = entry?.available === false ? [] : entry?.models ?? [];
      const remembered = rememberedModelName(backendId, profile.id, list);
      return {
        id: profile.id,
        label: profile.name,
        models: entry?.available && !list.length
          ? [{ id: composeChoice(profile.id, ''), label: t`默认模型` }]
          : list.map((item) => ({ id: composeChoice(profile.id, item.value), label: cleanLabel(item.name), aliases: modelUsageAliases(item) })),
        loading: !entry,
        ...(entry?.available === false ? { issue: entry.reason?.trim() || t`${label(backendId)} 不可用` } : {}),
        preferred: profile.id === saved,
        ...(remembered ? { rememberedModelId: composeChoice(profile.id, remembered) } : {}),
      };
    });
  }, [grouped, backend, backendId, settings.nativeBackendDefaults, settings.defaultModel, assistant, label, t]);
  // Usage is read for the active provider only, stored raw so ModelPicker, settings and plugin pages share one cache.
  const loadModelUsage = useCallback((signal: AbortSignal) => apiFor(activeServerId || undefined).backendUsage(backendId, { ...(project?.id ? { projectId: project.id } : { scope: 'global' as const }), ...(activeProfileId ? { profileId: activeProfileId } : {}) }, signal), [activeServerId, backendId, project?.id, activeProfileId]);
  const slash = useSlashCatalog(quickChat || backend?.available === false ? undefined : backendId, { ...(project?.id ? { projectId: project.id } : { scope: 'global' as const }), ...(activeProfileId ? { profileId: activeProfileId } : {}), ...(activeServerId ? { serverId: activeServerId } : {}) });
  const selected = backendSelection(backendId, activeCatalog, selection);
  const effectiveSelection = launchSelection(activeCatalog, selected);
  const selectionNeedsCatalog = Boolean(selection) && (catalogLoading || Boolean(catalogError) || activeCatalog.length === 0);
  const backendIssue = backend?.available === false ? backend.reason?.trim() || t`${label(backendId)} 不可用` : '';
  // Availability failures also reach catalogError; the backend's row says that cause once, and
  // anything else about the catalog is said, with its retry, on the model picker.
  const catalogIssue = catalogError.trim();
  const modelsError = catalogIssue !== backendIssue ? catalogIssue : '';
  /*
   * On a pointer device the model menu also picks the agent: its column lists the offered agents (with
   * its providers), and picking a model saves agent, provider and model in one write. Other agents'
   * lists paint from the cache and are read when the reader looks at them.
   */
  const agentModels = useAgentModels(project?.id ?? '', activeServerId);
  // Decided by layout alone: the agent list arrives after the first frames, and a choice that
  // waited for it would draw the separate agent button first and then swap it out.
  const agentChoices = !quickChat && !mobile;
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const pickerBackends = useMemo(() => backends.filter((entry) => entry.backendId !== 'chat' && entry.cliMissing !== true), [backends]);
  const agentOf = (id: NativeBackendId) => ({ id, label: label(id), icon: <AgentLogo backend={id} size={14} style={agentMarkStyle(id)} /> });
  const listedBackend = backends.find((entry) => entry.backendId === backendId);
  const activeAgentMissing = listedBackend?.cliMissing === true;
  /** The active agent's row while its providers are not grouped: the same id it has while another agent is active, so the column keeps its place when it becomes the active one. */
  const listedProfiles = listedBackend?.profiles ?? [];
  const activeSourceId = otherSource(backendId, listedProfiles.length ? activeProfileId ?? listedProfiles[0]?.id : undefined);
  // While every provider's models are listed together, the active provider's row holds only its own.
  const activeModels = grouped && activeProfileId ? models.filter((item) => item.id.startsWith(`${activeProfileId}${CHOICE_SEPARATOR}`)) : models;
  const agentSources: ModelProviderChoices[] | undefined = agentChoices ? pickerBackends.flatMap((entry) => {
    const agent = agentOf(entry.backendId);
    if (entry.backendId === backendId && providerChoices) return providerChoices.map((provider) => ({ ...provider, agent }));
    const profiles: Array<NativeBackendProfile | undefined> = entry.profiles.length ? entry.profiles : [undefined];
    const defaultProfile = (entry.profiles.find((profile) => profile.isDefault) ?? entry.profiles[0])?.id;
    const saved = settings.nativeBackendDefaults?.[entry.backendId]?.profileId ?? defaultProfile;
    return profiles.map((profile): ModelProviderChoices => {
      const id = otherSource(entry.backendId, profile?.id);
      const label = profile?.name ?? agent.label;
      // The provider in force lists the composer's own catalog; the others, while it has several
      // that have not all been read, are listed like another agent's and fill in as they answer.
      if (id === activeSourceId) return { id, label, agent, models: activeModels, loading: catalogLoading && !models.length, ...(!models.length && (backendIssue || modelsError) ? { issue: backendIssue || modelsError } : {}) };
      const probe = agentModels.probed(entry.backendId, profile?.id);
      const isDefault = profile?.id === defaultProfile;
      const available = (!isDefault || entry.available) && probe?.available !== false;
      const list = available ? agentModels.read(entry.backendId, profile?.id) : undefined;
      const issue = !available
        ? (probe?.reason ?? (isDefault ? entry.reason : undefined))?.trim() || t`${agent.label} 不可用`
        : list?.length ? undefined : agentModels.issue(entry.backendId, profile?.id);
      const loading = !list?.length && agentModels.loading(entry.backendId, profile?.id);
      // An agent that lists nothing still starts on its own default model, as picking it alone used to.
      const fallback = available && !loading && !list?.length && (list || issue);
      const remembered = rememberedModelName(entry.backendId, profile?.id, list ?? []);
      return {
        id,
        label,
        agent,
        preferred: profile?.id === saved,
        ...(remembered ? { rememberedModelId: otherChoice(entry.backendId, profile?.id, remembered) } : {}),
        models: fallback
          ? [{ id: otherChoice(entry.backendId, profile?.id, ''), label: t`默认模型` }]
          : (list ?? []).map((item) => ({ id: otherChoice(entry.backendId, profile?.id, item.value), label: cleanLabel(item.name), aliases: modelUsageAliases(item) })),
        loading,
        ...(issue ? { issue } : {}),
      };
    });
  }) : undefined;
  /** Switches directly to an available agent or provider and restores its remembered model. */
  const selectModelProvider = (id: string) => {
    const other = splitOther(`${id}${OTHER_AGENT}`);
    const targetBackendId = other ? other.backendId : backendId;
    const targetProfileId = other ? other.profileId : id;
    if (targetBackendId === backendId && (targetProfileId ?? activeProfileId) === activeProfileId) return;
    const scope = `${assistant ? `assistant${CHOICE_SEPARATOR}` : ''}${targetBackendId}${CHOICE_SEPARATOR}${targetProfileId ?? ''}`;
    const previous = choices.current.get(scope);
    const saved = assistant ? undefined : settings.nativeBackendDefaults?.[targetBackendId];
    const targetEntry = backends.find((entry) => entry.backendId === targetBackendId);
    const targetDefaultProfile = targetEntry?.profiles.find((entry) => entry.isDefault)?.id;
    const isSavedDefault = !assistant && (targetProfileId ?? targetDefaultProfile) === (saved?.profileId ?? targetDefaultProfile);
    const raw = previous?.edited
      ? previous.selection
      : (!assistant && targetProfileId ? saved?.profileModels?.[targetProfileId] : undefined)
        || (isSavedDefault ? saved?.model : undefined)
        || (!assistant && targetBackendId === LEGACY_DEFAULT_BACKEND_ID && (!targetProfileId || targetProfileId === 'default') ? settings.defaultModel : undefined)
        || (!assistant ? targetEntry?.defaultModel : undefined)
        || '';
    const targetCatalog = targetBackendId === backendId && targetProfileId === activeProfileId
      ? activeCatalog
      : agentModels.read(targetBackendId, targetProfileId) ?? [];
    const parsed = parseSelection(raw);
    const next = raw
      ? (targetCatalog.length ? pickedSelection(targetCatalog, parsed.model, parsed.params, raw) : raw)
      : '';
    if (targetBackendId !== backendId) {
      onBackendChange(targetBackendId, targetProfileId, previous?.edited || next ? next : undefined);
      return;
    }
    if (targetProfileId) onProfileChange(targetProfileId, next);
  };
  // An installation may reveal a new Agent after the menu has opened.
  const { load: loadAgentModels, read: readAgentModels, probed: probedAgent } = agentModels;
  const groupedProviders = Boolean(providerChoices);
  useEffect(() => {
    if (!agentChoices || !agentPickerOpen) return;
    for (const entry of pickerBackends) {
      if (entry.backendId === backendId && groupedProviders) continue;
      const defaultProfile = (entry.profiles.find((profile) => profile.isDefault) ?? entry.profiles[0])?.id;
      for (const profileId of entry.profiles.length ? entry.profiles.map((profile) => profile.id) : [undefined]) {
        if (otherSource(entry.backendId, profileId) === activeSourceId) continue;
        if (profileId === defaultProfile && !entry.available) continue;
        if (!readAgentModels(entry.backendId, profileId)?.length) loadAgentModels(entry.backendId, profileId, probedAgent(entry.backendId, profileId)?.cliMissing);
      }
    }
  }, [activeSourceId, agentChoices, agentPickerOpen, backendId, groupedProviders, loadAgentModels, pickerBackends, probedAgent, readAgentModels]);

  // A send held for the catalog has no reason of its own on the disabled button.
  const selectionHeld = selectionNeedsCatalog && !catalogLoading;
  // A list that is still loading locks only once the wait outlasts the grace, as its spinner does,
  // so a quick switch does not dim the picker for a frame. A pick made from it meanwhile applies
  // here but is not remembered: the list may still be another project's (see Workbench).
  const catalogWaited = useLingering(catalogLoading, WAIT_GRACE_MS);
  const selectedModel = parseSelection(effectiveSelection).model;
  // Old saved ids can outlive the catalog. Keep them for submit compatibility, but never present
  // an unrecognized id as a model choice or infer configuration options for it.
  const modelChoice = grouped && activeProfileId ? composeChoice(activeProfileId, selectedModel) : selectedModel;
  const model = models.some((item) => item.id === modelChoice) ? selectedModel : '';
  const params = useMemo(() => catalogParams(activeCatalog, model, model ? parseSelection(effectiveSelection).params : {}), [activeCatalog, effectiveSelection, model]);
  const submitSelection = effectiveSelection
    ? catalogSelection(activeCatalog, selectedModel, parseSelection(effectiveSelection).params)
    : effectiveSelection;

  useEffect(() => {
    if (quickChat) onActiveModelChange?.(submitSelection || model);
  }, [quickChat, submitSelection, model, onActiveModelChange]);

  useEffect(() => {
    if (!selectionEdited) setSelection(defaultModel);
  }, [defaultModel, selectionEdited]);
  useEffect(() => {
    const previous = approvalBaseline.current;
    approvalBaseline.current = defaultApproval;
    setApproval((current) => previous !== defaultApproval || !capabilities?.permissions.some((option) => option.id === current) ? defaultApproval : current);
  }, [capabilities, defaultApproval]);

  // A CLI takes seconds to start, longer than most first messages take to write. While this page
  // shows an Agent that keeps one (`supportsPrewarm`), a warm CLI is held for it: asked for when the
  // page opens, renewed while it stays open, and released when the page closes or another Agent or
  // setting is chosen. A sent message hands it to the new conversation instead.
  const prewarmClaims = useRef<{ current?: string; handedOff?: string }>({});
  useEffect(() => {
    if (quickChat || !project || !capabilities?.supportsPrewarm || activeServerId) return;
    const claims = prewarmClaims.current;
    let closed = false, claimId: string | undefined;
    const release = (id = claimId) => {
      claimId = undefined;
      if (id && id !== claims.handedOff) void api.nativePrewarmRelease({ backendId, claimId: id }).catch(() => undefined);
    };
    const warm = () => void api.nativePrewarm({
      projectId: project.id, backendId, backendProfileId: profileId,
      ...(effectiveSelection ? { model: effectiveSelection } : {}),
      mode,
      approval,
      // A renewal names the page's warm CLI: it never takes the one slot from another page.
      ...(claimId ? { claimId } : {}),
    }).then(result => {
      // A send made before the first answer handed this one over.
      if (result.claimId && claims.handedOff === PENDING_HANDOFF) claims.handedOff = result.claimId;
      // An answer that arrives after the page closed is released at once.
      if (closed) release(result.claimId);
      else if (result.claimId) claimId = claims.current = result.claimId;
    }).catch(() => undefined);
    const start = window.setTimeout(warm, PREWARM_BUDGET.startDelayMs);
    const renew = window.setInterval(warm, PREWARM_BUDGET.renewMs);
    const leave = () => release();
    window.addEventListener('pagehide', leave);
    return () => {
      closed = true;
      window.clearTimeout(start);
      window.clearInterval(renew);
      window.removeEventListener('pagehide', leave);
      release();
    };
  }, [approval, effectiveSelection, mode, project?.id, backendId, profileId, capabilities?.supportsPrewarm, quickChat]);
  const submit: typeof onCreate = input => {
    const claims = prewarmClaims.current;
    claims.handedOff = claims.current ?? PENDING_HANDOFF;
    return onCreate(input).then(created => { if (!created) claims.handedOff = undefined; return created; }, (error: unknown) => { claims.handedOff = undefined; throw error; });
  };

  const hasServerPill = Boolean(serverOptions && serverOptions.length > 0);
  const scopedDirectories = useMemo(
    () => hasServerPill ? directories.filter((item) => (serverOfObject(item.id) ?? '') === activeServerId) : directories,
    [directories, hasServerPill, activeServerId],
  );
  const needsRemoteDirectory = !quickChat && !assistant && Boolean(activeServerId) && !project;
  const pillClass = 'flex h-7 max-w-full items-center gap-1.5 rounded-lg px-2 text-xs text-fg-2 transition-colors outline-none hover:bg-hover hover:text-fg data-[state=open]:bg-active data-[state=open]:text-fg focus-visible:ring-2 focus-visible:ring-focus';

  const creationNotices: FeedbackMessage[] = [];
  if (backendIssue) creationNotices.push({ id: `backend:${backendIssue}`, text: backendIssue, tone: 'danger' });
  if (selectionHeld) creationNotices.push({ id: 'selection', text: t`模型选择已保留，目录恢复前暂不能发送。`, tone: 'neutral' });
  if (needsRemoteDirectory) creationNotices.push({ id: 'remote-directory', text: t`先在 ${activeServer?.name ?? ''} 选择一个目录`, tone: 'neutral' });

  return (
    <div className="relative flex flex-col">
      {/* The session's working directory is the one choice that cannot be changed afterwards, so
          it is offered right where the request is written — and only here, so that clicking
          "new session" in the sidebar stays a plain navigation step. Fixed `h-7` keeps the
          composer in place when switching between 新建任务 and 快速对话. */}
      <div className="mb-1.5 flex h-7 items-center gap-1" inert={fullscreen || undefined}>
        {!quickChat && !assistant && hasServerPill && serverOptions && <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={cn(pillClass, 'shrink-0 max-w-44')}>
              {activeServer?.self ? <IconLaptop className="size-3.5 shrink-0 text-fg-3" /> : <IconServer className="size-3.5 shrink-0 text-fg-3" />}
              <span className="min-w-0 truncate font-medium">{activeServer?.name}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[min(19rem,calc(100vw-1.5rem))]">
            <DropdownMenuLabel>{t`在哪台服务器新建？`}</DropdownMenuLabel>
            {serverOptions.map((item) => {
              const subtitle = item.note || [item.alias && item.alias !== item.name ? item.alias : '', formatServerPlatform(item.platform)].filter(Boolean).join(' · ');
              return (
                <DropdownMenuItem key={item.id || 'self'} disabled={!item.usable} onSelect={() => onSelectServer?.(item.id)}>
                  <StatusDot tone={item.usable ? 'success' : 'idle'} className="shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{item.name}</span>
                    {!item.reason && subtitle && <span className="truncate text-2xs text-fg-4">{subtitle}</span>}
                  </span>
                  {item.reason && <span className="shrink-0 text-2xs text-fg-3">{item.reason}</span>}
                  <span className="grid size-4 shrink-0 place-items-center">{item.id === activeServerId && <IconCheck className="size-4 text-fg" />}</span>
                </DropdownMenuItem>
              );
            })}
            {onOpenLinksSettings && <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onOpenLinksSettings}>
                <IconLink className="size-4 text-fg-3" />
                <span>{t`管理互联…`}</span>
              </DropdownMenuItem>
            </>}
          </DropdownMenuContent>
        </DropdownMenu>}
        {!quickChat && !assistant && (needsRemoteDirectory ? (
          <button type="button" onClick={onChooseDirectory} className={pillClass}>
            <IconFolderPlus className="size-3.5 shrink-0 text-fg-3" />
            <span className="min-w-0 truncate font-medium">{t`选择目录…`}</span>
          </button>
        ) : <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" title={project?.cwd} className={pillClass}>
              <IconFolderClosed className="size-3.5 shrink-0 text-fg-3" />
              <span className="min-w-0 truncate font-medium">{project?.system === 'task-workspace' || !project ? t`未关联项目` : project.name}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[min(22rem,calc(100vw-1.5rem))]">
            <DirectoryMenu
              directories={scopedDirectories}
              selectedProjectId={project?.system === 'task-workspace' ? '' : project?.id ?? ''}
              showServerTag={!hasServerPill}
              onSelectNoProject={activeServerId ? undefined : onSelectNoProject}
              onSelectProject={onSelectProject}
              {...(onChooseDirectory ? { onChooseDirectory } : {})}
              {...(!activeServerId && onOpenDirectory ? { onOpenDirectory } : {})}
              onCreateWorktree={onCreateWorktree}
              isolating={isolating}
            />
          </DropdownMenuContent>
        </DropdownMenu>)}
      </div>

      <Composer
        variant="hero"
        autoFocus
        projectId={project?.id ?? ''}
        referenceProjectId={referenceProjectId}
        referencesEnabled={!quickChat}
        // One composer and one draft across task/chat tabs; only task references are project-bound.
        draftKey="new:home"
        fullscreen={fullscreen}
        onFullscreenChange={onFullscreenChange}
        enterBehavior={settings.composerEnterBehavior}
        placeholder={quickChat || assistant ? t`输入消息…` : t`描述任务…`}
        commands={(!quickChat ? slash.catalog?.items : undefined) ?? capabilities?.slashCommands ?? []}
        inlineSkills={!quickChat && (slash.catalog?.inlineSkills ?? capabilities?.inlineSkills)}
        onSlashMenuOpen={quickChat ? undefined : slash.refresh}
        fileMentions={!quickChat && Boolean(project) && !isAssistantProject(project)}
        sessionMentions={!quickChat && sessionReferences && capabilities?.supportsSessionReferences === true}
        agentMentions={agentMentions}
        referenceSessions={referenceSessions}
        referenceProjects={directories}
        onOpenReferenceSession={onOpenReferenceSession}
        disabled={busy}
        submitDisabled={catalogLoading || selectionNeedsCatalog || activeAgentMissing || backend?.available === false || (quickChat && !model) || needsRemoteDirectory}
        // An empty list's picker is its own retry and holds itself while that runs, keeping focus.
        pickersDisabled={catalogWaited && models.length > 0}
        modelsLoading={catalogLoading}
        modelsError={modelsError}
        onRetryModels={onRetryCatalog}
        toolbar={!quickChat && capabilities?.permissions.length ? (
          <ApprovalPicker
            side={fullscreen ? 'top' : 'bottom'}
            value={approval}
            options={capabilities.permissions}
            onChange={setApproval}
            compact={!mobile}
            disabled={busy || !capabilities.supportsPermissionSelection}
          />
        ) : undefined}
        toolsPicker={toolsOffered || extensionsOffered ? <ToolsPicker value={pickedToolGroups} onChange={changeToolGroups} extensions={extensionPick} agents={callsOffered} servers={!activeServerId} disabled={busy} onError={onError} /> : undefined}
        statusChips={quickChat && modelChatConfig ? (() => {
          const protocol = inferModelProtocol(submitSelection || model);
          const chips = collectNonDefaultChips(modelChatConfig, protocol, {
            bareMode: 'Raw',
            stateless: 'Stateless',
            window: 'Window',
            full: 'Full',
            effortOff: 'Effort off',
            effortPrefix: 'Effort',
            webSearch: 'Web Search',
            fast: 'Fast',
            cacheOff: 'No Cache',
            jsonObject: 'JSON',
            jsonSchema: 'JSON Schema',
          });
          const activeDocCount = (modelChatDocs ?? []).filter((doc) => doc.pinned).length;
          const hasCustomSystem = !modelChatConfig.bareMode && modelChatConfig.systemPrompt.trim().length > 0;
          if (!chips.length && !activeDocCount && !hasCustomSystem) return undefined;
          return (
            <div className="flex flex-wrap items-center gap-1">
              {hasCustomSystem && (
                <button
                  type="button"
                  onClick={() => onOpenModelChatPanel?.('params')}
                  className="inline-flex h-6 items-center rounded-md bg-subtle px-2 text-2xs text-fg-2 transition-colors hover:bg-hover hover:text-fg"
                >
                  System
                </button>
              )}
              {activeDocCount > 0 && (
                <button
                  type="button"
                  onClick={() => onOpenModelChatPanel?.('context')}
                  className="inline-flex h-6 items-center rounded-md bg-subtle px-2 text-2xs text-fg-2 transition-colors hover:bg-hover hover:text-fg"
                >
                  {t`材料 ${activeDocCount}`}
                </button>
              )}
              {chips.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  onClick={() => onOpenModelChatPanel?.(chip.id === 'stateless' || chip.id === 'window' || chip.id === 'full' || chip.id === 'cache' ? 'context' : 'params')}
                  className={cn(
                    'inline-flex h-6 items-center rounded-md px-2 text-2xs transition-colors',
                    chip.tone === 'warning'
                      ? 'bg-warning-soft text-warning hover:opacity-90'
                      : chip.tone === 'accent'
                        ? 'bg-accent-soft text-fg hover:opacity-90'
                        : 'bg-subtle text-fg-2 hover:bg-hover hover:text-fg',
                  )}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          );
        })() : undefined}
        mobileSettingsPrefix={quickChat || !capabilities?.permissions.length ? undefined : <ApprovalSummary mode={approval} options={capabilities.permissions} />}
        mobileSettingsLabel={[!quickChat && label(backendId), models.find((item) => item.id === modelChoice)?.label].filter(Boolean).join(' · ')}
        // The model menu picks the agent too where it has a column for them; a phone keeps its own row.
        startPickers={quickChat || agentChoices ? undefined : <BackendPicker backends={pickerBackends} backendId={backendId} onChange={onBackendChange} onOpen={onAgentPickerOpen} disabled={busy} fullWidth={mobile} />}
        startPickersLabel={quickChat ? undefined : label(backendId)}
        models={models}
        providers={agentSources ?? providerChoices}
        // Named the way the rows are: by profile while the providers come grouped, else by the column's own ids.
        activeProviderId={providerChoices ? activeProfileId : agentSources ? activeSourceId : undefined}
        modelLeading={agentSources && <><AgentLogo backend={backendId} size={14} className="shrink-0" style={agentMarkStyle(backendId)} /><span className="sr-only">{label(backendId)}</span></>}
        modelSourceLabel={activeServerId && activeServer ? t`来自 ${activeServer.name}` : undefined}
        onPreviewModelProvider={(id) => { const other = splitOther(`${id}${OTHER_AGENT}`); if (other && id !== activeSourceId) agentModels.load(other.backendId, other.profileId); }}
        onSelectModelProvider={selectModelProvider}
        onModelPickerOpenChange={agentChoices ? (open) => { setAgentPickerOpen(open); if (open) onAgentPickerOpen(); } : undefined}
        loadModelUsage={activeAgentMissing ? undefined : loadModelUsage}
        refreshCatalog={quickChat ? onRetryCatalog : agentChoices && activeAgentMissing ? undefined : onRefreshCatalog}
        usageScopeKey={`${activeServerId}|${backendId}|${project?.id ?? 'global'}|${activeProfileId ?? ''}`}
        model={model ? modelChoice : undefined}
        onModelChange={(id) => {
          // A model picked again on a provider comes back as last used there; another one keeps the
          // effort, Fast and context in force wherever it accepts them. The 助理 keeps a choice of its own.
          const inForce = parseSelection(effectiveSelection).params;
          const lastOn = (agent: NativeBackendId, profile: string | undefined) => assistant || !profile ? undefined : settings.nativeBackendDefaults?.[agent]?.profileModels?.[profile];
          const other = splitOther(id);
          if (other) {
            // Another agent's model: the agent, its provider and the model are saved together.
            // An empty model is that agent's default, for one that lists nothing.
            const next = other.model ? pickedSelection(agentModels.read(other.backendId, other.profileId) ?? [], other.model, inForce, lastOn(other.backendId, other.profileId)) : '';
            const scope = `${activeServerId ? `${activeServerId}${CHOICE_SEPARATOR}` : ''}${assistant ? `assistant${CHOICE_SEPARATOR}` : ''}${other.backendId}${CHOICE_SEPARATOR}${other.profileId ?? ''}`;
            const previous = choices.current.get(scope);
            if (previous) choices.current.set(scope, { ...previous, selection: next, edited: true });
            onBackendChange(other.backendId, other.profileId, next);
            return;
          }
          const chosen = splitChoice(id);
          const chosenCatalog = (chosen.profileId && grouped?.find((entry) => entry.profile.id === chosen.profileId)?.models) || activeCatalog;
          const next = pickedSelection(chosenCatalog, chosen.model, inForce, lastOn(backendId, chosen.profileId ?? activeProfileId));
          // Picking another provider's model is also how that provider gets selected, and the
          // two have to be saved together or the model would be dropped as a stale override.
          if (chosen.profileId && chosen.profileId !== activeProfileId) {
            const scope = `${assistant ? `assistant${CHOICE_SEPARATOR}` : ''}${backendId}${CHOICE_SEPARATOR}${chosen.profileId}`;
            const previous = choices.current.get(scope);
            if (previous) choices.current.set(scope, { ...previous, selection: next, edited: true });
            onProfileChange(chosen.profileId, next);
          } else {
            setSelectionEdited(true);
            setSelection(next);
            if (!quickChat && !catalogLoading) onRememberModel?.(next);
          }
        }}
        modelParams={params}
        onModelParamChange={(id, value) => {
          const next = catalogSelection(activeCatalog, model, { ...parseSelection(effectiveSelection).params, [id]: value }, id);
          setSelectionEdited(true);
          setSelection(next);
          if (quickChat && onUpdateModelChatConfig) {
            if (id === 'effort') {
              void onUpdateModelChatConfig({ effort: (value === 'default' ? MODEL_CHAT_DEFAULT_CONFIG.effort : value) as ModelChatEffort });
            } else if (id === 'search') {
              void onUpdateModelChatConfig({ webSearch: value === 'true' });
            } else if (id === 'fast') {
              void onUpdateModelChatConfig({ fast: value === 'true' });
            }
          }
          if (!quickChat && !catalogLoading) onRememberModel?.(next);
        }}
        references={references}
        onReferencesChange={onReferencesChange}
        feedback={pendingCreations?.length ? <div className="flex flex-col gap-2 text-xs text-fg-3" role="status">{pendingCreations.map(body => <div key={body.clientSessionId} className="rounded-lg bg-subtle px-3 py-2">
          <p className="line-clamp-2 break-words text-fg-2">{body.initialMessage.text}</p>
          <div className="mt-1 flex flex-wrap items-center gap-3"><span>{body.rejected ? <Trans>发送失败</Trans> : <Trans>暂时无法确认是否已发送</Trans>}</span>{body.rejected ? <button type="button" disabled={busy} onClick={() => onRecoverCreation?.(body, 'restore')} className="underline underline-offset-2 disabled:opacity-50"><Trans>恢复到输入框</Trans></button> : <><button type="button" disabled={busy} onClick={() => onRecoverCreation?.(body)} className="underline underline-offset-2 disabled:opacity-50"><Trans>检查状态</Trans></button><button type="button" disabled={busy} onClick={() => onRecoverCreation?.(body, true)} className="underline underline-offset-2 disabled:opacity-50"><Trans>重试发送</Trans></button></>}{busy && <Spinner className="size-3" />}</div>
        </div>)}</div> : undefined}
        restoreDraft={creationRestore && creationRestore.projectId === project?.id ? creationRestore.draft : undefined}
        onSubmitPersisted={onCreationPersisted}
        onSubmit={(prompt, attachments, context) => {
          const chatPatch: ModelChatConfigPatch | undefined = quickChat && modelChatConfig ? (() => {
            const patch: ModelChatConfigPatch = { ...modelChatConfig };
            if (modelChatDocs?.length) patch.pinnedDocs = [...modelChatDocs];
            const isDefault = !patch.pinnedDocs?.length
              && !patch.bareMode
              && !patch.systemPrompt
              && patch.effort === MODEL_CHAT_DEFAULT_CONFIG.effort
              && patch.temperature === undefined
              && patch.topP === undefined
              && patch.maxOutputTokens === MODEL_CHAT_DEFAULT_CONFIG.maxOutputTokens
              && patch.contextBudget === MODEL_CHAT_DEFAULT_CONFIG.contextBudget
              && patch.contextStrategy === MODEL_CHAT_DEFAULT_CONFIG.contextStrategy
              && patch.responseFormat?.type === 'text'
              && !patch.webSearch
              && !patch.fast
              && patch.promptCaching === MODEL_CHAT_DEFAULT_CONFIG.promptCaching
              && (patch.seed === undefined || patch.seed === null)
              && !patch.stop?.length;
            return isDefault ? undefined : patch;
          })() : undefined;
          const effectiveModel = quickChat
            ? parseSelection(submitSelection).model
            : submitSelection;
          return submit({ ...(project?.id ? { projectId: project.id } : { projectless: true }), prompt, attachments, context, mode: quickChat ? 'agent' : mode, ...(effectiveModel ? { model: effectiveModel } : {}), ...(quickChat ? { backendId: 'chat', backendProfileId: null, ...(chatPatch ? { chatConfig: chatPatch } : {}) } : { approval }), ...(toolsOffered ? { toolGroups: pickedToolGroups } : {}), ...(extensionPick && extensionsOff.length ? { extensionsOff } : {}), ...(member ? { agentMemberId: member.id } : {}) });
        }}
        onError={onError}
      />
      <FeedbackNotices scope={`${project?.id ?? 'global'}:${backendId}:${activeProfileId ?? ''}`} messages={creationNotices}
        className="mt-2" noticeClassName="items-start rounded-lg px-3 py-2 text-xs" icon={null}
        action={message => message.id.startsWith('backend:')
          ? <Button size="xs" variant="quiet" onClick={onRetryCatalog} disabled={catalogLoading} className="-my-1 shrink-0">{t`重新检测`}</Button>
          : message.id === 'remote-directory' && onChooseDirectory
            ? <Button size="xs" variant="quiet" onClick={onChooseDirectory} className="-my-1 shrink-0">{t`选择目录`}</Button>
            : undefined} />
    </div>
  );
}

export function NewSessionHome({ sessions, onOpenShell, onAttemptsStarted, onOpenAttemptGroup, onSelectSession, onSessionAction, header, ...composer }: Props) {
  const { t } = useLingui();
  const { ui } = useStores();
  const quickChat = composer.backendId === 'chat';
  const label = useBackendLabel();
  const { project, backends, backendId, backend, busy, settings, references, onReferencesChange, onError } = composer;
  // An unread status is pending, not "no repository": a repository's tools do not dim while it is read.
  const noRepository = useGitStatus(project?.id)?.code === 'NOT_A_GIT_REPOSITORY';
  const [attemptsOpen, setAttemptsOpen] = useState(false);
  useEffect(() => { setAttemptsOpen(false); }, [project?.id]);
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const capabilities = backend?.capabilities;
  const activeProfileId = composer.profileId ?? backend?.profiles.find((entry) => entry.isDefault)?.id ?? backend?.profiles[0]?.id;
  const slash = useSlashCatalog(quickChat || backend?.available === false ? undefined : backendId, { ...(project?.id ? { projectId: project.id } : { scope: 'global' as const }), ...(activeProfileId ? { profileId: activeProfileId } : {}) });
  // Only the phone's home lists recent conversations; a desktop has them in the sidebar.
  const recent = useMemo(() => mobile ? sortSessionsByActivity(sessions.filter((session) => !session.archivedAt && !session.agentMemberId)).slice(0, 5) : [], [mobile, sessions]);
  const runnerOpen = useRunnerOpen();
  const [composerFullscreen, setComposerFullscreen] = useState(false);
  const behind = composerFullscreen || undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="contents" inert={behind} aria-hidden={behind}>{header}</div>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto flex w-full max-w-[720px] flex-col px-4 pb-6 pt-6 md:px-8 md:pb-16 md:pt-[max(48px,14vh)]">
          <div className="mb-4 flex flex-col items-center gap-2 text-center md:mb-6" inert={behind} aria-hidden={behind}>
            {composer.member && (!isDefaultMember(composer.member) || composer.member.avatar)
              ? <MemberAvatar member={composer.member} size={mobile ? 56 : 64} className="mb-1 ring-1 ring-line md:mb-2" />
              : <LiveBrandMark className="mb-1 size-12 text-fg md:mb-2 md:size-16" />}
            {/* Reserve the heading's own line height so switching 新建任务 / 快速对话 never shifts the composer. */}
            <div className="flex min-h-(--text-xl--line-height) w-full items-center justify-center gap-2 md:min-h-(--text-2xl--line-height)">
              {composer.member
                ? <h1 className="max-w-full truncate text-xl font-semibold tracking-tight text-fg md:text-2xl">{composer.member.name}</h1>
                : !quickChat && project && !isAssistantProject(project) && <h1 className="max-w-full truncate text-xl font-semibold tracking-tight text-fg md:text-2xl">{t`要在 ${project.name} 做什么？`}</h1>}
            </div>
            {composer.member?.scope.kind === 'project' && project && (
              <p className="text-xs text-fg-3">{project.name}</p>
            )}
          </div>

          <NewSessionComposer {...composer} onCreateWorktree={noRepository ? undefined : composer.onCreateWorktree} fullscreen={composerFullscreen} onFullscreenChange={setComposerFullscreen} />

          <div key={quickChat ? 'chat' : composer.member ? `member:${composer.member.id}` : project?.id ?? 'projectless'} className="animate-in fade-in-0 duration-[var(--duration-base)]" inert={behind} aria-hidden={behind}>
            {quickChat && project ? (
              <>
                {composer.modelChatConfig && composer.onUpdateModelChatConfig && (
                  <ModelChatStartBar
                    config={composer.modelChatConfig}
                    onUpdate={composer.onUpdateModelChatConfig}
                    onOpenPanel={composer.onOpenModelChatPanel}
                  />
                )}
                {mobile && <QuickChatHistory project={project} sessions={sessions} onSelectSession={onSelectSession} onSessionAction={onSessionAction} />}
              </>
            ) : <>
              {project && (composer.member || isAssistantProject(project)) && (
                <>
                  <AssistantSetup projectId={project.id} backendId={backendId} profileId={composer.profileId} member={composer.member} onOpenConfig={composer.onOpenMemberConfig} />
                  {composer.member && <MemberSessionsList member={composer.member} sessions={sessions} onSelectSession={onSelectSession} />}
                </>
              )}
              {project && !composer.member && !isAssistantProject(project) && <><details open={!mobile} className="group/tools mt-4 md:mt-8"><summary className="flex cursor-pointer list-none select-none items-center gap-1.5 py-3 text-sm text-fg-3 md:hidden [&::-webkit-details-marker]:hidden"><IconChevronRight className="size-3.5 shrink-0 text-fg-4 transition-transform duration-[var(--duration-base)] ease-[var(--ease-standard)] group-open/tools:rotate-90" /><Trans>CLI 与终端工具</Trans></summary><div className="grid gap-2 sm:grid-cols-3">
                <QuickAction icon={<IconTerminal />} title={t`Shell 终端`} onClick={onOpenShell} />
                <QuickAction icon={<IconColumns2 />} title={t`并行尝试`} note={t`各自在独立 Worktree`} disabled={busy || Boolean(project.system)} onClick={() => setAttemptsOpen(true)} />
                <QuickAction icon={<IconHistory />} title={t`继续终端会话`} disabled={Boolean(project.system)} onClick={() => ui.openImportSession(project.id)} />
              </div></details>
              <AttemptsDialog open={attemptsOpen && !project.system} onOpenChange={setAttemptsOpen} projectId={project.id} directory={noRepository} backends={backends} backendId={backendId} onStarted={onAttemptsStarted} onError={onError}
                references={references} onReferencesChange={onReferencesChange}
                commands={slash.catalog?.items ?? capabilities?.slashCommands ?? []}
                inlineSkills={slash.catalog?.inlineSkills ?? capabilities?.inlineSkills}
                onSlashMenuOpen={slash.refresh}
                enterBehavior={settings.composerEnterBehavior} />

              <AttemptsHistory projectId={project.id} onOpenGroup={onOpenAttemptGroup} /></>}

              {recent.length > 0 && !composer.member && !isAssistantProject(project) && (
                <section className="mt-6 md:mt-10">
                  <h2 className="mb-1 px-2 text-xs font-medium text-fg-3"><Trans>最近会话</Trans></h2>
                  <div className="flex flex-col">
                    {recent.map((session) => (
                      <button key={session.id} type="button" onClick={() => onSelectSession(session)} className="group/recent flex h-10 items-center gap-3 rounded-lg px-2 text-left text-sm hover:bg-hover">
                        {session.kind === 'native' ? <IconSquareTerminal className="size-4 shrink-0 text-fg-4" /> : <StatusDot className="mx-[5px]" tone={session.state === 'running' ? 'accent' : session.state === 'waiting' ? 'warning' : 'idle'} />}
                        <span className="min-w-0 flex-1 truncate text-fg">{session.title}</span>
                        <span className="shrink-0 text-xs text-fg-3">{label(sessionBackend(session))}</span>
                        <span className="shrink-0 text-xs text-fg-3">{relativeTime(sessionActivityAt(session))}</span>
                        <IconChevronRight className="size-4 shrink-0 text-fg-4 opacity-0 transition-opacity group-hover/recent:opacity-100" />
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </>}
          </div>
        </div>
      </div>
      {/* 黑马跑酷 from the palette: under the page, so the mark, heading and composer keep their place. */}
      <div data-runner-bottom className="mx-auto w-full max-w-[720px] shrink-0 px-4 md:px-8">
        {runnerOpen && <RunnerGame height={150} onClose={closeRunner} className="mb-4" />}
      </div>
    </div>
  );
}

export function NoProjects({ onAddProject, header }: { onAddProject: () => void; header: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 pb-24 text-center">
        <div className="grid size-12 place-items-center rounded-2xl bg-subtle text-fg-2"><IconFolderPlus className="size-5" /></div>
        <div className="flex max-w-sm flex-col gap-1.5">
          <h1 className="text-xl font-semibold text-fg"><Trans>添加第一个项目</Trans></h1>
          <p className="text-sm text-fg-3"><Trans>选择运行服务器的电脑上的代码目录，所选 Agent 会在其中读写文件、执行命令。</Trans></p>
        </div>
        <Button variant="primary" size="lg" onClick={onAddProject}><IconFolderPlus /><Trans>添加项目</Trans></Button>
      </div>
    </div>
  );
}

function ModelChatStartBar({
  config,
  onUpdate,
  onOpenPanel,
}: {
  config: ModelChatConfig;
  onUpdate: (patch: ModelChatConfigPatch) => Promise<void> | void;
  onOpenPanel?: (tab: 'params' | 'context') => void;
}) {
  const isRaw = config.bareMode;
  const isStateless = config.contextStrategy === 'stateless';
  const isJson = config.responseFormat.type !== 'text';
  const isDeterministic = config.effort === 'off' && config.temperature === 0;

  const pillClass = (active: boolean) => cn(active && 'bg-accent-soft text-fg hover:bg-accent-soft');

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 px-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="secondary"
          size="xs"
          aria-pressed={isRaw}
          className={pillClass(isRaw)}
          onClick={() => void onUpdate({ bareMode: !isRaw })}
        >
          Raw
        </Button>
        <Button
          variant="secondary"
          size="xs"
          aria-pressed={isStateless}
          className={pillClass(isStateless)}
          onClick={() => void onUpdate({ contextStrategy: isStateless ? 'summary' : 'stateless' })}
        >
          Stateless
        </Button>
        <Button
          variant="secondary"
          size="xs"
          aria-pressed={isJson}
          className={pillClass(isJson)}
          onClick={() => void onUpdate({ responseFormat: isJson ? { type: 'text' } : { type: 'json_object' } })}
        >
          JSON
        </Button>
        <Button
          variant="secondary"
          size="xs"
          aria-pressed={isDeterministic}
          className={pillClass(isDeterministic)}
          onClick={() => void onUpdate(
            isDeterministic
              ? { effort: MODEL_CHAT_DEFAULT_CONFIG.effort, temperature: undefined }
              : { effort: 'off', temperature: 0 },
          )}
        >
          T=0
        </Button>
      </div>

      {onOpenPanel && (
        <Button
          variant="quiet"
          size="xs"
          onClick={() => onOpenPanel('params')}
        >
          <IconSettings2 aria-hidden className="size-3.5" />
          <Trans>参数与上下文</Trans>
        </Button>
      )}
    </div>
  );
}
