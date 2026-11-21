import { useCallback, useEffect, useRef, useState } from 'react';
import { TRACE_BUDGET, type Run, type SyncLane, type TracePage, type TraceRequests, type TraceRow, type TraceRowDetail, type TraceSummary } from '@contracts';
import { usePluginHost } from '@riffet/plugin-web';

/*
 * Reads a lane's trace: the summary once (and again while the conversation runs), the index in pages from
 * the start of the log, then only what was written since. Payloads are read one row at a time and kept in
 * a small LRU (`TRACE_BUDGET.webDetail*`).
 */

const base = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/trace`;
const laneQuery = (lane: SyncLane, generation?: string) => {
  const query = new URLSearchParams({ lane });
  if (generation) query.set('generation', generation);
  return query;
};

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const isGenerationChange = (error: unknown) => (error as { code?: unknown } | null)?.code === 'TRACE_GENERATION_CHANGED';

export interface LaneState {
  lane: SyncLane;
  generation?: string;
  rows: TraceRow[];
  lastSeq: number;
  /** Every page up to the head of the log has been read. */
  complete: boolean;
  /** Reading stopped at `TRACE_BUDGET.webRows`. */
  capped: boolean;
  /** Rows read so far, ahead of `rows` while pages are still arriving (they are handed over in batches). */
  read: number;
  error?: string;
}

export interface TraceData {
  summary?: TraceSummary;
  runs: Run[];
  lane: LaneState;
  /** Reads the lane from the start again. */
  reload(): void;
}

const emptyLane = (lane: SyncLane): LaneState => ({ lane, rows: [], lastSeq: 0, complete: false, capped: false, read: 0 });
/** Pages read between two hand-overs of the rows: each hand-over refolds the lane, so a long log is not refolded per page. */
const PAGES_PER_COMMIT = 8;
/** Index pages read at once while a lane is read from the start. */
const PARALLEL_PAGES = 4;

export function useTraceData(sessionId: string, lane: SyncLane, live: boolean, visible: boolean, signal: AbortSignal): TraceData {
  const host = usePluginHost();
  const [summary, setSummary] = useState<TraceSummary>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [state, setState] = useState<LaneState>(() => emptyLane(lane));
  const [epoch, setEpoch] = useState(0);
  const reload = useCallback(() => setEpoch((value) => value + 1), []);

  // The summary and the runs, again on each reload and every few polls while live.
  const refreshMeta = useCallback(async (abort: AbortSignal) => {
    const [next, nextRuns] = await Promise.all([
      host.request.get<TraceSummary>(base(sessionId), { signal: abort }),
      host.sessions.runs(sessionId, { signal: abort }).catch(() => [] as Run[]),
    ]);
    if (abort.aborted) return;
    setSummary(next);
    setRuns(nextRuns);
  }, [host, sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener('abort', stop);
    refreshMeta(controller.signal).catch((error: unknown) => {
      if (!isAbort(error)) setState((current) => ({ ...current, error: host.notify.errorText(error, '') || String(error) }));
    });
    return () => { signal.removeEventListener('abort', stop); controller.abort(); };
  }, [refreshMeta, epoch, signal, host]);

  // Pages from the start of the log; each page is drawn as it arrives.
  const generation = useRef<string | undefined>(undefined);
  const lastSeq = useRef(0);
  // Each load has a token; the live poll runs only once the current load has finished, and drops an answer
  // that arrives after another load began. A settled old load never marks the new one finished.
  const loadToken = useRef(0);
  const loadedToken = useRef(-1);
  useEffect(() => {
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener('abort', stop);
    const token = ++loadToken.current;
    generation.current = undefined;
    lastSeq.current = 0;
    setState(emptyLane(lane));
    (async () => {
      const read = async (after: number) => {
        const query = laneQuery(lane, generation.current);
        query.set('after', String(after));
        query.set('limit', String(TRACE_BUDGET.pageRows));
        return host.request.get<TracePage>(`${base(sessionId)}/rows?${query.toString()}`, { signal: controller.signal });
      };
      const first = await read(0);
      if (controller.signal.aborted) return;
      generation.current = first.generation;
      let rows: TraceRow[] = first.rows.slice(0, TRACE_BUDGET.webRows);
      const commit = (complete: boolean, lastSeqOfLog: number) => {
        const capped = rows.length >= TRACE_BUDGET.webRows;
        lastSeq.current = rows.at(-1)?.seq ?? 0;
        setState((current) => ({ ...current, lane, generation: generation.current, rows, lastSeq: lastSeqOfLog, complete: complete || capped, capped, read: rows.length }));
      };
      commit(first.next === undefined, first.lastSeq);
      if (first.next === undefined || rows.length >= TRACE_BUDGET.webRows) return;
      // A lane numbers its rows from 1 without gaps, so the rest of the pages are known from the first and are
      // read a few at a time. Each page is appended in order; a row already held (pages overlap after a gap) is skipped.
      const starts: number[] = [];
      const stop = Math.min(first.lastSeq, TRACE_BUDGET.webRows + first.next);
      for (let after = first.next; after < stop; after += TRACE_BUDGET.pageRows) starts.push(after);
      const pages = new Map<number, TracePage>();
      let appended = 0, launched = 0, done = 0;
      const append = () => {
        while (pages.has(appended)) {
          const page = pages.get(appended)!;
          pages.delete(appended);
          const from = rows.at(-1)?.seq ?? 0;
          rows = rows.concat(page.rows.filter((row) => row.seq > from)).slice(0, TRACE_BUDGET.webRows);
          appended += 1;
          if (appended === starts.length || appended % PAGES_PER_COMMIT === 0 || rows.length >= TRACE_BUDGET.webRows) commit(appended === starts.length, page.lastSeq);
        }
        setState((current) => ({ ...current, read: Math.max(current.read, first.rows.length + done * TRACE_BUDGET.pageRows) }));
      };
      const worker = async () => {
        while (launched < starts.length && !controller.signal.aborted && rows.length < TRACE_BUDGET.webRows) {
          const index = launched++;
          // One failed page ends the load: the pages after it could never be appended in order.
          const page = await read(starts[index]!).catch((error: unknown) => { controller.abort(); throw error; });
          if (controller.signal.aborted) return;
          done += 1;
          pages.set(index, page);
          append();
        }
      };
      await Promise.all(Array.from({ length: PARALLEL_PAGES }, worker));
      if (!controller.signal.aborted && appended < starts.length) commit(true, rows.at(-1)?.seq ?? 0);
    })().then(() => {
      if (token === loadToken.current && !controller.signal.aborted) loadedToken.current = token;
    }, (error: unknown) => {
      // A failed page aborts its siblings, but `Promise.all` rejects with the failure itself, not their aborts.
      if (token !== loadToken.current || isAbort(error)) return;
      if (isGenerationChange(error)) { reload(); return; }
      setState((current) => ({ ...current, error: host.notify.errorText(error, '') || String(error) }));
    });
    return () => { signal.removeEventListener('abort', stop); controller.abort(); };
  }, [host, sessionId, lane, epoch, signal, reload]);

  // While the conversation runs and the view is shown: what was written since the last read.
  useEffect(() => {
    if (!live || !visible) return;
    const controller = new AbortController();
    let ticks = 0;
    let polling = false;
    const timer = window.setInterval(() => {
      const token = loadToken.current;
      if (polling || loadedToken.current !== token || !generation.current || controller.signal.aborted) return;
      polling = true;
      const query = laneQuery(lane, generation.current);
      query.set('after', String(lastSeq.current));
      query.set('limit', String(TRACE_BUDGET.pageRows));
      host.request.get<TracePage>(`${base(sessionId)}/rows?${query.toString()}`, { signal: controller.signal }).then((page) => {
        if (controller.signal.aborted || token !== loadToken.current || page.rows.length === 0) return;
        lastSeq.current = Math.max(lastSeq.current, page.rows.at(-1)!.seq);
        setState((current) => {
          if (current.capped) return current;
          const from = current.rows.at(-1)?.seq ?? 0;
          const fresh = page.rows.filter((row) => row.seq > from);
          if (!fresh.length) return current;
          const rows = current.rows.concat(fresh).slice(0, TRACE_BUDGET.webRows);
          return { ...current, rows, lastSeq: page.lastSeq, read: rows.length, capped: rows.length >= TRACE_BUDGET.webRows };
        });
      }).catch((error: unknown) => {
        if (token === loadToken.current && isGenerationChange(error)) reload();
      }).finally(() => { polling = false; });
      ticks += 1;
      if (ticks % 5 === 0) void refreshMeta(controller.signal).catch(() => undefined);
    }, TRACE_BUDGET.livePollMs);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [live, visible, host, sessionId, lane, epoch, refreshMeta, reload]);

  return { ...(summary ? { summary } : {}), runs, lane: state, reload };
}

/* ------------------------------------------------------------------ payloads */

/** Whole payloads by `<generation>:<lane>:<seq>`, oldest dropped past either budget. */
export class DetailCache {
  private readonly entries = new Map<string, { detail: TraceRowDetail; bytes: number }>();
  private bytes = 0;

  get(key: string): TraceRowDetail | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.detail;
  }

  set(key: string, detail: TraceRowDetail): void {
    const bytes = detail.payloadText !== undefined ? detail.payloadText.length : detail.bytes;
    const old = this.entries.get(key);
    if (old) { this.bytes -= old.bytes; this.entries.delete(key); }
    this.entries.set(key, { detail, bytes });
    this.bytes += bytes;
    for (const [oldest, entry] of this.entries) {
      if (this.entries.size <= TRACE_BUDGET.webDetailEntries && this.bytes <= TRACE_BUDGET.webDetailBytes) break;
      if (oldest === key) break;
      this.entries.delete(oldest);
      this.bytes -= entry.bytes;
    }
  }

  clear(): void { this.entries.clear(); this.bytes = 0; }
}

export type DetailState = { status: 'loading' } | { status: 'ready'; detail: TraceRowDetail } | { status: 'error'; message: string };

/** The whole payload of one row, read once and kept in `cache`. */
export function useRowDetail(sessionId: string, lane: SyncLane, generation: string | undefined, seq: number | undefined, cache: DetailCache): DetailState | undefined {
  const host = usePluginHost();
  const key = seq === undefined || !generation ? undefined : `${generation}:${lane}:${seq}`;
  const [state, setState] = useState<{ key: string; value: DetailState }>();
  useEffect(() => {
    if (!key || seq === undefined) return;
    const cached = cache.get(key);
    if (cached) { setState({ key, value: { status: 'ready', detail: cached } }); return; }
    const controller = new AbortController();
    setState({ key, value: { status: 'loading' } });
    host.request.get<TraceRowDetail>(`${base(sessionId)}/rows/${seq}?${laneQuery(lane, generation).toString()}`, { signal: controller.signal })
      .then((detail) => { cache.set(key, detail); setState({ key, value: { status: 'ready', detail } }); })
      .catch((error: unknown) => { if (!isAbort(error)) setState({ key, value: { status: 'error', message: host.notify.errorText(error, '') || String(error) } }); });
    return () => controller.abort();
  }, [key, seq, host, sessionId, lane, generation, cache]);
  return key && state?.key === key ? state.value : key ? { status: 'loading' } : undefined;
}

/** The least time between two reads of the request context brought on by a newer step. */
const REQUESTS_REREAD_MS = 10_000;
/** A step this much later than the newest recorded request means the records have moved on since the read. */
const REQUESTS_STALE_MS = 5_000;

export interface RequestsState {
  data?: TraceRequests;
  loading: boolean;
  error?: string;
}

/**
 * The lane's request context (docs/TRACE.md §2.1): read the first time something needs it, not with the lane,
 * since it is a whole read of the agent's own transcript; again on `epoch` (Reload), and when something on screen
 * is newer than the newest request read (`wantedAt`, the selected step of a running conversation), at most every
 * `REQUESTS_REREAD_MS`. Nothing polls: an open view of a running conversation does not re-read a large transcript
 * on a timer. A read in flight is never dropped for a newer one; it is aborted only when the lane, the session or
 * the epoch changes, or the view goes away.
 */
export function useTraceRequests(sessionId: string, lane: SyncLane, need: boolean, wantedAt: number | undefined, epoch: number, signal: AbortSignal): RequestsState {
  const host = usePluginHost();
  const [state, setState] = useState<RequestsState & { key: string; read?: number; newest?: number }>({ key: '', loading: false });
  const key = `${sessionId}\n${lane}\n${epoch}`;
  const current = state.key === key ? state : undefined;
  const inflight = useRef<{ key: string; controller: AbortController } | undefined>(undefined);
  const [tick, setTick] = useState(0);

  // Abort what is in flight when the key changes or the view goes away.
  useEffect(() => () => { inflight.current?.controller.abort(); inflight.current = undefined; }, [key]);
  useEffect(() => {
    const stop = () => inflight.current?.controller.abort();
    signal.addEventListener('abort', stop);
    return () => signal.removeEventListener('abort', stop);
  }, [signal]);

  const stale = current?.read !== undefined && wantedAt !== undefined && wantedAt > (current.newest ?? 0) + REQUESTS_STALE_MS;
  const due = need && (current?.read === undefined || stale);
  useEffect(() => {
    if (!due || inflight.current?.key === key || signal.aborted) return;
    const wait = current?.read === undefined ? 0 : current.read + REQUESTS_REREAD_MS - Date.now();
    if (wait > 0) {
      // Throttled: check again once the interval has passed.
      const timer = window.setTimeout(() => setTick((value) => value + 1), wait);
      return () => window.clearTimeout(timer);
    }
    const controller = new AbortController();
    inflight.current = { key, controller };
    setState((previous) => ({ ...(previous.key === key ? previous : {}), key, loading: true }));
    const settle = () => { if (inflight.current?.controller === controller) inflight.current = undefined; };
    const query = new URLSearchParams({ lane });
    host.request.get<TraceRequests>(`${base(sessionId)}/requests?${query}`, { signal: controller.signal }).then(
      (data) => {
        settle();
        const newest = data.requests.reduce((max, request) => Math.max(max, Date.parse(request.at) || 0), 0);
        setState({ key, data, loading: false, read: Date.now(), newest });
      },
      (error: unknown) => {
        settle();
        if (isAbort(error)) return;
        setState((previous) => ({ ...(previous.key === key ? previous : {}), key, loading: false, read: Date.now(), error: host.notify.errorText(error, '') || String(error) }));
      },
    );
    return undefined;
    // `current` is read for its time only; `tick` re-checks a throttled read.
  }, [due, key, tick, host, sessionId, lane, signal]);

  return current ?? { loading: need };
}
