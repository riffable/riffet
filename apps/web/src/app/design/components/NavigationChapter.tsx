import { useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconCpu, IconEllipsis, IconFileText, IconFolder, IconGitBranch, IconGlobe, IconMessageSquareText, IconSun, IconTerminal } from '@/components/icons';
import { AgentMark } from '@/components/agent-marks';
import { Button } from '@/components/ui/button';
import { Badge, Switch, UnderlineTabs } from '@/components/ui/controls';
import { Tile } from '@/components/ui/tile';
import { ListRow, RowActions } from '@/components/ui/list-row';
import { menuItem } from '@/components/ui/dropdown-menu';
import { SortableList, SortHandle } from '@/components/ui/sortable-list';
import { SettingsLinkRow } from '@/app/settings/SettingsLayout';
import { Disclosure } from '@/app/session/Timeline';
import { cn } from '@/lib/utils';
import { Chapter, Family, Frame, Plate, Specimen, usePainted, Value } from '../specimen';

/** The first child as painted: height, left padding and radius, so the figure never states a number the row does not have. */
function Measured({ name, source, children }: { name: string; source: string; children: ReactNode }) {
  const [ref, metrics] = usePainted((element) => {
    const row = (element.firstElementChild ?? element) as HTMLElement;
    const style = getComputedStyle(row);
    return `${Math.round(row.getBoundingClientRect().height)} · ${Math.round(parseFloat(style.paddingLeft))} · ${Math.round(parseFloat(style.borderTopLeftRadius))}`;
  });
  return (
    <div className="grid grid-cols-[9rem_minmax(0,1fr)_8rem] items-center gap-x-6 gap-y-2 px-6 py-4 edge-t first:border-t-0 max-md:grid-cols-1 max-md:px-4">
      <span className="flex flex-col gap-0.5"><span className="font-mono text-xs text-fg">{name}</span><span className="font-mono text-2xs text-fg-4">{source}</span></span>
      <div ref={ref} className="min-w-0 max-w-xs">{children}</div>
      <Value className="max-md:order-first">{metrics}</Value>
    </div>
  );
}

/** The rows of the app side by side; the measurement column reads height · left padding · radius in px. */
function Rows() {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Frame className="py-2">
      <div className="grid grid-cols-[9rem_minmax(0,1fr)_8rem] gap-x-6 px-6 pb-2 pt-3 font-mono text-2xs text-fg-4 max-md:hidden">
        <span>{t`行`}</span><span /><span>h · px · r</span>
      </div>
      <Measured name="SessionRow" source="Sidebar.tsx:160">
        {/* The sidebar row is a ListRow; the component itself needs the session stores. */}
        <ListRow tabIndex={-1} selected leading={<IconMessageSquareText />}>{t`超时改用共享的时长常量`}</ListRow>
      </Measured>
      <Measured name="PlaceRow" source="SessionInfo.tsx:58">
        <ListRow tabIndex={-1} className="text-fg" leading={<IconGitBranch />} meta="12">{t`改动`}</ListRow>
      </Measured>
      <Measured name="menuItem" source="dropdown-menu.tsx:17">
        <div className={cn(menuItem, 'data-[highlighted]:bg-hover')}><IconFileText />{t`文件`}</div>
      </Measured>
      <Measured name="settings nav" source="SettingsDialog.tsx:178">
        <ListRow tabIndex={-1} selected leading={<IconFolder />}>{t`项目`}</ListRow>
      </Measured>
      <Measured name="SettingsLinkRow" source="SettingsLayout.tsx:18">
        <SettingsLinkRow title={t`模型提供商`} onClick={() => {}} />
      </Measured>
      <Measured name="Disclosure" source="Timeline.tsx:244">
        <Disclosure icon={<IconTerminal />} title="Bash" detail="pnpm check" open={open} onToggle={() => setOpen(!open)} expandable={false}>{null}</Disclosure>
      </Measured>
    </Frame>
  );
}

function SortableDemo() {
  const { t } = useLingui();
  const names: Record<string, string> = { changes: t`改动`, files: t`文件`, terminal: t`终端`, browser: t`浏览器` };
  const [order, setOrder] = useState(['changes', 'files', 'terminal', 'browser']);
  return (
    <div className="flex w-72 flex-col rounded-xl border border-line bg-elevated px-4 [&>*+*]:edge-t">
      <SortableList ids={order} onReorder={setOrder} label={(id) => names[id]!}>
        {(id) => <div className="-ml-1.5 flex h-11 items-center gap-1 text-sm"><SortHandle label={t`调整${names[id]!}的顺序`} />{names[id]}</div>}
      </SortableList>
    </div>
  );
}

