import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Session } from '@contracts';
import { IconFolderClosed, IconMessagesSquare } from '@/components/icons';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import type { ProjectRecord } from '@/lib/api';
import { matchCommands, type CommandCandidate, type CommandKind } from '@/lib/command-search';
import { sortSessionsByActivity } from '@/lib/session-order';
import { MOBILE_LAYOUT_QUERY } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';
import { isComposingKey } from './session/composerKeyboard';
import { QuickInput, quickListTallClass, SessionSearchResults, type SessionSearchProps } from './SessionSearchDialog';

/** One thing the palette can do. The workbench owns what a row runs; the palette only lists it. */
export interface PaletteAction {
  id: string;
  label: string;
  keywords?: string;
  /** Secondary text beside the label, such as the plugin a command comes from. */
  detail?: string;
  icon: ReactNode;
  run: () => void;
  /**
   * Runs once the palette has closed and would otherwise hand focus back to whatever opened it,
   * for an action whose whole point is to move focus somewhere.
   */
  takesFocus?: boolean;
}

interface ListProps {
  sessions: Session[];
  projects: ProjectRecord[];
  /** Read once per opening: the rows, their labels and what they run are the workbench as it was then. */
  actions: () => PaletteAction[];
  /** What the palette opens with, e.g. the rest of a search query that began with `>`. */
  initialQuery?: string;
  /** Runs the same selection path as the sidebar, so the selection mirror stays in step. */
  onSelectSession: (session: Session) => void;
  onSelectProject: (project: ProjectRecord) => void;
}

/** ⌘K searches conversations; `>` there, or ⇧⌘P, narrows the same palette to commands. */
export type PaletteScope = 'search' | 'commands';

interface Props extends ListProps {
  open: boolean;
  scope: PaletteScope;
  onOpenChange: (open: boolean) => void;
  /** Moves between the scopes; `query` is what the new scope starts with. */
  onScopeChange: (scope: PaletteScope, query: string) => void;
  search: SessionSearchProps;
}

const LIST_ID = 'command-palette-list';
const optionId = (index: number) => `command-palette-option-${index}`;

/**
 * One keyboard-first surface over everything the workbench already holds: conversations by title or
 * content, and in the command scope actions, conversations and projects. It reuses the dialog
 * primitive, so Escape and the browser back button dismiss it through the same overlay stack as every
 * other sheet, and focus never leaves the query box — the active row is tracked with
 * `aria-activedescendant` instead, which is what keeps typing from being interrupted.
 */
export function CommandPalette({ open, scope, onOpenChange, onScopeChange, search, ...list }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  /** A result opened somewhere else; focus is that place's to set. */
  const navigating = useRef(false);
  const afterClose = useRef<(() => void) | undefined>(undefined);
  // The dialog stays open across a scope switch, so its own autofocus does not run again.
  useEffect(() => { if (open) inputRef.current?.focus(); }, [scope]);

  const run = (handler: (() => void) | undefined, takesFocus: boolean) => {
    if (takesFocus) afterClose.current = handler;
    onOpenChange(false);
    if (!takesFocus) handler?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        mobileSheet
        size="content"
        className="top-[12%] max-h-[calc(88dvh-16px)] translate-y-0 gap-0 overflow-hidden p-0"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          navigating.current = false;
          previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          event.preventDefault();
          inputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const handler = afterClose.current;
          afterClose.current = undefined;
          if (handler) { handler(); return; }
          const previous = previousFocus.current;
          if (navigating.current || !previous?.isConnected || document.querySelector('[role="dialog"][data-state="open"]')) return;
          if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches && previous.matches('input, textarea, [contenteditable="true"]')) return;
          previous.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={(event) => { if (event.isComposing || event.keyCode === 229) event.preventDefault(); }}
      >
        <DialogTitle className="sr-only">{scope === 'commands' ? <Trans>命令面板</Trans> : <Trans>搜索会话</Trans>}</DialogTitle>
        {/* Content exists only while the dialog is shown, so a closed palette builds and ranks nothing
            and every opening starts over. */}
        {scope === 'commands'
          ? <PaletteList {...list} inputRef={inputRef} onRun={run} onLeave={() => onScopeChange('search', '')} />
          : (
            <SessionSearchResults
              {...search}
              open={open}
              inputRef={inputRef}
              onNavigate={() => { navigating.current = true; onOpenChange(false); }}
              onCommandMode={(query) => onScopeChange('commands', query)}
            />
          )}
      </DialogContent>
    </Dialog>
  );
}

