import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { AGENT_CALL_TOOL_GROUP, SESSION_MESSAGE_TOOL_GROUP, type DeviceInfo, type LoadedExtensions, type NativeBackendId, type ServerInfo, type ToolGroupId } from '@contracts';
import { IconPuzzle } from '@/components/icons';
import { Spinner } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, MenuSub } from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { localizedText, usePlugins } from '@/lib/plugins';
import { useLists, useStores } from '../state/stores';
import { whenIdle } from './useEarlierHistory';
import { cn, errorMessage } from '@/lib/utils';
import { boundedCache } from '@/lib/bounded-cache';
import { registerBounded } from '@/lib/cache-registry';

const LAST_PICK_KEY = 'riffet.tool-groups.last';
const DEVICE_PREFIX = 'device:';
const SERVER_PREFIX = 'server:';

/** Whether a backend can have the tools injected at all; the picker is not offered otherwise. */
export const offersRiffetTools = (capabilities?: { supportsRiffetTools?: boolean }) => capabilities?.supportsRiffetTools === true;

export const phoneGroup = (deviceId: string) => `${DEVICE_PREFIX}${deviceId}` as ToolGroupId;
export const serverGroup = (serverId: string) => `${SERVER_PREFIX}${serverId}` as ToolGroupId;

/** Riffet's own tools are always injected; a pick only names phones. Older snapshots may still carry `riffet.core`. */
export const phoneGroups = (groups: readonly string[]): ToolGroupId[] => groups.filter((id): id is ToolGroupId => id.startsWith(DEVICE_PREFIX));
export const serverGroups = (groups: readonly string[]): ToolGroupId[] => groups.filter((id): id is ToolGroupId => id.startsWith(SERVER_PREFIX));

/** A plugin's agent tools, `<pluginId>/<name>` (docs/BROWSER.md §2). */
const isPluginGroup = (id: string) => /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9.-]*$/.test(id);
/** What a pick may name: phones, explicitly mounted linked servers, plugin tool groups, calling any Agent and messaging any conversation. */
const pickedGroups = (groups: readonly string[]): ToolGroupId[] => groups.filter((id): id is ToolGroupId => id.startsWith(DEVICE_PREFIX) || id.startsWith(SERVER_PREFIX) || isPluginGroup(id) || id === AGENT_CALL_TOOL_GROUP || id === SESSION_MESSAGE_TOOL_GROUP);

/**
 * Linked servers this conversation may mount for remote command execution: online, compatible peers that
 * allow this server to operate them, plus any already selected in `value` so they can still be cleared.
 */
export function useLinkableServers(value: readonly string[], enabled = true): { servers: ServerInfo[]; available: ToolGroupId[]; offered: boolean } {
  const all = useLists((state) => state.servers);
  const linkedStatus = useLists((state) => state.linkedStatus);
  if (!enabled) return { servers: [], available: [], offered: false };
  const selected = new Set(serverGroups(value));
  const servers = all.filter((item) => {
    if (item.self) return false;
    const online = item.online && linkedStatus[item.id] !== 'offline';
    const usable = online && item.compatible && item.outbound;
    return usable || selected.has(serverGroup(item.id));
  });
  const available = servers
    .filter((item) => item.online && linkedStatus[item.id] !== 'offline' && item.compatible && item.outbound)
    .map((item) => serverGroup(item.id));
  return { servers, available, offered: servers.length > 0 };
}

/**
 * The tool groups of the plugins that are on, plus any the value already names whose plugin is off now
 * (so the pick can be cleared). `available` lists only the usable ones.
 */
export function usePluginToolGroups(value: readonly string[]): { rows: Array<{ id: ToolGroupId; name: string; off: boolean }>; available: ToolGroupId[] } {
  const plugins = usePlugins();
  const rows: Array<{ id: ToolGroupId; name: string; off: boolean }> = [];
  for (const plugin of plugins ?? []) {
    for (const group of plugin.declared?.agentTools ?? []) {
      const id = group.id as ToolGroupId;
      if (plugin.enabled || value.includes(id)) rows.push({ id, name: localizedText(group.title) ?? group.id, off: !plugin.enabled });
    }
  }
  return { rows, available: rows.filter((row) => !row.off).map((row) => row.id) };
}

/**
 * A new conversation starts with what the last one on this browser was given, deliberately excluding
 * `server:*` grants so remote machine access is always opt-in per conversation.
 */
