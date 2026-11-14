import type { ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { SPACE } from '@contracts';
import { IconEllipsis, IconMoon, IconWrapText } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input, Switch } from '@/components/ui/controls';
import { cn } from '@/lib/utils';
import { Chapter, Frame, Plate, Token, useInView, usePainted, Value } from '../specimen';
import { useRadius } from './RadiusChapter';

/** The spacing scale is drawn this many times its size. */
const SCALE = 4;

function SpaceScale() {
  const [ref, seen] = useInView({ once: true, margin: '0px 0px -20% 0px' });
  return (
    <div ref={ref}>
    <Frame className="flex flex-wrap items-end gap-x-12 gap-y-8 px-10 pb-8 pt-14 max-md:gap-x-6 max-md:px-6">
      {Object.entries(SPACE).map(([name, value], index) => (
        <div key={name} className="flex flex-col items-start gap-4">
          <span
            className="origin-bottom-left rounded-xs bg-fg transition-transform duration-[calc(var(--duration-slow)*2.4)] ease-[var(--ease-out-soft)]"
            style={{ width: value * SCALE, height: value * SCALE, transform: seen ? 'none' : 'scale(0)', transitionDelay: `${index * 70}ms` }}
          />
          <div className="flex flex-col gap-0.5">
            <Token>{name}</Token>
            <Value>{value}</Value>
          </div>
        </div>
      ))}
      <span className="ml-auto self-start font-mono text-2xs text-fg-4">× {SCALE}</span>
    </Frame>
    </div>
  );
}

/** A dimension line: hairline, end ticks, its length in the middle. */
function Dim({ x, y, length, label, vertical, side = 'start', drawn = true, delay = 0 }: { x: number; y: number; length: number; label: string; vertical?: boolean; side?: 'start' | 'end'; drawn?: boolean; delay?: number }) {
  const tick = vertical ? 'absolute left-[-3px] h-px w-[7px] bg-fg-2' : 'absolute top-[-3px] h-[7px] w-px bg-fg-2';
  return (
    <div
      aria-hidden
      className="absolute transition-opacity duration-[calc(var(--duration-slow)*2)] ease-[var(--ease-out-soft)]"
      style={{ ...(vertical ? { left: x, top: y, height: length, width: 1 } : { left: x, top: y, width: length, height: 1 }), opacity: drawn ? 1 : 0, transitionDelay: `${delay}ms` }}
    >
      <span
        className={cn('absolute inset-0 bg-fg-2 transition-transform duration-[calc(var(--duration-slow)*2)] ease-[var(--ease-out-soft)]', vertical ? 'origin-top' : 'origin-left')}
        style={{ transform: drawn ? 'none' : vertical ? 'scaleY(0)' : 'scaleX(0)', transitionDelay: `${delay}ms` }}
      />
      <span className={cn(tick, vertical ? 'top-0' : 'left-0')} />
      <span className={cn(tick, vertical ? 'bottom-0' : 'right-0')} />
      <span
        className={cn('absolute whitespace-nowrap font-mono text-2xs leading-none text-fg', vertical
          ? cn('top-1/2 -translate-y-1/2', side === 'end' ? 'left-2' : 'right-2')
          : cn('left-1/2 -translate-x-1/2', side === 'end' ? 'top-2' : '-top-3.5'))}
      >
        {label}
      </span>
    </div>
  );
}

/** A settings group drawn to scale and dimensioned like a drawing. */
function Blueprint() {
  const { t } = useLingui();
  const W = 360;
  const ROW = 56;
  const PAD = 16;
  const ICON = 32;
  const GAP = 12;
  const M = 56;
  const radius = useRadius('card');
  const [ref, drawn] = useInView({ once: true, margin: '0px 0px -25% 0px' });
  const rows = [
    { icon: <IconMoon className="size-4" />, title: t`跟随系统的深浅色`, on: true },
    { icon: <IconWrapText className="size-4" />, title: t`长行自动换行`, on: false },
  ];
  return (
    <Frame className="overflow-x-auto py-6">
      <div ref={ref} className="relative mx-auto shrink-0 md:[zoom:1.3]" style={{ width: W + M * 2, height: ROW * 2 + 1 + M * 2 }}>
        {/* The layout grid the drawing is dimensioned on. */}
        <div aria-hidden className="absolute inset-0 bg-[linear-gradient(to_right,var(--line-soft)_1px,transparent_1px),linear-gradient(to_bottom,var(--line-soft)_1px,transparent_1px)] bg-[size:8px_8px]" />
        <div className="absolute flex flex-col overflow-hidden border border-line bg-elevated" style={{ left: M, top: M, width: W, borderRadius: radius }}>
          {rows.map((row, index) => (
            <div key={row.title} className={cn('flex items-center', index > 0 && 'edge-t')} style={{ height: ROW, paddingInline: PAD, gap: GAP }}>
              <span className="grid shrink-0 place-items-center rounded-lg bg-muted text-fg-2" style={{ width: ICON, height: ICON }}>{row.icon}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-fg">{row.title}</span>
              <Switch checked={row.on} aria-label={row.title} tabIndex={-1} />
            </div>
          ))}
        </div>
        {/* Horizontal dimensions above the card, carried down to the first row by extension lines. */}
        {[0, PAD, PAD + ICON, PAD + ICON + GAP, W - PAD, W].map((at) => (
          <span key={at} aria-hidden className="absolute w-px border-l border-dashed border-fg-4 transition-opacity duration-[var(--duration-slow)]" style={{ left: M + at, top: M - 30, height: 30 + ROW / 2, opacity: drawn ? 1 : 0 }} />
        ))}
        <Dim x={M} y={M - 22} length={PAD} label={String(PAD)} drawn={drawn} delay={200} />
        <Dim x={M + PAD} y={M - 22} length={ICON} label={String(ICON)} drawn={drawn} delay={320} />
        <Dim x={M + PAD + ICON} y={M - 22} length={GAP} label={String(GAP)} drawn={drawn} delay={440} />
        <Dim x={M + W - PAD} y={M - 22} length={PAD} label={String(PAD)} drawn={drawn} delay={560} />
        <span aria-hidden className="absolute h-px border-t border-dashed border-fg-4" style={{ left: M + W, top: M, width: 26 }} />
        <span aria-hidden className="absolute h-px border-t border-dashed border-fg-4" style={{ left: M + W, top: M + ROW, width: 26 }} />
        <Dim x={M + W + 18} y={M} length={ROW} label={String(ROW)} vertical side="end" drawn={drawn} delay={680} />
        {/* The corner radius, called out from its corner. */}
        <svg aria-hidden className="absolute overflow-visible text-fg-2 transition-opacity duration-[calc(var(--duration-slow)*2)]" style={{ left: M, top: M + ROW * 2 + 1, opacity: drawn ? 1 : 0, transitionDelay: '800ms' }} width="1" height="1">
          <path d={`M 0 ${-radius} A ${radius} ${radius} 0 0 0 ${radius} 0`} fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d={`M ${radius * 0.3} ${-radius * 0.3} L -22 22 L -40 22`} fill="none" stroke="currentColor" strokeWidth="1" />
        </svg>
        <span className="absolute font-mono text-2xs leading-none text-fg transition-opacity duration-[calc(var(--duration-slow)*2)]" style={{ left: M - 66, top: M + ROW * 2 + 1 + 17, opacity: drawn ? 1 : 0, transitionDelay: '800ms' }}>r {radius}</span>
      </div>
    </Frame>
  );
}

