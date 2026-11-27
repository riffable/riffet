import { readContextFile } from '../../context-references/read-file.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AgentDiscussionRequest } from '@riffet/plugin-api/experimental/agent';
import {
  isNativeBackendId,
  MODEL_CHAT_BUDGET,
  MODEL_CHAT_DEFAULT_CONFIG,
  type AuxiliaryModelRef,
  type ModelChatConfig,
  type ModelChatConfigPatch,
  type ModelChatEffort,
  type ModelChatLiveStream,
  type ModelChatMetrics,
  type ModelChatNode,
  type ModelChatPinnedDoc,
  type ModelChatResponseFormat,
  type ModelChatSendRequest,
  type ModelChatStreamEvent,
  type ModelChatTreeSnapshot,
  type ModelChatWireRecord,
  type ModelConfigOption,
  type ModelInfo,
  type NativeBackendCapabilities,
  type NativeBackendId,
  type NativeInteraction,
  type NativeInteractionResult,
  type NativeStatus,
  type QuickChatPreset,
  type Session,
} from '../../../../../packages/contracts/src/index.js';
import { join, resolve, sep } from 'node:path';
import { AppError } from '../../errors.js';
import {
  acceptsPart,
  AUXILIARY_MODEL_BACKENDS,
  complete,
  gatewayEfforts,
  gatewayProtocol,
  redactSensitiveText,
  streamChat,
  type ChatEffort,
  type ChatPart,
  type ChatStreamResult,
  type GatewayEndpoint,
  type WirePreparedSnapshot,
} from '../../auxiliary/gateway.js';
import { decodePreviewText } from '../../previews/formats.js';
import { parseNativeModelSelection, type NativeModelSelection } from '../shared/model-selection.js';
import { auxiliaryEndpoint, profileModelEndpoint, listAuxiliaryModels, type GatewayProfiles } from '../../auxiliary/models.js';
import type { AuxiliaryCallRecorder } from '../../auxiliary/telemetry.js';
import type { LaneWriter, TranscriptSource } from '../../journal/ingest.js';
import { estimatedTokens, estimateTokens } from '../../metrics/tokens.js';
import { measuredWindow } from '../../metrics/turn-metrics.js';
import { chatDiscussionInstructions, historyCompactionPrompt, quickChatSystemPrompt } from '../../prompts/index.js';
import { firstMessageTitlePatch } from '../../session-title.js';
import type {
  NativeBackendAvailability, NativeBackendConfigurePatch, NativeBackendConfigureResult, NativeBackendDriver, NativeBackendHost,
  NativeBackendOpenResult, NativeBackendProfileConfig, NativeBackendSendRequest, NativeBackendTraits, NativeControlMessage, NativeShareTranscript,
  NativeDriverStored,
} from '../types.js';
import {
  activePathOf,
  activeRecordsOf,
  answerEvent,
  answerEventId,
  appendRecord,
  assembleContext,
  buildChatTree,
  contextOf,
  readRecords,
  recordEvents,
  resolveEffectiveParentId,
  withAttachmentNames,
  type ChatAttachment,
  type ChatRecord,
  type ChatTreeNode,
  type ChatTreeState,
  type ChatTurnStatus,
  type TurnRecord,
} from './history.js';
import type { BackendCatalog } from '../catalog.js';
import { runAgentDiscussion } from './discussion.js';

/*
 * Model Chat (docs/QUICK-CHAT.md): a direct LLM workbench conversation. No CLI runs; the server
 * calls a gateway a Claude, DSH or Codex profile already holds credentials for, and keeps the
 * conversation as an append-only message tree in its own JSONL file (`history.ts`), whose active
 * branch the journal projects linearly like any transcript.
 */

const BACKEND_ID: NativeBackendId = 'chat';
const PROFILE_ID = 'default';
const MAX_OUTPUT_TOKENS = 8_192;
/** What earlier turns may cost in legacy/side-chat mode; the oldest go first. */
const CONTEXT_TOKENS = 48_000;
const IDLE_TIMEOUT_MS = 120_000;
/** Streamed text reaches the journal at most this often. */
const DRAFT_INTERVAL_MS = 150;
/** What a summary of dropped turns may be; the turns it replaces were worth far more. */
const SUMMARY_TOKENS = 1_500;
/** Maximum redacted Wire snapshots retained per session on disk. */
const MAX_WIRE_FILES_PER_SESSION = 50;
/** The plain conversation, without a preset. */
export const PLAIN_MODE = 'agent';
const PRESET_MODE = 'preset:';
/** A text file is sent inline up to this many characters; the rest is cut with a note. */
const TEXT_ATTACHMENT_CHARS = 200_000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** A chat model's value: the gateway model behind one backend profile, `<backend>:<profile>:<model>`, with `[effort=…,fast=…,search=…]` for its switches. */
export function chatModelValue(ref: AuxiliaryModelRef): string { return `${ref.backendId}:${ref.profileId}:${ref.model}`; }

const EFFORTS: readonly ChatEffort[] = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'adaptive'];
const MODEL_CHAT_EFFORTS = new Set<ModelChatEffort>(['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'adaptive']);
const MODEL_CHAT_STRATEGIES = new Set(['summary', 'window', 'full', 'stateless']);

export interface ChatModelRef extends AuxiliaryModelRef { search: boolean; effort?: ChatEffort; fast: boolean }

export function chatModelRef(value: string | undefined, discussion = false): ChatModelRef | undefined {
  const selection: NativeModelSelection = parseNativeModelSelection(value);
  const match = /^([^:]+):([^:]+):(.*)$/.exec(selection.model);
  if (!match || !isNativeBackendId(match[1]) || match[1] === 'chat') return undefined;
  if (discussion && !gatewayProtocol(match[1])) {
    // Native catalogs own the entire selector, including bracket parameters and provider namespaces.
    const model = value!.trim().slice(match[1].length + match[2]!.length + 2);
    return { backendId: match[1], profileId: match[2]!, model, search: false, fast: false };
  }
  if (!match[3] || !AUXILIARY_MODEL_BACKENDS.includes(match[1])) return undefined;
  const effort = EFFORTS.find(level => level === selection.params.effort);
  return { backendId: match[1] as NativeBackendId, profileId: match[2]!, model: match[3]!, search: selection.params.search === 'true', ...(effort ? { effort } : {}), fast: selection.params.fast === 'true' };
}

/** The stored spelling of a ref: only switches its gateway honours, so a stale one cannot linger. */
function chatSelection(ref: ChatModelRef): string {
  const params = [
    ...(ref.effort ? [`effort=${ref.effort}`] : []),
    ...(ref.fast && fastens(ref.backendId) ? ['fast=true'] : []),
    ...(ref.search && searches(ref.backendId) ? ['search=true'] : []),
  ];
  return params.length ? `${chatModelValue(ref)}[${params.join(',')}]` : chatModelValue(ref);
}

/** Only these gateways run a search themselves; any other model answers from what it knows. */
const searches = (backendId: NativeBackendId) => { const protocol = gatewayProtocol(backendId); return protocol === 'anthropic' || protocol === 'responses'; };
/** OpenAI's priority tier exists only on the Responses API. */
const fastens = (backendId: NativeBackendId) => gatewayProtocol(backendId) === 'responses';
/** `default` sends nothing, so a model that cannot think is not asked to. */
const EFFORT_OPTION: ModelConfigOption = {
  id: 'effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: 'default',
  options: [{ value: 'default', name: 'Default' }, ...['low', 'medium', 'high'].map(level => ({ value: level, name: level }))],
};
const FAST_OPTION: ModelConfigOption = {
  id: 'fast', name: 'Fast', category: 'model_config', type: 'select', currentValue: 'false',
  options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'On' }],
};
const SEARCH_OPTION: ModelConfigOption = {
  id: 'search', name: 'Web search', category: 'model_config', type: 'select', currentValue: 'false',
  options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'On' }],
};

export interface ChatBackendOptions {
  stateDir: string;
  gatewayProfiles: GatewayProfiles;
  catalog: Pick<BackendCatalog, 'validateProfile' | 'discussionRunner' | 'validateDiscussionModel'>;
  /** `auxiliaryModels.chat`, read on every use. */
  defaultModel(): AuxiliaryModelRef | undefined;
  /** Without a default, the model and switches of the latest chat other than `exceptSessionId`. */
  latestModel?(exceptSessionId: string): string | undefined;
  /** `quickChat.presets` in effect, read on every use. */
  presets(): readonly QuickChatPreset[];
  fetchImpl?: typeof fetch;
  recordAuxiliaryCall?: AuxiliaryCallRecorder;
}

type AgentDiscussionRunner = (request: AgentDiscussionRequest) => Promise<void>;
type ChatEndpoint = GatewayEndpoint | AgentDiscussionRunner;
type DiscussionRoute = Pick<AgentDiscussionRequest, 'sourceSessionId' | 'sourceAttachment'>;

/** One answer being written (up to `MODEL_CHAT_BUDGET.maxCompareModels` concurrently per session). */
interface Live {
  turnId: string;
  runId: string;
  assistantId: string;
  parentId: string;
  modelSelection: string;
  model?: string;
  compareGroupId?: string;
  text: string;
  reasoning: string;
  startedAt: string;
  abort: AbortController;
  done: Promise<void>;
}

export const CHAT_TRAITS: NativeBackendTraits = {
  // `/clear` is answered by the driver itself: writing it is its delivery and its completion.
  settlesSlashOnSubmit: true,
  // The answer's end is recorded before the status goes idle, but read after; only the record settles a run.
  completesOnTurnEvent: true,
};

export class ChatBackendAdapter implements NativeBackendDriver {
  readonly stored: NativeDriverStored = {
    readOnly: true,
    context: (host, session, profile, options) => this.readContextTranscript(host, session, profile, options),
    share: (host, session) => this.readShareTranscript(host, session),
  };
  readonly id = BACKEND_ID;
  readonly label = '模型对话';
  readonly traits = CHAT_TRAITS;
  /** Live streams per session, keyed by `assistantId`. */
  private readonly live = new Map<string, Map<string, Live>>();
  private readonly drafts = new Map<string, NodeJS.Timeout>();
  /** SSE subscribers per session for tree events (`delta`, `turn_done`, `tree_updated`). */
  private readonly treeListeners = new Map<string, Set<(event: ModelChatStreamEvent) => void>>();
  /** At most one background history summary per session; dispose waits for its writer before deleting history. */
  private readonly summaries = new Map<string, { abort: AbortController; done: Promise<void> }>();
  /** Sessions currently being disposed; prevents late background summaries from resurrecting deleted `.jsonl` files. */
  private readonly disposing = new Set<string>();
  private readonly lifetime = new AbortController();

