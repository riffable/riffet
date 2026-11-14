import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import { DESKTOP_TEXT, MOTION_DURATION, SPACE, THEME_ROLES } from '@contracts';
import { AgentLogo } from '@/components/AgentLogo';
import { IconArrowUp, IconCheck, IconChevronRight, IconCopy, IconEllipsis, IconFolder, IconGitBranch, IconPencilLine, IconPlus, IconSearch, IconSparkles, IconSquareTerminal, IconTrash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Badge, Segmented, Spinner, StatusDot, Switch } from '@/components/ui/controls';
import { agentMarkStyle } from '@/lib/backends';
import { setThemeMode, useTheme, type ThemeMode } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { Chapter, display, Frame, PAGE, reducedMotion, Reveal, useInView } from '../specimen';

/** True from the first frame after mount, so an entrance can transition from its start state. */
function useEntered(): boolean {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return entered;
}

/** The cover's entrance: rises into place after `delay`. */
const rise = (entered: boolean, delay: number, distance = 20): CSSProperties => ({
  opacity: entered ? 1 : 0,
  translate: entered ? '0 0' : `0 ${distance}px`,
  transition: `opacity 700ms var(--ease-out-soft) ${delay}ms, translate 1100ms var(--ease-out-soft) ${delay}ms`,
});

/**
 * One surface on the stage. The outer layer follows the pointer by `depth` px at the stage's edge,
 * the inner one carries the entrance, so the two transitions never wait on each other.
 */
function Piece({ entered, order, depth, className, children }: { entered: boolean; order: number; depth: number; className?: string; children: ReactNode }) {
  return (
    <div
      className={cn('absolute', className)}
      style={{ transform: `translate3d(calc(var(--mx, 0) * ${depth}px), calc(var(--my, 0) * ${depth}px), 0)`, transition: 'transform 700ms var(--ease-out-soft)' }}
    >
      <div style={rise(entered, 420 + order * 130, 32)}>{children}</div>
    </div>
  );
}

const card = 'rounded-xl bg-elevated shadow-pop';

/** A conversation as the workbench draws it, built from the same parts. */
function Conversation() {
  const { t } = useLingui();
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-t-2xl bg-bg shadow-pop">
      <div className="flex h-11 shrink-0 items-center gap-2 px-4 edge-b">
        <AgentLogo backend="claude" size={14} style={agentMarkStyle('claude')} />
        <span className="min-w-0 truncate text-sm font-medium text-fg">{t`超时改用共享的时长常量`}</span>
        <span className="ml-auto flex items-center gap-0.5 text-fg-3">
          <Button size="icon-sm" variant="quiet" tabIndex={-1} aria-hidden><IconGitBranch /></Button>
          <Button size="icon-sm" variant="quiet" tabIndex={-1} aria-hidden><IconEllipsis /></Button>
        </span>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col gap-4 px-8 pt-6 text-sm">
        <div className="max-w-[80%] self-end rounded-2xl bg-bubble px-3.5 py-2 text-fg">{t`把 300 换成共享的时长常量`}</div>
        <div className="flex items-center gap-1.5 text-fg-3"><IconChevronRight className="size-3.5" />{t`已处理 · 3 个工具调用`}</div>
        <p className="leading-relaxed text-fg">{t`已替换。motion.ts 里另外两处已在使用常量，保持原样。`}</p>
        <div className="overflow-hidden rounded-lg border border-line font-mono text-xs">
          <div className="flex items-center justify-between px-3 py-1.5 text-fg-3 edge-b"><span>lib/motion.ts</span><span className="tabular-nums"><span style={{ color: 'var(--diff-add-marker)' }}>+1</span> <span style={{ color: 'var(--diff-del-marker)' }}>−1</span></span></div>
          <div className="flex whitespace-pre px-3 py-1 text-fg" style={{ background: 'var(--diff-del)' }}><span className="w-4" style={{ color: 'var(--diff-del-marker)' }}>−</span>  const ms = <span className="rounded-xs" style={{ background: 'var(--diff-del-strong)' }}>300</span>;</div>
          <div className="flex whitespace-pre px-3 py-1 text-fg" style={{ background: 'var(--diff-add)' }}><span className="w-4" style={{ color: 'var(--diff-add-marker)' }}>+</span>  const ms = <span className="rounded-xs" style={{ background: 'var(--diff-add-strong)' }}>MOTION_DURATION.slow</span>;</div>
        </div>
        <div className="absolute inset-x-5 bottom-5 flex flex-col gap-2 rounded-2xl bg-elevated p-3 shadow-composer">
          <span className="px-1 text-fg-4">{t`回复 Claude Code`}</span>
          <div className="flex items-center gap-1">
            <Button size="icon-sm" variant="quiet" tabIndex={-1} aria-hidden><IconPlus /></Button>
            <span className="flex h-7 items-center rounded-lg px-2 text-xs text-fg-2">{t`自动编辑`}</span>
            <span className="ml-auto flex h-7 items-center rounded-lg px-2 text-xs text-fg-3">Opus 5.5</span>
            <span className="grid size-8 place-items-center rounded-full bg-primary text-primary-fg"><IconArrowUp className="size-4" strokeWidth={2.4} /></span>
          </div>
        </div>
      </div>
    </div>
  );
}

