import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconCopy, IconEllipsis, IconFolder, IconPencilLine, IconPlus, IconSearch, IconSettings2, IconTrash2 } from '@/components/icons';
import { AgentMark } from '@/components/agent-marks';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Badge, Input, Kbd, Segmented, Select, Spinner, StatusDot, StatusPill, Switch, Textarea, UnderlineTabs } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Notice } from '@/components/ui/notice';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Chapter, Family, Frame, Reveal, Specimen } from './specimen';

type Variant = NonNullable<ButtonProps['variant']>;
type Size = NonNullable<ButtonProps['size']>;
const SIZES: Size[] = ['xs', 'sm', 'md', 'lg'];
const ICON_SIZES: Size[] = ['icon-xs', 'icon-sm', 'icon'];
const TONES = ['neutral', 'accent', 'success', 'warning', 'danger'] as const;
const SCOPES = [{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }, { value: 'dsh', label: 'DeepSeek' }, { value: 'droid', label: 'Droid' }, { value: 'pi', label: 'pi' }, { value: 'traex', label: 'TRAE CLI' }, { value: 'cursor', label: 'Cursor' }, { value: 'antigravity', label: 'Antigravity' }];
const AGENTS = [{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }, { value: 'cursor', label: 'Cursor' }];

function RowMenu() {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button size="icon-sm" variant="quiet" aria-label={t`更多`}><IconEllipsis /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem><IconPencilLine />{t`重命名`}</DropdownMenuItem>
        <DropdownMenuItem><IconCopy />{t`复制链接`}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="danger"><IconTrash2 />{t`删除`}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The components set together in one page, as they are used. */
function Scene() {
  const { t } = useLingui();
  const [tab, setTab] = useState('general');
  const [lines, setLines] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [agent, setAgent] = useState('claude');
  const [mode, setMode] = useState('system');
  const row = 'flex min-h-14 items-center justify-between gap-6 px-4';
  return (
    <Frame className="p-10 max-md:p-4">
      <div className="overflow-hidden rounded-xl bg-bg shadow-[0_0_0_1px_var(--line),var(--shadow-peek)]">
        <div className="flex h-12 items-center gap-4 px-4 edge-b">
          <span className="text-sm font-medium text-fg">riffet</span>
          <div className="h-full"><UnderlineTabs value={tab} onChange={setTab} ariaLabel={t`页签`} options={[{ value: 'general', label: t`通用` }, { value: 'agents', label: 'Agent' }, { value: 'files', label: t`文件` }]} /></div>
          <div className="ml-auto flex items-center gap-1">
            <Tip label={t`搜索`} kbd="⌘K"><Button size="icon-sm" variant="quiet" aria-label={t`搜索`}><IconSearch /></Button></Tip>
            <RowMenu />
            <Button size="sm" variant="primary" className="ml-2"><IconPlus />{t`新建会话`}</Button>
          </div>
        </div>
        <div className="grid gap-6 p-6 md:grid-cols-[minmax(0,1fr)_240px] max-md:p-4">
          <div className="flex flex-col gap-5">
            <div className="flex flex-col">
              <span className="mb-1 text-xs font-medium text-fg-3">{t`编辑器`}</span>
              <div className="flex flex-col rounded-xl border border-line bg-elevated [&>*+*]:edge-t">
                <div className={row}><span className="text-sm text-fg">{t`显示行号`}</span><Switch checked={lines} onCheckedChange={setLines} aria-label={t`显示行号`} /></div>
                <div className={row}><span className="text-sm text-fg">{t`长行自动换行`}</span><Switch checked={wrap} onCheckedChange={setWrap} aria-label={t`长行自动换行`} /></div>
                <div className={row}><span className="text-sm text-fg">{t`默认 Agent`}</span><Select label={t`默认 Agent`} value={agent} options={AGENTS} onChange={setAgent} className="w-40" /></div>
                <div className={row}><span className="text-sm text-fg">{t`明暗`}</span><Segmented size="xs" value={mode} onChange={setMode} ariaLabel={t`明暗`} options={[{ value: 'system', label: t`跟随系统` }, { value: 'light', label: t`浅色` }, { value: 'dark', label: t`深色` }]} /></div>
              </div>
              <p className="mt-2 text-xs text-fg-3">{t`仅保存在这台设备`}</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <IconFolder aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-4" />
                <Input defaultValue="~/workspace/riffet" aria-label={t`工作目录`} className="pl-8 font-mono text-xs" />
              </div>
              <Button>{t`选择`}</Button>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <Notice tone="warning">{t`Codex 本周额度剩余 8%。`}</Notice>
            <div className="flex flex-col gap-2.5 rounded-xl border border-line p-3.5">
              <div className="flex items-center justify-between text-sm text-fg"><span className="flex items-center gap-2"><StatusDot tone="success" />{t`本机服务器`}</span><Badge tone="success">{t`运行中`}</Badge></div>
              <div className="flex items-center justify-between text-sm text-fg"><span className="flex items-center gap-2"><StatusDot tone="danger" />{t`手机`}</span><StatusPill tone="danger" label={t`连接失败`} actionLabel={t`重试`} onAction={() => {}} /></div>
              <div className="flex items-center justify-between text-sm text-fg-3"><span className="flex items-center gap-2"><Spinner />{t`同步中`}</span><span className="flex gap-1"><Kbd>⌘</Kbd><Kbd>S</Kbd></span></div>
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}

/** The open state of a row's menu, drawn as the menu surface draws it. */
function MenuSurface() {
  const { t } = useLingui();
  const item = 'flex h-8 items-center gap-2 rounded-lg px-2 text-sm [&_svg]:size-4';
  return (
    <div className="flex flex-col items-end gap-1.5">
      <RowMenu />
      <div className="flex w-48 flex-col rounded-xl bg-popover p-1 shadow-pop">
        <span className={cn(item, 'bg-hover text-fg [&_svg]:text-fg-2')}><IconPencilLine />{t`重命名`}</span>
        <span className={cn(item, 'text-fg [&_svg]:text-fg-3')}><IconCopy />{t`复制链接`}</span>
        <span className="mx-2 my-1 h-px bg-line" />
        <span className={cn(item, 'text-danger')}><IconTrash2 />{t`删除`}</span>
      </div>
    </div>
  );
}

export function ComponentChapter() {
  const { t } = useLingui();
  const [on, setOn] = useState(true);
  const [mode, setMode] = useState('light');
  const [tab, setTab] = useState('changes');
  const [choice, setChoice] = useState('claude');
  const modes = [{ value: 'system', label: t`跟随系统` }, { value: 'light', label: t`浅色` }, { value: 'dark', label: t`深色` }];
  const badge: Record<(typeof TONES)[number], string> = { neutral: t`已归档`, accent: t`新`, success: t`已完成`, warning: t`等待确认`, danger: t`失败` };
  const dots = ['idle', 'accent', 'success', 'warning', 'danger'] as const;
  const [scope, setScope] = useState<string>('claude');
  const choices = [
    { what: t`值`, options: t`2–4 个，固定，标签简短`, use: 'Segmented' },
    { what: t`值`, options: t`5 个以上，或数量随数据变化`, use: 'Select' },
    { what: t`值`, options: t`需要看描述或预览才能选`, use: 'SettingsThumbChoice' },
    { what: t`视图`, options: t`页面的一级视图`, use: 'UnderlineTabs' },
    { what: t`视图`, options: t`一级视图内部的子视图，2–4 个`, use: 'Segmented' },
    { what: t`所属对象`, options: t`切换下方内容配置的对象`, use: 'Select appearance="heading"' },
  ];
  const trio = (variant: Variant) => <>
    <Button variant={variant}>{t`继续`}</Button>
    <Button variant={variant}><IconPlus />{t`新建`}</Button>
    <Button variant={variant} disabled>{t`继续`}</Button>
  </>;
  return (
    <Chapter id="components" number="08" title={t`组件`} lede={t`每种组件每端一个实现。业务代码通过组件使用样式，组件只引用颜色角色与尺寸档位。`} source="apps/web/src/components/ui/">
      <Family title={t`操作`}>
        <Specimen name={t`主按钮`} prop={'variant="primary"'} note={t`每个区域至多一个。`}>{trio('primary')}</Specimen>
        <Specimen name={t`次级按钮`} prop={'variant="secondary"'}>{trio('secondary')}</Specimen>
        <Specimen name={t`危险按钮`} prop={'variant="danger"'} note={t`用于不可逆操作。`}>{trio('danger')}</Specimen>
        <Specimen name={t`透明按钮`} prop="ghost · quiet · danger-ghost">
          <Button variant="ghost">{t`继续`}</Button>
          <Button variant="quiet"><IconPlus />{t`新建`}</Button>
          <Button variant="danger-ghost">{t`移除`}</Button>
        </Specimen>
        <Specimen name={t`尺寸`} prop="size">
          {SIZES.map((size) => <Button key={size} size={size} variant="secondary">{size}</Button>)}
        </Specimen>
        <Specimen name={t`图标按钮`} prop={'size="icon"'} note={t`由 Tip 提供名称与快捷键。`}>
          {ICON_SIZES.map((size) => <Tip key={size} label={t`设置`}><Button size={size} variant="quiet" aria-label={t`设置`}><IconSettings2 /></Button></Tip>)}
          {ICON_SIZES.map((size) => <Button key={`s-${size}`} size={size} variant="secondary" aria-label={t`设置`}><IconSettings2 /></Button>)}
        </Specimen>
      </Family>
      <Family title={t`输入与选择`}>
        <Specimen name="Input">
          <div className="flex w-64 flex-col gap-3">
            <div className="relative">
              <IconSearch aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-4" />
              <Input placeholder={t`搜索会话`} aria-label={t`搜索会话`} className="pl-8" />
            </div>
            <Input defaultValue="~/workspace/riffet" aria-label={t`工作目录`} className="font-mono text-xs" />
          </div>
        </Specimen>
        <Specimen name="Select" note={t`选项列在应用的菜单面板里。`}>
          <div className="flex w-56 flex-col gap-3">
            <Select label="Agent" value={choice} options={AGENTS} onChange={setChoice} />
            <Select label="Agent" value={choice} options={AGENTS} onChange={setChoice} disabled />
          </div>
        </Specimen>
        <Specimen name="Textarea">
          <Textarea defaultValue={t`先跑类型检查，再提交。`} aria-label={t`补充说明`} rows={3} className="w-64" />
        </Specimen>
        <Specimen name="Switch">
          <Switch checked={on} onCheckedChange={setOn} aria-label={t`开关`} />
          <Switch checked={!on} onCheckedChange={(next) => setOn(!next)} aria-label={t`开关`} />
          <Switch disabled checked aria-label={t`开关`} />
        </Specimen>
        <Specimen name="Segmented" note={t`选中块在选项之间滑动。`}>
          <div className="flex flex-col items-center gap-3">
            <Segmented value={mode} options={modes} onChange={setMode} ariaLabel={t`明暗`} />
            <Segmented size="xs" value={mode} options={modes} onChange={setMode} ariaLabel={t`明暗`} />
          </div>
        </Specimen>
        <Specimen name="UnderlineTabs" note={t`页面的一级视图。`}>
          <div className="h-9"><UnderlineTabs value={tab} onChange={setTab} ariaLabel={t`页签`} options={[{ value: 'changes', label: t`改动` }, { value: 'files', label: t`文件` }, { value: 'terminal', label: t`终端` }]} /></div>
        </Specimen>
      </Family>
      <Family title={t`选择控件的选用`}>
        <Reveal className="md:col-span-2 lg:col-span-3">
          <div className="overflow-hidden rounded-2xl bg-sidebar">
            <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)_minmax(0,1.4fr)] gap-x-6 px-6 py-3 text-xs text-fg-3 max-md:hidden">
              <span>{t`选什么`}</span><span>{t`选项`}</span><span>{t`用`}</span>
            </div>
            {choices.map((row) => (
              <div key={row.use} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)_minmax(0,1.4fr)] items-center gap-x-6 gap-y-1 px-6 py-3.5 text-sm edge-t max-md:grid-cols-1">
                <span className="text-fg">{row.what}</span>
                <span className="text-fg-2">{row.options}</span>
                <span className="font-mono text-xs text-fg">{row.use}</span>
              </div>
            ))}
          </div>
        </Reveal>
        <Specimen name={t`标题式选择`} prop={'appearance="heading"'} note={t`对象名作为下方各组的标题，点开切换；对象再多也放得下。`} wide>
          <div className="flex w-full max-w-md flex-col gap-3">
            <Select appearance="heading" label={t`配置的 Agent`} value={scope} onChange={setScope} options={SCOPES.map((agent) => ({ ...agent, icon: <AgentMark backend={agent.value} size={16} /> }))} />
            <div className="flex flex-col rounded-xl border border-line bg-elevated px-4 text-sm text-fg [&>*+*]:edge-t">
              <span className="flex h-11 items-center justify-between">{t`默认审批模式`}<span className="text-fg-3">Auto mode</span></span>
              <span className="flex h-11 items-center justify-between">{t`模型提供商`}<span className="text-fg-3">2</span></span>
            </div>
          </div>
        </Specimen>
        <Specimen name={t`选项超过四个`} prop="Select" note={t`分段控件的总宽超过所在行的一半，就换成 Select。`}>
          <Select label="Agent" value={scope} onChange={setScope} options={SCOPES.map((agent) => ({ ...agent, icon: <AgentMark backend={agent.value} size={14} /> }))} className="w-56" />
        </Specimen>
      </Family>
      <Family title={t`状态与反馈`}>
        <Specimen name="Badge">{TONES.map((tone) => <Badge key={tone} tone={tone}>{badge[tone]}</Badge>)}</Specimen>
        <Specimen name="StatusPill" note={t`状态附带一个可执行的操作。`}>
          <div className="flex flex-col items-center gap-3">
            <StatusPill tone="danger" label={t`连接失败`} actionLabel={t`重试`} onAction={() => {}} />
            <StatusPill tone="warning" label={t`已暂停`} actionLabel={t`继续`} onAction={() => {}} />
          </div>
        </Specimen>
        <Specimen name="StatusDot · Spinner · Kbd" note={t`实心与空心区分同色的两种状态。`}>
          <div className="flex flex-col items-center gap-4">
            <span className="flex items-center gap-3">{dots.map((tone) => <StatusDot key={tone} tone={tone} label={tone} />)}</span>
            <span className="flex items-center gap-3">{dots.map((tone) => <StatusDot key={tone} tone={tone} shape="ring" label={tone} />)}</span>
            <span className="flex items-center gap-3"><Spinner /><span className="flex gap-1"><Kbd>⌘</Kbd><Kbd>K</Kbd></span></span>
          </div>
        </Specimen>
        <Specimen name={t`菜单`} prop="DropdownMenu"><MenuSurface /></Specimen>
        <Specimen name="Notice" wide>
          <div className="grid w-full max-w-xl gap-2">
            <Notice tone="neutral">{t`这段历史来自导入的终端会话。`}</Notice>
            <Notice tone="warning">{t`Codex 本周额度剩余 8%。`}</Notice>
            <Notice tone="danger">{t`无法连接到服务器。`}</Notice>
          </div>
        </Specimen>
      </Family>
      <Family title={t`组合`}>
        <div className="md:col-span-2 lg:col-span-3"><Scene /></div>
      </Family>
    </Chapter>
  );
}
