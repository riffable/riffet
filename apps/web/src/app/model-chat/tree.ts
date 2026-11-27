import type {
  ModelChatConfig,
  ModelChatEffort,
  ModelChatLiveStream,
  ModelChatMetrics,
  ModelChatNode,
  ModelChatProtocol,
  ModelChatTurnStatus,
  ModelChatWireRecord,
  ModelInfo,
  RunMetrics,
} from '@contracts';
import { MODEL_CHAT_DEFAULT_CONFIG } from '@contracts';
import { parseSelection } from '@/lib/models';
import { cleanLabel } from '@/lib/utils';

export type ModelChatUserNode = Extract<ModelChatNode, { kind: 'user' }>;
export type ModelChatAssistantNode = Extract<ModelChatNode, { kind: 'assistant' }>;
export type ModelChatClearNode = Extract<ModelChatNode, { kind: 'clear' }>;

export interface ModelChatBranchAnswer {
  id: string;
  parentId: string;
  turnId: string;
  runId?: string;
  at: string;
  text: string;
  reasoning?: string;
  status?: ModelChatTurnStatus;
  error?: string;
  model?: string;
  modelSelection?: string;
  compareGroupId?: string;
  hasWire?: boolean;
  edited?: boolean;
  metrics?: ModelChatMetrics;
  streaming: boolean;
  node?: ModelChatAssistantNode;
}

export interface ModelChatTurnView {
  id: string;
  turnNumber: number;
  userNode: ModelChatUserNode;
  userSiblings: ModelChatUserNode[];
  userIndex: number;
  activeAssistant?: ModelChatBranchAnswer;
  assistantSiblings: ModelChatBranchAnswer[];
  assistantIndex: number;
  compareGroupId?: string;
  compareAnswers: ModelChatBranchAnswer[];
  isCompareCandidate: boolean;
  clearedBefore?: ModelChatClearNode;
}

function toAnswerFromNode(node: ModelChatAssistantNode): ModelChatBranchAnswer {
  return {
    id: node.id,
    parentId: node.parentId ?? '',
    turnId: node.turnId,
    ...(node.runId ? { runId: node.runId } : {}),
    at: node.at,
    text: node.text,
    ...(node.reasoning ? { reasoning: node.reasoning } : {}),
    status: node.status,
    ...(node.error ? { error: node.error } : {}),
    ...(node.model ? { model: node.model } : {}),
    ...(node.modelSelection ? { modelSelection: node.modelSelection } : {}),
    ...(node.compareGroupId ? { compareGroupId: node.compareGroupId } : {}),
    ...(node.hasWire !== undefined ? { hasWire: node.hasWire } : {}),
    ...(node.edited ? { edited: node.edited } : {}),
    ...(node.metrics ? { metrics: node.metrics } : {}),
    streaming: false,
    node,
  };
}

function toAnswerFromStream(stream: ModelChatLiveStream): ModelChatBranchAnswer {
  return {
    id: stream.assistantId,
    parentId: stream.parentId,
    turnId: stream.turnId,
    runId: stream.runId,
    at: stream.startedAt,
    text: stream.text,
    ...(stream.reasoning ? { reasoning: stream.reasoning } : {}),
    model: stream.model,
    modelSelection: stream.modelSelection,
    ...(stream.compareGroupId ? { compareGroupId: stream.compareGroupId } : {}),
    streaming: true,
  };
}

/**
 * Resolves the active root-to-leaf conversation branch from the message tree and merges any
 * live streaming answers (single or multi-model parallel compare) into their parent user turn.
 */
