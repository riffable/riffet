import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconFolder, IconPlus, IconSearch } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Badge, Field, Input, Kbd, Segmented, Select, Spinner, StatusDot, StatusPill, Switch, UnderlineTabs } from '@/components/ui/controls';
import { Notice } from '@/components/ui/notice';
import { Tip } from '@/components/ui/tooltip';
import { ModelParameterSetting } from '../../settings/AgentSettingsSection';
import { SettingsGroup, SettingsLinkRow, SettingsRow } from '../../settings/SettingsLayout';
import { Chapter, Frame, Matrix, Plate } from '../specimen';
import { Mark, Pair } from './parts';

const AGENTS = [{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }, { value: 'cursor', label: 'Cursor' }];

/** A settings group with each of its parts named. */
function Anatomy() {
  const { t } = useLingui();
  const [wrap, setWrap] = useState(true);
  const [mode, setMode] = useState('system');
  return (
    <Frame className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 p-8 max-md:grid-cols-1 max-md:p-4">
      <div className="mx-auto w-full max-w-md">
        <SettingsGroup title={t`编辑器`} note={t`仅保存在这台设备`}>
          <SettingsRow title={t`长行自动换行`}><Switch checked={wrap} onCheckedChange={setWrap} aria-label={t`长行自动换行`} /></SettingsRow>
          <SettingsRow title={t`明暗`} description={t`切换后立即生效`}><Segmented size="xs" value={mode} onChange={setMode} ariaLabel={t`明暗`} options={[{ value: 'system', label: t`跟随系统` }, { value: 'light', label: t`浅色` }, { value: 'dark', label: t`深色` }]} /></SettingsRow>
          <SettingsLinkRow title={t`快捷键`} onClick={() => undefined} />
        </SettingsGroup>
      </div>
      <div className="flex flex-col justify-between gap-2 py-6 max-md:hidden">
        <Mark>SettingsGroup title · text-xs fg-3</Mark>
        <Mark>SettingsRow title · text-sm medium</Mark>
        <Mark>SettingsRow description · text-xs fg-3</Mark>
        <Mark>SettingsLinkRow · min-h 48</Mark>
        <Mark>SettingsGroup note · text-xs fg-3</Mark>
      </div>
    </Frame>
  );
}

/** A field with its label and hint, then the same field in error. */
function Fields() {
  const { t } = useLingui();
  return (
    <Frame className="grid grid-cols-2 gap-8 p-8 max-md:grid-cols-1 max-md:p-4">
      <Field label={t`项目名称`} hint={t`显示在侧栏里`}><Input defaultValue="riffet" /></Field>
      <div className="flex flex-col gap-1.5">
        <Field label={t`工作目录`}><Input defaultValue="~/missing" aria-invalid /></Field>
        <p role="alert" className="text-xs text-danger">{t`目录不存在`}</p>
      </div>
    </Frame>
  );
}

function SaveModel() {
  const { t } = useLingui();
  return (
    <Frame className="p-8 max-md:p-4">
      <Matrix
        columns={[t`位置`, t`保存`, t`离开时`]}
        rows={[
          { label: t`设置页`, cells: [t`改动立即生效`, t`无需确认`] },
          { label: 'Popover', cells: [t`改动立即生效`, t`无需确认`] },
          { label: 'Dialog', cells: [t`提交时保存`, <span className="font-mono text-xs">useDiscardGuard</span>] },
        ]}
      />
    </Frame>
  );
}

function Descriptions() {
  const { t } = useLingui();
  return (
    <Pair
      good={<p className="text-xs text-fg-3">{t`仅保存在这台设备`}</p>}
      goodNote={t`存储位置、是否需重启、是否跨设备、计费与权限。`}
      bad={<p className="text-xs text-fg-3">{t`这个开关用来控制是否显示行号`}</p>}
      badNote={t`复述控件的名字。`}
    />
  );
}

