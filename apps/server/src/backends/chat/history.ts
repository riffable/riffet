import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  MODEL_CHAT_DEFAULT_CONFIG,
  type ModelChatConfig,
  type ModelChatMetrics,
  type ModelChatNode,
  type ModelChatPinnedDoc,
  type ModelChatTokenBreakdown,
  type NativeWorkbenchEvent,
} from '../../../../../packages/contracts/src/index.js';
import type { ChatMessage, ChatPart } from '../../auxiliary/gateway.js';
import { estimateTokens } from '../../metrics/tokens.js';

/*
 * A model chat's own record (docs/QUICK-CHAT.md): one JSONL file per conversation, appended and
 * never rewritten. Each turn record names its parent, forming an append-only message tree. Meta
 * records (`branch_select`, `turn_flag`, `assistant_edit`, `config_patch`, `pinned_docs`, `summary`)
 * overlay state onto the tree without rewriting prior lines.
 */

export type ChatTurnStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted';

interface RecordBase { id: string; parentId?: string; turnId: string; runId?: string; at: string }
export type ChatRecord =
  /** `attachments`: uploads the turn carried, read again from the workbench's store for every turn that sends them. */
  | RecordBase & { kind: 'user'; text: string; commandId: string; attachments?: ChatAttachment[]; editedFrom?: string; rootFork?: true }
  /** `dropped`: earlier turns the token budget left out of what the model saw. */
  | RecordBase & {
      kind: 'assistant';
      text: string;
      reasoning?: string;
      status: ChatTurnStatus;
      error?: string;
      model?: string;
      modelSelection?: string;
      dropped?: number;
      compareGroupId?: string;
      wireBlobRef?: string;
      metrics?: ModelChatMetrics;
    }
  | RecordBase & { kind: 'clear'; commandId: string }
  | { kind: 'summary'; id: string; at: string; upTo: string; text: string; manual?: boolean }
  | { kind: 'branch_select'; id: string; at: string; leafId: string }
  | { kind: 'turn_flag'; id: string; at: string; userId: string; pinned?: boolean; muted?: boolean }
  | { kind: 'assistant_edit'; id: string; at: string; targetId: string; text: string }
  | { kind: 'config_patch'; id: string; at: string; config: Partial<ModelChatConfig> }
  | { kind: 'pinned_docs'; id: string; at: string; docs: ModelChatPinnedDoc[] };

export type TurnRecord = Extract<ChatRecord, { kind: 'user' | 'assistant' | 'clear' }>;
export type ChatTreeNode =
  | (Extract<ModelChatNode, { kind: 'user' }> & { rootFork?: true })
  | Extract<ModelChatNode, { kind: 'assistant' }>
  | Extract<ModelChatNode, { kind: 'clear' }>;
export interface ChatAttachment { id: string; name: string; mimeType: string; width?: number; height?: number }

export function isTurnRecord(record: ChatRecord): record is TurnRecord {
  return record.kind === 'user' || record.kind === 'assistant' || record.kind === 'clear';
}

/**
 * Resolves the effective parent ID of `targetId` in `records`, staying compatible with legacy JSONL
 * records that omitted `parentId`: if `target.parentId` is present it is returned; if `target` is
 * an explicit root fork (`rootFork: true`) or legacy root edit fork it returns `undefined`; otherwise
 * it returns the nearest preceding `TurnRecord`'s `id` (or `undefined` if `target` is the first turn).
 */
export function resolveEffectiveParentId(records: readonly ChatRecord[], targetId: string): string | undefined {
  const idx = records.findIndex(record => isTurnRecord(record) && record.id === targetId);
  if (idx < 0) return undefined;
  const target = records[idx] as TurnRecord;
  if (target.parentId !== undefined) return target.parentId;
  if (target.kind === 'user' && (target.rootFork === true || target.editedFrom !== undefined)) return undefined;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const prev = records[i]!;
    if (isTurnRecord(prev)) return prev.id;
  }
  return undefined;
}

