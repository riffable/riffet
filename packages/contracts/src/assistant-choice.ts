/**
 * The 助理's agent, provider and model (docs/ASSISTANT.md §4), one rule for the clients' composer and
 * the server's background runs (§7).
 */
import type { AssistantSettings, NativeBackendCatalogEntry, NativeBackendId } from './index.js';

export interface AssistantChoice { backendId: NativeBackendId; profileId?: string; model?: string }

/** The agent the 助理 is built on: its own instructions, memory and Riffet's skills reach only this one. */
export const ASSISTANT_STANDING_BACKEND: NativeBackendId = 'claude';

/**
 * The saved choice while its agent is still offered. A provider since removed falls back to the
 * agent's default one, and its model with it. With nothing saved it is Claude Code where that can
 * run, rather than whichever agent the composer last used elsewhere.
 */
export function assistantChoice(saved: AssistantSettings | undefined, backends: readonly NativeBackendCatalogEntry[]): AssistantChoice | undefined {
  const backend = (saved?.backendId ? backends.find((entry) => entry.backendId === saved.backendId) : undefined)
    ?? backends.find((entry) => entry.backendId === ASSISTANT_STANDING_BACKEND && entry.available);
  if (!backend) return undefined;
  const profileKept = !saved?.profileId || backend.profiles.some((profile) => profile.id === saved.profileId);
  return {
    backendId: backend.backendId,
    ...(profileKept && saved?.profileId ? { profileId: saved.profileId } : {}),
    ...(profileKept && saved?.model ? { model: saved.model } : {}),
  };
}
