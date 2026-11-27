import { AGENT_CALL_TOOL_GROUP, RIFFET_TOOL_GROUPS, SESSION_MESSAGE_TOOL_GROUP, type ToolGroupId } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';

const DEVICE_GROUP = /^device:[A-Za-z0-9._-]{1,100}$/;
/** A linked server explicitly mounted into one conversation (`server:<serverId>`). */
const SERVER_GROUP = /^server:[0-9a-f-]{36}$/i;
/** A plugin's `contributes.agentTools` id, `<pluginId>/<name>`; kept while the plugin is off, given only while it is on. */
const PLUGIN_GROUP = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9.-]{0,63}$/;
const MAX_GROUPS = 32;

export function isToolGroupId(value: unknown): value is ToolGroupId {
  return typeof value === 'string' && ((RIFFET_TOOL_GROUPS as readonly string[]).includes(value) || value === AGENT_CALL_TOOL_GROUP || value === SESSION_MESSAGE_TOOL_GROUP || DEVICE_GROUP.test(value) || SERVER_GROUP.test(value) || (value.length <= 130 && PLUGIN_GROUP.test(value)));
}

/** A validated, de-duplicated list of tool groups, in the order given. */
export function toolGroupList(value: unknown, name = 'toolGroups'): ToolGroupId[] {
  if (!Array.isArray(value) || value.length > MAX_GROUPS) throw new AppError('INVALID_TOOL_GROUPS', `${name} must list at most ${MAX_GROUPS} tool groups`);
  const groups: ToolGroupId[] = [];
  for (const item of value) {
    if (!isToolGroupId(item)) throw new AppError('INVALID_TOOL_GROUPS', `${name} contains an unknown tool group`);
    // `riffet.core` is retired: Riffet's own tools are always given. An older client may still send it.
    if (item !== 'riffet.core' && !groups.includes(item)) groups.push(item);
  }
  return groups;
}

/** Refuses a `device:<id>` group naming a device that is not paired. */
export function requirePairedDevices(groups: readonly ToolGroupId[], paired: (id: string) => boolean): void {
  const unknown = groups.find(group => group.startsWith('device:') && !paired(group.slice('device:'.length)));
  if (unknown) throw new AppError('UNKNOWN_DEVICE', `${unknown} names no paired device`, 400);
}
