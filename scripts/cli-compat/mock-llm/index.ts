export {
  DEFAULT_NARRATION_SIGNATURE,
  DEFAULT_THINKING_SIGNATURE,
  asString,
  chunkText,
  computeUsage,
  createAbortError,
  estimateInputTokens,
  extractLastUserText,
  formatMismatchMessage,
  isAbortError,
  isRecord,
  resolveEffectiveStopReason,
  resolveThinkingSignature,
  safeJsonParse,
  serializeToolArguments,
  sleep,
  type MockErrorSpec,
  type MockGateHook,
  type MockModelInfo,
  type MockProtocol,
  type MockReplySpec,
  type MockRoute,
  type MockStreamFaultSpec,
  type MockThinkingSpec,
  type MockToolCallSpec,
  type MockUsageSpec,
  type NormalizedMessage,
  type NormalizedRequest,
  type NormalizedToolCall,
  type NormalizedToolResult,
  type ProtocolRuntimeContext,
} from './types.js';

export { GateRegistry } from './gates.js';

export {
  AUXILIARY_DEFAULT_PRIORITY,
  MockLlmHub,
  replyDisconnect,
  replyError,
  replyText,
  replyToolCall,
  routeByTag,
  type MockLlmHubOptions,
} from './hub.js';

export {
  DEFAULT_CLAUDE_TOOLS,
  DEFAULT_CODEX_TOOLS,
  DEFAULT_GENERIC_TOOLS,
  currentTurnToolResults,
  hasToolResultForCurrentTurn,
  registerTckScripts,
  type TckScriptOptions,
  type TckScriptsHandle,
  type TckToolMap,
  type ToolArgProfile,
} from './scripts.js';

export {
  handleAnthropicCountTokens,
  handleAnthropicMessages,
  isAnthropicModelsRequest,
  normalizeAnthropicRequest,
  writeAnthropicError,
  writeAnthropicModels,
} from './protocols/anthropic.js';

export {
  attachOpenAiResponsesWebSocket,
  handleOpenAiResponsesHttp,
  normalizeResponsesRequest,
  writeOpenAiResponsesError,
} from './protocols/openai-responses.js';

export {
  handleOpenAiChatCompletions,
  normalizeOpenAiChatRequest,
  writeOpenAiChatError,
  writeOpenAiModels,
} from './protocols/openai-chat.js';

export {
  handleGeminiGenerateContent,
  isGeminiModelsRequest,
  matchGeminiActionPath,
  normalizeGeminiRequest,
  writeGeminiError,
  writeGeminiModels,
} from './protocols/gemini.js';
