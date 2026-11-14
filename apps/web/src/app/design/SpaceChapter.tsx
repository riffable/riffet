import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { DESKTOP_STYLES, SPACE } from '@contracts';
import { IconMoon, IconWrapText } from '@/components/icons';
import { Switch } from '@/components/ui/controls';
import { cn } from '@/lib/utils';
import { Chapter, display, Frame, Plate, Scrubber, Token, useInView, useRootValue, Value } from './specimen';

/** The spacing scale is drawn this many times its size. */
const SCALE = 4;

const RADII = DESKTOP_STYLES.find((style) => style.id === 'riffet')?.tokens.radii;
type Tier = keyof NonNullable<typeof RADII>;
const cssOf = (value: string | number | undefined) => typeof value === 'string' ? `var(${value})` : `${value ?? 0}px`;
const tokenOf = (value: string | number | undefined) => typeof value === 'string' ? value.replace(/^--/, '') : String(value ?? '');

/** A tier's radius in px, as painted. */
function useRadius(tier: Tier): number {
  const value = RADII?.[tier];
  const painted = useRootValue(typeof value === 'string' ? value : '--radius-none');
  return typeof value === 'number' ? value : Number.parseFloat(painted) || 0;
}

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

/** Drawn this many times its size, so a 4px inset can be seen. */
const NEST_SCALE = 3;

/** The smallest radius a nested corner takes. */
const MIN_RADIUS = 4;

/** Radii nested by their padding: each inner radius is the outer one less the gap between them. */
function Nesting() {
  const { t } = useLingui();
  const floating = useRadius('floating');
  const card = useRadius('card');
  const control = useRadius('control');
  const spec = floating - card;
  const [chosen, setChosen] = useState<number | null>(null);
  const pad = chosen ?? spec;
  const mid = Math.max(MIN_RADIUS, floating - pad);
  const inner = Math.max(MIN_RADIUS, mid - pad);
  const k = NEST_SCALE;
  const levels: Array<[string, number, string, string]> = [
    [t`浮层`, floating, 'R', 'bg-elevated'],
    [t`卡片`, mid, `max(${MIN_RADIUS}, ${floating} − ${pad})`, 'bg-subtle'],
    [t`控件`, inner, `max(${MIN_RADIUS}, ${mid} − ${pad})`, 'bg-active'],
  ];
  const fit = 'transition-[border-radius,padding] duration-[var(--duration-base)] ease-[var(--ease-standard)]';
  return (
    <Frame className="grid items-center gap-10 p-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-md:p-6">
      <div className="relative">
        <div className={cn('bg-elevated shadow-[0_0_0_1px_var(--line-strong)]', fit)} style={{ borderRadius: floating * k, padding: pad * k }}>
          <div className={cn('bg-subtle shadow-[0_0_0_1px_var(--line-strong)]', fit)} style={{ borderRadius: mid * k, padding: pad * k }}>
            <div className={cn('h-28 bg-active shadow-[0_0_0_1px_var(--line-strong)]', fit)} style={{ borderRadius: inner * k }} />
          </div>
        </div>
        <span className="absolute -bottom-6 right-0 font-mono text-2xs text-fg-4">× {k}</span>
      </div>
      <div className="flex flex-col gap-8">
        <ol className="flex flex-col edge-t">
          {levels.map(([name, radius, formula, tone]) => (
            <li key={name} className="flex items-center gap-4 py-3 edge-b">
              <span className={cn('size-3 shrink-0 rounded-xs shadow-[0_0_0_1px_var(--line-strong)]', tone)} />
              <span className="w-12 font-medium tabular-nums text-fg" style={display(24, '2.4vw', 32)}>{radius}</span>
              <span className="text-sm text-fg">{name}</span>
              <Value className="ml-auto">{formula}</Value>
            </li>
          ))}
        </ol>
        <Scrubber label={t`内边距`} value={pad} min={0} max={12} onChange={setChosen} unit="px" marks={[spec]} />
        <span className="-mt-5 text-xs text-fg-3">{pad === spec && card === mid && control === inner ? t`当前为规范取值` : t`规范取值 ${spec}px`}</span>
      </div>
    </Frame>
  );
}

function RadiusTier({ tier, name, use }: { tier: Tier; name: string; use: string }) {
  const radius = useRadius(tier);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid aspect-[4/3] place-items-center border border-fg-3" style={{ borderRadius: cssOf(RADII?.[tier]) }}>
        <span className="font-medium tabular-nums text-fg-2" style={display(24, '2.6vw', 36)}>{radius}</span>
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="text-sm text-fg">{name}</span>
        <Token className="text-fg-3">{tokenOf(RADII?.[tier])}</Token>
        <span className="mt-1 text-xs text-fg-3">{use}</span>
      </div>
    </div>
  );
}

export function SpaceChapter() {
  const { t } = useLingui();
  const tiers: Array<[Tier, string, string]> = [
    ['control', t`控件`, t`按钮、页签、列表行`],
    ['container', t`容器`, t`代码块、菜单里的行`],
    ['card', t`卡片`, t`内容卡、用户消息、设置分组`],
    ['menu', t`菜单`, t`菜单、弹出层`],
    ['floating', t`浮层`, t`输入框、悬浮面板`],
  ];
  return (
    <Chapter id="spacing" number="04" title={t`间距与圆角`} lede={t`间距取自 ${Object.keys(SPACE).length} 档固定值；圆角分 ${tiers.length} 档，嵌套时内圆角随内边距递减。`} source="packages/contracts/src/design-tokens.ts">
      <Plate number="4.1" title={t`间距`} note={t`组内 4–8，组间 16，页边距 12–16，浮层内边距 4。全部取值来自档位。`}>
        <SpaceScale />
      </Plate>
      <Plate number="4.2" title={t`标注`} note={t`设置分组的一行：内边距、图标、间距与行高均取自档位。`}>
        <Blueprint />
      </Plate>
      <Plate number="4.3" title={t`嵌套`} note={t`内圆角 = 外圆角 − 内边距，下限 4。`}>
        <Nesting />
      </Plate>
      <Plate number="4.4" title={t`圆角档位`} note={t`胶囊与圆形按钮的圆角取高度的一半。`}>
        <div className="grid grid-cols-5 gap-5 max-md:grid-cols-2">
          {tiers.map(([tier, name, use]) => <RadiusTier key={tier} tier={tier} name={name} use={use} />)}
        </div>
      </Plate>
    </Chapter>
  );
}
