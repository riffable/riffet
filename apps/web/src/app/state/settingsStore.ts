import type { AppSettings, NativeBackendDefaults, NativeBackendId } from '@contracts';
import { api } from '@/lib/api';
import { mergeSavedSettings, preserveNewerDefaultModel } from '@/lib/reconcile';
import { LEGACY_DEFAULT_BACKEND_ID } from '@/lib/legacy-identity';
import { createStore } from '@/lib/store';

/** The fields this store writes: the per-backend defaults and the two settings that mirror them. */
type DefaultsPatch = Partial<Pick<AppSettings, 'nativeBackendDefaults' | 'defaultBackendId' | 'defaultModel'>>;
const DEFAULT_KEYS = ['defaultModel', 'defaultBackendId', 'nativeBackendDefaults'] as const;
const touchesDefaults = (patch: Partial<AppSettings>) => DEFAULT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(patch, key));

export interface SettingsHooks {
  /** A saved patch made another backend the default; the new-session picker follows it. */
  onDefaultBackend?: (backendId: NativeBackendId, profileId: string | undefined) => void;
}

/**
 * The server's settings, plus the only path that writes the per-backend defaults.
 *
 * Those defaults travel as one `nativeBackendDefaults` map, so two writers building that map from
 * their own snapshots overwrite each other. Every write here is therefore queued, and builds its
 * map from the latest settings at the moment it runs (read latest, change one backend's entry,
 * write back). Writes from other browser tabs are not coordinated.
 */
export function createSettingsStore(initial: AppSettings, hooks: SettingsHooks = {}) {
  const store = createStore<{ settings: AppSettings }>({ settings: initial });
  /** Bumped whenever a default is changed or applied, so an older read or write can tell it lost. */
  let revision = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const get = () => store.get().settings;
  const put = (settings: AppSettings) => store.set({ settings });
  const enqueue = <R,>(job: () => Promise<R>): Promise<R> => {
    const run = tail.catch(() => undefined).then(job);
    tail = run;
    return run;
  };

  /** Folds in what the server answered to a PATCH, touching only the fields the patch carried. */
  const applySaved = (response: AppSettings, patch: Partial<AppSettings>) => {
    const next = mergeSavedSettings(get(), response, patch);
    if (touchesDefaults(patch)) revision += 1;
    put(next);
    if (patch.defaultBackendId) hooks.onDefaultBackend?.(patch.defaultBackendId, next.nativeBackendDefaults?.[patch.defaultBackendId]?.profileId);
  };

  const withBackendEntry = (latest: AppSettings, backendId: NativeBackendId, entry: NativeBackendDefaults): NonNullable<AppSettings['nativeBackendDefaults']> => ({ ...latest.nativeBackendDefaults, [backendId]: entry });

  // The optimistic path (`remember`) writes in the background; only the newest ticket still writes,
  // carrying the accumulated state of every older one.
  let ticket = 0;
  const pendingKeys = new Set<'defaultBackendId' | 'defaultModel'>();

  return {
    ...store,
    current: get,
    revision: () => revision,
    /** A bootstrap read replaces settings unless a default was changed while it was in flight. */
    absorb(incoming: AppSettings, revisionAtRequest: number): AppSettings {
      const next = preserveNewerDefaultModel(incoming, get(), revisionAtRequest, revision);
      put(next);
      return next;
    },
    /** For sections that PATCH keys no one else writes and hand the server's answer over. */
    applySaved,
    /**
     * Writes a change to one backend's defaults. The patch is built when the write's turn comes, from
     * the settings as they are then; `change` returns that backend's new entry, or undefined for
     * no change. An optimistic change made while the write was in flight is not rolled back by its answer.
     */
    updateBackendDefaults(backendId: NativeBackendId, change: (current: NativeBackendDefaults | undefined) => NativeBackendDefaults | undefined, extra: Pick<DefaultsPatch, 'defaultBackendId' | 'defaultModel'> = {}): Promise<void> {
      return enqueue(async () => {
        const latest = get();
        const entry = change(latest.nativeBackendDefaults?.[backendId]);
        if (!entry) return;
        const patch: DefaultsPatch = { ...extra, nativeBackendDefaults: withBackendEntry(latest, backendId, entry) };
        const started = revision;
        const saved = await api.updateSettings(patch);
        if (revision === started) { applySaved(saved, patch); return; }
        const { nativeBackendDefaults: _a, defaultBackendId: _b, defaultModel: _c, ...rest } = patch;
        applySaved(saved, rest);
      });
    },
    /**
     * Applies a change to one backend's defaults that the server already made (a provider was removed,
     * its default model dropped). Queued so it lands after any write whose answer would overwrite it.
     */
    syncBackendDefaults(backendId: NativeBackendId, change: (current: NativeBackendDefaults | undefined) => NativeBackendDefaults | undefined): Promise<void> {
      return enqueue(async () => {
        const latest = get();
        const entry = change(latest.nativeBackendDefaults?.[backendId]);
        if (!entry) return;
        const nativeBackendDefaults = withBackendEntry(latest, backendId, entry);
        applySaved({ ...latest, nativeBackendDefaults }, { nativeBackendDefaults });
      });
    },
    /**
     * A selection made in the composer or the new-session picker: shown at once, saved in the
     * background. Rapid choices coalesce, and the write that survives carries all of them.
     */
    remember(backendId: NativeBackendId, patch: { profileId?: string; model?: string }, makeDefault = false): void {
      const latest = get();
      const entry = { ...latest.nativeBackendDefaults?.[backendId], ...patch };
      // An empty model means “use this profile’s configured default”. Do not persist it as an
      // override when clearing a selection during a profile switch.
      if (patch.model === '') delete entry.model;
      revision += 1;
      put({
        ...latest,
        nativeBackendDefaults: withBackendEntry(latest, backendId, entry),
        ...(makeDefault ? { defaultBackendId: backendId } : {}),
        ...(backendId === LEGACY_DEFAULT_BACKEND_ID && patch.model !== undefined ? { defaultModel: patch.model } : {}),
      });
      if (makeDefault) pendingKeys.add('defaultBackendId');
      if (backendId === LEGACY_DEFAULT_BACKEND_ID && patch.model !== undefined) pendingKeys.add('defaultModel');
      const mine = ++ticket;
      void enqueue(async () => {
        if (mine !== ticket) return;
        const current = get();
        const body: DefaultsPatch = {
          nativeBackendDefaults: current.nativeBackendDefaults ?? {},
          ...(pendingKeys.has('defaultBackendId') && current.defaultBackendId ? { defaultBackendId: current.defaultBackendId } : {}),
          ...(pendingKeys.has('defaultModel') && current.defaultModel !== undefined ? { defaultModel: current.defaultModel } : {}),
        };
        pendingKeys.clear();
        await api.updateSettings(body);
      }).catch((error) => { console.warn('无法保存后端默认值', error); });
    },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