function MenuPiece() {
  const { t } = useLingui();
  const item = 'flex h-8 items-center gap-2 rounded-lg px-2 text-sm [&_svg]:size-4';
  return (
    <div className={cn(card, 'flex w-52 flex-col bg-popover p-1')}>
      <span className={cn(item, 'bg-hover text-fg [&_svg]:text-fg-2')}><IconPencilLine />{t`重命名`}</span>
      <span className={cn(item, 'text-fg [&_svg]:text-fg-3')}><IconCopy />{t`复制链接`}</span>
      <span className="mx-2 my-1 h-px bg-line" />
      <span className={cn(item, 'text-danger')}><IconTrash2 />{t`删除`}</span>
    </div>
  );
}

function SettingsPiece() {
  const { t } = useLingui();
  const theme = useTheme();
  const [lines, setLines] = useState(true);
  const [wrap, setWrap] = useState(false);
  const row = 'flex h-12 items-center justify-between gap-4 px-4 text-sm text-fg';
  return (
    <div className={cn(card, 'flex w-72 flex-col')}>
      <label className={cn(row, 'edge-b')}>{t`显示行号`}<Switch checked={lines} onCheckedChange={setLines} /></label>
      <label className={cn(row, 'edge-b')}>{t`长行自动换行`}<Switch checked={wrap} onCheckedChange={setWrap} /></label>
      <div className={row}>
        {t`明暗`}
        <Segmented<ThemeMode> size="xs" value={theme.mode} onChange={setThemeMode} ariaLabel={t`明暗`} options={[{ value: 'system', label: t`跟随系统` }, { value: 'light', label: t`浅色` }, { value: 'dark', label: t`深色` }]} />
      </div>
    </div>
  );
}

function ApprovalPiece() {
  const { t } = useLingui();
  return (
    <div className={cn(card, 'flex w-72 flex-col gap-3 p-3.5')}>
      <div className="flex items-center gap-2 text-sm text-fg">
        <IconSquareTerminal className="size-4 text-fg-3" />
        <span className="font-mono text-xs">pnpm vitest run</span>
        <Badge tone="warning" className="ml-auto">{t`等待确认`}</Badge>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="secondary" tabIndex={-1}>{t`拒绝`}</Button>
        <Button size="sm" variant="primary" tabIndex={-1}>{t`允许`}</Button>
      </div>
    </div>
  );
}

function RunPiece() {
  const { t } = useLingui();
  return (
    <div className={cn(card, 'flex w-56 flex-col p-1.5 text-sm')}>
      <span className="flex h-8 items-center gap-2 px-2 text-fg"><Spinner className="size-3.5 text-fg-2" />{t`修改 3 个文件`}<span className="ml-auto font-mono text-2xs text-fg-3">4s</span></span>
      <span className="flex h-8 items-center gap-2 px-2 text-fg-3"><IconCheck className="size-3.5 text-fg-4" /><span className="font-mono text-xs">read motion.ts</span><span className="ml-auto font-mono text-2xs text-fg-4">0.4s</span></span>
    </div>
  );
}

/**
 * The product, set on a stage: a conversation with the surfaces that float over it. Each surface
 * is the shipping component; the stage leans with the pointer, the nearer surfaces further.
 */
