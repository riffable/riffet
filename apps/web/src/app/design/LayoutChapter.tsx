import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconPanelLeft, IconPlus, IconSearch } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { DEFAULT_CONTENT_WIDTH, MAX_CONTENT_WIDTH, MIN_CONTENT_WIDTH } from '@/lib/content-width';
import { cn } from '@/lib/utils';
import { COLUMN_GUTTER_TOTAL } from '../session/ContentWidthHandle';
import { PANEL_DEFAULT, panelDockMinWidth, SIDEBAR_DEFAULT } from '../state/uiStore';
import { Chapter, Frame, Plate, Scrubber } from './specimen';

/** The widest window the figure draws, and the height every window is drawn at. */
const WIDEST = 1920;
const HEIGHT = 900;
/** Below this the workbench takes its phone layout (`MOBILE_LAYOUT_QUERY`). */
const PHONE_BELOW = 768;
const MAIN_INSET = 8;
const PANEL_GUTTER = 8;
const PHONE_PADDING = 32;

/** The workbench's regions at one window width, by the rules the shell uses. */
function regions(width: number) {
  const phone = width < PHONE_BELOW;
  const sidebar = phone ? 0 : Math.min(SIDEBAR_DEFAULT, Math.round(width * 0.4));
  const main = phone ? width : width - sidebar - MAIN_INSET;
  const docked = !phone && width >= panelDockMinWidth(SIDEBAR_DEFAULT, PANEL_DEFAULT);
  const session = docked ? main - PANEL_DEFAULT - PANEL_GUTTER : main;
  const column = phone ? width - PHONE_PADDING : Math.min(DEFAULT_CONTENT_WIDTH, session - COLUMN_GUTTER_TOTAL);
  return { phone, sidebar, main, docked, session, column };
}

const pct = (value: number, of: number) => `${(value / of) * 100}%`;

/** The workbench drawn to scale for a window width the reader sets. */
function Workbench() {
  const { t } = useLingui();
  const [width, setWidth] = useState(1440);
  const { phone, sidebar, main, docked, session, column } = regions(width);
  const dockAt = panelDockMinWidth(SIDEBAR_DEFAULT, PANEL_DEFAULT);
  const header = phone ? 48 : 52;
  const bar = 'h-1.5 rounded-full bg-fg/[0.1]';
  const readout: Array<[string, string]> = [
    [t`布局`, phone ? t`手机` : t`桌面`],
    [t`侧栏`, phone ? t`抽屉` : `${sidebar}`],
    [t`会话区`, `${session}`],
    [t`内容列`, `${column}`],
    [t`面板`, phone ? t`全屏` : docked ? `${PANEL_DEFAULT}` : t({ message: '悬浮', context: 'design-panel-state' })],
  ];
  return (
    <Frame className="flex flex-col gap-8 p-8 max-md:p-4">
      <div className="relative w-full" style={{ aspectRatio: `${WIDEST} / ${HEIGHT}` }}>
        <div className="absolute left-0 top-0 h-full overflow-hidden rounded-lg bg-canvas shadow-[0_0_0_1px_var(--line-strong)]" style={{ width: pct(width, WIDEST) }}>
          {!phone && (
            <div className="absolute inset-y-0 left-0 flex flex-col gap-[6%] bg-sidebar px-[2%] pt-[4%]" style={{ width: pct(sidebar, width) }}>
              {[70, 55, 62, 48, 58].map((length, index) => <span key={index} className={bar} style={{ width: `${length}%` }} />)}
            </div>
          )}
          <div
            className={cn('absolute flex overflow-hidden bg-bg', !phone && 'rounded-md shadow-[0_0_0_1px_var(--line)]')}
            style={phone ? { inset: 0 } : { left: pct(sidebar, width), right: pct(MAIN_INSET, width), top: pct(MAIN_INSET, HEIGHT), bottom: pct(MAIN_INSET, HEIGHT) }}
          >
            <div className="relative flex min-w-0 flex-col" style={{ width: pct(session, main) }}>
              <div className="flex shrink-0 items-center px-[3%] edge-b" style={{ height: pct(header, HEIGHT) }}><span className={cn(bar, 'w-1/4')} /></div>
              <div className="relative flex-1">
                <div className="absolute inset-y-[8%] left-1/2 flex -translate-x-1/2 flex-col gap-[5%] rounded-sm bg-fg/[0.04] p-[3%] shadow-[inset_0_0_0_1px_var(--line-strong)]" style={{ width: pct(column, session) }}>
                  {[90, 70, 84, 40].map((length, index) => <span key={index} className={bar} style={{ width: `${length}%` }} />)}
                </div>
              </div>
            </div>
            {docked && <div className="flex-1 bg-subtle edge-l" />}
          </div>
          {!phone && !docked && <div className="absolute rounded-md bg-elevated shadow-pop" style={{ right: pct(24, width), top: pct(96, HEIGHT), width: pct(PANEL_DEFAULT, width), height: '58%' }} />}
        </div>
      </div>
      <div className="grid grid-cols-5 gap-4 max-md:grid-cols-3">
        {readout.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1">
            <span className="text-xs text-fg-3">{label}</span>
            <span className="font-mono text-sm tabular-nums text-fg">{value}</span>
          </div>
        ))}
      </div>
      <Scrubber label={t`窗口宽度`} value={width} min={360} max={WIDEST} step={8} unit="px" marks={[PHONE_BELOW, dockAt]} onChange={setWidth} />
    </Frame>
  );
}

