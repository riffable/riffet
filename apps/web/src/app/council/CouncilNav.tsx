import { Trans, useLingui } from '@lingui/react/macro';
import { councilAwaitsReader, type CouncilFormat, type CouncilSummary } from '@contracts';
import { IconArrowRightLeft, IconChevronDown, IconFilePenLine, IconLayers, IconMessagesSquare, IconPlus, IconTrash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner, StatusDot } from '@/components/ui/controls';
import { ListRow, rowConceal, rowReveal } from '@/components/ui/list-row';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { relativeTime } from '@/lib/utils';
import { useCouncilLabels } from './model';

function formatIcon(format: CouncilFormat) {
  if (format === 'ld') return <IconArrowRightLeft />;
  if (format === 'roundtable') return <IconMessagesSquare />;
  if (format === 'prism') return <IconLayers />;
  return <IconFilePenLine />;
}

/** The discussions held so far, under the new discussion's seats: the way back into one, and where one is deleted. */
export function CouncilRecent({ items, onSelect, onDelete }: {
  items: readonly CouncilSummary[];
  onSelect: (id: string) => void;
  onDelete: (item: CouncilSummary) => void;
}) {
  const { t } = useLingui();
  const labels = useCouncilLabels();
  // The marks the sidebar row sums up, on the discussion they come from; a read one shows its format.
  const leadingOf = (item: CouncilSummary) => {
    if (item.status === 'running') return <Spinner />;
    if (!councilAwaitsReader(item)) return formatIcon(item.format);
    if (item.status === 'paused') return <StatusDot tone="warning" label={t`等待处理`} />;
    if (item.status === 'failed') return <StatusDot tone="danger" label={t`运行失败`} />;
    return <StatusDot tone="accent" label={t`未读`} />;
  };
  if (!items.length) return null;
  return (
    <section aria-labelledby="council-recent" className="flex min-w-0 flex-col">
      <h2 id="council-recent" className="mb-1 px-2.5 text-xs font-medium text-fg-3"><Trans>最近</Trans></h2>
      <div className="flex flex-col gap-px">
        {items.map((item) => (
          <ListRow
            key={item.id}
            className="min-h-10 gap-3"
            leading={leadingOf(item)}
            meta={labels.format(item.format)}
            onClick={() => onSelect(item.id)}
            actions={(
              // The time gives its place to the delete button while the row is pointed at or focused.
              <span className="grid w-16 shrink-0 items-center justify-items-end">
                <span className={`col-start-1 row-start-1 text-xs tabular-nums text-fg-4 ${rowConceal}`}>{relativeTime(item.updatedAt)}</span>
                <span className={`col-start-1 row-start-1 z-10 flex ${rowReveal}`}>
                  <Tip label={t`删除协作`}>
                    <Button size="icon-xs" variant="quiet" className="no-hover:size-11" aria-label={t`删除协作`} onClick={() => onDelete(item)}>
                      <IconTrash2 />
                    </Button>
                  </Tip>
                </span>
              </span>
            )}
          >
            <span className="text-fg">{item.title}</span>
          </ListRow>
        ))}
      </div>
    </section>
  );
}

/** The open discussion's title, opening the others and a new one. */
export function CouncilHistoryMenu({
  items,
  activeId,
  title,
  onSelect,
}: {
  items: readonly CouncilSummary[];
  activeId: string;
  title?: string;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useLingui();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-7 max-w-full min-w-0 items-center gap-1 rounded-md px-2 text-sm font-medium text-fg outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus data-[state=open]:bg-hover no-hover:min-h-11">
        <span className="min-w-0 truncate">{title ?? t`模型协作`}</span>
        <IconChevronDown className="size-3.5 shrink-0 text-fg-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(70dvh,480px)] w-72 overflow-y-auto">
        <DropdownMenuItem onSelect={() => onSelect(null)}>
          <IconPlus />
          <span><Trans>新建协作</Trans></span>
        </DropdownMenuItem>
        {items.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={activeId} onValueChange={(v) => onSelect(v || null)}>
              {items.map((item) => (
                <DropdownMenuRadioItem key={item.id} value={item.id}>
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
