import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconChevronRight, IconColumns2, IconFolderClosed, IconFolderPlus, IconHistory, IconSquareTerminal, IconTerminal } from '@/components/icons';
import type { AppSettings, Attachment, AttemptGroup, ModelInfo, NativeBackendCatalogEntry, NativeBackendId, NativeBackendProfile, Session, ToolGroupId } from '@contracts';
import { Button } from '@/components/ui/button';
import { LiveBrandMark } from '@/components/BrandMark';
import { Spinner, StatusDot } from '@/components/ui/controls';
import { FeedbackNotices, type FeedbackMessage } from '@/components/ui/feedback-notice';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { api, type NativeSessionCreateInput, type ProjectRecord, type PromptContextReference } from '@/lib/api';
import { catalogEntry, catalogParams, catalogSelection, parseSelection } from '@/lib/models';
import { agentMarkStyle, backendSelection, launchSelection, sessionBackend, useBackendLabel } from '@/lib/backends';
import { LEGACY_DEFAULT_BACKEND_ID } from '@/lib/legacy-identity';
import { cleanLabel, cn, relativeTime } from '@/lib/utils';
import { sessionActivityAt, sortSessionsByActivity } from '@/lib/session-order';
import { ApprovalPicker, ApprovalSummary } from './session/ApprovalPicker';
import { ToolsPicker, lastToolGroups, offersExtensionToggles, offersRiffetTools, phoneGroup, rememberToolGroups, useControllablePhones, useExtensionsOffered, usePluginToolGroups } from './session/ToolsPicker';
import { AgentLogo } from '@/components/AgentLogo';
import { BackendPicker } from './session/BackendPicker';
import { useAgentModels } from './session/agentModels';
import { DirectoryMenu } from './session/DirectoryMenu';
import { AttemptsDialog, AttemptsHistory } from './session/Attempts';
import { Composer, type ComposerProps } from './session/Composer';
import type { ModelProviderChoices } from './session/ModelPicker';
import type { Choice } from './session/model';
import { useSlashCatalog } from './session/useSlashCatalog';
import { useLingering, WAIT_GRACE_MS } from './session/sessionLayout';
import { useGitStatus } from './state/gitStatusStore';
import { useStores } from './state/stores';
import { QuickChatHistory } from './QuickChatHistory';
import type { SessionAction } from './Sidebar';

export interface ProfileCatalog { profile: NativeBackendProfile; models: ModelInfo[] }

/**
 * A model choice has to name its provider too, and two providers may well offer the same model id.
 * NUL cannot occur in either id, so it joins them without needing an escape.
 */
const CHOICE_SEPARATOR = '\u0000';
const composeChoice = (profileId: string, model: string) => `${profileId}${CHOICE_SEPARATOR}${model}`;

/** The picker's own list: online phones only, nothing remembered kept in it. */
const NO_TOOL_GROUPS: ToolGroupId[] = [];
const NO_EXTENSIONS_OFF: string[] = [];

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
  referenceProjectId?: string;
  recentModel?: string;
  /** Every project, so the composer can offer the others as new-session directories. */
  directories: ProjectRecord[];
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
  /** Re-reads the catalog(s) as the model list opens, without disturbing the current selection. */
  onRefreshCatalog?: () => Promise<void> | void;
  busy: boolean;
  references: PromptContextReference[];
  sessionReferences?: boolean;
  referenceSessions?: Session[];
  onOpenReferenceSession?: (id: string) => void;
  onReferencesChange: (references: PromptContextReference[]) => void;
  onCreate: (input: { projectId?: string; projectless?: boolean; prompt: string; attachments: Attachment[]; context: PromptContextReference[]; mode: string; model?: string; approval?: string; toolGroups?: ToolGroupId[]; extensionsOff?: string[]; backendId?: NativeBackendId; backendProfileId?: string | null }) => Promise<boolean>;
  onError: (message: string) => void;
  /** Called when the user picks a model here, so the choice can be remembered globally. */
  onRememberModel?: (model: string) => void;
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

function QuickAction({ icon, title, note, onClick, disabled }: { icon: ReactNode; title: string; note?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="group/action flex min-w-0 items-center gap-3 rounded-xl border border-line bg-elevated px-3.5 py-3 text-left transition-[border-color,background-color] hover:border-line-strong hover:bg-subtle disabled:opacity-50">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-fg-2 [&_svg]:size-4">{icon}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-fg">{title}</span>
        {note && <span className="truncate text-xs text-fg-3">{note}</span>}
      </span>
    </button>
  );
}

