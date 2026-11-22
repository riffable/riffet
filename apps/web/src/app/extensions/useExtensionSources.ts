import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { ExtensionContext, ExtensionManagementCapabilities, NativeBackendCatalogEntry } from '@contracts';
import { api } from '@/lib/api';
import { extensionContextKey, isRiffetSource, RIFFET_SOURCE_ID, type ExtensionSource, type ExtensionSourceContext } from './model';

interface CachedSource {
  source: ExtensionSource;
  fetchedAt: number;
  capabilityCheckedAt: number;
  capabilityRequest?: Promise<ExtensionManagementCapabilities | undefined>;
}

interface SourceDescriptor {
  key: string;
  context: ExtensionSourceContext;
  profileName: string;
}

const INVENTORY_TTL = 30_000;
const CAPABILITY_TTL = 60_000;

export function useExtensionSources({ backends, projectId, active }: {
  backends: NativeBackendCatalogEntry[];
  projectId?: string;
  active: boolean;
}): {
  sources: ExtensionSource[];
  loading: boolean;
  refresh(): Promise<void>;
  ensureCapabilities(context: ExtensionSourceContext): Promise<ExtensionManagementCapabilities | undefined>;
} {
  const { t } = useLingui();
  const cache = useRef(new Map<string, CachedSource>());
  const controllers = useRef(new Set<AbortController>());
  const lifecycle = useRef({ epoch: 0, active: false, keys: [] as string[] });
  const [version, publish] = useReducer((value: number) => value + 1, 0);

  // Catalog objects change during polling. Only actual context membership restarts discovery;
  // names are projected separately so renaming a profile never restarts an in-flight scan.
  const riffetContext: ExtensionSourceContext = { backendId: RIFFET_SOURCE_ID, profileId: RIFFET_SOURCE_ID };
  const serializedDescriptors = JSON.stringify([
    { key: extensionContextKey(riffetContext), context: riffetContext, profileName: 'Riffet' },
    ...backends.flatMap(backend => backend.profiles.map(profile => {
      const context: ExtensionContext = { backendId: backend.backendId, profileId: profile.id, ...(projectId ? { projectId } : {}) };
      return { key: extensionContextKey(context), context, profileName: profile.name };
    })),
  ]);
  const descriptors = useMemo(() => JSON.parse(serializedDescriptors) as SourceDescriptor[], [serializedDescriptors]);
  const contextSignature = JSON.stringify(descriptors.map(source => source.key).sort());

  const cancelPending = useCallback(() => {
    lifecycle.current.epoch += 1;
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    for (const cached of cache.current.values()) {
      cached.source = { ...cached.source, loading: false };
      cached.capabilityRequest = undefined;
    }
  }, []);

  const loadInventories = useCallback(async (force: boolean) => {
    const { epoch, active: enabled, keys } = lifecycle.current;
    if (!enabled) return;
    const pending = keys.map(key => cache.current.get(key)).filter((source): source is CachedSource => Boolean(source))
      .filter(source => force || !source.fetchedAt || Date.now() - source.fetchedAt >= INVENTORY_TTL);
    for (const cached of pending) cached.source = { ...cached.source, loading: true };
    if (pending.length) publish();
    const errors: Error[] = [];
    let next = 0;
    const isCurrent = () => lifecycle.current.active && lifecycle.current.epoch === epoch;
    const worker = async () => {
      while (isCurrent() && next < pending.length) {
        const cached = pending[next++];
        const controller = new AbortController();
        controllers.current.add(controller);
        try {
          const inventory = isRiffetSource(cached.source.context)
            ? await api.riffetExtensions(controller.signal)
            : await api.extensions(cached.source.context, controller.signal);
          if (!controller.signal.aborted && isCurrent()) {
            cached.source = { ...cached.source, inventory, error: undefined };
            cached.fetchedAt = Date.now();
          }
        } catch (error) {
          // request() wraps fetch failures in HttpError, so signal.aborted is authoritative.
          if (!controller.signal.aborted && isCurrent()) {
            const message = error instanceof Error ? error.message : t`无法读取扩展目录`;
            cached.source = { ...cached.source, error: message };
            errors.push(new Error(`${cached.source.context.backendId} / ${cached.source.profileName}: ${message}`));
          }
        } finally {
          controllers.current.delete(controller);
          if (isCurrent()) {
            cached.source = { ...cached.source, loading: false };
            publish();
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));
    if (isCurrent() && errors.length) throw new AggregateError(errors, t`部分扩展目录刷新失败`);
  }, []);

  useEffect(() => {
    const keys = JSON.parse(contextSignature) as string[];
    const retained = new Set(keys);
    for (const key of cache.current.keys()) if (!retained.has(key)) cache.current.delete(key);
    for (const key of keys) {
      const existing = cache.current.get(key);
      if (existing) {
        if (active && existing.capabilityCheckedAt && Date.now() - existing.capabilityCheckedAt >= CAPABILITY_TTL) {
          existing.capabilityCheckedAt = 0;
          existing.source = { ...existing.source, capabilities: undefined, capabilityError: undefined };
        }
        continue;
      }
      const [backendId, profileId, sourceProjectId] = JSON.parse(key) as [ExtensionSourceContext['backendId'], string, string];
      const context: ExtensionSourceContext = backendId === RIFFET_SOURCE_ID
        ? { backendId: RIFFET_SOURCE_ID, profileId: RIFFET_SOURCE_ID }
        : { backendId, profileId, ...(sourceProjectId ? { projectId: sourceProjectId } : {}) };
      cache.current.set(key, {
        source: { key, context, profileName: backendId === RIFFET_SOURCE_ID ? 'Riffet' : profileId, loading: false },
        fetchedAt: 0,
        capabilityCheckedAt: 0,
      });
    }
    lifecycle.current = { ...lifecycle.current, active, keys };
    publish();
    // Automatic discovery reports per-source errors without producing an unhandled rejection.
    if (active) void loadInventories(false).catch(() => undefined);
    return () => {
      lifecycle.current.active = false;
      cancelPending();
    };
  }, [active, contextSignature, cancelPending, loadInventories]);

  const refresh = useCallback(async () => {
    if (!lifecycle.current.active) return;
    cancelPending();
    for (const cached of cache.current.values()) {
      cached.capabilityCheckedAt = 0;
      cached.source = { ...cached.source, capabilities: undefined, capabilityError: undefined };
    }
    publish();
    await loadInventories(true);
  }, [cancelPending, loadInventories]);

  const ensureCapabilities = useCallback((context: ExtensionSourceContext): Promise<ExtensionManagementCapabilities | undefined> => {
    if (isRiffetSource(context)) return Promise.resolve(undefined);
    const cached = cache.current.get(extensionContextKey(context));
    if (!lifecycle.current.active || !cached) return Promise.resolve(undefined);
    if (cached.capabilityRequest) return cached.capabilityRequest;
    // Cache failures for the same TTL too: an unsupported/forbidden source must not retry on every render.
    if (cached.capabilityCheckedAt && Date.now() - cached.capabilityCheckedAt < CAPABILITY_TTL) {
      return Promise.resolve(cached.source.capabilities);
    }
    const epoch = lifecycle.current.epoch;
    const controller = new AbortController();
    controllers.current.add(controller);
    const isCurrent = () => !controller.signal.aborted && lifecycle.current.active && lifecycle.current.epoch === epoch;
    const request = (async () => {
      try {
        if (isRiffetSource(cached.source.context)) return undefined;
        const capabilities = await api.extensionCapabilities(cached.source.context, controller.signal);
        if (!isCurrent()) return undefined;
        cached.source = { ...cached.source, capabilities, capabilityError: undefined };
        cached.capabilityCheckedAt = Date.now();
        return capabilities;
      } catch (error) {
        if (isCurrent()) {
          cached.source = { ...cached.source, capabilities: undefined,
            capabilityError: error instanceof Error ? error.message : t`无法读取管理能力` };
          cached.capabilityCheckedAt = Date.now();
        }
        return undefined;
      } finally {
        controllers.current.delete(controller);
        if (isCurrent()) {
          cached.capabilityRequest = undefined;
          publish();
        }
      }
    })();
    cached.capabilityRequest = request;
    return request;
  }, []);

  const sources = useMemo(() => descriptors.map(({ key, context, profileName }) => {
    const source = cache.current.get(key)?.source;
    return source ? { ...source, profileName } : { key, context, profileName, loading: active };
  }), [descriptors, version, active]);
  return { sources, loading: sources.some(source => source.loading), refresh, ensureCapabilities };
}
