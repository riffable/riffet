import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Spinner, ToolIcon, useMessages, usePluginHost } from '@riffet/plugin-web';
import { cn } from './cn';
import {
  IconArrowRightLeft, IconArrowsInLineHorizontal, IconBrain, IconCalendarClock, IconCheck, IconCircle, IconCircleAlert, IconCircleCheck, IconGitCommitHorizontal, IconGitFork, IconGlobe, IconListChecks,
  IconPaperclip, IconPlus, IconSparkle, IconSparkles, IconSquareTerminal,
} from './icons';
import { catalogs } from './messages';
import { LIVE_STATES, attachmentsOf, callLabel, formatDuration, plainText, type Artifact, type FileChange, type Step, type Track, type TurnDetail } from './detail';
import { ART, BAR, CHANGE, ROW, STRIP, lineCount, type Block, type FlowNext, type FlowNode, type Mark } from './flow';

/*
 * What the canvas draws for each thing a conversation holds. Every kind keeps the same paper and
 * ink; what tells them apart is shape and edge. The reader's messages are filled bubbles, what the
 * workbench injected is outlined or dashed, and the agent's answers alone are raised cards. Nothing
 * else on the canvas is carded: what an answer wrote is a ledger printed on its directory's track,
 * what it showed or made are photos and window outlines, calls are marks on a strip, subagents and
 * background tasks are bars, a `/compact` is a pin on the spine. Colour marks state only, and the
 * diff's own green and red.
 */

export interface CardActions {
  hover: (node: FlowNode, on: boolean) => void;
  /** The pointer is on one file of a change sheet, or has left it. */
  file: (node: FlowNode, path: string | undefined) => void;
  /** The pointer is on one call of a strip (its index among the strip's steps), or has left it. */
  mark: (node: FlowNode, index: number | undefined) => void;
  select: (node: FlowNode) => void;
  open: (node: FlowNode) => void;
  /** An image is opened large. */
  view: (item: Artifact) => void;
  /** An image would not load; it leaves the track. */
  broken: (key: string) => void;
}

/** The live output rate of a running turn, sampled as its tokens arrive. */
export interface Pulse { rate: number; series: number[] }

/** The agent answer's own form: no other kind of node wears it. */
const answerCard = 'rounded-[14px] border border-line bg-elevated shadow-[0_1px_1px_rgb(0_0_0/0.03),0_10px_28px_-16px_rgb(0_0_0/0.22)]';
const answerHover = 'hover:border-line-strong hover:shadow-[0_1px_1px_rgb(0_0_0/0.04),0_16px_36px_-16px_rgb(0_0_0/0.3)]';
const clamp = (lines: number): CSSProperties => ({ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: lines, overflow: 'hidden' });
const SIZE_TRANSITION = 'width 420ms cubic-bezier(0.33, 1, 0.68, 1), height 420ms cubic-bezier(0.33, 1, 0.68, 1), opacity 200ms, box-shadow 200ms, border-color 200ms';

export const Node = memo(function Node({ node, far, cutoff, now, pulse, fresh, dim, lit, selected, focusPath, marked, actions }: {
  node: FlowNode;
  far: boolean;
  cutoff: number;
  now: number;
  pulse: Pulse | undefined;
  fresh: boolean;
  dim: boolean;
  lit: boolean;
  selected: boolean;
  /** The file a hover is following across change sheets. */
  focusPath?: string | undefined;
  /** The call of a strip under the pointer. */
  marked?: number | undefined;
  actions: CardActions;
}) {
  const style: CSSProperties = { left: node.x, top: node.y, width: node.w, height: node.h, transition: SIZE_TRANSITION };
  const shell = cn('absolute outline-none', fresh && 'canvas-enter', dim && 'opacity-45', selected && 'ring-2 ring-accent/50 ring-offset-2 ring-offset-[var(--canvas-paper)]');
  const press = {
    'data-node': node.id,
    role: 'button' as const, tabIndex: far ? -1 : 0,
    onClick: () => actions.select(node), onDoubleClick: () => actions.open(node),
    onPointerEnter: () => actions.hover(node, true), onPointerLeave: () => actions.hover(node, false),
    onKeyDown: (event: React.KeyboardEvent) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); actions.select(node); } },
  };
  switch (node.kind) {
    case 'header': return <Header node={node} far={far} className={shell} style={style} onOpen={() => actions.open(node)} />;
    case 'user': return <Prompt node={node} far={far} press={press} className={shell} style={style} />;
    case 'signal': return <Signal node={node} far={far} cutoff={cutoff} press={press} className={shell} style={style} />;
    case 'agent': return <Answer node={node} far={far} cutoff={cutoff} now={now} pulse={pulse} lit={lit} press={press} className={shell} style={style} />;
    case 'actor': return <ActorBar node={node} far={far} cutoff={cutoff} marked={marked} onMark={(index) => actions.mark(node, index)} press={press} className={shell} style={style} />;
    case 'fold': return <FoldPin node={node} far={far} press={press} className={shell} style={style} />;
    case 'tools': return <Strip node={node} far={far} cutoff={cutoff} marked={marked} onMark={(index) => actions.mark(node, index)} press={press} className={shell} style={style} />;
    case 'change': return <Ledger node={node} far={far} focusPath={focusPath} onFile={(path) => actions.file(node, path)} press={press} className={shell} style={style} />;
    case 'artifacts': return <Shelf node={node} far={far} onView={actions.view} onBroken={actions.broken} press={press} className={shell} style={style} />;
  }
});

type Press = Record<string, unknown>;

