import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ModelChatConfigPatch,
  ModelChatLiveStream,
  ModelChatSendRequest,
  ModelChatStreamEvent,
  ModelChatTreeSnapshot,
  ModelChatWireRecord,
} from '@contracts';
import { api, HttpError } from '@/lib/api';
import { errorMessage, reconnectDelay } from '@/lib/utils';

type DeltaEvent = Extract<ModelChatStreamEvent, { type: 'delta' }>;

function mergeSnapshotWithLive(
  prev: ModelChatTreeSnapshot | undefined,
  next: ModelChatTreeSnapshot,
): ModelChatTreeSnapshot {
  if (!prev || prev.sessionId !== next.sessionId || prev.liveStreams.length === 0 || next.liveStreams.length === 0) {
    return next;
  }
  const prevById = new Map(prev.liveStreams.map((stream) => [stream.assistantId, stream]));
  let changed = false;
  const mergedStreams = next.liveStreams.map((stream) => {
    const existing = prevById.get(stream.assistantId);
    if (!existing) return stream;
    const text = existing.text.length > stream.text.length ? existing.text : stream.text;
    const reasoning = existing.reasoning.length > stream.reasoning.length ? existing.reasoning : stream.reasoning;
    if (text === stream.text && reasoning === stream.reasoning) return stream;
    changed = true;
    return { ...stream, text, reasoning };
  });
  return changed ? { ...next, liveStreams: mergedStreams } : next;
}

function applyDeltas(
  snapshot: ModelChatTreeSnapshot | undefined,
  deltas: readonly DeltaEvent[],
): ModelChatTreeSnapshot | undefined {
  if (!snapshot || deltas.length === 0) return snapshot;
  const streams = [...snapshot.liveStreams];
  let changed = false;

  for (const delta of deltas) {
    const index = streams.findIndex((item) => item.assistantId === delta.assistantId);
    if (index >= 0) {
      const existing = streams[index]!;
      streams[index] = delta.kind === 'reasoning'
        ? { ...existing, reasoning: `${existing.reasoning}${delta.text}` }
        : { ...existing, text: `${existing.text}${delta.text}` };
      changed = true;
    } else {
      const placeholder: ModelChatLiveStream = {
        assistantId: delta.assistantId,
        parentId: delta.parentId,
        turnId: delta.parentId,
        runId: delta.assistantId,
        modelSelection: '',
        text: delta.kind === 'text' ? delta.text : '',
        reasoning: delta.kind === 'reasoning' ? delta.text : '',
        startedAt: new Date().toISOString(),
      };
      streams.push(placeholder);
      changed = true;
    }
  }

  return changed ? { ...snapshot, liveStreams: streams } : snapshot;
}

const MAX_WIRE_CACHE_ENTRIES = 16;

export interface ModelChatController {
  snapshot: ModelChatTreeSnapshot | undefined;
  loading: boolean;
  connected: boolean;
  loadError: string | undefined;
  wireCache: Record<string, ModelChatWireRecord>;
  wireLoadingId: string | undefined;
  send: (body: ModelChatSendRequest) => Promise<{ snapshot: ModelChatTreeSnapshot; assistantIds: string[] } | undefined>;
  stop: (assistantId?: string) => Promise<void>;
  updateConfig: (patch: ModelChatConfigPatch) => Promise<void>;
  selectBranch: (leafId: string) => Promise<void>;
  setTurnFlags: (userId: string, flags: { pinned?: boolean; muted?: boolean }) => Promise<void>;
  editAssistant: (assistantId: string, text: string) => Promise<void>;
  loadWire: (assistantId: string, force?: boolean) => Promise<ModelChatWireRecord | undefined>;
  refresh: () => Promise<void>;
}

/**
 * Manages a Model Chat session's message tree, live SSE deltas, reconnect backoff,
 * and white-box Wire inspection cache.
 */
