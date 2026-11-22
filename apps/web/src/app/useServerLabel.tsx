import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { ServerPlatform } from '@contracts';
import { serverOfObject } from '@/lib/server-routing';
import { useLists } from './state/stores';

/** Readable platform summary from Node's `os` and `arch`, e.g. `macOS · arm64`. */
export function formatServerPlatform(platform?: ServerPlatform): string {
  if (!platform) return '';
  const os = platform.os === 'darwin' ? 'macOS' : platform.os === 'linux' ? 'Linux' : platform.os === 'win32' ? 'Windows' : platform.os;
  return platform.arch ? `${os} · ${platform.arch}` : os;
}

export interface ServerBadgeInfo {
  id: string;
  name: string;
  alias: string;
  label: string;
  offline: boolean;
  /** True when two or more linked peers exist, so a bare link icon is no longer enough to tell them apart. */
  multiPeer: boolean;
}

/**
 * Full server metadata for an object on a linked server; `undefined` for the entry server's own objects,
 * so a workbench with no links shows nothing new (docs/SERVER-LINKS.md §10).
 */
export function useServerBadge(objectId: string | undefined): ServerBadgeInfo | undefined {
  const { t } = useLingui();
  const serverId = serverOfObject(objectId);
  const server = useLists((state) => serverId ? state.servers.find((item) => item.id === serverId) : undefined);
  const peerCount = useLists((state) => state.servers.filter((item) => !item.self).length);
  const status = useLists((state) => serverId ? state.linkedStatus[serverId] : undefined);
  if (!serverId || !server) return undefined;
  const offline = status === 'offline' || server.online === false;
  const label = offline ? t`${server.name} · 离线` : server.name;
  return {
    id: serverId,
    name: server.name,
    alias: server.alias || server.name,
    label,
    offline,
    multiPeer: peerCount >= 2,
  };
}

/**
 * The name of the linked server an object lives on, with 离线 when it cannot be reached; `undefined` for the entry
 * server's own objects, so a workbench with no links shows nothing new (docs/SERVER-LINKS.md §10).
 */
export function useServerLabel(objectId: string | undefined): string | undefined {
  return useServerBadge(objectId)?.label;
}

/** The linked server an object lives on, as a quiet label beside its name; nothing for the entry's own objects. */
export function ServerTag({ objectId, className }: { objectId: string; className?: string }) {
  const label = useServerLabel(objectId);
  return label ? <span className={className ?? 'shrink-0 truncate text-2xs font-normal text-fg-4'}>{label}</span> : null;
}

/**
 * The servers new work can be put on: this one (value `''`) and each linked server it may operate. Empty without
 * links, so a picker built on it stays hidden on a single server.
 */
export function useServerChoices(): Array<{ value: string; label: string; disabled?: boolean }> {
  const servers = useLists((state) => state.servers);
  const linkedStatus = useLists((state) => state.linkedStatus);
  return useMemo(() => {
    const usable = servers.filter((item) => item.self || (item.outbound && item.compatible));
    if (usable.length < 2) return [];
    return usable.map((item) => ({
      value: item.self ? '' : item.id,
      label: item.name,
      ...(!item.self && (!item.online || linkedStatus[item.id] === 'offline') ? { disabled: true } : {}),
    }));
  }, [servers, linkedStatus]);
}

export interface HomeServerOption {
  /** `''` for the entry server; the linked server's `serverId` otherwise. */
  id: string;
  name: string;
  alias?: string;
  note?: string;
  platform?: ServerPlatform;
  self: boolean;
  online: boolean;
  usable: boolean;
  reason?: string;
}

/**
 * Every server known to the workbench for the new-session server pill (docs/SERVER-LINKS.md §10). Ordered
 * self -> online usable -> unavailable, with unavailable peers disabled and labelled so a newly linked peer
 * does not silently vanish. Empty when there are no linked servers.
 */
export function useHomeServerOptions(): HomeServerOption[] {
  const { t } = useLingui();
  const servers = useLists((state) => state.servers);
  const linkedStatus = useLists((state) => state.linkedStatus);
  return useMemo(() => {
    if (servers.length < 2) return [];
    const mapped = servers.map((item): HomeServerOption => {
      if (item.self) {
        return {
          id: '', name: item.name, self: true, online: true, usable: true,
          ...(item.alias ? { alias: item.alias } : {}),
          ...(item.platform ? { platform: item.platform } : {}),
        };
      }
      const online = item.online && linkedStatus[item.id] !== 'offline';
      const reason = !online ? t`离线` : !item.compatible ? t`版本不兼容` : !item.outbound ? t`未允许本机操作` : undefined;
      return {
        id: item.id, name: item.name, self: false, online, usable: !reason,
        ...(item.alias ? { alias: item.alias } : {}),
        ...(item.note ? { note: item.note } : {}),
        ...(item.platform ? { platform: item.platform } : {}),
        ...(reason ? { reason } : {}),
      };
    });
    const rank = (item: HomeServerOption) => item.self ? 0 : item.usable ? 1 : 2;
    return mapped.sort((left, right) => rank(left) - rank(right));
  }, [servers, linkedStatus, t]);
}
