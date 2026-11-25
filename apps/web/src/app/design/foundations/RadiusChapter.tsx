import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { DESKTOP_STYLE } from '@contracts';
import { cn } from '@/lib/utils';
import { Chapter, display, Frame, Plate, Scrubber, Token, useRootValue, Value } from '../specimen';

export const RADII = DESKTOP_STYLE.radii;
export type Tier = keyof typeof RADII;
const cssOf = (value: string | number | undefined) => typeof value === 'string' ? `var(${value})` : `${value ?? 0}px`;
const tokenOf = (value: string | number | undefined) => typeof value === 'string' ? value.replace(/^--/, '') : String(value ?? '');

/** A tier's radius in px, as painted. */
export function useRadius(tier: Tier): number {
  const value = RADII[tier];
  const painted = useRootValue(typeof value === 'string' ? value : '--radius-none');
  return typeof value === 'number' ? value : Number.parseFloat(painted) || 0;
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
      <div className="grid aspect-[4/3] place-items-center border border-fg-3" style={{ borderRadius: cssOf(RADII[tier]) }}>
        <span className="font-medium tabular-nums text-fg-2" style={display(24, '2.6vw', 36)}>{radius}</span>
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="text-sm text-fg">{name}</span>
        <Token className="text-fg-3">{tokenOf(RADII[tier])}</Token>
        <span className="mt-1 text-xs text-fg-3">{use}</span>
      </div>
    </div>
  );
}


/** A capsule's radius is half its height, so it follows the control it belongs to. */
function PillTier({ name, use }: { name: string; use: string }) {
  const HEIGHT = 26;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid aspect-[4/3] place-items-center border border-transparent">
        <span className="grid place-items-center rounded-full border border-fg-3 px-4 font-medium tabular-nums text-fg-2" style={{ height: HEIGHT * 2 }}>{HEIGHT} / 2</span>
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="text-sm text-fg">{name}</span>
        <Token className="text-fg-3">rounded-full</Token>
        <span className="mt-1 text-xs text-fg-3">{use}</span>
      </div>
    </div>
  );
}

export function RadiusChapter() {
  const { t } = useLingui();
  const tiers: Array<[Tier, string, string]> = [
    ['control', t`控件`, t`按钮、页签、列表行`],
    ['container', t`容器`, t`代码块、菜单里的行`],
    ['card', t`卡片`, t`内容卡、用户消息、设置分组`],
    ['menu', t`菜单`, t`菜单、弹出层`],
    ['floating', t`浮层`, t`输入框、悬浮面板`],
  ];
  return (
    <Chapter title={t`圆角`} lede={t`圆角分 ${tiers.length} 档，胶囊另取高度的一半；嵌套时内圆角随内边距递减。`} source="packages/contracts/src/interface-styles.ts">
      <Plate number={1} title={t`档位`}>
        <div className="grid grid-cols-6 gap-5 max-md:grid-cols-2">
          {tiers.map(([tier, name, use]) => <RadiusTier key={tier} tier={tier} name={name} use={use} />)}
          <PillTier name={t`胶囊`} use={t`胶囊、圆形按钮、开关`} />
        </div>
      </Plate>
      <Plate number={2} title={t`嵌套`} note={t`内圆角 = 外圆角 − 内边距，下限 4。`}>
        <Nesting />
      </Plate>
    </Chapter>
  );
}