export function resolveModelChatTurns(
  nodes: readonly ModelChatNode[],
  activeLeafId: string | undefined,
  liveStreams: readonly ModelChatLiveStream[],
): ModelChatTurnView[] {
  const byId = new Map<string, ModelChatNode>();
  const childrenByParent = new Map<string, ModelChatNode[]>();
  for (const node of nodes) {
    byId.set(node.id, node);
    const key = node.parentId ?? '';
    const list = childrenByParent.get(key);
    if (list) list.push(node);
    else childrenByParent.set(key, [node]);
  }

  const liveByParent = new Map<string, ModelChatLiveStream[]>();
  for (const stream of liveStreams) {
    const list = liveByParent.get(stream.parentId);
    if (list) list.push(stream);
    else liveByParent.set(stream.parentId, [stream]);
  }

  // Pick the active anchor node: explicit activeLeafId, otherwise latest node in the tree.
  let leaf: ModelChatNode | undefined = activeLeafId ? byId.get(activeLeafId) : undefined;
  if (!leaf && liveStreams.length > 0) {
    const lastStream = liveStreams[liveStreams.length - 1]!;
    leaf = byId.get(lastStream.parentId);
  }
  if (!leaf && nodes.length > 0) {
    leaf = nodes[nodes.length - 1];
  }
  if (!leaf) return [];

  // Walk upwards to root with cycle guard.
  const path: ModelChatNode[] = [];
  const seen = new Set<string>();
  let cursor: ModelChatNode | undefined = leaf;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  path.reverse();

  // If the chosen leaf is a user node that has children (e.g. from an older branch selection),
  // keep walking down its latest child if no live stream is attached directly to it.
  const lastNode = path[path.length - 1];
  if (lastNode && lastNode.kind === 'user' && !liveByParent.has(lastNode.id)) {
    let tail: ModelChatNode | undefined = lastNode;
    while (tail) {
      const children = childrenByParent.get(tail.id);
      if (!children?.length) break;
      const next = children[children.length - 1]!;
      if (seen.has(next.id)) break;
      seen.add(next.id);
      path.push(next);
      tail = next;
    }
  }

  const turns: ModelChatTurnView[] = [];
  let pendingClear: ModelChatClearNode | undefined;

  for (let index = 0; index < path.length; index += 1) {
    const current = path[index]!;
    if (current.kind === 'clear') {
      pendingClear = current;
      continue;
    }
    if (current.kind !== 'user') continue;

    const userNode = current;
    const siblingPool = childrenByParent.get(userNode.parentId ?? '') ?? [];
    const userSiblings = siblingPool.filter((node): node is ModelChatUserNode => node.kind === 'user');
    const userIndex = Math.max(0, userSiblings.findIndex((node) => node.id === userNode.id));

    const persistedAssistants = (childrenByParent.get(userNode.id) ?? [])
      .filter((node): node is ModelChatAssistantNode => node.kind === 'assistant')
      .map(toAnswerFromNode);

    const streamsForTurn = liveByParent.get(userNode.id) ?? [];
    const assistantSiblings: ModelChatBranchAnswer[] = [...persistedAssistants];
    for (const stream of streamsForTurn) {
      const existingIndex = assistantSiblings.findIndex((item) => item.id === stream.assistantId);
      const liveAnswer = toAnswerFromStream(stream);
      if (existingIndex >= 0) assistantSiblings[existingIndex] = liveAnswer;
      else assistantSiblings.push(liveAnswer);
    }

    const nextOnPath = path[index + 1];
    let activeAssistant: ModelChatBranchAnswer | undefined;
    if (nextOnPath?.kind === 'assistant') {
      activeAssistant = assistantSiblings.find((item) => item.id === nextOnPath.id);
    }
    if (!activeAssistant && streamsForTurn.length > 0) {
      activeAssistant = assistantSiblings.find((item) => item.id === streamsForTurn[0]!.assistantId);
    }
    if (!activeAssistant && assistantSiblings.length > 0) {
      activeAssistant = assistantSiblings[assistantSiblings.length - 1];
    }

    const assistantIndex = activeAssistant
      ? Math.max(0, assistantSiblings.findIndex((item) => item.id === activeAssistant.id))
      : 0;

    // Identify parallel multi-model compare group for this turn.
    const activeGroupId = activeAssistant?.compareGroupId
      ?? streamsForTurn.find((stream) => stream.compareGroupId)?.compareGroupId;
    const compareAnswers = activeGroupId
      ? assistantSiblings.filter((item) => item.compareGroupId === activeGroupId)
      : [];
    const isCompareCandidate = compareAnswers.length > 1;

    turns.push({
      id: userNode.id,
      turnNumber: turns.length + 1,
      userNode,
      userSiblings,
      userIndex,
      ...(activeAssistant ? { activeAssistant } : {}),
      assistantSiblings,
      assistantIndex,
      ...(isCompareCandidate && activeGroupId ? { compareGroupId: activeGroupId } : {}),
      compareAnswers: isCompareCandidate ? compareAnswers : [],
      isCompareCandidate,
      ...(pendingClear ? { clearedBefore: pendingClear } : {}),
    });
    pendingClear = undefined;
  }

  return turns;
}

