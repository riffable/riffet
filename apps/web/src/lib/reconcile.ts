import type { AppSettings } from '@contracts';
import { LEGACY_DEFAULT_BACKEND_ID } from './legacy-identity';
import { isRecord } from './utils';

/** The same keys holding identical values; only a field's own entries are compared. */
function sameEntries(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]));
}

/**
 * Reuse unchanged API records so a quiet list refresh does not invalidate the workbench. A field
 * holding an array or a plain object (`nativeRuntime`, `origin`, `tags`) arrives as a new object on
 * every read, so it is compared by its entries, one level deep.
 */
export function sameRecord<T extends object>(left: T, right: T): boolean {
  if (left === right) return true;
  const keys = Object.keys(left) as Array<keyof T>;
  return keys.length === Object.keys(right).length && keys.every((key) => {
    const a: unknown = left[key], b: unknown = right[key];
    if (Object.is(a, b)) return true;
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
    return isRecord(a) && isRecord(b) && sameEntries(a, b);
  });
}

/** Keep a model choice made after an asynchronous settings read/write began. */
export function preserveNewerDefaultModel(
  incoming: AppSettings,
  current: AppSettings,
  revisionAtRequest: number,
  currentRevision: number,
): AppSettings {
  return revisionAtRequest === currentRevision
    ? incoming
    : { ...incoming, defaultModel: current.defaultModel, defaultBackendId: current.defaultBackendId, nativeBackendDefaults: current.nativeBackendDefaults };
}

/** Apply only fields written by a settings PATCH; other response fields may already be stale. */
export function mergeSavedSettings(current: AppSettings, response: AppSettings, patch: Partial<AppSettings>): AppSettings {
  const next = { ...current };
  const assign = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => { next[key] = value; };
  for (const key of Object.keys(patch) as Array<keyof AppSettings>) assign(key, response[key]);
  if ((patch.defaultModel !== undefined || patch.defaultMode !== undefined) && patch.nativeBackendDefaults === undefined && response.nativeBackendDefaults !== undefined) {
    next.nativeBackendDefaults = {
      ...current.nativeBackendDefaults,
      [LEGACY_DEFAULT_BACKEND_ID]: response.nativeBackendDefaults[LEGACY_DEFAULT_BACKEND_ID],
    };
  }
  return next;
}

export function reconcileById<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
  const records = new Map(previous.map((record) => [record.id, record]));
  const next = incoming.map((record) => {
    const current = records.get(record.id);
    return current && sameRecord(current, record) ? current : record;
  });
  return next.length === previous.length && next.every((record, index) => record === previous[index]) ? previous : next;
}
