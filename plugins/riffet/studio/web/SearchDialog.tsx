import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { CodeIndexStatus, CodeSymbol, FileEntry, SearchHit, SearchResults } from '@contracts';
import { usePluginHost } from '@riffet/plugin-web';
import { cn } from './cn';
import { dirName, fileName, findInFiles, KIND_MARK, type CodeApi, type TextOptions } from './data';
import type { Messages } from './messages';

export type SearchTab = 'all' | 'classes' | 'files' | 'symbols' | 'text' | 'actions';
const TABS: readonly SearchTab[] = ['all', 'classes', 'files', 'symbols', 'text', 'actions'];

/** A place a result opens. */
export interface Place { path: string; line?: number; column?: number }

/** A command of the page, listed under Actions and matched by its label. */
export interface StudioAction { id: string; label: string; icon?: ReactNode; run(): void }

type Row =
  | { key: string; type: 'heading'; label: string }
  | { key: string; type: 'note'; label: string; error?: boolean }
  | { key: string; type: 'symbol'; symbol: CodeSymbol }
  | { key: string; type: 'file'; path: string }
  | { key: string; type: 'hit'; hit: SearchHit }
  | { key: string; type: 'action'; action: StudioAction }
  | { key: string; type: 'line'; line: number; column?: number };

/** What a tab found for one query; `error` when it could not search, which is not the same as nothing found. */
interface Found { key: string; symbols?: CodeSymbol[]; types?: CodeSymbol[]; files?: FileEntry[]; text?: SearchResults; index?: CodeIndexStatus; error?: string }

const DEBOUNCE_MS = 150;
/** Rows per kind in the All tab; a tab of its own lists more. */
const ALL_EACH = 6;
const TEXT_LIMIT = 100;
/** Rows one Page Up or Page Down moves. */
const PAGE = 10;
const LIST_ID = 'studio-search-list';
const optionId = (index: number) => `studio-search-option-${index}`;
const selectable = (row: Row) => row.type !== 'heading' && row.type !== 'note';

/** `Name:120` or `Name:120:8` opens the match at that line; `:120` is a line of the open file. */
function parseQuery(raw: string): { name: string; line?: number; column?: number } {
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(raw.trim());
  if (!match) return { name: raw.trim() };
  return { name: match[1]!.trim(), line: Number(match[2]), ...(match[3] ? { column: Number(match[3]) } : {}) };
}

/** Where `needle` is in `text`, for marking it; none for a regex or no match. */
function marked(text: string, needle: string, options?: { matchCase: boolean; regex: boolean }): ReactNode {
  if (!needle || options?.regex) return text;
  const at = options?.matchCase ? text.indexOf(needle) : text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return text;
  return <>{text.slice(0, at)}<span className="rounded-sm bg-accent-soft text-fg">{text.slice(at, at + needle.length)}</span>{text.slice(at + needle.length)}</>;
}

/**
 * Search everywhere, as an IDE's: one dialog for classes, files, symbols, text in files and the page's
 * actions, a tab each and an All tab that lists the first of each. `Tab` moves between tabs, the query
 * stays as tabs change, `Name:120` opens at a line. Text search has match case, words, regex, file masks
 * and a module scope, and previews the selected hit. A search that failed or stopped early says so, so an
 * empty list always means nothing matched.
 */