/** Records in file order; a line that does not parse is left out. */
export function readRecords(file: string): ChatRecord[] {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: ChatRecord[] = [];
  const lines = text.split('\n');
  lines.forEach(line => {
    if (!line.trim()) return;
    // A torn line is skipped: the last one may still be being written, any other was left by a crash and written past.
    try { records.push(JSON.parse(line) as ChatRecord); } catch { /* see above */ }
  });
  return records;
}

export function appendRecord(file: string, record: ChatRecord): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // A write a crash cut short leaves a torn last line; starting a fresh line keeps it from swallowing this record.
  appendFileSync(file, `${endsTorn(file) ? '\n' : ''}${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function endsTorn(file: string): boolean {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return false; }
  try {
    const { size } = fstatSync(fd);
    if (!size) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally { closeSync(fd); }
}

export interface ChatTreeState {
  nodes: ChatTreeNode[];
  config: ModelChatConfig;
  pinnedDocs: ModelChatPinnedDoc[];
  summary: string;
  summaryUpTo?: string;
  summaryManual?: boolean;
  activeLeafId?: string;
  editCount: number;
}

function cloneConfig(base: ModelChatConfig): ModelChatConfig {
  return {
    ...base,
    responseFormat: base.responseFormat.type === 'json_schema'
      ? { ...base.responseFormat, schema: structuredClone(base.responseFormat.schema) }
      : { ...base.responseFormat },
    ...(base.stop ? { stop: [...base.stop] } : {}),
    ...(base.compareModels ? { compareModels: [...base.compareModels] } : {}),
  };
}

function applyConfigPatch(target: ModelChatConfig, patch: Partial<ModelChatConfig>): void {
  const raw = patch as Record<string, unknown>;
  if (typeof patch.systemPrompt === 'string') target.systemPrompt = patch.systemPrompt;
  if (typeof patch.bareMode === 'boolean') target.bareMode = patch.bareMode;
  if (typeof patch.effort === 'string') target.effort = patch.effort;
  if ('thinkingBudget' in raw) {
    if (typeof raw.thinkingBudget === 'number' && Number.isFinite(raw.thinkingBudget)) target.thinkingBudget = raw.thinkingBudget;
    else delete target.thinkingBudget;
  }
  if ('temperature' in raw) {
    if (typeof raw.temperature === 'number' && Number.isFinite(raw.temperature)) target.temperature = raw.temperature;
    else delete target.temperature;
  }
  if ('topP' in raw) {
    if (typeof raw.topP === 'number' && Number.isFinite(raw.topP)) target.topP = raw.topP;
    else delete target.topP;
  }
  if (typeof patch.maxOutputTokens === 'number' && Number.isFinite(patch.maxOutputTokens)) target.maxOutputTokens = patch.maxOutputTokens;
  if (typeof patch.contextBudget === 'number' && Number.isFinite(patch.contextBudget)) target.contextBudget = patch.contextBudget;
  if (typeof patch.contextStrategy === 'string') target.contextStrategy = patch.contextStrategy;
  if (patch.responseFormat && typeof patch.responseFormat === 'object') {
    target.responseFormat = patch.responseFormat.type === 'json_schema'
      ? { ...patch.responseFormat, schema: structuredClone(patch.responseFormat.schema) }
      : { ...patch.responseFormat };
  }
  if (typeof patch.webSearch === 'boolean') target.webSearch = patch.webSearch;
  if (typeof patch.fast === 'boolean') target.fast = patch.fast;
  if (typeof patch.promptCaching === 'boolean') target.promptCaching = patch.promptCaching;
  if ('seed' in raw) {
    if (typeof raw.seed === 'number' && Number.isFinite(raw.seed)) target.seed = raw.seed;
    else target.seed = null;
  }
  if ('stop' in raw) {
    if (Array.isArray(raw.stop)) target.stop = raw.stop.filter((item): item is string => typeof item === 'string');
    else delete target.stop;
  }
  if ('compareModels' in raw) {
    if (Array.isArray(raw.compareModels)) target.compareModels = raw.compareModels.filter((item): item is string => typeof item === 'string');
    else delete target.compareModels;
  }
}

/**
 * Pure tree builder over an append-only JSONL record list: reconstructs nodes, merges
 * `assistant_edit` and `turn_flag` overlays, resolves latest `config`, `pinnedDocs`, `summary`,
 * and determines `activeLeafId`.
 */
export function buildChatTree(
  records: readonly ChatRecord[],
  defaultConfig: ModelChatConfig = MODEL_CHAT_DEFAULT_CONFIG,
): ChatTreeState {
  const nodes: ChatTreeNode[] = [];
  const nodeById = new Map<string, ChatTreeNode>();
  const nodeRecordIndex = new Map<string, number>();
  const config = cloneConfig(defaultConfig);
  let pinnedDocs: ModelChatPinnedDoc[] = [];
  let summary = '';
  let summaryUpTo: string | undefined;
  let summaryManual: boolean | undefined;
  let summaryRecordIndex: number | undefined;
  let activeLeafId: string | undefined;
  let editCount = 0;

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    if (record.kind === 'user') {
      const node: Extract<ChatTreeNode, { kind: 'user' }> = {
        kind: 'user',
        id: record.id,
        ...(record.parentId !== undefined ? { parentId: record.parentId } : {}),
        turnId: record.turnId,
        ...(record.runId !== undefined ? { runId: record.runId } : {}),
        at: record.at,
        text: record.text,
        commandId: record.commandId,
        ...(record.attachments?.length ? { attachments: record.attachments.map(a => ({ ...a })) } : {}),
        ...(record.editedFrom !== undefined ? { editedFrom: record.editedFrom } : {}),
        ...(record.rootFork ? { rootFork: true as const } : {}),
      };
      nodes.push(node);
      nodeById.set(node.id, node);
      nodeRecordIndex.set(node.id, i);
      activeLeafId = node.id;
    } else if (record.kind === 'assistant') {
      const node: Extract<ChatTreeNode, { kind: 'assistant' }> = {
        kind: 'assistant',
        id: record.id,
        ...(record.parentId !== undefined ? { parentId: record.parentId } : {}),
        turnId: record.turnId,
        ...(record.runId !== undefined ? { runId: record.runId } : {}),
        at: record.at,
        text: record.text,
        ...(record.reasoning !== undefined ? { reasoning: record.reasoning } : {}),
        status: record.status,
        ...(record.error !== undefined ? { error: record.error } : {}),
        ...(record.model !== undefined ? { model: record.model } : {}),
        ...(record.modelSelection !== undefined ? { modelSelection: record.modelSelection } : {}),
        ...(record.dropped !== undefined ? { dropped: record.dropped } : {}),
        ...(record.compareGroupId !== undefined ? { compareGroupId: record.compareGroupId } : {}),
        ...(record.wireBlobRef ? { hasWire: true } : {}),
        ...(record.metrics ? { metrics: { ...record.metrics } } : {}),
      };
      nodes.push(node);
      nodeById.set(node.id, node);
      nodeRecordIndex.set(node.id, i);
      if (activeLeafId === undefined || record.parentId === undefined || activeLeafId === record.parentId) {
        activeLeafId = node.id;
      } else {
        const currentActive = nodeById.get(activeLeafId);
        if (currentActive?.kind === 'assistant' && currentActive.parentId === record.parentId) {
          if (!record.compareGroupId || currentActive.compareGroupId !== record.compareGroupId) {
            activeLeafId = node.id;
          } else if (currentActive.status !== 'completed' && record.status === 'completed') {
            activeLeafId = node.id;
          }
        }
      }
    } else if (record.kind === 'clear') {
      const node: Extract<ChatTreeNode, { kind: 'clear' }> = {
        kind: 'clear',
        id: record.id,
        ...(record.parentId !== undefined ? { parentId: record.parentId } : {}),
        turnId: record.turnId,
        ...(record.runId !== undefined ? { runId: record.runId } : {}),
        at: record.at,
        commandId: record.commandId,
      };
      nodes.push(node);
      nodeById.set(node.id, node);
      nodeRecordIndex.set(node.id, i);
      activeLeafId = node.id;
    } else if (record.kind === 'branch_select') {
      if (nodeById.has(record.leafId)) activeLeafId = record.leafId;
    } else if (record.kind === 'turn_flag') {
      const target = nodeById.get(record.userId);
      if (target?.kind === 'user') {
        if (record.pinned !== undefined) target.pinned = record.pinned;
        if (record.muted !== undefined) target.muted = record.muted;
      }
    } else if (record.kind === 'assistant_edit') {
      const target = nodeById.get(record.targetId);
      if (target?.kind === 'assistant') {
        target.text = record.text;
        target.edited = true;
        editCount += 1;
      }
    } else if (record.kind === 'config_patch') {
      applyConfigPatch(config, record.config);
    } else if (record.kind === 'pinned_docs') {
      pinnedDocs = record.docs.map(doc => ({ ...doc }));
    } else if (record.kind === 'summary') {
      summary = record.text;
      summaryUpTo = record.upTo;
      summaryManual = Boolean(record.manual);
      summaryRecordIndex = i;
    }
  }

  // Ensure an earlier summary (including a manual summary) never leaks past a `clear` on the active path.
  if (summary && activeLeafId) {
    const activePath = activePathOf(nodes, activeLeafId);
    const lastClearIdx = activePath.findLastIndex(node => node.kind === 'clear');
    if (lastClearIdx >= 0) {
      const clearNode = activePath[lastClearIdx]!;
      const clearRecordIdx = nodeRecordIndex.get(clearNode.id) ?? -1;
      const predatesClear = summaryRecordIndex !== undefined && summaryRecordIndex < clearRecordIdx;
      const autoStaleAcrossClear = !summaryManual && Boolean(summaryUpTo)
        && !activePath.slice(lastClearIdx + 1).some(node => node.id === summaryUpTo);
      if (predatesClear || autoStaleAcrossClear) {
        summary = '';
        summaryUpTo = undefined;
        summaryManual = undefined;
      }
    }
  }

  return {
    nodes,
    config,
    pinnedDocs,
    summary,
    ...(summaryUpTo !== undefined ? { summaryUpTo } : {}),
    ...(summaryManual !== undefined ? { summaryManual } : {}),
    ...(activeLeafId !== undefined ? { activeLeafId } : {}),
    editCount,
  };
}

/**
 * Traces the active branch from `activeLeafId` back to the root, returning root-to-leaf order.
 * Compatible with legacy JSONL records that omitted `parentId` (falls back to the preceding node
 * unless the node is an explicit root fork or legacy root edit fork).
 */
export function activePathOf(nodes: readonly ChatTreeNode[], activeLeafId: string | undefined): ChatTreeNode[] {
  if (!activeLeafId || nodes.length === 0) return [];
  const indexById = new Map<string, number>();
  for (let i = 0; i < nodes.length; i += 1) indexById.set(nodes[i]!.id, i);
  const startIndex = indexById.get(activeLeafId);
  if (startIndex === undefined) return [];

  // Track the earliest index at which any node declared an explicit `parentId`.
  let firstExplicitParentIndex = nodes.length;
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i]!.parentId !== undefined) { firstExplicitParentIndex = i; break; }
  }

  const path: ChatTreeNode[] = [];
  const visited = new Set<string>();
  let currentIndex: number | undefined = startIndex;
  while (currentIndex !== undefined) {
    const node = nodes[currentIndex]!;
    if (visited.has(node.id)) break;
    visited.add(node.id);
    path.push(node);
    if (node.kind === 'user' && node.rootFork === true) {
      currentIndex = undefined;
    } else if (node.parentId !== undefined) {
      currentIndex = indexById.get(node.parentId);
    } else if (currentIndex > 0) {
      const isRootFork = node.kind === 'user' && node.editedFrom !== undefined;
      if (!isRootFork && (node.kind === 'assistant' || currentIndex < firstExplicitParentIndex)) {
        currentIndex -= 1;
      } else {
        currentIndex = undefined;
      }
    } else {
      currentIndex = undefined;
    }
  }
  path.reverse();
  return path;
}

function nodeToTurnRecord(node: ChatTreeNode, wireRefById?: ReadonlyMap<string, string>): TurnRecord {
  if (node.kind === 'user') {
    return {
      kind: 'user',
      id: node.id,
      ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
      turnId: node.turnId,
      ...(node.runId !== undefined ? { runId: node.runId } : {}),
      at: node.at,
      text: node.text,
      commandId: node.commandId,
      ...(node.attachments?.length ? { attachments: node.attachments } : {}),
      ...(node.editedFrom !== undefined ? { editedFrom: node.editedFrom } : {}),
      ...(node.rootFork ? { rootFork: true as const } : {}),
    };
  }
  if (node.kind === 'clear') {
    return {
      kind: 'clear',
      id: node.id,
      ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
      turnId: node.turnId,
      ...(node.runId !== undefined ? { runId: node.runId } : {}),
      at: node.at,
      commandId: node.commandId,
    };
  }
  const wireBlobRef = wireRefById?.get(node.id);
  return {
    kind: 'assistant',
    id: node.id,
    ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
    turnId: node.turnId,
    ...(node.runId !== undefined ? { runId: node.runId } : {}),
    at: node.at,
    text: node.text,
    ...(node.reasoning !== undefined ? { reasoning: node.reasoning } : {}),
    status: node.status,
    ...(node.error !== undefined ? { error: node.error } : {}),
    ...(node.model !== undefined ? { model: node.model } : {}),
    ...(node.modelSelection !== undefined ? { modelSelection: node.modelSelection } : {}),
    ...(node.dropped !== undefined ? { dropped: node.dropped } : {}),
    ...(node.compareGroupId !== undefined ? { compareGroupId: node.compareGroupId } : {}),
    ...(wireBlobRef ? { wireBlobRef } : {}),
    ...(node.metrics ? { metrics: node.metrics } : {}),
  };
}

/** Projects only the active branch (with `assistant_edit` applied) as linear `TurnRecord[]` for Journal/share/context. */
export function activeRecordsOf(records: readonly ChatRecord[], defaultConfig: ModelChatConfig = MODEL_CHAT_DEFAULT_CONFIG): TurnRecord[] {
  const tree = buildChatTree(records, defaultConfig);
  const path = activePathOf(tree.nodes, tree.activeLeafId);
  return path.map(node => nodeToTurnRecord(node));
}

export interface AssembleContextOptions {
  /** Base system prompt used when `config.bareMode` is false and `config.systemPrompt` is empty. */
  defaultSystemPrompt?: string;
  /** Extra system instructions appended (e.g. side-chat discussion context). */
  extraSystemPrompt?: string;
  /** Outgoing user prompt text; omit when calculating the breakdown of the current snapshot. */
  nextUserText?: string;
  /** Outgoing user non-text parts (images/PDFs/files). */
  nextUserParts?: ChatPart[];
  /** Explicit parent node ID to assemble history up to; `''` means root (no prior history). */
  parentId?: string;
  /** Existing user node ID being rerun; history stops at its parent and its text is treated as `nextUserText`. */
  rerunUserId?: string;
}

export interface AssembledContext {
  system?: string;
  messages: ChatMessage[];
  dropped: number;
  tokenBreakdown: ModelChatTokenBreakdown;
}

function formatPinnedDocs(docs: readonly ModelChatPinnedDoc[]): string {
  const active = docs.filter(doc => doc.pinned && doc.text.trim());
  if (!active.length) return '';
  const body = active
    .map(doc => `<doc name="${doc.name.replace(/"/g, "'")}">\n${doc.text}\n</doc>`)
    .join('\n\n');
  return `<pinned_context>\n${body}\n</pinned_context>`;
}

