import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import { DESKTOP_TEXT, MAC_MOTION, MOBILE_EASING, MOBILE_SHARED_MOTION, MOTION_DURATION, MOTION_EASING, SPACE, THEME_ROLES } from '@contracts';
import { AgentLogo } from '@/components/AgentLogo';
import { IconArrowUp, IconCheck, IconChevronRight, IconCopy, IconEllipsis, IconFolder, IconGitBranch, IconPencilLine, IconPlus, IconSearch, IconSparkles, IconSquareTerminal, IconTrash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Badge, Segmented, Spinner, StatusDot, Switch } from '@/components/ui/controls';
import { agentMarkStyle } from '@/lib/backends';
import { setThemeMode, useTheme, type ThemeMode } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { Chapter, display, Frame, PAGE, reducedMotion, Reveal, useInView } from './specimen';

export interface ChapterEntry { id: string; number: string; title: string }

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
          <Button size="lg" variant="primary" className="rounded-full px-5" onClick={() => onGo('components')}>{t`浏览组件`}</Button>
          <Button size="lg" variant="secondary" className="rounded-full px-5" onClick={() => onGo('principles')}>{t`设计原则`}</Button>
        </div>
      </div>
      <div className={cn(PAGE, 'max-w-[1280px] pb-24')}>
        <Stage entered={entered} />
      </div>
    </section>
  );
}