  constructor(private readonly options: ChatBackendOptions) {}

  private async endpoint(model: AuxiliaryModelRef, discussion: boolean, signal?: AbortSignal): Promise<ChatEndpoint> {
    if (!discussion) return auxiliaryEndpoint(model, this.options.gatewayProfiles, signal);
    const profile = this.options.catalog.validateProfile(model.backendId, model.profileId);
    const run = !gatewayProtocol(model.backendId) && this.options.catalog.discussionRunner(profile);
    if (run) {
      await this.options.catalog.validateDiscussionModel(profile, model.model, model.model);
      return run;
    }
    try { return await profileModelEndpoint(model, profile, signal); }
    catch { throw new AppError('DISCUSSION_PROVIDER_UNAVAILABLE', 'The model provider is unavailable for side chats', 409); }
  }

  private file(sessionId: string): string { return join(this.options.stateDir, 'chat', `${encodeURIComponent(sessionId)}.jsonl`); }

  private safeWireSegment(value: string, field: string): string {
    if (!value || value.length > 200 || /[\0/\\]/.test(value) || value === '.' || value === '..') {
      throw new AppError('INVALID_INPUT', `Invalid ${field}`, 400);
    }
    return encodeURIComponent(value);
  }

  private wireRoot(): string { return resolve(this.options.stateDir, 'chat', 'wire'); }

  private wireDir(sessionId: string): string {
    const root = this.wireRoot();
    const dir = resolve(root, this.safeWireSegment(sessionId, 'sessionId'));
    if (!dir.startsWith(`${root}${sep}`)) throw new AppError('INVALID_INPUT', 'Invalid sessionId', 400);
    return dir;
  }

  private wireFile(sessionId: string, assistantId: string): string {
    const dir = this.wireDir(sessionId);
    const file = resolve(dir, `${this.safeWireSegment(assistantId, 'assistantId')}.json`);
    if (!file.startsWith(`${dir}${sep}`)) throw new AppError('INVALID_INPUT', 'Invalid assistantId', 400);
    return file;
  }

  private saveWire(sessionId: string, wire: ModelChatWireRecord): void {
    const dir = this.wireDir(sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = this.wireFile(sessionId, wire.assistantId);
    let payload = JSON.stringify(wire);
    if (Buffer.byteLength(payload, 'utf8') > MODEL_CHAT_BUDGET.maxWireBytes) {
      const compact: ModelChatWireRecord = {
        ...wire,
        body: {
          ...(typeof wire.body.model === 'string' ? { model: wire.body.model } : {}),
          truncated: true,
        },
        truncated: true,
      };
      payload = JSON.stringify(compact);
    }
    writeFileSync(file, payload, { mode: 0o600 });
    try {
      const entries = readdirSync(dir)
        .filter(name => name.endsWith('.json'))
        .map(name => {
          const full = join(dir, name);
          let mtimeMs = 0;
          try { mtimeMs = statSync(full).mtimeMs; } catch { /* ignore */ }
          return { full, mtimeMs };
        });
      if (entries.length > MAX_WIRE_FILES_PER_SESSION) {
        entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const stale of entries.slice(MAX_WIRE_FILES_PER_SESSION)) {
          try { unlinkSync(stale.full); } catch { /* ignore */ }
        }
      }
    } catch { /* pruning is best-effort */ }
  }

