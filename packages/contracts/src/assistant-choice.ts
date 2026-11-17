/**
 * The 助理's agent, provider and model (docs/ASSISTANT.md §4), one rule for the clients' composer and
 * the server's background runs (§7).
 */
import type { AppSettings, AssistantSettings, NativeBackendCatalogEntry, NativeBackendId } from './index.js';

export interface AssistantChoice { backendId: NativeBackendId; profileId?: string; model?: string }

/**
 * The agents the 助理 runs on, first the one it starts on: those that launch it isolated from the owner's own
 * configuration (docs/ASSISTANT.md §4). On any other it would run with the owner's instructions, skills and servers.
 */
export const ASSISTANT_BACKENDS: readonly NativeBackendId[] = ['claude', 'codex'];

export function isAssistantBackend(backendId: string | undefined): boolean {
  return ASSISTANT_BACKENDS.includes(backendId as NativeBackendId);
}

/**
 * The saved choice while its agent is still offered. A provider since removed falls back to the
 * agent's default one, and its model with it. With nothing saved, or an agent it no longer runs on,
 * it is the first of {@link ASSISTANT_BACKENDS} that can run, rather than whichever agent the
 * composer last used elsewhere.
 */
export function assistantChoice(saved: AssistantSettings | undefined, backends: readonly NativeBackendCatalogEntry[]): AssistantChoice | undefined {
  const backend = (isAssistantBackend(saved?.backendId) ? backends.find((entry) => entry.backendId === saved!.backendId) : undefined)
    ?? ASSISTANT_BACKENDS.map((id) => backends.find((entry) => entry.backendId === id && entry.available)).find(Boolean);
  if (!backend) return undefined;
  // A saved provider and model belong to the saved agent only.
  const own = backend.backendId === saved?.backendId;
  const profileKept = own && (!saved?.profileId || backend.profiles.some((profile) => profile.id === saved.profileId));
  return {
    backendId: backend.backendId,
    ...(profileKept && saved?.profileId ? { profileId: saved.profileId } : {}),
    ...(profileKept && saved?.model ? { model: saved.model } : {}),
  };
}

/**
 * Who a new 任务 goes to (docs/TASK-BOARD.md §10): 任务看板's saved agent and model while that agent is
 * offered, else the composer's default agent with its own defaults, else the first agent that can run.
 * Quick chat is no worker. A provider since removed falls back to the agent's default, and its model with it.
 */
export function workItemAgentChoice(settings: Pick<AppSettings, 'workItems' | 'defaultBackendId'> | undefined, backends: readonly NativeBackendCatalogEntry[]): AssistantChoice | undefined {
  const workers = backends.filter((entry) => entry.backendId !== 'chat' && entry.available);
  const saved = settings?.workItems;
  const chosen = saved?.backendId ? workers.find((entry) => entry.backendId === saved.backendId) : undefined;
  const backend = chosen ?? workers.find((entry) => entry.backendId === settings?.defaultBackendId) ?? workers[0];
  if (!backend) return undefined;
  if (!chosen) return { backendId: backend.backendId };
  const profileKept = !saved?.profileId || backend.profiles.some((profile) => profile.id === saved.profileId);
  return {
    backendId: backend.backendId,
    ...(profileKept && saved?.profileId ? { profileId: saved.profileId } : {}),
    ...(profileKept && saved?.model ? { model: saved.model } : {}),
  };
}
