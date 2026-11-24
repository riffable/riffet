import type { ModelInfo, NativeBackendCatalogEntry, NativeInteraction, Project, Session } from '../../../../packages/contracts/src/index.js';
import type { ChannelConnectionStatus, ChannelHealth, ChannelKind, ChannelRegistrationState } from '../../../../packages/contracts/src/channels.js';
import type { SessionLock } from '../agent-host/session-lock.js';
import type { NativeBackendService } from '../backends/service.js';
import type { NativeDispatcher } from '../native/dispatch.js';
import type { OwnerService } from '../owner/index.js';
import type { SessionCommands } from '../orchestration/session-commands.js';
import type { SettingsService } from '../settings/index.js';
import type { Store } from '../store.js';
import type { TranscriptIngest } from '../sync/ingest.js';
import type { TimelineService } from '../timeline/service.js';
import type { WorkspaceService } from '../workspace/index.js';
import type { ChannelBindings } from './bindings.js';
import type { Following } from './follow.js';
import type { ChannelIdentities } from './identity.js';
import type {
  ChannelAddress, ChannelConnection, ChannelProvider, ReplyAnchor, SentRef, TurnSurface, TurnView,
} from './types.js';

export interface ChannelDeps {
  store: Store;
  settings: SettingsService;
  nativeBackends: NativeBackendService;
  dispatch: NativeDispatcher;
  sessionCommands: SessionCommands;
  sessionLock: SessionLock;
  timeline: TimelineService;
  ingest: TranscriptIngest;
  workspace: WorkspaceService;
  owner: OwnerService;
  stateDir: string;
  /** The platforms of the plugins that are on, read each time: a plugin can be turned on or off at any time. */
  providers: () => ChannelProvider[];
  /** Called after the plugins' platforms changed; accounts connect, reconnect or drop accordingly. */
  onProvidersChanged?: (listener: () => void) => () => void;
}

export const KIB = 1024;
export const MIB = KIB * KIB;
export const DEDUPE_WINDOW_MS = 60_000;
export const HOLD_MS = 10 * 60_000;
export const REF_TTL_MS = 24 * 60 * 60_000;
export const PICKER_LIMIT = 50;
export const MAX_ATTACHMENTS = 20;
// perf-rules: allow channel inbound attachment limit moved from service.ts
export const MAX_ATTACHMENT_BYTES = 24 * MIB;
export const PUSH_DELAY_MS = 400;
export const MODEL_NAMES_TTL_MS = 10 * 60_000;
export const CATALOG_TTL_MS = 5 * 60_000;
export const CATALOG_CACHE_MAX = 32;
export const PERSIST_EVERY_MS = 5000;
export const HEALTH_TTL_MS = 60_000;
export const REGISTRATION_READY_MS = 15_000;
export const REGISTRATION_KEEP_MS = 10 * 60_000;
/** How long an answer press waits for the backend before toasting without its result. */
export const ANSWER_WAIT_MS = 2500;
export const MODEL_NAMES_CAP = 16;
export const MODEL_NAMES_FINAL_WAIT_MS = 500;

export const UNCERTAIN_TEXT = '已发送，但没有确认收到';
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
export const answerKey = (id: string, revision: string) => `${id}\n${revision}`;

export interface Runtime {
  status: ChannelConnectionStatus;
  abort: AbortController;
  connection?: ChannelConnection;
  provider?: ChannelProvider;
  settled: Promise<void>;
  resumed: boolean;
  pending: Set<string>;
}

export interface ModelRef {
  kind: 'model'; account: string; address: ChannelAddress; anchor?: ReplyAnchor; at: number;
  scope: 'session' | 'chat'; chat: string; sessionId?: string; sent?: SentRef;
  pending?: string;
  chain?: Promise<void>;
}

export type RefEntry =
  | { kind: 'stop'; account: string; sessionId: string; runId: string }
  | { kind: 'picker'; account: string; chat: string; at: number }
  | { kind: 'panel'; account: string; address: ChannelAddress; anchor?: ReplyAnchor; at: number }
  | ModelRef
  | { kind: 'interaction'; account: string; sessionId: string; interactionId: string; revision: string };

export interface Tracker {
  runId: string; sessionId: string; commandId: string; address: ChannelAddress;
  source: TurnView['source']; anchor?: ReplyAnchor;
  surface?: TurnSurface; opening?: Promise<TurnSurface | undefined>;
  timer?: NodeJS.Timeout; finishing: boolean; persisted?: string; persistedAt?: number; persistedIds?: string; stopRef: string;
}

export interface Shown { ref: string; refs: string[]; interaction: NativeInteraction; sent: SentRef }

export interface SessionFollow {
  sessionId: string; following: Following; trackers: Set<string>;
  waiting: boolean; shown?: Shown; answered: Set<string>;
  contextPercent?: number;
  chain: Promise<void>;
}

export interface Registration extends ChannelRegistrationState {
  kind: ChannelKind;
  abort: AbortController;
  url: string;
  qr: string;
  expiresAt: number;
  finishedAt?: number;
}

export interface ModelNameCacheEntry {
  names: Map<string, string>;
  models: ModelInfo[];
  loading?: Promise<void>;
  at: number;
}

export interface ChannelSharedState {
  readonly deps: ChannelDeps;
  readonly bindings: ChannelBindings;
  readonly identities: ChannelIdentities;
  readonly runtimes: Map<string, Runtime>;
  readonly trackers: Map<string, Tracker>;
  readonly follows: Map<string, SessionFollow>;
  readonly refs: Map<string, RefEntry>;
  readonly anchors: Map<string, ReplyAnchor>;
  readonly registrations: Map<string, Registration>;
  readonly healthCache: Map<string, { at: number; value: ChannelHealth }>;
  readonly catalogs: Map<string, { at: number; value: Promise<NativeBackendCatalogEntry> }>;
  readonly backendList: { at: number; value?: Promise<Array<{ id: string; name: string }>> };
  readonly modelNames: Map<string, ModelNameCacheEntry>;
  isClosed(): boolean;
  provider(kind: string): ChannelProvider | undefined;
  connectionOf(account: string): ChannelConnection | undefined;
  changed(): void;
  addRef(entry: RefEntry): string;
  projectOf(id: string): Project | undefined;
  threadAnchor(sessionId: string, address: ChannelAddress): ReplyAnchor | undefined;
  reply(connection: ChannelConnection, address: ChannelAddress, anchor: ReplyAnchor | undefined, text: string): Promise<unknown>;
  notify(sessionId: string, text: string): void;
}
