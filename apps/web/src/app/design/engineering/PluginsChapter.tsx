import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { THEME_ROLES, VIEW_LOCATIONS, type ViewLocation } from '@contracts';
import { PLUGIN_BASE_STYLE } from '@riffet/plugin-web';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Field, Input, Segmented, Select, Spinner, StatusDot, Switch } from '@/components/ui/controls';
import { Notice } from '@/components/ui/notice';
import { cn } from '@/lib/utils';
import { capabilityLabel } from '../../plugins/PluginGrantDialog';
import { SettingsGroup, SettingsRow } from '../../settings/SettingsLayout';
import { Chapter, Frame, Matrix, Plate, Token, Value } from '../specimen';

/** The `--riffet-*` declarations of the base stylesheet's `:root` rule, as written, in order. */
function baseTokens(): Array<[string, string]> {
  const root = PLUGIN_BASE_STYLE.split('\n')[0] ?? '';
  return root.replace(/^:root\{/, '').replace(/\}$/, '').split(';').filter(Boolean).map((declaration) => {
    const at = declaration.indexOf(':');
    return [declaration.slice(0, at), declaration.slice(at + 1)];
  });
}

const TOKENS = baseTokens();
const tokenGroup = (name: string) => name.replace('--riffet-', '').split('-')[0]!;

/** One column of the comparison: the way's name and a small drawing of what draws it. */
function Way({ title, drawing }: { title: string; drawing: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <span className="text-sm font-medium text-fg">{title}</span>
      <div className="flex h-28 items-center justify-center rounded-xl bg-bg shadow-[0_0_0_1px_var(--line)] p-4">{drawing}</div>
    </div>
  );
}

function Box({ label, tone = 'host', className }: { label: string; tone?: 'host' | 'plugin'; className?: string }) {
  return <span className={cn('grid min-w-0 place-items-center truncate rounded-lg px-2 py-1.5 font-mono text-2xs', tone === 'host' ? 'bg-subtle text-fg-3' : 'bg-accent/10 text-accent', className)}>{label}</span>;
}

function Ways() {
  const { t } = useLingui();
  const columns = [t`声明式描述`, t`应用内模块`, t`隔离视图`];
  return (
    <Frame className="flex flex-col gap-6 p-6 max-md:p-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Way title={columns[0]!} drawing={<div className="flex w-full flex-col gap-1.5"><Box label="PluginPage" tone="plugin" /><Box label="SettingsGroup · SettingsRow" className="w-full" /></div>} />
        <Way title={columns[1]!} drawing={<div className="flex w-full flex-col gap-1.5"><Box label="defineWebPlugin" tone="plugin" /><Box label="UiKit · PluginHost" className="w-full" /></div>} />
        <Way title={columns[2]!} drawing={<div className="flex w-full flex-col gap-1.5"><Box label="iframe · WKWebView" tone="plugin" /><Box label="PLUGIN_BASE_STYLE · bridge" className="w-full" /></div>} />
      </div>
      <Matrix columns={columns} rows={[
        { label: t`谁绘制`, cells: [t`各端的宿主组件`, t`插件的 React 组件`, t`插件自带的页面`] },
        { label: t`平台`, cells: [t`Web、Mac、手机`, t`Web`, t`Web、Mac`] },
        { label: t`样式来源`, cells: [t`宿主组件`, t`UiKit 与 Tailwind 类`, t`颜色角色、--riffet-* 与元素规则`] },
        { label: t`位置`, cells: [t`设置、侧栏、会话视图`, t`全部`, t`会话视图、侧栏`] },
        { label: t`适用`, cells: [t`设置、检测结果、数据、操作`, t`内置官方插件`, t`复杂界面的第三方包`] },
      ]} />
    </Frame>
  );
}

interface Slot { location: ViewLocation; name: string; size: string }