/** The small figure on each contents card: what the chapter is about, drawn in the chapter's own terms. */
function Glimpse({ id }: { id: string }) {
  const spread = 'transition-[translate,scale,opacity] duration-[var(--duration-slow)] ease-[var(--ease-standard)]';
  switch (id) {
    case 'principles':
      return (
        <div className="flex w-28 flex-col gap-2">
          <span className={cn(spread, 'h-1.5 w-full rounded-full bg-fg')} />
          <span className={cn(spread, 'h-1.5 w-3/4 rounded-full bg-fg-3 group-hover:translate-x-2')} />
          <span className={cn(spread, 'h-1.5 w-1/2 rounded-full bg-fg-4 group-hover:translate-x-4')} />
        </div>
      );
    case 'colors':
      return (
        <div className="flex">
          {['var(--fg)', 'var(--fg-3)', 'var(--fg-4)', 'var(--agent-claude)', 'var(--agent-codex)', 'var(--agent-dsh)'].map((fill, index) => (
            <span key={fill} className={cn(spread, 'size-7 translate-x-[var(--overlap)] rounded-full ring-2 ring-sidebar group-hover:translate-x-0')} style={{ background: fill, ['--overlap' as string]: `${index * -8}px` }} />
          ))}
        </div>
      );
    case 'type':
      return <span className="flex items-baseline gap-2 text-fg"><span className={cn(spread, 'font-semibold leading-none group-hover:-translate-y-0.5')} style={{ fontSize: 40 }}>Aa</span><span className="text-2xl">Aa</span><span className="text-sm text-fg-3">Aa</span></span>;
    case 'spacing':
      return <span className="flex items-end gap-1.5">{[6, 10, 14, 20, 28].map((size, index) => <span key={size} className={cn(spread, 'rounded-xs bg-fg/[0.14] group-hover:bg-fg/[0.22]')} style={{ width: size, height: size, transitionDelay: `${index * 30}ms` }} />)}</span>;
    case 'elevation':
      return (
        <span className="relative block h-14 w-24">
          {[0, 1, 2].map((index) => <span key={index} className={cn(spread, 'absolute inset-x-0 h-10 rounded-md bg-elevated shadow-pop')} style={{ top: index * 8, left: index * 8, right: -index * 8 }} />)}
        </span>
      );
    case 'motion': {
      // The standard curve in the figure's own pixels (112 × 48); the dot travels it on hover.
      const [x1, y1, x2, y2] = MOTION_EASING.standard;
      const curve = `M 0 48 C ${x1 * 112} ${48 - y1 * 48}, ${x2 * 112} ${48 - y2 * 48}, 112 0`;
      return (
        <span className="relative block h-12 w-28">
          <svg aria-hidden viewBox="0 0 112 48" className="absolute inset-0 size-full overflow-visible text-fg-4">
            <path d={curve} fill="none" stroke="currentColor" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
          </svg>
          <span
            className="absolute left-0 top-0 size-2 rounded-full bg-fg transition-[offset-distance] duration-[calc(var(--duration-slow)*3)] ease-[var(--ease-standard)] [offset-distance:0%] group-hover:[offset-distance:100%]"
            style={{ offsetPath: `path('${curve}')`, offsetRotate: '0deg' }}
          />
        </span>
      );
    }
    case 'icons':
      return <span className="flex items-center gap-3 text-fg-2 [&_svg]:size-6">{[<IconSearch key="s" />, <IconFolder key="f" />, <IconSparkles key="k" />, <IconGitBranch key="g" />].map((glyph, index) => <span key={index} className={cn(spread, 'group-hover:-translate-y-0.5')} style={{ transitionDelay: `${index * 40}ms` }}>{glyph}</span>)}</span>;
    case 'layout':
      return (
        <span className="flex h-14 w-28 gap-1 rounded-md bg-canvas p-1 shadow-[0_0_0_1px_var(--line-strong)]">
          <span className={cn(spread, 'w-5 rounded-xs bg-fg/[0.08]')} />
          <span className="flex-1 rounded-xs bg-bg shadow-[0_0_0_1px_var(--line)]" />
          <span className={cn(spread, 'w-7 origin-right rounded-xs bg-fg/[0.08] group-hover:scale-x-0')} />
        </span>
      );
    case 'overlays':
      return (
        <span className="relative block h-14 w-28">
          <span className="absolute left-0 top-0 h-6 w-12 rounded-md bg-fg/[0.08]" />
          <span className={cn(spread, 'absolute left-4 top-8 h-10 w-24 origin-top-left rounded-lg bg-elevated shadow-pop group-hover:scale-105')} />
        </span>
      );
    case 'architecture':
      return (
        <span className="flex w-28 flex-col gap-1">
          {[0, 1, 2, 3].map((index) => <span key={index} className={cn(spread, 'h-2.5 rounded-xs bg-fg')} style={{ opacity: 1 - index * 0.22, translate: `${index * 6}px 0` }} />)}
        </span>
      );
    default:
      return (
        <span className="flex items-center gap-3">
          <span className="inline-flex h-7 items-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-fg">{'Aa'}</span>
          <span className="inline-flex h-[18px] w-8 items-center rounded-full bg-primary p-0.5"><span className={cn(spread, 'size-3.5 translate-x-3.5 rounded-full bg-primary-fg group-hover:translate-x-0')} /></span>
        </span>
      );
  }
}

/** The contents: one card per chapter, each with a figure and what the chapter holds. */
export function Contents({ chapters, icons, onGo }: { chapters: ChapterEntry[]; icons: number; onGo: (id: string) => void }) {
  const { t } = useLingui();
  const summary: Record<string, string> = {
    principles: t`三条原则`,
    colors: t`${THEME_ROLES.length} 个颜色角色`,
    type: t`${Object.keys(DESKTOP_TEXT).length} 档字号`,
    spacing: t`${Object.keys(SPACE).length} 档间距`,
    elevation: t`5 档阴影`,
    motion: t`${Object.keys(MOTION_DURATION).length} 档时长`,
    icons: t`${icons} 个图标`,
    components: t`按钮、输入框、开关、菜单`,
    layout: t`工作台与页面骨架`,
    overlays: t`七种浮层`,
    architecture: t`六层，依赖只向下`,
  };
  return (
    <section className="bg-bg">
      <nav aria-label={t`章节`} className={cn(PAGE, 'grid grid-cols-4 gap-4 pb-32 max-lg:grid-cols-2')}>
        {chapters.map((chapter, index) => (
          <Reveal key={chapter.id} delay={index * 50}>
            <button
              type="button"
              onClick={() => onGo(chapter.id)}
              className="group flex h-56 w-full flex-col rounded-2xl bg-sidebar p-5 text-left outline-none transition-[background-color,translate] duration-[var(--duration-base)] ease-[var(--ease-standard)] hover:-translate-y-0.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-focus max-md:h-48"
            >
              <span className="font-mono text-2xs tabular-nums text-fg-4">{chapter.number}</span>
              <span aria-hidden className="grid flex-1 place-items-center"><Glimpse id={chapter.id} /></span>
              <span className="flex items-end justify-between gap-3">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-base font-medium text-fg">{chapter.title}</span>
                  <span className="truncate text-sm text-fg-3">{summary[chapter.id]}</span>
                </span>
                <IconChevronRight className="size-4 shrink-0 -translate-x-1 text-fg-3 opacity-0 transition-[opacity,translate] duration-[var(--duration-base)] group-hover:translate-x-0 group-hover:opacity-100" />
              </span>
            </button>
          </Reveal>
        ))}
      </nav>
    </section>
  );
}