/**
 * Assembles the final `{ system, messages, dropped, tokenBreakdown }` sent to the gateway
 * according to `config.contextStrategy`, `config.contextBudget`, `bareMode`, `pinnedDocs`,
 * `summary`, and per-turn `pinned`/`muted` flags.
 */
export function assembleContext(tree: ChatTreeState, options: AssembleContextOptions = {}): AssembledContext {
  const { config } = tree;
  const baseSystem = config.bareMode
    ? ''
    : [config.systemPrompt.trim() || (options.defaultSystemPrompt ?? '').trim(), (options.extraSystemPrompt ?? '').trim()]
        .filter(Boolean)
        .join('\n\n');
  const pinnedDocsBlock = formatPinnedDocs(tree.pinnedDocs);

  // Resolve the history path and outgoing prompt.
  let historyLeafId: string | undefined;
  let nextUserText = options.nextUserText;
  if (options.rerunUserId) {
    const idx = tree.nodes.findIndex(node => node.id === options.rerunUserId);
    const rerunNode = idx >= 0 ? tree.nodes[idx]! : undefined;
    if (rerunNode?.kind === 'user') {
      if (nextUserText === undefined) nextUserText = withAttachmentNames(rerunNode);
      if (rerunNode.rootFork === true) {
        historyLeafId = undefined;
      } else if (rerunNode.parentId !== undefined) {
        historyLeafId = rerunNode.parentId;
      } else if (idx > 0 && rerunNode.editedFrom === undefined) {
        // Legacy JSONL fallback where parentId was omitted.
        const anyExplicit = tree.nodes.slice(0, idx + 1).some(n => n.parentId !== undefined);
        historyLeafId = anyExplicit ? undefined : tree.nodes[idx - 1]!.id;
      }
    }
  } else if (options.parentId !== undefined) {
    historyLeafId = options.parentId === '' ? undefined : options.parentId;
  } else {
    historyLeafId = tree.activeLeafId;
  }

  const fullPath = historyLeafId ? activePathOf(tree.nodes, historyLeafId) : [];
  const clearIdx = fullPath.findLastIndex(node => node.kind === 'clear');
  let relevantPath = fullPath.slice(clearIdx + 1);

  // Summary applies only in `summary` strategy and when still relevant after the last `clear`.
  let activeSummary = '';
  if (config.contextStrategy === 'summary' && tree.summary.trim()) {
    if (tree.summaryManual) {
      activeSummary = tree.summary.trim();
    } else if (tree.summaryUpTo) {
      const coveredIdx = relevantPath.findIndex(node => node.id === tree.summaryUpTo);
      if (coveredIdx >= 0) {
        activeSummary = tree.summary.trim();
        relevantPath = relevantPath.slice(coveredIdx + 1);
      }
    }
  }

  // Pair answered user+assistant turns on the relevant path.
  interface HistoryTurn {
    index: number;
    userId: string;
    userContent: string;
    assistantContent: string;
    pinned: boolean;
    muted: boolean;
    tokens: number;
  }
  const turns: HistoryTurn[] = [];
  let pendingUser: Extract<ModelChatNode, { kind: 'user' }> | undefined;
  for (const node of relevantPath) {
    if (node.kind === 'user') {
      pendingUser = node;
    } else if (node.kind === 'assistant') {
      if (pendingUser && node.text.trim()) {
        const userContent = withAttachmentNames(pendingUser);
        turns.push({
          index: turns.length,
          userId: pendingUser.id,
          userContent,
          assistantContent: node.text,
          pinned: Boolean(pendingUser.pinned),
          muted: Boolean(pendingUser.muted),
          tokens: estimateTokens(userContent) + estimateTokens(node.text),
        });
      }
      pendingUser = undefined;
    }
  }

  const systemTokens = baseSystem ? estimateTokens(baseSystem) : 0;
  const pinnedDocsTokens = pinnedDocsBlock ? estimateTokens(pinnedDocsBlock) : 0;
  const summaryBlock = activeSummary ? `<earlier_conversation>\n${activeSummary}\n</earlier_conversation>` : '';
  const summaryTokens = activeSummary ? estimateTokens(activeSummary) : 0;
  const nextTokens = nextUserText ? estimateTokens(nextUserText) : 0;
  const budget = Math.max(0, config.contextBudget);

  let includedTurns: HistoryTurn[] = [];
  let droppedByBudget = 0;

  if (config.contextStrategy === 'stateless') {
    includedTurns = [];
  } else if (config.contextStrategy === 'full') {
    includedTurns = turns.filter(turn => !turn.muted);
  } else {
    // `window` or `summary`: pinned turns are forcefully kept first; remaining budget fills newest-first.
    const candidates = turns.filter(turn => !turn.muted);
    const chosen = new Set<number>();
    let remaining = Math.max(0, budget - systemTokens - pinnedDocsTokens - summaryTokens - nextTokens);

    for (const turn of candidates) {
      if (turn.pinned) {
        chosen.add(turn.index);
        remaining -= turn.tokens;
      }
    }
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const turn = candidates[i]!;
      if (chosen.has(turn.index)) continue;
      if (remaining - turn.tokens < 0) break;
      chosen.add(turn.index);
      remaining -= turn.tokens;
    }
    includedTurns = candidates.filter(turn => chosen.has(turn.index));
    droppedByBudget = candidates.length - includedTurns.length;
  }

  const includedSet = new Set(includedTurns.map(turn => turn.userId));
  const includedTurnIds = includedTurns.map(turn => turn.userId);
  const droppedTurnIds = turns.filter(turn => !includedSet.has(turn.userId)).map(turn => turn.userId);

  const systemParts = [
    baseSystem,
    pinnedDocsBlock,
    ...(config.contextStrategy === 'stateless' ? [] : [summaryBlock]),
  ].filter(Boolean);
  const system = systemParts.length ? systemParts.join('\n\n') : undefined;

  const messages: ChatMessage[] = [];
  for (const turn of includedTurns) {
    messages.push({ role: 'user', content: turn.userContent });
    messages.push({ role: 'assistant', content: turn.assistantContent });
  }
  if (nextUserText !== undefined) {
    messages.push({
      role: 'user',
      content: nextUserText,
      ...(options.nextUserParts?.length ? { parts: options.nextUserParts } : {}),
    });
  }

  const historyTokens = includedTurns.reduce((sum, turn) => sum + turn.tokens, 0);
  const effectiveSummaryTokens = config.contextStrategy === 'stateless' ? 0 : summaryTokens;
  const totalTokens = systemTokens + pinnedDocsTokens + effectiveSummaryTokens + historyTokens + nextTokens;

  return {
    ...(system !== undefined ? { system } : {}),
    messages,
    dropped: droppedByBudget,
    tokenBreakdown: {
      systemTokens,
      pinnedDocsTokens,
      summaryTokens: effectiveSummaryTokens,
      historyTokens,
      totalTokens,
      budget,
      includedTurnIds,
      droppedTurnIds,
    },
  };
}

