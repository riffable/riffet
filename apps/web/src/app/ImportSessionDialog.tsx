import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { ExternalSession, ExternalSessionDirectory, NativeBackendId, Session } from '@contracts';
import { AgentLogo } from '@/components/AgentLogo';
import { IconArrowLeft, IconChevronRight, IconFolder, IconListFilter, IconSearch, IconTriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner, UnderlineTabs } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, type ProjectRecord } from '@/lib/api';
import { agentMarkStyle, useBackendLabel } from '@/lib/backends';
import { cn, errorMessage, relativeTime, tildePath } from '@/lib/utils';
import { isComposingKey } from './session/composerKeyboard';
import { QuickInput } from './SessionSearchDialog';

type Scope = 'project' | 'directory' | 'all';
/** The agents whose conversations the server can read from disk. */
const AGENTS: NativeBackendId[] = ['claude', 'codex'];
const PAGE = 30;
const LIST_ID = 'import-session-results';
const optionId = (index: number) => `import-session-result-${index}`;

/**
 * Conversations the agents' own CLIs stored on the server's machine (docs/TERMINAL-SESSIONS.md).
 * Choosing one imports it.
 */
export function ImportSessionDialog({ open, onOpenChange, project, onImported, onError }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set when opened from a project: the picker starts on that project's directory. */
  project: ProjectRecord | undefined;
  onImported: (session: Session) => Promise<void>;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        mobileSheet
        size="content"
        className="top-[6%] flex max-h-[calc(94dvh-16px)] translate-y-0 flex-col gap-0 overflow-hidden p-0"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}
      >
        <DialogTitle className="sr-only"><Trans>从终端导入…</Trans></DialogTitle>
        <ImportList project={project} inputRef={inputRef} onImported={onImported} onError={onError} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ImportList({ project, inputRef, onImported, onError, onDone }: {
  project: ProjectRecord | undefined;
  inputRef: RefObject<HTMLInputElement | null>;
  onImported: (session: Session) => Promise<void>;
  onError: (message: string) => void;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const label = useBackendLabel();
  const [scope, setScope] = useState<Scope>(project ? 'project' : 'all');
  const [query, setQuery] = useState('');
  const [needle, setNeedle] = useState('');
  const [backendId, setBackendId] = useState('');
  const [nonInteractive, setNonInteractive] = useState(false);
  /** The directory whose conversations the directory scope is showing. */
  const [browsing, setBrowsing] = useState<ExternalSessionDirectory>();
  const [sessions, setSessions] = useState<ExternalSession[]>([]);
  const [directories, setDirectories] = useState<ExternalSessionDirectory[]>([]);
  const [failures, setFailures] = useState<Array<{ backendId: NativeBackendId; message: string }>>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState<string>();
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const loadingMore = useRef(false);
  const generation = useRef(0);
  const showDirectories = scope === 'directory' && !browsing;
  const projectId = project?.id;

  useEffect(() => {
    const timer = window.setTimeout(() => setNeedle(query.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  const request = useCallback((signal: AbortSignal, next?: string) => api.externalSessions({
    scope: scope === 'project' && !projectId ? 'all' : scope,
    ...(scope === 'project' && projectId ? { projectId } : {}),
    ...(scope === 'directory' && browsing ? { cwd: browsing.cwd } : {}),
    ...(backendId ? { backendId } : {}),
    ...(needle ? { q: needle } : {}),
    ...(next ? { cursor: next } : {}),
    limit: PAGE,
    nonInteractive,
  }, signal), [scope, projectId, browsing, backendId, needle, nonInteractive]);

  useEffect(() => {
    const controller = new AbortController();
    generation.current += 1;
    loadingMore.current = false;
    setLoading(true);
    setActive(0);
    if (listRef.current) listRef.current.scrollTop = 0;
    const done = (action: () => void) => { if (!controller.signal.aborted) { action(); setLoading(false); } };
    if (showDirectories) {
      api.externalSessionDirectories({ ...(backendId ? { backendId } : {}), nonInteractive }, controller.signal)
        .then((found) => done(() => { setDirectories(found); setFailures([]); }))
        .catch((error) => done(() => { setDirectories([]); onError(errorMessage(error, t`无法读取终端会话`)); }));
    } else {
      request(controller.signal)
        .then((page) => done(() => { setSessions(page.items); setCursor(page.nextCursor); setFailures(page.failures ?? []); }))
        .catch((error) => done(() => { setSessions([]); setCursor(undefined); onError(errorMessage(error, t`无法读取终端会话`)); }));
    }
    return () => controller.abort();
    // `t` and `onError` change identity without changing what is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDirectories, request, backendId, nonInteractive]);

  const loadMore = () => {
    if (!cursor || loading || loadingMore.current) return;
    loadingMore.current = true;
    const started = generation.current;
    request(new AbortController().signal, cursor)
      .then((page) => {
        if (started !== generation.current) return;
        setSessions((current) => [...current, ...page.items]);
        setCursor(page.nextCursor);
      })
      .catch((error) => { if (started === generation.current) onError(errorMessage(error, t`无法读取终端会话`)); })
      .finally(() => { if (started === generation.current) loadingMore.current = false; });
  };

  const rows = useMemo(() => {
    if (!showDirectories) return [];
    const text = needle.toLocaleLowerCase();
    return directories.filter((item) => !text || item.cwd.toLocaleLowerCase().includes(text)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [showDirectories, directories, needle]);

  const count = showDirectories ? rows.length : sessions.length;
  const activeIndex = count ? Math.min(active, count - 1) : 0;
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, count]);

  const choose = async (index: number) => {
    if (showDirectories) {
      const directory = rows[index];
      if (directory?.exists) { setBrowsing(directory); setQuery(''); setNeedle(''); }
      return;
    }
    const item = sessions[index];
    if (!item || !item.cwdExists || importing) return;
    setImporting(item.nativeSessionId);
    try {
      const result = await api.importExternalSession({ backendId: item.backendId, backendProfileId: item.backendProfileId, nativeSessionId: item.nativeSessionId });
      await onImported(result.session);
      onDone();
    } catch (error) {
      onError(errorMessage(error, t`无法导入会话`));
    } finally { setImporting(undefined); }
  };

  const changeScope = (next: Scope) => { setScope(next); setBrowsing(undefined); setQuery(''); setNeedle(''); inputRef.current?.focus(); };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposingKey(event.nativeEvent)) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (count) setActive((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void choose(activeIndex);
    } else if (event.key === 'Backspace' && !query && browsing) setBrowsing(undefined);
  };

  const showCwd = scope !== 'project' && !browsing;
  const busy = loading || Boolean(importing);
  return (
    <>
      <QuickInput
        inputRef={inputRef}
        aria-controls={LIST_ID}
        aria-activedescendant={count ? optionId(activeIndex) : undefined}
        aria-label={t`搜索终端会话`}
        placeholder={showDirectories ? t`搜索目录` : t`搜索终端会话`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        trailing={busy && <Spinner />}
      />
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 edge-b px-3">
        {browsing
          ? <button type="button" aria-label={t`返回`} onClick={() => { setBrowsing(undefined); inputRef.current?.focus(); }} className="-mx-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-fg-3 hover:bg-hover hover:text-fg-2"><IconArrowLeft className="size-3 shrink-0" /><span className="truncate">{tildePath(browsing.cwd)}</span></button>
          : <UnderlineTabs<Scope>
            value={scope}
            onChange={changeScope}
            ariaLabel={t`导入范围`}
            options={[
              ...(project ? [{ value: 'project' as const, label: t`当前项目` }] : []),
              { value: 'directory', label: t`目录` },
              { value: 'all', label: t`全部` },
            ]}
          />}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="quiet" size="icon-sm" aria-label={t`筛选`} className={cn((backendId || nonInteractive) && 'text-fg')}><IconListFilter /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}>
            <DropdownMenuLabel>Agent</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={backendId} onValueChange={setBackendId}>
              <DropdownMenuRadioItem value=""><Trans>全部</Trans></DropdownMenuRadioItem>
              {AGENTS.map((id) => (
                <DropdownMenuRadioItem key={id} value={id}><AgentLogo backend={id} size={14} className="size-3.5" style={agentMarkStyle(id)} />{label(id)}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={nonInteractive} onCheckedChange={(value) => setNonInteractive(value === true)}><Trans>含非交互</Trans></DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div
        ref={listRef}
        id={LIST_ID}
        role="listbox"
        aria-label={t`终端会话`}
        aria-busy={busy}
        // Taller than the search palette's list: browsing a long history is the point here.
        className="min-h-0 h-[min(680px,72dvh)] shrink overflow-y-auto p-2"
        onScroll={(event) => { const el = event.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) loadMore(); }}
      >
        {!showDirectories && failures.map((failure) => (
          <div key={failure.backendId} role="status" title={failure.message} className="flex items-center gap-2 px-3 py-1.5 text-xs text-fg-4"><IconTriangleAlert className="size-3.5 shrink-0" /><span className="truncate"><Trans>{label(failure.backendId)} 读取失败</Trans></span></div>
        ))}
        {showDirectories
          ? rows.map((directory, index) => (
            <div
              key={directory.cwd}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              aria-disabled={!directory.exists}
              data-index={index}
              onClick={() => void choose(index)}
              onPointerMove={() => { if (index !== activeIndex) setActive(index); }}
              className={cn('flex h-9 cursor-default items-center gap-3 rounded-lg px-3', index === activeIndex && 'bg-active', !directory.exists && 'opacity-45')}
            >
              <IconFolder aria-hidden className="size-4 shrink-0 text-fg-4" />
              <span className="min-w-0 flex-1 truncate text-sm text-fg" title={directory.cwd}>{tildePath(directory.cwd)}</span>
              {!directory.projectId && <span className="shrink-0 text-2xs text-fg-4"><Trans>新项目</Trans></span>}
              <span className="shrink-0 text-2xs tabular-nums text-fg-4">{directory.count}</span>
              <span className="shrink-0 text-2xs text-fg-4">{relativeTime(directory.updatedAt)}</span>
              <IconChevronRight aria-hidden className="size-3.5 shrink-0 text-fg-4" />
            </div>
          ))
          : sessions.map((item, index) => {
            const meta = [showCwd ? tildePath(item.cwd) : '', item.gitBranch ?? ''].filter(Boolean).join(' · ');
            return (
              <div
                key={`${item.backendId}:${item.backendProfileId}:${item.nativeSessionId}`}
                id={optionId(index)}
                role="option"
                aria-selected={index === activeIndex}
                aria-disabled={!item.cwdExists}
                data-index={index}
                onClick={() => void choose(index)}
                onPointerMove={() => { if (index !== activeIndex) setActive(index); }}
                className={cn('flex h-9 cursor-default items-center gap-3 rounded-lg px-3', index === activeIndex && 'bg-active', !item.cwdExists && 'opacity-45', importing === item.nativeSessionId && 'opacity-70')}
              >
                <span className="shrink-0" title={label(item.backendId)}><AgentLogo backend={item.backendId} size={14} className="text-fg-3" style={agentMarkStyle(item.backendId)} /></span>
                {/* One line per conversation, so a screen holds a long stretch of history. */}
                <span className="min-w-0 max-w-[60%] shrink truncate text-sm text-fg" title={item.preview ?? item.title}>{item.title}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-fg-4" title={item.cwd}>{meta}</span>
                {item.live === 'terminal' && <span className="shrink-0 text-2xs text-warning"><Trans>在终端中</Trans></span>}
                <span className="w-14 shrink-0 text-right text-2xs tabular-nums text-fg-4">{relativeTime(item.updatedAt)}</span>
              </div>
            );
          })}
        {cursor && !loading && <div className="flex h-8 items-center justify-center"><Spinner /></div>}
        {!count && (
          <div role="status" className="flex h-full flex-col items-center justify-center gap-3 pb-6 text-sm text-fg-4">
            {loading ? <Spinner className="size-6" /> : <IconSearch aria-hidden className="size-6" />}
            <span>{loading ? t`搜索中…` : needle ? t`没有匹配的结果` : t`没有可导入的会话`}</span>
          </div>
        )}
      </div>
    </>
  );
}
