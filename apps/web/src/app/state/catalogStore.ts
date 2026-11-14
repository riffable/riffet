import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { AppSettings, NativeBackendCatalogEntry, NativeBackendId, NativeBackendProfile } from '@contracts';
import { isNativeBackendId } from '@contracts';
import { api, isUnreachable } from '@/lib/api';
import { publishBackendLabels } from '@/lib/backends';
import { LEGACY_DEFAULT_BACKEND_ID } from '@/lib/legacy-identity';
import { cachedCatalog, rememberCatalog } from '@/lib/catalog-cache';
import { toast } from '@/lib/toast';
import { errorMessage, readStored, singleFlight } from '@/lib/utils';
import type { ProfileCatalog } from '../ProjectHome';
import { STORAGE_KEYS } from './navStore';
import { createStore } from '@/lib/store';

export interface CatalogState {
  backends: NativeBackendCatalogEntry[];
  /** The agent and provider a new session would start with. */
  homeBackendId: NativeBackendId;
  homeProfileId?: string;
  result?: { key: string; entry: NativeBackendCatalogEntry };
  profileCatalogs?: { key: string; entries: ProfileCatalog[] };
  loading: boolean;
  error: string;
  loadedKey: string;
  /** Bumped when the backend list is re-read, so the catalog behind it is loaded again. */
  revision: number;
}

/** The agent a new session starts with once the one chosen is not offered (its plugin is off or gone): the server's default, else the first that is available. */
function offeredHome(current: CatalogState, backends: NativeBackendCatalogEntry[], preferred?: NativeBackendId): Partial<CatalogState> {
  if (!backends.length || backends.some((entry) => entry.backendId === current.homeBackendId)) return {};
  const next = backends.find((entry) => entry.backendId === preferred) ?? backends.find((entry) => entry.available) ?? backends[0]!;
  return { homeBackendId: next.backendId, homeProfileId: undefined };
}

const profilesCacheKey = (projectId: string, backendId: NativeBackendId, profileId: string) => `${projectId}:${backendId}:${profileId}`;

export interface CatalogTarget {
  projectId: string;
  sessionId: string;
  backendId: NativeBackendId;
  profileId?: string;
  /** Identifies this target in `result` / `loadedKey`. */
  key: string;
}

/**
 * Backends, their providers and model catalogs, and the agent chosen for new sessions. [offline]
 * says the lists on screen are not the server's current answer; the sidebar already says so, so a
 * failed read here is not reported on top of it.
 */