export function SearchDialog({ api, projectId, messages: m, open, onOpenChange, tab, onTabChange, focusToken, query, onQueryChange, options, onOptionsChange, module, recent, actions, activeFile, onPick, onTextResults }: {
  api: CodeApi;
  projectId: string;
  messages: Messages;
  open: boolean;
  onOpenChange(open: boolean): void;
  tab: SearchTab;
  onTabChange(tab: SearchTab): void;
  focusToken: number;
  query: string;
  onQueryChange(query: string): void;
  options: TextOptions;
  onOptionsChange(options: TextOptions): void;
  /** The open file's module directory, for the module scope; `undefined` when there is none. */
  module: string | undefined;
  recent: readonly string[];
  actions: readonly StudioAction[];
  activeFile: string | undefined;
  onPick(place: Place): void;
  /** ⌘↵ in the Text tab: every hit, in the find panel. */
  onTextResults(query: string): void;
}) {
  const { ui } = usePluginHost();
  const parsed = parseQuery(query);
  const needle = tab === 'text' ? query : parsed.name;
  const within = options.scope === 'module' && module !== undefined ? module : undefined;
  const fetchKey = `${tab}\n${needle}\n${tab === 'text' ? JSON.stringify(options) + (within ?? '') : ''}`;
  const remote = needle.trim() && tab !== 'actions';
  const [found, setFound] = useState<Found>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !remote) { setBusy(false); return; }
    const controller = new AbortController();
    const { signal } = controller;
    setBusy(true);
    const timer = window.setTimeout(() => {
      const name = needle.trim();
      const read: Promise<Omit<Found, 'key'>> =
        tab === 'classes' ? api.symbols(name, true, signal).then((result) => ({ types: result.items, index: result.index }))
          : tab === 'symbols' ? api.symbols(name, false, signal).then((result) => ({ symbols: result.items, index: result.index }))
            : tab === 'files' ? api.files(name, signal).then((files) => ({ files }))
              // The Kotlin and Java part of a whole-word search shows first; the scan of the rest keeps the spinner on.
              : tab === 'text' ? findInFiles(api, needle, options, within, TEXT_LIMIT, signal, (part) => { if (!signal.aborted) setFound({ key: fetchKey, text: part }); }).then((text) => ({ text }))
                : Promise.allSettled([api.symbols(name, true, signal), api.files(name, signal), api.symbols(name, false, signal)]).then(([types, files, symbols]) => {
                  // A kind that failed is left out with a note; the others still answer.
                  const failed = [types, files, symbols].find((result) => result.status === 'rejected');
                  return {
                    ...(types.status === 'fulfilled' ? { types: types.value.items, index: types.value.index } : {}),
                    ...(files.status === 'fulfilled' ? { files: files.value } : {}),
                    ...(symbols.status === 'fulfilled' ? { symbols: symbols.value.items.filter((item) => !KIND_TYPES.has(item.kind)) } : {}),
                    ...(failed ? { error: errorText(failed.reason) } : {}),
                  };
                });
      read.then(
        (result) => { if (!signal.aborted) { setFound({ key: fetchKey, ...result }); setBusy(false); } },
        (error: unknown) => { if (!signal.aborted) { setFound({ key: fetchKey, error: errorText(error) }); setBusy(false); } },
      );
    }, DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [api, open, fetchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const lower = parsed.name.toLowerCase();
    if (tab !== 'text' && tab !== 'actions' && !parsed.name && parsed.line !== undefined && activeFile) {
      out.push({ key: 'line', type: 'line', line: parsed.line, ...(parsed.column !== undefined ? { column: parsed.column } : {}) });
    }
    if (tab === 'actions' || (tab === 'all' && parsed.name)) {
      const matching = actions.filter((action) => !lower || action.label.toLowerCase().includes(lower));
      if (tab === 'all' && matching.length) out.push({ key: 'h:actions', type: 'heading', label: m.sections.actions });
      for (const action of tab === 'all' ? matching.slice(0, 3) : matching) out.push({ key: `a:${action.id}`, type: 'action', action });
      if (tab === 'actions') { if (!out.length) out.push({ key: 'none', type: 'note', label: m.noMatches }); return out; }
    }
    if (!needle.trim()) {
      if ((tab === 'all' || tab === 'files') && recent.length) {
        out.push({ key: 'h:recent', type: 'heading', label: m.sections.recent });
        for (const path of recent) out.push({ key: `r:${path}`, type: 'file', path });
      }
      return out;
    }
    const current = found?.key === fetchKey ? found : undefined;
    if (!current) return out;
    const pending = current.index && current.index.state !== 'ready' && (tab === 'classes' || tab === 'symbols' || tab === 'all');
    const section = (label: string, items: Row[]) => {
      if (!items.length) return;
      if (tab === 'all') out.push({ key: `h:${label}`, type: 'heading', label });
      out.push(...(tab === 'all' ? items.slice(0, ALL_EACH) : items));
    };
    section(m.sections.classes, (current.types ?? []).map((symbol) => ({ key: `t:${symbol.path}:${symbol.line}:${symbol.name}`, type: 'symbol' as const, symbol })));
    section(m.sections.files, (current.files ?? []).map((entry) => ({ key: `f:${entry.path}`, type: 'file' as const, path: entry.path })));
    section(m.sections.symbols, (current.symbols ?? []).map((symbol) => ({ key: `s:${symbol.path}:${symbol.line}:${symbol.name}`, type: 'symbol' as const, symbol })));
    for (const hit of current.text?.hits ?? []) out.push({ key: `x:${hit.path}:${hit.line}`, type: 'hit', hit });
    if (current.text?.incomplete) out.push({ key: 'incomplete', type: 'note', label: m.findIncomplete[current.text.incomplete] });
    else if (current.text?.more) out.push({ key: 'more', type: 'note', label: m.moreMatches(MOD_ENTER) });
    if (pending) out.push({ key: 'pending', type: 'note', label: m.index.pending });
    if (current.error) out.push({ key: 'error', type: 'note', label: `${m.searchFailed}: ${current.error}`, error: true });
    if (!out.some(selectable) && !pending && !current.error) out.push({ key: 'none', type: 'note', label: m.noMatches });
    return out;
  }, [tab, parsed.name, parsed.line, parsed.column, needle, fetchKey, found, recent, actions, activeFile, m]);

  const choices = useMemo(() => rows.map((row, index) => (selectable(row) ? index : -1)).filter((index) => index >= 0), [rows]);
  const [activeAt, setActiveAt] = useState(0);
  useEffect(() => setActiveAt(0), [tab, needle, found]);
  const activeIndex = choices[Math.min(activeAt, choices.length - 1)];
  const activeRow = activeIndex === undefined ? undefined : rows[activeIndex];
  useEffect(() => { if (activeIndex !== undefined) document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' }); }, [activeIndex]);

  // The preview follows the selected hit a moment later, so holding an arrow key does not load every file it passes.
  const [preview, setPreview] = useState<SearchHit>();
  const activeHit = activeRow?.type === 'hit' ? activeRow.hit : undefined;
  useEffect(() => {
    const timer = window.setTimeout(() => setPreview(activeHit), 120);
    return () => window.clearTimeout(timer);
  }, [activeHit]);

  const pick = (row: Row | undefined) => {
    if (!row) return;
    const at = parsed.line !== undefined ? { line: parsed.line, ...(parsed.column !== undefined ? { column: parsed.column } : {}) } : {};
    switch (row.type) {
      case 'symbol': onPick({ path: row.symbol.path, line: row.symbol.line, column: row.symbol.column }); break;
      case 'file': onPick({ path: row.path, ...at }); break;
      case 'hit': onPick({ path: row.hit.path, line: row.hit.line }); break;
      case 'line': if (activeFile) onPick({ path: activeFile, line: row.line, ...(row.column !== undefined ? { column: row.column } : {}) }); break;
      case 'action': onOpenChange(false); row.action.run(); return;
      default: return;
    }
    onOpenChange(false);
  };

  const toggle = (key: 'matchCase' | 'word' | 'regex') => onOptionsChange({ ...options, [key]: !options[key] });
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const move = (by: number) => { event.preventDefault(); if (choices.length) setActiveAt((at) => (by === Infinity ? choices.length - 1 : by === -Infinity ? 0 : (Math.min(at, choices.length - 1) + by + choices.length) % choices.length)); };
    if (event.key === 'ArrowDown') return move(1);
    if (event.key === 'ArrowUp') return move(-1);
    if (event.key === 'PageDown') return move(PAGE);
    if (event.key === 'PageUp') return move(-PAGE);
    if (event.key === 'Tab') {
      event.preventDefault();
      onTabChange(TABS[(TABS.indexOf(tab) + (event.shiftKey ? TABS.length - 1 : 1)) % TABS.length]!);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (tab === 'text' && (event.metaKey || event.ctrlKey)) { if (query.trim()) { onTextResults(query); onOpenChange(false); } return; }
      pick(activeRow);
      return;
    }
    // ⌥C, ⌥W, ⌥X toggle the text options, as in the IDE's find dialog; by physical key, since ⌥ changes `key` on a Mac.
    if (tab === 'text' && event.altKey && !event.metaKey && !event.ctrlKey) {
      const key = event.code === 'KeyC' ? 'matchCase' : event.code === 'KeyW' ? 'word' : event.code === 'KeyX' ? 'regex' : undefined;
      if (key) { event.preventDefault(); toggle(key); }
    }
  };

  if (!ui.QuickPanel) return null;
  const textTools = tab === 'text' && (
    <>
      {([['matchCase', m.matchCase, 'case-sensitive', '⌥C'], ['word', m.wholeWord, 'whole-word', '⌥W'], ['regex', m.regex, 'regex', '⌥X']] as const).map(([key, label, icon, kbd]) => {
        const Icon = ui.icon(icon);
        return (
          <ui.Tip key={key} label={label} kbd={kbd}>
            <ui.Button size="icon-xs" variant={options[key] ? 'secondary' : 'quiet'} aria-label={label} aria-pressed={options[key]} onClick={() => toggle(key)}><Icon /></ui.Button>
          </ui.Tip>
        );
      })}
      <ui.Input aria-label={m.mask} placeholder={m.maskPlaceholder} value={options.mask} onChange={(event) => onOptionsChange({ ...options, mask: event.target.value })} className="h-7 w-32 text-xs" />
      {ui.Menu ? (
        <ui.Menu
          align="end"
          trigger={<ui.Button size="xs" variant="quiet">{options.scope === 'module' && module !== undefined ? m.scope.module : m.scope.project}</ui.Button>}
          entries={[
            { kind: 'radio', label: m.scope.project, checked: options.scope !== 'module' || module === undefined, onSelect: () => onOptionsChange({ ...options, scope: 'project' }) },
            { kind: 'radio', label: m.scope.module, checked: options.scope === 'module' && module !== undefined, disabled: module === undefined, onSelect: () => onOptionsChange({ ...options, scope: 'module' }) },
          ]}
        />
      ) : null}
    </>
  );

  return (
    <ui.QuickPanel
      open={open} onOpenChange={onOpenChange} title={m.search} focusToken={focusToken}
      query={query} onQueryChange={onQueryChange} placeholder={m.searchPlaceholder[tab]} onKeyDown={onKeyDown} busy={busy && Boolean(remote)}
      tabs={TABS.map((value) => ({ value, label: m.searchTabs[value] }))} tab={tab} onTabChange={(value) => onTabChange(value as SearchTab)}
      tools={textTools || undefined}
      listId={LIST_ID} {...(activeIndex !== undefined ? { activeId: optionId(activeIndex) } : {})} listLabel={m.searchTabs[tab]}
      {...(tab === 'text' && preview && ui.CodeFile ? { preview: <ui.CodeFile key={preview.path} projectId={projectId} path={preview.path} target={{ line: preview.line, token: preview.line }} /> } : {})}
    >
      {rows.map((row, index) => {
        if (row.type === 'heading') return <div key={row.key} className="px-3 pb-1 pt-2 text-xs text-fg-4">{row.label}</div>;
        if (row.type === 'note') return <p key={row.key} className={cn('px-3 py-3 text-center text-xs', row.error ? 'text-danger' : 'text-fg-3')}>{row.label}</p>;
        return (
          <div
            key={row.key} id={optionId(index)} role="option" aria-selected={index === activeIndex}
            onMouseMove={() => { const at = choices.indexOf(index); if (at >= 0 && at !== activeAt) setActiveAt(at); }}
            onClick={() => pick(row)}
            className={cn('flex h-8 cursor-default items-center gap-2.5 rounded-lg px-3', index === activeIndex && 'bg-active')}
          >
            <RowBody row={row} needle={needle} options={options} messages={m} />
          </div>
        );
      })}
    </ui.QuickPanel>
  );
}

