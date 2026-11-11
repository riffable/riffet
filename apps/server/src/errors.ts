import type { z } from 'zod/v4';
import { AppError } from '../../../packages/plugin-api/src/kit/errors.js';

export { AppError, requireString } from '../../../packages/plugin-api/src/kit/errors.js';

/**
 * Validates one input body against its contract schema. The caller
 * names the error code the route has always answered with, so schema validation does not rename an
 * existing failure; the zod issues ride along in `details`, leaving the error envelope unchanged.
 */
export function parseInput<Schema extends z.ZodType>(schema: Schema, value: unknown, code: string): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map(issue => ({ code: issue.code, path: issue.path.map(String), message: issue.message }));
    const first = issues[0];
    const where = first?.path.length ? first.path.join('.') : 'input';
    throw new AppError(code, `${where}: ${first?.message ?? 'Invalid input'}`, 400, { issues });
  }
  return result.data;
}

/** A conversation handed to a terminal (`riffet resume`) has that CLI as its only writer. */
export function sessionInTerminal(): AppError {
  return new AppError('SESSION_IN_TERMINAL', 'This conversation is open in a terminal; take it back to send from here', 409);
}
