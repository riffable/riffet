import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { AppSettings, NativeBackendCatalogEntry, NativeBackendId, NativeBackendProfile } from '@contracts';
import { isNativeBackendId } from '@contracts';
import { api, apiFor, isUnreachable } from '@/lib/api';
import { publishBackendLabels } from '@/lib/backends';
import { LEGACY_DEFAULT_BACKEND_ID } from '@/lib/legacy-identity';
import { cachedCatalog, rememberCatalog } from '@/lib/catalog-cache';
import { toast } from '@/lib/toast';
import { errorMessage, readStored, singleFlight } from '@/lib/utils';
import type { ProfileCatalog } from '../ProjectHome';
import { STORAGE_KEYS } from './navStore';
import { createStore } from '@/lib/store';

export interface RemoteHomeChoice {
  backendId: NativeBackendId;
  profileId?: string;
}

export interface CatalogState {
  backends: NativeBackendCatalogEntry[];
  /** Per-linked-server agent lists, read on demand when the new-session server pill selects that server. */
  remoteBackends: Readonly<Record<string, NativeBackendCatalogEntry[]>>;
  /** Per-linked-server read-only settings (defaults only); never written back from the entry server. */
  remoteSettings: Readonly<Record<string, AppSettings>>;
  /** Per-linked-server agent/provider pick kept apart from this server's own `homeBackendId`. */
  remoteHome: Readonly<Record<string, RemoteHomeChoice>>;
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

/**
 * The agent a new session starts with once the one in place is not offered (its plugin is off or
 * gone): the server's default, else the first that is available. Nobody having chosen one yet (no
 * pick in this browser, no server default), the built-in default gives way to an agent that can run.
 */
function offeredHome(current: { homeBackendId: NativeBackendId }, backends: NativeBackendCatalogEntry[], preferred?: NativeBackendId, chosen = true): Partial<Pick<CatalogState, 'homeBackendId' | 'homeProfileId'>> {
  const entry = backends.find((item) => item.backendId === current.homeBackendId);
  if (!backends.length || (entry && (chosen || entry.available))) return {};
  const usable = backends.find((item) => item.available && item.backendId !== 'chat');
  const next = (chosen ? backends.find((item) => item.backendId === preferred) ?? usable : usable) ?? entry ?? backends[0]!;
  return next.backendId === current.homeBackendId ? {} : { homeBackendId: next.backendId, homeProfileId: undefined };
}

function initialRemoteHome(backends: NativeBackendCatalogEntry[], settings?: AppSettings): RemoteHomeChoice | undefined {
  const usable = backends.filter((item) => item.backendId !== 'chat');
  if (!usable.length) return undefined;
  const preferred = settings?.defaultBackendId && usable.find((item) => item.backendId === settings.defaultBackendId);
  const picked = (preferred?.available ? preferred : undefined)
    ?? usable.find((item) => item.available)
    ?? preferred
    ?? usable[0]!;
  const savedProfile = settings?.nativeBackendDefaults?.[picked.backendId]?.profileId;
  const profileId = savedProfile && picked.profiles.some((profile) => profile.id === savedProfile)
    ? savedProfile
    : picked.profiles.find((profile) => profile.isDefault)?.id;
  return { backendId: picked.backendId, ...(profileId ? { profileId } : {}) };
}

const serverScope = (serverId: string | undefined, projectId: string) => serverId ? `${serverId}@${projectId}` : projectId;
const profilesCacheKey = (projectId: string, backendId: NativeBackendId, profileId: string, serverId?: string) => `${serverScope(serverId, projectId)}:${backendId}:${profileId}`;

export interface CatalogTarget {
  projectId: string;
  sessionId: string;
  backendId: NativeBackendId;
  profileId?: string;
  /** Target linked server when reading a new-session catalog without a local project id. */
  serverId?: string;
  /** Identifies this target in `result` / `loadedKey`. */
  key: string;
}

const REMOTE_HOME_KEY = 'riffet.remote-home.v1';
const REMOTE_HOME_LIMIT = 32;

function readRemoteHome(): Record<string, RemoteHomeChoice> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(REMOTE_HOME_KEY) ?? '{}') as Record<string, { backendId?: unknown; profileId?: unknown }>;
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, RemoteHomeChoice> = {};
    for (const [serverId, entry] of Object.entries(raw)) {
      if (!entry || !isNativeBackendId(entry.backendId)) continue;
      out[serverId] = { backendId: entry.backendId, ...(typeof entry.profileId === 'string' && entry.profileId ? { profileId: entry.profileId } : {}) };
    }
    return out;
  } catch { return {}; }
}

