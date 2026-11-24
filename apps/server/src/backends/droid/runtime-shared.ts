import { spawn, type ChildProcess } from 'node:child_process';
import type {
  NativeContext,
  NativeInteraction,
  NativeInteractionResponse,
  NativeStatus,
  NativeWorkbenchEvent,
  Project,
  Session,
} from '../../../../../packages/contracts/src/index.js';
import { AGENT_PROCESS_BUDGET } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import type { ActivityLedger } from '../../journal/activity.js';
import { type RunMetricsTracker } from '../../metrics/turn-metrics.js';
import { isCliMissing, resolveCliExecutable, shellFunctionInvocation } from '../shared/cli-resolve.js';
import { nativeModelEffort, parseNativeModelSelection } from '../shared/model-selection.js';
import { KeyedTurnTrackers } from '../shared/turn-tracker.js';
import type { NativeBackendProfileConfig, NativeControlMessage, RiffetMcpServerSpec } from '../types.js';
import { isDroidPrompt, type DroidAttachmentInfo } from './events.js';
import type { DroidTranscript } from './history.js';
import type { DroidCallUsage, DroidStep } from './metering.js';
import { DROID_NO_REPLY, type DroidRpcClient } from './rpc.js';
import type { DroidStreamingBlock } from './transcript.js';

const KIB = 1024;
const MIB = KIB * KIB;

/** A conversation with nothing running gives its process back after this long. */
export const IDLE_STOP_MS = AGENT_PROCESS_BUDGET.headlessIdleMinutes * 60_000;
export const START_TIMEOUT_MS = 60_000;
/** Events of this process's conversation kept for what they tell later ones (a tool call's input, a prompt's echo). */
export const REMEMBERED_EVENTS = 8_000;
/** How much of the session file a reopened conversation reads for those events. */
export const RECENT_MESSAGES = 300;
export const MODEL_CACHE_MS = 10 * 60_000;
export const STDERR_TAIL = 4 * KIB;
// perf-rules: allow Droid RPC inline image limit moved from runtime.ts
export const MAX_INLINE_IMAGE_BYTES = 20 * MIB;
export const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
/** A running subagent's session file is re-read this often. */
export const SUBAGENT_POLL_MS = 1_000;
/** Child messages a subagent page opens with; older ones page through its own cursor. */
export const SUBAGENT_LIMIT = 32;
export const BUSY_STATES = new Set(['thinking', 'streaming_assistant_message', 'executing_tool', 'compacting_conversation', 'waiting_for_tool_confirmation']);
/** A request ceiling; Droid clamps this to the model's input window after reserving output. */
export const LONG_CONTEXT_REQUEST = 1_000_000;
/** How long a command whose ack timed out may still be claimed by its echo, and how many are remembered. */
export const LATE_COMMAND_RETAIN_MS = 10 * 60_000;
export const LATE_COMMAND_LIMIT = 16;

export const DROID_AUTONOMY_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export const DROID_MODES = ['agent', 'spec'] as const;
export type DroidAutonomy = typeof DROID_AUTONOMY_LEVELS[number];

/** Session choices; compaction is a process-only overlay and never goes through the settings RPC. */
export interface DroidSettings {
  modelId?: string;
  reasoningEffort?: string;
  compactionTokenLimit?: number;
  autonomyLevel: DroidAutonomy;
  interactionMode: 'auto' | 'spec';
}

export interface DroidProcess {
  readonly child: ChildProcess;
  readonly rpc: DroidRpcClient;
  stderr: string;
  stopping: boolean;
  exited: boolean;
  compactionTokenLimit?: number;
  compactionModelId?: string;
  settingsDirectory?: string;
  stopTask?: Promise<void>;
  contextRefreshSequence: number;
  readonly settingsRequests: Map<string, { reported?: Partial<DroidSettings> }>;
  pinnedModelId?: string;
  modelMismatch?: string;
  providerNotice?: string;
}

