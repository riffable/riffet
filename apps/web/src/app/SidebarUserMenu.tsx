import type { ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { NativeBackendCatalogEntry, OwnerInfo } from '@contracts';
import { OwnerAvatar } from '@/components/OwnerAvatar';
import { ThemeSwatch } from '@/components/theme-swatch';
import { IconChartColumn, IconChevronRight, IconCopy, IconLaptop, IconMonitor, IconMoon, IconPuzzle, IconServer, IconSettings, IconSun } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger, MenuSub } from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { palettesOf, selectAppearanceItem, useAppearance } from '@/lib/appearance';
import { copyWithToast } from '@/lib/files';
import { localizedText } from '@/lib/plugins';
import { hostInfo } from '@/lib/platform';
import { setThemeId, setThemeMode, useTheme, type ThemeMode } from '@/lib/theme';
import { useThemeOptions } from '@/lib/theme-library';
import { cn } from '@/lib/utils';

interface Props {
  owner?: OwnerInfo;
  backend?: NativeBackendCatalogEntry;
  stale?: { mode: 'syncing' | 'offline' };
  mobile?: boolean;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  onOpenExtensions: () => void;
  onOpenStats: () => void;
  onOpenPlugins?: () => void;
  extensionsActive?: boolean;
  statsActive?: boolean;
  pluginsActive?: boolean;
}

/** Prefetch only; opening the menu does not mount the settings workspace. */
const preloadSettings = () => void import('./settings/SettingsDialog');

/** The sidebar's only footer trigger; all destinations keep their existing navigation callbacks. */
export function SidebarUserMenu({ owner, backend, stale, mobile, onOpenProfile, onOpenSettings, onOpenExtensions, onOpenStats, onOpenPlugins, extensionsActive, statsActive, pluginsActive }: Props) {
  const { t } = useLingui();
  const { local, address } = hostInfo();
  const offline = stale?.mode === 'offline';
  const backendNotice = backend?.needsLogin ? t`${backend.label} 未登录` : backend && !backend.available ? t`${backend.label} 不可用` : undefined;
  const warning = offline ? t`无法连接服务器` : backendNotice;
  const label = t`个人资料与更多`;
  const tooltip = [owner?.name, label, warning].filter(Boolean).join(' · ');
  const HostIcon = local ? IconLaptop : IconServer;
  const hostLabel = local ? t`本机` : t({ message: '远端', context: 'workbench-remote-host' });
  return (
    <DropdownMenu>
      <Tip label={tooltip} side="top">
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="quiet" aria-label={tooltip} onPointerEnter={preloadSettings} onFocus={preloadSettings} className="relative rounded-full">
            <OwnerAvatar owner={owner} size={24} />
            {warning && <StatusDot tone="warning" className={cn('absolute right-0 bottom-0 ring-2', mobile ? 'ring-sidebar' : 'ring-canvas')} />}
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent side="top" align="start" className="w-64" aria-label={label}>
        <DropdownMenuItem onSelect={onOpenProfile} textValue={t`个人资料`} className="gap-3 py-3 md:py-3">
          <OwnerAvatar owner={owner} size={36} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{owner?.name || t`个人资料`}</span>
            {owner?.name && <span className="block text-xs text-fg-3"><Trans>个人资料</Trans></span>}
          </span>
          <IconChevronRight className="size-3.5 text-fg-4" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem aria-current={extensionsActive ? 'page' : undefined} onSelect={onOpenExtensions}><IconPuzzle /><Trans>Agent 扩展</Trans></DropdownMenuItem>
        {mobile && onOpenPlugins && <DropdownMenuItem aria-current={pluginsActive ? 'page' : undefined} onSelect={onOpenPlugins}><IconPuzzle /><Trans>插件</Trans></DropdownMenuItem>}
        <DropdownMenuItem aria-current={statsActive ? 'page' : undefined} onSelect={onOpenStats}><IconChartColumn /><Trans>数据统计</Trans></DropdownMenuItem>
        <DropdownMenuSeparator />
        <ThemeMenu />
        <DropdownMenuItem onSelect={onOpenSettings} textValue={t`设置`} aria-label={backendNotice ? [t`设置`, backendNotice, backend?.reason].filter(Boolean).join(' · ') : undefined}>
          <IconSettings />
          <span className="min-w-0 flex-1"><Trans>设置</Trans>{backendNotice && <span className="block py-1 text-xs text-warning wrap-anywhere">{backendNotice}</span>}</span>
        </DropdownMenuItem>
        {(!local || offline) && <>
          <DropdownMenuSeparator />
          <MenuSub icon={<HostIcon className={offline ? 'text-warning' : undefined} />} label={hostLabel} value={offline ? t`无法连接服务器` : stale ? t`正在同步` : undefined} className="w-64">
            <DropdownMenuLabel>{hostLabel}</DropdownMenuLabel>
            <p className="px-2 pb-1 font-mono text-xs text-fg-2 wrap-anywhere">{address}</p>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void copyWithToast(window.location.origin, t`已复制地址`)}><IconCopy /><Trans>复制地址</Trans></DropdownMenuItem>
          </MenuSub>
        </>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeMenu() {
  const { t } = useLingui();
  const { mode, themeId, resolved, paletteKey } = useTheme();
  const themes = useThemeOptions();
  const pluginPalettes = palettesOf(useAppearance().catalog);
  const options: { value: ThemeMode; label: string; icon: ReactNode }[] = [
    { value: 'system', label: t`跟随系统`, icon: <IconMonitor /> },
    { value: 'light', label: t`浅色`, icon: <IconSun /> },
    { value: 'dark', label: t`深色`, icon: <IconMoon /> },
  ];
  const current = options.find(option => option.value === mode) ?? options[0]!;
  return (
    <MenuSub icon={resolved === 'dark' ? <IconMoon /> : <IconSun />} label={t`主题`} value={current.label} className="w-52">
      <DropdownMenuLabel><Trans>明暗</Trans></DropdownMenuLabel>
      <DropdownMenuRadioGroup value={mode} onValueChange={(value) => setThemeMode(value as ThemeMode)}>
        {options.map(option => <DropdownMenuRadioItem key={option.value} value={option.value}>{option.icon}{option.label}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuLabel><Trans>主题</Trans></DropdownMenuLabel>
      <DropdownMenuRadioGroup value={paletteKey ?? themeId} onValueChange={(value) => {
        const plugin = pluginPalettes.find(item => item.key === value);
        if (plugin) selectAppearanceItem('palette', plugin.palette.id); else setThemeId(value);
      }}>
        {themes.map(theme => <DropdownMenuRadioItem key={theme.id} value={theme.id}><ThemeSwatch id={theme.id} className="h-4 w-6 rounded-sm" />{theme.name}</DropdownMenuRadioItem>)}
        {pluginPalettes.map(({ palette, key }) => <DropdownMenuRadioItem key={key} value={key}><ThemeSwatch id={key} className="h-4 w-6 rounded-sm" />{localizedText(palette.title) ?? palette.id}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </MenuSub>
  );
}
