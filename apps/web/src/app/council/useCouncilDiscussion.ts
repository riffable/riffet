import { useCallback, useEffect, useRef, useState } from 'react';
import type { CouncilDiscussion, CouncilStreamEvent } from '@contracts';
import { api, councilStreamUrl } from '@/lib/api';
import { applyCouncilEvent, applySpeechRows, type SpeechRows } from './model';

/**
 * The open discussion, kept current by its event stream, and the rows of its speeches' turns: those streaming come
 * with the stream, a finished one's are read when the reader opens it (`loadRows`). Events are applied once per
 * frame; a snapshot (on connect, reconnect or a state change) replaces the discussion.
 */
export function useCouncilDiscussion(id: string | null) {
  const [discussion, setDiscussion] = useState<CouncilDiscussion>();
  const [rows, setRows] = useState<SpeechRows>({});
  const [connected, setConnected] = useState(false);
  const queued = useRef<CouncilStreamEvent[]>([]);
  const frame = useRef<number | undefined>(undefined);
  const loading = useRef(new Set<string>());

  useEffect(() => {
    setDiscussion(undefined);
    setRows({});
    setConnected(false);
    loading.current.clear();
    if (!id) return;
    const drop = () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
      queued.current = [];
    };
    const apply = () => {
      frame.current = undefined;
      const events = queued.current.splice(0);
      setDiscussion((current) => events.reduce<CouncilDiscussion | undefined>((d, event) => event.type === 'speech' ? applyCouncilEvent(d, event) : d, current));
      setRows((current) => events.reduce<SpeechRows>((held, event) => event.type === 'rows' ? applySpeechRows(held, event.speechId, event.upserts, event.deletes) : held, current));
    };
    const source = new EventSource(councilStreamUrl(id));
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      let event: CouncilStreamEvent;
      try { event = JSON.parse(message.data) as CouncilStreamEvent; } catch { return; }
      if (event.type === 'snapshot') {
        apply();
        setDiscussion(event.discussion);
        return;
      }
      queued.current.push(event);
      frame.current ??= requestAnimationFrame(apply);
    };
    return () => {
      source.close();
      drop();
    };
  }, [id]);

  const loadRows = useCallback((speechId: string) => {
    if (!id || loading.current.has(speechId)) return;
    loading.current.add(speechId);
    void api.councilSpeechRows(id, speechId)
      .then((result) => setRows((current) => applySpeechRows(current, speechId, result.rows, [])))
      .catch(() => loading.current.delete(speechId));
  }, [id]);

  return { discussion, rows, loadRows, connected };
}
