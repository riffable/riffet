import { useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconChevronDown, IconColumns2, IconPlus, IconTerminal, IconX } from '@/components/icons';
import { TERMINAL_BUDGET, type TerminalInfo, type TerminalProfile } from '@contracts';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ResizeHandle } from '@/components/ui/resize-handle';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { DOCK_MAX, DOCK_MIN } from '@/app/state/uiStore';
import type { CreateShellOptions } from '@/app/use-terminal-actions';
import { TerminalView } from './TerminalView';

interface Props {
  terminals: TerminalInfo[];
  profiles?: TerminalProfile[];
  selectedId: string;
  height: number;
  onHeightChange: (height: number) => void;
  onSelect: (id: string) => void;
  onCreate: (options?: CreateShellOptions) => Promise<TerminalInfo | undefined>;
  onHide: () => void;
  onChanged: (terminal: TerminalInfo) => void;
  onClose: (terminal: TerminalInfo) => void;
  onError: (message: string) => void;
  /** Fill the mobile full-screen surface selected by the owning shell. */
  fullscreen?: boolean;
}

const EMPTY_PROFILES: TerminalProfile[] = [];
/**
 * The folder the shell is in. A prompt's own title (`user@host: ~/path`) repeats on every tab, so it
 * only reaches the tooltip; tmux's foreground command is read once per attach and goes stale.
 */
function shellTabLabel(terminal: TerminalInfo): string {
  const folder = terminal.cwd?.replace(/\/+$/, '').split('/').pop();
  return folder || terminal.paneTitle || terminal.title;
}