/**
 * The directory, agent, model and first message of a new conversation: the project page's hero.
 */
export function NewSessionComposer({ project, referenceProjectId, recentModel, directories, onSelectProject, onSelectNoProject, onCreationPersisted, creationRestore, pendingCreations, onRecoverCreation, onChooseDirectory, onOpenDirectory, onCreateWorktree, isolating, settings, backends, backendId, profileId, backend, profileCatalogs, onBackendChange, onProfileChange, catalog, catalogLoading, catalogError, onRetryCatalog, onRefreshCatalog, busy, references, sessionReferences, referenceSessions, onOpenReferenceSession, onReferencesChange, onCreate, onError, onRememberModel }: NewSessionComposerProps) {
  const { t } = useLingui();
  const quickChat = backendId === 'chat';
  const label = useBackendLabel();
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const capabilities = backend?.capabilities;
  const savedDefaults = settings.nativeBackendDefaults?.[backendId];
  const defaultProfileId = backend?.profiles.find((entry) => entry.isDefault)?.id;
  const defaults = (profileId ?? defaultProfileId) === (savedDefaults?.profileId ?? defaultProfileId) ? savedDefaults : undefined;
  // New sessions always start in agent mode. Plan and ask remain reachable from the session's own
  // mode picker, where the conversation they apply to is already on screen.
  const mode = capabilities?.modes.find((option) => option.id === 'agent')?.id ?? capabilities?.modes[0]?.id ?? 'agent';
  const preferredChat = settings.auxiliaryModels?.chat;
  const preferredChatModel = preferredChat ? `${preferredChat.backendId}:${preferredChat.profileId}:${preferredChat.model}` : '';
  const lastChat = parseSelection(recentModel);
  const chatModel = catalogEntry(catalog, preferredChatModel)?.value ?? catalogEntry(catalog, lastChat.model)?.value ?? catalog[0]?.value;
  // A configured chat model still inherits its latest effort/Fast choices; a different model gets its own defaults.
  const chatSelection = chatModel ? catalogSelection(catalog, chatModel, chatModel === lastChat.model ? lastChat.params : {}) : recentModel || preferredChatModel;
  const defaultModel = (quickChat ? chatSelection : defaults?.model || recentModel || (backendId === LEGACY_DEFAULT_BACKEND_ID && (!profileId || profileId === 'default') ? settings.defaultModel : undefined)) || backend?.defaultModel || '';
  const defaultApproval = capabilities?.permissions.find((option) => option.id === defaults?.approval)?.id ?? capabilities?.permissions[0]?.id ?? '';
  const [approval, setApproval] = useState(defaultApproval);
  const approvalBaseline = useRef(defaultApproval);
  // Starts from the last pick on this browser; the server drops a phone that has since gone.
  const [toolGroups, setToolGroups] = useState<ToolGroupId[]>(lastToolGroups);
  const changeToolGroups = useCallback((next: ToolGroupId[]) => { setToolGroups(next); rememberToolGroups(next); }, []);
  const { phones } = useControllablePhones(NO_TOOL_GROUPS);
  const pluginTools = usePluginToolGroups(NO_TOOL_GROUPS);
  // A remembered phone that is offline now (or a plugin that is off) is left out of this conversation and kept for the next.
  const pickedToolGroups = toolGroups.filter((id) => phones.some((device) => phoneGroup(device.id) === id) || pluginTools.available.includes(id));
  const toolsOffered = !quickChat && offersRiffetTools(capabilities) && (phones.length > 0 || pluginTools.available.length > 0);
  const [selection, setSelection] = useState(defaultModel);
  const [selectionEdited, setSelectionEdited] = useState(false);
  /*
   * The composer survives tab/provider switches. Each target keeps its own model and approval;
   * returning to it restores explicit picks while untouched controls follow their saved defaults.
   */
  const choiceScope = `${backendId}${CHOICE_SEPARATOR}${profileId ?? ''}`;
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
  const [hasDraft, setHasDraft] = useState(false);
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
    ? grouped.flatMap(({ profile, models: list }) => list.map((item) => ({ id: composeChoice(profile.id, item.value), label: cleanLabel(item.name), group: profile.name })))
    : catalog.map((item) => ({ id: item.value, label: cleanLabel(item.name) })), [grouped, catalog]);
  // The provider column, in configured order, with each provider's models as its read lands.
  // A missing entry is loading rather than empty, so previously loaded providers do not jump.
  const providerChoices = useMemo<ModelProviderChoices[] | undefined>(() => {
    if (!grouped || !backend?.profiles.length) return undefined;
    return backend.profiles.map((profile) => {
      const entry = grouped.find((item) => item.profile.id === profile.id);
      return {
        id: profile.id,
        label: profile.name,
        models: entry ? entry.models.map((item) => ({ id: composeChoice(profile.id, item.value), label: cleanLabel(item.name) })) : [],
        loading: !entry,
      };
    });
  }, [grouped, backend]);
  // The grouped list prefixes each id with its provider; usage is read for the active one only.
  const loadModelUsage = useCallback((signal: AbortSignal) => api.backendUsage(backendId, { ...(project?.id ? { projectId: project.id } : { scope: 'global' as const }), ...(activeProfileId ? { profileId: activeProfileId } : {}) }, signal)
    .then((usage) => grouped && activeProfileId
      ? { ...usage, models: Object.fromEntries(Object.entries(usage.models).map(([id, status]) => [composeChoice(activeProfileId, id), status])) }
      : usage), [backendId, project?.id, activeProfileId, grouped]);
  const slash = useSlashCatalog(quickChat || backend?.available === false ? undefined : backendId, { ...(project?.id ? { projectId: project.id } : { scope: 'global' as const }), ...(activeProfileId ? { profileId: activeProfileId } : {}) });
  const selected = backendSelection(backendId, activeCatalog, selection);
  const effectiveSelection = launchSelection(activeCatalog, selected);
  const selectionNeedsCatalog = Boolean(selection) && (catalogLoading || Boolean(catalogError) || activeCatalog.length === 0);
  const backendIssue = backend?.available === false ? backend.reason?.trim() || t`${label(backendId)} 不可用` : '';
  // Availability failures also reach catalogError; the backend's row says that cause once, and
  // anything else about the catalog is said, with its retry, on the model picker.
  const catalogIssue = catalogError.trim();
  const modelsError = catalogIssue !== backendIssue ? catalogIssue : '';
  /*
   * On a pointer device the model menu also picks the agent: its column lists every agent (with
   * its providers), and picking a model saves agent, provider and model in one write. Other agents'
   * lists paint from the cache and are read when the reader looks at them.
   */
  const agentModels = useAgentModels(project?.id ?? '');
  // Decided by layout alone: the agent list arrives after the first frames, and a choice that
  // waited for it would draw the separate agent button first and then swap it out.
  const agentChoices = !quickChat && !mobile;
  const agentOf = (id: NativeBackendId) => ({ id, label: label(id), icon: <AgentLogo backend={id} size={14} style={agentMarkStyle(id)} /> });
  /** The active agent's row while its providers are not grouped: the same id it has while another agent is active, so the column keeps its place when it becomes the active one. */
  const listedProfiles = backends.find((entry) => entry.backendId === backendId)?.profiles ?? [];
  const activeSourceId = otherSource(backendId, listedProfiles.length ? activeProfileId ?? listedProfiles[0]?.id : undefined);
  // While every provider's models are listed together, the active provider's row holds only its own.
  const activeModels = grouped && activeProfileId ? models.filter((item) => item.id.startsWith(`${activeProfileId}${CHOICE_SEPARATOR}`)) : models;
  const agentSources: ModelProviderChoices[] | undefined = agentChoices ? backends.filter((entry) => entry.backendId !== 'chat').flatMap((entry) => {
    const agent = agentOf(entry.backendId);
    if (entry.backendId === backendId && providerChoices) return providerChoices.map((provider) => ({ ...provider, agent }));
    const profiles: Array<NativeBackendProfile | undefined> = entry.profiles.length ? entry.profiles : [undefined];
    const saved = settings.nativeBackendDefaults?.[entry.backendId]?.profileId ?? entry.profiles.find((profile) => profile.isDefault)?.id;
    return profiles.map((profile): ModelProviderChoices => {
      const id = otherSource(entry.backendId, profile?.id);
      const label = profile?.name ?? agent.label;
      // The provider in force lists the composer's own catalog; the others, while it has several
      // that have not all been read, are listed like another agent's and fill in as they answer.
      if (id === activeSourceId) return { id, label, agent, models: activeModels, loading: catalogLoading && !models.length, ...(!models.length && (backendIssue || modelsError) ? { issue: backendIssue || modelsError } : {}) };
      const list = agentModels.read(entry.backendId, profile?.id);
      const issue = entry.available === false ? entry.reason?.trim() || t`${agent.label} 不可用` : list?.length ? undefined : agentModels.issue(entry.backendId, profile?.id);
      const loading = !list?.length && agentModels.loading(entry.backendId, profile?.id);
      // An agent that lists nothing still starts on its own default model, as picking it alone used to.
      const fallback = entry.available !== false && !loading && !list?.length && (list || issue);
      return {
        id,
        label,
        agent,
        preferred: profile?.id === saved,
        models: fallback
          ? [{ id: otherChoice(entry.backendId, profile?.id, ''), label: t`默认模型` }]
          : (list ?? []).map((item) => ({ id: otherChoice(entry.backendId, profile?.id, item.value), label: cleanLabel(item.name) })),
        loading,
        ...(issue ? { issue } : {}),
      };
    });
  }) : undefined;
  /** As the menu opens, reads the other agents nothing is known about yet; the rest are read on preview. */
  const loadUnknownAgents = () => {
    for (const source of agentSources ?? []) {
      const other = splitOther(`${source.id}${OTHER_AGENT}`);
      const entry = other && backends.find((item) => item.backendId === other.backendId);
      if (other && source.id !== activeSourceId && entry?.available !== false && !source.models.length) agentModels.load(other.backendId, other.profileId);
    }
  };

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
    if (!selectionEdited) setSelection(defaultModel);
  }, [defaultModel, selectionEdited]);
  useEffect(() => {
    const previous = approvalBaseline.current;
    approvalBaseline.current = defaultApproval;
    setApproval((current) => previous !== defaultApproval || !capabilities?.permissions.some((option) => option.id === current) ? defaultApproval : current);
  }, [capabilities, defaultApproval]);

  useEffect(() => {
    if (quickChat || !project || !capabilities?.supportsPrewarm || !(hasDraft || references.length > 0)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api.nativePrewarm({
        projectId: project.id, backendId, backendProfileId: profileId,
        ...(effectiveSelection ? { model: effectiveSelection } : {}),
        mode,
        approval,
      }, controller.signal).catch(() => undefined);
    }, 700);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [approval, effectiveSelection, hasDraft, mode, project?.id, references.length, backendId, profileId, capabilities?.supportsPrewarm, quickChat]);

  const creationNotices: FeedbackMessage[] = [];
  if (backendIssue) creationNotices.push({ id: `backend:${backendIssue}`, text: backendIssue, tone: 'danger' });
  if (selectionHeld) creationNotices.push({ id: 'selection', text: t`模型选择已保留，目录恢复前暂不能发送。`, tone: 'neutral' });

  return (
    <div className="relative flex flex-col">
      {/* The session's working directory is the one choice that cannot be changed afterwards, so
          it is offered right where the request is written — and only here, so that clicking
          "new session" in the sidebar stays a plain navigation step. */}
      <div className="mb-1.5 flex h-7 items-center gap-1">
        {!quickChat && <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" title={project?.cwd} className="flex h-7 max-w-full items-center gap-1.5 rounded-lg px-2 text-xs text-fg-2 transition-colors outline-none hover:bg-hover hover:text-fg data-[state=open]:bg-active data-[state=open]:text-fg focus-visible:ring-2 focus-visible:ring-focus">
              <IconFolderClosed className="size-3.5 shrink-0 text-fg-3" />
              <span className="min-w-0 truncate font-medium">{project?.system === 'task-workspace' || !project ? t`未关联项目` : project.name}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[min(22rem,calc(100vw-1.5rem))]">
            <DirectoryMenu
              directories={directories}
              selectedProjectId={project?.system === 'task-workspace' ? '' : project?.id ?? ''}
              onSelectNoProject={onSelectNoProject}
              onSelectProject={onSelectProject}
              {...(onChooseDirectory ? { onChooseDirectory } : {})}
              {...(onOpenDirectory ? { onOpenDirectory } : {})}
              onCreateWorktree={onCreateWorktree}
              isolating={isolating}
            />
          </DropdownMenuContent>
        </DropdownMenu>}
      </div>

      <Composer
        variant="hero"
        autoFocus
        projectId={project?.id ?? ''}
        referenceProjectId={referenceProjectId}
        referencesEnabled={!quickChat}
        // One composer and one draft across task/chat tabs; only task references are project-bound.
        draftKey="new:home"
        enterBehavior={settings.composerEnterBehavior}
        placeholder={quickChat ? t`输入消息…` : t`描述任务…`}
        commands={(!quickChat ? slash.catalog?.items : undefined) ?? capabilities?.slashCommands ?? []}
        inlineSkills={!quickChat && (slash.catalog?.inlineSkills ?? capabilities?.inlineSkills)}
        onSlashMenuOpen={quickChat ? undefined : slash.refresh}
        fileMentions={!quickChat && Boolean(project)}
        sessionMentions={!quickChat && sessionReferences && capabilities?.supportsSessionReferences === true}
        referenceSessions={referenceSessions}
        referenceProjects={directories}
        onOpenReferenceSession={onOpenReferenceSession}
        disabled={busy}
        submitDisabled={catalogLoading || selectionNeedsCatalog || backend?.available === false || (quickChat && !model)}
        // An empty list's picker is its own retry and holds itself while that runs, keeping focus.
        pickersDisabled={catalogWaited && models.length > 0}
        modelsLoading={catalogLoading}
        modelsError={modelsError}
        onRetryModels={onRetryCatalog}
        toolbar={!quickChat && capabilities?.permissions.length ? (
          <ApprovalPicker
            side="bottom"
            value={approval}
            options={capabilities.permissions}
            onChange={setApproval}
            compact={!mobile}
            disabled={busy || !capabilities.supportsPermissionSelection}
          />
        ) : undefined}
        toolsPicker={toolsOffered || extensionsOffered ? <ToolsPicker value={pickedToolGroups} onChange={changeToolGroups} extensions={extensionPick} disabled={busy} onError={onError} /> : undefined}
        mobileSettingsPrefix={quickChat || !capabilities?.permissions.length ? undefined : <ApprovalSummary mode={approval} options={capabilities.permissions} />}
        mobileSettingsLabel={[!quickChat && label(backendId), models.find((item) => item.id === modelChoice)?.label].filter(Boolean).join(' · ')}
        // The model menu picks the agent too where it has a column for them; a phone keeps its own row.
        startPickers={quickChat || agentSources ? undefined : <BackendPicker backends={backends} backendId={backendId} onChange={onBackendChange} disabled={busy} fullWidth={mobile} />}
        startPickersLabel={quickChat ? undefined : label(backendId)}
        models={models}
        providers={agentSources ?? providerChoices}
        // Named the way the rows are: by profile while the providers come grouped, else by the column's own ids.
        activeProviderId={providerChoices ? activeProfileId : agentSources ? activeSourceId : undefined}
        modelLeading={agentSources && <><AgentLogo backend={backendId} size={14} className="shrink-0" style={agentMarkStyle(backendId)} /><span className="sr-only">{label(backendId)}</span></>}
        onPreviewModelProvider={(id) => { const other = splitOther(`${id}${OTHER_AGENT}`); if (other && id !== activeSourceId) agentModels.load(other.backendId, other.profileId); }}
        loadModelUsage={loadModelUsage}
        refreshCatalog={quickChat ? onRetryCatalog : () => { loadUnknownAgents(); return onRefreshCatalog?.(); }}
        usageScopeKey={`${backendId}|${project?.id ?? 'global'}|${activeProfileId ?? ''}`}
        model={model ? modelChoice : undefined}
        onModelChange={(id) => {
          const other = splitOther(id);
          if (other) {
            // Another agent's model: the agent, its provider and the model are saved together.
            // An empty model is that agent's default, for one that lists nothing.
            const next = other.model ? catalogSelection(agentModels.read(other.backendId, other.profileId) ?? [], other.model) : '';
            const scope = `${other.backendId}${CHOICE_SEPARATOR}${other.profileId ?? ''}`;
            const previous = choices.current.get(scope);
            if (previous) choices.current.set(scope, { ...previous, selection: next, edited: true });
            onBackendChange(other.backendId, other.profileId, next);
            return;
          }
          const chosen = splitChoice(id);
          const chosenCatalog = (chosen.profileId && grouped?.find((entry) => entry.profile.id === chosen.profileId)?.models) || activeCatalog;
          const next = catalogSelection(chosenCatalog, chosen.model);
          // Picking another provider's model is also how that provider gets selected, and the
          // two have to be saved together or the model would be dropped as a stale override.
          if (chosen.profileId && chosen.profileId !== activeProfileId) {
            const scope = `${backendId}${CHOICE_SEPARATOR}${chosen.profileId}`;
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
          if (!quickChat && !catalogLoading) onRememberModel?.(next);
        }}
        onDraftChange={setHasDraft}
        references={references}
        onReferencesChange={onReferencesChange}
        feedback={pendingCreations?.length ? <div className="flex flex-col gap-2 text-xs text-fg-3" role="status">{pendingCreations.map(body => <div key={body.clientSessionId} className="rounded-lg bg-subtle px-3 py-2">
          <p className="line-clamp-2 break-words text-fg-2">{body.initialMessage.text}</p>
          <div className="mt-1 flex flex-wrap items-center gap-3"><span>{body.rejected ? <Trans>发送失败</Trans> : <Trans>暂时无法确认是否已发送</Trans>}</span>{body.rejected ? <button type="button" disabled={busy} onClick={() => onRecoverCreation?.(body, 'restore')} className="underline underline-offset-2 disabled:opacity-50"><Trans>恢复到输入框</Trans></button> : <><button type="button" disabled={busy} onClick={() => onRecoverCreation?.(body)} className="underline underline-offset-2 disabled:opacity-50"><Trans>检查状态</Trans></button><button type="button" disabled={busy} onClick={() => onRecoverCreation?.(body, true)} className="underline underline-offset-2 disabled:opacity-50"><Trans>重试发送</Trans></button></>}{busy && <Spinner className="size-3" />}</div>
        </div>)}</div> : undefined}
        restoreDraft={creationRestore && creationRestore.projectId === project?.id ? creationRestore.draft : undefined}
        onSubmitPersisted={onCreationPersisted}
        onSubmit={(prompt, attachments, context) => onCreate({ ...(project?.id ? { projectId: project.id } : { projectless: true }), prompt, attachments, context, mode: quickChat ? 'agent' : mode, ...(submitSelection ? { model: submitSelection } : {}), ...(quickChat ? { backendId: 'chat', backendProfileId: null } : { approval }), ...(toolsOffered ? { toolGroups: pickedToolGroups } : {}), ...(extensionPick && extensionsOff.length ? { extensionsOff } : {}) })}
        onError={onError}
      />
      <FeedbackNotices scope={`${project?.id ?? 'global'}:${backendId}:${activeProfileId ?? ''}`} messages={creationNotices}
        className="mt-2" noticeClassName="items-start rounded-lg px-3 py-2 text-xs" icon={null}
        action={message => message.id.startsWith('backend:') ? <Button size="xs" variant="quiet" onClick={onRetryCatalog} disabled={catalogLoading} className="-my-1 shrink-0">{t`重新检测`}</Button> : undefined} />
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
  const recent = useMemo(() => mobile ? sortSessionsByActivity(sessions.filter((session) => !session.archivedAt)).slice(0, 5) : [], [mobile, sessions]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto flex w-full max-w-[720px] flex-col px-4 pb-6 pt-6 md:px-8 md:pb-16 md:pt-[max(48px,14vh)]">
          <div className="mb-4 flex min-h-7 flex-col items-center gap-2 text-center md:mb-6 md:min-h-8">
            <LiveBrandMark className="mb-1 size-12 text-fg md:mb-2 md:size-16" />
            {!quickChat && project && <h1 className="max-w-full truncate text-xl font-semibold tracking-tight text-fg md:text-2xl">{t`要在 ${project.name} 做什么？`}</h1>}
          </div>

          <NewSessionComposer {...composer} onCreateWorktree={noRepository ? undefined : composer.onCreateWorktree} />

          <div key={quickChat ? 'chat' : project?.id ?? 'projectless'} className="animate-in fade-in-0 duration-[var(--duration-base)]">
            {quickChat && project ? <QuickChatHistory project={project} sessions={sessions} onSelectSession={onSelectSession} onSessionAction={onSessionAction} /> : <>
              {project && <><details open={!mobile} className="group/tools mt-4 md:mt-8"><summary className="flex cursor-pointer list-none select-none items-center gap-1.5 py-3 text-sm text-fg-3 md:hidden [&::-webkit-details-marker]:hidden"><IconChevronRight className="size-3.5 shrink-0 text-fg-4 transition-transform duration-[var(--duration-base)] ease-[var(--ease-standard)] group-open/tools:rotate-90" /><Trans>CLI 与终端工具</Trans></summary><div className="grid gap-2 sm:grid-cols-3">
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

              {recent.length > 0 && (
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
