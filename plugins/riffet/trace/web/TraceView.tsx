import { useCallback, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isRunningSession, type SyncLane, type TraceRow } from '@contracts';
import { Button, EmptyState, Input, Notice, Segmented, Select, Spinner, StatusDot, Tip, useMessages, useSessions, type ViewProps } from '@riffet/plugin-web';
import { cn } from './cn';
import { DetailCache, useTraceData, useTraceRequests } from './data';
import { formatCount, formatExact, formatMs } from './format';
import { IconCircleAlert, IconRefreshCw, IconSearch } from './icons';
import { Inspector, type Selection } from './Inspector';
import { catalogs, type TraceMessages } from './messages';
import { CATEGORIES, fold, indexRequests, logLines, promptChanges, spanLines, type Category, type Filter, type Folded } from './model';
import { CATEGORY_COLOR, TOKEN_COLOR } from './palette';
import { SpanList } from './SpanList';
import { Timeline } from './Timeline';
import { TOKEN_SERIES, TokenBar } from './TokenBar';

/*
 * The trace of one conversation (docs/TRACE.md): an overview of the lane (its figures and a zoomable timeline),
 * the list of its turns and spans (or of its raw rows), and the inspector of the selection. The overview is an
 * overview surface (foundations §12, DECISIONS 2026-11-21); the list and the inspector are read line by line.
 */

const DEFAULT_CATEGORIES: ReadonlySet<Category> = new Set(CATEGORIES.filter((category) => category !== 'draft'));

