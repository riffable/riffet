import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconMaximize, IconPictureInPicture, IconPlus, IconRefreshCw, IconTerminal, IconX } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Segmented, UnderlineTabs } from '@/components/ui/controls';
import { DOCK_DEFAULT, DOCK_MAX, DOCK_MIN, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, SIDEBAR_DEFAULT, panelDockMinWidth } from '@/app/state/uiStore';
import { INSET, MIN_H, MIN_W, SNAP } from '@/app/panels/FloatingPanelFrame';
import { cn } from '@/lib/utils';
import { Chapter, Frame, Matrix, Plate, Value } from '../specimen';
import { Legend, Line, Mark } from './wire';

const FLOAT = { minWidth: MIN_W, minHeight: MIN_H, snap: SNAP, inset: INSET } as const;

type Mode = 'docked' | 'floating' | 'fullscreen';

/** A miniature of the workbench: sidebar, session, and the panel in one of its three forms. */
function Miniature({ mode }: { mode: Mode }) {
  return (
    <div className="relative flex h-44 overflow-hidden rounded-xl bg-sidebar shadow-[0_0_0_1px_var(--line)]">
      <div className="flex w-1/5 shrink-0 flex-col gap-2 p-2"><Line w="w-2/3" /><Line w="w-1/2" /><Line w="w-3/4" /></div>
      <div className="relative my-1.5 mr-1.5 flex-1 rounded-lg bg-bg shadow-[0_0_0_1px_var(--line)]">
        <div className="flex flex-col gap-2 p-3"><Line w="w-1/2" /><Line w="w-2/3" /><Line w="w-1/3" /></div>
      </div>
      {mode === 'docked' && <div className="absolute inset-y-1.5 right-1.5 w-[34%] rounded-lg bg-bg shadow-[0_0_0_1px_var(--line-strong)]"><div className="h-5 edge-b" /></div>}
      {mode === 'floating' && <div className="absolute right-4 top-4 h-24 w-[38%] rounded-lg bg-bg shadow-pop"><div className="h-5 edge-b" /></div>}
      {mode === 'fullscreen' && <div className="absolute inset-y-1.5 left-[20%] right-1.5 rounded-lg bg-bg shadow-[0_0_0_1px_var(--line-strong)]"><div className="h-5 edge-b" /></div>}
    </div>
  );
}

function Forms() {
  const { t } = useLingui();
  const dock = panelDockMinWidth(SIDEBAR_DEFAULT, PANEL_DEFAULT);
  const dockCollapsed = panelDockMinWidth(undefined, PANEL_DEFAULT);
  return (
    <div className="flex flex-col gap-8">
      <Frame className="grid gap-6 p-6 md:grid-cols-3 max-md:p-4">
        {([['docked', t`停靠`], ['floating', t`悬浮`], ['fullscreen', t`全屏`]] as Array<[Mode, string]>).map(([mode, label]) => (
          <div key={mode} className="flex flex-col gap-2"><Miniature mode={mode} /><span className="text-sm text-fg">{label}</span></div>
        ))}
      </Frame>
      <Matrix
        columns={[t`取值`]}
        rows={[
          { label: t`停靠宽度`, cells: [<Value key="a">{PANEL_MIN}–{PANEL_MAX} · {t`默认`} {PANEL_DEFAULT}</Value>] },
          { label: t`停靠阈值`, cells: [<Value key="a">≥ {dock} · {t`侧栏收起`} ≥ {dockCollapsed}</Value>] },
          { label: t`停靠外边距`, cells: [<Value key="a">8 · {t`圆角`} 12</Value>] },
          { label: t`悬浮下限`, cells: [<Value key="a">{FLOAT.minWidth} × {FLOAT.minHeight}</Value>] },
          { label: t`悬浮吸附`, cells: [<Value key="a">{t`距边缘 ≤`} {FLOAT.snap} · {t`内缩`} {FLOAT.inset}</Value>] },
          { label: t`窄窗口与手机`, cells: [<Value key="a">{t`底部面板`}</Value>] },
        ]}
      />
    </div>
  );
}

