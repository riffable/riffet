import type { Run } from '../../contracts/src/index.js';
import { hasNativeInputReceipt } from './model.js';
import { isRecord, str } from './values.js';

/** A confirmed input keeps its delivery success even when its task's later outcome is missing. */
export function nativeTaskOutcome(run: Run): 'unknown' | 'failed' | undefined {
  const native = run.native;
  if (!native) return undefined;
  const received = hasNativeInputReceipt(native) || native.stage === 'provider_failed' || native.stage === 'turn_outcome_unknown';
  if (received && (native.stage === 'turn_outcome_unknown' || native.delivery === 'uncertain' || native.stage === 'acknowledged')) return 'unknown';
  return received && native.delivery === 'failed' ? 'failed' : undefined;
}

const SUMMARY_LENGTH = 180;
const ENVELOPE_LENGTH = 16_384;

/** Read a provider's JSON envelope even when an HTTP transport prefixes it or appends a URL. */
function envelope(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  if (start < 0 || start >= ENVELOPE_LENGTH) return undefined;
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < Math.min(text.length, start + ENVELOPE_LENGTH); index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) {
      try {
        const value: unknown = JSON.parse(text.slice(start, index + 1));
        return isRecord(value) ? value : undefined;
      } catch { return undefined; }
    }
  }
  return undefined;
}

/** Only explicit error/message fields explain a failure; arbitrary nested details do not. */
function providerMessage(value: Record<string, unknown>, depth = 0): string | undefined {
  if (depth >= 4) return undefined;
  if (isRecord(value.error)) {
    const nested = providerMessage(value.error, depth + 1);
    if (nested) return nested;
  }
  return str(value.message)?.trim() || str(value.error)?.trim() || undefined;
}

/**
 * A readable reason and, only when it adds information, its original diagnostic. The caller owns
 * redaction: this is a lossless presentation of already-safe errors, never a credential filter or a
 * retry policy. Keeping the original event/error makes live, replayed and older failures equivalent.
 */
export function describeFailure(text: string): { message: string; detail?: string } {
  const original = text.trim();
  const body = envelope(original);
  const reason = (body && providerMessage(body)) || original;
  const firstLine = reason.split(/[\r\n]/, 1)[0]!.trim();
  const message = firstLine.length > SUMMARY_LENGTH ? `${firstLine.slice(0, SUMMARY_LENGTH - 1).trimEnd()}…` : firstLine;
  return { message, ...(message !== original ? { detail: text } : {}) };
}