/** The three column widths on one ruler. */
function Columns() {
  const { t } = useLingui();
  const tiers: Array<{ name: string; width: number; use: string; range?: [number, number] }> = [
    { name: t({ message: '阅读', context: 'content-column' }), width: DEFAULT_CONTENT_WIDTH, use: t`对话、终端、输入框`, range: [MIN_CONTENT_WIDTH, MAX_CONTENT_WIDTH] },
    { name: t`文档`, width: 768, use: t`列表、表单、项目主页` },
    { name: t`看板`, width: 1200, use: t`统计、设计规范` },
  ];
  return (
    <Frame className="flex flex-col gap-6 p-8 max-md:p-4">
      {tiers.map((tier) => (
        <div key={tier.name} className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-4 text-sm">
            <span className="text-fg">{tier.name}<span className="ml-3 text-fg-3">{tier.use}</span></span>
            <span className="font-mono text-xs tabular-nums text-fg-2">{tier.width}{tier.range && <span className="text-fg-4">{`  ${tier.range[0]}–${tier.range[1]}`}</span>}</span>
          </div>
          <div className="relative h-3 rounded-full bg-fg/[0.05]">
            {tier.range && <span className="absolute inset-y-0 rounded-full bg-fg/[0.08]" style={{ left: pct(tier.range[0], MAX_CONTENT_WIDTH), width: pct(tier.range[1] - tier.range[0], MAX_CONTENT_WIDTH) }} />}
            <span className="absolute inset-y-0 left-0 rounded-full bg-fg" style={{ width: pct(tier.width, MAX_CONTENT_WIDTH) }} />
          </div>
        </div>
      ))}
    </Frame>
  );
}

/** A page header with its measurements. */
function PageHeader() {
  const { t } = useLingui();
  const label = 'font-mono text-2xs text-fg-3';
  return (
    <Frame className="flex flex-col gap-3 p-8 max-md:p-4">
      <div className="flex justify-between"><span className={label}>{t`左内边距 16 · 手机 12`}</span><span className={label}>{t`高 52 · 手机 48`}</span></div>
      <div className="flex h-13 items-center gap-2 rounded-lg bg-bg pl-4 pr-3 shadow-[0_0_0_1px_var(--line)]">
        <Button size="icon-sm" variant="quiet" tabIndex={-1} aria-hidden><IconPanelLeft /></Button>
        <span className="text-sm font-medium text-fg">{t`定时任务`}</span>
        <span className="ml-auto flex items-center gap-1">
          <Button size="icon-sm" variant="quiet" tabIndex={-1} aria-hidden><IconSearch /></Button>
          <Button size="sm" variant="primary" tabIndex={-1}><IconPlus />{t`新建`}</Button>
        </span>
      </div>
      <div className="flex justify-between"><span className={label}>{t`侧栏按钮 · 标题`}</span><span className={label}>{t`图标按钮 · 主操作`}</span></div>
    </Frame>
  );
}

export function LayoutChapter() {
  const { t } = useLingui();
  return (
    <Chapter id="layout" number="09" title={t`布局`} lede={t`工作台分为侧栏、主区、面板与终端四块；页面由页头和一条居中的内容列组成，内容列取三档宽度之一。`} source="docs/design/system/patterns.md">
      <Plate number="9.1" title={t`工作台`} note={t`宽度小于 768 时进入手机布局；达到 ${panelDockMinWidth(SIDEBAR_DEFAULT, PANEL_DEFAULT)} 时面板停靠，窄于它时悬浮。图中数值由工作台的同一组常量算出。`}>
        <Workbench />
      </Plate>
      <Plate number="9.2" title={t`内容列`} note={t`阅读列的宽度由读者拖动调整；文档列和看板列固定。`}>
        <Columns />
      </Plate>
      <Plate number="9.3" title={t`页头`} note={t`页面只有一个滚动容器，页头固定在它上方。`}>
        <PageHeader />
      </Plate>
    </Chapter>
  );
}
