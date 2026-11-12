import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  ModelInfo, NativeContext, NativeInteraction, NativeInteractionResponse,
  NativeInteractionResult, NativeRunConfig, NativeRunInput, NativeSlashItem, NativeStatus, NativeWorkbenchEvent,
  Project, Session,
} from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { measuredWindow, runTracker, type RunMetricsTracker } from '../../metrics/turn-metrics.js';
import { estimateTokens } from '../../metrics/tokens.js';
import { firstHumanMessage, firstMessageTitlePatch, generatedTitlePatch, providerTitlePatch } from '../../session-title.js';
import { childHasExited, waitForExit } from '../shared/child-process.js';
import { resolveCliExecutable, shellFunctionInvocation } from '../shared/cli-resolve.js';
import { nativeModelEffort, parseNativeModelSelection } from '../shared/model-selection.js';
import { KeyedTurnTrackers } from '../shared/turn-tracker.js';
import { activityId, ActivityLedger, withActivity } from '../../journal/activity.js';
import type { NativeBackendAvailability, NativeBackendHost, NativeBackendProfileConfig, NativeControlMessage, NativeDispatchBinding, RiffetMcpServerSpec } from '../types.js';
import {
  droidBackgroundActivity, droidBackgroundEnd, droidFireAndForgetResult, droidToolResultEvent,
  droidUserEventId, droidProviderNotice, isDroidPrompt, isHiddenMessage, messageFromProtocol, projectDroidMessage,
  projectDroidTurnEnd, type DroidAttachmentInfo,
} from './events.js';
import { findDroidTranscript, readDroidSessionSettings, readDroidTranscript, validateDroidSessionId, type DroidTranscript } from './history.js';
import { DROID_NO_REPLY, DROID_RPC_ERRORS, DroidRpcClient, DroidRpcError } from './rpc.js';
import { DroidTranscriptSource, type DroidStreamingBlock } from './transcript.js';

/** A conversation with nothing running gives its process back after this long. */
const IDLE_STOP_MS = 10 * 60_000;
const START_TIMEOUT_MS = 60_000;
/** Events of this process's conversation kept for what they tell later ones (a tool call's input, a prompt's echo). */
const REMEMBERED_EVENTS = 8_000;
/** How much of the session file a reopened conversation reads for those events. */
const RECENT_MESSAGES = 300;
const MODEL_CACHE_MS = 10 * 60_000;
const STDERR_TAIL = 4 * 1024;
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
/** A running command's output reaches the browser at most this often; the last one always does. */
/** A running subagent's session file is re-read this often. */
const SUBAGENT_POLL_MS = 1_000;
/** Child messages a subagent page opens with; older ones page through its own cursor. */
const SUBAGENT_LIMIT = 32;
const BUSY_STATES = new Set(['thinking', 'streaming_assistant_message', 'executing_tool', 'compacting_conversation', 'waiting_for_tool_confirmation']);
/** A request ceiling; Droid clamps this to the model's input window after reserving output. */
const LONG_CONTEXT_REQUEST = 1_000_000;
export const DROID_AUTONOMY_LEVELS = ['off', 'low', 'medium', 'high'] as const;
export const DROID_MODES = ['agent', 'spec'] as const;
type DroidAutonomy = typeof DROID_AUTONOMY_LEVELS[number];

/** Session choices; compaction is a process-only overlay and never goes through the settings RPC. */
interface DroidSettings {
  modelId?: string;
  reasoningEffort?: string;
  compactionTokenLimit?: number;
  autonomyLevel: DroidAutonomy;
  interactionMode: 'auto' | 'spec';
}