function Header({ node, far, className, style, onOpen }: { node: Extract<FlowNode, { kind: 'header' }>; far: boolean; className: string; style: CSSProperties; onOpen: () => void }) {
  const m = useMessages(catalogs);
  const { backendLabel } = usePluginHost().sessions;
  const { session } = node;
  const live = LIVE_STATES.has(session.state);
  return (
    <div data-node={node.id} className={cn(className, 'flex items-center gap-2 px-1')} style={style}>
      {far ? <span className="h-2.5 w-48 rounded-full bg-fg/15" /> : (
        <>
          {node.fork === 'handoff' ? <IconArrowRightLeft className="size-3.5 shrink-0 text-fg-3" /> : node.fork ? <IconGitFork className="size-3.5 shrink-0 text-fg-3" /> : null}
          <button type="button" className="min-w-0 truncate text-left text-[16px] font-semibold tracking-[-0.01em] text-fg hover:underline" onClick={onOpen}>{session.title}</button>
          <span className="shrink-0 text-xs text-fg-4">{backendLabel(session)}{session.model ? ` · ${session.model.replace(/\[.*\]$/, '')}` : ''}</span>
          {live && <span className="size-1.5 shrink-0 rounded-full bg-accent animate-pulse-dot" />}
          {node.written && (
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-fg-4">
              <IconGitCommitHorizontal className="size-3.5" />{m.files(node.written.files)}
              <span className="font-mono text-[10.5px]"><span className="text-[var(--diff-add-marker)]">+{node.written.added}</span> <span className="text-[var(--diff-del-marker)]">−{node.written.removed}</span></span>
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** The reader's message, in whichever form it came: typed, a fork's brief, a scheduled run, a command. */
function Prompt({ node, far, press, className, style }: { node: Extract<FlowNode, { kind: 'user' }>; far: boolean; press: Press; className: string; style: CSSProperties }) {
  const m = useMessages(catalogs);
  const steers = node.detail?.steers ?? [];
  const { images, others } = attachmentsOf(node.detail?.attachments ?? []);
  if (far) return <div {...press} className={cn(className, 'rounded-[14px]', node.variant === 'brief' ? 'border border-dashed border-fg/20' : 'bg-fg/10')} style={style} />;
  if (node.variant === 'command') {
    return (
      <div {...press} className={cn(className, 'flex cursor-pointer items-center rounded-[12px] border border-line bg-muted px-3.5 font-mono text-[12.5px] text-fg hover:border-line-strong')} style={style}>
        <span className="truncate">{node.text}</span>
      </div>
    );
  }
  const brief = node.variant === 'brief';
  return (
    <div
      {...press}
      className={cn(className, 'flex cursor-pointer flex-col rounded-[14px] px-4 py-3',
        brief ? 'border border-line bg-elevated/70 hover:border-line-strong' : 'bg-bubble hover:brightness-[0.985]')}
      style={style}
    >
      {(brief || node.variant === 'scheduled') && (
        <span className="mb-1 flex h-4 items-center gap-1.5 text-[11px] font-medium text-fg-3">
          {node.origin === 'handoff' ? <IconArrowRightLeft className="size-3" /> : brief ? <IconGitFork className="size-3" /> : <IconCalendarClock className="size-3" />}
          {node.origin === 'handoff' ? m.handoffSummary : brief ? m.forkBrief : node.origin === 'template' ? m.taskTemplate : m.scheduled}
        </span>
      )}
      <p className={cn('break-words text-[13px] leading-[19px]', brief ? 'text-fg-2' : 'text-fg')} style={clamp(node.lines)}>{node.text || '…'}</p>
      {(images.length > 0 || others > 0) && (
        <div className={cn('flex items-end gap-1.5 overflow-hidden', images.length ? 'mt-2 h-11' : 'mt-1 h-5')}>
          {images.slice(0, 6).map((image) => <AttachmentThumb key={image.id} id={image.id} />)}
          {others > 0 && <span className="flex h-5 shrink-0 items-center gap-1 text-[11px] text-fg-3"><IconPaperclip className="size-3" />{m.attachments(others)}</span>}
        </div>
      )}
      {steers.map((steer) => (
        <p key={steer.key} className="mt-2.5 border-l-2 border-accent/40 pl-2 text-[12px] leading-[17px] text-fg-2" style={clamp(4)}>{steer.text}</p>
      ))}
    </div>
  );
}

/**
 * The question not yet asked, in the next column of the spine: a bubble's shape with nothing in it,
 * and no fill, as nothing is said yet. Sent, the text stands here as a bubble with a spinner until
 * the conversation has the turn.
 */
export function NextPrompt({ node, pending, fresh, onOpen }: { node: FlowNext; pending: string | undefined; fresh: boolean; onOpen: () => void }) {
  const m = useMessages(catalogs);
  const style: CSSProperties = { left: node.x, top: node.y, width: node.w, minHeight: node.h };
  if (pending !== undefined) {
    return (
      <div key="pending" className={cn('absolute flex items-start gap-2 rounded-[14px] bg-bubble px-4 py-3', fresh && 'canvas-enter')} style={style}>
        <p className="min-w-0 flex-1 break-words text-[13px] leading-[19px] text-fg" style={clamp(Math.min(3, lineCount(pending, node.w - 32, 13)))}>{pending}</p>
        <Spinner className="mt-[3px] size-3 shrink-0 text-fg-3" />
      </div>
    );
  }
  return (
    <div
      key="slot"
      data-next
      role="button"
      tabIndex={0}
      aria-label={m.continueChat}
      className={cn('absolute flex cursor-pointer items-center gap-2 rounded-[14px] border border-line px-4 text-[13px] text-fg-3 outline-none transition-colors hover:border-line-strong focus-visible:border-line-strong focus-visible:ring-2 focus-visible:ring-focus', fresh && 'canvas-enter')}
      style={{ ...style, height: node.h }}
      onClick={onOpen}
      onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen(); } }}
    >
      <IconPlus className="size-3.5 shrink-0" />
      <span className="truncate">{m.continueChat}</span>
    </div>
  );
}

/** An image attached to a message; one that will not load is left out. */
function AttachmentThumb({ id }: { id: string }) {
  const { sessions } = usePluginHost();
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img src={sessions.attachmentUrl(id)} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} className="h-11 max-w-24 shrink-0 rounded-[6px] border border-line bg-muted object-cover" />;
}

/** A turn no one typed: a background task or subagent reported back, or the agent carried on alone. */
function Signal({ node, far, cutoff, press, className, style }: { node: Extract<FlowNode, { kind: 'signal' }>; far: boolean; cutoff: number; press: Press; className: string; style: CSSProperties }) {
  const m = useMessages(catalogs);
  const arrivals = (node.detail?.arrivals ?? []).filter((arrival) => arrival.at <= cutoff);
  return (
    <div {...press} className={cn(className, 'flex cursor-pointer flex-col justify-center rounded-[12px] border border-dashed px-3', far ? 'border-fg/20' : 'border-line-strong bg-[var(--canvas-paper)]/60 hover:bg-elevated/60')} style={style}>
      {!far && (arrivals.length ? arrivals.map((arrival) => (
        <span key={arrival.id} className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-2" style={{ height: ROW.signalRow }}>
          {arrival.status === 'failed' ? <IconCircleAlert className="size-3 shrink-0 text-danger" /> : arrival.status === 'running' ? <Spinner className="size-3 shrink-0" /> : <IconCircleCheck className="size-3 shrink-0 text-fg-3" />}
          <span className="min-w-0 truncate">{arrival.title}</span>
        </span>
      )) : <span className="text-[12px] text-fg-3" style={{ lineHeight: `${ROW.signalRow}px` }}>{m.autoContinue}</span>)}
    </div>
  );
}

/** What a turn did, as counts by kind of tool: the transcript's own icons, quiet. */
function Activity({ detail }: { detail: TurnDetail }) {
  const counts = new Map<string, number>();
  for (const step of detail.steps) if (step.kind === 'tool') counts.set(step.kindName ?? 'other', (counts.get(step.kindName ?? 'other') ?? 0) + 1);
  const subagents = detail.actors.filter((actor) => actor.kind === 'subagent').length;
  const background = detail.actors.length - subagents;
  return (
    <div className="flex h-[26px] items-end gap-3 text-[11px] tabular-nums text-fg-4">
      {[...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([kind, count]) => {
        return <span key={kind} className="flex items-center gap-1"><ToolIcon kind={kind} className="size-3" />{count}</span>;
      })}
      {subagents > 0 && <span className="flex items-center gap-1 text-fg-3"><IconSparkles className="size-3" />{subagents}</span>}
      {background > 0 && <span className="flex items-center gap-1 text-fg-3"><IconSquareTerminal className="size-3" />{background}</span>}
    </div>
  );
}

/** Lines changed in a turn, summed over its edits. */
function diffOf(detail: TurnDetail | undefined): { added: number; removed: number } | undefined {
  let added = 0, removed = 0;
  for (const step of detail?.steps ?? []) { added += step.added ?? 0; removed += step.removed ?? 0; }
  return added || removed ? { added, removed } : undefined;
}

/** A small line of the output rate: the turn's pulse while it writes. */
export function Sparkline({ series, className }: { series: number[]; className?: string }) {
  if (series.length < 2) return null;
  const max = Math.max(...series, 1);
  const points = series.map((value, index) => `${(index / (series.length - 1)) * 44},${12 - (value / max) * 11}`).join(' ');
  return (
    <svg viewBox="0 0 44 13" className={cn('h-[13px] w-11 overflow-visible', className)} aria-hidden>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={44} cy={12 - (series.at(-1)! / max) * 11} r={1.6} fill="currentColor" />
    </svg>
  );
}

function Answer({ node, far, cutoff, now, pulse, lit, press, className, style }: { node: Extract<FlowNode, { kind: 'agent' }>; far: boolean; cutoff: number; now: number; pulse: Pulse | undefined; lit: boolean; press: Press; className: string; style: CSSProperties }) {
  const m = useMessages(catalogs);
  const { backendLabel } = usePluginHost().sessions;
  const { detail, turn } = node;
  const replaying = cutoff < Infinity;
  const running = replaying ? cutoff < node.end : turn.status === 'running';
  const errored = !running && detail?.steps.some((step) => step.kind === 'status' && step.failed);
  const stopped = !running && !errored && (turn.status === 'failed' || turn.status === 'cancelled');
  const elapsed = Math.min(replaying ? cutoff : now, node.end) - node.t;
  const answer = detail?.answer && !(replaying && running) ? plainText(detail.answer) : '';
  // Compact, a finished answer's one-sentence summary stands in for its preview.
  const summary = node.summary && !running ? node.summary : '';
  const diff = diffOf(detail);
  // The sweep along the top quickens with the output rate.
  const sweep = pulse ? Math.min(2.6, Math.max(0.6, 2.6 - pulse.rate / 50)) : 1.8;
  return (
    <div
      {...press}
      className={cn(className, answerCard, !far && answerHover, 'flex cursor-pointer flex-col overflow-hidden',
        far && 'border-transparent bg-fg/[0.07] shadow-none',
        !far && errored && 'border-danger/40', !far && stopped && 'border-dashed border-line-strong shadow-none',
        lit && !far && 'border-line-strong')}
      style={{ ...style, padding: far ? 0 : `${ROW.agentPad}px` }}
    >
      {running && !far && <span aria-hidden className="canvas-shimmer absolute inset-x-5 top-0 h-[1.5px] rounded-full" style={{ animationDuration: `${sweep}s` }} />}
      {!far && (
        <>
          <div className="flex shrink-0 items-center gap-2 text-[11px] font-medium tabular-nums text-fg-3" style={{ height: ROW.meta }}>
            <IconSparkle className="size-3 text-fg-3" />
            <span className="text-fg-2">{backendLabel(node.session)}</span>
            {elapsed > 0 && <span className="text-fg-4">{formatDuration(elapsed)}</span>}
            {errored && <span className="text-danger">{m.turnError}</span>}
            {stopped && <span className="text-fg-3">{m.interrupted}</span>}
            <span className="ml-auto flex items-center gap-2">
              {diff && !running && <span className="font-mono text-[10.5px] font-normal"><span className="text-success">+{diff.added}</span> <span className="text-danger/80">−{diff.removed}</span></span>}
              {running && (
                <span className="flex items-center gap-1.5 text-accent">
                  {pulse && <><Sparkline series={pulse.series} /><span className="w-12 text-right text-[10.5px]">{Math.round(pulse.rate)} t/s</span></>}
                  {!pulse && <span className="size-1.5 rounded-full bg-accent animate-pulse-dot" />}
                </span>
              )}
            </span>
          </div>
          {node.blocks ? (
            <div key="detail" className="canvas-fade mt-1.5 flex flex-col" style={{ gap: ROW.blockGap }}>
              {node.blocks.length ? node.blocks.map((block) => <BlockView key={block.key} block={block} cutoff={cutoff} />) : <p className="text-[13px] leading-[19px] text-fg-4">{running ? m.running : m.noBody}</p>}
            </div>
          ) : (
            <div key="summary" className="canvas-fade mt-1.5 flex min-h-0 flex-1 flex-col">
              <p className={cn('text-[13px] leading-[19px]', summary ? 'font-medium text-fg' : answer ? 'text-fg' : 'text-fg-4')} style={clamp(node.previewLines)}>
                {summary || answer || (running ? m.running : !detail ? '' : m.noBody)}
              </p>
              {detail && (detail.tools > 0 || detail.actors.length > 0) && <div className="mt-auto"><Activity detail={detail} /></div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One block of an opened answer. Heights come from the layout, so edges meet the rows they start at. */
export function BlockView({ block, cutoff }: { block: Block; cutoff: number }) {
  const m = useMessages(catalogs);
  switch (block.kind) {
    case 'thought':
      return <p className="flex gap-1.5 text-[12px] italic leading-[18px] text-fg-3" style={{ height: block.h }}><IconBrain className="mt-[3px] size-3 shrink-0 not-italic text-fg-4" /><span style={clamp(2)}>{block.text}</span></p>;
    case 'commentary':
      return <p className="text-[12.5px] leading-[18px] text-fg-2" style={{ height: block.h, ...clamp(2) }}>{block.text}</p>;
    case 'plan': {
      const entries = block.step.entries ?? [];
      return (
        <div className="-mx-1.5 flex flex-col rounded-lg border border-line-soft px-2 py-1" style={{ height: block.h }}>
          <span className="flex h-[20px] items-center gap-1.5 text-[11px] font-medium text-fg-3"><IconListChecks className="size-3" />{m.plan}</span>
          {entries.slice(0, entries.length - block.hidden).map((entry, index) => (
            <span key={index} className="flex min-w-0 items-center gap-2 text-[12px]" style={{ height: ROW.planRow }}>
              {entry.status === 'completed' ? <IconCheck className="size-3 shrink-0 text-fg-4" /> : entry.status === 'in_progress' ? <span className="mx-[3px] size-1.5 shrink-0 rounded-full bg-accent" /> : <IconCircle className="size-3 shrink-0 text-fg-4" />}
              <span className={cn('min-w-0 truncate', entry.status === 'completed' ? 'text-fg-4 line-through decoration-fg-4/50' : 'text-fg-2')}>{entry.text}</span>
            </span>
          ))}
          {block.hidden > 0 && <span className="pl-5 text-[11px] text-fg-4" style={{ lineHeight: `${ROW.planRow}px` }}>+{block.hidden}</span>}
        </div>
      );
    }
    case 'actor': {
      const Icon = block.step.kind === 'subagent' ? IconSparkles : IconSquareTerminal;
      return (
        <div className="-mx-1.5 flex items-center gap-2 rounded-lg border border-line-soft px-1.5 text-[12px] text-fg-2" style={{ height: block.h }}>
          <Icon className="size-3 shrink-0 text-fg-3" />
          <span className="min-w-0 flex-1 truncate">{block.step.label}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-fg-4">{formatDuration(block.step.end - block.step.start)}</span>
        </div>
      );
    }
    case 'calls': {
      const counts = new Map<string, number>();
      for (const step of block.steps) counts.set(step.toolName ?? step.kindName ?? 'other', (counts.get(step.toolName ?? step.kindName ?? 'other') ?? 0) + 1);
      const kinds = new Map(block.steps.map((step) => [step.toolName ?? step.kindName ?? 'other', step.kindName ?? 'other']));
      const failed = block.steps.some((step) => step.failed);
      return (
        <div className="flex items-center gap-3 text-[11px] tabular-nums text-fg-4" style={{ height: block.h }}>
          {[...counts].map(([name, count]) => {
            return <span key={name} className="flex items-center gap-1"><ToolIcon kind={kinds.get(name) ?? ''} className="size-3" />{name}{count > 1 && <span className="text-fg-4/80">×{count}</span>}</span>;
          })}
          {failed && <IconCircleAlert className="size-3 text-danger" />}
        </div>
      );
    }
    case 'compaction':
      return (
        <div className="flex items-center gap-2 text-[10.5px] text-fg-4" style={{ height: block.h }}>
          <span className="h-px flex-1 bg-line" />
          <span className="shrink-0">{m.compaction}{block.step.label ? ` ${block.step.label}` : ''}</span>
          <span className="h-px flex-1 bg-line" />
        </div>
      );
    case 'status':
      return <p className="truncate text-[12px] leading-[22px] text-danger" style={{ height: block.h }}>{block.step.label}</p>;
    case 'answer':
      return <p className="whitespace-pre-line border-t border-line-soft pt-2 text-[13px] leading-[19px] text-fg" style={{ height: block.h, ...clamp(block.lines) }}>{block.text}</p>;
  }
}

/**
 * A subagent or background task on the row's clock: its name above, then the bar from when it began
 * to when it ended — solid for a subagent, dashed for a background task, the accent while it runs —
 * with its own calls ticked along it, and a dotted run on to the turn it reported in.
 */
function ActorBar({ node, far, cutoff, marked, onMark, press, className, style }: { node: Extract<FlowNode, { kind: 'actor' }>; far: boolean; cutoff: number; marked: number | undefined; onMark: (index: number | undefined) => void; press: Press; className: string; style: CSSProperties }) {
  const m = useMessages(catalogs);
  const { actor, bar, report, marks, steps } = node;
  const running = cutoff < Infinity ? cutoff < node.end : actor.running;
  const subagent = actor.kind === 'subagent';
  const Icon = subagent ? IconSparkles : IconSquareTerminal;
  const y = BAR.pad + BAR.label + BAR.bar / 2;
  const tone = running ? 'var(--accent)' : actor.failed ? 'var(--danger)' : 'var(--fg)';
  const onPoint = useMarkPointer(marks, node.w, (_, yy) => yy >= BAR.pad + BAR.label - 2 && yy <= BAR.pad + BAR.label + BAR.bar + 2, onMark);
  let ticks = '', failed = '';
  for (const mark of marks) {
    if (mark.index === marked || steps[mark.index]!.start > cutoff) continue;
    const path = `M ${mark.x} ${y - 5} V ${y + 5} `;
    if (steps[mark.index]!.failed) failed += path; else ticks += path;
  }
  return (
    <div {...press} {...(far ? {} : onPoint(press))} className={cn(className, 'cursor-pointer')} style={style}>
      <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={node.w} height={node.h} aria-hidden>
        {report !== undefined && !running && <path d={`M ${bar + 5} ${y} H ${report}`} stroke="var(--fg)" strokeOpacity={0.3} strokeWidth={1.2} strokeDasharray="1 4" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
        {report !== undefined && !running && <circle cx={report} cy={y} r={3} fill="var(--bg-elevated)" stroke="var(--fg)" strokeOpacity={0.45} strokeWidth={1.2} />}
        {subagent
          ? <path d={`M ${3} ${y} H ${Math.max(3.01, bar - 3)}`} stroke={tone} strokeOpacity={running ? 0.55 : actor.failed ? 0.6 : 0.2} strokeWidth={6} strokeLinecap="round" className={running ? 'animate-pulse' : undefined} />
          : <path d={`M 0 ${y} H ${bar}`} stroke={tone} strokeOpacity={running ? 0.7 : actor.failed ? 0.7 : 0.4} strokeWidth={2} strokeDasharray="5 3" className={running ? 'animate-pulse' : undefined} />}
        {!subagent && <path d={`M 0 ${y - 4} V ${y + 4} M ${bar} ${y - 4} V ${y + 4}`} stroke={tone} strokeOpacity={0.4} strokeWidth={1.2} />}
        {ticks && <path d={ticks} stroke="var(--fg)" strokeOpacity={0.55} strokeWidth={1.2} />}
        {failed && <path d={failed} stroke="var(--danger)" strokeOpacity={0.85} strokeWidth={1.2} />}
        {marked !== undefined && marks[marked] && <path d={`M ${marks[marked]!.x} ${y - 7} V ${y + 7}`} stroke="var(--fg)" strokeWidth={2} />}
      </svg>
      {!far && (
        <>
          <div className="absolute left-0 flex max-w-full items-center gap-1.5 whitespace-nowrap text-[11.5px]" style={{ top: BAR.pad, height: BAR.label }}>
            <Icon className={cn('size-3 shrink-0', running ? 'text-accent' : actor.failed ? 'text-danger' : 'text-fg-4')} />
            <span className={cn('min-w-0 truncate', subagent ? 'font-medium text-fg-2' : 'font-mono text-[11px] text-fg-2')}>{subagent ? actor.label : actor.note ?? actor.label}</span>
            {subagent && actor.note && <span className="shrink-0 font-mono text-[10.5px] text-fg-4">{actor.note}</span>}
            {(running || node.end - actor.start >= 1000) && <span className="shrink-0 tabular-nums text-[10.5px] text-fg-4">{running ? m.running : formatDuration(node.end - actor.start)}</span>}
          </div>
          {node.conclusion && <p className="canvas-fade absolute left-0 truncate text-[11px] text-fg-3" style={{ top: BAR.pad + BAR.label + BAR.bar, height: BAR.line, lineHeight: `${BAR.line}px`, width: node.w }}>{node.conclusion}</p>}
        </>
      )}
    </div>
  );
}

/** A `/compact` turn's pin on the spine: the context's size before and after. */
function FoldPin({ node, far, press, className, style }: { node: Extract<FlowNode, { kind: 'fold' }>; far: boolean; press: Press; className: string; style: CSSProperties }) {
  const m = useMessages(catalogs);
  if (far) return <div {...press} className={cn(className, 'rounded-full bg-fg/[0.05]')} style={style} />;
  return (
    <div {...press} className={cn(className, 'flex cursor-pointer items-center justify-center')} style={style}>
      <span className="flex h-full items-center gap-1.5 whitespace-nowrap rounded-full border border-dashed border-line-strong bg-[var(--canvas-paper)] px-2.5 text-[11px] text-fg-3 hover:text-fg-2">
        <IconArrowsInLineHorizontal className="size-3.5 text-fg-4" />
        {m.compaction}
        {node.tokens && <span className="font-mono text-[10.5px] tabular-nums text-fg-4">{node.tokens}</span>}
      </span>
    </div>
  );
}

/**
 * Which mark of a strip or bar the pointer is on, as it moves: the nearest within a few screen
 * pixels, where [inRow] says the pointer is at the marks' height; [extra] picks anything else (a name).
 */
export function useMarkPointer(marks: readonly Mark[], width: number, inRow: (x: number, y: number) => boolean, onMark: (index: number | undefined) => void, extra?: (x: number, y: number) => number | undefined) {
  const last = useRef<number | undefined>(undefined);
  return (press: Press) => ({
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const scale = rect.width / width;
      const x = (event.clientX - rect.left) / scale, y = (event.clientY - rect.top) / scale;
      let hit = extra?.(x, y);
      if (hit === undefined && inRow(x, y)) {
        let best = Math.max(5, 6 / scale);
        for (const mark of marks) {
          const distance = x < mark.x ? mark.x - x : x > mark.x2 ? x - mark.x2 : 0;
          if (distance <= best) { best = distance; hit = mark.index; }
        }
      }
      if (hit !== last.current) { last.current = hit; onMark(hit); }
    },
    onPointerLeave: (event: React.PointerEvent) => {
      last.current = undefined;
      onMark(undefined);
      (press.onPointerLeave as (event: React.PointerEvent) => void)(event);
    },
  });
}

const DIFF_LINE = { add: 'bg-[var(--diff-add)] text-fg', del: 'bg-[var(--diff-del)] text-fg', same: 'text-fg-3' } as const;
/** A shade of the paper under a ledger, so it hides the track's line behind its text. */
const GROUND = 'color-mix(in oklab, var(--canvas-paper), var(--fg) 1.8%)';

/**
 * What an answer wrote under one directory, printed on its track: a rule down the left split green
 * and red by what was added and removed, a head with the counts, the files with theirs, and, opened,
 * each file's first changed lines. A write the shell made has no counts, so its rule is grey.
 */
function Ledger({ node, far, focusPath, onFile, press, className, style }: { node: Extract<FlowNode, { kind: 'change' }>; far: boolean; focusPath: string | undefined; onFile: (path: string | undefined) => void; press: Press; className: string; style: CSSProperties }) {
  const m = useMessages(catalogs);
  const { changes, shown } = node;
  const added = changes.reduce((sum, change) => sum + change.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.removed, 0);
  const hidden = changes.length - shown;
  const counted = changes.some((change) => change.edits.length > 0) && added + removed > 0;
  const share = Math.round((added / Math.max(1, added + removed)) * 100);
  const rule = <span aria-hidden className="absolute bottom-[3px] left-0 top-[3px] w-0.5 rounded-[1px] opacity-75" style={{ background: counted ? `linear-gradient(var(--diff-add-marker) ${share}%, var(--diff-del-marker) ${share}%)` : 'var(--fg-4)' }} />;
  const ground = { ...style, background: GROUND };
  if (far) {
    return (
      <div {...press} className={cn(className, 'cursor-pointer rounded-[6px]')} style={ground}>
        {rule}
        <span className="absolute left-3.5 top-[9px] h-1.5 w-2/5 rounded-full bg-fg/10" />
      </div>
    );
  }
  return (
    <div {...press} className={cn(className, 'flex cursor-pointer flex-col rounded-[6px]')} style={{ ...ground, padding: '0 6px 0 14px' }}>
      {rule}
      <div className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-fg-3" style={{ height: CHANGE.head }}>
        <span>{changes.length === 1 ? m.oneFile : m.files(changes.length)}</span>
        {changes.some((change) => change.edits.length > 0) && (
          <span className="ml-auto font-mono text-[10.5px]"><span className="text-[var(--diff-add-marker)]">+{added}</span> <span className="text-[var(--diff-del-marker)]">−{removed}</span></span>
        )}
      </div>
      {changes.slice(0, shown).map((change, index) => (
        <FileRows key={change.path} change={change} base={node.base} lines={node.lines[index] ?? 0} focused={change.path === focusPath} onFile={onFile} />
      ))}
      {hidden > 0 && <span className="pl-5 text-[11px] text-fg-4" style={{ lineHeight: `${CHANGE.file}px` }}>{m.moreFiles(hidden)}</span>}
    </div>
  );
}

function FileRows({ change, base, lines, focused, onFile }: { change: FileChange; base: string; lines: number; focused: boolean; onFile: (path: string | undefined) => void }) {
  const m = useMessages(catalogs);
  // Inside the track's directory, so only the part below it.
  const path = base && change.path.startsWith(`${base}/`) ? change.path.slice(base.length + 1) : change.path;
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1), dir = slash > 0 ? path.slice(0, slash + 1) : '';
  return (
    <div onPointerEnter={() => onFile(change.path)} onPointerLeave={() => onFile(undefined)}>
      <div className={cn('-mx-1.5 flex min-w-0 items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-hover', focused && 'bg-hover')} style={{ height: CHANGE.file }} title={change.path}>
        <span className={cn('w-2.5 shrink-0 text-center font-mono text-[11px] leading-none', change.created ? 'text-[var(--diff-add-marker)]' : change.deleted ? 'text-[var(--diff-del-marker)]' : 'text-fg-4')}>
          {change.created ? '+' : change.deleted ? '−' : '·'}
        </span>
        <span className={cn('shrink-0 font-mono text-[11.5px] text-fg-2', change.deleted && 'line-through decoration-fg-4')}>{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-fg-4" dir="rtl">{dir && <bdi>{dir}</bdi>}</span>
        {change.edits.length
          ? <span className="shrink-0 font-mono text-[10.5px] tabular-nums"><span className="text-[var(--diff-add-marker)]">+{change.added}</span> <span className="text-[var(--diff-del-marker)]">−{change.removed}</span></span>
          : <span className="shrink-0 text-[10.5px] text-fg-4">{m.byCommand}</span>}
      </div>
      {lines > 0 && (
        <div className="canvas-fade -mx-1 overflow-hidden rounded-md bg-muted font-mono text-[10.5px]" style={{ padding: `${CHANGE.inset}px 0`, marginBottom: CHANGE.gap }}>
          {change.preview.slice(0, lines).map((line, index) => line.type === 'gap'
            ? <div key={index} className="mx-2 border-t border-dashed border-line" style={{ height: CHANGE.line / 2, marginTop: CHANGE.line / 2 }} />
            : (
              <div key={index} className={cn('flex min-w-0', DIFF_LINE[line.type])} style={{ height: CHANGE.line, lineHeight: `${CHANGE.line}px` }}>
                <span className={cn('w-4 shrink-0 select-none text-center', line.type === 'add' ? 'text-[var(--diff-add-marker)]' : line.type === 'del' ? 'text-[var(--diff-del-marker)]' : 'text-fg-4')}>{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''}</span>
                <span className="min-w-0 truncate whitespace-pre pr-2">{line.text || ' '}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/** An image of an artifact: a photo in its own frame, cropped from the top left; one click opens it large. A file that is gone leaves the track. */
export function ArtifactImage({ item, className, style, onView, onBroken }: { item: Artifact; className?: string; style?: CSSProperties; onView: (item: Artifact) => void; onBroken: (key: string) => void }) {
  // The file may be written a moment after the call that named it: a failure is tried once more before the image is given up.
  const [retried, setRetried] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const failed = () => {
    if (retried) { onBroken(item.key); return; }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setRetried(true), 1500);
  };
  return (
    <img
      src={retried ? `${item.src}&retry=1` : item.src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      style={style}
      onError={failed}
      onClick={(event) => { event.stopPropagation(); onView(item); }}
      onDoubleClick={(event) => event.stopPropagation()}
      className={cn('block cursor-zoom-in rounded-[7px] border border-line-strong bg-muted object-cover object-left-top', className)}
    />
  );
}

/**
 * What a turn showed or made, side by side on the track and not carded: an image is a photo with
 * its file name beneath, a page a window outline (there is nothing to preview), and what does not
 * fit across the column a dashed count.
 */
function Shelf({ node, far, onView, onBroken, press, className, style }: { node: Extract<FlowNode, { kind: 'artifacts' }>; far: boolean; onView: (item: Artifact) => void; onBroken: (key: string) => void; press: Press; className: string; style: CSSProperties }) {
  const { items, shown } = node;
  const more = items.length - shown;
  const at = (index: number) => index * (ART.w + ART.gap);
  return (
    <div {...press} className={cn(className, 'cursor-pointer')} style={style}>
      {items.slice(0, shown).map((item, index) => far
        ? <span key={item.key} className="absolute top-0 rounded-[7px] bg-fg/[0.07]" style={{ left: at(index), width: ART.w, height: ART.h }} />
        : (
          <figure key={item.key} className="absolute top-0 m-0" style={{ left: at(index), width: ART.w }} title={item.path ?? item.name}>
            {item.kind === 'image'
              ? <ArtifactImage item={item} className="w-full" style={{ height: ART.h }} onView={onView} onBroken={onBroken} />
              : (
                <div className="flex flex-col overflow-hidden rounded-[7px] border border-line-strong bg-subtle" style={{ height: ART.h }}>
                  <div className="flex h-4 shrink-0 items-center gap-[3px] border-b border-line bg-muted px-1.5">
                    {[0, 1, 2].map((dot) => <span key={dot} className="size-[5px] rounded-full bg-fg-4/60" />)}
                  </div>
                  <div className="grid flex-1 place-items-center text-fg-4"><IconGlobe className="size-3.5" /></div>
                </div>
              )}
            <figcaption className="mt-[5px] truncate font-mono text-[10.5px] leading-4 text-fg-3">{item.name}</figcaption>
          </figure>
        ))}
      {more > 0 && (
        <span className={cn('absolute top-0 grid place-items-center rounded-[7px]', far ? 'bg-fg/[0.07]' : 'border border-dashed border-line-strong text-xs tabular-nums text-fg-3 hover:text-fg')} style={{ left: at(shown), width: ART.w, height: ART.h }}>
          {!far && `+${more}`}
        </span>
      )}
    </div>
  );
}

/** An image at full size over the plane; a click or Escape puts it away. */
export function Lightbox({ item, onClose }: { item: Artifact; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div data-canvas-scroll role="dialog" aria-label={item.name} className="canvas-fade absolute inset-0 z-30 flex cursor-zoom-out flex-col items-center justify-center gap-2 bg-black/70 p-8" onClick={onClose}>
      <img src={item.src} alt="" className="min-h-0 max-w-full rounded-[7px] object-contain" />
      <span className="font-mono text-[11px] text-white/80">{item.name}</span>
    </div>
  );
}

/**
 * One turn's calls of one kind, drawn on the track rather than carded: each call a mark where it
 * ran on the turn's clock — a command a stroke as long as it took, a read a tick, a search a ring, a
 * lookup a diamond, a question a pin, any other tool a square — and the few worth naming beneath,
 * each on a leader from its mark. What a call printed is a hover away; the inspector has every call.
 */
function Strip({ node, far, cutoff, marked, onMark, press, className, style }: { node: Extract<FlowNode, { kind: 'tools' }>; far: boolean; cutoff: number; marked: number | undefined; onMark: (index: number | undefined) => void; press: Press; className: string; style: CSSProperties }) {
  const { steps, marks, callouts, track, w } = node;
  const mid = STRIP.pad + STRIP.marks / 2;
  const below = STRIP.pad + STRIP.marks + 2;
  const shown = (index: number) => steps[index]!.start <= cutoff;
  const running = (step: Step) => cutoff < Infinity ? cutoff < step.end : step.running;
  // Every mark of one look is one path, so a strip of two hundred reads is a handful of elements.
  const ink = { plain: '', failed: '', live: '' };
  for (const mark of marks) {
    if (!shown(mark.index) || mark.index === marked) continue;
    const step = steps[mark.index]!;
    ink[running(step) ? 'live' : step.failed ? 'failed' : 'plain'] += glyph(track, step, mark, mid);
  }
  const visible = marks.filter((mark) => shown(mark.index));
  const onPoint = useMarkPointer(visible, w, (_, y) => y < below, onMark, (x, y) => {
    if (y < below) return undefined;
    const row = Math.floor((y - below) / STRIP.callout);
    return callouts.find((callout) => callout.row === row && shown(callout.index) && (callout.side === 'right' ? x >= callout.x - 4 && x <= callout.x + 6 + callout.w : x >= callout.x - 6 - callout.w && x <= callout.x + 4))?.index;
  });
  const focus = marked !== undefined ? marks[marked] : undefined;
  const focusStep = marked !== undefined ? steps[marked] : undefined;
  const look = (kind: keyof typeof ink) => STROKE[track === 'shell' ? 'shell' : track === 'explore' ? 'explore' : 'mark'][kind];
  return (
    <div {...press} {...(far ? {} : onPoint(press))} className={cn(className, 'cursor-pointer')} style={style}>
      <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={w} height={node.h} aria-hidden>
        {/* The turn's own stretch of the track: darker than the line between turns, with its ends marked. */}
        <path d={`M ${STRIP.inset} ${mid} H ${w - STRIP.inset} M ${STRIP.inset} ${mid - 4} V ${mid + 4} M ${w - STRIP.inset} ${mid - 4} V ${mid + 4}`} stroke="var(--fg)" strokeOpacity={0.16} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {!far && callouts.filter((callout) => shown(callout.index)).map((callout) => {
          const y = below + callout.row * STRIP.callout + STRIP.callout / 2;
          const elbow = callout.side === 'right' ? 4 : -4;
          return <path key={callout.index} d={`M ${callout.x} ${mid + 5} V ${y} h ${elbow}`} fill="none" stroke="var(--fg)" strokeOpacity={callout.index === marked ? 0.5 : 0.18} strokeWidth={1} vectorEffect="non-scaling-stroke" />;
        })}
        {(['plain', 'failed', 'live'] as const).map((kind) => ink[kind] && <path key={kind} d={ink[kind]} {...look(kind)} className={kind === 'live' ? 'animate-pulse' : undefined} />)}
        {focus && focusStep && <path d={glyph(track, focusStep, focus, mid)} {...look(running(focusStep) ? 'live' : focusStep.failed ? 'failed' : 'plain')} strokeOpacity={1} fillOpacity={1} {...(track === 'shell' ? { strokeWidth: 7 } : {})} />}
      </svg>
      {!far && callouts.filter((callout) => shown(callout.index)).map((callout) => {
        const step = steps[callout.index]!;
        const label = callLabel(step, track);
        const flexible = track === 'other' || track === 'ask';
        return (
          <div
            key={callout.index}
            className={cn('absolute flex items-baseline gap-2 whitespace-nowrap text-[11px] transition-opacity', callout.side === 'left' && 'justify-end', marked !== undefined && marked !== callout.index && 'opacity-50')}
            style={{ left: callout.side === 'right' ? callout.x + 6 : callout.x - 6 - callout.w, top: below + callout.row * STRIP.callout, width: callout.w, height: STRIP.callout, lineHeight: `${STRIP.callout}px` }}
          >
            <span className={cn(flexible ? 'shrink-0 max-w-[60%]' : 'min-w-0', 'truncate', label.mono && 'font-mono text-[10.5px]', step.failed ? 'text-danger' : track === 'other' ? 'font-medium text-fg-2' : 'text-fg-2')}>{label.text}</span>
            {label.aside && <span className={cn(flexible ? 'min-w-0 truncate' : 'shrink-0', 'text-[10.5px] tabular-nums text-fg-4')}>{label.aside}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** How each look is inked: a command's stroke, an exploration's ticks and rings, any other call's solid mark. */
const STROKE = {
  shell: {
    plain: { fill: 'none', stroke: 'var(--fg)', strokeOpacity: 0.5, strokeWidth: 5, strokeLinecap: 'round' },
    failed: { fill: 'none', stroke: 'var(--danger)', strokeOpacity: 0.85, strokeWidth: 5, strokeLinecap: 'round' },
    live: { fill: 'none', stroke: 'var(--accent)', strokeOpacity: 0.9, strokeWidth: 5, strokeLinecap: 'round' },
  },
  explore: {
    plain: { fill: 'var(--bg-elevated)', fillOpacity: 1, stroke: 'var(--fg)', strokeOpacity: 0.4, strokeWidth: 1.4 },
    failed: { fill: 'var(--bg-elevated)', fillOpacity: 1, stroke: 'var(--danger)', strokeOpacity: 0.85, strokeWidth: 1.4 },
    live: { fill: 'var(--bg-elevated)', fillOpacity: 1, stroke: 'var(--accent)', strokeOpacity: 0.9, strokeWidth: 1.4 },
  },
  mark: {
    plain: { fill: 'var(--fg)', fillOpacity: 0.5, stroke: 'none' },
    failed: { fill: 'var(--danger)', fillOpacity: 0.85, stroke: 'none' },
    live: { fill: 'var(--accent)', fillOpacity: 0.9, stroke: 'none' },
  },
} as const;

/** One call's mark as path data, centred on the strip's line at [mid]. */
function glyph(track: Track, step: Step, mark: Mark, mid: number): string {
  const x = mark.x;
  switch (track) {
    case 'shell': return `M ${x} ${mid} H ${Math.max(mark.x2, x + 0.01)} `;
    case 'explore': return step.kindName === 'read' ? `M ${x} ${mid - 6} V ${mid + 6} ` : `M ${x - 3.5} ${mid} a 3.5 3.5 0 1 0 7 0 a 3.5 3.5 0 1 0 -7 0 `;
    case 'web': return `M ${x} ${mid - 4.5} l 4.5 4.5 l -4.5 4.5 l -4.5 -4.5 Z `;
    case 'ask': return `M ${x - 0.6} ${mid - 9} h 1.2 v 6 h -1.2 Z M ${x - 4} ${mid + 1} a 4 4 0 1 0 8 0 a 4 4 0 1 0 -8 0 `;
    case 'other': return `M ${x - 3} ${mid - 3} h 6 v 6 h -6 Z `;
  }
}

/** A turn's text as the reader would copy it. */
export function copyText(node: FlowNode): string {
  switch (node.kind) {
    case 'user': return node.text;
    case 'agent': return node.detail?.answer ?? '';
    case 'actor': return node.actor.note ?? node.actor.label;
    case 'fold': return '';
    case 'signal': return (node.detail?.arrivals ?? []).map((arrival) => arrival.title).join('\n');
    case 'header': return node.session.title;
    case 'change': return node.changes.map((change) => change.path).join('\n');
    case 'artifacts': return node.items.map((item) => item.path ?? item.name).join('\n');
    case 'tools': return node.steps.map((step) => step.arg ?? step.title ?? step.label).join('\n');
  }
}