/** The answered turns since the last `clear`, oldest first, with the record that ends each. */
export function turnsSince(records: readonly ChatRecord[], from: number): Array<{ end: string; user: string; assistant: string }> {
  const turns: Array<{ end: string; user: string; assistant: string }> = [];
  let question: string | undefined;
  for (const record of records.slice(from)) {
    if (record.kind === 'user') question = withAttachmentNames(record);
    else if (record.kind === 'assistant') {
      if (question !== undefined && record.text.trim()) turns.push({ end: record.id, user: question, assistant: record.text });
      question = undefined;
    }
  }
  return turns;
}

/** Where the context starts: after the last `clear`, and after what the newest summary since then covers. */
export function contextStart(records: readonly ChatRecord[]): { from: number; summary?: string } {
  const cleared = records.findLastIndex(record => record.kind === 'clear') + 1;
  for (let index = records.length - 1; index >= cleared; index -= 1) {
    const record = records[index]!;
    if (record.kind !== 'summary') continue;
    const covered = records.findIndex(item => item.id === record.upTo);
    if (covered >= cleared) return { from: covered + 1, summary: record.text };
  }
  return { from: cleared };
}

/**
 * What the model is sent: the turns since the last `clear` (or the summary that stands in for the
 * oldest of them), newest kept first until `budget` tokens are spent, then `next`. A turn that
 * produced no answer is left out, so roles still alternate.
 */