function writeRemoteHome(map: Readonly<Record<string, RemoteHomeChoice>>): void {
  try {
    const entries = Object.entries(map).slice(-REMOTE_HOME_LIMIT);
    window.localStorage.setItem(REMOTE_HOME_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* Storage may be unavailable. */ }
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
  const store = createStore<CatalogState>({
    backends: [],
    remoteBackends: {},
    remoteSettings: {},
    remoteHome: readRemoteHome(),
    homeBackendId: isNativeBackendId(stored) ? stored : LEGACY_DEFAULT_BACKEND_ID,
    loading: true,
    error: '',
    loadedKey: '',
    revision: 0,
  });
  let request: AbortController | undefined;
  const cache = new Map<string, NativeBackendCatalogEntry>();
  const remoteInFlight = new Map<string, { promise: Promise<void>; next?: Promise<void> }>();
  let localBackendReads = Promise.resolve();
  let initialized = false;
  let preferredHome: NativeBackendId | undefined;
  /** An agent was picked in this browser or set as the server's default; until then the start follows availability. */
  let homeChosen = isNativeBackendId(stored);
  const report = (error: unknown, fallback: string) => { if (!offline() && !isUnreachable(error)) toast.error(errorMessage(error, fallback)); };
  /** Keep an older list from overwriting a recheck, while settings refreshes keep their own invalidation. */
  const loadLocalBackends = (recheckMissing: boolean): Promise<void> => {
    const read = async () => {
      try {
        const backends = await api.backends(recheckMissing);
        publishBackendLabels(backends);
        if (recheckMissing && JSON.stringify(backends) === JSON.stringify(store.get().backends)) return;
        cache.clear();
        store.set((current) => ({ backends, profileCatalogs: undefined, revision: current.revision + 1, ...offeredHome(current, backends, preferredHome, homeChosen) }));
      }
      catch (error) { if (!recheckMissing) report(error, i18n._(msg`无法加载 Agent 列表`)); }
    };
    localBackendReads = localBackendReads.then(read, read);
    return localBackendReads;
  };
  const recheckLocalBackends = singleFlight(() => loadLocalBackends(true));

  const actions = {
    refreshBackends: singleFlight(() => loadLocalBackends(false)),
    /** The picker may have hidden an Agent that was installed since the last list read. */
    recheckBackends: (serverId: string): Promise<void> => serverId ? actions.loadRemote(serverId, true) : recheckLocalBackends(true),
    /** Reads a linked server's own agents and read-only defaults so the new-session picker matches that server. */
    loadRemote(serverId: string, recheckMissing = false): Promise<void> {
      if (!serverId) return Promise.resolve();
      if (!recheckMissing && store.get().remoteBackends[serverId]) return Promise.resolve();
      const existing = remoteInFlight.get(serverId);
      // The in-flight probe may predate an install. Reopens share one subsequent read.
      if (existing) return recheckMissing
        ? (existing.next ??= existing.promise.then(() => actions.loadRemote(serverId, true)))
        : existing.promise;
      const run = (async () => {
        try {
          const remoteApi = apiFor(serverId);
          const [backends, settings] = await Promise.all([
            remoteApi.backends(recheckMissing),
            remoteApi.settings().catch(() => undefined),
          ]);
          publishBackendLabels(backends);
          store.set((current) => {
            const changed = JSON.stringify(backends) !== JSON.stringify(current.remoteBackends[serverId]);
            const existingHome = current.remoteHome[serverId];
            const stillValid = existingHome && backends.some((entry) => entry.backendId === existingHome.backendId);
            const nextChoice = stillValid ? existingHome : initialRemoteHome(backends, settings ?? current.remoteSettings[serverId]);
            return {
              ...(changed ? { remoteBackends: { ...current.remoteBackends, [serverId]: backends } } : {}),
              ...(settings ? { remoteSettings: { ...current.remoteSettings, [serverId]: settings } } : {}),
              ...(nextChoice ? { remoteHome: { ...current.remoteHome, [serverId]: nextChoice } } : {}),
              ...(recheckMissing && changed ? { revision: current.revision + 1 } : {}),
            };
          });
        } catch (error) {
          if (!recheckMissing) report(error, i18n._(msg`无法加载对端服务器的 Agent 列表`));
        } finally {
          remoteInFlight.delete(serverId);
        }
      })();
      remoteInFlight.set(serverId, { promise: run });
      return run;
    },
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
      homeChosen = isNativeBackendId(saved) || Boolean(settings.defaultBackendId);
      const id = isNativeBackendId(saved) ? saved : settings.defaultBackendId ?? LEGACY_DEFAULT_BACKEND_ID;
      const home = { homeBackendId: id, homeProfileId: settings.nativeBackendDefaults?.[id]?.profileId };
      store.set((current) => ({ ...home, ...offeredHome({ ...current, ...home }, current.backends, preferredHome, homeChosen) }));
    },
    setHome(backendId: NativeBackendId, profileId: string | undefined) { homeChosen = true; store.set({ homeBackendId: backendId, homeProfileId: profileId }); },
    setHomeProfile(profileId: string | undefined) { store.set({ homeProfileId: profileId }); },
    setRemoteHome(serverId: string, backendId: NativeBackendId, profileId: string | undefined) {
      store.set((current) => {
        const next = { ...current.remoteHome, [serverId]: { backendId, ...(profileId ? { profileId } : {}) } };
        writeRemoteHome(next);
        return { remoteHome: next };
      });
    },
    setRemoteHomeProfile(serverId: string, profileId: string | undefined) {
      store.set((current) => {
        const prior = current.remoteHome[serverId];
        if (!prior) return {};
        const next = { ...current.remoteHome, [serverId]: { backendId: prior.backendId, ...(profileId ? { profileId } : {}) } };
        writeRemoteHome(next);
        return { remoteHome: next };
      });
    },

    /** Every provider configured for the agent being started, loaded and cached per project/provider. */
    loadProfiles(projectId: string, backendId: NativeBackendId, profiles: NativeBackendProfile[], key: string, refresh = false, serverId?: string): () => void {
      const controller = new AbortController();
      const cacheKey = (profileId: string) => profilesCacheKey(projectId, backendId, profileId, serverId);
      // Each provider is shown as soon as it answers, in configured order: a slow or failing gateway must not
      // hold back, or blank, the others. The last known list paints first and a fresh answer replaces it.
      const loaded = new Map(actions.peekProfiles(projectId, backendId, profiles, serverId).map((entry) => [entry.profile.id, entry] as const));
      const publish = () => {
        if (!controller.signal.aborted) store.set({ profileCatalogs: { key, entries: profiles.flatMap((profile) => loaded.get(profile.id) ?? []) } });
      };
      if (loaded.size) publish();
      for (const profile of profiles) {
        const k = cacheKey(profile.id);
        if (!refresh && cache.get(k)?.available) continue;
        void apiFor(serverId || undefined).backendCatalog(backendId, profile.id, projectId || undefined, controller.signal).then((entry) => {
          cache.set(k, entry);
          rememberCatalog(k, entry);
          loaded.set(profile.id, { profile, models: entry.models, available: entry.available, reason: entry.reason });
          publish();
        }).catch(() => undefined);
      }
      return () => controller.abort();
    },
    /** What `loadProfiles` paints at once, for a render that cannot wait for its effect. */
    peekProfiles(projectId: string, backendId: NativeBackendId, profiles: NativeBackendProfile[], serverId?: string): ProfileCatalog[] {
      return profiles.flatMap((profile) => {
        const key = profilesCacheKey(projectId, backendId, profile.id, serverId);
        const entry = cache.get(key) ?? cachedCatalog(key);
        return entry ? [{ profile, models: entry.models, available: entry.available, reason: entry.reason }] : [];
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
      const sharedKey = `${serverScope(target.serverId, target.projectId)}:${target.backendId}:${target.profileId ?? 'default'}`;
      return cachedCatalog(target.sessionId ? `session:${target.sessionId}` : sharedKey) ?? cachedCatalog(sharedKey);
    },
    async load(target: CatalogTarget) {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const sharedKey = `${serverScope(target.serverId, target.projectId)}:${target.backendId}:${target.profileId ?? 'default'}`;
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
          : await apiFor(target.serverId || undefined).backendCatalog(target.backendId, target.profileId, target.projectId || undefined, controller.signal);
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
