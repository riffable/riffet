import { useEffect, useRef } from 'react';
import type { SyncLane } from '@contracts';
import { Button, DiffView, Markdown, Spinner, Tip, useMessages } from '@riffet/plugin-web';
import { cn } from './cn';
import { ArtifactImage } from './cards';
import { formatDuration, type Artifact, type Step, type TurnDetail } from './detail';
import type { FlowNode } from './flow';
import { IconChevronDown, IconGitFork, IconGlobe, IconSparkles, IconSquareArrowOutUpRight, IconSquareTerminal, IconX } from './icons';
import { catalogs } from './messages';

/*
 * What a node holds, beside the canvas: the canvas shows how a conversation is shaped, this panel
 * what was said and done at one place in it.
 */

/** A subagent lane's detail by lane id: `undefined` while closed, `null` while loading. */
export type LaneLookup = (lane: string) => TurnDetail | null | undefined;

export function Inspector({ node, detail, lanes, onToggleLane, onOpen, forking, onFork, onOpenPath, onView, onBroken, focus, onClose }: {
  node: FlowNode;
  /** The turn's detail, for a question or an answer. */
  detail?: TurnDetail | undefined;
  lanes: LaneLookup;
  onToggleLane: (lane: SyncLane) => void;
  onOpen: () => void;
  /** The fork this answer started is still being made. */
  forking?: boolean;
  onFork?: () => void;
  onOpenPath?: (path: string) => void;
  onView: (item: Artifact) => void;
  onBroken: (key: string) => void;
  /** The call to bring into view, for a strip opened at one of its calls. */
  focus?: string;
  onClose: () => void;
}) {
  const m = useMessages(catalogs);
  const focused = useRef<HTMLElement>(null);
  useEffect(() => { focused.current?.scrollIntoView({ block: 'center' }); }, [focus]);
  const actorLane = node.kind === 'actor' ? node.actor.lane : undefined;
  const actorDetail = actorLane ? lanes(actorLane) : undefined;
  return (
    <aside data-canvas-scroll className="absolute bottom-3 right-3 top-3 flex w-[400px] max-w-[calc(100%-24px)] cursor-auto select-text flex-col overflow-hidden rounded-xl border border-line bg-elevated shadow-soft">
      <div className="flex h-11 shrink-0 items-center gap-1 edge-b pl-4 pr-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
          {node.kind === 'user' ? m.prompt : node.kind === 'agent' ? m.answer : node.kind === 'change' ? m.outputs : node.kind === 'artifacts' ? m.artifacts : node.kind === 'tools' ? m.calls(node.steps.length) : node.kind === 'actor' ? node.actor.label : node.session.title}
        </span>
        {node.kind !== 'actor' && <Tip label={m.openInChat}><Button size="icon-sm" variant="quiet" aria-label={m.openInChat} onClick={onOpen}><IconSquareArrowOutUpRight className="size-3.5" /></Button></Tip>}
        {onFork && <Tip label={m.forkFromHere}><Button size="icon-sm" variant="quiet" aria-label={m.forkFromHere} disabled={forking === true} onClick={onFork}>{forking ? <Spinner className="size-3.5" /> : <IconGitFork className="size-3.5" />}</Button></Tip>}
        <Button size="icon-sm" variant="quiet" aria-label={m.close} onClick={onClose}><IconX className="size-3.5" /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {node.kind === 'user' && (
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-fg">{node.text}</p>
        )}
        {node.kind === 'agent' && (
          <>
            <Facts items={[formatDuration(node.end - node.t), detail?.tools ? m.toolCalls(detail.tools) : '', detail?.actors.length ? m.subtasks(detail.actors.length) : '']} />
            {node.summary && <p className="mb-3 text-sm font-medium leading-6 text-fg">{node.summary}</p>}
            {detail?.answer ? <Markdown text={detail.answer} className="text-sm" /> : <p className="text-sm text-fg-4">{node.turn.status === 'running' ? m.running : m.noBody}</p>}
            {detail && detail.steps.length > 0 && <Steps steps={detail.steps} lanes={lanes} onToggleLane={onToggleLane} />}
          </>
        )}
        {node.kind === 'change' && (
          <div className="flex flex-col gap-3">
            {node.changes.flatMap((change) => change.edits.map((edit, index) => (
              <DiffView key={`${change.path}|${index}`} path={change.path} before={edit.before} after={edit.after} remember={`canvas:${node.id}:${change.path}:${index}`} {...(onOpenPath ? { onOpenPath } : {})} />
            )))}
            {node.changes.filter((change) => change.commands.length > 0).map((change) => (
              <section key={`${change.path}|commands`} className="flex flex-col gap-1.5">
                <p className="flex min-w-0 items-baseline gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate font-mono text-fg-2" title={change.path}>{change.path}</span>
                  <span className="shrink-0 text-fg-4">{m.byCommand}</span>
                </p>
                {change.commands.map((command, index) => <pre key={index} className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted px-3 py-2 font-mono text-xs text-fg-2">{command}</pre>)}
              </section>
            ))}
          </div>
        )}
        {node.kind === 'artifacts' && (
          <div className="flex flex-col gap-4">
            {node.items.map((item) => (
              <figure key={item.key} className="m-0 flex flex-col gap-1.5">
                {item.kind === 'image'
                  ? <ArtifactImage item={item} className="max-h-64 w-full" onView={onView} onBroken={onBroken} />
                  : (
                    <button type="button" className="flex h-16 items-center justify-center gap-2 rounded-[7px] border border-line-strong bg-subtle text-fg-4 hover:bg-hover" onClick={() => item.path && onOpenPath?.(item.path)}>
                      <IconGlobe className="size-4" />
                    </button>
                  )}
                <figcaption className="truncate font-mono text-[11px] text-fg-3" title={item.path ?? item.name}>{item.path ?? item.name}</figcaption>
              </figure>
            ))}
          </div>
        )}
        {node.kind === 'tools' && (
          <div className="flex flex-col gap-4">
            {node.steps.map((step) => (
              <section key={step.key} ref={step.key === focus ? focused : undefined} className={cn('flex flex-col gap-1.5', step.key === focus && '-mx-2 rounded-lg bg-accent-soft/50 px-2 py-1.5')}>
                <p className="flex min-w-0 items-baseline gap-2 text-xs">
                  <span className={cn('shrink-0 font-medium', step.failed ? 'text-danger' : 'text-fg-2')}>{step.toolName ?? step.kindName}</span>
                  <span className="min-w-0 flex-1 truncate text-fg-3">{step.title !== step.arg ? step.title : ''}</span>
                  <span className="shrink-0 tabular-nums text-fg-4">{formatDuration(step.end - step.start)}</span>
                </p>
                {step.arg && <pre className="whitespace-pre-wrap break-all rounded-lg bg-muted px-3 py-2 font-mono text-xs text-fg-2">{step.arg}</pre>}
                {step.output && <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line-soft px-3 py-2 font-mono text-[11px] leading-[16px] text-fg-3">{step.output}</pre>}
              </section>
            ))}
          </div>
        )}
        {node.kind === 'actor' && (
          <>
            <Facts items={[node.actor.kind === 'subagent' ? m.subagent : m.backgroundTask, node.actor.note ?? '', formatDuration(node.actor.end - node.actor.start), node.actor.running ? m.running : node.actor.failed ? m.failed : '']} />
            {node.actor.kind === 'background' && node.actor.note && <pre className="mb-3 whitespace-pre-wrap break-all rounded-lg bg-muted px-3 py-2 font-mono text-xs text-fg-2">{node.actor.note}</pre>}
            {actorLane && (actorDetail === undefined
              ? <Button size="sm" variant="quiet" onClick={() => onToggleLane(actorLane)}><IconChevronDown className="size-3.5" />{m.showSteps}</Button>
              : actorDetail === null ? <Spinner className="size-3" />
              : (
                <>
                  {actorDetail.answer && <Markdown text={actorDetail.answer} className="text-sm" />}
                  <Steps steps={actorDetail.steps} lanes={lanes} onToggleLane={onToggleLane} />
                </>
              ))}
          </>
        )}
      </div>
    </aside>
  );
}

function Facts({ items }: { items: string[] }) {
  const shown = items.filter(Boolean);
  if (!shown.length) return null;
  return <p className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-fg-3">{shown.map((item, index) => <span key={index}>{item}</span>)}</p>;
}

const stepColor: Record<Step['kind'], string> = {
  thought: 'bg-fg-4/50',
  commentary: 'bg-fg-3/60',
  answer: 'bg-fg-2',
  plan: 'bg-fg-3/70',
  status: 'bg-danger/70',
  tool: 'bg-fg-3/60',
  subagent: 'bg-accent/70',
  background: 'bg-fg-3/70',
  compaction: 'bg-fg-4/40',
};
const toolColor: Record<NonNullable<Step['tool']>, string> = {
  read: 'bg-fg-4/70',
  search: 'bg-fg-4/70',
  edit: 'bg-fg-2',
  execute: 'bg-fg-3',
  fetch: 'bg-fg-3/80',
  other: 'bg-fg-4',
};

/** The steps on one time axis: what ran side by side, and what outlived the rest. */
function Steps({ steps, lanes, onToggleLane, depth = 0 }: { steps: Step[]; lanes: LaneLookup; onToggleLane: (lane: SyncLane) => void; depth?: number }) {
  if (!steps.length) return null;
  const start = Math.min(...steps.map((step) => step.start));
  const end = Math.max(...steps.map((step) => step.end), start + 1);
  const pct = (value: number) => Math.min(100, Math.max(0, ((value - start) / (end - start)) * 100));
  return (
    <div className={cn('flex flex-col', depth === 0 && 'mt-4 border-t border-line-soft pt-3')}>
      {steps.slice(0, 200).map((step) => {
        const open = step.lane ? lanes(step.lane) : undefined;
        const icon = step.kind === 'subagent' ? <IconSparkles className="size-3 shrink-0 text-accent" /> : step.kind === 'background' ? <IconSquareTerminal className="size-3 shrink-0 text-success" /> : null;
        const label = (
          <span className="flex min-w-0 items-center gap-1 text-[11px] leading-[22px] text-fg-3" style={{ paddingLeft: depth * 10 }}>
            {step.lane && <IconChevronDown className={cn('size-2.5 shrink-0 transition-transform', open === undefined && '-rotate-90')} />}
            {icon}
            <span className="truncate">{step.label}</span>
          </span>
        );
        return (
          <div key={step.key}>
            <div className="flex h-[22px] items-center gap-2">
              <div className="w-[150px] shrink-0">
                {step.lane ? <button type="button" className="w-full text-left hover:text-fg" onClick={() => onToggleLane(step.lane!)}>{label}</button> : label}
              </div>
              <div className="relative h-1.5 flex-1 rounded-full bg-muted" title={`${step.label} · ${formatDuration(step.end - step.start)}`}>
                <span
                  className={cn('absolute top-0 h-1.5 min-w-[3px] rounded-full', step.failed ? 'bg-danger' : step.tool ? toolColor[step.tool] : stepColor[step.kind], step.running && 'animate-pulse')}
                  style={{ left: `${pct(step.start)}%`, width: `${pct(step.end) - pct(step.start)}%` }}
                />
              </div>
            </div>
            {open === null && <div className="py-1 pl-6"><Spinner className="size-3" /></div>}
            {open && depth < 3 && <Steps steps={open.steps} lanes={lanes} onToggleLane={onToggleLane} depth={depth + 1} />}
          </div>
        );
      })}
      {depth === 0 && <div className="mt-1 flex justify-between pl-[158px] text-[10px] tabular-nums text-fg-4"><span>0</span><span>{formatDuration(end - start)}</span></div>}
    </div>
  );
}
