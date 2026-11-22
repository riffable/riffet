import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { ExtensionAction, ExtensionContext, ExtensionCreateTarget, ExtensionInventory, ExtensionItem, ExtensionManagementCapabilities, ExtensionRuntimeEntry, ExtensionRuntimeReport } from '@contracts';

export const RIFFET_SOURCE_ID = 'riffet' as const;
export type RiffetSourceContext = { backendId: typeof RIFFET_SOURCE_ID; profileId: typeof RIFFET_SOURCE_ID; projectId?: undefined };
export type ExtensionSourceContext = ExtensionContext | RiffetSourceContext;
export type RiffetActivation = 'auto' | 'opt-in' | 'assistant' | 'task' | 'pack' | 'readonly';
export type CatalogExtensionItem = ExtensionItem & { activation?: RiffetActivation };

export function isRiffetSource(context: ExtensionSourceContext): context is RiffetSourceContext {
  return context.backendId === RIFFET_SOURCE_ID;
}

export function riffetActivationBadge(activation?: RiffetActivation): { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' } | undefined {
  switch (activation) {
    case 'auto': return { label: i18n._(msg`自动生效`), tone: 'success' };
    case 'opt-in': return { label: i18n._(msg`按对话开启`), tone: 'accent' };
    case 'assistant': return { label: i18n._(msg`仅个人助理`), tone: 'neutral' };
    case 'task': return { label: i18n._(msg`仅任务会话`), tone: 'neutral' };
    case 'pack': return { label: i18n._(msg`需启用能力包`), tone: 'warning' };
    case 'readonly': return { label: i18n._(msg`实时只读`), tone: 'neutral' };
    default: return undefined;
  }
}

export interface ExtensionSource {
  key: string;
  context: ExtensionSourceContext;
  profileName: string;
  inventory?: { items: CatalogExtensionItem[]; diagnostics: string[]; checkedAt: string; createTargets?: ExtensionCreateTarget[] };
  capabilities?: ExtensionManagementCapabilities;
  capabilityError?: string;
  error?: string;
  loading: boolean;
}

export interface ExtensionEntry {
  key: string;
  context: ExtensionSourceContext;
  profileName: string;
  item: CatalogExtensionItem;
  sourceLabel: string;
  ownerKey?: string;
  capabilities?: ExtensionManagementCapabilities;
  capabilityError?: string;
  inventoryError?: string;
  ambiguousNativeId?: boolean;
}

export interface ExtensionCreation {
  context: ExtensionContext;
  profileName: string;
  targets: ExtensionCreateTarget[];
}

export function extensionContextKey(context: ExtensionSourceContext): string {
  return JSON.stringify([context.backendId, context.profileId, context.projectId ?? '']);
}

export function extensionEntryKey(context: ExtensionSourceContext, id: string): string {
  return JSON.stringify([extensionContextKey(context), id]);
}

/** Mirror the server's ownership checks; installed plugin metadata can be read-only yet manageable. */
export function extensionActions(entry: ExtensionEntry): ExtensionAction[] {
  const { item, capabilities } = entry;
  if (entry.inventoryError) return [];
  // Item actions are authoritative, including read-only/plugin-provided skills whose native
  // configuration can still be toggled. An explicit empty list also overrides broad capabilities.
  if (item.actions !== undefined) return item.actions.filter(action => action !== 'install');
  if (item.kind === 'skill' || item.ownerPluginId || item.scope === 'managed' || item.scope === 'builtin') return [];
  return (capabilities?.kinds[item.kind] ?? []).filter(action => action !== 'install'
    && (!['plugin', 'mcp'].includes(item.kind) || Boolean(item.nativeId)));
}

/** Runtime entries are session-specific. Never pick a winner or join two same-name file sources. */
export function extensionRuntimeEntries(entry: ExtensionEntry, report?: ExtensionRuntimeReport): ExtensionRuntimeEntry[] {
  if (!report) return [];
  return report.entries.filter(runtime => {
    if (runtime.kind !== entry.item.kind) return false;
    // One JSON document can contain several MCP servers or hooks; a path alone is not an identity.
    if (entry.item.nativeId && runtime.name !== entry.item.nativeId) return false;
    if (runtime.sourcePath && entry.item.sourcePath) return runtime.sourcePath === entry.item.sourcePath;
    return Boolean(!entry.ambiguousNativeId && entry.item.nativeId && runtime.name === entry.item.nativeId);
  });
}

/** The stable part of a status, so filtering never depends on the translated label. */
export type ExtensionStatusKey = 'disabled' | 'attention' | 'loaded' | 'pending' | 'enabled' | 'found';

export function extensionStatus(entry: ExtensionEntry, report?: ExtensionRuntimeReport): { key: ExtensionStatusKey; label: string; tone: 'idle' | 'warning' | 'success' | 'neutral' } {
  if (entry.item.enabled === false) return { key: 'disabled', label: i18n._(msg`已停用`), tone: 'idle' };
  const runtimes = extensionRuntimeEntries(entry, report);
  if (runtimes.some(runtime => runtime.state === 'error')) return { key: 'attention', label: i18n._(msg`需处理`), tone: 'warning' };
  if (runtimes.length && runtimes.every(runtime => runtime.state === 'loaded')) return { key: 'loaded', label: i18n._(msg`已加载`), tone: 'success' };
  if (runtimes.some(runtime => runtime.state === 'pending')) return { key: 'pending', label: i18n._(msg`待加载`), tone: 'warning' };
  return entry.item.enabled === true
    ? { key: 'enabled', label: i18n._(msg`已启用`), tone: 'neutral' }
    : { key: 'found', label: i18n._(msg`已发现`), tone: 'neutral' };
}
