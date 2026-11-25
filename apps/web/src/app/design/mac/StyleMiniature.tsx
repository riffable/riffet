import type { CSSProperties, ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconChevronRight, IconFolder } from '@/components/icons';
import { cn } from '@/lib/utils';
import { fontStack, MAC, points, STYLE } from './values';

/**
 * The Mac window drawn at 1:1 in the style's values: inset content card, project-tree sidebar,
 * session tabs, a turn with a tool run and a code block, the composer, and the model menu opened from it.
 */
export function StyleMiniature() {
  const { t } = useLingui();
  const style = STYLE;
  const radii = Object.fromEntries(Object.entries(style.radii).map(([key, value]) => [key, points(value)])) as Record<keyof typeof style.radii, number>;
  const text = { body: points(style.text.body), secondary: points(style.text.secondary), label: points(style.text.label), sidebar: points(style.text.sidebar) };
  const { sidebarWidth, sidebarRow, sidebarGap, header } = style.layout;
  const ui: CSSProperties = { fontFamily: fontStack(style.fonts.ui) };
  const mono: CSSProperties = { fontFamily: fontStack(style.fonts.mono, true) };
  const inset = MAC.cardInset;
  const selected = 'bg-active text-fg';

  const groups: Array<{ rows: Array<{ title: string; icon?: ReactNode; indent?: boolean }> }> = [
    { rows: [{ title: 'riffet', icon: <IconFolder /> }, { title: t`整理超时常量`, indent: true }, { title: t`修复首帧跳变`, indent: true }, { title: 'riffet-plugins', icon: <IconFolder /> }] },
  ];
  const current = t`整理超时常量`;

  const sidebar = (
    <div
      className="absolute flex flex-col overflow-hidden bg-sidebar"
      style={{ left: 0, top: 0, bottom: 0, width: sidebarWidth }}
    >
      <div className="flex shrink-0 items-center gap-2 px-4" style={{ height: header }} aria-hidden>
        {[0, 1, 2].map((dot) => <span key={dot} className="size-3 rounded-full bg-fg/[0.14]" />)}
      </div>
      <div className="flex flex-col px-2">
        {groups.map((group, index) => (
          <div key={index} className="flex flex-col" style={{ marginTop: index ? sidebarGap : 0 }}>
            {group.rows.map((row) => (
              <span
                key={row.title}
                className={cn('flex items-center gap-2 truncate px-2 text-fg-2 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-fg-3', row.title === current && selected)}
                style={{ height: sidebarRow, fontSize: text.sidebar, borderRadius: radii.control, paddingLeft: row.indent ? 30 : undefined }}
              >
                {row.icon}<span className="truncate">{row.title}</span>
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );

  const headerBar = (
    <div className="flex shrink-0 items-center gap-1 px-2 edge-b" style={{ height: header }}>
      <span className="flex items-center bg-active px-3 text-fg" style={{ height: 28, borderRadius: radii.control, fontSize: text.body }}>{current}</span>
      {[t`修复首帧跳变`, t`发布清单`].map((title) => <span key={title} className="px-3 text-fg-3" style={{ fontSize: text.body }}>{title}</span>)}
    </div>
  );

  const inlineCode = <span className="rounded-xs bg-fg/[0.07] px-1" style={{ ...mono, fontSize: '0.86em' }}>TIMEOUT_MS</span>;
  const block = 'bg-fg/[0.04]';
  const toolRun = (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1 text-fg-3" style={{ fontSize: text.body }}>{t`已运行 2 个命令`}<IconChevronRight className="size-3" /></span>
      <div className={cn('flex flex-col', block)} style={{ borderRadius: radii.container }}>
        {['pnpm typecheck', 'pnpm test --filter web'].map((command, index) => <span key={command} className={cn('truncate px-3 py-1.5 text-fg-2', index && 'edge-t')} style={{ ...mono, fontSize: text.secondary }}>{command}</span>)}
      </div>
    </div>
  );

  const composer = (
    <div className="absolute inset-x-5 bottom-4 flex flex-col gap-2 bg-elevated p-3 shadow-composer" style={{ borderRadius: radii.floating }}>
      <span className="text-fg-4" style={{ fontSize: 14 }}>{t`回复…`}</span>
      <span className="flex items-center gap-1">
        <span className="flex items-center px-2 text-fg-3" style={{ height: 26, borderRadius: radii.control, fontSize: text.secondary }}>{t`自动`}</span>
        <span className="ml-auto flex items-center px-2 text-fg-3" style={{ height: 26, borderRadius: radii.control, fontSize: text.secondary }}>Sonnet</span>
        <span className="size-7 rounded-full bg-primary" aria-hidden />
      </span>
    </div>
  );

  const menuRow = Math.min(radii.container, Math.max(4, radii.menu - MAC.menu.pad));
  const menu = (
    <div
      className="absolute right-5 flex w-48 flex-col bg-popover shadow-pop"
      // Opened upward from the composer's model chip, over the space between the turn and the composer.
      style={{ bottom: 108, padding: MAC.menu.pad, borderRadius: radii.menu }}
    >
      {['Sonnet 5.5', 'Opus 5.5'].map((label, index) => (
        <span key={label} className={cn('flex items-center px-2.5 text-fg', !index && 'bg-hover')} style={{ height: MAC.menu.row, borderRadius: menuRow, fontSize: text.body }}>{label}</span>
      ))}
      <span className="mx-2.5 my-1 h-px bg-line" />
      <span className="flex items-center justify-between px-2.5 text-fg" style={{ height: MAC.menu.row, fontSize: text.body }}>
        {t`思考`}
        <span className="flex h-[18px] w-8 items-center justify-end rounded-full bg-primary p-0.5" aria-hidden>
          <span className="size-3.5 rounded-full bg-primary-fg" />
        </span>
      </span>
    </div>
  );

  const card = 'shadow-soft';
  return (
    <div className="overflow-x-auto">
      <div
        role="img"
        aria-label={t`窗口缩样`}
        className="relative h-[480px] min-w-[720px] overflow-hidden rounded-xl bg-sidebar shadow-[0_0_0_1px_var(--line-strong)]"
        style={ui}
      >
        {sidebar}
        <div
          className="absolute flex flex-col overflow-hidden bg-bg shadow-[0_0_0_1px_var(--line)]"
          style={{ left: sidebarWidth, top: inset, right: inset, bottom: inset, borderRadius: radii.card }}
        >
          {headerBar}
          <div className="flex flex-col gap-3 px-6 pt-4">
            <p className="max-w-md text-fg" style={{ fontSize: 14, lineHeight: `${style.text.readingLine}px` }}><Trans>超时统一读 {inlineCode}，两处手写的 30 秒都换掉了。</Trans></p>
            <div className={cn('flex max-w-md flex-col gap-2 bg-bg p-3', card)} style={{ borderRadius: radii.card }}>
              {toolRun}
              <span className={cn('block px-3 py-2 text-fg-2', block)} style={{ ...mono, fontSize: text.secondary, borderRadius: radii.container }}>export const TIMEOUT_MS = 30_000</span>
            </div>
          </div>
          {composer}
          {menu}
        </div>
      </div>
    </div>
  );
}