/** A control with its painted box read back: the height it is drawn at, and its width when it is square. */
function Measured({ name, children, square }: { name: ReactNode; children: ReactNode; square?: boolean }) {
  const [ref, box] = usePainted<{ w: number; h: number }>((element) => ({ w: Math.round(element.getBoundingClientRect().width), h: Math.round(element.getBoundingClientRect().height) }));
  return (
    <div className="flex flex-col items-start gap-3">
      <div ref={ref} className="inline-flex">{children}</div>
      <div className="flex flex-col gap-0.5">
        <Token>{name}</Token>
        <Value>{box ? (square ? `${box.w} × ${box.h}` : box.h) : ' '}</Value>
      </div>
    </div>
  );
}

/** A control inside the box a finger needs: the drawn size is smaller, the hit area is not. */
function Target({ children, name }: { children: ReactNode; name: string }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <div className="grid size-11 place-items-center border border-dashed border-fg-3">{children}</div>
      <div className="flex flex-col gap-0.5">
        <Token>{name}</Token>
        <Value>44 × 44</Value>
      </div>
    </div>
  );
}

function Sizes() {
  const { t } = useLingui();
  const buttons = ['xs', 'sm', 'md', 'lg'] as const;
  const icons = ['icon-xs', 'icon-sm', 'icon'] as const;
  return (
    <Frame className="flex flex-col gap-10 p-10 max-md:p-6">
      <div className="flex flex-wrap items-end gap-x-10 gap-y-8">
        {buttons.map((size) => <Measured key={size} name={`Button ${size}`}><Button size={size}>{t`保存`}</Button></Measured>)}
        <Measured name="Input"><Input readOnly value={t`项目名称`} className="w-32" /></Measured>
      </div>
      <div className="flex flex-wrap items-end gap-x-10 gap-y-8 edge-t pt-8">
        {icons.map((size) => <Measured key={size} name={`Button ${size}`} square><Button size={size} variant="quiet" aria-label={t`更多操作`}><IconEllipsis /></Button></Measured>)}
        <Measured name="Switch" square><Switch checked aria-label={t`开关`} tabIndex={-1} /></Measured>
      </div>
      <div className="flex flex-wrap items-end gap-x-10 gap-y-8 edge-t pt-8">
        <Target name="no-hover:min-h-11"><Button size="icon-sm" variant="quiet" aria-label={t`更多操作`}><IconEllipsis /></Button></Target>
        <Target name="no-hover:size-11"><Switch checked aria-label={t`开关`} tabIndex={-1} /></Target>
        <span className="ml-auto self-end font-mono text-2xs text-fg-4">hover: none</span>
      </div>
    </Frame>
  );
}

export function SpaceChapter() {
  const { t } = useLingui();
  return (
    <Chapter title={t`间距与尺寸`} lede={t`间距取自 ${Object.keys(SPACE).length} 档固定值；控件高度分 4 档，触摸设备上点击区放大到 44。`} source="packages/contracts/src/design-tokens.ts">
      <Plate number={1} title={t`间距`} note={t`组内 4–8，组间 16，页边距 12–16，浮层内边距 4。全部取值来自档位。`}>
        <SpaceScale />
      </Plate>
      <Plate number={2} title={t`标注`} note={t`设置分组的一行：内边距、图标、间距与行高均取自档位。`}>
        <Blueprint />
      </Plate>
      <Plate number={3} title={t`尺寸与点击区`} note={t`数值读自实际绘制的控件。图形可以小，点击区不缩。`}>
        <Sizes />
      </Plate>
    </Chapter>
  );
}
