import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { composerRunningIntent } from '../session/composerRunning';
import { useComposerQuotes } from '../session/composerQuotes';
import { IconInfo, IconSquare, IconSquareArrowOutUpRight, IconArrowRightLeft, IconPuzzle, IconBookmarkPlus, IconFileText, IconGitFork, IconMessagesSquare, IconRotateCw, IconSquareTerminal } from '@/components/icons';
import { DEFAULT_AGENT_MEMBER_ID, type Attachment, type AttemptGroup, type Automation, type DiscussionSource, type InboxAction, type ModelInfo, type NativeBackendCapabilities, type NativeBackendCatalogEntry, type NativeBackendProfile, type NativeProfileContinuation, type NativeRuntimeAction, type Run, type Session, type SessionControlSnapshot, type TerminalInfo, type ToolGroupId } from '@contracts';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Spinner, StatusDot, StatusPill } from '@/components/ui/controls';
import { FeedbackNotice, FeedbackNotices, type FeedbackMessage } from '@/components/ui/feedback-notice';
import { Collapse } from '@/components/ui/collapse';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Tip } from '@/components/ui/tooltip';
import { api, HttpError, isSessionReference, restoreContext, type ForkSessionResult, type PromptContextReference } from '@/lib/api';
import { serverOfObject } from '@/lib/server-routing';
import { workbenchAppearanceConnection } from '@/lib/workbench-appearance';
import { confirmDialog } from '@/lib/dialogs';
import { toast } from '@/lib/toast';
import { catalogParams, catalogSelection, parseSelection, pickedSelection } from '@/lib/models';
import { cn, cleanLabel, errorMessage, newId } from '@/lib/utils';
import { HAN } from '@/lib/errors';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { useOverlayState } from '@/lib/overlay-navigation';
import { backendSelection, hasNativeTerminal, launchSelection, sessionBackend, useBackendLabel } from '@/lib/backends';
import { useWakeLock } from '@/lib/wake-lock';
import type { HeaderSlots } from '../Header';
import { ApprovalPicker, ApprovalSummary } from '../session/ApprovalPicker';
import { ToolsPicker, offersExtensionToggles, offersRiffetTools, useControllablePhones, useExtensionsOffered, useLinkableServers, usePluginToolGroups } from '../session/ToolsPicker';
import { Composer, type ComposerProps } from '../session/Composer';
import { TerminalHoldBar } from '../session/TerminalHoldBar';
import type { ComposerSlotProps } from '@riffet/plugin-web';
import { ComposerDock } from '../session/ComposerDock';
import { RunnerDock } from '@/components/runner/RunnerDock';
import { PlanDock } from '../work-items/PlanDock';
import { FollowUpList, scheduleFollowUp, useSessionFollowUps } from '../automations/SendLater';
import { pickerBlockReason } from '../session/pickers';
import { useSessionTranscript } from '../session/useSessionTranscript';
import { modelUsageAliases, timelineItemTime, type Choice, type SlashCommand } from '../session/model';
import { ModelPicker, type ModelProviderChoices } from '../session/ModelPicker';
import { SessionAside } from '../session/SessionAside';
import { MemberRunReportsDock, runIsActive, useMemberBackgroundRuns } from '../session/MemberBackgroundRuns';
import { ASSEMBLY_MS, ContentColumn, useLingering, useSessionLayout } from '../session/sessionLayout';
import { ShareDialog } from '../shares/ShareDialog';
import { SessionWorkActions } from '../session/SessionWorkActions';
import { SessionCalls, SessionDiscussions, SessionMemberRuns } from '../SessionInfo';
import { TabChromeContext } from '../tabs/chrome';
import { SessionMarksSection, SessionMarksContext, useSessionMarks } from '../session/marks';
import { SubagentSession } from '../session/SubagentSession';
import { NativeJobStoreContext, SubagentContext, SubagentStoreContext, useRunningSubagentCount, type SubagentRenderer, type SubagentTarget } from '../session/subagents';
import { BackgroundWorkIndicator, WorkingIndicator, type TurnAction } from '../session/Timeline';
import { ActivityContext, liveBackgroundActivities, useActivityControls } from '../session/Activities';
import { ImageSourceContext, projectImageSource } from '../session/imageSource';
import { conversationFiles, FileAccessContext, resolveFileMention } from '../session/fileAccess';
import { TranscriptView } from '../session/TranscriptView';
import type { TranscriptScrollHandle } from '../session/useTranscriptScroll';
import { connectionNoticeState } from '../session/transcriptLoad';
import { FailureDetails } from '../session/FailureDetails';
import { SideDiscussionPanel as DiscussionPanel } from '../session/SideDiscussion';
import type { MessageFocus } from '../session/focus-message';
import { NativeInteractionCard } from '../session/NativeInteractionCard';
import { useSessionSync } from '../session/useSessionSync';
import { useSlashCatalog } from '../session/useSlashCatalog';
import { HandoffDialog, SaveAutomationDialog } from '../session/SessionHandoff';
import { AttemptStrip } from '../session/Attempts';
import { shareModelName, ShareSessionContext, type ShareSession } from '../marks/ShareImage';
import { MessageCommandsContext } from '../session/messageCommands';
import { useCatalog, useLists, useStores } from '../state/stores';
import { AgentCallsProvider } from '../session/agentCalls';
import type { AgentMentionSource } from '../session/agentMentions';
import type { CallSenderInfo } from '../session/Timeline';
import { ViewDots, useViewShortcut, useViewShortcuts } from '../session/ViewDots';
import { useSessionViews, useViewPrefs, visibleViews } from '../session/viewPrefs';
import type { SessionView } from '../state/navStore';
import type { ViewEntry } from '@/plugins/catalog';
import { localizedText } from '@/lib/plugins';
import { viewIcon } from '@/plugins/viewIcons';
import { PluginView } from '@/plugins/PluginView';

const TerminalView = lazy(() => import('./TerminalView').then((module) => ({ default: module.TerminalView })));

/**
 * Commands that change a setting or the session itself and print nothing worth reading; every other
 * command answers inside the CLI's pane, which is where its result has to be seen.
 *
 * `commit` is deliberately absent: the CLI answers it entirely inside its own TUI, and the command
 * output it prints *is* the result. Listing it here meant sending it produced no visible reaction at all.
 */
const quietCommands = new Set(['compact', 'summarize', 'max-mode', 'fast', 'plan', 'ask', 'goal', 'clear', 'fork', 'rename', 'run-everything', 'auto-review', 'debug', 'vim', 'show-thinking', 'line-numbers', 'status-indicators']);

/**
 * Whether the CLI's answer to a slash command only exists in its own pane. `compact` and
 * `summarize` are quiet: their progress and result arrive as a system activity (context
 * compaction) in the transcript.
 */
export function commandNeedsTerminal(command: string): boolean {
  return !quietCommands.has(command) && !/^(claude|gpt|gemini|grok|composer|kimi|glm|codex|muse|auto)/.test(command);
}

/** The native detail picker uses the same model catalog and parameter controls as new sessions. */
const NO_TOOL_GROUPS: ToolGroupId[] = [];
const NO_EXTENSIONS_OFF: string[] = [];

/**
 * A per-conversation pick saved with the session and applied at the next launch. It shows at once and the
 * next toggle builds on it; only the latest request's answer is kept.
 */
function useSessionPick<K extends 'toolGroups' | 'extensionsOff'>(
  session: Session,
  key: K,
  none: NonNullable<Session[K]>,
  onSessionChanged: (session: Session) => void,
  onError: (message: string) => void,
): [NonNullable<Session[K]>, (next: NonNullable<Session[K]>) => void] {
  const { t } = useLingui();
  const [pending, setPending] = useState<{ sessionId: string; value: NonNullable<Session[K]> }>();
  const latest = useRef(0);
  const change = useCallback((next: NonNullable<Session[K]>) => {
    const request = ++latest.current;
    setPending({ sessionId: session.id, value: next });
    void api.updateSession(session.id, { [key]: next })
      .then((updated) => { if (request === latest.current) { onSessionChanged(updated); setPending(undefined); } })
      .catch((error) => {
        if (request === latest.current) setPending(undefined);
        onError(errorMessage(error, t`无法更新技能与工具`));
      });
  }, [session.id, key, onSessionChanged, onError, t]);
  return [(pending?.sessionId === session.id ? pending.value : undefined) ?? session[key] ?? none, change];
}

/**
 * A model choice of another provider names that provider too; two providers may offer the same id.
 * NUL cannot occur in either id, so it joins them without an escape (as on the new-session composer).
 */
const CHOICE_SEPARATOR = '\u0000';
const composeChoice = (profileId: string, model: string) => `${profileId}${CHOICE_SEPARATOR}${model}`;
function splitChoice(id: string): { profileId?: string; model: string } {
  const at = id.indexOf(CHOICE_SEPARATOR);
  return at < 0 ? { model: id } : { profileId: id.slice(0, at), model: id.slice(at + 1) };
}

function NativeModelPicker({ session, catalog, continuations, profiles, providerLabel, loading, refreshing, catalogError, disabled, blockedReason, onError, onSessionChanged, onSwitchingChange, onRememberModel, refreshCatalog }: {
  session: Session;
  catalog: ModelInfo[];
  /** Providers the conversation can move to in place; their models join the list under their name. */
  continuations?: NativeProfileContinuation[];
  /** The backend's providers in configured order, so the provider column keeps the settings' order. */
  profiles: NativeBackendProfile[];
  providerLabel?: string;
  loading: boolean;
  /** A catalog read is in flight, also one behind a list already shown. */
  refreshing: boolean;
  catalogError: string;
  disabled: boolean;
  /** Why the control is unavailable, carried as a native tooltip: a disabled button fires no hover. */
  blockedReason?: string;
  onError: (message: string) => void;
  onSessionChanged: (session: Session) => void;
  onSwitchingChange: (switching: boolean) => void;
  onRememberModel?: (model: string) => void;
  refreshCatalog?: () => void;
}) {
  const { t } = useLingui();
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const [picked, setPicked] = useState<string>();
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const sessionId = session.id;

  // A local pick bridges the session refresh; offline sessions can store it for the next open.
  useEffect(() => { setPicked(undefined); }, [session.model]);

  const profileId = session.backendProfileId;
  const grouped = Boolean(profileId && continuations?.length);
  const currentModels: Choice[] = useMemo(() => catalog.map((item) => ({ id: grouped ? composeChoice(profileId!, item.value) : item.value, label: cleanLabel(item.name), aliases: modelUsageAliases(item), ...(grouped && providerLabel ? { group: providerLabel } : {}) })), [catalog, grouped, profileId, providerLabel]);
  // The current provider first in the settings' order with the others, each with its own models.
  const providers = useMemo<ModelProviderChoices[] | undefined>(() => {
    if (!grouped) return undefined;
    const entries: ModelProviderChoices[] = [{ id: profileId!, label: providerLabel ?? profileId!, models: currentModels }];
    for (const item of continuations!) entries.push({ id: item.profile.id, label: item.profile.name, models: item.models.map((model) => ({ id: composeChoice(item.profile.id, model.value), label: cleanLabel(model.name), aliases: modelUsageAliases(model), group: item.profile.name })) });
    const order = new Map(profiles.map((profile, index) => [profile.id, index]));
    return entries.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }, [grouped, profileId, providerLabel, currentModels, continuations, profiles]);
  const models: Choice[] = useMemo(() => providers ? providers.flatMap((provider) => provider.models) : currentModels, [providers, currentModels]);
  const backendId = sessionBackend(session);
  const selectionFromNativeCatalog = backendSelection(backendId, catalog, session.model);
  const correctedSelection = launchSelection(catalog, selectionFromNativeCatalog);
  const selectionValue = picked ?? correctedSelection;
  const selection = parseSelection(selectionValue);
  const model = currentModels.some((item) => item.id === (grouped ? composeChoice(profileId!, selection.model) : selection.model)) ? selection.model : undefined;
  const params = useMemo(() => catalogParams(catalog, model ?? '', selection.params), [catalog, model, selectionValue]);

  const apply = (value: string) => {
    if (!value) return;
    setPicked(value);
    onSwitchingChange(true);
    void api.nativeSetModel(sessionId, value)
      .then((updated) => { onSessionChanged(updated); onRememberModel?.(updated.model ?? value); })
      .catch((error) => { setPicked(undefined); errorRef.current(errorMessage(error, t`无法切换模型`)); })
      .finally(() => { onSwitchingChange(false); });
  };

  const switchProfile = (target: NativeProfileContinuation, value: string) => {
    onSwitchingChange(true);
    void api.nativeSwitchProfile(sessionId, target.profile.id, value)
      .then(onSessionChanged)
      .catch((error) => { errorRef.current(errorMessage(error, t`无法切换模型`)); })
      .finally(() => { onSwitchingChange(false); });
  };

  const choose = (id: string) => {
    const chosen = splitChoice(id);
    const target = chosen.profileId && chosen.profileId !== profileId ? continuations?.find((item) => item.profile.id === chosen.profileId) : undefined;
    // Effort, Fast and the context window carry over to the new model wherever it accepts them.
    if (target) switchProfile(target, pickedSelection(target.models, chosen.model, selection.params));
    else apply(pickedSelection(catalog, chosen.model, selection.params));
  };

  return (
    <div className="flex min-w-0 items-end" title={disabled ? blockedReason : undefined}>
      <ModelPicker
        inlineParams={mobile}
        side="top"
        models={models}
        {...(providers ? { providers, activeProviderId: profileId } : { providerLabel })}
        {...(model ? { value: grouped ? composeChoice(profileId!, model) : model, params } : {})}
        placeholder={t({ message: '选择模型', context: 'terminal-model-picker-label' })}
        loadUsage={(signal) => api.backendUsage(backendId, { sessionId }, signal)}
        refreshCatalog={refreshCatalog}
        usageScopeKey={JSON.stringify([backendId, sessionId, profileId ?? '', grouped])}
        loading={loading}
        refreshing={refreshing}
        error={catalogError}
        onRetry={refreshCatalog}
        disabled={disabled}
        onChange={choose}
        onParamChange={(id, value) => { if (model) apply(catalogSelection(catalog, model, { ...selection.params, [id]: value }, id)); }}
      />
    </div>
  );
}

