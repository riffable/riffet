import { useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { IconArrowRight, IconPlus } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/controls';
import { cn } from '@/lib/utils';
import { Chapter, Frame, Matrix, Plate, Token } from '../specimen';

/** One layer of the ladder: its name, the test for belonging to it, and something drawn from it. */
function Rung({ name, test, children, last }: { name: string; test: string; children: ReactNode; last?: boolean }) {
  return (
    <div className="flex min-w-0 flex-1 items-stretch gap-3 max-lg:flex-col">
      <div className="flex min-w-0 flex-1 flex-col gap-4 rounded-xl bg-bg p-4 shadow-[0_0_0_1px_var(--line)]">
        <span className="flex flex-col gap-1">
          <span className="text-base font-medium text-fg">{name}</span>
          <span className="text-xs text-fg-3">{test}</span>
        </span>
        <div aria-hidden className="pointer-events-none flex flex-1 items-center justify-center py-2">{children}</div>
      </div>
      {!last && <IconArrowRight aria-hidden className="size-4 shrink-0 self-center text-fg-4 max-lg:rotate-90" />}
    </div>
  );
}

/** The same settings line, built up a layer at a time: values, then parts, then a row, then a screen. */
function Ladder() {
  const { t } = useLingui();
  const [on, setOn] = useState(true);
  return (
    <Frame className="flex gap-3 p-6 max-lg:flex-col max-md:p-4">
      <Rung name={t`基础`} test={t`只有取值`}>
        <span className="flex items-end gap-2">
          <span className="size-6 rounded-full bg-fg" />
          <span className="size-6 rounded-full bg-fg-3" />
          <span className="size-6 rounded-md bg-elevated shadow-[0_0_0_1px_var(--line-strong)]" />
          <span className="font-semibold leading-none text-fg" style={{ fontSize: 24 }}>Aa</span>
        </span>
      </Rung>
      <Rung name={t`组件`} test={t`一个可复用的部件`}>
        <span className="flex items-center gap-3">
          <Button size="sm" variant="secondary" tabIndex={-1}><IconPlus />{t`新建`}</Button>
          <Switch checked={on} onCheckedChange={setOn} tabIndex={-1} aria-hidden />
        </span>
      </Rung>
      <Rung name={t`模式`} test={t`几个组件的组合与约定`}>
        <span className="flex w-full max-w-52 flex-col rounded-lg border border-line bg-elevated px-3 [&>*+*]:edge-t">
          <span className="flex h-9 items-center justify-between text-xs text-fg">{t`显示行号`}<Switch checked={on} onCheckedChange={setOn} tabIndex={-1} aria-hidden /></span>
          <span className="flex h-9 items-center justify-between text-xs text-fg">{t`长行自动换行`}<Switch checked={!on} onCheckedChange={(next) => setOn(!next)} tabIndex={-1} aria-hidden /></span>
        </span>
      </Rung>
      <Rung name={t`界面`} test={t`Riffet 自己的整页`} last>
        <span className="flex h-24 w-full max-w-52 overflow-hidden rounded-lg bg-bg shadow-[0_0_0_1px_var(--line-strong)]">
          <span className="w-10 shrink-0 bg-sidebar" />
          <span className="flex flex-1 flex-col gap-1.5 p-2">
            <span className="ml-auto h-3 w-16 rounded-full bg-bubble" />
            {[90, 70, 80].map((width) => <span key={width} className="h-1.5 rounded-full bg-fg/[0.12]" style={{ width: `${width}%` }} />)}
            <span className="mt-auto h-5 rounded-md bg-elevated shadow-composer" />
          </span>
        </span>
      </Rung>
    </Frame>
  );
}

/** Where each cross-cutting concern is stated, one example per layer. */
function Threads() {
  const { t } = useLingui();
  const cell = (text: string) => <span className="text-sm text-fg-2">{text}</span>;
  const rows = [
    { label: <span className="text-sm font-medium text-fg">{t`动效`}</span>, cells: [cell(t`时长与曲线的档位`), cell(t`按钮按下时缩到 0.97`), cell(t`浮层从触发它的控件展开`), cell(t`回合结束后执行过程收成一行`)] },
    { label: <span className="text-sm font-medium text-fg">{t`无障碍`}</span>, cells: [cell(t`对比度、点击区 44`), cell(t`图标按钮的名称来自 Tip`), cell(t`Esc 关闭最上面一层`), cell(t`审批可以只用键盘回答`)] },
    { label: <span className="text-sm font-medium text-fg">{t`文案`}</span>, cells: [cell(t`语气、术语、数字格式`), cell(t`按钮以动词开头`), cell(t`确认按钮写出结果`), cell(t`Git 面板整块用英文`)] },
  ];
  return <Matrix columns={[t`基础`, t`组件`, t`模式`, t`界面`]} rows={rows} />;
}

/** The two axes across the layers: which platform, and which style. */
function Axes() {
  const { t } = useLingui();
  const platforms: Array<[string, string]> = [['Web', 'WAI-ARIA APG'], ['macOS', 'HIG'], ['iOS', 'HIG'], ['Android', 'Material 3']];
  const box = 'flex min-w-0 flex-col gap-4 rounded-xl bg-bg p-5 shadow-[0_0_0_1px_var(--line)]';
  return (
    <Frame className="grid gap-4 p-6 md:grid-cols-2 max-md:p-4">
      <div className={box}>
        <span className="flex flex-col gap-1"><span className="text-base font-medium text-fg">{t`平台`}</span><span className="text-xs text-fg-3">{t`换写法：行为跟平台，数值跟同一份定义`}</span></span>
        <ul className="flex flex-col edge-b">
          {platforms.map(([platform, basis]) => <li key={platform} className="flex items-baseline justify-between gap-4 py-2 edge-t text-sm text-fg">{platform}<Token className="text-fg-3">{basis}</Token></li>)}
        </ul>
      </div>
      <div className={box}>
        <span className="flex flex-col gap-1"><span className="text-base font-medium text-fg">{t`风格`}</span><span className="text-xs text-fg-3">{t`换取值与形态：状态、键盘和文案不变`}</span></span>
        <ul className="flex flex-col edge-b">
          <li className="flex items-baseline justify-between gap-4 py-2 edge-t text-sm text-fg">{t`桌面`}<span className="flex flex-wrap justify-end gap-x-2 text-fg-2"><span>Riffet</span></span></li>
          <li className="flex items-baseline justify-between gap-4 py-2 edge-t text-sm text-fg">Android<Token className="text-right text-fg-3">material3 · ios · expressive · miuix · fluent</Token></li>
          <li className="flex items-baseline justify-between gap-4 py-2 edge-t text-sm text-fg">iOS<span className="text-fg-2">{t`系统控件`}</span></li>
        </ul>
      </div>
    </Frame>
  );
}

/** Each group's documents and code, so a rule is looked up in one place. */
function Sources() {
  const { t } = useLingui();
  const rows: Array<[string, string, string]> = [
    [t`总览`, 'README.md', 'design/overview/'],
    [t`基础`, 'foundations.md · content.md', 'design/foundations/'],
    [t`组件`, 'components/*.md', 'design/components/'],
    [t`模式`, 'patterns.md', 'design/patterns/'],
    [t`界面`, 'surfaces.md', 'design/surfaces/'],
    [t`扩展与工程`, 'plugins.md · architecture.md', 'design/engineering/'],
    [t`平台：macOS`, 'macos.md', 'design/mac/'],
  ];
  return (
    <div className="overflow-hidden rounded-xl shadow-[0_0_0_1px_var(--line)]">
      <div className="grid grid-cols-[minmax(0,0.7fr)_minmax(0,1.2fr)_minmax(0,1fr)] gap-x-6 bg-sidebar px-5 py-2.5 text-xs text-fg-3 max-md:hidden">
        <span>{t`组`}</span><span>docs/design/system/</span><span>apps/web/src/app/</span>
      </div>
      {rows.map(([group, doc, code], index) => (
        <div key={group} className={cn('grid grid-cols-[minmax(0,0.7fr)_minmax(0,1.2fr)_minmax(0,1fr)] items-baseline gap-x-6 gap-y-1 px-5 py-3 max-md:grid-cols-1', index > 0 && 'edge-t')}>
          <span className="text-sm text-fg">{group}</span>
          <Token className="text-fg-2">{doc}</Token>
          <Token className="text-fg-3">{code}</Token>
        </div>
      ))}
    </div>
  );
}

export function SystemChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`体系的组织`} lede={t`规范从小到大分四层，每层只用前面的层。平台和风格是另外两条轴，换写法与取值，不换分层。`} source="docs/design/system/README.md §1">
      <Plate number={1} title={t`四层`} note={t`一条规则放在用到它的最低一层，上层只引用。`}>
        <Ladder />
      </Plate>
      <Plate number={2} title={t`贯穿各层`} note={t`动效、无障碍、文案在每一层都有，基础只给取值和通用规则。`}>
        <Threads />
      </Plate>
      <Plate number={3} title={t`平台与风格`}>
        <Axes />
      </Plate>
      <Plate number={4} title={t`在哪里找`} note={t`设计规范页的组、文档和代码目录一一对应。`}>
        <Sources />
      </Plate>
    </Chapter>
  );
}