/** The parts set together in one page, as they are used. */
function Scene() {
  const { t } = useLingui();
  const [tab, setTab] = useState('general');
  const [lines, setLines] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [agent, setAgent] = useState('claude');
  const [mode, setMode] = useState('system');
  return (
    <Frame className="p-10 max-md:p-4">
      <div className="overflow-hidden rounded-xl bg-bg shadow-[0_0_0_1px_var(--line),var(--shadow-peek)]">
        <div className="flex h-12 items-center gap-4 px-4 edge-b">
          <span className="text-sm font-medium text-fg">riffet</span>
          <div className="h-full max-md:hidden"><UnderlineTabs value={tab} onChange={setTab} ariaLabel={t`页签`} options={[{ value: 'general', label: t`通用` }, { value: 'agents', label: 'Agent' }, { value: 'files', label: t`文件` }]} /></div>
          <div className="ml-auto flex items-center gap-1">
            <Tip label={t`搜索`} kbd="⌘K"><Button size="icon-sm" variant="quiet" aria-label={t`搜索`}><IconSearch /></Button></Tip>
            <Button size="sm" variant="primary" className="ml-2"><IconPlus />{t`新建会话`}</Button>
          </div>
        </div>
        <div className="grid gap-6 p-6 md:grid-cols-[minmax(0,1fr)_240px] max-md:p-4">
          <div className="flex flex-col gap-5">
            <SettingsGroup title={t`编辑器`} note={t`仅保存在这台设备`}>
              <SettingsRow title={t`显示行号`}><Switch checked={lines} onCheckedChange={setLines} aria-label={t`显示行号`} /></SettingsRow>
              <SettingsRow title={t`长行自动换行`}><Switch checked={wrap} onCheckedChange={setWrap} aria-label={t`长行自动换行`} /></SettingsRow>
              <SettingsRow title={t`默认 Agent`}><Select label={t`默认 Agent`} value={agent} options={AGENTS} onChange={setAgent} className="w-40" /></SettingsRow>
              <SettingsRow title={t`明暗`}><Segmented size="xs" value={mode} onChange={setMode} ariaLabel={t`明暗`} options={[{ value: 'system', label: t`跟随系统` }, { value: 'light', label: t`浅色` }, { value: 'dark', label: t`深色` }]} /></SettingsRow>
            </SettingsGroup>
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
              <div className="flex items-center justify-between text-sm text-fg"><span className="flex items-center gap-2"><StatusDot tone="danger" />{t`手机`}</span><StatusPill tone="danger" label={t`连接失败`} actionLabel={t`重试`} onAction={() => undefined} /></div>
              <div className="flex items-center justify-between text-sm text-fg-3"><span className="flex items-center gap-2"><Spinner />{t`同步中`}</span><span className="flex gap-1"><Kbd>⌘</Kbd><Kbd>S</Kbd></span></div>
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}

function LaunchSettings() {
  const { t } = useLingui();
  const [model, setModel] = useState('model-a');
  const [effort, setEffort] = useState('high');
  const [fast, setFast] = useState('true');
  const [context, setContext] = useState('default');
  return <Frame className="p-8 max-md:p-4">
    <SettingsGroup title={t`启动设置`}>
      <SettingsRow title={t`默认提供商`}><Select label={t`默认提供商`} value="gateway" options={[{ value: 'gateway', label: t`示例网关` }]} onChange={() => undefined} className="w-64 max-md:w-full" /></SettingsRow>
      <SettingsRow title={t`默认模型`}><Select label={t`默认模型`} value={model} options={[{ value: '', label: t`自动选择` }, { value: 'model-a', label: 'Model A' }, { value: 'model-b', label: 'Model B' }]} onChange={setModel} className="w-64 max-md:w-full" /></SettingsRow>
      <ModelParameterSetting param={{ id: 'effort', name: 'Effort', category: 'thought_level', value: effort, options: ['low', 'medium', 'high'].map((value) => ({ value, label: value })) }} onChange={setEffort} />
      <ModelParameterSetting param={{ id: 'fast', name: 'Fast', category: 'model_config', value: fast, options: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'On' }] }} onChange={setFast} />
      <ModelParameterSetting param={{ id: 'context', name: 'Context', category: 'model_config', value: context, options: [{ value: 'default', label: 'Default' }, { value: '1m', label: '1M' }] }} onChange={setContext} />
    </SettingsGroup>
  </Frame>;
}