  getWire(sessionId: string, assistantId: string): ModelChatWireRecord | undefined {
    let file: string;
    try { file = this.wireFile(sessionId, assistantId); } catch { return undefined; }
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as ModelChatWireRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return undefined;
    }
  }

  private addLive(sessionId: string, live: Live): void {
    let map = this.live.get(sessionId);
    if (!map) { map = new Map(); this.live.set(sessionId, map); }
    map.set(live.assistantId, live);
  }

  private removeLive(sessionId: string, live: Live): void {
    const map = this.live.get(sessionId);
    if (!map) return;
    if (map.get(live.assistantId) === live) map.delete(live.assistantId);
    if (map.size === 0) {
      this.live.delete(sessionId);
      clearTimeout(this.drafts.get(sessionId));
      this.drafts.delete(sessionId);
    }
  }

  private hasLive(sessionId: string): boolean {
    const map = this.live.get(sessionId);
    return Boolean(map && map.size > 0);
  }

  private liveStreamsOf(sessionId: string): ModelChatLiveStream[] {
    const map = this.live.get(sessionId);
    if (!map || map.size === 0) return [];
    const streams: ModelChatLiveStream[] = [];
    for (const item of map.values()) {
      streams.push({
        assistantId: item.assistantId,
        parentId: item.parentId,
        turnId: item.turnId,
        runId: item.runId,
        modelSelection: item.modelSelection,
        ...(item.model ? { model: item.model } : {}),
        ...(item.compareGroupId ? { compareGroupId: item.compareGroupId } : {}),
        text: item.text,
        reasoning: item.reasoning,
        startedAt: item.startedAt,
      });
    }
    return streams;
  }

  subscribeTree(sessionId: string, listener: (event: ModelChatStreamEvent) => void): () => void {
    let set = this.treeListeners.get(sessionId);
    if (!set) { set = new Set(); this.treeListeners.set(sessionId, set); }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.treeListeners.get(sessionId) === set) this.treeListeners.delete(sessionId);
    };
  }

  private emitTree(sessionId: string, event: ModelChatStreamEvent): void {
    const listeners = this.treeListeners.get(sessionId);
    if (!listeners || listeners.size === 0) return;
    for (const listener of [...listeners]) {
      try { listener(event); } catch { /* a listener must not stop the others */ }
    }
  }

  getTree(sessionId: string, session?: Pick<Session, 'mode'>): ModelChatTreeSnapshot {
    const records = readRecords(this.file(sessionId));
    const tree = buildChatTree(records, MODEL_CHAT_DEFAULT_CONFIG);
    const assembled = assembleContext(tree, { defaultSystemPrompt: this.instructions(session?.mode) });
    const nodes: ModelChatNode[] = tree.nodes.map(node => {
      if (node.kind === 'user' && node.rootFork) {
        const { rootFork: _rootFork, ...rest } = node;
        return rest;
      }
      return node;
    });
    return {
      sessionId,
      ...(tree.activeLeafId !== undefined ? { activeLeafId: tree.activeLeafId } : {}),
      config: tree.config,
      pinnedDocs: tree.pinnedDocs,
      summary: tree.summary,
      nodes,
      tokenBreakdown: assembled.tokenBreakdown,
      liveStreams: this.liveStreamsOf(sessionId),
    };
  }

  validateConfigPatch(patch: ModelChatConfigPatch): void {
    this.parseConfigPatch(patch);
  }

  private parseConfigPatch(patch: ModelChatConfigPatch): {
    hasConfigPatch: boolean;
    configPatch: Record<string, unknown>;
    validatedDocs: ModelChatPinnedDoc[] | undefined;
    validatedSummary: string | undefined;
  } {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new AppError('INVALID_INPUT', 'Config patch must be an object', 400);
    }
    const raw = patch as Record<string, unknown>;
    const configPatch: Record<string, unknown> = {};
    let hasConfigPatch = false;

    if ('systemPrompt' in raw && raw.systemPrompt !== undefined) {
      if (typeof raw.systemPrompt !== 'string' || raw.systemPrompt.length > 200_000) {
        throw new AppError('INVALID_INPUT', 'systemPrompt must be a string up to 200000 characters', 400);
      }
      configPatch.systemPrompt = raw.systemPrompt;
      hasConfigPatch = true;
    }
    if ('bareMode' in raw && raw.bareMode !== undefined) {
      if (typeof raw.bareMode !== 'boolean') throw new AppError('INVALID_INPUT', 'bareMode must be a boolean', 400);
      configPatch.bareMode = raw.bareMode;
      hasConfigPatch = true;
    }
    if ('effort' in raw && raw.effort !== undefined) {
      if (typeof raw.effort !== 'string' || !MODEL_CHAT_EFFORTS.has(raw.effort as ModelChatEffort)) {
        throw new AppError('INVALID_INPUT', 'Unsupported reasoning effort', 400);
      }
      configPatch.effort = raw.effort;
      hasConfigPatch = true;
    }
    if ('thinkingBudget' in raw) {
      if (raw.thinkingBudget === null || raw.thinkingBudget === undefined) {
        configPatch.thinkingBudget = null;
        hasConfigPatch = true;
      } else if (typeof raw.thinkingBudget === 'number' && Number.isInteger(raw.thinkingBudget) && raw.thinkingBudget >= 0 && raw.thinkingBudget <= 128_000) {
        configPatch.thinkingBudget = raw.thinkingBudget;
        hasConfigPatch = true;
      } else {
        throw new AppError('INVALID_INPUT', 'thinkingBudget must be an integer between 0 and 128000', 400);
      }
    }
    if ('temperature' in raw) {
      if (raw.temperature === null || raw.temperature === undefined) {
        configPatch.temperature = null;
        hasConfigPatch = true;
      } else if (typeof raw.temperature === 'number' && Number.isFinite(raw.temperature) && raw.temperature >= 0 && raw.temperature <= 2) {
        configPatch.temperature = raw.temperature;
        hasConfigPatch = true;
      } else {
        throw new AppError('INVALID_INPUT', 'temperature must be a number between 0 and 2', 400);
      }
    }
    if ('topP' in raw) {
      if (raw.topP === null || raw.topP === undefined) {
        configPatch.topP = null;
        hasConfigPatch = true;
      } else if (typeof raw.topP === 'number' && Number.isFinite(raw.topP) && raw.topP >= 0 && raw.topP <= 1) {
        configPatch.topP = raw.topP;
        hasConfigPatch = true;
      } else {
        throw new AppError('INVALID_INPUT', 'topP must be a number between 0 and 1', 400);
      }
    }
    if ('maxOutputTokens' in raw && raw.maxOutputTokens !== undefined) {
      if (typeof raw.maxOutputTokens !== 'number' || !Number.isInteger(raw.maxOutputTokens) || raw.maxOutputTokens < 1 || raw.maxOutputTokens > 200_000) {
        throw new AppError('INVALID_INPUT', 'maxOutputTokens must be an integer between 1 and 200000', 400);
      }
      configPatch.maxOutputTokens = raw.maxOutputTokens;
      hasConfigPatch = true;
    }
    if ('contextBudget' in raw && raw.contextBudget !== undefined) {
      if (typeof raw.contextBudget !== 'number' || !Number.isInteger(raw.contextBudget) || raw.contextBudget < 1_000 || raw.contextBudget > 2_000_000) {
        throw new AppError('INVALID_INPUT', 'contextBudget must be an integer between 1000 and 2000000', 400);
      }
      configPatch.contextBudget = raw.contextBudget;
      hasConfigPatch = true;
    }
    if ('contextStrategy' in raw && raw.contextStrategy !== undefined) {
      if (typeof raw.contextStrategy !== 'string' || !MODEL_CHAT_STRATEGIES.has(raw.contextStrategy)) {
        throw new AppError('INVALID_INPUT', 'Unsupported contextStrategy', 400);
      }
      configPatch.contextStrategy = raw.contextStrategy;
      hasConfigPatch = true;
    }
    if ('responseFormat' in raw && raw.responseFormat !== undefined) {
      configPatch.responseFormat = validateResponseFormat(raw.responseFormat);
      hasConfigPatch = true;
    }
    if ('webSearch' in raw && raw.webSearch !== undefined) {
      if (typeof raw.webSearch !== 'boolean') throw new AppError('INVALID_INPUT', 'webSearch must be a boolean', 400);
      configPatch.webSearch = raw.webSearch;
      hasConfigPatch = true;
    }
    if ('fast' in raw && raw.fast !== undefined) {
      if (typeof raw.fast !== 'boolean') throw new AppError('INVALID_INPUT', 'fast must be a boolean', 400);
      configPatch.fast = raw.fast;
      hasConfigPatch = true;
    }
    if ('promptCaching' in raw && raw.promptCaching !== undefined) {
      if (typeof raw.promptCaching !== 'boolean') throw new AppError('INVALID_INPUT', 'promptCaching must be a boolean', 400);
      configPatch.promptCaching = raw.promptCaching;
      hasConfigPatch = true;
    }
    if ('seed' in raw) {
      if (raw.seed === null || raw.seed === undefined) {
        configPatch.seed = null;
        hasConfigPatch = true;
      } else if (typeof raw.seed === 'number' && Number.isInteger(raw.seed)) {
        configPatch.seed = raw.seed;
        hasConfigPatch = true;
      } else {
        throw new AppError('INVALID_INPUT', 'seed must be an integer or null', 400);
      }
    }
    if ('stop' in raw) {
      if (raw.stop === null || raw.stop === undefined) {
        configPatch.stop = null;
        hasConfigPatch = true;
      } else if (Array.isArray(raw.stop) && raw.stop.length <= 16 && raw.stop.every(item => typeof item === 'string' && item.length <= 256)) {
        configPatch.stop = raw.stop;
        hasConfigPatch = true;
      } else {
        throw new AppError('INVALID_INPUT', 'stop must be an array of at most 16 short strings', 400);
      }
    }
    if ('compareModels' in raw) {
      if (raw.compareModels === null || raw.compareModels === undefined) {
        configPatch.compareModels = null;
        hasConfigPatch = true;
      } else if (Array.isArray(raw.compareModels) && raw.compareModels.length <= MODEL_CHAT_BUDGET.maxCompareModels && raw.compareModels.every(item => typeof item === 'string' && item.trim().length > 0)) {
        configPatch.compareModels = raw.compareModels.map(item => item.trim());
        hasConfigPatch = true;
      } else {
        throw new AppError('INVALID_INPUT', `compareModels may contain at most ${MODEL_CHAT_BUDGET.maxCompareModels} model selections`, 400);
      }
    }

    let validatedDocs: ModelChatPinnedDoc[] | undefined;
    if ('pinnedDocs' in raw && raw.pinnedDocs !== undefined) {
      if (!Array.isArray(raw.pinnedDocs)) throw new AppError('INVALID_INPUT', 'pinnedDocs must be an array', 400);
      if (raw.pinnedDocs.length > MODEL_CHAT_BUDGET.maxPinnedDocs) {
        throw new AppError('PINNED_DOCS_LIMIT', `At most ${MODEL_CHAT_BUDGET.maxPinnedDocs} pinned documents are allowed`, 400);
      }
      validatedDocs = raw.pinnedDocs.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AppError('INVALID_INPUT', 'Each pinnedDoc must be an object', 400);
        const doc = item as Record<string, unknown>;
        const name = typeof doc.name === 'string' ? doc.name.trim() : '';
        if (!name || name.length > 256) throw new AppError('INVALID_INPUT', 'Each pinnedDoc needs a short name', 400);
        if (typeof doc.text !== 'string') throw new AppError('INVALID_INPUT', 'Each pinnedDoc needs text', 400);
        if (doc.text.length > MODEL_CHAT_BUDGET.maxPinnedDocChars) {
          throw new AppError('PINNED_DOC_TOO_LARGE', `Pinned document "${name}" exceeds ${MODEL_CHAT_BUDGET.maxPinnedDocChars} characters`, 400);
        }
        const id = typeof doc.id === 'string' && doc.id.trim() ? doc.id.trim().slice(0, 128) : randomUUID();
        const pinned = doc.pinned === undefined ? true : Boolean(doc.pinned);
        const sourcePath = typeof doc.sourcePath === 'string' && doc.sourcePath.trim() ? doc.sourcePath.trim().slice(0, 1024) : undefined;
        return {
          id,
          name,
          text: doc.text,
          tokens: estimateTokens(doc.text),
          pinned,
          ...(sourcePath ? { sourcePath } : {}),
        };
      });
    }

    let validatedSummary: string | undefined;
    if ('summary' in raw && raw.summary !== undefined) {
      if (typeof raw.summary !== 'string') throw new AppError('INVALID_INPUT', 'summary must be a string', 400);
      if (raw.summary.length > MODEL_CHAT_BUDGET.maxSummaryChars) {
        throw new AppError('SUMMARY_TOO_LARGE', `Summary exceeds ${MODEL_CHAT_BUDGET.maxSummaryChars} characters`, 400);
      }
      validatedSummary = raw.summary;
    }

    return { hasConfigPatch, configPatch, validatedDocs, validatedSummary };
  }

  updateConfig(sessionId: string, patch: ModelChatConfigPatch, session?: Pick<Session, 'mode'>): ModelChatTreeSnapshot {
    const { hasConfigPatch, configPatch, validatedDocs, validatedSummary } = this.parseConfigPatch(patch);
    const at = new Date().toISOString();
    const file = this.file(sessionId);
    if (hasConfigPatch) {
      appendRecord(file, { kind: 'config_patch', id: randomUUID(), at, config: configPatch as Partial<ModelChatConfig> });
    }
    if (validatedDocs !== undefined) {
      appendRecord(file, { kind: 'pinned_docs', id: randomUUID(), at, docs: validatedDocs });
    }
    if (validatedSummary !== undefined) {
      appendRecord(file, { kind: 'summary', id: randomUUID(), at, upTo: '', text: validatedSummary, manual: true });
    }

    const snapshot = this.getTree(sessionId, session);
    this.emitTree(sessionId, { type: 'tree_updated', snapshot });
    return snapshot;
  }

  private resolveCompareTargets(
    primary: AuxiliaryModelRef & Partial<ChatModelRef>,
    primarySelection: string,
    compareModels: readonly string[] | undefined,
  ): Array<{ ref: AuxiliaryModelRef & Partial<ChatModelRef>; selection: string }> {
    const models: Array<{ ref: AuxiliaryModelRef & Partial<ChatModelRef>; selection: string }> = [
      { ref: primary, selection: primarySelection },
    ];
    for (const extra of compareModels ?? []) {
      if (models.length >= MODEL_CHAT_BUDGET.maxCompareModels) break;
      const ref = chatModelRef(extra);
      if (!ref) continue;
      const selection = chatSelection(ref);
      if (models.some(item => item.selection === selection)) continue;
      models.push({ ref, selection });
    }
    return models;
  }

  async sendTree(
    host: NativeBackendHost,
    sessionInput: Session,
    req: ModelChatSendRequest,
  ): Promise<{ snapshot: ModelChatTreeSnapshot; assistantIds: string[] }> {
    const sessionId = sessionInput.id;
    let session = host.getSession(sessionId);
    if (session.archivedAt) throw new AppError('ARCHIVED_SESSION', 'Restore this conversation before running it', 409);
    if (this.hasLive(sessionId)) throw new AppError('CLI_BUSY', 'The answer before is still being written', 409);
    if (!session.nativeSessionId) session = host.setNativeSessionId(sessionId, sessionId);

    const file = this.file(sessionId);
    const records = readRecords(file);
    const tree = buildChatTree(records, MODEL_CHAT_DEFAULT_CONFIG);
    const at = new Date().toISOString();

    // Resolve models (1..MODEL_CHAT_BUDGET.maxCompareModels).
    let models: Array<{ ref: AuxiliaryModelRef & Partial<ChatModelRef>; selection: string }> = [];
    if (req.models !== undefined) {
      if (!Array.isArray(req.models) || req.models.length === 0) {
        throw new AppError('INVALID_MODEL', 'Choose at least one model', 400);
      }
      if (req.models.length > MODEL_CHAT_BUDGET.maxCompareModels) {
        throw new AppError('COMPARE_MODEL_LIMIT', `At most ${MODEL_CHAT_BUDGET.maxCompareModels} models can run in parallel`, 400);
      }
      for (const rawSelection of req.models) {
        if (typeof rawSelection !== 'string' || !rawSelection.trim()) {
          throw new AppError('INVALID_MODEL', 'Choose a model from the list', 400);
        }
        const ref = chatModelRef(rawSelection);
        if (!ref) throw new AppError('INVALID_MODEL', `Unsupported model selection: ${rawSelection}`, 400);
        models.push({ ref, selection: chatSelection(ref) });
      }
    } else {
      const primary = this.resolveModel(session) ?? await listAuxiliaryModels(this.options.gatewayProfiles).then(options => options[0]);
      if (!primary) throw new AppError('CHAT_MODEL_UNAVAILABLE', 'No model is available; add a profile with an API endpoint first', 409);
      const primarySelection = session.model && chatModelRef(session.model) ? session.model : chatModelValue(primary);
      models = this.resolveCompareTargets(primary, primarySelection, tree.config.compareModels);
    }

    const compareGroupId = models.length > 1 ? randomUUID() : undefined;
    const attachmentIds = Array.isArray(req.attachmentIds) ? req.attachmentIds : [];

    // Case A: rerun an existing user turn (regenerate or compare with other models).
    if (req.rerunUserId !== undefined) {
      const targetUser = tree.nodes.find(node => node.id === req.rerunUserId);
      if (!targetUser || targetUser.kind !== 'user') {
        throw new AppError('TURN_NOT_FOUND', 'Target user turn does not exist', 404);
      }
      const rerunAttachmentIds = attachmentIds.length ? attachmentIds : (targetUser.attachments?.map(a => a.id) ?? []);
      const partsByModel = await Promise.all(
        models.map(item => rerunAttachmentIds.length
          ? this.readAttachments(host, rerunAttachmentIds, item.ref).then(list => list.map(f => f.part)).catch(() => [])
          : Promise.resolve<ChatPart[]>([])),
      );
      const turnId = `turn-${randomUUID()}`;
      const runId = randomUUID();
      const lives: Live[] = models.map(item => ({
        turnId,
        runId,
        assistantId: randomUUID(),
        parentId: targetUser.id,
        modelSelection: item.selection,
        model: item.ref.model,
        ...(compareGroupId ? { compareGroupId } : {}),
        text: '',
        reasoning: '',
        startedAt: at,
        abort: new AbortController(),
        done: Promise.resolve(),
      }));
      for (const live of lives) this.addLive(sessionId, live);
      const instructions = this.instructions(session.mode);
      lives.forEach((live, index) => {
        live.done = this.runModelAnswer(
          host,
          sessionId,
          live,
          tree,
          targetUser.text,
          models[index]!.ref,
          instructions,
          partsByModel[index]!,
          { rerunUserId: targetUser.id },
          undefined,
          false,
        );
      });
      try {
        host.recordActivity?.(sessionId, at);
        host.transcript?.wake(sessionId);
        host.emit(sessionId, { type: 'status', status: this.status(host, host.getSession(sessionId)) });
      } catch { /* best-effort status update */ }
      const snapshot = this.getTree(sessionId, session);
      this.emitTree(sessionId, { type: 'tree_updated', snapshot });
      return { snapshot, assistantIds: lives.map(item => item.assistantId) };
    }

    // Case B: new user turn (append, edit-fork, or `/clear`).
    const text = typeof req.text === 'string' ? req.text.trim() : '';
    const clear = /^\/clear\s*$/i.test(text) && !req.editedFrom && attachmentIds.length === 0;
    if (!clear && !text && attachmentIds.length === 0) {
      throw new AppError('INVALID_SUBMISSION', 'Message text or attachment is required', 400);
    }

    let resolvedParentId: string | undefined;
    let isRootFork = false;
    if (req.parentId !== undefined) {
      if (req.parentId === '') {
        resolvedParentId = undefined;
        isRootFork = true;
      } else {
        if (!tree.nodes.some(node => node.id === req.parentId)) {
          throw new AppError('NODE_NOT_FOUND', 'Parent node does not exist', 404);
        }
        resolvedParentId = req.parentId;
      }
    } else if (req.editedFrom !== undefined) {
      const original = tree.nodes.find(node => node.id === req.editedFrom);
      if (!original || original.kind !== 'user') {
        throw new AppError('NODE_NOT_FOUND', 'Original user node does not exist', 404);
      }
      resolvedParentId = resolveEffectiveParentId(records, original.id);
      if (resolvedParentId === undefined) isRootFork = true;
    } else {
      resolvedParentId = tree.activeLeafId;
    }

    if (req.editedFrom !== undefined && !tree.nodes.some(node => node.id === req.editedFrom && node.kind === 'user')) {
      throw new AppError('NODE_NOT_FOUND', 'Original user node does not exist', 404);
    }

    const commandId = typeof req.commandId === 'string' && req.commandId.trim() ? req.commandId.trim() : randomUUID();
    const runId = randomUUID();
    const turnId = `turn-${runId}`;

    if (clear) {
      appendRecord(file, {
        kind: 'clear',
        id: randomUUID(),
        ...(resolvedParentId !== undefined ? { parentId: resolvedParentId } : {}),
        turnId,
        runId,
        at,
        commandId,
      });
      await this.reprojectJournal(host, sessionId);
      const snapshot = this.getTree(sessionId, session);
      this.emitTree(sessionId, { type: 'tree_updated', snapshot });
      return { snapshot, assistantIds: [] };
    }

    // Validate attachments against every target model before persisting anything.
    const filesPerModel = await Promise.all(
      models.map(item => this.readAttachments(host, attachmentIds, item.ref)),
    );
    const attachments: ChatAttachment[] = filesPerModel[0]!.map(f => f.attachment);
    const userRecord: Extract<ChatRecord, { kind: 'user' }> = {
      kind: 'user',
      id: randomUUID(),
      ...(resolvedParentId !== undefined ? { parentId: resolvedParentId } : {}),
      ...(isRootFork ? { rootFork: true as const } : {}),
      turnId,
      runId,
      at,
      text,
      commandId,
      ...(attachments.length ? { attachments } : {}),
      ...(req.editedFrom !== undefined ? { editedFrom: req.editedFrom } : {}),
    };

    const lives: Live[] = models.map(item => ({
      turnId,
      runId,
      assistantId: randomUUID(),
      parentId: userRecord.id,
      modelSelection: item.selection,
      model: item.ref.model,
      ...(compareGroupId ? { compareGroupId } : {}),
      text: '',
      reasoning: '',
      startedAt: at,
      abort: new AbortController(),
      done: Promise.resolve(),
    }));

    for (const live of lives) this.addLive(sessionId, live);
    try {
      appendRecord(file, userRecord);
    } catch (error) {
      for (const live of lives) this.removeLive(sessionId, live);
      throw error;
    }

    const instructions = this.instructions(session.mode);
    const historyParentOption = resolvedParentId ?? '';
    lives.forEach((live, index) => {
      live.done = this.runModelAnswer(
        host,
        sessionId,
        live,
        tree,
        text,
        models[index]!.ref,
        instructions,
        filesPerModel[index]!.map(f => f.part),
        { parentId: historyParentOption },
        undefined,
        false,
      );
    });

    try {
      if (!records.some(record => record.kind === 'user')) {
        const patch = firstMessageTitlePatch(session, text);
        if (patch) host.emit(sessionId, { type: 'session', session: host.updateSession(sessionId, patch) });
      }
      host.recordActivity?.(sessionId, at);
      host.transcript?.wake(sessionId);
      host.emit(sessionId, { type: 'status', status: this.status(host, host.getSession(sessionId)) });
    } catch { /* title/status failure does not fail the answer */ }

    const snapshot = this.getTree(sessionId, session);
    this.emitTree(sessionId, { type: 'tree_updated', snapshot });
    return { snapshot, assistantIds: lives.map(item => item.assistantId) };
  }

  async stopStream(sessionId: string, assistantId?: string, session?: Pick<Session, 'mode'>): Promise<ModelChatTreeSnapshot> {
    const map = this.live.get(sessionId);
    if (map && map.size > 0) {
      if (assistantId) {
        const target = map.get(assistantId);
        if (target) {
          target.abort.abort();
          await target.done;
        }
      } else {
        const targets = [...map.values()];
        for (const item of targets) item.abort.abort();
        await Promise.all(targets.map(item => item.done));
      }
    }
    return this.getTree(sessionId, session);
  }

  async selectBranch(host: NativeBackendHost, sessionId: string, leafId: string): Promise<ModelChatTreeSnapshot> {
    const file = this.file(sessionId);
    const records = readRecords(file);
    const tree = buildChatTree(records, MODEL_CHAT_DEFAULT_CONFIG);
    if (!tree.nodes.some(node => node.id === leafId)) {
      throw new AppError('NODE_NOT_FOUND', 'Target branch node does not exist', 404);
    }
    appendRecord(file, { kind: 'branch_select', id: randomUUID(), at: new Date().toISOString(), leafId });
    await this.reprojectJournal(host, sessionId);
    let session: Session | undefined;
    try { session = host.getSession(sessionId); } catch { /* ignore */ }
    const snapshot = this.getTree(sessionId, session);
    this.emitTree(sessionId, { type: 'tree_updated', snapshot });
    return snapshot;
  }

  setTurnFlags(
    sessionId: string,
    userId: string,
    flags: { pinned?: boolean; muted?: boolean },
    session?: Pick<Session, 'mode'>,
  ): ModelChatTreeSnapshot {
    if (!flags || typeof flags !== 'object' || Array.isArray(flags)) {
      throw new AppError('INVALID_INPUT', 'Flags must be an object', 400);
    }
    if (flags.pinned !== undefined && typeof flags.pinned !== 'boolean') {
      throw new AppError('INVALID_INPUT', 'pinned must be a boolean', 400);
    }
    if (flags.muted !== undefined && typeof flags.muted !== 'boolean') {
      throw new AppError('INVALID_INPUT', 'muted must be a boolean', 400);
    }
    const file = this.file(sessionId);
    const records = readRecords(file);
    const tree = buildChatTree(records, MODEL_CHAT_DEFAULT_CONFIG);
    const target = tree.nodes.find(node => node.id === userId);
    if (!target || target.kind !== 'user') {
      throw new AppError('TURN_NOT_FOUND', 'User turn does not exist', 404);
    }
    appendRecord(file, {
      kind: 'turn_flag',
      id: randomUUID(),
      at: new Date().toISOString(),
      userId,
      ...(flags.pinned !== undefined ? { pinned: flags.pinned } : {}),
      ...(flags.muted !== undefined ? { muted: flags.muted } : {}),
    });
    const snapshot = this.getTree(sessionId, session);
    this.emitTree(sessionId, { type: 'tree_updated', snapshot });
    return snapshot;
  }

  async editAssistant(host: NativeBackendHost, sessionId: string, assistantId: string, text: string): Promise<ModelChatTreeSnapshot> {
    if (typeof text !== 'string') throw new AppError('INVALID_INPUT', 'text must be a string', 400);
    const file = this.file(sessionId);
    const records = readRecords(file);
    const tree = buildChatTree(records, MODEL_CHAT_DEFAULT_CONFIG);
    const target = tree.nodes.find(node => node.id === assistantId);
    if (!target || target.kind !== 'assistant') {
      throw new AppError('NODE_NOT_FOUND', 'Assistant message does not exist', 404);
    }
    appendRecord(file, { kind: 'assistant_edit', id: randomUUID(), at: new Date().toISOString(), targetId: assistantId, text });
    await this.reprojectJournal(host, sessionId);
    let session: Session | undefined;
    try { session = host.getSession(sessionId); } catch { /* ignore */ }
    const snapshot = this.getTree(sessionId, session);
    this.emitTree(sessionId, { type: 'tree_updated', snapshot });
    return snapshot;
  }

  private async reprojectJournal(host: NativeBackendHost, sessionId: string): Promise<void> {
    if (!host.transcript) return;
    await host.transcript.drain(sessionId).catch(() => undefined);
    host.transcript.wake(sessionId);
  }

  profiles(_host: NativeBackendHost): NativeBackendProfileConfig[] {
    const preferred = this.options.defaultModel();
    return [{ id: PROFILE_ID, backendId: BACKEND_ID, name: this.label, isDefault: true, config: preferred ? { defaultModel: chatModelValue(preferred) } : {} }];
  }

  /** Presets are the backend's modes, so every client's mode picker offers them and a chat remembers its own. */
  capabilities(): NativeBackendCapabilities {
    const presets = this.options.presets().map(preset => ({ id: `${PRESET_MODE}${preset.id}`, label: preset.name, description: preset.prompt }));
    // A chat takes files (`readAttachments`); images, PDFs and text, decided per model when sent.
    return {
      backendId: BACKEND_ID, label: this.label, modes: [{ id: PLAIN_MODE, label: '对话' }, ...presets], permissions: [], interactionTransport: 'none',
      supportsResume: true, supportsInterrupt: true, supportsHistory: true, supportsModelSelection: true,
      supportsModeSelection: true, supportsPermissionSelection: false, supportsTerminal: false, supportsPrewarm: false,
      slashCommands: [{ name: 'clear', description: 'Start over with an empty context' }],
    };
  }

  async available(): Promise<NativeBackendAvailability> {
    const any = AUXILIARY_MODEL_BACKENDS.some(backendId => { try { return this.options.gatewayProfiles(backendId).length > 0; } catch { return false; } });
    return any ? { available: true } : { available: false, reason: 'Add a Claude Code, DeepSeek Harness or Codex profile with an API endpoint first' };
  }

  normalizeModel(model: string): string { return model.trim(); }

  async listModels(): Promise<ModelInfo[]> {
    const options = await listAuxiliaryModels(this.options.gatewayProfiles);
    return options.map(option => ({
      value: chatModelValue(option), name: `${option.profileName} · ${option.model}`,
      configOptions: [{ ...EFFORT_OPTION }, ...(fastens(option.backendId) ? [{ ...FAST_OPTION }] : []), ...(searches(option.backendId) ? [{ ...SEARCH_OPTION }] : [])],
    }));
  }

  async openOrResume(host: NativeBackendHost, session: Session): Promise<NativeBackendOpenResult> {
    const current = session.nativeSessionId ? session : host.setNativeSessionId(session.id, session.id);
    return { nativeSessionId: current.nativeSessionId!, status: this.status(host, current) };
  }

  async send(host: NativeBackendHost, request: NativeBackendSendRequest): Promise<void> {
    const sessionId = request.session.id;
    if (this.hasLive(sessionId)) throw new AppError('CLI_BUSY', 'The answer before is still being written', 409);
    const session = request.session.nativeSessionId ? host.getSession(sessionId) : host.setNativeSessionId(sessionId, sessionId);
    const text = request.input.text.trim();
    const clear = /^\/clear\s*$/i.test(text);
    const records = readRecords(this.file(sessionId));
    const tree = buildChatTree(records, MODEL_CHAT_DEFAULT_CONFIG);
    const turnId = `turn-${request.runId}`, at = new Date().toISOString();
    // The model is settled before the fence too, so its files are judged against the gateway that will read them.
    const discussion = session.origin?.kind === 'discussion';
    const selectedModel = clear ? undefined : discussion ? chatModelRef(session.model, true) : this.resolveModel(session) ?? await listAuxiliaryModels(this.options.gatewayProfiles).then(options => options[0]);
    if (!clear && discussion && (!selectedModel || gatewayProtocol(selectedModel.backendId))) {
      const selection = parseNativeModelSelection(session.model);
      if (!selectedModel || selection.params.effort && selection.params.effort !== 'default' && !gatewayEfforts(gatewayProtocol(selectedModel.backendId)!).includes(selection.params.effort as ChatEffort)
          || selection.params.fast === 'true' && !fastens(selectedModel.backendId)) throw new AppError('DISCUSSION_PROVIDER_UNAVAILABLE', "This conversation's model configuration is unavailable for side chats", 409);
    }
    const model = session.origin?.kind === 'discussion' && selectedModel ? { ...selectedModel, search: false } : selectedModel;
    if (!clear && !model) throw new AppError('CHAT_MODEL_UNAVAILABLE', 'No model is available; add a profile with an API endpoint first', 409);
    const primarySelection = model ? (session.model && chatModelRef(session.model, discussion) ? session.model : chatModelValue(model)) : '';
    const targets = clear ? []
      : discussion ? [{ ref: model!, selection: primarySelection }]
      : this.resolveCompareTargets(model!, primarySelection, tree.config.compareModels);
    // Files are read and judged before the fence: one the model cannot take fails the send, and nothing is recorded.
    const filesPerModel = clear ? [] : await Promise.all(
      targets.map(item => this.readAttachments(host, request.input.attachmentIds, item.ref)),
    );
    const context = clear ? undefined : this.discussionContext(host, session);
    const inherited = context && model ? { endpoint: await this.endpoint(model, true), route: context.route } : undefined;
    const baseInstructions = clear ? '' : this.instructions(session.mode);
    request.commitDispatchFence({
      backendId: BACKEND_ID, nativeSessionId: session.nativeSessionId!, nativeTurnId: turnId, renderedText: text, slashCommand: clear,
      resolvedConfig: { mode: session.mode, ...(model ? { model: session.model ?? chatModelValue(model) } : {}) },
    });
    const parentId = tree.activeLeafId;
    if (clear) {
      appendRecord(this.file(sessionId), { kind: 'clear', id: randomUUID(), ...(parentId ? { parentId } : {}), turnId, runId: request.runId, at, commandId: request.commandId });
      host.transcript?.wake(sessionId);
      this.emitTree(sessionId, { type: 'tree_updated', snapshot: this.getTree(sessionId, session) });
      return;
    }
    const attachments: ChatAttachment[] = filesPerModel[0]!.map(file => file.attachment);
    const user: ChatRecord = { kind: 'user', id: randomUUID(), ...(parentId ? { parentId } : {}), turnId, runId: request.runId, at, text, commandId: request.commandId, ...(attachments.length ? { attachments } : {}) };
    const compareGroupId = targets.length > 1 ? randomUUID() : undefined;
    // Registered before the record exists, so no read can take the turn for one a restart left open.
    const lives: Live[] = targets.map(item => ({
      turnId,
      runId: request.runId,
      assistantId: randomUUID(),
      parentId: user.id,
      modelSelection: item.selection,
      model: item.ref.model,
      ...(compareGroupId ? { compareGroupId } : {}),
      text: '',
      reasoning: '',
      startedAt: at,
      abort: new AbortController(),
      done: Promise.resolve(),
    }));
    for (const live of lives) this.addLive(sessionId, live);
    try {
      appendRecord(this.file(sessionId), user);
    } catch (error) {
      // Nothing was recorded, so nothing is open: the send fails as a whole and the next one may go.
      for (const live of lives) this.removeLive(sessionId, live);
      throw error;
    }
    lives.forEach((live, index) => {
      live.done = this.runModelAnswer(
        host,
        sessionId,
        live,
        tree,
        text,
        targets[index]!.ref,
        baseInstructions,
        filesPerModel[index]!.map(file => file.part),
        { ...(context?.instructions ? { extraSystemPrompt: context.instructions } : {}) },
        index === 0 ? inherited : undefined,
        discussion,
      );
    });
    try {
      if (!records.some(record => record.kind === 'user')) {
        const patch = firstMessageTitlePatch(session, text);
        if (patch) host.emit(sessionId, { type: 'session', session: host.updateSession(sessionId, patch) });
      }
      host.transcript?.wake(sessionId);
      host.emit(sessionId, { type: 'status', status: this.status(host, host.getSession(sessionId)) });
      this.emitTree(sessionId, { type: 'tree_updated', snapshot: this.getTree(sessionId, session) });
    } catch { /* the answer is under way; a title or a status is not worth failing it */ }
  }

  /** The model of a turn: the conversation's own, else the configured default, else the latest chat's, else the first one any gateway serves. */
  private resolveModel(session: Session): (AuxiliaryModelRef & Partial<ChatModelRef>) | undefined {
    return chatModelRef(session.model) ?? this.options.defaultModel() ?? chatModelRef(this.options.latestModel?.(session.id));
  }

  /** The system prompt of a turn: the preset the chat is in follows the base instructions. A preset since removed leaves the plain chat. */
  private instructions(mode: string | undefined): string {
    const preset = mode?.startsWith(PRESET_MODE) ? this.options.presets().find(item => item.id === mode.slice(PRESET_MODE.length)) : undefined;
    return preset ? `${quickChatSystemPrompt()}\n\n${preset.prompt}` : quickChatSystemPrompt();
  }

  /** Source material stays outside the chat journal and is charged against every turn's budget. */
  private discussionContext(host: NativeBackendHost, session: Session) {
    if (session.origin?.kind !== 'discussion') return undefined;
    const source = session.origin.discussion;
    const blob = source && host.journal?.sessionBlob(session.id, source.contextRef);
    if (!source || !blob) throw new AppError('DISCUSSION_CONTEXT_UNAVAILABLE', 'The saved discussion context is unavailable', 409);
    const { sourceAttachment, sessionTitle, messages } = JSON.parse(blob.bytes().toString('utf8'));
    const route: DiscussionRoute = { sourceSessionId: session.origin.sessionId, sourceAttachment };
    const instructions = chatDiscussionInstructions({ snapshot: JSON.stringify({ sessionTitle, messages }), quote: JSON.stringify(source.quote.exact) });
    return { instructions, route };
  }

  /**
   * The uploads of a turn as the model takes them: an image as an image, a PDF as a document where the
   * gateway reads one, anything that decodes as text inline. Anything else is refused before the turn
   * starts, so the reader is told rather than the file silently left out.
   */
  private async readAttachments(host: NativeBackendHost, ids: readonly string[], model: AuxiliaryModelRef | undefined): Promise<Array<{ attachment: ChatAttachment; part: ChatPart }>> {
    const protocol = model ? gatewayProtocol(model.backendId) : undefined;
    const files: Array<{ attachment: ChatAttachment; part: ChatPart }> = [];
    for (const id of ids) {
      const { attachment: stored, data } = await host.readAttachment(id);
      const attachment: ChatAttachment = { id: stored.id, name: stored.name, mimeType: stored.mimeType,
        ...(stored.width ? { width: stored.width } : {}), ...(stored.height ? { height: stored.height } : {}) };
      let part: ChatPart | undefined;
      if (IMAGE_TYPES.has(stored.mimeType)) part = { type: 'image', mimeType: stored.mimeType, data: data.toString('base64') };
      else if (stored.mimeType === 'application/pdf' || data.subarray(0, 5).toString('latin1') === '%PDF-') part = { type: 'pdf', name: stored.name, data: data.toString('base64') };
      else {
        const text = decodePreviewText(data);
        if (text !== undefined) {
          const clipped = text.length > TEXT_ATTACHMENT_CHARS ? `${text.slice(0, TEXT_ATTACHMENT_CHARS)}\n[cut at ${TEXT_ATTACHMENT_CHARS} characters]` : text;
          part = { type: 'text', text: `<file name="${stored.name.replace(/"/g, "'")}">\n${clipped}\n</file>` };
        }
      }
      if (!part) throw new AppError('CHAT_ATTACHMENT_UNSUPPORTED', `${stored.name} cannot be read by a model; attach an image, a PDF or a text file`, 400);
      if (!protocol && part.type !== 'text') throw new AppError('CHAT_ATTACHMENT_UNSUPPORTED', 'This side chat accepts text attachments', 400);
      if (protocol && !acceptsPart(protocol, part.type)) throw new AppError('CHAT_ATTACHMENT_UNSUPPORTED', `This model cannot read ${stored.name}; choose a Claude or Codex model for PDFs`, 400);
      files.push({ attachment, part });
    }
    return files;
  }

  private async runModelAnswer(
    host: NativeBackendHost,
    sessionId: string,
    live: Live,
    tree: ChatTreeState,
    text: string,
    chosen: (AuxiliaryModelRef & Partial<ChatModelRef>) | undefined,
    defaultSystemPrompt: string,
    parts: ChatPart[],
    contextOptions: { parentId?: string; rerunUserId?: string; extraSystemPrompt?: string },
    inherited: { endpoint: ChatEndpoint; route: DiscussionRoute } | undefined,
    isDiscussion: boolean,
  ): Promise<void> {
    const startedAt = Date.now();
    let result: ChatStreamResult | undefined, status: ChatTurnStatus = 'completed', error: string | undefined;
    let system: string | undefined;
    let messages: Array<{ role: 'user' | 'assistant'; content: string; parts?: ChatPart[] }>;
    let dropped = 0;

    if (isDiscussion) {
      const fullSystem = [defaultSystemPrompt, contextOptions.extraSystemPrompt].filter(Boolean).join('\n\n');
      const legacyRecords = readRecords(this.file(sessionId)).filter(r => r.id !== live.parentId);
      const legacy = contextOf(legacyRecords, text, Math.max(0, CONTEXT_TOKENS - estimateTokens(fullSystem)));
      dropped = legacy.dropped;
      system = legacy.summary ? `${fullSystem}\n\n<earlier_conversation>\n${legacy.summary}\n</earlier_conversation>` : fullSystem;
      messages = parts.length ? [...legacy.messages.slice(0, -1), { ...legacy.messages.at(-1)!, parts }] : legacy.messages;
    } else {
      const assembled = assembleContext(tree, {
        defaultSystemPrompt,
        ...(contextOptions.extraSystemPrompt ? { extraSystemPrompt: contextOptions.extraSystemPrompt } : {}),
        nextUserText: text,
        ...(parts.length ? { nextUserParts: parts } : {}),
        ...(contextOptions.parentId !== undefined ? { parentId: contextOptions.parentId } : {}),
        ...(contextOptions.rerunUserId !== undefined ? { rerunUserId: contextOptions.rerunUserId } : {}),
      });
      system = assembled.system;
      messages = assembled.messages;
      dropped = assembled.dropped;
    }

    const model = chosen;
    const config = tree.config;
    let endpoint: ChatEndpoint | undefined;
    let authMs = 0;
    let firstTextAt: number | undefined;
    let firstDeltaAt: number | undefined;
    let lastDeltaAt: number | undefined;
    let requestStartedAt = startedAt;
    let savedWire: ModelChatWireRecord | undefined;

    try {
      if (!model) throw new Error('No model is available; add a profile with an API endpoint first');
      const authStartedAt = Date.now();
      endpoint = inherited?.endpoint ?? await auxiliaryEndpoint(model, this.options.gatewayProfiles, live.abort.signal);
      authMs = Math.max(0, Date.now() - authStartedAt);
      requestStartedAt = Date.now();
      const onDelta = (kind: 'text' | 'reasoning', piece: string) => {
        if (piece) {
          const now = Date.now();
          firstDeltaAt ??= now;
          lastDeltaAt = now;
          if (kind === 'text' && firstTextAt === undefined) firstTextAt = now;
        }
        if (kind === 'text') live.text += piece;
        else live.reasoning += piece;
        this.scheduleDraft(host, sessionId);
        if (piece) {
          this.emitTree(sessionId, { type: 'delta', assistantId: live.assistantId, parentId: live.parentId, kind, text: piece });
        }
      };

      const maxOutputTokens = isDiscussion ? MAX_OUTPUT_TOKENS : config.maxOutputTokens;
      const baseRequest = {
        messages,
        maxOutputTokens,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        signal: live.abort.signal,
        ...(system !== undefined ? { system } : {}),
      };

      if (typeof endpoint === 'function') {
        result = await runAgentDiscussion(endpoint, { ...baseRequest, system: system ?? '', ...inherited?.route, model: model.model, onDelta: piece => onDelta('text', piece) });
      } else {
        const effectiveEffort: ChatEffort | undefined = isDiscussion
          ? model.effort
          : (config.effort !== 'default' ? config.effort : model.effort);
        const effectiveSearch = !isDiscussion && Boolean(config.webSearch) && searches(model.backendId);
        const effectiveFast = (isDiscussion ? Boolean(model.fast) : Boolean(config.fast)) && fastens(model.backendId);
        const onWirePrepared = (wire: WirePreparedSnapshot) => {
          savedWire = {
            assistantId: live.assistantId,
            protocol: wire.protocol,
            endpoint: wire.endpoint,
            headers: wire.headers,
            body: wire.body,
            at: new Date().toISOString(),
            ...(wire.truncated ? { truncated: true } : {}),
          };
          try { this.saveWire(sessionId, savedWire); } catch { /* wire persistence never fails an answer */ }
        };
        result = await streamChat({
          ...endpoint,
          ...baseRequest,
          onDelta,
          ...(effectiveSearch ? { search: true } : {}),
          ...(effectiveEffort ? { effort: effectiveEffort } : {}),
          ...(inherited && endpoint.protocol === 'anthropic' ? { adaptiveThinking: true } : {}),
          ...(!isDiscussion && config.thinkingBudget !== undefined ? { thinkingBudget: config.thinkingBudget } : {}),
          ...(!isDiscussion && config.temperature !== undefined ? { temperature: config.temperature } : {}),
          ...(!isDiscussion && config.topP !== undefined ? { topP: config.topP } : {}),
          ...(!isDiscussion && config.seed !== undefined ? { seed: config.seed } : {}),
          ...(!isDiscussion && config.stop?.length ? { stop: config.stop } : {}),
          ...(!isDiscussion && config.responseFormat ? { responseFormat: config.responseFormat } : {}),
          ...(!isDiscussion ? { promptCaching: config.promptCaching } : {}),
          ...(effectiveFast ? { fast: true } : {}),
          onWirePrepared,
          ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        });
      }
    } catch (failure) {
      if (live.abort.signal.aborted) status = 'cancelled';
      else {
        status = 'failed';
        error = redactSensitiveText(failure instanceof Error ? failure.message : 'The model could not answer');
      }
    }
    // An answer the output budget stopped reads as whole but is not; it stays, marked as what it is.
    if (result?.cutOff) { status = 'interrupted'; error = 'The answer reached the output limit and was cut off'; }
    const endedAt = Date.now();
    const ttftMs = firstTextAt !== undefined ? Math.max(0, firstTextAt - requestStartedAt) : null;
    const durationMs = Math.max(0, endedAt - requestStartedAt);
    const metrics: ModelChatMetrics = {
      ...(endpoint && typeof endpoint !== 'function' ? { protocol: endpoint.protocol } : {}),
      authMs,
      ttftMs,
      durationMs,
      ...(result?.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
      ...(result?.cacheReadTokens !== undefined ? { cacheReadTokens: result.cacheReadTokens } : {}),
      ...(result?.cacheWriteTokens !== undefined ? { cacheWriteTokens: result.cacheWriteTokens } : {}),
      ...(result?.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
      ...(result?.reasoningTokens !== undefined ? { reasoningTokens: result.reasoningTokens } : {}),
      ...(result?.stopReason ? { stopReason: result.stopReason } : {}),
    };
    if (savedWire) {
      savedWire = { ...savedWire, metrics };
      try { this.saveWire(sessionId, savedWire); } catch { /* best-effort metrics update */ }
    }
    if (model && endpoint && status !== 'cancelled') {
      this.options.recordAuxiliaryCall?.({
        kind: 'chat', preset: 'stream', source: 'live',
        backendId: model.backendId, profileId: model.profileId, model: model.model,
        transport: (typeof endpoint === 'function' || endpoint.executeComplete || endpoint.executeStreamChat) ? 'cli-process' : 'http',
        ...(typeof endpoint !== 'function' ? { protocol: endpoint.protocol } : {}),
        ok: status === 'completed',
        authMs,
        ttftMs,
        durationMs,
        inputTokens: result?.inputTokens ?? null,
        outputTokens: result?.outputTokens ?? null,
        reasoningTokens: result?.reasoningTokens ?? null,
        reasoningChars: (result?.reasoning ?? live.reasoning).length,
        thinkingDetected: (result?.reasoningTokens ?? 0) > 0 || Boolean((result?.reasoning ?? live.reasoning).length),
        streaming: true,
        ...(status === 'completed' ? {} : { errorCode: result?.cutOff ? 'CUT_OFF' : 'ERROR' }),
      });
    }
    const answer = result?.text ?? live.text, reasoning = result?.reasoning ?? live.reasoning;
    try {
      appendRecord(this.file(sessionId), {
        kind: 'assistant',
        id: live.assistantId,
        parentId: live.parentId,
        turnId: live.turnId,
        runId: live.runId,
        at: new Date().toISOString(),
        text: answer,
        ...(reasoning ? { reasoning } : {}),
        status,
        ...(error ? { error } : {}),
        ...(result?.model ?? model?.model ? { model: result?.model ?? model!.model } : {}),
        ...(live.modelSelection ? { modelSelection: live.modelSelection } : {}),
        ...(dropped ? { dropped } : {}),
        ...(live.compareGroupId ? { compareGroupId: live.compareGroupId } : {}),
        ...(savedWire ? { wireBlobRef: live.assistantId } : {}),
        metrics,
      });
    } catch (failure) {
      // The turn cannot be recorded as ended; the journal ends it so its run settles and the chat is free again.
      void host.transcript?.endTurn(sessionId, live.turnId, 'failed', new Date().toISOString(), failure instanceof Error ? failure.message : 'The answer could not be saved');
    } finally {
      this.removeLive(sessionId, live);
    }
    if (answer || result) {
      const outputTokens = result?.outputTokens ?? estimatedTokens(answer + reasoning);
      const range = measuredWindow({
        streamStart: firstDeltaAt,
        streamEnd: lastDeltaAt,
        fallbackStart: requestStartedAt,
        outputTokens,
        now: endedAt,
      }) ?? { startedAt: requestStartedAt, endedAt, window: 'observed' as const };
      host.stats.recordUsage(sessionId, live.runId, {
        stepId: live.assistantId, ...(result?.model ?? model?.model ? { model: result?.model ?? model!.model } : {}),
        startedAt: range.startedAt, endedAt: range.endedAt, durationMs: Math.max(0, range.endedAt - range.startedAt),
        nativeMessageId: answerEventId(live.assistantId, 'text'),
        ...(result?.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        outputTokens,
        tokenSource: result?.outputTokens !== undefined ? 'provider' : 'estimated', window: range.window,
      });
    }
    host.transcript?.wake(sessionId);
    let currentSession: Session | undefined;
    try {
      currentSession = host.getSession(sessionId);
      host.emit(sessionId, { type: 'status', status: this.status(host, currentSession) });
    } catch { /* the conversation was deleted */ }
    this.emitTree(sessionId, {
      type: 'turn_done',
      assistantId: live.assistantId,
      status,
      ...(error ? { error } : {}),
      snapshot: this.getTree(sessionId, currentSession),
    });
    const latestTree = buildChatTree(readRecords(this.file(sessionId)), MODEL_CHAT_DEFAULT_CONFIG);
    const shouldSummarize = dropped > 0
      && status === 'completed'
      && model
      && (isDiscussion || config.contextStrategy === 'summary')
      && !tree.summaryManual
      && !latestTree.summaryManual
      && !this.disposing.has(sessionId)
      && !this.lifetime.signal.aborted
      && !this.summaries.has(sessionId);
    if (shouldSummarize) {
      const abort = new AbortController();
      const budget = isDiscussion ? CONTEXT_TOKENS : config.contextBudget;
      const done = this.summarize(sessionId, model, inherited?.route, budget, AbortSignal.any([abort.signal, this.lifetime.signal]))
        .catch(() => undefined).finally(() => this.summaries.delete(sessionId));
      this.summaries.set(sessionId, { abort, done });
    }
  }

  /**
   * Turns that no longer fit are condensed once, behind the answer, into a summary the next turns
   * start from; until it is written they are simply left out. The previous summary is folded in.
   */
  private async summarize(sessionId: string, model: AuxiliaryModelRef, route: DiscussionRoute | undefined, budget: number, signal: AbortSignal): Promise<void> {
    const file = this.file(sessionId);
    const records = readRecords(file);
    const tree = buildChatTree(records, MODEL_CHAT_DEFAULT_CONFIG);
    if (tree.summaryManual) return;
    const fullPath = activePathOf(tree.nodes, tree.activeLeafId);
    const clearIdx = fullPath.findLastIndex(node => node.kind === 'clear');
    let relevantPath = fullPath.slice(clearIdx + 1);
    let existingSummary = '';
    if (tree.summary.trim() && tree.summaryUpTo) {
      const coveredIdx = relevantPath.findIndex(node => node.id === tree.summaryUpTo);
      if (coveredIdx >= 0) {
        existingSummary = tree.summary.trim();
        relevantPath = relevantPath.slice(coveredIdx + 1);
      }
    }
    const turns: Array<{ end: string; user: string; assistant: string }> = [];
    let pendingUser: Extract<ChatTreeNode, { kind: 'user' }> | undefined;
    for (const node of relevantPath) {
      if (node.kind === 'user') pendingUser = node;
      else if (node.kind === 'assistant') {
        if (pendingUser && node.text.trim()) {
          turns.push({ end: node.id, user: withAttachmentNames(pendingUser), assistant: node.text });
        }
        pendingUser = undefined;
      }
    }
    // Keep the newest half of the budget verbatim; everything older is condensed.
    let kept = 0, spent = 0;
    while (kept < turns.length) {
      const turn = turns[turns.length - 1 - kept]!;
      spent += estimatedTokens(turn.user) + estimatedTokens(turn.assistant);
      if (spent > budget / 2) break;
      kept += 1;
    }
    const older = turns.slice(0, turns.length - kept);
    if (!older.length) return;
    const transcript = older.map(turn => `User: ${turn.user}\n\nAssistant: ${turn.assistant}`).join('\n\n---\n\n');
    const endpoint = await this.endpoint(model, Boolean(route), signal);
    const content = `${existingSummary ? `<summary_so_far>\n${existingSummary}\n</summary_so_far>\n\n` : ''}<conversation>\n${transcript.slice(-400_000)}\n</conversation>`;
    const system = historyCompactionPrompt(), maxOutputTokens = SUMMARY_TOKENS * 2;
    const result = typeof endpoint === 'function' ? await runAgentDiscussion(endpoint, {
      ...route, model: model.model, system, messages: [{ role: 'user', content }], maxOutputTokens,
      idleTimeoutMs: IDLE_TIMEOUT_MS, signal: AbortSignal.any([signal, AbortSignal.timeout(IDLE_TIMEOUT_MS)]), onDelta: () => {},
    }) : await complete({
      ...endpoint, system, maxOutputTokens, timeoutMs: IDLE_TIMEOUT_MS, content, signal,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });
    signal.throwIfAborted();
    if (this.disposing.has(sessionId)) return;
    const latest = buildChatTree(readRecords(file), MODEL_CHAT_DEFAULT_CONFIG);
    if (latest.summaryManual) return;
    const text = typeof result === 'string' ? result : result.cutOff ? '' : result.text;
    const clipped = text.trim().slice(0, MODEL_CHAT_BUDGET.maxSummaryChars);
    if (clipped) appendRecord(file, { kind: 'summary', id: randomUUID(), at: new Date().toISOString(), upTo: older.at(-1)!.end, text: clipped });
  }

  private scheduleDraft(host: NativeBackendHost, sessionId: string): void {
    if (this.drafts.has(sessionId)) return;
    const timer = setTimeout(() => { this.drafts.delete(sessionId); host.transcript?.wake(sessionId); }, DRAFT_INTERVAL_MS);
    timer.unref?.();
    this.drafts.set(sessionId, timer);
  }

  async interrupt(_host: NativeBackendHost, session: Session): Promise<void> {
    await this.stopStream(session.id, undefined, session);
  }

  async respond(): Promise<NativeInteractionResult> {
    throw new AppError('NATIVE_INTERACTION_GONE', 'A quick chat never asks for anything', 409);
  }

  async configure(_host: NativeBackendHost, session: Session, _profile: NativeBackendProfileConfig, patch: NativeBackendConfigurePatch): Promise<NativeBackendConfigureResult> {
    if (patch.mode !== undefined && !this.capabilities().modes.some(mode => mode.id === patch.mode)) throw new AppError('INVALID_MODE', 'Choose one of the quick chat presets', 400);
    if (patch.approval !== undefined) throw new AppError('INVALID_APPROVAL_MODE', 'A quick chat runs no tools', 400);
    const mode = patch.mode !== undefined ? { mode: patch.mode } : {};
    if (patch.model === undefined) return mode;
    const ref = chatModelRef(patch.model, session.origin?.kind === 'discussion');
    if (!ref) throw new AppError('INVALID_MODEL', 'Choose a model from the list', 400);
    if (session.origin?.kind === 'discussion') {
      const current = chatModelRef(session.model, true);
      const effort = parseNativeModelSelection(patch.model).params.effort;
      if (!current || current.backendId !== ref.backendId || current.profileId !== ref.profileId) throw new AppError('DISCUSSION_PROVIDER_UNAVAILABLE', 'A side chat keeps its provider', 409);
      if (!gatewayProtocol(ref.backendId)) {
        const profile = this.options.catalog.validateProfile(ref.backendId, ref.profileId);
        if (!this.options.catalog.discussionRunner(profile)) throw new AppError('DISCUSSION_PROVIDER_UNAVAILABLE', 'The model provider is unavailable for side chats', 409);
        const model = await this.options.catalog.validateDiscussionModel(profile, current.model, ref.model);
        return { ...mode, model: chatModelValue({ ...ref, model }) };
      }
      if (effort && effort !== 'default' && !gatewayEfforts(gatewayProtocol(ref.backendId)!).includes(effort as ChatEffort)) throw new AppError('INVALID_MODEL_PARAMETER', 'Unsupported reasoning effort');
      await this.endpoint(ref, true);
      ref.search = false;
    } else await auxiliaryEndpoint(ref, this.options.gatewayProfiles);
    return { ...mode, model: chatSelection(ref) };
  }

  transcript(host: NativeBackendHost, session: Session): TranscriptSource {
    return new ChatTranscriptSource(session.id, () => host.getSession(session.id).nativeSessionId ?? session.id, this.file(session.id), this.live);
  }

  private async readContextTranscript(_host: NativeBackendHost, session: Session, _profile: NativeBackendProfileConfig, options: { maxBytes: number; signal: AbortSignal }) {
    const content = await readContextFile(this.file(session.id), options.maxBytes, options.signal);
    const records: ChatRecord[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line) as ChatRecord); } catch { /* skip partial lines */ }
    }
    return activeRecordsOf(records).flatMap(record => recordEvents(session.id, record))
      .filter(event => event.type === 'user_message_chunk' || event.type === 'agent_message_chunk');
  }

  private async readShareTranscript(_host: NativeBackendHost, session: Session): Promise<NativeShareTranscript> {
    return { events: activeRecordsOf(readRecords(this.file(session.id))).flatMap(record => recordEvents(session.id, record)), subagents: [] };
  }

  interaction(): NativeInteraction | undefined { return undefined; }

  status(_host: NativeBackendHost, session: Session): NativeStatus {
    const map = this.live.get(session.id);
    if (!map || map.size === 0) return { phase: 'idle', ...(session.model ? { model: session.model } : {}) };
    const first = map.values().next().value!;
    return {
      phase: 'busy',
      activeTurnId: first.runId,
      activeTurn: { nativeSessionId: session.nativeSessionId ?? session.id, turnId: first.turnId, ownerRunId: first.runId },
      ...(session.model ? { model: session.model } : {}),
    };
  }

  subscribe(_host: NativeBackendHost, _session: Session, _profile: NativeBackendProfileConfig, _listener: (message: NativeControlMessage) => void): () => void {
    // Status goes out through `host.emit` as it changes; there is no provider to follow.
    return () => undefined;
  }

  async dispose(_host: NativeBackendHost, sessionId: string): Promise<void> {
    this.disposing.add(sessionId);
    try {
      clearTimeout(this.drafts.get(sessionId));
      this.drafts.delete(sessionId);
      for (;;) {
        const map = this.live.get(sessionId);
        const lives = map ? [...map.values()] : [];
        for (const live of lives) live.abort.abort();
        const summary = this.summaries.get(sessionId);
        summary?.abort.abort();
        if (lives.length === 0 && !summary) break;
        await Promise.all([...lives.map(live => live.done), summary?.done]);
      }
    } finally {
      this.disposing.delete(sessionId);
    }
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    for (const timer of this.drafts.values()) clearTimeout(timer);
    this.drafts.clear();
    this.treeListeners.clear();
    const open: Live[] = [];
    for (const map of this.live.values()) {
      for (const live of map.values()) {
        live.abort.abort();
        open.push(live);
      }
    }
    await Promise.all([...open.map(live => live.done), ...[...this.summaries.values()].map(summary => summary.done)]);
  }
}