function Header() {
  const { t } = useLingui();
  const [tab, setTab] = useState('changes');
  const [floating, setFloating] = useState(false);
  return (
    <div className="flex flex-col gap-8">
      <Frame className="p-6 max-md:p-3">
        <div className="relative mx-auto flex w-full max-w-[380px] flex-col overflow-hidden rounded-xl bg-bg shadow-[0_0_0_1px_var(--line-strong)]">
          <div className="flex h-12 shrink-0 items-stretch gap-2 edge-b px-1.5">
            <Mark n={1} className="left-1 top-0.5" />
            <UnderlineTabs value={tab} onChange={setTab} ariaLabel={t`上下文视图`} className="shrink-0" options={[{ value: 'changes', label: t`变更` }, { value: 'files', label: t`文件` }, { value: 'browser', label: t`浏览器` }]} />
            <div className="relative ml-auto flex shrink-0 items-center pr-1.5">
              <Mark n={2} className="-top-1 right-0" />
              <Button size="icon-xs" variant="quiet" aria-label={t`悬浮`} aria-pressed={floating} onClick={() => setFloating(!floating)}><IconPictureInPicture /></Button>
              <Button size="icon-xs" variant="quiet" aria-label={t`全屏`}><IconMaximize /></Button>
              <Button size="icon-xs" variant="quiet" aria-label={t`关闭面板`}><IconX /></Button>
            </div>
          </div>
          <div className="flex h-24 flex-col gap-3 p-4"><Line w="w-3/4" /><Line w="w-1/2" /><Line w="w-2/3" /></div>
        </div>
      </Frame>
      <Legend items={[
        { n: 1, name: t`页签`, value: t`下划线页签，放不下的进入末尾菜单，当前页签始终可见`, source: 'ContextPanel.tsx' },
        { n: 2, name: t`操作`, value: t`悬浮 · 全屏 · 关闭，quiet icon-xs；标题栏高 48，可拖动`, source: 'data-panel-drag' },
      ]} />
      <Matrix
        columns={[t`页签`, t`来源`, t`出现条件`]}
        rows={[
          { label: 'changes', cells: [<Value key="a">{t`变更`}</Value>, <Value key="b">hostViews.ts</Value>, <Value key="c">{t`项目是 Git 仓库`}</Value>] },
          { label: 'files', cells: [<Value key="a">{t`文件`}</Value>, <Value key="b">hostViews.ts</Value>, <Value key="c">{t`常驻`}</Value>] },
          { label: 'riffet.browser', cells: [<Value key="a">{t`浏览器`}</Value>, <Value key="b">{t`内置插件`}</Value>, <Value key="c">{t`在「技能与工具」中开启`}</Value>] },
          { label: 'plugin', cells: [<Value key="a">{t`插件视图`}</Value>, <Value key="b">catalog.ts</Value>, <Value key="c">{t`按视图的 when 条件`}</Value>] },
        ]}
      />
    </div>
  );
}

const ROWS: Array<[string, string, number, number, string, string]> = [
  ['Dialog.tsx', 'apps/web/src/components/ui', 12, 3, 'M', 'text-warning'],
  ['focus.ts', 'apps/web/src/lib', 4, 0, 'A', 'text-success'],
  ['legacy-focus.ts', 'apps/web/src/lib', 0, 18, 'D', 'text-danger'],
];