/** A Droid request the user has to answer; the first one in the queue is what the card shows. */
export interface PendingRequest {
  readonly rpcId: string;
  readonly method: 'droid.request_permission' | 'droid.ask_user';
  readonly params: Record<string, unknown>;
  interaction: NativeInteraction;
  /** ask_user only: the question on screen and the answers collected so far. */
  questionIndex: number;
  answers: Array<{ index: number; question: string; answer: string }>;
  resolve(result: unknown): void;
}

/** A child session a `Task` call started, followed so its row can open the subagent's transcript. */
export interface DroidSubagent {
  readonly toolCallId: string;
  readonly childId: string;
  subagentType?: string;
  background: boolean;
  running: boolean;
  syncing?: Promise<void>;
  lastChangeAt: number;
}

/** The conversation's phase goes through its tracker; nothing here sets `status.phase` by hand. */
export const droidTurns = new KeyedTurnTrackers<object>();

export interface DroidConversation {
  readonly workbenchSessionId: string;
  session: Session;
  project: Project;
  profile: NativeBackendProfileConfig;
  nativeSessionId?: string;
  /** The control path's listeners (`subscribe`). */
  readonly listeners: Set<(message: NativeControlMessage) => void>;
  /** What moved the transcript (`transcriptSource` reads it into the journal). */
  readonly wakers: Set<() => void>;
  /** This process's events by identity, for what later ones need of them (see `REMEMBERED_EVENTS`). */
  readonly events: Map<string, NativeWorkbenchEvent>;
  proc?: DroidProcess;
  starting?: Promise<DroidProcess>;
  /** Droid's own `droid_working_state_changed` value. */
  working: string;
  /** Between a sent message and its `agent_turn_completed`. */
  turnActive: boolean;
  activeTurn?: string;
  /** Set when Droid exited in the middle of a turn; cleared by the next start. */
  failure?: string;
  status: NativeStatus;
  /** Highest message `seq` Droid has written; the next message continues after it. */
  lastSeq?: number;
  /** Text of the blocks being streamed, until their message commits: the journal's drafts (`transcript.ts`). */
  readonly drafts: Map<string, DroidStreamingBlock>;
  /** Droid does not stream tool messages; their seq is the one after the assistant message. */
  toolMessage?: { id: string; seq: number };
  /** Keyed by the parent's `Task` tool call id. */
  readonly subagents: Map<string, DroidSubagent>;
  /** One poll for every running child of this conversation; cleared once none runs. */
  subagentTimer?: NodeJS.Timeout;
  /** The session file was read for the title, settings and first prompt (a live process keeps these current). */
  loaded: boolean;
  /** `add_user_message` request ids, mapped to the command they delivered. */
  readonly commands: Map<string, { commandId: string; runId: string; attachments?: DroidAttachmentInfo[] }>;
  /**
   * Commands whose `add_user_message` ack timed out, kept for a while: Droid may still take the message and echo it, and the
   * echo can then confirm the run. Expires by `expiresAt` (epoch ms); never read by turn-end bookkeeping.
   */
  readonly lateCommands: Map<string, { commandId: string; runId: string; attachments?: DroidAttachmentInfo[]; expiresAt: number }>;
  /** User message ids (Droid's turn ids), mapped to the command that started them. */
  readonly turns: Map<string, { commandId: string; runId: string }>;
  readonly pending: PendingRequest[];
  /** Last settings Droid reported. */
  reported?: Partial<DroidSettings>;
  /** A change asked for during a turn; applied once the turn ends. */
  deferred?: DroidSettings;
  /**
   * The workbench is installing settings of its own. Droid reports what it held before (resuming
   * reports the stored settings first), and adopting that would overwrite the user's choice.
   */
  configuring: number;
  disposed: boolean;
  context?: NativeContext;
  firstMessage?: string;
  readonly metrics: Map<string, RunMetricsTracker>;
  readonly steps: Map<string, DroidStep>;
  /** Wall clock when the current model request began (user prompt or last tool result). */
  requestStartAt?: number;
  /** System activities this process saw (compaction, fire-and-forget commands), for the status summary; the journal has their rows. */
  readonly activities: ActivityLedger;
  /** The compaction Droid is in the middle of, if any. */
  compaction?: string;
  compactions: number;
  /** Looks for the end of detached commands by their process id; runs only while one is live. */
  backgroundWatch?: NodeJS.Timeout;
  lastCallUsage?: DroidCallUsage;
  idleTimer?: NodeJS.Timeout;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function droidAutonomy(value: string | undefined): DroidAutonomy {
  return (DROID_AUTONOMY_LEVELS as readonly string[]).includes(value ?? '') ? value as DroidAutonomy : 'off';
}

export function droidMode(value: string | undefined): 'agent' | 'spec' {
  return value === 'spec' ? 'spec' : 'agent';
}

/** The workbench's model selection, including a process-scoped context request when selected. */
export function droidModelValue(modelId: string, reasoningEffort?: string, compactionTokenLimit?: number): string {
  const params = [
    ...(reasoningEffort && reasoningEffort !== 'none' ? [`effort=${reasoningEffort}`] : []),
    ...(compactionTokenLimit !== undefined ? ['context=long'] : []),
  ];
  return params.length ? `${modelId}[${params.join(',')}]` : modelId;
}

export function desiredSettings(profile: NativeBackendProfileConfig, config: { model?: string; mode?: string; approval?: string }): DroidSettings {
  const selection = parseNativeModelSelection(config.model ?? str(profile.config.defaultModel));
  const effort = nativeModelEffort(selection);
  const context = selection.params.context;
  if (context !== undefined && context !== 'default' && context !== 'long') {
    throw new AppError('INVALID_MODEL', 'Droid context must be default or long.', 400);
  }
  return {
    ...(selection.model ? { modelId: selection.model } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
    ...(context === 'long' ? { compactionTokenLimit: LONG_CONTEXT_REQUEST } : {}),
    autonomyLevel: droidAutonomy(config.approval),
    interactionMode: droidMode(config.mode) === 'spec' ? 'spec' : 'auto',
  };
}

/** The keys of `desired` Droid does not already hold. */
export function settingsChange(reported: Partial<DroidSettings> | undefined, desired: DroidSettings): Partial<DroidSettings> | undefined {
  const change: Partial<DroidSettings> = {};
  if (desired.modelId && desired.modelId !== reported?.modelId) change.modelId = desired.modelId;
  if (desired.reasoningEffort && (desired.reasoningEffort !== reported?.reasoningEffort || change.modelId)) change.reasoningEffort = desired.reasoningEffort;
  if (desired.autonomyLevel !== reported?.autonomyLevel) change.autonomyLevel = desired.autonomyLevel;
  if (desired.interactionMode !== reported?.interactionMode) change.interactionMode = desired.interactionMode;
  return Object.keys(change).length ? change : undefined;
}

export function readSettings(value: unknown): Partial<DroidSettings> {
  // Droid's settings response omits the process context request. Keep it in Riffet's model
  // selection; get_context_breakdown supplies the effective budget after native policy/clamping.
  const settings = record(value) ?? {};
  const autonomy = str(settings.autonomyLevel);
  const mode = str(settings.interactionMode);
  return {
    ...(str(settings.modelId) ? { modelId: str(settings.modelId) } : {}),
    ...(str(settings.reasoningEffort) ? { reasoningEffort: str(settings.reasoningEffort) } : {}),
    ...(autonomy && (DROID_AUTONOMY_LEVELS as readonly string[]).includes(autonomy) ? { autonomyLevel: autonomy as DroidAutonomy } : {}),
    ...(mode === 'auto' || mode === 'spec' ? { interactionMode: mode } : {}),
  };
}

export function confirmDroidSettings(reported: Partial<DroidSettings> | undefined, desired: Partial<DroidSettings>): void {
  for (const key of ['modelId', 'reasoningEffort', 'autonomyLevel', 'interactionMode'] as const) {
    if (desired[key] !== undefined && reported?.[key] !== desired[key]) {
      throw new AppError('NATIVE_SETTINGS_UNCONFIRMED', `Droid did not confirm ${key}: expected ${desired[key]}, actual ${reported?.[key] ?? 'unreported'}. No prompt was sent.`, 503);
    }
  }
}

export function launchCommand(profile: NativeBackendProfileConfig): { command: string; args: string[]; configured: string } {
  const configured = str(profile.config.executable) ?? 'droid';
  const resolution = resolveCliExecutable({ command: configured });
  if (resolution.source === 'shell-function') {
    const invocation = shellFunctionInvocation(configured.slice('shell:'.length), []);
    return { ...invocation, configured };
  }
  return { command: resolution.executable, args: [], configured };
}

export function droidEnvironment(profile: NativeBackendProfileConfig): NodeJS.ProcessEnv {
  const apiKey = str(profile.config.apiKey);
  return { ...process.env, ...(apiKey ? { FACTORY_API_KEY: apiKey } : {}) };
}

/** The process-only `--settings` overlay, when this launch needs one. */
export function droidSettingsOverlay(desired: Pick<DroidSettings, 'modelId' | 'compactionTokenLimit'>, riffetMcp?: RiffetMcpServerSpec): Record<string, unknown> | undefined {
  const overlay: Record<string, unknown> = {
    // The RPC setter writes the user's global file instead. Override only this model; Spec,
    // fallback and custom models keep their native limits.
    ...(desired.compactionTokenLimit !== undefined ? { compactionTokenLimitPerModel: { [desired.modelId!]: desired.compactionTokenLimit } } : {}),
    // The conversation's Riffet tools (docs/DEVICES.md §2), for this process only: the
    // `droid.add_mcp_server` RPC would save them to the user's `~/.factory/mcp.json`.
    ...(riffetMcp ? { mcp: { mcpServers: { [riffetMcp.name]: { type: 'stdio', command: riffetMcp.command, args: riffetMcp.args } } } } : {}),
  };
  return Object.keys(overlay).length ? overlay : undefined;
}

export function spawnDroid(profile: NativeBackendProfileConfig, cwd: string, settingsFile?: string): ChildProcess {
  const launch = launchCommand(profile);
  return spawn(launch.command, [...launch.args, 'exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc', '--cwd', cwd, ...(settingsFile ? ['--settings', settingsFile] : [])], {
    cwd,
    env: droidEnvironment(profile),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMissingCliError(error: unknown, configured: string): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT' && isCliMissing(resolveCliExecutable({ command: configured }));
}

const PERMISSION_TITLES: Record<string, string> = {
  exec: 'Allow command?',
  create: 'Allow file creation?',
  edit: 'Allow file edit?',
  apply_patch: 'Allow file changes?',
  mcp_tool: 'Allow tool call?',
};

const PERMISSION_LABELS: Record<string, string> = {
  proceed_once: 'Allow',
  proceed_always: 'Always allow (Low)',
  cancel: 'Deny',
};

function permissionDetail(toolUse: Record<string, unknown>): string {
  const details = record(toolUse.details) ?? {};
  const call = record(toolUse.toolUse) ?? {};
  const command = str(details.fullCommand) ?? str(details.command);
  if (command) return command;
  const path = str(details.filePath) ?? str(record(call.input)?.file_path);
  if (path) return path;
  const input = JSON.stringify(call.input ?? {});
  return `${str(call.name) ?? 'Tool'} ${input.length > 2_000 ? `${input.slice(0, 2_000)}…` : input}`;
}

export function permissionInteraction(id: string, rpcId: string, params: Record<string, unknown>): NativeInteraction {
  const toolUses = (Array.isArray(params.toolUses) ? params.toolUses : []).map(record).filter((item): item is Record<string, unknown> => item !== undefined);
  const options = (Array.isArray(params.options) ? params.options : []).flatMap(item => {
    const option = record(item);
    const value = str(option?.value);
    return value ? [{ value, label: str(option?.label) ?? value }] : [];
  });
  const first = toolUses[0];
  const type = str(first?.confirmationType) ?? '';
  const base = { id, revision: `${rpcId}:0`, transport: 'protocol' as const, requestId: rpcId };
  if (type === 'exit_spec_mode') {
    const details = record(first?.details) ?? {};
    // A new session would continue under an id this conversation does not own, so those are left out.
    const choices = options.filter(option => option.value !== 'cancel' && !option.value.startsWith('proceed_new_session'));
    return {
      ...base,
      kind: 'plan',
      title: str(details.title) ?? 'Spec ready',
      message: str(details.plan) ?? '',
      options: choices.map((option, index) => ({ id: option.value, label: option.label, selected: index === 0 })),
      actions: [{ id: 'submit', label: 'Proceed', tone: 'primary' }, { id: 'cancel', label: 'Keep iterating', tone: 'danger' }],
    };
  }
  return {
    ...base,
    kind: 'permission',
    title: PERMISSION_TITLES[type] ?? 'Allow this action?',
    message: toolUses.map(permissionDetail).join('\n'),
    options: [],
    actions: options.map(option => ({
      id: option.value,
      label: PERMISSION_LABELS[option.value] ?? option.label,
      ...(option.value === 'proceed_once' ? { tone: 'primary' as const } : option.value === 'cancel' ? { tone: 'danger' as const } : {}),
    })),
  };
}

export interface DroidQuestion { index: number; topic?: string; question: string; options: string[]; multiSelect?: boolean }

export function askUserQuestions(params: Record<string, unknown>): DroidQuestion[] {
  return (Array.isArray(params.questions) ? params.questions : []).flatMap((item, position) => {
    const question = record(item);
    const text = str(question?.question);
    if (!question || !text) return [];
    return [{
      index: typeof question.index === 'number' ? question.index : position + 1,
      question: text,
      ...(str(question.topic) ? { topic: str(question.topic) } : {}),
      options: (Array.isArray(question.options) ? question.options : []).flatMap(option => str(option) ?? []),
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
    }];
  });
}

export function questionInteraction(id: string, rpcId: string, questions: DroidQuestion[], index: number): NativeInteraction {
  const question = questions[index]!;
  return {
    id,
    revision: `${rpcId}:${index}`,
    transport: 'protocol',
    requestId: rpcId,
    kind: 'question',
    title: question.topic ?? `Question ${index + 1}`,
    message: question.question,
    options: question.options.map((label, option) => ({ id: `option:${option}`, label, selected: false })),
    ...(question.multiSelect ? { multiple: true } : {}),
    allowOther: true,
    questionIndex: index + 1,
    questionCount: questions.length,
    actions: [{ id: 'answer', label: index + 1 < questions.length ? '下一题' : '提交', tone: 'primary' }, { id: 'cancel', label: '取消', tone: 'danger' }],
  };
}

export function questionAnswer(question: DroidQuestion, response: NativeInteractionResponse): string {
  const selected = new Set(response.selectedIds ?? []);
  const values = question.options.filter((_, index) => selected.has(`option:${index}`));
  if (response.otherText?.trim()) values.push(response.otherText.trim());
  return values.join(', ');
}

/** The answer that withdraws a request Droid is waiting on. */
export function cancelResult(pending: PendingRequest): unknown {
  return pending.method === 'droid.ask_user' ? { cancelled: true, answers: [] } : { selectedOption: 'cancel' };
}

/** Settles requests Droid stopped waiting on (the turn ended, or the process went away) without answering. */
export function dropPending(state: DroidConversation): void {
  for (const pending of state.pending.splice(0)) pending.resolve(DROID_NO_REPLY);
}

export function notify(state: DroidConversation, message: NativeControlMessage): void {
  for (const listener of state.listeners) {
    try { listener(message); } catch { /* one subscriber must not stop the others */ }
  }
}

/** The transcript moved: whoever reads it into the journal reads again. */
export function wake(state: DroidConversation): void {
  for (const waker of state.wakers) {
    try { waker(); } catch { /* one reader must not stop the others */ }
  }
}

/** Whether a child's latest prompt has an outcome, i.e. it is not working on anything. */
export function childTurnEnded(transcript: DroidTranscript): boolean {
  const prompt = transcript.chain.findLast(isDroidPrompt);
  return Boolean(prompt && transcript.outcomes.has(prompt.id));
}