function Stage({ entered }: { entered: boolean }) {
  const stage = useRef<HTMLDivElement>(null);
  const follow = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || !stage.current || reducedMotion()) return;
    const box = stage.current.getBoundingClientRect();
    stage.current.style.setProperty('--mx', (((event.clientX - box.left) / box.width) * 2 - 1).toFixed(3));
    stage.current.style.setProperty('--my', (((event.clientY - box.top) / box.height) * 2 - 1).toFixed(3));
  };
  const rest = () => { stage.current?.style.setProperty('--mx', '0'); stage.current?.style.setProperty('--my', '0'); };
  return (
    <div
      ref={stage}
      onPointerMove={follow}
      onPointerLeave={rest}
      className="relative isolate h-[620px] overflow-hidden rounded-3xl max-md:h-[520px]"
      style={{
        ...rise(entered, 300, 40),
        background: [
          'radial-gradient(55% 60% at 8% 100%, color-mix(in srgb, var(--agent-claude) 16%, transparent), transparent 70%)',
          'radial-gradient(45% 55% at 96% 4%, color-mix(in srgb, var(--agent-codex) 13%, transparent), transparent 70%)',
          'radial-gradient(40% 50% at 70% 110%, color-mix(in srgb, var(--agent-dsh) 12%, transparent), transparent 70%)',
          'var(--bg-sidebar)',
        ].join(', '),
      }}
    >
      <Piece entered={entered} order={0} depth={-6} className="inset-x-0 bottom-0 top-14 mx-auto w-[min(560px,calc(100%-40px))]">
        <div className="h-[566px] max-md:h-[466px]"><Conversation /></div>
      </Piece>
      <Piece entered={entered} order={1} depth={16} className="left-[4%] top-32 max-lg:hidden"><MenuPiece /></Piece>
      <Piece entered={entered} order={2} depth={12} className="right-[3%] top-24 max-lg:hidden"><SettingsPiece /></Piece>
      <Piece entered={entered} order={3} depth={20} className="bottom-28 left-[6%] max-lg:hidden"><RunPiece /></Piece>
      <Piece entered={entered} order={4} depth={24} className="bottom-20 right-[5%] max-lg:hidden"><ApprovalPiece /></Piece>
    </div>
  );
}

export function Cover({ onGo }: { onGo: (id: string) => void }) {
  const { t } = useLingui();
  const entered = useEntered();
  return (
    <section id="cover" className="bg-bg">
      <div className={cn(PAGE, 'flex flex-col items-center pb-16 pt-28 text-center max-md:pt-16')}>
        <span className="inline-flex h-7 items-center gap-2 rounded-full bg-fg/[0.05] px-3 text-xs text-fg-2" style={rise(entered, 0, 10)}>
          Web<span className="text-fg-4">·</span>macOS<span className="text-fg-4">·</span>Android<span className="text-fg-4">·</span>iOS
        </span>
        <h1 className="mt-7 whitespace-nowrap font-semibold leading-[1.05] tracking-tight text-fg" style={{ ...display(36, '6.4vw', 80), ...rise(entered, 80) }}>
          Riffet {t`设计规范`}
        </h1>
        <p className="mt-6 flex flex-col gap-1 text-lg md:text-xl" style={rise(entered, 160)}>
          <span className="text-balance text-fg-2">{t`四个客户端共用的颜色、文字、间距、动效与组件。`}</span>
          <span className="text-balance text-fg-3">{t`取值只定义一次，由生成器写入各端。`}</span>
        </p>
        <div className="mt-9 flex items-center gap-3" style={rise(entered, 240)}>
          <Button size="lg" variant="primary" className="rounded-full px-5" onClick={() => onGo('components/actions')}>{t`浏览组件`}</Button>
          <Button size="lg" variant="secondary" className="rounded-full px-5" onClick={() => onGo('overview/principles')}>{t`设计原则`}</Button>
        </div>
      </div>
      <div className={cn(PAGE, 'max-w-[1280px] pb-24')}>
        <Stage entered={entered} />
      </div>
    </section>
  );
}

