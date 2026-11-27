import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { withShownTitle } from './shown-title';
import type {
  ListRevisions, SessionListDelta,
  AgentMember, AgentMemberCreate, AgentMemberList, AgentMemberUpdate, AgentMemberUserProfile,
  AssistantDelegation, AssistantDelegationTrigger, AssistantFile, AssistantPack, AssistantRunSummary, AssistantRunUsage, AssistantInstructions, AssistantMemory, InboxNoticeList, NorthStarReport, PluginApprovalDecision, PluginApprovalList, PluginApprovalResult, RiffetNotice, WorkItem, WorkItemAnswer, WorkItemBrief, WorkItemCreate, WorkItemEvent, WorkItemList, WorkItemPatch, WorkItemRework, WorkItemStartResult, WorkItemSummary, SessionWorkItemRequest,
  CommandObservation,
  ActionStep,
  ApiError,
  BuildInfo,
  DeviceInfo, PushKeyInput, PushKeyStatus,
  LinkAuditEntry, LinkInfo, LinkInviteRequest, LinkInviteResult, LinkJoinRequest, LinkSelfInfo, LinkUpdateRequest, ServerInfo, SecurityEventsResponse,
  CouncilContinueRequest, CouncilCreateRequest, CouncilDiscussion, CouncilExportRequest, CouncilExportResult, CouncilPatchRequest, CouncilPrompts, CouncilSpeechRows, CouncilSummary, CouncilSupplementRequest,
  ChannelAccountInfo, ChannelAccountInput, ChannelBindCode, ChannelChat, ChannelHealth, ChannelRegistration, ChannelRegistrationInput, ChannelRegistrationState, ChannelsState,
  UpdateCheck,
  ExtensionContext, ExtensionInventory, ExtensionDetail, ExtensionDocument, ExtensionManagementCapabilities, ExtensionActionRequest, ExtensionActionResult, ExtensionRuntimeReport,
  NativeBackendUsage,
  OwnerAvatarGenerateRequest,
  OwnerAvatarStyle,
  OwnerAvatarUpload,
  OwnerInfo,
  OwnerUpdate,
  NativeRuntimeActionRequest,
  NativeTurnTarget,
  NativeStopRequest,
  NativeRunRecovery,
  SessionReferenceInput,
  AgentMention,
  AgentCall,
  NativeSlashCatalog,
  ApprovalMode,
  AppSettings,
  AppSettingsUpdate,
  AuxiliaryModelOption,
  AuxiliaryModelPurpose,
  AuxiliaryModelRef,
  HandoffDraft,
  DiscussionCreateRequest,
  Attachment,
  AttemptComparison,
  AttemptGroup,
  BranchInfo,
  Checkpoint,
  CheckpointChange,
  ConfigFile,
  FileEntry,
  FilePreview,
  FileVersion,
  FileDeletion,
  FolderFavorite,
  FolderFavoritesResponse,
  PluginDefaultsUpdate,
  PluginDescriptor,
  PluginsResponse,
  PluginMarketList,
  PluginUpdate,
  GitCommitDetail,
  GitDiff,
  GitDiscardResult,
  GitLineChange,
  GitLog,
  GitRefs,
  GitStatus,
  LaunchTarget,
  Mark,
  MarkCreateRequest,
  MarkFacets,
  MarkListPage,
  MarkListQuery,
  MarkLocation,
  MarkPrompt,
  MarkUpdateRequest,
  MergeResult,
  MachineReport,
  ModelInfo,
  NativeBackendId,
  ServiceMonitorSnapshot,
  StorageReport,
  StatsDashboard,
  StatsGranularity,
  StatsLatency,
  StatsRunsPage,
  StatsSeries,
  StatsSeriesMetric,
  StatsSplit,
  AuxiliaryInspectResponse,
  ModelLeaderboardCategory,
  ModelLeaderboardResponse,
  ModelLeaderboardSource,
  ModelProbePreset,
  ModelProbeResult,
  LoadedExtensions,
  NativeBackendCatalogEntry,
  NativeBackendProfilesResponse,
  NativeBackendProfileSettings,
  NativeBackendProfileSettingsUpdate,
  NativeModelSource, NativeModelApiProtocol,
  NativeInteraction as ContractNativeInteraction,
  NativeInteractionResponse as ContractNativeInteractionResponse,
  NativeInteractionResult as ContractNativeInteractionResult,
  NativeHistoryState as ContractNativeHistoryState,
  PullRequestStatus,
  Automation,
  AutomationRun,
  AutomationTrigger,
  PushResult,
  ReviewComment,
  Run,
  SearchHit,
  CodeDefinitions,
  CodeReferences,
  Session,
  ExternalSessionDirectory,
  ExternalSessionPage,
  SessionDeletionPreview,
  SessionDeletionReceipt,
  ToolGroupId,
  TerminalGridDiagnostics,
  TerminalInfo,
  TerminalAppearance,
  TerminalAttachmentPaste,
  TerminalPasteResult,
  AppearanceCatalog,
  ThemeLibrary,
  ThemeLibraryUpdate,
  WorkbenchEvent,
  WorktreeComparison,
  WorktreeInfo,
  ReleaseNotes,
  ClientAccess,
} from '@contracts';
import { API, CLIENT_FEATURES_HEADER, PLUGIN_PAGE_KINDS_PARAM, TERMINAL_APPEARANCE_HEADER, TERMINAL_BINARY_PROTOCOL } from '@contracts';
import { pageTerminalAppearance } from './terminal-theme';
import { HttpError } from './errors';
import { newId } from './utils';
import { currentServer, locate, serverOfObject, serverPath, withServer } from './server-routing';
import { readNativeOutbox, removeNativeOutbox, writeNativeOutbox } from './native-outbox-storage';

/**
 * What this web client can decode. Every request names it in the features header; a stream that
 * cannot set headers (the browser's `EventSource`) carries the same value in its URL instead.
 */
/** The plugin page's item kinds this client draws beyond the base six (`PluginPageView`). */
const PAGE_KINDS = `${PLUGIN_PAGE_KINDS_PARAM}=meter`;

export const CLIENT_FEATURES = 'quick-chat,pi-agent,antigravity-agent,projectless-tasks,plugin-agents,session-references-v1';