export function contextOf(records: readonly ChatRecord[], next: string, budget: number): { messages: ChatMessage[]; dropped: number; summary?: string } {
  const { from, summary } = contextStart(records);
  const turns: Array<[ChatMessage, ChatMessage]> = [];
  let question: string | undefined;
  for (const record of records.slice(from)) {
    // Earlier turns go back by name only: their files were read when they were asked about.
    if (record.kind === 'user') question = withAttachmentNames(record);
    else if (record.kind === 'assistant') {
      if (question !== undefined && record.text.trim()) turns.push([{ role: 'user', content: question }, { role: 'assistant', content: record.text }]);
      question = undefined;
    }
  }
  let spent = estimateTokens(next) + (summary ? estimateTokens(summary) : 0);
  let kept = turns.length;
  while (kept > 0) {
    const [user, assistant] = turns[kept - 1]!;
    const cost = estimateTokens(user.content) + estimateTokens(assistant.content);
    if (spent + cost > budget) break;
    spent += cost;
    kept -= 1;
  }
  return { messages: [...turns.slice(kept).flat(), { role: 'user', content: next }], dropped: kept, ...(summary ? { summary } : {}) };
}

export function withAttachmentNames(record: { text: string; attachments?: ChatAttachment[] }): string {
  const names = record.attachments?.map(attachment => attachment.name) ?? [];
  return names.length ? `${record.text}\n\n[${names.join(', ')}]` : record.text;
}

