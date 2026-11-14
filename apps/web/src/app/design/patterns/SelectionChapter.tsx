import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { AgentMark } from '@/components/agent-marks';
import { Segmented, Select } from '@/components/ui/controls';
import { Chapter, Frame, Plate, Reveal } from '../specimen';
import { Pair } from './parts';

const AGENTS = ['claude', 'codex', 'dsh', 'droid', 'pi', 'traex', 'cursor', 'antigravity'];
const NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', dsh: 'DeepSeek', droid: 'Droid', pi: 'pi', traex: 'TRAE CLI', cursor: 'Cursor', antigravity: 'Antigravity' };

/** The choice table: what is being chosen, how many options, and the control. */
function Choices() {
  const { t } = useLingui();
  const rows: Array<{ what: string; options: string; use: string }> = [
    { what: t`值`, options: t`2–4 个，固定，标签简短`, use: 'Segmented' },
    { what: t`值`, options: t`5 个以上，或数量随数据变化`, use: 'Select' },
    { what: t`值`, options: t`需要看描述或预览才能选`, use: 'SettingsThumbChoice' },
    { what: t`开或关`, options: '—', use: 'Switch' },
    { what: t`视图`, options: t`页面的一级视图，2–5 个`, use: 'UnderlineTabs' },
    { what: t`视图`, options: t`一级视图内部的子视图，2–4 个`, use: 'Segmented' },
    { what: t`所属对象`, options: t`切换下方内容配置的对象`, use: 'Select appearance="heading"' },
    { what: t`所属对象`, options: t`需要并排比较各对象的状态`, use: t`对象列表，每行进入二级页` },
  ];
  const grid = 'grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)_minmax(0,1.4fr)] gap-x-6';
  return (
    <Reveal>
      <div className="overflow-hidden rounded-2xl bg-sidebar">
        <div className={`${grid} px-6 py-3 text-xs text-fg-3 max-md:hidden`}><span>{t`选什么`}</span><span>{t`选项`}</span><span>{t`用`}</span></div>
        {rows.map((row) => (
          <div key={row.use + row.options} className={`${grid} items-center gap-y-1 px-6 py-3.5 text-sm edge-t max-md:grid-cols-1`}>
            <span className="text-fg">{row.what}</span>
            <span className="text-fg-2">{row.options}</span>
            <span className="font-mono text-xs text-fg">{row.use}</span>
          </div>
        ))}
      </div>
    </Reveal>
  );
}

const options = (size: number) => AGENTS.map((value) => ({ value, label: NAMES[value] ?? value, icon: <AgentMark backend={value} size={size} /> }));

function HeadingSelect() {
  const { t } = useLingui();
  const [scope, setScope] = useState('claude');
  return (
    <Frame className="flex justify-center p-8 max-md:p-4">
      <div className="flex w-full max-w-md flex-col gap-3">
        <Select appearance="heading" label={t`配置的 Agent`} value={scope} onChange={setScope} options={options(16)} />
        <div className="flex flex-col rounded-xl border border-line bg-elevated px-4 text-sm text-fg [&>*+*]:edge-t">
          <span className="flex h-11 items-center justify-between">{t`默认审批模式`}<span className="text-fg-3">Auto mode</span></span>
          <span className="flex h-11 items-center justify-between">{t`模型提供商`}<span className="text-fg-3">2</span></span>
        </div>
      </div>
    </Frame>
  );
}

function ManyOptions() {
  const { t } = useLingui();
  const [scope, setScope] = useState('claude');
  return (
    <Pair
      good={<Select label="Agent" value={scope} onChange={setScope} options={options(14)} className="w-56" />}
      goodNote={t`总宽超过所在行的一半，就换成 Select。`}
      bad={<div className="w-full overflow-hidden"><Segmented size="xs" value={scope} onChange={setScope} ariaLabel="Agent" options={AGENTS.slice(0, 6).map((value) => ({ value, label: NAMES[value] ?? value }))} /></div>}
      badNote={t`撑满设置行，再加一项就放不下。`}
    />
  );
}

export function SelectionChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`选择`} lede={t`先问选的是值，还是下方内容所属的对象；再问选项是固定的几个，还是随数据变化。`} tone="canvas" source="docs/design/system/patterns.md">
      <Plate number={1} title={t`选择控件的选用`} note={t`同一行只放一种选择控件；同一种选择在不同页面用同一种控件。`}>
        <Choices />
      </Plate>
      <Plate number={2} title={t`标题式选择`} note={t`对象名作为下方各组的标题，点开切换；对象再多也放得下。`}>
        <HeadingSelect />
      </Plate>
      <Plate number={3} title={t`选项超过四个`} note={t`2026-11-14 决定：选项多或切换所属对象时改用 Select。`}>
        <ManyOptions />
      </Plate>
    </Chapter>
  );
}
