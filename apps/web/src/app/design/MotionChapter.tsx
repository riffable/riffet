import { useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { MOTION_DURATION, MOTION_EASING } from '@contracts';
import { IconPlay } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Chapter, Frame, Plate, reducedMotion, Token, useInView, Value } from './specimen';

type Curve = readonly [number, number, number, number];
type CurveName = keyof typeof MOTION_EASING;
type DurationName = keyof typeof MOTION_DURATION;
const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** Demonstrations run this many times slower than the interface, so their shape can be seen. */
const SLOW = 4;

/** The progress a CSS cubic-bezier reaches at time `x` (both 0–1). */
function progress([x1, y1, x2, y2]: Curve, x: number): number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const at = (t: number) => ((ax * t + bx) * t + cx) * t;
  let low = 0, high = 1, t = x;
  for (let step = 0; step < 24; step += 1) {
    const value = at(t);
    if (Math.abs(value - x) < 1e-5) break;
    if (value < x) low = t; else high = t;
    t = (low + high) / 2;
  }
  return ((ay * t + by) * t + cy) * t;
}

/** Calls `frame(elapsed)` every animation frame for `duration` ms. */
function useTimeline(duration: number, frame: (elapsed: number) => void): [() => void, boolean] {
  const [running, setRunning] = useState(false);
  const handle = useRef(0);
  const draw = useRef(frame);
  draw.current = frame;
  useEffect(() => () => cancelAnimationFrame(handle.current), []);
  const play = () => {
    cancelAnimationFrame(handle.current);
    const start = performance.now();
    setRunning(true);
    const tick = (now: number) => {
      const elapsed = Math.min(now - start, duration);
      draw.current(elapsed);
      if (elapsed < duration) handle.current = requestAnimationFrame(tick);
      else setRunning(false);
    };
    handle.current = requestAnimationFrame(tick);
  };
  return [play, running];
}

/** Replays `play` every `period` ms while the figure is on screen. */
function useAutoplay(play: () => void, period: number) {
  const [ref, visible] = useInView<HTMLDivElement>({ margin: '0px 0px -20% 0px' });
  const latest = useRef(play);
  latest.current = play;
  useEffect(() => {
    if (!visible || reducedMotion()) return;
    latest.current();
    const timer = window.setInterval(() => latest.current(), period);
    return () => window.clearInterval(timer);
  }, [visible, period]);
  return ref;
}

const SIZE = 100;
const point = (x: number, y: number) => `${x * SIZE} ${SIZE - y * SIZE}`;

