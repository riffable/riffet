import { isDeepStrictEqual } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type {
  ModelInfo, NativeActivity, NativeBackendId, NativeContext, NativeInteraction, NativeInteractionResponse,
  NativeInteractionResult, NativeRunConfig, NativeRuntimeActionRequest, NativeRuntimeControl, NativeStatus, NativeStreamMessage, NativeWorkbenchEvent, NativeTurnTarget, Project, Run, Session, SessionGoal,
} from '../../../../../packages/contracts/src/index.js';
import type { CodexAppServerClient, CodexAppServerFactory, CodexAppServerOptions, JsonRpcServerRequest } from '../shared/codex-app-server.js';
import { NO_SERVER_RESPONSE } from '../shared/codex-app-server.js';
import { listWorkbenchAppServers, stopWorkbenchAppServerAt } from '../shared/app-server-daemons.js';
import { CodexDraftStream, messagePhase, type CodexDraftOptions } from './drafts.js';
import { codexFlavor, type CodexFlavor } from './flavors.js';
import { NotificationGate, type CodexObservation } from './observation.js';
import { findCodexRollout } from './rollout-usage.js';
import { normalizePlanEntries, parseRolloutPlan, type RolloutPlanSnapshot } from './rollout-plan.js';
import { notificationSpan, rolloutItemSpans, type ItemSpans } from './item-spans.js';
import { codexTrustArgs } from '../shared/cli-trust.js';
import { nativeModelEffort, nativeModelFast, parseNativeModelSelection, type NativeModelSelection } from '../shared/model-selection.js';
import { modelSourceOf, resolveSource } from '../shared/model-source.js';
import { TurnTracker, turnPhaseOf } from '../shared/turn-tracker.js';
import { DORMANT_POLL_MS, DormancyClock } from '../shared/dormancy.js';
import { turnMarkers } from './event-diff.js';
import { AppError } from '../../errors.js';
import { sameTerminalAppearance } from '../../terminal/appearance.js';
import { firstHumanMessage, firstMessageTitlePatch, isPromptTitle, nativeTitlePatch } from '../../session-title.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativePtyLaunchSpec, NativeControlMessage, NativeDispatchBinding, NativeInteractionReceipt } from '../types.js';
import { turnMetaId } from '../../journal/ingest.js';
import { activityEvent, isLiveActivity, withActivity } from '../../journal/activity.js';
import { CodexActivities } from './activities.js';
import type { CodexNativeCommand } from './commands.js';
import { projectCodexItem, rowTextKey, userMessageText } from './project-item.js';
import { CodexTurnMetering, CodexContextMeter, noteItemMeter, noteRequestWaitStart, noteRequestWaitEnd } from './metering.js';
import { CodexSubagents, type CodexSubagentFrame } from './subagents.js';
import { codexInvocation, codexInvocationFingerprint, codexTerminalEndpoint } from './endpoint.js';
import { CodexJournalSpace, journalOf, type CodexIngestState } from './journal-space.js';
import type { CodexLiveFeed, CodexThreadReader, CodexTurnPage, CodexTurnsRequest } from './transcript-source.js';
import type {
  TerminalEndpointState, CodexPendingInteraction, TurnRun, RpcThread, RpcTurn, RpcItem, RpcQuestion,
} from './types.js';
import {
  RESIDENT_EVENTS, MAX_EVENTS, ROUTINE_TURNS, IMPORT_PAGE_TURNS, TAIL_TURNS, TURN_CACHE_THREADS,
  THREAD_MATERIALIZATION_GRACE_MS, HISTORY_POLL_MS, HISTORY_FALLBACK_POLL_MS, ANSWER_CONFIRM_MS,
} from './runtime-limits.js';
import {
  stableTurnIdsOf, insertPlanEvent, mergeResidentEvents, shownTextRowsOf, extendCachedTurns, settleTurnPages, withinMaterializationGrace,
  planSnapshotForTurns, latestPlanTextOf, CodexHistoryReader,
} from './history-read.js';
import { threadStatusUpdate } from './thread-status.js';
import { codexGoal, sameGoal } from './goal.js';
import { requestIdString, toIso, str, finiteToken, asRecord, asArray, canonicalJson } from './util.js';
import {
  MAX_ROLLOUT_BYTES, normalizePermission, permissionOf, reportedTraePermission, sandboxPolicyOf, executableOf, runtimeFingerprintFor, runtimeScopeFingerprintFor, matchesRuntimeFingerprint, providerEnv, credentialDirFor, collaborationModeOf,
  probeAppServer, STEER_MIN_VERSIONS, supportsSteerVersion, TUI_TOKEN_ENV, permissionParamsOf, hasNativePermissions, riffetMcpOverride,
} from './config.js';
import { fastServiceTier, listModels, modelBackendVariant, resolveModelSelection } from './catalog.js';
import { extensionsOffNames } from '../../extensions/toggles.js';
import { codexStanding, standingProtects, standingThreadConfig, useStandingSkillRoots, type CodexStanding } from './standing.js';
import { readConfiguredMcpNames } from './extensions.js';
import { conversationServerOptions, newThreadRequest, spawnConversationServer, type CodexWarm, type ThreadStart } from './launch.js';
import type { RuntimeAttachment, RuntimeContext } from '@riffet/plugin-api';
import type { PluginRegistry } from '../../plugins/registry.js';
import {
  makePendingInteraction, commandApprovalDecision, questionInteraction, answerValues, elicitationContent, interactionFingerprint, asyncQuestionsOf, asyncQuestionInteraction,
  asyncAnswerText, modeChangeInteraction, asyncQuestionReply, isAsyncQuestionInteraction, parseAsyncQuestionReplies, type CodexAsyncQuestion,
} from './interactions.js';
import { CodexQuestionHistory, isCodexQuestionTool } from './question-history.js';
import {
  isCodexToolItem, projectStartedTool, projectCompletedTool, codexPlanNativeId,
  turnStatus, isFinalTurnStatus, userItemText,
  isProvisionalItemId, buildEvent, rolloutPlanNativeId, nativeTurnIdOf, type ItemSpan,
} from './transcript.js';
import {
  isMissingTerminalError, isUnmaterializedThreadError, isUnavailableSocket, isActiveWriterError, isTurnsListUnsupportedError,
  isEmptyThreadRolloutError, safeTurnError, safeProviderError,
} from './errors.js';
import { MESSAGE_ID_PREFIX, STEER_ELEMENT_PREFIX, commandIdOfMessageId, commandIdOfSteerPlaceholder, isTaggedMessageId } from './message-tag.js';


/** The plugins' runtime hooks, as `PluginRegistry` serves them. */
export type NativeRuntimeHooks = Pick<PluginRegistry, 'runtimeHooks'>;
type SavedAttachment = NonNullable<NonNullable<Session['nativeRuntime']>['attachment']>;

export class CodexSessionRuntime implements CodexThreadReader {
  transport?: CodexAppServerClient;
  nativeSessionId: string | undefined;
  terminalId: string | undefined;
  activeTurnId: string | undefined;
  /** The newest foreground turn observed ended, including native TUI turns with no command mapping. */
  private foregroundEndedTurnId: string | undefined;
  private dispatchCommandId: string | undefined;
  /** A written operation without a receipted turn may still start, even after its local wait ends. */
  private unboundNativeCommand: string | undefined;
  private nativeCommand?: {
    commandId: string;
    runId: string;
    config: NativeRunConfig;
    type: CodexNativeCommand['type'];
    transport: CodexAppServerClient;
    threadId: string;
    acknowledged: boolean;
    cancelled?: boolean;
    rejected?: boolean;
    foregroundEndedBeforeSend?: string;
    previousTurns: Set<string>;
    startedTurns: Set<string>;
    candidate?: string;
    userTurns: Set<string>;
    turnId?: string;
    resolve(turnId: string): void;
    reject(error: Error): void;
  };
  private readonly turn = new TurnTracker('starting', { activePollMs: HISTORY_POLL_MS, fallbackPollMs: HISTORY_FALLBACK_POLL_MS });
  status: NativeStatus = { phase: 'starting', connection: { state: 'reconnecting' }, history: { state: 'loading' } };
  interaction: NativeInteraction | undefined;
  private readonly pending = new Map<string, CodexPendingInteraction>();
  /** Questions the running turn asked without waiting; shown after any blocking request. */
  private asyncQuestions: CodexAsyncQuestion[] = [];
  private readonly seenAsyncItems = new Set<string>();
  private readonly sendingAsyncAnswers = new Set<string>();
  private readonly questionHistory = new CodexQuestionHistory();
  private readonly turnRuns = new Map<string, TurnRun>();
  /** Every confirmed input belongs to one execution; the owner remains its first input. */
  private readonly turnCommands = new Map<string, Set<string>>();
  private readonly turnConfigs = new Map<string, NativeRunConfig>();
  private readonly pendingTurnOutcomes = new Map<string, RpcTurn>();
  private readonly completionWaiters = new Map<string, Set<{ resolve(): void; reject(error: Error): void }>>();
  private readonly commandRuns = new Map<string, TurnRun>();
  private readonly listeners = new Set<(message: NativeControlMessage) => void>();
  private historyPoll: NodeJS.Timeout | undefined;
  private pollHealthy?: boolean;
  private pollDormant = false;
  /** Polls slow to `DORMANT_POLL_MS` once idle and unwatched; a client, a turn or a request brings the normal cadence back. */
  private readonly dormancy = new DormancyClock();
  private readonly events: NativeWorkbenchEvent[] = [];
  private readonly livePlanSnapshots = new Map<string, NativeWorkbenchEvent>();
  private readonly subagents: CodexSubagents;
  private readonly seenEvents = new Set<string>();
  /** Items explicitly committed by a notification; partial history must not undo them. */
  private readonly liveCompletedIds = new Set<string>();
  /**
   * Event numbering and the log's generation come from the session journal, so they outlive both a
   * rebuilt runtime and a restarted service: the same event keeps its number.
   */
  private space: CodexJournalSpace;
  /** The journal's own reader imports the thread (`transcript-source.ts`); this runtime keeps to the newest turns. */
  private readonly journalRead: boolean;
  /** Set while a batch of settled history is being projected for the journal rather than for listeners. */
  private importBatch: NativeWorkbenchEvent[] | undefined;
  private importTask: Promise<void> | undefined;
  private importStopped = false;
  /** Settled turns whose events are unchanged since the last read; their rows are not rewritten. */
  private stableTurnIds: ReadonlySet<string> = new Set();
  private transcriptLoaded = false;
  private historySnapshotReady = false;
  /** The name the thread itself last reported, or was last given. */
  private threadName: string | undefined;
  /** The name a `thread/name/set` in flight is giving the thread. */
  private pushingTitle: string | undefined;
  private opening?: Promise<string | undefined>;
  private attached = false;
  private transportBorrowed = false;
  private endpointSource: 'terminal' | 'binding' | 'spawn' = 'spawn';
  /** The saved endpoint this runtime found gone before spawning its own; it stays saved until a resume confirms the replacement. */
  private unreachableBinding: string | undefined;
  private loadedCheck: boolean | undefined;
  private loadedCheckAt = 0;
  private loadedCheckThreadId: string | undefined;
  private attachAttemptAt = 0;
  private terminalEndpointCheckedAt = 0;
  private terminalEndpointStateValue: TerminalEndpointState = 'absent';
  private terminalEndpointCheck?: Promise<TerminalEndpointState>;
  private endpointWriteConflict = false;
  private bindingScopeMismatch = false;
  /** Set when the app-server could not be shared privately, so no TUI may attach to it. */
  private terminalUnavailable = false;
  /** A colour change waiting for the turn to end before the TUI is relaunched to probe it. */
  private appearancePending = false;
  private readonly metering: CodexTurnMetering;
  private readonly drafts = new CodexDraftStream({
    ...(process.env.RIFFET_CODEX_STREAM_TIMING === '1' ? {
      timing: (sample: Parameters<NonNullable<CodexDraftOptions['timing']>>[0]) =>
        console.info('[codex-stream-timing]', JSON.stringify({ sessionId: this.session.id, ...sample })),
    } : {}),
    nextSequence: () => this.space.peekNext(),
    reserveSequence: () => undefined,
    persist: (finalId, event) => this.space.assignDraft(finalId, event),
    eventContext: turnId => {
      const run = this.turnRuns.get(turnId);
      return { sessionId: this.session.id, runId: run?.runId ?? turnId, createdAt: run?.createdAt ?? new Date().toISOString() };
    },
    send: () => undefined,
  });
  /** Context compactions and background terminals: live state, log rows and the status summary. */
  private readonly activities: CodexActivities;
  /** The journal's transcript source listening in (`transcript-source.ts`), when one does. */
  private feed: CodexLiveFeed | undefined;
  private refreshTask: Promise<NativeWorkbenchEvent[] | undefined> | undefined;
  private refreshQueued: Promise<NativeWorkbenchEvent[] | undefined> | undefined;
  private readonly usage: CodexContextMeter;
  private rolloutPlanCache?: { generation: string; snapshot?: RolloutPlanSnapshot };
  /** When the conversation thread's items happened, as its rollout last read says (`item-spans.ts`). */
  private itemSpans?: { threadId: string; spans: ItemSpans };
  /** The last complete turn list per thread, with the connection it was read over (see `TAIL_TURNS`). */
  /** Marker of each turn as of the last read, for telling which settled turns cannot have changed. */
  private turnMarkersSeen = new Map<string, string>();
  private readonly history: CodexHistoryReader;
  /** The rollout the provider itself reported for this thread (`thread.path`), when it did. */
  private rolloutPath: string | undefined;
  /** The model the thread last reported; Plan mode settings must name one. */
  private threadModel: string | undefined;
  private configuring = false;
  /** The recorded mode corresponding to the last observed native permissions, including customizations. */
  private nativeApproval: string | undefined;
  /** Native collaboration mode is independent of permission presets and browser configuration intent. */
  private nativeMode: string | undefined;
  private modeObservation = 0;
  private modeReconciliation: Promise<void> | undefined;
  private readonly modeRequests = new WeakMap<CodexPendingInteraction, { observation: number; decision?: string }>();
  private permissionObservation = 0;
  /** A sandbox other than the 助理's profile was named on the loaded thread (`standingProfile`). */
  private standingSandboxNamed = false;
  private readonly standingMoments = new Set<'start' | 'compact'>();
  /** The files each of the 助理's open file changes writes, by item: an approval request names only the item. */
  private readonly standingWrites = new Map<string, string[]>();
  private commandConfigObserver?: (settings: Record<string, unknown>) => void;
  private permissionSettings: Record<string, unknown> | undefined;
  /**
   * Messages steered into a running turn when the provider takes no tag for them (TRAE CLI). Each
   * waits to claim the next user item of its turn with the same text; `claimedItems` remembers the
   * claim so later reads of the same item resolve to the same command.
   */
  private readonly pendingSteers: Array<{ turnId: string; commandId: string; text: string }> = [];
  private readonly claimedItems = new Map<string, string>();
  /** The outcome each turn was first settled with; a later, different one is stale. */
  private readonly settledTurns = new Map<string, string>();
  /**
   * Rows projected from a running turn's positional items (`item-1`, `item-2`, …), by turn id. They
   * are the provider's provisional naming of items the settled read returns under their own ids.
   */
  private provisionalRows = new Map<string, string[]>();
  /** A provider notice that holds only while its condition does, such as a queue position. */
  private transientNotice: string | undefined;
  /**
   * The facts `refreshStatus` derives the published status from. `link` is what the app-server last
   * said about work outside a tracked turn; the phase is that, the interaction and the active turn.
   * The notice's source stays local: transport/history diagnostics have their own structured status.
   */
  private facts: {
    link: 'starting' | 'offline' | 'quiet' | 'working';
    connection?: NativeStatus['connection']; history?: NativeStatus['history']; approval?: string; model?: string;
    notice?: { text: string; level: NativeStatus['noticeLevel']; source: 'thread' | 'transient' | 'other' };
  } = { link: 'starting', connection: { state: 'reconnecting' }, history: { state: 'loading' } };
  private threadError = false;
  /** Only a root turn observed in the current activity can explain its thread's generic error. */
  private threadErrorTurnId: string | undefined;
  private connectionConflictSource?: 'profile' | 'endpoint';
  private readonly profileConfig: Record<string, unknown>;
  private profileFingerprint: string;
  private profilePending = false;
  private readonly scopeFingerprint: string;
  /** A plugin's sidecar on the native process, such as a routing proxy, with the plugin's id. */
  private attachment?: { owner: string; value: RuntimeAttachment };
  private detachObservation?: () => void;
  /** The thread a warm app-server was started with, until this conversation opens its first thread. */
  private warmThread?: CodexWarm;

  constructor(
    private readonly host: NativeBackendHost,
    private session: Session,
    private readonly project: Project,
    private readonly profile: NativeBackendProfileConfig,
    private readonly startAppServer: CodexAppServerFactory,
    private readonly flavor: CodexFlavor = codexFlavor,
    private readonly runtimeHooks?: NativeRuntimeHooks,
    /** Reports what shell commands change in the working tree (`observation.ts`); only Codex itself has the hooks it needs. */
    private readonly observation?: CodexObservation,
  ) {
    this.detachObservation = observation?.attach(session.id, () => this.nativeSessionId);
    // These describe the process we connected to. A later profile edit must not retroactively
    // change its launch identity or the fingerprint committed for that process.
    this.project = { ...project };
    this.session = { ...session };
    this.profile = { ...profile, config: structuredClone(profile.config) };
    this.nativeSessionId = session.nativeSessionId;
    // Sync v3 reads the thread into the journal (`transcript-source.ts`) once its ingest is attached to the
    // host; then this runtime writes nothing there and numbers in memory for its own bookkeeping.
    this.journalRead = host.transcript !== undefined && host.journal !== undefined;
    this.space = new CodexJournalSpace(journalOf(host), session.id, this.nativeSessionId, this.journalRead);
    // A complete log is ready the moment the runtime exists: numbering is known, and the newest
    // events are at hand before the app-server has answered anything.
    if (this.space.ready) {
      this.events.push(...this.space.tail(RESIDENT_EVENTS));
      for (const event of this.events) this.seenEvents.add(event.nativeId);
    }
    this.terminalId = session.terminalId;
    this.profileConfig = this.profile.config;
    this.profileFingerprint = runtimeFingerprintFor(this.project, this.profile, this.flavor);
    this.scopeFingerprint = runtimeScopeFingerprintFor(this.project, this.profile, this.flavor);
    this.history = new CodexHistoryReader({
      requireTransport: () => this.requireTransport(),
      label: () => this.label,
      subagents: () => this.subagents,
      dispatchCommandId: () => this.dispatchCommandId,
      foregroundEndedTurnId: () => this.foregroundEndedTurnId,
      routineWindow: () => this.space.ready || (this.journalRead && this.space.initialized),
    });
    this.subagents = new CodexSubagents({
      readTurns: threadId => this.history.readTurns(threadId),
      readThread: (threadId, includeTurns) => this.history.readThread(threadId, includeTurns),
      projectChildItem: (item, turn, childThreadId) => this.projectChildItem(item, turn, childThreadId),
      turnCompleted: (threadId, turn) => this.completeTurnWaiters(turn.id, threadId),
      emit: message => this.emit(message),
    });
    this.usage = new CodexContextMeter({
      contextUsage: this.flavor.contextUsage,
      emit: message => { for (const listener of this.listeners) listener(message); },
      threadId: () => this.nativeSessionId,
      transport: () => this.transport,
      bindingScopeMismatch: () => this.bindingScopeMismatch,
      rolloutFile: threadId => this.rolloutFile(threadId),
      contextUsed: used => this.activities.noteContext(used),
    });
    this.metering = new CodexTurnMetering({
      sessionId: session.id,
      host,
      turnRun: turnId => this.turnRuns.get(turnId),
      userMessageId: turnId => this.events.find(event => event.type === 'user_message_chunk'
        && event.nativeId.startsWith(`${this.nativeSessionId ?? 'unknown'}:${turnId}:`))?.nativeId,
      model: () => this.status.model,
      emit: message => this.emit(message),
    });
    this.activities = new CodexActivities({
      flavor: this.flavor,
      sessionId: this.session.id,
      threadId: () => this.nativeSessionId,
      transport: () => this.transport?.isOnline ? this.transport : undefined,
      journal: () => journalOf(this.host),
      contextUsed: () => this.usage.context?.used,
      rolloutFile: threadId => this.rolloutFile(threadId),
      write: (activity, turnId) => this.writeActivity(activity, turnId),
      // The journal's reader follows background terminals too, whether or not a v2 client listens.
      hasListeners: () => this.listeners.size > 0 || (this.feed !== undefined && this.feed.active?.() !== false),
    });
  }

  get label(): string { return this.flavor.label; }

  /** The id a submitted message is tagged with, in the field the provider echoes back. */
  private messageTagOf(commandId: string): string {
    return this.flavor.messageTag.echo === 'id' ? `${MESSAGE_ID_PREFIX}${commandId}` : commandId;
  }

  /** The workbench command a user item answers, or undefined for a message typed in the TUI. */
  private commandIdOf(item: RpcItem, turnId: string | undefined): string | undefined {
    if (item.type !== 'userMessage') return undefined;
    if (this.flavor.messageTag.echo === 'clientId') return str(item.clientId);
    const id = str(item.id);
    if (!id) return undefined;
    if (isTaggedMessageId(id)) return commandIdOfMessageId(id);
    const parts = asArray<Record<string, unknown>>(item.content);
    const markers = parts.filter(part => part.type === 'text').flatMap(part =>
      asArray<Record<string, unknown>>(part.text_elements).filter(element => commandIdOfSteerPlaceholder(str(element.placeholder)) !== undefined)
        .map(element => ({ element, text: str(part.text) ?? '' })));
    if (markers.length) {
      // A tag alone is not a receipt. Require the original persisted write fence, exact text and
      // metadata in this same provider turn; this also works after a Riffet restart.
      if (markers.length !== 1 || !turnId || !this.nativeSessionId) return undefined;
      const { element, text } = markers[0]!;
      const range = asRecord(element.byteRange);
      const commandId = commandIdOfSteerPlaceholder(element.placeholder as string);
      if (!commandId || range?.start !== 0 || range.end !== 0 || userMessageText(item) !== text) return undefined;
      const run = this.host.findRunsByNativeTurn?.(this.session.id, this.nativeSessionId, turnId).find(candidate =>
        candidate.commandId === commandId && candidate.sessionId === this.session.id
        && candidate.native?.intent === 'steer' && candidate.native.backendId === this.flavor.id
        && candidate.native.nativeSessionId === this.nativeSessionId && candidate.native.nativeTurnId === turnId
        && candidate.native.baselineSequence !== undefined && candidate.native.renderedText === text
        && !['queued', 'preparing'].includes(candidate.native.delivery)
        && !['steer_rejected', 'acknowledged', 'cancelled'].includes(candidate.native.stage ?? ''));
      return run?.commandId;
    }
    const claimed = this.claimedItems.get(id);
    if (claimed) return claimed;
    const text = userItemText(item).trim();
    const index = this.pendingSteers.findIndex(steer => (!turnId || steer.turnId === turnId) && steer.text.trim() === text);
    if (index < 0) return undefined;
    const [steer] = this.pendingSteers.splice(index, 1);
    this.claimedItems.set(id, steer!.commandId);
    if (this.claimedItems.size > 256) this.claimedItems.delete(this.claimedItems.keys().next().value!);
    return steer!.commandId;
  }

  /** Keeps what a thread record says about itself: where its rollout is, which model it runs. */
  private noteThread(thread: RpcThread | undefined, settings?: Record<string, unknown>): void {
    if (!thread) return;
    if (str(thread.path) && isAbsolute(thread.path!)) this.rolloutPath = thread.path!;
    // start/resume report the effective model at the response's top level, not inside Thread.
    const model = str(settings?.model) ?? str(thread.model);
    if (model) this.threadModel = model;
  }

  private adoptApproval(settings: Record<string, unknown> | undefined): void {
    if (this.flavor.id !== 'traex' || this.configuring) return;
    const session = this.host.getSession(this.session.id);
    if (session.configPending) return;
    const approval = reportedTraePermission(settings);
    if (settings?.approvalPolicy !== undefined && settings.approvalsReviewer !== undefined) {
      this.nativeApproval = approval ?? normalizePermission(session.approval, this.flavor.id);
    }
    if (!approval) {
      // Keep the configured intent as the inheritance fence, but do not label extended/native
      // permission profiles as a bare built-in preset. Only an explicit picker change replaces it.
      if (this.hasNativePermissions(settings)) this.refreshStatus({ approval: 'custom' });
      return;
    }
    if (approval !== session.approval) {
      const updated = this.host.bumpConfig(session.id, { approval });
      this.emit({ type: 'session', session: updated });
    }
    this.session = this.host.getSession(this.session.id);
    this.refreshStatus({ approval });
  }

  private hasNativePermissions(settings: Record<string, unknown> | undefined): boolean {
    return hasNativePermissions(settings);
  }

  private adoptMode(mode: string | undefined): void {
    if (this.flavor.id !== 'traex' || !mode || !this.flavor.modes.some(option => option.id === mode)) return;
    // Even same-value settings are observations, but this counter is only a read fence: it
    // cannot order a provider's settings event against its independently resolved mode request.
    this.nativeMode = mode;
    this.modeObservation += 1;
    const session = this.host.getSession(this.session.id);
    if (session.mode !== mode) {
      this.emit({ type: 'session', session: this.host.bumpConfig(session.id, { mode }) });
      this.session = this.host.getSession(session.id);
    }
  }

  private adoptSettingsMode(settings: Record<string, unknown> | undefined): void {
    const model = str(settings?.model);
    if (model) this.threadModel = model;
    this.adoptMode(str(asRecord(settings?.collaborationMode)?.mode));
  }

