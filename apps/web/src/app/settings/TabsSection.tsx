import { Trans, useLingui } from '@lingui/react/macro';
import { Segmented } from '@/components/ui/controls';
import { useStores } from '../state/stores';
import { TabStyleSetting } from '../tabs/TabStyleSetting';
import type { TabNewMode, TabOpenMode } from '../tabs/tabsStore';
import { useTabs } from '../tabs/useTabs';
import { SettingsGroup as Group, SettingsRow as Row } from './SettingsLayout';

/** 标签页: the session tab bar and how sessions open into it. Its keys are on 快捷键. */
export function TabsSection() {
  const { t } = useLingui();
  const { tabs } = useStores();
  const style = useTabs((state) => state.style);
  const openMode = useTabs((state) => state.openMode);
  const newMode = useTabs((state) => state.newMode);
  const off = style === 'off';
  return <div className="flex flex-col gap-6">
    <p className="text-xs text-fg-3"><Trans>仅保存在这台设备</Trans></p>
    <Group title={t`标签样式`}>
      <TabStyleSetting />
    </Group>
    <Group>
      <Row title={t`打开会话时`}>
        <Segmented<TabOpenMode> size="xs" value={openMode} onChange={(mode) => tabs.setOpenMode(mode)} ariaLabel={t`打开会话时`} options={[{ value: 'preview', label: t`临时标签`, disabled: off }, { value: 'keep', label: t`直接加入`, disabled: off }]} />
      </Row>
      <Row title={t`新建会话时`}>
        <Segmented<TabNewMode> size="xs" value={openMode === 'keep' ? 'keep' : newMode} onChange={(mode) => tabs.setNewMode(mode)} ariaLabel={t`新建会话时`} options={[{ value: 'preview', label: t`临时标签`, disabled: off || openMode === 'keep' }, { value: 'keep', label: t`直接加入`, disabled: off || openMode === 'keep' }]} />
      </Row>
    </Group>
  </div>;
}
