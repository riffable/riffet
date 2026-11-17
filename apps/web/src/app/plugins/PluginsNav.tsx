/** The plugin page's contents: what is installed, then each plugin source (patterns.md §1.4, 目录加正文). */
import type { ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { PluginSource } from '@contracts';
import { IconArrowUp, IconChevronDown, IconCircleAlert, IconGlobe, IconLayers, IconPackage, IconPlus, IconTriangleAlert } from '@/components/icons';
import { ListRow } from '@/components/ui/list-row';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { sourceName } from './PluginMarket';

/** `installed`, its `updates` and `attention` subsets, or `source:<id>` (`source:all` is every enabled source). */
export type PluginScope = 'installed' | 'updates' | 'attention' | `source:${string}`;
export const ALL_SOURCES: PluginScope = 'source:all';
export const sourceScope = (id: string): PluginScope => `source:${id}`;

export interface PluginNavCounts { installed?: number; updates: number; attention: number; available?: number; /** Listed entries per source id. */ bySource: Map<string, number> }

interface Item { scope: PluginScope; icon: ReactNode; label: string; count?: number; muted?: boolean; danger?: boolean }

function useItems(sources: PluginSource[] | undefined, counts: PluginNavCounts, scope: PluginScope) {
  const { t } = useLingui();
  const library: Item[] = [
    { scope: 'installed', icon: <IconPackage />, label: t({ message: '已安装' }), count: counts.installed },
    // The subsets appear when they have something in them, or while one is open.
    ...(counts.updates || scope === 'updates' ? [{ scope: 'updates' as const, icon: <IconArrowUp />, label: t({ message: '有更新' }), count: counts.updates }] : []),
    ...(counts.attention || scope === 'attention' ? [{ scope: 'attention' as const, icon: <IconCircleAlert />, label: t({ message: '异常' }), count: counts.attention }] : []),
  ];
  const several = (sources ?? []).filter(source => source.enabled).length > 1;
  const market: Item[] = [
    ...(several || !sources ? [{ scope: ALL_SOURCES, icon: <IconLayers />, label: t({ message: '全部插件源' }), count: counts.available }] : []),
    ...(sources ?? []).map(source => ({
      scope: sourceScope(source.id),
      icon: source.enabled && source.error ? <IconTriangleAlert /> : <IconGlobe />,
      label: sourceName(source),
      count: source.enabled && !source.error ? counts.bySource.get(source.id) ?? 0 : undefined,
      muted: !source.enabled,
      danger: source.enabled && Boolean(source.error),
    })),
  ];
  return { library, market };
}

export function PluginsAside({ sources, counts, scope, disabled, onScope, onAddSource }: {
  sources?: PluginSource[];
  counts: PluginNavCounts;
  scope: PluginScope;
  disabled: boolean;
  onScope(scope: PluginScope): void;
  onAddSource(): void;
}) {
  const { t } = useLingui();
  const { library, market } = useItems(sources, counts, scope);
  const row = (item: Item) => <ListRow
    key={item.scope}
    leading={<span className={cn(item.danger && 'text-danger')}>{item.icon}</span>}
    meta={item.count === undefined ? undefined : String(item.count)}
    selected={scope === item.scope}
    aria-current={scope === item.scope ? 'page' : undefined}
    disabled={disabled}
    className={cn(item.muted && scope !== item.scope && 'text-fg-4')}
    onClick={() => onScope(item.scope)}
  >{item.label}</ListRow>;
  return (
    <nav aria-label={t({ message: '插件' })} className="hidden w-56 shrink-0 flex-col overflow-y-auto px-3 pb-10 pt-9 lg:flex">
      <div className="mb-3 flex flex-col gap-px">{library.map(row)}</div>
      <div className="flex flex-col gap-px">
        <h3 className="px-2.5 pb-1 pt-2 text-2xs font-medium text-fg-4"><Trans>插件源</Trans></h3>
        {market.map(row)}
        <ListRow leading={<IconPlus />} disabled={disabled || !sources} aria-haspopup="dialog" onClick={onAddSource}><Trans>添加插件源</Trans></ListRow>
      </div>
    </nav>
  );
}

/** Below `lg` the contents fold into a menu beside the page title. */
export function PluginsScopeMenu({ sources, counts, scope, disabled, onScope, onAddSource }: Parameters<typeof PluginsAside>[0]) {
  const { t } = useLingui();
  const { library, market } = useItems(sources, counts, scope);
  const current = [...library, ...market].find(item => item.scope === scope);
  const item = (value: Item) => <DropdownMenuRadioItem key={value.scope} value={value.scope} className={cn(value.muted && 'text-fg-4')}>
    <span className={cn('contents', value.danger && 'text-danger')}>{value.icon}</span>
    <span className="min-w-0 flex-1 truncate">{value.label}</span>
    {value.count !== undefined && <span className="text-xs tabular-nums text-fg-3">{value.count}</span>}
  </DropdownMenuRadioItem>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger disabled={disabled} className="ml-1 flex h-7 min-w-0 items-center gap-1 rounded-md px-2 text-sm text-fg-2 outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 lg:hidden no-hover:min-h-11">
        <span className="min-w-0 truncate">{current?.label ?? t({ message: '已安装' })}</span>
        <IconChevronDown className="size-3.5 shrink-0 text-fg-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-[min(70dvh,560px)] w-64 overflow-y-auto">
        <DropdownMenuRadioGroup value={scope} onValueChange={value => onScope(value as PluginScope)}>
          {library.map(item)}
          <DropdownMenuSeparator />
          <DropdownMenuLabel><Trans>插件源</Trans></DropdownMenuLabel>
          {market.map(item)}
        </DropdownMenuRadioGroup>
        <DropdownMenuGroup>
          <DropdownMenuItem disabled={!sources} onSelect={onAddSource}><IconPlus /><Trans>添加插件源</Trans></DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