export function createCatalogStore({ offline }: { offline: () => boolean }) {
  // The agent last picked here, from the first frame: the server's settings arrive a render later,
  // and starting on the built-in default would paint that agent's button and then swap it.
  const stored = readStored(STORAGE_KEYS.backend);
  const store = createStore<CatalogState>({ backends: [], homeBackendId: isNativeBackendId(stored) ? stored : LEGACY_DEFAULT_BACKEND_ID, loading: true, error: '', loadedKey: '', revision: 0 });
  let request: AbortController | undefined;
  const cache = new Map<string, NativeBackendCatalogEntry>();
  let initialized = false;
  let preferredHome: NativeBackendId | undefined;
  const report = (error: unknown, fallback: string) => { if (!offline() && !isUnreachable(error)) toast.error(errorMessage(error, fallback)); };

  const actions = {
    refreshBackends: singleFlight(async () => {
      try {
        const backends = await api.backends();
        cache.clear();
        publishBackendLabels(backends);
        store.set((current) => ({ backends, profileCatalogs: undefined, revision: current.revision + 1, ...offeredHome(current, backends, preferredHome) }));
      }
      catch (error) { report(error, i18n._(msg`无法加载 Agent 列表`)); }
    }),
    /** Reads again whatever the first attempt could not fetch, once the server answers. */
    refreshMissing() {
      if (!store.get().revision) void actions.refreshBackends();
    },
    /** The first bootstrap decides the starting agent: the one last picked here, else the server's default. */
    initHome(settings: AppSettings) {
      if (initialized) return;
      initialized = true;
      const saved = readStored(STORAGE_KEYS.backend);
      preferredHome = settings.defaultBackendId;
      const id = isNativeBackendId(saved) ? saved : settings.defaultBackendId ?? LEGACY_DEFAULT_BACKEND_ID;
      const home = { homeBackendId: id, homeProfileId: settings.nativeBackendDefaults?.[id]?.profileId };
      store.set((current) => ({ ...home, ...offeredHome({ ...current, ...home }, current.backends, preferredHome) }));
    },
    setHome(backendId: NativeBackendId, profileId: string | undefined) { store.set({ homeBackendId: backendId, homeProfileId: profileId }); },
    setHomeProfile(profileId: string | undefined) { store.set({ homeProfileId: profileId }); },

    /** Every provider configured for the agent being started, loaded and cached per project/provider. */
    loadProfiles(projectId: string, backendId: NativeBackendId, profiles: NativeBackendProfile[], key: string, refresh = false): () => void {
      const controller = new AbortController();
      const cacheKey = (profileId: string) => profilesCacheKey(projectId, backendId, profileId);
      // Each provider is shown as soon as it answers, in configured order: a slow or failing gateway must not
      // hold back, or blank, the others. The last known list paints first and a fresh answer replaces it.
      const loaded = new Map(actions.peekProfiles(projectId, backendId, profiles).map((entry) => [entry.profile.id, entry] as const));
      const publish = () => {
        if (!controller.signal.aborted) store.set({ profileCatalogs: { key, entries: profiles.flatMap((profile) => loaded.get(profile.id) ?? []) } });
      };
      if (loaded.size) publish();
      for (const profile of profiles) {
        const k = cacheKey(profile.id);
        if (!refresh && cache.get(k)) continue;
        void api.backendCatalog(backendId, profile.id, projectId, controller.signal).then((entry) => {
          cache.set(k, entry);
          rememberCatalog(k, entry);
          loaded.set(profile.id, { profile, models: entry.models });
          publish();
        }).catch(() => undefined);
      }
      return () => controller.abort();
    },
    /** What `loadProfiles` paints at once, for a render that cannot wait for its effect. */
    peekProfiles(projectId: string, backendId: NativeBackendId, profiles: NativeBackendProfile[]): ProfileCatalog[] {
      return profiles.flatMap((profile) => {
        const key = profilesCacheKey(projectId, backendId, profile.id);
        const entry = cache.get(key) ?? cachedCatalog(key);
        return entry ? [{ profile, models: entry.models }] : [];
      });
    },
    clearProfileCatalogs() { if (store.get().profileCatalogs) store.set({ profileCatalogs: undefined }); },

    abortLoad() { request?.abort(); },
    /**
     * The last known catalog `load` would paint at once. The target's key changes in the render that
     * selects it while `load` runs only after that render paints, so the render reads this instead
     * of showing a frame of loading.
     */
    peek(target: Omit<CatalogTarget, 'key'>): NativeBackendCatalogEntry | undefined {
      const sharedKey = `${target.projectId}:${target.backendId}:${target.profileId ?? 'default'}`;
      return cachedCatalog(target.sessionId ? `session:${target.sessionId}` : sharedKey) ?? cachedCatalog(sharedKey);
    },
    async load(target: CatalogTarget) {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const sharedKey = `${target.projectId}:${target.backendId}:${target.profileId ?? 'default'}`;
      const storeKey = target.sessionId ? `session:${target.sessionId}` : sharedKey;
      // Paint the last known catalog at once and refresh it quietly; only a first load shows a spinner.
      const cached = actions.peek(target);
      if (cached) {
        store.set({ result: { key: target.key, entry: cached }, loading: false, loadedKey: target.key });
      } else store.set({ loading: true });
      store.set({ error: '' });
      try {
        const entry = target.sessionId
          ? await api.sessionCatalog(target.sessionId, controller.signal)
          : await api.backendCatalog(target.backendId, target.profileId, target.projectId, controller.signal);
        if (controller.signal.aborted) return;
        rememberCatalog(storeKey, entry);
        if (cached && !entry.models.length) {
          if (entry.reason || !entry.available) store.set({ error: entry.reason ?? i18n._(msg`所选后端不可用`) });
          return;
        }
        store.set({ result: { key: target.key, entry }, ...(entry.reason || !entry.available ? { error: entry.reason ?? i18n._(msg`所选后端不可用`) } : {}) });
      } catch (error) {
        if (!controller.signal.aborted && !cached) store.set({ error: errorMessage(error, i18n._(msg`无法加载模型列表`)) });
      } finally {
        if (!controller.signal.aborted) store.set({ loading: false, loadedKey: target.key });
      }
    },
  };
  return { ...store, ...actions };
}

export type CatalogStore = ReturnType<typeof createCatalogStore>;
