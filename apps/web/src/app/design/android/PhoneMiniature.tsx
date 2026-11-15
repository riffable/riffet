import type { CSSProperties, ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconCheck, IconChevronRight, IconGlobe, IconHand, IconListTodo, IconMoon, IconSettings, IconSquarePen } from '@/components/icons';
import { cn } from '@/lib/utils';
import { ANDROID, type AndroidStyle, type TextStyle } from './values';

const font = (style: TextStyle): CSSProperties => ({ fontSize: style.size, lineHeight: `${style.line}px`, fontWeight: style.weight });

/**
 * A phone at 1:1 in dp, drawn in one Android style: a settings page with a segmented choice, a group
 * of rows, a pair of buttons, and the tab bar. Each part reads a dimension or recipe field, so a style
 * that recombines existing forms draws without new code here.
 */
export function PhoneMiniature({ style }: { style: AndroidStyle }) {
  const { t } = useLingui();
  const { dimensions: d, recipes: r, type } = style;
  const { width, height, status, gesture } = ANDROID.phone;

  const modes = [t`跟随系统`, t`浅色`, t`深色`];
  const chosen = 1;
  const segmented = (() => {
    const label = (text: string, index: number) => <span className="truncate">{index === chosen && r.segments === 'connected' && <IconCheck className="mr-1 inline size-4 align-[-3px]" />}{text}</span>;
    if (r.segments === 'underline') {
      return (
        <div className="flex edge-b" style={{ height: d.segmentedHeight }}>
          {modes.map((mode, index) => (
            <span key={mode} className={cn('relative flex flex-1 items-center justify-center', index === chosen ? 'text-fg' : 'text-fg-3')} style={font(type.label)}>
              {mode}{index === chosen && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-accent" />}
            </span>
          ))}
        </div>
      );
    }
    if (r.segments === 'pills') {
      return (
        <div className="flex gap-1.5" style={{ height: d.segmentedHeight }}>
          {modes.map((mode, index) => (
            <span key={mode} className={cn('flex flex-1 items-center justify-center rounded-full', index === chosen ? 'bg-accent/20 text-fg' : 'bg-fg/[0.05] text-fg-2')} style={font(type.label)}>{mode}</span>
          ))}
        </div>
      );
    }
    if (r.segments === 'sliding') {
      return (
        <div className="flex bg-fg/[0.06] p-0.5" style={{ height: d.segmentedHeight, borderRadius: d.controlRadius }}>
          {modes.map((mode, index) => (
            <span key={mode} className={cn('flex flex-1 items-center justify-center', index === chosen ? 'bg-elevated text-fg shadow-soft' : 'text-fg-2')} style={{ ...font(type.label), borderRadius: d.selectionRadius }}>{mode}</span>
          ))}
        </div>
      );
    }
    return (
      <div className="flex overflow-hidden rounded-full shadow-[inset_0_0_0_1px_var(--line-strong)]" style={{ height: d.segmentedHeight }}>
        {modes.map((mode, index) => (
          <span key={mode} className={cn('flex flex-1 items-center justify-center px-2', index > 0 && 'shadow-[inset_1px_0_0_var(--line-strong)]', index === chosen ? 'bg-accent/15 text-fg' : 'text-fg-2')} style={font(type.label)}>{label(mode, index)}</span>
        ))}
      </div>
    );
  })();

  const toggle = (
    <span className="flex shrink-0 items-center justify-end rounded-full bg-accent px-0.5" style={{ width: d.switchWidth, height: d.switchHeight }} aria-hidden>
      <span className="rounded-full bg-white shadow-soft" style={{ width: Math.min(d.switchThumbSize, d.switchHeight - 4), height: Math.min(d.switchThumbSize, d.switchHeight - 4) }} />
    </span>
  );
  const chevron = <IconChevronRight className="size-4 shrink-0 text-fg-4" />;
  const below = !r.selectionAtEnd;
  const rows: Array<{ icon: ReactNode; title: string; value?: string; trailing: ReactNode }> = [
    { icon: <IconMoon />, title: t`深色模式`, trailing: toggle },
    { icon: <IconGlobe />, title: t`语言`, value: t`简体中文`, trailing: chevron },
    { icon: <IconHand />, title: t`手势与触觉`, trailing: chevron },
  ];
  const card = r.card === 'elevated' ? 'bg-elevated shadow-soft' : r.card === 'whiteBlend' ? 'bg-elevated' : 'bg-fg/[0.045]';
  const group = (
    <div className="flex flex-col">
      <span className={cn('pb-2', r.accentSections ? 'font-medium text-accent' : 'text-fg-3')} style={{ ...font(type.caption), paddingLeft: r.card === 'tonal' ? 0 : d.rowPadding }}>{t`外观`}</span>
      <div className={cn('flex flex-col overflow-hidden', card)} style={{ borderRadius: d.groupRadius }}>
        {rows.map((row, index) => (
          <div key={row.title} className="flex items-center" style={{ minHeight: row.value && below ? d.rowSubtitleHeight : d.rowHeight, paddingLeft: d.rowPadding, paddingRight: d.rowPadding, gap: d.controlInset }}>
            <span className="flex shrink-0 items-center justify-center text-fg-2 [&_svg]:size-full" style={{ width: d.iconSize, height: d.iconSize }}>{row.icon}</span>
            <span className={cn('flex min-w-0 flex-1 self-stretch', below ? 'flex-col justify-center' : 'items-center justify-between gap-3', index > 0 && r.dividers && 'shadow-[inset_0_1px_0_var(--line)]')}>
              <span className="truncate text-fg" style={font(type.body)}>{row.title}</span>
              {row.value && <span className="truncate text-fg-3" style={font(type.caption)}>{row.value}</span>}
            </span>
            {row.trailing}
          </div>
        ))}
      </div>
    </div>
  );

  const buttonHeight = Math.max(32, d.controlHeight - 8);
  const secondary = r.secondaryButtons === 'plain' ? 'text-accent' : r.secondaryButtons === 'outlined' ? 'text-fg shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'bg-fg/[0.08] text-fg';
  const buttons = (
    <div className="flex justify-end gap-2">
      <span className={cn('flex items-center px-5', secondary)} style={{ ...font(type.label), height: buttonHeight, borderRadius: d.controlRadius }}>{t`取消`}</span>
      <span className="flex items-center bg-accent px-5 text-accent-fg" style={{ ...font(type.label), height: buttonHeight, borderRadius: d.controlRadius }}>{t`保存`}</span>
    </div>
  );

  const floating = r.navigation === 'floating';
  const tabs = [<IconSquarePen key="new" />, <IconListTodo key="tasks" />, <IconSettings key="settings" />];
  const selectedTab = 2;
  const tabBar = (
    <div
      className={cn('absolute flex items-stretch', floating ? 'rounded-full bg-elevated/95 p-1.5 shadow-pop' : 'bg-elevated', !floating && r.indicator === 'topLine' && 'edge-t')}
      style={floating
        ? { left: d.tabBarInset, right: d.tabBarInset, bottom: gesture + d.tabBarBottomInset, height: d.tabBarHeight }
        : { left: 0, right: 0, bottom: 0, height: d.tabBarHeight + gesture, paddingBottom: gesture }}
    >
      {tabs.map((icon, index) => {
        const on = index === selectedTab;
        const fill = r.indicator === 'fill' || r.indicator === 'capsule';
        return (
          <span key={index} className="relative flex flex-1 items-center justify-center">
            {on && fill && <span className={cn('absolute bg-accent/15', floating ? 'inset-0 rounded-full' : 'h-8 w-16')} style={floating ? undefined : { borderRadius: r.indicator === 'capsule' ? 999 : d.rowRadius }} />}
            {on && r.indicator === 'topLine' && <span className="absolute inset-x-6 top-0 h-0.5 rounded-full bg-accent" />}
            {on && r.indicator === 'bottomDot' && <span className="absolute bottom-2 size-1 rounded-full bg-accent" />}
            <span className={cn('relative flex items-center justify-center [&_svg]:size-full', on ? 'text-accent' : 'text-fg-3')} style={{ width: d.iconSize, height: d.iconSize }}>{icon}</span>
          </span>
        );
      })}
    </div>
  );

  return (
    <div
      role="img"
      aria-label={t`${style.id} 风格的手机缩样`}
      // A grouped list on the ios style sits on a darker page, so its white cards read as cards.
      className={cn('relative shrink-0 overflow-hidden shadow-[0_0_0_1px_var(--line-strong)]', r.card === 'whiteBlend' ? 'bg-canvas' : 'bg-bg')}
      style={{ width, height, borderRadius: 32, fontFamily: 'Roboto, "Noto Sans SC", system-ui, sans-serif' }}
    >
      <div className="flex items-center justify-between px-6 text-fg-2" style={{ height: status, fontSize: 12 }} aria-hidden>
        <span className="tabular-nums">9:41</span>
        <span className="flex gap-1"><span className="size-2.5 rounded-full bg-fg/30" /><span className="h-2.5 w-4 rounded-sm bg-fg/30" /></span>
      </div>
      <div className={cn('flex items-center', r.centeredTitle && 'justify-center')} style={{ height: d.barHeight, paddingLeft: d.pageInset, paddingRight: d.pageInset }}>
        <span className="text-fg" style={font(type.barTitle)}>{t`设置`}</span>
      </div>
      <div className="flex flex-col" style={{ paddingLeft: d.pageInset, paddingRight: d.pageInset, paddingTop: d.pageTitleGap / 2, gap: d.sectionGap }}>
        {segmented}
        {group}
        {buttons}
      </div>
      {tabBar}
      {floating && <span className="absolute bottom-1.5 left-1/2 h-1 w-24 -translate-x-1/2 rounded-full bg-fg/25" aria-hidden />}
    </div>
  );
}
