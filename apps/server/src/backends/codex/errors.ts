import { str, asRecord } from './util.js';

export function isMissingTerminalError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /terminal (?:not found|does not exist)|unknown terminal/i.test(message);
}

export function isUnmaterializedThreadError(error: unknown, threadId?: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/^thread\s+(.+)\s+is not materialized yet;\s*(?:thread\/(?:turns\/list|read)|includeTurns)\s+is unavailable before first user message/i);
  return Boolean(match && (threadId === undefined || match[1] === threadId));
}

export function isUnavailableSocket(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

export function isActiveWriterError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /active writer/i.test(message);
}

export function isTurnsListUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:list_turns|paginated_threads) is not supported yet/i.test(message);
}

export function isEmptyThreadRolloutError(error: unknown, threadId: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // The app-server wraps the same store failure differently across versions. Metadata failures
  // alone also include permissions/corruption; only an explicitly empty rollout can be pending.
  const match = message.match(/^failed to (?:read thread|load thread history for thread ([^:]+)):\s*thread-store internal error:/i);
  return Boolean(match && (!match[1] || match[1] === threadId)
    && /\brollout at .+\.jsonl is empty$/i.test(message));
}

export function safeTurnError(value: unknown, config: Record<string, unknown>): string {
  const error = asRecord(value);
  let message = str(error?.message) ?? str(value) ?? 'Codex turn failed.';
  message = redactProviderSecrets(message, config);
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

export function safeProviderError(value: unknown, config: Record<string, unknown>): string {
  const message = value instanceof Error ? value.message : str(value) ?? 'Codex app-server is unavailable.';
  return redactProviderSecrets(message, config).replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

function redactProviderSecrets(value: string, config: Record<string, unknown>): string {
  let message = value;
  const apiKey = str(config.apiKey);
  if (apiKey) message = message.replaceAll(apiKey, '[redacted]');
  return message
    // Native HTTP failures can echo the local model URL, whose path holds a routing capability.
    .replace(/(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/)[a-f0-9]{64}(?=\/api\/ide\/)/gi, '$1[redacted]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/\b(?:sk|rk|pk|sess|token)[-_][A-Za-z0-9_-]{12,}\b/gi, '[redacted]')
    .replace(/\b([A-Z0-9_-]*(?:API_KEY|TOKEN|SECRET|AUTHORIZATION))\s*([=:]\s*["']?)[^\s"'&,;]+/gi, '$1$2[redacted]');
}
