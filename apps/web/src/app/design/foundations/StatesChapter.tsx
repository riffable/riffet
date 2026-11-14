import type { ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Button } from '@/components/ui/button';
import { Input, Spinner, Switch } from '@/components/ui/controls';
import { cn } from '@/lib/utils';
import { Chapter, Frame, Matrix, Plate, Token } from '../specimen';

/**
 * Each state is drawn on the real component with the state's own classes applied, because a page
 * cannot hover or press five things at once. The class strings repeat what the component applies
 * itself on :hover, :active and :focus-visible.
 */
const NONE = <span className="font-mono text-2xs text-fg-4">—</span>;

/** A list row the way the settings navigation draws it. */
function Row({ label, className, trailing }: { label: string; className?: string; trailing?: ReactNode }) {
  return (
    <div className={cn('flex h-[30px] w-40 items-center gap-2 rounded-lg px-2.5 text-sm text-fg-2', className)}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </div>
  );
}

export function StatesChapter() {
  const { t } = useLingui();
  const label = t`保存`;
  const row = t`外观`;
  const rows: Array<{ label: string; cells: ReactNode[] }> = [
    {
      label: t`默认`,
      cells: [
        <Button key="b">{label}</Button>,
        <Row key="r" label={row} />,
        <Input key="i" readOnly value={t`项目名称`} className="w-36" />,
        <Switch key="s" aria-label={label} tabIndex={-1} />,
      ],
    },
    {
      label: t`悬停`,
      cells: [
        <Button key="b" className="bg-fg/[0.11]">{label}</Button>,
        <Row key="r" label={row} className="bg-hover text-fg" />,
        <Input key="i" readOnly value={t`项目名称`} className="w-36 border-fg-4/60" />,
        NONE,
      ],
    },
    {
      label: t`按下`,
      cells: [
        <Button key="b" className="scale-[0.97] bg-fg/[0.11]">{label}</Button>,
        <Row key="r" label={row} className="bg-active text-fg" />,
        NONE,
        NONE,
      ],
    },
    {
      label: t`键盘焦点`,
      cells: [
        <Button key="b" className="ring-2 ring-focus">{label}</Button>,
        <Row key="r" label={row} className="ring-2 ring-inset ring-focus" />,
        <Input key="i" readOnly value={t`项目名称`} className="w-36 border-accent ring-3 ring-accent/15" />,
        <Switch key="s" aria-label={label} tabIndex={-1} className="ring-2 ring-focus" />,
      ],
    },
    {
      label: t`选中`,
      cells: [
        <Button key="b" data-state="open">{label}</Button>,
        <Row key="r" label={row} className="bg-active text-fg" />,
        NONE,
        <Switch key="s" checked aria-label={label} tabIndex={-1} />,
      ],
    },
    {
      label: t`禁用`,
      cells: [
        <Button key="b" disabled>{label}</Button>,
        <Row key="r" label={row} className="opacity-50" />,
        <Input key="i" disabled value={t`项目名称`} className="w-36" />,
        <Switch key="s" disabled aria-label={label} tabIndex={-1} />,
      ],
    },
    {
      label: t`加载`,
      cells: [
        <Button key="b" aria-busy className="w-[4.5rem]"><Spinner className="text-current" /></Button>,
        <Row key="r" label={row} trailing={<Spinner />} />,
        NONE,
        NONE,
      ],
    },
  ];
  return (
    <Chapter title={t`状态`} lede={t`所有可交互的组件从同一套状态里取；组件只列自己有的。`} tone="canvas" source="docs/design/system/foundations.md">
      <Plate number={1} title={t`状态矩阵`} note={t`状态变化不改变组件尺寸：加载时文字换成 spinner，宽度保持。`}>
        <Frame className="px-8 py-6 max-md:px-4">
          <Matrix columns={['Button', t`列表行`, 'Input', 'Switch']} rows={rows} />
        </Frame>
      </Plate>
      <Plate number={2} title={t`取值`} note={t`Web 的类名。`}>
        <Frame className="px-8 py-6 max-md:px-4">
          <Matrix
            columns={['Button', t`列表行`, t`输入框`]}
            rows={[
              { label: t`悬停`, cells: [<Token key="a">bg-fg/[0.11]</Token>, <Token key="b">bg-hover text-fg</Token>, <Token key="c">border-fg-4/60</Token>] },
              { label: t`按下`, cells: [<Token key="a">active:scale-[0.97]</Token>, <Token key="b">bg-active</Token>, NONE] },
              { label: t`键盘焦点`, cells: [<Token key="a">ring-2 ring-focus</Token>, <Token key="b">ring-2 ring-inset ring-focus</Token>, <Token key="c">border-accent ring-3 ring-accent/15</Token>] },
              { label: t`禁用`, cells: [<Token key="a">opacity-50</Token>, <Token key="b">opacity-50</Token>, <Token key="c">opacity-50</Token>] },
            ]}
          />
        </Frame>
      </Plate>
    </Chapter>
  );
}
