import { useLingui } from '@lingui/react/macro';
import { Chapter, Frame, Plate, Token, Value } from '../specimen';
import { CompareTable, type CompareRow } from '../compare';
import { useFamilyNotes, useMacColumns } from './notes';
import { MAC, STYLES } from './values';

function Workbench() {
  const { t } = useLingui();
  const familyNote = useFamilyNotes();
  const columns = useMacColumns();
  const cell = (value: number | string, range?: string) => (
    <span className="flex flex-col"><span className="font-mono tabular-nums">{value}</span>{range && <Value className="text-fg-4">{range}</Value>}</span>
  );
  const rows: CompareRow[] = [
    { label: t`主区`, hint: <Token className="text-2xs text-fg-4">window</Token>, keys: STYLES.map((style) => style.recipes.window), cells: STYLES.map((style) => <span key={style.id}>{familyNote('window').options[style.recipes.window] ?? style.recipes.window}</span>) },
    { label: t`主区内缩`, keys: STYLES.map((style) => String(style.recipes.window === 'insetCard')), cells: STYLES.map((style) => <span key={style.id}>{cell(style.recipes.window === 'insetCard' ? MAC.cardInset : 0)}</span>) },
    { label: t`侧栏`, hint: t`窗口放不下侧栏、主区 ${MAC.mainMin} 与面板时自动收起`, keys: STYLES.map((style) => style.tokens.layout.sidebarWidth), cells: STYLES.map((style) => <span key={style.id}>{cell(style.tokens.layout.sidebarWidth, `${MAC.sidebar.min}–${MAC.sidebar.max}`)}</span>) },
    { label: t`页头`, keys: STYLES.map((style) => style.tokens.layout.header), cells: STYLES.map((style) => <span key={style.id}>{cell(style.tokens.layout.header)}</span>) },
    { label: t`右侧面板`, hint: t`停靠、悬浮、全屏由用户切换`, keys: STYLES.map((style) => style.tokens.layout.rightPanel), cells: STYLES.map((style) => <span key={style.id}>{cell(style.tokens.layout.rightPanel, t`${MAC.panelMin} 到窗口宽 − ${MAC.mainMin}`)}</span>) },
    { label: t`终端`, keys: STYLES.map(() => MAC.terminal.default), cells: STYLES.map((style) => <span key={style.id}>{cell(MAC.terminal.default, t`${MAC.terminal.min} 起，最多详情高的 60%`)}</span>) },
    { label: t({ message: '阅读列', context: 'content-column' }), hint: t`读者拖动调整`, keys: STYLES.map(() => MAC.reading.default), cells: STYLES.map((style) => <span key={style.id}>{cell(MAC.reading.default, `${MAC.reading.min}–${MAC.reading.max}`)}</span>) },
  ];
  return <CompareTable columns={columns} groups={[{ rows }]} />;
}