/** Principle 1, shown: the conversation is neutral; colour is the agent's mark and the diff. */
function InkDemo() {
  const { t } = useLingui();
  const [ref, seen] = useInView<HTMLDivElement>({ once: true, margin: '0px 0px -20% 0px' });
  const step = (index: number) => ({ opacity: seen ? 1 : 0, translate: seen ? '0 0' : '0 8px', transitionDelay: `${300 + index * 260}ms` });
  const enter = 'transition-[opacity,translate] duration-[calc(var(--duration-slow)*2)] ease-[var(--ease-out-soft)]';
  return (
    <div ref={ref} className="flex w-full max-w-md flex-col gap-4 p-8">
      <div className={cn(enter, 'self-end rounded-xl bg-bubble px-3.5 py-2 text-sm text-fg')} style={step(0)}>{t`超时改用共享的时长常量`}</div>
      <div className={cn(enter, 'flex items-center gap-2 text-sm font-medium text-fg')} style={step(1)}>
        <span className="size-2 rounded-full" style={{ background: 'var(--agent-claude)' }} />
        Claude Code
      </div>
      <p className={cn(enter, 'text-sm text-fg-2')} style={step(2)}>{t`替换了一处手写数值，其余调用点保持原样。`}</p>
      <div className={cn(enter, 'overflow-hidden rounded-lg border border-line bg-elevated font-mono text-xs')} style={step(3)}>
        <div className="flex items-center justify-between px-3 py-1.5 text-fg-3 edge-b"><span>lib/motion.ts</span><span className="tabular-nums"><span style={{ color: 'var(--diff-add-marker)' }}>+1</span> <span style={{ color: 'var(--diff-del-marker)' }}>−1</span></span></div>
        <div className="whitespace-pre px-3 py-1 text-fg-3">export function settle() {'{'}</div>
        <div className="flex whitespace-pre px-3 py-1 text-fg" style={{ background: 'var(--diff-del)' }}><span className="w-4" style={{ color: 'var(--diff-del-marker)' }}>−</span>  const ms = <span className="rounded-xs" style={{ background: 'var(--diff-del-strong)' }}>300</span>;</div>
        <div className="flex whitespace-pre px-3 py-1 text-fg" style={{ background: 'var(--diff-add)' }}><span className="w-4" style={{ color: 'var(--diff-add-marker)' }}>+</span>  const ms = <span className="rounded-xs" style={{ background: 'var(--diff-add-strong)' }}>MOTION_DURATION.slow</span>;</div>
        <div className="px-3 py-1 text-fg-3">{'}'}</div>
      </div>
    </div>
  );
}

/** Steps a demonstration through `count` phases while it is on screen; holds `rest` otherwise. */
function usePhases(count: number, interval: number, rest: number): [React.RefObject<HTMLDivElement | null>, number] {
  const [ref, visible] = useInView<HTMLDivElement>({ margin: '0px 0px -15% 0px' });
  const [phase, setPhase] = useState(rest);
  useEffect(() => {
    if (!visible || reducedMotion()) { setPhase(rest); return; }
    setPhase(0);
    const timer = window.setInterval(() => setPhase((value) => (value + 1) % count), interval);
    return () => window.clearInterval(timer);
  }, [visible, count, interval, rest]);
  return [ref, phase];
}

/**
 * Principle 2, shown as it runs: the call in progress carries the weight, finished calls drop to
 * the secondary ink, then fold into one line; a command waiting on the reader outweighs them all.
 */
function WeightDemo() {
  const { t } = useLingui();
  const calls: Array<{ label: ReactNode; time: string }> = [
    { label: <span className="font-mono text-xs">read package.json</span>, time: '0.4s' },
    { label: <span className="font-mono text-xs">pnpm vitest run</span>, time: '12s' },
    { label: <span>{t`修改 3 个文件`}</span>, time: '4s' },
  ];
  // 0–2: call n runs; 3: all done; 4–6: folded, a command waits.
  const [ref, phase] = usePhases(7, 1100, 4);
  const folded = phase >= 4;
  const row = 'flex h-9 items-center gap-3 px-4 text-sm animate-in fade-in-0 slide-in-from-bottom-1 duration-[var(--duration-base)] ease-[var(--ease-decelerate)]';
  return (
    <div ref={ref} className="flex w-full max-w-md flex-col py-6">
      {folded
        ? <div key="folded" className={cn(row, 'text-fg-4')}><IconChevronRight className="size-3.5" />{t`已处理 · ${calls.length} 个工具调用`}</div>
        : calls.slice(0, phase + 1).map((call, index) => {
            const running = index === phase && phase < calls.length;
            return (
              <div key={index} className={cn(row, 'transition-colors duration-[var(--duration-slow)]', running ? 'text-fg' : 'text-fg-3')}>
                {running ? <Spinner className="size-3.5 text-fg-2" /> : <IconCheck className="size-3.5 text-fg-4" />}
                {call.label}
                <span className={cn('ml-auto font-mono text-2xs tabular-nums', running ? 'text-fg-3' : 'text-fg-4')}>{call.time}</span>
              </div>
            );
          })}
      {folded && (
        <div key="waiting" className={cn(row, 'mx-2 mt-2 rounded-lg bg-warning-soft px-2 text-fg')}>
          <StatusDot tone="warning" pulse />
          <span className="font-mono text-xs">rm -rf dist/</span>
          <Badge tone="warning" className="ml-auto">{t`等待确认`}</Badge>
        </div>
      )}
    </div>
  );
}

