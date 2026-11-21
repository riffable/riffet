import { useMemo, useState, type ReactNode } from 'react';
import type { Run, Session, SyncLane, TracePrompt, TraceRow, TraceRowDetail } from '@contracts';
import { Button, Markdown, Segmented, Spinner, Tip, ToolIcon, usePluginHost, useMessages } from '@riffet/plugin-web';
import { cn } from './cn';
import { useRowDetail, type DetailCache, type DetailState, type RequestsState } from './data';
import { formatBytes, formatClock, formatCount, formatDateTime, formatExact, formatMs, formatOffset } from './format';
import { IconCopy, IconGitBranch, IconSquareArrowOutUpRight, IconX } from './icons';
import { JsonTree, LongString } from './JsonTree';
import { catalogs, type TraceMessages } from './messages';
import { requestOfStep, requestsOfTurn, timeOf, type Node, type RequestIndex, type Span, type Step, type Turn } from './model';
import { AddedMessages, PromptDetail, RequestDetail, RequestsGate } from './Requests';
import { CATEGORY_COLOR, TOKEN_COLOR } from './palette';
import { TokenBar } from './TokenBar';

/*
 * What the selection holds, read on demand: a turn's run and dispatch timings, a span's revisions and
 * whole payloads, a model request's token counts, or one log row as stored.
 */

export type Selection = { node: Node } | { row: TraceRow; spanId?: string } | { prompt: TracePrompt };

interface Context {
  sessionId: string;
  session: Session | undefined;
  lane: SyncLane;
  generation: string | undefined;
  cache: DetailCache;
  onOpenLane(lane: SyncLane): void;
  onSelect(id: string): void;
  lanes: ReadonlySet<string>;
  /** The lane's request context, read when first needed (docs/TRACE.md §2.1). */
  requests: RequestsState;
  requestIndex: RequestIndex | undefined;
  onOpenPrompt(id: string): void;
}

export function Inspector({ selection, onClose, ...context }: Context & { selection: Selection; onClose(): void }) {
  const m = useMessages(catalogs);
  const node = 'node' in selection ? selection.node : undefined;
  const title = node?.type === 'turn' ? (node.turnId ? m.turn(node.index) : m.outsideTurns)
    : node?.type === 'step' ? node.step.model ?? m.categories.model
      : node?.type === 'span' ? node.name ?? node.kind
        : 'row' in selection ? `${selection.row.kind} · #${selection.row.seq}` : 'prompt' in selection ? promptTitle(selection.prompt.id, context.requestIndex, m.prompt_) : '';
  return (
    <aside className="flex min-h-0 w-full flex-col bg-elevated">
      <header className="flex h-11 shrink-0 items-center gap-2 edge-b pl-4 pr-2">
        {node && node.type !== 'turn' && <span className="size-2 shrink-0 rounded-full" style={{ background: node.error ? 'var(--danger)' : CATEGORY_COLOR[node.category] }} aria-hidden />}
        {node?.type === 'span' && node.category === 'tool' && <ToolIcon kind={node.toolKind ?? ''} className="size-3.5 shrink-0 text-fg-3" />}
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">{title}</span>
        <Button size="icon-sm" variant="quiet" aria-label={m.close} onClick={onClose}><IconX className="size-3.5" /></Button>
      </header>
      {/* Keyed by the selection, so another selection starts at its top. */}
      <div key={node?.id ?? ('row' in selection ? `row:${selection.row.seq}` : 'prompt' in selection ? `prompt:${selection.prompt.id}` : '')} className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3">
        {node?.type === 'turn' && <TurnDetail turn={node} {...context} />}
        {node?.type === 'span' && <SpanDetail key={node.id} span={node} {...context} />}
        {node?.type === 'step' && <StepDetail step={node} m={m} {...context} />}
        {'prompt' in selection && context.requestIndex && <PromptDetail key={selection.prompt.id} prompt={selection.prompt} index={context.requestIndex} />}
        {'row' in selection && <RowDetail key={selection.row.seq} row={selection.row} {...(selection.spanId ? { spanId: selection.spanId } : {})} {...context} />}
      </div>
    </aside>
  );
}