/** A page drawn with its parts named: the header from `pageChrome`, the one scroller, the centred column. */
function PageAnatomy() {
  const { t } = useLingui();
  const mark = 'pointer-events-none absolute font-mono text-2xs text-fg-3';
  return (
    <Frame className="p-10 max-md:p-4">
      <div className="relative mx-auto flex h-80 max-w-2xl flex-col overflow-hidden rounded-lg bg-bg shadow-[0_0_0_1px_var(--line-strong)]">
        <div className="flex h-11 shrink-0 items-center gap-2 px-4 edge-b">
          <span className="text-sm font-medium text-fg">{t`定时任务`}</span>
          <span className="ml-auto flex items-center gap-2" aria-hidden><span className="size-4 rounded-xs bg-fg/[0.12]" /><span className="h-6 w-14 rounded-md bg-primary" /></span>
        </div>
        <div className="relative flex-1">
          <div className="absolute inset-x-[14%] bottom-[18%] top-[16%] flex flex-col gap-3 rounded-sm bg-fg/[0.04] p-4 shadow-[inset_0_0_0_1px_var(--line-strong)]">
            {[80, 64, 72, 40].map((width, index) => <span key={index} className="h-1.5 rounded-full bg-fg/[0.1]" style={{ width: `${width}%` }} />)}
          </div>
          <span className={`${mark} left-2 top-1/2`}>{MAC.page.inline}</span>
          <span className={`${mark} right-2 top-1/2`}>{MAC.page.inline}</span>
          <span className={`${mark} left-1/2 top-2 -translate-x-1/2`}>{MAC.page.top}</span>
          <span className={`${mark} bottom-2 left-1/2 -translate-x-1/2`}>{MAC.page.bottom}</span>
        </div>
      </div>
      <div className="mx-auto mt-6 grid max-w-2xl gap-4 text-sm md:grid-cols-3">
        <span className="flex flex-col gap-0.5"><Token>pageChrome</Token><span className="text-fg-3">{t`原生风格是窗口工具栏，自绘风格是 CustomPageBar`}</span></span>
        <span className="flex flex-col gap-0.5"><Token>.document {MAC.page.document}</Token><span className="text-fg-3">{t`列表、表单、收藏、任务、插件`}</span></span>
        <span className="flex flex-col gap-0.5"><Token>.board {MAC.page.board}</Token><span className="text-fg-3">{t`统计、扩展概览、并行尝试`}</span></span>
      </div>
    </Frame>
  );
}

/** The Settings window at half scale. */
function SettingsWindow() {
  const { t } = useLingui();
  const [width, height] = MAC.settings.window.ideal;
  const scale = 0.5;
  return (
    <Frame className="flex flex-col items-center gap-4 p-10 max-md:p-4">
      <div className="flex overflow-hidden rounded-lg bg-bg shadow-[0_0_0_1px_var(--line-strong)]" style={{ width: width * scale, height: height * scale, maxWidth: '100%' }}>
        <div className="flex shrink-0 flex-col gap-2 bg-sidebar px-3 pt-8" style={{ width: MAC.settings.sidebar.ideal * scale }}>
          {[70, 56, 64, 48, 60, 52].map((length, index) => <span key={index} className={index === 1 ? 'h-2 rounded-full bg-fg/[0.3]' : 'h-2 rounded-full bg-fg/[0.1]'} style={{ width: `${length}%` }} />)}
        </div>
        <div className="flex flex-1 flex-col gap-3 p-5">
          {[0, 1].map((group) => (
            <div key={group} className="flex flex-col rounded-md bg-fg/[0.03] shadow-[inset_0_0_0_1px_var(--line)]">
              {[0, 1, 2].map((row) => <span key={row} className="flex h-7 items-center justify-between px-3"><span className="h-1.5 w-1/3 rounded-full bg-fg/[0.12]" /><span className="h-2.5 w-5 rounded-full bg-fg/[0.16]" /></span>)}
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap justify-center gap-x-8 gap-y-1 font-mono text-2xs text-fg-3">
        <span>{t`窗口 ${width} × ${height}，最小 ${MAC.settings.window.min[0]} × ${MAC.settings.window.min[1]}`}</span>
        <span>{t`分类 ${MAC.settings.sidebar.ideal}（${MAC.settings.sidebar.min}–${MAC.settings.sidebar.max}）`}</span>
      </div>
    </Frame>
  );
}

export function WindowChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`窗口与页面`} lede={t`工作台的尺寸一部分来自风格配方，一部分各风格相同；页面和设置的骨架三种风格一致。`} source="docs/design/system/macos.md §3">
      <Plate number={1} title={t`工作台`} note={t`侧栏、页头与右侧面板的默认值随风格变，范围各风格相同。`}>
        <Workbench />
      </Plate>
      <Plate number={2} title={t`页面骨架`} note={t`非会话页都用 PageScaffold：页头、一个滚动区和一条居中的内容列。内容列宽度不含内边距。`}>
        <PageAnatomy />
      </Plate>
      <Plate number={3} title={t`设置窗口`} note={t`所有风格下都是独立窗口，⌘, 打开；分类保持原样，顶部搜索按分类和设置项筛选。`}>
        <SettingsWindow />
      </Plate>
    </Chapter>
  );
}
