import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconFolder, IconSearch } from '@/components/icons';
import { AgentMark } from '@/components/agent-marks';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, Input, Kbd, Segmented, Select, Switch, Textarea } from '@/components/ui/controls';
import { ChoiceCards } from '@/components/ui/choice-card';
import { RadioGroup } from '@/components/ui/radio-group';
import { SearchField } from '@/components/ui/search-field';
import { Slider } from '@/components/ui/slider';
import { Chapter, Family, Specimen } from '../specimen';

const AGENTS = [{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }, { value: 'cursor', label: 'Cursor' }];

export function InputsChapter() {
  const { t } = useLingui();
  const [agent, setAgent] = useState('claude');
  const [heading, setHeading] = useState('codex');
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);
  const [mode, setMode] = useState('light');
  const [size, setSize] = useState('standard');
  const [search, setSearch] = useState('');
  const [picks, setPicks] = useState<string[]>(['a']);
  const all = picks.length === 2 ? true : picks.length > 0 ? 'indeterminate' : false;
  const [radio, setRadio] = useState('local');
  const [card, setCard] = useState('claude');
  const [margin, setMargin] = useState(12);
  const modes = [{ value: 'system', label: t`跟随系统` }, { value: 'light', label: t`浅色` }, { value: 'dark', label: t`深色` }];
  const sizes = [{ value: 'small', label: t`小` }, { value: 'standard', label: t`标准` }, { value: 'large', label: t`大` }];
  const withIcons = AGENTS.map((item) => ({ ...item, icon: <AgentMark backend={item.value} size={14} /> }));
  return (
    <Chapter title={t`输入`} lede={t`取得一个值的控件。字段共用 fieldClass 的外观，聚焦时边框与光晕换成强调色。`} source="apps/web/src/components/ui/controls.tsx">
      <Family title="Input">
        <Specimen name={t`默认`} prop="placeholder">
          <div className="w-64"><Input placeholder={t`会话标题`} aria-label={t`会话标题`} /></div>
        </Specimen>
        <Specimen name={t`带图标`} prop="pl-8">
          <div className="relative w-64">
            <IconSearch aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-4" />
            <Input placeholder={t`搜索会话`} aria-label={t`搜索会话`} className="pl-8" />
          </div>
        </Specimen>
        <Specimen name={t`等宽`} prop="font-mono text-xs" note={t`路径、命令、标识符。`}>
          <div className="relative w-64">
            <IconFolder aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-4" />
            <Input defaultValue="~/workspace/riffet" aria-label={t`工作目录`} className="pl-8 font-mono text-xs" />
          </div>
        </Specimen>
        <Specimen name={t`禁用`} prop="disabled">
          <div className="w-64"><Input defaultValue={t`只读的值`} aria-label={t`只读的值`} disabled /></div>
        </Specimen>
      </Family>
      <Family title="Textarea">
        <Specimen name={t`默认`} prop="min-h-20">
          <Textarea defaultValue={t`先跑类型检查，再提交。`} aria-label={t`补充说明`} className="w-64" />
        </Specimen>
        <Specimen name={t`禁用`} prop="disabled">
          <Textarea defaultValue={t`先跑类型检查，再提交。`} aria-label={t`补充说明`} className="w-64" disabled />
        </Specimen>
      </Family>
      <Family title="Field">
        <Specimen name={t`标签与说明`} prop="label · hint" note={t`标签包住控件，点标签聚焦控件。`}>
          <Field label={t`工作目录`} hint={t`新会话在这里启动。`} className="w-64"><Input defaultValue="~/workspace/riffet" className="font-mono text-xs" /></Field>
        </Specimen>
        <Specimen name={t`只有标签`} prop="label">
          <Field label={t`标题`} className="w-64"><Input defaultValue={t`超时改用共享的时长常量`} /></Field>
        </Specimen>
        <Specimen name={t`错误`} prop="error" note={t`错误替换说明的位置，读屏随控件读出。`}>
          <Field label={t`工作目录`} error={t`目录不存在`} className="w-64"><Input defaultValue="~/missing" className="font-mono text-xs" /></Field>
        </Specimen>
      </Family>
      <Family title="Select">
        <Specimen name={t`字段`} prop={'appearance="field"'} note={t`选项列在应用的菜单面板里。`}>
          <div className="flex w-56 flex-col gap-3">
            <Select label="Agent" value={agent} options={AGENTS} onChange={setAgent} />
            <Select label="Agent" value={agent} options={withIcons} onChange={setAgent} />
            <Select label="Agent" value={agent} options={AGENTS} onChange={setAgent} disabled />
          </div>
        </Specimen>
        <Specimen name={t`标题`} prop={'appearance="heading"'}>
          <div className="flex flex-col items-start gap-3">
            <Select appearance="heading" label="Agent" value={heading} onChange={setHeading} options={AGENTS} />
            <Select appearance="heading" label="Agent" value={heading} onChange={setHeading} options={withIcons} />
          </div>
        </Specimen>
      </Family>
      <Family title="Switch">
        <Specimen name={t`开与关`} prop="checked" note={t`改动即时生效，不需要提交。`}>
          <Switch checked={off} onCheckedChange={setOff} aria-label={t`关`} />
          <Switch checked={on} onCheckedChange={setOn} aria-label={t`开`} />
        </Specimen>
        <Specimen name={t`禁用`} prop="disabled">
          <Switch disabled aria-label={t`关`} />
          <Switch disabled checked aria-label={t`开`} />
        </Specimen>
      </Family>
      <Family title="SearchField">
        <Specimen name={t`空与有内容`} prop="value · hint" note={t`空时可放快捷键提示，有内容换成清除；Escape 先清空，已空则失焦。`}>
          <div className="flex w-64 flex-col gap-3">
            <SearchField value={search} onChange={setSearch} placeholder={t`搜索会话`} aria-label={t`搜索会话`} hint={<Kbd>/</Kbd>} />
            <SearchField value={t`终端`} onChange={() => {}} aria-label={t`搜索会话`} />
          </div>
        </Specimen>
        <Specimen name={t`尺寸`} prop={'size="lg"'} note={t`页面顶部的主搜索用 36 像素高。`}>
          <div className="w-64"><SearchField size="lg" value="" onChange={() => {}} placeholder={t`搜索收藏`} aria-label={t`搜索收藏`} /></div>
        </Specimen>
        <Specimen name={t`禁用`} prop="disabled">
          <div className="w-64"><SearchField disabled value="" onChange={() => {}} placeholder={t`搜索插件`} aria-label={t`搜索插件`} /></div>
        </Specimen>
      </Family>
      <Family title="Checkbox">
        <Specimen name={t`状态`} prop="checked" note={t`16 像素，触屏命中区 44；半选用于全选。`}>
          <Checkbox checked={false} aria-label={t`未选`} />
          <Checkbox checked aria-label={t`已选`} />
          <Checkbox checked="indeterminate" aria-label={t`半选`} />
        </Specimen>
        <Specimen name={t`禁用`} prop="disabled">
          <Checkbox disabled aria-label={t`未选`} />
          <Checkbox disabled checked aria-label={t`已选`} />
        </Specimen>
        <Specimen name={t`与标签配对`} prop="label" note={t`标签包住复选框，点文字即切换。`}>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm text-fg"><Checkbox checked={all} onCheckedChange={(on) => setPicks(on === true ? ['a', 'b'] : [])} />{t`全选本页`}</label>
            {[['a', t`收藏夹`], ['b', t`自动化`]].map(([id, label]) => (
              <label key={id} className="flex items-center gap-2 text-sm text-fg"><Checkbox checked={picks.includes(id!)} onCheckedChange={(on) => { setPicks((current) => on === true ? [...current, id!] : current.filter((item) => item !== id)); }} />{label}</label>
            ))}
          </div>
        </Specimen>
      </Family>
      <Family title="RadioGroup">
        <Specimen name={t`选项列表`} prop="options" note={t`3 个以上、需要读说明的单选；2 到 4 个短选项用 Segmented。`}>
          <RadioGroup ariaLabel={t`运行位置`} value={radio} onValueChange={setRadio} className="w-64" options={[
            { value: 'local', label: t`本机`, description: t`直接使用这台设备上的环境。` },
            { value: 'remote', label: t`远程服务器` },
            { value: 'sandbox', label: t`沙盒`, disabled: true },
          ]} />
        </Specimen>
      </Family>
      <Family title="ChoiceCards">
        <Specimen name={t`单选卡片`} prop="options · tile" note={t`一整页只做这一个决定、选项带标志时用；设置里用 RadioGroup。`}>
          <ChoiceCards ariaLabel={t`默认 Agent`} value={card} onValueChange={setCard} className="w-80" options={[
            { value: 'claude', label: 'Claude Code', tile: <AgentMark backend="claude" size={20} /> },
            { value: 'codex', label: 'Codex', tile: <AgentMark backend="codex" size={20} /> },
            { value: 'cursor', label: 'Cursor', description: t`未登录`, tile: <AgentMark backend="cursor" size={20} />, disabled: true },
          ]} />
        </Specimen>
      </Family>
      <Family title="Slider">
        <Specimen name={t`数值`} prop="value · min · max · step" note={t`当前值写在旁边的文字里。`}>
          <div className="flex w-64 items-center gap-2">
            <Slider min={0} max={32} step={2} value={margin} onValueChange={setMargin} aria-label={t`边距`} />
            <span className="w-12 shrink-0 text-right text-xs tabular-nums text-fg-3">{margin} px</span>
          </div>
        </Specimen>
        <Specimen name={t`禁用`} prop="disabled">
          <div className="w-64"><Slider disabled min={0} max={32} value={8} onValueChange={() => {}} aria-label={t`边距`} /></div>
        </Specimen>
      </Family>
      <Family title="Segmented">
        <Specimen name={t`尺寸`} prop={'size="sm" · "xs"'} note={t`选中块在选项之间滑动。`}>
          <div className="flex flex-col items-center gap-3">
            <Segmented value={mode} options={modes} onChange={setMode} ariaLabel={t`明暗`} />
            <Segmented size="xs" value={mode} options={modes} onChange={setMode} ariaLabel={t`明暗`} />
          </div>
        </Specimen>
        <Specimen name={t`单项禁用`} prop="option.disabled">
          <Segmented value={mode} onChange={setMode} ariaLabel={t`明暗`} options={modes.map((option) => ({ ...option, disabled: option.value === 'dark' }))} />
        </Specimen>
        <Specimen name={t`等宽铺满`} prop="fill" wide>
          <div className="w-full"><Segmented fill value={size} options={sizes} onChange={setSize} ariaLabel={t`文字大小`} /></div>
        </Specimen>
      </Family>
    </Chapter>
  );
}
