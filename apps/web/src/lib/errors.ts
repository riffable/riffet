import { i18n } from '@lingui/core';
import { t } from '@lingui/core/macro';
import type { TextParams, TextRef } from '@contracts';

/** A failed request, with the server's error (`ApiError`) when it sent one. */
export class HttpError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  params?: TextParams;
  constructor(status: number, message: string, code?: string, details?: unknown, params?: TextParams) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.params = params;
  }
}

/**
 * The text [ref] names in the `errors` catalog (generated from `i18n/errors`), in the active
 * language; undefined for a code the catalog does not have. `{message}` in a text is [message].
 */
export function textOf(ref: TextRef, message = ''): string | undefined {
  const id = `error.${ref.code}`;
  return Object.hasOwn(i18n.messages, id) ? i18n._(id, { ...ref.params, message }) : undefined;
}

const HAN = /\p{Script=Han}/u;

/**
 * What to tell the user about [error]. A server error shows the text its code names. A code not yet
 * in the catalog still shows the server's own message — Chinese from before the catalogs, or the
 * English one — since a generic [fallback] would hide the reason; [fallback] is for an error with no
 * message at all. Any other error shows its message, which this client wrote.
 */
export function errorMessage(error: unknown, fallback?: string): string {
  if (error instanceof HttpError) {
    const own = Object.values(error.params ?? {}).reduce<string>((text, value) => text.split(String(value)).join(''), error.message);
    if (HAN.test(own)) return error.message;
    return (error.code && textOf({ code: error.code, ...(error.params ? { params: error.params } : {}) }, error.message)) || error.message || (fallback ?? t({ message: '操作失败', context: 'common-error-fallback' }));
  }
  return error instanceof Error && error.message ? error.message : (fallback ?? t({ message: '操作失败', context: 'common-error-fallback' }));
}