const bezier = (points: readonly number[]) => `cubic-bezier(${points.join(', ')})`;
const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
/** SwiftUI's spring response for a Compose stiffness, as `gen:tokens` converts it. */
const response = (stiffness: number) => Math.round((2 * Math.PI / Math.sqrt(stiffness)) * 100) / 100;

/** Source lines and the lines `gen:tokens` writes from them, computed from the same constants. */
function useTargets() {
  const mac = (tier: keyof typeof MAC_MOTION) => `static let ${tier} = Animation.${MAC_MOTION[tier].spring}(duration: ${MOTION_DURATION[MAC_MOTION[tier].duration] / 1000})`;
  return {
    sources: [
      { file: 'design-tokens.ts', lines: [`standard: [${MOTION_EASING.standard.join(', ')}],`, `fast: ${MOTION_DURATION.fast},`, `spring: '${MAC_MOTION.fast.spring}', duration: 'fast',`] },
      { file: 'mobile-styles.ts', lines: [`standard: [${MOBILE_EASING.standard.join(', ')}],`, `spatialStiffness: ${MOBILE_SHARED_MOTION.spatialStiffness},`, `spatialDamping: ${MOBILE_SHARED_MOTION.spatialDamping},`] },
    ],
    targets: [
      { platform: 'Web', path: 'apps/web/src/styles/index.css', lines: [`--ease-standard: ${bezier(MOTION_EASING.standard)};`, `--duration-${kebab('fast')}: ${MOTION_DURATION.fast}ms;`] },
      { platform: 'macOS', path: 'apps/macos/Riffet/Theme/Controls.swift', lines: [mac('fast'), mac('standard')] },
      { platform: 'Android', path: 'apps/mobile/shared/…/MobileStyles.generated.kt', lines: [`val StandardMotionEasing = CubicBezierEasing(${MOBILE_EASING.standard.map((n) => `${n}f`).join(', ')})`] },
      { platform: 'iOS', path: 'apps/mobile/iosApp/Riffet/Design/RiffetDesign.swift', lines: [`static let spatial = Animation.spring(response: ${response(MOBILE_SHARED_MOTION.spatialStiffness)}, dampingFraction: ${MOBILE_SHARED_MOTION.spatialDamping})`] },
    ],
  };
}

/** Where each target card's middle falls in the connector column, % of its height. */
const TARGET_AT = [12.5, 37.5, 62.5, 87.5];
const FORK = 34;