function Workbench() {
  const { t } = useLingui();
  const slots: Record<ViewLocation, Slot> = {
    navigation: { location: 'navigation', name: t`主导航入口`, size: t`图标加名称，宿主决定尺寸` },
    main: { location: 'main', name: t`主内容区`, size: t`页面，宽度按页面类型` },
    'session-view': { location: 'session-view', name: t`会话视图`, size: t`随主区，与对话、终端互换` },
    sidebar: { location: 'sidebar', name: t`辅助侧栏`, size: '320–720 · 380' },
    panel: { location: 'panel', name: t`底部面板`, size: t`宽度随主区，高度由用户拖动` },
    settings: { location: 'settings', name: t`设置页`, size: '768 · min(42rem, 100dvh − 32px)' },
    file: { location: 'file', name: t`文件的其他看法`, size: t`随文件视图` },
  };
  const slot = (location: ViewLocation, className?: string) => (
    <div className={cn('flex min-w-0 flex-col justify-between gap-2 rounded-xl bg-accent/10 p-3', className)}>
      <span className="font-mono text-2xs text-accent">{location}</span>
      <span className="text-sm text-fg">{slots[location].name}</span>
    </div>
  );
  const host = (label: string, className?: string) => <div className={cn('grid place-items-center rounded-xl bg-subtle text-xs text-fg-4', className)}>{label}</div>;
  return (
    <Frame className="flex flex-col gap-8 p-6 max-md:p-4">
      <div className="grid h-80 grid-cols-[3rem_minmax(0,1fr)_minmax(0,0.55fr)] grid-rows-[2rem_minmax(0,1fr)_5rem] gap-2 max-md:h-96 max-md:grid-cols-[2.5rem_minmax(0,1fr)]">
        {host(t`侧栏`, 'col-start-1 row-span-3 row-start-1')}
        {slot('navigation', 'col-start-2 row-start-1 flex-row items-center justify-between py-0')}
        {slot('sidebar', 'col-start-3 row-span-2 row-start-1 max-md:hidden')}
        <div className="col-start-2 row-start-2 grid grid-cols-2 gap-2">{slot('main')}{slot('session-view')}</div>
        {slot('panel', 'col-span-2 col-start-2 row-start-3 max-md:col-span-1')}
      </div>
      <Matrix columns={[t`位置`, t`宽或高`]} rows={VIEW_LOCATIONS.map((location) => ({
        label: <Token>{location}</Token>,
        cells: [slots[location].name, <Value key="size">{slots[location].size}</Value>],
      }))} />
    </Frame>
  );
}

function Tokens() {
  const { t } = useLingui();
  const groups = [...new Set(TOKENS.map(([name]) => tokenGroup(name)))];
  return (
    <div className="flex flex-col gap-6">
      <Frame className="p-6 max-md:p-4">
        <Matrix rows={groups.map((group) => ({
          label: <Token className="text-fg-3">{group}</Token>,
          cells: TOKENS.filter(([name]) => tokenGroup(name) === group).map(([name, value]) => (
            <span key={name} className="flex min-w-0 flex-col gap-0.5">
              <Token>{name}</Token>
              <span className="max-w-72 truncate font-mono text-2xs text-fg-4" title={value}>{value}</span>
            </span>
          )),
        }))} />
      </Frame>
      <Frame className="flex flex-col gap-4 p-6 max-md:p-4">
        <span className="text-sm font-medium text-fg">{t`随主题与字号推送`}</span>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-3 gap-y-2.5">
          {THEME_ROLES.map((role) => (
            <span key={role} className="flex min-w-0 items-center gap-2">
              <span className="size-4 shrink-0 rounded-sm shadow-[0_0_0_1px_var(--line-strong)]" style={{ background: `var(--${role})` }} />
              <span className="truncate font-mono text-2xs text-fg-3">--{role}</span>
            </span>
          ))}
          <span className="flex min-w-0 items-center gap-2">
            <span className="grid size-4 shrink-0 place-items-center font-mono text-2xs text-fg-3">×</span>
            <span className="truncate font-mono text-2xs text-fg-3">--text-scale</span>
          </span>
        </div>
      </Frame>
    </div>
  );
}

