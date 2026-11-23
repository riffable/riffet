import { useCallback, useEffect, useRef, useState } from 'react';
import type { CouncilDiscussion, CouncilStreamEvent } from '@contracts';
import { api, councilStreamUrl } from '@/lib/api';
import { HttpError } from '@/lib/errors';
import { reconnectDelay } from '@/lib/utils';
import { applyCouncilEvent, applySpeechRows, type SpeechRows } from './model';

export type SpeechRowsLoadState = 'loading' | 'ready' | 'failed';

/**
 * The open discussion, kept current by its event stream, and the rows of its speeches' turns: those streaming come
 * with the stream, a finished one's are read when the reader opens it (`loadRows`). Events are applied once per
 * frame; a snapshot (on connect, reconnect or a state change) replaces the discussion.
 */
export function useCouncilDiscussion(id: string | null) {
  const [discussion, setDiscussion] = useState<CouncilDiscussion>();
  const [missingId, setMissingId] = useState<string>();
  const [rows, setRows] = useState<SpeechRows>({});
  const [rowLoads, setRowLoads] = useState<Partial<Record<string, SpeechRowsLoadState>>>({});
  const queued = useRef<CouncilStreamEvent[]>([]);
  const frame = useRef<number | undefined>(undefined);
  const rowRequests = useRef<{ id: string; controller: AbortController; requested: Set<string> } | undefined>(undefined);

  useEffect(() => {
    setDiscussion(undefined);
    setMissingId(undefined);
    setRows({});
    setRowLoads({});
    if (!id) return;
    const requests = { id, controller: new AbortController(), requested: new Set<string>() };
    const { signal } = requests.controller;
    rowRequests.current = requests;
    const drop = () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
      queued.current = [];
    };
    const apply = () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
      const events = queued.current.splice(0);
      setDiscussion((current) => events.reduce<CouncilDiscussion | undefined>((d, event) => event.type === 'speech' ? applyCouncilEvent(d, event) : d, current));
      setRows((current) => events.reduce<SpeechRows>((held, event) => event.type === 'rows' ? applySpeechRows(held, event.speechId, event.upserts, event.deletes) : held, current));
    };
    let source: EventSource | undefined;
    let retryTimer: number | undefined;
    let retries = 0;
    const connect = () => {
      if (signal.aborted) return;
      const current = new EventSource(councilStreamUrl(id));
      source = current;
      current.onerror = () => {
        // EventSource retries ordinary disconnects itself. On an HTTP failure it closes
        // permanently, without telling us whether the server deleted this discussion.
        if (signal.aborted || source !== current || current.readyState !== EventSource.CLOSED) return;
        current.close();
        source = undefined;
        const recover = async () => {
          try {
            const snapshot = await api.councilGet(id, signal);
            if (!signal.aborted) {
              apply();
              setDiscussion(snapshot);
            }
          } catch (error) {
            if (!signal.aborted && error instanceof HttpError && error.code === 'COUNCIL_NOT_FOUND') {
              setMissingId(id);
              return;
            }
          }
          if (!signal.aborted) retryTimer = window.setTimeout(connect, reconnectDelay(++retries));
        };
        void recover();
      };
      current.onmessage = (message) => {
        if (signal.aborted || source !== current) return;
        let event: CouncilStreamEvent;
        try { event = JSON.parse(message.data) as CouncilStreamEvent; } catch { return; }
        if (event.type === 'snapshot') {
          retries = 0;
          apply();
          setDiscussion(event.discussion);
          return;
        }
        queued.current.push(event);
        frame.current ??= requestAnimationFrame(apply);
      };
    };
    connect();
    return () => {
      requests.controller.abort();
      rowRequests.current = undefined;
      source?.close();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      drop();
    };
  }, [id]);

  const loadRows = useCallback((speechId: string) => {
    const requests = rowRequests.current;
    if (!requests || requests.id !== id || requests.requested.has(speechId)) return;
    requests.requested.add(speechId);
    setRowLoads((current) => ({ ...current, [speechId]: 'loading' }));
    const { signal } = requests.controller;
    void api.councilSpeechRows(requests.id, speechId, signal).then(
      (result) => {
        if (signal.aborted) return;
        setRows((current) => applySpeechRows(current, speechId, result.rows, []));
        setRowLoads((current) => ({ ...current, [speechId]: 'ready' }));
      },
      () => {
        if (signal.aborted) return;
        requests.requested.delete(speechId);
        setRowLoads((current) => ({ ...current, [speechId]: 'failed' }));
      },
    );
  }, [id]);

  return { discussion, missingId, rows, rowLoads, loadRows };
}
