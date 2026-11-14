import type { CSSProperties, ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { DESKTOP_TEXT } from '@contracts';
import { IconEllipsis } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input, Spinner, Switch } from '@/components/ui/controls';
import { Tip } from '@/components/ui/tooltip';
import { textScales } from '@/lib/display-settings';
import { cn } from '@/lib/utils';
import { Chapter, Frame, Matrix, Plate, readInk, Token, usePainted, Value } from '../specimen';

/** Text roles read against the page: the ratio is measured on the painted colour, so each theme shows its own. */
const INKS = ['fg', 'fg-2', 'fg-3', 'fg-4', 'accent', 'danger', 'warning', 'success'] as const;

/** WCAG's floor for text, and for non-text parts. */
const TEXT_FLOOR = 4.5;
const PART_FLOOR = 3;
/** The bar is drawn this long, in ratio. */
const BAR = 21;

function InkRow({ role }: { role: (typeof INKS)[number] }) {
  const [ref, reading] = usePainted<ReturnType<typeof readInk>, HTMLSpanElement>(readInk);
  const ratio = reading?.ratio ?? 0;
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)_56px] items-center gap-4 py-3 edge-b max-md:grid-cols-[72px_minmax(0,1fr)_48px]">
      <Token>{role}</Token>
      <div className="flex flex-col gap-2">
        <span ref={ref} className="text-base" style={{ color: `var(--${role})` }}>Aa 12:40 ⌘K</span>
        <span className="relative h-1 rounded-full bg-muted">
          <span className="absolute inset-y-0 left-0 rounded-full bg-fg-3" style={{ width: `${Math.min(100, (ratio / BAR) * 100)}%` }} />
          {[PART_FLOOR, TEXT_FLOOR].map((mark) => <span key={mark} aria-hidden className="absolute -inset-y-1 w-px bg-fg" style={{ left: `${(mark / BAR) * 100}%` }} />)}
        </span>
      </div>
      <span className="text-right text-sm font-medium tabular-nums text-fg">{reading ? ratio.toFixed(1) : '–'}</span>
    </div>
  );
}

/** A small circled number: where focus goes at the Nth press of Tab. */
function Order({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <span aria-hidden className="grid size-4 place-items-center rounded-full border border-fg-4 font-mono leading-none text-fg-3" style={{ fontSize: 9 }}>{n}</span>
      {children}
    </div>
  );
}

/** A sample set the way the interface sets it at `scale`: its size and line height from the ladder, multiplied. */
const scaled = (step: keyof typeof DESKTOP_TEXT, scale: number): CSSProperties => ({ fontSize: DESKTOP_TEXT[step][0] * scale, lineHeight: `${DESKTOP_TEXT[step][1] * scale}px` });

function ScaleSample({ scale }: { scale: number }) {
  const { t } = useLingui();
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Value>{`--text-scale ${scale}`}</Value>
      <div className="flex min-w-0 flex-col gap-2 rounded-xl bg-elevated p-3 shadow-[0_0_0_1px_var(--line)]">
        <span className="font-medium text-fg" style={scaled('sm', scale)}>{t`修复设置页的焦点顺序`}</span>
        <span className="text-fg" style={scaled('base', scale)}>{t`焦点回到打开弹窗的按钮。`}</span>
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-fg-3" style={scaled('xs', scale)}>{t`已处理 · 1m 41s`}</span>
          <span className="shrink-0 rounded-lg bg-fg/[0.07] px-2.5 py-1 font-medium text-fg" style={scaled('sm', scale)}>{t`重试`}</span>
        </div>
      </div>
    </div>
  );
}