function Kit() {
  const { t } = useLingui();
  const [choice, setChoice] = useState('a');
  const [view, setView] = useState('list');
  return (
    <Frame className="p-6 max-md:p-4">
      <Matrix rows={[
        { label: 'Button', cells: [<Button key="a" variant="primary" size="sm">{t`保存`}</Button>, <Button key="b" variant="secondary" size="sm">{t`检测`}</Button>, <Button key="c" variant="ghost" size="sm">{t`取消`}</Button>, <Button key="d" variant="danger" size="sm">{t`清除`}</Button>] },
        { label: 'Input · Switch', cells: [<Input key="a" className="w-48" defaultValue="~/.cache" aria-label={t`路径`} />, <Switch key="b" defaultChecked aria-label={t`启用`} />] },
        { label: 'StatusDot · Badge', cells: [<StatusDot key="a" tone="success" label={t`已安装`} />, <StatusDot key="b" tone="warning" label={t`未找到`} />, <Badge key="c" tone="accent">beta</Badge>, <Badge key="d">1.2.0</Badge>] },
        { label: 'Select · Segmented', cells: [
          <Select key="a" label={t`排序`} value={choice} onChange={setChoice} className="w-40" options={[{ value: 'a', label: t`最近` }, { value: 'b', label: t`名称` }]} />,
          <Segmented key="b" ariaLabel={t`视图`} value={view} onChange={setView} options={[{ value: 'list', label: t`列表` }, { value: 'grid', label: t`网格` }]} />,
        ] },
        { label: 'Field', cells: [<Field key="a" label={t`名称`} hint={t`仅用于显示`} className="w-56"><Input defaultValue="notes" /></Field>] },
        { label: 'Notice', cells: [<Notice key="a" tone="warning" className="w-72">{t`未找到可执行文件`}</Notice>] },
        { label: 'EmptyState', cells: [<EmptyState key="a" title={t`没有记录`} className="py-4" />] },
        { label: 'Spinner', cells: [<Spinner key="a" />] },
        { label: 'SettingsGroup · SettingsRow', cells: [<span key="a" className="font-mono text-2xs text-fg-3">{t`见声明式页面`}</span>] },
        { label: 'Tip · Markdown · DiffView · ModelField', cells: [<span key="a" className="font-mono text-2xs text-fg-3">UiKit</span>] },
      ]} />
    </Frame>
  );
}

function Page() {
  const { t } = useLingui();
  const options = [{ value: 'chrome', label: 'Chrome', detail: t`已安装` }, { value: 'chromium', label: 'Chromium', detail: t`未找到` }];
  return (
    <Frame className="flex justify-center p-8 max-md:p-4">
      <div className="flex w-full max-w-xl flex-col gap-6">
        <SettingsGroup title={t`浏览器`} note={t`仅保存在这台服务器`}>
          <div role="radiogroup" aria-label={t`浏览器`} className="flex flex-col py-2">
            {options.map((option, index) => (
              <div key={option.value} className="flex min-h-9 items-center gap-3">
                <span className="flex min-w-0 flex-1 items-center gap-3 py-1">
                  <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border', index === 0 ? 'border-accent' : 'border-line-strong')}>{index === 0 && <span className="size-2 rounded-full bg-accent" />}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{option.label}</span>
                  <span className="shrink-0 text-xs text-fg-3">{option.detail}</span>
                </span>
                {index === 1 && <Button type="button" size="xs" variant="secondary">{t`下载`}</Button>}
              </div>
            ))}
          </div>
          <SettingsRow title={t`无头模式`} description={t`不显示窗口`}><Switch defaultChecked aria-label={t`无头模式`} /></SettingsRow>
          <SettingsRow title={t`代理`}><div className="w-80 max-w-full max-md:w-full"><Input placeholder="http://127.0.0.1:7890" aria-label={t`代理`} /></div></SettingsRow>
          <SettingsRow title={t`缓存`}>
            <div className="flex items-center gap-3"><span className="text-sm tabular-nums text-fg-2">128 MB</span><Button type="button" size="xs" variant="secondary">{t`清除`}</Button></div>
          </SettingsRow>
        </SettingsGroup>
      </div>
    </Frame>
  );
}