function PaletteList({ sessions: liveSessions, projects: liveProjects, actions: readActions, initialQuery = '', onSelectSession, onSelectProject, inputRef, onRun, onLeave }: ListProps & {
  inputRef: RefObject<HTMLInputElement | null>;
  onRun: (handler: (() => void) | undefined, takesFocus: boolean) => void;
  /** Backspace in an empty query goes back to searching conversations, as deleting `>` would. */
  onLeave: () => void;
}) {
  // Frozen at open with the actions: live lists are activity-sorted, and rows would reorder under the keyboard.
  const [actions] = useState(readActions);
  const [sessions] = useState(liveSessions);
  const [projects] = useState(liveProjects);
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const { t } = useLingui();
  const KIND_LABEL: Record<CommandKind, string> = { command: t({ message: '命令', context: 'workbench-command-label' }), conversation: t({ message: '会话', context: 'workbench-session-noun' }), project: t`项目` };
  const listRef = useRef<HTMLDivElement>(null);

  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const candidates = useMemo<CommandCandidate[]>(() => [
    ...actions.map((action) => ({ id: `action:${action.id}`, kind: 'command' as const, label: action.label, ...(action.keywords ? { keywords: action.keywords } : {}), ...(action.detail ? { detail: action.detail } : {}) })),
    ...sortSessionsByActivity(sessions.filter((session) => !session.archivedAt)).map((session) => ({ id: `session:${session.id}`, kind: 'conversation' as const, label: session.title, keywords: (session.tags ?? []).join(' '), detail: projectNames.get(session.projectId) ?? '' })),
    ...projects.filter((project) => !project.archivedAt).map((project) => ({ id: `project:${project.id}`, kind: 'project' as const, label: project.name, keywords: project.cwd, detail: project.cwd })),
  ], [actions, sessions, projects, projectNames]);
  const matches = useMemo(() => matchCommands(candidates, query), [candidates, query]);

  const handleById = useMemo(() => {
    const handlers = new Map<string, () => void>();
    for (const action of actions) handlers.set(`action:${action.id}`, action.run);
    for (const session of sessions) handlers.set(`session:${session.id}`, () => onSelectSession(session));
    for (const project of projects) handlers.set(`project:${project.id}`, () => onSelectProject(project));
    return handlers;
  }, [actions, sessions, projects, onSelectSession, onSelectProject]);
  const actionById = useMemo(() => new Map(actions.map((action) => [`action:${action.id}`, action])), [actions]);

  // A shrinking result set must not leave the highlight past its end; deriving the index keeps Enter
  // correct in the render right after the query changed, before any effect has run.
  const activeIndex = matches.length ? Math.min(active, matches.length - 1) : 0;
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, matches]);

  const run = (candidate: CommandCandidate) => onRun(handleById.get(candidate.id), Boolean(actionById.get(candidate.id)?.takesFocus));

  const onQueryKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // An IME's Enter or arrow keys pick a candidate; they are not ours while a composition is open.
    if (isComposingKey(event.nativeEvent)) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => {
        if (!matches.length) return 0;
        const from = Math.min(current, matches.length - 1);
        return event.key === 'ArrowDown' ? (from + 1) % matches.length : (from - 1 + matches.length) % matches.length;
      });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const match = matches[activeIndex];
      if (match) run(match);
    } else if (event.key === 'Backspace' && !query) {
      event.preventDefault();
      onLeave();
    }
  };

  const rowIcon = (candidate: CommandCandidate) => {
    if (candidate.kind === 'conversation') return <IconMessagesSquare className="size-4 shrink-0 text-fg-3" />;
    if (candidate.kind === 'project') return <IconFolderClosed className="size-4 shrink-0 text-fg-3" />;
    return actionById.get(candidate.id)?.icon;
  };

  return (
    <>
      <QuickInput
        inputRef={inputRef}
        className="edge-b"
        aria-controls={LIST_ID}
        aria-activedescendant={matches[activeIndex] ? optionId(activeIndex) : undefined}
        aria-label={t`搜索命令、会话与项目`}
        placeholder={t`搜索命令、会话与项目…`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onQueryKeyDown}
      />
      <div ref={listRef} id={LIST_ID} role="listbox" aria-label={t({ message: '命令', context: 'workbench-command-label' })} className={quickListTallClass}>
        {matches.length ? matches.map((candidate, index) => (
          <div
            key={candidate.id}
            id={optionId(index)}
            role="option"
            aria-selected={index === activeIndex}
            data-index={index}
            onClick={() => run(candidate)}
            onPointerMove={() => { if (index !== activeIndex) setActive(index); }}
            className={cn('flex min-h-10 cursor-default items-center gap-3 rounded-lg px-3 text-sm text-fg', index === activeIndex && 'bg-active')}
          >
            {rowIcon(candidate)}
            <span className="min-w-0 flex-1 truncate">{candidate.label}</span>
            {candidate.detail && <span className="max-w-[40%] shrink-0 truncate text-xs text-fg-4">{candidate.detail}</span>}
            <span className="shrink-0 text-2xs text-fg-4">{KIND_LABEL[candidate.kind]}</span>
          </div>
        )) : <p className="px-3 py-8 text-center text-sm text-fg-3"><Trans>没有匹配的结果</Trans></p>}
      </div>
    </>
  );
}