/** The Git panel as it reads: every visible string English, plurals right. Static, from `GitPanel.tsx`'s classes. */
function Git() {
  const [view, setView] = useState('changes');
  return (
    <div className="flex flex-col gap-8">
      <Frame className="p-6 max-md:p-3">
        <div className="mx-auto flex w-full max-w-[380px] flex-col overflow-hidden rounded-xl bg-bg shadow-[0_0_0_1px_var(--line-strong)]">
          {/* i18n-ignore: the Git panel is English in every language */}
          <div className="flex shrink-0 items-center gap-2 px-3 py-2">
            <Segmented size="xs" value={view} onChange={setView} ariaLabel="Git view" options={[{ value: 'changes', label: 'Changes' }, { value: 'history', label: 'History' }, { value: 'checkpoints', label: 'Checkpoints' }]} />
            <Button size="icon-xs" variant="quiet" className="ml-auto" aria-label="Refresh"><IconRefreshCw /></Button>
          </div>
          <div className="flex flex-wrap items-center gap-1 px-4 pb-1">
            <Segmented size="xs" value="working" onChange={() => undefined} ariaLabel="Compare with" options={[{ value: 'working', label: 'Uncommitted' }, { value: 'turn', label: 'This Turn' }]} />
            <Button size="xs" variant="ghost" className="ml-auto">Stage All</Button>
          </div>
          <div className="flex flex-col px-2 pb-2">
            {ROWS.map(([name, dir, added, removed, letter, tone]) => (
              <div key={name} className="flex h-8 items-center gap-2 rounded-lg px-2 hover:bg-hover">
                <span className="flex min-w-0 flex-1 items-center gap-2 text-sm"><span className="min-w-0 shrink truncate text-fg">{name}</span><span className="min-w-0 flex-1 truncate text-xs text-fg-3">{dir}</span></span>
                <span className="flex shrink-0 items-center gap-1 text-2xs tabular-nums">{added > 0 && <span className="text-success">+{added}</span>}{removed > 0 && <span className="text-danger">−{removed}</span>}</span>
                <span className={cn('w-3 shrink-0 text-center font-mono text-xs font-semibold', tone)}>{letter}</span>
              </div>
            ))}
            <span className="px-2 py-2 text-xs text-fg-3">1 file staged · 2 files unstaged</span>
          </div>
        </div>
      </Frame>
    </div>
  );
}

function Terminal() {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-8">
      <Frame className="p-6 max-md:p-3">
        <div className="relative mx-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-bg shadow-[0_0_0_1px_var(--line)]">
          <div className="flex h-28 flex-col gap-3 p-4"><Line w="w-1/2" /><Line w="w-3/4" /><Line w="w-1/3" /></div>
          <div className="relative flex flex-col edge-t bg-bg">
            <Mark n={1} className="-top-2 right-2" />
            <div className="flex h-9 shrink-0 items-center gap-1 edge-b px-2">
              <span className="flex h-7 max-w-48 shrink-0 items-center gap-1.5 rounded-md bg-active px-2 text-xs text-fg"><IconTerminal className="size-3.5 shrink-0" /><span className="truncate">zsh</span></span>
              <Button size="icon-xs" variant="quiet" aria-label={t`新建终端`}><IconPlus /></Button>
            </div>
            <div className="h-20 bg-bg p-3 font-mono text-xs text-fg-2">$ pnpm dev</div>
          </div>
        </div>
      </Frame>
      <Legend items={[
        { n: 1, name: t`终端`, value: `${DOCK_MIN}–${DOCK_MAX} · ${t`默认`} ${DOCK_DEFAULT}` + t`，停靠在会话底部，拖顶边调整`, source: 'TerminalDock.tsx' },
      ]} />
    </div>
  );
}

export function PanelsChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`侧边面板`} lede={t`会话旁的上下文：变更、文件、浏览器和插件视图。可以停靠、悬浮或全屏，整块一起变。`} tone="canvas" source="apps/web/src/app/WorkbenchPanels.tsx">
      <Plate number={1} title={t`形态与尺寸`} note={t`悬浮是全局偏好，位置跨会话记住；是否打开仍按会话。`}><Forms /></Plate>
      <Plate number={2} title={t`标题栏与页签`}><Header /></Plate>
      <Plate number={3} title="Git" note={t`面板内的文案整块用英文，与界面语言无关。`}><Git /></Plate>
      <Plate number={4} title={t`终端`}><Terminal /></Plate>
    </Chapter>
  );
}