/** A dialog drawn in place, for the states of `PluginFlowDialog` and the grant. */
function Card({ title, caption, children, footer }: { title: string; caption?: string; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-2xl bg-elevated shadow-pop">
      <div className="flex flex-col gap-1 px-5 pb-3 pt-5">
        <span className="text-lg font-semibold text-fg">{title}</span>
        {caption && <span className="text-sm text-fg-3">{caption}</span>}
      </div>
      <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-5 py-3">{children}</div>
      <div className="flex justify-end gap-2 px-5 pb-4 pt-2">{footer}</div>
    </div>
  );
}

function Flows() {
  const { t } = useLingui();
  const close = <Button variant="ghost">{t`关闭`}</Button>;
  const capabilities = ['sessions.read', 'network', 'process.exec'];
  return (
    <Frame className="grid gap-5 p-6 md:grid-cols-2 max-md:p-4">
      <Card title={t`登录`} caption={t`凭据保存在运行 Riffet 服务器的电脑上`} footer={close}>
        <div className="grid size-24 place-items-center rounded-lg bg-subtle text-fg-4"><span className="font-mono text-2xs">QR</span></div>
        <p className="font-mono text-sm text-fg">ABCD-1234</p>
        <span className="text-xs text-accent underline">{t`在浏览器中打开授权页`}</span>
        <p className="inline-flex items-center gap-1.5 text-xs text-fg-3"><Spinner />{t`等待授权…`}</p>
      </Card>
      <Card title={t`登录`} footer={close}>
        <p className="text-sm text-fg-2">{t`在终端中运行`}</p>
        <p className="w-full whitespace-pre-wrap break-all rounded-lg bg-subtle px-3 py-2 font-mono text-sm text-fg">vendor login</p>
      </Card>
      <Card title={t`登录`} footer={<>{close}<Button variant="primary">{t`重试`}</Button></>}>
        <p role="alert" className="text-sm text-danger">{t`已过期`}</p>
      </Card>
      <Card title="vendor.name" caption="1.2.0" footer={<><Button variant="ghost">{t`取消`}</Button><Button variant="primary">{t`安装`}</Button></>}>
        <ul className="flex w-full flex-col gap-1.5 text-sm text-fg">
          {capabilities.map((capability) => <li key={capability}>{capabilityLabel(capability)}</li>)}
        </ul>
        <p className="w-full text-xs text-fg-3">{t`安装到当前连接的服务器`}</p>
      </Card>
    </Frame>
  );
}

export function PluginsChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`插件界面`} lede={t`插件的界面优先由宿主按声明绘制；需要自己绘制时，取值与组件同样来自宿主，视图看起来与应用其余部分一致。`} source="docs/design/system/plugins.md">
      <Plate number={1} title={t`呈现方式`} note={t`能用声明描述的，用声明描述。`}><Ways /></Plate>
      <Plate number={2} title={t`位置与尺寸`} note={t`插件只拥有分配给它的视图内容；尺寸与排布归工作台。`}><Workbench /></Plate>
      <Plate number={3} title={t`可用的取值`} note={t`隔离视图的页面里已写入这些变量与元素规则。`}><Tokens /></Plate>
      <Plate number={4} title={t`UiKit`} note={t`应用内模块经 usePluginHost().ui 取得。`}><Kit /></Plate>
      <Plate number={5} title={t`声明式页面`} note={t`插件在运行时给出 PluginPage，各端用自己的控件绘制。`}><Page /></Plate>
      <Plate number={6} title={t`授权与流程`} note={t`动作的步骤与安装授权由宿主的弹窗承载。`}><Flows /></Plate>
    </Chapter>
  );
}
