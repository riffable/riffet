import { useMemo } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconPin, IconPinFilled } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SortableList, SortHandle } from '@/components/ui/sortable-list';
import { Tip } from '@/components/ui/tooltip';
import { mainViewsIn } from '@/plugins/catalog';
import { useViewCatalog } from '@/plugins/registry';
import { reorderSidebarPinned, SIDEBAR_DESTINATION_META, splitSidebarDestinations, toggleSidebarPinned, WEB_SIDEBAR_DESTINATIONS, type WebSidebarDestination } from '../sidebarDestinations';
import { useSidebarPinned } from '../useSidebarPinned';
import { SettingsGroup as Group, SettingsRow as Row } from './SettingsLayout';

/** 侧栏: which destinations are sidebar rows, in what order; the rest sit under the sidebar's 更多. */
export function SidebarSection({ onError }: { onError: (message: string) => void }) {
  const { t } = useLingui();
  const catalog = useViewCatalog();
  const mainViews = useMemo(() => mainViewsIn(catalog), [catalog]);
  const mainViewMap = useMemo(() => new Map(mainViews.map((view) => [view.id, view])), [mainViews]);
  const offered = useMemo<string[]>(() => [...WEB_SIDEBAR_DESTINATIONS, ...mainViews.map((view) => view.id)], [mainViews]);
  const { saved, save, canEdit } = useSidebarPinned(onError);
  const { pinned, more } = splitSidebarDestinations(saved, offered);
  const name = (id: string) => id in SIDEBAR_DESTINATION_META ? t(SIDEBAR_DESTINATION_META[id as WebSidebarDestination].label) : (mainViewMap.get(id)?.title ?? id);
  // A pin, not a switch: unpinning moves the page under 更多, it does not turn anything off.
  const pin = (id: string, pinned: boolean) => {
    const label = pinned ? t`从侧栏移到更多` : t`固定到侧栏`;
    return (
      <Tip label={label}>
        <Button size="icon-sm" variant="quiet" aria-label={pinned ? t`把${name(id)}移到更多` : t`把${name(id)}固定到侧栏`} aria-pressed={pinned} className={pinned ? 'text-fg' : 'text-fg-3'} onClick={() => save((current) => toggleSidebarPinned(current, id, !pinned))}>
          {pinned ? <IconPinFilled /> : <IconPin />}
        </Button>
      </Tip>
    );
  };
  return <div className="flex flex-col gap-6">
    <p className="text-xs text-fg-3"><Trans>所有设备生效</Trans></p>
    <fieldset disabled={!canEdit} className="grid min-w-0 grid-cols-1 gap-6 disabled:[&_button]:pointer-events-none disabled:[&_button]:opacity-50 @4xl:grid-cols-2 @4xl:items-start">
      {pinned.length > 0 && <Group title={t`固定显示`}>
        <SortableList ids={pinned} onReorder={(ids) => save((current) => reorderSidebarPinned(current, ids))} label={name}>
          {(id) => <Row title={<span className="-ml-1.5 flex items-center gap-1"><SortHandle label={t`调整${name(id)}的顺序`} />{name(id)}</span>}>{pin(id, true)}</Row>}
        </SortableList>
      </Group>}
      {more.length > 0 && <Group title={t({ message: '更多', context: 'workbench-sidebar-more' })}>
        {more.map((id) => <Row key={id} title={name(id)}>{pin(id, false)}</Row>)}
      </Group>}
    </fieldset>
  </div>;
}