function validateResponseFormat(value: unknown): ModelChatResponseFormat {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_INPUT', 'responseFormat must be an object', 400);
  }
  const obj = value as Record<string, unknown>;
  if (obj.type === 'text') return { type: 'text' };
  if (obj.type === 'json_object') return { type: 'json_object' };
  if (obj.type === 'json_schema') {
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name || name.length > 128) throw new AppError('INVALID_INPUT', 'json_schema responseFormat requires a short name', 400);
    if (!obj.schema || typeof obj.schema !== 'object' || Array.isArray(obj.schema)) {
      throw new AppError('INVALID_INPUT', 'json_schema responseFormat requires a schema object', 400);
    }
    const strict = obj.strict === undefined ? undefined : Boolean(obj.strict);
    return { type: 'json_schema', name, schema: structuredClone(obj.schema as Record<string, unknown>), ...(strict !== undefined ? { strict } : {}) };
  }
  throw new AppError('INVALID_INPUT', 'Unsupported responseFormat.type', 400);
}

function parseChatCursor(cursor: string | null): { count: number; lastId?: string; editCount?: number } {
  if (!cursor) return { count: 0 };
  if (/^\d+$/.test(cursor)) {
    const n = Number(cursor);
    return { count: Number.isSafeInteger(n) ? n : 0 };
  }
  const match = /^(\d+):([^:]*):(\d+)$/.exec(cursor);
  if (!match) return { count: 0 };
  const count = Number(match[1]);
  const editCount = Number(match[3]);
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(editCount)) return { count: 0 };
  return { count, lastId: match[2] || undefined, editCount };
}

