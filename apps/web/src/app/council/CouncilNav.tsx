import { Trans, useLingui } from '@lingui/react/macro';
import type { CouncilDiscussion } from '@contracts';
import { IconChevronDown, IconFileText, IconLayers, IconMessagesSquare, IconPlus, IconTrash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/controls';
import { ListRow, RowActions } from '@/components/ui/list-row';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

function modeIcon(mode: CouncilDiscussion['mode']) {
  if (mode === 'debate') return <IconMessagesSquare />;
  if (mode === 'prism') return <IconLayers />;
  return <IconFileText />;
}

/**
 * Dedicated left history rail inside the Model Collaboration page (`PageScaffold aside`),
 * matching `PluginsAside` (same background as page body, no extra border/time clutter).
 */
export function CouncilAsideNav({
  items,
  activeId,
  onSelect,
  onDelete,
}: {
  items: CouncilDiscussion[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useLingui();

  return (
    <nav aria-label={t`协作历史`} className="hidden w-56 shrink-0 flex-col overflow-y-auto px-3 pb-10 pt-5 lg:flex">
      <ListRow
        leading={<IconPlus />}
        selected={activeId === null}
        aria-current={activeId === null ? 'page' : undefined}
        onClick={() => onSelect(null)}
      >
        <Trans>新建协作</Trans>
      </ListRow>

      <h3 className="px-2.5 pb-1 pt-4 text-2xs font-medium text-fg-4">
        <Trans>历史记录</Trans>
      </h3>

      {items.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-fg-4"><Trans>暂无记录</Trans></p>
      ) : (
        <div className="flex flex-col gap-px">
          {items.map((item) => (
            <ListRow
              key={item.id}
              leading={item.status === 'running' ? <Spinner /> : modeIcon(item.mode)}
              selected={activeId === item.id}
              aria-current={activeId === item.id ? 'page' : undefined}
              onClick={() => onSelect(item.id)}
              actions={(
                <RowActions>
                  <Button
                    size="icon-xs"
                    variant="quiet"
                    aria-label={t`删除协作`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(item.id);
                    }}
                  >
                    <IconTrash2 />
                  </Button>
                </RowActions>
              )}
            >
              {item.title}
            </ListRow>
          ))}
        </div>
      )}
    </nav>
  );
}

/** Compact switcher shown in the header on narrow viewports (< lg) where the left column folds. */
export function CouncilHistoryMenu({
  items,
  activeId,
  onSelect,
}: {
  items: CouncilDiscussion[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useLingui();
  const current = activeId ? items.find((i) => i.id === activeId) : undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="ml-1 flex h-7 min-w-0 items-center gap-1 rounded-md px-2 text-sm text-fg-2 outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus lg:hidden no-hover:min-h-11">
        <span className="min-w-0 truncate">{current?.title ?? t`新建协作`}</span>
        <IconChevronDown className="size-3.5 shrink-0 text-fg-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-[min(70dvh,480px)] w-64 overflow-y-auto">
        <DropdownMenuItem onSelect={() => onSelect(null)}>
          <IconPlus />
          <span><Trans>新建协作</Trans></span>
        </DropdownMenuItem>
        {items.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={activeId ?? ''} onValueChange={(v) => onSelect(v || null)}>
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
