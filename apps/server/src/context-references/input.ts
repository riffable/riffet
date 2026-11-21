import type { SessionReferenceInput } from '../../../../packages/contracts/src/index.js';
import { SESSION_REFERENCE_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import { AppError } from '../errors.js';

export const SESSION_REFERENCE_FEATURE = 'session-references-v1';
export const SESSION_REFERENCE_MIME = 'application/vnd.riffet.session-reference+json';
export const CONTEXT_LIMITS = SESSION_REFERENCE_BUDGET;

/** Parse declarations without touching their sources: an accepted retry must work after deletion. */
export function sessionReferenceInputs(value: unknown): SessionReferenceInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > CONTEXT_LIMITS.references) throw new AppError('INVALID_SESSION_REFERENCES', 'Use at most five session references');
  const ids = new Set<string>();
  const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);
  const result = value.map((item: unknown): SessionReferenceInput => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AppError('INVALID_SESSION_REFERENCES', 'Invalid session reference');
    const ref = item as Record<string, unknown>;
    if (ref.kind !== 'session' || !id(ref.sessionId) || ref.fromRunId !== undefined && !id(ref.fromRunId)
      || Object.keys(ref).some(key => !['kind', 'sessionId', 'fromRunId'].includes(key)) || ids.has(ref.sessionId)) {
      throw new AppError('INVALID_SESSION_REFERENCES', 'Invalid or duplicate session reference');
    }
    ids.add(ref.sessionId);
    return { kind: 'session', sessionId: ref.sessionId, ...(ref.fromRunId ? { fromRunId: ref.fromRunId as string } : {}) };
  });
  return result.length ? result : undefined;
}
