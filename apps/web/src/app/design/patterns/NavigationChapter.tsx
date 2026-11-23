import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconSearch } from '@/components/icons';
import { Kbd, Segmented, UnderlineTabs } from '@/components/ui/controls';
import { shortcutHint, useShortcutOverrides } from '../../shortcuts';
import { cn } from '@/lib/utils';
import { pageAddressUrl, readPageAddress } from '../../state/page-url';
import { Chapter, Frame, Matrix, Plate } from '../specimen';
import { Bar, Mark } from './parts';

/** The four layers a reader moves through, drawn as the stack the workbench keeps. */
function Levels() {
  const { t } = useLingui();
  const layers: Array<{ name: string; part: string; offset: string; tone: string }> = [
    { name: t`浮层`, part: t`搜索 · 命令面板`, offset: 'left-[18%] top-0', tone: 'bg-elevated shadow-pop' },
    { name: t`页面`, part: 'PageScaffold', offset: 'left-[9%] top-[22%]', tone: 'bg-bg shadow-[0_0_0_1px_var(--line-strong),var(--shadow-peek)]' },
    { name: t`会话`, part: t`侧栏 + 标签页 + 对话`, offset: 'left-0 top-[44%]', tone: 'bg-bg shadow-[0_0_0_1px_var(--line)]' },
  ];
  return (
    <Frame className="p-8 max-md:p-4">
      <div className="relative h-72 w-full max-md:h-60">
        {layers.map((layer) => (
          <div key={layer.name} className={cn('absolute flex h-[46%] w-[72%] flex-col gap-2 rounded-xl p-4', layer.offset, layer.tone)}>
            <span className="text-sm font-medium text-fg">{layer.name}</span>
            <Mark>{layer.part}</Mark>
            <Bar w={50} /><Bar w={34} />
          </div>
        ))}
      </div>
    </Frame>
  );
}

/** A tab strip drawn as the tab bar draws it: a kept tab is solid, a temporary one is dashed. */
function Tabs() {
  const { t } = useLingui();
  const tab = 'flex h-8 w-36 items-center rounded-lg border px-3 text-xs';
  return (
    <Frame className="flex flex-col gap-6 p-8 max-md:p-4">
      <div className="flex flex-wrap gap-2">
        <span className={cn(tab, 'border-transparent bg-active font-medium text-fg')}>{t`重命名会话`}</span>
        <span className={cn(tab, 'border-transparent text-fg-2')}>{t`修复登录超时`}</span>
        <span className={cn(tab, 'border-dashed border-line-strong text-fg-3')}>{t`整理发布说明`}</span>
      </div>
      <div className="flex flex-wrap gap-x-8 gap-y-1">
        <Mark>{t`已保留`}</Mark><Mark>{t`已保留`}</Mark><Mark>{t`临时：下一个打开的会话替换它`}</Mark>
      </div>
      <Matrix
        columns={[t`设置`, t`选项`, t`默认`]}
        rows={[
          { label: t`打开会话时`, cells: [<span className="font-mono text-xs">preview · keep · manual</span>, 'preview'] },
          { label: t`新建会话时`, cells: [<span className="font-mono text-xs">preview · keep</span>, 'keep'] },
        ]}
      />
    </Frame>
  );
}

