import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ToolIcon, useMessages } from '@riffet/plugin-web';
import { cn } from './cn';
import { formatBytes, formatClock, formatCount, formatMs, formatOffset } from './format';
import { IconActivity, IconBrain, IconChevronRight, IconCircleAlert, IconInfo, IconMessagesSquare, IconSparkle } from './icons';
import { catalogs, type TraceMessages } from './messages';
import { addStep, emptyTokens, lineId, timeOf, type Item, type Line, type Span, type Tokens } from './model';
import { CATEGORY_COLOR } from './palette';
import { TokenBar } from './TokenBar';

/*
 * The list of a lane, one fixed-height line per turn, span or row, windowed: only the lines in view (and a
 * screen either side) are in the document, so a 100,000-row log scrolls as a 100-row one. Keyboard follows
 * the tree pattern: ↑↓ move, ← closes a turn or goes to it, → opens it, Home and End.
 */

export const LINE_HEIGHT = 28;
const OVERSCAN = 20;

export function SpanList({ lines, selectedId, hoverId, onSelect, onHover, onToggle, mode, empty }: {
  lines: readonly Line[];
  selectedId: string | undefined;
  /** Pointed at here or on the timeline; both show it. */
  hoverId: string | undefined;
  onHover(id: string | undefined): void;
  onSelect(id: string): void;
  onToggle(turnId: string): void;
  mode: 'spans' | 'log';
  empty: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const frame = useRef(0);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setView({ top: element.scrollTop, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const element = scroller.current;
      if (element) setView({ top: element.scrollTop, height: element.clientHeight });
    });
  }, []);
  useEffect(() => () => { cancelAnimationFrame(frame.current); frame.current = 0; }, []);

  const selectedIndex = selectedId === undefined ? -1 : lines.findIndex((line) => lineId(line) === selectedId);

  // Keep the selection in view when it moves by keyboard or from elsewhere (the strip, the inspector).
  useEffect(() => {
    const element = scroller.current;
    if (!element || selectedIndex < 0) return;
    const top = selectedIndex * LINE_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + LINE_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = top + LINE_HEIGHT - element.clientHeight;
  }, [selectedIndex, selectedId]);

  const move = (index: number) => {
    const line = lines[Math.max(0, Math.min(lines.length - 1, index))];
    if (line) onSelect(lineId(line));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const page = Math.max(1, Math.floor(view.height / LINE_HEIGHT) - 1);
    const current = lines[selectedIndex];
    switch (event.key) {
      case 'ArrowDown': case 'j': move(selectedIndex + 1); break;
      case 'ArrowUp': case 'k': move(selectedIndex < 0 ? 0 : selectedIndex - 1); break;
      case 'PageDown': move(selectedIndex + page); break;
      case 'PageUp': move(selectedIndex - page); break;
      case 'Home': move(0); break;
      case 'End': move(lines.length - 1); break;
      case 'ArrowLeft':
        if (current?.type === 'turn' && current.expanded) onToggle(current.turn.id);
        else if (current?.type === 'item') onSelect(current.parent ?? current.turn.id);
        else return;
        break;
      case 'ArrowRight':
        if (current?.type === 'turn' && !current.expanded) onToggle(current.turn.id);
        else if (current?.type === 'turn') move(selectedIndex + 1);
        else return;
        break;
      case 'Enter': case ' ':
        if (current?.type === 'turn') onToggle(current.turn.id); else return;
        break;
      default: return;
    }
    event.preventDefault();
  };

  const first = Math.max(0, Math.floor(view.top / LINE_HEIGHT) - OVERSCAN);
  const last = Math.min(lines.length, Math.ceil((view.top + view.height) / LINE_HEIGHT) + OVERSCAN);
  const shown = lines.slice(first, last);

  return (
    <div
      ref={scroller}
      role="tree"
      aria-multiselectable={false}
      aria-activedescendant={selectedIndex >= 0 ? `trace-line-${selectedIndex}` : undefined}
      tabIndex={0}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      onMouseLeave={() => onHover(undefined)}
      className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
    >
      {lines.length === 0 ? empty : (
        <div style={{ height: lines.length * LINE_HEIGHT, position: 'relative' }}>
          {shown.map((line, offset) => {
            const index = first + offset;
            const id = lineId(line);
            return (
              <div key={id} id={`trace-line-${index}`} style={{ position: 'absolute', top: index * LINE_HEIGHT, left: 0, right: 0, height: LINE_HEIGHT }}>
                <LineView line={line} selected={id === selectedId} hovered={id === hoverId} mode={mode} onSelect={onSelect} onHover={onHover} onToggle={onToggle} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const LineView = memo(function LineView({ line, selected, hovered, mode, onSelect, onHover, onToggle }: { line: Line; selected: boolean; hovered: boolean; mode: 'spans' | 'log'; onSelect(id: string): void; onHover(id: string): void; onToggle(id: string): void }) {
  const m = useMessages(catalogs);
  const id = lineId(line);
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-level={line.type === 'item' ? (line.parent ? 3 : 2) : 1}
      {...(line.type === 'turn' ? { 'aria-expanded': line.expanded } : {})}
      onClick={() => onSelect(id)}
      onMouseEnter={() => onHover(id)}
      onDoubleClick={() => { if (line.type === 'turn') onToggle(line.turn.id); }}
      className={cn(
        'group flex h-full cursor-default items-center gap-2 pr-3 text-sm',
        selected ? 'bg-accent-soft text-fg' : hovered && 'bg-hover',
        line.type === 'turn' && 'edge-t font-medium',
      )}
    >
      {line.type === 'turn' && <TurnLine line={line} m={m} onToggle={onToggle} />}
      {line.type === 'item' && <ItemLine line={line} m={m} />}
      {line.type === 'row' && mode === 'log' && <RowLine line={line} m={m} />}
    </div>
  );
});

/** Where a span sits in its turn, as a bar across a fixed column: the waterfall at row scale. */
function Bar({ start, end, from, to, timed, error, color }: { start: number; end: number; from: number; to: number; timed: boolean; error?: boolean; color: string }) {
  const span = Math.max(1, to - from);
  const left = Math.min(100, Math.max(0, ((start - from) / span) * 100));
  const width = timed ? Math.max(0.8, Math.min(100 - left, ((end - start) / span) * 100)) : 0;
  return (
    <span className="relative hidden h-3 w-28 shrink-0 md:block" aria-hidden>
      <span className="absolute inset-x-0 top-1/2 h-px bg-line-soft" />
      {timed
        ? <span className={cn('absolute top-0.5 h-2 rounded-full', error && 'bg-danger')} style={{ left: `${left}%`, width: `${width}%`, ...(error ? {} : { background: color }) }} />
        : <span className={cn('absolute top-0 h-3 w-0.5 rounded-full', error && 'bg-danger')} style={{ left: `${left}%`, ...(error ? {} : { background: color }) }} />}
    </span>
  );
}

function TurnLine({ line, m, onToggle }: { line: Extract<Line, { type: 'turn' }>; m: TraceMessages; onToggle(id: string): void }) {
  const { turn } = line;
  const failed = Boolean(turn.error || turn.status === 'failed');
  const tokens = turn.tokens;
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-label={turn.turnId ? m.turn(turn.index) : m.outsideTurns}
        className="ml-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-3 hover:bg-hover"
        onClick={(event) => { event.stopPropagation(); onToggle(turn.id); }}
      >
        <IconChevronRight className={cn('size-3.5 transition-transform duration-[var(--duration-fast)]', line.expanded && 'rotate-90')} />
      </button>
      <span className="shrink-0 text-fg">{turn.turnId ? m.turn(turn.index) : m.outsideTurns}</span>
      <span className="min-w-0 flex-1 truncate font-normal text-fg-3">{turn.prompt}</span>
      {failed && <IconCircleAlert className="size-3.5 shrink-0 text-danger" />}
      {!turn.ended && turn.turnId && <span className="shrink-0 text-xs font-normal text-fg-3">{m.running}</span>}
      {tokens.measured && (
        <span className="hidden w-32 shrink-0 items-center justify-between gap-2 font-mono text-xs font-normal text-fg-3 lg:flex">
          <TokenBar tokens={tokens} className="h-1.5 w-8 shrink-0" />
          {tokenFlow(tokens)}
        </span>
      )}
      {/* As wide as an item's bar, so the token columns of a turn and its requests line up. */}
      <span className="w-10 shrink-0 text-right font-mono text-xs font-normal text-fg-3 md:w-28">{turn.tools || ''}</span>
      <span className="w-16 shrink-0 text-right font-mono text-xs font-normal text-fg-2">{turn.turnId ? formatMs(turn.end - turn.start) : ''}</span>
    </>
  );
}

function ItemIcon({ item }: { item: Item }) {
  const className = 'size-3.5 shrink-0 text-fg-3';
  if (item.type === 'step') return <IconSparkle className={className} />;
  if (item.category === 'tool') return <ToolIcon kind={item.toolKind ?? ''} className={className} />;
  if (item.category === 'thinking') return <IconBrain className={className} />;
  if (item.category === 'message') return <IconMessagesSquare className={className} />;
  if (item.category === 'draft') return <IconActivity className={className} />;
  return <IconInfo className={className} />;
}

function ItemLine({ line, m }: { line: Extract<Line, { type: 'item' }>; m: TraceMessages }) {
  const { item, turn } = line;
  // A row stamped before its turn began carries the provider's coarse time, not when it happened: no offset is shown for it.
  const right = item.timed ? formatMs(item.end - item.start) : item.start >= turn.start ? formatOffset(item.start - turn.start) : '';
  const said = item.type === 'span' && (item.kind === 'user_message_chunk' || item.kind === 'agent_message_chunk');
  return (
    <>
      <span className={cn('shrink-0', line.parent ? 'w-14' : 'w-9')} />
      <ItemIcon item={item} />
      {item.type === 'step' ? (
        <>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
            {m.requestAt(line.request ?? 0)}
            {line.namesModel && (item.step.model ?? item.step.requestedModel) && <span className="ml-2 text-fg-3">{item.step.model ?? item.step.requestedModel}</span>}
          </span>
          <StepTokens item={item} />
        </>
      ) : (
        <>
          <span className={cn('max-w-48 shrink-0 truncate font-mono text-xs', item.error ? 'text-danger' : 'text-fg-2')}>{spanLabel(item, m)}</span>
          <span className={cn('min-w-0 flex-1 truncate', said ? 'text-fg-2' : 'text-fg-3')}>{item.title}</span>
        </>
      )}
      <Bar start={item.start} end={item.end} from={turn.start} to={turn.end} timed={item.timed} error={item.error} color={CATEGORY_COLOR[item.category]} />
      <span className={cn('w-16 shrink-0 text-right font-mono text-xs', item.timed ? 'text-fg-2' : 'text-fg-4')}>{right}</span>
    </>
  );
}

/** Who said it for a message, what it is for thinking; a tool by its name. */
function spanLabel(span: Span, m: TraceMessages): string {
  if (span.kind === 'user_message_chunk') return m.user;
  if (span.kind === 'agent_message_chunk') return m.assistant;
  if (span.kind === 'agent_thought_chunk') return m.thinking;
  return span.name ?? span.kind;
}

/** A request's tokens as the turn line shows its own: what went in, then what came out; the breakdown is in the inspector. */
function StepTokens({ item }: { item: Extract<Item, { type: 'step' }> }) {
  const tokens = emptyTokens();
  addStep(tokens, item.step);
  if (!tokens.measured) return null;
  return (
    <span className="hidden w-32 shrink-0 items-center justify-between gap-2 font-mono text-xs text-fg-3 lg:flex">
      <TokenBar tokens={tokens} className="h-1.5 w-8 shrink-0" />
      {tokenFlow(tokens)}
    </span>
  );
}

/** What went in, then what came out; `~` when the provider did not count them and they were estimated. */
function tokenFlow(tokens: Tokens): string {
  return `${tokens.estimated ? '~' : ''}${formatCount(tokens.input + tokens.cacheRead + tokens.cacheWrite)} → ${formatCount(tokens.output)}`;
}

function RowLine({ line, m }: { line: Extract<Line, { type: 'row' }>; m: TraceMessages }) {
  const { row } = line;
  return (
    <>
      <span className="w-16 shrink-0 text-right font-mono text-xs text-fg-4">{row.seq}</span>
      <span className="hidden w-24 shrink-0 font-mono text-xs text-fg-3 md:block">{formatClock(timeOf(row))}</span>
      <span className={cn('w-44 shrink-0 truncate font-mono text-xs', row.error ? 'text-danger' : row.kind.startsWith('meta.') || row.kind === 'draft' || row.kind === 'tombstone' ? 'text-fg-3' : 'text-fg-2')}>
        {row.kind}{row.type ? <span className="text-fg-4"> · {row.type}</span> : null}
      </span>
      <span className="w-8 shrink-0 font-mono text-2xs text-fg-4">{row.rev > 1 ? `r${row.rev}` : ''}</span>
      <span className={cn('min-w-0 flex-1 truncate', row.cleared ? 'italic text-fg-4' : 'text-fg-3')}>{row.cleared ? '{}' : row.text ?? row.name ?? ''}</span>
      {row.blob && <span className="shrink-0 font-mono text-2xs text-fg-4">blob</span>}
      <span className="w-14 shrink-0 text-right font-mono text-2xs text-fg-4">{formatBytes(row.bytes)}</span>
    </>
  );
}
