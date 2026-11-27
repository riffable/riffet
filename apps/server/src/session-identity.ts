import { isNativeBackendId, type NativeBackendId, type NativeRunDetails, type Run, type Session, type AppSettings } from '../../../packages/contracts/src/index.js';

/*
 * Cursor was Riffet's first backend, and two of its habits are still in stored rows, in old
 * clients' requests and on the wire:
 *
 *  1. a row or request without `backendId` means Cursor;
 *  2. a Cursor chat is named twice: `nativeSessionId` is canonical, `cursorSessionId` its mirror.
 *
 * This module is the only place that knows either rule. The store runs `normalize*` on every session
 * and run it reads or writes (and keeps the matching SQL defaults), so the rest of the server sees a
 * `backendId` on every session and run and a `nativeSessionId` wherever a provider id exists, and
 * never defaults or falls back itself. Stored rows are not rewritten by a read; a row gains the
 * normalized fields when it is next written. The mirror stays on the objects the store hands out, so
 * API and wire payloads, which older Android, iOS and macOS builds decode, are unchanged.
 */

/** The backend of every stored row and legacy request that names none. This is identity, not the default of a new conversation (`defaultBackendForClient`). */
export const LEGACY_DEFAULT_BACKEND_ID = 'cursor' as const satisfies NativeBackendId;

export const NATIVE_MODEL_LIMIT = 200;

/** Side chats prepend the backend and profile to the parent's native model selector. Only the selector uses the 200-character model budget. */
export function sessionModelLimit(value: unknown, discussion: boolean): number {
  const prefix = discussion && typeof value === 'string' ? /^([^:]+):([^:]{1,200}):/.exec(value) : undefined;
  return NATIVE_MODEL_LIMIT + (prefix && isNativeBackendId(prefix[1]) ? prefix[0].length : 0);
}

interface IdentityFields { backendId?: NativeBackendId; nativeSessionId?: string; cursorSessionId?: string }

/** A session as the store returns it: `backendId` is always set. */
export type IdentifiedSession = Session & { backendId: NativeBackendId };
/** A run as the store returns it: a native run's `backendId` is always set. */
export type IdentifiedRun = Run & { native?: NativeRunDetails & { backendId: NativeBackendId } };

/** The mirror field itself: Cursor sessions and runs also carry their provider id as `cursorSessionId`, for old readers. */
export function legacyMirrorFields(backendId: string | undefined, nativeSessionId: string | undefined): { cursorSessionId?: string } {
  return (backendId ?? LEGACY_DEFAULT_BACKEND_ID) === LEGACY_DEFAULT_BACKEND_ID && nativeSessionId ? { cursorSessionId: nativeSessionId } : {};
}

export function withLegacyMirror<T extends IdentityFields>(value: T): T {
  const mirror = legacyMirrorFields(value.backendId, value.nativeSessionId);
  return mirror.cursorSessionId === undefined || value.cursorSessionId === mirror.cursorSessionId ? value : { ...value, ...mirror };
}

/**
 * `backendId` set (to `fallbackBackendId`, Cursor unless the caller knows better) and, for Cursor,
 * `nativeSessionId` taken from a stored `cursorSessionId`. Returns `value` itself when nothing changes.
 */
export function normalizeIdentity<T extends IdentityFields>(value: T, fallbackBackendId: NativeBackendId = LEGACY_DEFAULT_BACKEND_ID): T & { backendId: NativeBackendId } {
  const backendId = value.backendId ?? fallbackBackendId;
  const nativeSessionId = value.nativeSessionId ?? (backendId === LEGACY_DEFAULT_BACKEND_ID ? value.cursorSessionId : undefined);
  const complete = value.backendId === backendId && value.nativeSessionId === nativeSessionId
    ? value as T & { backendId: NativeBackendId }
    : { ...value, backendId, ...(nativeSessionId ? { nativeSessionId } : {}) };
  return withLegacyMirror(complete);
}

export function normalizeSessionIdentity(session: Session): IdentifiedSession {
  return normalizeIdentity(session);
}

/** A session's backend as the store would read it, for a caller that may hold a session the store did not hand out. */
export function backendIdOf(session: { backendId?: NativeBackendId }): NativeBackendId {
  return session.backendId ?? LEGACY_DEFAULT_BACKEND_ID;
}

/**
 * A run's native identity, on read and on write. A run without its own `backendId` belongs to its
 * session's backend; `ownerBackendId` is asked only then, so the common case reads nothing extra.
 */
export function normalizeRunIdentity(run: Run, ownerBackendId?: () => NativeBackendId | undefined): IdentifiedRun {
  if (!run.native) return run as IdentifiedRun;
  const native = normalizeIdentity(run.native, run.native.backendId ?? ownerBackendId?.() ?? LEGACY_DEFAULT_BACKEND_ID);
  return native === run.native ? run as IdentifiedRun : { ...run, native };
}