export function NavigationChapter() {
  const { t } = useLingui();
  const [tab, setTab] = useState('changes');
  const [agent, setAgent] = useState('codex');
  return (
    <Chapter title={t`导航`} lede={t`在视图和条目之间移动。页签切换一级视图，行进入一个条目。`} source="apps/web/src/components/ui/controls.tsx">
      <Family title="UnderlineTabs">
        <Specimen name={t`默认`} prop="options" note={t`页面的一级视图；高度由所在栏决定。左右方向键、Home、End 切换。`}>
          <div className="h-9"><UnderlineTabs value={tab} onChange={setTab} ariaLabel={t`页签`} options={[{ value: 'changes', label: t`改动` }, { value: 'files', label: t`文件` }, { value: 'terminal', label: t`终端` }]} /></div>
        </Specimen>
        <Specimen name={t`带图标`} prop="option.icon">
          <div className="h-9"><UnderlineTabs value={tab} onChange={setTab} ariaLabel={t`页签`} options={[{ value: 'changes', label: t`改动`, icon: <IconGitBranch /> }, { value: 'files', label: t`文件`, icon: <IconFileText /> }, { value: 'terminal', label: t`终端`, icon: <IconTerminal /> }]} /></div>
        </Specimen>
        <Specimen name={t`单项禁用`} prop="option.disabled">
          <div className="h-9"><UnderlineTabs value={tab} onChange={setTab} ariaLabel={t`页签`} options={[{ value: 'changes', label: t`改动` }, { value: 'files', label: t`文件` }, { value: 'terminal', label: t`终端`, disabled: true }]} /></div>
        </Specimen>
        <Specimen name={t`横向滚动`} prop="scrollable">
          <div className="w-full min-w-0 max-w-xs">
            <UnderlineTabs scrollable className="h-11" value={agent} onChange={setAgent} ariaLabel={t`配置的 Agent`}
              options={['codex', 'claude', 'cursor', 'dsh', 'pi', 'droid'].map((id) => ({ value: id, label: id === 'dsh' ? 'DeepSeek' : id === 'pi' ? 'pi' : id[0]!.toUpperCase() + id.slice(1), icon: <AgentMark backend={id} size={16} />, disabled: id === 'droid' }))} />
          </div>
        </Specimen>
      </Family>
      <Family title="ListRow">
        <Specimen name={t`默认`} prop="leading · meta" note={t`高 32，触屏 44；横向内边距 10。悬停 bg-hover。`}>
          <div className="w-64"><ListRow leading={<IconFileText />} meta="12">{t`文件`}</ListRow></div>
        </Specimen>
        <Specimen name={t`悬停`} prop="hover">
          <div className="w-64"><ListRow className="bg-hover text-fg" leading={<IconFileText />} meta="12">{t`文件`}</ListRow></div>
        </Specimen>
        <Specimen name={t`选中`} prop="selected" note={t`bg-active，文字 fg；调用方传对应的 ARIA。`}>
          <div className="w-64"><ListRow selected aria-current="page" leading={<IconFileText />} meta="12">{t`文件`}</ListRow></div>
        </Specimen>
        <Specimen name={t`禁用`} prop="disabled">
          <div className="w-64"><ListRow disabled leading={<IconFileText />} meta="12">{t`文件`}</ListRow></div>
        </Specimen>
        <Specimen name={t`尾部操作`} prop="actions · RowActions" note={t`指针停留、键盘进入或菜单打开时出现，触屏常驻；隐藏时仍占位。`}>
          <div className="flex w-64 flex-col gap-1">
            <ListRow leading={<IconFileText />} actions={<RowActions><Button size="icon-sm" variant="quiet" aria-label={t`更多操作`}><IconEllipsis /></Button></RowActions>}>{t`文件`}</ListRow>
            {/* The same row as hover draws it, so the hidden actions can be seen. */}
            <ListRow className="bg-hover text-fg" leading={<IconFileText />} actions={<RowActions className="pointer-events-auto opacity-100"><Button size="icon-sm" variant="quiet" aria-label={t`更多操作`}><IconEllipsis /></Button></RowActions>}>{t`文件`}</ListRow>
          </div>
        </Specimen>
      </Family>
      <Family title="Tile">
        <Specimen name={t`默认`} prop="media · meta · description · facts · actions" note={t`整张卡片打开详情；页脚的控件在它上面。两行说明，按正文宽度排一到三列。`} wide>
          <div className="grid w-full max-w-xl grid-cols-2 gap-3">
            <Tile media={<span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-fg-2"><IconCpu className="size-5" /></span>} title={t`网关模型`} meta="Example · v1.0.0" description={t`把兼容 OpenAI 接口的网关作为模型源。`} facts={<><IconCpu /><IconGlobe /></>} actions={<Button size="sm" variant="secondary">{t`安装`}</Button>} onOpen={() => {}} />
            <Tile className="border-line-strong" media={<span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-fg-2"><IconSun className="size-5" /></span>} title={t`石墨`} badge={<Badge className="font-normal">{t`内置`}</Badge>} meta="Example · v1.0.0" description={t`中性灰与一种低饱和蓝的配色。`} actions={<Switch checked aria-label={t`石墨`} onCheckedChange={() => {}} />} onOpen={() => {}} />
          </div>
        </Specimen>
      </Family>
      <Family title="SortableList">
        <Specimen name={t`默认`} prop="ids · onReorder · SortHandle" note={t`拖把手排序，或聚焦把手后按 ↑ ↓；拖动中 Esc 取消。`}>
          <SortableDemo />
        </Specimen>
      </Family>
      <Plate number={1} title={t`行`} note={t`SessionRow、会话信息的各行和设置分区导航已换用 ListRow；menuItem 属于浮层，SettingsLinkRow 是卡片内的整宽分隔行，Disclosure 是转录折叠行，三者保持独立。`}>
        <Rows />
      </Plate>
    </Chapter>
  );
}
