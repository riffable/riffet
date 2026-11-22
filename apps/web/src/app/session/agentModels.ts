import { useCallback, useEffect, useRef, useState } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { ModelInfo, NativeBackendId } from '@contracts';
import { apiFor } from '@/lib/api';
import { cachedCatalog, rememberCatalog } from '@/lib/catalog-cache';
import { errorMessage } from '@/lib/utils';
import { useCatalog } from '../state/stores';

/** The catalog cache's key, shared with `catalogStore`, so a list read there paints here at once and back. */
const catalogKey = (serverId: string, projectId: string, backendId: NativeBackendId, profileId?: string) => `${serverId ? `${serverId}@${projectId}` : projectId}:${backendId}:${profileId ?? 'default'}`;

export interface AgentModels {
  /** The last known models of one agent's provider: empty when it answered with none, undefined while nothing is known. */
  read(backendId: NativeBackendId, profileId?: string): ModelInfo[] | undefined;
  /** Why the last read failed, or the agent's own reason for having no models. */
  issue(backendId: NativeBackendId, profileId?: string): string | undefined;
  loading(backendId: NativeBackendId, profileId?: string): boolean;
  /** Reads the list once per page visit; `force` reads it again. Answers repaint the picker. */
  load(backendId: NativeBackendId, profileId?: string, force?: boolean): void;
}

/**
 * Model lists of agents other than the one a new session is set to, for the picker's agent column.
 * Nothing is read until the reader looks: the column paints cached lists and reads on preview.
 * A new agent list (providers edited in Settings) forgets what was read, so the next look reads again.
 */
export function useAgentModels(projectId: string, serverId = ''): AgentModels {
  const [, repaint] = useState(0);
  const revision = useCatalog((state) => state.revision);
  /** This visit's answers, ahead of the persisted cache, which drops lists past its age limit and empty ones. */
  const fresh = useRef(new Map<string, ModelInfo[]>());
  const issues = useRef(new Map<string, string>());
  const pending = useRef(new Set<string>());
  const visited = useRef(new Set<string>());
  useEffect(() => {
    fresh.current.clear();
    issues.current.clear();
    visited.current.clear();
  }, [revision, projectId, serverId]);
  const read = useCallback((backendId: NativeBackendId, profileId?: string) => {
    const key = catalogKey(serverId, projectId, backendId, profileId);
    return fresh.current.get(key) ?? cachedCatalog(key)?.models;
  }, [serverId, projectId]);
  const load = useCallback((backendId: NativeBackendId, profileId?: string, force = false) => {
    const key = catalogKey(serverId, projectId, backendId, profileId);
    if (pending.current.has(key) || (!force && visited.current.has(key))) return;
    pending.current.add(key);
    visited.current.add(key);
    repaint((value) => value + 1);
    void apiFor(serverId || undefined).backendCatalog(backendId, profileId, projectId || undefined).then((entry) => {
      fresh.current.set(key, entry.models);
      rememberCatalog(key, entry);
      if (entry.models.length) issues.current.delete(key);
      else issues.current.set(key, entry.reason?.trim() || '');
    }, (error: unknown) => {
      // Never empty: a failure is what offers the agent's default model in its place.
      issues.current.set(key, errorMessage(error, '') || i18n._(msg`无法加载模型列表`));
      // A failed read is tried again on the next look rather than held for the rest of the visit.
      visited.current.delete(key);
    }).finally(() => {
      pending.current.delete(key);
      repaint((value) => value + 1);
    });
  }, [serverId, projectId]);
  return {
    read,
    issue: (backendId, profileId) => issues.current.get(catalogKey(serverId, projectId, backendId, profileId)) || undefined,
    loading: (backendId, profileId) => pending.current.has(catalogKey(serverId, projectId, backendId, profileId)),
    load,
  };
}