/** Finds the latest leaf descendant of `nodeId` so branch switching lands at the end of that branch. */
export function latestLeafOf(nodeId: string, nodes: readonly ModelChatNode[]): string {
  const childrenByParent = new Map<string, ModelChatNode[]>();
  for (const node of nodes) {
    const key = node.parentId ?? '';
    const list = childrenByParent.get(key);
    if (list) list.push(node);
    else childrenByParent.set(key, [node]);
  }
  const seen = new Set<string>([nodeId]);
  let current = nodeId;
  while (true) {
    const children = childrenByParent.get(current);
    if (!children?.length) return current;
    const next = children[children.length - 1]!;
    if (seen.has(next.id)) return current;
    seen.add(next.id);
    current = next.id;
  }
}

/** Infers wire protocol from model selection string or recent wire metadata. */
export function inferModelProtocol(
  modelSelection: string | undefined,
  knownProtocol?: ModelChatProtocol,
): ModelChatProtocol {
  if (knownProtocol) return knownProtocol;
  const raw = (modelSelection ?? '').toLowerCase();
  const model = parseSelection(modelSelection).model.toLowerCase();
  if (/^claude:/.test(model) || /^claude:/.test(raw)) return 'anthropic';
  if (/^codex:/.test(model) || /^codex:/.test(raw)) return 'responses';
  if (/^dsh:/.test(model) || /^dsh:/.test(raw)) return 'chat';
  if (model.includes('claude') || raw.includes('anthropic')) return 'anthropic';
  if (
    model.startsWith('gpt-5')
    || model.startsWith('o1')
    || model.startsWith('o3')
    || model.startsWith('o4')
    || raw.includes('codex')
    || raw.includes('responses')
  ) {
    return 'responses';
  }
  return 'chat';
}

export interface ProtocolCapabilities {
  protocol: ModelChatProtocol;
  effortOptions: readonly ModelChatEffort[];
  supportsWebSearch: boolean;
  supportsFast: boolean;
  supportsSeed: boolean;
}

export function protocolCapabilities(protocol: ModelChatProtocol): ProtocolCapabilities {
  if (protocol === 'anthropic') {
    return {
      protocol,
      effortOptions: ['default', 'off', 'low', 'medium', 'high', 'adaptive'],
      supportsWebSearch: true,
      supportsFast: false,
      supportsSeed: false,
    };
  }
  if (protocol === 'responses') {
    return {
      protocol,
      effortOptions: ['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      supportsWebSearch: true,
      supportsFast: true,
      supportsSeed: false,
    };
  }
  return {
    protocol,
    effortOptions: ['default', 'off', 'low', 'medium', 'high'],
    supportsWebSearch: false,
    supportsFast: false,
    supportsSeed: true,
  };
}

/**
 * Protocol mutual-exclusion guard:
 * - Anthropic disables temperature / top_p whenever extended thinking is explicitly enabled (`effort !== 'default' && effort !== 'off'`).
 * - OpenAI Responses disables sampling controls whenever reasoning is explicitly above `'minimal'`.
 */
export function isSamplingLocked(protocol: ModelChatProtocol, effort: ModelChatEffort): boolean {
  if (effort === 'default' || effort === 'off') return false;
  if (protocol === 'anthropic') return true;
  if (protocol === 'responses') return effort !== 'minimal';
  return false;
}

export function estimateTextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  let cjk = 0;
  let other = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(cjk * 1.1 + other / 3.8));
}

export function assistantRunMetrics(metrics: ModelChatMetrics | undefined): RunMetrics | undefined {
  if (!metrics) return undefined;
  const durationMs = metrics.durationMs;
  const outputTokens = metrics.outputTokens;
  if (typeof durationMs !== 'number' || typeof outputTokens !== 'number' || !(durationMs > 0) || !(outputTokens > 0)) {
    return undefined;
  }
  return {
    durationMs,
    outputTokens,
    tokens: 'provider',
    window: 'stream',
    steps: 1,
  };
}

