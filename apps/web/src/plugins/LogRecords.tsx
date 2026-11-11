import { memo, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { TaskLogRecords, TaskLogTone } from '@contracts';
import { IconPause, IconPlay, IconSearch, IconTrash2, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * A log of records, as Android Studio's Logcat draws one: the fields as columns, the level as a
 * coloured cap, and a query over the fields with completion. The query is Studio's:
 *
 * - `tag:Foo` contains, `tag=:Foo` equals, `tag~:Fo+` matches; `-` in front excludes.
 * - `level:W` keeps that level and the more severe ones.
 * - A bare word searches the message; `-word` leaves it out.
 * - Terms on the same field are alternatives, terms on different fields all apply.
 */

const LINES = 4000;
const HISTORY = 10;
const SUGGESTIONS = 12;
const TOKEN = /(-?)([a-z][a-z0-9]*)(=:|~:|:)(?:"([^"]*)"?|(\S*))|(-?)"([^"]*)"?|(-?)(\S+)/g;

type Tone = TaskLogTone | undefined;
interface Entry { kind: 'record'; fields: Record<string, string>; level: number; text: string }
interface Plain { kind: 'plain'; text: string; tone: Tone }
type Row = Entry | Plain;

interface Term { field: string; op: ':' | '=:' | '~:'; value: string; negate: boolean; regex?: RegExp | undefined }
interface Query { terms: Term[]; words: Array<{ value: string; negate: boolean }> }

export function parseQuery(query: string): Query {
  const result: Query = { terms: [], words: [] };
  for (const match of query.matchAll(TOKEN)) {
    if (match[2]) {
      const value = match[4] ?? match[5] ?? '';
      if (!value) continue;
      let regex: RegExp | undefined;
      if (match[3] === '~:') { try { regex = new RegExp(value, 'i'); } catch { continue; } }
      result.terms.push({ field: match[2], op: match[3] as Term['op'], value, negate: match[1] === '-', regex });
    } else {
      const value = match[7] ?? match[9] ?? '';
      if (value) result.words.push({ value: value.toLowerCase(), negate: (match[6] ?? match[8]) === '-' });
    }
  }
  return result;
}

/** The level index a query value names: the value itself, or a word starting with it (`warn` → W). */
const levelOf = (levels: readonly string[], value: string): number => {
  const upper = value.toUpperCase();
  const exact = levels.findIndex((level) => level.toUpperCase() === upper);
  return exact >= 0 ? exact : levels.findIndex((level) => level.length === 1 && level.toUpperCase() === upper[0]);
};

function termMatches(term: Term, entry: Entry, levels: readonly string[]): boolean {
  if (term.field === 'level' && levels.length) {
    const threshold = levelOf(levels, term.value);
    return threshold >= 0 && entry.level >= threshold;
  }
  const field = entry.fields[term.field];
  if (field === undefined) return false;
  if (term.op === '~:') return term.regex!.test(field);
  return term.op === '=:' ? field.toLowerCase() === term.value.toLowerCase() : field.toLowerCase().includes(term.value.toLowerCase());
}

function matches(query: Query, row: Row, levels: readonly string[]): boolean {
  const text = (row.kind === 'record' ? row.fields.message ?? row.text : row.text).toLowerCase();
  for (const word of query.words) if (text.includes(word.value) === word.negate) return false;
  if (row.kind === 'plain') return !query.terms.length;
  const byField = new Map<string, Term[]>();
  for (const term of query.terms) {
    if (term.negate) { if (termMatches(term, row, levels)) return false; continue; }
    byField.set(term.field, [...(byField.get(term.field) ?? []), term]);
  }
  for (const terms of byField.values()) if (!terms.some((term) => termMatches(term, row, levels))) return false;
  return true;
}

const CAP: Record<TaskLogTone, string> = {
  muted: 'bg-muted text-fg-3', accent: 'bg-accent-soft text-accent', success: 'bg-success-soft text-success', warning: 'bg-warning-soft text-warning', error: 'bg-danger-soft text-danger',
};
const MESSAGE: Record<TaskLogTone, string> = { muted: 'text-fg-3', accent: 'text-fg-2', success: 'text-fg', warning: 'text-warning', error: 'text-danger' };
const PLAIN: Record<TaskLogTone, string> = { muted: 'text-fg-4', accent: 'text-accent', success: 'text-success', warning: 'text-warning', error: 'text-danger' };
/** The widest a column grows to, in characters; longer values are cut and shown whole on hover. */
const COLUMN_MAX: Record<string, number> = { tag: 24, package: 28 };

export function RecordsLog({ log, records, tone, wrap, storageKey }: {
  log: string;
  records: TaskLogRecords;
  /** A plain line's tone, from the action's rules. */
  tone: (text: string) => Tone;
  wrap: boolean;
  /** Where the query and its history are kept in this browser. */
  storageKey: string;
}) {
  const { t } = useLingui();
  const pattern = useMemo(() => { try { return new RegExp(records.pattern); } catch { return undefined; } }, [records.pattern]);
  const levels = useMemo(() => (records.levels ?? []).map((level) => level.value), [records.levels]);
  const tones = records.levels?.map((level) => level.tone);
  const columns = records.columns ?? [];

  const [query, setQueryState] = useState(() => { try { return localStorage.getItem(`${storageKey}.query`) ?? ''; } catch { return ''; } });
  const setQuery = (value: string) => { setQueryState(value); try { localStorage.setItem(`${storageKey}.query`, value); } catch { /* this view only */ } };
  const [history, setHistory] = useState<string[]>(() => {
    try { const value: unknown = JSON.parse(localStorage.getItem(`${storageKey}.history`) ?? '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, HISTORY) : []; } catch { return []; }
  });
  const remember = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const next = [trimmed, ...history.filter((item) => item !== trimmed)].slice(0, HISTORY);
    setHistory(next);
    try { localStorage.setItem(`${storageKey}.history`, JSON.stringify(next)); } catch { /* this view only */ }
  };

  // Pause holds what is drawn; Clear hides what has arrived so far, found again by its last lines.
  const [frozen, setFrozen] = useState<string>();
  const [clearedTail, setClearedTail] = useState<string>();
  const shownLog = frozen ?? log;

  /** Rows by line, kept across polls: an unchanged line is the same row and its drawing is reused. */
  const parsedLines = useRef<{ by: unknown[]; rows: Map<string, Row> }>({ by: [], rows: new Map() });
  const rows = useMemo<Row[]>(() => {
    let lines = shownLog.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (clearedTail) {
      const tail = clearedTail.split('\n');
      for (let index = lines.length - tail.length; index >= 0; index--) {
        if (tail.every((line, offset) => lines[index + offset] === line)) { lines = lines.slice(index + tail.length); break; }
      }
    }
    // A new pattern, level list or tone parses afresh.
    const by = [pattern, levels, tone];
    const previous = by.every((value, index) => parsedLines.current.by[index] === value) ? parsedLines.current.rows : new Map<string, Row>();
    const next = new Map<string, Row>();
    const parsed = lines.slice(-LINES).map((text): Row => {
      let row = previous.get(text) ?? next.get(text);
      if (!row) {
        const groups = pattern?.exec(text)?.groups;
        if (!groups) row = { kind: 'plain', text, tone: tone(text) };
        else {
          const fields = Object.fromEntries(Object.entries(groups).filter((entry): entry is [string, string] => entry[1] !== undefined));
          row = { kind: 'record', fields, level: fields.level === undefined ? -1 : levelOf(levels, fields.level), text };
        }
      }
      next.set(text, row);
      return row;
    });
    parsedLines.current = { by, rows: next };
    return parsed;
  }, [shownLog, clearedTail, pattern, levels, tone]);

  const parsed = useMemo(() => parseQuery(query), [query]);
  const shown = useMemo(() => rows.filter((row) => matches(parsed, row, levels)), [rows, parsed, levels]);
  const recordCount = rows.reduce((count, row) => count + Number(row.kind === 'record'), 0);
  const widths = useMemo(() => {
    const width: Record<string, number> = {};
    for (const row of shown) if (row.kind === 'record') for (const column of columns) width[column] = Math.max(width[column] ?? 0, row.fields[column]?.length ?? 0);
    for (const column of columns) width[column] = Math.min(width[column] ?? 0, COLUMN_MAX[column] ?? 32);
    return width;
  }, [shown, columns]);

  const widthKey = columns.map((column) => widths[column] ?? 0).join(',');
  const termRef = useRef<(field: string, value: string, negate: boolean) => void>(() => undefined);
  const addTermStable = useMemo(() => (field: string, value: string, negate: boolean) => termRef.current(field, value, negate), []);
  const box = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useLayoutEffect(() => { const node = box.current; if (node && stuck.current) node.scrollTop = node.scrollHeight; }, [shown]);

  /** Adds a term for a value, as clicking a tag in Studio's Logcat does; ⌥-click excludes it. */
  const addTermNow = (field: string, value: string, negate: boolean) => {
    const term = `${negate ? '-' : ''}${field}${value.includes(' ') ? `:"${value}"` : `:${value}`}`;
    if (query.split(/\s+/).includes(term)) return;
    const next = `${query.trim()} ${term}`.trim();
    setQuery(next);
    remember(next);
  };
  termRef.current = addTermNow;
  const addTerm = addTermStable;

  return (
    <div className="flex min-h-0 flex-1 flex-col edge-t">
      <div className="flex h-10 shrink-0 items-center gap-1 px-2">
        <QueryInput
          value={query} onChange={setQuery} onCommit={remember} history={history}
          fields={['level', ...columns.filter((column) => column !== 'level'), ...(pattern && /\(\?<message>/.test(records.pattern) ? ['message'] : [])]}
          values={(field) => {
            if (field === 'level') return levels;
            const counts = new Map<string, number>();
            for (const row of rows) if (row.kind === 'record' && row.fields[field]) counts.set(row.fields[field]!, (counts.get(row.fields[field]!) ?? 0) + 1);
            return [...counts].sort((a, b) => b[1] - a[1]).map(([value]) => value);
          }}
        />
        <span className="shrink-0 px-1 text-2xs tabular-nums text-fg-4" title={t`显示的记录 / 全部记录`}>
          {shown.reduce((count, row) => count + Number(row.kind === 'record'), 0)}/{recordCount}
        </span>
        <Tip label={frozen === undefined ? t`暂停` : t`继续`}>
          <Button size="icon-xs" variant="quiet" aria-label={frozen === undefined ? t`暂停` : t`继续`} aria-pressed={frozen !== undefined} className={cn(frozen !== undefined && 'bg-hover text-fg')} onClick={() => setFrozen((current) => (current === undefined ? log : undefined))}>
            {frozen === undefined ? <IconPause /> : <IconPlay />}
          </Button>
        </Tip>
        <Tip label={t`清空`}>
          <Button size="icon-xs" variant="quiet" aria-label={t`清空`} onClick={() => {
            const lines = shownLog.split('\n');
            if (lines.at(-1) === '') lines.pop();
            setClearedTail(lines.slice(-3).join('\n') || undefined);
            setFrozen(undefined);
          }}><IconTrash2 /></Button>
        </Tip>
      </div>
      <div
        ref={box} role="log" aria-label={t`日志`} tabIndex={0}
        onScroll={(event) => { const node = event.currentTarget; stuck.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24; }}
        className="min-h-0 flex-1 overflow-auto py-1 font-mono text-xs leading-5"
      >
        <div className={cn(!wrap && 'w-max min-w-full')}>
          {(() => {
            // Keyed by the line and how many times it came before, which holds while lines arrive.
            const seen = new Map<string, number>();
            return shown.map((row) => {
              const nth = (seen.get(row.text) ?? 0) + 1;
              seen.set(row.text, nth);
              return <LogRow key={`${row.text}\u0000${nth}`} row={row} columns={columns} widths={widthKey} tones={tones} wrap={wrap} onTerm={addTerm} />;
            });
          })()}
          {!shown.length && rows.length > 0 && <p className="px-3 py-6 font-sans text-sm text-fg-3"><Trans>没有符合筛选的记录</Trans></p>}
        </div>
      </div>
    </div>
  );
}

/** One drawn line; unchanged across polls while its record and the column widths are. */
const LogRow = memo(function LogRow({ row, columns, widths, tones, wrap, onTerm }: {
  row: Row; columns: string[]; widths: string; tones: Array<TaskLogTone | undefined> | undefined; wrap: boolean;
  onTerm: (field: string, value: string, negate: boolean) => void;
}) {
  if (row.kind === 'plain') return <div className={cn('min-h-5 px-3', wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre', row.tone ? PLAIN[row.tone] : 'text-fg-2')}>{row.text || ' '}</div>;
  const width = widths.split(',');
  const levelTone = tones?.[row.level];
  return (
    <div className="flex min-h-5 items-start gap-2 px-3 hover:bg-hover">
      {columns.map((column, index) => {
        const value = row.fields[column] ?? '';
        return (
          <button
            key={column} type="button" tabIndex={-1} title={`${column}:${value}`}
            onClick={(event) => onTerm(column, value, event.altKey)}
            style={{ width: `${width[index] ?? 0}ch` }}
            className={cn('shrink-0 overflow-hidden text-left whitespace-pre text-ellipsis hover:text-fg', column === 'tag' ? 'text-fg-2' : 'text-fg-4')}
          >{value}</button>
        );
      })}
      {row.fields.level !== undefined && (
        <button type="button" tabIndex={-1} title={`level:${row.fields.level}`} onClick={() => onTerm('level', row.fields.level!, false)}
          className={cn('mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-sm text-2xs font-semibold', levelTone ? CAP[levelTone] : 'bg-muted text-fg-3')}>{row.fields.level}</button>
      )}
      <span className={cn('min-w-0', wrap ? 'flex-1 whitespace-pre-wrap break-words' : 'whitespace-pre', levelTone ? MESSAGE[levelTone] : 'text-fg-2')}>{row.fields.message ?? row.text}</span>
    </div>
  );
});

/**
 * The query box: completion for the field under the caret (`ta` → `tag:`) and for its values
 * (`tag:` → the tags seen, most frequent first), and the last queries when it is empty.
 */
function QueryInput({ value, onChange, onCommit, history, fields, values }: {
  value: string;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
  history: string[];
  fields: string[];
  values: (field: string) => string[];
}) {
  const { t } = useLingui();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** Enter takes a suggestion only once the arrows picked one; otherwise it keeps what was typed. */
  const [picked, setPicked] = useState(false);
  const [caret, setCaret] = useState(value.length);

  const start = value.lastIndexOf(' ', caret - 1) + 1;
  const token = value.slice(start, caret);
  const field = /^-?([a-z][a-z0-9]*)(=:|~:|:)(.*)$/.exec(token);
  let options: Array<{ label: string; insert: string; whole?: boolean }>;
  if (!value.trim()) options = history.map((item) => ({ label: item, insert: item, whole: true }));
  else if (field) {
    const prefix = token.slice(0, token.length - field[3]!.length);
    const typed = field[3]!.replace(/^"/, '').toLowerCase();
    // Values that start with what is typed first, then those containing it; each by how often it occurs.
    const candidates = values(field[1]!).filter((item) => item.toLowerCase().includes(typed) && item.toLowerCase() !== typed);
    options = [...candidates.filter((item) => item.toLowerCase().startsWith(typed)), ...candidates.filter((item) => !item.toLowerCase().startsWith(typed))].slice(0, SUGGESTIONS)
      .map((item) => ({ label: item, insert: `${prefix}${item.includes(' ') ? `"${item}"` : item} ` }));
  } else {
    const bare = token.replace(/^-/, '');
    options = token ? fields.filter((name) => name.startsWith(bare.toLowerCase()) && name !== bare).map((name) => ({ label: `${token.startsWith('-') ? '-' : ''}${name}:`, insert: `${token.startsWith('-') ? '-' : ''}${name}:` })) : [];
  }
  const shown = open && options.length > 0;
  const index = Math.min(active, Math.max(0, options.length - 1));

  const accept = (option: { insert: string; whole?: boolean }) => {
    const next = option.whole ? option.insert : value.slice(0, start) + option.insert + value.slice(caret);
    const at = option.whole ? next.length : start + option.insert.length;
    onChange(next);
    setCaret(at);
    setActive(0);
    setPicked(false);
    requestAnimationFrame(() => { input.current?.setSelectionRange(at, at); });
    if (option.whole) onCommit(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (shown && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setActive(picked ? (index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length : event.key === 'ArrowDown' ? 0 : options.length - 1);
      setPicked(true);
    } else if (shown && (event.key === 'Tab' || (event.key === 'Enter' && picked && options[index]))) {
      event.preventDefault();
      accept(options[index]!);
    } else if (event.key === 'Enter') { onCommit(value); setOpen(false); }
    else if (event.key === 'Escape' && shown) { event.preventDefault(); setOpen(false); }
  };

  return (
    <label className="relative flex h-7 min-w-0 flex-1 items-center rounded-md bg-subtle px-2 focus-within:ring-2 focus-within:ring-focus">
      <IconSearch className="size-3.5 shrink-0 text-fg-4" />
      <input
        ref={input} value={value} spellCheck={false} aria-label={t`筛选日志`} placeholder="tag:  level:W  -tag:  message~:"
        role="combobox" aria-expanded={shown} aria-autocomplete="list"
        onChange={(event) => { onChange(event.target.value); setCaret(event.target.selectionStart ?? event.target.value.length); setOpen(true); setActive(0); setPicked(false); }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? value.length)}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKeyDown}
        className="h-full min-w-0 flex-1 bg-transparent pl-1.5 font-mono text-xs text-fg outline-none placeholder:text-fg-4"
      />
      {value && <button type="button" aria-label={t`清除筛选`} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(''); input.current?.focus(); }} className="grid size-5 shrink-0 place-items-center rounded text-fg-4 hover:text-fg"><IconX className="size-3" /></button>}
      {shown && (
        <div role="listbox" className="absolute left-0 top-full z-20 mt-1 max-h-64 w-80 max-w-full overflow-y-auto rounded-lg bg-popover p-1 shadow-pop">
          {options.map((option, at) => (
            <div key={option.label} role="option" aria-selected={at === index}
              onMouseDown={(event) => { event.preventDefault(); accept(option); }} onPointerMove={() => { setActive(at); setPicked(true); }}
              className={cn('flex h-7 cursor-default items-center truncate rounded-md px-2 font-mono text-xs text-fg-2', picked && at === index && 'bg-active text-fg')}>{option.label}</div>
          ))}
        </div>
      )}
    </label>
  );
}
