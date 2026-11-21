// Agent identity (docs/design/plugin-system.md §5.1). The built-in ids are persisted values and keep
// their meaning; any other id is namespaced by the plugin that provides the Agent. The format is judged
// here and whether the provider is installed is judged separately, so a conversation of an Agent whose
// plugin is gone stays readable.

/**
 * Built-in native runtimes supported by the workbench, in the canonical Agent order: every list of Agents
 * and every "first usable Agent" choice follows it ({@link compareAgentOrder}). Legacy sessions without an
 * id are Cursor sessions, whatever their place here.
 * `chat` is the workbench's own quick chat: no CLI, a model gateway called directly (docs/QUICK-CHAT.md).
 */
export const NATIVE_BACKEND_IDS = ['claude', 'codex', 'antigravity', 'cursor', 'pi', 'traex', 'droid', 'dsh', 'chat'] as const;
export type BuiltinBackendId = typeof NATIVE_BACKEND_IDS[number];

/** `<pluginId>` or `<pluginId>.<name>`: lowercase, dotted, at most {@link PLUGIN_AGENT_ID_MAX} characters. */
export const PLUGIN_AGENT_ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*$/;
export const PLUGIN_AGENT_ID_MAX = 64;
/** An Agent id a plugin provides. Built-in ids have no dot, so the two never collide. */
export type PluginAgentId = `${string}.${string}`;
/**
 * Any Agent id. Code that keys a table by id writes `Partial<Record<NativeBackendId, T>>` and falls
 * back for an id it does not list; it does not enumerate the plugin ids, which are not known to it.
 */
export type NativeBackendId = BuiltinBackendId | PluginAgentId;

export function isBuiltinBackendId(value: unknown): value is BuiltinBackendId {
  return typeof value === 'string' && (NATIVE_BACKEND_IDS as readonly string[]).includes(value);
}

export function isPluginAgentId(value: unknown): value is PluginAgentId {
  return typeof value === 'string' && value.length <= PLUGIN_AGENT_ID_MAX && PLUGIN_AGENT_ID.test(value);
}

/** A built-in id or a well-formed plugin Agent id; says nothing about whether anything provides it. */
export function isNativeBackendId(value: unknown): value is NativeBackendId {
  return isBuiltinBackendId(value) || isPluginAgentId(value);
}

/** Whether the plugin `pluginId` may provide the plugin Agent id `id`: it is the plugin's id or lies under it. */
export function isAgentOfPlugin(pluginId: string, id: unknown): id is PluginAgentId {
  return isPluginAgentId(id) && (id === pluginId || id.startsWith(`${pluginId}.`));
}

/** Plugin Agents sort after the built-in ones and keep their registration order among themselves (`Array.sort` is stable). */
function agentRank(id: string): number {
  const index = (NATIVE_BACKEND_IDS as readonly string[]).indexOf(id);
  if (id === 'chat') return Number.MAX_SAFE_INTEGER;
  return index < 0 ? NATIVE_BACKEND_IDS.length : index;
}

/** The canonical Agent order: built-in ids as in {@link NATIVE_BACKEND_IDS}, then plugin Agents, then quick chat. */
export function compareAgentOrder(a: string, b: string): number {
  return agentRank(a) - agentRank(b);
}
