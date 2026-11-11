import { Trans, useLingui } from '@lingui/react/macro';
import { Kbd, Segmented } from '@/components/ui/controls';
import { useStores } from '../state/stores';
import { shortcutCaps, tabShortcuts } from '../tabs/keys';
import { TabStyleSetting } from '../tabs/TabStyleSetting';
import type { TabOpenMode } from '../tabs/tabsStore';
import { useTabs } from '../tabs/useTabs';
import { SettingsGroup as Group, SettingsRow as Row } from './SettingsLayout';

/** 标签页: the session tab bar, how sessions open into it, and the keys that drive the workbench. */
export function TabsSection() {
  const { t, i18n } = useLingui();
  const { tabs } = useStores();
  const style = useTabs((state) => state.style);
  const openMode = useTabs((state) => state.openMode);
  const off = style === 'off';
  return <div className="flex flex-col gap-6">
    <p className="text-xs text-fg-3"><Trans>仅保存在这台设备</Trans></p>
    <Group title={t`标签样式`}>
      <TabStyleSetting />
    </Group>
    <Group>
      <Row title={t`打开会话时`}>
        <Segmented<TabOpenMode> size="xs" value={openMode} onChange={(mode) => tabs.setOpenMode(mode)} ariaLabel={t`打开会话时`} options={[{ value: 'preview', label: t`临时标签`, disabled: off }, { value: 'keep', label: t`直接加入`, disabled: off }, { value: 'manual', label: t`仅手动加入`, disabled: off }]} />
      </Row>
    </Group>
    <Group title={t`快捷键`}>
      {tabShortcuts.map(({ label, keys }) => (
        <div key={label.id} className="flex items-center justify-between gap-6 py-2.5">
          <span className="min-w-0 text-sm text-fg">{i18n._(label)}</span>
          <span className="flex shrink-0 items-center gap-1">{shortcutCaps(keys).map((cap) => <Kbd key={cap}>{cap}</Kbd>)}</span>
        </div>
      ))}
    </Group>
  </div>;
}
