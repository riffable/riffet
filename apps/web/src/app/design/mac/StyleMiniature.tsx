import type { CSSProperties, ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { DesktopStyle } from '@contracts';
import { IconChevronDown, IconChevronRight, IconFolder, IconSquareTerminal } from '@/components/icons';
import { cn } from '@/lib/utils';
import { fontStack, MAC, points } from './values';

/**
 * A Mac window drawn at 1:1 in one style's tokens and recipes: its frame, sidebar, header, a turn
 * with a tool run and a code block, the composer, and the model menu opened from it. Each part reads a
 * recipe field, so a style that recombines existing forms draws without new code here; a form this
 * figure does not know yet falls back to the plainest drawing of its family.
 */
export function StyleMiniature({ style }: { style: DesktopStyle }) {
  const { t } = useLingui();
  const { recipes } = style;
  const radii = Object.fromEntries(Object.entries(style.tokens.radii).map(([key, value]) => [key, points(value)])) as Record<keyof DesktopStyle['tokens']['radii'], number>;
  const text = { body: points(style.tokens.text.body), secondary: points(style.tokens.text.secondary), label: points(style.tokens.text.label), sidebar: points(style.tokens.text.sidebar) };
  const { sidebarWidth, sidebarRow, sidebarGap, header } = style.tokens.layout;
  const ui: CSSProperties = { fontFamily: fontStack(style.tokens.fonts.ui) };
  const mono: CSSProperties = { fontFamily: fontStack(style.tokens.fonts.mono, true) };
  const inset = recipes.window === 'insetCard' ? MAC.cardInset : 0;
  const floatingSidebar = recipes.window === 'system';
  const selected = recipes.selection === 'wash' ? 'bg-accent/15 text-fg' : 'bg-active text-fg';
  const accentInk = recipes.ink === 'brand';

  const groups: Array<{ label?: string; rows: Array<{ title: string; icon?: ReactNode; indent?: boolean }> }> =
    recipes.sidebar === 'projectTree'
      ? [{ rows: [{ title: 'riffet', icon: <IconFolder /> }, { title: t`整理超时常量`, indent: true }, { title: t`修复首帧跳变`, indent: true }, { title: 'riffet-plugins', icon: <IconFolder /> }] }]
      : recipes.sidebar === 'timeGroups'
        ? [{ label: t`置顶`, rows: [{ title: t`发布清单` }] }, { label: t`最近`, rows: [{ title: t`整理超时常量` }, { title: t`修复首帧跳变` }] }]
        : [{ label: t`今天`, rows: [{ title: t`整理超时常量` }, { title: t`修复首帧跳变` }] }, { label: t`本周`, rows: [{ title: t`发布清单` }] }];
  const current = t`整理超时常量`;

  const sidebar = (
    <div
      className={cn('absolute flex flex-col overflow-hidden', floatingSidebar ? 'bg-sidebar/90 shadow-[0_0_0_1px_var(--line)]' : 'bg-sidebar', recipes.window === 'flat' && 'bg-bg edge-r')}
      style={floatingSidebar ? { left: 8, top: 8, bottom: 8, width: sidebarWidth - 16, borderRadius: radii.floating } : { left: 0, top: 0, bottom: 0, width: sidebarWidth }}
    >
      <div className="flex shrink-0 items-center gap-2 px-4" style={{ height: header }} aria-hidden>
        {[0, 1, 2].map((dot) => <span key={dot} className="size-3 rounded-full bg-fg/[0.14]" />)}
      </div>
      <div className="flex flex-col px-2">
        {groups.map((group, index) => (
          <div key={index} className="flex flex-col" style={{ marginTop: index ? sidebarGap : 0 }}>
            {group.label && <span className="flex items-end px-2 pb-1 font-medium text-fg-3" style={{ fontSize: text.label, height: text.label + 12 }}>{group.label}</span>}
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

  const headerBar = recipes.header === 'sessionTabs' ? (
    <div className="flex shrink-0 items-center gap-1 px-2 edge-b" style={{ height: header }}>
      <span className="flex items-center bg-active px-3 text-fg" style={{ height: 28, borderRadius: radii.control, fontSize: text.body }}>{current}</span>
      {[t`修复首帧跳变`, t`发布清单`].map((title) => <span key={title} className="px-3 text-fg-3" style={{ fontSize: text.body }}>{title}</span>)}
    </div>
  ) : (
    <div className={cn('flex shrink-0 items-center gap-1.5 px-4', recipes.header === 'titleMenu' && 'edge-b')} style={{ height: header }}>
      <span className="font-medium text-fg" style={{ fontSize: text.body }}>{current}</span>
      {recipes.header === 'titleMenu' && <IconChevronDown className="size-3.5 text-fg-3" />}
      <span className="ml-auto flex gap-3" aria-hidden>{[0, 1, 2].map((dot) => <span key={dot} className="size-3.5 rounded-xs bg-fg/[0.12]" />)}</span>
    </div>
  );

  const inlineCode = recipes.inlineCode === 'plain'
    ? <span style={{ ...mono, fontSize: '0.86em' }}>TIMEOUT_MS</span>
    : <span className="rounded-xs bg-fg/[0.07] px-1" style={{ ...mono, fontSize: '0.86em' }}>TIMEOUT_MS</span>;
  const block = recipes.block === 'outlined' ? 'shadow-[inset_0_0_0_1px_var(--line)]' : 'bg-fg/[0.04]';
  const toolRun = recipes.toolRun === 'labelled' ? (
    <span className="flex items-center gap-2 text-fg-2" style={{ fontSize: text.body }}>
      <IconSquareTerminal className="size-3.5 text-fg-3" /><span className="font-medium text-fg">Bash</span><span className="truncate text-fg-3" style={mono}>pnpm test --filter web</span>
    </span>
  ) : (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1 text-fg-3" style={{ fontSize: text.body }}>{t`已运行 2 个命令`}<IconChevronRight className="size-3" /></span>
      {recipes.toolRun === 'list' && (
        <div className={cn('flex flex-col', block)} style={{ borderRadius: radii.container }}>
          {['pnpm typecheck', 'pnpm test --filter web'].map((command, index) => <span key={command} className={cn('truncate px-3 py-1.5 text-fg-2', index && 'edge-t')} style={{ ...mono, fontSize: text.secondary }}>{command}</span>)}
        </div>
      )}
    </div>
  );

  const composer = recipes.composer === 'line' ? (
    <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-bg px-5 pb-3 pt-3 edge-t">
      <span className="text-fg-4" style={{ fontSize: text.body }}>{t`回复…`}</span>
      <span className="flex gap-3 text-fg-3" style={{ fontSize: text.secondary }}><span>~/riffet</span><span>main</span><span>Sonnet</span></span>
    </div>
  ) : (
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
      className={cn('absolute right-5 flex w-48 flex-col shadow-pop', recipes.menu === 'drawn' ? 'bg-popover' : 'bg-popover/75 backdrop-blur-xl')}
      // Opened upward from the composer's model chip, over the space between the turn and the composer.
      style={{ bottom: recipes.composer === 'line' ? 76 : 108, padding: MAC.menu.pad, borderRadius: radii.menu }}
    >
      {['Sonnet 5.5', 'Opus 5.5'].map((label, index) => (
        <span key={label} className={cn('flex items-center px-2.5 text-fg', !index && 'bg-hover')} style={{ height: MAC.menu.row, borderRadius: menuRow, fontSize: text.body }}>{label}</span>
      ))}
      <span className="mx-2.5 my-1 h-px bg-line" />
      <span className="flex items-center justify-between px-2.5 text-fg" style={{ height: MAC.menu.row, fontSize: text.body }}>
        {t`思考`}
        <span className={cn('flex h-[18px] w-8 items-center justify-end rounded-full p-0.5', accentInk ? 'bg-accent' : 'bg-primary')} aria-hidden>
          <span className={cn('size-3.5 rounded-full', accentInk ? 'bg-white' : 'bg-primary-fg')} />
        </span>
      </span>
    </div>
  );

  const card = recipes.surface === 'outlined' ? 'shadow-[inset_0_0_0_1px_var(--line)]' : 'shadow-soft';
  return (
    <div className="overflow-x-auto">
      <div
        role="img"
        aria-label={t`${style.id} 风格的窗口缩样`}
        className={cn('relative h-[480px] min-w-[720px] overflow-hidden rounded-xl shadow-[0_0_0_1px_var(--line-strong)]', recipes.window === 'insetCard' ? 'bg-sidebar' : 'bg-bg')}
        style={ui}
      >
        {sidebar}
        <div
          className={cn('absolute flex flex-col overflow-hidden bg-bg', recipes.window === 'insetCard' && 'shadow-[0_0_0_1px_var(--line)]')}
          style={{ left: sidebarWidth, top: inset, right: inset, bottom: inset, borderRadius: inset ? radii.card : 0 }}
        >
          {headerBar}
          <div className="flex flex-col gap-3 px-6 pt-4">
            <p className="max-w-md text-fg" style={{ fontSize: 14, lineHeight: `${style.tokens.text.readingLine}px` }}><Trans>超时统一读 {inlineCode}，两处手写的 30 秒都换掉了。</Trans></p>
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
