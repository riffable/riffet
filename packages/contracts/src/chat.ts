/**
 * Model Chat (direct LLM workbench) contracts.
 *
 * A Model Chat session uses `backendId: 'chat'` and stores an append-only message tree
 * (`<stateDir>/chat/<sessionId>.jsonl`). The journal keeps a linear projection of the
 * active branch so search, marks, stats, shares, and older clients remain compatible,
 * while `/api/sessions/:id/chat/*` serves the full tree, white-box parameters, context
 * orchestration, multi-model parallel compare, and redacted Wire inspection.
 */

export type ModelChatProtocol = 'anthropic' | 'chat' | 'responses';

export type ModelChatEffort = 'default' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'adaptive';

export type ModelChatContextStrategy = 'summary' | 'window' | 'full' | 'stateless';

export type ModelChatResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict?: boolean };

export interface ModelChatConfig {
  /** Custom system prompt; omitted from requests when `bareMode` is true. */
  systemPrompt: string;
  /** Zero-pollution bare mode: send no host or user system prompt at all. */
  bareMode: boolean;
  /** Reasoning effort; `'off'` explicitly disables thinking where supported. */
  effort: ModelChatEffort;
  /** Optional custom Anthropic thinking token budget when `effort` is fixed. */
  thinkingBudget?: number;
  /** Sampling temperature (0..2). Omitted when protocol locks sampling under thinking/reasoning. */
  temperature?: number;
  /** Nucleus sampling (0..1). Omitted when protocol locks sampling under thinking/reasoning. */
  topP?: number;
  /** Output token limit for each answer. */
  maxOutputTokens: number;
  /** Context token budget before truncation/summarization kicks in. */
  contextBudget: number;
  /** How conversation history is assembled into `messages`. */
  contextStrategy: ModelChatContextStrategy;
  /** Plain text, JSON object, or strict JSON Schema response constraint. */
  responseFormat: ModelChatResponseFormat;
  /** Enable gateway-native web search where supported (Anthropic / Responses). */
  webSearch: boolean;
  /** Enable OpenAI Responses priority tier where supported. */
  fast: boolean;
  /** Enable explicit prompt caching breakpoints where supported (e.g. Anthropic ephemeral). */
  promptCaching: boolean;
  /** Optional deterministic seed for protocols that accept it. */
  seed?: number | null;
  /** Optional stop sequences. */
  stop?: string[];
  /** Additional model selections for parallel multi-model comparison (1..3 total including primary). */
  compareModels?: string[];
}

export const MODEL_CHAT_DEFAULT_CONFIG: Readonly<ModelChatConfig> = {
  systemPrompt: '',
  bareMode: false,
  effort: 'default',
  maxOutputTokens: 16_384,
  contextBudget: 128_000,
  contextStrategy: 'summary',
  responseFormat: { type: 'text' },
  webSearch: false,
  fast: false,
  promptCaching: true,
};

export interface ModelChatPinnedDoc {
  id: string;
  name: string;
  text: string;
  tokens: number;
  pinned: boolean;
  sourcePath?: string;
}

export interface ModelChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  width?: number;
  height?: number;
}

export type ModelChatTurnStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface ModelChatMetrics {
  protocol?: ModelChatProtocol;
  authMs?: number;
  ttftMs?: number | null;
  durationMs?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  stopReason?: string;
}

export type ModelChatNode =
  | {
      kind: 'user';
      id: string;
      parentId?: string;
      turnId: string;
      runId?: string;
      at: string;
      text: string;
      commandId: string;
      attachments?: ModelChatAttachment[];
      editedFrom?: string;
      pinned?: boolean;
      muted?: boolean;
    }
  | {
      kind: 'assistant';
      id: string;
      parentId?: string;
      turnId: string;
      runId?: string;
      at: string;
      text: string;
      reasoning?: string;
      status: ModelChatTurnStatus;
      error?: string;
      model?: string;
      modelSelection?: string;
      dropped?: number;
      compareGroupId?: string;
      hasWire?: boolean;
      edited?: boolean;
      metrics?: ModelChatMetrics;
    }
  | {
      kind: 'clear';
      id: string;
      parentId?: string;
      turnId: string;
      runId?: string;
      at: string;
      commandId: string;
    };

export interface ModelChatLiveStream {
  assistantId: string;
  parentId: string;
  turnId: string;
  runId: string;
  modelSelection: string;
  model?: string;
  compareGroupId?: string;
  text: string;
  reasoning: string;
  startedAt: string;
}

export interface ModelChatTokenBreakdown {
  systemTokens: number;
  pinnedDocsTokens: number;
  summaryTokens: number;
  historyTokens: number;
  totalTokens: number;
  budget: number;
  includedTurnIds: string[];
  droppedTurnIds: string[];
}

export interface ModelChatTreeSnapshot {
  sessionId: string;
  activeLeafId?: string;
  config: ModelChatConfig;
  pinnedDocs: ModelChatPinnedDoc[];
  summary: string;
  nodes: ModelChatNode[];
  tokenBreakdown: ModelChatTokenBreakdown;
  liveStreams: ModelChatLiveStream[];
}

export interface ModelChatWireRecord {
  assistantId: string;
  protocol: ModelChatProtocol;
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  metrics?: ModelChatMetrics;
  at: string;
  truncated?: boolean;
}

export interface ModelChatConfigPatch extends Omit<Partial<ModelChatConfig>, 'temperature' | 'topP' | 'thinkingBudget'> {
  temperature?: number | null;
  topP?: number | null;
  thinkingBudget?: number | null;
  summary?: string;
  pinnedDocs?: ModelChatPinnedDoc[];
}

export interface ModelChatSendRequest {
  text: string;
  commandId?: string;
  /** Parent record ID to fork from; omit to append after current activeLeafId. */
  parentId?: string;
  /** Original user node ID when editing and forking a user turn. */
  editedFrom?: string;
  /** Reuse an existing user node (regenerate / rerun with another model). */
  rerunUserId?: string;
  /** One to three model selections; defaults to session primary + config.compareModels. */
  models?: string[];
  attachmentIds?: string[];
}

export type ModelChatStreamEvent =
  | { type: 'snapshot'; snapshot: ModelChatTreeSnapshot }
  | { type: 'delta'; assistantId: string; parentId: string; kind: 'text' | 'reasoning'; text: string }
  | { type: 'turn_done'; assistantId: string; status: ModelChatTurnStatus; error?: string; snapshot: ModelChatTreeSnapshot }
  | { type: 'tree_updated'; snapshot: ModelChatTreeSnapshot };
