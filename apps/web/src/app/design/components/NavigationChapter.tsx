import { useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconEllipsis, IconFileText, IconFolder, IconGitBranch, IconMessageSquareText, IconTerminal } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { UnderlineTabs } from '@/components/ui/controls';
import { ListRow, RowActions } from '@/components/ui/list-row';
import { menuItem } from '@/components/ui/dropdown-menu';
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

export function NavigationChapter() {
  const { t } = useLingui();
  const [tab, setTab] = useState('changes');
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
      <Plate number={1} title={t`行`} note={t`SessionRow、会话信息的各行和设置分区导航已换用 ListRow；menuItem 属于浮层，SettingsLinkRow 是卡片内的整宽分隔行，Disclosure 是转录折叠行，三者保持独立。`}>
        <Rows />
      </Plate>
    </Chapter>
  );
}