  /** Read effective settings without selecting a mode/model or resuming the native execution. */
  private async reconcileMode(threadId: string): Promise<void> {
    const transport = this.transport;
    if (this.flavor.id !== 'traex' || !transport?.isOnline || this.nativeSessionId !== threadId) return;
    // ThreadSettingsUpdateParams has only threadId required; omitted overrides leave settings
    // unchanged. Its current-settings response is the protocol's readback (there is no get RPC).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const observation = this.modeObservation;
      try {
        const response = await transport.request<{ threadSettings?: Record<string, unknown> | null }>('thread/settings/update', { threadId });
        if (this.transport !== transport || !transport.isOnline || this.nativeSessionId !== threadId) return;
        if (this.modeObservation !== observation) continue;
        this.adoptSettingsMode(response.threadSettings ?? undefined);
        return;
      } catch { return; } // Empty legacy replies/outages leave the last actual observation intact.
    }
  }

  private async rolloutFile(threadId: string): Promise<string | undefined> {
    return this.rolloutPath ?? await findCodexRollout(this.flavor.stateHome(this.profileConfig), threadId);
  }

  matches(project: Project, profile: NativeBackendProfileConfig): boolean {
    return !this.profilePending && runtimeFingerprintFor(project, profile, this.flavor) === this.profileFingerprint;
  }

  belongsTo(project: Project, profile: NativeBackendProfileConfig): boolean {
    return runtimeScopeFingerprintFor(project, profile, this.flavor) === this.scopeFingerprint && !this.bindingScopeMismatch;
  }

  canRunWith(project: Project, profile: NativeBackendProfileConfig): boolean {
    return this.belongsTo(project, profile) && !this.endpointWriteConflict;
  }

  syncSessionBinding(session: Session, project: Project, profile: NativeBackendProfileConfig): void {
    if (session.terminalId && session.terminalId !== this.terminalId) {
      this.terminalId = session.terminalId;
      this.terminalEndpointCheckedAt = 0;
    }
    // The fingerprint belongs to the process, not the latest profile. A restored profile clears
    // the pending state without rewriting that process's identity or replacing its connection.
    this.profilePending = !matchesRuntimeFingerprint(this.profileFingerprint, project, profile, this.flavor);
    if (!this.profilePending && !session.nativeRuntime?.scopeFingerprint) this.bindingScopeMismatch = false;
    if (this.belongsTo(project, profile) && !this.endpointWriteConflict
      && this.connectionConflictSource === 'profile' && this.status.connection?.state === 'conflict') {
      this.setConnection({ state: this.attached ? 'connected' : 'disconnected' });
      return;
    }
    this.refreshStatus();
  }

  /** The session's saved endpoint names another app-server than this one, and not the one it already found gone. */
  bindingMoved(address: string | undefined): boolean {
    return Boolean(address && address !== this.transport?.remoteAddress && address !== this.unreachableBinding);
  }

  deferForProfileChange(): void {
    const message = `The ${this.label} profile changed. Restore the previous profile or explicitly end its ${this.label} backend, then retry.`;
    this.setConnection({ state: 'conflict', message }, 'profile');
  }

  deferWriteBlocked(project: Project, profile: NativeBackendProfileConfig): { code: string; message: string } {
    if (!this.belongsTo(project, profile)) {
      this.deferForProfileChange();
      return {
        code: 'NATIVE_PROFILE_CHANGED',
        message: `The ${this.label} profile changed. Restore the previous profile or explicitly end its ${this.label} backend, then retry.`,
      };
    }
    this.deferForEndpointConflict();
    return {
      code: 'NATIVE_ENDPOINT_CONFLICT',
      message: this.endpointConflictMessage(),
    };
  }

  private assertWritable(): void {
    if (this.bindingScopeMismatch) throw new AppError('NATIVE_PROFILE_CHANGED', `The previous ${this.label} profile must be restored or its backend explicitly ended before this thread can be resumed.`, 409);
    if (this.endpointWriteConflict) throw new AppError('NATIVE_ENDPOINT_CONFLICT', this.endpointConflictMessage(), 409);
  }

  private endpointConflictMessage(): string {
    return this.terminalEndpointStateValue === 'changed'
      ? `This ${this.label} terminal is connected to a different backend.`
      : `This ${this.label} terminal's backend connection could not be verified.`;
  }

  /**
   * Writes stay blocked either way, but only a terminal proven to use another app-server is a
   * conflict. One that could not be verified yet is retried and reads as reconnecting.
   */
  private endpointConnection(): NonNullable<NativeStatus['connection']> {
    return { state: this.terminalEndpointStateValue === 'changed' ? 'conflict' : 'reconnecting', message: this.endpointConflictMessage() };
  }

  /** Writes wait for the terminal's endpoint to be verified again. */
  get endpointBlocked(): boolean { return this.endpointWriteConflict; }

  private deferForEndpointConflict(): void {
    const message = this.endpointConflictMessage();
    if (!this.endpointWriteConflict || this.status.connection?.message !== message) {
      this.logRecovery('terminal', this.transport?.remoteAddress ?? 'unknown', 'verify', this.terminalEndpointStateValue === 'changed' ? 'changed' : 'unverified', false);
    }
    this.endpointWriteConflict = true;
    this.setConnection(this.endpointConnection(), 'endpoint');
  }

  get projectCwd(): string { return this.project.cwd; }

  /** The actual writer's launch profile, independent of the next provider the user selected. */
  get launchProfile(): NativeBackendProfileConfig { return this.profile; }

  /** The source model for rollback, including saved dimensions when they still name that model. */
  get currentModel(): string | undefined {
    const selected = this.status.model ?? (!this.session.backendProfileId || this.session.backendProfileId === this.profile.id ? this.session.model : undefined);
    return selected && (!this.threadModel || parseNativeModelSelection(selected).model === this.threadModel)
      ? selected : this.threadModel ?? str(this.profileConfig.defaultModel);
  }

  get canSwitchProfile(): boolean {
    return !this.activeTurnId && !this.dispatchCommandId && !this.currentInteraction
      && this.status.phase !== 'busy' && this.status.phase !== 'attention'
      && ![...this.subagents.values()].some(child => child.running)
      && !this.activities.ledger.list().some(isLiveActivity)
      && this.host.getSession(this.session.id).goal?.status !== 'active';
  }

  profileSwitchFailed(message: string): void {
    this.refreshStatus({ notice: { text: message, level: 'error', source: 'other' } });
  }

  /**
   * Lets go of the thread for a new topic (docs/ASSISTANT.md §5.5): what it wrote is read into the journal, the TUI
   * that shows it stops and the app-server unloads it. The app-server stays, for the thread that follows. Only an idle
   * thread is left; the caller holds the session lock and replaces this runtime afterwards.
   */
  async leaveThread(): Promise<string> {
    const busy = () => new AppError('CLI_BUSY', 'The current task is still running; start a new topic when it finishes.', 409);
    const threadId = this.nativeSessionId;
    if (!threadId || !this.attached) throw new AppError('NATIVE_SESSION_NOT_STARTED', 'This conversation has not started yet', 409);
    if (!this.canSwitchProfile) throw busy();
    this.assertWritable();
    const transport = this.requireTransport();
    await this.host.transcript?.drain(this.session.id);
    if (!this.canSwitchProfile) throw busy();
    if (this.terminalId) {
      const terminalId = this.terminalId;
      this.terminalId = undefined;
      this.host.updateSession(this.session.id, { terminalId: undefined });
      await this.host.terminal.stop(terminalId).catch(() => undefined);
    }
    await transport.request('thread/unsubscribe', { threadId }).catch(() => undefined);
    return threadId;
  }

  /** Release only an idle, verified owner; a provider change never interrupts its current work. */
  async releaseForProfileSwitch(): Promise<boolean> {
    if (!this.canSwitchProfile) return false;
    await this.terminalEndpointState(true);
    this.assertWritable();
    const transport = this.requireTransport();
    const threadId = this.nativeSessionId;
    const binding = this.host.getSession(this.session.id).nativeRuntime;
    const loaded = threadId ? await this.loadedThread(threadId, true) : undefined;
    if (loaded === false && !this.transportBorrowed) {
      // A saved owner was already gone and this reader spawned an unloaded replacement.
      await this.dispose(this.host);
      return true;
    }
    if (!threadId || binding?.address !== transport.remoteAddress || loaded !== true) {
      throw new AppError('NATIVE_LAUNCH_ABORTED', 'The existing backend could not be verified; it was left running.', 409);
    }
    const idle = async () => {
      const thread = await this.history.readThread(threadId, false);
      return thread?.id === threadId && thread.status?.type !== 'active' && this.canSwitchProfile;
    };
    if (!await idle()) return false;
    await this.host.transcript?.drain(this.session.id);
    if (!await idle()) return false;
    this.assertWritable();
    const current = this.host.getSession(this.session.id);
    if (current.nativeSessionId !== threadId || current.nativeRuntime?.address !== binding.address
      || current.nativeRuntime.fingerprint !== binding.fingerprint || this.transport !== transport) {
      throw new AppError('NATIVE_LAUNCH_ABORTED', 'The backend binding changed during restart; no backend was stopped.', 409);
    }
    // Reattached Unix clients have no process handle. Stop only the verified Riffet-owned daemon.
    if (this.transportBorrowed && !transport.processId
      && !await stopWorkbenchAppServerAt(binding.address, [credentialDirFor(this.flavor)])) {
      throw new AppError('NATIVE_LAUNCH_ABORTED', 'The existing backend process could not be verified; it was left running.', 409);
    }
    await this.dispose(this.host);
    return true;
  }

  /** Explicit user action, never called by a reader or by ordinary reconnect/send. */
  async restartBackend(expected: string, address: string): Promise<boolean> {
    const binding = this.host.getSession(this.session.id).nativeRuntime;
    if (!binding || binding.fingerprint !== expected || binding.address !== address || !this.profilePending) return false;
    await this.terminalEndpointState(true);
    this.assertWritable();
    const transport = this.requireTransport();
    const assertTarget = () => {
      const current = this.host.getSession(this.session.id);
      if (current.nativeRuntime?.fingerprint !== expected || current.nativeRuntime.address !== address
        || current.nativeSessionId !== this.nativeSessionId || this.transport !== transport || !transport.isOnline || !this.profilePending) {
        throw new AppError('NATIVE_LAUNCH_ABORTED', 'The backend binding changed during restart; no backend was stopped.', 409);
      }
      this.assertWritable();
    };
    if (binding.address !== transport.remoteAddress || !this.nativeSessionId
      || await this.loadedThread(this.nativeSessionId, true) !== true) {
      throw new AppError('NATIVE_LAUNCH_ABORTED', 'The existing backend could not be verified; it was left running.', 409);
    }
    const stopBorrowed = this.transportBorrowed && !transport.processId;
    if (stopBorrowed && !(await listWorkbenchAppServers([credentialDirFor(this.flavor)])).some(server => server.address === binding.address)) {
      throw new AppError('NATIVE_LAUNCH_ABORTED', 'The existing backend process could not be verified; it was left running.', 409);
    }
    assertTarget();
    await this.interrupt();
    await this.host.transcript?.drain(this.session.id);
    assertTarget();
    // A borrowed Unix connection has no process handle. Only a verified Riffet process group
    // may be stopped; closing the socket alone must never be mistaken for stopping its owner.
    if (stopBorrowed
      && !await stopWorkbenchAppServerAt(binding.address, [credentialDirFor(this.flavor)])) {
      throw new AppError('NATIVE_LAUNCH_ABORTED', 'The existing backend process could not be verified; it was left running.', 409);
    }
    await this.dispose(this.host);
    // The durable binding stays until a replacement resumes the same native thread. start()
    // still probes it, so a surviving listener cannot produce a second writer.
    return true;
  }

  /**
   * `warm` hands over an app-server with a new thread started ahead of this conversation (`launch.ts`);
   * it is asked only by a conversation that has no thread and no process of its own yet.
   */
  async start(optionsOnly: { reconnectOnly?: boolean; warm?: () => Promise<CodexWarm | undefined> } = {}): Promise<void> {
    let runtime: CodexSessionRuntime | undefined;
    const binding = this.session.nativeRuntime;
    const launchChanged = Boolean(binding?.fingerprint && !matchesRuntimeFingerprint(binding.fingerprint, this.project, this.profile, this.flavor));
    this.bindingScopeMismatch = Boolean(binding?.scopeFingerprint && binding.scopeFingerprint !== this.scopeFingerprint);
    const gate = new NotificationGate();
    const handlers: Pick<CodexAppServerOptions, 'onNotification' | 'onServerRequest' | 'onExit'> = {
      // A command's completion waits for its PostToolUse record, and everything after it waits behind it.
      onNotification: (method, params) => gate.push(this.observation?.hold(method, params), () => runtime?.onNotification(method, params)),
      onServerRequest: request => runtime?.onServerRequest(request) ?? Promise.reject(new Error(`${this.label} runtime is not ready`)),
      // An exit is taken after a completion held before it, or the completion would land on a runtime that has let go.
      onExit: error => gate.push(undefined, () => runtime?.onExit(error)),
    };
    const options = await conversationServerOptions(this.project, this.profile, this.flavor, this.observation, handlers);
    runtime = this;
    const threadId = this.nativeSessionId;
    const terminalAddress = threadId && this.terminalId
      ? await this.terminalEndpoint(this.terminalId, threadId).catch(() => undefined)
      : undefined;
    const candidates: Array<{ address: string; source: 'terminal' | 'binding' }> = [];
    if (terminalAddress) candidates.push({ address: terminalAddress, source: 'terminal' });
    if (binding?.address && !candidates.some(candidate => candidate.address === binding.address)) {
      candidates.push({ address: binding.address, source: 'binding' });
    }

    let lastAttachError: unknown;
    for (const candidate of candidates) {
      try {
        this.transport = await this.startAppServer({ ...options, remoteAddress: candidate.address });
        this.transportBorrowed = true;
        this.endpointSource = candidate.source;
        if (binding?.address === candidate.address && launchChanged) {
          this.profileFingerprint = binding.fingerprint;
          this.profilePending = true;
          // Old rows have only a launch hash. A verified terminal proves their cwd/thread; a
          // headless owner must prove both through the protocol before relaxing the old gate.
          if (!binding.scopeFingerprint && !terminalAddress) {
            const thread = threadId ? await this.history.readThread(threadId, false).catch(() => undefined) : undefined;
            const [storedCwd, projectCwd] = await Promise.all([
              thread?.cwd ? realpath(thread.cwd).catch(() => undefined) : undefined,
              realpath(this.project.cwd).catch(() => undefined),
            ]);
            this.bindingScopeMismatch = !threadId || await this.loadedThread(threadId, true) !== true
              || thread?.id !== threadId || !storedCwd || storedCwd !== projectCwd;
          }
        } else if (launchChanged) {
          this.bindingScopeMismatch = true;
        }
        this.logRecovery(candidate.source, candidate.address, 'connect', 'connected', false);
        break;
      } catch (error) {
        lastAttachError = error;
        this.logRecovery(candidate.source, candidate.address, 'connect', isUnavailableSocket(error) ? 'unreachable' : 'failed', false);
        // A terminal's verified endpoint can still be the active owner even when this socket
        // failed. Try only another durable endpoint; never create a second writer in that case.
        if (!isUnavailableSocket(error)) throw error;
      }
    }

    if (!this.transport) {
      if (optionsOnly.reconnectOnly) throw new AppError('STEER_TARGET_CHANGED', `The existing ${this.label} endpoint is unavailable; the instruction was not sent.`, 409);
      if (terminalAddress) {
        const error = lastAttachError ?? new Error(`The verified ${this.label} terminal endpoint is unavailable`);
        this.facts = { link: 'offline', connection: { state: 'failed', message: `The ${this.label} terminal endpoint could not be reached.` }, history: { state: 'error', message: `${this.label} history could not be loaded from the running terminal.` } };
        this.status = { phase: this.turnPhase('offline'), connection: this.facts.connection, history: this.facts.history };
        throw error;
      }
      // Only a definitively gone endpoint permits a replacement. Its binding is retained until
      // the replacement confirms the original thread id.
      this.bindingScopeMismatch = false;
      this.profilePending = false;
      this.profileFingerprint = runtimeFingerprintFor(this.project, this.profile, this.flavor);
      if (binding?.address && lastAttachError && !isUnavailableSocket(lastAttachError)) throw lastAttachError;
      if (binding?.address && lastAttachError) {
        this.logRecovery('binding', binding.address, 'connect', 'unreachable', false);
        this.unreachableBinding = binding.address;
      }
      const warm = !binding && !threadId && !this.terminalId ? await optionsOnly.warm?.() : undefined;
      let spawnedTransport: CodexAppServerClient | undefined;
      try {
        if (warm) {
          warm.attach(handlers);
          spawnedTransport = warm.transport;
          this.terminalUnavailable ||= warm.terminalUnavailable;
          this.warmThread = warm;
        } else {
          await this.prepareAttachment();
          if (this.attachment) options.env = { ...options.env, ...this.attachment.value.launchEnv };
          const spawned = await spawnConversationServer(this.startAppServer, this.flavor, options);
          spawnedTransport = spawned.transport;
          this.terminalUnavailable ||= spawned.terminalUnavailable;
        }
        this.transport = spawnedTransport;
        await this.attachment?.value.bindNative({ address: spawnedTransport.remoteAddress, pid: spawnedTransport.processId });
      } catch (error) {
        await spawnedTransport?.dispose();
        this.transport = undefined;
        await this.releaseAttachment(false);
        throw error;
      }
      this.transportBorrowed = false;
      this.endpointSource = 'spawn';
      this.logRecovery('spawn', this.transport.remoteAddress, 'connect', 'connected', false);
    }
    // A sidecar a previous server left on this very process comes back only through the plugin that made it.
    const saved = this.transportBorrowed && binding?.address === this.transport.remoteAddress ? binding?.attachment : undefined;
    const owned = saved && this.runtimeHooks?.runtimeHooks(this.flavor.id).find(item => item.owner === saved.hook);
    if (binding && saved && owned) {
      const value = await owned.hook.recover({ ...this.runtimeContext(binding.fingerprint), id: saved.id, address: this.transport.remoteAddress }).catch(() => undefined);
      if (value) this.attachment = { owner: owned.owner, value };
    }
    // Riffet's observation hooks run only once confirmed; a conversation without a TUI is confirmed here.
    await this.observation?.trust(this.transport, this.project.cwd).catch(() => undefined);
    await this.terminalEndpointState(true);
    // Opening the app-server socket is not proof that this client owns the native thread. A
    // cold history reader remains offline until it explicitly resumes a confirmed loaded owner.
    this.facts = {
      link: 'offline',
      connection: this.endpointWriteConflict
        ? this.endpointConnection()
        : this.bindingScopeMismatch
        ? { state: 'conflict', message: `The ${this.label} profile changed. Restore the previous profile or explicitly end its ${this.label} backend, then retry.` }
        : { state: 'disconnected' },
      history: { state: 'loading' },
    };
    this.status = {
      phase: this.turnPhase('offline'),
      connection: this.facts.connection,
      history: this.facts.history,
      ...(this.profilePending ? { profilePending: true } : {}),
    };
    const control = this.runtimeControl();
    if (control) this.status.runtimeControl = control;
  }

  private runtimeContext(fingerprint: string): RuntimeContext {
    return {
      sessionId: this.session.id, fingerprint, profileConfig: this.profileConfig,
      // `<backend>/routes` predates hooks; routes already running are found there.
      directory: join(credentialDirFor(this.flavor), '..', 'routes'),
      onChange: () => this.refreshStatus(),
    };
  }

  /** The first hook that attaches to the process about to spawn. One that fails leaves the process as launched. */
  private async prepareAttachment(): Promise<void> {
    for (const { owner, hook } of this.runtimeHooks?.runtimeHooks(this.flavor.id) ?? []) {
      try {
        const value = await hook.prepare(this.runtimeContext(this.runtimeFingerprint));
        if (value) { this.attachment = { owner, value }; return; }
      } catch (error) {
        console.warn(`[riffet] plugin ${owner} did not attach to ${this.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** `keep` leaves the sidecar serving a native process that outlives this runtime. */
  private async releaseAttachment(keep: boolean): Promise<void> {
    const attachment = this.attachment?.value;
    this.attachment = undefined;
    try {
      if (keep) attachment?.detach();
      else await attachment?.stop();
    } catch { /* Plugin code is not ours: its failure cannot fail a teardown. */ }
  }

  /** The model the sidecar's control is shown for. */
  private controlModel(status: NativeStatus = this.status): string | undefined {
    return parseNativeModelSelection(status.model ?? this.threadModel ?? this.session.model).model || undefined;
  }

  /** The sidecar's control on this conversation. Plugin code: one that throws shows nothing. */
  private runtimeControl(status?: NativeStatus): NativeRuntimeControl | undefined {
    const attachment = this.attachment;
    if (!attachment?.value.control) return undefined;
    try {
      const control = attachment.value.control({ model: this.controlModel(status) });
      return control ? { ...control, owner: attachment.owner } : undefined;
    } catch { return undefined; }
  }

  async runtimeAction(request: NativeRuntimeActionRequest): Promise<void> {
    this.assertWritable();
    const attachment = this.attachment?.value;
    if (!attachment?.act || !this.transport?.isOnline) throw new AppError('RUNTIME_CONTROL_UNAVAILABLE', 'The native process is not connected to its sidecar', 409);
    try {
      await attachment.act({ ...request, model: this.controlModel() });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('RUNTIME_CONTROL_UNAVAILABLE', 'The sidecar cannot be reached', 503);
    } finally {
      this.refreshStatus();
    }
  }

  private get runtimeFingerprint(): string {
    return this.profileFingerprint;
  }

  /**
   * `override` carries a configuration change that has not reached `this.session` yet: the runtime
   * only ever holds the snapshot it was constructed with, while `configure` merges its patch with
   * the store's current intent. Without it, opening first on the snapshot would create or resume the
   * thread on the previous model/approval and only correct it with a follow-up request — wrong on
   * the wire, and a real defect for any reader that adopts what the first response reported.
   */
  async openOrResume(override?: { model?: string; approval?: string }): Promise<string> {
    const source = modelSourceOf(this.profileConfig);
    const reason = source && resolveSource(source, this.profileConfig).reason;
    if (reason && !this.transportBorrowed) throw new AppError('NATIVE_MODEL_SOURCE_UNAVAILABLE', reason, 409);
    this.assertWritable();
    while (this.opening) {
      const opened = await this.opening;
      if (opened) return opened;
    }
    this.assertWritable();
    if (this.nativeSessionId && this.transport?.isOnline && this.attached) return this.nativeSessionId;
    const task = (async () => {
      const transport = this.requireTransport();
      const existingId = this.nativeSessionId;
      const current = this.host.getSession(this.session.id);
      const requestedModel = override?.model ?? current.model ?? str(this.profileConfig.defaultModel);
      // A saved selector may predate a provider rename; resolve it against the live catalog before
      // the thread is created or resumed, so the provider never sees the retired spelling.
      const selection = await resolveModelSelection(transport, this.flavor, parseNativeModelSelection(requestedModel));
      const permission = permissionOf(override?.approval ?? current.approval, this.flavor.id);
      let thread: RpcThread;
      let settings: Record<string, unknown> | undefined;
      let permissionObservation = this.permissionObservation;
      const modeObservation = this.modeObservation;
      if (existingId) {
        const observed = await this.history.readThread(existingId, false).catch(() => undefined);
        const active = this.activeTurnId !== undefined || this.status.phase === 'busy' || observed?.status?.type === 'active';
        try {
          permissionObservation = this.permissionObservation;
          const response = active
            ? await transport.request<{ thread: RpcThread } & Record<string, unknown>>('thread/resume', {
              threadId: existingId, cwd: this.project.cwd, excludeTurns: true,
            })
            : await this.resumeWithConfiguration(existingId, selection,
              this.flavor.id === 'traex' && override?.approval === undefined && !current.configPending ? undefined : permission);
          thread = response.thread;
          settings = response;
        } catch (error) {
          this.noteConnectionFailure(error);
          this.logRecovery(this.endpointSource, transport.remoteAddress, 'resume', isActiveWriterError(error) ? 'conflict' : 'failed', false);
          await this.discardFailedTransport();
          throw error;
        }
      } else {
        // A warm thread started for the same model and permission is this conversation's first thread.
        const warm = this.warmThread;
        this.warmThread = undefined;
        try {
          const response = warm && warm.model === requestedModel && warm.approval === permission.id ? warm.thread : await this.startThread(selection, permission);
          thread = response.thread;
          settings = response;
        } catch (error) {
          this.noteConnectionFailure(error);
          this.logRecovery(this.endpointSource, transport.remoteAddress, 'start', isActiveWriterError(error) ? 'conflict' : 'failed', false);
          await this.discardFailedTransport();
          throw error;
        }
      }
      if (!thread?.id) {
        const error = new Error(`${this.label} app-server did not return a thread id`);
        this.noteConnectionFailure(error);
        this.logRecovery(this.endpointSource, transport.remoteAddress, existingId ? 'resume' : 'start', 'missing-thread-id', false);
        await this.discardFailedTransport();
        throw error;
      }
      if (existingId && thread.id !== existingId) {
        const error = new Error(`${this.label} app-server resumed a different thread`);
        this.noteConnectionFailure(error);
        this.logRecovery(this.endpointSource, transport.remoteAddress, 'resume', 'wrong-thread', false);
        await this.discardFailedTransport();
        throw error;
      }
      this.attached = true;
      this.nativeSessionId = thread.id;
      // A newly created thread has no older transcript to seed before accepting live events.
      if (!existingId) {
        // A new thread of a conversation that may have had others: the 助理 is told what it lacks (§5.1).
        if (this.isStanding()) this.standingMoments.add('start');
        this.history.startMaterialization(thread.id);
        this.space.adoptThread(thread.id);
        if (!this.space.initialized) { this.space.bind('real'); this.space.writeState({ phase: 'ready', turns: 0 }); this.space.markInitialized(); }
      }
      this.noteThread(thread, this.modeObservation === modeObservation ? settings : undefined);
      if (this.permissionObservation === permissionObservation) this.adoptApproval(settings);
      if (this.modeObservation === modeObservation) this.adoptSettingsMode(settings);
      // A different thread is a different window: the old numbers must not be repainted under it.
      this.usage.reset();
      this.adoptProviderTitle(typeof thread.name === 'string' ? thread.name : undefined);
      this.host.setNativeSessionId(this.session.id, thread.id);
      void this.readGoal(thread.id);
      this.applyThreadStatus(thread.status);
      if (this.facts.link === 'offline' || this.facts.link === 'starting') this.refreshStatus({ link: 'quiet' });
      // Commit the durable endpoint only after Codex confirms the requested thread id. History is
      // a separate read path: a transcript error must not undo an established writer binding.
      await this.commitRuntimeBinding(transport, thread.id);
      this.setConnection({ state: 'connected' });
      this.logRecovery(this.endpointSource, transport.remoteAddress, existingId ? 'resume' : 'start', 'confirmed', true);
      await this.refreshEvents().catch(error => this.noteHistoryFailure(error));
      return thread.id;
    })();
    this.opening = task;
    try { return await task; }
    finally { if (this.opening === task) this.opening = undefined; }
  }

  /** Explicit opens and observer resumes must preserve the same durable native/attachment association. */
  private async commitRuntimeBinding(transport: CodexAppServerClient, threadId: string): Promise<void> {
    const current = this.host.getSession(this.session.id);
    const previous = current.nativeRuntime;
    const attachment = this.attachment ? { hook: this.attachment.owner, id: this.attachment.value.id }
      : this.transportBorrowed && previous?.address === transport.remoteAddress ? previous?.attachment : undefined;
    // A sidecar that cannot bind says so in its own control; the native writer stays verified.
    try { await this.attachment?.value.bindNative({ address: transport.remoteAddress, nativeSessionId: threadId }); }
    catch { /* reported by the plugin */ }
    // A control outage must not erase a verified native writer or lose the attachment needed on reconnect.
    this.host.updateSession(this.session.id, {
      ...(this.flavor.id === 'codex' && current.configPending && current.backendProfileId === this.profile.id ? { configPending: false } : {}),
      nativeRuntime: {
        address: transport.remoteAddress, fingerprint: this.runtimeFingerprint, scopeFingerprint: this.scopeFingerprint,
        profileId: this.profile.id, ...(attachment ? { attachment } : {}),
      },
    });
  }

  private async resumeWithConfiguration(threadId: string, selection: NativeModelSelection, permission: ReturnType<typeof permissionOf> | undefined): Promise<{ thread: RpcThread } & Record<string, unknown>> {
    const standing = await this.standingThread();
    const effort = nativeModelEffort(selection);
    const serviceTier = fastServiceTier(this.flavor, selection.model, nativeModelFast(selection));
    const backendVariant = modelBackendVariant(this.flavor, selection);
    const config = {
      ...(effort && effort !== 'default' ? { model_reasoning_effort: effort } : {}),
      ...(backendVariant ? { model_backend_variant: backendVariant } : {}),
      ...this.riffetMcpConfig(),
      ...await this.extensionsOffConfig(),
      ...standing?.config,
    };
    return await this.requireTransport().request<{ thread: RpcThread } & Record<string, unknown>>('thread/resume', {
      ...standing?.instructions,
      threadId,
      cwd: this.project.cwd,
      model: selection.model || null,
      ...(permission ? this.permissionParams(permission, 'sandbox', true) : {}),
      ...(serviceTier ? { serviceTier } : {}),
      ...(Object.keys(config).length ? { config } : {}),
      excludeTurns: true,
    });
  }

  /**
   * The 助理's isolation (`standing.ts`), given again at every start and resume: a resumed thread keeps nothing of the
   * last one's overrides, and the directory's files may have changed since. Undefined for any other conversation.
   */
  private async standingThread(): Promise<{ instructions: { baseInstructions: string; developerInstructions: string }; config: Record<string, unknown> } | undefined> {
    const standing = this.standing();
    if (!standing) return undefined;
    const transport = this.requireTransport();
    await useStandingSkillRoots(transport, standing);
    const riffet = Object.keys(this.riffetMcpConfig()).map(key => key.slice('mcp_servers.'.length));
    return {
      instructions: { baseInstructions: standing.baseInstructions, developerInstructions: standing.developerInstructions },
      config: await standingThreadConfig(transport, this.project.cwd, standing, riffet),
    };
  }

  private isStanding(): boolean {
    return this.flavor.id === 'codex' && Boolean(this.host.standing?.launch(this.project, this.host.getSession(this.session.id)));
  }

  /** The 助理's isolation when this is one of its conversations (`standing.ts`); TRAE's app-server is not isolated. */
  private standing(): CodexStanding | undefined {
    return this.flavor.id === 'codex' ? codexStanding(this.host.standing?.launch(this.project, this.host.getSession(this.session.id))) : undefined;
  }

  /**
   * Whether the 助理's permission profile is the sandbox in force: in the workspace-write preset, until a sandbox of
   * another mode was named on the loaded thread, which stays in force over the profile until the thread is loaded
   * again. Then the preset is named instead, without the profile's read-only files (docs/ASSISTANT.md §4.1).
   */
  private standingProfile(permission: ReturnType<typeof permissionOf>): boolean {
    if (!this.isStanding()) return false;
    if (permission.sandbox !== 'workspace-write') { this.standingSandboxNamed = true; return false; }
    return !this.standingSandboxNamed;
  }

  /** The moments the 助理 has not been told of yet (`StandingMoment`): a new thread, a summarized one. Taken once. */
  takeStandingMoments(): Array<'start' | 'compact'> {
    const moments = [...this.standingMoments];
    this.standingMoments.clear();
    return moments;
  }

  /**
   * The conversation's Riffet MCP server as a per-thread override (docs/DEVICES.md §2). The dotted
   * key adds one server beside the reader's own; the CLI's config files are never written. The
   * app-server starts MCP servers itself, outside the command sandbox, so no network opening is needed.
   */
  private riffetMcpConfig(): Record<string, unknown> {
    const server = this.host.riffetMcp?.server(this.session.id);
    return riffetMcpOverride(server);
  }

  /**
   * The MCP servers this conversation switched off (docs/EXTENSIONS.md), as per-thread overrides. Skills the owner
   * switched off stay in the CLI's own configuration; only the 助理's thread switches skills off itself (`standing.ts`).
   */
  private async extensionsOffConfig(): Promise<Record<string, unknown>> {
    // A dotted key cannot carry a dot inside a server name; the CLI's own names never have one.
    const names = extensionsOffNames(this.host.getSession(this.session.id).extensionsOff, 'mcp').filter(name => /^[\w-]+$/.test(name));
    if (!names.length) return {};
    // The app-server refuses a thread whose config names an MCP server the configuration does not define (a stale or
    // handed-over name, or a plugin's server), so only defined names reach it. If the config cannot be read, nothing
    // is switched off rather than risking the launch.
    let known: Set<string>;
    try { known = await readConfiguredMcpNames(this.requireTransport(), this.project.cwd); }
    catch { return {}; }
    return Object.fromEntries(names.filter(name => known.has(name)).map(name => [`mcp_servers.${name}.enabled`, false]));
  }

  private async startThread(selection: NativeModelSelection, permission: ReturnType<typeof permissionOf>): Promise<{ thread: RpcThread } & Record<string, unknown>> {
    const standing = await this.standingThread();
    const config = { ...this.riffetMcpConfig(), ...await this.extensionsOffConfig(), ...standing?.config };
    return await this.requireTransport().request<ThreadStart>('thread/start',
      newThreadRequest(this.flavor, this.project.cwd, selection, this.permissionParams(permission, 'sandbox', true), config, standing?.instructions));
  }

  /**
   * The launch of a terminal client joining this runtime's app-server, or undefined where the build
   * or the endpoint offers no shared transport. `ensureTui` starts it as Riffet's own terminal;
   * `terminalLaunch` hands it to the reader's terminal.
   */
  async tuiLaunchSpec(): Promise<NativePtyLaunchSpec | undefined> {
    if (!this.transport) return undefined;
    // A recovered old process has no recoverable launch config beyond its hash. Do not launch a
    // new remote TUI with the edited provider flags; the protocol conversation remains usable.
    if (this.transportBorrowed && this.profilePending) return undefined;
    const probe = await probeAppServer(executableOf(this.profile, this.flavor));
    const shared = this.flavor.terminalTransport(probe);
    if (shared === 'none' || this.terminalUnavailable) return undefined;
    const address = this.transport.remoteAddress;
    if (shared === 'ws' ? !address.startsWith('ws:') || !this.transport.authToken : !address.startsWith('unix:')) return undefined;
    const token = shared === 'ws' ? this.transport.authToken : undefined;
    const command = executableOf(this.profile, this.flavor);
    // Riffet's own observation hooks are confirmed on the server first, so the TUI does not ask
    // about them each time it starts; a failure leaves the CLI's prompt as the fallback.
    await this.observation?.trust(this.transport, this.project.cwd).catch(() => undefined);
    // Directory trust is a global override, so it stays ahead of `resume`. Review of other hooks
    // remains the CLI's own prompt, lifted into Riffet by TerminalDialogObserver; the CLI persists
    // each trusted hook hash. Disable the separate startup update prompt, which otherwise returns
    // after every Codex release until the reader dismisses it in the terminal.
    const args = [
      ...this.flavor.args(this.profileConfig), ...codexTrustArgs(this.project.cwd), '-c', 'check_for_update_on_startup=false',
      '--remote', address, ...(token ? ['--remote-auth-token-env', TUI_TOKEN_ENV] : []),
      // Riffet scrolls tmux history. A full-screen TUI leaves that history empty, so use the
      // CLI's inline mode when this installed build advertises it.
      ...(probe.noAltScreen ? ['--no-alt-screen'] : []),
      '--cd', this.project.cwd, 'resume', this.nativeSessionId!,
    ];
    const invocation = codexInvocation([command, ...args], this.project.cwd, this.nativeSessionId!);
    return {
      command,
      args,
      env: this.flavor.env(this.profileConfig),
      ...(token ? { secretEnv: { [TUI_TOKEN_ENV]: token } } : {}),
      cwd: this.project.cwd,
      title: this.label,
      // Recovery still matches the live pane's argv and cwd; this only rules out a look-alike launch.
      ...(invocation ? { launchMarker: codexInvocationFingerprint(invocation) } : {}),
    };
  }

  async ensureTui(): Promise<string | undefined> {
    // While a terminal holds the conversation it is the only client; Riffet's own TUI must not come back.
    if (this.host.getSession(this.session.id).terminalHold) return undefined;
    this.assertWritable();
    if (!this.transport) return undefined;
    let existing: Awaited<ReturnType<NativeBackendHost['terminal']['get']>> | undefined;
    if (this.terminalId) {
      try { existing = await this.host.terminal.get(this.terminalId); }
      catch (error) {
        if (!isMissingTerminalError(error)) {
          this.deferForEndpointConflict();
          throw new AppError('NATIVE_ENDPOINT_CONFLICT', `The ${this.label} terminal state could not be verified, so no new terminal was started.`, 409);
        }
      }
    }
    if (existing?.state === 'running') {
      // The write gate just verified this terminal. Reuse that short-lived proof instead of
      // scanning the same process tree again and turning a transient timeout into a conflict.
      const state = await this.terminalEndpointState(true);
      if (state === 'verified') return existing.id;
      // A running TUI may be the only remaining owner of this thread. Never replace it based on
      // an in-memory transport identity or a profile change; the terminal worker verifies the
      // actual endpoint when it can.
      this.deferForEndpointConflict();
      throw new AppError('NATIVE_ENDPOINT_CONFLICT', this.endpointConflictMessage(), 409);
    }
    if (existing && existing.state !== 'exited') {
      this.deferForEndpointConflict();
      throw new AppError('NATIVE_ENDPOINT_CONFLICT', `A ${this.label} terminal is still changing state and its endpoint is not verified.`, 409);
    }
    const spec = await this.tuiLaunchSpec();
    if (!spec) return undefined;
    const terminal = await this.host.launchPty(this.session, this.project, spec);
    this.terminalId = terminal.id;
    this.terminalEndpointCheckedAt = 0;
    return terminal.id;
  }

  /**
   * Relaunches the remote TUI so it probes the session's current terminal colours: Codex reads them
   * once at startup and keeps its diff and composer palette for the life of the process. The thread
   * lives in the app-server, so the new TUI resumes it unchanged. A turn in flight is never cut off;
   * the relaunch waits for it to settle. Callers hold the session lock.
   */
  async relaunchTuiForAppearance(): Promise<void> {
    if (this.activeTurnId || this.dispatchCommandId || this.interaction || this.status.phase === 'busy' || this.status.phase === 'attention') {
      this.appearancePending = true;
      return;
    }
    this.appearancePending = false;
    const terminalId = this.terminalId;
    if (!terminalId || !this.transport?.isOnline || this.terminalUnavailable || this.profilePending) return;
    const current = await this.host.terminal.get(terminalId).catch(() => undefined);
    const wanted = this.host.getSession(this.session.id).terminalAppearance;
    if (!current || current.state !== 'running' || !wanted || sameTerminalAppearance(current.appearance, wanted)) return;
    // Stop the old TUI only where `ensureTui` will launch its successor: a writable runtime whose
    // terminal is verified on this endpoint, and a build that still offers a remote TUI on it.
    if (this.host.getSession(this.session.id).terminalHold) return;
    try { this.assertWritable(); } catch { return; }
    if (await this.terminalEndpointState(true) !== 'verified') return;
    const shared = this.flavor.terminalTransport(await probeAppServer(executableOf(this.profile, this.flavor)));
    const address = this.transport?.remoteAddress;
    if (!address || shared === 'none' || (shared === 'ws' ? !address.startsWith('ws:') || !this.transport?.authToken : !address.startsWith('unix:'))) return;
    await this.host.terminal.stop(terminalId);
    await this.ensureTui();
  }

  async terminalEndpointState(force = false): Promise<TerminalEndpointState> {
    if (!this.terminalId || !this.nativeSessionId || !this.transport?.remoteAddress) return this.confirmTerminalEndpoint('absent');
    if (this.terminalEndpointCheck) {
      const checking = this.terminalEndpointCheck;
      const state = await checking;
      if (!force || state !== 'unknown') return state;
      if (this.terminalEndpointCheck === checking) this.terminalEndpointCheck = undefined;
      // Another caller may already have started the fresh check while this one was waiting.
      if (this.terminalEndpointCheck) return await this.terminalEndpointCheck;
    }
    const elapsed = Date.now() - this.terminalEndpointCheckedAt;
    if (this.terminalEndpointCheckedAt && elapsed < 2_500 && (!force || elapsed < 750)
      && (!force || this.terminalEndpointStateValue !== 'unknown')) return this.terminalEndpointStateValue;
    const task = (async () => {
      // A read-only scan can time out while tmux or the event loop is busy. A user action gets
      // one fresh retry, but a changed endpoint or two unverified scans still block every write.
      for (let attempt = 0; attempt < (force ? 2 : 1); attempt += 1) {
        const terminalId = this.terminalId;
        const threadId = this.nativeSessionId;
        const address = this.transport?.remoteAddress;
        let state: TerminalEndpointState = 'unknown';
        try {
          if (!terminalId || !threadId || !address) state = 'absent';
          else {
            let terminal: Awaited<ReturnType<NativeBackendHost['terminal']['get']>> | undefined;
            try { terminal = await this.host.terminal.get(terminalId); }
            catch (error) { if (!isMissingTerminalError(error)) throw error; }
            if (!terminal || terminal.state === 'exited') state = 'absent';
            else if (terminal.state === 'running') {
              const endpoint = await this.terminalEndpoint(terminalId, threadId);
              state = endpoint ? endpoint === address ? 'verified' : 'changed' : 'unknown';
            }
          }
        } catch { /* Retry an unverified scan without sending or replacing anything. */ }
        // A scan of a previous binding cannot verify the terminal selected while it was in flight.
        if (terminalId !== this.terminalId || threadId !== this.nativeSessionId || address !== this.transport?.remoteAddress) continue;
        if (state === 'unknown') continue;
        if (state === 'changed') {
          this.terminalEndpointStateValue = state;
          this.terminalEndpointCheckedAt = Date.now();
          this.deferForEndpointConflict();
        } else {
          this.confirmTerminalEndpoint(state);
        }
        return state;
      }
      this.terminalEndpointStateValue = 'unknown';
      this.terminalEndpointCheckedAt = Date.now();
      this.deferForEndpointConflict();
      return 'unknown' as const;
    })();
    this.terminalEndpointCheck = task;
    try { return await task; }
    finally { if (this.terminalEndpointCheck === task) this.terminalEndpointCheck = undefined; }
  }

  private confirmTerminalEndpoint(state: 'absent' | 'verified'): 'absent' | 'verified' {
    const wasBlocked = this.endpointWriteConflict;
    this.endpointWriteConflict = false;
    this.terminalEndpointStateValue = state;
    this.terminalEndpointCheckedAt = Date.now();
    if (this.bindingScopeMismatch || (this.status.connection?.state === 'conflict' && this.connectionConflictSource !== 'endpoint')) return state;
    this.connectionConflictSource = undefined;
    if (this.attached) {
      this.refreshStatus({ link: this.resumed(), connection: { state: 'connected' } });
    } else if (this.status.connection?.state === 'conflict' || wasBlocked) {
      this.refreshStatus({ link: 'offline', connection: { state: 'disconnected' } });
    }
    return state;
  }

  private async terminalEndpoint(terminalId: string, threadId: string): Promise<string | undefined> {
    return await codexTerminalEndpoint(this.host, this.session.id, terminalId, threadId, this.project.cwd, this.transport?.remoteAddress);
  }

  private async loadedThread(threadId: string, fresh = false): Promise<boolean | undefined> {
    if (!fresh && this.loadedCheckThreadId === threadId && Date.now() - this.loadedCheckAt < 5_000) return this.loadedCheck;
    const clearCheck = () => {
      this.loadedCheck = undefined;
      this.loadedCheckAt = 0;
      this.loadedCheckThreadId = undefined;
    };
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      let result: { data?: unknown; nextCursor?: string | null };
      try {
        result = await this.requireTransport().request<{ data?: unknown; nextCursor?: string | null }>('thread/loaded/list', {
          ...(cursor ? { cursor } : {}), limit: 100,
        });
      } catch {
        // Older app-server versions may not expose this endpoint. Unknown is different from the
        // authoritative empty list and must never trigger a writer-creating resume.
        clearCheck();
        return undefined;
      }
      if (!Array.isArray(result.data)) {
        clearCheck();
        return undefined;
      }
      if (result.data.includes(threadId)) {
        this.loadedCheck = true;
        this.loadedCheckAt = Date.now();
        this.loadedCheckThreadId = threadId;
        return true;
      }
      if (!result.nextCursor) {
        this.loadedCheck = false;
        this.loadedCheckAt = Date.now();
        this.loadedCheckThreadId = threadId;
        return false;
      }
      cursor = result.nextCursor;
    }
    clearCheck();
    return undefined;
  }

  /** Attach only when the selected endpoint already proves it owns this loaded thread. */
  async attachLoadedOwner(): Promise<void> {
    const threadId = this.nativeSessionId;
    if (!threadId || this.attached || !this.transport?.isOnline) return;
    if (this.bindingScopeMismatch) {
      this.deferForProfileChange();
      return;
    }
    if (this.endpointWriteConflict) {
      this.deferForEndpointConflict();
      return;
    }
    if (this.opening) {
      // An explicit open owns the same resume gate. Its error is already reported to its caller;
      // the observer must not issue a competing resume after that operation settles.
      await this.opening.catch(() => undefined);
      return;
    }
    const task = (async (): Promise<string | undefined> => {
      const loaded = await this.loadedThread(threadId, true);
      if (loaded !== true || this.attached || !this.transport?.isOnline) return undefined;
      if (this.bindingScopeMismatch) {
        this.deferForProfileChange();
        return undefined;
      }
      if (this.endpointWriteConflict) {
        this.deferForEndpointConflict();
        return undefined;
      }
      if (Date.now() - this.attachAttemptAt < 15_000) return undefined;
      this.attachAttemptAt = Date.now();
      try {
        const transport = this.requireTransport();
        const permissionObservation = this.permissionObservation;
        const modeObservation = this.modeObservation;
        const response = await transport.request<{ thread: RpcThread } & Record<string, unknown>>('thread/resume', {
          threadId, cwd: this.project.cwd, excludeTurns: true,
        });
        if (!response.thread?.id || response.thread.id !== threadId) throw new Error(`${this.label} app-server resumed a different thread`);
        this.noteThread(response.thread, this.modeObservation === modeObservation ? response : undefined);
        if (this.permissionObservation === permissionObservation) this.adoptApproval(response);
        if (this.modeObservation === modeObservation) this.adoptSettingsMode(response);
        this.attached = true;
        this.applyThreadStatus(response.thread.status);
        if (this.facts.link === 'offline' || this.facts.link === 'starting') this.refreshStatus({ link: 'quiet' });
        await this.commitRuntimeBinding(transport, threadId);
        this.setConnection({ state: 'connected' });
        this.logRecovery(this.endpointSource, transport.remoteAddress, 'observer-resume', 'confirmed', true);
        return threadId;
      } catch (error) {
        this.noteConnectionFailure(error);
        this.logRecovery(this.endpointSource, this.transport?.remoteAddress ?? 'unknown', 'observer-resume', isActiveWriterError(error) ? 'conflict' : 'failed', false);
        return undefined;
      }
    })();
    this.opening = task;
    try { await task; }
    catch { /* Only an explicit open can reject the shared opening gate. */ }
    finally { if (this.opening === task) this.opening = undefined; }
  }

  /** Local evidence of a live turn on the attached owner connection. */
  private foregroundTarget(): (NativeTurnTarget & { ownerRunId?: string }) | undefined {
    if (!this.attached || !this.transport?.isOnline || this.bindingScopeMismatch || this.endpointWriteConflict ||
      !this.nativeSessionId || !this.activeTurnId || this.settledTurns.has(this.activeTurnId) ||
      this.status.connection?.state !== 'connected' || this.status.phase !== 'busy' || this.currentInteraction) return undefined;
    const ownerRunId = this.turnRuns.get(this.activeTurnId)?.runId;
    return { nativeSessionId: this.nativeSessionId, turnId: this.activeTurnId, ...(ownerRunId ? { ownerRunId } : {}) };
  }

  /** Only a mapped Riffet run may authorize a foreground tool. */
  ownedForegroundTurn(): (NativeTurnTarget & { ownerRunId: string }) | undefined {
    const target = this.foregroundTarget();
    return target?.ownerRunId ? { ...target, ownerRunId: target.ownerRunId } : undefined;
  }

  /** Steering additionally depends on the native protocol version. */
  get steerTarget(): (NativeTurnTarget & { ownerRunId?: string }) | undefined {
    return supportsSteerVersion(this.transport?.serverUserAgent, this.flavor.id) ? this.foregroundTarget() : undefined;
  }

  private assertSteerTarget(target: NativeTurnTarget): void {
    this.assertWritable();
    const live = this.steerTarget;
    if (!live || live.nativeSessionId !== target.nativeSessionId || live.turnId !== target.turnId ||
      this.host.getSession(this.session.id).nativeSessionId !== target.nativeSessionId) {
      throw new AppError('STEER_TARGET_CHANGED', 'The original turn is no longer active and writable; the instruction was not sent.', 409);
    }
  }

  async steer(input: {
    runId: string; commandId: string; renderedText: string; input: unknown[]; target: NativeTurnTarget;
    commitDispatchFence(binding?: NativeDispatchBinding): unknown;
  }): Promise<void> {
    // Updating the CLI symlink does not upgrade an already running app-server. Never advertise or
    // write steering to an unverified process, and never restart its task to obtain support.
    if (!supportsSteerVersion(this.transport?.serverUserAgent, this.flavor.id)) {
      throw new AppError('STEER_UNSUPPORTED', `This ${this.label} app-server requires version ${STEER_MIN_VERSIONS[this.flavor.id]} or newer with verified steering receipts.`, 409);
    }
    this.assertSteerTarget(input.target);
    const terminal = this.terminalId ? await this.host.terminal.get(this.terminalId).catch(() => undefined) : undefined;
    this.restoreTurnCommands(input.target.turnId);
    // All asynchronous preparation precedes the final identity check and durable write fence.
    this.assertSteerTarget(input.target);
    const target = input.target;
    // A turn started in the native TUI may have no Riffet owner. Its steering input must not
    // become the execution owner just because it is the first Riffet command we observe.
    if (!this.turnRuns.has(target.turnId)) this.turnRuns.set(target.turnId, { createdAt: new Date().toISOString() });
    const ownerRunId = this.turnRuns.get(target.turnId)?.runId;
    const resolvedConfig = this.turnConfigs.get(target.turnId);
    const transport = this.requireTransport();
    const taggedInput = this.flavor.id === 'traex' ? input.input.map(part => {
      const value = asRecord(part);
      if (value?.type !== 'text' || value.text !== input.renderedText) return part;
      return { ...value, text_elements: [...asArray(value.text_elements), {
        // A zero-width span survives native history without making the text an atomic UI element.
        byteRange: { start: 0, end: 0 }, placeholder: `${STEER_ELEMENT_PREFIX}${input.commandId}`,
      }] };
    }) : input.input;
    input.commitDispatchFence({
      backendId: this.flavor.id, nativeSessionId: target.nativeSessionId, nativeTurnId: target.turnId,
      ...(ownerRunId ? { ownerRunId } : {}),
      ...(terminal ? { terminalId: terminal.id, terminalEpoch: terminal.epoch } : {}),
      baselineSequence: this.headSequence, renderedText: input.renderedText,
      ...(resolvedConfig ? { resolvedConfig } : {}),
    });
    this.commandRuns.set(input.commandId, { runId: input.runId, commandId: input.commandId, createdAt: new Date().toISOString() });
    try {
      const result = await transport.request<{ turn?: { id: string }; turnId?: string }>('turn/steer', {
        threadId: target.nativeSessionId, expectedTurnId: target.turnId,
        ...(this.flavor.messageTag.echo === 'clientId' ? { clientUserMessageId: input.commandId } : {}),
        input: taggedInput,
      });
      if ((result.turn?.id ?? result.turnId) !== target.turnId) throw new Error(`${this.label} acknowledged a different turn`);
      // A completion may have arrived before this acknowledgement; never resurrect that turn.
      const outcome = this.pendingTurnOutcomes.get(target.turnId);
      if (outcome) this.emitTurnOutcome(outcome, target.turnId);
    } catch (error) {
      if ((error as { rpcError?: boolean })?.rpcError) {
        this.commandRuns.delete(input.commandId);
        this.turnCommands.get(target.turnId)?.delete(input.commandId);
        for (const [id, commandId] of this.claimedItems) if (commandId === input.commandId) this.claimedItems.delete(id);
        const message = safeProviderError(error, this.profileConfig);
        const changed = /expected.*turn|turn.*mismatch|no active turn|not.*active|turn.*(?:finished|completed|ended)/i.test(message);
        throw new AppError(changed ? 'STEER_TARGET_CHANGED' : 'STEER_REJECTED', message, 409);
      }
      // A transport failure cannot prove the provider rejected a submitted message.
      throw error;
    }
  }

  private rememberTurnCommand(turnId: string, commandId: string, confirmed: boolean): void {
    const command = this.commandRuns.get(commandId);
    if (!command) return;
    const owner = this.turnRuns.get(turnId);
    if (!owner || owner.commandId === commandId && !owner.runId && command.runId) this.turnRuns.set(turnId, { ...command, commandId });
    if (confirmed) {
      const commands = this.turnCommands.get(turnId) ?? new Set<string>();
      commands.add(commandId);
      this.turnCommands.set(turnId, commands);
    }
  }

  private restoreTurnCommands(turnId: string): void {
    if (!this.nativeSessionId) return;
    const runs = this.host.findRunsByNativeTurn?.(this.session.id, this.nativeSessionId, turnId) ?? [];
    // The first ordinary input owns the execution even if a steer was restored before it.
    const owner = runs.find(run => run.native?.intent !== 'steer');
    if (owner) {
      this.commandRuns.set(owner.commandId, { runId: owner.id, commandId: owner.commandId, createdAt: owner.createdAt });
      this.turnRuns.set(turnId, this.commandRuns.get(owner.commandId)!);
      if (owner.native?.resolvedConfig) this.turnConfigs.set(turnId, owner.native.resolvedConfig);
    }
    if (!owner && runs.length && !this.turnRuns.has(turnId)) {
      this.turnRuns.set(turnId, { ...(runs[0]!.native?.ownerRunId ? { runId: runs[0]!.native.ownerRunId } : {}), createdAt: runs[0]!.createdAt });
    }
    for (const run of runs) {
      if (run.native?.delivery === 'failed' || run.native?.delivery === 'cancelled') continue;
      this.commandRuns.set(run.commandId, { runId: run.id, commandId: run.commandId, createdAt: run.createdAt });
      // An acceptance alone does not prove the model's original turn received this input.
      if (run.native?.delivery === 'observed' || Boolean(run.native?.nativeMessageId)) this.rememberTurnCommand(turnId, run.commandId, true);
    }
  }

  async send(input: {
    runId: string;
    commandId: string;
    renderedText: string;
    input: unknown[];
    config: NativeRunConfig;
    nativeSessionId: string;
    command?: CodexNativeCommand;
    commitDispatchFence(binding?: NativeDispatchBinding): unknown;
  }): Promise<{ turnId: string }> {
    this.assertWritable();
    if (input.command) return await this.sendCommand(input, input.command);
    const requestedModel = input.config.model ?? str(this.profileConfig.defaultModel);
    const requestedSelection = parseNativeModelSelection(requestedModel);
    const submittedAt = new Date().toISOString();
    this.commandRuns.set(input.commandId, { runId: input.runId, commandId: input.commandId, createdAt: submittedAt });
    const transport = this.requireTransport();
    const modeObservation = this.modeObservation;
    const modelSelection = await resolveModelSelection(transport, this.flavor, requestedSelection);
    const effort = nativeModelEffort(modelSelection);
    const serviceTier = fastServiceTier(this.flavor, modelSelection.model, nativeModelFast(modelSelection));
    const backendVariant = modelBackendVariant(this.flavor, modelSelection);
    const terminal = this.terminalId ? await this.host.terminal.get(this.terminalId).catch(() => undefined) : undefined;
    // A resolved candidate can require authoritative readback. Do not send its next turn in
    // the earlier observed mode merely because the resolution receipt completed first.
    while (this.modeReconciliation) await this.modeReconciliation;
    // Ordinary send follows the current foreground, unlike an explicit user-targeted steer.
    // Select after the final terminal await; a completed/replaced turn must never be steered.
    this.assertWritable();
    const activeTurnId = this.activeTurnId && !this.settledTurns.has(this.activeTurnId) ? this.activeTurnId : undefined;
    // The TUI may tighten permissions or resolve a mode decision during preparation. Fence and
    // submit the same effective config, not the adapter's earlier snapshot.
    if (this.flavor.id === 'traex') input.config = { ...input.config,
      approval: this.host.getSession(this.session.id).approval,
      ...(this.modeObservation !== modeObservation && this.nativeMode ? { mode: this.nativeMode } : {}),
    };
    const binding = {
      backendId: this.flavor.id,
      nativeSessionId: input.nativeSessionId,
      ...(terminal ? { terminalId: terminal.id, terminalEpoch: terminal.epoch } : {}),
      baselineSequence: this.headSequence,
      renderedText: input.renderedText,
      slashCommand: false,
      // Keep the accepted spelling in the run snapshot, but attribute the dispatch to the
      // canonical model sent below. The saved parameter suffix still selects the same controls.
      resolvedConfig: modelSelection.model === requestedSelection.model ? input.config : {
        ...input.config,
        model: modelSelection.model + (requestedModel?.trim().slice(requestedSelection.model.length) ?? ''),
      },
    };
    input.commitDispatchFence(binding);
    const permission = permissionOf(input.config.approval, this.flavor.id);
    // Codex states the sandbox per turn. TRAE inherits its observed native permissions unless
    // the requested mode changed, preserving profile modifications made in the TUI.
    const mode = this.flavor.modes.length ? collaborationModeOf(input.config.mode) : undefined;
    const modeModel = modelSelection.model || this.threadModel;
    const collaborationMode = mode && modeModel ? { mode, settings: { model: modeModel, reasoning_effort: effort === 'default' ? null : effort ?? null } } : undefined;
    const params = {
      threadId: input.nativeSessionId,
      [this.flavor.messageTag.request]: this.messageTagOf(input.commandId),
      input: input.input,
      model: modelSelection.model || null,
      ...(backendVariant ? { modelBackendVariant: backendVariant } : {}),
      ...this.permissionParams(permission, 'sandboxPolicy'),
      effort: effort === 'default' ? null : effort ?? null,
      ...(serviceTier ? { serviceTier } : {}),
      // Each turn states its own mode, like its approval policy, so a browser turn runs in the mode
      // the browser shows even when the TUI switched in between. A mode never chosen is left alone.
      ...(collaborationMode ? { collaborationMode } : {}),
    };
    const foregroundEndedBeforeSend = this.foregroundEndedTurnId;
    this.dispatchCommandId = input.commandId;
    if (activeTurnId) this.rememberTurnCommand(activeTurnId, input.commandId, false);
    try {
      const steerClaim = activeTurnId && this.flavor.messageTag.echo === 'id'
        ? { turnId: activeTurnId, commandId: input.commandId, text: input.renderedText }
        : undefined;
      if (steerClaim) {
        this.pendingSteers.push(steerClaim);
        if (this.pendingSteers.length > 32) this.pendingSteers.shift();
      }
      let response: { turn?: { id: string }; turnId?: string };
      const permissionObservation = this.permissionObservation;
      try {
        response = activeTurnId
          ? await transport.request<{ turn?: { id: string }; turnId?: string }>('turn/steer', {
            threadId: params.threadId,
            ...(this.flavor.messageTag.echo === 'clientId' ? { clientUserMessageId: input.commandId } : {}),
            input: params.input, expectedTurnId: activeTurnId,
          })
          : await transport.request<{ turn?: { id: string }; turnId?: string }>('turn/start', params);
      } catch (error) {
        // A definite rejection leaves a new thread empty. A lost acknowledgement may already
        // have started its first turn; native notifications independently supply that evidence.
        if (!(error as { rpcError?: boolean })?.rpcError) this.history.beginMaterialization();
        // A message the provider never took must not claim a TUI message with the same text later.
        const index = steerClaim ? this.pendingSteers.indexOf(steerClaim) : -1;
        if (index >= 0) this.pendingSteers.splice(index, 1);
        throw error;
      }
      this.history.beginMaterialization();
      // Codex acknowledges with the turn; TRAE CLI's steer answers with just its id.
      const turnId = response.turn?.id ?? str(response.turnId);
      if (!turnId) throw new Error(`${this.label} app-server did not acknowledge the submitted turn`);
      if (!activeTurnId && this.flavor.id === 'traex' && Object.hasOwn(params, 'approvalPolicy')) {
        if (this.host.getSession(this.session.id).configPending) {
          this.emit({ type: 'session', session: this.host.updateSession(this.session.id, { configPending: false }) });
        }
        if (this.permissionObservation !== permissionObservation) this.adoptApproval(this.permissionSettings);
        else {
          this.nativeApproval = permission.id;
          this.refreshStatus({ approval: permission.id });
        }
      }
      // A new message supersedes the questions still open, as a TUI submission does.
      this.asyncQuestions = [];
      this.rememberTurnCommand(turnId, input.commandId, !activeTurnId);
      if (!activeTurnId) this.turnConfigs.set(turnId, structuredClone(binding.resolvedConfig));
      const completedBeforeAck = this.pendingTurnOutcomes.get(turnId);
      if (completedBeforeAck) {
        this.pendingTurnOutcomes.delete(turnId);
        this.emitTurnOutcome(completedBeforeAck, turnId);
      }
      // A fast completion can precede this response. Neither that turn nor a newer native turn
      // which started while the response was pending may be replaced by the acknowledgement.
      if ((!this.activeTurnId || this.activeTurnId === turnId) &&
        (!this.foregroundEndedTurnId || this.foregroundEndedTurnId === turnId || this.foregroundEndedTurnId === foregroundEndedBeforeSend)) {
        if (completedBeforeAck || this.foregroundEndedTurnId === turnId) {
          this.activeTurnId = undefined;
          this.foregroundEndedTurnId = turnId;
        } else {
          this.activeTurnId = turnId;
          this.foregroundEndedTurnId = undefined;
        }
      }
      this.refreshStatus({ link: 'quiet', model: input.config.model || undefined, ...(completedBeforeAck ? {} : { notice: undefined }) });
      return { turnId };
    } finally {
      if (this.dispatchCommandId === input.commandId) this.dispatchCommandId = undefined;
    }
  }

  /** Native operations have no user-message echo. Bind their real turn before reporting receipt. */
  private async sendCommand(input: Parameters<CodexSessionRuntime['send']>[0], command: CodexNativeCommand): Promise<{ turnId: string }> {
    if (this.flavor.id !== 'codex') throw new AppError('NATIVE_COMMAND_UNSUPPORTED', 'This backend does not support this native command.', 400);
    const assertIdle = () => {
      if (this.activeTurnId || this.nativeCommand || this.interaction || this.status.phase === 'busy') {
        throw new AppError('CLI_BUSY', 'Finish or stop the current turn before running this command.', 409);
      }
    };
    assertIdle();
    const transport = this.requireTransport();
    const terminal = this.terminalId ? await this.host.terminal.get(this.terminalId).catch(() => undefined) : undefined;
    // The setter ACK is not application evidence. Verify the final native snapshot after all
    // other preparation awaits, including on fresh threads, before the irreversible command.
    const verified = await this.verifyCommandConfig(input.config, input.nativeSessionId);
    this.assertWritable();
    assertIdle();
    if (transport !== this.transport || input.nativeSessionId !== this.nativeSessionId || verified.observation !== this.permissionObservation) {
      throw new AppError('NATIVE_COMMAND_CONFIG_UNVERIFIED', 'Native settings changed before the command could be submitted.', 409);
    }
    input.config = verified.config;
    const submittedAt = new Date().toISOString();
    const previousTurns = new Set([...this.turnRuns.keys(), ...this.settledTurns.keys(), ...this.pendingTurnOutcomes.keys(),
      ...(this.foregroundEndedTurnId ? [this.foregroundEndedTurnId] : []),
      ...this.events.map(event => event.nativeTurnId).filter((id): id is string => Boolean(id))]);
    let resolve!: (turnId: string) => void;
    let reject!: (error: Error) => void;
    const observed = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
    void observed.catch(() => undefined);
    const pending: NonNullable<CodexSessionRuntime['nativeCommand']> = { commandId: input.commandId, runId: input.runId, config: input.config, type: command.type, transport, threadId: input.nativeSessionId, acknowledged: false, foregroundEndedBeforeSend: this.foregroundEndedTurnId, previousTurns, startedTurns: new Set(), userTurns: new Set(), resolve, reject };
    input.commitDispatchFence({ backendId: this.flavor.id, nativeSessionId: input.nativeSessionId,
      ...(terminal ? { terminalId: terminal.id, terminalEpoch: terminal.epoch } : {}),
      baselineSequence: this.headSequence, renderedText: input.renderedText, resolvedConfig: input.config, slashCommand: true });
    this.commandRuns.set(input.commandId, { runId: input.runId, commandId: input.commandId, createdAt: submittedAt });
    this.nativeCommand = pending;
    this.unboundNativeCommand = input.commandId;
    this.dispatchCommandId = input.commandId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cancelled = observed.then(() => new Promise<never>(() => undefined));
      // Observe the RPC independently of the local wait: Stop must not discard a definitive
      // rejection or an authoritative review turn id which arrives after it releases the lock.
      const response = (command.type === 'review'
        ? transport.request<{ turn?: { id: string }; reviewThreadId: string }>('review/start', { threadId: input.nativeSessionId, delivery: 'inline',
          target: command.target.type === 'commit' ? { ...command.target, title: command.target.title ?? null } : command.target }).then(result => {
          if (!result.turn?.id || result.reviewThreadId !== pending.threadId) throw new Error('Codex did not identify the review turn.');
          pending.acknowledged = true;
          this.confirmNativeCommand(result.turn.id, pending);
        })
        : transport.request('thread/compact/start', { threadId: input.nativeSessionId }).then(() => {
          pending.acknowledged = true;
          if (this.nativeCommand === pending && pending.candidate) this.confirmNativeCommand(pending.candidate, pending);
        })).catch(error => { this.rejectNativeCommand(pending, error); throw error; });
      await Promise.race([response, cancelled]);
      this.history.beginMaterialization();
      // The empty compact ACK means accepted, not completed. A missing start remains uncertain
      // behind the dispatch fence; it must never fall back to a prompt or retry the operation.
      const turnId = pending.turnId ?? await Promise.race([observed, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Codex accepted the command but its turn is unconfirmed.')), 10_000);
      })]);
      return { turnId };
    } finally {
      if (timer) clearTimeout(timer);
      if (this.nativeCommand === pending) this.nativeCommand = undefined;
      if (this.dispatchCommandId === input.commandId) this.dispatchCommandId = undefined;
      if (pending.turnId && (this.settledTurns.has(pending.turnId) || this.pendingTurnOutcomes.has(pending.turnId))
        && transport === this.transport && transport.isOnline && this.status.phase !== 'offline') {
        this.refreshStatus({ link: 'quiet' });
      }
    }
  }

  private async verifyCommandConfig(config: NativeRunConfig, threadId: string): Promise<{ config: NativeRunConfig; observation: number }> {
    const transport = this.requireTransport();
    const fail = (field: string) => new AppError('NATIVE_COMMAND_CONFIG_UNVERIFIED', `Native command settings were not confirmed (${field}).`, 409);
    if (this.commandConfigObserver) throw fail('concurrent configuration');
    const notifications: Record<string, unknown>[] = [];
    let overflow = false;
    const observe = (settings: Record<string, unknown>) => {
      if (notifications.length < 64) notifications.push(settings); else overflow = true;
    };
    this.commandConfigObserver = observe;
    try {
      const requested = config.model ?? str(this.profileConfig.defaultModel) ?? this.threadModel;
      const selection = await resolveModelSelection(transport, this.flavor, parseNativeModelSelection(requested));
      let effort = nativeModelEffort(selection);
      if (!selection.model) throw fail('model');
      if (effort === 'default') {
        const model = (await listModels(transport, this.flavor)).find(item => item.value === selection.model);
        effort = model?.configOptions.find(option => option.id === 'effort')?.currentValue;
        if (!effort || effort === 'default') throw fail('reasoning effort');
      }
      const tier = fastServiceTier(this.flavor, selection.model, nativeModelFast(selection));
      const permission = permissionOf(config.approval, this.flavor.id);
      const sandbox = this.sandboxPolicy(permission.sandbox);
      const cwd = await realpath(this.project.cwd).catch(() => this.project.cwd);
      const profileId = permission.id === 'on-request' ? ':workspace' : permission.id === 'read-only' ? ':read-only' : ':danger-full-access';
      const matches = (value: Record<string, unknown>): boolean => {
        const profile = asRecord(value.activePermissionProfile);
        const provenance = value.activePermissionProfile == null || Boolean(profile && profile.id === profileId && profile.extends == null
          && (profile.modifications === undefined || Array.isArray(profile.modifications) && profile.modifications.length === 0)
          && Object.keys(profile).every(key => ['id', 'extends', 'modifications'].includes(key)));
        return provenance && value.model === selection.model && [cwd, this.project.cwd].includes(String(value.cwd))
          && value.approvalPolicy === permission.approvalPolicy && value.approvalsReviewer === 'user'
          && isDeepStrictEqual(value.sandbox, sandbox) && (effort === undefined || value.reasoningEffort === effort)
          && (tier === undefined || value.serviceTier === tier);
      };
      const assertNoConflict = () => {
        if (overflow || notifications.some(settings => !matches({ ...settings, sandbox: settings.sandboxPolicy, reasoningEffort: settings.effort }))) {
          throw fail('concurrent settings change');
        }
      };
      try {
        assertNoConflict();
        this.assertWritable();
        if (transport !== this.transport || !transport.isOnline || threadId !== this.nativeSessionId) throw fail('connection');
        if (this.activeTurnId || this.interaction || this.status.phase === 'busy') throw new AppError('CLI_BUSY', 'Finish or stop the current turn before running this command.', 409);
        // Unlike resume overrides, this applies to an already loaded thread. Null effort preserves
        // the old effort, so an explicit default above resolves to the model catalog's actual value.
        await transport.request('thread/settings/update', { threadId, cwd: this.project.cwd, model: selection.model,
          approvalPolicy: permission.approvalPolicy, approvalsReviewer: 'user', ...(this.standingProfile(permission) ? {} : { sandboxPolicy: sandbox }),
          ...(effort !== undefined ? { effort } : {}), ...(tier !== undefined ? { serviceTier: tier } : {}),
        });
        const deadline = Date.now() + 5_000;
        do {
          assertNoConflict();
          if (transport !== this.transport || !transport.isOnline || this.nativeSessionId !== threadId) throw fail('connection');
          const observation = this.permissionObservation;
          const actual = await transport.request<Record<string, unknown>>('thread/resume', { threadId, excludeTurns: true });
          assertNoConflict();
          const thread = asRecord(actual.thread);
          if (thread?.id !== threadId) throw fail('thread');
          if (asRecord(thread.status)?.type === 'active' || this.activeTurnId) throw new AppError('CLI_BUSY', 'Finish or stop the current turn before running this command.', 409);
          if (asRecord(thread.status)?.type === 'idle' && observation === this.permissionObservation && matches(actual)) {
            this.noteThread(thread as unknown as RpcThread, actual);
            const suffix = requested?.trim().slice(parseNativeModelSelection(requested).model.length) ?? '';
            return { config: { ...config, model: selection.model + suffix, approval: permission.id }, observation };
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        throw fail('model or permissions');
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw fail('native protocol');
      }
    } finally { if (this.commandConfigObserver === observe) this.commandConfigObserver = undefined; }
  }

  private rejectNativeCommand(pending: NonNullable<CodexSessionRuntime['nativeCommand']>, error: unknown): void {
    if (!(error as { rpcError?: boolean })?.rpcError || pending.turnId || pending.rejected) return;
    pending.rejected = true;
    if (this.unboundNativeCommand === pending.commandId) this.unboundNativeCommand = undefined;
    this.host.emitEvent(this.session.id, { sequence: this.headSequence + 1, sessionId: this.session.id,
      runId: pending.runId, type: 'native_input_rejected', nativeId: `${pending.threadId}:command:${pending.commandId}:rejected`, createdAt: new Date().toISOString(),
      data: { commandId: pending.commandId, nativeSessionId: pending.threadId, receiptKind: 'native_command', error: safeProviderError(error, this.profileConfig) },
    });
  }

  private confirmNativeCommand(turnId: string, pending = this.nativeCommand): void {
    if (!pending || pending.rejected || pending.cancelled && pending.type !== 'review' || pending.turnId || pending.transport !== this.transport || pending.threadId !== this.nativeSessionId
      || !pending.transport.isOnline || pending.previousTurns.has(turnId) || pending.userTurns.has(turnId)) return;
    if (pending.type === 'compact') {
      pending.candidate = turnId;
      if (pending.startedTurns.size !== 1 || !pending.startedTurns.has(turnId)) return;
    }
    if (!pending.acknowledged) return;
    pending.turnId = turnId;
    if (this.unboundNativeCommand === pending.commandId) this.unboundNativeCommand = undefined;
    this.rememberTurnCommand(turnId, pending.commandId, true);
    this.turnConfigs.set(turnId, structuredClone(pending.config));
    const receipt = this.withStableSequence(this.makeEvent(
      `${this.nativeSessionId}:${turnId}:command:${pending.commandId}`, turnId, this.commandRuns.get(pending.commandId)?.runId,
      'native_input_receipt', { commandId: pending.commandId, receiptKind: 'native_command', nativeSessionId: this.nativeSessionId },
    ));
    this.pushEvent(receipt);
    this.host.emitEvent(this.session.id, receipt);
    this.recordSubmittedTurn(turnId, pending.runId, pending.commandId);
    if (!this.pendingTurnOutcomes.has(turnId) && !this.settledTurns.has(turnId)
      && (!this.activeTurnId || this.activeTurnId === turnId)
      && (!this.foregroundEndedTurnId || this.foregroundEndedTurnId === pending.foregroundEndedBeforeSend)) {
      this.activeTurnId = turnId;
      this.foregroundEndedTurnId = undefined;
      this.refreshStatus({ link: this.resumed() });
    }
    pending.resolve(turnId);
  }

  /** Release a local receipt wait so Stop can acquire the session lock; this does not stop Codex. */
  requestInterrupt(): void {
    const pending = this.nativeCommand;
    if (!pending) return;
    pending.cancelled = true;
    pending.reject(new Error('The native command receipt is unconfirmed.'));
  }

  async interrupt(targetTurnId?: string, targetThreadId = this.nativeSessionId): Promise<void> {
    this.assertWritable();
    const runs = this.host.listRuns?.(this.session.id);
    const unresolved = (run: Run) => run.native && !run.native.nativeTurnId
      && (!run.native.nativeSessionId || run.native.nativeSessionId === this.nativeSessionId)
      && ['dispatching', 'input_sent', 'uncertain'].includes(run.native.delivery)
      && !['completed', 'failed', 'cancelled'].includes(run.state) && run.native.stage !== 'acknowledged'
      && /^\s*\/(compact|review)(?=\s|$)/.test(run.native.input.text);
    if (this.unboundNativeCommand && runs) {
      const run = runs.find(run => run.commandId === this.unboundNativeCommand);
      if (run && !unresolved(run)) this.unboundNativeCommand = undefined;
    }
    if (targetThreadId === this.nativeSessionId && (this.unboundNativeCommand || this.flavor.id === 'codex' && runs?.some(unresolved))
      && (!targetTurnId || targetTurnId !== this.activeTurnId)) {
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'The native command has no confirmed turn yet; stopping it could not be verified.', 409);
    }
    if (targetThreadId && targetThreadId !== this.nativeSessionId && !this.subagents.owns(targetThreadId)) {
      throw new AppError('NATIVE_SESSION_NOT_CONNECTED', `The requested ${this.label} child is not associated with this session.`, 409);
    }
    if (!this.transport?.isOnline) throw new Error(`${this.label} app-server is offline; the turn has not been confirmed stopped.`);
    if (!this.attached) {
      // A reconnect has not observed the running turn yet. Rejoin only a verified loaded owner,
      // then read its current turn; lack of local state is not proof that the task already stopped.
      await this.attachLoadedOwner();
      this.assertWritable();
      if (!this.attached) throw new AppError('NATIVE_SESSION_NOT_CONNECTED', `The ${this.label} thread is not attached; its turn has not been confirmed stopped.`, 409);
      await this.refreshEvents();
      if (!this.historySnapshotReady) throw new AppError('NATIVE_HISTORY_UNAVAILABLE', `The current ${this.label} turn could not be read; interruption was not confirmed.`, 503);
    }
    const turnId = targetTurnId ?? (targetThreadId === this.nativeSessionId ? this.activeTurnId : undefined);
    if (!turnId || !targetThreadId) return;
    const waiterId = this.scopedRequestId(targetThreadId, turnId);
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => { resolveCompleted = resolve; rejectCompleted = reject; });
    const waiter = { resolve: resolveCompleted, reject: rejectCompleted };
    let rejectTimeout!: (error: Error) => void;
    const timeoutReached = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    let waiters = this.completionWaiters.get(waiterId);
    if (!waiters) this.completionWaiters.set(waiterId, waiters = new Set());
    waiters.add(waiter);
    const timeout = setTimeout(() => {
      this.completionWaiters.get(waiterId)?.delete(waiter);
      if (this.completionWaiters.get(waiterId)?.size === 0) this.completionWaiters.delete(waiterId);
      rejectTimeout(new Error(`${this.label} acknowledged interruption but did not confirm the turn stopped.`));
    }, 15_000);
    timeout.unref();
    try {
      await Promise.race([
        this.requireTransport().request('turn/interrupt', { threadId: targetThreadId, turnId }).then(() => completed),
        timeoutReached,
      ]);
    } finally {
      clearTimeout(timeout);
      this.completionWaiters.get(waiterId)?.delete(waiter);
      if (this.completionWaiters.get(waiterId)?.size === 0) this.completionWaiters.delete(waiterId);
    }
  }

  private sandboxPolicy(mode: ReturnType<typeof permissionOf>['sandbox']): Record<string, unknown> {
    return sandboxPolicyOf(mode);
  }

  private permissionParams(permission: ReturnType<typeof permissionOf>, sandboxField: 'sandbox' | 'sandboxPolicy', force = false): Record<string, unknown> {
    // An unchanged TRAE mode inherits the actual native profile, including additional roots and
    // custom restrictions. Only an explicit switch may replace it with a bare built-in preset.
    if (this.flavor.id === 'traex' && !force && this.nativeApproval === permission.id && !this.host.getSession(this.session.id).configPending) return {};
    if (this.standingProfile(permission)) return { approvalPolicy: permission.approvalPolicy };
    return permissionParamsOf(permission, sandboxField);
  }

  async applyThreadConfig(config: { model?: string; approval?: string; mode?: string }, updateApproval = true): Promise<{ approval?: string; mode?: string }> {
    this.assertWritable();
    const observedBeforeConfig = this.permissionObservation;
    let effectiveApproval: string | undefined;
    let effectiveMode: string | undefined;
    this.configuring = updateApproval;
    try {
      // The open itself has to carry the merged setting rather than the runtime's construction-time
      // snapshot; the native settings update below keeps an already-attached thread in step rather
      // than correcting a thread that this call has just created with stale settings.
      if (this.nativeSessionId && this.flavor.id !== 'traex') {
        const observed = await this.history.readThread(this.nativeSessionId, false).catch(() => undefined);
        if (this.activeTurnId || this.status.phase === 'busy' || observed?.status?.type === 'active') {
          this.applyThreadStatus(observed?.status);
          return {};
        }
      }
      const threadId = await this.openOrResume({ model: config.model, ...(updateApproval ? { approval: config.approval } : {}) });
      const transport = this.requireTransport();
      const selection = await resolveModelSelection(transport, this.flavor, parseNativeModelSelection(config.model));
      const effort = nativeModelEffort(selection);
      const serviceTier = fastServiceTier(this.flavor, selection.model, nativeModelFast(selection));
      const backendVariant = modelBackendVariant(this.flavor, selection);
      const modelConfig = {
        ...(effort && effort !== 'default' ? { model_reasoning_effort: effort } : {}),
        ...(backendVariant ? { model_backend_variant: backendVariant } : {}),
      };
      const permission = permissionOf(config.approval, this.flavor.id);
      // TRAE has an explicit settings setter. A new, already-attached thread may have no rollout
      // until its first turn, so resuming it merely to change settings would fail before the setter.
      if (this.flavor.id !== 'traex') {
        const response = await transport.request<{ thread: RpcThread } & Record<string, unknown>>('thread/resume', {
          threadId,
          cwd: this.project.cwd,
          model: selection.model || null,
          ...this.permissionParams(permission, 'sandbox', true),
          ...(serviceTier ? { serviceTier } : {}),
          ...(Object.keys(modelConfig).length ? { config: modelConfig } : {}),
          excludeTurns: true,
        });
        this.noteThread(response.thread, response);
      }
      // Resume carries no mode; the thread's own settings do, which is also what an attached TUI shows.
      const mode = collaborationModeOf(config.mode);
      const modeModel = selection.model || this.threadModel;
      const collaborationMode = mode && modeModel && this.flavor.modes.length ? { mode, settings: { model: modeModel, reasoning_effort: effort === 'default' ? null : effort ?? null } } : undefined;
      if (this.flavor.id === 'traex' || collaborationMode) {
        // Keep TRAE's model and variant in one update, including Standard when leaving Max.
        const permissionObservation = this.permissionObservation;
        const modeObservation = this.modeObservation;
        const response = await transport.request<{ threadSettings?: Record<string, unknown> | null }>('thread/settings/update', {
          threadId,
          ...(this.flavor.id === 'traex' ? {
            ...(selection.model ? { model: selection.model } : {}),
            ...(backendVariant ? { modelBackendVariant: backendVariant } : {}),
            effort: effort === 'default' ? null : effort ?? null,
            ...(updateApproval ? this.permissionParams(permission, 'sandboxPolicy', true) : {}),
          } : {}),
          ...(collaborationMode ? { collaborationMode } : {}),
        });
        if (this.flavor.id === 'traex') {
          if (this.modeObservation === modeObservation) this.adoptSettingsMode(response.threadSettings ?? undefined);
          if (this.modeObservation !== modeObservation) effectiveMode = this.nativeMode;
          if (!updateApproval) {
            // A TUI notification received while awaiting this reply may already be newer.
            if (this.permissionObservation === permissionObservation) this.adoptApproval(response.threadSettings ?? undefined);
          }
          else {
            const newerSettings = this.permissionObservation !== permissionObservation ? this.permissionSettings : undefined;
            const effectiveSettings = newerSettings ?? response.threadSettings ?? undefined;
            const reported = reportedTraePermission(effectiveSettings);
            effectiveApproval = reported ?? (newerSettings ? normalizePermission(this.host.getSession(this.session.id).approval, this.flavor.id) : permission.id);
            this.nativeApproval = effectiveApproval;
            this.refreshStatus({ approval: !reported && this.hasNativePermissions(effectiveSettings) ? 'custom' : this.nativeApproval });
          }
        }
      }
    } catch (error) {
      this.configuring = false;
      // A failed write cannot invalidate a native settings notification received while awaiting it.
      if (updateApproval && this.permissionObservation !== observedBeforeConfig) this.adoptApproval(this.permissionSettings);
      throw error;
    } finally { this.configuring = false; }
    return {
      ...(effectiveApproval !== undefined ? { approval: effectiveApproval } : {}),
      ...(effectiveMode !== undefined ? { mode: effectiveMode } : {}),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return await listModels(this.requireTransport(), this.flavor);
  }

  subscribe(listener: (message: NativeControlMessage) => void): () => void {
    this.listeners.add(listener);
    // Seed child activity before the main phase: an idle parent can still have working children.
    for (const watch of this.subagents.values()) if (watch.running) listener({ type: 'subagent', toolCallId: watch.toolCallId, agentId: watch.childId, running: true });
    if (this.usage.context) listener({ type: 'context', context: this.usage.context });
    listener({ type: 'status', status: this.status });
    if (this.interaction) listener({ type: 'status', status: { ...this.status, phase: 'attention', interaction: this.interaction } });
    if ((!this.historyPoll || this.pollDormant) && this.nativeSessionId && this.transport?.isOnline) this.scheduleHistoryPoll(true);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.historyPoll) {
        clearTimeout(this.historyPoll);
        this.historyPoll = undefined;
      }
    };
  }

  /**
   * Notifications are the primary feed once this client owns the thread over a healthy connection;
   * the history read then only backstops a missed one. Anything else (a reader that is not attached,
   * a failing connection or history) still has nothing but the read, so it keeps the quick cadence.
   */
  private pushHealthy(): boolean {
    return this.attached && this.transport?.isOnline === true && !this.bindingScopeMismatch && !this.endpointWriteConflict
      && this.status.connection?.state === 'connected' && this.status.history?.state === 'ready';
  }

  /** One read now (or after the suggested interval), then rescheduled at the cadence the tracker suggests. */
  private scheduleHistoryPoll(immediate = false): void {
    if (this.historyPoll) clearTimeout(this.historyPoll);
    this.historyPoll = undefined;
    if (this.listeners.size === 0 || !this.nativeSessionId || !this.transport?.isOnline) return;
    const healthy = this.pushHealthy();
    this.pollHealthy = healthy;
    this.pollDormant = this.dormant();
    const run = () => {
      // Polls need the current read, not an additional full read queued behind a slow one.
      if (!this.refreshTask) void this.refreshEvents().catch(error => this.noteHistoryFailure(error));
      // An unverified endpoint is usually a scan that timed out, not a different owner. Re-check it
      // (at most every couple of seconds, by the state's own cache) so the conflict clears on its own.
      if (this.endpointWriteConflict) void this.terminalEndpointState().then(() => this.attachLoadedOwner());
      else void this.attachLoadedOwner();
      this.activities.sync();
      this.scheduleHistoryPoll();
    };
    if (immediate) { run(); return; }
    const interval = this.turn.suggestedPollMs(healthy);
    this.historyPoll = setTimeout(run, this.pollDormant ? Math.max(interval, DORMANT_POLL_MS) : interval);
    this.historyPoll.unref();
  }

  /** Idle, with no client listening, for a while: nothing anyone sees depends on a quick read. */
  private dormant(): boolean {
    const quiet = !this.activeTurnId && this.pending.size === 0 && this.asyncQuestions.length === 0
      && (this.status.phase === 'idle' || this.status.phase === 'offline');
    return this.dormancy.dormant(!quiet || this.listeners.size > 0);
  }

  /**
   * What a reader needs before the poll takes over: the thread read once (status, active turn, title),
   * whether this client owns it, its children, and the context window the provider has not reported yet.
   */
  async prime(): Promise<void> {
    try {
      await this.refreshEvents();
    } catch (error) {
      this.noteHistoryFailure(error);
      this.historySnapshotReady = false;
    }
    if (!this.attached && this.nativeSessionId && this.transcriptLoaded) {
      await this.loadedThread(this.nativeSessionId).catch(() => undefined);
      this.refreshStatus({ link: 'offline', connection: this.status.connection?.state === 'conflict' || this.endpointWriteConflict ? this.status.connection : { state: 'disconnected' } });
    }
    void this.subagents.refresh();
    // A resumed thread reports nothing until its next turn, so the rollout is consulted once when
    // nothing has been reported yet; after that the provider's own frames lead.
    await this.usage.seedContextWindow().catch(() => undefined);
    if (!this.usage.contextBreakdown) await this.usage.refreshContextBreakdown().catch(() => undefined);
  }

  async respond(response: NativeInteractionResponse): Promise<NativeInteractionResult> {
    if (typeof response.requestId !== 'string' || !response.requestId || response.requestId.length > 200 || /[\0\r\n]/.test(response.requestId)) {
      throw new AppError('INVALID_INTERACTION_REQUEST_ID', 'Interaction request id is invalid', 400);
    }
    const fingerprint = interactionFingerprint(response);
    const previous = this.host.getInteractionReceipt(this.session.id, response.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.interactionId !== response.interactionId || previous.revision !== response.revision) {
        throw new AppError('NATIVE_INTERACTION_REQUEST_CONFLICT', 'This interaction retry id was already used for a different answer', 409);
      }
      return previous.result;
    }
    const asked = this.asyncQuestions.find(question => asyncQuestionInteraction(question, this.label).id === response.interactionId);
    if (asked) return await this.answerAsyncQuestion(asked, response, fingerprint);
    if (isAsyncQuestionInteraction({ id: response.interactionId } as NativeInteraction)) {
      return { status: 'uncertain', message: `${this.label} no longer has this question pending.` };
    }
    const current = this.interaction;
    if (!current || current.id !== response.interactionId || current.revision !== response.revision) {
      return { status: 'uncertain', message: `The ${this.label} request changed before the answer was submitted.` };
    }
    const id = current.requestId;
    if (!id) return { status: 'uncertain', message: `The ${this.label} request has no native request id.` };
    const pending = this.pending.get(id);
    if (!pending) return { status: 'uncertain', message: `${this.label} no longer has this request pending.` };
    if (!current.actions.some(action => action.id === response.action)) {
      throw new AppError('INVALID_NATIVE_INTERACTION', `The selected action is not available for this ${this.label} request`, 400);
    }
    if (pending.candidateSent) {
      // A fresh retry key is not a license to journal an invalid candidate. Validate against the
      // still-current request before writing its uncertain receipt; never submit a second choice.
      if (pending.request.method === 'item/tool/requestUserInput' && response.action !== 'cancel') {
        const question = asArray<RpcQuestion>(pending.request.params.questions)[pending.currentQuestion];
        if (!question) throw new AppError('INVALID_NATIVE_INTERACTION', `The ${this.label} question is no longer available.`, 400);
        answerValues(question, response);
      } else if (pending.request.method === 'mcpServer/elicitation/request'
        && (response.action === 'answer' || response.action === 'accept')) {
        elicitationContent(pending.request.params.requestedSchema, response);
      }
      const result = { status: 'uncertain' as const, message: `${this.label} is still resolving this answer.` };
      this.saveInteractionResponse(response, fingerprint, result);
      return result;
    }
    const method = pending.request.method;
    let result: Record<string, unknown>;
    if (method === 'item/tool/requestUserInput') {
      if (response.action === 'cancel') {
        const cancellation = { status: 'uncertain' as const, message: `The ${this.label} turn is being interrupted.` };
        this.saveInteractionResponse(response, fingerprint, cancellation);
        await this.interrupt(str(pending.request.params.turnId), str(pending.request.params.threadId));
        return cancellation;
      }
      const questions = asArray<RpcQuestion>(pending.request.params.questions);
      const question = questions[pending.currentQuestion];
      if (!question) return { status: 'uncertain', message: `The ${this.label} question is no longer available.` };
      const answer = answerValues(question, response);
      if (pending.currentQuestion + 1 < questions.length) {
        const answers = { ...pending.answers, [question.id ?? String(pending.currentQuestion)]: { answers: answer } };
        const nextIndex = pending.currentQuestion + 1;
        const nextRevision = `${pending.request.id}:${pending.revisionCounter + 1}`;
        const nextInteraction = questionInteraction(pending.request, questions[nextIndex]!, nextIndex, questions.length, nextRevision, pending.interaction.id);
        nextInteraction.requestId = id;
        const advanced = { status: 'advanced' as const, interaction: nextInteraction };
        this.saveInteractionResponse(response, fingerprint, advanced);
        pending.answers = answers;
        pending.currentQuestion += 1;
        pending.revisionCounter += 1;
        pending.interaction = nextInteraction;
        this.interaction = pending.interaction;
        this.emit({ type: 'status', status: { ...this.status, phase: 'attention', interaction: this.interaction } });
        return advanced;
      }
      pending.answers[question.id ?? String(pending.currentQuestion)] = { answers: answer };
      result = { answers: pending.answers };
    } else if (method === 'mcpServer/elicitation/request') {
      const mode = str(pending.request.params.mode);
      if (response.action !== 'answer' && response.action !== 'accept') result = { action: response.action === 'cancel' ? 'cancel' : 'decline', content: null, _meta: null };
      else {
        if (mode === 'url') {
          const unsupported = { status: 'uncertain' as const, message: `This ${this.label} URL request cannot be answered from the current web form.` };
          this.saveInteractionResponse(response, fingerprint, unsupported);
          return unsupported;
        }
        const content = elicitationContent(pending.request.params.requestedSchema, response);
        result = { action: 'accept', content, _meta: null };
      }
    } else if (method === 'item/permissions/requestApproval') {
      const permissions = Object.fromEntries(Object.entries(asRecord(pending.request.params.permissions) ?? {}).filter(([, value]) => value != null));
      result = response.action === 'approve' || response.action === 'approveForSession'
        ? { permissions, scope: response.action === 'approveForSession' ? 'session' : 'turn' }
        : { permissions: {}, scope: 'turn' };
    } else if (method === 'item/commandExecution/requestApproval') {
      result = { decision: commandApprovalDecision(pending.request, response.action) };
    } else if (method === 'item/fileChange/requestApproval') {
      const decision = response.action === 'approveForSession' ? 'acceptForSession'
        : response.action === 'approve' ? 'accept' : response.action === 'cancel' ? 'cancel' : 'decline';
      result = { decision };
    } else if (method === 'mode/changeRequested') {
      // Answered through its own request rather than a server-request reply; resolved by `mode/changeResolved`.
      const decision = response.action === 'approve' ? 'approved' : response.action === 'cancel' ? 'cancelled' : 'rejected';
      const modeRequest = this.modeRequests.get(pending);
      if (modeRequest) {
        // Settings before the choice is actually submitted are its baseline, not a later native
        // override. A model-only update carrying the same Plan mode must not defeat approval.
        modeRequest.observation = this.modeObservation;
        modeRequest.decision = decision;
      }
      const candidate = { status: 'uncertain' as const, message: `Answer sent; ${this.label} is resolving it.` };
      this.saveInteractionResponse(response, fingerprint, candidate);
      pending.candidateResponse = { requestId: response.requestId, fingerprint };
      pending.candidateSent = true;
      try {
        await this.requireTransport().request('mode/change/respond', {
          threadId: str(pending.request.params.threadId) ?? this.nativeSessionId,
          requestId: str(pending.request.params.requestId),
          decision,
        });
      } catch (error) {
        // A resolved notification may win the race with an RPC error. Its durable receipt is
        // stronger than that error; a missing pending request is terminal, not permission denied.
        const receipt = this.candidateReceipt(pending);
        if (receipt && (receipt.result.status === 'completed' || this.pending.get(id) !== pending)) return receipt.result;
        // Only a protocol rejection proves the choice was not accepted. A timeout/disconnect
        // leaves it uncertain, so a fresh card must not send a second choice under a new key.
        const rpcCode = (error as { rpcCode?: number })?.rpcCode;
        if (typeof rpcCode === 'number') pending.candidateSent = false;
        const expired = rpcCode === -32600
          && /No pending mode change found for request_id:/i.test(error instanceof Error ? error.message : '');
        const failed = { status: 'uncertain' as const, message: expired
          ? `This ${this.label} mode request has expired; no choice was confirmed. Request a new mode change in the native terminal.`
          : safeProviderError(error, this.profileConfig) };
        this.saveInteractionResponse(response, fingerprint, failed);
        if (expired) this.releaseModeChange(id, pending, failed.message);
        return failed;
      }
      return await this.confirmAnswer(pending, candidate);
    } else if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      const decision = response.action === 'approveForSession' ? 'approved_for_session'
        : response.action === 'approve' ? 'approved'
          : response.action === 'cancel' ? 'abort' : { denied: { rejection: 'Rejected from the workbench.' } };
      result = { decision };
    } else {
      return { status: 'uncertain', message: `This ${this.label} request type is not supported by the web controls.` };
    }
    const candidate = { status: 'uncertain' as const, message: `Answer sent; ${this.label} is resolving it.` };
    this.saveInteractionResponse(response, fingerprint, candidate);
    pending.candidateResponse = { requestId: response.requestId, fingerprint };
    pending.candidateSent = true;
    const confirmed = this.confirmAnswer(pending, candidate);
    pending.resolve?.(result);
    return await confirmed;
  }

  /**
   * Like Claude's acknowledgement wait: the reply has gone out on this socket, and the provider says
   * `serverRequest/resolved` (or `mode/changeResolved`) right after it. Waiting that moment lets the
   * card close as answered instead of lingering as unconfirmed with sync controls.
   */
  private async confirmAnswer(pending: CodexPendingInteraction, candidate: NativeInteractionResult): Promise<NativeInteractionResult> {
    // A mode-change notification can arrive before its RPC reply. The durable receipt then already
    // contains the confirmation, before this waiter has had a chance to subscribe.
    const receipt = this.candidateReceipt(pending);
    if (receipt && (receipt.result.status === 'completed' || this.pending.get(pending.interaction.requestId ?? String(pending.request.id)) !== pending)) return receipt.result;
    const settled = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), ANSWER_CONFIRM_MS);
      timer.unref();
      pending.onSettled = () => { clearTimeout(timer); resolve(true); };
    });
    pending.onSettled = undefined;
    return settled ? this.candidateReceipt(pending)?.result ?? candidate : candidate;
  }

  private candidateReceipt(pending: CodexPendingInteraction): NativeInteractionReceipt | undefined {
    const sent = pending.candidateResponse;
    const receipt = sent ? this.host.getInteractionReceipt(this.session.id, sent.requestId) : undefined;
    return receipt?.fingerprint === sent?.fingerprint ? receipt : undefined;
  }

  /** Whether a blocking request with this interaction id is waiting on this runtime's own live socket. */
  holdsInteraction(interactionId: string): boolean {
    if (!this.transport?.isOnline) return false;
    for (const pending of this.pending.values()) {
      if (pending.interaction.id === interactionId) return true;
    }
    return false;
  }

  /** What the card shows: a blocking request first, then the oldest unanswered async question. */
  get currentInteraction(): NativeInteraction | undefined {
    return this.interaction ?? this.asyncInteraction();
  }

  private asyncInteraction(): NativeInteraction | undefined {
    const next = this.asyncQuestions[0];
    return next ? asyncQuestionInteraction(next, this.label) : undefined;
  }

  /** A blocking request's interaction is the caller's to set; otherwise the pending async question rides along. */
  private withAsyncQuestion(status: NativeStatus): NativeStatus {
    const { interaction, ...rest } = status;
    const shown = interaction && !isAsyncQuestionInteraction(interaction) ? interaction : this.asyncInteraction();
    return shown ? { ...rest, interaction: shown } : rest;
  }

  private noteAsyncQuestions(item: RpcItem, turnId: string): void {
    const itemId = str(item.id);
    if (!itemId || this.seenAsyncItems.has(itemId)) return;
    const questions = asyncQuestionsOf(item as Record<string, unknown>, turnId);
    if (!questions.length) return;
    this.seenAsyncItems.add(itemId);
    if (this.seenAsyncItems.size > 256) this.seenAsyncItems.delete(this.seenAsyncItems.values().next().value!);
    this.asyncQuestions.push(...questions);
    this.refreshStatus();
  }

  private dropAsyncQuestions(drop: (question: CodexAsyncQuestion) => boolean): void {
    const kept = this.asyncQuestions.filter(question => !drop(question));
    if (kept.length === this.asyncQuestions.length) return;
    this.asyncQuestions = kept;
    this.refreshStatus();
  }

  private async answerAsyncQuestion(question: CodexAsyncQuestion, response: NativeInteractionResponse, fingerprint: string): Promise<NativeInteractionResult> {
    const settle = (result: NativeInteractionResult) => { this.saveInteractionResponse(response, fingerprint, result); return result; };
    const next = (): NativeInteractionResult => {
      const interaction = this.currentInteraction;
      return interaction ? { status: 'advanced', interaction } : { status: 'completed' };
    };
    if (response.action === 'skip') {
      this.dropAsyncQuestions(entry => entry.itemId === question.itemId);
      return settle(next());
    }
    if (response.action !== 'answer') throw new AppError('INVALID_NATIVE_INTERACTION', `The selected action is not available for this ${this.label} question`, 400);
    const answer = asyncAnswerText(question, response);
    if (!answer) throw new AppError('INVALID_NATIVE_INTERACTION', 'Choose an option or type an answer', 400);
    if (!this.nativeSessionId || this.activeTurnId !== question.turnId) {
      this.dropAsyncQuestions(entry => entry.turnId === question.turnId);
      return { status: 'uncertain', message: `The ${this.label} turn that asked this has ended; send the answer as a message.` };
    }
    if (this.sendingAsyncAnswers.has(question.questionItemId)) return { status: 'uncertain', message: `${this.label} is still receiving this answer.` };
    this.sendingAsyncAnswers.add(question.questionItemId);
    try {
      await this.requireTransport().request('turn/steer', {
        threadId: this.nativeSessionId,
        input: [{ type: 'text', text: asyncQuestionReply(question, answer), text_elements: [] }],
        expectedTurnId: question.turnId,
      });
    } catch (error) {
      return { status: 'uncertain', message: safeProviderError(error, this.profileConfig) };
    } finally {
      this.sendingAsyncAnswers.delete(question.questionItemId);
    }
    this.dropAsyncQuestions(entry => entry.questionItemId === question.questionItemId);
    return settle(next());
  }

  private saveInteractionResponse(response: NativeInteractionResponse, fingerprint: string, result: NativeInteractionResult): void {
    const previous = this.host.getInteractionReceipt(this.session.id, response.requestId);
    const receipt: NativeInteractionReceipt = {
      fingerprint,
      interactionId: response.interactionId,
      revision: response.revision,
      result,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
    };
    this.host.saveInteractionReceipt(this.session.id, response.requestId, receipt);
  }

  private resolveCandidateReceipt(pending: CodexPendingInteraction, result: NativeInteractionResult = { status: 'completed', message: `${this.label} resolved the native request.` }): void {
    pending.onSettled?.();
    const candidate = pending.candidateResponse;
    if (!candidate) return;
    const previous = this.host.getInteractionReceipt(this.session.id, candidate.requestId);
    if (!previous || previous.fingerprint !== candidate.fingerprint) return;
    this.host.saveInteractionReceipt(this.session.id, candidate.requestId, {
      ...previous,
      result,
    });
  }

  async dispose(host: NativeBackendHost, options: { keepRunning?: boolean } = {}): Promise<void> {
    this.detachObservation?.();
    this.detachObservation = undefined;
    this.requestInterrupt();
    for (const pending of this.pending.values()) {
      pending.resolve?.(NO_SERVER_RESPONSE);
    }
    this.pending.clear();
    this.interaction = undefined;
    this.asyncQuestions = [];
    const transport = this.transport;
    this.transport = undefined;
    const preserveOwner = options.keepRunning && (this.transportBorrowed || this.attached);
    if (preserveOwner && transport?.detach) await transport.detach();
    else await transport?.dispose();
    await this.releaseAttachment(Boolean(preserveOwner));
    if (!options.keepRunning && this.terminalId) await host.terminal.stop(this.terminalId).catch(() => undefined);
    this.transportBorrowed = false;
    this.attached = false;
    this.listeners.clear();
    this.subagents.clear();
    this.drafts.clear();
    this.importStopped = true;
    this.activities.dispose();
    if (this.historyPoll) clearTimeout(this.historyPoll);
    this.historyPoll = undefined;
    this.refreshStatus({ link: 'offline', model: undefined, notice: undefined, connection: { state: 'failed', message: `This ${this.label} client is disconnected.` } });
  }

  recordSubmittedTurn(turnId: string, runId: string, commandId: string): void {
    const previous = this.commandRuns.get(commandId);
    this.commandRuns.set(commandId, { ...(previous ?? {}), commandId, runId, createdAt: previous?.createdAt ?? new Date().toISOString() });
    this.rememberTurnCommand(turnId, commandId, false);
    const completedBeforeAck = this.pendingTurnOutcomes.get(turnId);
    if (completedBeforeAck) {
      this.pendingTurnOutcomes.delete(turnId);
      this.emitTurnOutcome(completedBeforeAck, turnId);
    }
  }

  /** The highest number handed out so far: a steer's baseline for "events after the input". */
  private get headSequence(): number { return this.space.peekNext() - 1; }

  private requireTransport(): CodexAppServerClient {
    if (!this.transport?.isOnline) throw new Error(`${this.label} app-server is offline`);
    return this.transport;
  }

  private async discardFailedTransport(): Promise<void> {
    this.history.beginMaterialization();
    const transport = this.transport;
    this.transport = undefined;
    this.attached = false;
    if (!transport) return;
    if (this.transportBorrowed && transport.detach) await transport.detach();
    else await transport.dispose();
    await this.releaseAttachment(this.transportBorrowed);
  }

  hasEmptyHistoryBaseline(threadId: string): boolean {
    return this.history.materialization?.threadId === threadId;
  }

  private rolloutSpan(threadId: string, item: RpcItem): ItemSpan | undefined {
    return this.itemSpans?.threadId === threadId ? this.itemSpans.spans(item) : undefined;
  }

  private async loadItemSpans(threadId: string): Promise<void> {
    const spans = await rolloutItemSpans(this.flavor.stateHome(this.profileConfig), threadId);
    if (spans) this.itemSpans = { threadId, spans };
  }

  private async readRolloutPlanSnapshot(threadId: string, turns: readonly RpcTurn[]): Promise<RolloutPlanSnapshot | undefined> {
    try {
      const path = await this.rolloutFile(threadId);
      if (!path) return undefined;
      const info = await stat(path);
      const generation = `${threadId}:${path}:${info.size}:${info.mtimeMs}`;
      let snapshot: RolloutPlanSnapshot | undefined;
      if (this.rolloutPlanCache?.generation === generation) snapshot = this.rolloutPlanCache.snapshot;
      else {
        snapshot = info.size <= MAX_ROLLOUT_BYTES ? parseRolloutPlan(await readFile(path, 'utf8')) : undefined;
        this.rolloutPlanCache = { generation, snapshot };
      }
      if (!snapshot) return undefined;
      return planSnapshotForTurns(snapshot, turns);
    } catch {
      // Rollout history is an optional recovery source; unreadable or partial logs must not hide
      // the app-server transcript.
      return undefined;
    }
  }

  /**
   * One transcript read at a time. A caller arriving mid-read shares a single follow-up read that
   * starts after it, so it still sees state at least as new as its call.
   */
  private refreshEvents(): Promise<NativeWorkbenchEvent[] | undefined> {
    if (!this.refreshTask) {
      const task = this.readEvents().finally(() => { if (this.refreshTask === task) this.refreshTask = undefined; });
      this.refreshTask = task;
      return task;
    }
    this.refreshQueued ??= this.refreshTask.catch(() => undefined).then(() => {
      this.refreshQueued = undefined;
      return this.refreshEvents();
    });
    return this.refreshQueued;
  }

  private async readEvents(): Promise<NativeWorkbenchEvent[] | undefined> {
    const materializationBeforeRead = this.history.materialization;
    const statusBeforeRead = this.status;
    const activeTurnBeforeRead = this.activeTurnId;
    const foregroundEndedBeforeRead = this.foregroundEndedTurnId;
    const threadId = this.nativeSessionId;
    if (!threadId || !this.transport?.isOnline) {
      this.historySnapshotReady = false;
      return;
    }
    // A concurrent poll must not invalidate the successful snapshot another caller just awaited.
    // Keep that snapshot ready until this read either replaces it or actually fails.
    const eventsBeforeRead = new Map(this.events.map(event => [event.nativeId, event]));
    const draftsBeforeRead = this.drafts.texts();
    const window = await this.history.readThreadWindow(threadId);
    // Before its first user message a new thread has no native history yet. Keep that normal
    // preparation distinct from a reader that cannot read this thread at all.
    if (!window || window === 'pending') {
      this.historySnapshotReady = false;
      if (window === 'pending') this.setHistory({ state: 'loading' });
      else this.noteHistoryUnavailable();
      return;
    }
    const turns = window.turns;
    if (!this.space.initialized) this.chooseLog(threadId, window.complete);
    else if (this.space.ready && this.logTrailsThread(window)) {
      // The log stops short of this window: turns ran while nobody was reading. Serve the tail from a
      // scratch window and let a background import close the gap in order.
      this.space.writeState({ ...this.space.ingestState()!, phase: 'importing' });
      this.space.unbind();
      this.events.length = 0;
      this.seenEvents.clear();
      this.provisionalRows = new Map();
      return await this.readEvents();
    }
    // A settled turn whose marker has not moved since the last published read cannot have changed.
    const markersNow = turnMarkers(turns);
    const stableTurns = stableTurnIdsOf(turns, markersNow, this.turnMarkersSeen);
    this.stableTurnIds = stableTurns;
    const rolloutPlan = await this.readRolloutPlanSnapshot(threadId, turns);
    await this.loadItemSpans(threadId);
    // Until the first read has finished, nothing is published: notifications that arrived meanwhile
    // were numbered provisionally and are numbered for good, in conversational order, by this pass.
    const initializing = !this.space.initialized;
    for (const turn of turns) {
      this.restoreTurnCommands(turn.id);
      for (const item of asArray<RpcItem>(turn.items)) {
        const commandId = this.commandIdOf(item, turn.id);
        if (!commandId) continue;
        const previous = this.commandRuns.get(commandId);
        const runId = previous?.runId ?? this.host.findRunIdByCommand(this.session.id, commandId);
        this.commandRuns.set(commandId, {
          ...(runId ? { runId } : {}), commandId,
          createdAt: previous?.createdAt ?? toIso(typeof turn.startedAt === 'number' ? turn.startedAt * 1000 : undefined) ?? new Date().toISOString(),
        });
        this.rememberTurnCommand(turn.id, commandId, true);
      }
    }
    const plansByTurn = new Map<string, NativeWorkbenchEvent>();
    if (rolloutPlan?.turnId) plansByTurn.set(rolloutPlan.turnId, this.rolloutPlanEvent(threadId, rolloutPlan));
    for (const [turnId, event] of this.livePlanSnapshots) {
      const current = plansByTurn.get(turnId);
      if (!current || Date.parse(event.createdAt) >= Date.parse(current.createdAt)) plansByTurn.set(turnId, event);
    }
    const orderedTurns = new Set(turns.map(turn => turn.id));
    const loosePlans = [...plansByTurn].filter(([turnId]) => !orderedTurns.has(turnId)).map(([, event]) => event);
    if (rolloutPlan && !rolloutPlan.turnId) loosePlans.push(this.rolloutPlanEvent(threadId, rolloutPlan));
    loosePlans.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    let loosePlanIndex = 0;
    const events: NativeWorkbenchEvent[] = [];
    // A turn that is still running is served under positional item ids naming the same items as the
    // ids it is written with, so this read holds its text to what the turn already shows and
    // remembers the copies it adds, for the settled read to take back.
    const shown = this.shownTextRows(threadId, turns.map(turn => turn.id));
    const provisionalRows = new Map<string, string[]>();
    const superseded = new Set<string>();
    const committed = new Set<string>();
    const streaming = new Set<string>();
    for (const turn of turns) {
      if (!stableTurns.has(turn.id)) { this.noteTurnStart(turn); this.noteCompactions(turn); }
      const turnStartedAt = typeof turn.startedAt === 'number' ? turn.startedAt * 1_000 : Number.NEGATIVE_INFINITY;
      while (loosePlanIndex < loosePlans.length && Date.parse(loosePlans[loosePlanIndex]!.createdAt) <= turnStartedAt) {
        const planEvent = loosePlans[loosePlanIndex++]!;
        events.push(this.withStableSequence(planEvent));
        this.pushEvent(planEvent);
      }
      // Number the complete turn before publishing its receipts. Numbering every user first and
      // the remaining items after the loop groups all questions ahead of all answers on recovery.
      const projected = this.projectTurnItems(turn, { shown, provisionalRows, superseded });
      const planEvent = plansByTurn.get(turn.id);
      if (planEvent) insertPlanEvent(projected, planEvent, rolloutPlan, turn.id);
      const final = isFinalTurnStatus(turn.status);
      for (const event of projected) {
        const numbered = this.withStableSequence(event);
        if (final) committed.add(event.nativeId);
        const text = str(asRecord(event.data.content)?.text);
        if (!final && text !== undefined && this.drafts.adoptPartial(event.nativeId, text, draftsBeforeRead.get(event.nativeId), numbered.sequence, event.data.phase)) {
          streaming.add(event.nativeId);
          continue;
        }
        events.push(numbered);
      }
      this.projectKnownUserReceipts(turn);
      if (planEvent) this.pushEvent(planEvent);
      if (isFinalTurnStatus(turn.status) && !(turnStatus(turn.status) === 'interrupted' && this.isTurnRunning(threadId, turn))) {
        events.push(...this.emitTurnOutcome(turn, turn.id));
      }
      if (!stableTurns.has(turn.id)) this.noteTurnEnd(turn);
    }
    while (loosePlanIndex < loosePlans.length) {
      const planEvent = loosePlans[loosePlanIndex++]!;
      events.push(this.withStableSequence(planEvent));
      this.pushEvent(planEvent);
    }
    const unique = mergeResidentEvents(events, this.events, superseded, streaming, this.liveCompletedIds, committed, eventsBeforeRead);
    for (const nativeId of streaming) this.seenEvents.delete(nativeId);
    for (const nativeId of superseded) {
      this.seenEvents.delete(nativeId);
      this.space.retire(nativeId);
    }
    this.provisionalRows = provisionalRows;
    const full = [...unique.values()].map(event => this.numbered(event)).sort((left, right) => left.sequence - right.sequence);
    const limited = full.slice(-MAX_EVENTS);
    this.events.splice(0, this.events.length, ...limited);
    for (const event of this.events) this.seenEvents.add(event.nativeId);
    this.drafts.settleCommitted(nativeId => committed.has(nativeId) || this.liveCompletedIds.has(nativeId));
    const retained = new Set(this.events.map(event => event.nativeId));
    for (const id of this.liveCompletedIds) if (!retained.has(id)) this.liveCompletedIds.delete(id);
    if (initializing) {
      this.drafts.resequence(nativeId => this.space.seqOf(nativeId));
      this.space.markInitialized();
    }
    const phaseStillCurrent = this.status === statusBeforeRead && this.activeTurnId === activeTurnBeforeRead
      && this.foregroundEndedTurnId === foregroundEndedBeforeRead && !this.dispatchCommandId;
    if (turns.length && phaseStillCurrent) {
      const latest = turns.at(-1)!;
      const target = this.activeTurnId ? turns.find(turn => turn.id === this.activeTurnId) : undefined;
      // A bounded read can miss a just-started target. Only that target's own terminal record
      // clears it; an interrupted copy of a turn we still drive may be provisional.
      if (target && isFinalTurnStatus(target.status) &&
        !(turnStatus(target.status) === 'interrupted' && this.isTurnRunning(threadId, target))) {
        this.activeTurnId = undefined;
        this.foregroundEndedTurnId = target.id;
      }
      // Only an ordered turn after the observed end can provide new foreground work. A read
      // stopping before a newer live end, or its same-turn inProgress copy, cannot undo that fact.
      const endedIndex = this.foregroundEndedTurnId ? turns.findIndex(turn => turn.id === this.foregroundEndedTurnId) : -1;
      const pastEnd = !this.foregroundEndedTurnId || (endedIndex >= 0 && endedIndex < turns.length - 1);
      const active = turnStatus(latest.status) === 'inProgress' && pastEnd
        && (!this.activeTurnId || target) ? latest : undefined;
      if (active) {
        this.activeTurnId = active.id;
        this.foregroundEndedTurnId = undefined;
        if (!!!this.metering.active(active.id) && !this.metering.isSettled(active.id)) {
          const meter = this.metering.meterFor(active.id);
          const hasAssistantOrTool = asArray<RpcItem>(active.items).some(item => item.type !== 'userMessage');
          meter.requestStartAt ??= !hasAssistantOrTool && typeof active.startedAt === 'number'
            ? active.startedAt * 1000
            : Date.now();
        }
      } else if (!this.activeTurnId && (!this.foregroundEndedTurnId || endedIndex >= 0)
        && (turnStatus(latest.status) === 'completed' || turnStatus(latest.status) === 'failed')) {
        this.foregroundEndedTurnId = latest.id;
      } else if (turnStatus(latest.status) === 'interrupted' && pastEnd) {
        // An active TRAE thread can expose a newly starting turn as interrupted before rollout
        // catches up. Without a live end for this turn, aggregate active remains busy.
        this.foregroundEndedTurnId = undefined;
      }
    }
    const statusBeforeThread = this.status;
    const activeTurnBeforeThread = this.activeTurnId;
    const foregroundEndedBeforeThread = this.foregroundEndedTurnId;
    // The first real turn page can arrive before the provider's metadata view catches up. Use
    // this read's initial evidence even if that page just completed materialization; later reads
    // still start without the grace, and genuine or foreign-thread errors remain failures.
    const thread = await this.history.readThread(threadId, false, materializationBeforeRead);
    this.noteThread(thread);
    if (thread) {
      this.adoptProviderTitle(typeof thread.name === 'string' ? thread.name : undefined);
      // `notLoaded` is an observation about this reader connection. It cannot prove that another
      // Codex endpoint stopped the thread, so only an explicitly attached owner drives phase.
      if (phaseStillCurrent && this.status === statusBeforeThread && this.activeTurnId === activeTurnBeforeThread &&
        this.foregroundEndedTurnId === foregroundEndedBeforeThread && !this.dispatchCommandId &&
        (this.attached || (this.loadedCheck === true && this.loadedCheckThreadId === threadId && Date.now() - this.loadedCheckAt < 5_000))) {
        const target = this.activeTurnId ? turns.find(turn => turn.id === this.activeTurnId) : undefined;
        // Unlike a provisional interrupted copy on an active thread, the same target plus the
        // verified owner's idle/error state confirms a lost interruption completion.
        if (target && turnStatus(target.status) === 'interrupted' &&
          (thread.status?.type === 'idle' || thread.status?.type === 'systemError')) {
          this.activeTurnId = undefined;
          this.foregroundEndedTurnId = target.id;
          this.emitTurnOutcome(target, target.id);
          this.noteTurnEnd(target);
        }
        this.applyThreadStatus(thread.status);
      }
    }
    this.history.noteMaterialized(threadId, turns);
    this.turnMarkersSeen = markersNow;
    this.transcriptLoaded = true;
    this.noteHistoryReady();
    this.historySnapshotReady = true;
    this.recordIngest(turns, window.complete);
    if (this.space.bound === 'scratch') this.startImport(threadId);
    // Children are followed on the same tick, but a slow child must not hold up the conversation.
    this.subagents.note(turns);
    void this.subagents.refresh();
    return full;
  }

  // ---- journal ingest ---------------------------------------------------------------------------

  /** Decides, at the first read of a thread, which log serves it and how its history gets in. */
  private chooseLog(threadId: string, complete: boolean): void {
    this.space.adoptThread(threadId);
    if (this.space.ingestState()?.phase === 'ready' || complete) this.space.bind('real');
    else this.space.bind('scratch');
  }

  /** Whether the log's last ingested turn is missing from a window that does not reach the thread's start. */
  private logTrailsThread(window: { turns: RpcTurn[]; complete: boolean }): boolean {
    if (window.complete) return false;
    const state = this.space.ingestState();
    // A log that has seen no turn at all (the thread was empty when it was written) trails any thread that has grown.
    if (!state?.settled && !state?.open) return true;
    return !window.turns.some(turn => turn.id === state.settled || turn.id === state.open);
  }

  private turnTime(seconds: unknown): string | undefined {
    return typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined;
  }

  /** Synthetic row opening a turn, named as the lane writer names it (`journal/ingest.ts`). Same payload every time, so re-reading a turn writes nothing. */
  private noteTurnStart(turn: RpcTurn): void {
    this.space.meta('meta.turn_started', turnMetaId(turn.id, 'started'), turn.id, this.turnTime(turn.startedAt), { turnId: turn.id });
  }

  /** A read of a turn: brings compactions and background terminals it shows into line with what is live. */
  private noteCompactions(turn: RpcTurn): void {
    this.activities.noteTurn(turn, isFinalTurnStatus(turn.status), !this.importBatch);
  }

  /**
   * Writes one state of a system activity: a new version of its row in the log (under the number its first
   * state got), the resident transcript, and the live stream. Settled history being imported is only logged.
   */
  private writeActivity(activity: NativeActivity, turnId: string | undefined): void {
    const run = turnId ? this.turnRuns.get(turnId) : undefined;
    const event = activityEvent(this.session.id, activity, {
      ...(turnId ? { runId: run?.runId ?? turnId, nativeTurnId: turnId } : {}),
      createdAt: this.turnRuns.get(turnId ?? '')?.createdAt ?? activity.startedAt,
    });
    try { this.feed?.activity(activity); } catch { /* as for notifications */ }
    const row = this.space.assignRow(event);
    // The entity stays where its first state was written; a later state is announced under its own row's number, above everything sent.
    const sequenced = { ...event, sequence: row.identity };
    if (this.importBatch) { this.importBatch.push(sequenced); return; }
    const index = this.events.findIndex(candidate => candidate.nativeId === event.nativeId);
    if (index >= 0) this.events[index] = sequenced;
    else {
      this.seenEvents.add(event.nativeId);
      this.events.splice(this.events.findLastIndex(existing => existing.sequence < sequenced.sequence) + 1, 0, sequenced);
    }
    this.refreshStatus();
  }

  /** Stops a background terminal; `stopping` at once, `stopped` when the provider's list or reply says it is gone. */
  async stopActivity(activityId: string): Promise<NativeActivity> { return await this.activities.stop(activityId); }

  // ---- the journal's transcript source (sync v3) ------------------------------------------------

  /** Passes this thread's notifications and activity states on to `feed` until the returned function is called. */
  attachFeed(feed: CodexLiveFeed): () => void {
    this.feed = feed;
    return () => { if (this.feed === feed) this.feed = undefined; };
  }

  /** The workbench command a user item answers; see `commandIdOf`. */
  commandOf(item: RpcItem, turnId: string): string | undefined { return this.commandIdOf(item, turnId); }

  /** Native question requests known before this reader attached; answers are never copied. */
  questionRequests(threadId: string): RpcItem[] { return this.questionHistory.requests(threadId); }

  /** Shared with transcript ingest: history can temporarily misreport our executing turn as interrupted. */
  isTurnRunning(threadId: string, turn: RpcTurn): boolean {
    return this.transport?.isOnline === true && threadId === this.nativeSessionId
      && !this.pendingTurnOutcomes.has(turn.id) && this.drivesTurn(turn);
  }

  /**
   * One page of `thread/turns/list` over this runtime's connection. An app-server too old for the
   * method answers from the legacy `thread/read`, paged here by position; a thread not materialized
   * yet reads as undefined.
   */
  async turnsPage(request: CodexTurnsRequest): Promise<CodexTurnPage | undefined> {
    const materialization = this.history.materialization;
    const { threadId, cursor, limit, sortDirection, itemsView } = request;
    const params = { threadId, ...(cursor ? { cursor } : {}), limit, sortDirection, itemsView: itemsView ?? 'full' };
    let flushError: unknown;
    try {
      const page = await this.requireTransport().request<CodexTurnPage>('thread/turns/list', params);
      if (Array.isArray(page.data)) this.history.noteMaterialized(threadId, page.data);
      this.history.clearChildPending(threadId);
      return page;
    } catch (error) {
      if (!cursor && this.history.isHistoryPending(threadId, error, materialization)) {
        return this.history.isEmptyNewThread(threadId) ? { data: [], nextCursor: null } : undefined;
      }
      if (this.history.isChildFlushUnavailable(threadId, error)) {
        // A child may unload between lookup and live-history flush. Retry the same page first;
        // persisted legacy history is a fallback only at the head (opaque cursors cannot be
        // translated safely). Never replace it with an empty successful snapshot.
        try {
          const page = await this.requireTransport().request<CodexTurnPage>('thread/turns/list', params);
          if (Array.isArray(page.data)) this.history.noteMaterialized(threadId, page.data);
          this.history.clearChildPending(threadId);
          return page;
        } catch (retryError) {
          if (!this.history.isChildFlushUnavailable(threadId, retryError) || (cursor && !cursor.startsWith('legacy:'))) throw retryError;
          flushError = retryError;
        }
      } else if (!isTurnsListUnsupportedError(error)) throw error;
    }
    const turns = await this.history.readLegacyTurns(threadId);
    if (flushError && (!turns || turns === 'pending' || !turns.length)) throw flushError;
    if (!turns || turns === 'pending') return undefined;
    this.history.clearChildPending(threadId);
    const at = cursor?.startsWith('legacy:') ? Number(cursor.slice('legacy:'.length)) : sortDirection === 'asc' ? 0 : turns.length;
    const start = sortDirection === 'asc' ? at : Math.max(0, at - limit);
    const end = sortDirection === 'asc' ? Math.min(turns.length, at + limit) : at;
    const data = turns.slice(start, end);
    const more = sortDirection === 'asc' ? end < turns.length : start > 0;
    return { data: sortDirection === 'asc' ? data : data.reverse(), nextCursor: more ? `legacy:${sortDirection === 'asc' ? end : start}` : null };
  }

  private noteTurnEnd(turn: RpcTurn): void {
    if (!isFinalTurnStatus(turn.status)) return;
    this.space.meta('meta.turn_ended', turnMetaId(turn.id, 'ended'), turn.id, this.turnTime(turn.completedAt),
      { turnId: turn.id, status: turnStatus(turn.status), ...(turnStatus(turn.status) === 'failed' ? { error: safeTurnError(turn.error, this.profileConfig) } : {}) });
  }

  /** Writes how far the thread has been read: the newest settled turn, and the turn still running. */
  private recordIngest(turns: readonly RpcTurn[], complete: boolean): void {
    if (this.space.bound !== 'real') return;
    const previous = this.space.ingestState();
    const settled = turns.findLast(turn => isFinalTurnStatus(turn.status))?.id ?? previous?.settled;
    const open = turns.findLast(turn => !isFinalTurnStatus(turn.status))?.id;
    // A bounded read that did not reach the thread's start must not claim a log it has not written.
    if (!complete && previous?.phase !== 'ready') return;
    this.space.writeState({ phase: 'ready', ...(settled ? { settled } : {}), ...(open ? { open } : {}), turns: previous?.turns ?? 0 });
  }

  /**
   * Projects settled turns into `space`'s log and commits them, with the ingest cursor, in one
   * transaction. Nothing is shown to listeners or kept resident: this is history on its way into the
   * journal. A turn already logged writes nothing (an identical event is skipped), so re-running a
   * batch after a crash, or overlapping one that was committed, neither duplicates nor drops rows.
   */
  ingestSettledTurns(turns: readonly RpcTurn[], options: { space?: CodexJournalSpace; state?: Omit<CodexIngestState, 'v' | 'threadId'> } = {}): number {
    const live = this.space;
    const space = options.space ?? this.space;
    const written: NativeWorkbenchEvent[] = [];
    this.space = space;
    this.importBatch = written;
    try {
      space.batch(() => {
        for (const turn of turns) {
          this.restoreTurnCommands(turn.id);
          for (const item of asArray<RpcItem>(turn.items)) {
            const commandId = this.commandIdOf(item, turn.id);
            if (!commandId) continue;
            const previous = this.commandRuns.get(commandId);
            const runId = previous?.runId ?? this.host.findRunIdByCommand(this.session.id, commandId);
            this.commandRuns.set(commandId, {
              ...(runId ? { runId } : {}), commandId,
              createdAt: previous?.createdAt ?? this.turnTime(turn.startedAt) ?? new Date().toISOString(),
            });
            this.rememberTurnCommand(turn.id, commandId, true);
          }
          this.noteTurnStart(turn);
          this.noteCompactions(turn);
          const projected = this.projectTurnItems(turn, { shown: new Map(), provisionalRows: new Map(), superseded: new Set() });
          for (const event of projected) this.withStableSequence(event);
          this.projectKnownUserReceipts(turn);
          if (isFinalTurnStatus(turn.status) && !(turnStatus(turn.status) === 'interrupted' && this.isTurnRunning(this.nativeSessionId ?? '', turn))) this.emitTurnOutcome(turn, turn.id);
          this.noteTurnEnd(turn);
        }
        if (options.state) space.writeState({ ...options.state, turns: (space.ingestState()?.turns ?? 0) + turns.length });
      });
    } finally {
      this.space = live;
      this.importBatch = undefined;
    }
    return written.length;
  }

  /** Starts the background import of the thread's history into the real log, once at a time. */
  private startImport(threadId: string): void {
    // The journal's reader imports the thread itself.
    if (this.journalRead) return;
    if (this.importTask || this.importStopped || !this.transport?.isOnline) return;
    const task = this.importHistory(threadId)
      .catch(error => console.warn('[codex-journal] history import paused; it resumes from its cursor on the next read:', safeProviderError(error, this.profileConfig)))
      .finally(() => { if (this.importTask === task) this.importTask = undefined; });
    this.importTask = task;
  }

  /**
   * Imports settled turns oldest first, a few at a time, each step committing its rows together with
   * the cursor (the last turn ingested). Interrupted at any point it resumes after that turn. The
   * running turn is left to the live path. When the thread is caught up the real log takes over from
   * the scratch window.
   */
  private async importHistory(threadId: string): Promise<void> {
    const real = new CodexJournalSpace(this.space.journal, this.session.id, threadId);
    real.bind('real');
    let state = real.ingestState();
    let settled = state?.phase === 'importing' ? state.settled : undefined;
    let open: string | undefined;
    if (!state) real.writeState({ phase: 'importing', turns: 0 });
    let cursor: string | undefined;
    let skipThrough = settled;
    if (settled) {
      const position = await this.locateAfter(threadId, settled);
      if (!position) {
        // The thread no longer contains the turn the log stopped at: it was rewritten. Start over.
        this.space.journal.rebuild(this.session.id);
        real.writeState({ phase: 'importing', turns: 0 });
        settled = undefined; skipThrough = undefined;
      } else cursor = position.cursor;
    }
    for (;;) {
      if (this.importStopped) return;
      const page = await this.requireTransport().request<{ data?: RpcTurn[]; nextCursor?: string | null }>('thread/turns/list', {
        threadId, ...(cursor ? { cursor } : {}), limit: IMPORT_PAGE_TURNS, sortDirection: 'asc', itemsView: 'full',
      });
      if (!Array.isArray(page.data)) throw new Error(`${this.label} app-server thread/turns/list returned invalid history data.`);
      await this.loadItemSpans(threadId);
      let turns = page.data;
      if (skipThrough) {
        const at = turns.findIndex(turn => turn.id === skipThrough);
        if (at >= 0) { turns = turns.slice(at + 1); skipThrough = undefined; } else turns = [];
      }
      const done = turns.findIndex(turn => !isFinalTurnStatus(turn.status));
      const batch = done < 0 ? turns : turns.slice(0, done);
      if (done >= 0) open = turns[done]!.id;
      if (batch.length) {
        settled = batch.at(-1)!.id;
        this.ingestSettledTurns(batch, { space: real, state: { phase: 'importing', settled } });
      }
      if (done >= 0 || !page.nextCursor) break;
      cursor = page.nextCursor;
      // Let notifications and requests run between steps; a long thread is many of them.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (this.importStopped) return;
    real.writeState({ phase: 'ready', ...(settled ? { settled } : {}), ...(open ? { open } : {}), turns: real.ingestState()?.turns ?? 0 });
    this.promoteToRealLog();
  }

  /** The asc-order cursor of the page holding `turnId`, found by scanning turn headers only. */
  private async locateAfter(threadId: string, turnId: string): Promise<{ cursor?: string } | undefined> {
    let cursor: string | undefined;
    for (let pages = 0; pages < 1000; pages += 1) {
      let response: { data?: RpcTurn[]; nextCursor?: string | null };
      const request = (itemsView: string) => this.requireTransport().request<{ data?: RpcTurn[]; nextCursor?: string | null }>('thread/turns/list', {
        threadId, ...(cursor ? { cursor } : {}), limit: 100, sortDirection: 'asc', itemsView,
      });
      try { response = await request('notLoaded'); } catch { response = await request('summary'); }
      if ((response.data ?? []).some(turn => turn.id === turnId)) return cursor ? { cursor } : {};
      if (!response.nextCursor) return undefined;
      cursor = response.nextCursor;
    }
    return undefined;
  }

  /** The real log is complete: the scratch window gives way to it, under the log's own generation. */
  private promoteToRealLog(): void {
    this.space.promote();
    this.events.splice(0, this.events.length, ...this.space.tail(RESIDENT_EVENTS));
    this.seenEvents.clear();
    for (const event of this.events) this.seenEvents.add(event.nativeId);
    this.stableTurnIds = new Set();
    this.turnMarkersSeen = new Map();
    this.drafts.resequence(nativeId => this.space.seqOf(nativeId));
    void this.refreshEvents().catch(() => undefined);
  }

  /** A child's projected events, without the parent's run/command bookkeeping. */
  private projectChildItem(item: RpcItem, turn: RpcTurn, childThreadId: string): NativeWorkbenchEvent[] {
    return this.projectItem(item, turn, { childThreadId, isolated: true });
  }

  private projectItem(item: RpcItem, turn: RpcTurn, options: { childThreadId?: string; isolated?: boolean; span?: ItemSpan } = {}): NativeWorkbenchEvent[] {
    const threadId = options.childThreadId ?? this.nativeSessionId ?? 'unknown';
    const turnRun = options.isolated ? undefined : this.turnRuns.get(turn.id);
    const commandId = options.isolated ? undefined : this.commandIdOf(item, turn.id);
    const commandRun = !options.isolated && commandId ? this.commandRuns.get(commandId) : undefined;
    const runId = commandRun?.runId ?? turnRun?.runId ?? turn.id;
    const createdAt = toIso(typeof turn.startedAt === 'number' ? turn.startedAt * 1000 : undefined) ?? commandRun?.createdAt ?? turnRun?.createdAt ?? new Date().toISOString();
    const main = !options.isolated && !options.childThreadId;
    const span = options.span ?? this.rolloutSpan(threadId, item);
    return projectCodexItem(item, turn, {
      sessionId: this.session.id, threadId, runId, createdAt, ...(commandId ? { commandId } : {}), questions: this.questionHistory,
      ...(span ? { span } : {}),
      ...(this.observation ? { observedChanges: (toolCallId: string) => this.observation?.changes(this.session.id, toolCallId) } : {}),
      // A child thread's first message names the child, not this conversation; its compactions are its own.
      ...(options.childThreadId ? {} : {
        onUserText: (text: string) => this.nameFromMessage(text),
        compaction: (compacted: RpcItem, at: Pick<RpcTurn, 'id' | 'startedAt' | 'status' | 'items'>, settled: boolean) => this.activities.presented(compacted, at, settled),
      }),
      ...(main ? { phase: (itemId: string, nativeId: string) => this.drafts.phase(itemId, nativeId) ?? messagePhase(this.events.find(candidate => candidate.nativeId === nativeId)?.data.phase) } : {}),
    });
  }

  /** Parent ids remain wire-compatible; child request ids are scoped to their native thread. */
  private scopedRequestId(threadId: string | undefined, id: string): string {
    return threadId && threadId !== this.nativeSessionId ? `thread:${encodeURIComponent(threadId)}:${id}` : id;
  }

  private onChildNotification(method: string, params: Record<string, unknown>, threadId: string): void {
    if (method === 'mode/changeRequested') this.raiseModeChange(params);
    else if (method === 'mode/changeResolved') this.settleModeChange(params);
    else if (method === 'serverRequest/resolved') this.settleServerRequest(params);
    else if (method === 'turn/started' || method === 'turn/completed') {
      const turnId = str(asRecord(params.turn)?.id);
      if (!turnId) return;
      const completed = method === 'turn/completed';
      this.subagents.noteTurn(threadId, turnId, completed);
      if (completed) {
        this.completeTurnWaiters(turnId, threadId);
        this.clearTurnInteractions(turnId, threadId);
        this.refreshStatus({ link: 'quiet', notice: undefined });
      }
      void this.subagents.refresh();
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = asRecord(params.item) as RpcItem | undefined;
      const turnId = str(params.turnId);
      if (item && turnId && (item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall')) {
        this.subagents.note([{ id: turnId, items: [item] }], true);
      }
      void this.subagents.refresh();
    }
    // Child settings/status/usage/text are read by the child tracker, not projected or adopted
    // into the parent's mode, permissions, context meter, journal lane or foreground turn.
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    const threadId = str(params.threadId);
    if (threadId && threadId !== this.nativeSessionId) {
      if (this.subagents.owns(threadId)) this.onChildNotification(method, params, threadId);
      return;
    }
    // Native TUI input can precede the workbench's first send. Observe it before waking the
    // journal reader, and never restart the deadline on subsequent items or turns.
    if (threadId === this.nativeSessionId && (method === 'turn/started' || method === 'turn/completed'
      || (method.startsWith('item/') && typeof params.turnId === 'string'))) this.history.beginMaterialization();
    if (method === 'turn/started') {
      this.threadError = false;
      this.foregroundEndedTurnId = undefined;
      const turn = asRecord(params.turn);
      const id = str(turn?.id);
      this.threadErrorTurnId = id;
      if (id) {
        if (this.nativeCommand?.type === 'compact' && !this.nativeCommand.previousTurns.has(id)) {
          this.nativeCommand.startedTurns.add(id);
          if (asArray<RpcItem>(turn?.items).some(item => item.type === 'userMessage')) this.nativeCommand.userTurns.add(id);
        }
        // An unmapped provisional interrupted history copy is not a completion receipt. A native
        // start now names its active turn; committed workbench outcomes still keep their first end.
        if (turnStatus(this.pendingTurnOutcomes.get(id)?.status) === 'interrupted' && !this.settledTurns.has(id)) {
          this.pendingTurnOutcomes.delete(id);
        }
        this.activeTurnId = id;
        this.noteTurnStart({ id, startedAt: typeof turn?.startedAt === 'number' ? turn.startedAt : undefined });
        const commandId = this.nativeCommand ? undefined : this.dispatchCommandId;
        const submitted = commandId ? this.commandRuns.get(commandId) : undefined;
        if (submitted) this.turnRuns.set(id, { ...submitted, commandId });
        const meter = this.metering.meterFor(id);
        if (typeof turn?.startedAt === 'number') meter.requestStartAt = turn.startedAt * 1000;
        else meter.requestStartAt ??= Date.now();
      }
      this.refreshStatus({ link: 'working', notice: undefined });
      try { this.feed?.notification(method, params); } catch { /* the journal's reader must not break the live runtime */ }
      return;
    }
    try { this.feed?.notification(method, params); } catch { /* the journal's reader must not break the live runtime */ }
    // Streamed text is shown as a draft until `item/completed` commits the item and replaces it, so
    // the answer is readable while the TUI is still printing it without ever rendering twice.
    if (method === 'item/agentMessage/delta' || method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      // Output means the turn is no longer waiting in a provider queue.
      if (this.transientNotice) this.showTransientNotice(undefined);
      this.metering.noteStreamDelta(str(params.turnId), params.delta, method, str(params.itemId));
      const threadId = this.nativeSessionId ?? 'unknown';
      const kind = method === 'item/agentMessage/delta' ? 'assistant' : 'thinking';
      const nativeId = `${threadId}:${params.turnId}:${params.itemId}:${kind}`;
      const partial = !this.liveCompletedIds.has(nativeId) ? this.events.find(event => event.nativeId === nativeId) : undefined;
      const text = partial && str(asRecord(partial.data.content)?.text);
      const noted = this.drafts.note(method, params, threadId, partial && text !== undefined ? { text, sequence: partial.sequence, phase: partial.data.phase } : undefined);
      if (partial && text !== undefined && noted === partial.nativeId) {
        this.events.splice(this.events.indexOf(partial), 1);
        this.seenEvents.delete(partial.nativeId);
      }
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      const tokenUsage = asRecord(params.tokenUsage);
      const usage = this.usage.turnUsage(str(params.turnId), tokenUsage);
      if (usage) this.metering.noteTurnUsage(str(params.turnId), usage);
      void this.usage.applyUsageFrame(tokenUsage, params).catch(() => undefined);
      return;
    }
    if (method === 'turn/plan/updated') {
      const turnId = str(params.turnId);
      const entries = normalizePlanEntries(params.plan);
      if (turnId && entries) this.publishPlanSnapshot(turnId, entries, params);
      return;
    }
    if (method === 'turn/completed') {
      const turn = asRecord(params.turn);
      const turnId = str(turn?.id);
      this.observation?.release(this.nativeSessionId);
      this.standingWrites.clear();
      if (turnId && this.nativeCommand?.type === 'compact') {
        const items = asArray<RpcItem>(turn?.items);
        if (items.some(item => item.type === 'userMessage')) this.nativeCommand.userTurns.add(turnId);
        if (items.some(item => item.type === 'contextCompaction')) this.confirmNativeCommand(turnId);
      }
      if (turn && turnId) {
        for (const item of asArray<RpcItem>(turn.items)) {
          if (item.type === 'userMessage') this.noteUserMessage(turnId, this.projectItem(item, turn as unknown as RpcTurn));
          this.metering.noteCompletedOutput(turnId, item);
        }
      }
      if (turnId) this.metering.settleTurnMetrics(turnId);
      if (turn && turnId) this.activities.noteTurn(turn as unknown as RpcTurn, true, true);
      if (turnId) this.activities.turnCompleted(turnId, turn?.status as RpcTurn['status']);
      this.activities.hint();
      this.transientNotice = undefined;
      void this.usage.refreshContextBreakdown();
      if (turn && turnId) {
        const completedTurn = turn as unknown as RpcTurn;
        this.projectKnownUserReceipts(completedTurn);
        this.emitTurnOutcome(completedTurn, turnId);
      }
      if (turnId) this.clearTurnInteractions(turnId);
      if (turnId) {
        this.completeTurnWaiters(turnId);
      }
      if (turnId && this.activeTurnId === turnId) {
        this.activeTurnId = undefined;
        this.foregroundEndedTurnId = turnId;
      } else if (turnId && !this.activeTurnId && !this.foregroundEndedTurnId) {
        this.foregroundEndedTurnId = turnId;
      }
      // An interrupted item may never be committed; the reset below drops whatever it streamed.
      if (turnId) this.drafts.dropTurn(turnId);
      this.refreshStatus({ link: this.dispatchCommandId ? 'working' : 'quiet', notice: undefined });
      if (this.appearancePending && this.status.phase === 'idle') {
        // This handler can inherit the async scope of a locked operation; queue behind it instead.
        const relaunch = () => this.relaunchTuiForAppearance();
        void (this.host.withDetachedSessionLock ? this.host.withDetachedSessionLock(this.session.id, relaunch) : this.host.withSessionLock(this.session.id, relaunch)).catch(() => undefined);
      }
      void this.refreshEvents()
        .catch(error => this.noteHistoryFailure(error));
      return;
    }
    if (method === 'thread/status/changed') {
      this.applyThreadStatus(asRecord(params.status) as RpcThread['status']);
      return;
    }
    if (method === 'queue/status') {
      // A busy provider holds the request in its own queue; without this the turn just looks stuck.
      if (str(params.state) === 'ready') {
        this.showTransientNotice(undefined);
        return;
      }
      const position = finiteToken(params.position);
      // An exhausted daily quota lowers priority instead of rejecting the turn, so say why the
      // request is waiting rather than presenting it as ordinary queue contention.
      const fallback = params.modelQuotaLowPriority === true
        ? 'Daily quota is used up; this request is running at low priority.'
        : `Waiting in the ${this.label} queue${position === undefined ? '' : ` (position ${position})`}.`;
      this.showTransientNotice(safeProviderError(str(params.message) ?? fallback, this.profileConfig));
      return;
    }
    if (method === 'model/fallback') {
      const event = asRecord(params.event);
      const model = (key: string) => str(asRecord(event?.[key])?.model);
      const type = str(event?.type);
      if (type === 'attemptStarted') this.showTransientNotice(`${model('from') ?? 'The model'} is unavailable; trying ${model('to') ?? 'a fallback model'}.`);
      else if (type === 'committed' && model('target')) {
        this.showTransientNotice(undefined);
        this.refreshStatus({ model: model('target'), notice: { text: `This turn is answered by ${model('target')} instead.`, level: 'info', source: 'other' } });
      } else if (type === 'exhausted') this.showTransientNotice(undefined);
      return;
    }
    if (method === 'model/loopDetectedRecovering') {
      this.refreshStatus({ notice: { text: `The model repeated itself; ${this.label} compacted the context and is retrying.`, level: 'info', source: 'other' } });
      return;
    }
    if (method === 'thread/settings/updated') {
      const settings = asRecord(params.threadSettings);
      if (str(settings?.model)) this.threadModel = str(settings?.model);
      if (this.nativeSessionId && params.threadId === this.nativeSessionId) {
        this.commandConfigObserver?.(settings ?? {});
        this.permissionObservation += 1;
        this.permissionSettings = settings;
        this.adoptApproval(settings);
        this.adoptSettingsMode(settings);
      }
      return;
    }
    if (method === 'mode/changeRequested') {
      this.raiseModeChange(params);
      return;
    }
    if (method === 'mode/changeResolved') {
      this.settleModeChange(params);
      return;
    }
    if (method === 'thread/name/updated') {
      this.adoptProviderTitle(str(params.name));
      return;
    }
    if (method === 'thread/goal/updated') {
      // A status this version does not know leaves the shown goal as it is.
      const goal = codexGoal(params.goal);
      if (goal || params.goal === null) this.adoptGoal(goal);
      return;
    }
    if (method === 'thread/goal/cleared') { this.adoptGoal(undefined); return; }
    if (method === 'item/started' || method === 'item/completed') {
      const item = asRecord(params.item) as RpcItem | undefined;
      const turnId = str(params.turnId);
      if (!item || !turnId) return;
      if (item.type === 'userMessage' && this.nativeCommand?.type === 'compact') this.nativeCommand.userTurns.add(turnId);
      if (item.type === 'fileChange' && typeof item.id === 'string' && this.isStanding()) {
        if (method === 'item/started') this.standingWrites.set(item.id, asArray<Record<string, unknown>>(item.changes).flatMap(change => [str(change.path), str(asRecord(change.kind)?.move_path)]).filter((path): path is string => Boolean(path)));
        else this.standingWrites.delete(item.id);
      }
      if (item.type === 'contextCompaction') {
        if (this.nativeCommand?.type === 'compact') this.confirmNativeCommand(turnId);
        if (this.isStanding()) {
          // As Claude Code's PreCompact and its SessionStart after one: the 助理 saves what matters, and is then told.
          if (method === 'item/started') { try { this.host.standing?.compacting?.(this.session.id); } catch { /* a standing host's trouble is not the turn's */ } }
          else this.standingMoments.add('compact');
        }
        if (method === 'item/started') this.activities.compactionStarted(item, turnId, Number(params.startedAtMs));
        else this.activities.compactionCompleted(item, turnId, typeof params.completedAtMs === 'number' ? params.completedAtMs : undefined);
        return;
      }
      if (item.type === 'userMessage') {
        this.activities.noteUserMessage(turnId);
        // A finished goal steps aside once the conversation moves on, as on every backend.
        if (method === 'item/started' && this.host.getSession(this.session.id).goal?.status === 'complete') this.adoptGoal(undefined);
      }
      if (item.type === 'commandExecution') {
        this.activities.noteCommand(item, turnId);
        if (method === 'item/completed') this.activities.sync();
      }
      if (method === 'item/started' && item.type === 'agentMessage' && !str(item.text) && messagePhase(item.phase)) {
        this.drafts.note('item/agentMessage/delta', { itemId: item.id, turnId, delta: '', phase: item.phase }, this.nativeSessionId ?? 'unknown');
      }
      noteItemMeter(this.metering, method, item, turnId);
      const turn = this.turnRuns.get(turnId);
      const commandId = this.commandIdOf(item, turnId);
      if (commandId && !this.commandRuns.has(commandId)) {
        this.commandRuns.set(commandId, { commandId, runId: this.host.findRunIdByCommand(this.session.id, commandId), createdAt: toIso(Number(params.startedAtMs)) ?? new Date().toISOString() });
      }
      const itemTurn = { id: turnId, startedAt: Number(params.startedAtMs) / 1000 };
      // The notification states its own times; the rollout, which may not have the line yet, is the fallback.
      const span = notificationSpan(method, params, item) ?? this.rolloutSpan(this.nativeSessionId ?? 'unknown', item);
      const projected = isCodexQuestionTool(item) ? this.projectItem(item, itemTurn, { span })
        : isCodexToolItem(item)
        ? method === 'item/started'
          ? projectStartedTool(item, this.session.id, this.nativeSessionId ?? 'unknown', turnId, turn?.runId, turn?.createdAt, span)
          : projectCompletedTool(item, this.session.id, this.nativeSessionId ?? 'unknown', turnId, turn?.runId, turn?.createdAt, span, id => this.observation?.changes(this.session.id, id))
        : this.projectItem(item, itemTurn, { span });
      if (item.type === 'userMessage') this.noteUserMessage(turnId, projected);
      if (method === 'item/completed') this.metering.noteCompletedOutput(turnId, item);
      if (method === 'item/completed' && item.type === 'agentMessage') this.noteAsyncQuestions(item, turnId);
      if (item.type === 'userMessage') {
        // Answered from the TUI or another client: the envelope names the questions it settles.
        const answered = new Set(parseAsyncQuestionReplies(userMessageText(item))?.map(reply => reply.questionItemId));
        if (answered.size) this.dropAsyncQuestions(question => answered.has(question.questionItemId) || answered.has(question.itemId));
      }
      if (item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall') {
        this.subagents.note([{ ...itemTurn, items: [item] }], true);
        void this.subagents.refresh();
      }
      if (method === 'item/completed') {
        if (item.id) this.drafts.settle(item.id);
        for (const event of projected) {
          this.liveCompletedIds.add(event.nativeId);
          this.pushEvent(event, true);
        }
        return;
      }
      for (const event of projected) this.pushEvent(event);
      return;
    }
    if (method === 'serverRequest/resolved') this.settleServerRequest(params);
  }

  private settleServerRequest(params: Record<string, unknown>): void {
      const nativeRequestId = requestIdString(params.requestId);
      if (!nativeRequestId) return;
      const threadId = str(params.threadId) ?? this.nativeSessionId;
      const requestId = this.scopedRequestId(threadId, nativeRequestId);
      const pending = this.pending.get(requestId);
      if (!pending || (str(pending.request.params.threadId) ?? this.nativeSessionId) !== threadId) return;
      this.pending.delete(requestId);
      if (pending) this.resolveCandidateReceipt(pending);
      const turnId = pending && str(pending.request.params.turnId);
      const main = threadId === this.nativeSessionId;
      if (main && pending && turnId) {
        const answered = this.questionHistory.answered(pending);
        if (answered) {
          for (const event of this.projectItem(answered, { id: turnId })) this.pushEvent(event);
        }
      }
      const meter = main && turnId ? this.metering.active(turnId) : undefined;
      if (meter) noteRequestWaitEnd(meter, requestId);
      if (pending) pending.resolve?.(NO_SERVER_RESPONSE);
      if (pending && this.interaction?.requestId === requestId) this.interaction = this.pending.values().next().value?.interaction;
      this.refreshStatus({ link: 'quiet', notice: undefined });
  }

  private async onServerRequest(request: JsonRpcServerRequest): Promise<unknown> {
    const threadId = str(request.params.threadId) ?? this.nativeSessionId;
    if (threadId && threadId !== this.nativeSessionId && !this.subagents.owns(threadId)) {
      throw new Error(`Request belongs to a different ${this.label} thread.`);
    }
    // The owner's files are not the 助理's to change in any mode (docs/ASSISTANT.md §2): the profile has them
    // read-only, and the approval Codex then asks for is declined here, as Claude Code's deny rule does.
    if (request.method === 'item/fileChange/requestApproval') {
      const writes = this.standingWrites.get(str(request.params.itemId) ?? '');
      const standing = writes?.length ? this.standing() : undefined;
      if (standing && writes!.some(path => standingProtects(path, standing))) return { decision: 'decline' };
    }
    const requestId = this.scopedRequestId(threadId, String(request.id));
    const main = threadId === this.nativeSessionId;
    const requestedTurnId = str(request.params.turnId);
    if (main && requestedTurnId && this.dispatchCommandId && !this.nativeCommand) {
      const submitted = this.commandRuns.get(this.dispatchCommandId);
      if (submitted) this.turnRuns.set(requestedTurnId, { ...submitted, commandId: this.dispatchCommandId });
    }
    const pending = makePendingInteraction(request);
    if (!pending) throw new Error(`${this.label} request ${request.method} is not supported by the workbench.`);
    pending.interaction.requestId = requestId;
    if (main && requestedTurnId) noteRequestWaitStart(this.metering, requestedTurnId, requestId);
    this.pending.set(requestId, pending);
    if (request.method === 'item/tool/requestUserInput') {
      const question = this.questionHistory.request(request.params, threadId);
      // A child's output-only history still needs this native metadata, as does a v3 reader with
      // its own question tracker. Forward metadata, never candidate answers or a child main row.
      try { this.feed?.notification(request.method, { ...request.params, threadId }); } catch { /* as for notifications */ }
      if (main && requestedTurnId && question) {
        for (const event of this.projectItem(question, { id: requestedTurnId })) this.pushEvent(event, true);
      }
    }
    this.interaction = pending.interaction;
    this.refreshStatus({ link: this.resumed(), notice: undefined });
    return await new Promise(resolve => {
      // A server request remains pending until a web answer or the shared TUI resolves it.
      // This promise is intentionally settled by respond() or the protocol's resolved notice.
      pending.resolve = resolve;
    });
  }

  private clearTurnInteractions(turnId: string, threadId = this.nativeSessionId): void {
    // Like the TUI: a finished turn no longer waits on its questions; a later message answers them.
    if (threadId === this.nativeSessionId) this.asyncQuestions = this.asyncQuestions.filter(question => question.turnId !== turnId);
    let changed = false;
    for (const [id, pending] of this.pending) {
      if (str(pending.request.params.turnId) !== turnId
        || (str(pending.request.params.threadId) ?? this.nativeSessionId) !== threadId) continue;
      this.pending.delete(id);
      if (pending.request.method === 'mode/changeRequested') {
        this.modeRequests.delete(pending);
        this.resolveCandidateReceipt(pending, { status: 'uncertain', message: `${this.label} turn ended without confirming the mode decision.` });
      } else this.resolveCandidateReceipt(pending);
      pending.resolve?.(NO_SERVER_RESPONSE);
      changed = true;
    }
    if (!changed) return;
    const currentId = this.interaction?.requestId;
    if (currentId && !this.pending.has(currentId)) this.interaction = this.pending.values().next().value?.interaction;
  }

  private noteUserMessage(turnId: string, events: NativeWorkbenchEvent[]): void {
    const event = events.find(candidate => candidate.type === 'user_message_chunk');
    const commandId = str(event?.data.commandId);
    if (commandId) this.rememberTurnCommand(turnId, commandId, true);
    if (event && !this.metering.isSettled(turnId)) this.metering.meterFor(turnId).nativeMessageId ??= event.nativeId;
    const outcome = this.pendingTurnOutcomes.get(turnId);
    if (commandId && outcome) queueMicrotask(() => this.emitTurnOutcome(outcome, turnId));
  }

  private publishPlanSnapshot(turnId: string, entries: Array<Record<string, unknown>>, raw: unknown): void {
    const threadId = this.nativeSessionId ?? 'unknown';
    const nativeId = codexPlanNativeId(threadId, turnId);
    const event = this.withStableSequence({
      ...this.makeEvent(nativeId, turnId, this.turnRuns.get(turnId)?.runId, 'plan', { entries }, raw),
      createdAt: new Date().toISOString(),
    });
    this.livePlanSnapshots.set(turnId, event);
    this.seenEvents.add(nativeId);
    const existingIndex = this.events.findIndex(existing => existing.nativeId === nativeId);
    if (existingIndex >= 0) this.events[existingIndex] = event;
    else {
      const at = this.events.findLastIndex(existing => existing.sequence < event.sequence) + 1;
      this.events.splice(at, 0, event);
      if (this.events.length > MAX_EVENTS) {
        this.events.splice(0, this.events.length - MAX_EVENTS);
      }
    }
  }

  private rolloutPlanEvent(threadId: string, snapshot: RolloutPlanSnapshot): NativeWorkbenchEvent {
    const turnId = snapshot.turnId;
    const nativeId = rolloutPlanNativeId(threadId, snapshot);
    const event = this.makeEvent(
      nativeId,
      turnId ?? '',
      turnId ? this.turnRuns.get(turnId)?.runId : undefined,
      'plan',
      { entries: snapshot.entries },
    );
    return { ...event, createdAt: snapshot.timestamp };
  }

  private makeEvent(nativeId: string, turnId: string, runId: string | undefined, type: string, data: Record<string, unknown>, raw?: unknown): NativeWorkbenchEvent {
    return buildEvent(this.session.id, this.turnRuns.get(turnId)?.createdAt, nativeId, turnId, runId, type, data, raw);
  }

  /** Only a reliable turn terminal (live or recovered history), never an offline/unknown state. */
  private completeTurnWaiters(turnId: string, threadId = this.nativeSessionId): void {
    const waiterId = this.scopedRequestId(threadId, turnId);
    for (const waiter of this.completionWaiters.get(waiterId) ?? []) waiter.resolve();
    this.completionWaiters.delete(waiterId);
  }

  private emitTurnOutcome(turn: RpcTurn, turnId: string): NativeWorkbenchEvent[] {
    const status = turnStatus(turn.status);
    const type = status === 'completed' ? 'run_completed' : status === 'failed' ? 'run_failed' : status === 'interrupted' ? 'run_cancelled' : undefined;
    if (!type) return [];
    // A turn ends once. A history read that started before `turn/completed` can return after it with
    // an older status; settling on that would flip a completed run to cancelled.
    const settled = this.settledTurns.get(turnId);
    if (settled && settled !== type) return [];
    this.completeTurnWaiters(turnId);
    this.pendingTurnOutcomes.set(turnId, turn);
    if (this.pendingTurnOutcomes.size > 64) this.pendingTurnOutcomes.delete(this.pendingTurnOutcomes.keys().next().value!);
    this.restoreTurnCommands(turnId);
    const ids = new Set([...(this.turnCommands.get(turnId) ?? []), ...asArray<RpcItem>(turn.items)
      .filter(item => item.type === 'userMessage')
      .map(item => this.commandIdOf(item, turnId))
      .filter((id): id is string => Boolean(id))]);
    const mapped = this.turnRuns.get(turnId);
    if (mapped?.commandId) ids.add(mapped.commandId);
    const known = [...ids].filter(commandId => this.commandRuns.has(commandId));
    if (!known.length) {
      if (this.dispatchCommandId) {
        this.pendingTurnOutcomes.set(turnId, turn);
        if (this.pendingTurnOutcomes.size > 64) this.pendingTurnOutcomes.delete(this.pendingTurnOutcomes.keys().next().value!);
      }
      return [];
    }
    this.settledTurns.set(turnId, type);
    if (this.settledTurns.size > 256) this.settledTurns.delete(this.settledTurns.keys().next().value!);
    const outcomes: NativeWorkbenchEvent[] = [];
    for (const commandId of known) {
      const command = this.commandRuns.get(commandId)!;
      const nativeMessage = this.events.find(event => event.type === 'user_message_chunk'
        && event.data.commandId === commandId
        && event.nativeId.startsWith(`${this.nativeSessionId ?? 'unknown'}:${turnId}:`));
      const data: Record<string, unknown> = { commandId };
      data.nativeMessageId = nativeMessage?.nativeId ?? `${this.nativeSessionId ?? 'unknown'}:${turnId}:web:${commandId}:user`;
      if (status === 'failed') data.error = safeTurnError(turn.error, this.profileConfig);
      if (status === 'interrupted') data.reason = `${this.label} turn was interrupted.`;
      const nativeId = `${this.nativeSessionId ?? 'thread'}:${turnId}:${type}:${commandId}`;
      const event = this.events.find(candidate => candidate.nativeId === nativeId) ?? this.withStableSequence({ ...this.makeEvent(
        nativeId,
        turnId,
        command.runId ?? mapped?.runId,
        type,
        data,
        { id: turn.id, status, ...(status === 'failed' ? { error: safeTurnError(turn.error, this.profileConfig) } : {}) },
      ), createdAt: command.createdAt });
      this.pushEvent(event);
      // An outcome can already have left the resident tail. Include it in this read's projection
      // even when pushEvent correctly suppresses another live delivery of the same identity.
      outcomes.push(event);
    }
    return outcomes;
  }

  /**
   * Whether this client is driving the turn right now: it is the active turn, or it carries the
   * message being dispatched. Only an `interrupted` read of such a turn is ignored: a history read
   * taken while it starts can call it that — TRAE CLI derives the status from a rollout that does not
   * have the turn's `task_started` yet — whereas `completed` and `failed` only appear once it ended.
   * A real interruption still arrives live as `turn/completed`.
   */
  private drivesTurn(turn: RpcTurn): boolean {
    if (turn.id === this.activeTurnId) return true;
    const dispatching = this.dispatchCommandId;
    return Boolean(dispatching && asArray<RpcItem>(turn.items).some(item => this.commandIdOf(item, turn.id) === dispatching));
  }

  private projectKnownUserReceipts(turn: RpcTurn): void {
    for (const item of asArray<RpcItem>(turn.items)) {
      if (item.type !== 'userMessage') continue;
      const commandId = this.commandIdOf(item, turn.id);
      if (!commandId || !this.commandRuns.has(commandId)) continue;
      for (const event of this.projectItem(item, turn)) this.pushEvent(event);
    }
  }

  /**
   * The text rows these turns already show under the ids their items keep, by turn id.
   *
   * Rows a positional item added are left out: this is the settled side of the comparison, and a
   * copy standing in for a settled row must not pass for one.
   */
  private shownTextRows(threadId: string, turnIds: readonly string[]): Map<string, Set<string>> {
    return shownTextRowsOf(this.provisionalRows, this.events, threadId, turnIds);
  }

  /** Which text row a provisional native id stands for, if it is one this transcript still holds. */
  private textKeyOf(nativeId: string): string | undefined {
    const event = this.events.find(candidate => candidate.nativeId === nativeId);
    return event ? rowTextKey(event) : undefined;
  }

  /**
   * One turn's history items, projected without showing a running turn's items twice.
   *
   * TRAE CLI serves a turn it has not written yet under positional item ids (`item-1`, `item-2`, …)
   * and returns the same items under the ids they keep once it is written (`msg_…` for an answer,
   * `rs_…` for its reasoning). A read taken mid-turn would therefore show a second copy of what the
   * live stream — or an earlier read — already committed, and the copy it adds is named with an id
   * that will not last. So text the turn already shows is not shown again, and the copies this read
   * adds are remembered until the settled read returns the items under the ids that do last.
   */
  private projectTurnItems(turn: RpcTurn, context: {
    shown: Map<string, Set<string>>;
    /** Rows this read projected from a positional item, by turn id; replaces `provisionalRows`. */
    provisionalRows: Map<string, string[]>;
    /** Rows of the transcript a settled copy replaces; the caller drops them. */
    superseded: Set<string>;
  }): NativeWorkbenchEvent[] {
    const items = asArray<RpcItem>(turn.items);
    const settled = isFinalTurnStatus(turn.status);
    // Every item returned under the id it keeps means the turn is written and this read is the
    // settled copy of all of it; otherwise a positional item is only compared with what text shows.
    const renamed = settled && items.every(item => !isProvisionalItemId(str(item.id)));
    const shown = context.shown.get(turn.id) ?? new Set<string>();
    const events: NativeWorkbenchEvent[] = [];
    const positional: NativeWorkbenchEvent[][] = [];
    for (const item of items) {
      const projected = this.projectItem(item, turn);
      if (!projected.length) continue;
      if (isProvisionalItemId(str(item.id))) { positional.push(projected); continue; }
      for (const event of projected) {
        const key = rowTextKey(event);
        if (key) shown.add(key);
        events.push(event);
      }
    }
    const rows = new Set<string>();
    for (const nativeId of this.provisionalRows.get(turn.id) ?? []) {
      const key = this.textKeyOf(nativeId);
      if (renamed || (key !== undefined && shown.has(key))) context.superseded.add(nativeId);
      else rows.add(nativeId);
    }
    for (const projected of positional) {
      const keys = projected.map(rowTextKey).filter((key): key is string => key !== undefined);
      if (keys.some(key => shown.has(key))) continue;
      for (const event of projected) rows.add(event.nativeId);
      events.push(...projected);
    }
    if (rows.size) context.provisionalRows.set(turn.id, [...rows]);
    context.shown.set(turn.id, shown);
    return events;
  }

  private pushEvent(event: NativeWorkbenchEvent, replace = false): void {
    // Settled history being logged is not shown to anyone: it only needs its number and a row.
    if (this.importBatch) { this.importBatch.push(this.withStableSequence(event)); return; }
    if (this.seenEvents.has(event.nativeId)) {
      if (replace) {
        const index = this.events.findIndex(candidate => candidate.nativeId === event.nativeId);
        if (index >= 0) this.events[index] = this.withStableSequence(event);
      }
      return;
    }
    const sequenced = this.withStableSequence(event);
    this.seenEvents.add(sequenced.nativeId);
    // A sequence reserved by a draft sits behind newer events, so keep the transcript ordered.
    const at = this.events.findLastIndex(existing => existing.sequence < sequenced.sequence) + 1;
    this.events.splice(at, 0, sequenced);
    if (this.events.length > MAX_EVENTS) {
      const dropped = this.events.splice(0, this.events.length - MAX_EVENTS);
      for (const previous of dropped) this.liveCompletedIds.delete(previous.nativeId);
    }
  }

  /** An event that already has its place keeps it without being looked at in the log again. */
  private numbered(event: NativeWorkbenchEvent): NativeWorkbenchEvent {
    const known = this.space.seqOf(event.nativeId);
    return known === undefined ? this.withStableSequence(event) : { ...event, sequence: known };
  }

  private withStableSequence(event: NativeWorkbenchEvent): NativeWorkbenchEvent {
    const sequence = this.space.assign(event, event.nativeTurnId !== undefined && this.stableTurnIds.has(event.nativeTurnId));
    const nativeTurnId = nativeTurnIdOf(event, this.nativeSessionId);
    const numbered = { ...event, sequence, ...(nativeTurnId ? { nativeTurnId } : {}) };
    return numbered;
  }

  /** What the control path takes of a message: the transcript itself is read into the journal (`transcript-source.ts`). */
  private emit(message: NativeStreamMessage | CodexSubagentFrame): void {
    let control: NativeControlMessage | undefined;
    if (message.type === 'subagent') control = message.running === undefined ? undefined : { type: 'subagent', toolCallId: message.toolCallId, agentId: message.agentId, running: message.running };
    else if (message.type === 'status' || message.type === 'context' || message.type === 'metrics' || message.type === 'job' || message.type === 'session') control = message;
    if (!control) return;
    for (const listener of this.listeners) {
      try { listener(control); } catch { /* A failing listener must not stop the native process observer. */ }
    }
  }

  /** Keep the session's goal equal to the thread's. */
  private adoptGoal(goal: SessionGoal | undefined): void {
    if (sameGoal(goal, this.host.getSession(this.session.id).goal)) return;
    this.emit({ type: 'session', session: this.host.updateSession(this.session.id, { goal }) });
  }

  /** Reads the thread's goal once it is attached; a CLI without goals answers with an error and leaves the stored one. */
  private async readGoal(threadId: string): Promise<void> {
    try {
      const response = await this.requireTransport().request<{ goal?: unknown }>('thread/goal/get', { threadId });
      if (this.nativeSessionId !== threadId) return;
      const goal = codexGoal(response.goal);
      // The thread keeps a finished goal until the next one; here it already stepped aside unless it was still on show.
      if (goal?.status === 'complete' && this.host.getSession(this.session.id).goal?.objective !== goal.objective) return;
      this.adoptGoal(goal);
    } catch { /* goals are an opt-in feature of the CLI */ }
  }

  /**
   * A thread name can be a first-message fallback before the CLI writes its actual summary. Read
   * the durable first message before adopting or echoing an automatic title, including on resume.
   */
  private adoptProviderTitle(name: string | undefined): void {
    if (name) {
      this.threadName = name;
      const message = this.firstTitleMessage();
      const patch = message === undefined ? undefined : nativeTitlePatch(this.host.getSession(this.session.id), name, message);
      if (patch) {
        // Only what the store now holds: a reset frame carrying the CLI's name while the store kept a
        // human one would contradict the title every list renders.
        this.emit({ type: 'session', session: this.host.updateSession(this.session.id, patch) });
      }
    }
    void this.pushTitle().catch(() => undefined);
  }

  /**
   * Gives Codex the conversation's title when the reader or a model chose one the thread does not
   * carry, so the Codex app and `codex resume` list it under the same name. Codex echoes the change
   * as `thread/name/updated`, which then matches and stops here.
   */
  async pushTitle(): Promise<void> {
    const session = this.host.getSession(this.session.id);
    if (session.titleSource !== 'user' && session.titleSource !== 'generated' && session.titleSource !== 'agent') return;
    if (session.titleSource !== 'user') {
      const message = this.firstTitleMessage();
      if (message === undefined || isPromptTitle(session.title, message)) return;
    }
    if (!this.nativeSessionId || !this.transport?.isOnline || session.title === this.threadName) return;
    if (this.pushingTitle === session.title) return;
    this.pushingTitle = session.title;
    try {
      await this.transport.request('thread/name/set', { threadId: this.nativeSessionId, name: session.title });
      this.threadName = session.title;
    } finally {
      if (this.pushingTitle === session.title) this.pushingTitle = undefined;
    }
  }

  private firstTitleMessage(): string | undefined {
    // Resident events and search indexes can contain only the tail. Production hosts resolve the
    // original input from the real journal or an unassigned new thread; an imported thread waits for it.
    if (this.host.firstUserMessage) return this.host.firstUserMessage(this.session.id);
    const session = this.host.getSession(this.session.id);
    return firstHumanMessage(this.events) ?? (session.titleSource === 'prompt' ? session.title : undefined);
  }

  /**
   * Name the conversation after the first human message of the thread, which is what a resumed
   * conversation has instead of a name. Idempotent once the title carries `titleSource: 'prompt'`.
   */
  private nameFromMessage(text: string): void {
    if (this.importBatch) return;
    const firstMessage = this.host.firstUserMessage ? this.firstTitleMessage() : text;
    if (firstMessage === undefined) return;
    const patch = firstMessageTitlePatch(this.host.getSession(this.session.id), firstMessage);
    if (!patch) return;
    this.emit({ type: 'session', session: this.host.updateSession(this.session.id, patch) });
  }

  /** Shows a notice that lasts only while its condition holds, without clearing an unrelated one. */
  private showTransientNotice(text: string | undefined): void {
    this.transientNotice = text;
    if (text) this.refreshStatus({ notice: { text, level: 'info', source: 'transient' } });
    else if (this.facts.notice?.source === 'transient') this.refreshStatus({ notice: undefined });
  }

  /**
   * TRAE CLI asks to switch collaboration mode with a notification, not a server request, and takes
   * the answer through `mode/change/respond`. It is still one decision for the reader, so it waits
   * in the same pending map as approvals and is settled by `mode/changeResolved`.
   */
  private raiseModeChange(params: Record<string, unknown>): void {
    const requestId = str(params.requestId);
    if (!requestId) return;
    const key = this.scopedRequestId(str(params.threadId), `mode:${requestId}`);
    if (this.pending.has(key)) return;
    const targetMode = str(params.targetMode);
    const supported = this.flavor.modes.some(mode => mode.id === targetMode);
    const leavingPlan = targetMode === 'default';
    const plan = leavingPlan ? this.latestPlanText(str(params.turnId), str(params.threadId)) : undefined;
    const interaction = modeChangeInteraction(this.flavor.id, key, params, supported, leavingPlan, plan);
    const pending: CodexPendingInteraction = { request: { id: key, method: 'mode/changeRequested', params }, interaction, currentQuestion: 0, revisionCounter: 0, answers: {}, candidateSent: false };
    this.modeRequests.set(pending, { observation: this.modeObservation });
    this.pending.set(key, pending);
    this.interaction = interaction;
    this.refreshStatus({ link: this.resumed(), notice: undefined });
  }

  private settleModeChange(params: Record<string, unknown>): void {
    const requestId = str(params.requestId);
    if (!requestId) return;
    const key = this.scopedRequestId(str(params.threadId), `mode:${requestId}`);
    const pending = this.pending.get(key);
    if (!pending || pending.request.method !== 'mode/changeRequested') return;
    const decision = str(params.decision);
    if (str(params.threadId) !== str(pending.request.params.threadId)
      || str(params.turnId) !== str(pending.request.params.turnId)
      || str(params.targetMode) !== str(pending.request.params.targetMode)
      || !decision || !['approved', 'rejected', 'cancelled'].includes(decision)) return;
    const observed = this.modeRequests.get(pending);
    if (decision === 'approved' && str(params.threadId) === this.nativeSessionId) {
      if (observed?.observation === this.modeObservation) this.adoptMode(str(params.targetMode));
      else {
        // These RPCs/events have no provider revision. A settings event received after our
        // candidate may be from before or after the actual native mode application: counting
        // observations cannot tell. Read current settings instead of guessing the winner.
        const threadId = str(params.threadId);
        if (threadId) {
          const task = this.reconcileMode(threadId).finally(() => {
            if (this.modeReconciliation === task) this.modeReconciliation = undefined;
          });
          this.modeReconciliation = task;
        }
      }
    }
    if (pending.candidateResponse && observed?.decision !== decision) {
      this.resolveCandidateReceipt(pending, { status: 'uncertain', message: `${this.label} resolved this request as ${decision}; the submitted choice was not confirmed.` });
    } else this.resolveCandidateReceipt(pending);
    this.releaseModeChange(key, pending);
  }

  private releaseModeChange(key: string, pending: CodexPendingInteraction, notice?: string): void {
    if (this.pending.get(key) !== pending) return;
    this.pending.delete(key);
    this.modeRequests.delete(pending);
    if (this.interaction?.requestId === key) this.interaction = this.pending.values().next().value?.interaction;
    this.refreshStatus({ link: 'quiet', notice: notice ? { text: notice, level: 'warning', source: 'other' } : undefined });
  }

  /** The newest proposed plan of a turn, from the transcript, so the reader can see what they approve. */
  private latestPlanText(turnId: string | undefined, threadId = this.nativeSessionId): string | undefined {
    const prefix = turnId ? `${threadId ?? 'unknown'}:${turnId}:` : undefined;
    const events = threadId === this.nativeSessionId ? this.events
      : [...this.subagents.values()].find(watch => watch.childId === threadId)?.events ?? [];
    return latestPlanTextOf(events, prefix);
  }

  /** Evidence of live traffic ends `starting` and `offline`; a link that already says work is going on stays. */
  private resumed(): 'quiet' | 'working' { return this.facts.link === 'working' ? 'working' : 'quiet'; }

  /** The only place a phase is computed: an interaction wins, then a tracked turn or other work in progress. */
  private livePhase(working: boolean): 'attention' | 'busy' | 'idle' { return this.interaction ? 'attention' : this.activeTurnId || working ? 'busy' : 'idle'; }

  /** The one place a status is computed, from `facts` (updated by `change` first), the interaction and the active turn. */
  private refreshStatus(change: Partial<typeof this.facts> = {}): void {
    const facts = Object.assign(this.facts, change);
    // Thread failure is a condition, independent of statuses rebuilt by child/interaction events.
    // Once recovered or owned by a failed turn, discard copies of its projected notice.
    if (this.threadError && (!this.threadErrorTurnId || this.settledTurns.get(this.threadErrorTurnId) !== 'run_failed')) {
      facts.notice = { text: `${this.label} reported a thread-level system error.`, level: 'error', source: 'thread' };
    } else if (facts.notice?.source === 'thread') facts.notice = undefined;
    const requested = this.withAsyncQuestion({
      phase: facts.link === 'starting' || facts.link === 'offline' ? facts.link : this.livePhase(facts.link === 'working'),
      ...(facts.model ? { model: facts.model } : {}),
      ...(facts.notice ? { notice: facts.notice.text, noticeLevel: facts.notice.level } : {}),
      ...(this.interaction ? { interaction: this.interaction } : {}),
      ...(facts.connection ? { connection: facts.connection } : {}),
      ...(facts.history ? { history: facts.history } : {}),
      ...(facts.approval ? { approval: facts.approval } : {}),
    });
    const control = this.runtimeControl({ ...this.status, ...requested });
    const turnId = requested.phase === 'busy' || requested.phase === 'attention' ? this.activeTurnId : undefined;
    const next: NativeStatus = withActivity({
      ...requested,
      profilePending: this.profilePending || undefined,
      phase: this.turnPhase(requested.phase),
      ...(turnId ? { activeTurnId: this.turnRuns.get(turnId)?.runId ?? turnId } : {}),
      ...(turnId && this.attached && this.transport?.isOnline && !this.bindingScopeMismatch && !this.endpointWriteConflict &&
        facts.connection?.state === 'connected' && requested.phase === 'busy' && !this.currentInteraction && this.nativeSessionId
        && supportsSteerVersion(this.transport.serverUserAgent, this.flavor.id)
        ? { activeTurn: { nativeSessionId: this.nativeSessionId, turnId, ...(this.turnRuns.get(turnId)?.runId ? { ownerRunId: this.turnRuns.get(turnId)!.runId } : {}) } } : {}),
      ...(control ? { runtimeControl: control } : {}),
    }, this.activities.ledger.list(), { upgradePhase: false });
    // Compared by content: two paths that build the same status in a different key order (a notice
    // spread before or after the connection) are not a change, and every repeat is a frame to clients.
    if (canonicalJson(next) === canonicalJson(this.status)) return;
    this.status = next;
    this.emit({ type: 'status', status: next });
    // Losing (or regaining) the push feed is a gap: read at once rather than at the next slow tick.
    if (this.historyPoll && (this.pushHealthy() !== this.pollHealthy || (this.pollDormant && !this.dormant()))) this.scheduleHistoryPoll(true);
  }

  /** Every phase this runtime publishes passes through its tracker; the app-server protocol is the evidence. */
  private turnPhase(phase: NativeStatus['phase']): NativeStatus['phase'] {
    this.turn.observe({ source: 'protocol', phase: turnPhaseOf(phase), ...(phase === 'busy' && this.activeTurnId ? { turnId: this.activeTurnId } : {}) });
    return this.turn.nativePhase;
  }

  private setConnection(connection: NonNullable<NativeStatus['connection']>, source?: 'profile' | 'endpoint'): void {
    this.connectionConflictSource = connection.state === 'conflict' ? source : undefined;
    this.refreshStatus({ connection });
  }

  private setHistory(history: NonNullable<NativeStatus['history']>): void {
    const previous = this.status.history;
    if (!this.importStopped && history.state === 'error' && (previous?.state !== 'error' || previous.message !== history.message)) {
      console.warn('[codex-history]', JSON.stringify({
        sessionId: this.session.id,
        nativeThreadId: this.nativeSessionId ?? null,
        backendId: this.flavor.id,
        message: safeProviderError(history.message ?? 'The thread history could not be read.', this.profileConfig),
      }));
    }
    this.refreshStatus({ history });
  }

  private noteHistoryFailure(error: unknown): void {
    this.historySnapshotReady = false;
    const message = safeProviderError(error, this.profileConfig);
    this.setHistory({ state: 'error', message });
  }

  private noteHistoryUnavailable(): void {
    this.historySnapshotReady = false;
    this.setHistory({ state: 'error', message: `${this.label} could not read this thread history from the connected app-server.` });
  }

  private noteHistoryReady(): void {
    this.setHistory({ state: 'ready' });
  }

  private noteConnectionFailure(error: unknown): void {
    if (isActiveWriterError(error)) {
      this.setConnection({ state: 'conflict', message: `Another ${this.label} client currently owns this thread. The saved history remains available.` });
      return;
    }
    const message = safeProviderError(error, this.profileConfig);
    this.refreshStatus({ ...(this.transport?.isOnline ? {} : { link: 'offline' as const }), connection: { state: 'failed', message } });
  }

  private logRecovery(source: string, endpoint: string, attempt: string, result: string, commit: boolean): void {
    console.info('[codex-recovery]', JSON.stringify({
      sessionId: this.session.id,
      nativeThreadId: this.nativeSessionId ?? null,
      source,
      endpoint,
      attempt,
      result,
      commit,
    }));
  }

  private applyThreadStatus(status: RpcThread['status']): void {
    if (status?.type === 'active') this.history.beginMaterialization();
    // TRAE's thread status aggregates background work. A confirmed foreground end wins until
    // a new native turn starts or a dispatch is in flight; Codex retains its aggregate-active phase.
    const foregroundEnded = this.flavor.id === 'traex' && this.foregroundEndedTurnId !== undefined
      && !this.activeTurnId && !this.dispatchCommandId;
    // Thread status is aggregate evidence. An observed turn keeps its target until its own
    // completion (or a matching terminal history record) arrives, including during retries.
    const phase = this.livePhase(Boolean(this.dispatchCommandId));
    // Only a thread recovery clears its own diagnostic. Transport/history recovery never does.
    if (status?.type === 'active' || status?.type === 'idle') {
      this.threadError = false;
      // Recovery ends the previous error's ownership. An active, unsettled turn is fresh evidence;
      // a historical/foreground end is never evidence for a later, unrelated system error.
      this.threadErrorTurnId = status.type === 'active' && this.activeTurnId && !this.settledTurns.has(this.activeTurnId)
        ? this.activeTurnId : undefined;
    } else if (status?.type === 'systemError') this.threadError = true;
    const update = threadStatusUpdate(status, this.status, this.facts.notice?.source === 'thread', this.interaction, phase, foregroundEnded, Boolean(this.transport?.isOnline));
    // The update's phase says whether the thread reports work beyond a tracked turn; an attention phase leaves that as it was.
    if (update) this.refreshStatus({ link: update.phase === 'offline' ? 'offline' : update.phase === 'attention' ? this.resumed() : update.phase === 'busy' ? 'working' : 'quiet', ...(update.notice ? {} : { notice: undefined }) });
  }

  private onExit(error: Error): void {
    this.requestInterrupt();
    this.history.beginMaterialization();
    for (const [turnId, waiters] of this.completionWaiters) {
      for (const waiter of waiters) waiter.reject(new Error(`${this.label} app-server exited before confirming interruption for turn ${turnId}.`));
    }
    this.completionWaiters.clear();
    for (const pending of this.pending.values()) pending.resolve?.(NO_SERVER_RESPONSE);
    this.pending.clear();
    this.interaction = undefined;
    this.drafts.clear();
    this.activities.lost();
    try { this.feed?.lost?.(); } catch { /* as for notifications */ }
    this.refreshStatus({ link: 'offline', model: undefined, connection: { state: 'failed', message: safeProviderError(error, this.profileConfig) } });
    // A socket disconnect does not prove the child exited. Keep its handle so a
    // subsequent reopen or service shutdown can dispose it before starting another writer.
  }
}