interface DroidProcess {
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
interface PendingRequest {
  readonly rpcId: string;
  readonly method: 'droid.request_permission' | 'droid.ask_user';
  readonly params: Record<string, unknown>;
  interaction: NativeInteraction;
  /** ask_user only: the question on screen and the answers collected so far. */
  questionIndex: number;
  answers: Array<{ index: number; question: string; answer: string }>;
  resolve(result: unknown): void;
}

/** One streamed assistant message, measured from its first delta to its last. */
interface DroidStep {
  turnId?: string;
  text: string;
  startedAt: number;
  lastAt: number;
}

/** A child session a `Task` call started, followed so its row can open the subagent's transcript. */
interface DroidSubagent {
  readonly toolCallId: string;
  readonly childId: string;
  subagentType?: string;
  background: boolean;
  running: boolean;
  syncing?: Promise<void>;
  lastChangeAt: number;
}

/** The conversation's phase goes through its tracker; nothing here sets `status.phase` by hand. */
const droidTurns = new KeyedTurnTrackers<object>();

interface DroidConversation {
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
  /** System activities this process saw (compaction, fire-and-forget commands), for the status summary; the journal has their rows. */
  readonly activities: ActivityLedger;
  /** The compaction Droid is in the middle of, if any. */
  compaction?: string;
  compactions: number;
  /** Looks for the end of detached commands by their process id; runs only while one is live. */
  backgroundWatch?: NodeJS.Timeout;
  lastCallUsage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number };
  idleTimer?: NodeJS.Timeout;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finite(value: unknown): number | undefined {
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

function desiredSettings(profile: NativeBackendProfileConfig, config: { model?: string; mode?: string; approval?: string }): DroidSettings {
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
function settingsChange(reported: Partial<DroidSettings> | undefined, desired: DroidSettings): Partial<DroidSettings> | undefined {
  const change: Partial<DroidSettings> = {};
  if (desired.modelId && desired.modelId !== reported?.modelId) change.modelId = desired.modelId;
  if (desired.reasoningEffort && (desired.reasoningEffort !== reported?.reasoningEffort || change.modelId)) change.reasoningEffort = desired.reasoningEffort;
  if (desired.autonomyLevel !== reported?.autonomyLevel) change.autonomyLevel = desired.autonomyLevel;
  if (desired.interactionMode !== reported?.interactionMode) change.interactionMode = desired.interactionMode;
  return Object.keys(change).length ? change : undefined;
}

function readSettings(value: unknown): Partial<DroidSettings> {
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

function confirmDroidSettings(reported: Partial<DroidSettings> | undefined, desired: Partial<DroidSettings>): void {
  for (const key of ['modelId', 'reasoningEffort', 'autonomyLevel', 'interactionMode'] as const) {
    if (desired[key] !== undefined && reported?.[key] !== desired[key]) {
      throw new AppError('NATIVE_SETTINGS_UNCONFIRMED', `Droid did not confirm ${key}: expected ${desired[key]}, actual ${reported?.[key] ?? 'unreported'}. No prompt was sent.`, 503);
    }
  }
}

function launchCommand(profile: NativeBackendProfileConfig): { command: string; args: string[]; configured: string } {
  const configured = str(profile.config.executable) ?? 'droid';
  const resolution = resolveCliExecutable({ command: configured });
  if (resolution.source === 'shell-function') {
    const invocation = shellFunctionInvocation(configured.slice('shell:'.length), []);
    return { ...invocation, configured };
  }
  return { command: resolution.executable, args: [], configured };
}

function droidEnvironment(profile: NativeBackendProfileConfig): NodeJS.ProcessEnv {
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

function spawnDroid(profile: NativeBackendProfileConfig, cwd: string, settingsFile?: string): ChildProcess {
  const launch = launchCommand(profile);
  return spawn(launch.command, [...launch.args, 'exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc', '--cwd', cwd, ...(settingsFile ? ['--settings', settingsFile] : [])], {
    cwd,
    env: droidEnvironment(profile),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Probes the configured CLI without starting a session. */
export async function probeDroidCli(profile: NativeBackendProfileConfig): Promise<NativeBackendAvailability> {
  const launch = launchCommand(profile);
  const run = (args: string[]) => new Promise<string>((resolvePromise, reject) => {
    const child = spawn(launch.command, [...launch.args, ...args], { env: droidEnvironment(profile), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timed out')); }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => { if (output.length < 256 * 1024) output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { if (output.length < 256 * 1024) output += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); resolvePromise(output); });
  });
  try {
    const version = await run(['--version']);
    const help = await run(['exec', '--help']);
    if (!help.includes('stream-jsonrpc')) return { available: false, reason: `“${launch.configured}” does not support \`droid exec --input-format stream-jsonrpc\`; update Droid.`, version };
    return { available: true, version };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { available: false, reason: `Cannot find “${launch.configured}”. Install Droid (https://factory.ai) or set this profile's executable to its absolute path.` };
    return { available: false, reason: `Could not start Droid at “${launch.command}” (${errorMessage(error)}).` };
  }
}

const modelCache = new Map<string, { at: number; models: Promise<ModelInfo[]> }>();

/** Droid's model catalog. `droid.list_models` answers without a session, so a short-lived process serves it. */
export async function listDroidModels(profile: NativeBackendProfileConfig): Promise<ModelInfo[]> {
  const key = JSON.stringify([str(profile.config.executable) ?? 'droid', createHash('sha256').update(str(profile.config.apiKey) ?? '').digest('hex')]);
  const cached = modelCache.get(key);
  if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return await cached.models;
  const models = fetchDroidModels(profile);
  modelCache.set(key, { at: Date.now(), models });
  models.catch(() => { if (modelCache.get(key)?.models === models) modelCache.delete(key); });
  return await models;
}

async function fetchDroidModels(profile: NativeBackendProfileConfig): Promise<ModelInfo[]> {
  const child = spawnDroid(profile, homedir());
  const rpc = new DroidRpcClient(child.stdin!, child.stdout!, { onNotification: () => undefined, onRequest: async () => ({}) });
  child.once('error', error => rpc.close(error));
  child.once('exit', () => rpc.close());
  try {
    const result = await rpc.request<{ models?: unknown[] }>('droid.list_models', {}, { timeoutMs: 30_000 });
    return droidModelInfos(result.models ?? []);
  } finally {
    rpc.close();
    child.stdin?.end();
    if (!await waitForExit(child, 2_000)) child.kill('SIGKILL');
  }
}

/**
 * Droid's `/` catalog for `cwd`: user-invocable skills and custom commands. Both RPCs answer without
 * a session, so a short-lived process serves them. Droid invokes a skill wherever `/name` sits in
 * the message, so every skill is offered mid-message too.
 */
export async function listDroidSlashItems(profile: NativeBackendProfileConfig, cwd: string): Promise<NativeSlashItem[]> {
  const child = spawnDroid(profile, cwd);
  const rpc = new DroidRpcClient(child.stdin!, child.stdout!, { onNotification: () => undefined, onRequest: async () => ({}) });
  child.once('error', error => rpc.close(error));
  child.once('exit', () => rpc.close());
  try {
    const [skills, commands] = await Promise.all([
      rpc.request<{ skills?: unknown[] }>('droid.list_skills', {}, { timeoutMs: 30_000 }),
      rpc.request<{ commands?: unknown[] }>('droid.list_commands', {}, { timeoutMs: 30_000 }).catch(() => ({ commands: [] as unknown[] })),
    ]);
    return droidSlashItems(skills.skills ?? [], commands.commands ?? []);
  } finally {
    rpc.close();
    child.stdin?.end();
    if (!await waitForExit(child, 2_000)) child.kill('SIGKILL');
  }
}

/** How long a command whose ack timed out may still be claimed by its echo, and how many are remembered. */
const LATE_COMMAND_RETAIN_MS = 10 * 60_000;
const LATE_COMMAND_LIMIT = 16;

export function droidSlashItems(skills: unknown[], commands: unknown[]): NativeSlashItem[] {
  const items: NativeSlashItem[] = [];
  for (const value of commands) {
    const command = record(value);
    const name = str(command?.name)?.replace(/^\//, '');
    if (!command || !name) continue;
    const description = str(command.description);
    const hint = str(command.argumentHint) ?? str(command.argumentsHint);
    items.push({ name, kind: 'command', ...(description ? { description } : {}), ...(hint ? { hint } : {}) });
  }
  for (const value of skills) {
    const skill = record(value);
    const name = str(skill?.name);
    if (!skill || !name || skill.enabled === false || skill.userInvocable === false) continue;
    const description = str(skill.description);
    const path = str(skill.filePath);
    items.push({ name, kind: 'skill', ...(description ? { description } : {}), ...(path ? { path } : {}) });
  }
  return items;
}

export function droidModelInfos(models: unknown[]): ModelInfo[] {
  return models.flatMap(value => {
    const model = record(value);
    const id = str(model?.id) ?? str(model?.modelId);
    if (!model || !id || model.deprecated === true || model.disabled === true) return [];
    const efforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.flatMap(item => str(item) ?? []).filter(effort => effort !== 'none')
      : [];
    const defaultEffort = str(model.defaultReasoningEffort);
    return [{
      value: id,
      name: str(model.displayName) ?? id,
      configOptions: [...(efforts.length ? [{
        id: 'effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select' as const,
        currentValue: defaultEffort && efforts.includes(defaultEffort) ? defaultEffort : efforts[0]!,
        options: efforts.map(effort => ({ value: effort, name: effort === 'xhigh' ? 'Extra high' : effort[0]!.toUpperCase() + effort.slice(1) })),
      }] : []), ...(model.isCustom === false && model.kind !== 'router' ? [{
        id: 'context',
        name: 'Context budget',
        category: 'model_config',
        description: 'Default follows Droid\'s compaction setting. Long context requests a compaction threshold of up to 1M; the actual threshold is bounded by the model\'s input window and organization policy. A change applies from the next turn.',
        type: 'select' as const,
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'long', name: 'Long · ≤1M', description: 'An upper bound; the budget in force is what Droid reports.' },
        ],
      }] : [])],
    }];
  });
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

function permissionInteraction(id: string, rpcId: string, params: Record<string, unknown>): NativeInteraction {
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

interface DroidQuestion { index: number; topic?: string; question: string; options: string[]; multiSelect?: boolean }

function askUserQuestions(params: Record<string, unknown>): DroidQuestion[] {
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

function questionInteraction(id: string, rpcId: string, questions: DroidQuestion[], index: number): NativeInteraction {
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

function questionAnswer(question: DroidQuestion, response: NativeInteractionResponse): string {
  const selected = new Set(response.selectedIds ?? []);
  const values = question.options.filter((_, index) => selected.has(`option:${index}`));
  if (response.otherText?.trim()) values.push(response.otherText.trim());
  return values.join(', ');
}

/** The answer that withdraws a request Droid is waiting on. */
function cancelResult(pending: PendingRequest): unknown {
  return pending.method === 'droid.ask_user' ? { cancelled: true, answers: [] } : { selectedOption: 'cancel' };
}

/** Settles requests Droid stopped waiting on (the turn ended, or the process went away) without answering. */
function dropPending(state: DroidConversation): void {
  for (const pending of state.pending.splice(0)) pending.resolve(DROID_NO_REPLY);
}

/** Owns one `droid exec` process per open conversation and routes its stream to the workbench. */
export class DroidRuntime {
  private readonly conversations = new Map<string, DroidConversation>();

  constructor(private readonly host: NativeBackendHost) {}

  conversation(session: Session, project: Project, profile: NativeBackendProfileConfig): DroidConversation {
    const existing = this.conversations.get(session.id);
    if (existing) {
      if (existing.nativeSessionId && session.nativeSessionId && existing.nativeSessionId !== session.nativeSessionId) {
        throw new AppError('NATIVE_SESSION_SCOPE_MISMATCH', 'This Droid conversation is bound to a different Droid session', 409);
      }
      existing.session = session;
      existing.project = project;
      existing.profile = profile;
      existing.nativeSessionId ??= session.nativeSessionId;
      return existing;
    }
    const state: DroidConversation = {
      workbenchSessionId: session.id,
      session,
      project,
      profile,
      ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
      listeners: new Set(),
      wakers: new Set(),
      events: new Map(),
      working: 'idle',
      turnActive: false,
      status: { phase: 'idle' },
      drafts: new Map(),
      subagents: new Map(),
      loaded: false,
      commands: new Map(),
      lateCommands: new Map(),
      turns: new Map(),
      pending: [],
      configuring: 0,
      disposed: false,
      metrics: new Map(),
      steps: new Map(),
      activities: new ActivityLedger(() => this.emitStatus(state)),
      compactions: 0,
    };
    state.status = this.statusOf(state);
    this.conversations.set(session.id, state);
    return state;
  }

  status(session: Session): NativeStatus {
    return this.conversations.get(session.id)?.status ?? { phase: 'idle' };
  }

  interaction(session: Session): NativeInteraction | undefined {
    return this.conversations.get(session.id)?.pending[0]?.interaction;
  }

  context(session: Session): NativeContext | undefined {
    return this.conversations.get(session.id)?.context;
  }

  isRunning(sessionId: string): boolean {
    const proc = this.conversations.get(sessionId)?.proc;
    return Boolean(proc && !proc.exited);
  }

  subscribe(session: Session, project: Project, profile: NativeBackendProfileConfig, listener: (message: NativeControlMessage) => void): () => void {
    const state = this.conversation(session, project, profile);
    state.listeners.add(listener);
    listener({ type: 'context', ...(state.context ? { context: state.context } : {}) });
    void this.ensureLoaded(state);
    return () => { state.listeners.delete(listener); };
  }

  /**
   * The conversation's transcript for the session journal (sync v3): Droid's session file, woken by this
   * process's notifications, with the text it is streaming and the subagents it has running.
   */
  transcriptSource(session: Session, profile: NativeBackendProfileConfig): DroidTranscriptSource {
    const sessionId = session.id;
    const current = () => { try { return this.host.getSession(sessionId); } catch { return undefined; } };
    return new DroidTranscriptSource({
      sessionId,
      nativeSessionId: () => current()?.nativeSessionId,
      locate: async nativeSessionId => {
        const latest = current();
        return latest ? await findDroidTranscript(nativeSessionId, this.host.getProject(latest.projectId).cwd) : undefined;
      },
      live: {
        watch: wake => {
          const latest = this.host.getSession(sessionId);
          const state = this.conversation(latest, this.host.getProject(latest.projectId), profile);
          state.wakers.add(wake);
          return () => { state.wakers.delete(wake); };
        },
        streaming: () => [...this.conversations.get(sessionId)?.drafts.values() ?? []],
        running: () => [...this.conversations.get(sessionId)?.subagents.values() ?? []]
          .filter(item => item.running).map(item => ({ toolCallId: item.toolCallId, childId: item.childId, ...(item.subagentType ? { subagentType: item.subagentType } : {}) })),
        command: messageId => {
          const known = this.conversations.get(sessionId)?.turns.get(messageId);
          if (known) return known;
          // After a restart only the run the dispatcher bound to the echoed prompt knows it.
          const runId = this.host.findRunIdByNativeMessage(sessionId, droidUserEventId(messageId));
          return runId ? { runId } : undefined;
        },
      },
    });
  }

  /**
   * Binds the conversation without starting Droid: its transcript reads from disk, and the process
   * (which also creates the Droid session of a new conversation) starts with the first send.
   */
  open(session: Session, project: Project, profile: NativeBackendProfileConfig): { nativeSessionId?: string; status: NativeStatus } {
    const state = this.conversation(session, project, profile);
    return { ...(state.nativeSessionId ? { nativeSessionId: state.nativeSessionId } : {}), status: state.status };
  }

  async send(input: {
    session: Session;
    project: Project;
    profile: NativeBackendProfileConfig;
    commandId: string;
    runId: string;
    input: NativeRunInput;
    config: NativeRunConfig;
    isCancelled(): boolean;
    commitDispatchFence(binding?: NativeDispatchBinding): unknown;
  }): Promise<void> {
    const state = this.conversation(input.session, input.project, input.profile);
    const prompt = await this.materialize(input.input);
    if (input.isCancelled()) return;
    const desired = desiredSettings(input.profile, input.config);
    const proc = await this.ensureProcess(state, desired);
    if (proc.stopping || proc.exited || proc.modelMismatch) throw new AppError('NATIVE_SETTINGS_UNCONFIRMED', state.failure ?? 'Droid stopped before confirming this send. No prompt was sent.', 503);
    const change = settingsChange(state.reported, desired);
    if (change) await this.applySettings(state, proc, change, desired);
    confirmDroidSettings(state.reported, desired);
    if (proc.stopping || proc.exited || proc.modelMismatch) throw new AppError('NATIVE_SETTINGS_UNCONFIRMED', state.failure ?? 'Droid stopped before dispatch. No prompt was sent.', 503);
    // This send has adopted the latest persisted selection, replacing any older deferred change.
    state.deferred = undefined;
    if (input.isCancelled()) return;
    const resolvedConfig: NativeRunConfig = {
      ...(desired.modelId ? { model: droidModelValue(desired.modelId, desired.reasoningEffort, desired.compactionTokenLimit) } : {}),
      mode: desired.interactionMode === 'spec' ? 'spec' : 'agent',
      approval: desired.autonomyLevel,
    };
    input.commitDispatchFence({
      backendId: 'droid',
      ...(state.nativeSessionId ? { nativeSessionId: state.nativeSessionId } : {}),
      // Where the receipt is looked for; the service starts it at the end of the conversation's log.
      baselineSequence: 0,
      renderedText: prompt.text,
      resolvedConfig,
    });
    // Droid echoes this id on the user message it creates, which is how the turn finds its command.
    const rpcId = `add:${input.commandId}`;
    state.commands.set(rpcId, { commandId: input.commandId, runId: input.runId, ...(prompt.attachments.length ? { attachments: prompt.attachments } : {}) });
    // Busy before the request: a turn Droid ends at once can report that before this send returns.
    state.turnActive = true;
    state.failure = undefined;
    this.emitStatus(state);
    try {
      await proc.rpc.request('droid.add_user_message', {
        text: prompt.text,
        ...(prompt.images.length ? { images: prompt.images } : {}),
      }, { id: rpcId, timeoutMs: 30_000 });
    } catch (error) {
      const late = state.commands.get(rpcId);
      state.commands.delete(rpcId);
      if (late) this.keepLateCommand(state, rpcId, late);
      if (!state.activeTurn) {
        state.turnActive = state.commands.size > 0;
        this.emitStatus(state);
      }
      throw new Error(`Droid did not acknowledge this send; its outcome may be uncertain (${errorMessage(error)})`);
    }
  }

  private keepLateCommand(state: DroidConversation, rpcId: string, command: { commandId: string; runId: string; attachments?: DroidAttachmentInfo[] }): void {
    const at = Date.now();
    for (const [id, item] of state.lateCommands) if (item.expiresAt <= at) state.lateCommands.delete(id);
    while (state.lateCommands.size >= LATE_COMMAND_LIMIT) state.lateCommands.delete(state.lateCommands.keys().next().value!);
    state.lateCommands.set(rpcId, { ...command, expiresAt: at + LATE_COMMAND_RETAIN_MS });
  }

  private takeLateCommand(state: DroidConversation, rpcId: string): { commandId: string; runId: string; attachments?: DroidAttachmentInfo[] } | undefined {
    const late = state.lateCommands.get(rpcId);
    if (!late) return undefined;
    state.lateCommands.delete(rpcId);
    if (late.expiresAt <= Date.now()) return undefined;
    const { expiresAt: _expiresAt, ...command } = late;
    return command;
  }

  async interrupt(session: Session): Promise<void> {
    const state = this.conversations.get(session.id);
    const proc = state?.proc;
    if (!state || !proc || proc.exited) return;
    for (const pending of state.pending.splice(0)) pending.resolve(cancelResult(pending));
    try {
      await proc.rpc.request('droid.interrupt_session', {}, { timeoutMs: 10_000 });
    } catch (error) {
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', `Droid did not confirm that the turn stopped (${errorMessage(error)}).`, 503);
    }
    this.emitStatus(state);
  }

  /**
   * Switches model, effort, mode or autonomy. A running process takes it at once, or at the end of
   * the turn in flight; a stopped one takes it when it next starts, from the session record.
   */
  async configure(session: Session, project: Project, profile: NativeBackendProfileConfig, patch: { model?: string; mode?: string; approval?: string }): Promise<void> {
    const state = this.conversation(session, project, profile);
    const desired = desiredSettings(profile, {
      model: patch.model ?? session.model,
      mode: patch.mode ?? session.mode,
      approval: patch.approval ?? session.approval,
    });
    await this.validateContextBudget(profile, desired);
    const proc = state.proc;
    if (!proc || proc.exited) { state.deferred = undefined; return; }
    // Supersede any older deferred choice, including a turn-end application waiting for the lock.
    state.deferred = desired;
    if (state.turnActive || BUSY_STATES.has(state.working) || state.pending.length) {
      return;
    }
    if (this.contextBudgetChanged(proc, desired)) {
      if (this.hasActiveWork(state)) {
        return;
      }
      await this.stop(state, proc);
      if (state.deferred === desired) state.deferred = undefined;
      return;
    }
    const change = settingsChange(state.reported, desired);
    if (change) await this.applySettings(state, proc, change, desired);
    if (state.deferred === desired) state.deferred = undefined;
  }

  async rename(session: Session): Promise<void> {
    const proc = this.conversations.get(session.id)?.proc;
    if (!proc || proc.exited || !session.title.trim()) return;
    await proc.rpc.request('droid.rename_session', { title: session.title }, { timeoutMs: 10_000 }).catch(() => undefined);
  }

  async respond(session: Session, response: NativeInteractionResponse): Promise<NativeInteractionResult> {
    if (typeof response.requestId !== 'string' || !response.requestId || response.requestId.length > 200 || /[\0\r\n]/.test(response.requestId)) {
      throw new AppError('INVALID_INTERACTION_REQUEST_ID', 'Interaction request id is invalid');
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({
      interactionId: response.interactionId,
      revision: response.revision,
      action: response.action,
      selectedIds: response.selectedIds ?? [],
      otherText: response.otherText ?? '',
    })).digest('hex');
    const previous = this.host.getInteractionReceipt(session.id, response.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.interactionId !== response.interactionId || previous.revision !== response.revision) {
        throw new AppError('NATIVE_INTERACTION_REQUEST_CONFLICT', 'This interaction retry id was already used for a different answer', 409);
      }
      return previous.result;
    }
    const state = this.conversations.get(session.id);
    const pending = state?.pending[0];
    const current = pending?.interaction;
    if (!state || !pending || !current || current.id !== response.interactionId || current.revision !== response.revision) {
      return { status: 'uncertain', ...(current ? { interaction: current } : {}), message: 'This Droid request is no longer active.' };
    }
    if (!current.actions.some(action => action.id === response.action)) {
      return { status: 'uncertain', interaction: current, message: 'The selected action is not available for this request.' };
    }
    const save = (result: NativeInteractionResult) => {
      this.host.saveInteractionReceipt(session.id, response.requestId, { fingerprint, interactionId: response.interactionId, revision: response.revision, result, createdAt: new Date().toISOString() });
      return result;
    };
    let answer: unknown;
    if (pending.method === 'droid.ask_user') {
      const questions = askUserQuestions(pending.params);
      if (response.action === 'cancel') {
        answer = { cancelled: true, answers: [] };
      } else {
        const question = questions[pending.questionIndex]!;
        pending.answers.push({ index: question.index, question: question.question, answer: questionAnswer(question, response) });
        if (pending.questionIndex + 1 < questions.length) {
          pending.questionIndex += 1;
          pending.interaction = questionInteraction(current.id, pending.rpcId, questions, pending.questionIndex);
          const advanced = save({ status: 'advanced', interaction: pending.interaction });
          this.emitStatus(state);
          return advanced;
        }
        answer = { cancelled: false, answers: pending.answers };
      }
    } else if (current.kind === 'plan') {
      answer = { selectedOption: response.action === 'submit' ? (response.selectedIds?.[0] ?? current.options[0]?.id ?? 'proceed_once') : 'cancel' };
    } else {
      answer = { selectedOption: response.action };
    }
    state.pending.shift();
    const next = state.pending[0];
    const result = save(next ? { status: 'advanced', interaction: next.interaction } : { status: 'completed' });
    pending.resolve(answer);
    this.emitStatus(state);
    return result;
  }

  async dispose(sessionId: string): Promise<void> {
    const state = this.conversations.get(sessionId);
    if (!state) return;
    this.conversations.delete(sessionId);
    state.disposed = true;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    if (state.backgroundWatch) clearInterval(state.backgroundWatch);
    if (state.subagentTimer) clearInterval(state.subagentTimer);
    state.subagentTimer = undefined;
    state.listeners.clear();
    state.wakers.clear();
    if (state.proc) await this.stop(state, state.proc);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.conversations.keys()].map(id => this.dispose(id)));
  }

  private async transcript(state: DroidConversation): Promise<DroidTranscript | undefined> {
    if (!state.nativeSessionId) return undefined;
    const path = await findDroidTranscript(state.nativeSessionId, state.project.cwd);
    return path ? await readDroidTranscript(path, state.nativeSessionId) : undefined;
  }

  /** Reads Droid's session file once, unless a live process already keeps the conversation current. */
  private async ensureLoaded(state: DroidConversation): Promise<void> {
    if (state.loaded || state.proc || !state.nativeSessionId) return;
    state.loaded = true;
    try { await this.loadTranscript(state); } catch { state.loaded = false; }
  }

  /** What the session file says of the conversation: where its numbering stands, its subagents, its title and its settings. */
  private async loadTranscript(state: DroidConversation): Promise<void> {
    const transcript = await this.transcript(state);
    if (!transcript) {
      state.loaded = Boolean(state.proc);
      return;
    }
    const events = transcript.chain.slice(-RECENT_MESSAGES).flatMap(message => projectDroidMessage(message, { sessionId: state.workbenchSessionId }));
    this.keep(state, events);
    state.lastSeq = transcript.lastSeq;
    state.loaded = true;
    const first = firstHumanMessage(events);
    if (first && !state.firstMessage) state.firstMessage = first;
    if (first) this.patchSession(state, firstMessageTitlePatch(this.host.getSession(state.workbenchSessionId), first));
    if (transcript.title) this.patchSession(state, providerTitlePatch(this.host.getSession(state.workbenchSessionId), transcript.title));
    await this.adoptStoredSettings(state, transcript.path);
  }

  /** A session imported from Droid takes the settings Droid last used for whatever the record leaves open. */
  private async adoptStoredSettings(state: DroidConversation, path: string): Promise<void> {
    const initial = this.host.getSession(state.workbenchSessionId);
    if (initial.model && initial.approval) return;
    const stored = await readDroidSessionSettings(path);
    if (!stored) return;
    // Import can overlap a picker change while the sidecar is being read. Only fill fields that
    // are still unspecified now, rather than replacing the user's newer selection.
    const session = this.host.getSession(state.workbenchSessionId);
    const patch: Partial<Session> = {
      ...(!session.model && stored.model ? { model: droidModelValue(stored.model, stored.reasoningEffort) } : {}),
      ...(!session.approval && stored.autonomyLevel ? { approval: droidAutonomy(stored.autonomyLevel) } : {}),
    };
    if (Object.keys(patch).length) this.patchSession(state, patch);
  }

  private patchSession(state: DroidConversation, patch: Partial<Session> | undefined): void {
    if (!patch || !Object.keys(patch).length) return;
    state.session = this.host.updateSession(state.workbenchSessionId, patch);
    notify(state, { type: 'session', session: state.session });
  }

  private async materialize(input: NativeRunInput): Promise<{ text: string; images: Array<{ type: 'base64'; data: string; mediaType: string }>; attachments: DroidAttachmentInfo[] }> {
    const extras = input.context.map(item => `@${item.path}${item.line ? `:${item.line}` : ''}`);
    const images: Array<{ type: 'base64'; data: string; mediaType: string }> = [];
    const attachments: DroidAttachmentInfo[] = [];
    for (const id of input.attachmentIds) {
      const { attachment, data } = await this.host.readAttachment(id);
      attachments.push({
        id: attachment.id, name: attachment.name, mimeType: attachment.mimeType,
        ...(attachment.width !== undefined ? { width: attachment.width } : {}),
        ...(attachment.height !== undefined ? { height: attachment.height } : {}),
      });
      if (IMAGE_MEDIA_TYPES.has(attachment.mimeType.toLowerCase()) && data.length <= MAX_INLINE_IMAGE_BYTES) {
        images.push({ type: 'base64', data: data.toString('base64'), mediaType: attachment.mimeType.toLowerCase() });
        continue;
      }
      const directory = join(tmpdir(), 'riffet-attachments', attachment.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = join(directory, basename(attachment.name) || 'attachment');
      await writeFile(target, data, { mode: 0o600 });
      extras.push(target);
    }
    return { text: [input.text, ...(extras.length ? ['', ...extras] : [])].join('\n'), images, attachments };
  }

  private async ensureProcess(state: DroidConversation, desired?: DroidSettings): Promise<DroidProcess> {
    const previous = state.proc;
    if (previous?.stopTask) await previous.stopTask;
    if (state.proc && !state.proc.exited && desired && this.contextBudgetChanged(state.proc, desired)) {
      if (this.hasActiveWork(state)) {
        throw new AppError('CLI_BUSY', 'The new Droid context budget takes effect after the current turn and background work finish.', 409);
      }
      await this.stop(state, state.proc);
    }
    if (state.proc && !state.proc.exited) return state.proc;
    state.starting ??= this.launch(state, desired ?? desiredSettings(state.profile, state.session)).finally(() => { state.starting = undefined; });
    return await state.starting;
  }

  private async launch(state: DroidConversation, desired: DroidSettings): Promise<DroidProcess> {
    await this.validateContextBudget(state.profile, desired);
    if (state.nativeSessionId) await this.loadTranscript(state);
    const cwd = resolve(state.project.cwd);
    let settingsDirectory: string | undefined;
    let settingsFile: string | undefined;
    const overlay = droidSettingsOverlay(desired, this.host.riffetMcp?.server(state.workbenchSessionId));
    if (overlay) {
      settingsDirectory = await mkdtemp(join(tmpdir(), 'riffet-droid-settings-'));
      settingsFile = join(settingsDirectory, 'settings.json');
      try {
        await writeFile(settingsFile, JSON.stringify(overlay), { mode: 0o600 });
      } catch (error) {
        await rm(settingsDirectory, { recursive: true, force: true });
        throw error;
      }
    }
    const child = spawnDroid(state.profile, cwd, settingsFile);
    const proc: DroidProcess = {
      child,
      stderr: '',
      stopping: false,
      exited: false,
      contextRefreshSequence: 0,
      settingsRequests: new Map(),
      ...(desired.modelId ? { pinnedModelId: desired.modelId } : {}),
      ...(desired.compactionTokenLimit !== undefined ? { compactionTokenLimit: desired.compactionTokenLimit, compactionModelId: desired.modelId } : {}),
      ...(settingsDirectory ? { settingsDirectory } : {}),
      rpc: new DroidRpcClient(child.stdin!, child.stdout!, {
        onNotification: notification => this.handleNotification(state, proc, notification),
        onRequest: async (method, params, id) => await this.handleRequest(state, proc, method, params, id),
        // A transport that closed under a live child (a bad frame, a broken stdin) cannot be reused.
        onClose: () => { if (!proc.exited) proc.child.kill('SIGTERM'); },
      }),
    };
    child.stderr!.on('data', (chunk: Buffer) => { proc.stderr = `${proc.stderr}${chunk.toString()}`.slice(-STDERR_TAIL); });
    child.once('error', error => {
      this.handleExit(state, proc, error.message);
      if (settingsDirectory) void rm(settingsDirectory, { recursive: true, force: true }).catch(() => undefined);
    });
    child.once('exit', (code, signal) => {
      this.handleExit(state, proc, `exit ${code ?? signal ?? 'unknown'}`);
      if (settingsDirectory) void rm(settingsDirectory, { recursive: true, force: true }).catch(() => undefined);
    });
    state.proc = proc;
    state.working = 'idle';
    state.configuring += 1;
    try {
      if (state.nativeSessionId) {
        const loaded = await proc.rpc.request<Record<string, unknown>>('droid.load_session', { sessionId: state.nativeSessionId, messageLimit: 1 }, { timeoutMs: START_TIMEOUT_MS });
        state.reported = readSettings(loaded.settings);
        const change = settingsChange(state.reported, desired);
        if (change) await this.applySettings(state, proc, change, desired);
      } else {
        const created = await proc.rpc.request<Record<string, unknown>>('droid.initialize_session', {
          machineId: hostname(),
          cwd,
          ...(desired.modelId ? { modelId: desired.modelId } : {}),
          ...(desired.reasoningEffort ? { reasoningEffort: desired.reasoningEffort } : {}),
          autonomyLevel: desired.autonomyLevel,
          interactionMode: desired.interactionMode,
        }, { timeoutMs: START_TIMEOUT_MS });
        const nativeSessionId = str(created.sessionId);
        if (!nativeSessionId) throw new Error('Droid did not return a session id');
        state.nativeSessionId = nativeSessionId;
        state.loaded = true;
        state.reported = readSettings(created.settings);
        state.session = this.host.setNativeSessionId(state.workbenchSessionId, nativeSessionId);
        notify(state, { type: 'session', session: state.session });
      }
      if (desired.compactionTokenLimit !== undefined) await this.refreshContext(state, true);
    } catch (error) {
      await this.stop(state, proc);
      if (error instanceof AppError) throw error;
      const detail = proc.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
      const code = error instanceof DroidRpcError ? error.code : undefined;
      if (code === DROID_RPC_ERRORS.unauthorized) throw new AppError('NATIVE_AUTH_REQUIRED', 'Droid is not signed in. Run `droid` once in a terminal to sign in, or set an API key on this profile.', 401);
      if (code === DROID_RPC_ERRORS.notFound) throw new AppError('NATIVE_SESSION_NOT_FOUND', 'Droid no longer has this session.', 404);
      throw new AppError('NATIVE_START_FAILED', `Droid could not start: ${errorMessage(error)}${detail ? ` (${detail})` : ''}`, 503);
    } finally {
      state.configuring -= 1;
    }
    state.loaded = true;
    state.failure = undefined;
    this.emitStatus(state);
    if (desired.compactionTokenLimit === undefined) void this.refreshContext(state);
    return proc;
  }

  private contextBudgetChanged(proc: DroidProcess, desired: DroidSettings): boolean {
    return proc.compactionTokenLimit !== desired.compactionTokenLimit
      || (desired.compactionTokenLimit !== undefined && proc.compactionModelId !== desired.modelId);
  }

  /** A child can still be executing after its parent's turn has ended. */
  private hasActiveWork(state: DroidConversation): boolean {
    return state.turnActive || BUSY_STATES.has(state.working) || state.pending.length > 0
      || [...state.subagents.values()].some(child => child.running);
  }

  private async validateContextBudget(profile: NativeBackendProfileConfig, desired: DroidSettings): Promise<void> {
    if (desired.compactionTokenLimit === undefined) return;
    const model = (await listDroidModels(profile)).find(item => item.value === desired.modelId);
    if (!model?.configOptions.some(option => option.id === 'context')) {
      throw new AppError('INVALID_MODEL', 'Long context requires a Droid-listed built-in model with a known input window; custom and Auto models are not supported.', 400);
    }
  }

  private async applySettings(state: DroidConversation, proc: DroidProcess, change: Partial<DroidSettings>, desired = change): Promise<void> {
    const requestId = `settings:${randomUUID()}`;
    const acknowledgement: { reported?: Partial<DroidSettings> } = {};
    proc.settingsRequests.set(requestId, acknowledgement);
    state.configuring += 1;
    try {
      await proc.rpc.request('droid.update_session_settings', change, { id: requestId, timeoutMs: 15_000 });
      // The supported protocol emits settings_updated(requestId, actual settings) before the
      // empty response. The empty response alone does not prove which model or permission won.
      confirmDroidSettings(acknowledgement.reported, desired);
      confirmDroidSettings(state.reported, desired);
      if (desired.modelId) proc.pinnedModelId = desired.modelId;
    } catch (error) {
      state.failure = errorMessage(error);
      await this.stop(state, proc);
      if (error instanceof AppError) throw error;
      if (error instanceof DroidRpcError && (error.code === undefined || error.code === DROID_RPC_ERRORS.disconnected)) {
        throw new AppError('NATIVE_SETTINGS_UNCONFIRMED', `Droid did not confirm the requested settings (${errorMessage(error)}). No prompt was sent.`, 503);
      }
      if (change.modelId || change.reasoningEffort) throw new AppError('INVALID_MODEL', `Droid refused this model selection (${errorMessage(error)})`, 400);
      throw new AppError('INVALID_APPROVAL_MODE', `Droid refused this setting (${errorMessage(error)})`, 400);
    } finally {
      state.configuring -= 1;
      proc.settingsRequests.delete(requestId);
    }
    if (change.modelId || change.reasoningEffort) void this.refreshContext(state);
  }

  private handleExit(state: DroidConversation, proc: DroidProcess, reason: string): void {
    if (proc.exited) return;
    proc.exited = true;
    proc.rpc.close(new DroidRpcError(`Droid exited (${reason})`, DROID_RPC_ERRORS.disconnected));
    if (state.proc !== proc || state.disposed) return;
    state.proc = undefined;
    state.working = 'idle';
    dropPending(state);
    if (state.turnActive) {
      // Droid writes no outcome for a turn it died in. The one it echoed ends on the journal (below);
      // a prompt it never echoed is in no transcript, so its run hears the end directly.
      const reason = proc.modelMismatch ? 'model_changed' : proc.stopping ? 'cancelled' : 'process_exit';
      this.endUnechoed(state, [...state.commands.entries()], reason);
    }
    state.commands.clear();
    state.lateCommands.clear();
    state.steps.clear();
    state.drafts.clear();
    for (const item of state.subagents.values()) if (item.running) this.finishSubagent(state, item);
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
    if (!proc.stopping && state.turnActive) {
      const detail = proc.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 240);
      state.failure = `Droid exited during this turn (${reason})${detail ? `: ${detail}` : ''}`;
    }
    // The journal's copy of the turn (sync v3): its transcript has no outcome line to end it with.
    if (state.turnActive) this.endExitedTurn(state.workbenchSessionId, proc.stopping && !proc.modelMismatch ? 'cancelled' : 'failed', state.failure);
    state.turnActive = false;
    state.activeTurn = undefined;
    // Nothing reports on a compaction once this process is gone; a detached command outlives it and is followed by its process id.
    state.compaction = undefined;
    state.activities.settleWhere(activity => activity.kind === 'compaction', 'unknown');
    this.emitStatus(state);
  }

  /** Tells the runs of prompts Droid never echoed how their turn ended; nothing in its transcript can. */
  private endUnechoed(state: DroidConversation, commands: Array<[string, { commandId: string; runId: string }]>, reason: string): void {
    const createdAt = new Date().toISOString();
    for (const [rpcId, command] of commands) {
      const event = projectDroidTurnEnd({ turnId: rpcId, reason }, state.lastSeq ?? 0, createdAt, { sessionId: state.workbenchSessionId, commandId: command.commandId, runId: command.runId });
      if (event) this.host.emitEvent(state.workbenchSessionId, event);
    }
  }

  /** Ends on the journal the turn a Droid process exited in, after what it wrote; fire and forget. */
  private endExitedTurn(sessionId: string, status: 'cancelled' | 'failed', error: string | undefined): void {
    const at = new Date().toISOString();
    void this.host.transcript?.withSource(sessionId, (source, w) => source instanceof DroidTranscriptSource ? source.endOpenTurns(w, status, at, status === 'failed' ? error : undefined) : undefined)
      .catch(() => undefined);
  }

  private stop(state: DroidConversation, proc: DroidProcess): Promise<void> {
    return proc.stopTask ??= (async () => {
      try {
        if (proc.exited) return;
        proc.stopping = true;
        for (const pending of state.pending.splice(0)) pending.resolve(cancelResult(pending));
        await proc.rpc.request('droid.close_session', {}, { timeoutMs: 2_000 }).catch(() => undefined);
        proc.child.stdin?.end();
        if (await waitForExit(proc.child, 2_000)) return;
        proc.child.kill('SIGTERM');
        if (await waitForExit(proc.child, 3_000)) return;
        proc.child.kill('SIGKILL');
        if (!await waitForExit(proc.child, 3_000)) {
          throw new AppError('NATIVE_STOP_UNCONFIRMED', 'Droid did not confirm that its previous process stopped; the new context budget was not started.', 503);
        }
      } finally {
        if (childHasExited(proc.child)) {
          this.handleExit(state, proc, 'stopped');
          if (proc.settingsDirectory) await rm(proc.settingsDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    })();
  }

  private scheduleIdleStop(state: DroidConversation): void {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
    const proc = state.proc;
    if (!proc || proc.exited || proc.stopping || this.hasActiveWork(state)) return;
    state.idleTimer = setTimeout(() => {
      state.idleTimer = undefined;
      if (state.proc === proc && !this.hasActiveWork(state)) {
        void this.stop(state, proc).catch(error => { state.failure = errorMessage(error); this.emitStatus(state); });
      }
    }, IDLE_STOP_MS);
    state.idleTimer.unref();
  }

  private statusOf(state: DroidConversation): NativeStatus {
    const session = state.session;
    const interaction = state.pending[0]?.interaction;
    // Droid's protocol is the only channel, so the tracker only records the lifecycle it reports.
    const phase = droidTurns.report(state, state.failure && state.proc?.modelMismatch ? 'attention' : interaction
      ? 'attention'
      : state.turnActive || (state.proc && BUSY_STATES.has(state.working))
        ? 'busy'
        : state.failure ? 'offline' : 'idle', 'protocol');
    const approval = droidAutonomy(session.approval);
    return withActivity({
      phase,
      ...(session.model ?? str(state.profile.config.defaultModel) ? { model: session.model ?? str(state.profile.config.defaultModel) } : {}),
      approval,
      permission: approval,
      ...(interaction ? { interaction } : {}),
      ...(state.failure && (phase === 'offline' || phase === 'attention') ? { notice: state.failure, noticeLevel: 'error' } : {}),
    }, state.activities.list());
  }

  /** Droid's `compacting_conversation` working state is the only signal of context compaction; it carries no token counts. */
  private trackCompaction(state: DroidConversation, previous: string): void {
    const compacting = state.working === 'compacting_conversation';
    if (compacting && previous !== 'compacting_conversation' && !state.compaction) {
      const id = activityId('droid', `compaction:${Date.now().toString(36)}-${++state.compactions}`);
      state.compaction = id;
      state.activities.apply({ id, kind: 'compaction', status: 'running', title: '上下文压缩', startedAt: new Date().toISOString(), compaction: { trigger: 'auto' } });
    } else if (!compacting) {
      this.endCompaction(state);
    }
  }

  private endCompaction(state: DroidConversation): void {
    const id = state.compaction;
    if (!id) return;
    state.compaction = undefined;
    const current = state.activities.get(id);
    if (current) state.activities.apply({ ...current, status: 'completed' });
  }

  /** A `fireAndForget` Execute that started its process: a background task that Droid gives no way to stop or to hear back from. */
  private trackBackgroundShell(state: DroidConversation, toolUseId: string, content: unknown, isError: boolean): void {
    const call = state.events.get(`tool:${toolUseId}`);
    const input = record(call?.data.rawInput);
    if (call?.data.toolName !== 'Execute' || input?.fireAndForget !== true) return;
    const started = droidFireAndForgetResult(content, isError);
    if (!started) return;
    const command = str(input.command), summary = str(input.summary);
    const activity = droidBackgroundActivity(toolUseId, { ...(command ? { command } : {}), ...(summary ? { summary } : {}) }, started, new Date().toISOString());
    if (started.pid) this.watchBackground(state);
    state.activities.apply(activity);
  }

  /**
   * Droid never reports the end of a `fireAndForget` command, so its process id is the evidence: once the
   * operating system has no such process, the command is over (its exit code is not known).
   */
  private watchBackground(state: DroidConversation): void {
    if (state.backgroundWatch) return;
    const watch = setInterval(() => {
      const live = state.activities.live().filter(activity => /^droid:bg:\d+$/.test(activity.id));
      if (!live.length || state.disposed) { clearInterval(watch); if (state.backgroundWatch === watch) state.backgroundWatch = undefined; return; }
      for (const activity of live) {
        const ended = droidBackgroundEnd(activity);
        if (ended) state.activities.apply({ ...activity, status: ended });
      }
    }, 5_000);
    watch.unref();
    state.backgroundWatch = watch;
  }

  private emitStatus(state: DroidConversation): void {
    if (state.disposed) return;
    try { state.session = this.host.getSession(state.workbenchSessionId); } catch { /* deleted; keep the last record */ }
    state.status = this.statusOf(state);
    notify(state, { type: 'status', status: state.status });
    this.scheduleIdleStop(state);
  }

  /** Remembers events whose identity is new, forgetting the oldest beyond the limit; returns the new ones. */
  private keep(state: DroidConversation, events: NativeWorkbenchEvent[]): NativeWorkbenchEvent[] {
    const fresh: NativeWorkbenchEvent[] = [];
    for (const event of events) {
      if (state.events.has(event.nativeId)) continue;
      state.events.set(event.nativeId, event);
      fresh.push(event);
    }
    this.noteSubagents(state, fresh);
    for (const id of state.events.keys()) {
      if (state.events.size <= REMEMBERED_EVENTS) break;
      state.events.delete(id);
    }
    return fresh;
  }

  private noteSeq(state: DroidConversation, seq: number | undefined): void {
    if (seq === undefined || (state.lastSeq !== undefined && seq <= state.lastSeq)) return;
    state.lastSeq = seq;
  }

  private handleNotification(state: DroidConversation, proc: DroidProcess, notification: Record<string, unknown>): void {
    if (state.proc !== proc) return;
    switch (notification.type) {
      case 'droid_working_state_changed': {
        const previous = state.working;
        state.working = str(notification.newState) ?? 'idle';
        this.trackCompaction(state, previous);
        this.emitStatus(state);
        return;
      }
      case 'create_message':
        this.handleMessage(state, notification);
        return;
      case 'assistant_text_delta':
      case 'thinking_text_delta':
        this.handleDelta(state, notification);
        return;
      case 'tool_result':
        this.handleToolResult(state, notification);
        return;
      case 'child_session_available': {
        const toolCallId = str(notification.toolUseId);
        const childId = str(notification.childSessionId);
        if (toolCallId && childId) this.registerSubagent(state, toolCallId, childId, true, str(notification.subagentType));
        return;
      }
      case 'session_compacted':
        this.endCompaction(state);
        void this.refreshContext(state);
        return;
      case 'session_token_usage_changed': {
        const usage = record(notification.lastCallTokenUsage);
        if (usage) {
          const next = { inputTokens: finite(usage.inputTokens), outputTokens: finite(usage.outputTokens), cacheReadTokens: finite(usage.cacheReadTokens), cacheCreationTokens: finite(usage.cacheCreationTokens) };
          const previous = state.lastCallUsage;
          state.lastCallUsage = next;
          if (!previous || previous.inputTokens !== next.inputTokens || previous.outputTokens !== next.outputTokens || previous.cacheReadTokens !== next.cacheReadTokens || previous.cacheCreationTokens !== next.cacheCreationTokens) void this.refreshContext(state);
        }
        return;
      }
      case 'session_title_updated':
        if (notification.updateType === 'llm_generated') {
          this.patchSession(state, generatedTitlePatch(this.host.getSession(state.workbenchSessionId), str(notification.title), state.firstMessage));
        }
        return;
      case 'settings_updated': {
        const reported = readSettings(notification.settings);
        const acknowledgement = proc.settingsRequests.get(str(notification.requestId) ?? '');
        if (acknowledgement) acknowledgement.reported = reported;
        if (!acknowledgement && state.configuring === 0 && proc.pinnedModelId && reported.modelId && reported.modelId !== proc.pinnedModelId) {
          state.reported = { ...state.reported, ...reported };
          this.haltModelDrift(state, proc, reported.modelId);
          return;
        }
        const changed = (reported.modelId !== undefined && reported.modelId !== state.reported?.modelId)
          || (reported.reasoningEffort !== undefined && reported.reasoningEffort !== state.reported?.reasoningEffort);
        this.adoptReportedSettings(state, reported);
        if (changed && state.configuring === 0) void this.refreshContext(state);
        return;
      }
      case 'agent_turn_completed':
        this.handleTurnEnd(state, notification);
        return;
      case 'permission_resolved': {
        const requestId = str(notification.requestId);
        const index = state.pending.findIndex(item => item.rpcId === requestId);
        if (index >= 0) {
          state.pending.splice(index, 1)[0]!.resolve(DROID_NO_REPLY);
          this.emitStatus(state);
        }
        return;
      }
      default:
    }
  }

  private handleMessage(state: DroidConversation, notification: Record<string, unknown>): void {
    const message = messageFromProtocol(notification.message);
    if (!message) return;
    this.noteSeq(state, message.seq);
    const providerNotice = droidProviderNotice(message);
    if (providerNotice && state.proc) {
      state.proc.providerNotice = providerNotice;
      if (state.proc.modelMismatch) {
        state.failure = `${state.proc.modelMismatch} ${providerNotice}`;
        this.emitStatus(state);
      }
    }
    if (message.role === 'user' && !isHiddenMessage(message) && message.visibility !== 'user_only') {
      const requestId = str(notification.requestId) ?? '';
      const command = state.commands.get(requestId) ?? this.takeLateCommand(state, requestId);
      if (command) {
        state.commands.delete(requestId);
        state.turns.set(message.id, { commandId: command.commandId, runId: command.runId });
      }
      state.activeTurn = message.id;
      state.turnActive = true;
      const events = this.keep(state, projectDroidMessage(message, {
        sessionId: state.workbenchSessionId,
        ...(command ? { commandId: command.commandId, runId: command.runId, ...(command.attachments ? { attachments: command.attachments } : {}) } : {}),
      }));
      const text = firstHumanMessage(events);
      if (text) {
        state.firstMessage ??= text;
        this.patchSession(state, firstMessageTitlePatch(this.host.getSession(state.workbenchSessionId), text));
      }
      if (events.length) wake(state);
      return;
    }
    const turn = state.activeTurn ? state.turns.get(state.activeTurn) : undefined;
    this.keep(state, projectDroidMessage(message, { sessionId: state.workbenchSessionId, ...(turn ? { runId: turn.runId } : {}) }));
    for (const [key, block] of state.drafts) if (block.messageId === message.id) state.drafts.delete(key);
    if (message.role === 'assistant') this.settleStep(state, message.id);
    wake(state);
  }

  private handleDelta(state: DroidConversation, notification: Record<string, unknown>): void {
    const messageId = str(notification.messageId);
    const delta = str(notification.textDelta);
    if (!messageId || !delta) return;
    const now = Date.now();
    const step = state.steps.get(messageId) ?? { ...(state.activeTurn ? { turnId: state.activeTurn } : {}), text: '', startedAt: now, lastAt: now };
    step.text += delta;
    step.lastAt = now;
    state.steps.set(messageId, step);
    this.publishStep(state, messageId, step, true);
    const blockIndex = typeof notification.blockIndex === 'number' && Number.isSafeInteger(notification.blockIndex) && notification.blockIndex >= 0 ? notification.blockIndex : 0;
    const key = `${messageId}:${blockIndex}:${String(notification.type)}`;
    const block = state.drafts.get(key) ?? { messageId, blockIndex, thought: notification.type === 'thinking_text_delta', text: '', at: new Date(now).toISOString() };
    block.text += delta;
    state.drafts.set(key, block);
    wake(state);
  }

  private handleToolResult(state: DroidConversation, notification: Record<string, unknown>): void {
    const toolUseId = str(notification.toolUseId);
    const messageId = str(notification.messageId);
    if (!toolUseId || !messageId) return;
    if (state.toolMessage?.id !== messageId) {
      const seq = (state.lastSeq ?? -1) + 1;
      state.toolMessage = { id: messageId, seq };
      this.noteSeq(state, seq);
    }
    const tool = state.toolMessage;
    const turn = state.activeTurn ? state.turns.get(state.activeTurn) : undefined;
    const event = droidToolResultEvent({ seq: tool.seq, createdAt: new Date().toISOString() }, {
      toolUseId,
      content: notification.content,
      isError: notification.isError === true,
    }, { sessionId: state.workbenchSessionId, ...(turn ? { runId: turn.runId } : {}) });
    if (event) this.keep(state, [event]);
    const subagent = state.subagents.get(toolUseId);
    if (subagent?.running) this.finishSubagent(state, subagent);
    wake(state);
    this.trackBackgroundShell(state, toolUseId, notification.content, notification.isError === true);
  }

  private handleTurnEnd(state: DroidConversation, notification: Record<string, unknown>): void {
    const turnId = str(notification.turnId) ?? state.activeTurn;
    const reason = state.proc?.modelMismatch ? 'model_changed' : str(notification.reason) ?? 'completed';
    const turn = turnId ? state.turns.get(turnId) : undefined;
    for (const [messageId] of state.steps) this.settleStep(state, messageId);
    // A turn Droid ended before it wrote the user message (a refused model, say) never names its
    // command; its run would otherwise wait for a receipt that is not coming. Later commands stay
    // bound: an interrupted turn can end after the message that replaces it was sent.
    const sawPrompt = turnId !== undefined && state.events.has(droidUserEventId(turnId));
    const oldest = turn || sawPrompt ? undefined : state.commands.entries().next().value;
    if (oldest) {
      state.commands.delete(oldest[0]);
      this.endUnechoed(state, [oldest], reason === 'completed' ? 'error' : reason);
    }
    wake(state);
    for (const item of state.subagents.values()) {
      // A background child outlives the turn that started it; its own outcome settles it.
      if (item.running && !item.background) this.finishSubagent(state, item);
    }
    this.recordChildUsage(state, turnId, notification);
    state.drafts.clear();
    state.turnActive = state.commands.size > 0;
    state.activeTurn = undefined;
    state.toolMessage = undefined;
    dropPending(state);
    const proc = state.proc;
    const deferred = state.deferred;
    if (proc && deferred && !proc.stopping && !proc.modelMismatch) {
      // A setter can wait for native compaction. Queue the entire application behind the same
      // session lock as send/configure so an older setter cannot land after a newer dispatch.
      void this.host.withSessionLock(state.workbenchSessionId, async () => {
        if (state.disposed || state.proc !== proc || proc.exited || proc.stopping || proc.modelMismatch || state.deferred !== deferred || state.turnActive) return;
        if (this.contextBudgetChanged(proc, deferred)) {
          if (this.hasActiveWork(state)) return;
          await this.stop(state, proc);
        } else {
          const change = settingsChange(state.reported, deferred);
          if (change) await this.applySettings(state, proc, change, deferred);
        }
        if (state.deferred === deferred) state.deferred = undefined;
      }).catch(error => { state.failure = errorMessage(error); this.emitStatus(state); });
    }
    this.emitStatus(state);
    void this.refreshContext(state);
  }

  /**
   * Follows a change Droid made itself: "always allow" raises autonomy, and leaving spec mode
   * switches to the autonomy the user picked on the plan card.
   */
  private adoptReportedSettings(state: DroidConversation, reported: Partial<DroidSettings>): void {
    state.reported = { ...state.reported, ...reported };
    // The CLI still reports the settings of its in-flight turn after a picker change was saved.
    // Keep that observation for the eventual diff, without undoing the deferred desired settings.
    if (state.configuring > 0 || state.deferred) return;
    const session = this.host.getSession(state.workbenchSessionId);
    const patch: Partial<Session> = {};
    if (reported.autonomyLevel && reported.autonomyLevel !== droidAutonomy(session.approval)) patch.approval = reported.autonomyLevel;
    if (reported.interactionMode) {
      const mode = reported.interactionMode === 'spec' ? 'spec' : 'agent';
      if (mode !== droidMode(session.mode)) patch.mode = mode;
    }
    const selected = parseNativeModelSelection(session.model);
    if (reported.modelId || reported.reasoningEffort) {
      const model = reported.modelId ?? selected.model;
      const effort = reported.reasoningEffort ?? nativeModelEffort(selected);
      const next = droidModelValue(model, effort, selected.params.context === 'long' ? LONG_CONTEXT_REQUEST : undefined);
      if (next !== session.model) patch.model = next;
    }
    if (!Object.keys(patch).length) return;
    state.session = this.host.bumpConfig(state.workbenchSessionId, patch);
    notify(state, { type: 'session', session: state.session });
    this.emitStatus(state);
  }

  private haltModelDrift(state: DroidConversation, proc: DroidProcess, actualModelId: string): void {
    if (proc.modelMismatch) return;
    proc.modelMismatch = `Droid changed the requested model from ${proc.pinnedModelId} to ${actualModelId}. The turn was stopped; the selected model was preserved.`;
    state.failure = `${proc.modelMismatch}${proc.providerNotice ? ` ${proc.providerNotice}` : ''}`;
    this.emitStatus(state);
    void this.stop(state, proc).catch(error => {
      state.failure = `${state.failure} ${errorMessage(error)}`;
      this.emitStatus(state);
    });
  }

  private async handleRequest(state: DroidConversation, proc: DroidProcess, method: string, params: Record<string, unknown>, rpcId: string): Promise<unknown> {
    if (state.proc !== proc) throw new Error('This Droid process is no longer attached to the workbench');
    if (proc.stopping || proc.modelMismatch) throw new Error('Droid is stopping; no further tool or user guidance will be accepted');
    const id = `droid:${state.nativeSessionId ?? state.workbenchSessionId}:${rpcId}`;
    let interaction: NativeInteraction;
    if (method === 'droid.request_permission') {
      interaction = permissionInteraction(id, rpcId, params);
      if (!interaction.actions.length) return { selectedOption: 'cancel' };
    } else if (method === 'droid.ask_user') {
      const questions = askUserQuestions(params);
      if (!questions.length) return { cancelled: true, answers: [] };
      interaction = questionInteraction(id, rpcId, questions, 0);
    } else {
      throw new Error(`Unsupported Droid request: ${method}`);
    }
    return await new Promise<unknown>(resolvePromise => {
      state.pending.push({ rpcId, method, params, interaction, questionIndex: 0, answers: [], resolve: resolvePromise });
      this.emitStatus(state);
    });
  }

  /**
   * Registers the children that projected `Task` results name, in the conversation or in a
   * subagent's own transcript (whose calls are not resident).
   */
  private noteSubagents(state: DroidConversation, events: readonly NativeWorkbenchEvent[]): void {
    for (const event of events) {
      if (event.type !== 'tool_call_update') continue;
      const toolCallId = str(event.data.toolCallId);
      const childId = str(record(event.data.subagentResult)?.agentId);
      if (!toolCallId || !childId || state.subagents.has(toolCallId)) continue;
      const call = events.find(item => item.type === 'tool_call' && item.data.toolCallId === toolCallId) ?? state.events.get(`tool:${toolCallId}`);
      this.registerSubagent(state, toolCallId, childId, false, undefined, record(call?.data.subagent));
    }
  }

  /** `call` is the spawning call's `subagent` data; a live child's call is resident in the conversation. */
  private registerSubagent(state: DroidConversation, toolCallId: string, childId: string, running: boolean, subagentType?: string, call = record(state.events.get(`tool:${toolCallId}`)?.data.subagent)): void {
    try { validateDroidSessionId(childId); } catch { return; }
    let item = state.subagents.get(toolCallId);
    if (!item) {
      const type = subagentType ?? str(call?.type);
      item = { toolCallId, childId, background: call?.background === true, running: false, lastChangeAt: Date.now(), ...(type ? { subagentType: type } : {}) };
      state.subagents.set(toolCallId, item);
      while (state.subagents.size > SUBAGENT_LIMIT) {
        const items = [...state.subagents.values()];
        const evicted = items.filter(entry => !entry.running).sort((left, right) => left.lastChangeAt - right.lastChangeAt)[0] ?? items[0]!;
        state.subagents.delete(evicted.toolCallId);
      }
      this.scheduleSubagents(state);
    }
    if (running && !item.running) {
      item.running = true;
      this.scheduleSubagents(state);
      notify(state, { type: 'subagent', toolCallId, agentId: childId, running: true });
    }
    if (state.subagents.has(toolCallId)) void this.syncSubagent(state, item);
  }

  /** Keeps exactly one child poll per conversation, and only while one of its children runs. */
  private scheduleSubagents(state: DroidConversation): void {
    const running = !state.disposed && [...state.subagents.values()].some(item => item.running);
    if (running && !state.subagentTimer) {
      state.subagentTimer = setInterval(() => {
        for (const item of state.subagents.values()) if (item.running) void this.syncSubagent(state, item);
      }, SUBAGENT_POLL_MS);
      state.subagentTimer.unref();
    } else if (!running && state.subagentTimer) {
      clearInterval(state.subagentTimer);
      state.subagentTimer = undefined;
    }
  }

  /** The child stopped (its result arrived, or the turn ended): one last read settles its page. */
  private finishSubagent(state: DroidConversation, item: DroidSubagent): void {
    item.running = false;
    this.scheduleSubagents(state);
    // Budget changes are applied on the next send; finishing a child must never stop its parent.
    this.scheduleIdleStop(state);
    void (async () => {
      await item.syncing?.catch(() => undefined);
      await this.syncSubagent(state, item);
      notify(state, { type: 'subagent', toolCallId: item.toolCallId, agentId: item.childId, running: false });
    })();
  }

  /** Children live beside their parent's session file. */
  private async childPath(state: DroidConversation, childId: string): Promise<string | undefined> {
    if (!state.nativeSessionId) return undefined;
    const parent = await findDroidTranscript(state.nativeSessionId, state.project.cwd);
    return parent ? join(dirname(parent), `${childId}.jsonl`) : undefined;
  }

  /** Reads a child's session file: the subagents it started in turn, and whether a background child is done. Its lane reads the same file. */
  private async syncSubagent(state: DroidConversation, item: DroidSubagent): Promise<void> {
    if (item.syncing) return await item.syncing;
    const task = (async () => {
      const path = await this.childPath(state, item.childId);
      const transcript = path ? await readDroidTranscript(path, item.childId).catch(() => undefined) : undefined;
      if (!transcript || state.subagents.get(item.toolCallId) !== item) return;
      item.lastChangeAt = Date.now();
      wake(state);
      this.noteSubagents(state, transcript.chain.slice(-RECENT_MESSAGES).flatMap(message => projectDroidMessage(message, { sessionId: state.workbenchSessionId })));
      if (item.running && item.background && childTurnEnded(transcript)) this.finishSubagent(state, item);
    })();
    item.syncing = task;
    try { await task; } finally { if (item.syncing === task) item.syncing = undefined; }
  }

  /** Droid reports what a turn's subagents spent only in total, at the end of the turn. */
  private recordChildUsage(state: DroidConversation, turnId: string | undefined, notification: Record<string, unknown>): void {
    const usage = record(notification.childTokenUsage);
    const outputTokens = finite(usage?.outputTokens);
    if (!turnId || !usage || !outputTokens) return;
    const endedAt = Date.now();
    const durationMs = finite(notification.durationMs);
    try {
      this.host.stats.recordUsage(state.workbenchSessionId, state.turns.get(turnId)?.runId, {
        stepId: `${turnId}:subagents`,
        agentKind: 'subagent',
        ...(durationMs !== undefined ? { startedAt: endedAt - durationMs } : {}),
        endedAt,
        tokenSource: 'provider',
        outputTokens,
        ...(finite(usage.inputTokens) !== undefined ? { inputTokens: finite(usage.inputTokens) } : {}),
        ...(finite(usage.cacheReadTokens) !== undefined ? { cacheReadTokens: finite(usage.cacheReadTokens) } : {}),
        ...(finite(usage.cacheCreationTokens) !== undefined ? { cacheWriteTokens: finite(usage.cacheCreationTokens) } : {}),
        ...(finite(usage.thinkingTokens) !== undefined ? { reasoningTokens: finite(usage.thinkingTokens) } : {}),
      });
    } catch { /* statistics must never affect the stream */ }
  }

  private async refreshContext(state: DroidConversation, required = false): Promise<void> {
    const proc = state.proc;
    if (!proc || proc.exited || proc.stopping) {
      if (required) throw new AppError('NATIVE_CONTEXT_BUDGET_UNCONFIRMED', 'Droid stopped before confirming the effective context budget.', 503);
      return;
    }
    const sequence = ++proc.contextRefreshSequence;
    try {
      const breakdown = await proc.rpc.request<Record<string, unknown>>('droid.get_context_breakdown', {}, { timeoutMs: 15_000 });
      if (state.proc !== proc || proc.exited || proc.stopping) {
        if (required) throw new AppError('NATIVE_CONTEXT_BUDGET_UNCONFIRMED', 'Droid changed processes before confirming the effective context budget.', 503);
        return;
      }
      const size = finite(breakdown.contextBudget);
      if (size === undefined || size <= 0) {
        if (required) throw new AppError('NATIVE_CONTEXT_BUDGET_UNCONFIRMED', 'Droid did not report an effective context budget; the long-context request was not confirmed.', 503);
        return;
      }
      if (sequence !== proc.contextRefreshSequence) return;
      // usedTokens/categories estimate message characters. The native compaction meter instead
      // uses the last call's measured input/cache/output total; it may legitimately exceed budget.
      const used = finite(breakdown.lastCallCompactionTokens);
      if (used === undefined || used < 0) {
        state.context = undefined;
        notify(state, { type: 'context' });
        return;
      }
      const context: NativeContext = {
        used,
        size,
        limitKind: 'compaction',
        breakdownEstimated: true,
        breakdown: (Array.isArray(breakdown.categories) ? breakdown.categories : []).flatMap(item => {
          const category = record(item);
          const label = str(category?.name);
          const tokens = finite(category?.tokens);
          if (!label || tokens === undefined) return [];
          return [{ id: str(category?.colorKey) ?? label.toLowerCase().replace(/\W+/g, '-'), label, tokens }];
        }),
      };
      state.context = context;
      notify(state, { type: 'context', context });
    } catch (error) {
      if (required) throw error;
      // The meter keeps its last value during ordinary background refreshes.
    }
  }

  private metricsFor(state: DroidConversation, runId: string | undefined, key: string): RunMetricsTracker {
    return runTracker(state.metrics, runId ?? key, { runId }, {
      emit: message => notify(state, message), save: (id, run) => this.host.saveRunMetrics(id, run),
    });
  }

  private publishStep(state: DroidConversation, messageId: string, step: DroidStep, live: boolean, outputTokens?: number): void {
    const range = measuredWindow({ streamStart: step.startedAt, streamEnd: step.lastAt, fallbackStart: step.startedAt });
    if (!range) return;
    const runId = step.turnId ? state.turns.get(step.turnId)?.runId : undefined;
    this.metricsFor(state, runId, `turn:${step.turnId ?? messageId}`).update({
      stepId: messageId,
      text: step.text,
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...range,
      live,
    }, !live);
  }

  /** Publishes a finished assistant message once, with the count Droid reported just before committing it. */
  private settleStep(state: DroidConversation, messageId: string): void {
    const step = state.steps.get(messageId);
    if (!step) return;
    state.steps.delete(messageId);
    const usage = state.lastCallUsage;
    state.lastCallUsage = undefined;
    this.publishStep(state, messageId, step, false, usage?.outputTokens);
    const range = measuredWindow({ streamStart: step.startedAt, streamEnd: step.lastAt, fallbackStart: step.startedAt });
    if (!range) return;
    const provider = usage?.outputTokens !== undefined;
    const outputTokens = provider ? usage!.outputTokens! : Math.max(0, Math.round(estimateTokens(step.text)));
    if (!provider && !step.text.trim()) return;
    try {
      this.host.stats.recordUsage(state.workbenchSessionId, step.turnId ? state.turns.get(step.turnId)?.runId : undefined, {
        stepId: messageId,
        ...(state.reported?.modelId ? { model: state.reported.modelId } : {}),
        startedAt: range.startedAt,
        endedAt: range.endedAt,
        window: range.window,
        tokenSource: provider ? 'provider' : 'estimated',
        outputTokens,
        ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      });
    } catch { /* statistics must never affect the stream */ }
  }
}

function notify(state: DroidConversation, message: NativeControlMessage): void {
  for (const listener of state.listeners) {
    try { listener(message); } catch { /* one subscriber must not stop the others */ }
  }
}

/** The transcript moved: whoever reads it into the journal reads again. */
function wake(state: DroidConversation): void {
  for (const waker of state.wakers) {
    try { waker(); } catch { /* one reader must not stop the others */ }
  }
}

/** Whether a child's latest prompt has an outcome, i.e. it is not working on anything. */
function childTurnEnded(transcript: DroidTranscript): boolean {
  const prompt = transcript.chain.findLast(isDroidPrompt);
  return Boolean(prompt && transcript.outcomes.has(prompt.id));
}

const runtimes = new WeakMap<NativeBackendHost, DroidRuntime>();

export function getDroidRuntime(host: NativeBackendHost): DroidRuntime {
  let runtime = runtimes.get(host);
  if (!runtime) {
    runtime = new DroidRuntime(host);
    runtimes.set(host, runtime);
  }
  return runtime;
}

export async function closeDroidRuntime(host: NativeBackendHost): Promise<void> {
  const runtime = runtimes.get(host);
  runtimes.delete(host);
  await runtime?.close();
}