export function lastToolGroups(): ToolGroupId[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LAST_PICK_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? pickedGroups(parsed.filter((item): item is string => typeof item === 'string')).filter((id) => !id.startsWith(SERVER_PREFIX)) : [];
  } catch { return []; }
}

export function rememberToolGroups(groups: readonly ToolGroupId[]): void {
  try { window.localStorage.setItem(LAST_PICK_KEY, JSON.stringify(pickedGroups(groups).filter((id) => !id.startsWith(SERVER_PREFIX)))); } catch { /* Storage may be unavailable. */ }
}

/*
 * The paired devices, read once per page and again when the server says they changed (a phone came
 * online or went offline), the menu opens or the window regains focus. Whether the picker is offered
 * depends on them, so the composer that hosts it reads the same copy.
 */
let cached: DeviceInfo[] | undefined;
let inflight: Promise<void> | undefined;
const listeners = new Set<() => void>();

function refreshDevices(): Promise<void> {
  inflight ??= api.devices()
    .then(({ devices }) => { cached = devices; listeners.forEach((listener) => listener()); })
    .finally(() => { inflight = undefined; });
  return inflight;
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => cached;

/**
 * The phones a conversation can be given: those online and allowing control, plus any the value
 * already names (so a pick can still be unticked after the phone went offline or stopped allowing
 * it). `offered` is false when there is nothing to pick, and the caller then leaves the picker out.
 */
export function useControllablePhones(value: readonly string[]): { phones: DeviceInfo[]; offered: boolean } {
  const devices = useSyncExternalStore(subscribe, snapshot);
  const { lists } = useStores();
  useEffect(() => {
    const refresh = () => { refreshDevices().catch(() => { /* The picker reports it when opened. */ }); };
    if (!cached) refresh();
    const offDevices = lists.onDevices(refresh);
    window.addEventListener('focus', refresh);
    return () => { offDevices(); window.removeEventListener('focus', refresh); };
  }, [lists]);
  const named = phoneGroups(value);
  const phones = (devices ?? []).filter((device) => device.platform && ((device.allowControl && device.online) || named.includes(phoneGroup(device.id))));
  // Until the first answer, a value that names a phone keeps the picker where it was.
  return { phones, offered: phones.length > 0 || (!devices && named.length > 0) };
}

export type ExtensionToggles = { mcp: boolean; skills: boolean };

/** Which kinds of installed extensions a conversation on this backend can switch off, if any. */
export function offersExtensionToggles(capabilities?: { extensionToggles?: ExtensionToggles }): ExtensionToggles | undefined {
  const toggles = capabilities?.extensionToggles;
  return toggles && (toggles.mcp || toggles.skills) ? toggles : undefined;
}

/** What the extension rows are read for and written to: the loaded list depends on the profile and the project. */
export interface ExtensionPick {
  backendId: NativeBackendId;
  profileId?: string;
  projectId: string;
  toggles: ExtensionToggles;
  /** `mcp:<name>` / `skill:<name>` items switched off. */
  off: readonly string[];
  onChange: (next: string[]) => void;
}

const MCP_PREFIX = 'mcp:';
const SKILL_PREFIX = 'skill:';

/*
 * What a launch would load, read when the menu opens (the server probes the CLI, which takes a few
 * seconds, and caches for five minutes). A short copy here makes reopening instant.
 */
const LOADED_FRESH_MS = 60_000;
const loadedCache = boundedCache<string, { at: number; data: LoadedExtensions }>({ limit: 32 });
registerBounded('loaded-extensions', loadedCache, 32);
const loadedInflight = new Map<string, Promise<LoadedExtensions>>();
const loadedListeners = new Set<() => void>();
const subscribeLoaded = (listener: () => void) => { loadedListeners.add(listener); return () => { loadedListeners.delete(listener); }; };

const loadedKey = (pick: Pick<ExtensionPick, 'backendId' | 'profileId' | 'projectId'>) => JSON.stringify([pick.backendId, pick.profileId ?? '', pick.projectId]);

function readLoaded(pick: Pick<ExtensionPick, 'backendId' | 'profileId' | 'projectId'>): Promise<LoadedExtensions> {
  const key = loadedKey(pick);
  const hit = loadedCache.get(key);
  if (hit && Date.now() - hit.at < LOADED_FRESH_MS) return Promise.resolve(hit.data);
  let inflight = loadedInflight.get(key);
  if (!inflight) {
    inflight = api.loadedExtensions(pick.backendId, pick.profileId, pick.projectId)
      .then((data) => { loadedCache.set(key, { at: Date.now(), data }); loadedListeners.forEach((listener) => listener()); return data; })
      .finally(() => { loadedInflight.delete(key); });
    loadedInflight.set(key, inflight);
  }
  return inflight;
}

function useLoadedExtensions(pick: ExtensionPick | undefined, open: boolean) {
  const key = pick ? loadedKey(pick) : undefined;
  const [state, setState] = useState<{ key?: string; data?: LoadedExtensions; failed?: boolean }>({});
  const [attempt, setAttempt] = useState(0);
  const pickRef = useRef(pick);
  pickRef.current = pick;
  useEffect(() => {
    const current = pickRef.current;
    if (!open || !current || !key) return;
    let live = true;
    setState((prev) => (prev.key === key ? { key, data: prev.data } : { key, data: loadedCache.get(key)?.data }));
    readLoaded(current)
      .then((data) => { if (live) setState({ key, data }); })
      .catch(() => { if (live) setState((prev) => ({ key, ...(prev.key === key && prev.data ? { data: prev.data } : {}), failed: true })); });
    return () => { live = false; };
  }, [open, key, attempt]);
  const own = state.key === key ? state : undefined;
  const data = own?.data ?? (key ? loadedCache.get(key)?.data : undefined);
  const failed = own?.failed === true && !own.data;
  return { data, failed, loading: Boolean(key) && !data && !failed, retry: () => { setState({ key }); setAttempt((value) => value + 1); } };
}

/**
 * Whether the extension rows would have anything: a listed MCP server or skill the backend can switch,
 * or one already switched off. The list is read once the page is idle, behind everything the
 * conversation needs; until it lands, or when the read fails, nothing is offered on its account.
 */
export function useExtensionsOffered(pick: ExtensionPick | undefined): boolean {
  const key = pick ? loadedKey(pick) : undefined;
  const data = useSyncExternalStore(subscribeLoaded, () => (key ? loadedCache.get(key)?.data : undefined));
  const pickRef = useRef(pick);
  pickRef.current = pick;
  useEffect(() => {
    if (!key) return;
    return whenIdle(() => {
      const current = pickRef.current;
      if (current) readLoaded(current).catch(() => { /* The menu reports it when opened. */ });
    });
  }, [key]);
  if (!pick) return false;
  const has = (on: boolean, listed: readonly unknown[] | undefined, prefix: string) => on && (Boolean(listed?.length) || pick.off.some((item) => item.startsWith(prefix)));
  return has(pick.toggles.mcp, data?.mcp, MCP_PREFIX) || has(pick.toggles.skills, data?.skills, SKILL_PREFIX);
}

/** The listed names plus any already switched off that the list no longer has, so they can be switched back on. */
function extensionRows(listed: readonly string[] | undefined, off: readonly string[], prefix: string): string[] {
  const names = [...(listed ?? [])];
  for (const item of off) if (item.startsWith(prefix) && !names.includes(item.slice(prefix.length))) names.push(item.slice(prefix.length));
  return names;
}

/**
 * Set by the composer around its attach (+) menu: there the picker is a submenu row rather than a
 * button of its own on the toolbar.
 */
export const ToolsPickerInMenu = createContext(false);

/**
 * The plugin tools (the browser) and phones a conversation's agent may use (a phone's consent lives on the
 * phone, never here), and the MCP servers and skills it keeps. Riffet's own tools need no pick.
 */
export function ToolsPicker({ value, onChange, extensions, agents, servers: allowServers = false, disabled, footnote, onError }: {
  value: readonly string[];
  onChange: (next: ToolGroupId[]) => void;
  /** The conversation's Agent can call other Agents (docs/AGENT-CALLS.md): offers letting it call any of them. */
  agents?: boolean;
  /** Local conversations may mount linked servers for `remote_exec`; disabled on remote conversations to prevent chaining. */
  servers?: boolean;
  /** Absent when the backend cannot switch extensions or the conversation has no project to read them from. */
  extensions?: ExtensionPick;
  disabled?: boolean;
  /** Shown under the rows, for a selection that does not apply to the running CLI. */
  footnote?: string;
  onError?: (message: string) => void;
}) {
  const { t } = useLingui();
  const inMenu = useContext(ToolsPickerInMenu);
  const [open, setOpen] = useState(false);
  const picked = pickedGroups(value);
  const { phones } = useControllablePhones(value);
  const pluginGroups = usePluginToolGroups(value);
  const linkedServers = useLinkableServers(value, allowServers);
  const linkedStatus = useLists((state) => state.linkedStatus);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const loaded = useLoadedExtensions(extensions, open);

  const load = () => {
    refreshDevices().catch((error) => errorRef.current?.(errorMessage(error, t`无法读取设备`)));
  };

  const toggle = (group: ToolGroupId, on: boolean) => {
    // A phone, server or plugin group that is gone is dropped with the change.
    const kept = picked.filter((id) => id !== group && (
      id === AGENT_CALL_TOOL_GROUP || id === SESSION_MESSAGE_TOOL_GROUP
      || phones.some((device) => phoneGroup(device.id) === id)
      || linkedServers.servers.some((server) => serverGroup(server.id) === id)
      || pluginGroups.rows.some((row) => row.id === id)
    ));
    onChange(on ? [...kept, group] : kept);
  };

  const off = extensions?.off ?? [];
  const toggleExtension = (item: string, on: boolean) => {
    if (!extensions) return;
    extensions.onChange(on ? off.filter((entry) => entry !== item) : off.includes(item) ? [...off] : [...off, item]);
  };
  const mcpRows = extensions?.toggles.mcp ? extensionRows(loaded.data?.mcp.map((entry) => entry.name), off, MCP_PREFIX) : [];
  const skillRows = extensions?.toggles.skills ? extensionRows(loaded.data?.skills.map((entry) => entry.name), off, SKILL_PREFIX) : [];
  const toolCount = new Map(loaded.data?.mcp.map((entry) => [entry.name, entry.tools] as const));
  const offCount = off.filter((item) => (extensions?.toggles.mcp && item.startsWith(MCP_PREFIX)) || (extensions?.toggles.skills && item.startsWith(SKILL_PREFIX))).length;

  const label = t`技能与工具`;
  const rows = phones.map((device) => ({ id: phoneGroup(device.id), name: t`控制 ${device.name}`, offline: !device.online }));
  const serverRows = linkedServers.servers.map((server) => {
    const online = server.online && linkedStatus[server.id] !== 'offline';
    const status = !online ? t`离线` : !server.compatible ? t`版本不兼容` : !server.outbound ? t`未允许` : undefined;
    return { id: serverGroup(server.id), name: server.name, alias: server.alias, status };
  });
  // A revoked phone has no row, so it is not counted; until the list arrives, every pick is.
  const phonePicks = phoneGroups(picked);
  const serverPicks = serverGroups(picked);
  const count = (phones.length ? phonePicks.filter((id) => rows.some((row) => row.id === id)).length : phonePicks.length)
    + serverPicks.filter((id) => serverRows.some((row) => row.id === id)).length
    + picked.filter((id) => pluginGroups.available.includes(id) || (agents && (id === AGENT_CALL_TOOL_GROUP || id === SESSION_MESSAGE_TOOL_GROUP))).length;
  const n = offCount;
  // With switches and nothing changed, everything installed is on: 默认, not 未开启.
  const summary = [count ? t`${count} 项` : '', offCount ? t`已关 ${n}` : ''].filter(Boolean).join(' · ') || (extensions ? t`默认` : t`未开启`);
  const checkboxRow = (key: string, checked: boolean, name: string, onCheckedChange: (on: boolean) => void, trailing?: ReactNode) => (
    <DropdownMenuCheckboxItem key={key} checked={checked} textValue={name} onCheckedChange={onCheckedChange} onSelect={(event) => event.preventDefault()}>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {trailing}
    </DropdownMenuCheckboxItem>
  );
  const items = (
    <>
      {agents && checkboxRow(AGENT_CALL_TOOL_GROUP, picked.includes(AGENT_CALL_TOOL_GROUP), t`调用其他 Agent`, (on) => toggle(AGENT_CALL_TOOL_GROUP, on))}
      {agents && checkboxRow(SESSION_MESSAGE_TOOL_GROUP, picked.includes(SESSION_MESSAGE_TOOL_GROUP), t`给其他会话发消息`, (on) => toggle(SESSION_MESSAGE_TOOL_GROUP, on))}
      {pluginGroups.rows.map((row) => checkboxRow(
        row.id,
        picked.includes(row.id),
        row.name,
        (on) => toggle(row.id, on),
        row.off && <span className="shrink-0 text-xs text-fg-3">{t`已停用`}</span>,
      ))}
      {rows.length > 0 && <DropdownMenuLabel>{t`手机`}</DropdownMenuLabel>}
      {rows.map((row) => checkboxRow(
        row.id,
        picked.includes(row.id),
        row.name,
        (on) => toggle(row.id, on),
        row.offline && <span className="shrink-0 text-xs text-fg-3">{t`离线`}</span>,
      ))}
      {serverRows.length > 0 && <DropdownMenuLabel>{t`互联机器`}</DropdownMenuLabel>}
      {serverRows.map((row) => checkboxRow(
        row.id,
        picked.includes(row.id),
        row.name,
        (on) => toggle(row.id, on),
        row.status
          ? <span className="shrink-0 text-xs text-fg-3">{row.status}</span>
          : row.alias && row.alias !== row.name && <span className="shrink-0 font-mono text-2xs text-fg-4">{row.alias}</span>,
      ))}
      {mcpRows.length > 0 && <DropdownMenuLabel>{t`MCP`}</DropdownMenuLabel>}
      {mcpRows.map((name) => {
        const tools = toolCount.get(name);
        return checkboxRow(
          `${MCP_PREFIX}${name}`,
          !off.includes(`${MCP_PREFIX}${name}`),
          name,
          (on) => toggleExtension(`${MCP_PREFIX}${name}`, !on),
          tools !== undefined && <span className="shrink-0 text-xs tabular-nums text-fg-3">{tools}</span>,
        );
      })}
      {skillRows.length > 0 && <DropdownMenuLabel>{t`Skills`}</DropdownMenuLabel>}
      {skillRows.map((name) => checkboxRow(`${SKILL_PREFIX}${name}`, !off.includes(`${SKILL_PREFIX}${name}`), name, (on) => toggleExtension(`${SKILL_PREFIX}${name}`, !on)))}
      {extensions && open && loaded.loading && (
        <div className="flex min-h-11 items-center px-3 md:min-h-8 md:px-2"><Spinner /></div>
      )}
      {extensions && open && loaded.failed && (
        <DropdownMenuItem onSelect={(event) => { event.preventDefault(); loaded.retry(); }}>
          <span className="min-w-0 flex-1 truncate text-fg-3">{t`无法读取技能与工具`}</span>
          <span className="shrink-0 text-xs">{t`重试`}</span>
        </DropdownMenuItem>
      )}
      {footnote && (rows.length > 0 || serverRows.length > 0 || pluginGroups.rows.length > 0 || mcpRows.length > 0 || skillRows.length > 0) && <div className="px-2 pb-1.5 pt-1 text-xs text-fg-3">{footnote}</div>}
    </>
  );
  if (inMenu) {
    // Says what is on only when something differs from the default.
    return (
      <MenuSub icon={<IconPuzzle />} label={label} value={count || offCount ? summary : undefined} disabled={disabled} onOpenChange={(next) => { setOpen(next); if (next) load(); }} className="w-[min(22rem,calc(100vw-24px))]">
        {items}
      </MenuSub>
    );
  }
  return (
    <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (next) load(); }}>
      <Tip label={label}>
        <DropdownMenuTrigger
          aria-label={label}
          disabled={disabled}
          className={cn(
            'inline-flex h-11 min-w-0 items-center gap-1.5 rounded-md px-2 text-sm text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 disabled:hover:bg-transparent data-[state=open]:bg-hover data-[state=open]:text-fg md:h-7 md:min-w-7 md:justify-center md:px-1.5 md:text-xs [&_svg]:size-4 [&_svg]:shrink-0',
            count > 0 && 'text-fg-2',
          )}
        >
          <IconPuzzle />
          {/* In the mobile sheet the section heading already names the picker, so the button says what is on. */}
          <span className="min-w-0 flex-1 truncate text-left md:hidden">{summary}</span>
          {count > 0 && <span className="hidden tabular-nums md:inline">{count}</span>}
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent side="top" align="start" className="max-h-[min(60dvh,420px)] w-[min(22rem,calc(100vw-24px))] overflow-y-auto">
        {items}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