/**
 * A Cursor session's provider id moves as one: a write that names either field sets both, and an
 * explicit clear clears both, so a switch can never leave the row naming two chats. Two different
 * ids in one write are ambiguous and refused with `conflict`. `item` is the merged record.
 */
export function applyNativeSessionIdPatch(item: Session, patch: Partial<Session>, conflict: () => Error): void {
  if (item.kind !== 'native' || (item.backendId ?? LEGACY_DEFAULT_BACKEND_ID) !== LEGACY_DEFAULT_BACKEND_ID) return;
  const hasNative = Object.prototype.hasOwnProperty.call(patch, 'nativeSessionId');
  const hasCursor = Object.prototype.hasOwnProperty.call(patch, 'cursorSessionId');
  if (!hasNative && !hasCursor) return;
  if (hasNative && hasCursor && patch.nativeSessionId !== patch.cursorSessionId) throw conflict();
  const nativeSessionId = hasNative ? patch.nativeSessionId : patch.cursorSessionId;
  item.nativeSessionId = nativeSessionId;
  item.cursorSessionId = nativeSessionId;
}

/** How a request body names the provider chat: `nativeSessionId`, or `cursorSessionId` from a client that predates it. */
export interface RequestedNativeSession { nativeSessionId?: string; cursorSessionId?: string }

export function requestedNativeSessionId(body: RequestedNativeSession): string | undefined {
  return body.nativeSessionId ?? body.cursorSessionId;
}

/**
 * How an observed run is picked up after a restart, for backends whose CLI outlives the service (`survivesRestart`):
 * a turn that ended meanwhile closes by what the provider recorded, one that did not is not left running for ever,
 * and nothing is resent. The store recovers its runs before any backend or plugin is up and so cannot read the
 * trait; the list is frozen here and a backend added later is not on it.
 * - `hook`: Claude and Cursor (the legacy default) report a turn's end by hook, which a restart can lose. An
 *   observed run keeps waiting; Claude's transcript end rows (`stop_hook_summary`, `turn_duration`) or Cursor's
 *   store settle it, otherwise it closes unconfirmed once the CLI has been idle a while.
 * - `daemon`: Codex, Traex and Antigravity keep a detached daemon/app-server that holds the thread. The watch the dispatcher opens
 *   for every unfinished run reads the thread back, which yields the ends recorded meanwhile; a run it cannot
 *   settle closes by the same idle rule.
 */
export function restartObservation(backendId: string): 'hook' | 'daemon' | undefined {
  if (backendId === LEGACY_DEFAULT_BACKEND_ID || backendId === 'claude') return 'hook';
  return backendId === 'codex' || backendId === 'traex' || backendId === 'antigravity' ? 'daemon' : undefined;
}

/**
 * The legacy top-level `defaultModel` / `defaultMode` settings are the legacy default backend's own
 * saved defaults, from before defaults were kept per backend (`nativeBackendDefaults`). They apply to
 * no other backend.
 */
export function legacyDefaults(backendId: string, settings: Pick<AppSettings, 'defaultModel' | 'defaultMode'>): { model?: string; mode?: string } {
  return backendId === LEGACY_DEFAULT_BACKEND_ID
    ? { ...(settings.defaultModel !== undefined ? { model: settings.defaultModel } : {}), ...(settings.defaultMode !== undefined ? { mode: settings.defaultMode } : {}) }
    : {};
}

/**
 * `POST /api/sessions/:id/start` answers the legacy default backend's conversation with the bare
 * terminal, the shape clients decoded before the reply carried the session; every other backend
 * answers `{ session, status, ... }`. Clients accept both, so only older builds depend on it.
 */
export function startsWithBareTerminal(backendId: string): boolean {
  return backendId === LEGACY_DEFAULT_BACKEND_ID;
}

/**
 * A warm-up reservation as earlier versions persisted it: the chat id was `cursorSessionId` and no
 * backend was recorded, since only Cursor kept a warm CLI. Read through this wherever a stored
 * terminal's `warmup` is used.
 */
export function normalizeWarmup<T extends { nativeSessionId?: string; cursorSessionId?: string; backendId?: NativeBackendId }>(warmup: T): Omit<T, 'cursorSessionId' | 'nativeSessionId' | 'backendId'> & { nativeSessionId: string; backendId: NativeBackendId } {
  const { cursorSessionId, nativeSessionId, backendId, ...rest } = warmup;
  return { ...rest, nativeSessionId: nativeSessionId ?? cursorSessionId ?? '', backendId: backendId ?? LEGACY_DEFAULT_BACKEND_ID };
}