export function useModelChat(
  sessionId: string,
  onError: (message: string) => void,
): ModelChatController {
  const [snapshot, setSnapshot] = useState<ModelChatTreeSnapshot>();
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [wireCache, setWireCache] = useState<Record<string, ModelChatWireRecord>>({});
  const [wireLoadingId, setWireLoadingId] = useState<string>();

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const wireCacheRef = useRef(wireCache);
  wireCacheRef.current = wireCache;
  const missingWireRef = useRef<Set<string>>(new Set());
  const wireAbortRef = useRef<AbortController | undefined>(undefined);
  const sessionAbortRef = useRef<AbortController | undefined>(undefined);
  const queuedDeltasRef = useRef<DeltaEvent[]>([]);
  const frameRef = useRef<number | undefined>(undefined);

  const flushDeltas = useCallback(() => {
    if (frameRef.current !== undefined) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
    }
    const batch = queuedDeltasRef.current.splice(0);
    if (batch.length > 0) {
      setSnapshot((current) => applyDeltas(current, batch));
    }
  }, []);

  const refresh = useCallback(async () => {
    const controller = sessionAbortRef.current;
    try {
      const next = await api.modelChatTree(sessionId, controller?.signal);
      if (!controller || controller.signal.aborted || sessionAbortRef.current !== controller) return;
      flushDeltas();
      setSnapshot((prev) => mergeSnapshotWithLive(prev, next));
      setLoadError(undefined);
    } catch (error) {
      if (!controller || controller.signal.aborted || sessionAbortRef.current !== controller) return;
      const message = errorMessage(error);
      setLoadError(message);
    } finally {
      if (controller && !controller.signal.aborted && sessionAbortRef.current === controller) {
        setLoading(false);
      }
    }
  }, [sessionId, flushDeltas]);

  useEffect(() => {
    setSnapshot(undefined);
    setLoading(true);
    setConnected(false);
    setLoadError(undefined);
    setWireCache({});
    setWireLoadingId(undefined);
    missingWireRef.current.clear();
    wireAbortRef.current?.abort();
    wireAbortRef.current = undefined;

    const controller = new AbortController();
    const { signal } = controller;
    sessionAbortRef.current = controller;

    let source: EventSource | undefined;
    let retryTimer: number | undefined;
    let retries = 0;
    let receivedStreamSnapshot = false;

    const dropQueued = () => {
      if (frameRef.current !== undefined) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = undefined;
      }
      queuedDeltasRef.current = [];
    };

    const loadInitial = async () => {
      try {
        const next = await api.modelChatTree(sessionId, signal);
        if (signal.aborted) return;
        if (!receivedStreamSnapshot) {
          setSnapshot((prev) => mergeSnapshotWithLive(prev, next));
          setLoadError(undefined);
        }
      } catch (error) {
        if (signal.aborted) return;
        if (!receivedStreamSnapshot) {
          setLoadError(errorMessage(error));
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    };

    const connect = () => {
      if (signal.aborted) return;
      const current = api.openModelChatStream(sessionId);
      source = current;

      current.onopen = () => {
        if (signal.aborted || source !== current) return;
        retries = 0;
        setConnected(true);
      };

      current.onerror = () => {
        if (signal.aborted || source !== current) return;
        setConnected(false);
        if (current.readyState !== EventSource.CLOSED) return;
        current.close();
        source = undefined;
        const recover = async () => {
          try {
            const fresh = await api.modelChatTree(sessionId, signal);
            if (!signal.aborted) {
              dropQueued();
              setSnapshot((prev) => mergeSnapshotWithLive(prev, fresh));
              setLoadError(undefined);
            }
          } catch (error) {
            if (signal.aborted) return;
            if (
              error instanceof HttpError
              && error.status >= 400
              && error.status < 500
              && error.status !== 408
              && error.status !== 429
            ) {
              setLoadError(errorMessage(error));
              setLoading(false);
              return;
            }
            // Keep reconnecting with backoff; user-facing error stays quiet unless initial load failed.
          }
          if (!signal.aborted) {
            retryTimer = window.setTimeout(connect, reconnectDelay(++retries));
          }
        };
        void recover();
      };

      current.onmessage = (message) => {
        if (signal.aborted || source !== current) return;
        let event: ModelChatStreamEvent;
        try {
          event = JSON.parse(message.data) as ModelChatStreamEvent;
        } catch {
          return;
        }
        if (event.type === 'snapshot' || event.type === 'tree_updated') {
          receivedStreamSnapshot = true;
          retries = 0;
          setConnected(true);
          dropQueued();
          setSnapshot(event.snapshot);
          setLoadError(undefined);
          setLoading(false);
          return;
        }
        if (event.type === 'turn_done') {
          receivedStreamSnapshot = true;
          dropQueued();
          setSnapshot(event.snapshot);
          setLoading(false);
          if (event.error) onErrorRef.current(event.error);
          return;
        }
        if (event.type === 'delta') {
          queuedDeltasRef.current.push(event);
          frameRef.current ??= requestAnimationFrame(flushDeltas);
        }
      };
    };

    void loadInitial();
    connect();

    return () => {
      controller.abort();
      if (sessionAbortRef.current === controller) sessionAbortRef.current = undefined;
      wireAbortRef.current?.abort();
      wireAbortRef.current = undefined;
      source?.close();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      dropQueued();
    };
  }, [sessionId, flushDeltas]);

  const send = useCallback(async (body: ModelChatSendRequest) => {
    const controller = sessionAbortRef.current;
    try {
      const result = await api.sendModelChat(sessionId, body);
      if (!controller || controller.signal.aborted || sessionAbortRef.current !== controller) return undefined;
      flushDeltas();
      setSnapshot((prev) => mergeSnapshotWithLive(prev, result.snapshot));
      return result;
    } catch (error) {
      if (!controller || controller.signal.aborted || sessionAbortRef.current !== controller) return undefined;
      onErrorRef.current(errorMessage(error));
      return undefined;
    }
  }, [sessionId, flushDeltas]);

  const stop = useCallback(async (assistantId?: string) => {
    const controller = sessionAbortRef.current;
    try {
      const result = await api.stopModelChat(sessionId, assistantId);
      if (!controller || controller.signal.aborted || sessionAbortRef.current !== controller) return;
      flushDeltas();
      setSnapshot((prev) => mergeSnapshotWithLive(prev, result.snapshot));
    } catch (error) {
      if (!controller || controller.signal.aborted || sessionAbortRef.current !== controller) return;
      onErrorRef.current(errorMessage(error));
    }
  }, [sessionId, flushDeltas]);

  const updateConfig = useCallback(async (patch: ModelChatConfigPatch) => {
    const controller = sessionAbortRef.current;
    try {
      const next = await api.updateModelChatConfig(sessionId, patch);
      if (!controller || controller.signal.aborted || sessionAbortRef.current !== controller) return;
      flushDeltas();
      setSnapshot((prev) => mergeSnapshotWithLive(prev, next));
    } catch (error) {
      if (!controller || controller.signal.aborted || sessionAbortRef.current !== controller) return;
      onErrorRef.current(errorMessage(error));
    }
  }, [sessionId, flushDeltas]);

  const selectBranch = useCallback(async (leafId: string) => {
    const controller = sessionAbortRef.current;
    try {
      const next = await api.selectModelChatBranch(sessionId, leafId);
      if (!controller || controller.signal.aborted || sessionAbortRef.current !== controller) return;
      flushDeltas();
      setSnapshot((prev) => mergeSnapshotWithLive(prev, next));
    } catch (error) {
      if (!controller || controller.signal.aborted || sessionAbortRef.current !== controller) return;
      onErrorRef.current(errorMessage(error));
    }
  }, [sessionId, flushDeltas]);

  const setTurnFlags = useCallback(async (userId: string, flags: { pinned?: boolean; muted?: boolean }) => {
    const controller = sessionAbortRef.current;
    try {
      const next = await api.setModelChatTurnFlags(sessionId, userId, flags);
      if (!controller || controller.signal.aborted || sessionAbortRef.current !== controller) return;
      flushDeltas();
      setSnapshot((prev) => mergeSnapshotWithLive(prev, next));
    } catch (error) {
      if (!controller || controller.signal.aborted || sessionAbortRef.current !== controller) return;
      onErrorRef.current(errorMessage(error));
    }
  }, [sessionId, flushDeltas]);

  const editAssistant = useCallback(async (assistantId: string, text: string) => {
    const controller = sessionAbortRef.current;
    try {
      const next = await api.editModelChatAssistant(sessionId, assistantId, text);
      if (!controller || controller.signal.aborted || sessionAbortRef.current !== controller) return;
      flushDeltas();
      setSnapshot((prev) => mergeSnapshotWithLive(prev, next));
    } catch (error) {
      if (!controller || controller.signal.aborted || sessionAbortRef.current !== controller) return;
      onErrorRef.current(errorMessage(error));
    }
  }, [sessionId, flushDeltas]);

  const loadWire = useCallback(async (assistantId: string, force = false) => {
    if (!force && wireCacheRef.current[assistantId]) {
      return wireCacheRef.current[assistantId];
    }
    if (!force && missingWireRef.current.has(assistantId)) {
      return undefined;
    }
    if (force) missingWireRef.current.delete(assistantId);
    const sessionController = sessionAbortRef.current;
    wireAbortRef.current?.abort();
    const controller = new AbortController();
    wireAbortRef.current = controller;
    setWireLoadingId(assistantId);
    try {
      const record = await api.modelChatWire(sessionId, assistantId, controller.signal);
      if (
        controller.signal.aborted
        || !sessionController
        || sessionController.signal.aborted
        || sessionAbortRef.current !== sessionController
      ) {
        return undefined;
      }
      missingWireRef.current.delete(assistantId);
      setWireCache((current) => {
        const entries = Object.entries(current).filter(([key]) => key !== assistantId);
        entries.push([assistantId, record]);
        const bounded = entries.slice(-MAX_WIRE_CACHE_ENTRIES);
        return Object.fromEntries(bounded);
      });
      return record;
    } catch (error) {
      if (
        controller.signal.aborted
        || !sessionController
        || sessionController.signal.aborted
        || sessionAbortRef.current !== sessionController
      ) {
        return undefined;
      }
      if (error instanceof HttpError && error.status === 404) {
        missingWireRef.current.add(assistantId);
        return undefined;
      }
      onErrorRef.current(errorMessage(error));
      return undefined;
    } finally {
      if (wireAbortRef.current === controller) {
        wireAbortRef.current = undefined;
        setWireLoadingId(undefined);
      }
    }
  }, [sessionId]);

  return {
    snapshot,
    loading,
    connected,
    loadError,
    wireCache,
    wireLoadingId,
    send,
    stop,
    updateConfig,
    selectBranch,
    setTurnFlags,
    editAssistant,
    loadWire,
    refresh,
  };
}