/** The connectors from the generator to the four targets, a pulse running down each. */
function Connectors({ running }: { running: boolean }) {
  const pulses = useRef<SVGPathElement[]>([]);
  useEffect(() => {
    if (!running || reducedMotion()) return;
    // motion-loop: the pulse along each connector, only while the figure is on screen
    const runs = pulses.current.map((path, index) => path.animate([{ strokeDashoffset: 100 }, { strokeDashoffset: 0 }], { duration: 2000, delay: index * 220, iterations: Infinity, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }));
    return () => runs.forEach((run) => run.cancel());
  }, [running]);
  const path = (y: number) => `M 0 50 L ${FORK} 50 C ${FORK + 30} 50, ${FORK + 22} ${y}, 100 ${y}`;
  return (
    <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-y-0 -left-6 -right-6 h-full w-[calc(100%+3rem)] overflow-visible">
      {TARGET_AT.map((y) => <path key={y} d={path(y)} fill="none" stroke="var(--paper)" strokeOpacity="0.22" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
      {TARGET_AT.map((y, index) => (
        <path
          key={`pulse-${y}`}
          ref={(element) => { if (element) pulses.current[index] = element; }}
          d={path(y)}
          pathLength={100}
          fill="none"
          stroke="var(--paper)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="16 84"
          strokeDashoffset={100}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

/** A file's lines set on the ink: its name, then the code. */
function Listing({ title, caption, lines, className }: { title: string; caption?: string; lines: string[]; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-2.5 rounded-xl border border-(--paper)/15 bg-(--paper)/[0.05] px-4 py-3.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-(--paper)">{title}</span>
        {caption && <span className="min-w-0 truncate font-mono text-2xs text-(--paper)/45">{caption}</span>}
      </div>
      <div className="flex flex-col gap-0.5 font-mono text-xs text-(--paper)/80">
        {lines.map((line) => <span key={line} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{line}</span>)}
      </div>
    </div>
  );
}

/** One definition, four platforms: the source constants, the generator and what it writes. */
export function Pipeline() {
  const { t } = useLingui();
  const { sources, targets } = useTargets();
  const [figure, running] = useInView<HTMLDivElement>({ margin: '0px' });
  return (
    <section className="bg-(--ink) text-(--paper) [--ink:var(--fg)] [--paper:var(--bg)] dark:[--ink:color-mix(in_srgb,var(--bg)_55%,black)] dark:[--paper:var(--fg)]">
      <div className={cn(PAGE, 'flex flex-col gap-20 py-32 max-md:gap-12 max-md:py-20')}>
        <header className="flex max-w-[48rem] flex-col">
          <Reveal className="flex items-center gap-3 font-mono text-xs text-(--paper)/45">
            <span>packages/contracts</span>
            <span className="h-px w-6 bg-(--paper)/25" />
            <span>pnpm gen:tokens</span>
          </Reveal>
          <Reveal delay={60}><h2 className="mt-5 font-semibold leading-[1.05] tracking-tight" style={display(36, '5vw', 64)}>{t`一处定义，四端生成`}</h2></Reveal>
          <Reveal delay={120}>
            <p className="mt-5 max-w-[36em] text-lg text-(--paper)/70">{t`间距、字号、圆角与动效以 packages/contracts 为源，颜色以 apps/web/src/styles/index.css 为源。pnpm gen:tokens 与 pnpm gen:theme 把取值写入四端的源文件；生成结果过期时，--check 以非零状态退出。`}</p>
          </Reveal>
        </header>
        <Reveal delay={160}>
          <div ref={figure} className="grid items-center gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(120px,0.4fr)_minmax(0,1.5fr)]">
            <div className="flex flex-col gap-3">
              <span className="font-mono text-2xs text-(--paper)/45">packages/contracts/src/</span>
              {sources.map((source) => <Listing key={source.file} title={source.file} lines={source.lines} />)}
            </div>
            <div className="relative h-full min-h-24 max-lg:hidden">
              <Connectors running={running} />
              <span className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-(--paper) px-3 py-1 font-mono text-2xs text-(--ink)" style={{ left: `calc(${FORK / 100} * (100% + 3rem) - 1.5rem)` }}>gen:tokens</span>
            </div>
            <div className="grid grid-rows-4 gap-3">
              {targets.map((target) => <Listing key={target.platform} title={target.platform} caption={target.path} lines={target.lines} />)}
            </div>
          </div>
        </Reveal>
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
    <Chapter id="principles" number="01" title={t`原则`} lede={t`三条原则用于取舍。具体规则与原则冲突时以原则为准，结论记入 docs/design/DECISIONS.md。`} tone="canvas" source="docs/design/system/README.md">
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