function LoadingSettings() {
  const { t } = useLingui();
  const [loading, setLoading] = useState(false);
  return <Frame className="flex flex-col gap-4 p-8 max-md:p-4">
    <div className="flex justify-end"><Switch aria-label={t`加载`} checked={loading} onCheckedChange={setLoading} /></div>
    <SettingsGroup title={t`启动设置`} loading={loading}>
      <SettingsRow title={t`默认提供商`}><Select label={t`默认提供商`} value="gateway" options={[{ value: 'gateway', label: t`示例网关` }]} onChange={() => undefined} className="w-64 max-md:w-full" /></SettingsRow>
      <SettingsRow title={t`默认模型`}><Select label={t`默认模型`} value="model-a" options={[{ value: 'model-a', label: 'Model A' }]} onChange={() => undefined} className="w-64 max-md:w-full" /></SettingsRow>
      <SettingsRow title="Fast"><Switch aria-label="Fast" checked disabled /></SettingsRow>
    </SettingsGroup>
  </Frame>;
}

function ProviderSettings() {
  const { t } = useLingui();
  const [type, setType] = useState('generic');
  return <Frame className="p-8 max-md:p-4">
    <div className="flex flex-col gap-5">
      <UnderlineTabs scrollable className="h-11" ariaLabel={t`配置的 Agent`} value="codex" options={AGENTS} onChange={() => undefined} />
      <SettingsGroup title={t`模型提供商`}>
        <SettingsRow title={t`接入方式`}><Select label={t`接入方式`} value="api" options={[{ value: 'login', label: t`CLI 自带登录` }, { value: 'api', label: 'API' }]} onChange={() => undefined} className="w-48" /></SettingsRow>
        <SettingsRow title={t`网关类型`}><Select label={t`网关类型`} value={type} options={[{ value: 'generic', label: t`通用` }, { value: 'adapter', label: t`示例网关` }]} onChange={setType} className="w-48" /></SettingsRow>
        <SettingsRow title={t`服务地址`}><Input aria-label={t`服务地址`} defaultValue="https://gateway.example/v1" className="w-64 font-mono max-md:w-full" /></SettingsRow>
        <SettingsRow title="API Key" description={t`仅保存到服务器，不会回显`}><Input aria-label="API Key" type="password" defaultValue="example-key" className="w-64 max-md:w-full" /></SettingsRow>
        {type === 'adapter' && <SettingsRow title={t`额度`}><span className="text-sm text-fg-3 tabular-nums">72%</span></SettingsRow>}
      </SettingsGroup>
    </div>
  </Frame>;
}

export function FormsChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`表单与设置`} lede={t`设置行把名称放左、控件放右，改动立即生效；需要提交的表单放进弹窗。说明文字只写读者推断不出的信息。`} source="docs/design/system/patterns.md">
      <Plate number={1} title={t`设置行的结构`} note={t`分类保持原有分组，新设置放进已有分类。`}>
        <Anatomy />
      </Plate>
      <Plate number={2} title={t`字段与校验`} note={t`错误显示在字段下方，用 role=alert；字段带 aria-invalid。`}>
        <Fields />
      </Plate>
      <Plate number={3} title={t`保存`}>
        <SaveModel />
      </Plate>
      <Plate number={4} title={t`说明文字`}>
        <Descriptions />
      </Plate>
      <Plate number={5} title={t`启动设置`}><LaunchSettings /></Plate>
      <Plate number={6} title={t`Agent 与模型提供商`}>
        <ProviderSettings />
      </Plate>
      <Plate number={7} title={t`加载`}><LoadingSettings /></Plate>
      <Plate number={8} title={t`组合示例`} note={t`设置行、状态与通知在一个页面里的样子。`}>
        <Scene />
      </Plate>
    </Chapter>
  );
}