export function AccessibilityChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`无障碍`} lede={t`每个操作都能用键盘完成，每个控件都有名称，文字和布局随读者的设定变化。`} tone="canvas" source="docs/design/system/foundations.md">
      <Plate number={1} title={t`对比度`} note={t`竖线分别是非文字 3:1 和文字 4.5:1。读自当前主题；占位和快捷键用的 fg-4 不承载需要读清的信息。`}>
        <Frame className="px-8 py-4 max-md:px-4">
          <div className="flex flex-col edge-t">{INKS.map((role) => <InkRow key={role} role={role} />)}</div>
        </Frame>
      </Plate>
      <Plate number={2} title={t`焦点`} note={t`Tab 顺序与视觉顺序一致；焦点环只在键盘操作时出现。`}>
        <Frame className="flex flex-wrap items-end gap-x-8 gap-y-6 p-10 max-md:p-6">
          <Order n={1}><Input readOnly value={t`项目名称`} className="w-40" /></Order>
          <Order n={2}><Switch checked aria-label={t`开关`} tabIndex={-1} /></Order>
          <Order n={3}><Button variant="ghost">{t`取消`}</Button></Order>
          <Order n={4}><Button variant="primary" className="ring-2 ring-focus">{t`保存`}</Button></Order>
          <Value className="ml-auto">ring-2 ring-focus</Value>
        </Frame>
      </Plate>
      <Plate number={3} title={t`键盘等价`} note={t`指针能做的，键盘都能做。`}>
        <Frame className="px-8 py-6 max-md:px-4">
          <Matrix
            columns={[t`指针`, t`键盘`]}
            rows={[
              { label: t`悬停显示的操作`, cells: [<Token key="a">group-hover:opacity-100</Token>, <Token key="b">group-focus-within:opacity-100</Token>] },
              { label: t`悬停提示`, cells: [<Token key="a">Tip</Token>, <span key="b" className="text-sm text-fg-2">{t`获得键盘焦点时同样显示`}</span>] },
              { label: t`右键菜单`, cells: [<Token key="a">contextmenu</Token>, <Token key="b">{t`更多操作`}</Token>] },
              { label: t`关闭浮层`, cells: [<span key="a" className="text-sm text-fg-2">{t`点击遮罩`}</span>, <Token key="b">Esc</Token>] },
            ]}
          />
        </Frame>
      </Plate>
      <Plate number={4} title={t`名称`} note={t`只有图标的按钮用 Tip 显示名称，同时写进 aria-label。`}>
        <Frame className="grid gap-px md:grid-cols-2">
          <div className="flex flex-col gap-4 p-8 max-md:p-5">
            <Tip label={t`更多操作`} side="right"><Button size="icon-sm" variant="quiet" aria-label={t`更多操作`}><IconEllipsis /></Button></Tip>
            <Token>Tip label + aria-label</Token>
          </div>
          <div className="flex flex-col gap-4 p-8 edge-l max-md:p-5 max-md:edge-t">
            <Button size="icon-sm" variant="quiet" aria-hidden tabIndex={-1}><IconEllipsis /></Button>
            <Token className="text-fg-4 line-through">{t`仅图标`}</Token>
          </div>
        </Frame>
      </Plate>
      <Plate number={5} title={t`减少动态效果`} note={t`系统开启后，位移和缩放换成淡入淡出，过渡缩短为 100ms。`}>
        <Frame className="px-8 py-6 max-md:px-4">
          <Matrix
            columns={[t`默认`, t`减少动态效果`]}
            rows={[
              { label: t`浮层、页面`, cells: [<Token key="a">translate · scale · opacity</Token>, <Token key="b">opacity</Token>] },
              { label: t`状态变化`, cells: [<Token key="a">{t`颜色与位置过渡`}</Token>, <Token key="b">color · background · border</Token>] },
              { label: t`进行中`, cells: [<Spinner key="a" className="size-4" />, <span key="b" className="text-sm text-fg-2">{t`缓慢淡入淡出`}</span>] },
            ]}
          />
        </Frame>
      </Plate>
      <Plate number={6} title={t`文字缩放`} note={t`设置里的文字大小改变 --text-scale，字号与行高一起缩放；布局随之重排。`}>
        <Frame className={cn('grid grid-cols-4 gap-5 p-8 max-md:grid-cols-2 max-md:p-5')}>
          {Object.values(textScales).map((scale) => <ScaleSample key={scale} scale={scale} />)}
        </Frame>
      </Plate>
    </Chapter>
  );
}
