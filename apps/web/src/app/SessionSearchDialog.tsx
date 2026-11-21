import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Session } from '@contracts';
import { IconMessagesSquare, IconSearch } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner, UnderlineTabs } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { MessageSearchHit, ProjectRecord } from '@/lib/api';
import { sidebarProjectMap } from '@/lib/project-family';
import { sessionActivityAt, sortSessionsByActivity } from '@/lib/session-order';
import { createTitleMatcher } from '@/lib/title-search';
import { useMessageSearch } from '@/lib/use-message-search';
import { useListWindow } from '@/lib/use-list-window';
import { serverOfObject } from '@/lib/server-routing';
import { cn, relativeTime } from '@/lib/utils';
import { isComposingKey } from './session/composerKeyboard';
import { useLists } from './state/stores';
import { ServerTag } from './useServerLabel';

export interface SessionSearchProps {
  sessions: Session[];
  projects: ProjectRecord[];
  currentSessionId?: string;
  onSelectSession: (session: Session) => void;
  onOpenMessage: (hit: MessageSearchHit) => void;
}

type SearchMode = 'title' | 'content';
const LIST_ID = 'session-search-results';
const optionId = (index: number) => `session-search-result-${index}`;

/** The query row both scopes of the palette type into: one height, one icon, clear of the close button. */
export function QuickInput({ inputRef, trailing, className, ...props }: ComponentProps<'input'> & { inputRef: RefObject<HTMLInputElement | null>; trailing?: ReactNode }) {
  return (
    // As tall as the dialog's close button sits low (44px at 8px on a phone, 28px at 12px on a
    // desktop), so the query and the × share one center line.
    <div className={cn('flex h-15 shrink-0 items-center gap-3 pl-5 pr-14 md:h-13 md:pr-12', className)}>
      <IconSearch aria-hidden className="size-4.5 shrink-0 text-fg-3" />
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded
        aria-autocomplete="list"
        className="h-full min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-4"
        {...props}
      />
      {trailing}
    </div>
  );
}

/** The list area of either scope: the same height, so switching scope does not resize the dialog. */
export const quickListClass = 'min-h-0 h-[min(480px,56dvh)] shrink overflow-y-auto p-2';

/** Conversations the content-search scope menu lists besides the current one; older ones are a title search away. */
const SCOPE_MENU_SESSIONS = 100;
/** The command scope has no 标题 / 内容 row (h-10), so its list takes that height back. */
export const quickListTallClass = 'min-h-0 h-[calc(min(480px,56dvh)+2.5rem)] shrink overflow-y-auto p-2';

/**
 * Conversations by title, or by what was said in them. A separate search surface: opening or
 * filtering it never rearranges the sidebar.
 */