export default function TraceView({ context }: ViewProps) {
  const m = useMessages(catalogs);
  const sessionId = context.sessionId ?? '';
  const session = useSessions().find((item) => item.id === sessionId);
  const live = session ? isRunningSession(session) : false;
  const [lane, setLane] = useState<SyncLane>('main');
  const data = useTraceData(sessionId, lane, live, context.visible, context.signal);
  const cache = useMemo(() => new DetailCache(), []);
  useEffect(() => () => cache.clear(), [cache]);
  useEffect(() => { cache.clear(); }, [cache, data.lane.generation]);

  const [mode, setMode] = useState<'spans' | 'log'>('spans');
  const [categories, setCategories] = useState<ReadonlySet<Category>>(DEFAULT_CATEGORIES);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const [range, setRange] = useState<readonly [number, number]>();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string>();
  const [hoverId, setHoverId] = useState<string>();

  const laneInfo = data.summary?.lanes.find((item) => item.lane === lane);
  const folded = useMemo(() => fold(data.lane.rows, data.summary?.steps ?? [], data.runs, laneInfo ?? { lane }), [data.lane.rows, data.summary?.steps, data.runs, laneInfo, lane]);
  // The request context is a read of the agent's own transcript, so it is read with the view, not with each page.
  const [requestsEpoch, setRequestsEpoch] = useState(0);
  // A selected step of a running conversation newer than the records read asks for a fresh read.
  const selectedNode = selectedId ? folded.byId.get(selectedId) : undefined;
  const wantedAt = live && selectedNode && selectedNode.type !== 'span' ? selectedNode.start : undefined;
  const requests = useTraceRequests(sessionId, lane, context.visible, wantedAt, requestsEpoch, context.signal);
  const requestIndex = useMemo(() => requests.data?.status === 'ok' ? indexRequests(requests.data) : undefined, [requests.data]);
  const marks = useMemo(() => requestIndex ? promptChanges(requestIndex) : undefined, [requestIndex]);
  const reload = useCallback(() => { data.reload(); setRequestsEpoch((value) => value + 1); }, [data.reload]);
  const rowsBySeq = useMemo(() => new Map<number, TraceRow>(data.lane.rows.map((row) => [row.seq, row])), [data.lane.rows]);
  const filter: Filter = useMemo(() => ({ categories, query: deferredQuery, errorsOnly, ...(range ? { range } : {}) }), [categories, deferredQuery, errorsOnly, range]);
  const lines = useMemo(() => mode === 'spans' ? spanLines(folded, filter, collapsed) : logLines(data.lane.rows, filter), [mode, folded, filter, collapsed, data.lane.rows]);
  const lanes = useMemo(() => new Set<string>((data.summary?.lanes ?? []).map((item) => item.lane)), [data.summary?.lanes]);

  const toggle = useCallback((id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);

  /** Selects by id in either reading, switching to the spans when a span or turn is asked for from the log. */
  const select = useCallback((id: string) => {
    if (id.startsWith('prompt:')) { setSelectedId(id); return; }
    if (!id.startsWith('row:') && mode === 'log') setMode('spans');
    const node = folded.byId.get(id);
    const turnId = node && node.type !== 'turn' ? (node.turnId ? `turn:${node.turnId}` : 'turn:loose') : undefined;
    if (turnId) setCollapsed((current) => { if (!current.has(turnId)) return current; const next = new Set(current); next.delete(turnId); return next; });
    setSelectedId(id);
  }, [folded.byId, mode]);

  const switchMode = (next: 'spans' | 'log') => {
    if (next === mode) return;
    if (selectedId) {
      if (next === 'log') {
        const node = folded.byId.get(selectedId);
        const seq = node?.type === 'span' ? node.rows[0]!.seq : node?.type === 'turn' ? node.markers[0]?.seq : undefined;
        setSelectedId(seq !== undefined ? `row:${seq}` : undefined);
      } else if (selectedId.startsWith('row:')) {
        setSelectedId(folded.spanOfSeq.get(Number(selectedId.slice(4))));
      }
    }
    setMode(next);
  };

  const selection: Selection | undefined = useMemo(() => {
    if (!selectedId) return undefined;
    if (selectedId.startsWith('prompt:')) {
      const prompt = requestIndex?.prompts.get(selectedId.slice(7));
      return prompt ? { prompt } : undefined;
    }
    if (selectedId.startsWith('row:')) {
      const row = rowsBySeq.get(Number(selectedId.slice(4)));
      if (!row) return undefined;
      const spanId = folded.spanOfSeq.get(row.seq);
      return spanId ? { row, spanId } : { row };
    }
    const node = folded.byId.get(selectedId);
    return node ? { node } : undefined;
  }, [selectedId, rowsBySeq, folded, requestIndex]);

  const openLane = useCallback((next: SyncLane) => { setLane(next); setSelectedId(undefined); setRange(undefined); setCollapsed(new Set()); }, []);

  const totalRows = laneInfo?.rows ?? 0;
  const loading = !data.lane.complete && !data.lane.error;
  const filtering = deferredQuery !== '' || errorsOnly || range !== undefined || categories.size !== DEFAULT_CATEGORIES.size || [...DEFAULT_CATEGORIES].some((category) => !categories.has(category));
  const clearFilters = () => { setQuery(''); setErrorsOnly(false); setRange(undefined); setCategories(DEFAULT_CATEGORIES); };

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-bg text-fg">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 edge-b px-3 py-1.5">
        {(data.summary?.lanes.length ?? 0) > 1 && (
          <Select
            className="w-52"
            label={m.lane}
            value={lane}
            onChange={(value) => openLane(value as SyncLane)}
            options={(data.summary?.lanes ?? []).map((item) => ({ value: item.lane, label: item.lane === 'main' ? m.mainLane : item.title ?? item.subagentType ?? item.lane }))}
          />
        )}
        <Segmented size="xs" value={mode} ariaLabel={m.modeLabel} onChange={(value) => switchMode(value as 'spans' | 'log')} options={[{ value: 'spans', label: m.spans }, { value: 'log', label: m.log }]} />
        <label className="relative flex w-56 items-center max-md:w-full">
          <IconSearch className="pointer-events-none absolute left-2 size-3.5 text-fg-4" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') setQuery(''); }}
            placeholder={m.filter}
            aria-label={m.filter}
            className="h-7 pl-7 text-xs"
          />
        </label>
        <div className="flex flex-wrap items-center gap-0.5" role="group" aria-label={m.filter}>
          {CATEGORIES.map((category) => {
            const on = categories.has(category);
            return (
              <Button
                key={category}
                size="xs"
                variant={on ? 'secondary' : 'quiet'}
                aria-pressed={on}
                className={cn(!on && 'text-fg-4')}
                onClick={() => setCategories((current) => { const next = new Set(current); if (on) next.delete(category); else next.add(category); return next; })}
              >
                <span className={cn('size-2 shrink-0 rounded-full transition-opacity duration-[var(--duration-fast)]', !on && 'opacity-40')} style={{ background: CATEGORY_COLOR[category] }} aria-hidden />
                {m.categories[category]}
              </Button>
            );
          })}
          <Button size="xs" variant={errorsOnly ? 'secondary' : 'quiet'} aria-pressed={errorsOnly} className={cn(!errorsOnly && 'text-fg-4')} onClick={() => setErrorsOnly(!errorsOnly)}>
            <IconCircleAlert className={cn('size-3.5', errorsOnly && folded.totals.failures > 0 && 'text-danger')} />
            {m.failuresOnly}{folded.totals.failures > 0 ? ` ${folded.totals.failures}` : ''}
          </Button>
        </div>
        <div className="flex-1" />
        {requestIndex && requestIndex.data.prompts.length > 0 && (
          <Button size="xs" variant={selectedId?.startsWith('prompt:') ? 'secondary' : 'quiet'} aria-pressed={selectedId?.startsWith('prompt:') ?? false} onClick={() => select(`prompt:${requestIndex.data.prompts.at(-1)!.id}`)}>
            {m.prompt_}
          </Button>
        )}
        <Tip label={m.reload}>
          <Button size="icon-sm" variant="quiet" aria-label={m.reload} onClick={reload}><IconRefreshCw className="size-3.5" /></Button>
        </Tip>
      </div>

      {(folded.turns.length > 0 || loading) && (
        <Figures folded={folded} live={live} loading={loading} read={data.lane.read} total={Math.max(totalRows, data.lane.read)} rows={data.lane.rows.length} m={m} />
      )}

      {(data.lane.error || data.lane.capped || data.summary?.stepsTruncated || laneInfo?.importing) && (
        <div className="flex shrink-0 flex-col gap-1 px-3 pb-2">
          {data.lane.error && <Notice tone="danger" action={<Button size="xs" variant="secondary" onClick={reload}>{m.reload}</Button>}>{m.loadFailed}: {data.lane.error}</Notice>}
          {data.lane.capped && <Notice tone="warning">{m.capped(formatExact(data.lane.rows.length))}</Notice>}
          {data.summary?.stepsTruncated && <Notice>{m.stepsTruncated(formatExact(data.summary.steps.length))}</Notice>}
          {laneInfo?.importing && <Notice>{m.importing}</Notice>}
        </div>
      )}

      {folded.turns.length > 0 && (
        <div className="shrink-0 edge-b animate-in fade-in-0 duration-[var(--duration-slow)] ease-[var(--ease-decelerate)]">
          <Timeline folded={folded} resetKey={lane} selectedId={selectedId} hoverId={hoverId} range={range} marks={marks} onRange={setRange} onSelect={select} onHover={setHoverId} />
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <SpanList
            lines={lines}
            selectedId={selectedId}
            hoverId={hoverId}
            onSelect={select}
            onHover={setHoverId}
            onToggle={toggle}
            mode={mode}
            empty={loading ? (
              <div className="flex h-32 items-center justify-center"><Spinner className="size-4 text-fg-4" /></div>
            ) : (
              <EmptyState className="mt-16" title={filtering ? m.noMatches : m.noRows}>
                {filtering && <Button size="sm" variant="secondary" onClick={clearFilters}>{m.clearFilters}</Button>}
              </EmptyState>
            )}
          />
        </div>
        {selection && (
          <div className="flex w-[440px] shrink-0 edge-l animate-in fade-in-0 slide-in-from-right-3 duration-[var(--duration-base)] ease-[var(--ease-decelerate)] max-lg:w-[360px] max-md:absolute max-md:inset-0 max-md:w-full">
            <Inspector
              selection={selection}
              onClose={() => setSelectedId(undefined)}
              sessionId={sessionId}
              session={session}
              lane={lane}
              generation={data.lane.generation}
              cache={cache}
              onOpenLane={openLane}
              onSelect={select}
              lanes={lanes}
              requests={requests}
              requestIndex={requestIndex}
              onOpenPrompt={(id) => select(`prompt:${id}`)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/*
 * The lane in figures, the overview's head: active time is the largest number, the counts beside it, and the
 * tokens as one stacked bar with its legend. The one gradient of the screen tints this band.
 */
function Figures({ folded, live, loading, read, total, rows, m }: { folded: Folded; live: boolean; loading: boolean; read: number; total: number; rows: number; m: TraceMessages }) {
  const { totals } = folded;
  const tokens = totals.tokens;
  const wall = folded.turns.length ? folded.turns[folded.turns.length - 1]!.end - folded.turns[0]!.start : 0;
  const read_ = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const cached = read_ > 0 ? Math.round((tokens.cacheRead / read_) * 100) : undefined;
  return (
    <div style={BAND} className="mx-3 mb-2 mt-2 grid shrink-0 grid-cols-[auto_repeat(4,minmax(0,auto))_minmax(0,1fr)] items-end gap-x-7 gap-y-3 rounded-xl px-4 py-3 animate-in fade-in-0 slide-in-from-top-1 duration-[var(--duration-slow)] ease-[var(--ease-decelerate)] max-lg:grid-cols-[auto_repeat(4,minmax(0,auto))] max-md:grid-cols-3">
      <Figure label={m.activeTime} value={formatMs(totals.activeMs) || '0 ms'} prominent
        aside={live ? <span className="flex items-center gap-1.5 text-xs text-fg-2"><StatusDot tone="success" pulse />{m.live}</span>
          : wall > totals.activeMs ? <span className="text-xs text-fg-4">/ {formatMs(wall)}</span> : null} />
      <Figure label={m.turns} value={formatExact(totals.turns)} />
      <Figure label={m.toolCalls} value={formatExact(totals.tools)} />
      <Figure label={m.requests} value={formatExact(totals.requests)} />
      <Figure label={m.failures} value={formatExact(totals.failures)} danger={totals.failures > 0} />
      <div className="flex min-w-0 flex-col gap-1.5 max-lg:col-span-full">
        <div className="flex items-baseline gap-2 text-xs">
          <span className="text-fg-3">{m.tokens}</span>
          {tokens.measured && <span className="font-medium tabular-nums text-fg">{formatCount(read_ + tokens.output)}</span>}
          {cached !== undefined && <span className="tabular-nums text-fg-4">{cached}% {m.cacheRead.toLowerCase()}</span>}
          {tokens.estimated && <span className="text-fg-4">{m.estimated}</span>}
          <span className="flex-1" />
          {loading
            ? <span className="flex items-center gap-1.5 text-fg-3"><Spinner className="size-3" />{m.reading(formatExact(read), formatExact(total))}</span>
            : <span className="tabular-nums text-fg-4">{formatExact(rows)} {m.rows.toLowerCase()}</span>}
        </div>
        {tokens.measured ? (
          <>
            <TokenBar tokens={tokens} className="h-2 w-full" />
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-fg-3">
              {TOKEN_SERIES.map((key) => (
                <span key={key} className="flex items-center gap-1 whitespace-nowrap">
                  <span className="size-1.5 rounded-full" style={{ background: TOKEN_COLOR[key] }} aria-hidden />
                  {m[key]} <span className="tabular-nums text-fg-2">{formatCount(tokens[key])}</span>
                </span>
              ))}
            </div>
          </>
        ) : <span className="h-2 w-full rounded-full bg-line-soft" aria-hidden />}
      </div>
    </div>
  );
}

// Foundations §12.2: the tint, at most a tenth of the data hue mixed on the card colour, fades into the panel within it.
const BAND = { background: 'linear-gradient(100deg, color-mix(in oklab, var(--chart-1) 9%, var(--bg-elevated)), var(--bg-subtle) 60%)' } as const;

function Figure({ label, value, prominent, danger, aside }: { label: string; value: string; prominent?: boolean; danger?: boolean; aside?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-fg-3">{label}</span>
      <span className="flex items-baseline gap-2">
        <span className={cn('truncate font-semibold tracking-tight tabular-nums', prominent ? 'text-2xl' : 'text-lg', danger ? 'text-danger' : 'text-fg')}>{value}</span>
        {aside}
      </span>
    </div>
  );
}
