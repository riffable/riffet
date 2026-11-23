import { Trans, useLingui } from '@lingui/react/macro';
import { Segmented, Switch } from '@/components/ui/controls';
import { SortableList, SortHandle } from '@/components/ui/sortable-list';
import { cn } from '@/lib/utils';
import type { ViewEntry } from '@/plugins/catalog';
import { setChapterNavigation, setProcessFoldTiming, setSessionSide, setViewOrder, setViewPlacement, setViewVisible, useSessionViews, useSidebarOrder, useViewPrefs, type ProcessFoldTiming, type RailMark, type ViewList, type ViewSwitchPlacement } from '../session/viewPrefs';
import { SettingsGroup as Group, SettingsRow as Row, SettingsThumbChoice, ThumbSidebar, thumbFrame } from './SettingsLayout';

/** Settings list the views of a conversation, whichever one is open. */
const SETTINGS_FACTS = { hasProject: true, hasSession: true, capabilities: new Set<string>() };

type SessionSideOption = 'overview' | 'rail-line' | 'rail-dot';

/** One prompt's mark on the rail, as the miniature draws it. */
function Mark({ mark, active }: { mark: RailMark; active?: boolean }) {
  return mark === 'dot'
    ? <i className={cn('rounded-full bg-current', active ? 'size-[4px]' : 'size-[3px]')} />
    : <i className={cn('h-[2px] rounded-full bg-current', active ? 'w-[9px]' : 'w-[5px]')} />;
}

/** A miniature of a wide session: the reading column, and the overview column or either rail style beside it. */
function Thumb({ option, selected }: { option: SessionSideOption; selected: boolean }) {
  const mark: RailMark = option === 'rail-dot' ? 'dot' : 'line';
  return (
    <span className={thumbFrame(selected)}>
      <ThumbSidebar />
      <span className="relative flex flex-1 gap-[5px] rounded-md bg-bg p-[5px]">
        <span className="flex flex-1 flex-col items-center gap-1 pt-0.5">
          {['70%', '52%', '64%', '40%'].map((width, row) => <i key={row} className="h-[3px] rounded-sm bg-active" style={{ width }} />)}
        </span>
        {option === 'overview'
          ? (
            <span className="flex w-[28%] flex-col gap-[3px] pt-0.5">
              {[0, 1, 2].map((row) => <i key={row} className={cn('h-[3px] rounded-sm', row === 2 ? 'bg-fg-4' : 'bg-active')} />)}
              <i className="mt-1 h-[3px] w-3/4 rounded-sm bg-active" />
            </span>
          )
          : (
            <span className="absolute top-1/2 right-[3px] flex -translate-y-1/2 flex-col items-end gap-[3px]">
              {[0, 1, 2, 3, 4].map((row) => (
                <span key={row} className={cn('flex justify-center', mark === 'dot' && 'w-[4px]', row === 3 ? 'text-fg-4' : 'text-active')}>
                  <Mark mark={mark} active={row === 3} />
                </span>
              ))}
            </span>
          )}
      </span>
    </span>
  );
}

/** The views of one list with their order and visibility controls; 对话 cannot be turned off. */
function ViewRows({ list, views, hidden }: { list: ViewList; views: readonly ViewEntry[]; hidden: readonly string[] }) {
  const { t } = useLingui();
  const titles = new Map(views.map((view) => [view.id, view.title]));
  const name = (id: string) => titles.get(id) ?? id;
  return (
    <SortableList ids={views.map((view) => view.id)} onReorder={(ids) => setViewOrder(ids, list)} label={name}>
      {(view) => (
        <Row title={<span className="-ml-1.5 flex items-center gap-1"><SortHandle label={t`调整${name(view)}的顺序`} />{name(view)}</span>}>
          <Switch aria-label={name(view)} checked={!hidden.includes(view)} disabled={list === 'session' && view === 'chat'} onCheckedChange={(visible) => setViewVisible(view, visible, list)} />
        </Row>
      )}
    </SortableList>
  );
}

/** 视图: what a wide session shows on its right, how its rail marks prompts, and the switch between the views the catalog offers (对话, 终端, 画布...). */
export function ViewsSection() {
  const { t } = useLingui();
  const side = useViewPrefs((state) => state.side);
  const mark = useViewPrefs((state) => state.mark);
  const placement = useViewPrefs((state) => state.placement);
  const chapterNavigation = useViewPrefs((state) => state.chapterNavigation);
  const processFoldTiming = useViewPrefs((state) => state.processFoldTiming);
  const hidden = useViewPrefs((state) => state.hidden);
  const sidebarHidden = useViewPrefs((state) => state.sidebarHidden);
  const offered = useSessionViews(SETTINGS_FACTS);
  const sidebar = useSidebarOrder();
  const sideOption: SessionSideOption = side === 'overview' ? 'overview' : mark === 'dot' ? 'rail-dot' : 'rail-line';
  const selectSide = (option: SessionSideOption) => {
    if (option === 'overview') setSessionSide('overview');
    else setSessionSide('rail', option === 'rail-dot' ? 'dot' : 'line');
  };
  return <div className="flex flex-col gap-6">
    <Group title={t`会话右侧`} action={<span className="text-2xs text-fg-4"><Trans>仅保存在这台设备</Trans></span>}>
      <SettingsThumbChoice<SessionSideOption>
        label={t`会话右侧`}
        value={sideOption}
        onChange={selectSide}
        options={[
          { value: 'overview', label: t`会话概览` },
          { value: 'rail-line', label: t`线条导航条` },
          { value: 'rail-dot', label: t`圆点导航条` },
        ]}
        thumb={(value, selected) => <Thumb option={value} selected={selected} />}
      />
    </Group>
    <Group>
      <Row title={t`过程自动收起`}>
        <Segmented<ProcessFoldTiming> size="xs" value={processFoldTiming} onChange={setProcessFoldTiming} ariaLabel={t`过程自动收起`} options={[
          { value: 'turn-end', label: t`回合结束时` },
          { value: 'next-input', label: t`发送下一条时` },
        ]} />
      </Row>
      <Row title={t`章节导航`}>
        <Switch aria-label={t`章节导航`} checked={chapterNavigation} onCheckedChange={setChapterNavigation} />
      </Row>
      <Row title={t`视图切换`}>
        <Segmented<ViewSwitchPlacement> size="xs" value={placement} onChange={setViewPlacement} ariaLabel={t`视图切换`} options={[{ value: 'dots', label: t`底部圆点` }, { value: 'header', label: t`标题栏图标` }]} />
      </Row>
    </Group>
    <Group title={t`显示的视图`}>
      <ViewRows list="session" views={offered} hidden={hidden} />
    </Group>
    <Group title={t`侧板视图`}>
      <ViewRows list="sidebar" views={sidebar} hidden={sidebarHidden} />
    </Group>
  </div>;
}