export const userEventId = (record: TurnRecord) => `${record.id}:user`;
export const answerEventId = (assistantId: string, part: 'text' | 'reasoning') => `${assistantId}:${part}`;

/** The events of one record, as the timeline reads them. */
export function recordEvents(sessionId: string, record: ChatRecord): NativeWorkbenchEvent[] {
  if (!isTurnRecord(record)) return [];
  const base = { sequence: 0, sessionId, nativeTurnId: record.turnId, createdAt: record.at, ...(record.runId ? { runId: record.runId } : {}) };
  // `/clear` stays in the transcript as it was typed: the line the context starts over at.
  if (record.kind !== 'assistant') {
    return [{ ...base, type: 'user_message_chunk', nativeId: userEventId(record),
      data: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: record.kind === 'clear' ? '/clear' : record.text }, commandId: record.commandId,
        ...(record.kind === 'user' && record.attachments?.length ? { attachments: record.attachments.map(attachment => ({ ...attachment, type: attachment.mimeType.startsWith('image/') ? 'image' : 'file' })) } : {}) } }];
  }
  const events: NativeWorkbenchEvent[] = [];
  if (record.reasoning) events.push(answerEvent(base, record.id, 'reasoning', record.reasoning));
  if (record.text) events.push(answerEvent(base, record.id, 'text', record.text));
  // How a turn that did not complete ended, in the transcript itself, as every provider's reads.
  const outcome = record.status === 'failed' ? { type: 'run_failed', data: { error: record.error ?? 'The model could not answer' } }
    : record.status === 'cancelled' ? { type: 'run_cancelled', data: {} }
    : record.status === 'interrupted' ? { type: 'run_interrupted', data: record.error ? { reason: record.error } : {} }
    : undefined;
  if (outcome) events.push({ ...base, type: outcome.type, nativeId: `${record.id}:outcome`, data: { sessionUpdate: outcome.type, ...outcome.data } });
  return events;
}

export function answerEvent(base: Omit<NativeWorkbenchEvent, 'type' | 'nativeId' | 'data'>, assistantId: string, part: 'text' | 'reasoning', text: string): NativeWorkbenchEvent {
  const type = part === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk';
  return { ...base, type, nativeId: answerEventId(assistantId, part),
    data: { sessionUpdate: type, content: { type: 'text', text }, ...(part === 'reasoning' ? { channel: 'thinking' } : {}) } };
}
