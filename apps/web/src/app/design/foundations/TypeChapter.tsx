import { useState, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { DESKTOP_TEXT } from '@contracts';
import { IconSquareTerminal } from '@/components/icons';
import { Segmented } from '@/components/ui/controls';
import { cn } from '@/lib/utils';
import { Chapter, display, Frame, Plate, Token, usePainted, Value } from '../specimen';

type Step = keyof typeof DESKTOP_TEXT;

/** Written out so Tailwind sees each class. */
const STEP: Record<Step, string> = {
  '2xs': 'text-2xs', xs: 'text-xs', sm: 'text-sm', base: 'text-base', lg: 'text-lg', xl: 'text-xl', '2xl': 'text-2xl',
};

const metrics = (step: Step, weight = 400) => `${DESKTOP_TEXT[step][0]} / ${DESKTOP_TEXT[step][1]} · ${weight}`;

/** The family the browser resolved first, as its stack names it. */
const firstFamily = (element: HTMLElement) => getComputedStyle(element).fontFamily.split(',')[0]?.replace(/["']/g, '').trim();

/**
 * Inter's vertical metrics, em (units of 2048): where the cap height, x-height and baseline fall
 * in a line box of line-height 1, so they can be ruled over the specimen.
 */
const INTER = { ascender: 1984 / 2048, descender: 494 / 2048, cap: 1490 / 2048, x: 1118 / 2048 };
const baseline = INTER.ascender - (INTER.ascender + INTER.descender - 1) / 2;

function Metrics() {
  const rules: Array<[string, number]> = [[`cap ${INTER.cap.toFixed(3)}`, baseline - INTER.cap], [`x ${INTER.x.toFixed(3)}`, baseline - INTER.x], ['baseline', baseline]];
  return (
    <span aria-hidden className="pointer-events-none absolute inset-y-0 left-[-40px] right-[-0.9em]">
      {rules.map(([label, at]) => (
        <span key={label} className="absolute inset-x-0 flex items-start justify-end border-t border-fg-4/70" style={{ top: `${at}em` }}>
          <span className="-translate-y-full pb-1 font-mono text-2xs leading-none tracking-normal text-fg-4">{label}</span>
        </span>
      ))}
    </span>
  );
}

function FaceSpecimen() {
  const [sans, sansFamily] = usePainted(firstFamily);
  const [mono, monoFamily] = usePainted(firstFamily);
  return (
    <Frame className="grid gap-px md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="flex flex-col justify-between gap-10 p-10 max-md:p-6">
        <div ref={sans} className="flex items-end gap-8 font-sans text-fg">
          <span className="relative font-medium leading-none tracking-tighter" style={display(120, '16vw', 220)}>Aa{sansFamily && /^inter/i.test(sansFamily) && <Metrics />}</span>
          {/* i18n-ignore: a glyph specimen, the same in every language */}
          <span className="pb-2 leading-none text-fg-3" style={display(48, '6vw', 88)}>永</span>
        </div>
        <div className="flex flex-col gap-3">
          <p className="break-all text-lg text-fg-2">ABCDEFGHIJKLMNOPQRSTUVWXYZ<br />abcdefghijklmnopqrstuvwxyz<br /><span className="tabular-nums">0123456789</span> &amp; ( ) — · …</p>
          <div className="flex items-baseline justify-between gap-4 edge-t pt-3">
            <span className="text-sm text-fg">{sansFamily}</span>
            <span className="flex gap-4 text-sm"><span className="font-normal text-fg-2">400 Regular</span><span className="font-medium text-fg">500 Medium</span></span>
          </div>
        </div>
      </div>
      <div className="flex flex-col justify-between gap-10 p-10 edge-l max-md:p-6 max-md:edge-t">
        <span ref={mono} className="font-mono leading-[0.8] text-fg" style={display(72, '9vw', 132)}>{'{}'}</span>
        <div className="flex flex-col gap-3">
          <p className="font-mono text-sm text-fg-2">{'=> !== <= 0O 1lI'}<br />{'const ms = 150;'}</p>
          <div className="flex items-baseline justify-between gap-4 edge-t pt-3">
            <span className="text-sm text-fg">{monoFamily}</span>
            <Value>font-mono</Value>
          </div>
        </div>
      </div>
    </Frame>
  );
}

/** A sentence the reader types once, set at every step of the ladder, largest first. */
function Tester() {
  const { t } = useLingui();
  const steps = (Object.keys(DESKTOP_TEXT) as Step[]).reverse();
  const [sample, setSample] = useState(() => t`Agent 在 3 个文件里做了 12 处修改`);
  const [weight, setWeight] = useState<'400' | '500'>('400');
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4 rounded-2xl bg-elevated px-5 shadow-[0_0_0_1px_var(--line)] focus-within:shadow-[0_0_0_1px_var(--line-strong),var(--shadow-soft)]">
        <input
          value={sample}
          onChange={(event) => setSample(event.target.value)}
          aria-label={t`样张文字`}
          spellCheck={false}
          className="h-16 min-w-0 flex-1 bg-transparent text-2xl text-fg outline-none placeholder:text-fg-4"
          placeholder={t`样张文字`}
        />
        <Segmented size="xs" value={weight} onChange={setWeight} ariaLabel={t`字重`} options={[{ value: '400', label: '400' }, { value: '500', label: '500' }]} />
      </div>
      <div className="flex flex-col edge-t">
        {steps.map((step) => (
          <div key={step} className="grid grid-cols-[120px_minmax(0,1fr)] items-baseline gap-6 py-4 edge-b max-md:grid-cols-[88px_minmax(0,1fr)]">
            <div className="flex flex-col gap-0.5">
              <Token>{STEP[step]}</Token>
              <Value>{`${DESKTOP_TEXT[step][0]} / ${DESKTOP_TEXT[step][1]}`}</Value>
            </div>
            <span className={cn(STEP[step], 'truncate text-fg', weight === '500' && 'font-medium')}>{sample || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A small circled number, the key between a mark on the figure and its line in the legend. */
function Callout({ n, className }: { n: number; className?: string }) {
  return <span aria-hidden className={cn('grid size-4 shrink-0 place-items-center rounded-full border border-fg-4 font-mono leading-none text-fg-3', className)} style={{ fontSize: 9 }}>{n}</span>;
}

/** A fragment of a conversation with each line keyed to the text role it is set in. */
function Annotated() {
  const { t } = useLingui();
  const roles: Array<{ name: string; step: Step; weight?: number; mono?: boolean }> = [
    { name: t`标题`, step: 'sm', weight: 500 },
    { name: t`正文`, step: 'base' },
    { name: t`界面`, step: 'sm' },
    { name: t`代码`, step: 'sm', mono: true },
    { name: t`次要`, step: 'xs' },
    { name: t`注脚`, step: '2xs' },
  ];
  const keyed = (n: number, children: ReactNode, className?: string) => (
    <div className={cn('relative flex items-start gap-3', className)}><Callout n={n} className="mt-0.5 -ml-7" />{children}</div>
  );
  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Frame className="flex flex-col gap-5 py-8 pl-14 pr-8 max-md:pl-11 max-md:pr-5">
        {keyed(1, <span className="text-sm font-medium text-fg">{t`修复设置页的焦点顺序`}</span>)}
        {keyed(2, <p className="text-base text-fg">{t`焦点在弹窗关闭后回到了页面顶部。改为回到打开弹窗的按钮，并补上 Esc 的处理。`}</p>)}
        <div className="flex flex-col gap-1.5 rounded-xl border border-line bg-elevated px-3.5 py-3">
          {keyed(3, <span className="flex items-center gap-2 text-sm text-fg"><IconSquareTerminal className="size-4 text-fg-3" />{t`运行命令`}</span>)}
          {keyed(4, <code className="font-mono text-sm text-fg">pnpm vitest run settings</code>)}
          {keyed(5, <span className="text-xs text-fg-3">apps/web · {t`12 项通过`}</span>)}
        </div>
        {keyed(6, <span className="text-2xs text-fg-3">{t`已处理 · 1m 41s · 2.3K tokens`}</span>)}
      </Frame>
      <ol className="flex flex-col justify-center edge-t">
        {roles.map((role, index) => (
          <li key={role.name} className="flex items-center gap-4 py-3 edge-b">
            <Callout n={index + 1} />
            <span className="w-12 text-sm text-fg">{role.name}</span>
            <Value className="ml-auto text-right">{`${role.mono ? 'mono ' : ''}${STEP[role.step]} · ${metrics(role.step, role.weight)}`}</Value>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function TypeChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`文字`} lede={t`两种字体、${Object.keys(DESKTOP_TEXT).length} 档字号、两种字重。行高取 2px 的整数倍。`} tone="canvas" source="packages/contracts/src/design-tokens.ts">
      <Plate number={1} title={t`字体`} note={t`界面用 Inter，代码用 JetBrains Mono，中文回退苹方。字重为 400 与 500；600 仅用于品牌名。`}>
        <FaceSpecimen />
      </Plate>
      <Plate number={2} title={t`字阶`} note={t`字号与行高成对使用，随读者设定的文字大小整体缩放。`}>
        <Tester />
      </Plate>
      <Plate number={3} title={t`角色`} note={t`组件引用文字角色，字号与行高由角色决定。`}>
        <Annotated />
      </Plate>
    </Chapter>
  );
}