/** `Prompt 2/3`: which of the lane's prompts this is. */
function promptTitle(id: string, index: RequestIndex | undefined, label: string): string {
  const prompts = index?.data.prompts ?? [];
  const position = prompts.findIndex((prompt) => prompt.id === id);
  return prompts.length > 1 && position >= 0 ? `${label} ${position + 1}/${prompts.length}` : label;
}

/* ------------------------------------------------------------------ shared pieces */

function Facts({ items }: { items: Array<[string, ReactNode] | false | undefined> }) {
  const shown = items.filter((item): item is [string, ReactNode] => Array.isArray(item) && item[1] !== undefined && item[1] !== '' && item[1] !== null);
  return (
    <dl className="grid grid-cols-[minmax(84px,auto)_1fr] gap-x-3 gap-y-1 text-xs">
      {shown.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-fg-4">{label}</dt>
          <dd className="min-w-0 select-text wrap-anywhere font-mono text-fg-2">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-5">
      <div className="mb-2 flex h-6 items-center gap-2">
        <h3 className="flex-1 text-xs font-medium text-fg-3">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function CopyJson({ value }: { value: unknown }) {
  const { ui } = usePluginHost();
  const m = useMessages(catalogs);
  return (
    <Tip label={m.copyJson}>
      <Button size="icon-xs" variant="quiet" aria-label={m.copyJson} onClick={() => { void ui.copy(typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }}>
        <IconCopy className="size-3.5" />
      </Button>
    </Tip>
  );
}

function Loading({ state, children }: { state: DetailState | undefined; children: (detail: TraceRowDetail) => ReactNode }) {
  const m = useMessages(catalogs);
  if (!state) return null;
  if (state.status === 'loading') return <div className="flex h-10 items-center"><Spinner className="size-4 text-fg-4" /></div>;
  if (state.status === 'error') return <p className="text-xs text-danger">{m.loadFailed}: {state.message}</p>;
  return <>{children(state.detail)}</>;
}

/** A payload as stored: the tree, or the head of its text when it was too large to send whole. */
function Payload({ detail }: { detail: TraceRowDetail }) {
  const m = useMessages(catalogs);
  if (detail.cleared) return <p className="text-xs text-fg-4">{m.cleared}</p>;
  if (detail.payloadText !== undefined) {
    return (
      <>
        {detail.truncated && <p className="mb-1 text-xs text-fg-4">{detail.missing ? m.blobMissing : m.truncated}</p>}
        <LongString text={detail.payloadText} />
      </>
    );
  }
  return <JsonTree value={detail.payload} openDepth={3} />;
}

type Envelope = { data?: Record<string, unknown> };
const dataOf = (detail: TraceRowDetail | undefined): Record<string, unknown> | undefined => (detail?.payload as Envelope | undefined)?.data;

function textOf(content: unknown): string | undefined {
  if (!content) return undefined;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.map(textOf).filter((part): part is string => Boolean(part));
    return parts.length ? parts.join('\n') : undefined;
  }
  if (typeof content === 'object') {
    const block = content as Record<string, unknown>;
    if (typeof block.text === 'string') return block.text;
    return textOf(block.content);
  }
  return undefined;
}

/* ------------------------------------------------------------------ span */

function SpanDetail({ span, sessionId, session, lane, generation, cache, onOpenLane, lanes }: Context & { span: Span }) {
  const m = useMessages(catalogs);
  const host = usePluginHost();
  const [tab, setTab] = useState<'content' | 'payload' | 'revisions'>('content');
  const latest = span.rows[span.rows.length - 1]!;
  const call = span.rows.find((row) => row.kind === 'tool_call') ?? span.rows[0]!;
  const [revision, setRevision] = useState(latest.seq);
  const latestState = useRowDetail(sessionId, lane, generation, latest.seq, cache);
  const callState = useRowDetail(sessionId, lane, generation, span.category === 'tool' && call.seq !== latest.seq ? call.seq : undefined, cache);
  const revisionState = useRowDetail(sessionId, lane, generation, tab === 'payload' ? revision : undefined, cache);
  const subLane = span.lane ?? (span.toolCallId && lanes.has(`sub:${span.toolCallId}`) ? `sub:${span.toolCallId}` as SyncLane : undefined);

  return (
    <>
      <Facts items={[
        ['kind', span.kind],
        span.status !== undefined && [m.status, span.status],
        span.toolCallId !== undefined && ['toolCallId', span.toolCallId],
        ['nativeId', latest.nativeId],
        span.turnId !== undefined && ['turnId', span.turnId],
        latest.runId !== undefined && ['runId', latest.runId],
        [m.started, formatClock(span.start)],
        span.end !== span.start && [m.ended, formatClock(span.end)],
        span.timed && [m.duration, formatMs(span.end - span.start)],
        [m.revisions, String(span.rows.length)],
        [m.size, formatBytes(span.bytes)],
      ]} />
      <div className="mt-3 flex flex-wrap gap-1.5">
        {subLane && <Button size="sm" variant="secondary" onClick={() => onOpenLane(subLane)}><IconGitBranch className="size-3.5" />{m.openLane}</Button>}
        {session && span.category !== 'draft' && (
          <Button size="sm" variant="ghost" onClick={() => host.navigation.openTurn(session, { nativeId: span.rows[0]!.nativeId, ...(latest.runId ? { runId: latest.runId } : {}) })}>
            <IconSquareArrowOutUpRight className="size-3.5" />{m.openInChat}
          </Button>
        )}
      </div>
      <Segmented
        className="mt-4"
        size="xs"
        value={tab}
        ariaLabel={m.modeLabel}
        onChange={(value) => setTab(value as typeof tab)}
        options={[{ value: 'content', label: m.content }, { value: 'payload', label: m.payload }, { value: 'revisions', label: `${m.revisions} ${span.rows.length}` }]}
      />
      {tab === 'content' && (
        <div className="mt-3">
          {span.category === 'tool' && (
            <Section title={m.input_}>
              <Loading state={callState ?? latestState}>{(detail) => {
                const input = dataOf(detail)?.rawInput;
                return input !== undefined ? <JsonTree value={input} openDepth={2} /> : <Payload detail={detail} />;
              }}</Loading>
            </Section>
          )}
          <Section title={span.category === 'tool' ? m.output_ : m.text} action={latestState?.status === 'ready' ? <CopyJson value={latestState.detail.payload ?? latestState.detail.payloadText} /> : undefined}>
            <Loading state={latestState}>{(detail) => <SpanContent span={span} detail={detail} />}</Loading>
          </Section>
        </div>
      )}
      {tab === 'payload' && (
        <div className="mt-3">
          {span.rows.length > 1 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {span.rows.map((row) => (
                <button
                  key={row.seq}
                  type="button"
                  onClick={() => setRevision(row.seq)}
                  className={cn('h-6 rounded-sm px-1.5 font-mono text-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus', row.seq === revision ? 'bg-active text-fg' : 'text-fg-3 hover:bg-hover')}
                >
                  #{row.seq}{row.seq === latest.seq ? ` ${m.latest}` : ''}
                </button>
              ))}
            </div>
          )}
          <Loading state={revisionState}>{(detail) => (
            <>
              <div className="mb-1 flex items-center justify-between font-mono text-2xs text-fg-4">
                <span>{detail.kind} · r{detail.rev} · {formatBytes(detail.bytes)} · {detail.digest.slice(0, 12)}</span>
                <CopyJson value={detail.payload ?? detail.payloadText} />
              </div>
              <Payload detail={detail} />
            </>
          )}</Loading>
        </div>
      )}
      {tab === 'revisions' && <Revisions rows={span.rows} onOpen={(seq) => { setRevision(seq); setTab('payload'); }} />}
    </>
  );
}

function SpanContent({ span, detail }: { span: Span; detail: TraceRowDetail }) {
  if (detail.cleared || detail.payloadText !== undefined) return <Payload detail={detail} />;
  const data = dataOf(detail);
  if (!data) return <Payload detail={detail} />;
  if (span.category === 'tool') {
    const text = textOf(data.content);
    return (
      <>
        {text && <LongString text={text} />}
        {data.rawOutput !== undefined && <div className="mt-2"><JsonTree value={data.rawOutput} openDepth={1} /></div>}
        {!text && data.rawOutput === undefined && <JsonTree value={data} openDepth={1} />}
      </>
    );
  }
  const text = textOf(data.content) ?? (typeof data.text === 'string' ? data.text : undefined);
  if (span.category === 'message' && text) return <Markdown text={text} className="text-sm" />;
  if (text) return <LongString text={text} />;
  return <JsonTree value={data} openDepth={2} />;
}

function Revisions({ rows, onOpen }: { rows: readonly TraceRow[]; onOpen(seq: number): void }) {
  const first = timeOf(rows[0]!);
  return (
    <ol className="mt-3 flex flex-col">
      {rows.map((row) => (
        <li key={row.seq}>
          <button type="button" onClick={() => onOpen(row.seq)} className="flex h-7 w-full items-center gap-2 rounded-sm px-1.5 text-left font-mono text-xs hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <span className="w-14 shrink-0 text-fg-4">#{row.seq}</span>
            <span className="w-8 shrink-0 text-fg-4">r{row.rev}</span>
            <span className="min-w-0 flex-1 truncate text-fg-2">{row.kind}{row.status ? ` · ${row.status}` : ''}</span>
            <span className="shrink-0 text-fg-4">{formatOffset(timeOf(row) - first)}</span>
            <span className={cn('w-14 shrink-0 text-right', row.cleared ? 'italic text-fg-4' : 'text-fg-3')}>{row.cleared ? '{}' : formatBytes(row.bytes)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ one log row */

function RowDetail({ row, spanId, sessionId, lane, generation, cache, onSelect }: Context & { row: TraceRow; spanId?: string }) {
  const m = useMessages(catalogs);
  const state = useRowDetail(sessionId, lane, generation, row.seq, cache);
  return (
    <>
      <Facts items={[
        ['seq', String(row.seq)], ['kind', row.kind], row.type !== undefined && ['type', row.type], ['nativeId', row.nativeId], ['rev', String(row.rev)],
        row.turnId !== undefined && ['turnId', row.turnId], row.runId !== undefined && ['runId', row.runId], row.toolCallId !== undefined && ['toolCallId', row.toolCallId],
        row.status !== undefined && [m.status, row.status], ['at', formatDateTime(timeOf(row))], [m.size, `${formatBytes(row.bytes)}${row.blob ? ' · blob' : ''}`],
        state?.status === 'ready' && ['digest', state.detail.digest], state?.status === 'ready' && state.detail.blobRef !== undefined && ['blobRef', state.detail.blobRef],
      ]} />
      {spanId && <Button className="mt-3" size="sm" variant="ghost" onClick={() => onSelect(spanId)}>{m.showSpan}</Button>}
      <Section title={m.payload} action={state?.status === 'ready' ? <CopyJson value={state.detail.payload ?? state.detail.payloadText} /> : undefined}>
        <Loading state={state}>{(detail) => <Payload detail={detail} />}</Loading>
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ model request */

function Tokens({ rows }: { rows: Array<[string, number | undefined, string]> }) {
  const shown = rows.filter((row): row is [string, number, string] => row[1] !== undefined);
  const total = shown.reduce((sum, [, value]) => sum + value, 0) || 1;
  if (!shown.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {shown.map(([label, value, color]) => (
        <div key={label} className="flex items-center gap-2 text-xs">
          <span className="w-20 shrink-0 text-fg-4">{label}</span>
          <span className="relative h-1.5 min-w-0 flex-1 rounded-full bg-muted">
            <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(0.5, (value / total) * 100)}%`, background: color }} />
          </span>
          <span className="w-20 shrink-0 text-right font-mono text-fg-2">{formatExact(value)}</span>
        </div>
      ))}
    </div>
  );
}

function StepDetail({ step: item, m, requests, requestIndex, onOpenPrompt }: Context & { step: Step; m: TraceMessages }) {
  const step = item.step;
  return (
    <>
      <Facts items={[
        [m.model, step.model], step.requestedModel !== step.model && [m.requestedModel, step.requestedModel], ['agent', step.agent], ['subagentType', step.subagentType],
        [m.started, step.startedAt !== undefined ? formatClock(step.startedAt) : undefined], [m.ended, step.endedAt !== undefined ? formatClock(step.endedAt) : undefined],
        [m.duration, formatMs(step.durationMs ?? (item.timed ? item.end - item.start : undefined))], ['window', step.window], ['tokens', step.tokens === 'estimated' ? m.estimated : step.tokens],
        ['runId', step.runId], ['nativeMessageId', step.nativeMessageId], ['key', step.key], ['parentKey', step.parentKey],
      ]} />
      <Section title={m.tokens}>
        <Tokens rows={[[m.cacheRead, step.cacheReadTokens, TOKEN_COLOR.cacheRead], [m.input, step.inputTokens, TOKEN_COLOR.input], [m.cacheWrite, step.cacheWriteTokens, TOKEN_COLOR.cacheWrite], [m.output, step.outputTokens, TOKEN_COLOR.output], [m.reasoning, step.reasoningTokens, TOKEN_COLOR.reasoning]]} />
      </Section>
      <Section title={m.request}>
        <RequestsGate state={requests} index={requestIndex}>
          {(index) => {
            const request = requestOfStep(index, item);
            return request ? <RequestDetail request={request} index={index} onOpenPrompt={onOpenPrompt} /> : <p className="text-xs text-fg-4">{m.noRequestMatch}</p>;
          }}
        </RequestsGate>
      </Section>
      <Section title={m.payload} action={<CopyJson value={step} />}><JsonTree value={step} openDepth={1} /></Section>
    </>
  );
}

/* ------------------------------------------------------------------ turn and its run */

function TurnDetail({ turn, onSelect, requests, requestIndex, onOpenPrompt }: Context & { turn: Turn }) {
  const m = useMessages(catalogs);
  const run = turn.run;
  const steps = turn.children.filter((child): child is Step => child.type === 'step');
  return (
    <>
      <Facts items={[
        turn.turnId !== undefined && ['turnId', turn.turnId], turn.runId !== undefined && ['runId', turn.runId],
        [m.started, turn.start ? formatDateTime(turn.start) : undefined], turn.ended && [m.ended, formatClock(turn.end)],
        turn.turnId !== undefined && [m.duration, formatMs(turn.end - turn.start)], [m.status, turn.status ?? (turn.ended ? undefined : m.notEnded)],
        [m.toolCalls, turn.tools ? String(turn.tools) : undefined], [m.requests, steps.length ? String(steps.length) : undefined],
      ]} />
      {turn.tokens.measured && (
        <Section title={turn.tokens.estimated ? `${m.tokens} · ${m.estimated}` : m.tokens}>
          <Tokens rows={[[m.cacheRead, turn.tokens.cacheRead, TOKEN_COLOR.cacheRead], [m.input, turn.tokens.input, TOKEN_COLOR.input], [m.cacheWrite, turn.tokens.cacheWrite, TOKEN_COLOR.cacheWrite], [m.output, turn.tokens.output, TOKEN_COLOR.output], [m.reasoning, turn.tokens.reasoning || undefined, TOKEN_COLOR.reasoning]]} />
        </Section>
      )}
      {turn.error && <Section title={m.error}><LongString text={turn.error} className="text-danger" /></Section>}
      {turn.prompt && <Section title={m.prompt}><LongString text={run?.prompt ?? turn.prompt} /></Section>}
      {run && <RunDetail run={run} m={m} />}
      {steps.length > 0 && (
        <Section title={m.steps}>
          <ol className="flex flex-col">
            {steps.map((step) => (
              <li key={step.id}>
                <button type="button" onClick={() => onSelect(step.id)} className="flex h-7 w-full items-center gap-2 rounded-sm px-1.5 text-left font-mono text-xs hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                  <span className="min-w-0 flex-1 truncate text-fg-2">{step.step.model ?? '—'}</span>
                  <TokenBar tokens={{ cacheRead: step.step.cacheReadTokens ?? 0, input: step.step.inputTokens ?? 0, cacheWrite: step.step.cacheWriteTokens ?? 0, output: step.step.outputTokens ?? 0 }} className="h-1.5 w-12 shrink-0" />
                  <span className="shrink-0 text-fg-3">{formatCount((step.step.inputTokens ?? 0) + (step.step.cacheReadTokens ?? 0) + (step.step.cacheWriteTokens ?? 0))} → {formatCount(step.step.outputTokens ?? 0)}</span>
                  <span className="w-16 shrink-0 text-right text-fg-3">{step.timed ? formatMs(step.end - step.start) : ''}</span>
                </button>
              </li>
            ))}
          </ol>
        </Section>
      )}
      <TurnRequests turn={turn} requests={requests} requestIndex={requestIndex} onOpenPrompt={onOpenPrompt} />
      {turn.markers.length > 0 && (
        <Section title={m.markers}>
          <JsonTree value={turn.markers} openDepth={1} />
        </Section>
      )}
    </>
  );
}

function RunDetail({ run, m }: { run: Run; m: TraceMessages }) {
  const native = run.native;
  const timings = useMemo(() => Object.entries(native?.timings ?? {}).filter(([, at]) => Number.isFinite(at)).sort((a, b) => a[1] - b[1]), [native?.timings]);
  const created = Date.parse(run.createdAt);
  const origin = Math.min(created, timings[0]?.[1] ?? created);
  const span = Math.max(1, (timings.at(-1)?.[1] ?? origin) - origin);
  return (
    <>
      <Section title={m.run} action={<CopyJson value={run} />}>
        <Facts items={[
          ['id', run.id], ['state', run.state], [m.delivery, native?.delivery], [m.attempt, native ? String(native.attempt) : undefined],
          native?.intent !== undefined && ['intent', native.intent], native?.stage !== undefined && ['stage', native.stage],
          native?.sourceRunId !== undefined && ['sourceRunId', native.sourceRunId], native?.ownerRunId !== undefined && ['ownerRunId', native.ownerRunId],
          [m.config, native ? configText(native.config) : undefined], native?.resolvedConfig !== undefined && [m.resolved, configText(native.resolvedConfig)],
          native?.metrics !== undefined && ['metrics', `${formatExact(native.metrics.outputTokens)} tok · ${formatMs(native.metrics.durationMs)} · ${native.metrics.window}`],
          run.error !== undefined && [m.error, run.error],
        ]} />
        {native?.diagnostic && (
          <p className="mt-2 rounded-md bg-danger-soft px-2.5 py-1.5 font-mono text-xs text-fg-2">
            {native.diagnostic.code ? `${native.diagnostic.code} · ` : ''}{native.diagnostic.stage ? `${native.diagnostic.stage} · ` : ''}{native.diagnostic.message}
          </p>
        )}
      </Section>
      {timings.length > 0 && (
        <Section title={m.timings}>
          <ol className="flex flex-col gap-0.5">
            <TimingLine label="createdAt" offset={created - origin} span={span} />
            {timings.map(([key, at]) => <TimingLine key={key} label={key} offset={at - origin} span={span} />)}
          </ol>
        </Section>
      )}
    </>
  );
}

function TimingLine({ label, offset, span }: { label: string; offset: number; span: number }) {
  return (
    <li className="flex h-6 items-center gap-2 font-mono text-xs">
      <span className="w-28 shrink-0 truncate text-fg-3">{label}</span>
      <span className="relative h-3 min-w-0 flex-1">
        <span className="absolute inset-x-0 top-1/2 h-px bg-line-soft" />
        <span className="absolute top-0 h-3 w-0.5 rounded-full bg-fg-3" style={{ left: `calc(${(offset / span) * 100}% - 1px)` }} />
      </span>
      <span className="w-16 shrink-0 text-right text-fg-2">{formatOffset(offset)}</span>
    </li>
  );
}

const configText = (config: { model?: string; mode: string; approval?: string }) => [config.model, config.mode, config.approval].filter(Boolean).join(' · ');

/**
 * What the turn's requests carried beyond the conversation: a turn recorded as one (Codex) shows that record;
 * per-request records (Claude Code) show the injected messages of all of them, each once.
 */
function TurnRequests({ turn, requests, requestIndex, onOpenPrompt }: Pick<Context, 'requests' | 'requestIndex' | 'onOpenPrompt'> & { turn: Turn }) {
  const m = useMessages(catalogs);
  if (!turn.turnId) return null;
  return (
    <Section title={requestIndex?.data.granularity === 'turn' ? m.request : m.addedThisTurn}>
      <RequestsGate state={requests} index={requestIndex}>
        {(index) => {
          const list = requestsOfTurn(index, turn);
          if (index.data.granularity === 'turn' && list.length === 1) return <RequestDetail request={list[0]!} index={index} onOpenPrompt={onOpenPrompt} />;
          const seen = new Set<string>();
          const injected = list.flatMap((request) => (request.added ?? []).filter((id): id is string => id !== null && !seen.has(id) && Boolean(seen.add(id))));
          return injected.length ? <AddedMessages added={injected} index={index} /> : <p className="text-xs text-fg-4">{m.noRequestMatch}</p>;
        }}
      </RequestsGate>
    </Section>
  );
}