/** Native browser loads cannot send the feature header used by JSON requests. Also addresses the path to its server. */
export function withClientFeatures(path: string): string {
  const [url, hash] = serverPath(path).split('#', 2);
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}features=${encodeURIComponent(CLIENT_FEATURES)}${hash ? `#${hash}` : ''}`;
}

/** A project image decoded for display (`/file/image`); `version` is the preview's hash, so a changed file is fetched again. */
export function projectImageUrl(projectId: string, path: string, version: string): string {
  return withClientFeatures(`/api/projects/${encodeURIComponent(projectId)}/file/image?path=${encodeURIComponent(path)}&version=${version}`);
}

export interface ProjectRecord {
  id: string;
  name: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  archivedAt?: string;
  /** Present when this directory is a git worktree cut from another project. */
  worktree?: { originProjectId: string; branch: string };
  /** The workbench's own project, e.g. the one holding every quick chat; never listed as a project. */
  system?: 'quick-chat' | 'task-workspace' | 'assistant';
  /** The 助理's one standing conversation, on its project only (docs/ASSISTANT.md §3). */
  mainSessionId?: string;
  /** The team member that owns this dedicated assistant project (docs/TEAM.md). */
  agentMemberId?: string;
}

export interface Bootstrap {
  projects: ProjectRecord[];
  sessions: Session[];
  terminals: TerminalInfo[];
  /** Lightweight shell summary of work items; absent from an older server. */
  workItemSummaries?: WorkItemSummary[];
  /** Team members on this server (docs/TEAM.md); absent from an older server or a linked server. */
  teamMembers?: AgentMember[];
  /** Where each list stood when read (`list-delta`); absent from an older server. */
  revisions?: ListRevisions;
  settings: AppSettings;
  /** Absent from a server that predates personal info. */
  owner?: OwnerInfo;
  /** Whether this browser's connection is encrypted and what it may do over it; absent from an older server. */
  access?: ClientAccess;
  csrfToken: string;
  protocol?: { version: number; features: string[] };
  /** This server's id and the servers linked with it (`server-links-v1`); absent from a linked server's answer. */
  serverId?: string;
  servers?: ServerInfo[];
}

/** One conversation search result. `snippet` is a window of the matched text, not the whole message. */
export interface MessageSearchHit {
  sessionId: string;
  projectId: string;
  sessionTitle: string;
  archived: boolean;
  backendId: NativeBackendId;
  messageId: string;
  kind: 'user' | 'assistant' | 'tool';
  at: string;
  snippet: string;
  /** Present for a question: the client turns it into that turn's timeline row key. */
  runId?: string;
}

export interface MessageSearchResult { query: string; hits: MessageSearchHit[]; pending: number }

export interface FileSearchResult {
  entries?: FileEntry[];
  hits?: SearchHit[];
}

export type NativeHistoryState = ContractNativeHistoryState;
export type NativeInteraction = ContractNativeInteraction;
export type NativeInteractionResponse = ContractNativeInteractionResponse;
export type NativeInteractionResult = ContractNativeInteractionResult;

/** `favoriteId` is set when the folder is a (host-level) folder favorite. */
export interface BrowseEntry { name: string; kind: 'directory'; hidden: boolean; favoriteId?: string; }
export interface BrowseResult { path: string; parent?: string; home: string; entries: BrowseEntry[]; favoriteId?: string; }
/**
 * Result of asking the server host to show its native folder chooser.
 * `supported: false` means the host has no usable chooser and the caller should fall
 * back to the in-app directory browser; `cancelled: true` means the user dismissed it.
 */
export interface PickDirectoryResult { supported: boolean; cancelled: boolean; path?: string; }

export interface FileContextReference { kind?: 'file'; path: string; line?: number; text?: string; inline?: boolean; }
export interface SessionContextReference extends SessionReferenceInput {
  title?: string;
  backendId?: NativeBackendId;
  inline?: boolean;
  path?: never;
  line?: never;
  text?: never;
}
/** An @-mentioned Agent the conversation may call (docs/AGENT-CALLS.md); `label` is for the chip only. */
export interface AgentContextReference extends AgentMention {
  kind: 'agent';
  label?: string;
  path?: never;
  line?: never;
  text?: never;
}
export type PromptContextReference = FileContextReference | SessionContextReference | AgentContextReference;
export const isSessionReference = (reference: PromptContextReference): reference is SessionContextReference => reference.kind === 'session';
export const isAgentReference = (reference: PromptContextReference): reference is AgentContextReference => reference.kind === 'agent';
export const isFileReference = (reference: PromptContextReference): reference is FileContextReference => reference.kind !== 'session' && reference.kind !== 'agent';
export const sameContextReference = (left: PromptContextReference, right: PromptContextReference): boolean => isSessionReference(left)
  ? isSessionReference(right) && left.sessionId === right.sessionId
  // One mention per team member or per Agent: its provider and model are a choice on the chip, not another mention.
  : isAgentReference(left)
    ? isAgentReference(right) && (left.memberId || right.memberId ? left.memberId === right.memberId : left.backendId === right.backendId)
  : isFileReference(right) && left.path === right.path && left.line === right.line;
export function mergeRestoredReferences(current: PromptContextReference[], restored: PromptContextReference[]): PromptContextReference[] {
  return [...restored, ...current.filter(item => !restored.some(reference => sameContextReference(reference, item)))];
}
export function messageContext(references: readonly PromptContextReference[]): Pick<NativeMessageInput, 'context' | 'references' | 'agents'> {
  const context = references.filter(isFileReference).map(({ path, line }) => ({ path, ...(line === undefined ? {} : { line }) }));
  const sessions = references.filter(isSessionReference).map(({ sessionId, fromRunId }) => ({ kind: 'session' as const, sessionId, ...(fromRunId ? { fromRunId } : {}) }));
  const agents = references.filter(isAgentReference).map(({ backendId, backendProfileId, model, memberId, label }) => ({
    backendId,
    ...(backendProfileId ? { backendProfileId } : {}),
    ...(model ? { model } : {}),
    ...(memberId ? { memberId } : {}),
    ...(memberId && label ? { label } : {}),
  }));
  return { ...(context.length ? { context } : {}), ...(sessions.length ? { references: sessions } : {}), ...(agents.length ? { agents } : {}) };
}
export function restoreContext(input: Pick<NativeMessageInput, 'context' | 'references' | 'agents'>, run?: Run): PromptContextReference[] {
  return [...input.context ?? [], ...input.references?.map(item => {
    const captured = run?.native?.contextSnapshots?.find(snapshot => snapshot.sessionId === item.sessionId);
    // Exact recovery retains the previously chosen version even when this local Run has no receipt yet.
    return { ...item, ...(captured ? { title: captured.title, backendId: captured.backendId, fromRunId: run!.id } : {}) };
  }) ?? [], ...input.agents?.map(item => ({ kind: 'agent' as const, ...item })) ?? []];
}

/** An editable new-recipient draft starts from source identity, never another recipient's Run. */
export function restoreNewSessionContext(input: Pick<NativeMessageInput, 'context' | 'references' | 'agents'>): PromptContextReference[] {
  return restoreContext(input).map(reference => {
    if (!isSessionReference(reference)) return reference;
    const { fromRunId: _previousRecipient, ...source } = reference;
    return source;
  });
}

export interface NativeMessageInput {
  commandId: string;
  text: string;
  attachments?: Array<{ id: string }>;
  context?: FileContextReference[];
  references?: SessionReferenceInput[];
  agents?: AgentMention[];
  expectedConfigRevision?: number;
  stop?: NativeStopRequest;
}

export interface NativeSteerInput extends Omit<NativeMessageInput, 'expectedConfigRevision' | 'stop'> { target: NativeTurnTarget; }

export interface NativeSessionCreateInput {
  /** Local acknowledgement only; omitted from the create protocol. */
  draftCleared?: boolean;
  rejected?: boolean;
  invalidReason?: string;
  backendId?: NativeBackendId;
  backendProfileId?: string;
  clientSessionId: string;
  projectId?: string;
  projectless?: boolean;
  title?: string;
  model?: string;
  mode?: string;
  approval?: string;
  /** The phones (`device:<id>`) the agent may control; absent or empty means none. */
  toolGroups?: ToolGroupId[];
  /** MCP servers and skills switched off for this conversation, `mcp:<name>` / `skill:<name>`; absent or empty means all on. */
  extensionsOff?: string[];
  /** The 任务 this conversation starts; absent, it belongs to none. */
  workItemId?: string;
  /** The team member that owns this conversation (docs/TEAM.md). */
  agentMemberId?: string;
  initialMessage: NativeMessageInput;
}

export interface NativeSessionCreateResult { session: Session; run: Run; project?: ProjectRecord; }
export interface ForkSessionResult { session: Session; run?: Run; project?: ProjectRecord; }
export interface NativeSendOutboxEntry { sessionId: string; body: NativeMessageInput; createdAt: string; mode?: 'interrupt'; steerTarget?: NativeTurnTarget; sourceRunId?: string; ownerRunId?: string; version?: 2; invalidReason?: string; }

let sessionReferencesSupported: boolean | undefined;

const nativeCreateOutboxPrefix = 'riffet.native-create.';
const nativeSendOutboxPrefix = 'riffet.native-send.';
const nativeSteerOutboxPrefix = 'riffet.native-steer.v2.';

/** Persist before POST so an uncertain HTTP result can be retried with the same idempotency keys. */
export function saveNativeCreateRequest(body: NativeSessionCreateInput): void {
  writeNativeOutbox(`${nativeCreateOutboxPrefix}${body.clientSessionId}`, JSON.stringify(body));
}

export function removeNativeCreateRequest(clientSessionId: string): void {
  removeNativeOutbox(`${nativeCreateOutboxPrefix}${clientSessionId}`);
}

export function listNativeCreateRequests(): NativeSessionCreateInput[] {
  const result = new Map<string, NativeSessionCreateInput>();
  for (const { value } of readNativeOutbox([nativeCreateOutboxPrefix])) {
    try {
      const parsed = JSON.parse(value) as NativeSessionCreateInput | null;
      if (!parsed?.clientSessionId || !parsed.initialMessage?.commandId || !(parsed.projectId || parsed.projectless === true)) continue;
      const prior = result.get(parsed.clientSessionId);
      const input = ({ draftCleared: _draft, rejected: _rejected, invalidReason: _reason, ...body }: NativeSessionCreateInput) => JSON.stringify(body);
      if (prior && input(prior) !== input(parsed)) prior.invalidReason = i18n._(msg`保存的消息存在冲突，无法重试`);
      else result.set(parsed.clientSessionId, { ...parsed, ...(prior?.draftCleared ? { draftCleared: true } : {}), ...(prior?.rejected ? { rejected: true, invalidReason: prior.invalidReason } : {}) });
    } catch { /* Retain unreadable recovery records. */ }
  }
  return [...result.values()];
}

const nativeSendOutboxKey = (sessionId: string, commandId: string, steer = false) => `${steer ? nativeSteerOutboxPrefix : nativeSendOutboxPrefix}${sessionId}.${commandId}`;

function validSteerTarget(target: NativeTurnTarget | undefined): boolean {
  return Boolean(target && typeof target.nativeSessionId === 'string' && target.nativeSessionId && typeof target.turnId === 'string' && target.turnId);
}

/** The dedicated mapper is shared by first send and retry; it cannot acquire current config/target. */
export function nativeSteerInput(entry: NativeSendOutboxEntry): NativeSteerInput {
  if (entry.invalidReason || entry.version !== 2 || !validSteerTarget(entry.steerTarget) || entry.mode || entry.body.expectedConfigRevision !== undefined || entry.body.stop !== undefined || entry.sourceRunId !== undefined && (typeof entry.sourceRunId !== 'string' || !entry.sourceRunId)) {
    throw new Error(entry.invalidReason ?? i18n._(msg`补充消息的发送记录不完整，请恢复内容后重试`));
  }
  const { commandId, text, attachments, context, references, agents } = entry.body;
  return { commandId, text, ...(attachments ? { attachments } : {}), ...(context ? { context } : {}), ...(references ? { references } : {}), ...(agents ? { agents } : {}), target: { nativeSessionId: entry.steerTarget!.nativeSessionId, turnId: entry.steerTarget!.turnId } };
}

export function saveNativeSendRequest(entry: NativeSendOutboxEntry): void {
  if (!entry.invalidReason && (entry.steerTarget || entry.version !== undefined || entry.sourceRunId !== undefined)) nativeSteerInput(entry);
  writeNativeOutbox(nativeSendOutboxKey(entry.sessionId, entry.body.commandId, Boolean(entry.steerTarget || entry.version !== undefined || entry.sourceRunId !== undefined)), JSON.stringify(entry));
}

export function removeNativeSendRequest(sessionId: string, commandId: string): void {
  removeNativeOutbox(nativeSendOutboxKey(sessionId, commandId));
  removeNativeOutbox(nativeSendOutboxKey(sessionId, commandId, true));
}

export function listNativeSendRequests(sessionId: string): NativeSendOutboxEntry[] {
  const prefixes = [nativeSendOutboxPrefix, nativeSteerOutboxPrefix].map(prefix => `${prefix}${sessionId}.`);
  const result = new Map<string, NativeSendOutboxEntry>();
  for (const { key, value } of readNativeOutbox(prefixes)) {
    try {
      const parsed = JSON.parse(value) as NativeSendOutboxEntry | null;
      if (parsed?.sessionId !== sessionId || !parsed.body?.commandId || typeof parsed.body.text !== 'string') continue;
      const steer = key.startsWith(nativeSteerOutboxPrefix);
      if (steer) {
        try { nativeSteerInput(parsed); }
        catch { parsed.invalidReason ??= i18n._(msg`补充消息的发送记录不完整，请恢复内容后重试`); }
      } else if (parsed.steerTarget || parsed.version !== undefined || parsed.sourceRunId !== undefined) {
        parsed.invalidReason = i18n._(msg`补充消息的发送记录无法读取，请恢复内容后重试`);
      }
      const prior = result.get(parsed.body.commandId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(parsed)) prior.invalidReason = i18n._(msg`保存的消息存在冲突，无法重试`);
      else result.set(parsed.body.commandId, parsed);
    } catch {
      // Retain unreadable records for recovery; never turn them into ordinary sends.
    }
  }
  return [...result.values()];
}

/** Replays the persisted action exactly, including after a reload or a lost HTTP response. */
export function submitNativeSendRequest(entry: NativeSendOutboxEntry, workbenchConnectionId?: string): Promise<Run> {
  if (entry.invalidReason) return Promise.reject(new Error(entry.invalidReason));
  if (entry.steerTarget || entry.version !== undefined || entry.sourceRunId !== undefined) {
    const input = nativeSteerInput(entry);
    return entry.sourceRunId ? api.steerQueuedNativeRun(entry.sessionId, entry.sourceRunId, { commandId: input.commandId, target: input.target }) : api.nativeSteer(entry.sessionId, input);
  }
  return entry.mode === 'interrupt' ? api.nativeInterruptAndSend(entry.sessionId, entry.body) : api.nativeSend(entry.sessionId, entry.body, workbenchConnectionId);
}

export interface MergeOptions { strategy?: 'merge' | 'squash'; message?: string; commitPending?: string; removeWorktree?: boolean; cleanup?: 'keep' | 'archive' | 'remove' }
export interface LaunchIds { clientSessionId: string; commandId: string }
/** What a new automation is made of; the server fills the rest (delivery `new`, catch-up `latest`, enabled). */
export type AutomationInput = {
  name: string; prompt: string; target?: LaunchTarget; projectId?: string | null; isolate?: boolean;
  triggers?: AutomationTrigger[]; delivery?: Automation['delivery']; catchUp?: Automation['catchUp']; enabled?: boolean;
  /** A follow-up of one conversation instead of a standalone task. */
  followUp?: { sessionId: string };
  /** A follow-up's id, chosen by the client so a retried request finds the first one. */
  id?: string;
} & Pick<NativeMessageInput, 'attachments' | 'context' | 'references'>;

export interface AuthStatus { authenticated: boolean; tokenRequired: boolean; csrfToken?: string; }
export type AuthLogin = { code: string; name?: string } | { token: string };

let csrfToken = '';

export function setCsrfToken(value: string | undefined): void {
  csrfToken = value ?? '';
}

export { HttpError };

/**
 * The server could not be reached, a gateway in front of it answered for it (a restart behind a
 * proxy's 502/503/504), or a timed read never started. None of these say anything about the sign-in;
 * the app's own 500 does say something, and is shown as the error it is.
 */
export function isUnreachable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504;
  return (error as { name?: unknown } | undefined)?.name === 'TimeoutError';
}

/**
 * Status and poll reads give up when no response has started after this long. Each poller lets one
 * read run at a time, so a half-open connection that never answers would otherwise freeze it while
 * it still looks current. Only the wait for the response is timed: a large list arriving slowly over
 * a weak link is still arriving, and cutting its body off would turn "slow" into "never".
 */
const STATUS_TIMEOUT_MS = 15_000;
const responseDeadlines = new WeakMap<AbortSignal, () => void>();
/** Signals their deadline aborted: an engine may reject with a plain AbortError rather than the reason. */
const expired = new WeakSet<AbortSignal>();
function timeout(ms = STATUS_TIMEOUT_MS): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    expired.add(controller.signal);
    controller.abort(new DOMException('The server did not answer in time', 'TimeoutError'));
  }, ms);
  responseDeadlines.set(controller.signal, () => clearTimeout(timer));
  return controller.signal;
}

let unauthenticatedHandler: (() => void) | undefined;

/** Called when the server says the browser's sign-in is gone (not a backend's own 401). */
export function onUnauthenticated(handler: (() => void) | undefined): void {
  unauthenticatedHandler = handler;
}

let sessionDeletedHandler: ((sessionId: string) => void) | undefined;

/** Called with the conversation a request named when the server answers `410 SESSION_DELETED`. */
export function onSessionDeletedResponse(handler: ((sessionId: string) => void) | undefined): void {
  sessionDeletedHandler = handler;
}

async function responsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  return contentType.includes('application/json') ? response.json() : response.text();
}

/** Shared authentication and errors for JSON requests and streamed responses. */
export async function requestResponse(path: string, init: RequestInit = {}): Promise<Response> {
  // Before anything is awaited, so a request inside `withServer` is addressed to that server.
  path = serverPath(path);
  const headers = new Headers(init.headers);
  // The web has the quick-chat and pi surfaces, so every read asks the server to include them.
  headers.set(CLIENT_FEATURES_HEADER, CLIENT_FEATURES);
  // A FormData body gets its multipart boundary from the browser.
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (init.method && !['GET', 'HEAD', 'OPTIONS'].includes(init.method.toUpperCase())) {
    headers.set('X-CSRF-Token', csrfToken);
    if (typeof document !== 'undefined' && typeof getComputedStyle === 'function') {
      const appearance = pageTerminalAppearance();
      headers.set(TERMINAL_APPEARANCE_HEADER, `${appearance.foreground};${appearance.background}`);
    }
  }
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
    if (init.signal) responseDeadlines.get(init.signal)?.();
  } catch (error) {
    // A timed read that went quiet is a lost connection; only the caller's own abort is passed through.
    if (init.signal?.aborted && !expired.has(init.signal)) throw error;
    throw new HttpError(0, error instanceof Error ? error.message : 'Network request failed');
  }
  if (!response.ok && !(response.status === 304 && headers.has('If-None-Match'))) {
    const payload = await responsePayload(response);
    const apiError = payload as ApiError | undefined;
    if (response.status === 401 && apiError?.error?.code === 'UNAUTHENTICATED') unauthenticatedHandler?.();
    if (response.status === 410 && apiError?.error?.code === 'SESSION_DELETED') {
      // Only the id the server names: a fork or handoff of a live source may fail on a deleted new id.
      const details: unknown = apiError.error.details;
      const named = typeof details === 'object' && details !== null ? (details as { sessionId?: unknown }).sessionId : undefined;
      if (typeof named === 'string' && named) sessionDeletedHandler?.(named);
    }
    throw new HttpError(
      response.status,
      apiError?.error?.message ?? (typeof payload === 'string' ? payload : response.statusText),
      apiError?.error?.code,
      apiError?.error?.details,
      apiError?.error?.params,
    );
  }
  return response;
}

export async function readSseStream(
  response: Response,
  onEvent: (event: string, data: string) => void,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const dispatch = (block: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) onEvent(event, data.join('\n'));
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: RegExpExecArray | null;
      while ((end = /\r?\n\r?\n/.exec(buffer))) {
        dispatch(buffer.slice(0, end.index));
        buffer = buffer.slice(end.index + end[0].length);
      }
    }
    const rest = buffer + decoder.decode();
    if (rest.trim()) dispatch(rest);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** One round trip; `response` is kept for callers that need headers (a list's `ETag`). */
async function send<T>(path: string, init: RequestInit): Promise<{ data: T; response: Response }> {
  const response = await requestResponse(path, init);
  // Conditional list reads have no payload when the server returns 304.
  if (response.status === 204 || response.status === 304) return { data: undefined as T, response };
  return { data: await responsePayload(response) as T, response };
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await send<T>(path, init)).data;
}

/** A list read that may be answered "unchanged since `etag`" instead of with the list. */
export type ConditionalList<T> = { unchanged: true } | { unchanged: false; data: T; etag?: string };

/**
 * Sends `If-None-Match` when the caller holds an ETag. A server without ETag support answers 200
 * with no header, which reads as a changed list with nothing to remember, so nothing is skipped.
 */
async function requestList<T>(path: string, etag?: string, signal?: AbortSignal): Promise<ConditionalList<T>> {
  const { data, response } = await send<T>(path, { ...(etag ? { headers: { 'If-None-Match': etag } } : {}), ...(signal ? { signal } : {}) });
  if (response.status === 304) return { unchanged: true };
  return { unchanged: false, data, ...(response.headers.get('ETag') ? { etag: response.headers.get('ETag')! } : {}) };
}

/** The revision a list ETag (`W/"12"`) names, or undefined for anything else. */
export function etagRevision(etag: string | undefined): number | undefined {
  const match = etag ? /^(?:W\/)?"(\d+)"$/.exec(etag) : null;
  return match ? Number(match[1]) : undefined;
}

const queryString = (params: object): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '' && value !== false) query.set(key, value === true ? '1' : String(value));
  const text = query.toString();
  return text ? `?${text}` : '';
};

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** The live source of an assistant request stays in the transport, outside the durable outbox. */
const workbenchPost = (body: unknown, connectionId?: string): RequestInit => ({
  ...json('POST', body),
  ...(connectionId ? { headers: { 'X-Riffet-Workbench': connectionId } } : {}),
});

export const api = {
  contextSnapshot: async (sessionId: string, hash: string, signal?: AbortSignal): Promise<{ version: number; messages: Array<{ role: string; text: string; at?: string; id?: string }> }> => {
    const response = await requestResponse(`/api/sessions/${encodeURIComponent(sessionId)}/blobs/${encodeURIComponent(hash)}`, { signal });
    return response.json();
  },
  health: () => request<{ ok: boolean; version: string; build?: BuildInfo; managedBy?: 'cli' | 'launchd' | 'app'; instanceId?: string }>('/health'),
  uploadClientLog: (name: string, content: string) => request<{ path: string; bytes: number }>('/api/client-logs', json('POST', { name, content })),
  /** `keepalive` lets the batch leave while the page is being hidden or closed; the browser caps such a body at 64 KB. */
  uploadJankReport: (report: unknown, keepalive = false) => request<void>('/api/client-jank', { ...json('POST', report), keepalive }),
  checkForUpdates: () => request<UpdateCheck>('/api/update'),
  /** The server's last check, without waiting for the network; `null` before any check. */
  updateStatus: () => request<UpdateCheck | null>('/api/update/status'),
  releaseNotes: (language: string) => request<ReleaseNotes>(`/api/update/notes?language=${encodeURIComponent(language)}`),
  authStatus: async () => {
    const status = await request<AuthStatus>('/api/auth/status', { signal: timeout() });
    setCsrfToken(status.csrfToken);
    return status;
  },
  login: async (credential: string | AuthLogin) => {
    const result = await request<AuthStatus & { csrfToken: string }>('/api/auth/login', json('POST', typeof credential==='string'?{token:credential}:credential));
    setCsrfToken(result.csrfToken);
    return result;
  },
  /** A one-use code for pairing another device with this server; `qr` is server-made SVG and `localOnly` means no other device can reach it. */
  pairingCode: () => request<{ code: string; expiresAt: number; qr: string; baseUrl: string; localOnly: boolean }>('/api/pairing/code', json('POST', {})),
  logout: () => { sessionReferencesSupported = undefined; return request<void>('/api/auth/logout', json('POST')); },
  bootstrap: async () => {
    const linked = currentServer();
    // Longer than a poll: it carries every list in full.
    const data = await request<Bootstrap>('/api/bootstrap', { signal: timeout(30_000) });
    // A linked server's answer carries no sign-in of this browser's, and its features are its own.
    if (linked) return data;
    setCsrfToken(data.csrfToken);
    sessionReferencesSupported = data.protocol?.features.includes('session-references-v1') ?? false;
    return data;
  },
  projects: () => request<ProjectRecord[]>('/api/projects', { signal: timeout() }),
  taskWorkspaceLocation: () => request<{ path: string; source: 'custom' | 'default'; available: boolean; error?: string }>('/api/task-workspaces/location'),
  promoteProject: (id: string, name: string) => request<ProjectRecord>(`/api/projects/${encodeURIComponent(id)}/promote`, json('POST', { name })),
  createProject: (body: { cwd: string; name?: string }) => request<ProjectRecord>('/api/projects', json('POST', body)),
  updateProject: (id: string, body: { name?: string; tags?: string[]; archived?: boolean }) => request<ProjectRecord>(`/api/projects/${encodeURIComponent(id)}`, json('PATCH', body)),
  deleteProject: (id: string) => request<void>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  browse: (path?: string) => request<BrowseResult>('/api/browse', json('POST', path ? { path } : {})),
  /** Ask the server host to open its native folder chooser (Finder/Explorer equivalent). */
  pickDirectory: (body?: { prompt?: string; defaultPath?: string }) => request<PickDirectoryResult>('/api/pick-directory', json('POST', body ?? {})),
  /** Host-level favorites without `projectId`, else that project's files-panel favorites; in their order. */
  folderFavorites: (projectId?: string) => request<FolderFavoritesResponse>(`/api/folder-favorites${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  /** Idempotent: favoriting a folder twice answers with the existing favorite. */
  createFolderFavorite: (body: { path: string; label?: string; projectId?: string }) => request<FolderFavorite>('/api/folder-favorites', json('POST', body)),
  updateFolderFavorite: (id: string, body: { label?: string | null; used?: true }) => request<FolderFavorite>(`/api/folder-favorites/${encodeURIComponent(id)}`, json('PATCH', body)),
  reorderFolderFavorites: (ids: string[], projectId?: string) => request<FolderFavoritesResponse>('/api/folder-favorites/order', json('PUT', { ids, ...(projectId ? { projectId } : {}) })),
  deleteFolderFavorite: (id: string) => request<{ ok: true }>(`/api/folder-favorites/${encodeURIComponent(id)}`, json('DELETE')),
  createSession: (body: { projectId: string; kind: 'native'; backendId?: NativeBackendId; backendProfileId?: string; nativeSessionId?: string; title?: string; model?: string; mode?: string; approval?: string; resumePicker?: boolean }) => request<Session>(serverPath('/api/sessions', serverOfObject(body.projectId)), json('POST', body)),
  createNativeSession: ({ draftCleared: _draftCleared, rejected: _rejected, invalidReason, ...body }: NativeSessionCreateInput, workbenchConnectionId?: string) => invalidReason ? Promise.reject(new Error(invalidReason)) : requireReferenceProtocol(body.initialMessage).then(() => request<NativeSessionCreateResult>(serverPath('/api/sessions', serverOfObject(body.projectId)), workbenchPost({ ...body, kind: 'native' }, workbenchConnectionId))),
  sessionDeletion: (id: string) => request<SessionDeletionPreview>(`/api/sessions/${encodeURIComponent(id)}/deletion`),
  deleteSession: (id: string, sessionIds: string[]) => request<SessionDeletionReceipt>(`/api/sessions/${encodeURIComponent(id)}`, json('DELETE', { sessionIds })),
  updateSession: (id: string, body: { title?: string; tags?: string[]; archived?: boolean; pinned?: boolean; toolGroups?: ToolGroupId[]; extensionsOff?: string[] }) => request<Session>(`/api/sessions/${encodeURIComponent(id)}`, json('PATCH', body)),
  /** The conversation was on screen up to `activityAt`; the server keeps the latest such time for every device. */
  markSessionSeen: (id: string, activityAt: string) => request<Session>(`/api/sessions/${encodeURIComponent(id)}/seen`, json('POST', { activityAt })),
  markAllSessionsSeen: () => request<{ sessionIds: string[] }>('/api/sessions/seen', json('POST', { all: true })),
  markSessionsSeen: async (sessionIds: readonly string[]) => {
    const path = serverPath('/api/sessions/seen');
    const batchSize = 5000; // The endpoint's limit for explicit ids.
    for (let offset = 0; offset < sessionIds.length; offset += batchSize) {
      await request(path, json('POST', { sessionIds: sessionIds.slice(offset, offset + batchSize) }));
    }
  },
  setPinOrder: async (sessionIds: string[]) => (await request<{ sessions: Session[] }>('/api/sessions/pin-order', json('PUT', { sessionIds }))).sessions,
  /** Provider conversations on the server's machine (docs/TERMINAL-SESSIONS.md). */
  externalSessions: (params: { scope: 'project' | 'directory' | 'all'; projectId?: string; cwd?: string; backendId?: string; q?: string; cursor?: string; limit?: number; nonInteractive?: boolean; refresh?: boolean }, signal?: AbortSignal) => request<ExternalSessionPage>(`/api/external-sessions${queryString(params)}`, { signal }),
  externalSessionDirectories: async (params: { backendId?: string; nonInteractive?: boolean; refresh?: boolean } = {}, signal?: AbortSignal) => (await request<{ directories: ExternalSessionDirectory[] }>(`/api/external-sessions/directories${queryString(params)}`, { signal })).directories,
  importExternalSession: (body: { backendId: NativeBackendId; backendProfileId?: string; nativeSessionId: string }) => request<{ session: Session; created: boolean }>('/api/external-sessions/import', json('POST', body)),
  /** Takes the conversation back from a terminal; `force` first stops the CLI still running there. */
  releaseTerminalHold: async (sessionId: string, force = false) => (await request<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/terminal-hold${force ? '?force=1' : ''}`, json('DELETE'))).session,
  sessions: () => request<Session[]>('/api/sessions'),
  sessionsIfChanged: (etag?: string) => requestList<Session[]>('/api/sessions', etag, timeout()),
  /** Only the sessions changed after [since] (docs/LIST-SYNC.md); [etag] still turns an unchanged list into a 304. */
  sessionsSince: (since: number, etag?: string) => requestList<SessionListDelta>(`/api/sessions?since=${since}`, etag, timeout()),
  startSession: <T = unknown>(id: string) => request<T>(`/api/sessions/${encodeURIComponent(id)}/start`, json('POST')),
  restartSession: <T = unknown>(id: string, restartFingerprint: string, restartAddress: string) => request<T>(`/api/sessions/${encodeURIComponent(id)}/start`, json('POST', { restartFingerprint, restartAddress })),
  steerQueuedNativeRun: (id: string, sourceRunId: string, body: { commandId: string; target: NativeTurnTarget }) => request<Run>(`/api/sessions/${encodeURIComponent(id)}/native/runs/${encodeURIComponent(sourceRunId)}/steer`, json('POST', body)),
  /** Asks the CLI to stop a background task. The activity's own later states say whether it did. */
  /** The command that continues the conversation in a terminal (docs/TERMINAL-SESSIONS.md). */
  resumeCommand: (id: string) => request<{ nativeSessionId: string; command: string; credentialsOmitted: boolean }>(`/api/sessions/${encodeURIComponent(id)}/resume-command`),
  /** Stops the conversation's CLI so a terminal can take over. */
  releaseSessionCli: (id: string) => request<{ session: Session }>(`/api/sessions/${encodeURIComponent(id)}/release-cli`, json('POST')),
  stopNativeActivity: (id: string, activityId: string) => request<unknown>(`/api/sessions/${encodeURIComponent(id)}/native/activities/${encodeURIComponent(activityId)}/stop`, json('POST')),
  /** The full text behind an activity's preview, fetched only when the reader asks for it. */
  sessionBlob: async (id: string, blobRef: string, signal?: AbortSignal): Promise<string> => {
    const body = await request<unknown>(`/api/sessions/${encodeURIComponent(id)}/blobs/${encodeURIComponent(blobRef)}`, { signal });
    return typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  },
  nativeSteer: (id: string, body: NativeSteerInput) => requireReferenceProtocol(body).then(() => request<Run>(`/api/sessions/${encodeURIComponent(id)}/native/steer`, json('POST', body))),
  nativeSend: (id: string, body: NativeMessageInput, workbenchConnectionId?: string) => requireReferenceProtocol(body).then(() => request<Run>(`/api/sessions/${encodeURIComponent(id)}/native/send`, workbenchPost(body, workbenchConnectionId))),
  /** Confirms a live CLI interrupt and accepts this follow-up before releasing the dispatch queue. */
  nativeInterruptAndSend: (id: string, body: NativeMessageInput) => requireReferenceProtocol(body).then(() => request<Run>(`/api/sessions/${encodeURIComponent(id)}/native/interrupt-and-send`, json('POST', body))),
  sendQueuedNativeRunNow: (id: string, runId: string, stop: NativeStopRequest) => request<Run>(`/api/sessions/${encodeURIComponent(id)}/native/runs/${encodeURIComponent(runId)}/send-now`, json('POST', { stop })),
  nativePrewarm: (body: { projectId: string; backendId?: NativeBackendId; backendProfileId?: string; model?: string; mode?: string; approval?: string; claimId?: string }) => request<{ state: string; reason?: string; claimId?: string }>(serverPath('/api/native/prewarm', serverOfObject(body.projectId)), json('POST', body)).then((answer) => { if (answer.claimId) locate([answer.claimId], serverOfObject(body.projectId)); return answer; }),
  // `keepalive` lets it leave with a closing page.
  nativePrewarmRelease: (body: { backendId?: NativeBackendId; claimId: string }) => request<void>(serverPath('/api/native/prewarm/release', serverOfObject(body.claimId)), { ...json('POST', body), keepalive: true }),
  cancelNativeRun: (id: string, runId: string) => request<Run>(`/api/sessions/${encodeURIComponent(id)}/native/runs/${encodeURIComponent(runId)}/cancel`, json('POST')),
  checkNativeRun: (id: string, runId: string) => request<NativeRunRecovery>(`/api/sessions/${encodeURIComponent(id)}/native/runs/${encodeURIComponent(runId)}/check`, json('POST')),
  resolveNativeRun: (id: string, runId: string, queuedRunIds: string[]) => request<Run>(`/api/sessions/${encodeURIComponent(id)}/native/runs/${encodeURIComponent(runId)}/resolve`, json('POST', { outcome: 'continue', queuedRunIds })),
  /** Conversation search: questions from the stored runs, answers from the server's message index. */
  searchMessages: (q: string, signal?: AbortSignal, sessionId?: string) => {
    const params = new URLSearchParams({ q });
    if (sessionId) params.set('sessionId', sessionId);
    return request<MessageSearchResult>(`/api/search/messages?${params.toString()}`, { signal });
  },
  nativeInteraction: (id: string, response: NativeInteractionResponse) => request<NativeInteractionResult>(`/api/sessions/${encodeURIComponent(id)}/native/interaction`, json('POST', response)),
  /** Pushes the auto-deny back; the stream then delivers the interaction with its new `expiresAt`. */
  extendNativeInteraction: (id: string, interactionId: string) => request<NativeInteraction>(`/api/sessions/${encodeURIComponent(id)}/native/interaction/extend`, json('POST', { interactionId })),
  nativeCurrentInteraction: (id: string) => request<NativeInteraction | null>(`/api/sessions/${encodeURIComponent(id)}/native/interaction`),
  nativeKeys: (id: string, keys: string[]) => request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/native/keys`, json('POST', { keys })),
  /** Restarts the CLI with another approval mode (`--force` / `--auto-review`), resuming the chat. */
  nativeSetApproval: (id: string, approval: string) => request<Session>(`/api/sessions/${encodeURIComponent(id)}/native/approval`, json('POST', { approval })),
  nativeRuntimeAction: (id: string, body: NativeRuntimeActionRequest) => request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/native/runtime-control`, json('POST', body)),
  nativeSetMode: (id: string, mode: string) => request<Session>(`/api/sessions/${encodeURIComponent(id)}/native/mode`, json('POST', { mode })),
  /** The CLI's own model list (from `--list-models`), so the picker needs no terminal interaction. */
  nativeModels: (id: string) => request<Array<{ value: string; name: string }>>(`/api/sessions/${encodeURIComponent(id)}/native/models`),
  /** Switches the CLI's model by restarting the terminal with `--model`, resuming the same chat. */
  nativeSetModel: (id: string, model: string) => request<Session>(`/api/sessions/${encodeURIComponent(id)}/native/model`, json('POST', { model })),
  /** Continues the conversation on another provider that shares its native session (`continuations`), with one of its models. */
  nativeSwitchProfile: (id: string, backendProfileId: string, model: string) => request<Session>(`/api/sessions/${encodeURIComponent(id)}/native/configure`, json('POST', { backendProfileId, model })),
  cancelSession: (id: string, body?: NativeStopRequest) => request<{ interrupted: boolean; run?: Run }>(`/api/sessions/${encodeURIComponent(id)}/cancel`, json('POST', body)),
  deleteRun: (id: string, runId: string) => request<void>(`/api/sessions/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' }),
  events: (id: string, after = 0) => request<WorkbenchEvent[]>(`/api/sessions/${encodeURIComponent(id)}/events?after=${after}`),
  runs: (id: string, commandId?: string) => request<Run[]>(`/api/sessions/${encodeURIComponent(id)}/runs${commandId ? `?commandId=${encodeURIComponent(commandId)}` : ''}`),
  exportSession: (id: string) => request<unknown>(`/api/sessions/${encodeURIComponent(id)}/export`),
  createTerminal: (body: { projectId: string; sessionId?: string; kind?: 'shell' | 'login'; title?: string; args?: string[]; profileId?: string; cwd?: string }) => request<TerminalInfo>(serverPath('/api/terminals', serverOfObject(body.projectId)), json('POST', body)),
  terminals: () => request<TerminalInfo[]>('/api/terminals'),
  terminalsIfChanged: (etag?: string) => requestList<TerminalInfo[]>('/api/terminals', etag, timeout()),
  getTerminal: (id: string) => request<TerminalInfo>(`/api/terminals/${encodeURIComponent(id)}`),
  terminalGridDiagnostics: (id: string) => request<TerminalGridDiagnostics>(`/api/terminals/${encodeURIComponent(id)}/diagnostics`, { cache: 'no-store', signal: timeout() }),
  claimTerminal: (id: string, body: { clientId: string; takeover?: boolean }) => request<TerminalInfo>(`/api/terminals/${encodeURIComponent(id)}/claim`, json('POST', body)),
  pasteTerminalAttachments: (id: string, body: TerminalAttachmentPaste) => request<TerminalPasteResult>(`/api/terminals/${encodeURIComponent(id)}/paste-attachments`, json('POST', body)),
  setTerminalAppearance: (id: string, body: TerminalAppearance) => request<TerminalInfo>(`/api/terminals/${encodeURIComponent(id)}/appearance`, json('POST', body)),
  interruptTerminal: (id: string) => request<void>(`/api/terminals/${encodeURIComponent(id)}/interrupt`, json('POST')),
  deleteTerminal: (id: string) => request<void>(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  files: (projectId: string, path = '', limit?: number, offset?: number) => {
    const params = new URLSearchParams({ path });
    if (limit !== undefined) params.set('limit', String(limit));
    if (offset !== undefined) params.set('offset', String(offset));
    return request<FileEntry[]>(`/api/projects/${encodeURIComponent(projectId)}/files?${params.toString()}`);
  },
  find: (projectId: string, query: string, signal?: AbortSignal) => request<FileSearchResult | FileEntry[]>(`/api/projects/${encodeURIComponent(projectId)}/find?q=${encodeURIComponent(query)}`, signal ? { signal } : {}),
  search: (projectId: string, query: string, signal?: AbortSignal) => request<SearchHit[]>(`/api/projects/${encodeURIComponent(projectId)}/search?q=${encodeURIComponent(query)}`, signal ? { signal } : {}),
  definition: (projectId: string, at: { path: string; line: number; column: number; word: string }, signal?: AbortSignal) => request<CodeDefinitions>(`/api/projects/${encodeURIComponent(projectId)}/code/definition?${new URLSearchParams({ path: at.path, line: String(at.line), column: String(at.column), word: at.word }).toString()}`, signal ? { signal } : {}),
  references: (projectId: string, at: { path: string; word: string; scope: 'module' | 'project' }, signal?: AbortSignal) => request<CodeReferences>(`/api/projects/${encodeURIComponent(projectId)}/code/references?${new URLSearchParams(at).toString()}`, signal ? { signal } : {}),
  preview: (projectId: string, path: string) => request<FilePreview>(`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`),
  saveFile: (projectId: string, path: string, content: string, expectedHash: string) => request<FileVersion>(`/api/projects/${encodeURIComponent(projectId)}/file`, { method: 'PUT', body: JSON.stringify({ path, content, expectedHash }) }),
  createFile: (projectId: string, path: string, kind: 'file' | 'directory') => request<FileVersion>(`/api/projects/${encodeURIComponent(projectId)}/file/create`, { method: 'POST', body: JSON.stringify({ path, kind }) }),
  moveFile: (projectId: string, from: string, to: string) => request<{ path: string }>(`/api/projects/${encodeURIComponent(projectId)}/file/move`, { method: 'POST', body: JSON.stringify({ from, to }) }),
  deleteFile: (projectId: string, path: string, permanent = false) => request<FileDeletion>(`/api/projects/${encodeURIComponent(projectId)}/file/delete`, { method: 'POST', body: JSON.stringify({ path, permanent }) }),
  restoreFile: (projectId: string, restoreId: string) => request<{ path: string }>(`/api/projects/${encodeURIComponent(projectId)}/file/restore`, { method: 'POST', body: JSON.stringify({ restoreId }) }),
  archiveInfo: (projectId: string, path: string) => request<{ name: string; files: number; bytes: number }>(`/api/projects/${encodeURIComponent(projectId)}/archive?path=${encodeURIComponent(path)}&check=1`),
  openInEditor: (projectId: string, path: string, line?: number) => request<void>(`/api/projects/${encodeURIComponent(projectId)}/open`, json('POST', { path, ...(line === undefined ? {} : { line }) })),
  revealInFinder: (projectId: string, path: string) => request<{ opened: true }>(`/api/projects/${encodeURIComponent(projectId)}/reveal`, json('POST', { path })),
  finderSupport: (projectId: string) => request<{ supported: boolean }>(`/api/projects/${encodeURIComponent(projectId)}/reveal`),
  upload: (projectId: string, body: { name: string; mimeType: string; dataBase64: string; width?: number; height?: number }, signal?: AbortSignal) => {
    // An attachment lives where it was uploaded; later reads of it go there too.
    const server = currentServer() ?? serverOfObject(projectId);
    return request<Attachment>(projectId ? `/api/projects/${encodeURIComponent(projectId)}/attachments` : '/api/attachments', { ...json('POST', body), ...(signal ? { signal } : {}) })
      .then((attachment) => { locate([attachment.id], server); return attachment; });
  },
  attachmentMetadata: (id: string, ownerId?: string) => located(id, ownerId, request<Attachment>(`${attachmentPath(id, ownerId)}/metadata`)),
  attachment: (id: string, ownerId?: string) => located(id, ownerId, request<Attachment>(attachmentPath(id, ownerId))),
  /** `fresh` reads again even when the server is following the project and knows of no change. */
  gitStatus: (projectId: string, fresh = false) => request<GitStatus>(`/api/projects/${encodeURIComponent(projectId)}/git/status${fresh ? '?fresh=true' : ''}`),
  /** `base` compares the working tree with `checkpoint:<id>` or a commit instead of what is staged. */
  gitDiff: (projectId: string, path: string, options: { staged?: boolean; base?: string; commit?: string; from?: string } = {}) => request<GitDiff>(`/api/projects/${encodeURIComponent(projectId)}/git/diff?path=${encodeURIComponent(path)}&staged=${options.staged === true}${options.base ? `&base=${encodeURIComponent(options.base)}` : ''}${options.commit ? `&commit=${encodeURIComponent(options.commit)}` : ''}${options.from ? `&from=${encodeURIComponent(options.from)}` : ''}`),
  /** A page of history, newest first; `all` walks every branch and tag. */
  gitLog: (projectId: string, options: { all?: boolean; skip?: number } = {}) => request<GitLog>(`/api/projects/${encodeURIComponent(projectId)}/git/log?all=${options.all === true}&skip=${options.skip ?? 0}`),
  gitCommit: (projectId: string, hash: string) => request<GitCommitDetail>(`/api/projects/${encodeURIComponent(projectId)}/git/commits/${encodeURIComponent(hash)}`),
  gitRefs: (projectId: string) => request<GitRefs>(`/api/projects/${encodeURIComponent(projectId)}/git/refs`),
  gitFetch: (projectId: string) => request<GitRefs>(`/api/projects/${encodeURIComponent(projectId)}/git/fetch`, json('POST')),
  /** Fast-forward only; a branch that has diverged is refused with `GIT_PULL_DIVERGED`. */
  gitPull: (projectId: string) => request<{ branch: BranchInfo; status: GitStatus }>(`/api/projects/${encodeURIComponent(projectId)}/git/pull`, json('POST')),
  /** `remote` (as in `origin/topic`) checks out a local branch tracking it; `create` cuts a new one from `base` or the current commit. */
  gitSwitch: (projectId: string, body: { branch?: string; create?: boolean; base?: string; remote?: string }) => request<GitRefs>(`/api/projects/${encodeURIComponent(projectId)}/git/switch`, json('POST', body)),
  /** What the branch changed since it left the main line. */
  gitCompare: (projectId: string) => request<WorktreeComparison>(`/api/projects/${encodeURIComponent(projectId)}/git/compare`),
  /** `permanent` accepts that a file too large to save first cannot be brought back. */
  gitDiscard: (projectId: string, paths: string[], permanent = false) => request<GitDiscardResult>(`/api/projects/${encodeURIComponent(projectId)}/git/discard`, json('POST', { paths, ...(permanent ? { permanent } : {}) })),
  gitLines: (projectId: string, body: { path: string; action: 'stage' | 'unstage' | 'discard'; changes: GitLineChange[]; version: string; base?: string }) => request<GitDiscardResult>(`/api/projects/${encodeURIComponent(projectId)}/git/lines`, json('POST', body)),
  stage: (projectId: string, paths: string[]) => request<void>(`/api/projects/${encodeURIComponent(projectId)}/git/stage`, json('POST', { paths })),
  unstage: (projectId: string, paths: string[]) => request<void>(`/api/projects/${encodeURIComponent(projectId)}/git/unstage`, json('POST', { paths })),
  commit: (projectId: string, message: string) => request<unknown>(`/api/projects/${encodeURIComponent(projectId)}/git/commit`, json('POST', { message })),
  checkpoints: (projectId: string) => request<Checkpoint[]>(`/api/projects/${encodeURIComponent(projectId)}/checkpoints`),
  createCheckpoint: (projectId: string, body: { sessionId?: string; title?: string }) => request<Checkpoint>(`/api/projects/${encodeURIComponent(projectId)}/checkpoints`, json('POST', body)),
  checkpointChanges: (projectId: string, checkpointId: string) => request<CheckpointChange[]>(`/api/projects/${encodeURIComponent(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/changes`),
  restoreCheckpoint: (projectId: string, checkpointId: string, expectedChanges: CheckpointChange[]) => request<unknown>(`/api/projects/${encodeURIComponent(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/restore`, json('POST', { expectedChanges })),
  gitBranch: (projectId: string) => request<BranchInfo>(`/api/projects/${encodeURIComponent(projectId)}/git/branch`),
  gitPush: (projectId: string, remote?: string) => request<PushResult>(`/api/projects/${encodeURIComponent(projectId)}/git/push`, json('POST', remote ? { remote } : {})),
  pullRequest: (projectId: string) => request<PullRequestStatus>(`/api/projects/${encodeURIComponent(projectId)}/git/pull-request`),
  createPullRequest: (projectId: string, body: { title?: string; body?: string; base?: string; draft?: boolean; remote?: string }) => request<PullRequestStatus>(`/api/projects/${encodeURIComponent(projectId)}/git/pull-request`, json('POST', body)),
  /** Merges a worktree project's branch back into the project it was cut from. */
  mergeWorktree: (projectId: string, body: MergeOptions) => request<MergeResult>(`/api/projects/${encodeURIComponent(projectId)}/worktree/merge`, json('POST', body)),
  sendReview: (sessionId: string, body: { commandId: string; comments: ReviewComment[]; note?: string }) => request<Run>(`/api/sessions/${encodeURIComponent(sessionId)}/review`, json('POST', body)),
  /** The checkpoints taken before each turn of this conversation, newest first. */
  sessionCheckpoints: (sessionId: string) => request<Checkpoint[]>(`/api/sessions/${encodeURIComponent(sessionId)}/checkpoints`),
  forkSession: (sessionId: string, body: LaunchIds & { runId?: string; target?: LaunchTarget; isolate?: boolean; note?: string }) => request<ForkSessionResult>(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, json('POST', body)),
  /** The Agent calls a conversation made (docs/AGENT-CALLS.md). */
  agentCalls: async (sessionId: string, signal?: AbortSignal) => (await request<{ calls: AgentCall[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/calls`, { signal })).calls,
  discussions: async (sessionId: string, signal?: AbortSignal) => (await request<Session[]>(`/api/sessions/${encodeURIComponent(sessionId)}/discussions`, { signal })).map(withShownTitle),
  discussionModels: (sessionId: string, signal?: AbortSignal) => request<{ model: string; models: import('@contracts').ModelInfo[]; providerName: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/discussions/models`, { signal }),
  createDiscussion: (sessionId: string, body: DiscussionCreateRequest) => request<NativeSessionCreateResult>(`/api/sessions/${encodeURIComponent(sessionId)}/discussions`, json('POST', body)),
  handoffSession: (sessionId: string, body: LaunchIds & { target: LaunchTarget; note?: string; text?: string }) => request<NativeSessionCreateResult>(`/api/sessions/${encodeURIComponent(sessionId)}/handoff`, json('POST', body)),
  handoffDraft: (sessionId: string, body: { target: LaunchTarget; goal?: string }, signal?: AbortSignal) => request<HandoffDraft>(`/api/sessions/${encodeURIComponent(sessionId)}/handoff/draft`, { ...json('POST', body), signal }),
  attemptGroups: (projectId: string) => request<AttemptGroup[]>(`/api/projects/${encodeURIComponent(projectId)}/attempts`),
  createAttempts: (projectId: string, body: { prompt: string; targets: LaunchTarget[]; base?: string; requestId?: string; attachments?: Attachment[]; context?: PromptContextReference[] }) => request<{ group: AttemptGroup; warnings: string[] }>(`/api/projects/${encodeURIComponent(projectId)}/attempts`, json('POST', body)),
  compareAttempts: (groupId: string) => request<{ group: AttemptGroup; attempts: AttemptComparison[] }>(`/api/attempts/${encodeURIComponent(groupId)}`),
  adoptAttempt: (groupId: string, body: MergeOptions & { sessionId: string }) => request<{ group: AttemptGroup; merge: MergeResult; warnings: string[] }>(`/api/attempts/${encodeURIComponent(groupId)}/adopt`, json('POST', body)),
  addAttempt: (groupId: string, target: LaunchTarget) => request<{ group: AttemptGroup }>(`/api/attempts/${encodeURIComponent(groupId)}/attempts`, json('POST', { target })),
  discardAttempt: (groupId: string, sessionId: string, removeWorktree = false) => request<{ group: AttemptGroup; warnings: string[] }>(`/api/attempts/${encodeURIComponent(groupId)}/discard`, json('POST', { sessionId, removeWorktree })),
  automations: () => request<Automation[]>('/api/automations'),
  createAutomation: (body: AutomationInput) => request<Automation>('/api/automations', json('POST', body)),
  updateAutomation: (id: string, body: Partial<AutomationInput>) => request<Automation>(`/api/automations/${encodeURIComponent(id)}`, json('PATCH', body)),
  deleteAutomation: (id: string) => request<void>(`/api/automations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  runAutomation: (id: string, body: Partial<LaunchIds> & { projectId?: string } = {}) => request<AutomationRun>(`/api/automations/${encodeURIComponent(id)}/run`, json('POST', body)),
  automationRuns: (limit = 20) => request<AutomationRun[]>(`/api/automation-runs?limit=${limit}`),
  worktrees: (projectId: string) => request<WorktreeInfo[]>(`/api/projects/${encodeURIComponent(projectId)}/worktrees`),
  createWorktree: (projectId: string, body: { branch: string; path?: string; base?: string }) => request<WorktreeInfo>(`/api/projects/${encodeURIComponent(projectId)}/worktrees`, json('POST', body)),
  removeWorktree: (projectId: string, path: string) => request<void>(`/api/projects/${encodeURIComponent(projectId)}/worktrees`, json('DELETE', { path })),
  /** Gives a worktree a project so conversations can run in it. Omit `path` to cut a fresh one. */
  createWorktreeProject: (projectId: string, body: { name?: string; path?: string; branch?: string; base?: string } = {}) =>
    request<ProjectRecord>(`/api/projects/${encodeURIComponent(projectId)}/worktree-projects`, json('POST', body)),
  machine: () => request<MachineReport>('/api/system/machine'),
  backends: (recheckMissing = false) => request<NativeBackendCatalogEntry[]>(recheckMissing ? '/api/backends?recheckMissing=1' : '/api/backends'),
  commandObservation: (id: NativeBackendId, signal?: AbortSignal) => request<CommandObservation>(`/api/backends/${encodeURIComponent(id)}/command-observation`, { signal }),
  trustCommandObservation: (id: NativeBackendId) => request<CommandObservation>(`/api/backends/${encodeURIComponent(id)}/command-observation/trust`, { method: 'POST' }),
  backendProfiles: (id: NativeBackendId, signal?: AbortSignal) => request<NativeBackendProfilesResponse>(`/api/backends/${id}/profiles`, { signal }),
  createBackendProfile: async (id: NativeBackendId, body: NativeBackendProfileSettingsUpdate): Promise<NativeBackendProfileSettings> => {
    const profileId = newId();
    const result = await request<NativeBackendProfilesResponse>(`/api/backends/${id}/profiles`, json('POST', { ...body, id: profileId }));
    const saved = result.profiles.find((profile) => profile.id === profileId);
    if (!saved) throw new Error(i18n._(msg`配置已提交，但无法确认保存结果`));
    return saved;
  },
  updateBackendProfile: async (id: NativeBackendId, profileId: string, body: NativeBackendProfileSettingsUpdate): Promise<NativeBackendProfileSettings> => {
    const result = await request<NativeBackendProfilesResponse>(`/api/backends/${id}/profiles/${encodeURIComponent(profileId)}`, json('PATCH', body));
    const saved = result.profiles.find((profile) => profile.id === profileId);
    if (!saved) throw new Error(i18n._(msg`配置已提交，但无法确认保存结果`));
    return saved;
  },
  deleteBackendProfile: (id: NativeBackendId, profileId: string) =>
    request<NativeBackendProfilesResponse>(`/api/backends/${id}/profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' }),
  /**
   * Asks a gateway what it serves using unsaved form values. Nothing is persisted.
   *
   * `apiEndpoint` is required only for a manual gateway: a named source carries its own address.
   */
  probeBackendModels: (id: NativeBackendId, body: { apiEndpoint?: string; apiKey?: string; profileId?: string; modelSource?: NativeModelSource; apiProtocol?: NativeModelApiProtocol }, signal?: AbortSignal) =>
    request<{ models: ModelInfo[] }>(`/api/backends/${id}/model-probe`, { ...json('POST', body), signal }),
  /** Built-in plugins in precedence order (docs/PLUGIN_ARCHITECTURE.md), as last detected. */
  pluginLogs: (id: string, signal?: AbortSignal) => request<{ logs: import('@contracts').PluginLogEntry[] }>('/api/integrations/' + encodeURIComponent(id) + '/logs', { signal }),
  activatePluginView: (id: string, view: string, signal?: AbortSignal) => request<PluginDescriptor>('/api/integrations/' + encodeURIComponent(id) + '/activate', { ...json('POST', { kind: 'view', id: view }), signal }),
  pluginDiagnostics: (id: string) => request<import('@contracts').PluginDiagnostic[]>('/api/integrations/' + encodeURIComponent(id) + '/diagnostics', json('POST', {})),
  reloadPlugin: (id: string) => request<PluginDescriptor>('/api/integrations/' + encodeURIComponent(id) + '/reload', json('POST', {})),
  setPluginRecovery: (enabled: boolean) => request<PluginsResponse>('/api/integrations/recovery', json('POST', { enabled })),
  plugins: (signal?: AbortSignal) => request<PluginsResponse>('/api/integrations', { signal }),
  /** Detects again, then lists. Only the plugins settings page asks for this. */
  refreshPlugins: (signal?: AbortSignal) => request<PluginsResponse>('/api/integrations/refresh', { ...json('POST', {}), signal }),
  /** Where new shares go; `null` leaves it to the first enabled publisher. */
  setPluginDefaults: (update: PluginDefaultsUpdate) => request<PluginsResponse>('/api/integrations', json('PATCH', update)),
  updatePlugin: (id: string, update: PluginUpdate) => request<PluginDescriptor>(`/api/integrations/${encodeURIComponent(id)}`, json('PATCH', update)),
  /** The plugin's own page (docs/PLUGIN_ARCHITECTURE.md「插件页」), in `locale`. */
  pluginPage: (id: string, locale: string, signal?: AbortSignal) =>
    request<import('@contracts').PluginPageResponse>(`/api/integrations/${encodeURIComponent(id)}/page?locale=${encodeURIComponent(locale)}&${PAGE_KINDS}`, { signal }),
  changePluginPage: (id: string, change: import('@contracts').PluginPageChange) =>
    request<import('@contracts').PluginPageResponse>(`/api/integrations/${encodeURIComponent(id)}/page?${PAGE_KINDS}`, json('POST', change)),
  pluginReadme: (id: string, locale: string, signal?: AbortSignal) =>
    request<import('@contracts').PluginReadmeResponse>(`/api/integrations/${encodeURIComponent(id)}/readme?locale=${encodeURIComponent(locale)}`, { signal }),
  /** A device flow answers `show-code`; its device code stays on the server behind `flowId`. */
  runPluginAction: (id: string, action: string, signal?: AbortSignal) =>
    request<ActionStep>(`/api/integrations/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`, { ...json('POST', {}), signal }),
  pollPluginFlow: (id: string, flowId: string, signal?: AbortSignal) =>
    request<ActionStep>(`/api/integrations/${encodeURIComponent(id)}/flows/${encodeURIComponent(flowId)}/poll`, { ...json('POST', {}), signal }),
  /** Grants and execution trust are explicitly confirmed per version; trusted uploads require a local request. */
  installPlugin: (file: File, grant: string[] = [], trusted = false) => {
    const body = new FormData();
    body.set('package', file);
    body.set('grant', JSON.stringify(grant));
    if (trusted) body.set('trusted', 'true');
    return request<PluginDescriptor>('/api/integrations/install', { method: 'POST', body });
  },
  /** The plugin index as the server reads it (docs/PLUGINS.md「插件市场」); `refresh` skips its cache. */
  marketPlugins: (refresh = false) => request<PluginMarketList>(`/api/integrations/market${refresh ? '?refresh=1' : ''}`),
  installMarketPlugin: (source: string, id: string, version: string, grant: string[], trusted = false) =>
    request<PluginDescriptor>('/api/integrations/install', json('POST', { market: { source, id, version }, grant, ...(trusted ? { trusted: true } : {}) })),
  addPluginSource: (url: string) => request<PluginMarketList>('/api/integrations/sources', json('POST', { url })),
  setPluginSourceEnabled: (id: string, enabled: boolean) => request<PluginMarketList>(`/api/integrations/sources/${encodeURIComponent(id)}`, json('PATCH', { enabled })),
  removePluginSource: (id: string) => request<PluginMarketList>(`/api/integrations/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  selectPluginVersion: (id: string, version: string) =>
    request<PluginDescriptor>(`/api/integrations/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/select`, json('POST', {})),
  uninstallPluginVersion: (id: string, version: string) =>
    request<PluginsResponse>(`/api/integrations/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`, json('DELETE')),
  /** Removes an installed package or development registration while preserving settings, data and development sources. */
  uninstallPlugin: (id: string, source?: 'installed' | 'development', path?: string) => {
    const query = new URLSearchParams();
    if (source) query.set('source', source);
    if (path) query.set('path', path);
    return request<PluginsResponse>(`/api/integrations/${encodeURIComponent(id)}${query.size ? `?${query}` : ''}`, json('DELETE'));
  },
  unlinkDevelopmentPlugin: (id: string) => request<PluginsResponse>(`/api/integrations/development/${encodeURIComponent(id)}`, json('DELETE')),
  /** Irreversible: removes the plugin's data directory and its backups. */
  deletePluginData: (id: string) => request<PluginsResponse>(`/api/integrations/${encodeURIComponent(id)}/data`, json('DELETE')),
  /** `allModels` bypasses the profile's curated list; only the settings page needs it. */
  backendCatalog: (backendId: NativeBackendId, profileId?: string, projectId?: string, signal?: AbortSignal, allModels?: boolean) => {
    const query = new URLSearchParams();
    if (profileId) query.set('profileId', profileId);
    if (projectId) query.set('projectId', projectId);
    else query.set('scope', 'global');
    if (allModels) query.set('allModels', '1');
    return request<NativeBackendCatalogEntry>(`/api/backends/${encodeURIComponent(backendId)}/catalog?${query}`, { signal });
  },
  sessionCatalog: (id: string, signal?: AbortSignal) => request<NativeBackendCatalogEntry>(`/api/sessions/${encodeURIComponent(id)}/native/catalog`, { signal }),
  /** Devices that have paired with this server; only those with a `platform` have ever reported themselves. */
  /** `currentId` is this browser's own record, when it paired rather than signed in with the access token. */
  devices: (signal?: AbortSignal) => request<{ devices: DeviceInfo[]; currentId?: string }>('/api/devices', { signal }),
  /** The device must pair again to come back. */
  revokeDevice: (id: string) => request<void>(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Servers linked with this one (docs/SERVER-LINKS.md). */
  /** This server first, then the servers linked with it (`server-links-v1`). */
  servers: (signal?: AbortSignal) => request<{ servers: ServerInfo[] }>('/api/servers', { signal: signal ?? timeout() }),
  links: (signal?: AbortSignal) => request<{ links: LinkInfo[]; self?: LinkSelfInfo }>('/api/links', { signal }),
  updateSelfLinkName: (name: string) => request<{ self: LinkSelfInfo }>('/api/links/self', json('PATCH', { name })),
  createLinkInvite: (input: LinkInviteRequest) => request<LinkInviteResult>('/api/links/invites', json('POST', input)),
  joinLink: (input: LinkJoinRequest) => request<{ link: LinkInfo }>('/api/links/join', json('POST', input)),
  /** Updates a link's inbound permission or local display name / alias / note. */
  updateLink: (serverId: string, change: LinkUpdateRequest) => request<{ link: LinkInfo }>(`/api/links/${encodeURIComponent(serverId)}`, json('PATCH', change)),
  /** Ends the link on both servers. */
  removeLink: (serverId: string) => request<{ removed: true }>(`/api/links/${encodeURIComponent(serverId)}`, { method: 'DELETE' }),
  linkAudit: (serverId: string, signal?: AbortSignal) => request<{ entries: LinkAuditEntry[] }>(`/api/links/${encodeURIComponent(serverId)}/audit`, { signal }),
  /** The security record (docs/TRANSPORT-SECURITY.md §7), newest first. */
  securityEvents: (signal?: AbortSignal) => request<SecurityEventsResponse>('/api/security/events', { signal }),
  /** The APNs key this server pushes to iPhones with; the key text is accepted, never returned. */
  pushKey: (signal?: AbortSignal) => request<PushKeyStatus>('/api/settings/push', { signal }),
  savePushKey: (input: PushKeyInput) => request<PushKeyStatus>('/api/settings/push', json('PUT', input)),
  removePushKey: () => request<PushKeyStatus>('/api/settings/push', { method: 'DELETE' }),
  channels: (signal?: AbortSignal) => request<ChannelsState>('/api/channels', { signal }),
  createChannelAccount: (input: ChannelAccountInput) => request<ChannelAccountInfo>('/api/channels/accounts', { method: 'POST', body: JSON.stringify(input) }),
  /** Omitting `appSecret` keeps the stored one. */
  updateChannelAccount: (id: string, input: Partial<ChannelAccountInput>) => request<ChannelAccountInfo>(`/api/channels/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteChannelAccount: (id: string) => request<{ ok: true }>(`/api/channels/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  channelBindCode: (accountId: string) => request<ChannelBindCode>(`/api/channels/accounts/${encodeURIComponent(accountId)}/bind-code`, { method: 'POST' }),
  deleteChannelIdentity: (id: string) => request<{ ok: true }>(`/api/channels/identities/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  updateChannelChat: (key: string, patch: { projectId?: string | null; flat?: boolean }) => request<ChannelChat>(`/api/channels/chats/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  /** `refresh` skips the server's cached checks. */
  channelHealth: (accountId: string, refresh = false, signal?: AbortSignal) => request<ChannelHealth>(`/api/channels/accounts/${encodeURIComponent(accountId)}/health${refresh ? '?refresh=1' : ''}`, { signal }),
  createChannelRegistration: (input: ChannelRegistrationInput) => request<ChannelRegistration>('/api/channels/registrations', { method: 'POST', body: JSON.stringify(input) }),
  channelRegistration: (id: string, signal?: AbortSignal) => request<ChannelRegistrationState>(`/api/channels/registrations/${encodeURIComponent(id)}`, { signal }),
  deleteChannelRegistration: (id: string) => request<{ ok: true }>(`/api/channels/registrations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Forgets the chat and its conversation bindings. */
  deleteChannelChat: (key: string) => request<{ ok: true }>(`/api/channels/chats/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  /** Account quota and per-model load, read live; a session pins the profile and project it runs on. */
  backendUsage: (backendId: NativeBackendId, scope: { projectId?: string; profileId?: string; sessionId?: string; scope?: 'global'; refresh?: boolean }, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(scope)) {
      if (key === 'refresh') { if (value === true) query.set('refresh', '1'); }
      else if (typeof value === 'string' && value) query.set(key, value);
    }
    return request<NativeBackendUsage>(`/api/backends/${encodeURIComponent(backendId)}/usage?${query}`, { signal });
  },
  /** Built-in commands plus the skills the backend discovers in the project, for the `/` menu. */
  slashCatalog: (backendId: NativeBackendId, scope: { projectId?: string; profileId?: string; sessionId?: string; scope?: 'global' }, options: { refresh?: boolean; signal?: AbortSignal } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(scope)) if (value) query.set(key, value);
    if (options.refresh) query.set('refresh', '1');
    return request<NativeSlashCatalog>(`/api/backends/${encodeURIComponent(backendId)}/slash?${query}`, { signal: options.signal });
  },
  /** The MCP servers and skills a launch of this backend profile in the project loads; probes the CLI, so it can take seconds. */
  loadedExtensions: (backendId: NativeBackendId, profileId: string | undefined, projectId: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ projectId });
    if (profileId) query.set('profileId', profileId);
    return request<LoadedExtensions>(`/api/backends/${encodeURIComponent(backendId)}/loaded-extensions?${query}`, { signal });
  },
  extensionCapabilities: (scope: ExtensionContext, signal?: AbortSignal) => request<ExtensionManagementCapabilities>(extensionUrl(scope, '/capabilities'), { signal }),
  extensionRuntime: (scope: ExtensionContext, signal?: AbortSignal) => request<ExtensionRuntimeReport>(extensionUrl(scope, '/runtime'), { signal }),
  extensionAction: (scope: ExtensionContext, body: ExtensionActionRequest) => request<ExtensionActionResult>(extensionUrl(scope, '/actions'), json('POST', body)),
  riffetExtensions: (signal?: AbortSignal) => request<{ items: Array<ExtensionInventory['items'][number] & { activation?: 'auto' | 'opt-in' | 'assistant' | 'task' | 'pack' | 'readonly' }>; diagnostics: string[]; checkedAt: string }>('/api/extensions/riffet', { signal }),
  riffetExtension: (id: string, signal?: AbortSignal) => request<ExtensionDetail>(`/api/extensions/riffet/${encodeURIComponent(id)}`, { signal }),
  riffetExtensionDocument: (id: string, signal?: AbortSignal) => request<ExtensionDocument>(`/api/extensions/riffet/documents/${encodeURIComponent(id)}`, { signal }),
  extensions: (scope: ExtensionContext, signal?: AbortSignal) => request<ExtensionInventory>(extensionUrl(scope), { signal }),
  extension: (scope: ExtensionContext, id: string, signal?: AbortSignal) => request<ExtensionDetail>(extensionUrl(scope, `/${encodeURIComponent(id)}`), { signal }),
  extensionDocument: (scope: ExtensionContext, id: string, signal?: AbortSignal) => request<ExtensionDocument>(extensionUrl(scope, `/documents/${encodeURIComponent(id)}`), { signal }),
  saveExtensionDocument: (scope: ExtensionContext, id: string, content: string, expectedHash: string) => request<ExtensionDocument>(extensionUrl(scope, `/documents/${encodeURIComponent(id)}`), json('PUT', { content, expectedHash })),
  createExtensionDocument: (scope: ExtensionContext, body: { targetId: string; path: string; content: string }) => request<ExtensionDocument>(extensionUrl(scope, '/documents'), json('POST', body)),
  configs: (projectId: string) => request<ConfigFile[]>(`/api/projects/${encodeURIComponent(projectId)}/configs`),
  createConfig: (projectId: string, body: { kind: 'rules' | 'skills' | 'commands'; path: string; content: string }) => request<ConfigFile>(`/api/projects/${encodeURIComponent(projectId)}/configs`, json('POST', body)),
  config: (projectId: string, configId: string) => request<ConfigFile>(`/api/projects/${encodeURIComponent(projectId)}/configs/${encodeURIComponent(configId)}`),
  saveConfig: (projectId: string, configId: string, content: string, expectedHash: string) => request<ConfigFile>(`/api/projects/${encodeURIComponent(projectId)}/configs/${encodeURIComponent(configId)}`, json('PUT', { content, expectedHash })),
  owner: () => request<OwnerInfo>('/api/owner'),
  updateOwner: (body: OwnerUpdate) => request<OwnerInfo>('/api/owner', json('PATCH', body)),
  uploadOwnerAvatar: (body: OwnerAvatarUpload) => request<OwnerInfo>('/api/owner/avatar', json('PUT', body)),
  ownerAvatarStyles: () => request<{ styles: OwnerAvatarStyle[] }>('/api/owner/avatar-styles'),
  generateOwnerAvatar: (body: OwnerAvatarGenerateRequest) => request<OwnerInfo>('/api/owner/avatar/generate', json('POST', body)),
  removeOwnerAvatar: () => request<OwnerInfo>('/api/owner/avatar', { method: 'DELETE' }),
  restoreOwnerAvatar: (sha256: string) => request<OwnerInfo>('/api/owner/avatar/restore', json('POST', { sha256 })),
  deleteOwnerAvatarHistory: (sha256: string) => request<OwnerInfo>(`/api/owner/avatar/history/${encodeURIComponent(sha256)}`, { method: 'DELETE' }),
  settings: () => request<AppSettings>('/api/settings'),
  updateSettings: (body: AppSettingsUpdate) => request<AppSettings>('/api/settings', json('PATCH', body)),
  /** The shared custom-theme library, not this device's selection. */
  themes: () => request<ThemeLibrary>(API.themes),
  updateThemes: (body: ThemeLibraryUpdate) => request<ThemeLibrary>(API.themes, json('PUT', body)),
  /** What the enabled plugins contribute to appearance; the device's selection is local. */
  appearance: () => request<AppearanceCatalog>('/api/appearance'),
  auxiliaryModels: (signal?: AbortSignal) => request<{ models: AuxiliaryModelOption[] }>('/api/auxiliary-models', { signal }),
  inspectAuxiliaryModels: (signal?: AbortSignal) => request<AuxiliaryInspectResponse>('/api/auxiliary-models/inspect', { signal }),
  probeAuxiliaryModel: (body: AuxiliaryModelRef & { preset: ModelProbePreset }, signal?: AbortSignal) => request<ModelProbeResult>('/api/auxiliary-models/probe', { ...json('POST', body), signal }),
  modelLeaderboard: (params: { category: ModelLeaderboardCategory; source?: ModelLeaderboardSource; days?: number }, signal?: AbortSignal) => {
    const query = new URLSearchParams({ category: params.category });
    if (params.source) query.set('source', params.source);
    if (params.days !== undefined) query.set('days', String(params.days));
    return request<ModelLeaderboardResponse>(`/api/stats/leaderboard?${query}`, { signal });
  },
  /** Runs one auxiliary job without saving settings or creating a session. */
  previewAuxiliaryModel: (body: AuxiliaryModelRef & { purpose: AuxiliaryModelPurpose; message: string }, signal?: AbortSignal) => request<{ text: string }>('/api/auxiliary-models/preview', { ...json('POST', body), signal }),
  previewAuxiliaryModelStream: async (
    body: AuxiliaryModelRef & { purpose: AuxiliaryModelPurpose; message: string },
    options: { onDelta(delta: string): void; signal?: AbortSignal },
  ): Promise<{ text: string }> => {
    const init = json('POST', body);
    const headers = new Headers(init.headers);
    headers.set('Accept', 'text/event-stream, application/json');
    const response = await requestResponse('/api/auxiliary-models/preview', { ...init, headers, ...(options.signal ? { signal: options.signal } : {}) });
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      return await response.json() as { text: string };
    }
    let result: { text: string } | undefined;
    let streamError: HttpError | undefined;
    await readSseStream(response, (event, data) => {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(data) as Record<string, unknown>; } catch { return; }
      if (event === 'delta' && typeof parsed.delta === 'string') {
        options.onDelta(parsed.delta);
      } else if (event === 'result' && typeof parsed.text === 'string') {
        result = { text: parsed.text };
      } else if (event === 'error') {
        const err = parsed.error as { code?: string; message?: string; details?: unknown; params?: Record<string, string | number> } | undefined;
        const status = typeof parsed.status === 'number' ? parsed.status : 400;
        streamError = new HttpError(status, err?.message ?? 'Auxiliary model failed', err?.code, err?.details, err?.params);
      }
    });
    if (streamError) throw streamError;
    if (!result) throw new HttpError(502, 'Auxiliary preview stream ended without a result');
    return result;
  },
  backup: () => request<unknown>('/api/system/backup', json('POST')),
  serviceMonitor: (signal?: AbortSignal) => request<ServiceMonitorSnapshot>('/api/system/monitor', { signal }),
  storage: (signal?: AbortSignal) => request<StorageReport>('/api/system/storage', { signal }),
  scanStorage: () => request<StorageReport>('/api/system/storage/scan', json('POST')),
  maintainStorage: () => request<StorageReport>('/api/system/storage/maintain', json('POST')),
  scheduleCompaction: (scheduled: boolean) => request<StorageReport>('/api/system/storage/compaction', json('PUT', { scheduled })),
  /** SIGTERM to a process in the service's own tree; the server refuses anything without `canTerminate`. */
  terminateServiceProcess: (pid: number) => request<{ ok: true }>(`/api/system/processes/${pid}/terminate`, json('POST')),
  /** 收藏, newest first. Read conditionally: a list push re-reads it, and an unchanged one costs a 304. */
  marks: (query: MarkListQuery, etag?: string, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
      else if (value !== undefined && value !== '') params.set(key, String(value));
    }
    return requestList<MarkListPage>(`${API.marks}?${params}`, etag, signal);
  },
  markFacets: (etag?: string, signal?: AbortSignal) => requestList<MarkFacets>(`${API.marks}/facets`, etag, signal),
  /** 任务 (docs/TASK-BOARD.md). Read conditionally under the work items revision, like 收藏. */
  workItems: (etag?: string, signal?: AbortSignal) => requestList<WorkItemList>('/api/work-items', etag, signal),
  /** What plugins ask the owner to approve (docs/TASK-BOARD.md §7); deciding runs the plugin's write. */
  pluginApprovals: (signal?: AbortSignal) => request<PluginApprovalList>('/api/plugin-approvals', { signal }),
  decidePluginApproval: (pluginId: string, id: string, body: PluginApprovalDecision) => request<PluginApprovalResult>(`/api/plugin-approvals/${encodeURIComponent(pluginId)}/${encodeURIComponent(id)}/decide`, json('POST', body)),
  /** Explicit messages sent to the owner's Inbox (e.g. from team members via `notify_user`). */
  inboxNotices: (signal?: AbortSignal) => request<InboxNoticeList>('/api/inbox/notices', { signal }),
  markInboxNoticeRead: (id: string) => request<{ notice: RiffetNotice }>(`/api/inbox/notices/${encodeURIComponent(id)}/read`, { method: 'POST' }),
  markAllInboxNoticesRead: () => request<{ count: number }>('/api/inbox/notices/read-all', { method: 'POST' }),
  deleteInboxNotice: (id: string) => request<{ ok: true }>(`/api/inbox/notices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Idempotent on the client-generated `id`. */
  createWorkItem: (body: WorkItemCreate) => request<WorkItem>('/api/work-items', json('POST', body)),
  updateWorkItem: (id: string, body: WorkItemPatch) => request<WorkItem>(`/api/work-items/${encodeURIComponent(id)}`, json('PATCH', body)),
  deleteWorkItem: (id: string) => request<void>(`/api/work-items/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  workItemEvents: (id: string, signal?: AbortSignal) => request<WorkItemEvent[]>(`/api/work-items/${encodeURIComponent(id)}/events`, { signal }),
  northStar: (params: { from: string; to: string; tz: string }, signal?: AbortSignal) => request<NorthStarReport>(`/api/work-items/north-star?${new URLSearchParams(params)}`, { signal }),
  workItemBrief: (id: string) => request<WorkItemBrief>(`/api/work-items/${encodeURIComponent(id)}/brief`),
  /** 开始 done by the server; the 助理's planned tasks start this way. */
  assistantInstructions: () => request<AssistantInstructions>('/api/assistant/instructions'),
  assistantMemory: () => request<AssistantMemory>('/api/assistant/memory'),
  forgetAssistantMemory: (name: string) => request<void>(`/api/assistant/memory/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  assistantFiles: () => request<{ files: AssistantFile[] }>('/api/assistant/files'),
  /** A download link: the browser sends the session cookie itself. */
  assistantFileUrl: (path: string) => `/api/assistant/file?${new URLSearchParams({ path })}`,
  assistantDelegations: () => request<{ delegations: AssistantDelegation[] }>('/api/assistant/delegations'),
  assistantRunUsage: () => request<AssistantRunUsage>('/api/assistant/runs/usage'),
  assistantRuns: (limit = 20) => request<{ runs: AssistantRunSummary[] }>(`/api/assistant/runs?limit=${encodeURIComponent(String(limit))}`),
  assistantPacks: () => request<{ packs: AssistantPack[] }>('/api/assistant/packs'),
  addAssistantPack: (id: string) => request<{ packs: AssistantPack[] }>(`/api/assistant/packs/${encodeURIComponent(id)}`, { method: 'PUT' }),
  removeAssistantPack: (id: string) => request<{ packs: AssistantPack[] }>(`/api/assistant/packs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  endAssistantDelegation: (id: string) => request<AssistantDelegation>(`/api/assistant/delegations/${encodeURIComponent(id)}/end`, json('POST', {})),
  watchWorkItemDelegation: (id: string, body: { goal?: string; attention: string; trigger: AssistantDelegationTrigger; until?: string; note?: string }) =>
    request<{ item: WorkItem; delegation: AssistantDelegation }>(`/api/work-items/${encodeURIComponent(id)}/watch-delegation`, json('POST', body)),
  /** `null` restores Riffet's own text. */
  saveAssistantInstructions: (text: string | null) => request<AssistantInstructions>('/api/assistant/instructions', json('PUT', { text })),
  teamMembers: () => request<AgentMemberList>('/api/team/members'),
  createTeamMember: (body: AgentMemberCreate) => request<AgentMember>('/api/team/members', json('POST', body)),
  updateTeamMember: (id: string, body: AgentMemberUpdate) => request<AgentMember>(`/api/team/members/${encodeURIComponent(id)}`, json('PATCH', body)),
  deleteTeamMember: (id: string) => request<void>(`/api/team/members/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  teamUserProfile: () => request<AgentMemberUserProfile>('/api/team/user-profile'),
  saveTeamUserProfile: (text: string) => request<AgentMemberUserProfile>('/api/team/user-profile', json('PUT', { text })),
  teamMemberInstructions: (id: string) => request<AssistantInstructions>(`/api/team/members/${encodeURIComponent(id)}/instructions`),
  saveTeamMemberInstructions: (id: string, text: string | null) => request<AssistantInstructions>(`/api/team/members/${encodeURIComponent(id)}/instructions`, json('PUT', { text })),
  teamMemberMemory: (id: string) => request<AssistantMemory>(`/api/team/members/${encodeURIComponent(id)}/memory`),
  forgetTeamMemberMemory: (id: string, name: string) => request<void>(`/api/team/members/${encodeURIComponent(id)}/memory/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  teamMemberFiles: (id: string) => request<{ files: AssistantFile[] }>(`/api/team/members/${encodeURIComponent(id)}/files`),
  teamMemberFileUrl: (id: string, path: string) => `/api/team/members/${encodeURIComponent(id)}/file?${new URLSearchParams({ path })}`,
  teamMemberSessions: (id: string) => request<{ sessions: Session[] }>(`/api/team/members/${encodeURIComponent(id)}/sessions`),
  teamMemberDelegations: (id: string) => request<{ delegations: AssistantDelegation[] }>(`/api/team/members/${encodeURIComponent(id)}/delegations`),
  teamMemberRuns: (id: string, limit = 20) => request<{ runs: AssistantRunSummary[] }>(`/api/team/members/${encodeURIComponent(id)}/runs?limit=${encodeURIComponent(String(limit))}`),
  startWorkItem: (id: string) => request<WorkItemStartResult>(`/api/work-items/${encodeURIComponent(id)}/start`, json('POST', {})),
  answerWorkItem: (id: string, questionId: string, body: WorkItemAnswer) => request<WorkItem>(`/api/work-items/${encodeURIComponent(id)}/questions/${encodeURIComponent(questionId)}/answer`, json('POST', body)),
  reworkWorkItem: (id: string, body: WorkItemRework) => request<WorkItem>(`/api/work-items/${encodeURIComponent(id)}/rework`, json('POST', body)),
  commentWorkItem: (id: string, body: { id: string; text: string }) => request<WorkItemEvent>(`/api/work-items/${encodeURIComponent(id)}/comments`, json('POST', body)),
  setSessionWorkItem: (sessionId: string, body: SessionWorkItemRequest) => request<{ session: Session; workItem?: WorkItem }>(`/api/sessions/${encodeURIComponent(sessionId)}/work-item`, json('POST', body)),
  /** Idempotent on the client-generated `id`; the same message again answers with the existing mark. */
  createMark: (body: MarkCreateRequest) => request<Mark>(API.marks, json('POST', body)),
  updateMark: (id: string, body: MarkUpdateRequest) => request<Mark>(`${API.marks}/${encodeURIComponent(id)}`, json('PATCH', body)),
  /** `keepalive` lets a delete sent while the page unloads outlive it. */
  deleteMarks: (ids: string[], { keepalive = false }: { keepalive?: boolean } = {}) => ids.length === 1
    ? request<void>(`${API.marks}/${encodeURIComponent(ids[0]!)}`, { method: 'DELETE', keepalive })
    : request<void>(`${API.marks}/delete`, { ...json('POST', { ids }), keepalive }),
  locateMark: (id: string) => request<MarkLocation>(`${API.marks}/${encodeURIComponent(id)}/locate`),
  markPrompt: (id: string) => request<MarkPrompt>(`${API.marks}/${encodeURIComponent(id)}/prompt`),
  statsDashboard: (query: string, signal?: AbortSignal) => request<StatsDashboard>(`${API.stats}/dashboard?${query}`, { signal }),
  statsSeries: (query: string, metric: StatsSeriesMetric, granularity: StatsGranularity, split: StatsSplit, signal?: AbortSignal) => {
    const params = new URLSearchParams(query);
    params.set('metric', metric);
    params.set('granularity', granularity);
    params.set('split', split);
    return request<StatsSeries>(`${API.stats}/series?${params}`, { signal });
  },
  statsLatency: (query: string, dimension: 'model' | 'backend', signal?: AbortSignal) => {
    const params = new URLSearchParams(query);
    params.set('dimension', dimension);
    return request<StatsLatency>(`${API.stats}/latency?${params}`, { signal });
  },
  statsRuns: (query: string, cursor: string | undefined, limit: number, signal?: AbortSignal) => {
    const params = new URLSearchParams(query);
    if (cursor) params.set('cursor', cursor);
    params.set('limit', String(limit));
    return request<StatsRunsPage>(`${API.stats}/runs?${params}`, { signal });
  },

  councilList: (signal?: AbortSignal) => request<{ items: CouncilSummary[] }>('/api/council', { signal }),
  councilGet: (id: string, signal?: AbortSignal) => request<CouncilDiscussion>(`/api/council/${encodeURIComponent(id)}`, { signal }),
  councilCreate: (body: CouncilCreateRequest) => request<CouncilDiscussion>('/api/council', { method: 'POST', body: JSON.stringify(body) }),
  councilPatch: (id: string, body: CouncilPatchRequest) => request<CouncilDiscussion>(`/api/council/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  councilContinue: (id: string, body?: CouncilContinueRequest) => request<CouncilDiscussion>(`/api/council/${encodeURIComponent(id)}/continue`, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  councilSupplement: (id: string, body: CouncilSupplementRequest) => request<CouncilDiscussion>(`/api/council/${encodeURIComponent(id)}/supplement`, { method: 'POST', body: JSON.stringify(body) }),
  councilStop: (id: string) => request<CouncilDiscussion>(`/api/council/${encodeURIComponent(id)}/stop`, { method: 'POST', body: '{}' }),
  councilDelete: (id: string) => request<void>(`/api/council/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  councilAgents: (signal?: AbortSignal) => request<NativeBackendCatalogEntry[]>('/api/council/agents', { signal }),
  councilPrompts: (id: string, seatId: string, speechId: string | undefined, signal?: AbortSignal) => {
    const query = speechId ? `?speechId=${encodeURIComponent(speechId)}` : '';
    return request<CouncilPrompts>(`/api/council/${encodeURIComponent(id)}/seats/${encodeURIComponent(seatId)}/prompts${query}`, { signal });
  },
  councilSpeechRows: (id: string, speechId: string, signal?: AbortSignal) => request<CouncilSpeechRows>(`/api/council/${encodeURIComponent(id)}/speeches/${encodeURIComponent(speechId)}/rows`, { signal }),
  councilExport: (id: string, body: CouncilExportRequest) => request<CouncilExportResult>(`/api/council/${encodeURIComponent(id)}/export`, { method: 'POST', body: JSON.stringify(body) }),
};

/** `GET /api/stats/export`. The body is a file, so this does not go through `request()`. */
export async function exportStats(query: string, format: 'csv' | 'json'): Promise<void> {
  const params = new URLSearchParams(query);
  params.set('format', format);
  const response = await fetch(`${API.stats}/export?${params}`, { credentials: 'same-origin', headers: { [CLIENT_FEATURES_HEADER]: CLIENT_FEATURES } });
  if (!response.ok) {
    let message = i18n._(msg`导出失败`);
    try {
      const payload = await response.json() as { error?: { message?: string } };
      if (payload.error?.message) message = payload.error.message;
    } catch { /* a non-JSON error body still fails the export */ }
    throw new Error(message);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const named = /filename="?([^"]+)"?/.exec(response.headers.get('content-disposition') ?? '')?.[1];
  link.href = url;
  link.download = named || `riffet-stats.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function statsStreamUrl(): string {
  return withClientFeatures(`${API.stats}/stream`);
}

export function councilStreamUrl(id: string): string {
  return withClientFeatures(`/api/council/${encodeURIComponent(id)}/stream`);
}

/** The lists stream of `serverId`, or of the entry server. */
export function listsStreamUrl(serverId?: string): string {
  return withClientFeatures(serverPath('/api/lists/stream', serverId));
}

/**
 * An attachment's address. Attachment ids are not in the lists, so one this browser did not upload is found through
 * the conversation or project it belongs to (`ownerId`).
 */
export function attachmentPath(id: string, ownerId?: string): string {
  return serverPath(`/api/attachments/${encodeURIComponent(id)}`, serverOfObject(id) ?? serverOfObject(ownerId));
}

/** Remembers where an attachment found through its owner lives, for the image loads that follow without one. */
function located<T>(id: string, ownerId: string | undefined, read: Promise<T>): Promise<T> {
  const server = serverOfObject(id) ?? serverOfObject(ownerId);
  return server ? read.then((value) => { locate([id], server); return value; }) : read;
}

/**
 * `api` with every call sent to `serverId` (docs/guide/multi-server.md §3.2); the entry server's own when absent.
 * For requests that name no object, such as a server's lists or a new conversation there; a request about a known
 * conversation, project or terminal finds its server by itself.
 */
export function apiFor(serverId: string | undefined): typeof api {
  if (!serverId) return api;
  return new Proxy(api, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (...args: unknown[]) => withServer(serverId, () => (value as (...rest: unknown[]) => unknown).apply(target, args)) : value;
    },
  });
}

/** The project's Git status as a stream: one `status` event now and one each time it changes. */
export function gitStatusStreamUrl(projectId: string): string {
  return withClientFeatures(`/api/projects/${encodeURIComponent(projectId)}/git/stream`);
}

export function terminalSocketUrl(id: string): string {
  const url = new URL(serverPath(`/api/terminals/${encodeURIComponent(id)}/ws`), window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('features', CLIENT_FEATURES);
  url.searchParams.set('protocol', String(TERMINAL_BINARY_PROTOCOL));
  return url.toString();
}

async function requireReferenceProtocol(input: Pick<NativeMessageInput, 'references'>): Promise<void> {
  if (!input.references?.length) return;
  if (sessionReferencesSupported === undefined) {
    try { await api.bootstrap(); }
    catch (error) {
      // Only negotiation was read: no submission crossed the transport boundary.
      throw new HttpError(409, error instanceof Error ? error.message : i18n._(msg`服务器版本过旧，请更新后重试`), 'REFERENCE_PREFLIGHT_FAILED', { accepted: false });
    }
  }
  if (!sessionReferencesSupported) throw new HttpError(409, i18n._(msg`服务器版本过旧，请更新后重试`), 'FEATURE_REQUIRED', { accepted: false });
}

function extensionUrl(scope: ExtensionContext, suffix = ''): string {
  const params = new URLSearchParams({ profileId: scope.profileId });
  if (scope.projectId) params.set('projectId', scope.projectId);
  return `/api/backends/${encodeURIComponent(scope.backendId)}/extensions${suffix}?${params}`;
}