interface Props {
  session: Session;
  initialRun?: Run;
  catalog: ModelInfo[];
  continuations?: NativeProfileContinuation[];
  backendCapabilities?: NativeBackendCapabilities;
  catalogLoading: boolean;
  catalogError: string;
  onRetryCatalog: () => void;
  terminal?: TerminalInfo;
  root?: string;
  reopening: boolean;
  sendingInitial?: boolean;
  onReopen: () => void;
  onTerminalChanged: (terminal: TerminalInfo) => void;
  onSessionChanged: (session: Session) => void;
  onRememberModel?: (model: string) => void;
  onError: (message: string) => void;
  notificationsEnabled: boolean;
  sessionReferences?: boolean;
  referenceSessions?: Session[];
  referenceProjects?: import('@/lib/api').ProjectRecord[];
  references: PromptContextReference[];
  onReferencesChange: (references: PromptContextReference[]) => void;
  /** Absent where the conversation's files cannot be previewed: its paths are then plain text. */
  onOpenPath?: ((path: string, line?: number) => void) | undefined;
  onOpenInEditor?: (path: string, line?: number) => void;
  renderHeader: (slots: HeaderSlots) => ReactNode;
  /** A search result asked to see one message in this conversation. */
  focus?: MessageFocus;
  /** Account-level Enter behavior for the composer; see `AppSettings.composerEnterBehavior`. */
  enterBehavior?: string;
  runningBehavior?: string;
  /** `AppSettings.composerSendLater`: shows the clock in the input box. */
  sendLaterEnabled?: boolean;
  /** A conversation this one started (a fork) was created; the workbench opens it. */
  onLaunched?: (result: ForkSessionResult) => void;
  /** The handoff dialog offers every other backend, with why an unavailable one cannot be picked. */
  backends?: NativeBackendCatalogEntry[];
  /** Resolves the conversation a fork or handoff links to, for the line naming it. */
  findSession?: (id: string) => Session | undefined;
  onOpenSession?: (id: string) => void;
  /** An attempt was merged back; a removed worktree archives the project this conversation lives in. */
  onAttemptAdopted?: (result: { originProjectId: string; removedWorktree: boolean }) => void;
  onOpenAttemptGroup?: (group: AttemptGroup) => void;
  /** The view to open in, when it is not the transcript. */
  initialView?: SessionView;
  onViewChange?: (view: SessionView) => void;
  /** A quick chat: presets instead of permissions, no terminal, files, worktree or handoff. */
  quickChat?: boolean;
}

const noCommands: SlashCommand[] = [];
const NO_CAPABILITIES: ReadonlySet<string> = new Set();

/** Inbox actions keyed by the run id the dock renders. An entry id and its command id can name different copies. */
function inboxActionsByRun(control: SessionControlSnapshot | undefined, runs: readonly Run[]): ReadonlyMap<string, readonly InboxAction[]> | undefined {
  if (!control) return undefined;
  const runIdByCommand = new Map<string, string>();
  for (const run of runs) {
    const prior = runIdByCommand.get(run.commandId);
    if (!prior || run.native?.fingerprint !== 'client-pending') runIdByCommand.set(run.commandId, run.id);
  }
  const actions = new Map<string, readonly InboxAction[]>();
  for (const entry of control.inbox) {
    actions.set(entry.id, entry.actions);
    const runId = runIdByCommand.get(entry.commandId);
    if (runId) actions.set(runId, entry.actions);
  }
  return actions;
}

/**
 * Where the view dots last sat, across sessions: each tab mounts its own session, and starting from
 * the previous offset rather than the centre keeps the dots still when switching tabs. Undefined
 * until the first conversation of this page load has settled, so a reload never shows them moving.
 */
let lastDotsShift: number | undefined;

/** How long an uninterpretable attention state must hold before the terminal drawer opens itself. */
const AUTO_OPEN_TERMINAL_DELAY_MS = 700;

/**
 * The session's views (对话, 终端, 画布...) as icons at the head of the header's actions, for a
 * reader who keeps the switch there. The current view is told by its ink alone: one is always
 * selected, so a fill would be a permanent pill.
 */
function ViewSwitch({ views, value, onChange }: { views: ViewEntry[]; value: SessionView; onChange: (view: SessionView) => void }) {
  const { t } = useLingui();
  const viewShortcut = useViewShortcut();
  return (
    <div role="tablist" aria-label={t`会话视图`} className="flex items-center gap-0.5">
      {views.map((view, index) => {
        const Icon = viewIcon(view);
        return (
          <Tip key={view.id} label={view.title} kbd={viewShortcut(index)}>
            <Button size="icon-sm" variant="quiet" role="tab" aria-selected={value === view.id} aria-label={view.title} className={cn('size-7', value === view.id ? 'text-fg' : 'text-fg-4 hover:text-fg-2')} onClick={() => onChange(view.id)}><Icon /></Button>
          </Tip>
        );
      })}
    </div>
  );
}

/** The chat composer's props for the plugin view that draws it in place; absent where the conversation takes no message. */
const ComposerSlotContext = createContext<ComposerProps | null>(null);

/**
 * The conversation's composer as a session view draws it. A module-level component, so its identity
 * never changes and a view that keeps it mounted keeps the caret; what changes reaches it through
 * the context. The draft key is the chat's, so a draft begun in either view is there in the other.
 */
function SessionComposerSlot({ autoFocus, className, onSent }: ComposerSlotProps) {
  const shared = useContext(ComposerSlotContext);
  const sent = useRef(onSent);
  sent.current = onSent;
  const submit = shared?.onSubmit;
  const onSubmit = useCallback<ComposerProps['onSubmit']>(async (text, attachments, context, onStored) => {
    const ok = await submit!(text, attachments, context, onStored);
    if (ok) sent.current?.(text);
    return ok;
  }, [submit]);
  if (!shared) return null;
  return (
    <div className={className}>
      <Composer {...shared} autoFocus={autoFocus ?? false} onSubmit={onSubmit} />
    </div>
  );
}

/**
 * Hybrid native conversation: the real agent CLI runs in tmux, so every command, dialog and
 * subagent behaves exactly as in a terminal, while the transcript is read back from the CLI's
 * chat store and rendered with the shared conversation timeline.
 */
/** Same conversations in the same order, as far as a list of them re-renders. */
const sameIds = (left: readonly Session[], right: readonly Session[]) => left.length === right.length && left.every((item, index) => item === right[index]);