/**
 * The chat file as the journal reads it. Projects only the active branch linearly into the journal;
 * when a branch switch or assistant edit diverges from what was already ingested, rebuilds the lane
 * under a fresh generation so timeline, search, and older clients stay consistent.
 */
class ChatTranscriptSource implements TranscriptSource {
  constructor(
    private readonly sessionId: string,
    private readonly nativeSessionId: () => string,
    private readonly file: string,
    private readonly live: ReadonlyMap<string, ReadonlyMap<string, Live>>,
  ) {}

  identity(): string { return this.nativeSessionId(); }

  async pull(w: LaneWriter): Promise<{ caughtUp: boolean }> {
    this.read(w);
    return { caughtUp: true };
  }

  async drain(w: LaneWriter): Promise<void> { this.read(w.scratch ?? w); }

  private read(w: LaneWriter): void {
    let records = readRecords(this.file);
    const sessionLive = this.live.get(this.sessionId);
    const liveTurnIds = new Set<string>();
    const liveParentIds = new Set<string>();
    if (sessionLive) {
      for (const item of sessionLive.values()) {
        liveTurnIds.add(item.turnId);
        liveParentIds.add(item.parentId);
      }
    }
    // A question this process is not answering was cut off by a restart (or a write that failed); each is closed where it stopped.
    const unanswered = records.filter((record, index): record is Extract<ChatRecord, { kind: 'user' }> =>
      record.kind === 'user'
      && !liveTurnIds.has(record.turnId)
      && !liveParentIds.has(record.id)
      && !records.slice(index + 1).some(later => later.kind === 'assistant' && (later.turnId === record.turnId || later.parentId === record.id)));
    for (const open of unanswered) {
      const closed: ChatRecord = {
        kind: 'assistant', id: randomUUID(), parentId: open.id, turnId: open.turnId,
        ...(open.runId ? { runId: open.runId } : {}),
        at: new Date().toISOString(), text: '', status: 'interrupted',
        error: 'Riffet restarted while the answer was being written',
      };
      appendRecord(this.file, closed);
      records = [...records, closed];
    }

    const tree = buildChatTree(records, MODEL_CHAT_DEFAULT_CONFIG);
    const active: TurnRecord[] = activePathOf(tree.nodes, tree.activeLeafId).map(node => {
      if (node.kind === 'user') {
        return {
          kind: 'user', id: node.id, ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
          turnId: node.turnId, ...(node.runId !== undefined ? { runId: node.runId } : {}),
          at: node.at, text: node.text, commandId: node.commandId,
          ...(node.attachments?.length ? { attachments: node.attachments } : {}),
          ...(node.editedFrom !== undefined ? { editedFrom: node.editedFrom } : {}),
        };
      }
      if (node.kind === 'clear') {
        return {
          kind: 'clear', id: node.id, ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
          turnId: node.turnId, ...(node.runId !== undefined ? { runId: node.runId } : {}),
          at: node.at, commandId: node.commandId,
        };
      }
      return {
        kind: 'assistant', id: node.id, ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
        turnId: node.turnId, ...(node.runId !== undefined ? { runId: node.runId } : {}),
        at: node.at, text: node.text, ...(node.reasoning !== undefined ? { reasoning: node.reasoning } : {}),
        status: node.status, ...(node.error !== undefined ? { error: node.error } : {}),
        ...(node.model !== undefined ? { model: node.model } : {}),
        ...(node.dropped !== undefined ? { dropped: node.dropped } : {}),
      };
    });

    const parsed = parseChatCursor(w.cursor);
    let next = parsed.count;
    const diverged = next > active.length
      || (next > 0 && parsed.lastId !== undefined && active[next - 1]?.id !== parsed.lastId)
      || (next > 0 && parsed.editCount !== undefined && parsed.editCount !== tree.editCount);
    if (diverged) {
      w.rebuild('identity-changed');
      next = 0;
    }

    const formatCursor = (count: number) => `${count}:${count > 0 ? active[count - 1]!.id : ''}:${tree.editCount}`;
    // A mark follows the rows it closes and precedes the cursor that passes it, so a read cut short redoes it.
    for (; next < active.length; next += 1) {
      const raw = active[next]!;
      const prev = next > 0 ? active[next - 1] : undefined;
      // When an assistant reply came from a `rerunUserId`, unify its turnId onto the paired user turn
      // so the original user turnId is always settled and never left hanging open in the journal.
      const record = raw.kind === 'assistant' && prev?.kind === 'user' && raw.turnId !== prev.turnId
        ? { ...raw, turnId: prev.turnId }
        : raw;
      w.turnStarted(record.turnId, record.at, record.runId);
      w.commit({ events: recordEvents(this.sessionId, record), cursor: formatCursor(next) });
      if (record.kind !== 'user') w.turnEnded(record.turnId, record.kind === 'clear' ? 'completed' : record.status, record.at, record.kind === 'clear' ? undefined : record.error);
      w.commit({ events: [], cursor: formatCursor(next + 1) });
    }

    const activeTail = active.at(-1);
    const activeTailId = activeTail?.id;
    let primaryLive: Live | undefined;
    if (sessionLive && sessionLive.size > 0) {
      for (const item of sessionLive.values()) {
        if (item.parentId === activeTailId) { primaryLive = item; break; }
      }
      primaryLive ??= sessionLive.values().next().value;
    }
    const draftTurnId = primaryLive && activeTail?.kind === 'user' && primaryLive.parentId === activeTail.id
      ? activeTail.turnId
      : primaryLive?.turnId;
    if (primaryLive && draftTurnId && (primaryLive.text || primaryLive.reasoning) && w.turnEndStatus(draftTurnId) === undefined) {
      const base = { sequence: 0, sessionId: this.sessionId, runId: primaryLive.runId, nativeTurnId: draftTurnId, createdAt: new Date().toISOString() };
      const drafts = [
        ...(primaryLive.reasoning ? [answerEvent(base, primaryLive.assistantId, 'reasoning', primaryLive.reasoning)] : []),
        ...(primaryLive.text ? [answerEvent(base, primaryLive.assistantId, 'text', primaryLive.text)] : []),
      ].map(event => ({ finalId: event.nativeId, event }));
      w.commit({ events: [], drafts, cursor: formatCursor(next) });
    }
  }
}

/** The directory of the project that holds every quick chat; nothing is ever written there. */
export function chatProjectCwd(stateDir: string): string { return join(stateDir, 'quick-chat'); }
