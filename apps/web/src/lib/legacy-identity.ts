import type { NativeBackendId } from '@contracts';

/**
 * The backend of every session and request that names none (it mirrors `apps/server/src/session-identity.ts`),
 * and the one the legacy top-level `defaultModel` / `defaultMode` settings belong to. Nothing else
 * in the web client names a backend by id.
 */
export const LEGACY_DEFAULT_BACKEND_ID = 'cursor' as const satisfies NativeBackendId;