export function NativeSession({ session, initialRun, catalog, continuations, backendCapabilities, catalogLoading, catalogError, onRetryCatalog, terminal, root, reopening, sendingInitial, onReopen, onTerminalChanged, onSessionChanged, onRememberModel, onError, notificationsEnabled, references, sessionReferences, referenceSessions, referenceProjects, onReferencesChange, onOpenPath, onOpenInEditor, renderHeader, focus, enterBehavior, runningBehavior, sendLaterEnabled, onLaunched, backends = [], findSession, onOpenSession, onAttemptAdopted, onOpenAttemptGroup, initialView, onViewChange, quickChat = false }: Props) {
  const { t } = useLingui();
  const mobileViewport = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const tabChrome = useContext(TabChromeContext);
  const recipientAlive = useRef(true);
  useEffect(() => { recipientAlive.current = true; return () => { recipientAlive.current = false; }; }, [session.id]);
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [discussionMounted, setDiscussionMounted] = useState(false);
  const [discussionSource, setDiscussionSource] = useState<DiscussionSource>();
  const [discussionFocus, setDiscussionFocus] = useState<MessageFocus>();
  // A discussion chosen in 会话信息; the panel opens on it.
  const [discussionRequest, setDiscussionRequest] = useState<{ session: Session; nonce: number }>();
  useEffect(() => { if (discussionOpen) setDiscussionMounted(true); }, [discussionOpen]);
  useEffect(() => { setDiscussionFocus(undefined); }, [focus]);
  // The 个人助理's conversation is not work in a project: no side chats, forks, rewinds, hand-offs, view pager
  // or file mentions, which all act on a project's code or open another conversation there (docs/ASSISTANT.md §3).
  const projectSystem = useLists((state) => state.projects.find((project) => project.id === session.projectId)?.system);
  const assistant = projectSystem === 'assistant';
  // Its main conversation, where `/new` and the packs' entries are offered (docs/ASSISTANT.md §5.5, §8.2).
  const assistantMain = useLists((state) => {
    const project = state.projects.find((item) => item.id === session.projectId);
    if (project?.system === 'assistant' && project.mainSessionId === session.id) return true;
    if (!session.agentMemberId) return false;
    const member = state.teamMembers.find((item) => item.id === session.agentMemberId);
    return Boolean(member && member.sessionMode === 'continuous' && member.mainSessionId === session.id);
  });
  const discussionAllowed = session.origin?.kind !== 'discussion' && !assistant;
  const memberRunsOwnerId = session.origin?.kind === 'assistant'
    ? undefined
    : (session.agentMemberId ?? (assistant ? DEFAULT_AGENT_MEMBER_ID : undefined));
  const memberRuns = useMemberBackgroundRuns(memberRunsOwnerId, !quickChat && Boolean(memberRunsOwnerId));
  const activeMemberRuns = memberRuns.some(runIsActive);
  const overview = useViewPrefs((state) => state.side === 'overview');
  const { containerRef: sessionRef, columnRef: sessionColumnRef, layout } = useSessionLayout(!quickChat && !mobileViewport && overview);
  // The view dots sit on the reading column's centre line, which an aside pushes left of the
  // session's own centre. The offset is measured in the transcript and kept while another view
  // shows, so switching views never moves them.
  const [readingColumn, setReadingColumn] = useState<HTMLDivElement | null>(null);
  const readingColumnRef = useCallback((element: HTMLDivElement | null) => { sessionColumnRef(element); setReadingColumn(element); }, [sessionColumnRef]);
  const [dotsShift, setDotsShift] = useState(() => lastDotsShift ?? 0);
  // Hidden until placed: the first time, the dots wait out the conversation's assembly (aside,
  // fonts) and then appear where they belong rather than sliding there.
  const [dotsPlaced, setDotsPlaced] = useState(() => lastDotsShift !== undefined);
  useLayoutEffect(() => {
    const container = readingColumn?.parentElement;
    if (!readingColumn || !container) return;
    // Layout offsets, not client rects: the column slides by transform while the aside settles.
    const measure = () => setDotsShift(Math.round(readingColumn.offsetLeft + readingColumn.offsetWidth / 2 - container.clientWidth / 2));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(readingColumn);
    observer.observe(container);
    const placed = dotsPlaced ? undefined : window.setTimeout(() => setDotsPlaced(true), ASSEMBLY_MS);
    return () => { observer.disconnect(); window.clearTimeout(placed); };
  }, [readingColumn, dotsPlaced]);
  // Only a session that can show the dots speaks for where they sit; a quick chat or a phone has none.
  useEffect(() => { if (dotsPlaced && !quickChat && !mobileViewport) lastDotsShift = dotsShift; }, [dotsPlaced, dotsShift, quickChat, mobileViewport]);
  const [chosenView, setView] = useState<SessionView>(initialView ?? 'chat');
  // A session opened in the terminal or canvas has no column to measure: the centre is its place,
  // and the transcript must not hide them again when the reader turns to it.
  useEffect(() => { if (!dotsPlaced && chosenView !== 'chat') setDotsPlaced(true); }, [dotsPlaced, chosenView]);
  // A phone or a quick chat has no switcher to leave a plugin's view by, so there it is the transcript.
  // On a desktop conversation, a view the reader turned off, or that is not offered now (its plugin
  // is off), is the transcript as well; the choice itself is kept, so the view returns with its plugin.
  const prefs = useViewPrefs((state) => state);
  const offered = useSessionViews({ hasProject: Boolean(session.projectId), hasSession: true, projectSystem, capabilities: NO_CAPABILITIES });
  const hostView = chosenView === 'chat' || chosenView === 'terminal';
  const view = !hostView && (mobileViewport || quickChat || !offered.some((entry) => entry.id === chosenView)) || !mobileViewport && !quickChat && prefs.hidden.includes(chosenView) ? 'chat' : chosenView;
  const native = useSessionSync(session, { onSessionChanged, onError, notificationsEnabled, initialRun }, view === 'chat');
  const marks = useSessionMarks(session.id, native.history?.generation);
  const discuss = useCallback((source: DiscussionSource) => {
    setDiscussionSource({ ...source, anchor: { ...source.anchor, ...(native.history?.generation ? { generation: native.history.generation } : {}) } });
    setDiscussionOpen(true);
  }, [native.history?.generation]);
  const openDiscussion = useCallback((thread: Session) => {
    setView('chat');
    setDiscussionRequest({ session: thread, nonce: Date.now() });
    setDiscussionOpen(true);
  }, []);
  const [drawer, setDrawer] = useState(false);
  /**
   * Fullscreen editing, owned here because it changes two things at once: the composer's layout, and
   * whether the conversation behind it is reachable (`inert` below). Keeping it in one place is why
   * the composer takes it as a controlled pair instead of owning a copy.
   */
  const [composerFullscreen, setComposerFullscreen] = useState(false);
  const transcriptScrollRef = useRef<TranscriptScrollHandle | null>(null);
  const forwardTranscriptWheel = useCallback((deltaY: number, deltaMode: number) => (
    transcriptScrollRef.current?.scrollByReader(deltaY, deltaMode) ?? false
  ), []);
  const [restoreDraft, setRestoreDraft] = useState<{ text: string; attachments: Attachment[]; context?: PromptContextReference[]; missingAttachments?: import('../session/composerAttachmentIntake').PendingUpload[]; scheduledAt?: Date; onPersisted?: () => void; nonce: number }>();
  const [quoted, setQuoted] = useState<{ text: string; nonce: number }>();
  const quote = useCallback((text: string) => setQuoted({ text, nonce: Date.now() }), []);
  // A passage selected in a file preview of the side panel.
  useComposerQuotes(session.id, quote);
  const [pickedApproval, setPickedApproval] = useState<string>();
  const [switchingApproval, setSwitchingApproval] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [configRelaunching, setConfigRelaunching] = useState(false);
  const [configSwitchSeq, setConfigSwitchSeq] = useState(0);
  const prevConfigPending = useRef(Boolean(session.configPending));
  const [repairingNativeModel, setRepairingNativeModel] = useState(false);
  const [runtimeActionPendingSession, setRuntimeActionPendingSession] = useState<string>();
  const runtimeActionPending = runtimeActionPendingSession === session.id;
  const [dialog, setDialog] = useState<'handoff' | 'automation' | 'share' | 'pdf'>();
  const autoOpened = useRef(false);
  const phase = native.status.phase;
  const connectionState = native.status.connection?.state;
  const connectionNotice = connectionNoticeState(connectionState, native.connected, native.statusKnown);
  const interaction = native.status.interaction;
  const recognizedInteraction = Boolean(interaction && interaction.actions.length > 0);
  const nativeRunInProgress = native.runs.some((run) => Boolean(run.native) && (run.state === 'queued' || run.state === 'running'));
  const silentConfigBoot = (configRelaunching || switchingApproval || switchingModel)
    && !nativeRunInProgress
    && !native.sending
    && !interaction;
  const unknownAttention = !silentConfigBoot && phase === 'attention' && !recognizedInteraction;
  const backendId = sessionBackend(session);
  const labelOf = useBackendLabel();
  const backendLabel = labelOf(backendId);
  const profiles = backends.find((entry) => entry.backendId === backendId)?.profiles ?? [];
  // A legacy conversation without a binding must not be labelled with a newly chosen default.
  const providerLabel = (session.backendProfileId
    ? profiles.find((profile) => profile.id === session.backendProfileId)
    : profiles.length === 1 ? profiles[0] : undefined)?.name;
  const runtimeControl = native.status.runtimeControl;
  const runtimeNotice = runtimeControl?.notice;
  const runtimeActionsEnabled = native.connected && !session.archivedAt && !runtimeActionPending;
  /** A progress that settles within the grace never puts a spinner beside the title and takes it away again. */
  const runtimeProgressShown = useLingering(runtimeActionPending || runtimeNotice?.tone === 'progress', ASSEMBLY_MS);
  const runRuntimeAction = useCallback(async (action: NativeRuntimeAction) => {
    if (!native.connected || runtimeActionPending || !runtimeControl) return;
    setRuntimeActionPendingSession(session.id);
    try {
      await api.nativeRuntimeAction(session.id, { action: action.id, revision: runtimeControl.revision });
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setRuntimeActionPendingSession((current) => current === session.id ? undefined : current);
    }
  }, [session.id, native.connected, runtimeActionPending, runtimeControl, onError]);
  const slash = useSlashCatalog(backendId, { sessionId: session.id });
  const slashCommands: SlashCommand[] = slash.catalog?.items ?? backendCapabilities?.slashCommands ?? noCommands;
  const supportsTerminal = backendCapabilities ? hasNativeTerminal(backendCapabilities) : Boolean(session.terminalId);
  const terminalLive = Boolean(terminal && terminal.state !== 'exited');
  // Terminal liveness controls terminal actions; durable sends resume the backend on the server.
  const terminalBound = backendCapabilities?.requiresLiveTerminal === true;
  const live = terminalBound ? terminalLive : phase !== 'offline';
  // Until the stream reports a status, the session list's state answers, so an open does not start idle.
  // Once a run's receipt or same-turn output arrives while the CLI is still starting (or before status
  // catches up), the turn is causally working so 正在处理 and TurnProcess never lag behind output.
  const latestUserIndex = native.timeline.findLastIndex((item) => item.kind === 'user');
  const latestOutputIndex = native.timeline.findLastIndex((item) => item.kind !== 'user' && item.kind !== 'activity');
  const latestUser = latestUserIndex >= 0 && native.timeline[latestUserIndex]?.kind === 'user' ? native.timeline[latestUserIndex] : undefined;
  const latestOutput = latestOutputIndex >= 0 ? native.timeline[latestOutputIndex] : undefined;
  const latestUserRun = latestUser?.run;
  const preBusyPhase = !silentConfigBoot && (!native.statusKnown || phase === 'starting' || phase === 'offline');
  const turnOutputActive = latestOutputIndex > latestUserIndex
    && Boolean(latestUser && latestOutput && (!latestUser.turn || !latestOutput.turn || latestUser.turn === latestOutput.turn))
    && Boolean(latestUserRun
      && (latestUserRun.state === 'running' || latestUserRun.state === 'queued')
      && !['queued', 'cancelled', 'failed', 'uncertain'].includes(latestUserRun.native?.delivery ?? '')
      && !latestUserRun.native?.timings?.busyAt
      && (preBusyPhase || latestUserRun.state === 'queued' || phase === 'idle'));
  const runObservedActive = native.runs.some((run) => !run.native?.queueReleasedAt
    && (run.state === 'running' || (run.state === 'queued' && (run.native?.delivery === 'observed' || Boolean(run.native?.nativeMessageId || run.native?.timings?.observedAt || run.native?.timings?.providerAcceptedAt))))
    && !run.native?.timings?.busyAt
    && (preBusyPhase || phase === 'idle'));
  // Fallback for a server that sends no control snapshot: with one, `activeTurn` already counts an observed
  // foreground run, so the client does not rederive it from run and timeline state.
  const causallyBusy = !native.control && !connectionNotice && (turnOutputActive || runObservedActive);
  const busy = !silentConfigBoot && (native.control
    ? native.control.activeTurn !== null && native.control.activeTurn.phase !== 'attention'
    : (native.statusKnown ? phase === 'busy' : session.state === 'running' || session.state === 'cancelling') || causallyBusy);
  const needsYou = !silentConfigBoot && (native.statusKnown ? phase === 'attention' : session.state === 'waiting');
  const working = busy || needsYou;
  // The main agent is idle while background agents keep going; only then is there something to stop that `working` does not cover.
  const runningSubagents = useRunningSubagentCount(native.subagents);
  // Background tasks the session reports (`status.activity`) and subagents still running overlap, so the larger count stands.
  const backgroundTotal = Math.max(native.status.activity?.background ?? 0, phase === 'idle' ? runningSubagents : 0);
  const backgroundCount = phase === 'idle' ? backgroundTotal : 0;
  const compacting = Boolean(native.status.activity?.compacting);
  const latestWorking = useRef(working);
  latestWorking.current = working;
  // The page the reader is on should not sleep mid-turn. Same `working` the rest of this view
  // renders from, so a lock can never outlive the spinner it belongs to.
  useWakeLock(working);
  const nativeConfigLocked = native.sending || native.hasUncertainSubmission || nativeRunInProgress;

  // Recognized prompts have native controls. Open the terminal automatically only for an attention
  // state the web client cannot safely interpret, and only once it has settled.
  //
  // Two limits keep this from moving the page around. Interrupting parks the CLI in that state for
  // a moment, so a web-initiated interrupt suppresses the open outright rather than racing the
  // settle timer — that is what made a queued "send now" flash the terminal open. And the opening
  // happens at most once per conversation: it is a hint about where the dialog lives, not the only
  // way to reach it, so after the first time the header's pill (on a phone, the banner's button) carries it. A heuristic that
  // can fire repeatedly will eventually flap, however long its delay.
  const previousUnknownAttention = useRef(false);
  const autoOpenSpent = useRef(false);
  const interrupting = native.interrupting;
  useEffect(() => {
    const previous = previousUnknownAttention.current;
    previousUnknownAttention.current = unknownAttention;
    if (!unknownAttention || !supportsTerminal) {
      if (previous && autoOpened.current) { autoOpened.current = false; setDrawer(false); }
      return;
    }
    if (previous || interrupting || autoOpenSpent.current) return;
    // The timer lives in the effect scope only for the transition into the state; a change of the
    // pending interaction must not cancel it, so it is not part of this effect's dependencies.
    const timer = window.setTimeout(() => { autoOpenSpent.current = true; autoOpened.current = true; setDrawer(true); }, AUTO_OPEN_TERMINAL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [unknownAttention, supportsTerminal, interrupting]);
  // A recognized prompt is answered on its card, which the terminal drawer would cover.
  const recognizedId = recognizedInteraction ? interaction?.id : undefined;
  useEffect(() => {
    if (!recognizedId) return;
    autoOpened.current = false;
    setDrawer(false);
  }, [recognizedId]);

  // The session record holds both user picks and modes adopted from the CLI's own footer/hooks;
  // during a restart or deferred switch `native.status.approval` still carries the pre-switch pane.
  const approval = pickedApproval ?? session.approval ?? native.status.approval ?? backendCapabilities?.permissions[0]?.id ?? '';
  useEffect(() => { setPickedApproval(undefined); }, [session.id, session.approval]);
  useEffect(() => { prevConfigPending.current = Boolean(session.configPending); setConfigRelaunching(false); }, [session.id]);
  useEffect(() => {
    const pending = Boolean(session.configPending);
    if (prevConfigPending.current && !pending && !nativeRunInProgress && !native.sending) {
      setConfigRelaunching(true);
      setConfigSwitchSeq((seq) => seq + 1);
    }
    prevConfigPending.current = pending;
  }, [session.configPending, nativeRunInProgress, native.sending]);
  useEffect(() => {
    if (!configRelaunching) return;
    if (nativeRunInProgress || native.sending || Boolean(interaction)) {
      setConfigRelaunching(false);
      return;
    }
    if (switchingApproval || switchingModel || session.configPending) return;
    const delayMs = phase === 'idle' ? 2_500 : 15_000;
    const timer = window.setTimeout(() => {
      setConfigRelaunching(false);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [configRelaunching, configSwitchSeq, nativeRunInProgress, native.sending, interaction, switchingApproval, switchingModel, session.configPending, phase]);
  const changeApproval = useCallback((next: string) => {
    setPickedApproval(next);
    setSwitchingApproval(true);
    setConfigRelaunching(true);
    setConfigSwitchSeq((seq) => seq + 1);
    void api.nativeSetApproval(session.id, next)
      .then(onSessionChanged)
      .catch((error) => { setPickedApproval(undefined); setConfigRelaunching(false); onError(errorMessage(error, t`无法切换权限模式`)); })
      .finally(() => { setSwitchingApproval(false); });
  }, [session.id, onSessionChanged, onError, t]);

  const timeline = native.timeline;
  const { queuedRuns, todoEntries, goal, subagentBriefs, visibleTimeline, visibleTurns, showWorking, sendingTurn, resumingTurn, workingSince, workingInTimeline } = useSessionTranscript(native, { working, busy, compacting, root, goal: session.goal, activeSince: session.activeSince });
  const timelineRef = useRef(visibleTimeline);
  timelineRef.current = visibleTimeline;
  const stores = useStores();
  const projectName = useLists((state) => state.projects.find((project) => project.id === session.projectId)?.name);
  const calledSessions = useLists((state) => state.sessions.filter((item) => item.origin?.kind === 'call' && item.origin.sessionId === session.id && !item.archivedAt), sameIds);
  const shareSession = useMemo<ShareSession>(() => ({
    title: session.title || t`未命名会话`, backendId, ...(projectName ? { projectName } : {}),
    turnBefore: (at) => {
      let prompt: string | undefined;
      let model = session.model;
      if (at) for (const item of timelineRef.current) {
        if (item.kind !== 'user') continue;
        // A follow-up still on its way has no answer yet: it is not the question this one replied to,
        // even though the store already stamped it with an earlier time.
        if (item.run?.native && ['queued', 'preparing', 'dispatching', 'input_sent', 'uncertain'].includes(item.run.native.delivery)) continue;
        if (timelineItemTime(item) > at) break;
        prompt = item.text;
        model = item.run?.native?.resolvedConfig?.model ?? item.run?.native?.config.model ?? session.model;
      }
      const name = shareModelName(model, catalog);
      return { ...(prompt ? { prompt } : {}), ...(name ? { model: name } : {}) };
    },
  }), [session.title, session.model, backendId, projectName, catalog, t]);
  const messageCommands = useMemo(() => ({ sessionId: session.id, ...(projectSystem ? { projectSystem } : {}), openModelSettings: (section: 'auxiliary' | 'quickchat') => { void stores.nav.navigate(() => { stores.nav.openSettings(section); stores.ui.setMobileSidebar(false); }, { keepUnderlying: true }); } }), [session.id, projectSystem, stores.nav, stores.ui]);
  const liveActivities = useMemo(() => native.activities ?? liveBackgroundActivities(visibleTimeline), [native.activities, visibleTimeline, native.timelineVersion]);
  // The header and the side column list these; they keep their memo while the transcript streams.
  const backgroundKey = liveActivities.map((activity) => `${activity.id}:${activity.status}:${activity.title}:${activity.startedAt ?? ''}`).join('\n');
  const backgroundActivities = useMemo(() => liveActivities, [backgroundKey]);
  const activityControls = useActivityControls(session.id, () => backgroundActivities);
  // Delegated work hands its result back and opens the next turn; a shell or a monitor may run for as long as the session does, so only the former is waited on.
  const runningOf = (kind: 'agent' | 'workflow') => backgroundActivities.filter((activity) => activity.status === 'running' && activity.task?.kind === kind).length;
  const delegatedAgents = phase === 'idle' ? Math.max(runningSubagents, runningOf('agent')) : 0;
  const delegatedWorkflows = phase === 'idle' ? runningOf('workflow') : 0;

  const [subagentStack, setSubagentStack] = useState<SubagentTarget[]>([]);
  const [outlineSlot, setOutlineSlot] = useState<HTMLDivElement | null>(null);
  useEffect(() => setSubagentStack([]), [session.id]);
  const subagentOpen = subagentStack.length > 0;
  // One overlay layer for the whole stack: each browser Back pops one level.
  useOverlayState({ open: subagentOpen, onOpenChange: (open) => { if (!open) setSubagentStack((stack) => stack.slice(0, -1)); } });
  const renderer = useMemo<SubagentRenderer>(() => ({ open: (target) => setSubagentStack([target]) }), []);
  const openNestedSubagent = useCallback((target: SubagentTarget) => setSubagentStack((stack) => (
    stack.at(-1)?.toolCallId === target.toolCallId ? stack : [...stack, target].slice(-8)
  )), []);
  // Asked during the subagent page's own render, which every parent render repeats, so reading the
  // latest timeline through a ref keeps the callback stable without serving a stale event.
  const latestTimeline = useRef(timeline);
  latestTimeline.current = timeline;
  const findSubagentEvent = useCallback((toolCallId: string) => {
    const item = latestTimeline.current.find((entry) => entry.kind === 'tool' && entry.event.data.toolCallId === toolCallId);
    return item?.event;
  }, []);
  const imageSource = useMemo(() => projectImageSource(session.projectId), [session.projectId]);
  // Mentions resolve against the files touched so far, read when a mention renders: the access
  // stays stable, so memoized rows do not re-render on every streamed event.
  const touchedCache = useRef(new WeakMap<object, readonly string[]>());
  const resolveMention = useCallback((path: string) => resolveFileMention(path, conversationFiles(latestTimeline.current, root, touchedCache.current)), [root]);
  const fileAccess = useMemo(() => ({ projectId: session.projectId, open: onOpenPath, resolve: resolveMention }), [session.projectId, onOpenPath, resolveMention]);

  const archived = Boolean(session.archivedAt);
  const held = Boolean(session.terminalHold);
  const runActionPending = useCallback((run: Run) => archived || native.sending || native.interrupting || (run.native?.delivery === 'queued' && native.hasUnknownSubmission) || native.runActionIds.has(run.id), [archived, native.sending, native.interrupting, native.hasUnknownSubmission, native.runActionIds]);
  const acceptedRunPreparing = native.runs.some((run) => ['queued', 'running'].includes(run.state) && ['queued', 'preparing', 'dispatching', 'input_sent'].includes(run.native?.delivery ?? ''));
  const starting = reopening || (!silentConfigBoot && phase === 'starting') || (!connectionNotice && phase === 'offline' && (session.state === 'starting' || acceptedRunPreparing));
  const [queueOverride, setQueueOverride] = useState('');
  const runningTargetKey = `${session.id}:${native.status.activeTurn?.turnId ?? ''}`;
  const preferredSubmitIntent = composerRunningIntent(runningBehavior, {
    running: busy,
    supportsSteer: native.control ? native.control.activeTurn?.canSteer : backendCapabilities?.supportsSteer,
    activeTurn: native.status.activeTurn,
    writable: native.connected && (!connectionState || connectionState === 'connected'),
    blocked: Boolean(interaction) || archived || starting || switchingApproval || switchingModel,
    uncertain: native.hasUncertainSubmission,
  });
  const submitIntent = queueOverride === runningTargetKey ? 'queue' : preferredSubmitIntent;
  const steerUnavailable = submitIntent === 'steer' && (native.control
    ? !native.control.activeTurn?.canSteer || native.hasUncertainSubmission || Boolean(interaction)
    : !backendCapabilities?.supportsSteer || !native.status.activeTurn || native.hasUncertainSubmission || Boolean(interaction));
  const storedNativeSelection = backendSelection(backendId, catalog, session.model);
  const correctedNativeSelection = launchSelection(catalog, storedNativeSelection);
  const needsNativeNormalization = Boolean(storedNativeSelection && correctedNativeSelection !== storedNativeSelection);
  const nativeModelCatalogUnavailable = Boolean(session.model) && (catalogLoading || Boolean(catalogError) || catalog.length === 0);
  // Why the model/permission controls are unavailable, so the mobile sheet can answer a tap with a
  // reason instead of the dead button that also dropped the keyboard (see `pickerBlockReason`).
  // What is left that truly blocks a switch: an archived conversation and a request already in
  // flight. A running turn deliberately is not one of them — the backends record a mid-turn switch and
  // apply it at the next idle moment, so the control stays live and the change lands with the next
  // turn. Leaving it `disabled` is what made a phone tap do nothing and drop the keyboard.
  const pickersBlocked = archived;
  const pickerBlocked = pickerBlockReason({
    archived,
    catalogUnavailable: catalogLoading || Boolean(catalogError) || catalog.length === 0,
    switching: false,
  });
  const [restartingBackend, setRestartingBackend] = useState(false);
  const restartBackend = useCallback(async () => {
    const binding = session.nativeRuntime;
    if (!binding || restartingBackend) return;
    if (!await confirmDialog({ title: t`重启并应用？`, description: t`运行中的任务会中断，对话记录保留`, confirmLabel: t`重启并应用`, destructive: true })) return;
    setRestartingBackend(true);
    try {
      const result = await api.restartSession<{ session: Session; terminal?: TerminalInfo }>(session.id, binding.fingerprint, binding.address);
      onSessionChanged(result.session);
      if (result.terminal) onTerminalChanged(result.terminal);
      native.retryConnection();
    } catch (error) { onError(errorMessage(error)); }
    finally { setRestartingBackend(false); }
  }, [session.id, session.nativeRuntime, restartingBackend, onSessionChanged, onTerminalChanged, native.retryConnection, onError, t]);
  const reopenDisabled = archived || held || reopening || repairingNativeModel || nativeModelCatalogUnavailable;
  const reopen = useCallback(async () => {
    if (!needsNativeNormalization || !correctedNativeSelection) {
      onReopen();
      return;
    }
    setRepairingNativeModel(true);
    try {
      const updated = await api.nativeSetModel(session.id, correctedNativeSelection);
      onSessionChanged(updated);
      onReopen();
    } catch (error) {
      onError(errorMessage(error, t`无法保存模型设置`));
    } finally {
      setRepairingNativeModel(false);
    }
  }, [needsNativeNormalization, correctedNativeSelection, onReopen, session.id, onSessionChanged, onError, t]);

  /**
   * Rewinding restores the checkpoint taken just before the turn, through the same fingerprint-checked
   * restore the changes panel uses. The conversation itself stays: the CLI owns its history and
   * cannot drop turns, so the confirmation says so rather than implying a full undo.
   */
  const turnAction = useCallback(async (action: TurnAction, runId: string) => {
    if (action === 'fork') {
      try { onLaunched?.(await api.forkSession(session.id, { clientSessionId: newId(), commandId: newId(), runId })); }
      catch (error) { onError(errorMessage(error, t`无法另开会话`)); }
      return;
    }
    // Restoring under a running turn would race the agent's own writes.
    if (working) { toast.info(t`Agent 正在运行，等它停下后再回退代码`); return; }
    try {
      const checkpoint = (await api.sessionCheckpoints(session.id)).find((item) => item.runId === runId);
      if (!checkpoint) { onError(t`本轮开始前没有检查点，无法回退代码。`); return; }
      const changes = await api.checkpointChanges(checkpoint.projectId, checkpoint.id);
      if (!changes.length) { toast.info(t`代码与本轮开始前一致，无需回退`); return; }
      const kind = { added: t({ message: '删除', context: 'terminal-change-delete' }), modified: t`还原`, deleted: t`恢复` } as const;
      const ok = await confirmDialog({
        title: t`回退代码到本轮开始前？`,
        description: t`代码将回到本轮开始前，撤销 ${changes.length} 个文件自那之后的改动。对话记录会保留，Agent 不会感知到回退，可以接着告诉它。`,
        detail: changes.map((change) => `${kind[change.kind]}  ${change.path}`).join('\n'),
        confirmLabel: t`回退`,
        destructive: true,
      });
      if (!ok) return;
      if (latestWorking.current) { toast.info(t`Agent 正在运行，等它停下后再回退代码`); return; }
      await api.restoreCheckpoint(checkpoint.projectId, checkpoint.id, changes);
      toast.success(t`已回退 ${changes.length} 个文件`);
    } catch (error) {
      onError(errorMessage(error, t`无法回退代码`));
    }
  }, [session.id, working, onLaunched, onError]);

  const terminalPane = (className: string, actions?: ReactNode, leading?: ReactNode) => terminal
    ? <Suspense fallback={<div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-fg-3"><Spinner /><Trans>正在加载终端…</Trans></div>}><TerminalView key={terminal.id} terminal={terminal} active showTitle={false} autoFocus={!mobileViewport} onChanged={onTerminalChanged} onError={onError} className={className} actions={actions} leading={leading} /></Suspense>
    : null;

  // A send owns what its launch did: its row shows the failure and the way back, so the conversation does not
  // say it again (one place per failure, DECISIONS 2026-11-12). The row is there before the launch, so nothing flashes.
  const sendOwnsLaunch = Boolean(native.control?.inbox.some(entry => entry.kind === 'message'));
  const failureNotice = !live && !sendOwnsLaunch ? session.error : undefined;
  // A reason in English is the CLI's or the server's diagnostic: the row says what happened, the reason sits behind 详情.
  const failureMessage = failureNotice === undefined ? undefined
    : HAN.test(failureNotice) ? { text: failureNotice } : { text: t`${backendLabel} 无法启动`, detail: failureNotice };
  const degraded = !native.status.history && native.status.transcript === 'unparsed'
    ? t`无法解析 ${backendLabel} 的会话存储，请查看后端版本与诊断信息。`
    : undefined;
  const historyLoad = native.historyLoad.state !== 'error' && degraded ? { state: 'error' as const, message: degraded } : native.historyLoad;
  const historyNotice = view === 'chat' && historyLoad.state === 'error' ? historyLoad.message : undefined;
  const feedbackScope = `${location.origin}:${session.projectId ?? ''}:${session.id}`;
  const banners: FeedbackMessage[] = [];
  const displayedNotices = new Set(historyNotice ? [historyNotice] : []);
  if (native.statusKnown && !archived) {
    // Where the header's pill already offers the one action, a row here only repeats it; the row
    // stays for a detail the pill cannot hold, and on a phone, whose header pill is not a button.
    if (connectionNotice === 'failed' || connectionNotice === 'conflict') {
      const connectionCopy = connectionNotice === 'conflict' ? t`连接冲突` : t`连接已断开`;
      const connectionDetail = native.status.connection?.message;
      if ((connectionNotice === 'conflict' || connectionDetail || mobileViewport) && (!historyNotice || historyNotice !== connectionDetail)) {
        // The backend's reason is an untranslated diagnostic: the notice says what happened, the reason sits behind 详情.
        banners.push({ id: `connection:${connectionDetail || connectionCopy}`, tone: 'warning', text: connectionCopy, ...(connectionDetail ? { detail: connectionDetail } : {}) });
        if (connectionDetail) displayedNotices.add(connectionDetail);
      }
    } else if (!starting && !sendingInitial && !connectionNotice && (failureNotice || mobileViewport && terminalBound && !live)) {
      const text = failureNotice ?? t`${backendLabel} 当前未运行。`;
      banners.push({ id: `session:${text}`, tone: failureNotice ? 'danger' : 'warning', text, ...failureMessage });
      if (failureNotice) displayedNotices.add(failureNotice);
    }
  }
  // An info-level notice is progress or a fact, not a problem: it is read in the header's info, as
  // the title's spinner carries the wait, and only warnings and errors become banners.
  const infoNotice = native.status.noticeLevel === 'info' ? native.status.notice : undefined;
  // Session feedback belongs outside the transcript. Keep suppressing mirrors from older backends
  // only when the detailed reason is already visible in its connection or history owner.
  const sessionNotices = [
    { text: failureNotice, tone: 'danger' as const },
    { text: infoNotice ? undefined : native.status.notice, tone: native.status.noticeLevel === 'error' ? 'danger' as const : 'warning' as const },
  ].filter((notice): notice is typeof notice & { text: string } => {
    if (!notice.text || displayedNotices.has(notice.text)) return false;
    displayedNotices.add(notice.text);
    return true;
  });
  const standingNotices: FeedbackMessage[] = [
    ...banners,
    // The banner above and this row are one failure: one id, so a hand-over between them is not a second
    // notice. Only the banner offers 恢复会话; while a start or a first send is under way the row does not.
    ...sessionNotices.filter(notice => notice.text === failureNotice).map(notice => ({ ...notice, ...failureMessage, id: `session:${notice.text}` })),
  ];
  const transientNotices: FeedbackMessage[] = sessionNotices.filter(notice => notice.text !== failureNotice)
    .map(notice => ({ ...notice, id: `native:${notice.text}` }));

  const changeView = useCallback((next: SessionView) => { setView(next); onViewChange?.(next); }, [onViewChange]);
  // A message asked for by a search result or a plugin's view is read in the transcript.
  const askedFocus = useRef(focus);
  useEffect(() => {
    if (focus === askedFocus.current) return;
    askedFocus.current = focus;
    if (focus) { setView('chat'); onViewChange?.('chat'); }
  }, [focus, onViewChange]);
  const switchNativeView = () => {
    if (mobileViewport && live && view === 'chat') {
      autoOpened.current = false;
      setDrawer(true);
      return;
    }
    changeView(view === 'chat' ? 'terminal' : 'chat');
  };

  /*
   * A streamed frame renders this component, and with it everything below that is handed a fresh
   * closure or element. The header, the composer and its dock do not read the timeline, so their
   * props are kept stable here (actions reach the latest state through `latest`) and those
   * subtrees sit the frames out; the transcript and the side column's output list are what move.
   */
  const paneAnswers = backendCapabilities?.interactionTransport === 'both';
  const compactCommand = !quickChat && !archived && !held ? backendCapabilities?.compactCommand?.replace(/^\//, '').trim() || undefined : undefined;
  const latest = useRef({ native, queuedRuns, submitIntent, steerUnavailable, slashCommands, backendId, paneAnswers, compactCommand, switchNativeView, changeView, assistantMain });
  latest.current = { native, queuedRuns, submitIntent, steerUnavailable, slashCommands, backendId, paneAnswers, compactCommand, switchNativeView, changeView, assistantMain };
  const queuedRun = (runId: string) => latest.current.native.runs.find((item) => item.id === runId);
  const stop = useCallback(() => { void latest.current.native.cancel(); }, []);
  const sendQueuedNowById = useCallback((runId: string) => {
    const run = queuedRun(runId);
    if (run) void latest.current.native.sendQueuedNow(run);
  }, []);
  const steerQueuedById = useCallback((runId: string) => {
    const run = queuedRun(runId);
    if (run) void latest.current.native.steerQueued(run);
  }, []);
  // A queued message handed back to the composer keeps its row until the draft lands: the server's
  // frame dropping it and the draft arriving would otherwise move the stack twice, down then up.
  // Once handed back (`done`) it stays out of the dock even while the server still lists it, until its frame drops it.
  const [handingBack, setHandingBack] = useState<{ run: Run; index: number; done?: true }>();
  const editQueued = useCallback((runId: string) => {
    const run = queuedRun(runId);
    if (!run) return;
    setHandingBack({ run, index: Math.max(0, latest.current.queuedRuns.findIndex(item => item.id === runId)) });
    const ids = run.native?.input.attachmentIds ?? [];
    void Promise.all([
      latest.current.native.cancelNativeRun(run),
      Promise.all(ids.map(async id => {
        try { return { attachment: await api.attachmentMetadata(id) }; }
        catch (error) { return { missing: { key: `missing:${id}`, attachmentId: id, name: t`附件`, size: 0, image: false, error: error instanceof HttpError && error.status === 404 ? t`请重新选择文件` : t`无法读取附件` } }; }
      })),
    ]).then(([cancelled, checked]) => {
      if (!recipientAlive.current) return;
      setHandingBack(current => current?.run.id !== runId ? current : cancelled ? { ...current, done: true } : undefined);
      if (!cancelled) return;
      setRestoreDraft({ text: run.native?.input.text ?? run.prompt, attachments: checked.flatMap(item => item.attachment ? [item.attachment] : []), context: restoreContext({ context: run.native?.input.context, references: run.native?.input.references, agents: run.native?.input.agents }, run), missingAttachments: checked.flatMap(item => item.missing ? [item.missing] : []), nonce: Date.now() });
    });
  }, []);
  const handedBackListed = Boolean(handingBack?.done && queuedRuns.some(item => item.id === handingBack.run.id));
  useEffect(() => {
    if (handingBack?.done && !handedBackListed) setHandingBack(current => current === handingBack ? undefined : current);
  }, [handingBack, handedBackListed]);
  const dockRuns = useMemo(() => {
    if (!handingBack) return queuedRuns;
    if (handingBack.done) return queuedRuns.filter(item => item.id !== handingBack.run.id);
    if (queuedRuns.some(item => item.id === handingBack.run.id)) return queuedRuns;
    const runs = [...queuedRuns];
    runs.splice(Math.min(handingBack.index, runs.length), 0, handingBack.run);
    return runs;
  }, [queuedRuns, handingBack]);
  const removeQueued = useCallback((runId: string) => {
    const run = queuedRun(runId);
    if (run) void latest.current.native.cancelNativeRun(run);
  }, []);
  // An answer is the reader acting at the end, as a message is: the card leaving takes the view down with it.
  const respondInteraction = useCallback((...args: Parameters<typeof native.respondInteraction>) => {
    transcriptScrollRef.current?.followSent();
    return latest.current.native.respondInteraction(...args);
  }, []);
  const submit = useCallback(async (text: string, attachments: Attachment[], context: PromptContextReference[], onStored?: () => boolean) => {
    const { native, submitIntent, steerUnavailable, slashCommands, backendId, paneAnswers, assistantMain } = latest.current;
    if (steerUnavailable) { onError(t`当前任务暂不接受补充，输入已保留`); return false; }
    // Before the message lands: once it does, the latest turn is the one being sent.
    transcriptScrollRef.current?.followSent();
    const ok = await (submitIntent === 'steer'
      ? native.steer(text, attachments, context, onStored)
      : native.send(text, attachments, context, onStored, assistantMain ? workbenchAppearanceConnection : undefined));
    const command = /^\/(\S+)/.exec(text.trim())?.[1];
    // A skill runs as an ordinary turn whose answer lands in the transcript, not the CLI's pane.
    const skill = slashCommands.some((item) => item.name === command && item.kind === 'skill');
    // Claude has no /summarize (its compaction is /compact, already quiet); everything else it
    // answers only in its pane, as the Mac client has it.
    if (ok && command && !skill && (backendId === 'claude' && command !== 'compact' || paneAnswers && commandNeedsTerminal(command))) setDrawer(true);
    return ok;
  }, []);
  const compactContext = useCallback(async () => {
    const { native, compactCommand, assistantMain } = latest.current;
    if (!compactCommand) return false;
    transcriptScrollRef.current?.followSent();
    return native.send(`/${compactCommand}`, [], [], undefined, assistantMain ? workbenchAppearanceConnection : undefined);
  }, []);
  const compactDisabled = archived || held || starting || sendingInitial || switchingApproval || switchingModel
    || working || compacting || Boolean(interaction)
    || !native.connected || Boolean(connectionState && connectionState !== 'connected')
    || native.sending || native.interrupting || native.hasUnknownSubmission;
  const { sending, hasUnknownSubmission, runActionIds, hasPendingQueuedSteer } = native;
  const queuedPending = useCallback((runId: string) => archived || !native.connected || Boolean(connectionState && connectionState !== 'connected') || starting || sending || interrupting || hasUnknownSubmission || runActionIds.has(runId) || hasPendingQueuedSteer(runId) || handingBack?.run.id === runId,
    [archived, native.connected, connectionState, starting, sending, interrupting, hasUnknownSubmission, runActionIds, hasPendingQueuedSteer, handingBack]);
  const steerDisabled = !native.connected || Boolean(connectionState && connectionState !== 'connected') || switchingApproval || switchingModel
    || (native.control ? !native.control.activeTurn?.canSteer || native.hasUncertainSubmission
      : phase !== 'busy' || Boolean(interaction) || native.hasUncertainSubmission);
  const inboxActions = useMemo(() => inboxActionsByRun(native.control, native.runs), [native.control, native.runs]);
  const canSteerQueued = native.control
    ? native.control.capabilities.canSteer && Boolean(native.control.activeTurn?.canSteer)
    : Boolean(backendCapabilities?.supportsSteer && native.status.activeTurn);
  const canSendQueuedNow = native.control
    ? native.control.capabilities.canSendNow
    : Boolean(backendCapabilities?.supportsTargetedStop);
  const heldQueue = native.control ? native.control.held : native.status.queue?.held;
  const queueUnconfirmed = heldQueue?.reason === 'unconfirmed';
  const unconfirmedRunId = queueUnconfirmed ? heldQueue?.runId : undefined;
  const revealUnconfirmed = useCallback(() => { if (unconfirmedRunId) transcriptScrollRef.current?.revealRun(unconfirmedRunId); }, [unconfirmedRunId]);
  /** The queue card is on screen, closing included: the composer card keeps its seam until the card has gone. */
  const [queueShown, setQueueShown] = useState(false);
  const followUps = useSessionFollowUps(session.id);
  const editFollowUp = useCallback((item: Automation) => {
    void followUps.cancel(item.id).then(async (cancelled) => {
      if (!cancelled || !recipientAlive.current) return;
      const ids = item.input?.attachmentIds ?? [];
      const checked = await Promise.all(ids.map(async id => {
        try { return { attachment: await api.attachmentMetadata(id) }; }
        catch (error) { return { missing: { key: `missing:${id}`, attachmentId: id, name: t`附件`, size: 0, image: false, error: error instanceof HttpError && error.status === 404 ? t`请重新选择文件` : t`无法读取附件` } }; }
      }));
      if (!recipientAlive.current) return;
      const due = item.nextRunAt && Date.parse(item.nextRunAt) > Date.now() ? new Date(item.nextRunAt) : undefined;
      const context = restoreContext({ context: item.input?.context, references: item.input?.references })?.map((entry) => {
        if (!isSessionReference(entry)) return entry;
        const target = findSession?.(entry.sessionId);
        return target ? { ...entry, title: entry.title ?? target.title, backendId: entry.backendId ?? sessionBackend(target) } : entry;
      });
      setRestoreDraft({
        text: item.prompt,
        attachments: checked.flatMap(entry => entry.attachment ? [entry.attachment] : []),
        context,
        missingAttachments: checked.flatMap(entry => entry.missing ? [entry.missing] : []),
        ...(due ? { scheduledAt: due } : {}),
        nonce: Date.now(),
      });
    });
  }, [followUps.cancel, findSession]);
  const followUpEditable = !archived && !held;
  const followUpList = useMemo(() => followUps.items.length ? <FollowUpList items={followUps.items} onCancel={(id) => void followUps.cancel(id)} onEdit={followUpEditable ? editFollowUp : undefined} onReschedule={followUpEditable ? followUps.reschedule : undefined} /> : undefined, [followUps.items, followUps.cancel, followUpEditable, editFollowUp, followUps.reschedule]);
  const sendLater = useCallback(async (prompt: string, attachments: Attachment[], context: PromptContextReference[], at: Date) => {
    const ok = await scheduleFollowUp(session.id, prompt, attachments, context, at);
    if (ok) void followUps.refresh();
    return ok;
  }, [session.id, followUps.refresh]);
  const dock = useMemo(() => (
    <ComposerDock
      planInAside={layout.plan === 'aside'}
      goal={goal}
      todos={todoEntries}
      runs={dockRuns}
      running={working}
      unconfirmed={queueUnconfirmed}
      onRevealUnconfirmed={unconfirmedRunId ? revealUnconfirmed : undefined}
      pending={queuedPending}
      onSteerQueued={inboxActions || canSteerQueued ? steerQueuedById : undefined}
      steerDisabled={steerDisabled}
      steerUnlisted={inboxActions ? canSteerQueued : undefined}
      onSendQueuedNow={inboxActions || canSendQueuedNow ? sendQueuedNowById : undefined}
      sendUnlisted={inboxActions ? canSendQueuedNow : undefined}
      inboxActions={inboxActions}
      onEditQueued={editQueued}
      onRemoveQueued={removeQueued}
      onQueueShown={setQueueShown}
      followUps={followUpList}
      plans={(assistant || memberRuns.length > 0) ? (
        <div className="flex flex-col gap-2 empty:hidden">
          {memberRuns.length > 0 && <MemberRunReportsDock runs={memberRuns} onOpenSession={onOpenSession} />}
          {assistant && <PlanDock />}
        </div>
      ) : undefined}
    />
    ), [assistant, memberRuns, onOpenSession, followUpList, layout.plan, goal, todoEntries, dockRuns, working, queueUnconfirmed, unconfirmedRunId, revealUnconfirmed, queuedPending, canSteerQueued, canSendQueuedNow, inboxActions, steerQueuedById, steerDisabled, sendQueuedNowById, editQueued, removeQueued]);
  // Without the backend's permissions there is no name to show, only an id.
  const approvalSummary = useMemo(() => (backendCapabilities?.permissions.length ? <ApprovalSummary mode={approval} options={backendCapabilities.permissions} /> : undefined), [approval, backendCapabilities]);
  const approvalPicker = useMemo(() => (backendCapabilities?.permissions.length ? (
    <ApprovalPicker
      compact={!mobileViewport}
      value={approval}
      options={backendCapabilities.permissions}
      onChange={changeApproval}
      disabled={pickersBlocked || !backendCapabilities.supportsPermissionSelection}
      note={paneAnswers && busy ? t`本轮结束后生效` : undefined}
    />
  ) : undefined), [backendCapabilities, mobileViewport, approval, changeApproval, pickersBlocked, paneAnswers, busy, t]);
  const [toolGroupsValue, changeToolGroups] = useSessionPick(session, 'toolGroups', NO_TOOL_GROUPS, onSessionChanged, onError);
  const [extensionsOffValue, changeExtensionsOff] = useSessionPick(session, 'extensionsOff', NO_EXTENSIONS_OFF, onSessionChanged, onError);
  const pluginToolRows = usePluginToolGroups(toolGroupsValue).rows.length;
  const remoteSession = Boolean(serverOfObject(session.id));
  const linkableServersOffered = useLinkableServers(toolGroupsValue, !quickChat && !archived && !remoteSession).offered;
  const phonesOffered = (useControllablePhones(toolGroupsValue).offered || pluginToolRows > 0 || linkableServersOffered) && offersRiffetTools(backendCapabilities);
  const extensionToggles = session.projectId ? offersExtensionToggles(backendCapabilities) : undefined;
  const extensionPick = useMemo(() => (extensionToggles && session.projectId
    ? { backendId, ...(session.backendProfileId ? { profileId: session.backendProfileId } : {}), projectId: session.projectId, toggles: extensionToggles, off: extensionsOffValue, onChange: changeExtensionsOff }
    : undefined), [extensionToggles, backendId, session.backendProfileId, session.projectId, extensionsOffValue, changeExtensionsOff]);
  const extensionsOffered = useExtensionsOffered(quickChat || archived ? undefined : extensionPick);
  // A called conversation cannot call further (docs/AGENT-CALLS.md §3).
  const callsOffered = !quickChat && session.origin?.kind !== 'call' && offersRiffetTools(backendCapabilities);
  const catalogBackends = useCatalog((state) => state.backends);
  const teamMembers = useLists((state) => state.teamMembers);
  const agentMentions = useMemo<AgentMentionSource | undefined>(
    () => callsOffered ? { projectId: session.projectId, backends: catalogBackends, members: teamMembers, ...(session.agentMemberId ? { currentMemberId: session.agentMemberId } : {}) } : undefined,
    [callsOffered, session.projectId, catalogBackends, teamMembers, session.agentMemberId],
  );
  const toolsPicker = useMemo(() => (!quickChat && !archived && (phonesOffered || extensionsOffered || callsOffered)
    ? <ToolsPicker value={toolGroupsValue} onChange={changeToolGroups} extensions={extensionPick} agents={callsOffered} servers={!remoteSession} onError={onError} footnote={t`下次启动时生效`} />
    : undefined), [quickChat, archived, phonesOffered, extensionsOffered, callsOffered, extensionPick, remoteSession, toolGroupsValue, changeToolGroups, onError, t]);
  const handleSwitchingModel = useCallback((next: boolean) => {
    setSwitchingModel(next);
    if (next) {
      setConfigRelaunching(true);
      setConfigSwitchSeq((seq) => seq + 1);
    }
  }, []);
  const modelPicker = useMemo(() => (backendCapabilities?.supportsModelSelection
    ? <NativeModelPicker session={session} catalog={catalog} continuations={continuations} profiles={profiles} providerLabel={providerLabel} loading={catalogLoading && !catalog.length} refreshing={catalogLoading} catalogError={catalogError} disabled={pickersBlocked} {...(pickerBlocked ? { blockedReason: pickerBlocked } : {})} onError={onError} onSessionChanged={onSessionChanged} onSwitchingChange={handleSwitchingModel} onRememberModel={onRememberModel} refreshCatalog={onRetryCatalog} />
    : undefined), [backendCapabilities?.supportsModelSelection, session, catalog, continuations, profiles, providerLabel, catalogLoading, catalogError, pickersBlocked, pickerBlocked, onError, onSessionChanged, handleSwitchingModel, onRememberModel, onRetryCatalog]);

  // What the header's badge says, as a value the header's memo can compare.
  // Session.state may aggregate background children; the conversation header describes only the
  // foreground phase once the native control stream has answered, including an explicit idle.
  // An accepted first message can be preparing before the CLI reports a live phase.
  const headerStatus = archived ? ''
    : connectionNotice === 'failed' || connectionNotice === 'conflict' ? `connection:${connectionNotice}`
    : starting || sendingInitial ? 'starting'
    : !native.statusKnown ? busy ? 'busy' : 'connecting'
    : connectionNotice ? `connection:${connectionNotice}`
    : recognizedInteraction ? 'interaction' : unknownAttention ? 'attention' : busy ? 'busy' : !silentConfigBoot && phase === 'offline' ? 'offline' : '';
  // Opening a session waits on its status for a moment; until that wait has lasted, the header reads
  // the session list's state, as the transcript does, instead of a spinner the answer then removes.
  const connectingLong = useLingering(headerStatus === 'connecting', ASSEMBLY_MS);
  // Session tabs show the busy/starting/connecting spinners on the tab itself and the header has no status
  // slot there, so what the reader can act on moves into the alerts.
  const tabbed = Boolean(tabChrome) && !mobileViewport;
  const tabbedAlert = tabbed && (headerStatus === 'attention' || headerStatus === 'offline' || headerStatus.startsWith('connection:') && connectionNotice !== 'reconnecting');
  const runtimeAlert = () => {
    if (runtimeProgressShown) return <span role="status" className="flex items-center gap-1.5 px-1 text-xs text-fg-3"><Spinner />{runtimeActionPending ? undefined : localizedText(runtimeNotice?.label)}</span>;
    if (!runtimeNotice) return undefined;
    const label = localizedText(runtimeNotice.label);
    const action = runtimeNotice.action;
    const actionLabel = action && localizedText(action.label);
    const run = action ? () => void runRuntimeAction(action) : undefined;
    const disabled = !runtimeActionsEnabled || action?.disabled;
    if (runtimeNotice.tone === 'danger') {
      const text = label ?? runtimeNotice.detail;
      if (!text) return undefined;
      return <span role="status" className="flex">{run && actionLabel
        ? <StatusPill tone="danger" label={text} title={runtimeNotice.detail} actionLabel={actionLabel} disabled={disabled} onAction={run} />
        : <Badge tone="danger" title={runtimeNotice.detail}>{text}</Badge>}</span>;
    }
    if (!label && !(run && actionLabel)) return undefined;
    return <>
      {label && <span className="px-1 text-xs text-fg-3" title={runtimeNotice.detail}>{label}</span>}
      {run && actionLabel && <Button size="xs" variant="quiet" disabled={disabled} onClick={run}>{actionLabel}</Button>}
    </>;
  };
  const statusSlot = () => headerStatus.startsWith('connection:')
    // Progress is a spinner beside the title, its words in the tooltip; what needs attention keeps its badge.
    ? connectionNotice === 'reconnecting'
      ? <span role="status" aria-label={t`正在重新连接`} title={t`正在重新连接`} className="flex"><Spinner className="size-3" /></span>
      : connectionNotice === 'conflict' ? <Badge tone="warning">{t`连接冲突`}</Badge>
      : <StatusPill tone="warning" label={t`连接已断开`} actionLabel={t`重新连接`} onAction={native.retryConnection} />
    : headerStatus === 'interaction' ? <Badge tone="warning"><Trans context="terminal-awaiting-confirmation">等待确认</Trans></Badge>
    : headerStatus === 'attention' ? supportsTerminal && view === 'chat' && !drawer && terminalLive
      ? <StatusPill tone="warning" label={t`等待终端操作`} actionLabel={t`打开终端`} onAction={() => { setSubagentStack([]); autoOpened.current = false; setDrawer(true); }} />
      : <Badge tone="warning">{supportsTerminal ? t`等待终端操作` : t`等待交互`}</Badge>
    : headerStatus === 'busy' ? <span role="status" aria-label={t`运行中`} title={t`运行中`} className="flex"><Spinner className="size-3 text-accent" /></span>
    : headerStatus === 'starting' ? <span role="status" aria-label={t`启动中`} title={t`启动中`} className="flex"><Spinner className="size-3" /></span>
    : headerStatus === 'connecting' ? connectingLong ? <span role="status" aria-label={t`连接中`} title={t`连接中`} className="flex"><Spinner className="size-3" /></span> : undefined
    : headerStatus === 'offline' ? held ? <Badge><Trans>在终端中</Trans></Badge> : quickChat || live ? <Badge><Trans>待恢复</Trans></Badge>
      : <StatusPill label={t`待恢复`} actionLabel={t({ message: '恢复', context: 'terminal-resume-session' })} title={pickerBlocked} disabled={reopenDisabled} busy={repairingNativeModel} onAction={() => void reopen()} />
    : null;
  // A phone switches views from its menu; a subagent's transcript has no views of its own.
  const viewIds = visibleViews(prefs, offered, (id) => id !== 'terminal' || supportsTerminal);
  const views = viewIds.flatMap((id) => offered.filter((entry) => entry.id === id));
  const switcher = !quickChat && !mobileViewport && !subagentOpen && views.length > 1;
  const viewsKey = viewIds.join();
  useViewShortcuts(viewIds, changeView, switcher);
  // A different alert is a new arrival; the same one re-rendering is not.
  const alertsKey = `${tabbedAlert ? headerStatus : ''}|${runtimeProgressShown ? 'progress' : runtimeNotice ? `${runtimeNotice.tone}:${runtimeNotice.action?.id ?? ''}` : ''}`;
  const header = useMemo(() => renderHeader({
    views: switcher && prefs.placement === 'header' ? <ViewSwitch views={viewsKey.split(',').flatMap((id) => offered.filter((entry) => entry.id === id))} value={view} onChange={changeView} /> : undefined,
    usage: quickChat ? undefined : native.context,
    approval: backendCapabilities?.permissions.find((mode) => mode.id === approval)?.label,
    // Shown in the row only while the route is changing or failing; the route in force is in the ⋯ menu.
    alerts: tabbedAlert ? <>{runtimeAlert()}{statusSlot()}</> : runtimeAlert(),
    alertsKey,
    infoBadge: runningSubagents > 0 || (native.status.activity?.background ?? 0) > 0 || activeMemberRuns || Boolean(infoNotice),
    info: (
      <ImageSourceContext.Provider value={imageSource}>
      {infoNotice && <section className="edge-t p-1.5"><p className="flex gap-2 px-2.5 py-1.5 text-xs text-fg-2"><IconInfo className="mt-px size-3.5 shrink-0 text-fg-3" /><span className="min-w-0 break-words">{infoNotice}</span></p></section>}
      <FileAccessContext.Provider value={fileAccess}>
      <SubagentContext.Provider value={renderer}>
        <SubagentStoreContext.Provider value={native.subagents}>
          <NativeJobStoreContext.Provider value={native.jobs}>
            <ActivityContext.Provider value={activityControls}>
              {discussionAllowed && <SessionDiscussions parentId={session.id} onOpen={openDiscussion} />}
              {onOpenSession && <SessionCalls calls={calledSessions} onOpen={onOpenSession} />}
              {memberRuns.length > 0 && <SessionMemberRuns runs={memberRuns} onOpen={onOpenSession} />}
              {!quickChat && <SessionWorkActions subagentStore={native.subagents} jobStore={native.jobs} tasks={backgroundActivities} reportedBackground={native.status.activity?.background ?? 0} subagentBriefs={subagentBriefs} onOpenPath={onOpenPath} />}
              <SessionMarksSection sessionId={session.id} />
            </ActivityContext.Provider>
          </NativeJobStoreContext.Provider>
        </SubagentStoreContext.Provider>
      </SubagentContext.Provider>
      </FileAccessContext.Provider>
      </ImageSourceContext.Provider>
    ),
    status: statusSlot(),
    menu: [
      ...(!archived && working && backendCapabilities?.supportsInterrupt ? [{ id: 'stop-task', icon: <IconSquare />, label: native.interrupting ? t`正在停止` : t`停止任务`, disabled: native.interrupting || !native.connected, onSelect: stop }] : []),
      ...(native.status.profilePending && !archived ? [{
        id: 'apply-profile', icon: <IconRotateCw />, label: t`重启并应用`,
        hint: t`新配置将在后端重启后生效`, disabled: restartingBackend,
        onSelect: () => void restartBackend(),
      }] : []),
      // On a desktop the views are tabs under the title.
      ...(supportsTerminal && mobileViewport ? [{
        id: 'view',
        icon: view === 'chat' ? <IconSquareTerminal /> : <IconMessagesSquare />,
        label: view === 'chat' ? t`切换终端视图` : t`切换对话视图`,
        onSelect: () => latest.current.switchNativeView(),
      }] : []),
      { id: 'share', icon: <IconSquareArrowOutUpRight />, label: t`分享会话…`, onSelect: () => setDialog('share') },
      { id: 'pdf', icon: <IconFileText />, label: t`导出为 PDF…`, onSelect: () => setDialog('pdf') },
      ...(!quickChat && !archived && !live && !starting && !sendingInitial && native.statusKnown ? [{
        id: 'resume', icon: <IconRotateCw />, label: t({ message: '恢复会话', context: 'terminal-resume-session' }),
        disabled: reopenDisabled, onSelect: () => void reopen(),
      }] : []),
      ...(runtimeControl?.actions ?? []).flatMap((action) => {
        const label = localizedText(action.label);
        return label ? [{
          id: `runtime:${action.id}`, icon: <IconPuzzle />, label, hint: localizedText(action.hint),
          disabled: action.disabled || !runtimeActionsEnabled, onSelect: () => void runRuntimeAction(action),
        }] : [];
      }),
      // Either would start another conversation in the 助理's directory, which has one (docs/ASSISTANT.md §3).
      ...(quickChat || archived || assistant ? [] : [
        ...(session.handedOffTo ? [] : [{ id: 'handoff', icon: <IconArrowRightLeft />, label: t`交接会话…`, onSelect: () => setDialog('handoff') }]),
        { id: 'automation', icon: <IconBookmarkPlus />, label: t`存为自动化…`, onSelect: () => setDialog('automation') },
      ]),
    ],
  }), [assistant, working, backendCapabilities?.supportsInterrupt, native.interrupting, native.connected, stop, openDiscussion, runningSubagents, activeMemberRuns, memberRuns, onOpenSession, discussionAllowed, native.status.profilePending, restartingBackend, restartBackend, renderHeader, imageSource, fileAccess, renderer, native.subagents, native.jobs, activityControls, backgroundActivities, changeView, subagentOpen, native.context, approval, backendCapabilities?.permissions, native.status.activity?.background, infoNotice, subagentBriefs, onOpenPath, headerStatus, tabbedAlert, connectingLong, connectionNotice, supportsTerminal, view, archived, quickChat, session.handedOffTo, runtimeControl, runtimeActionsEnabled, runRuntimeAction, runtimeProgressShown, runtimeActionPending, reopen, reopenDisabled, held, repairingNativeModel, pickerBlocked, native.retryConnection, drawer, terminalLive, live, starting, sendingInitial, native.statusKnown, mobileViewport, session.id, switcher, prefs.placement, viewsKey, offered, alertsKey, t]);
  const dialogs = (
    <>
      {(dialog === 'share' || dialog === 'pdf') && <ShareDialog key={dialog} sessionId={session.id} title={session.title} purpose={dialog} open onOpenChange={(open) => { if (!open) setDialog(undefined); }} />}
      <HandoffDialog open={dialog === 'handoff'} onOpenChange={(open) => setDialog(open ? 'handoff' : undefined)} session={session} backends={backends} working={working} onLaunched={(result) => onLaunched?.(result)} onError={onError} />
      <SaveAutomationDialog open={dialog === 'automation'} onOpenChange={(open) => setDialog(open ? 'automation' : undefined)} session={session} backends={backends} onError={onError} />
    </>
  );

  // Where this conversation came from reads as its first line, the way a branched chat names its
  // parent, and where it went as its last line: both are part of the transcript, not fixed bars,
  // since a handed-off conversation can still be continued here.
  const parentId = session.origin?.kind === 'fork' || session.origin?.kind === 'handoff' || session.origin?.kind === 'call' ? session.origin.sessionId : undefined;
  const parent = parentId ? findSession?.(parentId) : undefined;
  const owner = useLists((state) => state.owner);
  const parentMember = parent
    ? (parent.agentMemberId
      ? teamMembers.find((item) => item.id === parent.agentMemberId)
      : teamMembers.find((item) => item.scope.kind !== 'project' && item.projectId === parent.projectId))
    : undefined;
  const parentAgentLabel = parentMember ? parentMember.name : parent ? labelOf(sessionBackend(parent)) : t`其他 Agent`;
  const callSender = useMemo<CallSenderInfo | undefined>(() => {
    if (session.origin?.kind !== 'call') return undefined;
    if (parentMember) {
      return { kind: 'member', name: parentMember.name, member: parentMember, ...(parent ? { sessionId: parent.id } : {}) };
    }
    return {
      kind: 'agent',
      name: parent ? (parent.displayTitle ?? parent.title ?? labelOf(sessionBackend(parent))) : t`其他 Agent`,
      ...(parent ? { backendId: sessionBackend(parent), sessionId: parent.id } : {}),
    };
  }, [session.origin?.kind, parentMember, parent, labelOf, t]);
  const resolveCallSender = useCallback((callId: string, agentName: string): CallSenderInfo => {
    const called = findSession?.(callId);
    const member = called?.agentMemberId
      ? teamMembers.find((item) => item.id === called.agentMemberId)
      : teamMembers.find((item) => item.name === agentName);
    if (member) {
      return { kind: 'member', name: member.name, member, sessionId: callId };
    }
    return {
      kind: 'agent',
      name: agentName || (called ? (called.displayTitle ?? called.title ?? labelOf(sessionBackend(called))) : t`其他 Agent`),
      ...(called ? { backendId: sessionBackend(called) } : {}),
      sessionId: callId,
    };
  }, [findSession, teamMembers, labelOf, t]);
  // Call sessions already attribute each message bubble to the calling member/Agent (`callSender`),
  // so only fork and handoff sessions need a top lineage banner.
  const runOwnerMember = session.origin?.kind === 'assistant'
    ? (session.agentMemberId
      ? teamMembers.find((item) => item.id === session.agentMemberId)
      : teamMembers.find((item) => !item.archivedAt && item.projectId === session.projectId)
        ?? teamMembers.find((item) => item.id === DEFAULT_AGENT_MEMBER_ID))
    : undefined;
  const runOwnerMainId = runOwnerMember?.mainSessionId;
  const lineage = parentId && session.origin?.kind !== 'call' ? (
    <div className="mb-6 flex items-center justify-center gap-1.5 text-xs text-fg-3">
      {session.origin?.kind === 'fork' ? <IconGitFork className="size-3.5" /> : <IconArrowRightLeft className="size-3.5" />}
      <span>{session.origin?.kind === 'fork' ? <Trans>来源会话</Trans> : <Trans>由 {parentAgentLabel} 交接自</Trans>}</span>
      {parent && onOpenSession
        ? <button type="button" className="max-w-64 truncate rounded px-0.5 text-fg-2 underline-offset-2 hover:text-fg hover:underline" onClick={() => onOpenSession(parent.id)}>{parent.title}</button>
        : <span className="text-fg-4"><Trans>已删除的会话</Trans></span>}
    </div>
  ) : session.origin?.kind === 'assistant' && runOwnerMainId && onOpenSession ? (
    <div className="mb-6 flex items-center justify-center gap-1.5 text-xs text-fg-3">
      <span><Trans>后台任务</Trans></span>
      <span>·</span>
      <button type="button" className="max-w-64 truncate rounded px-0.5 text-fg-2 underline-offset-2 hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => onOpenSession(runOwnerMainId)}>
        <Trans>返回 {runOwnerMember?.name}</Trans>
      </button>
    </div>
  ) : undefined;
  const successor = session.handedOffTo ? findSession?.(session.handedOffTo) : undefined;
  const successorAgentLabel = successor ? labelOf(sessionBackend(successor)) : t`其他 Agent`;
  const handedOff = session.handedOffTo ? (
    <div className="mt-6 flex items-center justify-center gap-1.5 text-xs text-fg-3">
      <IconArrowRightLeft className="size-3.5" />
      <span><Trans>已交接给 {successorAgentLabel}，在新会话中继续。</Trans></span>
      {successor && onOpenSession && <button type="button" className="rounded px-0.5 text-fg-2 underline-offset-2 hover:text-fg hover:underline" onClick={() => onOpenSession(successor.id)}><Trans>打开</Trans></button>}
    </div>
  ) : null;

  const dots = switcher && prefs.placement === 'dots' ? <ViewDots views={views} value={view} onChange={changeView} /> : null;
  // One strip under every view, keyed so switching views keeps this very element: the dots stay on
  // the session's centre line instead of following the composer's column in one view and the full
  // width in another.
  const placed = dotsPlaced || view !== 'chat';
  // Over a plugin's view the strip floats on its ground, so the plane runs to the panel's edge.
  const dotsBar = dots && (
    <div key="view-dots" className={cn('flex h-6 shrink-0 items-center justify-center', view !== 'chat' && view !== 'terminal' && 'pointer-events-none absolute inset-x-0 bottom-0 z-10')}>
      <div
        className={cn('duration-[var(--duration-base)] ease-out-soft motion-reduce:transition-none', placed ? 'transition-[opacity,transform]' : 'pointer-events-none opacity-0')}
        style={{ transform: `translateX(${dotsShift}px)` }}
      >{dots}</div>
    </div>
  );

  /** What the chat view's composer and the one a session view draws in place both take: one draft, one way of sending. */
  const composerProps: ComposerProps = {
    feedback: steerUnavailable ? <>
        {steerUnavailable && <div className="flex items-center gap-3 px-1 text-xs text-fg-3"><span><Trans>当前任务暂不接受补充</Trans></span><button type="button" className="underline underline-offset-2" onClick={() => setQueueOverride(runningTargetKey)}><Trans>加入队列</Trans></button></div>}
    </> : undefined,
    projectId: session.projectId,
    draftKey: session.id,
    enterBehavior: enterBehavior,
    ...(quickChat ? {} : { mobileSettingsPrefix: approvalSummary }),
    mobileSettingsLabel: cleanLabel(catalog.find((item) => item.value === parseSelection(backendSelection(backendId, catalog, session.model)).model)?.name ?? t({ message: '选择模型', context: 'terminal-model-picker-label' })),
    disabled: archived,
    submitDisabled: held || sendingInitial || starting || switchingApproval || switchingModel || native.sending || native.interrupting || native.hasUnknownSubmission,
    placeholder: archived ? t`会话已归档` : busy ? submitIntent === 'steer' ? t`补充当前任务…` : t`输入下一条消息…` : t`输入消息…`,
    pickersDisabled: pickersBlocked,
    ...(pickerBlocked ? { pickersBlockedReason: pickerBlocked } : {}),
    toolbar: quickChat ? undefined : approvalPicker,
    toolsPicker,
    endPickers: modelPicker,
    modelsLoading: catalogLoading && !catalog.length,
    modelsError: catalogError || (!catalogLoading && !catalog.length ? t`没有可用模型` : ''),
    ...(quickChat ? {} : { usage: native.context }),
    ...(compactCommand ? { onCompact: compactContext, compacting, compactDisabled } : {}),
    commands: slashCommands,
    inlineSkills: slash.catalog?.inlineSkills ?? backendCapabilities?.inlineSkills,
    onSlashMenuOpen: slash.refresh,
    fileMentions: !quickChat && !assistant && Boolean(root),
    sessionMentions: !quickChat && sessionReferences && backendCapabilities?.supportsSessionReferences === true,
    agentMentions,
    referenceSessions: referenceSessions,
    referenceProjects: referenceProjects,
    recipientSessionId: session.id,
    onOpenReferenceSession: onOpenSession,
    unknownCommandHint: t`发送给 ${backendLabel}`,
    references: references,
    onReferencesChange: onReferencesChange,
    running: working,
    backgroundCount: backgroundCount,
    onStop: (native.control ? native.control.activeTurn?.canStop || (backgroundCount > 0 && Boolean(backendCapabilities?.supportsInterrupt)) : backendCapabilities?.supportsInterrupt) ? stop : undefined,
    stopping: native.interrupting,
    stopDisabled: archived || !live || (native.control ? !(native.control.activeTurn?.canStop || (backgroundCount > 0 && Boolean(backendCapabilities?.supportsInterrupt))) : !backendCapabilities?.supportsInterrupt) || starting || native.sending || native.interrupting,
    submitIntent: submitIntent,
    onSubmit: submit,
    ...(sendLaterEnabled && !quickChat && !archived ? { onSendLater: sendLater } : {}),
    onError: onError,
  };

  if (view !== 'chat') {
    // The terminal's toolbar leaves the switcher's place free, so they read as one bar.
    const plugin = view === 'terminal' ? undefined : offered.find((entry) => entry.id === view);
    const pane = view === 'terminal' && terminalPane('min-h-0 flex-1', mobileViewport ? (
      <Tip label={t`切换对话视图`}><Button size="icon-xs" variant="quiet" aria-label={t`切换对话视图`} className="no-hover:size-11" onClick={switchNativeView}><IconMessagesSquare /></Button></Tip>
    ) : undefined);
    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        {header}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {plugin ? (
            <ComposerSlotContext.Provider value={archived || quickChat ? null : composerProps}>
              <PluginView entry={plugin} projectId={session.projectId} sessionId={session.id} composer={archived || quickChat ? undefined : SessionComposerSlot} />
            </ComposerSlotContext.Provider>
          ) : pane || (
            <EmptyState className="flex-1 pb-24" icon={<IconSquareTerminal />} title={t`终端未在运行`} description={t`重新打开 ${backendLabel} 后继续原生会话。`}>
              <Button variant="primary" disabled={reopenDisabled} onClick={() => void reopen()} busy={repairingNativeModel}><IconSquareTerminal /><Trans>重新打开</Trans></Button>
            </EmptyState>
          )}
        </div>
        {dotsBar}
        {dialogs}
      </div>
    );
  }


  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <div ref={sessionRef} className="@container relative flex min-h-0 flex-1">
      {/* Clipped sideways only: a column sliding after a step (`useSessionLayout`) stays off the aside,
          while menus opening above the composer still reach out. */}
      <div ref={readingColumnRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-clip">
      <div className={cn('pointer-events-none absolute inset-x-0 top-2 z-20', (subagentOpen || composerFullscreen) && 'hidden')}>
        <ContentColumn outside><FeedbackNotices scope={feedbackScope} messages={transientNotices} floating /></ContentColumn>
      </div>
      <ActivityContext.Provider value={activityControls}>
      <ImageSourceContext.Provider value={imageSource}>
      <FileAccessContext.Provider value={fileAccess}>
      <SubagentContext.Provider value={renderer}>
      <SubagentStoreContext.Provider value={native.subagents}>
      <AgentCallsProvider sessionId={session.id} projectId={session.projectId} onOpenSession={onOpenSession}>
      <NativeJobStoreContext.Provider value={native.jobs}>
        {/*
          Hidden rather than unmounted while a subagent page is open, so returning keeps the place.
          In fullscreen the conversation stays visible — the design keeps it readable on purpose —
          but `inert` takes it out of the tab order and out of the pointer's way, so the only editing
          surface is the one the user is looking at. Reading still works: the composer hands the
          transcript the wheel deltas its own draft cannot spend through the session's explicit
          scroll handle, so the transcript coordinates reader intent and position together.
        */}
        {session.origin?.kind === 'attempt' && !subagentOpen && (
          <AttemptStrip session={session} findSession={findSession} onOpenSession={onOpenSession} onAdopted={onAttemptAdopted} onOpenGroup={onOpenAttemptGroup} onError={onError} />
        )}
        <div
          className={cn('flex min-h-0 flex-1 flex-col', subagentOpen && 'hidden')}
          inert={composerFullscreen || undefined}
          aria-hidden={composerFullscreen || undefined}
        >
        <SessionMarksContext.Provider value={marks}>
        <ShareSessionContext.Provider value={shareSession}>
        <MessageCommandsContext.Provider value={messageCommands}>
        <TranscriptView
          scrollHandleRef={transcriptScrollRef}
          sessionId={session.id}
          onOpenSession={onOpenSession}
          newTopicDivider={assistantMain}
          callSender={callSender}
          resolveCallSender={resolveCallSender}
          owner={owner}
          timeline={visibleTimeline}
          timelineVersion={native.timelineVersion}
          pendingConfirmationCount={interaction ? 1 : 0}
          metricsByRun={native.metricsByRun}
          resetVersion={native.resetVersion}
          turns={visibleTurns}
          turnsVersion={native.turnsVersion}
          outlineTarget={layout.nav === 'outline' && !subagentOpen ? outlineSlot : null}
          loaded={native.loaded}
          catchingUp={native.catchingUp}
          historyLoad={historyLoad}
          onRetryHistory={native.retryConnection}
          running={working}
          activeTurnId={native.status?.activeTurnId}
          root={root}
          onOpenPath={onOpenPath}
          onOpenInEditor={onOpenInEditor}
          hasMoreHistory={Boolean(native.history?.hasMore)}
          historyContextIncomplete={native.history?.contextIncomplete}
          historyStale={native.historyStale}
          loadingEarlier={native.loadingHistory}
          onLoadEarlier={native.loadOlder}
          hasMoreLater={native.hasMoreLater}
          loadingLater={native.loadingLater}
          onLoadLater={native.loadLater}
          onReaderEnd={native.readerAtEnd}
          onJumpToLatest={native.jumpToLatest}
          onLoadTurn={native.loadTurn}
          onFind={native.findInLane}
          onLoadPlace={native.loadPlace}
          onExpandRow={native.expandRow}
          onOpenTerminal={supportsTerminal && terminalLive && !drawer && !archived ? () => { setSubagentStack([]); autoOpened.current = false; setDrawer(true); } : undefined}
          onRetryNativeRun={run => native.retryNativeRun(run, assistantMain ? workbenchAppearanceConnection : undefined)}
          onCheckNativeRun={backendCapabilities?.supportsRecovery ? native.checkNativeRun : undefined}
          nativeRecoveries={native.recoveries}
          onContinueNativeRun={async run => {
            const recovery = native.recoveries[run.id];
            if (!recovery?.canContinue) return;
            const count = recovery.queuedRunIds.length;
            const label = count ? t`继续发送 ${count} 条消息` : t`继续对话`;
            if (await confirmDialog({ title: label, description: t`上一条消息是否已执行仍无法确认`, confirmLabel: label })) await native.continueNativeRun(run);
          }}
          onCancelNativeRun={native.cancelNativeRun}
          turnStatusByTurn={native.turnStatusByTurn}
          onRestoreNativeRun={async (run) => {
            const draft = await native.recoverNativeRun(run);
            if (!draft || !recipientAlive.current) return;
            setRestoreDraft({ text: draft.text, attachments: draft.attachments, context: draft.context, onPersisted: draft.onPersisted, nonce: Date.now() });
          }}
          onTurnAction={quickChat || archived || assistant ? undefined : turnAction}
          onDiscuss={discussionAllowed && !archived ? discuss : undefined}
          onQuote={archived || held ? undefined : quote}
          lead={lineage}
          runActionPending={runActionPending}
          focus={discussionFocus ?? focus}
          progress={native.interrupting || showWorking
            ? <WorkingIndicator startedAt={native.interrupting || sendingTurn ? undefined : workingSince} outputRate={native.interrupting || sendingTurn || !workingInTimeline ? undefined : native.status.outputRate} connected={native.connected} label={native.interrupting ? t`停止中` : compacting ? t`正在压缩上下文` : resumingTurn ? t`恢复中` : sendingTurn ? t`正在发送` : undefined} />
            : delegatedAgents + delegatedWorkflows > 0 && visibleTimeline.length > 0
              ? <BackgroundWorkIndicator
                  agents={delegatedAgents}
                  workflows={delegatedWorkflows}
                  onOpen={quickChat ? undefined : () => stores.ui.set({ sessionInfoOpen: true })}
                />
              : undefined}
          empty={!working && (
            <div className="flex flex-col items-center gap-2 py-24 text-center">
              <p className="text-xl font-semibold text-fg">{session.title}</p>
            </div>
          )}
        >
          {/* The parent card stays with its hidden transcript, preserving its draft and submission. */}
          {interaction && (
            <div data-pending-confirmation>
              <NativeInteractionCard
                key={`${session.id}:${interaction.id}`}
                sessionId={session.id}
                interaction={interaction}
                connected={native.connected}
                onRespond={respondInteraction}
                onSync={native.syncInteraction}
                onOpenTerminal={supportsTerminal ? () => { autoOpened.current = false; setDrawer(true); } : undefined}
              />
            </div>
          )}
          {/* With a terminal the header's pill opens it; a phone's header pill is not a button. */}
          <FeedbackNotice scope={feedbackScope} tone="warning" className="mt-5"
            message={unknownAttention && supportsTerminal && mobileViewport && t`${backendLabel} 正在等待操作。` + t`请打开终端继续。`}
            action={() => supportsTerminal && !drawer ? <Button size="xs" variant="secondary" onClick={() => setDrawer(true)}><Trans>打开终端</Trans></Button> : undefined} />
          {handedOff}
      </TranscriptView>
        </MessageCommandsContext.Provider>
        </ShareSessionContext.Provider>
        </SessionMarksContext.Provider>
        </div>
      {subagentOpen && (
        <SubagentSession
          stack={subagentStack}
          onBack={() => setSubagentStack((stack) => stack.slice(0, -1))}
          onClose={() => setSubagentStack([])}
          onOpen={openNestedSubagent}
          findEvent={findSubagentEvent}
          sessionId={session.id}
          sessionTitle={session.title}
          pendingConfirmation={Boolean(interaction)}
          root={root}
          onOpenPath={onOpenPath}
          onOpenInEditor={onOpenInEditor}
        />
      )}
      </NativeJobStoreContext.Provider>
      </AgentCallsProvider>
      </SubagentStoreContext.Provider>
      </SubagentContext.Provider>
      </FileAccessContext.Provider>
      </ImageSourceContext.Provider>

      {/* Opened by the reader or by an agent waiting on the terminal; either way it grows in, and its
          bottom gap travels with it so the composer below never moves on its own. */}
      {!mobileViewport && (
        <Collapse open={drawer && terminalLive} className={cn('shrink-0', subagentOpen && 'hidden')}>
          <ContentColumn outside className="flex h-[min(46vh,440px)] flex-col pb-2">
            {terminalPane('min-h-0 flex-1 overflow-hidden rounded-xl border border-line', (
              <Tip label={t({ message: '收起终端', context: 'terminal-collapse-terminal' })}><Button size="icon-xs" variant="quiet" aria-label={t({ message: '收起终端', context: 'terminal-collapse-terminal' })} onClick={() => { autoOpened.current = false; setDrawer(false); }}><IconMessagesSquare /></Button></Tip>
            ))}
          </ContentColumn>
        </Collapse>
      )}

      {mobileViewport && (
        <Dialog open={drawer && terminalLive && !subagentOpen} onOpenChange={(open) => { if (!open) { autoOpened.current = false; setDrawer(false); } }}>
          <DialogContent mobileFullscreen hideClose aria-describedby={undefined} className="p-0">
            <DialogTitle className="sr-only"><Trans>{backendLabel} 终端</Trans></DialogTitle>
            {terminalPane('min-h-0 flex-1 overflow-hidden', (
              <Tip label={t`返回对话`}><Button size="icon-xs" variant="quiet" aria-label={t`返回对话`} className="size-11" onClick={() => { autoOpened.current = false; setDrawer(false); }}><IconMessagesSquare /></Button></Tip>
            ))}
          </DialogContent>
        </Dialog>
      )}

      <ContentColumn outside className={cn('relative flex flex-col gap-2 pb-3 md:pb-5', dots && !composerFullscreen && 'md:pb-1', subagentOpen && 'hidden')}>
        <FeedbackNotices scope={feedbackScope} messages={standingNotices} recovered={native.connected && !connectionNotice && live}
          renderMessage={message => <FailureDetails text={message.text} detail={message.detail} />}
          action={message => message.id.startsWith('connection:')
            ? <Button size="xs" variant="secondary" onClick={native.retryConnection}><IconRotateCw /><Trans>重试连接</Trans></Button>
            : message.id.startsWith('session:') && banners.some(banner => banner.id === message.id) ? <Button size="xs" variant="secondary" disabled={reopenDisabled} busy={repairingNativeModel} onClick={() => void reopen()}>
              <IconRotateCw /><Trans context="terminal-resume-session">恢复会话</Trans>
            </Button> : undefined} />
        {/* The composer stays mounted, so its draft survives the hold; `contents` keeps its layout as it was. */}
        <div className={held ? 'hidden' : 'contents'} inert={held}>
          <Composer
            {...composerProps}
            autoFocus={!discussionOpen && !held}
            fullscreen={composerFullscreen && !held}
            onFullscreenChange={setComposerFullscreen}
            onTranscriptWheel={forwardTranscriptWheel}
            dock={dock}
            dockAttached={queueShown}
            restoreDraft={restoreDraft}
            quote={quoted}
          />
        </div>
        {held && <TerminalHoldBar session={session} />}

        {/* In the column's bottom padding, so the composer, its menus and its popovers keep their room. */}
      </ContentColumn>
      </ActivityContext.Provider>
      </div>
      {/* The column follows the session's width alone: what the conversation holds, or a subagent
          page covering it, never adds or removes it. */}
      {layout.aside === 'column' && (
        <SubagentContext.Provider value={renderer}>
          <ActivityContext.Provider value={activityControls}>
          <SessionAside
            projectId={session.projectId}
            outlineRef={setOutlineSlot}
            goal={goal}
            todos={todoEntries}
            subagentStore={native.subagents}
            jobStore={native.jobs}
            backgroundTasks={backgroundActivities}
            reportedBackground={native.status.activity?.background ?? 0}
            subagentBriefs={subagentBriefs}
            memberRuns={memberRuns}
            onOpenSession={onOpenSession}
            timeline={visibleTimeline}
            timelineVersion={native.timelineVersion}
            root={root}
            onOpenPath={onOpenPath}
            outputs={!assistant}
          />
          </ActivityContext.Provider>
        </SubagentContext.Provider>
      )}
      {/* 黑马跑酷, opened from the palette: in the room right of the composer, measured against this pane. */}
      {!composerFullscreen && !subagentOpen && <RunnerDock working={working} needsYou={needsYou} />}
      {(discussionMounted || discussionOpen) && discussionAllowed &&
        <DiscussionPanel
          parent={session}
          active={discussionOpen}
          source={discussionSource}
          onSourceConsumed={() => setDiscussionSource(undefined)}
          openRequest={discussionRequest}
          enterBehavior={enterBehavior}
          onClose={() => setDiscussionOpen(false)}
          onSessionChanged={onSessionChanged}
          onOpenSource={(source) => {
            setDiscussionFocus({ ...source.anchor, quote: source.quote });
            setDiscussionOpen(false);
          }}
          onBringBack={(text) => {
            setRestoreDraft({ text: text.split('\n').map(line => `> ${line}`).join('\n') + '\n\n', attachments: [], nonce: Date.now() });
            setDiscussionOpen(false);
          }}
        />}
      </div>
      {!composerFullscreen && dotsBar}
      {dialogs}
    </div>
  );
}
