import type { RpcItem, RpcTurn } from './types.js';

/**
 * A turn summarised by a marker (status, completion time, and each item's id, type, status and the
 * sizes of its fields): a settled turn whose marker is unchanged since the last read cannot have changed.
 */

const markers = new WeakMap<RpcTurn, string>();

function statusKey(status: RpcTurn['status']): string {
  return typeof status === 'string' ? status : status?.type ?? '';
}

function itemStamp(item: RpcItem): string {
  let stamp = `${item.id ?? ''}:${item.type}`;
  for (const key in item) {
    const value = item[key];
    if (typeof value === 'string') stamp += `|${key}${value.length}`;
    else if (Array.isArray(value)) stamp += `|${key}[${value.length}]`;
    else if (value && typeof value === 'object') stamp += `|${key}{${Object.keys(value).length}}`;
    else if (value !== undefined) stamp += `|${key}=${String(value)}`;
  }
  return stamp;
}

/** Changes whenever the turn's status, completion or any of its items' shape does. */
export function turnMarker(turn: RpcTurn): string {
  const cached = markers.get(turn);
  if (cached !== undefined) return cached;
  const marker = `${statusKey(turn.status)}|${turn.completedAt ?? ''}|${(turn.items ?? []).map(itemStamp).join(',')}`;
  markers.set(turn, marker);
  return marker;
}

export function turnMarkers(turns: readonly RpcTurn[]): Map<string, string> {
  return new Map(turns.map(turn => [turn.id, turnMarker(turn)]));
}
