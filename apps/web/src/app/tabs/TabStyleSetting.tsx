import { useLingui } from '@lingui/react/macro';
import { cn } from '@/lib/utils';
import type { TabStyle } from './tabsStore';
import { useStores } from '../state/stores';
import { useTabs } from './useTabs';
import { SettingsThumbChoice, ThumbSidebar, thumbFrame } from '../settings/SettingsLayout';

/** A miniature of the workbench with the tab bar where this style puts it. */
function Thumb({ style, selected }: { style: TabStyle; selected: boolean }) {
  return (
    <span className={thumbFrame(selected)}>
      <ThumbSidebar />
      <span className="flex flex-1 flex-col">
        {style === 'strip' && (
          <span className="flex h-2 items-end gap-0.5 pl-[3px]">
            <i className="session-tab-current h-2 w-[22px] rounded-t-[3px]" />
            <i className="mb-0.5 h-1 w-[22px] rounded-sm bg-active" />
            <i className="mb-0.5 h-1 w-[22px] rounded-sm bg-active" />
          </span>
        )}
        <span className={cn('flex flex-1 flex-col gap-1 rounded-md bg-bg p-[5px]', style === 'strip' && 'rounded-tl-none')}>
          {style === 'inline' && (
            <span className="flex h-[7px] gap-[3px]">
              <i className="session-tab-current w-5 rounded-sm border border-transparent" />
              <i className="w-5 rounded-[3px] bg-active" />
              <i className="w-5 rounded-[3px] bg-active" />
            </span>
          )}
          {style === 'off' && <span className="flex h-[7px]"><i className="w-11 rounded-[3px] bg-fg-4" /></span>}
          <i className="h-[3px] w-[70%] rounded-sm bg-active" />
          <i className="h-[3px] w-[45%] rounded-sm bg-active" />
        </span>
      </span>
    </span>
  );
}

/** 标签样式: three thumbnails, one per style. */
export function TabStyleSetting() {
  const { t } = useLingui();
  const { tabs } = useStores();
  const style = useTabs((state) => state.style);
  return (
    <SettingsThumbChoice<TabStyle>
      label={t`标签样式`}
      value={style}
      onChange={(next) => tabs.setStyle(next)}
      options={[{ value: 'off', label: t`关闭` }, { value: 'inline', label: t`标题栏` }, { value: 'strip', label: t`独立一行` }]}
      thumb={(value, selected) => <Thumb style={value} selected={selected} />}
    />
  );
}
