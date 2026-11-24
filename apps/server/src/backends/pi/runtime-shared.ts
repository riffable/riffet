import type { ChildProcess } from 'node:child_process';
import type {
  NativeContext,
  NativeInteraction,
  NativeStatus,
  Project,
  Session,
} from '../../../../../packages/contracts/src/index.js';
import { AGENT_PROCESS_BUDGET } from '../../../../../packages/contracts/src/index.js';
import type { DormancyClock } from '../shared/dormancy.js';
import { KeyedTurnTrackers } from '../shared/turn-tracker.js';
import type { NativeBackendProfileConfig, NativeControlMessage } from '../types.js';
import type { PiEntry } from './history.js';
import type { PiStepMetering } from './metering.js';
import type { PiRpcTransport } from './transport.js';

const KIB = 1024;
const MIB = KIB * KIB;

/** A conversation with nothing running gives its process back after this long (droid's own choice). */
export const IDLE_STOP_MS = AGENT_PROCESS_BUDGET.headlessIdleMinutes * 60_000;
export const START_TIMEOUT_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 30_000;
/** How long a written prompt may go unacknowledged before pi is stopped; until then a late ack still confirms it. */
export const PROMPT_ACK_GRACE_MS = 5 * 60_000;
export const STDERR_TAIL = 4 * KIB;
// perf-rules: allow Pi RPC inline image limit moved from runtime.ts
export const MAX_INLINE_IMAGE_BYTES = 20 * MIB;
export const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export type RecordValue = Record<string, unknown>;

/** One streamed assistant block that has not reached pi's session file yet. */
export interface PiDraft {
  key: string;
  contentIndex: number;
  thought: boolean;
  text: string;
  at: string;
  entryId?: string;
  messageTimestamp?: number;
  turnId?: string;
  runId?: string;
}

export interface PiDelivery {
  readonly commandId: string;
  readonly runId: string;
  readonly text: string;
  expectedText?: string;
  disposition?: string;
  readonly at: string;
  /** Entry index at the dispatch fence: ownership only looks after it. */
  readonly lastEntryId: string | null;
  readonly leafId: string | null;
  readonly recovered?: boolean;
  entryId?: string;
}

export interface PiPendingUi {
  readonly requestId: string;
  readonly method: string;
  interaction: NativeInteraction;
  resolve(response: RecordValue): Promise<void>;
  timer?: NodeJS.Timeout;
}

export interface PiProcess {
  readonly child: ChildProcess;
  readonly rpc: PiRpcTransport;
  stderr: string;
  stopping: boolean;
  exited: boolean;
  launchKey: string;
  exitTask?: Promise<void>;
  settling?: Promise<void>;
  pendingSettle?: RecordValue;
  stopTask?: Promise<void>;
  /** A settled run was aborted by pi. */
  settledAborted: boolean;
  /** Final retry failure, which outranks the last assistant's stop reason. */
  retryError?: string;
  lastAssistant?: RecordValue;
}

export interface PiDesired {
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

export interface PiConversation {
  readonly workbenchSessionId: string;
  session: Session;
  project: Project;
  profile: NativeBackendProfileConfig;
  nativeSessionId?: string;
  readonly listeners: Set<(message: NativeControlMessage) => void>;
  readonly wakers: Set<() => void>;
  context?: NativeContext;
  proc?: PiProcess;
  starting?: Promise<PiProcess>;
  status: NativeStatus;
  failure?: string;
  disposed: boolean;
  nativeActive: boolean;
  /** The selection a send must apply before its prompt. */
  desired?: PiDesired;
  /** What pi last reported. */
  reported: PiDesired;
  /** Unsettled prompts, by workbench command id. */
  readonly deliveries: Map<string, PiDelivery>;
  /** Confirmed native user entries, mapped to the command they answered. */
  readonly turns: Map<string, { commandId: string; runId: string }>;
  readonly drafts: Map<string, PiDraft>;
  readonly metering: PiStepMetering;
  /** The turn the streamed blocks belong to: a confirmed entry id, else the command id. */
  streamTurn?: string;
  activeTurn?: string;
  activeRunId?: string;
  /** Increments for each assistant message in a turn; draft keys stay unique across tool loops. */
  assistantStep: number;
  /** A stop was requested; the settled event is the outcome. */
  stopRequested: boolean;
  readonly pending: PiPendingUi[];
  readonly knownEntries: Set<string>;
  /** The last entry id the runtime has seen. */
  boundary?: string;
  loaded: boolean;
  firstMessage?: string;
  readonly dormancy: DormancyClock;
  compaction?: string;
  compactions: number;
  idleTimer?: NodeJS.Timeout;
  /** A non-fatal provider message, shown with its own level. */
  notice?: string;
  noticeLevel?: 'info' | 'warning' | 'error';
  /** An automatic retry still running: shown over `notice` without replacing it, gone once the retry or its turn ends. */
  retryNotice?: string;
}

export const piTurns = new KeyedTurnTrackers<object>();

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isEntry(value: unknown): value is PiEntry {
  const entry = record(value);
  return typeof entry?.id === 'string' && typeof entry.type === 'string';
}

export function messageOf(entry: PiEntry): RecordValue | undefined {
  return record(entry.message);
}

/** The user text of a prompt entry, ignoring images. */
export function promptText(entry: PiEntry): string {
  const content = messageOf(entry)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap(value => {
    const block = record(value);
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  }).join('\n');
}

/** Compares what the workbench sent with what pi persisted; an extension may rewrite the text. */
export function samePrompt(sent: string, stored: string): boolean {
  return sent.trim() === stored.trim();
}

/** The workbench model form pi understands: `provider/modelId[effort=level]`. */
export function piModelValue(provider: string | undefined, modelId: string, thinkingLevel?: string): string {
  return `${provider ? `${provider}/` : ''}${modelId}${thinkingLevel ? `[effort=${thinkingLevel}]` : ''}`;
}

export function splitModel(value: string | undefined): { provider?: string; modelId?: string } {
  const model = value?.trim();
  if (!model) return {};
  const slash = model.indexOf('/');
  if (slash <= 0) return { modelId: model };
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

export function readReported(data: RecordValue): PiDesired {
  const model = record(data.model);
  const provider = str(model?.provider);
  const modelId = str(model?.id);
  const thinking = str(data.thinkingLevel);
  return {
    ...(provider ? { provider } : {}),
    ...(modelId ? { modelId } : {}),
    ...(thinking ? { thinkingLevel: thinking } : {}),
  };
}

/** A model selection is already in force when pi reports the same provider, id and level. */
export function sameSelection(reported: PiDesired, desired: PiDesired): boolean {
  if (desired.modelId && desired.modelId !== reported.modelId) return false;
  if (desired.provider && desired.provider !== reported.provider) return false;
  if (desired.thinkingLevel && desired.thinkingLevel !== reported.thinkingLevel) return false;
  return true;
}

export function notify(state: PiConversation, message: NativeControlMessage): void {
  for (const listener of state.listeners) {
    try { listener(message); } catch { /* one subscriber must not stop the others */ }
  }
}

export function wake(state: PiConversation): void {
  for (const waker of state.wakers) {
    try { waker(); } catch { /* one reader must not stop the others */ }
  }
}

export function dropPending(state: PiConversation): void {
  for (const pending of state.pending.splice(0)) {
    if (pending.timer) clearTimeout(pending.timer);
    void pending.resolve({ cancelled: true }).catch(() => undefined);
  }
}