export function cacheHitPercent(metrics: ModelChatMetrics | undefined): number | undefined {
  if (!metrics?.inputTokens || !metrics.cacheReadTokens || metrics.inputTokens <= 0 || metrics.cacheReadTokens <= 0) {
    return undefined;
  }
  return Math.min(100, Math.round((metrics.cacheReadTokens / metrics.inputTokens) * 100));
}

export function resolveModelLabel(
  selection: string | undefined,
  models: readonly ModelInfo[] | undefined,
): string {
  if (!selection) return '';
  const parsed = parseSelection(selection).model;
  const matched = models?.find((item) => item.value === selection || item.value === parsed || item.aliases?.includes(parsed));
  if (matched?.name) return cleanLabel(matched.name);
  // Chat selections encode `<backend>:<profileId>:<modelId>`: never expose internal profile UUIDs.
  const triple = /^[^:]+:[^:]+:(.+)$/.exec(parsed);
  return cleanLabel(triple ? triple[1]! : parsed);
}

export function buildWireCurl(wire: ModelChatWireRecord): string {
  const headerFlags = Object.entries(wire.headers)
    .map(([key, value]) => `  -H ${JSON.stringify(`${key}: ${value}`)}`)
    .join(' \\\n');
  const bodyJson = JSON.stringify(wire.body, null, 2).replace(/'/g, "'\\''");
  const lines = [
    `curl -X POST ${JSON.stringify(wire.endpoint)} \\`,
    ...(headerFlags ? [`${headerFlags} \\`] : []),
    `  -d '${bodyJson}'`,
  ];
  return lines.join('\n');
}

export interface NonDefaultChip {
  id: string;
  label: string;
  tone?: 'warning' | 'accent' | 'neutral';
}

export function collectNonDefaultChips(
  config: ModelChatConfig,
  protocol: ModelChatProtocol,
  labels: {
    bareMode: string;
    stateless: string;
    window: string;
    full: string;
    effortOff: string;
    effortPrefix: string;
    webSearch: string;
    fast: string;
    cacheOff: string;
    jsonObject: string;
    jsonSchema: string;
  },
): NonDefaultChip[] {
  const chips: NonDefaultChip[] = [];
  if (config.bareMode) chips.push({ id: 'bare', label: labels.bareMode, tone: 'warning' });
  if (config.contextStrategy === 'stateless') chips.push({ id: 'stateless', label: labels.stateless });
  else if (config.contextStrategy === 'window') chips.push({ id: 'window', label: labels.window });
  else if (config.contextStrategy === 'full') chips.push({ id: 'full', label: labels.full });

  if (config.effort !== MODEL_CHAT_DEFAULT_CONFIG.effort) {
    chips.push({
      id: 'effort',
      label: config.effort === 'off' ? labels.effortOff : `${labels.effortPrefix} ${config.effort}`,
    });
  }
  const locked = isSamplingLocked(protocol, config.effort);
  if (!locked && typeof config.temperature === 'number') {
    chips.push({ id: 'temp', label: `T=${config.temperature.toFixed(2).replace(/\.?0+$/, '')}` });
  }
  if (!locked && typeof config.topP === 'number' && config.topP < 1) {
    chips.push({ id: 'topP', label: `P=${config.topP.toFixed(2).replace(/\.?0+$/, '')}` });
  }
  if (config.responseFormat.type === 'json_object') chips.push({ id: 'format', label: labels.jsonObject });
  else if (config.responseFormat.type === 'json_schema') chips.push({ id: 'format', label: labels.jsonSchema, tone: 'accent' });

  if (config.webSearch && protocolCapabilities(protocol).supportsWebSearch) {
    chips.push({ id: 'search', label: labels.webSearch });
  }
  if (config.fast && protocolCapabilities(protocol).supportsFast) {
    chips.push({ id: 'fast', label: labels.fast });
  }
  if (!config.promptCaching) {
    chips.push({ id: 'cache', label: labels.cacheOff });
  }
  return chips;
}
