import { memo, useState } from 'react';
import { useMessages } from '@riffet/plugin-web';
import { cn } from './cn';
import { formatExact } from './format';
import { IconChevronRight } from './icons';
import { catalogs } from './messages';

/*
 * A JSON value as a tree that opens on demand: children are built only when their parent is open, arrays
 * show 100 entries at a time, and a long string shows its first 4,000 characters until asked for the rest.
 */

const ARRAY_PAGE = 100;
const STRING_HEAD = 4_000;
/** Strings longer than this, or with a line break, are drawn as a block under their key. */
const INLINE_STRING = 120;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function JsonTree({ value, openDepth = 2 }: { value: unknown; openDepth?: number }) {
  return (
    <div className="pl-4 font-mono text-xs leading-5 text-fg" role="tree">
      <Entry label={undefined} value={value as Json} depth={0} openDepth={openDepth} />
    </div>
  );
}

const Entry = memo(function Entry({ label, value, depth, openDepth }: { label: string | undefined; value: Json; depth: number; openDepth: number }) {
  const m = useMessages(catalogs);
  const container = value !== null && typeof value === 'object';
  const size = container ? (Array.isArray(value) ? value.length : Object.keys(value).length) : 0;
  const [open, setOpen] = useState(() => depth < openDepth && size <= 400);
  const key = label === undefined ? null : <span className="text-fg-3">{label}<span className="text-fg-4">: </span></span>;

  if (!container) {
    if (typeof value === 'string' && (value.length > INLINE_STRING || value.includes('\n'))) {
      return (
        <div role="treeitem" aria-selected={false} style={{ paddingLeft: depth ? 14 : 0 }}>
          {key}<span className="text-fg-4">{formatExact(value.length)} chars</span>
          <LongString text={value} />
        </div>
      );
    }
    return <div role="treeitem" aria-selected={false} className="wrap-anywhere" style={{ paddingLeft: depth ? 14 : 0 }}>{key}<Scalar value={value} /></div>;
  }

  const isArray = Array.isArray(value);
  const brackets = isArray ? ['[', ']'] : ['{', '}'];
  return (
    <div role="treeitem" aria-expanded={open} aria-selected={false} style={{ paddingLeft: depth ? 14 : 0 }}>
      <button type="button" className="-ml-4 inline-flex max-w-full items-center gap-0.5 rounded-sm text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => setOpen(!open)}>
        <IconChevronRight className={cn('size-3 shrink-0 text-fg-4 transition-transform duration-[var(--duration-fast)]', open && 'rotate-90')} />
        {key}
        <span className="text-fg-4">{brackets[0]}{!open && <>{size ? ` ${isArray ? m.items(size) : m.keys(size)} ` : ''}{brackets[1]}</>}</span>
      </button>
      {open && <Children value={value} depth={depth} openDepth={openDepth} />}
      {open && <div className="text-fg-4" style={{ paddingLeft: 0 }}>{brackets[1]}</div>}
    </div>
  );
});

function Children({ value, depth, openDepth }: { value: Json[] | { [key: string]: Json }; depth: number; openDepth: number }) {
  const m = useMessages(catalogs);
  const [shown, setShown] = useState(ARRAY_PAGE);
  const entries: Array<[string, Json]> = Array.isArray(value) ? value.slice(0, shown).map((item, index) => [String(index), item]) : Object.entries(value).slice(0, shown);
  const total = Array.isArray(value) ? value.length : Object.keys(value).length;
  return (
    <div role="group">
      {entries.map(([label, child]) => <Entry key={label} label={label} value={child} depth={depth + 1} openDepth={openDepth} />)}
      {total > shown && (
        <button type="button" className="ml-3.5 rounded-sm px-1 text-accent hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => setShown(shown + ARRAY_PAGE)}>
          {m.showMore(Math.min(ARRAY_PAGE, total - shown))}
        </button>
      )}
    </div>
  );
}

function Scalar({ value }: { value: null | boolean | number | string }) {
  if (value === null) return <span className="italic text-fg-4">null</span>;
  if (typeof value === 'string') return <span className="whitespace-pre-wrap text-fg">"{value}"</span>;
  return <span className="text-fg-2">{String(value)}</span>;
}

/** A long text, as a block of its own lines. */
export function LongString({ text, className }: { text: string; className?: string }) {
  const m = useMessages(catalogs);
  const [all, setAll] = useState(false);
  const clipped = !all && text.length > STRING_HEAD;
  return (
    <div className={cn('my-1 rounded-md bg-muted px-2.5 py-1.5', className)}>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-fg-2">{clipped ? `${text.slice(0, STRING_HEAD)}…` : text}</pre>
      {clipped && (
        <button type="button" className="mt-1 rounded-sm text-xs text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" onClick={() => setAll(true)}>
          {m.showAll(formatExact(text.length))}
        </button>
      )}
    </div>
  );
}