export function TerminalDock({
  terminals, profiles = EMPTY_PROFILES, selectedId, height, onHeightChange, onSelect, onCreate, onHide, onChanged, onClose, onError, fullscreen = false,
}: Props) {
  const { t } = useLingui();
  const active = terminals.find((terminal) => terminal.id === selectedId) ?? terminals[0];
  const [splitId, setSplitId] = useState<string | null>(null);
  const splitTerminal = !fullscreen && splitId && splitId !== active?.id
    ? terminals.find((terminal) => terminal.id === splitId)
    : undefined;

  useEffect(() => {
    if (splitId && (!terminals.some((terminal) => terminal.id === splitId) || splitId === active?.id)) {
      setSplitId(null);
    }
  }, [active?.id, splitId, terminals]);

  // Bounded LRU keep-alive pool: switching tabs preserves scrollback, selection, and socket state.
  const [keptIds, setKeptIds] = useState<string[]>(() => (active ? [active.id] : []));
  useEffect(() => {
    const valid = new Set(terminals.map((terminal) => terminal.id));
    setKeptIds((previous) => {
      const next = previous.filter((id) => valid.has(id) && id !== active?.id && id !== splitTerminal?.id);
      if (splitTerminal) next.push(splitTerminal.id);
      if (active) next.push(active.id);
      const bounded = next.length > TERMINAL_BUDGET.keepAliveLimit
        ? next.slice(next.length - TERMINAL_BUDGET.keepAliveLimit)
        : next;
      if (bounded.length === previous.length && bounded.every((id, index) => id === previous[index])) return previous;
      return bounded;
    });
  }, [active?.id, splitTerminal?.id, terminals]);

  const keptTerminals = useMemo(() => {
    const byId = new Map(terminals.map((terminal) => [terminal.id, terminal]));
    const list: TerminalInfo[] = [];
    for (const id of keptIds) {
      const item = byId.get(id);
      if (item) list.push(item);
    }
    if (active && !list.some((item) => item.id === active.id)) list.push(active);
    if (splitTerminal && !list.some((item) => item.id === splitTerminal.id)) list.push(splitTerminal);
    return list;
  }, [active, keptIds, splitTerminal, terminals]);

  const toggleSplit = async () => {
    if (splitTerminal) {
      setSplitId(null);
      return;
    }
    const peer = terminals.find((terminal) => terminal.id !== active?.id && terminal.state === 'running')
      ?? terminals.find((terminal) => terminal.id !== active?.id);
    if (peer) {
      setSplitId(peer.id);
      return;
    }
    const created = await onCreate({ keepSelection: true });
    if (created) setSplitId(created.id);
  };

  return (
    <section className={cn('relative flex flex-col edge-t bg-bg', fullscreen ? 'h-full min-h-0 flex-1 border-0' : 'shrink-0')} style={fullscreen ? undefined : { height }} aria-label={t`终端面板`}>
      {/* Fully inside the dock: the animated wrapper clips anything above the top
          edge, which would otherwise eat half of this drag strip. */}
      {!fullscreen && <ResizeHandle
        axis="y"
        grow={-1}
        value={height}
        min={DOCK_MIN}
        max={DOCK_MAX}
        label={t`调整终端高度`}
        valueText={t`${height} 像素`}
        onChange={onHeightChange}
        className="absolute inset-x-0 top-0 h-2.5 focus-visible:bg-accent/40"
      />}
      <div className={cn('flex h-9 shrink-0 items-center gap-1 edge-b px-2', fullscreen && 'h-12 px-2.5')}>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {terminals.map((terminal) => {
            const label = shellTabLabel(terminal);
            const tooltip = [terminal.paneTitle, terminal.cwd].filter(Boolean).join(' — ') || label;
            const isPrimary = terminal.id === active?.id;
            const isSplit = terminal.id === splitTerminal?.id;
            return (
              <div
                key={terminal.id}
                data-active={isPrimary}
                onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
                onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(terminal); } }}
                className={cn(
                  'group/tab flex h-7 max-w-48 shrink-0 items-center rounded-md text-xs text-fg-3 transition-colors hover:bg-hover hover:text-fg no-hover:h-11',
                  fullscreen && 'h-10',
                  isPrimary && 'bg-active text-fg',
                  !isPrimary && isSplit && 'bg-hover/70 text-fg-2',
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect(terminal.id)}
                  title={tooltip}
                  aria-current={isPrimary || undefined}
                  className={cn('flex h-full min-w-0 items-center gap-1.5 rounded-md pl-2 pr-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus', fullscreen && 'pl-2.5')}
                >
                  <IconTerminal className="size-3.5 shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
                {/* The slot keeps its width while the button is hidden, so a tab does not change width
                    under the pointer. Touch has no hover: only the current tab has the button, at 44. */}
                <span className="mr-1 grid size-5 shrink-0 place-items-center no-hover:mr-0 no-hover:size-auto">
                  <button
                    type="button"
                    aria-label={t`关闭${label}`}
                    onClick={() => onClose(terminal)}
                    className="hidden size-5 place-items-center rounded-md text-fg-3 outline-none hover:bg-active hover:text-fg focus-visible:ring-2 focus-visible:ring-focus group-focus-within/tab:grid group-hover/tab:grid group-data-[active=true]/tab:grid no-hover:size-11"
                  >
                    <IconX className="size-3" />
                  </button>
                </span>
              </div>
            );
          })}
          <Tip label={t`新建终端`}><Button size="icon-xs" variant="quiet" aria-label={t`新建终端`} className={cn('no-hover:size-11', fullscreen && 'size-10')} onClick={() => void onCreate()}><IconPlus /></Button></Tip>
          {profiles.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-xs" variant="quiet" aria-label={t`从预设新建终端`} className={cn('no-hover:size-11', fullscreen && 'size-10')}>
                  <IconChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => void onCreate()}>{t`默认 Shell`}</DropdownMenuItem>
                {profiles.map((profile) => (
                  <DropdownMenuItem key={profile.id} onSelect={() => void onCreate({ profileId: profile.id })}>
                    {profile.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {!fullscreen && active && (
          <Tip label={splitTerminal ? t`退出分屏` : t`并排分屏`}>
            <Button
              size="icon-xs"
              variant={splitTerminal ? 'secondary' : 'quiet'}
              aria-label={splitTerminal ? t`退出分屏` : t`并排分屏`}
              aria-pressed={Boolean(splitTerminal)}
              className="no-hover:size-11"
              onClick={() => void toggleSplit()}
            ><IconColumns2 /></Button>
          </Tip>
        )}
        <Tip label={fullscreen ? t`返回对话` : t`收起`} kbd="⌃`"><Button size="icon-xs" variant="quiet" aria-label={fullscreen ? t`返回对话` : t({ message: '收起终端', context: 'terminal-collapse-terminal' })} className={cn('no-hover:size-11', fullscreen && 'size-10')} onClick={onHide}><IconChevronDown /></Button></Tip>
      </div>
      {active ? (
        <div className="flex min-h-0 flex-1">
          {keptTerminals.map((terminal) => {
            const isPrimary = terminal.id === active.id;
            const isSplit = terminal.id === splitTerminal?.id;
            const visible = isPrimary || isSplit;
            return (
              <TerminalView
                key={terminal.id}
                terminal={terminal}
                active={visible}
                toolbar={false}
                autoFocus={isPrimary && !fullscreen}
                className={cn(!visible && 'hidden', isSplit && 'edge-l')}
                onChanged={onChanged}
                onClose={onClose}
                onError={onError}
              />
            );
          })}
        </div>
      ) : (
        <EmptyState className="flex-1 py-4" title={t`没有运行中的终端`} description={t`终端运行在服务器，关闭浏览器后仍会保留。`}>
          <Button size="sm" onClick={() => void onCreate()}><IconPlus /><Trans>新建终端</Trans></Button>
        </EmptyState>
      )}
    </section>
  );
}
