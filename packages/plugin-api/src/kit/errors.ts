import type { TextParams } from '@riffet/contracts';

/**
 * A failure the API answers with `{ error: { code, message, params, details } }`. [message] is
 * English for developers and logs; clients show the text `code` names in `i18n/errors/*.json`,
 * filled from [params] (docs/guide/architecture.md, 界面语言).
 *
 * One class for the core and for plugins, so an `instanceof AppError` in the core holds for what a plugin throws.
 */
export class AppError extends Error {
  constructor(public code: string, message: string, public statusCode = 400, public details?: unknown, public params?: TextParams) { super(message); this.name = 'AppError'; }
}
export function requireString(value: unknown, name: string, max = 100_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError('INVALID_INPUT', `${name} must be a non-empty string (max ${max} characters)`);
  return value;
}