export function SessionSearchResults({ open, sessions, projects, currentSessionId, onSelectSession, onOpenMessage, onCommandMode, inputRef, onNavigate }: SessionSearchProps & {
  /** False during the exit animation, which still shows the last results. */
  open: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onNavigate: () => void;
  /** A title query that starts with `>` belongs to the command scope, as in VS Code's quick open. */
  onCommandMode: (query: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('title');
  const [scope, setScope] = useState('');
  const [active, setActive] = useState(0);
  const { t } = useLingui();
  const listRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const needle = query.trim();
  const projectMap = useMemo(() => sidebarProjectMap(projects, true), [projects]);
  const ordered = useMemo(() => sortSessionsByActivity(sessions), [sessions]);
  const titles = useMemo(() => {
    if (!needle) return ordered.filter((session) => !session.archivedAt).slice(0, 12);
    const scoreTitle = createTitleMatcher(needle);
    return ordered.flatMap((session) => {
      const score = scoreTitle(session.title);
      return score === undefined ? [] : [{ session, score }];
    }).sort((left, right) => left.score - right.score).map(({ session }) => session);
  }, [ordered, needle]);
  const linkedStatus = useLists((state) => state.linkedStatus);
  const linked = useMemo(() => Object.keys(linkedStatus).filter((id) => linkedStatus[id] !== 'offline'), [linkedStatus]);
  const found = useMessageSearch(open && mode === 'content' ? needle : '', scope || undefined, linked);
  // A linked server's own system conversations (its assistant, quick chats) are not in this workbench's lists.
  const search = useMemo(() => linked.length ? { ...found, hits: found.hits.filter((hit) => !serverOfObject(hit.projectId) || projectMap.has(hit.projectId)) } : found, [found, linked.length, projectMap]);
  const lastMessages = useRef(search);
  useLayoutEffect(() => { if (open) lastMessages.current = search; }, [open, search]);
  // Stop the search immediately, but leave its last result visible for the dialog's exit.
  const messages = open ? search : lastMessages.current;
  const content = mode === 'content';
  /** No title matches: the one row offered is the same query against the conversations' content. */
  const offerContent = !content && Boolean(needle) && !titles.length;
  const count = content ? messages.hits.length : offerContent ? 1 : titles.length;
  const busy = content && (messages.stale || messages.pending > 0);
  const activeIndex = count ? Math.min(active, count - 1) : 0;
  const scopeSession = sessions.find((session) => session.id === scope);
  const currentSession = sessions.find((session) => session.id === currentSessionId);

  useEffect(() => {
    setActive(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query, mode, scope]);
  // A broad title query matches thousands of conversations: only rows near the viewport mount.
  const rowKind = useCallback(() => 'title', []);
  const rowHeight = useCallback(() => 66, []);
  const titleRows = useListWindow({ count: content || offerContent ? 0 : titles.length, kindOf: rowKind, estimate: rowHeight, scroller: listRef, list: rowsRef });
  const { reveal } = titleRows;
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' }); else reveal(activeIndex);
  }, [activeIndex, count, reveal]);

  const select = (index: number) => {
    if (offerContent) { setMode('content'); inputRef.current?.focus(); return; }
    const hit = content ? messages.hits[index] : undefined;
    const session = content ? undefined : titles[index];
    if (!hit && !session) return;
    onNavigate();
    if (hit) onOpenMessage(hit);
    else if (session) onSelectSession(session);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposingKey(event.nativeEvent)) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (count) setActive((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      select(activeIndex);
    }
  };
  const row = (index: number, id: string, title: string, projectId: string, at: string, archived: boolean, snippet?: string) => (
    <div
      key={id}
      ref={snippet === undefined ? titleRows.measure(index) : undefined}
      id={optionId(index)}
      role="option"
      aria-selected={index === activeIndex}
      data-index={index}
      onClick={() => select(index)}
      onPointerMove={() => { if (index !== activeIndex) setActive(index); }}
      className={cn('flex cursor-default items-start gap-3 rounded-lg px-3 py-2.5', index === activeIndex && 'bg-active')}
    >
      <IconMessagesSquare aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-4" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-sm text-fg">{content ? title : highlight(title, needle)}</span>
          <span className="shrink-0 text-2xs text-fg-4">{relativeTime(at)}</span>
        </div>
        {snippet && <p className="mt-1 line-clamp-2 break-words text-sm leading-6 text-fg-2">{highlight(snippet, needle)}</p>}
        <div className="mt-1 flex items-center gap-2 text-xs text-fg-4">
          <ServerTag objectId={projectId} className="max-w-[40%] shrink-0 truncate" />
          <span className="truncate">{projectMap.get(projectId)?.name}</span>
          {archived && <span className="shrink-0"><Trans>已归档</Trans></span>}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <QuickInput
        inputRef={inputRef}
        aria-controls={LIST_ID}
        aria-activedescendant={count ? optionId(activeIndex) : undefined}
        aria-label={content ? t`搜索会话内容` : t`搜索会话标题`}
        placeholder={content ? t`搜索会话内容` : t`搜索会话标题`}
        value={query}
        onChange={(event) => {
          const value = event.target.value;
          if (!content && value.startsWith('>')) { onCommandMode(value.slice(1).trimStart()); return; }
          setQuery(value);
        }}
        onKeyDown={onKeyDown}
        trailing={busy && <Spinner />}
      />
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 edge-b px-3">
        <UnderlineTabs<SearchMode>
          value={mode}
          onChange={(value) => { setMode(value); inputRef.current?.focus(); }}
          ariaLabel={t`搜索字段`}
          options={[{ value: 'title', label: t`标题` }, { value: 'content', label: t`内容` }]}
        />
        {content && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="quiet" size="sm" className="max-w-[55%]" aria-label={t`选择搜索会话`}>
                <span className="truncate">{scopeSession?.title || t`全部会话`}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 max-w-80" onCloseAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}>
              <DropdownMenuRadioGroup value={scope} onValueChange={setScope}>
                <DropdownMenuRadioItem value=""><Trans>全部会话</Trans></DropdownMenuRadioItem>
                {currentSession && <DropdownMenuRadioItem value={currentSession.id} textValue={currentSession.title}><span className="truncate"><Trans>当前会话 · {currentSession.title}</Trans></span></DropdownMenuRadioItem>}
                <DropdownMenuSeparator />
                {ordered.filter((session) => session.id !== currentSessionId).slice(0, SCOPE_MENU_SESSIONS).map((session) => (
                  <DropdownMenuRadioItem key={session.id} value={session.id} textValue={session.title}><span className="truncate">{session.title}</span></DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div ref={listRef} id={LIST_ID} role="listbox" aria-label={t`搜索结果`} aria-busy={busy} className={quickListClass}>
        {!content && !needle && titles.length > 0 && <div className="px-3 pb-1 pt-2 text-xs text-fg-4"><Trans>最近会话</Trans></div>}
        {content
          ? messages.hits.map((hit, index) => row(index, `${hit.sessionId}:${hit.messageId}`, hit.sessionTitle, hit.projectId, hit.at, hit.archived, hit.snippet))
          : offerContent
            ? (
              <div id={optionId(0)} role="option" aria-selected data-index={0} onClick={() => select(0)} className="flex cursor-default items-center gap-3 rounded-lg bg-active px-3 py-2.5 text-sm text-fg">
                <IconSearch aria-hidden className="size-4 shrink-0 text-fg-4" />
                <span className="min-w-0 flex-1 truncate"><Trans>在内容中搜索「{needle}」</Trans></span>
              </div>
            )
            : (
              <div ref={rowsRef} role="presentation" style={{ paddingTop: titleRows.padTop, paddingBottom: titleRows.padBottom }}>
                {titles.slice(titleRows.from, titleRows.to).map((session, offset) => row(titleRows.from + offset, session.id, session.title, session.projectId, sessionActivityAt(session), Boolean(session.archivedAt)))}
              </div>
            )}
        {!count && (!content || needle) && <div role="status" className="flex h-full flex-col items-center justify-center gap-3 pb-6 text-sm text-fg-4">
          {busy ? <Spinner className="size-6" /> : <IconSearch aria-hidden className="size-6" />}
          <span>{busy ? t`搜索中…` : needle ? t`没有匹配的结果` : t`还没有会话`}</span>
        </div>}
      </div>
    </>
  );
}

function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const lower = text.toLocaleLowerCase(), needle = query.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (let start = lower.indexOf(needle); start !== -1; start = lower.indexOf(needle, cursor)) {
    parts.push(text.slice(cursor, start), <mark key={start} className="rounded-sm bg-accent-soft text-fg">{text.slice(start, start + query.length)}</mark>);
    cursor = start + query.length;
  }
  parts.push(text.slice(cursor));
  return parts;
}
