import type { NativeInteraction, NativeQueue, NativeStatus } from './native.js';
import type { NativeRunInput, OutputRate } from './run.js';
import type { CapturedSessionReference } from './session.js';

/**
 * The session control view (docs/DISPATCH-ARCHITECTURE.md §3.2). One snapshot is the only
 * authority for the foreground turn, the inbox, and which actions a client may offer.
 */

export type InboxAction =
  | 'send_now'
  | 'steer'
  | 'edit'
  | 'cancel'
  | 'retry'
  | 'check'
  | 'continue'
  | 'restore';

export interface InboxEntry {
  id: string;
  commandId: string;
  kind: 'message' | 'steer';
  /** `sending`: entering the transcript directly. `queued`: blocked, shown in the queue. */
  placement: 'sending' | 'queued';
  status: 'queued' | 'preparing' | 'sending' | 'uncertain' | 'failed';
  prompt: NativeRunInput;
  contextSnapshots?: CapturedSessionReference[];
  createdAt: string;
  updatedAt: string;
  error?: string;
  diagnostic?: { code?: string; message: string; stage?: string; at: string };
  /** Actions the server allows for this entry. A client does not infer a second set. */
  actions: readonly InboxAction[];
}

export interface ActiveTurnState {
  /** Journal turn key, or the provider turn id when that is all the server has. */
  turnId?: string;
  ownerRunId?: string;
  nativeSessionId?: string;
  nativeTurnId?: string;
  phase: 'starting' | 'running' | 'stopping' | 'attention';
  startedAt?: string;
  canStop: boolean;
  canSteer: boolean;
}

export interface SessionControlSnapshot {
  /** Monotonic per stream. Clients drop a frame whose revision went backwards. */
  revision: number;
  runtime: 'offline' | 'starting' | 'ready' | 'conflict' | 'failed';
  /** `null` is an idle foreground. A value is the turn that owns it. */
  activeTurn: ActiveTurnState | null;
  /** Unfinished inputs in dispatch order: the one sending now, then what is waiting. */
  inbox: readonly InboxEntry[];
  /** Why the queue is held. The same value `NativeDispatcher.queue` reports. */
  held?: NativeQueue['held'];
  capabilities: {
    canStop: boolean;
    canSteer: boolean;
    /** A queued message may stop the live turn and go now; true before any queued entry exists. */
    canSendNow: boolean;
  };
  interaction: NativeInteraction | null;
  activity: { compacting: boolean; background: number };
  outputRate?: OutputRate;
  connection?: NativeStatus['connection'];
  history?: NativeStatus['history'];
  runtimeControl?: NativeStatus['runtimeControl'];
  notice?: string;
  noticeLevel?: 'info' | 'warning' | 'error';
  model?: string;
  permission?: string;
  approval?: string;
  profilePending?: boolean;
  transcript?: NativeStatus['transcript'];
}