const KIND_TYPES = new Set(['class', 'interface', 'object', 'enum', 'annotation', 'typealias']);
const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD_ENTER = isApple ? '⌘↵' : 'Ctrl+↵';
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function RowBody({ row, needle, options, messages: m }: { row: Row; needle: string; options: TextOptions; messages: Messages }) {
  const { ui } = usePluginHost();
  const name = needle.trim();
  switch (row.type) {
    case 'symbol': {
      const { symbol } = row;
      return (
        <>
          <span className="w-4 shrink-0 text-center font-mono text-2xs text-fg-3">{KIND_MARK[symbol.kind] ?? '·'}</span>
          <span className="shrink-0 truncate text-sm text-fg">{marked(symbol.name, name)}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-fg-4">{[symbol.container, symbol.package].filter(Boolean).join(' · ')}</span>
          <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-4">{fileName(symbol.path)}:{symbol.line}</span>
        </>
      );
    }
    case 'file':
      return (
        <>
          {ui.FileIcon && <ui.FileIcon name={fileName(row.path)} className="size-4 shrink-0" />}
          <span className="shrink-0 truncate text-sm text-fg">{marked(fileName(row.path), name)}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-fg-4" dir="rtl"><bdi>{dirName(row.path)}</bdi></span>
        </>
      );
    case 'hit':
      return (
        <>
          {ui.FileIcon && <ui.FileIcon name={fileName(row.hit.path)} className="size-4 shrink-0" />}
          <code className="min-w-0 flex-1 truncate whitespace-pre font-mono text-xs text-fg-2">{marked(row.hit.text.trim(), needle, options)}</code>
          <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-4">{fileName(row.hit.path)}:{row.hit.line}</span>
        </>
      );
    case 'action':
      return <>{row.action.icon && <span className="grid size-4 shrink-0 place-items-center text-fg-3 [&_svg]:size-4">{row.action.icon}</span>}<span className="min-w-0 flex-1 truncate text-sm text-fg">{row.action.label}</span></>;
    case 'line':
      return <span className="min-w-0 flex-1 truncate text-sm text-fg">{m.goToLine(row.line)}</span>;
    default:
      return null;
  }
}