/** How much the origin demo enlarges the real motion, so its shape can be seen. */
const SLOW = 4;

/** Principle 3, shown: a popover enters from its trigger and leaves back into it; its place is held. */
function OriginDemo() {
  const { t } = useLingui();
  const [manual, setManual] = useState<boolean | null>(null);
  const [ref, phase] = usePhases(2, 2000, 0);
  const open = manual ?? phase === 0;
  const items: Array<[ReactNode, string]> = [[<IconPencilLine />, t`重命名`], [<IconCopy />, t`复制链接`], [<IconTrash2 />, t`删除`]];
  return (
    <div ref={ref} className="relative h-full w-full max-w-md p-8">
      <Button variant="secondary" size="sm" aria-expanded={open} onClick={() => setManual(!open)}><IconEllipsis />{t`更多`}</Button>
      <div className="relative mt-1.5 w-48">
        {/* Where it will be: the destination is held while it is closed. */}
        <div aria-hidden className={cn('absolute inset-0 rounded-xl border border-dashed border-fg-4 transition-opacity', open ? 'opacity-0' : 'opacity-100')} />
        {/* Where it comes from: the transform origin, at the trigger's corner. */}
        <svg aria-hidden viewBox="0 0 16 16" className="absolute -left-2 -top-2 z-10 size-4 text-fg-2">
          <path d="M8 0v16M0 8h16" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </svg>
        <div
          className="flex flex-col rounded-xl bg-popover p-1 shadow-pop"
          style={{
            transformOrigin: 'top left',
            transform: open ? 'scale(1)' : 'scale(0.6)',
            opacity: open ? 1 : 0,
            transition: open
              ? `transform ${MOTION_DURATION.fast * SLOW}ms var(--ease-decelerate), opacity ${MOTION_DURATION.fast * SLOW}ms var(--ease-decelerate)`
              : `transform ${MOTION_DURATION.exitFast * SLOW}ms var(--ease-accelerate), opacity ${MOTION_DURATION.exitFast * SLOW}ms var(--ease-accelerate)`,
          }}
        >
          {items.map(([glyph, label]) => <span key={label} className="flex h-8 items-center gap-2 rounded-lg px-2 text-sm text-fg [&_svg]:size-4 [&_svg]:text-fg-3">{glyph}{label}</span>)}
        </div>
      </div>
      <span className="absolute bottom-4 right-5 font-mono text-2xs text-fg-4">{t`缩放与时长放大 ${SLOW} 倍`}</span>
    </div>
  );
}

export function PrinciplesChapter() {
  const { t } = useLingui();
  const principles: Array<{ title: string; body: string; demo: ReactNode }> = [
    { title: t`彩色只用来传递信息`, body: t`界面框架使用灰阶。彩色出现在运行状态、diff、语法高亮和 agent 标志上，每种颜色对应一种含义。`, demo: <InkDemo /> },
    { title: t`正在发生的事最醒目`, body: t`运行中、待确认和出错的条目使用正文色；已完成的工具调用和历史轮次降为次要色，或折叠成一行。`, demo: <WeightDemo /> },
    { title: t`过渡保留位置关系`, body: t`浮层从触发它的控件展开、收回；切换内容时容器保持尺寸；控件在原位改变状态。`, demo: <OriginDemo /> },
  ];
  return (
    <Chapter title={t`原则`} lede={t`三条原则用于取舍。具体规则与原则冲突时以原则为准，结论记入 docs/design/DECISIONS.md。`} tone="canvas" source="docs/design/system/README.md">
      {principles.map((principle, index) => (
        <div key={principle.title} className="grid grid-cols-12 items-center gap-x-6 gap-y-8">
          <Reveal className={cn('col-span-12 flex flex-col gap-6 md:col-span-5', index % 2 === 1 && 'md:order-2 md:col-start-8')}>
            <span className="font-mono text-xs text-fg-4">{`P${index + 1}`}</span>
            <h3 className="text-balance font-semibold leading-[1.15] tracking-tight text-fg" style={display(26, '2.8vw', 36)}>{principle.title}</h3>
            <p className="max-w-[28em] text-base text-fg-2">{principle.body}</p>
          </Reveal>
          <Reveal delay={140} className={cn('col-span-12 md:col-span-7', index % 2 === 1 && 'md:order-1 md:col-span-6')}>
            <Frame className="flex min-h-[340px] items-center justify-center">{principle.demo}</Frame>
          </Reveal>
        </div>
      ))}
    </Chapter>
  );
}
