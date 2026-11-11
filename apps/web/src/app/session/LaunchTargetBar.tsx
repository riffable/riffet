import { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { LaunchTarget, NativeBackendCatalogEntry, NativeBackendId } from '@contracts';
import { api } from '@/lib/api';
import { cachedCatalog, rememberCatalog } from '@/lib/catalog-cache';
import { catalogParams, catalogSelection, parseSelection } from '@/lib/models';
import { cleanLabel } from '@/lib/utils';
import { ApprovalPicker } from './ApprovalPicker';
import { BackendPicker } from './BackendPicker';
import { ModePicker } from './Composer';
import type { Choice } from './model';
import { ModelPicker } from './ModelPicker';
import { ProfilePicker } from './ProfilePicker';

/** One launch's backend, profile, model, mode and approval, as the editors hold it. */
export interface LaunchTargetShape { backendId?: NativeBackendId; profileId?: string; model?: string; mode?: string; approval?: string }

export const launchTargetOf = (shape: LaunchTargetShape): LaunchTarget => ({
  ...(shape.backendId ? { backendId: shape.backendId } : {}),
  ...(shape.profileId ? { backendProfileId: shape.profileId } : {}),
  ...(shape.model ? { model: shape.model } : {}),
  ...(shape.mode ? { mode: shape.mode } : {}),
  ...(shape.approval ? { approval: shape.approval } : {}),
});

/** The catalog cache key the catalog store uses, so launch editors reuse what the home page loaded. */
export const catalogKey = (projectId: string, backendId: NativeBackendId, profileId?: string) => `${projectId}:${backendId}:${profileId ?? 'default'}`;

/**
 * The model catalogs of the wanted agent/profile pairs. `/api/backends` deliberately ships no
 * models, so each pair is read from its catalog endpoint (last-known first, like the home page).
 */
export function useBackendCatalogs(projectId: string, wants: readonly { backendId?: NativeBackendId; profileId?: string }[]) {
  const [fetched, setFetched] = useState<ReadonlyMap<string, NativeBackendCatalogEntry>>(new Map());
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  const attempted = useRef(new Set<string>());
  const wantsKey = wants.map((want) => (want.backendId ? catalogKey(projectId, want.backendId, want.profileId) : '')).filter(Boolean).join('|');
  // The stored copy is known in the render its key appears, so it is merged here rather than after paint.
  const catalogs = useMemo(() => {
    const merged = new Map(fetched);
    for (const key of wantsKey ? wantsKey.split('|') : []) {
      const cached = merged.has(key) ? undefined : cachedCatalog(key);
      if (cached) merged.set(key, cached);
    }
    return merged;
  }, [fetched, wantsKey]);
  // A wanted pair with no catalog and no finished request is still waiting, from its first render.
  const pending = useMemo(() => {
    const next = new Set(loading);
    for (const key of projectId && wantsKey ? wantsKey.split('|') : []) if (!catalogs.has(key) && !settled.has(key)) next.add(key);
    return next;
  }, [loading, catalogs, settled, projectId, wantsKey]);
  const read = useCallback((key: string, want: { backendId: NativeBackendId; profileId?: string }) => {
    setLoading((previous) => new Set(previous).add(key));
    void api.backendCatalog(want.backendId, want.profileId, projectId)
      .then((entry) => { rememberCatalog(key, entry); setFetched((previous) => new Map(previous).set(key, entry)); })
      .catch(() => undefined)
      .finally(() => {
        setLoading((previous) => { const next = new Set(previous); next.delete(key); return next; });
        setSettled((previous) => new Set(previous).add(key));
      });
  }, [projectId]);
  useEffect(() => {
    if (!projectId) return;
    for (const want of wants) {
      if (!want.backendId) continue;
      const key = catalogKey(projectId, want.backendId, want.profileId);
      if (attempted.current.has(key)) continue;
      attempted.current.add(key);
      read(key, { backendId: want.backendId, profileId: want.profileId });
    }
    // `wants` is identified by wantsKey; its identity changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, wantsKey, read]);
  /** Re-reads one pair as its model list opens, leaving the last known list in place meanwhile. */
  const refresh = useCallback((want: { backendId?: NativeBackendId; profileId?: string }) => {
    if (!projectId || !want.backendId) return;
    read(catalogKey(projectId, want.backendId, want.profileId), { backendId: want.backendId, profileId: want.profileId });
  }, [projectId, read]);
  return { catalogs, pending, refresh };
}

/**
 * One launch target as a row of the composer's own pickers: profile (when the backend has several),
 * model with its parameters, mode and approval. Only the choices the backend supports are shown.
 * `showBackend` is off where the backend is picked elsewhere (the handoff's cards); `showMode`
 * is off there too — a handoff continues work already under way, so only model and approval differ.
 */
export function LaunchTargetBar({ value, onChange, backends, catalogs, pending, projectId, disabled, showBackend = true, showMode = true, refreshCatalog }: {
  value: LaunchTargetShape;
  onChange: (patch: Partial<LaunchTargetShape>) => void;
  backends: NativeBackendCatalogEntry[];
  catalogs: ReadonlyMap<string, NativeBackendCatalogEntry>;
  pending: ReadonlySet<string>;
  projectId: string;
  disabled?: boolean;
  showBackend?: boolean;
  showMode?: boolean;
  refreshCatalog?: (backendId: NativeBackendId, profileId?: string) => void;
}) {
  const { t } = useLingui();
  if (!value.backendId) return null;
  const backendId = value.backendId;
  const entry = backends.find((item) => item.backendId === backendId);
  const key = catalogKey(projectId, backendId, value.profileId);
  const catalog = catalogs.get(key);
  const capabilities = catalog?.capabilities ?? entry?.capabilities;
  const models: Choice[] = [{ id: '', label: t`默认模型` }, ...(catalog?.models ?? []).map((model) => ({ id: model.value, label: cleanLabel(model.name) }))];
  // The model selection carries its parameters (effort, fast, …) in the same string the
  // session composer submits; the picker edits them through the catalog's own definitions.
  const parsedModel = parseSelection(value.model ?? '');
  const selectedModel = (catalog?.models ?? []).some((model) => model.value === parsedModel.model) ? parsedModel.model : '';
  const modelParams = catalog ? catalogParams(catalog.models, selectedModel, parsedModel.params) : [];
  const modes = capabilities?.modes ?? [];
  const permissions = capabilities?.permissions ?? [];
  return (
    <>
      {showBackend && <BackendPicker backends={backends} backendId={value.backendId} disabled={disabled} onChange={(next) => onChange({ backendId: next, profileId: undefined, model: undefined, mode: undefined, approval: undefined })} />}
      {entry && entry.profiles.length > 1 && (
        <ProfilePicker profiles={entry.profiles} value={value.profileId} disabled={disabled} onChange={(profileId) => onChange({ profileId, model: undefined })} />
      )}
      <ModelPicker side="bottom" models={models} value={selectedModel} params={modelParams} placeholder={t`默认模型`} loading={pending.has(key) && !catalog} disabled={disabled || (pending.has(key) && !catalog)} refreshCatalog={() => refreshCatalog?.(backendId, value.profileId)} usageScopeKey={`${backendId}|${value.profileId ?? ''}`} onChange={(id) => onChange({ model: id ? catalogSelection(catalog?.models ?? [], id, {}) : undefined })} onParamChange={(id, next) => { if (selectedModel) onChange({ model: catalogSelection(catalog?.models ?? [], selectedModel, { ...parsedModel.params, [id]: next }, id) }); }} />
      {showMode && capabilities?.supportsModeSelection && modes.length > 0 && (
        <ModePicker modes={modes} value={value.mode ?? modes.find((mode) => mode.id === 'agent')?.id ?? modes[0]?.id} disabled={disabled} onChange={(id) => onChange({ mode: id })} />
      )}
      {capabilities?.supportsPermissionSelection && permissions.length > 0 && (
        <ApprovalPicker side="bottom" options={permissions} value={value.approval ?? permissions[0]?.id ?? ''} disabled={disabled} onChange={(id) => onChange({ approval: id })} />
      )}
    </>
  );
}