/** All five curves on one plot; playing them sends a dot along each at once. */
function CurvePlot() {
  const { t } = useLingui();
  const names = Object.keys(MOTION_EASING) as CurveName[];
  const [focus, setFocus] = useState<CurveName>('standard');
  const dots = useRef(new Map<CurveName, SVGCircleElement>());
  const head = useRef<SVGLineElement>(null);
  const span = MOTION_DURATION.slow * SLOW;
  const [play, running] = useTimeline(span, (elapsed) => {
    const x = elapsed / span;
    head.current?.setAttribute('x1', String(x * SIZE));
    head.current?.setAttribute('x2', String(x * SIZE));
    for (const [name, dot] of dots.current) {
      dot.setAttribute('cx', String(x * SIZE));
      dot.setAttribute('cy', String(SIZE - progress(MOTION_EASING[name], x) * SIZE));
    }
  });
  const figure = useAutoplay(play, span + 1200);
  const label: Record<CurveName, [string, string]> = {
    standard: [t`标准`, t`原位的状态变化`],
    decelerate: [t`减速`, t`进入`],
    accelerate: [t`加速`, t`退出`],
    sheet: [t`底部面板`, t`移动端的底部面板`],
    outSoft: [t`柔和减速`, t`图片放大、面板出现`],
  };
  return (
    <Frame className="grid gap-10 p-10 md:grid-cols-[minmax(0,1fr)_260px] max-md:p-6">
      <div ref={figure} className="relative">
        <svg viewBox={`-4 -4 ${SIZE + 8} ${SIZE + 8}`} className="aspect-square w-full overflow-visible">
          {[0.25, 0.5, 0.75].map((at) => (
            <g key={at} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke">
              <line x1={at * SIZE} y1="0" x2={at * SIZE} y2={SIZE} vectorEffect="non-scaling-stroke" />
              <line x1="0" y1={at * SIZE} x2={SIZE} y2={at * SIZE} vectorEffect="non-scaling-stroke" />
            </g>
          ))}
          <rect x="0" y="0" width={SIZE} height={SIZE} fill="none" stroke="var(--line-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <line ref={head} x1="0" y1="0" x2="0" y2={SIZE} stroke="var(--fg-4)" strokeWidth="1" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" className={cn('transition-opacity', running ? 'opacity-100' : 'opacity-0')} />
          {names.map((name) => {
            const [x1, y1, x2, y2] = MOTION_EASING[name];
            const active = name === focus;
            return (
              <g key={name} className="transition-opacity" opacity={active ? 1 : 0.35}>
                {active && <path d={`M ${point(0, 0)} L ${point(x1, y1)} M ${point(1, 1)} L ${point(x2, y2)}`} stroke="var(--fg-4)" strokeWidth="1" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />}
                <path d={`M ${point(0, 0)} C ${point(x1, y1)} ${point(x2, y2)} ${point(1, 1)}`} fill="none" stroke={active ? 'var(--fg)' : 'var(--fg-3)'} strokeWidth={active ? 2 : 1} vectorEffect="non-scaling-stroke" />
                {active && [[x1, y1], [x2, y2]].map(([x, y], index) => <circle key={index} cx={x! * SIZE} cy={SIZE - y! * SIZE} r="1.6" fill="var(--bg)" stroke="var(--fg-2)" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
                <circle ref={(element) => { if (element) dots.current.set(name, element); else dots.current.delete(name); }} cx="0" cy={SIZE} r={active ? 2.2 : 1.6} fill={active ? 'var(--fg)' : 'var(--fg-3)'} />
              </g>
            );
          })}
        </svg>
        <span className="absolute -bottom-6 right-0 font-mono text-2xs text-fg-4">{t`时间`} →</span>
        <span className="absolute -left-1 bottom-0 -translate-x-full rotate-180 font-mono text-2xs text-fg-4 [writing-mode:vertical-rl] max-md:hidden">{t`进度`} →</span>
      </div>
      <div className="flex flex-col justify-between gap-8">
        <ul className="flex flex-col edge-t">
          {names.map((name) => (
            <li key={name}>
              <button
                type="button"
                onClick={() => setFocus(name)}
                aria-pressed={name === focus}
                className={cn('flex w-full flex-col gap-0.5 py-3 text-left outline-none edge-b focus-visible:ring-2 focus-visible:ring-focus', name === focus ? 'text-fg' : 'text-fg-3 hover:text-fg-2')}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium">{label[name][0]}</span>
                  <span className="text-xs text-fg-3">{label[name][1]}</span>
                </span>
                <Token className={cn(name !== focus && 'text-fg-3')}>{`ease-${kebab(name)}`}</Token>
                <Value>{MOTION_EASING[name].join(', ')}</Value>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between gap-3">
          <Button variant="secondary" size="sm" onClick={play}><IconPlay />{t`播放`}</Button>
          <span className="font-mono text-2xs text-fg-4">{span}ms · ×{SLOW}</span>
        </div>
      </div>
    </Frame>
  );
}

/** Durations on one time ruler, filled by a playhead that sweeps it. */
function Timeline() {
  const { t } = useLingui();
  const names = Object.keys(MOTION_DURATION) as DurationName[];
  const longest = MOTION_DURATION.slow;
  const fills = useRef(new Map<DurationName, HTMLSpanElement>());
  const head = useRef<HTMLSpanElement>(null);
  const [play] = useTimeline(longest * SLOW, (elapsed) => {
    const ms = elapsed / SLOW;
    if (head.current) head.current.style.left = `${(ms / longest) * 100}%`;
    for (const [name, fill] of fills.current) fill.style.transform = `scaleX(${Math.min(ms / MOTION_DURATION[name], 1)})`;
  });
  const figure = useAutoplay(play, longest * SLOW + 1400);
  const use: Record<DurationName, string> = {
    fast: t`悬停、按下、颜色变化`,
    base: t`展开、切换、调整大小`,
    medium: t`浮层进入`,
    slow: t`页面与视图之间的转场`,
    exitFast: t`菜单、提示气泡退出`,
    exitBase: t`浮层、弹窗退出`,
  };
  const ticks = Array.from({ length: longest / 50 + 1 }, (_, index) => index * 50);
  return (
    <div ref={figure} className="flex flex-col gap-4">
      <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-6 max-md:grid-cols-[120px_minmax(0,1fr)]">
        <div className="flex items-end"><Button variant="secondary" size="sm" onClick={play}><IconPlay />{t`播放`}</Button></div>
        <div className="relative h-6">
          {ticks.map((ms) => (
            <span key={ms} className="absolute bottom-0 flex -translate-x-1/2 flex-col items-center gap-1" style={{ left: `${(ms / longest) * 100}%` }}>
              <Value className="text-fg-4">{ms}</Value>
              <span className="h-1.5 w-px bg-fg-4" />
            </span>
          ))}
        </div>
      </div>
      <div className="relative flex flex-col edge-t">
        <div aria-hidden className="pointer-events-none absolute inset-y-0 left-[224px] right-0 max-md:left-[144px]">
          <span ref={head} className="absolute inset-y-0 w-px bg-fg" style={{ left: 0 }} />
        </div>
        {names.map((name) => (
          <div key={name} className="grid grid-cols-[200px_minmax(0,1fr)] items-center gap-6 py-3.5 edge-b max-md:grid-cols-[120px_minmax(0,1fr)]">
            <div className="flex flex-col gap-0.5">
              <span className="flex items-baseline gap-2"><Token>{`duration-${kebab(name)}`}</Token><Value>{MOTION_DURATION[name]}</Value></span>
              <span className="truncate text-xs text-fg-3">{use[name]}</span>
            </div>
            <div className="relative h-2.5 overflow-hidden rounded-full bg-fg-4/25" style={{ width: `${(MOTION_DURATION[name] / longest) * 100}%` }}>
              <span ref={(element) => { if (element) fills.current.set(name, element); else fills.current.delete(name); }} className="absolute inset-0 origin-left rounded-full bg-fg" style={{ transform: 'scaleX(0)' }} />
            </div>
          </div>
        ))}
      </div>
      <span className="self-end font-mono text-2xs text-fg-4">ms · ×{SLOW}</span>
    </div>
  );
}

export function MotionChapter() {
  const { t } = useLingui();
  return (
    <Chapter id="motion" number="06" title={t`动效`} lede={t`进入减速，退出加速，原位变化用标准曲线；退出时长约为进入的 70%。动画优先作用于 opacity 与 transform，由合成器执行。`} source="packages/contracts/src/design-tokens.ts">
      <Plate number="6.1" title={t`曲线`} note={t`横轴为时间，纵轴为进度。Mac 使用 snappy 与 smooth 弹簧，iOS 使用弹簧，感知时长与此一致。`}>
        <CurvePlot />
      </Plate>
      <Plate number="6.2" title={t`时长`} note={t`系统开启「减少动态效果」时，位移与缩放替换为淡入淡出。`}>
        <Timeline />
      </Plate>
    </Chapter>
  );
}
