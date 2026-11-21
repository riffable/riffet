import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import { serverOfObject } from '@/lib/server-routing';
import { useLists } from './state/stores';

/**
 * The name of the linked server an object lives on, with 离线 when it cannot be reached; `undefined` for the entry
 * server's own objects, so a workbench with no links shows nothing new (docs/SERVER-LINKS.md §10).
 */
export function useServerLabel(objectId: string | undefined): string | undefined {
  const { t } = useLingui();
  const serverId = serverOfObject(objectId);
  const name = useLists((state) => serverId ? state.servers.find((item) => item.id === serverId)?.name ?? '' : undefined);
  const offline = useLists((state) => serverId ? state.linkedStatus[serverId] === 'offline' || state.servers.find((item) => item.id === serverId)?.online === false : false);
  if (!serverId || name === undefined) return undefined;
  return offline ? t`${name} · 离线` : name;
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
