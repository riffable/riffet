import { Trans, useLingui } from '@lingui/react/macro';
import { IconChevronDown, IconPlus, IconTerminal } from '@/components/icons';
import type { TerminalInfo } from '@contracts';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/controls';
import { ResizeHandle } from '@/components/ui/resize-handle';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { DOCK_MAX, DOCK_MIN } from '@/app/state/uiStore';
import { TerminalView } from './TerminalView';


interface Props {
  terminals: TerminalInfo[];
  selectedId: string;
  height: number;
  onHeightChange: (height: number) => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onHide: () => void;
  onChanged: (terminal: TerminalInfo) => void;
  onClose: (terminal: TerminalInfo) => void;
  onError: (message: string) => void;
  /** Fill the mobile full-screen surface selected by the owning shell. */
  fullscreen?: boolean;
}

export function TerminalDock({ terminals, selectedId, height, onHeightChange, onSelect, onCreate, onHide, onChanged, onClose, onError, fullscreen = false }: Props) {
  const { t } = useLingui();
  const active = terminals.find((terminal) => terminal.id === selectedId) ?? terminals[0];
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
          {terminals.map((terminal) => (
            <button
              key={terminal.id}
              type="button"
              onClick={() => onSelect(terminal.id)}
              title={terminal.title}
              className={cn('flex h-7 max-w-48 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-fg-3 transition-colors hover:bg-hover hover:text-fg no-hover:h-11', fullscreen && 'h-10 px-2.5', terminal.id === active?.id && 'bg-active text-fg')}
            >
              <IconTerminal className="size-3.5 shrink-0" />
              <span className="truncate">{terminal.title}</span>
              {terminal.state !== 'running' && <span className="size-1.5 shrink-0 rounded-full bg-fg-4" aria-label={t`已停止`} />}
            </button>
          ))}
          <Tip label={t`新建终端`}><Button size="icon-xs" variant="quiet" aria-label={t`新建终端`} className={cn('no-hover:size-11', fullscreen && 'size-10')} onClick={onCreate}><IconPlus /></Button></Tip>
        </div>
        <Tip label={fullscreen ? t`返回对话` : t`收起`} kbd="⌃`"><Button size="icon-xs" variant="quiet" aria-label={fullscreen ? t`返回对话` : t({ message: '收起终端', context: 'terminal-collapse-terminal' })} className={cn('no-hover:size-11', fullscreen && 'size-10')} onClick={onHide}><IconChevronDown /></Button></Tip>
      </div>
      {active ? (
        <TerminalView key={active.id} terminal={active} active showTitle={false} autoFocus={!fullscreen} onChanged={onChanged} onClose={onClose} onError={onError} />
      ) : (
        <EmptyState className="flex-1 py-4" title={t`没有运行中的终端`} description={t`终端运行在服务器，关闭浏览器后仍会保留。`}>
          <Button size="sm" onClick={onCreate}><IconPlus /><Trans>新建终端</Trans></Button>
        </EmptyState>
      )}
    </section>
  );
}
