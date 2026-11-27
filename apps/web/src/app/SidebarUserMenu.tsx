import type { ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { NativeBackendCatalogEntry, OwnerInfo } from '@contracts';
import { OwnerAvatar } from '@/components/OwnerAvatar';
import { ThemeSwatch } from '@/components/theme-swatch';
import { IconChevronRight, IconCopy, IconInbox, IconLaptop, IconMonitor, IconMoon, IconServer, IconSettings, IconSun, IconSwatchBook } from '@/components/icons';
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
  /** Unread / pending items in the standalone Inbox: shown as a compact dot on the avatar and count inside the menu. */
  inboxCount?: number;
  onOpenInbox?: () => void;
  onOpenChange?: (open: boolean) => void;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  onOpenTheme?: () => void;
}

/** Prefetch only; opening the menu or hovering the trigger does not mount the settings page. */
const preloadSettings = () => void import('./settings/SettingsPage');

/** Desktop sidebar footer's direct settings trigger; carries backend login/availability notices. */
export function SidebarSettingsButton({ backend, onOpen }: { backend?: NativeBackendCatalogEntry; onOpen: () => void }) {
  const { t } = useLingui();
  const backendNotice = backend?.needsLogin ? t`${backend.label} 未登录` : backend && !backend.available ? t`${backend.label} 不可用` : undefined;
  const label = [t`设置`, backendNotice].filter(Boolean).join(' · ');
  const ariaLabel = [t`设置`, backendNotice, backend?.reason].filter(Boolean).join(' · ');
  return (
    <Tip label={label} side="top">
      <Button
        asChild
        size="icon-sm"
        variant="quiet"
        aria-label={ariaLabel}
        onPointerEnter={preloadSettings}
        onFocus={preloadSettings}
        className="relative"
      >
        <a href="/settings" onClick={event => {
          if (event.defaultPrevented || event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
          event.preventDefault();
          onOpen();
        }}>
          <IconSettings />
          {backendNotice && <StatusDot tone="warning" className="absolute right-1 bottom-1 ring-2 ring-canvas" />}
        </a>
      </Button>
    </Tip>
  );
}

/** The sidebar footer's account menu: profile, inbox, theme, and connection info. */
export function SidebarUserMenu({ owner, backend, stale, mobile, inboxCount = 0, onOpenInbox, onOpenChange, onOpenProfile, onOpenSettings, onOpenTheme }: Props) {
  const { t } = useLingui();
  const { local, address } = hostInfo();
  const offline = stale?.mode === 'offline';
  const backendNotice = backend?.needsLogin ? t`${backend.label} 未登录` : backend && !backend.available ? t`${backend.label} 不可用` : undefined;
  const warning = offline ? t`无法连接服务器` : mobile ? backendNotice : undefined;
  const label = t`个人资料与更多`;
  const inboxNotice = inboxCount > 0 ? t`${inboxCount} 条收件箱待处理` : undefined;
  const tooltip = [owner?.name, label, inboxNotice, warning].filter(Boolean).join(' · ');
  const HostIcon = local ? IconLaptop : IconServer;
  const hostLabel = local ? t`本机` : t({ message: '远端', context: 'workbench-remote-host' });
  const badgeText = inboxCount > 99 ? '99+' : String(inboxCount);
  const avatar = <>
    <OwnerAvatar owner={owner} size={24} />
    {inboxCount > 0 && (
      <StatusDot
        tone="danger"
        className={cn('pointer-events-none absolute top-0.5 right-0.5 size-2 ring-2', mobile ? 'ring-sidebar' : 'ring-canvas')}
      />
    )}
    {warning && <StatusDot tone="warning" className={cn('absolute right-0 bottom-0 ring-2', mobile ? 'ring-sidebar' : 'ring-canvas')} />}
  </>;
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <Tip label={tooltip} side="top">
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="quiet" aria-label={tooltip} onPointerEnter={preloadSettings} onFocus={preloadSettings} className="relative rounded-full">
            {avatar}
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
        {onOpenInbox && (
          <DropdownMenuItem onSelect={onOpenInbox} textValue={t`收件箱`}>
            <IconInbox />
            <span className="min-w-0 flex-1 truncate"><Trans>收件箱</Trans></span>
            {inboxCount > 0 && (
              <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-danger px-1 text-2xs font-medium leading-none tabular-nums text-danger-fg">
                {badgeText}
              </span>
            )}
          </DropdownMenuItem>
        )}
        <ThemeMenu onOpenTheme={onOpenTheme} />
        {mobile && (
          <DropdownMenuItem onSelect={onOpenSettings} textValue={t`设置`}>
            <IconSettings />
            <span className="min-w-0 flex-1 truncate"><Trans>设置</Trans></span>
            {backendNotice && <StatusDot tone="warning" />}
          </DropdownMenuItem>
        )}
        <MenuSub icon={<HostIcon className={offline ? 'text-warning' : undefined} />} label={hostLabel} value={offline ? t`无法连接服务器` : stale ? t`正在同步` : address} className="w-64">
          <DropdownMenuLabel>{hostLabel}</DropdownMenuLabel>
          <p className="px-2 pb-1 font-mono text-xs text-fg-2 wrap-anywhere">{address}</p>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void copyWithToast(window.location.origin, t`已复制地址`)}><IconCopy /><Trans>复制地址</Trans></DropdownMenuItem>
        </MenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeMenu({ onOpenTheme }: { onOpenTheme?: () => void }) {
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
      {onOpenTheme && <>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenTheme}><IconSwatchBook /><Trans>自定义主题</Trans></DropdownMenuItem>
      </>}
    </MenuSub>
  );
}
