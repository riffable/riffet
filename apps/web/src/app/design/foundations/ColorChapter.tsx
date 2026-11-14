import type { ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { THEME_ROLES, type ThemeRole } from '@contracts';
import { IconCircleAlert, IconCircleCheck, IconTriangleAlert } from '@/components/icons';
import { cn } from '@/lib/utils';
import { Chapter, display, ease, Frame, Plate, readFill, readInk, Token, usePainted, useScrollProgress, Value } from '../specimen';

const ofGroup = (prefix: RegExp) => THEME_ROLES.filter((role) => prefix.test(role));
const SURFACES = ofGroup(/^bg/);
const INKS = ofGroup(/^fg(-\d)?$/);
const AGENTS = ofGroup(/^agent-/);

/** A row of skeleton text: the shape of an interface, without its words. */
function Lines({ widths, className }: { widths: string[]; className?: string }) {
  return <span className={cn('flex flex-col gap-1.5', className)}>{widths.map((width, index) => <i key={index} className="h-1.5 rounded-full bg-fg-4/45" style={{ width }} />)}</span>;
}

/** A plane's edge, and the shadow it casts on the one below once the stack is taken apart. */
const LIFT = '0 0 0 1px var(--line), 0 calc(var(--p) * 28px) calc(var(--p) * 56px) -16px rgb(15 23 42 / calc(var(--p) * 0.18))';

/** One plane of the stack: the stage's whole footprint, lifted `level` steps as the page scrolls. */
function Plane({ level, label, labelAt, children }: { level: number; label: string; labelAt: string; children: ReactNode }) {
  return (
    <div className="absolute inset-0 [transform-style:preserve-3d]" style={{ transform: `translateZ(calc(var(--p) * ${level} * var(--lift)))` }}>
      {children}
      <span
        className={cn('pointer-events-none absolute whitespace-nowrap rounded-full bg-fg px-2 py-0.5 font-mono text-2xs text-bg', labelAt)}
        style={{ opacity: `clamp(0, calc((var(--p) - 0.55) * 4), 1)` }}
      >
        {label}
      </span>
    </div>
  );
}

/**
 * The workbench, then the same workbench taken apart: scrolling tilts it and lifts each surface
 * off the one below, so the layers the colours name can be seen as layers.
 */
function SurfaceStack() {
  const { t } = useLingui();
  const stage = useScrollProgress<HTMLDivElement>(ease(0.08, 0.72));
  const layers: Array<{ roles: string; use: string }> = [
    { roles: 'bg-sidebar', use: t`窗口底面、侧栏` },
    { roles: 'bg', use: t`内容区` },
    { roles: 'bg-elevated · bg-subtle · bg-bubble', use: t`卡片、代码块、用户消息` },
    { roles: 'bg-muted · bg-hover · bg-active', use: t`轨道、悬停、选中` },
    { roles: 'bg-popover', use: t`菜单与弹出层` },
  ];
  return (
    <div ref={stage} className="relative h-[280vh] max-md:h-[200vh]">
      <div className="sticky top-0 grid h-[calc(100dvh-3.25rem)] grid-cols-12 content-center gap-x-6 gap-y-8 max-md:h-[calc(100dvh-3rem)]">
        <div className="col-span-12 flex flex-col gap-2 md:col-span-3">
          <span className="font-mono text-xs text-fg-4">2.1</span>
          <h3 className="text-base font-medium text-fg">{t`底色层次`}</h3>
          <p className="text-sm text-fg-3">{t`每升一层，底色变化一级。层次由底色表达，阴影留给脱离文档流的浮层。`}</p>
          <ol className="mt-6 flex flex-col edge-t max-md:hidden">
            {layers.map((layer, index) => (
              <li key={layer.roles} className="flex flex-col gap-0.5 py-2.5 edge-b" style={{ opacity: `clamp(0.3, calc((var(--p) - ${index * 0.16}) * 5 + 0.3), 1)` }}>
                <Token className="text-fg">{layer.roles}</Token>
                <span className="text-xs text-fg-3">{layer.use}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="col-span-12 grid place-items-center [--lift:64px] [perspective:2600px] md:col-span-9 max-md:mt-6 max-md:[--lift:22px]">
          <div
            className="relative aspect-[16/10] w-full [transform-style:preserve-3d]"
            style={{ transform: 'rotateX(calc(var(--p) * 54deg)) rotateZ(calc(var(--p) * -34deg)) scale(calc(1 - var(--p) * 0.2))' }}
          >
            <Plane level={0} label="bg-sidebar" labelAt="left-4 top-3">
              <div className="absolute inset-0 rounded-2xl bg-sidebar" style={{ boxShadow: LIFT }} />
              <div className="absolute left-5 top-14 flex w-[15%] flex-col gap-3"><Lines widths={['80%', '60%', '72%', '50%', '66%', '58%']} /></div>
            </Plane>
            <Plane level={1} label="bg" labelAt="left-[24%] top-[9%]">
              <div className="absolute bottom-0 left-[22%] right-[2.5%] top-[6%] rounded-t-xl bg-bg" style={{ boxShadow: LIFT }} />
            </Plane>
            <Plane level={2} label="bg-elevated" labelAt="left-[27%] top-[13%]">
              <div className="absolute left-[27%] top-[19%] h-[40%] w-[42%] rounded-xl bg-elevated" style={{ boxShadow: LIFT }} />
              <div className="absolute bottom-[9%] left-[27%] flex h-[16%] w-[42%] items-center rounded-lg bg-subtle px-3"><Lines widths={['46%', '30%']} className="flex-1" /></div>
              <div className="absolute bottom-[9%] right-[7%] flex h-[16%] w-[20%] items-center rounded-xl bg-bubble px-3"><Lines widths={['90%', '60%']} className="flex-1" /></div>
            </Plane>
            <Plane level={3} label="bg-muted · bg-hover · bg-active" labelAt="left-[27%] top-[61%]">
              <div className="absolute left-[29%] top-[22%] flex h-[7%] w-[16%] gap-0.5 rounded-lg bg-muted p-0.5"><span className="flex-1 rounded-md bg-elevated shadow-[0_0_0_0.5px_var(--line-strong)]" /><span className="flex-1" /></div>
              <div className="absolute left-[28%] top-[33%] flex h-[9%] w-[40%] items-center rounded-lg bg-hover px-2.5"><Lines widths={['44%']} className="flex-1" /></div>
              <div className="absolute left-[28%] top-[44%] flex h-[9%] w-[40%] items-center rounded-lg bg-active px-2.5"><Lines widths={['62%']} className="flex-1" /></div>
            </Plane>
            <Plane level={4} label="bg-popover" labelAt="right-[7%] top-[22%]">
              <div className="absolute right-[7%] top-[28%] flex w-[24%] flex-col rounded-xl bg-popover p-1 shadow-pop">
                {[70, 52, 64].map((width) => <div key={width} className="flex h-7 items-center px-2"><Lines widths={[`${width}%`]} className="flex-1" /></div>)}
              </div>
            </Plane>
          </div>
        </div>
      </div>
    </div>
  );
}

function Ink({ role }: { role: ThemeRole }) {
  const [ref, reading] = usePainted<ReturnType<typeof readInk>, HTMLSpanElement>(readInk);
  return (
    <div className="flex flex-col gap-6 px-6 py-8 first:pl-0 [&+&]:edge-l max-md:px-3">
      <span ref={ref} className="font-medium leading-none" style={{ color: `var(--${role})`, ...display(48, '6vw', 80) }}>Aa</span>
      <div className="flex flex-col gap-1">
        <Token>{role}</Token>
        <Value>{reading ? hex6(reading.value) : ' '}</Value>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-medium tabular-nums text-fg">{reading ? reading.ratio.toFixed(1) : '–'}</span>
        <span className="font-mono text-2xs text-fg-3">: 1</span>
      </div>
    </div>
  );
}

const hex6 = ([r, g, b]: number[]) => `#${[r!, g!, b!].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;

const AGENT_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', dsh: 'dsh' };

/** One agent's plate; the one under the pointer widens, the others give way. */
function AgentPlate({ role }: { role: ThemeRole }) {
  const [ref, value] = usePainted(readFill);
  const name = role.replace('agent-', '');
  return (
    <div className="group flex min-w-0 flex-1 flex-col gap-3 transition-[flex-grow] duration-[var(--duration-slow)] ease-[var(--ease-standard)] hover:grow-[1.9] max-md:basis-[calc(50%-0.5rem)]">
      <div ref={ref} className="relative h-56 overflow-hidden rounded-2xl max-md:h-32" style={{ background: `var(--${role})` }}>
        <span className="absolute bottom-4 left-5 whitespace-nowrap text-lg font-medium text-white/90 opacity-0 transition-[opacity,translate] duration-[var(--duration-slow)] ease-[var(--ease-out-soft)] group-hover:opacity-100 max-md:hidden [translate:0_6px] group-hover:[translate:0_0]">{AGENT_NAME[name] ?? name}</span>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <Token>{name}</Token>
        <Value>{value}</Value>
      </div>
    </div>
  );
}

/** Status and diff as they appear: a hunk of a change, and the three states beside it. */
function StatusSpecimen() {
  const { t } = useLingui();
  const line = 'flex whitespace-pre px-4 py-0.5';
  const gutter = 'w-8 shrink-0 select-none text-right tabular-nums';
  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="overflow-hidden rounded-xl border border-line bg-elevated font-mono text-xs">
        <div className="flex items-center justify-between px-4 py-2 text-fg-3 edge-b"><span>src/tokens.ts</span><span><span style={{ color: 'var(--diff-add-marker)' }}>+2</span> <span style={{ color: 'var(--diff-del-marker)' }}>−1</span></span></div>
        <div className="py-1.5">
          <div className={cn(line, 'text-fg-3')}><span className={gutter}>12</span><span className="w-6" />export const MOTION = {'{'}</div>
          <div className={cn(line, 'text-fg')} style={{ background: 'var(--diff-del)' }}><span className={gutter} style={{ background: 'var(--diff-del-gutter)', color: 'var(--diff-del-marker)' }}>13</span><span className="w-6 text-center" style={{ color: 'var(--diff-del-marker)' }}>−</span>  fast: <span className="rounded-xs" style={{ background: 'var(--diff-del-strong)' }}>120</span>,</div>
          <div className={cn(line, 'text-fg')} style={{ background: 'var(--diff-add)' }}><span className={gutter} style={{ background: 'var(--diff-add-gutter)', color: 'var(--diff-add-marker)' }}>13</span><span className="w-6 text-center" style={{ color: 'var(--diff-add-marker)' }}>+</span>  fast: <span className="rounded-xs" style={{ background: 'var(--diff-add-strong)' }}>150</span>,</div>
          <div className={cn(line, 'text-fg')} style={{ background: 'var(--diff-add)' }}><span className={gutter} style={{ background: 'var(--diff-add-gutter)', color: 'var(--diff-add-marker)' }}>14</span><span className="w-6 text-center" style={{ color: 'var(--diff-add-marker)' }}>+</span>  exitFast: <span className="rounded-xs" style={{ background: 'var(--diff-add-strong)' }}>100</span>,</div>
          <div className={cn(line, 'text-fg-3')}><span className={gutter}>15</span><span className="w-6" />{'}'};</div>
        </div>
      </div>
      <div className="flex flex-col justify-center gap-2.5">
        {([
          ['success', IconCircleCheck, t`已完成 · 12 项检查通过`],
          ['warning', IconTriangleAlert, t`等待确认 · 将删除 dist/`],
          ['danger', IconCircleAlert, t`出错 · 进程退出码 1`],
        ] as const).map(([tone, Glyph, label]) => (
          <div key={tone} className="flex items-center gap-3 rounded-xl px-3.5 py-3 text-sm text-fg" style={{ background: `var(--${tone}-soft)` }}>
            <Glyph className="size-4 shrink-0" style={{ color: `var(--${tone})` }} />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <Token className="text-fg-3">{tone}</Token>
          </div>
        ))}
      </div>
    </div>
  );
}

function IndexRow({ role }: { role: ThemeRole }) {
  const [ref, value] = usePainted<string | undefined, HTMLSpanElement>(readFill);
  return (
    <div className="flex h-9 items-center gap-3 edge-b">
      <span ref={ref} className="size-4 shrink-0 rounded-sm shadow-[inset_0_0_0_1px_var(--line)]" style={{ background: `var(--${role})` }} />
      <Token className="min-w-0 flex-1 truncate">{role}</Token>
      <Value className="shrink-0">{value}</Value>
    </div>
  );
}

export function ColorChapter() {
  const { t } = useLingui();
  return (
    <Chapter
      title={t`颜色`}
      lede={t`${THEME_ROLES.length} 个颜色角色由主题提供：${SURFACES.length} 级底色表达层次，${INKS.length} 级墨色表达文字主次，彩色用于状态与 agent 标志。`}
      source="apps/web/src/styles/index.css"
    >
      <SurfaceStack />
      <Plate number={2} title={t`墨色`} note={t`对比度按 WCAG 2 相对亮度计算，底色为 bg。fg-4 用于占位符与快捷键这类可缺省的信息。`}>
        <div className="grid grid-cols-4 max-md:grid-cols-2">{INKS.map((role) => <Ink key={role} role={role} />)}</div>
      </Plate>
      <Plate number={3} title={t`Agent`} note={t`界面自有的四种彩色，用于 agent 的头像与名称标记。`}>
        <div className="flex gap-4 max-md:flex-wrap">{AGENTS.map((role) => <AgentPlate key={role} role={role} />)}</div>
      </Plate>
      <Plate number={4} title={t`状态与差异`} note={t`success：完成与新增；warning：等待处理；danger：出错与不可逆操作。状态色专用于状态。`}>
        <Frame className="p-6 max-md:p-4"><StatusSpecimen /></Frame>
      </Plate>
      <Plate number={5} title={t`全部角色`} note={t`取值读自当前主题。`}>
        <div className="grid gap-x-8 edge-t sm:grid-cols-2 lg:grid-cols-3">
          {THEME_ROLES.map((role) => <IndexRow key={role} role={role} />)}
        </div>
      </Plate>
    </Chapter>
  );
}
