import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { FileEntry, SearchHit } from '@contracts';
import { IconSearch } from '@/components/icons';
import { Spinner, UnderlineTabs } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { cn, errorMessage } from '@/lib/utils';
import { isComposingKey } from '../session/composerKeyboard';
import { QuickInput, quickListClass } from '../SessionSearchDialog';
import { DirectoryHint, FileIcon, Matched, splitPath } from './fileVisuals';

export type QuickOpenMode = 'name' | 'content';
const LIST_ID = 'quick-open-list';
const optionId = (index: number) => `quick-open-option-${index}`;
/** Names follow the typing; content waits for Enter, since a rare word reads every file of a large repo. */
const NAME_DELAY_MS = 120;

interface Row { key: string; run: () => void; body: ReactNode }

/**
 * Go to File over the panel's wide layout, as VS Code's quick open and Studio's Search Everywhere
 * are: the file tree stays where it was, the query box keeps focus, and the arrow keys and Enter
 * pick. Opened empty it lists the files viewed last; Tab moves between names and content.
 */
export function QuickOpen({ open, onOpenChange, projectId, mode: initialMode, recent, current, onOpenFile, onShowFolder, onError }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  mode: QuickOpenMode;
  /** Recently viewed paths, newest first. */
  recent: string[];
  current?: string | undefined;
  onOpenFile: (path: string, line?: number) => void;
  onShowFolder: (path: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<QuickOpenMode>(initialMode);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<FileEntry[]>();
  const [hits, setHits] = useState<{ query: string; hits: SearchHit[] }>();
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const request = useRef(0);
  /** The content search in flight, aborted by a newer one or by closing, so the server stops reading. */
  const contentAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => { if (!open) { request.current += 1; contentAbort.current?.abort(); setSearching(false); } }, [open]);
  const needle = query.trim();

  useEffect(() => { if (open) { setMode(initialMode); setActive(0); } }, [open, initialMode]);

  useEffect(() => {
    if (!open || mode !== 'name' || !needle) { setFound(undefined); return; }
    const timer = window.setTimeout(() => {
      const id = ++request.current;
      setSearching(true);
      void api.find(projectId, needle).then((result) => {
        if (id === request.current) { setFound(Array.isArray(result) ? result : result.entries ?? []); setActive(0); }
      }).catch((error) => { if (id === request.current) onError(errorMessage(error, t`搜索失败`)); })
        .finally(() => { if (id === request.current) setSearching(false); });
    }, NAME_DELAY_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` and `onError` only report a failure.
  }, [open, mode, needle, projectId]);

  const searchContent = () => {
    const id = ++request.current;
    contentAbort.current?.abort();
    contentAbort.current = new AbortController();
    setSearching(true);
    void api.search(projectId, needle, contentAbort.current.signal).then((result) => {
      if (id === request.current) { setHits({ query: needle, hits: result }); setActive(0); }
    }).catch((error) => { if (id === request.current) onError(errorMessage(error, t`搜索失败`)); })
      .finally(() => { if (id === request.current) setSearching(false); });
  };

  const close = (then: () => void) => { onOpenChange(false); then(); };
  const fileRow = (key: string, path: string, kind: FileEntry['kind'], line?: number, extra?: ReactNode): Row => {
    const { name, dir } = splitPath(path);
    return {
      key,
      run: () => close(() => (kind === 'directory' ? onShowFolder(path) : onOpenFile(path, line))),
      body: (
        <>
          <FileIcon entry={{ kind, name }} />
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="shrink-0 truncate text-sm text-fg-2"><Matched text={name} query={mode === 'name' ? query : ''} /></span>
            {line !== undefined && <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-4">{line}</span>}
            {extra ?? <DirectoryHint dir={dir} />}
          </span>
          {path === current && <span className="shrink-0 text-2xs text-fg-4"><Trans>当前</Trans></span>}
        </>
      ),
    };
  };

  let rows: Row[];
  let heading: ReactNode = null;
  if (mode === 'name') {
    if (!needle) { rows = recent.map((path) => fileRow(path, path, 'file')); if (rows.length) heading = <Trans>最近查看</Trans>; }
    else rows = (found ?? []).map((entry) => fileRow(entry.path, entry.path, entry.kind));
  } else if (hits && hits.query === needle) {
    rows = hits.hits.map((hit, index) => fileRow(`${hit.path}:${hit.line}:${index}`, hit.path, 'file', hit.line, <Snippet text={hit.text} needle={needle} />));
  } else {
    rows = needle ? [{ key: 'search', run: searchContent, body: <><IconSearch className="size-4 shrink-0 text-fg-4" /><span className="min-w-0 flex-1 truncate text-sm text-fg"><Trans>在文件内容中搜索「{needle}」</Trans></span></> }] : [];
  }
  const activeIndex = rows.length ? Math.min(active, rows.length - 1) : 0;
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, rows.length]);

  const switchMode = (next: QuickOpenMode) => { request.current += 1; setSearching(false); setMode(next); setActive(0); inputRef.current?.focus(); };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposingKey(event.nativeEvent)) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length) setActive((event.key === 'ArrowDown' ? activeIndex + 1 : activeIndex - 1 + rows.length) % rows.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      rows[activeIndex]?.run();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      switchMode(mode === 'name' ? 'content' : 'name');
    }
  };

  const empty = !searching && needle && (mode === 'name' ? found !== undefined : hits?.query === needle) && !rows.length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[10%] max-h-[calc(88dvh-16px)] max-w-[680px] translate-y-0 gap-0 overflow-hidden p-0"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); }}
        onEscapeKeyDown={(event) => { if (event.isComposing || event.keyCode === 229) event.preventDefault(); }}
      >
        <DialogTitle className="sr-only"><Trans>搜索文件</Trans></DialogTitle>
        <QuickInput
          inputRef={inputRef}
          aria-controls={LIST_ID}
          aria-activedescendant={rows[activeIndex] ? optionId(activeIndex) : undefined}
          aria-label={mode === 'name' ? t`按文件名查找` : t`搜索文件内容`}
          placeholder={mode === 'name' ? t`按文件名查找` : t`搜索文件内容`}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={onKeyDown}
          trailing={searching && <Spinner />}
        />
        <div className="flex h-10 shrink-0 items-center gap-3 edge-b px-3">
          <UnderlineTabs<QuickOpenMode> value={mode} onChange={switchMode} ariaLabel={t`搜索方式`} options={[{ value: 'name', label: t`文件名` }, { value: 'content', label: t`内容` }]} />
          <span className="ml-auto text-2xs text-fg-4">Tab</span>
        </div>
        <div ref={listRef} id={LIST_ID} role="listbox" aria-label={t`搜索结果`} aria-busy={searching} className={quickListClass}>
          {heading && <div className="px-3 pb-1 pt-2 text-xs text-fg-4">{heading}</div>}
          {rows.map((row, index) => (
            <div
              key={row.key} id={optionId(index)} role="option" aria-selected={index === activeIndex} data-index={index}
              onClick={row.run} onPointerMove={() => { if (index !== activeIndex) setActive(index); }}
              className={cn('flex min-h-9 cursor-default items-center gap-2.5 rounded-lg px-3 py-1', index === activeIndex && 'bg-active')}
            >{row.body}</div>
          ))}
          {empty && <p className="px-3 py-8 text-center text-sm text-fg-3"><Trans>没有找到匹配项</Trans></p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A content hit's line, trimmed, with the first occurrence of the query set apart. */
function Snippet({ text, needle }: { text: string; needle: string }) {
  const line = text.trim();
  const at = line.toLowerCase().indexOf(needle.toLowerCase());
  return (
    <code className="min-w-0 truncate whitespace-pre font-mono text-xs text-fg-3">
      {at < 0 ? line : <>{line.slice(0, at)}<span className="rounded-sm bg-accent-soft text-fg">{line.slice(at, at + needle.length)}</span>{line.slice(at + needle.length)}</>}
    </code>
  );
}