/** The addresses pages and conversations have, built by the app's own `pageAddressUrl`. */
function Addresses() {
  const { t } = useLingui();
  const stats = readPageAddress({ pathname: '/', search: '' }).stats;
  const base = { sessionId: '', projectId: '', pluginId: '', stats };
  const rows: Array<[string, string]> = [
    [t`会话`, pageAddressUrl({ ...base, sessionId: '‹sessionId›' })],
    [t`项目主页`, pageAddressUrl({ ...base, projectId: '‹projectId›' })],
    ...(['tasks', 'marks', 'extensions'] as const).map((page): [string, string] => [page, pageAddressUrl({ ...base, page })]),
    ['plugins', pageAddressUrl({ ...base, page: 'plugins', pluginId: '‹pluginId›' })],
    ['settings', pageAddressUrl({ ...base, page: 'settings', settingsSection: 'providers' })],
    ['design', pageAddressUrl({ ...base, page: 'design', designChapter: 'patterns/navigation' })],
  ];
  return (
    <Frame className="grid grid-cols-2 gap-x-10 gap-y-3 p-8 max-md:grid-cols-1 max-md:p-4">
      {rows.map(([name, url]) => (
        <div key={name} className="flex items-baseline justify-between gap-4 border-b border-line pb-2 text-sm">
          <span className="text-fg-3">{name}</span>
          <span className="font-mono text-xs text-fg">{url}</span>
        </div>
      ))}
    </Frame>
  );
}

/** A top-level view control above a sub-view control, as a page nests them. */
function ViewLevels() {
  const { t } = useLingui();
  const [view, setView] = useState('installed');
  const [kind, setKind] = useState('all');
  return (
    <Frame className="flex flex-col gap-4 p-8 max-md:p-4">
      <div className="mx-auto flex w-full max-w-md flex-col gap-4 rounded-xl bg-bg p-4 shadow-[0_0_0_1px_var(--line)]">
        <div className="h-9"><UnderlineTabs value={view} onChange={setView} ariaLabel={t`视图`} options={[{ value: 'installed', label: t`已安装` }, { value: 'market', label: t`市场` }]} /></div>
        <Segmented size="xs" value={kind} onChange={setKind} ariaLabel={t`类型`} options={[{ value: 'all', label: t`全部` }, { value: 'plugin', label: t`插件` }, { value: 'skill', label: t`技能` }]} />
        <div className="flex flex-col gap-2"><Bar w={80} /><Bar w={56} /></div>
      </div>
    </Frame>
  );
}

/** The two entries to the one search surface, with the scope each opens in. */
function SearchEntries() {
  const { t } = useLingui();
  useShortcutOverrides();
  const rows: Array<[string, string, string]> = [
    [shortcutHint('search') ?? '', t`会话`, t`按标题或内容找会话`],
    [shortcutHint('commandPalette') ?? '', t`命令`, t`命令、会话与项目，排在一个列表里`],
  ];
  return (
    <Frame className="flex flex-col gap-3 p-8 max-md:p-4">
      {rows.map(([keys, scope, what]) => (
        <div key={scope} className="flex items-center gap-4 rounded-xl bg-bg px-4 py-3 shadow-[0_0_0_1px_var(--line)]">
          <IconSearch aria-hidden className="size-4 text-fg-3" />
          <span className="text-sm font-medium text-fg">{scope}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-fg-3">{what}</span>
          <Kbd>{keys}</Kbd>
        </div>
      ))}
    </Frame>
  );
}

export function NavigationChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`导航`} lede={t`读者在四层之间移动：会话、盖在会话上的页面、浮层，以及侧栏和标签页这两条通往会话的路。`} source="docs/design/system/patterns.md">
      <Plate number={1} title={t`导航层级`} note={t`页面盖在会话上，浮层盖在最上面；关闭上层即回到下层。`}>
        <Levels />
      </Plate>
      <Plate number={2} title={t`会话标签页`} note={t`虚线是临时标签：它被下一个打开的会话替换，保留后变实线。`}>
        <Tabs />
      </Plate>
      <Plate number={3} title={t`页面与地址`} note={t`页面的地址不含会话；刷新后，下层的会话由上次的选择恢复。Back 与 Escape 关闭页面。`}>
        <Addresses />
      </Plate>
      <Plate number={4} title={t`一级视图与子视图`} note={t`一级视图用下划线，子视图用分段控件，两层不用同一种。`}>
        <ViewLevels />
      </Plate>
      <Plate number={5} title={t`搜索与命令面板`} note={t`同一个浮层，两个入口；列表高度在切换范围时不变。`}>
        <SearchEntries />
      </Plate>
    </Chapter>
  );
}
