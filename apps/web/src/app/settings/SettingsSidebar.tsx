import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconArrowLeft, IconPanelLeft } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { ListRow } from '@/components/ui/list-row';
import { SearchField } from '@/components/ui/search-field';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { shortcutHint } from '../shortcuts';
import { filterSettingsNavigation, settingsGroupTitle, settingsSections, type SettingsSection, type SettingsSectionGroup } from './settingsSections';

interface Props {
  section: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  onClose: () => void;
  onCollapse?: () => void;
  onPin?: () => void;
}

/**
 * Replaces the workspace sidebar while Settings is open on desktop (DECISIONS 2026-11-23):
 * one navigation rail on screen instead of stacking a settings rail beside the session sidebar.
 */
export function SettingsSidebar({ section, onSelect, onClose, onCollapse, onPin }: Props) {
  const { t } = useLingui();
  const [query, setQuery] = useState('');
  const sidebarHint = shortcutHint('toggleSidebar');
  const current = settingsSections.find((item) => item.id === section);
  const selected = (id: SettingsSection) => section === id || current?.parent === id;

  const grouped = useMemo(() => {
    const matched = filterSettingsNavigation(query);
    const groups = [...new Set(matched.map((item) => item.group))];
    return groups.map((group: SettingsSectionGroup) => ({
      group,
      title: settingsGroupTitle(group),
      items: matched.filter((item) => item.group === group),
    }));
  }, [query]);

  return (
    <nav className="flex h-full min-h-0 w-full flex-col bg-transparent" aria-label={t`设置分区`}>
      <div className="flex h-13 shrink-0 items-center gap-1 pl-2 pr-2">
        <Button size="sm" variant="quiet" className="gap-1.5 px-2 text-fg" onClick={onClose}>
          <IconArrowLeft className="size-4" />
          <Trans>返回</Trans>
        </Button>
        <div className="ml-auto flex items-center">
          {onCollapse && (
            <Tip label={t`收起侧边栏`} kbd={sidebarHint}>
              <Button size="icon-sm" variant="quiet" aria-label={t`收起侧边栏`} onClick={onCollapse}><IconPanelLeft /></Button>
            </Tip>
          )}
          {onPin && (
            <Tip label={t`固定侧边栏`} kbd={sidebarHint}>
              <Button size="icon-sm" variant="quiet" aria-label={t`固定侧边栏`} onClick={onPin}><IconPanelLeft /></Button>
            </Tip>
          )}
        </div>
      </div>

      <div className="px-2 pb-2">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t`搜索设置`}
          aria-label={t`搜索设置`}
          inputClassName="text-xs"
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-4">
        {grouped.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-xs text-fg-4"><Trans>没有匹配的设置</Trans></p>
        ) : (
          grouped.map(({ group, title, items }) => (
            <div key={group} className="mb-3 flex flex-col gap-px">
              {title && <h3 className="px-2 pb-1 pt-2 text-2xs font-medium text-fg-4">{title}</h3>}
              {items.map((item) => (
                <ListRow
                  key={item.id}
                  aria-current={selected(item.id) ? 'page' : undefined}
                  selected={selected(item.id)}
                  onClick={() => onSelect(item.id)}
                  leading={<item.icon />}
                  className={cn('px-2')}
                >
                  {item.label}
                </ListRow>
              ))}
            </div>
          ))
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between px-4 py-2.5">
        <span className="truncate font-mono text-2xs text-fg-4">{window.location.host}</span>
      </div>
    </nav>
  );
}
